/**
 * Narrow HTTP transport of the Synapse/IPFS storage node, ported from
 * haven-adapters `SynapseStorageAdapter`. That adapter was explicitly a
 * scaffold over the standard Kubo/IPFS HTTP API (`/api/v0/add`, `cat`,
 * `pin/ls`, `pin/add`) with the real Synapse SDK slotted in later; this
 * module keeps exactly that surface and nothing else.
 *
 * What does NOT carry over: Haven authenticated with a raw storage key
 * (`"env:VAR"` / `"0x…"` resolved into a bearer header). Here authentication
 * is a *signature* produced through `ctx.wallet` per request (see
 * `src/index.ts`), so no storage credential exists in configuration or in
 * this module at all.
 *
 * @module dsh-storage-synapse/synapse
 */

/** Content identifier returned by the node (CIDv1 requested on store). */
export type Cid = string

/**
 * Pin health of one CID, ported verbatim from Haven's `StorageAdapter`
 * `checkPin`/`renewPin` result shape: `expiresAt` `0` means permanent,
 * `-1` means not pinned; `redundancy` is the replica count (`0` = unpinned).
 */
export interface PinStatus {
  /** The content identifier. */
  readonly cid: Cid
  /** Storage provider label (always `synapse` for this transport). */
  readonly provider: string
  /** Unix ms expiry; `0` = permanent, `-1` = not pinned. */
  readonly expiresAt: number
  /** Replica count; `0` = not pinned. */
  readonly redundancy: number
}

/**
 * Test seam: substitute the HTTP transport without a live node. Production
 * resolution falls back to `globalThis.fetch`; a spec assigns a recording
 * fake here and restores `undefined` afterwards.
 */
export const internals: { fetch: typeof globalThis.fetch | undefined } = { fetch: undefined }

/** Resolve the active transport (test seam first, platform fetch otherwise). */
export function resolveFetch(): typeof globalThis.fetch {
  return internals.fetch ?? globalThis.fetch
}

/**
 * Fail-loud guard for HTTP-level failures: the node answered, but not with
 * success. Mirrors Haven's `IPFS <op> failed: <status>` messages with the
 * package prefix dsh error text conventions want.
 * @param operation - human-readable operation label (e.g. `add`, `pin/add`).
 * @param response - the non-ok response.
 */
export function httpError(operation: string, response: Response): Error {
  return new Error(`dsh-storage-synapse: ${operation} failed: ${response.status} ${response.statusText}`)
}
