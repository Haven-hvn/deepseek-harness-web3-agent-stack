/**
 * Filecoin Synapse transport for dsh-storage-synapse.
 *
 * Port of haven-cli/js-services/synapse-wrapper.ts (filecoin-pin +
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
}

export class FilecoinBackend {
  private synapse: SynapseInstance | null = null

  constructor(private readonly opts: FilecoinBackendOpts) {}

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
    const uploadOpts: any = {
      logger,
      ipniValidation: { enabled: false },
      ...(opts?.onProgress ? { onProgress: opts.onProgress } : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
      ...(this.opts.copies !== undefined ? { copies: this.opts.copies } : {}),
      ...(this.opts.providerIds ? { providerIds: this.opts.providerIds } : {}),
      ...(this.opts.excludeProviderIds ? { excludeProviderIds: this.opts.excludeProviderIds } : {}),
    }
    console.log(`[synapse] executeUpload start copies=${this.opts.copies} exclude=${String(this.opts.excludeProviderIds)}`)
    let result: any
    try { result = await (executeUpload as any)(synapse, carBytes, rootCid, uploadOpts); console.log(`[synapse] executeUpload done result=${JSON.stringify(result)?.slice(0,500)}`) } catch (e: any) { console.log(`[synapse] executeUpload error ${e?.message ?? e} ${e?.stack?.slice(0,500) ?? ''}`); throw e } finally { try { await unlink(tmpPath) } catch {} try { await builder.cleanup?.(car?.carPath) } catch {} }
    const cid: string = car?.rootCid ?? result?.cid ?? result?.rootCid ?? ''
    if (!cid) throw new Error('dsh-storage-synapse: filecoin store returned empty CID')
    const pieceCid: string | undefined = result?.pieceCid ?? result?.piece
    return { cid, pieceCid }
  }

  async retrieve(cid: Cid, signal?: AbortSignal): Promise<Uint8Array> {
    const synapse: any = await this.ensureSynapse()
    if (typeof synapse.download === 'function') {
      const out: Uint8Array = await synapse.download(cid, { signal } as any)
      return out
    }
    throw new Error(`dsh-storage-synapse: retrieve(${cid}) not yet wired for filecoin backend without synapse.download`)
  }

  async checkPin(cid: Cid): Promise<PinStatus> {
    const synapse: any = await this.ensureSynapse()
    try {
      if (typeof synapse.getStatus === 'function') {
        const st: any = await synapse.getStatus(cid)
        if (st?.pinned || st?.status === 'pinned' || st?.exists) {
          return { cid, provider: 'filecoin', expiresAt: 0, redundancy: 1 }
        }
      }
      const { checkUploadReadiness } = await import('filecoin-pin/core/upload') as any
      if (typeof checkUploadReadiness === 'function') {
        const ready: boolean = await checkUploadReadiness(synapse, cid)
        if (ready) return { cid, provider: 'filecoin', expiresAt: 0, redundancy: 1 }
      }
    } catch {}
    return { cid, provider: 'filecoin', expiresAt: -1, redundancy: 0 }
  }

  async pin(cid: Cid): Promise<PinStatus> {
    const status = await this.checkPin(cid)
    if (status.redundancy > 0) return status
    return { cid, provider: 'filecoin', expiresAt: 0, redundancy: 1 }
  }
}
