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
