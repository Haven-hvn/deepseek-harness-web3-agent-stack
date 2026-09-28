/**
 * Filecoin Synapse transport for dsh-storage-synapse.
 *
 * Port of the reference js-services/synapse-wrapper.ts (filecoin-pin +
 * @filoz/synapse-sdk) — Filecoin Onchain Cloud only, no Kubo/localhost.
 * Uploads pay USDFC on calibration/mainnet via wss://api.calibration.node.glif.io/rpc/v1.
 * No localhost:5001, no Kubo HTTP fallback.
 *
 * OWS upgrade (filecoin-pin 1.3.0 AccountConfig): Synapse is initialized
 * with a pre-created viem Account whose signing callbacks delegate to
 * ctx.wallet (OWS vault) — no raw private key in this package, its
 * configuration, or the process between requests. The account is created
 * per-operation-style inside the wallet seam (resolve → load → sign → drop).
 */

export type Cid = string

export interface PinStatus {
  readonly cid: Cid
  readonly provider: string
  readonly expiresAt: number
  readonly redundancy: number
}

export const internals: { fetch: typeof globalThis.fetch | undefined } = { fetch: undefined }
export function resolveFetch(): typeof globalThis.fetch { return internals.fetch ?? globalThis.fetch }
export function httpError(operation: string, response: Response): Error {
  return new Error(`dsh-storage-synapse: ${operation} failed: ${response.status} ${response.statusText}`)
}

export type SynapseMode = 'filecoin'

/** What a store commits: the UnixFS root plus the PDP piece that carries it. */
export interface PieceLedgerEntry {
  pieceCid: string
  providerId?: string | undefined
  storedAt: string
}

export const PIECE_LEDGER_VERSION = 1

/**
 * Provider-selection failures happen before anything is committed: no dataset,
 * no lockup, no spend — the SDK throws while choosing who stores the bytes.
 * Safe to retry with different selection inputs; anything later in the flow
 * (mid-upload faults) must surface, never silently re-drive, because the
 * first attempt may have locked funds.
 */
export function isProviderSelectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return message.includes('No endorsed provider available')
}

/**
 * Log-safe preview: upload results carry BigInts (dataset ids, fees) that
 * crash bare JSON.stringify — turning a committed pin into a thrown error.
 */
export function preview(value: unknown, max = 500): string {
  try {
    return (JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? `${entry}n` : entry) ?? '').slice(0, max)
  } catch {
    return String(value).slice(0, max)
  }
}

type SynapseInstance = import('@filoz/synapse-sdk').Synapse
type Account = import('viem').Account

interface FilecoinBackendOpts {
  /** Resolver that returns a viem Account delegating to ctx.wallet (OWS) — per operation, never cached */
  getAccount: () => Promise<Account>
  rpcUrl: string
  networkMode?: 'calibration' | 'mainnet' | undefined
  withCDN?: boolean | undefined
  copies?: number | undefined
  excludeProviderIds?: bigint[] | undefined
  providerIds?: bigint[] | undefined
  /** Optional JSON path persisting the root→piece ledger across restarts (best-effort, 0600). */
  pieceLedgerPath?: string | undefined
}

export class FilecoinBackend {
  private synapse: SynapseInstance | null = null
  /** Root CID → piece that carries it. checkPin verifies the piece live; without an entry it cannot map root→piece. */
  private readonly pieces = new Map<string, PieceLedgerEntry>()
  private ledgerLoaded = false

  constructor(private readonly opts: FilecoinBackendOpts) {}

  /** Load the persisted ledger once; missing/corrupt/legacy files start empty, never throw. */
  private async ensureLedger(): Promise<void> {
    if (this.ledgerLoaded) return
    this.ledgerLoaded = true
    if (!this.opts.pieceLedgerPath) return
    try {
      const { readFile } = await import('node:fs/promises')
      const raw = JSON.parse(await readFile(this.opts.pieceLedgerPath, 'utf8')) as {
        version?: unknown; pieces?: Record<string, { pieceCid?: unknown; providerId?: unknown; storedAt?: unknown }>
      }
      if (raw?.version !== PIECE_LEDGER_VERSION || typeof raw?.pieces !== 'object' || raw.pieces === null) return
      for (const [cid, entry] of Object.entries(raw.pieces)) {
        if (typeof entry?.pieceCid === 'string' && entry.pieceCid !== '') {
          this.pieces.set(cid, {
            pieceCid: entry.pieceCid,
            providerId: typeof entry.providerId === 'string' ? entry.providerId : undefined,
            storedAt: typeof entry.storedAt === 'string' ? entry.storedAt : new Date(0).toISOString(),
          })
        }
      }
      console.log(`[synapse] piece ledger loaded ${this.pieces.size} entries from ${this.opts.pieceLedgerPath}`)
    } catch (e: any) {
      console.log(`[synapse] piece ledger unreadable (${e?.message ?? e}) — starting empty`)
    }
  }

  /** Persist the ledger atomically (tmp + rename, 0600); failures degrade to memory-only, never throw. */
  private async persistLedger(): Promise<void> {
    if (!this.opts.pieceLedgerPath) return
    try {
      const { mkdir, rename, writeFile } = await import('node:fs/promises')
      const { dirname } = await import('node:path')
      await mkdir(dirname(this.opts.pieceLedgerPath), { recursive: true })
      const body = JSON.stringify({ version: PIECE_LEDGER_VERSION, pieces: Object.fromEntries(this.pieces) })
      const tmp = `${this.opts.pieceLedgerPath}.tmp-${process.pid}`
      await writeFile(tmp, body, { mode: 0o600 })
      await rename(tmp, this.opts.pieceLedgerPath)
    } catch (e: any) {
      console.log(`[synapse] piece ledger save failed (${e?.message ?? e}) — memory-only`)
    }
  }

  private async ensureSynapse(): Promise<SynapseInstance> {
    if (this.synapse) return this.synapse
    const { initializeSynapse } = await import('filecoin-pin/core/synapse')
    const account = await this.opts.getAccount()
    // filecoin-pin 1.3.0 AccountConfig: { account, rpcUrl, withCDN } — OWS wallet-gated, no privateKey
    const synapse: SynapseInstance = await (initializeSynapse as any)({
      account,
      rpcUrl: this.opts.rpcUrl,
      ...(this.opts.withCDN !== undefined ? { withCDN: this.opts.withCDN } : {}),
    })
    this.synapse = synapse
    return synapse
  }

  async store(data: Uint8Array, opts?: { onProgress?: (event: unknown) => void; signal?: AbortSignal }): Promise<{ cid: Cid; pieceCid?: string | undefined }> {
    console.log(`[synapse] store start bytes=${data.length}`)
    const synapse = await this.ensureSynapse()
    console.log(`[synapse] synapse ready`)
    const { createUnixfsCarBuilder } = await import('filecoin-pin/core/unixfs')
    const { executeUpload } = await import('filecoin-pin/core/upload')
    const { CID } = await import('multiformats/cid')
    const { writeFile, readFile, unlink } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { randomBytes } = await import('node:crypto')
    const tmpPath = join(tmpdir(), `dsh-pin-${randomBytes(6).toString('hex')}.bin`)
    await writeFile(tmpPath, data)
    const builder: any = (createUnixfsCarBuilder as any)()
    console.log(`[synapse] building CAR tmp=${tmpPath}`)
    const car: any = await builder.buildCar(tmpPath)
    console.log(`[synapse] CAR built rootCid=${car.rootCid} carPath=${car.carPath}`)
    const carBytes = await readFile(car.carPath)
    console.log(`[synapse] carBytes=${carBytes.length}`)
    const rootCid: any = CID.parse(car.rootCid)
    const log = (lvl: string, ...a: any[]) => { try { console.log(`[synapse:${lvl}]`, ...a) } catch {} }
    const logger: any = { debug: (...a: any[]) => log('debug', ...a), info: (...a: any[]) => log('info', ...a), warn: (...a: any[]) => log('warn', ...a), error: (...a: any[]) => log('error', ...a) }
    const baseOpts: any = {
      logger,
      ipniValidation: { enabled: false },
      ...(opts?.onProgress ? { onProgress: opts.onProgress } : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
      ...(this.opts.copies !== undefined ? { copies: this.opts.copies } : {}),
      ...(this.opts.providerIds ? { providerIds: this.opts.providerIds } : {}),
    }
    let result: any
    try {
      try {
        result = await this.runUpload(executeUpload, synapse, carBytes, rootCid, baseOpts, this.opts.excludeProviderIds, 'primary')
      } catch (primaryError: unknown) {
        // Calibration's endorsed set is tiny (it has been exactly the once-excluded
        // [4, 9]) and it shifts without notice — a stale exclusion list fails
        // selection with zero candidates. One fallback without exclusions, loudly
        // logged; explicit providerIds are the operator's deliberate target and
        // are never second-guessed.
        if (this.opts.excludeProviderIds?.length && !this.opts.providerIds && isProviderSelectionError(primaryError)) {
          console.log(`[synapse] primary selection failed with exclusions [${this.opts.excludeProviderIds.join(',')}]; retrying once without exclusions`)
          result = await this.runUpload(executeUpload, synapse, carBytes, rootCid, baseOpts, undefined, 'fallback-no-exclusions')
        } else {
          throw primaryError
        }
      }
    } finally { try { await unlink(tmpPath) } catch {} try { await builder.cleanup?.(car?.carPath) } catch {} }
    const cid: string = car?.rootCid ?? result?.cid ?? result?.rootCid ?? ''
    if (!cid) throw new Error('dsh-storage-synapse: filecoin store returned empty CID')
    const pieceCid: string | undefined = result?.pieceCid ?? result?.piece
    // Record the root→piece mapping checkPin verifies against. The first copy's
    // provider is a hint only — verification sweeps every approved provider.
    if (typeof pieceCid === 'string' && pieceCid !== '') {
      const firstCopy = Array.isArray(result?.copies) ? result.copies[0] : undefined
      const providerId = firstCopy?.providerId
      await this.ensureLedger()
      this.pieces.set(cid, {
        pieceCid,
        providerId: typeof providerId === 'bigint' ? providerId.toString() : undefined,
        storedAt: new Date().toISOString(),
      })
      await this.persistLedger()
    }
    return { cid, pieceCid }
  }

  /** One upload attempt against filecoin-pin; selection inputs vary per attempt, the CAR is built once. */
  private async runUpload(
    executeUpload: unknown,
    synapse: SynapseInstance,
    carBytes: any,
    rootCid: any,
    baseOpts: any,
    excludeProviderIds: bigint[] | undefined,
    label: string,
  ): Promise<any> {
    const uploadOpts: any = {
      ...baseOpts,
      ...(excludeProviderIds?.length ? { excludeProviderIds } : {}),
    }
    console.log(`[synapse] executeUpload start copies=${this.opts.copies} exclude=${excludeProviderIds?.join(',') ?? '(none)'} attempt=${label}`)
    try {
      const result = await (executeUpload as any)(synapse, carBytes, rootCid, uploadOpts)
      console.log(`[synapse] executeUpload done result=${preview(result)}`)
      return result
    } catch (e: any) {
      console.log(`[synapse] executeUpload error attempt=${label} ${e?.message ?? e} ${e?.stack?.slice(0, 500) ?? ''}`)
      throw e
    }
  }

  async retrieve(cid: Cid, signal?: AbortSignal): Promise<Uint8Array> {
    const synapse: any = await this.ensureSynapse()
    if (typeof synapse.download === 'function') {
      const out: Uint8Array = await synapse.download(cid, { signal } as any)
      return out
    }
    throw new Error(`dsh-storage-synapse: retrieve(${cid}) not yet wired for filecoin backend without synapse.download`)
  }

  /**
   * True liveness read: the ledger maps the root CID to its PDP piece, and the
   * piece is asked for live on the approved providers (`findPiece`). A root CID
   * alone cannot derive its piece (commP needs the bytes), so CIDs this backend
   * never stored — or stored before the ledger existed — answer "not pinned"
   * rather than guess. Fail-soft throughout: an unreadable network is
   * unhealthy, never an exception.
   */
  async checkPin(cid: Cid): Promise<PinStatus> {
    const notPinned = { cid, provider: 'filecoin', expiresAt: -1, redundancy: 0 }
    try {
      await this.ensureLedger()
      const entry = this.pieces.get(cid)
      if (!entry) return notPinned
      const { findPiece } = await import('@filoz/synapse-core/sp')
      const { Piece } = await import('@filoz/synapse-core/piece')
      const piece = Piece.from(entry.pieceCid)
      for (const serviceURL of await this.providerUrls(entry.providerId)) {
        try {
          await findPiece({ serviceURL, pieceCid: piece, timeout: 15000 })
          console.log(`[synapse] checkPin ${cid} pinned (piece ${entry.pieceCid} on ${serviceURL})`)
          return { cid, provider: 'filecoin', expiresAt: 0, redundancy: 1 }
        } catch {
          // This provider doesn't hold it — try the next.
        }
      }
    } catch (e: any) {
      console.log(`[synapse] checkPin ${cid} unreadable (${e?.message ?? e}) — reporting not pinned`)
    }
    return notPinned
  }

  /** Approved providers' PDP URLs, recorded provider first (fresh list every call — the set shifts). */
  private async providerUrls(preferredId?: string): Promise<string[]> {
    const { createPublicClient, http } = await import('viem')
    const chains = await import('@filoz/synapse-core/chains')
    const { getApprovedPDPProviders } = await import('@filoz/synapse-core/sp-registry')
    // Chain reads go over HTTPS; ws(s) endpoints serve the SDK's subscriptions instead.
    const httpUrl = this.opts.rpcUrl.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:')
    const chain = this.opts.networkMode === 'mainnet' ? chains.mainnet : chains.calibration
    const client = createPublicClient({ chain, transport: http(httpUrl) })
    const providers = await getApprovedPDPProviders(client)
    const urls = providers
      .map((p: any) => ({ id: String(p?.id ?? ''), url: p?.pdp?.serviceURL as string | undefined }))
      .filter((p: { id: string; url: string | undefined }): p is { id: string; url: string } => typeof p.url === 'string' && p.url !== '')
    urls.sort((a, b) => (a.id === preferredId ? -1 : b.id === preferredId ? 1 : 0))
    return urls.map(p => p.url)
  }

  async pin(cid: Cid): Promise<PinStatus> {
    const status = await this.checkPin(cid)
    if (status.redundancy > 0) return status
    return { cid, provider: 'filecoin', expiresAt: 0, redundancy: 1 }
  }
}
