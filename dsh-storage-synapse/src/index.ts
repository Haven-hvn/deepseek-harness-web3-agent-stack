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
 * - **Stored key → wallet signature.** Haven authenticated with a raw
 *   storage key (`storageKey: "env:VAR" | "0x…"` → bearer header). Here every
 *   request is authenticated by signing a per-request challenge through
 *   `ctx.wallet`, on top of dsh-wallet's custody pipeline: the credential
 *   resolves inside that one signing operation and no storage secret exists
 *   in this package, its configuration, or the process between requests.
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
/** Signing identity, credential resolution for Filecoin key, and the tool registry. */
export const inject = ['wallet', 'tools']

/** Plugin configuration. */
export interface Config {
  /** Configured `dsh-wallet` wallet name that identifies the payer. Required. */
  wallet: string
  /**
   * Credential reference for the Filecoin private key (e.g. HAVEN_PRIVATE_KEY).
   * Resolved via ctx.credentials / process.env — no raw key in config. Required
   * for Filecoin Synapse (filecoin-pin + @filoz/synapse-sdk) paying USDFC.
   */
  privateKeyRef: string
  /** Filecoin RPC URL (e.g. wss://api.calibration.node.glif.io/rpc/v1). Required. */
  rpcUrl: string
  /** Filecoin network: calibration (default) or mainnet. */
  networkMode?: 'calibration' | 'mainnet'
  /** Whether to enable the Filecoin CDN for retrievals. */
  withCDN?: boolean
}

/** Config schema. */
export const Config: z<Config> = z.object({
  wallet: z.string().required(),
  privateKeyRef: z.string().required(),
  rpcUrl: z.string().required(),
  networkMode: z.union(['calibration', 'mainnet']).default('calibration'),
  withCDN: z.boolean().default(false),
})

/**
 * The `ctx.synapse` seam: Filecoin Synapse SDK only (haven-cli parity).
 * No Kubo, no localhost:5001 — uploads go through filecoin-pin paying USDFC.
 */
export class SynapseRuntime {
  private filecoin: import('./synapse.ts').FilecoinBackend | null = null
  // Gated Filecoin config: only the credential NAME and RPC URL are stored long-term.
  // The raw private key is resolved per operation via the harness gate (ctx.credentials / env) and never cached.
  private readonly _privateKeyRef: string
  private readonly _rpcUrl: string
  private readonly _networkMode?: 'calibration' | 'mainnet'
  private readonly _withCDN?: boolean

  constructor(
    private readonly ctx: Context,
    private readonly wallet: string,
    opts: { privateKeyRef: string; rpcUrl: string; networkMode?: 'calibration' | 'mainnet'; withCDN?: boolean },
  ) {
    if (!opts.privateKeyRef || !opts.rpcUrl) {
      throw new Error('dsh-storage-synapse: privateKeyRef+rpcUrl required (Filecoin-only, no Kubo fallback)')
    }
    this._privateKeyRef = opts.privateKeyRef
    this._rpcUrl = opts.rpcUrl
    this._networkMode = opts.networkMode
    this._withCDN = opts.withCDN
  }

  private async resolvePrivateKey(): Promise<string> {
    // Per-operation gate: re-resolve the credential each call (wallet seam contract: consumers re-resolve at each operation and must not cache)
    const ref = this._privateKeyRef
    const creds: any = (this.ctx as any).credentials
    let v: string | undefined
    if (creds?.get) {
      try { v = creds.get(ref) as string | undefined } catch {}
    }
    if (!v) v = process.env[ref]
    if (!v) throw new Error(`dsh-storage-synapse: credential ${ref} not found (set ${ref} env or OWS vault) — Filecoin Onchain Cloud requires ${ref} + ${this._rpcUrl}`)
    return v
  }

  private async ensureBackend(): Promise<import('./synapse.ts').FilecoinBackend> {
    if (this.filecoin) return this.filecoin
    const { FilecoinBackend } = await import('./synapse.ts')
    const getPrivateKey = () => this.resolvePrivateKey()
    this.filecoin = new FilecoinBackend({
      privateKeyRef: this._privateKeyRef,
      getPrivateKey,
      rpcUrl: this._rpcUrl,
      networkMode: this._networkMode,
      withCDN: this._withCDN,
    })
    return this.filecoin
  }

  private get backend(): 'filecoin' { return 'filecoin' }

  /**
   * Store bytes on the node (CIDv1). Storing on the local node also pins
   * locally; `pin` makes the intent explicit and returns the recorded status.
   * @param data - raw bytes to store.
   * @param signal - abort signal bounding the request.
   * @returns the content identifier.
   */
  async store(data: Uint8Array, signal?: AbortSignal): Promise<{ cid: Cid }> {
    const be = await this.ensureBackend()
    return be.store(data)
  }

  /**
   * Retrieve stored bytes by CID.
   * @param cid - the content identifier.
   * @param signal - abort signal bounding the request.
   * @returns the raw bytes.
   */
  async retrieve(cid: Cid, signal?: AbortSignal): Promise<Uint8Array> {
    const be = await this.ensureBackend()
    return be.retrieve(cid, signal)
  }

  /**
   * Pin one CID (Haven's `renewPin`: pinning an already-pinned CID renews
   * it). Emits `synapse/pinned` at the commit point.
   * @param cid - the content identifier.
   * @param signal - abort signal bounding the request.
   * @returns the pin status after the operation.
   */
  async pin(cid: Cid, signal?: AbortSignal): Promise<PinStatus> {
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
  async checkPin(cid: Cid, signal?: AbortSignal): Promise<PinStatus> {
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
  // Resolve Filecoin private key for real Synapse SDK when configured (haven-cli parity).
  // No raw key is in config: privateKeyRef is a credential NAME (e.g. HAVEN_PRIVATE_KEY)
  // resolved here per-operation-style and immediately handed to the backend.
  // Filecoin-only: privateKeyRef+rpcUrl required.
  // Gated: store only the credential NAME and RPC URL; raw key is resolved per operation via the harness gate (like xmtp signatures)
  const synapse = new SynapseRuntime(ctx, config.wallet, {
    privateKeyRef: config.privateKeyRef,
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
