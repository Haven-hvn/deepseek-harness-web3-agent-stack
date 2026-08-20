/**
 * Filecoin Synapse transport for dsh-storage-synapse.
 *
 * Port of haven-cli/js-services/synapse-wrapper.ts (filecoin-pin +
 * @filoz/synapse-sdk) — Filecoin Onchain Cloud only, no Kubo/localhost.
 * Uploads pay USDFC on calibration/mainnet via wss://api.calibration.node.glif.io/rpc/v1.
 * No localhost:5001, no Kubo HTTP fallback.
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

interface FilecoinBackendOpts {
  /** Credential reference name (e.g. HAVEN_PRIVATE_KEY) — resolved per operation via harness gate, never stored as raw key */
  privateKeyRef: string
  /** Resolver that returns the raw private key for one operation (ctx.credentials / env gate) */
  getPrivateKey: () => Promise<string>
  rpcUrl: string
  networkMode?: 'calibration' | 'mainnet'
  withCDN?: boolean
}

export class FilecoinBackend {
  private synapse: SynapseInstance | null = null

  constructor(private readonly opts: FilecoinBackendOpts) {}

  private async ensureSynapse(): Promise<SynapseInstance> {
    // Re-resolve the credential each time we (re)connect — never cache the raw key beyond this call
    if (this.synapse) return this.synapse
    const { initializeSynapse } = await import('filecoin-pin/core/synapse')
    const privateKey = (await this.opts.getPrivateKey()) as `0x${string}`
    // filecoin-pin maps privateKey+rpcUrl to a viem Synapse (privateKeyToAccount + http/wss transport + chain probe)
    const synapse: SynapseInstance = await (initializeSynapse as any)({
      privateKey,
      rpcUrl: this.opts.rpcUrl,
      ...(this.opts.withCDN !== undefined ? { withCDN: this.opts.withCDN } : {}),
    })
    this.synapse = synapse
    return synapse
  }

  async store(data: Uint8Array): Promise<{ cid: Cid; pieceCid?: string }> {
    const synapse = await this.ensureSynapse()
    const { createUnixfsCarBuilder } = await import('filecoin-pin/core/unixfs')
    const { executeUpload } = await import('filecoin-pin/core/upload')
    const builder: any = (createUnixfsCarBuilder as any)()
    const car: any = await builder.addBytes(data)
    const result: any = await (executeUpload as any)(synapse, car)
    const cid: string = result?.cid ?? result?.rootCid ?? car?.rootCid ?? ''
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
