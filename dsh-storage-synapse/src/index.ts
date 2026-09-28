/**
 * Synapse pinning for dsh: `ctx.synapse` (store / retrieve / pin / pin-status
 * over a Synapse/IPFS node) plus two model-facing tools — `synapse_pin` and
 * `synapse_pin_status` — so the harness itself can natively choose to pin a
 * file.
 *
 * Concept lineage (haven-adapters `SynapseStorageAdapter` +
 * `StorageBackend`): the operation surface — store bytes → CID, retrieve by
 * CID, check pin, renew pin — carries over verbatim. Two things translate to
 * dsh seams instead of surviving as-is:
 *
 * - **Machine → tools.** Haven routed storage through a `StorageBackend`
 *   machine (`eStoreData`/`ePinRenew` events, an op queue, a
 *   `StoragePinManager` renewal loop). dsh already owns dispatch and
 *   scheduling, so the port is a service plus registered tools: the *agent*
 *   decides when something is worth pinning.
 * - **Stored key → wallet signature (OWS).** Haven authenticated with a raw
 *   storage key (`storageKey: "env:VAR" | "0x…"` → Bearer). Here every
 *   request is authenticated by a viem Account whose signing callbacks
 *   delegate to `ctx.wallet` (OWS vault, filecoin-pin 1.3.0 AccountConfig).
 *   No private key, no credential reference in config — the wallet seam
 *   resolves → loads → signs → drops per operation via the signing gate and
 *   treasury, exactly like `dsh-erc8004` on Ethereum Sepolia.
 *
 * @module dsh-storage-synapse
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
// Type-only: the read-back hook contract (runtime access to the guard stays
// optional via `ctx.reflect.get`, so this plugin mounts cleanly unguarded).
import type { CheckContext, CheckDecision } from 'dsh-exactly-once'
import type { Cid, PinStatus } from './synapse.ts'
import type { SynapsePinnedEvent } from './types.ts'

export type { Cid, PinStatus } from './synapse.ts'
export type { SynapsePinnedEvent } from './types.ts'

/**
 * Test seam: bounds the read-back retries that ride out Filecoin
 * eventual-consistency false negatives (production: three checks, 500ms
 * apart).
 */
export const internals = { checkRetries: 3, checkRetryMs: 500 }

/** Cordis plugin name. */
export const name = 'storage-synapse'
/** Signing identity (OWS) and the tool registry. Treasury is best-effort via ctx.get(). */
export const inject = ['wallet', 'tools']

/** Plugin configuration — wallet-gated OWS (filecoin-pin 1.3.0 AccountConfig), no privateKeyRef. */
export interface Config {
  /** Configured `dsh-wallet` wallet name that identifies the payer. Required. */
  wallet: string
  /** Filecoin RPC URL (e.g. wss://api.calibration.node.glif.io/rpc/v1). Required. */
  rpcUrl: string
  /** Filecoin network: calibration (default) or mainnet. */
  networkMode?: 'calibration' | 'mainnet'
  /** Whether to enable the Filecoin CDN for retrievals. */
  withCDN?: boolean
  /** Workaround for calibration #615: number of copies (default 1 to avoid 2-copy replication failure). */
  copies?: number
  /**
   * Provider IDs to exclude from auto-selection. Default empty: calibration's
   * endorsed set is tiny (observed as exactly [4, 9]) and excluding all of it
   * fails every upload with "No endorsed provider available" — the old [4, 9]
   * default did exactly that. Exclude only a provider you have live evidence
   * is down; the store path retries once without exclusions on selection
   * failure anyway.
   */
  excludeProviderIds?: number[]
  /** Explicit provider IDs to use (overrides auto-selection). Never second-guessed by the retry path. */
  providerIds?: number[]
  /**
   * Optional JSON path persisting the root→piece ledger checkPin verifies
   * against. Without it the ledger is memory-only: restarts forget which
   * pieces carry which roots and status degrades to "not pinned".
   */
  pieceLedgerPath?: string
}

/** Config schema — no credential fields, only wallet name + public RPC URL. */
export const Config: z<Config> = z.object({
  wallet: z.string().required(),
  rpcUrl: z.string().required(),
  networkMode: z.union(['calibration', 'mainnet']).default('calibration'),
  withCDN: z.boolean().default(false),
  copies: z.number().step(1).min(1).max(3).default(1),
  excludeProviderIds: z.array(z.number().step(1).min(0)).default([]),
  providerIds: z.array(z.number().step(1).min(0)),
  pieceLedgerPath: z.string(),
})

/**
 * The `ctx.synapse` seam: Filecoin Synapse SDK only (reference parity).
 * No Kubo, no localhost:5001 — uploads go through filecoin-pin paying USDFC
 * via a wallet-gated viem Account (OWS vault, no raw key).
 */
export class SynapseRuntime {
  private filecoin: import('./synapse.ts').FilecoinBackend | null = null
  /** Uploaded bytes by sha256: CIDs are content-deterministic, so a repeat stores once. */
  private readonly uploads = new Map<string, Cid>()
  /** Disposer for the lazily registered exactly-once hook (none while unguarded). */
  private hookDisposer: (() => void) | undefined
  private readonly _rpcUrl: string
  private readonly _networkMode?: 'calibration' | 'mainnet' | undefined
  private readonly _withCDN?: boolean | undefined
  private readonly _copies: number
  private readonly _excludeProviderIds?: bigint[] | undefined
  private readonly _providerIds?: bigint[] | undefined
  private readonly _pieceLedgerPath?: string | undefined

  constructor(
    private readonly ctx: Context,
    private readonly wallet: string,
    opts: { rpcUrl: string; networkMode?: 'calibration' | 'mainnet' | undefined; withCDN?: boolean | undefined; copies?: number; excludeProviderIds?: number[]; providerIds?: number[]; pieceLedgerPath?: string },
  ) {
    if (!opts.rpcUrl) {
      throw new Error('dsh-storage-synapse: rpcUrl required (Filecoin-only, no Kubo fallback)')
    }
    this._rpcUrl = opts.rpcUrl
    this._networkMode = opts.networkMode
    this._withCDN = opts.withCDN
    this._copies = opts.copies ?? 1
    this._excludeProviderIds = opts.excludeProviderIds?.length ? opts.excludeProviderIds.map(n => BigInt(n)) : undefined
    this._providerIds = opts.providerIds?.length ? opts.providerIds.map(n => BigInt(n)) : undefined
    this._pieceLedgerPath = opts.pieceLedgerPath
  }

  /** Build a viem Account delegating signing to ctx.wallet (OWS vault) — treasury-aware. */
  private async createAccount(): Promise<import('viem').Account> {
    const walletSeam: any = (this.ctx as any).wallet
    const treasury: any = (() => {
      try { return (this.ctx as any).get?.('treasury') } catch {}
      try { return (this.ctx as any).treasury } catch { return undefined }
    })()
    if (!walletSeam?.address || typeof walletSeam.signTransaction !== 'function') {
      throw new Error('dsh-storage-synapse: ctx.wallet not mounted or missing signTransaction (needs dsh-wallet + dsh-wallet-ethereum)')
    }
    const address = await walletSeam.address(this.wallet) as `0x${string}`
    const { toAccount } = await import('viem/accounts')
    const { serializeTransaction } = await import('viem')
    const walletName = this.wallet
    // Capture ctx for closures
    const ctx: any = this.ctx
    return toAccount({
      address,
      async signMessage({ message }: { message: string | { raw: string | Uint8Array } }): Promise<`0x${string}`> {
        let payload: string
        if (typeof message === 'string') payload = message
        else if (typeof (message as any).raw === 'string') payload = (message as any).raw
        else if ((message as any).raw instanceof Uint8Array) payload = new TextDecoder().decode((message as any).raw)
        else payload = String(message)
        const { signature } = await walletSeam.signMessage(walletName, payload)
        return signature as `0x${string}`
      },
      async signTransaction(transaction: any): Promise<`0x${string}`> {
        // Treasury pre-check (best-effort, fail fast on DEPLETED) — mirror dsh-erc8004
        // Treasury gate: respect dormant (unfunded) state — don't block when ledger never funded (haven-core zero-value rule would brick fresh install)
        if (treasury?.authorize && treasury?.report) {
          try {
            const rep: any = treasury.report()
            const hasBalances = Array.isArray(rep?.balances) && rep.balances.length > 0
            if (!hasBalances) {
              console.log(`[synapse] treasury dormant (no balances yet) — skipping storage gate`)
            } else {
              const decision = treasury.authorize('storage', 5_000)
              console.log(`[synapse] treasury authorize storage 5000 state=${rep?.state} total=${rep?.totalValueUsd} -> ${decision.approved ? 'approved' : 'DENIED'} ${decision.reason}`)
              if (decision && (decision as any).approved === false) {
                throw new Error(`treasury blocked Filecoin store: ${decision.reason ?? (decision as any).code ?? 'insufficient funds'} (state=${rep?.state} total=${rep?.totalValueUsd})`)
              }
            }
          } catch (e: any) {
            if (e?.message?.includes('treasury blocked')) throw e
            console.log(`[synapse] treasury authorize check failed open: ${e?.message ?? e}`)
          }
        }
        const serialized = serializeTransaction(transaction)
        const { signature: signedRaw } = await walletSeam.signTransaction(walletName, serialized)
        // Treasury post-commit best-effort
        if (treasury?.recordExpense || treasury?.addExpense) {
          try {
            const record = treasury.recordExpense ?? treasury.addExpense
            await record.call(treasury, { category: 'storage', amountUsd: 0.005, description: `filecoin-pin store via ${walletName}` })
          } catch {}
        }
        return signedRaw as `0x${string}`
      },
      async signTypedData(typedData: any): Promise<`0x${string}`> {
        // Filecoin Synapse EIP-712: CreateDataSet / AddPieces / SchedulePieceRemovals / TerminateService / Permit (synapse-core typed-data)
        // The digest must be signed RAW (secp256k1 over the 32 bytes, like viem's
        // privateKeyToAccount). OWS signMessage applies the EIP-191 prefix, which
        // recovers to a garbage address on-chain — InvalidSignature AFTER the
        // bytes are already stored. Same seam haven-aol uses for gate signing;
        // fail loud here rather than produce a doomed upload.
        if (typeof walletSeam.signDigest !== 'function') {
          throw new Error(
            'dsh-storage-synapse: ctx.wallet lacks signDigest (needs dsh-wallet-ethereum with raw digest signing) — '
            + 'refusing to EIP-191-sign an EIP-712 digest',
          )
        }
        const { hashTypedData } = await import('viem')
        const digest = hashTypedData(typedData as any) as `0x${string}`
        const res = await walletSeam.signDigest(walletName, digest)
        const signature = typeof res === 'string' ? res : (res as { signature: string }).signature
        void ctx
        return signature as `0x${string}`
      },
    } as any)
  }

  private async ensureBackend(): Promise<import('./synapse.ts').FilecoinBackend> {
    if (this.filecoin) return this.filecoin
    const { FilecoinBackend } = await import('./synapse.ts')
    const getAccount = () => this.createAccount()
    this.filecoin = new FilecoinBackend({
      getAccount,
      rpcUrl: this._rpcUrl,
      networkMode: this._networkMode,
      withCDN: this._withCDN,
      copies: this._copies,
      excludeProviderIds: this._excludeProviderIds,
      providerIds: this._providerIds,
      pieceLedgerPath: this._pieceLedgerPath,
    })
    return this.filecoin
  }

  // @ts-ignore unused but documents mode
  private get backend(): 'filecoin' { return 'filecoin' as const }

  /**
   * Register the `synapse_pin` read-back hook once the guard is present.
   * Lazy (called from every write path) so registration never depends on
   * plugin mount order; a no-op while unguarded, idempotent once registered.
   */
  hook(): void {
    if (this.hookDisposer !== undefined) return
    const guard = this.ctx.reflect.get('exactlyOnce') as
      | { registerCheck?: (name: string, fn: (check: CheckContext) => Promise<CheckDecision>) => () => void }
      | undefined
    if (guard === null || guard === undefined || typeof guard.registerCheck !== 'function') return
    this.hookDisposer = guard.registerCheck('synapse_pin', check => this.checkPinTool(check.args))
  }

  /** Retire the read-back hook (plugin disposal). */
  unhook(): void {
    try {
      this.hookDisposer?.()
    } catch {}
    this.hookDisposer = undefined
  }

  /**
   * Read-back hook for `synapse_pin` repeats after ambiguous outcomes. A
   * `cid` retry checks the pin directly; a `path` retry resolves by
   * content hash through the upload ledger, then checks the pin.
   * @param input - the retried tool arguments.
   * @returns replay when the CID is pinned, proceed when it provably is
   *   not, unknown when the bytes were never uploaded here or the node
   *   cannot answer.
   */
  async checkPinTool(input: unknown): Promise<CheckDecision> {
    this.hook()
    const args = (input ?? {}) as { path?: unknown; cid?: unknown }
    if (typeof args.cid === 'string' && args.cid !== '') {
      return await this.checkPinned(args.cid)
    }
    if (typeof args.path === 'string' && args.path !== '') {
      let data: Uint8Array
      try {
        data = await readFile(args.path)
      } catch {
        return { kind: 'unknown' }
      }
      const cid = this.uploads.get(createHash('sha256').update(data).digest('hex'))
      if (cid === undefined) return { kind: 'unknown' }
      return await this.checkPinned(cid)
    }
    return { kind: 'unknown' }
  }

  /** Pin verdict with bounded retries over Filecoin false negatives. */
  private async checkPinned(cid: Cid): Promise<CheckDecision> {
    for (let attempt = 0; attempt < internals.checkRetries; attempt += 1) {
      if (attempt > 0 && internals.checkRetryMs > 0) {
        await new Promise(done => setTimeout(done, internals.checkRetryMs))
      }
      let status: PinStatus
      try {
        status = await this.checkPin(cid)
      } catch {
        return { kind: 'unknown' } // the node cannot answer at all
      }
      if (status.redundancy > 0) return { kind: 'replay', value: status }
    }
    return { kind: 'proceed' }
  }

  /**
   * Store bytes on the node (CIDv1). Storing on the local node also pins
   * locally; `pin` makes the intent explicit and returns the recorded status.
   * Repeat stores of identical bytes return the recorded CID without
   * re-uploading (CIDs are content-deterministic).
   * @param data - raw bytes to store.
   * @param signal - abort signal bounding the request.
   * @returns the content identifier.
   */
  async store(data: Uint8Array, _signal?: AbortSignal, onProgress?: (event: unknown) => void): Promise<{ cid: Cid }> {
    this.hook()
    const sha = createHash('sha256').update(data).digest('hex')
    const known = this.uploads.get(sha)
    if (known !== undefined) return { cid: known }
    const be = await this.ensureBackend()
    const stored = await be.store(data, { signal: _signal, onProgress })
    this.uploads.set(sha, stored.cid)
    return stored
  }

  /**
   * Retrieve stored bytes by CID.
   * @param cid - the content identifier.
   * @param signal - abort signal bounding the request.
   * @returns the raw bytes.
   */
  async retrieve(cid: Cid, _signal?: AbortSignal): Promise<Uint8Array> {
    const be = await this.ensureBackend()
    return be.retrieve(cid, _signal)
  }

  /**
   * Pin one CID (Haven's `renewPin`: pinning an already-pinned CID renews
   * it). Emits `synapse/pinned` at the commit point.
   * @param cid - the content identifier.
   * @param signal - abort signal bounding the request.
   * @returns the pin status after the operation.
   */
  async pin(cid: Cid, _signal?: AbortSignal): Promise<PinStatus> {
    this.hook()
    const be = await this.ensureBackend()
    const st = await be.pin(cid)
    this.ctx.emit('synapse/pinned', { cid } satisfies SynapsePinnedEvent)
    return st
  }

  /**
   * Check one CID's pin health. Ported fail-soft semantics: any failure to
   * *answer the question* reports "not pinned" rather than throwing, because
   * Haven's pin monitoring treated an unreachable status as unhealthy.
   * @param cid - the content identifier.
   * @param signal - abort signal bounding the request.
   * @returns the pin status (`expiresAt: -1`, `redundancy: 0` when not pinned).
   */
  async checkPin(cid: Cid, _signal?: AbortSignal): Promise<PinStatus> {
    const be = await this.ensureBackend()
    return be.checkPin(cid)
  }

}

/** JSON-schema of the pin-status value both tools return. */
const PIN_STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    cid: { type: 'string', required: true },
    provider: { type: 'string', required: true },
    expiresAt: { type: 'number', required: true, description: '0 = permanent, -1 = not pinned.' },
    redundancy: { type: 'number', required: true, description: 'Replica count; 0 = not pinned.' },
  },
} as const

/** Render one pin status as the model-facing text block. */
function renderStatus(value: PinStatus): { type: 'text'; text: string }[] {
  const health = value.redundancy > 0 ? 'pinned' : 'not pinned'
  return [{ type: 'text', text: `${value.cid}: ${health} (provider ${value.provider})` }]
}

/**
 * Provide `ctx.synapse` and register the pin tools.
 * @param ctx - Plugin context.
 * @param config - Validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const synapse = new SynapseRuntime(ctx, config.wallet, {
    rpcUrl: config.rpcUrl,
    networkMode: config.networkMode,
    withCDN: config.withCDN,
    copies: (config as any).copies,
    excludeProviderIds: (config as any).excludeProviderIds?.length ? (config as any).excludeProviderIds : undefined,
    providerIds: (config as any).providerIds?.length ? (config as any).providerIds : undefined,
    pieceLedgerPath: (config as any).pieceLedgerPath,
  })
  ctx.provide('synapse', synapse)

  // The read-back hook registers lazily from the runtime's write paths
  // (mount-order-proof); this effect only retires it on disposal.
  ctx.effect(() => () => synapse.unhook())

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'synapse_pin',
    description: 'Persist content on the Synapse storage node and pin it. '
      + 'Give a local file path to upload and pin it (returns the new CID), or an existing CID to pin/renew it. '
      + 'Use this when a file or artifact must outlive this session.',
    parameters: {
      path: { type: 'string', description: 'Local file to upload and pin. Exactly one of path or cid.' },
      cid: { type: 'string', description: 'Existing content identifier to pin or renew. Exactly one of path or cid.' },
    },
    output: { schema: PIN_STATUS_SCHEMA, render: (_args, value) => renderStatus(value) },
    async execute(args: { path?: string; cid?: string }, exec): Promise<PinStatus> {
      console.log(`[synapse_pin] called path=${args.path ?? ''} cid=${args.cid ?? ''}`)
      if ((args.path === undefined) === (args.cid === undefined)) {
        throw new Error('provide exactly one of path or cid')
      }
      const signal: AbortSignal | undefined = (exec as any)?.signal
      const onProgress = (event: unknown) => {
        try { console.log(`[synapse_pin] progress ${JSON.stringify(event)?.slice(0,300)}`) } catch {}
        try { (exec as any)?.onProgress?.(event); } catch {}
        try { (synapse as any).ctx?.emit?.('synapse/progress', event as any); } catch {}
      }
      try {
        const cid = args.path !== undefined
          ? (await synapse.store(await readFile(args.path), signal, onProgress)).cid
          : args.cid as Cid
        console.log(`[synapse_pin] store done cid=${cid}, pinning...`)
        const st = await synapse.pin(cid, signal)
        console.log(`[synapse_pin] done ${JSON.stringify(st)}`)
        return st
      } catch (e: any) {
        console.log(`[synapse_pin] error ${e?.message ?? e} ${e?.stack?.slice(0,600) ?? ''}`)
        throw e
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Pin ${args.path !== undefined ? basename(args.path) : args.cid ?? ''} on Synapse`,
      kind: 'execute',
    }),
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'synapse_pin_status',
    description: 'Check whether a CID is currently pinned on the Synapse storage node.',
    parameters: {
      cid: { type: 'string', required: true, description: 'Content identifier to check.' },
    },
    output: { schema: PIN_STATUS_SCHEMA, render: (_args, value) => renderStatus(value) },
    execute: (args: { cid: string }, exec): Promise<PinStatus> => synapse.checkPin(args.cid, (exec as any)?.signal),
    presentCall: args => ({ card: 'generic', title: `Pin status of ${args.cid}`, kind: 'read' }),
  })))
}
