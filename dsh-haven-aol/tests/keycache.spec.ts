/**
 * Key-cache proofs for dsh-haven-aol (upstream Bugs 4–6 parity).
 *
 * 1. Cache units: bucket-key validation (incl. threshold-zero collapse
 *    and token case-folding), factory-once miss-fill under concurrency,
 *    failures never cached.
 * 2. Seal integration (test-only local DPKs, real IBE/AES): v3 seals in
 *    one bucket share one AES key + wrapped blob while sealed bytes stay
 *    unique per seal; v1/v4 still mint per seal; distinct buckets diverge.
 * 3. Decrypt wiring: gate denials bypass the cache (never stored), cache
 *    lookups key off the gate METADATA epoch (scenario-D rule), and a
 *    pre-populated vetKey flows into the real IBE-decrypt path with zero
 *    gate calls and zero signatures.
 *
 * A live canister round-trip success cannot be proven offline (no test
 * master secret exists in @icp-sdk/vetkeys), so the hit path is proven
 * by pre-population: the only unreal input is the cached key itself,
 * which in production comes from a real gate call.
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  BOND_ADDRESSES,
  buildGateMetadataV3,
  computeDerivationInputV3,
  currentEpoch,
  gateMetadataV3ToJson,
} from 'haven-aol'
import { AolRuntime, internals } from '../src/aol.ts'
import {
  EpochAesKeyCache,
  VetKeyCache,
  makeEpochCacheKey,
  vetKeySlot,
} from '../src/keyCache.ts'

const TOKEN = '0x2222222222222222222222222222222222222222'
const VERIFIER = '0x1111111111111111111111111111111111111111'

afterEach(() => {
  internals.requestV1 = undefined
  internals.requestV3 = undefined
  internals.requestV4 = undefined
  internals.marketCap = undefined
  internals.dpk = undefined
})

async function dpkFixture(version: 1 | 3 | 4): Promise<Uint8Array> {
  const { MasterPublicKey } = await import('@icp-sdk/vetkeys')
  const { Principal } = await import('@icp-sdk/core/principal')
  const master = MasterPublicKey.productionKey()
  const canister = Principal.fromText('gny6k-fqaaa-aaaab-ag3ra-cai').toUint8Array()
  return master.deriveCanisterKey(canister).deriveSubKey(new TextEncoder().encode(`accessol_v${version}`)).publicKeyBytes()
}

function stubDpk() {
  internals.dpk = (version: 1 | 3 | 4) => dpkFixture(version)
}

function plainRuntime(signGate?: (digestHex: `0x${string}`) => Promise<`0x${string}`>) {
  return new AolRuntime({
    canisterId: 'gny6k-fqaaa-aaaab-ag3ra-cai',
    icpHost: 'https://icp-api.io',
    fetchRootKey: false,
    ...(signGate !== undefined ? { signGate } : {}),
  })
}

describe('EpochAesKeyCache', () => {
  it('validates bucket keys (threshold-zero collapse enforced, not silent)', () => {
    const base = { chain: 'BaseMainnet', tokenAddress: TOKEN, threshold: 100n, epoch: 9 }
    expect(typeof makeEpochCacheKey(base)).toBe('string')
    // Same corpus, any token case, one slot.
    expect(makeEpochCacheKey({ ...base, tokenAddress: TOKEN.toUpperCase() })).toBe(makeEpochCacheKey(base))
    // Threshold-zero collapses to the eternal slot.
    expect(makeEpochCacheKey({ ...base, threshold: 0n, epoch: 0 })).not.toBe(makeEpochCacheKey(base))
    expect(() => makeEpochCacheKey({ ...base, chain: '' })).toThrow('non-empty chain')
    expect(() => makeEpochCacheKey({ ...base, tokenAddress: '' })).toThrow('non-empty tokenAddress')
    expect(() => makeEpochCacheKey({ ...base, threshold: -1n })).toThrow('non-negative threshold')
    expect(() => makeEpochCacheKey({ ...base, epoch: -1 })).toThrow('non-negative epoch')
    expect(() => makeEpochCacheKey({ ...base, threshold: 0n, epoch: 5 })).toThrow('threshold==0 requires epoch==0')
  })

  it('validates values and copies keys on install', () => {
    const cache = new EpochAesKeyCache()
    const bucket = { chain: 'BaseMainnet', tokenAddress: TOKEN, threshold: 1n, epoch: 1 }
    expect(() => cache.put(bucket, { rawKey: new Uint8Array(16), wrappedB64: 'eA==' })).toThrow('32-byte rawKey')
    expect(() => cache.put(bucket, { rawKey: new Uint8Array(32), wrappedB64: '' })).toThrow('non-empty wrappedB64')
    const raw = new Uint8Array(32).fill(7)
    cache.put(bucket, { rawKey: raw, wrappedB64: 'eA==' })
    raw.fill(0) // mutating the caller's buffer must not touch the cache
    expect(cache.get(bucket)?.rawKey).toEqual(new Uint8Array(32).fill(7))
    expect(cache.size).toBe(1)
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.get(bucket)).toBeUndefined()
  })

  it('miss-fills exactly once, even under concurrency; failures never cache', async () => {
    const cache = new EpochAesKeyCache()
    const bucket = { chain: 'BaseMainnet', tokenAddress: TOKEN, threshold: 1n, epoch: 1 }
    let fills = 0
    const factory = async () => {
      fills += 1
      await new Promise(resolve => setTimeout(resolve, 5))
      return { rawKey: new Uint8Array(32).fill(3), wrappedB64: 'eA==' }
    }
    const [a, b] = await Promise.all([cache.getOrCreate(bucket, factory), cache.getOrCreate(bucket, factory)])
    expect(fills).toBe(1)
    expect(a).toBe(b) // one fill, shared identity
    expect(cache.size).toBe(1)

    const failing = new EpochAesKeyCache()
    let attempts = 0
    const bomb = async (): Promise<never> => {
      attempts += 1
      throw new Error('dpk down')
    }
    await expect(failing.getOrCreate(bucket, bomb)).rejects.toThrow('dpk down')
    await expect(failing.getOrCreate(bucket, bomb)).rejects.toThrow('dpk down')
    expect(attempts).toBe(2)
    expect(failing.size).toBe(0)
  })
})

describe('VetKeyCache', () => {
  it('slots derivation inputs as hex; rejects empties', () => {
    expect(vetKeySlot(new Uint8Array([0xab, 0x00]))).toBe('ab00')
    expect(() => vetKeySlot(new Uint8Array(0))).toThrow('non-empty derivation input')
  })

  it('fetches exactly once under concurrency; denials never cache', async () => {
    const cache = new VetKeyCache()
    let fetches = 0
    const fetcher = async () => {
      fetches += 1
      await new Promise(resolve => setTimeout(resolve, 5))
      return { tag: 'vetkey' } as never
    }
    const [a, b] = await Promise.all([cache.getOrFetch('aa', fetcher), cache.getOrFetch('aa', fetcher)])
    expect(fetches).toBe(1)
    expect(a).toBe(b)
    await expect(cache.getOrFetch('bb', async () => { throw new Error('InsufficientBalance') })).rejects.toThrow()
    expect(cache.get('bb')).toBeUndefined()
    expect(cache.size).toBe(1)
    cache.clear()
    expect(cache.size).toBe(0)
  })
})

describe('seal-side epoch sharing (real IBE/AES, stub DPK)', () => {
  function v3seal(rt: AolRuntime, plaintext: Uint8Array, extra: Record<string, unknown> = {}) {
    return rt.seal({
      version: 3, cid: 'sha256:abc', chain: 'BaseMainnet', tokenAddress: TOKEN,
      threshold: 100n, plaintext, ...extra,
    } as never)
  }

  it('v3 seals in one bucket share the key + blob; bytes stay unique', async () => {
    stubDpk()
    const rt = plainRuntime()
    const a = await v3seal(rt, new TextEncoder().encode('file-a'))
    const b = await v3seal(rt, new TextEncoder().encode('file-b'))
    expect(a.keySha256).toBe(b.keySha256)
    expect(JSON.parse(a.gateMetadataJson).encryptedAesKey).toBe(JSON.parse(b.gateMetadataJson).encryptedAesKey)
    expect(Buffer.from(a.sealedBytes).equals(Buffer.from(b.sealedBytes))).toBe(false) // fresh IVs
    expect(rt.epochKeys.size).toBe(1)
  })

  it('distinct buckets diverge; token case folds to one slot', async () => {
    stubDpk()
    const rt = plainRuntime()
    const bytes = new TextEncoder().encode('x')
    const base = await v3seal(rt, bytes)
    expect((await v3seal(rt, bytes, { epoch: currentEpoch() + 40 })).keySha256).not.toBe(base.keySha256)
    expect((await v3seal(rt, bytes, { threshold: 101n })).keySha256).not.toBe(base.keySha256)
    expect((await v3seal(rt, bytes, { tokenAddress: `0x${TOKEN.slice(2).toUpperCase()}` })).keySha256).toBe(base.keySha256)
    expect(rt.epochKeys.size).toBe(3)
  })

  it('concurrent same-bucket seals share one fill', async () => {
    stubDpk()
    const rt = plainRuntime()
    const bytes = new TextEncoder().encode('race')
    const [a, b] = await Promise.all([v3seal(rt, bytes), v3seal(rt, bytes)])
    expect(a.keySha256).toBe(b.keySha256)
    expect(rt.epochKeys.size).toBe(1)
  })

  it('v1 and v4 still mint per seal (no sharing by design)', async () => {
    stubDpk()
    const rt = plainRuntime()
    const bytes = new TextEncoder().encode('same-bytes')
    const v1a = await rt.seal({ version: 1, cid: 'sha256:abc', chain: 'BaseMainnet', tokenAddress: TOKEN, threshold: 100n, plaintext: bytes })
    const v1b = await rt.seal({ version: 1, cid: 'sha256:abc', chain: 'BaseMainnet', tokenAddress: TOKEN, threshold: 100n, plaintext: bytes })
    expect(v1a.keySha256).not.toBe(v1b.keySha256)
    const v4params = {
      version: 4 as const, cid: 'sha256:abc', chain: 'BaseMainnet' as const, tokenAddress: TOKEN,
      threshold: 100n, marketCapTarget: 10n, oracleAddress: BOND_ADDRESSES.BaseMainnet as string, plaintext: bytes,
    }
    const v4a = await rt.seal(v4params)
    const v4b = await rt.seal(v4params)
    expect(v4a.keySha256).not.toBe(v4b.keySha256)
    expect(rt.epochKeys.size).toBe(0)
  })

  it('threshold-zero seals from any wall epoch share the eternal slot', async () => {
    stubDpk()
    const rt = plainRuntime()
    const bytes = new TextEncoder().encode('free')
    const a = await v3seal(rt, bytes, { threshold: 0n, epoch: currentEpoch() })
    const b = await v3seal(rt, bytes, { threshold: 0n, epoch: currentEpoch() + 7 })
    expect(JSON.parse(a.gateMetadataJson).epoch).toBe(0)
    expect(a.keySha256).toBe(b.keySha256)
    expect(rt.epochKeys.size).toBe(1)
  })

  it('a failed wrap poisons nothing (next seal retries the fill)', async () => {
    const rt = plainRuntime()
    internals.dpk = async () => { throw new Error('canister down') }
    await expect(v3seal(rt, new TextEncoder().encode('x'))).rejects.toThrow('canister down')
    expect(rt.epochKeys.size).toBe(0)
    stubDpk()
    const sealed = await v3seal(rt, new TextEncoder().encode('x'))
    expect(sealed.keySha256).toMatch(/^[0-9a-f]{64}$/)
    expect(rt.epochKeys.size).toBe(1)
  })
})

describe('decrypt-side vetKey caching', () => {
  function v3gate(epoch: number, encryptedAesKey = Buffer.from('ciphertext').toString('base64')) {
    return gateMetadataV3ToJson(buildGateMetadataV3({
      cid: 'bafytest', chain: 'BaseMainnet', tokenAddress: TOKEN, threshold: 100,
      epoch, encryptedAesKey,
    }))
  }

  function stubSigner(count: { signs: number }) {
    return async () => {
      count.signs += 1
      return ('0x' + 'ab'.repeat(65)) as `0x${string}`
    }
  }

  it('gate denials bypass the cache (never stored, always re-asked)', async () => {
    let calls = 0
    internals.requestV3 = async () => {
      calls += 1
      return { err: { InvalidSignature: 'nope' } }
    }
    const count = { signs: 0 }
    const rt = plainRuntime(stubSigner(count))
    const params = {
      gateMetadataJson: v3gate(currentEpoch()), encryptedFileBytes: new Uint8Array([9, 9]),
      evmAddress: VERIFIER, eip712ChainId: 8453n, eip712VerifyingContract: VERIFIER, nonce: 1n,
    }
    await expect(rt.decryptV3(params)).rejects.toThrow(/InvalidSignature/)
    await expect(rt.decryptV3({ ...params, nonce: 2n })).rejects.toThrow(/InvalidSignature/)
    expect(calls).toBe(2)
    expect(rt.vetKeys.size).toBe(0)
  })

  it('lookups key off the metadata epoch, never the wall clock (scenario D)', async () => {
    const seen: unknown[] = []
    internals.requestV3 = (async (...args: unknown[]) => {
      seen.push(args)
      return { err: { InvalidEpoch: null } }
    }) as never
    const count = { signs: 0 }
    const rt = plainRuntime(stubSigner(count))
    const oldEpoch = currentEpoch() - 2
    await expect(rt.decryptV3({
      gateMetadataJson: v3gate(oldEpoch), encryptedFileBytes: new Uint8Array([9, 9]),
      evmAddress: VERIFIER, eip712ChainId: 8453n, eip712VerifyingContract: VERIFIER, nonce: 1n,
    })).rejects.toThrow()
    expect(seen).toHaveLength(1)
    expect((seen[0] as unknown[])[2]).toMatchObject({ epoch: BigInt(oldEpoch) })
  })

  it('a cached vetKey opens the real IBE path with zero gate calls and zero signatures', async () => {
    stubDpk()
    let calls = 0
    let signs = 0
    const rt = plainRuntime(async () => {
      signs += 1
      throw new Error('must not sign on a cache hit')
    })
    // A real v3 seal: genuine wrapped blob + sealed bytes under the stub DPK.
    const plaintext = new TextEncoder().encode('epoch-file')
    const sealed = await rt.seal({
      version: 3, cid: 'bafytest', chain: 'BaseMainnet', tokenAddress: TOKEN,
      threshold: 100n, plaintext,
    })
    const epoch = JSON.parse(sealed.gateMetadataJson).epoch as number
    const derivation = await computeDerivationInputV3('BaseMainnet', TOKEN, 100n, epoch)
    // The only unreal input: the cached key itself (production fills it
    // from a real gate call). It cannot open the blob, so the IBE-decrypt
    // must throw — proving the cached value reached the real crypto.
    rt.vetKeys.put(vetKeySlot(derivation), { tag: 'forged' } as never)
    internals.requestV3 = (async () => {
      calls += 1
      throw new Error('must not be called on a cache hit')
    }) as never
    await expect(rt.decryptV3({
      gateMetadataJson: sealed.gateMetadataJson, encryptedFileBytes: sealed.sealedBytes,
      evmAddress: VERIFIER, eip712ChainId: 8453n, eip712VerifyingContract: VERIFIER, nonce: 1n,
    })).rejects.toThrow()
    expect(calls).toBe(0)
    expect(signs).toBe(0)
    expect(rt.vetKeys.size).toBe(1) // downstream failure is not cache invalidation
  })
})
