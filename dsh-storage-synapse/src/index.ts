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
 *   treasury, exactly like `dsh-erc8004` on Base Sepolia.
 *
 * @module dsh-storage-synapse
 */

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Cid, PinStatus } from './synapse.ts'
import type { SynapsePinnedEvent } from './types.ts'

export type { Cid, PinStatus } from './synapse.ts'
export type { SynapsePinnedEvent } from './types.ts'

/** Cordis plugin name. */
export const name = 'storage-synapse'
/** Signing identity (OWS) and the tool registry. Treasury is optional (best-effort). */
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
}

/** Config schema — no credential fields, only wallet name + public RPC URL. */
export const Config: z<Config> = z.object({
  wallet: z.string().required(),
  rpcUrl: z.string().required(),
  networkMode: z.union(['calibration', 'mainnet']).default('calibration'),
  withCDN: z.boolean().default(false),
})

/**
 * The `ctx.synapse` seam: Filecoin Synapse SDK only (haven-cli parity).
 * No Kubo, no localhost:5001 — uploads go through filecoin-pin paying USDFC
 * via a wallet-gated viem Account (OWS vault, no raw key).
 */
export class SynapseRuntime {
  private filecoin: import('./synapse.ts').FilecoinBackend | null = null
  private readonly _rpcUrl: string
  private readonly _networkMode?: 'calibration' | 'mainnet' | undefined
  private readonly _withCDN?: boolean | undefined

  constructor(
    private readonly ctx: Context,
    private readonly wallet: string,
    opts: { rpcUrl: string; networkMode?: 'calibration' | 'mainnet' | undefined; withCDN?: boolean | undefined },
  ) {
    if (!opts.rpcUrl) {
      throw new Error('dsh-storage-synapse: rpcUrl required (Filecoin-only, no Kubo fallback)')
    }
    this._rpcUrl = opts.rpcUrl
    this._networkMode = opts.networkMode
    this._withCDN = opts.withCDN
  }

  /** Build a viem Account delegating signing to ctx.wallet (OWS vault) — treasury-aware. */
  private async createAccount(): Promise<import('viem').Account> {
    const walletSeam: any = (this.ctx as any).wallet
    const treasury: any = (this.ctx as any).treasury
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
        if (treasury?.authorize) {
          try {
            const decision = treasury.authorize('storage', 5_000)
            if (decision && decision.authorized === false) {
              throw new Error(`treasury blocked Filecoin store: ${decision.reason ?? decision.code ?? 'insufficient funds'}`)
            }
          } catch (e: any) {
            if (e?.message?.includes('treasury blocked')) throw e
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
        // Single path: hash via viem hashTypedData then sign digest via ctx.wallet (OWS) — no JSON fallback.
        const { hashTypedData } = await import('viem')
        const digest = hashTypedData(typedData as any) as `0x${string}`
        // viem's privateKeyToAccount signs the digest directly (secp256k1 sign of hash, no personal prefix).
        // Delegate to OWS wallet as raw hash: OWS signMessage with hex digest (encoding handled by viem's hash).
        const { signature } = await walletSeam.signMessage(walletName, digest)
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
    })
    return this.filecoin
  }

  // @ts-ignore unused but documents mode
  private get backend(): 'filecoin' { return 'filecoin' as const }

  /**
   * Store bytes on the node (CIDv1). Storing on the local node also pins
   * locally; `pin` makes the intent explicit and returns the recorded status.
   * @param data - raw bytes to store.
   * @param signal - abort signal bounding the request.
   * @returns the content identifier.
   */
  async store(data: Uint8Array, _signal?: AbortSignal): Promise<{ cid: Cid }> {
    const be = await this.ensureBackend()
    return be.store(data)
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
  })
  ctx.provide('synapse', synapse)

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
      if ((args.path === undefined) === (args.cid === undefined)) {
        throw new Error('provide exactly one of path or cid')
      }
      const cid = args.path !== undefined
        ? (await synapse.store(await readFile(args.path), exec.signal)).cid
        : args.cid as Cid
      return synapse.pin(cid, exec.signal)
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
    execute: (args: { cid: string }, exec): Promise<PinStatus> => synapse.checkPin(args.cid, exec.signal),
    presentCall: args => ({ card: 'generic', title: `Pin status of ${args.cid}`, kind: 'read' }),
  })))
}
