/**
 * Seam proofs for dsh-haven-aol (token-gated decrypt):
 *
 * 1. Pure protocol comes from the haven-aol SDK verbatim: epoch math,
 *    v3/v4 metadata build→parse round-trips, Bond-pin classification.
 * 2. gateInfo dispatches all versions without network.
 * 3. Tools work THROUGH THE EXECUTOR (ctx.tools.execute): reads succeed,
 *    decrypt without a wired signGate fails loud (AolSigningError, no
 *    silently-invalid signature), canister errors surface as tool errors.
 * 4. v4 fails closed client-side on non-Bond oracles before any network.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {
  buildGateMetadataV3,
  gateMetadataV3ToJson,
  buildGateMetadataV4,
  gateMetadataV4ToJson,
  currentEpoch,
  EPOCH_LENGTH_SECONDS,
  BOND_ADDRESSES,
} from 'haven-aol'
import * as havenAol from '../src/index.ts'
import { internals } from '../src/aol.ts'
import { AolSigningError } from '../src/types.ts'

const testSignal = new AbortController().signal
const VERIFIER = '0x1111111111111111111111111111111111111111'
const TOKEN = '0x2222222222222222222222222222222222222222'

afterEach(() => {
  internals.requestV1 = undefined
  internals.requestV3 = undefined
  internals.requestV4 = undefined
  internals.marketCap = undefined
  internals.dpk = undefined
})

async function harness() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  // Stub wallet (spike stand-in): decrypt tests need an EOA address to reach
  // the signGate seam, where the unwired default throws AolSigningError.
  ;(ctx as any).provide('wallet', {
    address: async () => '0x1111111111111111111111111111111111111111',
    list: () => [],
  })
  await ctx.plugin(havenAol, {
    wallet: 'agent',
    canisterId: 'gny6k-fqaaa-aaaab-ag3ra-cai',
    icpHost: 'https://icp-api.io',
    fetchRootKey: false,
  })
  let calls = 0
  const execute = (name: string, args: Record<string, unknown>) => ctx.tools.execute({
    callId: ToolCallId(`call-${calls += 1}`),
    name,
    arguments: args,
    signal: testSignal,
  })
  return { ctx, execute }
}

function v3meta(): string {
  return gateMetadataV3ToJson(buildGateMetadataV3({
    cid: 'bafytest',
    chain: 'BaseMainnet',
    tokenAddress: TOKEN,
    threshold: 100,
    epoch: currentEpoch(),
    encryptedAesKey: Buffer.from('ciphertext').toString('base64'),
  }))
}

function v4meta(oracle: string): string {
  return gateMetadataV4ToJson(buildGateMetadataV4({
    cid: 'bafytest',
    chain: 'BaseMainnet',
    tokenAddress: TOKEN,
    threshold: 100,
    epoch: currentEpoch(),
    marketCapTarget: 10,
    oracleAddress: oracle,
    encryptedAesKey: Buffer.from('ciphertext').toString('base64'),
  }))
}

describe('pure protocol (SDK-verbatim)', () => {
  it('epoch matches SDK clock math with consistent rollover', async () => {
    const { execute } = await harness()
    const res = await execute('aol_epoch', {})
    expect(res.isError).toBe(false)
    const body = JSON.parse((res.content as Array<{ text: string }>)[0]?.text ?? '{}') as {
      epoch: number; epochLengthSeconds: number; nextRolloverUnix: number
    }
    expect(body.epoch).toBe(currentEpoch())
    expect(body.epochLengthSeconds).toBe(EPOCH_LENGTH_SECONDS)
    expect(body.nextRolloverUnix).toBe((body.epoch + 1) * EPOCH_LENGTH_SECONDS)
  })

  it('gateInfo dispatches v3 metadata without network', async () => {
    const { execute } = await harness()
    const res = await execute('aol_gate_info', { gateMetadataJson: v3meta() })
    expect(res.isError).toBe(false)
    const body = JSON.parse((res.content as Array<{ text: string }>)[0]?.text ?? '{}')
    expect(body).toMatchObject({ version: 3, chain: 'BaseMainnet', tokenAddress: TOKEN, threshold: '100' })
    expect(typeof body.epoch).toBe('number')
  })

  it('gateInfo v4 reports Bond pin state', async () => {
    const { execute } = await harness()
    const pinned = await execute('aol_gate_info', { gateMetadataJson: v4meta(BOND_ADDRESSES.BaseMainnet as string) })
    expect(pinned.isError).toBe(false)
    const pinnedBody = JSON.parse((pinned.content as Array<{ text: string }>)[0]?.text ?? '{}')
    expect(pinnedBody.bondPinned).toBe(true)
    expect(pinnedBody.marketCapTarget).toBe(10)

    const open = await execute('aol_gate_info', { gateMetadataJson: v4meta(VERIFIER) })
    expect(open.isError).toBe(false)
    const openBody = JSON.parse((open.content as Array<{ text: string }>)[0]?.text ?? '{}')
    expect(openBody.bondPinned).toBe(false)
  })

  it('gateInfo rejects garbage', async () => {
    const { execute } = await harness()
    const res = await execute('aol_gate_info', { gateMetadataJson: 'not json at all' })
    expect(res.isError).toBe(true)
  })
})

describe('gated decrypt', () => {
  it('fails loud without a wired signGate (no invalid signature produced)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aol-'))
    try {
      const enc = join(dir, 'enc.bin')
      await writeFile(enc, new Uint8Array([1, 2, 3]))
      const { execute } = await harness()
      const res = await execute('aol_decrypt', {
        path: enc,
        gateMetadataJson: v3meta(),
        outputPath: join(dir, 'out.bin'),
        eip712ChainId: 8453,
        eip712VerifyingContract: VERIFIER,
      })
      expect(res.isError).toBe(true)
      // NOTE: the tool runtime serializes thrown errors as `Error: <message>`,
      // dropping the class name — assert the stable message substring instead.
      expect(JSON.stringify(res.content)).toContain('EIP-712 gate signing is unwired')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('canister gate errors surface as tool errors (stubbed request, stubbed signer)', async () => {
    internals.requestV3 = async () => ({ err: { InvalidSignature: 'nope' } })
    // Drive decryptV3 through a runtime built with a stub signer
    // (spike stand-in: 65-byte canned signature).
    const { AolRuntime } = await import('../src/aol.ts')
    const rt = new AolRuntime({
      canisterId: 'gny6k-fqaaa-aaaab-ag3ra-cai',
      icpHost: 'https://icp-api.io',
      fetchRootKey: false,
      signGate: async () => ('0x' + 'ab'.repeat(65)) as `0x${string}`,
    })
    await expect(rt.decryptV3({
      gateMetadataJson: v3meta(),
      encryptedFileBytes: new Uint8Array([9, 9]),
      evmAddress: VERIFIER,
      eip712ChainId: 8453n,
      eip712VerifyingContract: VERIFIER,
      nonce: 1n,
    })).rejects.toThrow(/InvalidSignature/)
  })

  it('decrypt defaults the EIP-712 domain to the gate chain + zero verifier', async () => {
    // v3meta() is a BaseMainnet gate: no per-call domain, no config domain —
    // the request must still carry chain 8453 and the dapp zero verifier.
    let seen: { eip712ChainId?: unknown; eip712VerifyingContract?: unknown } = {}
    internals.requestV3 = (async (_agent: unknown, _canister: string, req: Record<string, unknown>) => {
      seen = req
      return { err: { InvalidSignature: 'stop-here' } }
    }) as never
    const { AolRuntime } = await import('../src/aol.ts')
    const rt = new AolRuntime({
      canisterId: 'gny6k-fqaaa-aaaab-ag3ra-cai',
      icpHost: 'https://icp-api.io',
      fetchRootKey: false,
      signGate: async () => ('0x' + 'ab'.repeat(65)) as `0x${string}`,
    })
    await expect(rt.decryptV3({
      gateMetadataJson: v3meta(),
      encryptedFileBytes: new Uint8Array([9, 9]),
      evmAddress: VERIFIER,
      nonce: 1n,
    })).rejects.toThrow(/InvalidSignature/)
    expect(seen.eip712ChainId).toBe(8453n)
    expect(seen.eip712VerifyingContract).toBe('0x0000000000000000000000000000000000000000')
  })

  it('vetkeys unwrap failures name their stage (transport vs IBE vs file)', async () => {
    // A canister ok carrying unopenable keys must surface WHICH local stage
    // rejected them — the SDK throws bare 'Decryption failed' from all three,
    // which a holder misreads as a balance denial.
    internals.requestV3 = (async () => ({
      ok: {
        encryptedKey: new Uint8Array(192).fill(7),
        verificationKey: new Uint8Array(96).fill(9),
      },
    })) as never
    const { AolRuntime } = await import('../src/aol.ts')
    const rt = new AolRuntime({
      canisterId: 'gny6k-fqaaa-aaaab-ag3ra-cai',
      icpHost: 'https://icp-api.io',
      fetchRootKey: false,
      signGate: async () => ('0x' + 'ab'.repeat(65)) as `0x${string}`,
    })
    await expect(rt.decryptV3({
      gateMetadataJson: v3meta(),
      encryptedFileBytes: new Uint8Array([9, 9]),
      evmAddress: VERIFIER,
      nonce: 1n,
    })).rejects.toThrow(/v3 vetKey transport unwrap failed \(/)
  })

  it('aol_decrypt requires exactly one of path/cid', async () => {
    const { execute } = await harness()
    const res = await execute('aol_decrypt', {
      gateMetadataJson: v3meta(),
      outputPath: 'out.bin',
    })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toContain('exactly one of path or cid')
  })

  it('aol_decrypt requires exactly one of gateMetadataJson/gateMetadataPath', async () => {
    const { execute } = await harness()
    const neither = await execute('aol_decrypt', { path: 'enc.bin', outputPath: 'out.bin' })
    expect(neither.isError).toBe(true)
    expect(JSON.stringify(neither.content)).toContain('exactly one of gateMetadataJson or gateMetadataPath')
    const both = await execute('aol_decrypt', {
      path: 'enc.bin', outputPath: 'out.bin',
      gateMetadataJson: v3meta(), gateMetadataPath: 'sidecar.json',
    })
    expect(both.isError).toBe(true)
    expect(JSON.stringify(both.content)).toContain('exactly one of gateMetadataJson or gateMetadataPath')
  })

  it('aol_decrypt reads gate metadata from gateMetadataPath (byte-exact, no retyping)', async () => {
    // Live incident: an agent retyped the sidecar with a one-character
    // token-case drift and derived a foreign vetKey. The path form must
    // feed file bytes straight into the v3 dispatch.
    const dir = await mkdtemp(join(tmpdir(), 'aol-'))
    try {
      const enc = join(dir, 'enc.bin')
      const sidecar = join(dir, 'enc.bin.gate.json')
      await writeFile(enc, new Uint8Array([1, 2, 3]))
      await writeFile(sidecar, v3meta())
      const { execute } = await harness()
      const res = await execute('aol_decrypt', {
        path: enc,
        gateMetadataPath: sidecar,
        outputPath: join(dir, 'out.bin'),
      })
      expect(res.isError).toBe(true)
      // Unwired signer: reaching signGate proves the file was read and
      // dispatched into v3 decrypt (a misread would fail at parse).
      expect(JSON.stringify(res.content)).toContain('EIP-712 gate signing is unwired')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('aol_gate_info reads a mixed-case sidecar from gateMetadataPath verbatim', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aol-'))
    try {
      const mixed = '0xF23a728b55BE576c75D98A8032982F85cBAD493E'
      const meta = gateMetadataV3ToJson(buildGateMetadataV3({
        cid: 'bafytest', chain: 'EthSepolia', tokenAddress: mixed,
        threshold: 100, epoch: currentEpoch(),
        encryptedAesKey: Buffer.from('ciphertext').toString('base64'),
      }))
      const sidecar = join(dir, 'file.gate.json')
      await writeFile(sidecar, meta)
      const { execute } = await harness()
      const res = await execute('aol_gate_info', { gateMetadataPath: sidecar })
      expect(res.isError).toBe(false)
      const summary = JSON.parse((res.content as Array<{ text: string }>)[0]?.text ?? '{}')
      expect(summary).toMatchObject({ version: 3, tokenAddress: mixed })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('marketCap fails closed client-side on non-Bond oracles', async () => {
    const { execute } = await harness()
    const res = await execute('aol_market_cap', {
      chain: 'BaseMainnet',
      tokenAddress: TOKEN,
      oracleAddress: VERIFIER,
    })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toContain('Bond')
  })

  it('marketCap returns whole reserve units (stubbed)', async () => {
    internals.marketCap = async () => ({ ok: 42n })
    const { execute } = await harness()
    const res = await execute('aol_market_cap', {
      chain: 'BaseMainnet',
      tokenAddress: TOKEN,
      oracleAddress: BOND_ADDRESSES.BaseMainnet as string,
    })
    expect(res.isError).toBe(false)
    expect(JSON.stringify(res.content)).toContain('42')
  })
})

describe('fail-loud default', () => {
  it('unwired runtime exposes AolSigningError type', () => {
    expect(new AolSigningError('x').name).toBe('AolSigningError')
  })
})

describe('seal (harness-native encrypt side)', () => {
  /**
   * Test-only DPKs via LOCAL vetkeys derivation (master → canister →
   * context). Production seals use the canister-fetched verification
   * key — never this — but the points are structurally valid G2 keys,
   * so the full IBE path runs offline.
   */
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

  async function sealRuntime() {
    const { AolRuntime } = await import('../src/aol.ts')
    return new AolRuntime({ canisterId: 'gny6k-fqaaa-aaaab-ag3ra-cai', icpHost: 'https://icp-api.io', fetchRootKey: false })
  }

  it('seals v1/v3/v4 end to end: sealed bytes + parseable gate metadata', async () => {
    stubDpk()
    const { execute } = await harness()
    const rt = await sealRuntime()
    const plaintext = new TextEncoder().encode('seal-me-please')
    for (const version of [1, 3, 4] as const) {
      const sealed = await rt.seal({
        version,
        cid: 'sha256:abc',
        chain: 'BaseMainnet',
        tokenAddress: TOKEN,
        threshold: 100n,
        ...(version === 4
          ? { marketCapTarget: 10n, oracleAddress: BOND_ADDRESSES.BaseMainnet as string }
          : {}),
        plaintext,
      })
      expect(sealed.version).toBe(version)
      // Framed single-chunk: 12-byte base IV + 8-byte chunk header + 16-byte GCM tag.
      expect(sealed.sealedBytes.length).toBe(plaintext.length + 36)
      const { isChunkedPayload } = await import('../src/seal.ts')
      expect(isChunkedPayload(sealed.sealedBytes)).toBe(true)
      expect(sealed.keySha256).toMatch(/^[0-9a-f]{64}$/)
      // The metadata parses through the SDK-verbatim readers.
      const info = await execute('aol_gate_info', { gateMetadataJson: sealed.gateMetadataJson })
      expect(info.isError).toBe(false)
      const summary = JSON.parse((info.content as Array<{ text: string }>)[0]?.text ?? '{}')
      expect(summary).toMatchObject({ version, chain: 'BaseMainnet', tokenAddress: TOKEN, threshold: '100' })
      if (version === 4) {
        expect(summary).toMatchObject({ marketCapTarget: 10, bondPinned: true })
      }
    }
  })

  it('seal bytes are unique per seal; v3 shares the epoch key, v1/v4 mint per seal', async () => {
    stubDpk()
    const rt = await sealRuntime()
    const plaintext = new TextEncoder().encode('same-bytes')
    // v3: one bucket key, but fresh IVs keep every seal's bytes unique.
    const v3params = {
      version: 3 as const, cid: 'sha256:abc', chain: 'BaseMainnet' as const,
      tokenAddress: TOKEN, threshold: 100n, plaintext,
    }
    const [a, b] = await Promise.all([rt.seal(v3params), rt.seal(v3params)])
    expect(a.keySha256).toBe(b.keySha256)
    expect(Buffer.from(a.sealedBytes).equals(Buffer.from(b.sealedBytes))).toBe(false)
    // v1/v4: a fresh key per seal by design.
    for (const version of [1, 4] as const) {
      const params = {
        version, cid: 'sha256:abc', chain: 'BaseMainnet' as const,
        tokenAddress: TOKEN, threshold: 100n, plaintext,
        ...(version === 4
          ? { marketCapTarget: 10n, oracleAddress: BOND_ADDRESSES.BaseMainnet as string }
          : {}),
      }
      const [x, y] = await Promise.all([rt.seal(params), rt.seal(params)])
      expect(x.keySha256).not.toBe(y.keySha256)
      expect(Buffer.from(x.sealedBytes).equals(Buffer.from(y.sealedBytes))).toBe(false)
    }
  })

  it('seal canonicalizes token case: mixed/lower callers share one wrap + metadata', async () => {
    // The derivation preimage hashes tokenAddress VERBATIM while the epoch
    // cache slots lowercase — a mixed-case seal must canonicalize BEFORE
    // wrapping, or the cached wrap and the metadata derivation diverge and
    // the IBE open fails although every gate term is correct (live
    // incident: checksummed seal vs lowercased decrypt metadata).
    stubDpk()
    const rt = await sealRuntime()
    const plaintext = new TextEncoder().encode('case-me')
    const mixed = '0xF23a728b55BE576c75D98A8032982F85cBAD493E'
    const base = {
      version: 3 as const, cid: 'sha256:abc', chain: 'EthSepolia' as const,
      threshold: 1000000000000000000n, epoch: 690, plaintext,
    }
    const [a, b] = await Promise.all([
      rt.seal({ ...base, tokenAddress: mixed }),
      rt.seal({ ...base, tokenAddress: mixed.toLowerCase() }),
    ])
    const metaA = JSON.parse(a.gateMetadataJson) as { tokenAddress: string; encryptedAesKey: string }
    const metaB = JSON.parse(b.gateMetadataJson) as { tokenAddress: string; encryptedAesKey: string }
    expect(metaA.tokenAddress).toBe(mixed.toLowerCase())
    expect(metaB.tokenAddress).toBe(mixed.toLowerCase())
    expect(metaA.encryptedAesKey).toBe(metaB.encryptedAesKey)
    expect(a.keySha256).toBe(b.keySha256)
    // And the metadata derivation is identical — one bucket, one vetKey.
    const { computeDerivationInputV3 } = await import('haven-aol')
    const [dA, dB] = await Promise.all([
      computeDerivationInputV3('EthSepolia', metaA.tokenAddress, 1000000000000000000n, 690),
      computeDerivationInputV3('EthSepolia', metaB.tokenAddress, 1000000000000000000n, 690),
    ])
    expect(Buffer.from(dA).equals(Buffer.from(dB))).toBe(true)
  })

  it('threshold-zero seals are refused (free ships clear, never sealed)', async () => {
    stubDpk()
    const rt = await sealRuntime()
    await expect(rt.seal({
      version: 3, cid: 'sha256:abc', chain: 'BaseMainnet', tokenAddress: TOKEN,
      threshold: 0n, epoch: currentEpoch(), plaintext: new TextEncoder().encode('free'),
    })).rejects.toThrow(/must be > 0/)
  })

  it('fails closed: bad version, chain, token, threshold, v4 oracle/target', async () => {
    stubDpk()
    const rt = await sealRuntime()
    const plaintext = new TextEncoder().encode('x')
    await expect(rt.seal({
      version: 2 as never, cid: 'c', chain: 'BaseMainnet', tokenAddress: TOKEN, threshold: 1n, plaintext,
    })).rejects.toThrow('unsupported seal version')
    await expect(rt.seal({
      version: 1, cid: 'c', chain: 'Nope' as never, tokenAddress: TOKEN, threshold: 1n, plaintext,
    })).rejects.toThrow()
    await expect(rt.seal({
      version: 1, cid: 'c', chain: 'BaseMainnet', tokenAddress: '0xnope', threshold: 1n, plaintext,
    })).rejects.toThrow()
    await expect(rt.seal({
      version: 4, cid: 'c', chain: 'BaseMainnet', tokenAddress: TOKEN, threshold: 1n,
      oracleAddress: BOND_ADDRESSES.BaseMainnet as string, plaintext,
    })).rejects.toThrow('marketCapTarget')
    await expect(rt.seal({
      version: 4, cid: 'c', chain: 'BaseMainnet', tokenAddress: TOKEN, threshold: 1n,
      marketCapTarget: 5n, oracleAddress: VERIFIER, plaintext,
    })).rejects.toThrow('Bond')
  })

  it('fails loud when the verification key is unavailable or garbage', async () => {
    const rt = await sealRuntime()
    const plaintext = new TextEncoder().encode('x')
    const params = {
      version: 1 as const, cid: 'c', chain: 'BaseMainnet' as const,
      tokenAddress: TOKEN, threshold: 1n, plaintext,
    }
    internals.dpk = async () => { throw new Error('canister down') }
    await expect(rt.seal(params)).rejects.toThrow('canister down')
    internals.dpk = async () => new Uint8Array([1, 2, 3])
    await expect(rt.seal(params)).rejects.toThrow('IBE wrap failed')
  })

  it('aol_seal tool wires files end to end (default sha256 cid)', async () => {
    stubDpk()
    const { createHash } = await import('node:crypto')
    const { readFile } = await import('node:fs/promises')
    const { execute } = await harness()
    const dir = await mkdtemp(join(tmpdir(), 'aol-seal-'))
    try {
      const input = join(dir, 'plain.bin')
      const bytes = new TextEncoder().encode('seal-me-please')
      await writeFile(input, bytes)
      const res = await execute('aol_seal', {
        path: input,
        outputPath: join(dir, 'sealed.bin'),
        version: 3,
        chain: 'BaseMainnet',
        tokenAddress: TOKEN,
        threshold: '100',
      })
      expect(res.isError).toBe(false)
      expect(JSON.stringify(res.content)).toContain(`sealed ${bytes.length + 36} bytes`)
      expect((await readFile(join(dir, 'sealed.bin'))).length).toBe(bytes.length + 36)
      // Durable twin: the gate sidecar survives restarts that lose in-turn results.
      const sidecar = await readFile(join(dir, 'sealed.bin.gate.json'), 'utf8')
      const meta = JSON.parse(sidecar) as { version: number; cid: string; encryptedAesKey: string }
      expect(meta.version).toBe(3)
      expect(meta.cid).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(meta.encryptedAesKey.length).toBeGreaterThan(0)
      expect(JSON.stringify(res.content)).toContain('sealed.bin.gate.json')
      // The tool path rejects bad input before touching the runtime.
      const bad = await execute('aol_seal', {
        path: input, outputPath: join(dir, 's2.bin'), version: 9,
        chain: 'BaseMainnet', tokenAddress: TOKEN, threshold: '100',
      })
      expect(bad.isError).toBe(true)
      expect(createHash('sha256').update(bytes).digest('hex')).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('AES-GCM mirrors the SDK decrypt byte-for-byte (round-trip)', async () => {
    const { encryptFileAesGcm } = await import('../src/seal.ts')
    const { decryptFile } = await import('haven-aol')
    const plaintext = new TextEncoder().encode('round-trip bytes')
    const key = new Uint8Array(32).fill(7)
    const { sealed } = await encryptFileAesGcm(plaintext, key)
    expect(sealed.length).toBe(plaintext.length + 28)
    await expect(decryptFile(sealed, key)).resolves.toEqual(plaintext)
    await expect(encryptFileAesGcm(plaintext, new Uint8Array(16))).rejects.toThrow('32 bytes')
  })

  describe('framed chunk payloads (haven-cli streaming parity)', () => {
    // Golden vectors produced by haven-cli's own streaming encryptor
    // (`haven_aol_v3.encrypt_file_streaming_v3`, EthSepolia, threshold
    // 10^18, epoch 691): aes_key = 32×0x07, os.urandom stubbed to
    // bytes 00..0b, IBE wrap stubbed (ciphertext is independent of
    // it). Regen in the haven-cli venv with those stubs, then paste.
    const GOLDEN_TEXT = 'The quick brown fox jumps over the lazy dog. The quick brown fox jumps'
    const GOLDEN_KEY = new Uint8Array(32).fill(7)
    const GOLDEN_IV = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    const GOLDEN_MULTI_16 = '000102030405060708090a0b00000000200000004ce98c506c7cb02a1c9287ee8d2f02da8fd4f71be15876e614a54998993efb7d0100000020000000150e15c08685f68d27621dd31aaac05c0cf63897134294f79a93cd73c9c4acd002000000200000002b54020903fa196575f09e0353e5846402ee146efe556b1f616c1498e8ee2de6030000002000000036ab4e1badda75eddef15912579cfa26eb0c786d0a6d20546251e77f681de33d0400000016000000d9046af28b54274e0e66538d6f1a266c90908d177a40'
    const GOLDEN_SINGLE_1024 = '000102030405060708090a0b00000000560000004ce98c506c7cb02a1c9287ee8d2f02da8753ceae72171a4165ee0ccceba54d71b60a668ef6b548dd908aa4987ca3dd56d4412910b7bec4f40320c3e280a674b76d2576d1ea206a8f96e8b9844d2c1a2241630298dcb1'

    function hexToBytes(hex: string): Uint8Array {
      return new Uint8Array(Buffer.from(hex, 'hex'))
    }

    it('chunked seals are byte-identical to haven-cli (multi + single chunk)', async () => {
      const { encryptFileChunkedAesGcm } = await import('../src/seal.ts')
      const plaintext = new TextEncoder().encode(GOLDEN_TEXT)
      expect(plaintext.length).toBe(70)
      const multi = await encryptFileChunkedAesGcm(plaintext, GOLDEN_KEY, { chunkSize: 16, baseIv: GOLDEN_IV })
      expect(Buffer.from(multi.sealed).toString('hex')).toBe(GOLDEN_MULTI_16)
      const single = await encryptFileChunkedAesGcm(plaintext, GOLDEN_KEY, { chunkSize: 1024, baseIv: GOLDEN_IV })
      expect(Buffer.from(single.sealed).toString('hex')).toBe(GOLDEN_SINGLE_1024)
    })

    it('chunked decrypt opens haven-cli bytes; any-shape open dispatches', async () => {
      const { decryptFileAny, decryptFileChunked, encryptFileAesGcm, isChunkedPayload } = await import('../src/seal.ts')
      const { decryptFile } = await import('haven-aol')
      const plaintext = new TextEncoder().encode(GOLDEN_TEXT)
      const golden = hexToBytes(GOLDEN_MULTI_16)
      expect(isChunkedPayload(golden)).toBe(true)
      await expect(decryptFileChunked(golden, GOLDEN_KEY)).resolves.toEqual(plaintext)
      await expect(decryptFileAny(golden, GOLDEN_KEY)).resolves.toEqual(plaintext)
      // Legacy rows stay open through the same entry point, SDK-identical.
      const { sealed: legacy } = await encryptFileAesGcm(plaintext, GOLDEN_KEY)
      await expect(decryptFileAny(legacy, GOLDEN_KEY)).resolves.toEqual(plaintext)
      await expect(decryptFile(legacy, GOLDEN_KEY)).resolves.toEqual(plaintext)
    })

    it('framing detector agrees with mobile: framed yes, legacy-shaped no', async () => {
      const { isChunkedPayload } = await import('../src/seal.ts')
      expect(isChunkedPayload(hexToBytes(GOLDEN_SINGLE_1024))).toBe(true)
      expect(isChunkedPayload(hexToBytes(GOLDEN_MULTI_16))).toBe(true)
      // Deterministic legacy-shaped buffers (shape only — never decrypted here).
      const notIndexZero = new Uint8Array(48).fill(0)
      notIndexZero[12] = 1 // would-be index 1, not a chunk stream
      expect(isChunkedPayload(notIndexZero)).toBe(false)
      const tagOnlyLength = new Uint8Array(48).fill(0)
      new DataView(tagOnlyLength.buffer).setUint32(16, 4, true) // length below the tag floor
      expect(isChunkedPayload(tagOnlyLength)).toBe(false)
      expect(isChunkedPayload(new Uint8Array(19))).toBe(false) // shorter than IV + header
    })

    it('chunked decrypt fails closed on corrupt framing', async () => {
      const { decryptFileChunked } = await import('../src/seal.ts')
      const golden = hexToBytes(GOLDEN_MULTI_16)
      // Reordered: the second chunk claims index 0 again → order mismatch.
      const reordered = new Uint8Array(golden)
      reordered.set([0, 0, 0, 0], 12 + 8 + 32)
      await expect(decryptFileChunked(reordered, GOLDEN_KEY)).rejects.toThrow('order mismatch')
      // Declared length past the end → truncation, not an alloc.
      const truncated = golden.subarray(0, golden.length - 1)
      await expect(decryptFileChunked(truncated, GOLDEN_KEY)).rejects.toThrow('truncated chunk')
      // Length below the tag floor → invalid.
      const badLen = new Uint8Array(golden)
      new DataView(badLen.buffer).setUint32(16, 4, true)
      await expect(decryptFileChunked(badLen, GOLDEN_KEY)).rejects.toThrow('invalid length')
      // Flipped ciphertext bit → GCM tag failure, never silent plaintext.
      const tampered = new Uint8Array(golden)
      tampered[20] = (tampered[20] as number) ^ 0xff
      await expect(decryptFileChunked(tampered, GOLDEN_KEY)).rejects.toThrow()
    })

    it('per-chunk IVs match haven-cli derivation (index 0 is identity, index 1 xors)', async () => {
      const { deriveChunkIv } = await import('../src/seal.ts')
      expect(deriveChunkIv(GOLDEN_IV, 0)).toEqual(GOLDEN_IV)
      const one = deriveChunkIv(GOLDEN_IV, 1)
      expect(Array.from(one.subarray(0, 4))).toEqual([0, 1, 2, 3])
      expect(Array.from(one.subarray(4))).toEqual([4, 5, 6, 7, 8, 9, 10, 10])
    })

    it('chunked round-trip across many chunks + input validation', async () => {
      const { decryptFileAny, encryptFileChunkedAesGcm } = await import('../src/seal.ts')
      const plaintext = new Uint8Array(5000).map((_, i) => i % 251)
      const key = new Uint8Array(32).fill(9)
      const { sealed } = await encryptFileChunkedAesGcm(plaintext, key, { chunkSize: 1000 })
      // 12 base IV + 5 × (8 header + 1000 ct + 16 tag).
      expect(sealed.length).toBe(12 + 5 * (8 + 1000 + 16))
      await expect(decryptFileAny(sealed, key)).resolves.toEqual(plaintext)
      await expect(encryptFileChunkedAesGcm(plaintext, new Uint8Array(16))).rejects.toThrow('32 bytes')
      await expect(encryptFileChunkedAesGcm(plaintext, key, { chunkSize: 0 })).rejects.toThrow('chunkSize')
      await expect(decryptFileAny(new Uint8Array(4), key)).rejects.toThrow('too short')
    })
  })

  it('IBE wrap output deserializes at the vetkeys-advertised size', async () => {
    const { ibeEncryptAesKey } = await import('../src/seal.ts')
    const { IbeCiphertext } = await import('@icp-sdk/vetkeys')
    const wrapped = ibeEncryptAesKey(await dpkFixture(1), new Uint8Array(32).fill(3), new Uint8Array(32).fill(5))
    const bytes = new Uint8Array(Buffer.from(wrapped, 'base64'))
    expect(bytes.length).toBe(IbeCiphertext.ciphertextSize(32))
    expect(() => IbeCiphertext.deserialize(bytes)).not.toThrow()
  })

  it('v1 builder round-trips through the SDK parser', async () => {
    const { buildGateMetadataV1, gateMetadataV1ToJson } = await import('../src/seal.ts')
    const { execute } = await harness()
    const json = gateMetadataV1ToJson(buildGateMetadataV1({
      cid: 'bafyv1', chain: 'BaseMainnet', tokenAddress: TOKEN, threshold: 7n,
      encryptedAesKey: Buffer.from('wrap').toString('base64'),
    }))
    const res = await execute('aol_gate_info', { gateMetadataJson: json })
    expect(res.isError).toBe(false)
    expect(JSON.parse((res.content as Array<{ text: string }>)[0]?.text ?? '{}'))
      .toMatchObject({ version: 1, cid: 'bafyv1', threshold: '7' })
    expect(() => buildGateMetadataV1({
      cid: '', chain: 'BaseMainnet', tokenAddress: TOKEN, threshold: 1n, encryptedAesKey: 'eA==',
    })).toThrow('cid must be')
  })
})

describe('seam declarations', () => {
  it('injects wallet: decrypt signs the EIP-712 gate request via ctx.wallet', () => {
    // Live failure: without the declaration Cordis throws 'cannot get
    // property "wallet" without inject' on every decrypt.
    expect([...havenAol.inject]).toEqual(expect.arrayContaining(['tools', 'wallet']))
  })
})
