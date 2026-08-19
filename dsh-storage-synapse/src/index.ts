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
import { httpError, resolveFetch } from './synapse.ts'
import type { Cid, PinStatus } from './synapse.ts'
import type { SynapsePinnedEvent } from './types.ts'

export type { Cid, PinStatus } from './synapse.ts'
export type { SynapsePinnedEvent } from './types.ts'

/** Cordis plugin name. */
export const name = 'storage-synapse'
/** Signing identity and the tool registry. */
export const inject = ['wallet', 'tools']

/** Plugin configuration. */
export interface Config {
  /**
   * Synapse/IPFS node HTTP API base URL. The default is the port of Haven's
   * default (`http://127.0.0.1:5001`, the standard Kubo API address).
   */
  url?: string
  /**
   * Configured `dsh-wallet` wallet name that signs every request. Required:
   * this package authenticates by wallet signature, not by a stored storage
   * key — there is deliberately no key/credential field here.
   */
  wallet: string
}

/** Config schema. */
export const Config: z<Config> = z.object({
  url: z.string().default('http://127.0.0.1:5001'),
  wallet: z.string().required(),
})

/**
 * The `ctx.synapse` seam: Haven's `StorageAdapter` operation surface over
 * one configured node, with wallet-signed authentication.
 */
export class SynapseRuntime {
  private readonly url: string

  constructor(
    private readonly ctx: Context,
    private readonly wallet: string,
    url: string,
  ) {
    this.url = url.replace(/\/+$/, '')
  }

  /**
   * Store bytes on the node (CIDv1). Storing on the local node also pins
   * locally; `pin` makes the intent explicit and returns the recorded status.
   * @param data - raw bytes to store.
   * @param signal - abort signal bounding the request.
   * @returns the content identifier.
   */
  async store(data: Uint8Array, signal?: AbortSignal): Promise<{ cid: Cid }> {
    const formData = new FormData()
    formData.append('file', new Blob([data as BlobPart]))
    const response = await this.request('add?cid-version=1', { body: formData, signal })
    if (!response.ok) throw httpError('add', response)
    const result = await response.json() as { Hash: string }
    return { cid: result.Hash }
  }

  /**
   * Retrieve stored bytes by CID.
   * @param cid - the content identifier.
   * @param signal - abort signal bounding the request.
   * @returns the raw bytes.
   */
  async retrieve(cid: Cid, signal?: AbortSignal): Promise<Uint8Array> {
    const response = await this.request(`cat?arg=${encodeURIComponent(cid)}`, { signal })
    if (!response.ok) throw httpError('cat', response)
    return new Uint8Array(await response.arrayBuffer())
  }

  /**
   * Pin one CID (Haven's `renewPin`: pinning an already-pinned CID renews
   * it). Emits `synapse/pinned` at the commit point.
   * @param cid - the content identifier.
   * @param signal - abort signal bounding the request.
   * @returns the pin status after the operation.
   */
  async pin(cid: Cid, signal?: AbortSignal): Promise<PinStatus> {
    const response = await this.request(`pin/add?arg=${encodeURIComponent(cid)}`, { signal })
    if (!response.ok) throw httpError('pin/add', response)
    const status: PinStatus = { cid, provider: 'synapse', expiresAt: 0, redundancy: 1 }
    this.ctx.emit('synapse/pinned', { cid } satisfies SynapsePinnedEvent)
    return status
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
    try {
      const response = await this.request(`pin/ls?arg=${encodeURIComponent(cid)}&type=all`, { signal })
      if (!response.ok) return { cid, provider: 'synapse', expiresAt: -1, redundancy: 0 }
      const result = await response.json() as { Keys?: Record<string, { Type: string }> }
      if (result.Keys?.[cid] !== undefined) {
        return { cid, provider: 'synapse', expiresAt: 0, redundancy: 1 }
      }
      return { cid, provider: 'synapse', expiresAt: -1, redundancy: 0 }
    } catch {
      return { cid, provider: 'synapse', expiresAt: -1, redundancy: 0 }
    }
  }

  /**
   * One signed POST to the node. The auth headers are minted HERE, per
   * request: a canonical challenge binds the signature to this operation and
   * a timestamp, `ctx.wallet.signMessage` runs the resolve→load→sign→drop
   * pipeline, and the node verifies signature-over-challenge against the
   * presented address. Nothing persists between requests.
   */
  private async request(
    pathWithQuery: string,
    options: { body?: FormData; signal?: AbortSignal },
  ): Promise<Response> {
    const [path] = pathWithQuery.split('?', 1) as [string]
    const challenge = `synapse:${path}:${Date.now()}`
    const { address, signature } = await this.ctx.wallet.signMessage(this.wallet, challenge)
    const fetchImpl = resolveFetch()
    return fetchImpl(`${this.url}/api/v0/${pathWithQuery}`, {
      method: 'POST',
      ...options.body !== undefined ? { body: options.body } : {},
      ...options.signal !== undefined ? { signal: options.signal } : {},
      headers: {
        'x-synapse-address': address,
        'x-synapse-challenge': challenge,
        'x-synapse-signature': signature,
      },
    })
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
  const synapse = new SynapseRuntime(ctx, config.wallet, config.url ?? 'http://127.0.0.1:5001')
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
