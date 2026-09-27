/**
 * Durable Haven-AOL key store: the epoch/vetKey caches are tiny and
 * append-only, so a configured path keeps them across restarts.
 *
 * Conventions follow the dsh-channel-xmtp outbox (the house pattern for
 * small persisted state):
 * - Versioned JSON: `{ version: 1, epochs: [...], vetKeys: [...] }`.
 * - Load is best-effort: a missing or corrupt file starts empty (and
 *   logs), never blocks sealing or decrypting. Invalid entries are
 *   skipped individually while valid ones load.
 * - Saves are atomic (tmp + rename) with the file created 0600, parent
 *   dirs made recursively. Save failures degrade to memory-only, never
 *   fail the seal/decrypt — with one exception: after a successful
 *   in-memory fill the key is live regardless of the disk outcome.
 * - Merge-on-save: the file is re-read and unioned with memory before
 *   every write, first-persisted-wins per slot. This matters because
 *   the vault path mints one short-lived runtime per decrypt call —
 *   without the merge, concurrent runtimes would drop each other's
 *   keys last-writer-wins.
 *
 * Same-slot conflicts (two runtimes filling one bucket before either
 * saves) keep the file's key and log; the loser's in-memory key stays
 * live for its own call. Divergent wrapped blobs within a bucket are
 * legal — one vetKey opens every IBE ciphertext under its identity —
 * just untidy. In practice the window is one DPK round-trip wide.
 *
 * @module dsh-haven-aol/keyStore
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { VetKey } from '@icp-sdk/vetkeys'
import {
  EpochAesKeyCache,
  VetKeyCache,
  makeEpochCacheKey,
  type EpochBucket,
} from './keyCache.ts'

export const KEY_STORE_VERSION = 1

interface StoredEpoch {
  slot: string
  bucket: { chain: string; tokenAddress: string; threshold: string; epoch: number }
  rawKeyB64: string
  wrappedB64: string
}

interface StoredVetKey {
  slot: string
  vetKeyB64: string
}

interface StoredFile {
  version: number
  epochs: StoredEpoch[]
  vetKeys: StoredVetKey[]
}

/** Raw parsed shape check (per-entry validation happens in load). */
function asStoredFile(parsed: unknown): StoredFile | undefined {
  if (parsed === null || typeof parsed !== 'object') return undefined
  const { version, epochs, vetKeys } = parsed as Partial<StoredFile>
  if (version !== KEY_STORE_VERSION) return undefined
  if (!Array.isArray(epochs) || !Array.isArray(vetKeys)) return undefined
  return { version, epochs: epochs as StoredEpoch[], vetKeys: vetKeys as StoredVetKey[] }
}

function parseEpochBucket(raw: unknown): EpochBucket | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const { chain, tokenAddress, threshold, epoch } = raw as Record<string, unknown>
  if (typeof chain !== 'string' || typeof tokenAddress !== 'string') return undefined
  if (typeof threshold !== 'string' || typeof epoch !== 'number') return undefined
  let thresholdBig: bigint
  try {
    thresholdBig = BigInt(threshold)
  } catch {
    return undefined
  }
  return { chain, tokenAddress, threshold: thresholdBig, epoch }
}

/**
 * Load stored keys into live caches. Best-effort: missing/corrupt files
 * and invalid entries are skipped with a log line, never thrown.
 */
export async function loadKeyStore(
  path: string,
  epochKeys: EpochAesKeyCache,
  vetKeys: VetKeyCache,
): Promise<{ epochs: number; vetKeys: number }> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.log(`[haven-aol] key store unreadable (${path}), starting empty: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { epochs: 0, vetKeys: 0 }
  }
  const file = asStoredFile(parsed)
  if (!file) {
    console.log(`[haven-aol] key store corrupt (${path}), starting empty`)
    return { epochs: 0, vetKeys: 0 }
  }
  let epochs = 0
  for (const entry of file.epochs) {
    if (entry === null || typeof entry !== 'object') continue
    const { slot, bucket: rawBucket, rawKeyB64, wrappedB64 } = entry as Partial<StoredEpoch>
    const bucket = parseEpochBucket(rawBucket)
    if (typeof slot !== 'string' || !bucket) continue
    if (typeof rawKeyB64 !== 'string' || typeof wrappedB64 !== 'string') continue
    let rawKey: Uint8Array
    try {
      rawKey = new Uint8Array(Buffer.from(rawKeyB64, 'base64'))
    } catch {
      continue
    }
    try {
      // Slot must recompute from the bucket (tamper/corruption guard);
      // put() enforces the 32-byte key + non-empty blob rules.
      if (makeEpochCacheKey(bucket) !== slot) continue
      epochKeys.put(bucket, { rawKey, wrappedB64 })
      epochs += 1
    } catch {
      continue // invalid bucket or value: skip, keep loading
    }
  }
  let vetKeyCount = 0
  for (const entry of file.vetKeys) {
    if (entry === null || typeof entry !== 'object') continue
    const { slot, vetKeyB64 } = entry as Partial<StoredVetKey>
    if (typeof slot !== 'string' || slot === '' || typeof vetKeyB64 !== 'string' || vetKeyB64 === '') continue
    try {
      vetKeys.put(slot, VetKey.deserialize(new Uint8Array(Buffer.from(vetKeyB64, 'base64'))))
      vetKeyCount += 1
    } catch {
      continue // undecodable bytes: skip, keep loading
    }
  }
  return { epochs, vetKeys: vetKeyCount }
}

/**
 * Persist live caches, unioned with whatever the file already holds
 * (first-persisted-wins per slot). Best-effort: failures log and
 * resolve — the in-memory keys stay live either way.
 */
export async function saveKeyStore(
  path: string,
  epochKeys: EpochAesKeyCache,
  vetKeys: VetKeyCache,
): Promise<void> {
  try {
    // Merge base: current file content wins on conflict (it persisted
    // first); unknown shapes start the union empty, like load.
    let base: StoredFile = { version: KEY_STORE_VERSION, epochs: [], vetKeys: [] }
    try {
      const parsed = asStoredFile(JSON.parse(await readFile(path, 'utf8')))
      if (parsed) base = parsed
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.log(`[haven-aol] key store unreadable during save (${path}), overwriting: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const epochSlots = new Set(base.epochs.map(e => e?.slot))
    for (const { slot, bucket, value } of epochKeys.snapshot()) {
      if (typeof slot !== 'string' || epochSlots.has(slot)) continue
      epochSlots.add(slot)
      base.epochs.push({
        slot,
        bucket: {
          chain: bucket.chain,
          tokenAddress: bucket.tokenAddress,
          threshold: bucket.threshold.toString(),
          epoch: bucket.epoch,
        },
        rawKeyB64: Buffer.from(value.rawKey).toString('base64'),
        wrappedB64: value.wrappedB64,
      })
    }
    const vetSlots = new Set(base.vetKeys.map(e => e?.slot))
    for (const { slot, vetKey } of vetKeys.snapshot()) {
      if (typeof slot !== 'string' || vetSlots.has(slot)) continue
      let vetKeyB64: string
      try {
        vetKeyB64 = Buffer.from(vetKey.serialize()).toString('base64')
      } catch {
        continue // unserializable (e.g. test forgery): memory-only
      }
      vetSlots.add(slot)
      base.vetKeys.push({ slot, vetKeyB64 })
    }
    await mkdir(dirname(path), { recursive: true })
    const tmp = join(dirname(path), `.keys.${Date.now()}.${Math.floor(Math.random() * 1e9)}.tmp`)
    await writeFile(tmp, JSON.stringify({ version: KEY_STORE_VERSION, epochs: base.epochs, vetKeys: base.vetKeys }), { mode: 0o600 })
    await rename(tmp, path)
  } catch (error: unknown) {
    console.log(`[haven-aol] key store persist failed (${path}), memory-only: ${error instanceof Error ? error.message : String(error)}`)
  }
}
