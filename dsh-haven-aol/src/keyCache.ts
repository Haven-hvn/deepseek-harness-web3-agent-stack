/**
 * In-memory Haven-AOL key caches (upstream Bugs 4–6 parity).
 *
 * Two caches, matching the reference `crypto/epoch_key_cache.py`
 * (encrypt side) and `crypto/gate_key_cache.py` (decrypt side):
 *
 * - {@link EpochAesKeyCache}: one AES content key + its IBE-wrapped blob
 *   per v3 `(chain, token, threshold, epoch)` bucket. N files sealed in
 *   one epoch share one `encryptedAesKey` — the v3 efficiency promise.
 *   v1 keeps per-file keys by design; v4 keeps per-rung keys (sharing
 *   one AES key across rungs would let a rung-1 unlock open rung-2
 *   files, breaking the drip), so neither touches this cache.
 * - {@link VetKeyCache}: one canister-derived vetKey per derivation
 *   input. N decrypts in one bucket cost one signed gate round-trip
 *   plus N local unwraps. The reference implementation caches the
 *   canister's `{encrypted_key, verification_key}` bundle; the harness uses an
 *   ephemeral transport keypair per call, so it caches the RECOVERED
 *   vetKey instead (same bucket semantics, one less local op per hit).
 *
 * Custody: memory-first, with an optional durable store. The keys are
 * tiny (32-byte AES, 48-byte vetKeys) and append-only, so a configured
 * `keyStorePath` (see `./keyStore.ts`) keeps them across restarts in a
 * versioned JSON file; unset keeps memory-only behavior.
 * Either way there is deliberately no revocation within an epoch: a
 * member who legitimately held a bucket key could have saved the
 * unwrapped file keys anyway.
 *
 * Invariants (same as the reference implementation):
 * - Threshold-zero collapses epoch to 0 in the cache key, so the whole
 *   free corpus lands in one slot (callers pass the collapsed epoch;
 *   `makeEpochCacheKey` throws on `threshold == 0, epoch != 0` rather
 *   than silently collapsing, so callers stay honest).
 * - Decrypt lookups key off the derivation input computed from the
 *   gate METADATA — never the wall clock — so old-epoch ciphertext
 *   stays decryptable past rollover (scenario-D rule).
 * - Concurrent misses attach to one in-flight factory call (the
 *   single-threaded equivalent of a lock-held miss-fill).
 * - Rejections are never cached: a failed factory drops its slot so
 *   the next call retries.
 *
 * @module dsh-haven-aol/keyCache
 */

import type { VetKey } from '@icp-sdk/vetkeys'

/** Canonical v3 bucket: chain variant, token, threshold, epoch. */
export interface EpochBucket {
  chain: string
  tokenAddress: string
  threshold: bigint
  epoch: number
}

/** One cached epoch key bundle (raw AES key + its already-wrapped form). */
export interface EpochAesKey {
  /** 32 raw AES bytes (fed to AES-GCM with a fresh IV per seal — the key is shared, IVs never are). */
  rawKey: Uint8Array
  /** IBE-wrapped form (base64) stored in every `encryptedAesKey` field of this bucket. */
  wrappedB64: string
}

function fail(message: string): never {
  throw new Error(`dsh-haven-aol: ${message}`)
}

/**
 * Canonical cache slot for a bucket. The token lowercases (same corpus,
 * any case, one slot); the threshold stringifies (u256 has no JS number).
 * INVARIANT: seal() canonicalizes tokenAddress to lowercase BEFORE
 * wrapping, so the slot always agrees with the case-sensitive derivation
 * preimage. Never serve this slot a wrap computed under a differently-
 * cased token — the IBE open would fail although the gate terms match.
 */
export function makeEpochCacheKey(bucket: EpochBucket): string {
  if (typeof bucket.chain !== 'string' || bucket.chain.length === 0) fail('epoch cache key needs a non-empty chain')
  if (typeof bucket.tokenAddress !== 'string' || bucket.tokenAddress.length === 0) {
    fail('epoch cache key needs a non-empty tokenAddress')
  }
  if (typeof bucket.threshold !== 'bigint' || bucket.threshold < 0n) {
    fail(`epoch cache key needs a non-negative threshold, got ${String(bucket.threshold)}`)
  }
  if (!Number.isInteger(bucket.epoch) || bucket.epoch < 0) {
    fail(`epoch cache key needs a non-negative epoch, got ${String(bucket.epoch)}`)
  }
  if (bucket.threshold === 0n && bucket.epoch !== 0) {
    fail('threshold==0 requires epoch==0 (v3 canister collapse rule)')
  }
  return JSON.stringify([bucket.chain, bucket.tokenAddress.toLowerCase(), bucket.threshold.toString(), bucket.epoch])
}

export class EpochAesKeyCache {
  private readonly entries = new Map<string, EpochAesKey>()
  private readonly inflight = new Map<string, Promise<EpochAesKey>>()

  get(bucket: EpochBucket): EpochAesKey | undefined {
    return this.entries.get(makeEpochCacheKey(bucket))
  }

  put(bucket: EpochBucket, value: EpochAesKey): void {
    if (!(value.rawKey instanceof Uint8Array) || value.rawKey.length !== 32) {
      fail('epoch cache value needs a 32-byte rawKey')
    }
    if (typeof value.wrappedB64 !== 'string' || value.wrappedB64.length === 0) {
      fail('epoch cache value needs a non-empty wrappedB64')
    }
    this.entries.set(makeEpochCacheKey(bucket), { rawKey: new Uint8Array(value.rawKey), wrappedB64: value.wrappedB64 })
  }

  /**
   * Return the cached bundle, miss-filling via `factory` exactly once
   * even under concurrency (callers attach to the in-flight fill).
   */
  async getOrCreate(bucket: EpochBucket, factory: () => Promise<EpochAesKey>): Promise<EpochAesKey> {
    const slot = makeEpochCacheKey(bucket)
    const hit = this.entries.get(slot)
    if (hit !== undefined) return hit
    const pending = this.inflight.get(slot)
    if (pending !== undefined) return pending
    const fill = (async () => {
      const fresh = await factory()
      this.put(bucket, fresh)
      const stored = this.entries.get(slot) as EpochAesKey
      return stored
    })()
    this.inflight.set(slot, fill)
    try {
      return await fill
    } finally {
      // Failed fills must not poison the slot; settled fills live in
      // `entries`, so `inflight` holds no trace either way.
      if (this.inflight.get(slot) === fill) this.inflight.delete(slot)
    }
  }

  clear(): void {
    this.entries.clear()
    // In-flight fills still resolve into the (now empty) cache: correct,
    // they computed a live key. Only settled entries drop.
    // Memory-only by design: clear() never touches the key store file.
  }

  get size(): number {
    return this.entries.size
  }

  /**
   * Snapshot for the key store: `[slot, bucket, value]` triples with
   * copied key bytes. Slots recompute from the bucket on load.
   */
  snapshot(): Array<{ slot: string; bucket: EpochBucket; value: EpochAesKey }> {
    const out: Array<{ slot: string; bucket: EpochBucket; value: EpochAesKey }> = []
    for (const [slot, value] of this.entries) {
      const [chain, tokenAddress, threshold, epoch] = JSON.parse(slot) as [string, string, string, number]
      out.push({
        slot,
        bucket: { chain, tokenAddress, threshold: BigInt(threshold), epoch },
        value: { rawKey: new Uint8Array(value.rawKey), wrappedB64: value.wrappedB64 },
      })
    }
    return out
  }
}

/**
 * Cache slot for a recovered vetKey: hex of the derivation input the SDK
 * computed from the gate metadata (uniform across v1/v3/v4 — v1 folds
 * the CID in, so only exact-file repeats hit, which is correct).
 */
export function vetKeySlot(derivationInput: Uint8Array): string {
  if (!(derivationInput instanceof Uint8Array) || derivationInput.length === 0) {
    fail('vetKey slot needs a non-empty derivation input')
  }
  return Buffer.from(derivationInput).toString('hex')
}

export class VetKeyCache {
  private readonly entries = new Map<string, VetKey>()
  private readonly inflight = new Map<string, Promise<VetKey>>()

  get(slot: string): VetKey | undefined {
    return this.entries.get(slot)
  }

  put(slot: string, value: VetKey): void {
    if (typeof slot !== 'string' || slot.length === 0) fail('vetKey slot must be a non-empty string')
    this.entries.set(slot, value)
  }

  /**
   * Return the cached vetKey, miss-fetching via `fetcher` exactly once
   * even under concurrency. Gate denials (and any other rejection)
   * are never cached.
   */
  async getOrFetch(slot: string, fetcher: () => Promise<VetKey>): Promise<VetKey> {
    const hit = this.entries.get(slot)
    if (hit !== undefined) return hit
    const pending = this.inflight.get(slot)
    if (pending !== undefined) return pending
    const fill = fetcher()
    this.inflight.set(slot, fill)
    try {
      const fresh = await fill
      this.entries.set(slot, fresh)
      return fresh
    } catch (error: unknown) {
      if (this.inflight.get(slot) === fill) this.inflight.delete(slot)
      throw error
    } finally {
      // A settled fill leaves no trace in `inflight` (the entry holds it).
      if (this.inflight.get(slot) === fill) this.inflight.delete(slot)
    }
  }

  clear(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }

  /** Snapshot for the key store: `[slot, vetKey]` pairs. */
  snapshot(): Array<{ slot: string; vetKey: VetKey }> {
    return [...this.entries].map(([slot, vetKey]) => ({ slot, vetKey }))
  }
}
