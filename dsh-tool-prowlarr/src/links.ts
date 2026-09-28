/**
 * Short-lived server-side table for Prowlarr release links.
 *
 * A Prowlarr proxy `downloadUrl` is ~330 opaque characters (an encrypted
 * blob plus a `file` name Prowlarr requires); models mistranscribe blobs
 * that long, and one wrong character fails the download server-side with
 * "Failed to normalize provided link". So `prowlarr_search` stores each
 * hit's links here and shows a short `ref` (e.g. `pl_9f2c4a1b7e00`) that
 * `acquire_submit` resolves back to the byte-exact links. The model never
 * copies the blob.
 *
 * Same-process only: refs die with the process (and prune past the cap),
 * so an unknown ref tells the caller to re-run the search for fresh refs.
 * Peek semantics (no consume): exactly-once replays submit the same args
 * twice, and both passes must resolve.
 *
 * @module dsh-tool-prowlarr/links
 */

import { randomBytes } from 'node:crypto'

/** Fetchable links for one search hit (API key already stripped). */
export interface ReleaseLinks {
  downloadUrl?: string
  magnetUrl?: string
}

/** Refs past this count prune oldest-first down to half. */
export const MAX_LINK_REFS = 1000

const table = new Map<string, ReleaseLinks>()

/**
 * Store one hit's links and mint its ref.
 * @param links - redacted downloadUrl and/or magnetUrl.
 * @returns short transcription-safe ref (`pl_` + 12 hex chars).
 */
export function storeReleaseLinks(links: ReleaseLinks): string {
  const ref = `pl_${randomBytes(6).toString('hex')}`
  table.set(ref, { ...links })
  if (table.size > MAX_LINK_REFS) {
    for (const key of table.keys()) {
      if (table.size <= MAX_LINK_REFS / 2) break
      table.delete(key)
    }
  }
  return ref
}

/**
 * Resolve a ref to its stored links (peek: repeated resolves all succeed).
 * @param ref - ref from a `prowlarr_search` result.
 * @returns the links, or `undefined` for an unknown/expired ref.
 */
export function takeReleaseLinks(ref: string): ReleaseLinks | undefined {
  return table.get(ref)
}
