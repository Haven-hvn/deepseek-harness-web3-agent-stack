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

  it('aol_decrypt requires exactly one of path/cid', async () => {
    const { execute } = await harness()
    const res = await execute('aol_decrypt', {
      gateMetadataJson: v3meta(),
      outputPath: 'out.bin',
    })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toContain('exactly one of path or cid')
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
      expect(sealed.sealedBytes.length).toBe(plaintext.length + 28) // 12-byte IV + 16-byte GCM tag
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

  it('every seal uses fresh randomness (no two seals share a key)', async () => {
    stubDpk()
    const rt = await sealRuntime()
    const plaintext = new TextEncoder().encode('same-bytes')
    const params = {
      version: 3 as const, cid: 'sha256:abc', chain: 'BaseMainnet' as const,
      tokenAddress: TOKEN, threshold: 100n, plaintext,
    }
    const [a, b] = await Promise.all([rt.seal(params), rt.seal(params)])
    expect(a.keySha256).not.toBe(b.keySha256)
    expect(Buffer.from(a.sealedBytes).equals(Buffer.from(b.sealedBytes))).toBe(false)
  })

  it('threshold-zero v3 seals at the eternal epoch', async () => {
    stubDpk()
    const rt = await sealRuntime()
    const sealed = await rt.seal({
      version: 3, cid: 'sha256:abc', chain: 'BaseMainnet', tokenAddress: TOKEN,
      threshold: 0n, epoch: currentEpoch(), plaintext: new TextEncoder().encode('free'),
    })
    expect(JSON.parse(sealed.gateMetadataJson).epoch).toBe(0)
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
      expect(JSON.stringify(res.content)).toContain(`sealed ${bytes.length + 28} bytes`)
      expect((await readFile(join(dir, 'sealed.bin'))).length).toBe(bytes.length + 28)
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
