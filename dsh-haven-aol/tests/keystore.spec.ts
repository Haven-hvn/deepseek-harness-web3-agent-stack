/**
 * Key-store proofs for dsh-haven-aol: keys are tiny, so they persist.
 *
 * The epoch/vetKey caches are append-only and small (32-byte AES keys,
 * 48-byte vetKeys), so a configured `keyStorePath` keeps them across
 * restarts in a versioned JSON file (0600, atomic tmp+rename — the xmtp
 * outbox convention). Unset path keeps the old memory-only behavior.
 *
 * 1. A v3 epoch key sealed by one runtime is reused by a fresh runtime
 *    off the same store: same `encryptedAesKey` blob, zero DPK calls.
 * 2. A vetKey flushed by one runtime opens the real IBE path in a fresh
 *    runtime with zero gate calls and zero signatures (a generator-point
 *    stand-in: real VetKey bytes, wrong key — so the IBE decrypt must
 *    throw, proving the loaded value reached the real crypto).
 * 3. Concurrent per-call runtimes (the vault signDigest path mints one
 *    runtime per decrypt) union through the file: each save merges, so
 *    no runtime's keys are dropped.
 * 4. A corrupt store starts empty and self-heals; invalid entries are
 *    skipped while valid ones load.
 * 5. Unset `keyStorePath` stays memory-only: fresh runtimes diverge.
 */

import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { computeDerivationInputV3 } from 'haven-aol'
import { VetKey } from '@icp-sdk/vetkeys'
import { AolRuntime, internals } from '../src/aol.ts'
import { vetKeySlot } from '../src/keyCache.ts'

const TOKEN = '0x2222222222222222222222222222222222222222'
const VERIFIER = '0x1111111111111111111111111111111111111111'
// BLS12-381 G1 generator (compressed): deserializes to a real VetKey
// offline, so persistence round-trips without a canister master secret.
const GENERATOR_VETKEY_B64 = Buffer.from(
  '97f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb',
  'hex',
).toString('base64')

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

/** Counting stub DPK: proves whether a fill ran (miss) or not (hit). */
function stubDpk(count: { calls: number }) {
  internals.dpk = async (version: 1 | 3 | 4) => {
    count.calls += 1
    return dpkFixture(version)
  }
}

function runtime(keyStorePath?: string) {
  return new AolRuntime({
    canisterId: 'gny6k-fqaaa-aaaab-ag3ra-cai',
    icpHost: 'https://icp-api.io',
    fetchRootKey: false,
    ...(keyStorePath !== undefined ? { keyStorePath } : {}),
  })
}

async function freshStore(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'haven-aol-keys-')), 'keys.json')
}

describe('epoch key persistence', () => {
  it('a fresh runtime reuses the sealed epoch key: same blob, zero DPK calls, 0600 file', async () => {
    const path = await freshStore()
    const dpk = { calls: 0 }
    stubDpk(dpk)
    const seal = {
      version: 3 as const, cid: 'sha256:abc', chain: 'BaseMainnet' as const,
      tokenAddress: TOKEN, threshold: 100n, plaintext: new TextEncoder().encode('file-a'),
    }
    const first = await runtime(path).seal(seal)
    expect(dpk.calls).toBe(1)

    const mode = (await stat(path)).mode & 0o777
    expect(mode).toBe(0o600)
    const stored = JSON.parse(await readFile(path, 'utf8')) as { version: number; epochs: unknown[]; vetKeys: unknown[] }
    expect(stored.version).toBe(1)
    expect(stored.epochs).toHaveLength(1)

    dpk.calls = 0
    const rt2 = runtime(path)
    const second = await rt2.seal({ ...seal, plaintext: new TextEncoder().encode('file-b') })
    expect(JSON.parse(second.gateMetadataJson).encryptedAesKey)
      .toBe(JSON.parse(first.gateMetadataJson).encryptedAesKey)
    expect(second.keySha256).toBe(first.keySha256)
    expect(Buffer.from(second.sealedBytes).equals(Buffer.from(first.sealedBytes))).toBe(false) // fresh IVs
    expect(dpk.calls).toBe(0) // factory never ran: the key came off disk
    expect(rt2.epochKeys.size).toBe(1)
  })

  it('per-call runtimes union through the file (merge-on-save, nothing dropped)', async () => {
    const path = await freshStore()
    stubDpk({ calls: 0 })
    const base = {
      version: 3 as const, cid: 'sha256:abc', chain: 'BaseMainnet' as const,
      tokenAddress: TOKEN, plaintext: new TextEncoder().encode('x'),
    }
    await runtime(path).seal({ ...base, threshold: 100n })
    // A second runtime loads {100}, seals another bucket, saves the union.
    await runtime(path).seal({ ...base, threshold: 200n })
    const stored = JSON.parse(await readFile(path, 'utf8')) as { epochs: Array<{ bucket: { threshold: string } }> }
    expect(stored.epochs.map(e => e.bucket.threshold).sort()).toEqual(['100', '200'])
    // And a third runtime loads both without any DPK call.
    const dpk = { calls: 0 }
    stubDpk(dpk)
    const rt3 = runtime(path)
    await rt3.seal({ ...base, threshold: 100n })
    await rt3.seal({ ...base, threshold: 200n })
    expect(dpk.calls).toBe(0)
    expect(rt3.epochKeys.size).toBe(2)
  })
})

describe('vetKey persistence', () => {
  it('a flushed vetKey opens the real IBE path after restart with zero gate calls and zero signatures', async () => {
    const path = await freshStore()
    stubDpk({ calls: 0 })
    const rt1 = runtime(path)
    const plaintext = new TextEncoder().encode('epoch-file')
    const sealed = await rt1.seal({
      version: 3, cid: 'bafytest', chain: 'BaseMainnet', tokenAddress: TOKEN,
      threshold: 100n, plaintext,
    })
    const epoch = JSON.parse(sealed.gateMetadataJson).epoch as number
    const derivation = await computeDerivationInputV3('BaseMainnet', TOKEN, 100n, epoch)
    rt1.vetKeys.put(vetKeySlot(derivation), VetKey.deserialize(Buffer.from(GENERATOR_VETKEY_B64, 'base64')))
    await rt1.flushKeys()

    const stored = JSON.parse(await readFile(path, 'utf8')) as { vetKeys: Array<{ slot: string; vetKeyB64: string }> }
    expect(stored.vetKeys).toHaveLength(1)
    expect(stored.vetKeys[0]?.vetKeyB64).toBe(GENERATOR_VETKEY_B64)

    let calls = 0
    let signs = 0
    internals.requestV3 = (async () => {
      calls += 1
      throw new Error('must not be called on a store hit')
    }) as never
    const rt2 = new AolRuntime({
      canisterId: 'gny6k-fqaaa-aaaab-ag3ra-cai',
      icpHost: 'https://icp-api.io',
      fetchRootKey: false,
      keyStorePath: path,
      signGate: (async () => {
        signs += 1
        throw new Error('must not sign on a store hit')
      }),
    })
    // Wrong-key bytes cannot open the blob, so the IBE decrypt must
    // throw — proving the loaded value reached the real crypto.
    await expect(rt2.decryptV3({
      gateMetadataJson: sealed.gateMetadataJson, encryptedFileBytes: sealed.sealedBytes,
      evmAddress: VERIFIER, eip712ChainId: 8453n, eip712VerifyingContract: VERIFIER, nonce: 1n,
    })).rejects.toThrow()
    expect(calls).toBe(0)
    expect(signs).toBe(0)
    expect(rt2.vetKeys.size).toBe(1)
  })
})

describe('store failure modes', () => {
  it('a corrupt store starts empty and self-heals on the next fill', async () => {
    const path = await freshStore()
    await writeFile(path, 'not json {{{')
    stubDpk({ calls: 0 })
    const rt = runtime(path)
    const sealed = await rt.seal({
      version: 3, cid: 'sha256:abc', chain: 'BaseMainnet', tokenAddress: TOKEN,
      threshold: 100n, plaintext: new TextEncoder().encode('x'),
    })
    expect(sealed.keySha256).toMatch(/^[0-9a-f]{64}$/)
    // The fill rewrote a valid store (best-effort load never blocks sealing).
    const stored = JSON.parse(await readFile(path, 'utf8')) as { version: number; epochs: unknown[] }
    expect(stored.version).toBe(1)
    expect(stored.epochs).toHaveLength(1)
  })

  it('invalid entries are skipped while valid ones load', async () => {
    const path = await freshStore()
    stubDpk({ calls: 0 })
    const rt1 = runtime(path)
    const first = await rt1.seal({
      version: 3, cid: 'sha256:abc', chain: 'BaseMainnet', tokenAddress: TOKEN,
      threshold: 100n, plaintext: new TextEncoder().encode('x'),
    })
    const stored = JSON.parse(await readFile(path, 'utf8')) as {
      version: number; epochs: unknown[]; vetKeys: unknown[]
    }
    stored.epochs.push(
      { slot: 'junk', bucket: { chain: '', tokenAddress: '', threshold: 'x', epoch: -1 }, rawKeyB64: '!!!', wrappedB64: '' },
      { ...(stored.epochs[0] as object), slot: 'tampered-slot' }, // slot mismatch
    )
    stored.vetKeys.push({ slot: 'aa', vetKeyB64: 'not-vetkey-bytes!!' })
    await writeFile(path, JSON.stringify(stored))

    const dpk = { calls: 0 }
    stubDpk(dpk)
    const rt2 = runtime(path)
    const second = await rt2.seal({
      version: 3, cid: 'sha256:abc', chain: 'BaseMainnet', tokenAddress: TOKEN,
      threshold: 100n, plaintext: new TextEncoder().encode('y'),
    })
    expect(JSON.parse(second.gateMetadataJson).encryptedAesKey)
      .toBe(JSON.parse(first.gateMetadataJson).encryptedAesKey)
    expect(dpk.calls).toBe(0)
    expect(rt2.epochKeys.size).toBe(1)
    expect(rt2.vetKeys.size).toBe(0)
  })

  it('unset keyStorePath stays memory-only: fresh runtimes diverge', async () => {
    stubDpk({ calls: 0 })
    const seal = {
      version: 3 as const, cid: 'sha256:abc', chain: 'BaseMainnet' as const,
      tokenAddress: TOKEN, threshold: 100n, plaintext: new TextEncoder().encode('x'),
    }
    const a = await runtime().seal(seal)
    const b = await runtime().seal(seal)
    expect(b.keySha256).not.toBe(a.keySha256)
  })
})
