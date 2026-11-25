/**
 * Seam proofs for aol_attest_holding (holding attestation for media records):
 *
 * 1. The EIP-712 digest is byte-pinned (vector verified against Fairhaven
 *    board-core's noble-based attestRequestDigest — independent keccak
 *    implementation, same inputs) and domain-separated on every field.
 * 2. The tool works THROUGH THE EXECUTOR: validation fails loud before any
 *    signature (threshold 0, malformed cidHash, unknown chain), an unwired
 *    signGate fails with AolSigningError, canister refusals surface as tool
 *    errors, and a canister echo mismatch throws instead of minting a
 *    receipt bound to the wrong record.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as havenAol from '../src/index.ts'
import { AolRuntime, internals, resetAttestDedup } from '../src/aol.ts'
import { attestRequestDigest } from '../src/attest.ts'
import { signGateFromTestKey } from '../src/test_signer.ts'

const testSignal = new AbortController().signal
const HOLDER = '0x1111111111111111111111111111111111111111'
const TOKEN = '0x2222222222222222222222222222222222222222'
const CIDHASH = 'ab'.repeat(32)
const VERIFIER = '0x0000000000000000000000000000000000000000'

afterEach(() => {
  internals.attest = undefined
  resetAttestDedup()
})

async function harness(wallet: Record<string, unknown>) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  ;(ctx as any).provide('wallet', wallet)
  await ctx.plugin(havenAol, {
    wallet: 'agent',
    canisterId: '3gzy3-kaaaa-aaaan-q6y6q-cai',
    icpHost: 'https://icp-api.io',
    fetchRootKey: false,
  })
  let calls = 0
  const execute = async (name: string, args: Record<string, unknown>) => {
    const batch = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: ToolCallId(`call-${calls += 1}`), name, arguments: JSON.stringify(args) }],
      signal: testSignal,
    })
    return batch.results[0]!.result
  }
  return { ctx, execute }
}

const noDigestWallet = {
  address: async () => HOLDER,
  list: () => [],
}

const digestWallet = (sig = `0x${'11'.repeat(64)}1b`) => ({
  address: async () => HOLDER,
  list: () => [],
  signDigest: async () => ({ address: HOLDER, signature: sig }),
})

describe('attestRequestDigest', () => {
  const input = {
    evmAddress: HOLDER,
    cidHash: CIDHASH,
    nonce: 7n,
    eip712ChainId: 11155111n,
    eip712VerifyingContract: VERIFIER,
  }

  it('is byte-pinned (independent noble cross-check)', () => {
    expect(attestRequestDigest(input)).toBe('0x7c12c949e817b1ee82986715f444f6f9136876cac83b43d219b71b598cf9a1b5')
  })

  it('separates on every field', () => {
    const base = attestRequestDigest(input)
    expect(attestRequestDigest({ ...input, nonce: 8n })).not.toBe(base)
    expect(attestRequestDigest({ ...input, eip712ChainId: 1n })).not.toBe(base)
    expect(attestRequestDigest({ ...input, eip712VerifyingContract: TOKEN })).not.toBe(base)
    expect(attestRequestDigest({ ...input, evmAddress: TOKEN })).not.toBe(base)
    expect(attestRequestDigest({ ...input, cidHash: 'cd'.repeat(32) })).not.toBe(base)
  })
})

describe('aol_attest_holding', () => {
  const args = {
    chain: 'EthSepolia',
    tokenAddress: TOKEN,
    threshold: '1000000000000000000',
    cidHash: CIDHASH,
  }

  // NOTE: the tool runtime resolves errors as { isError: true } (dropping
  // the class name) — assert isError + stable message substrings instead.
  it('fails loud without a wired signDigest (no signature produced)', async () => {
    const { execute } = await harness(noDigestWallet)
    const res = await execute('aol_attest_holding', args)
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toContain('EIP-712 gate signing is unwired')
  })

  it('rejects threshold 0 before signing', async () => {
    const { execute } = await harness(digestWallet())
    const res = await execute('aol_attest_holding', { ...args, threshold: '0' })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toContain('> 0')
  })

  it('rejects malformed threshold and cidHash before signing', async () => {
    const { execute } = await harness(digestWallet())
    const badThreshold = await execute('aol_attest_holding', { ...args, threshold: 'lots' })
    expect(badThreshold.isError).toBe(true)
    expect(JSON.stringify(badThreshold.content)).toContain('raw-integer')
    const badHash = await execute('aol_attest_holding', { ...args, cidHash: 'xyz' })
    expect(badHash.isError).toBe(true)
    expect(JSON.stringify(badHash.content)).toContain('64 hex')
  })

  it('rejects unknown chains before signing', async () => {
    const { execute } = await harness(digestWallet())
    const res = await execute('aol_attest_holding', { ...args, chain: 'Solana' })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toContain('unknown chain')
  })

  it('surfaces canister refusals as tool errors', async () => {
    internals.attest = async () => ({ err: { InsufficientBalance: { required: 1000n, actual: 3n } } })
    const { execute } = await harness(digestWallet())
    const res = await execute('aol_attest_holding', args)
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toContain('holds 3 of the 1000 required')
  })

  it('throws on canister echo mismatch instead of a misbound receipt', async () => {
    internals.attest = async () => ({
      ok: {
        attestation: {
          evmAddress: HOLDER, tokenAddress: TOKEN, threshold: 1000000000000000000n,
          balanceAtCheck: 2000000000000000000n, cidHash: 'cd'.repeat(32), timestamp: 1790000000n,
        },
        signature: new Uint8Array(64).fill(9),
      },
    })
    const { execute } = await harness(digestWallet())
    const res = await execute('aol_attest_holding', args)
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toContain('different cidHash')
  })

  it('replays the stored receipt on repeat calls (one mint, no second canister call)', async () => {
    let calls = 0
    internals.attest = async () => {
      calls += 1
      return {
        ok: {
          attestation: {
            evmAddress: HOLDER, tokenAddress: TOKEN, threshold: 1000000000000000000n,
            balanceAtCheck: 2000000000000000000n, cidHash: CIDHASH, timestamp: BigInt(Math.floor(Date.now() / 1000)),
          },
          signature: new Uint8Array(64).fill(9),
        },
      }
    }
    const { execute } = await harness(digestWallet())
    const first = await execute('aol_attest_holding', args)
    const second = await execute('aol_attest_holding', args)
    expect(first.isError).toBe(false)
    expect(second.isError).toBe(false)
    expect(calls).toBe(1)
    expect(second.content).toEqual(first.content)
  })

  it('mints again for another record (another cidHash always misses)', async () => {
    let calls = 0
    internals.attest = async (_agent, _id, req) => {
      calls += 1
      return {
        ok: {
          attestation: {
            evmAddress: HOLDER, tokenAddress: TOKEN, threshold: 1000000000000000000n,
            balanceAtCheck: 2000000000000000000n, cidHash: req.cidHash, timestamp: 1790000000n,
          },
          signature: new Uint8Array(64).fill(9),
        },
      }
    }
    const { execute } = await harness(digestWallet())
    await execute('aol_attest_holding', args)
    await execute('aol_attest_holding', { ...args, cidHash: 'cd'.repeat(32) })
    expect(calls).toBe(2)
  })

  it('returns the payload-ready Haven single shape on success', async () => {
    internals.attest = async () => ({
      ok: {
        attestation: {
          evmAddress: HOLDER, tokenAddress: TOKEN, threshold: 1000000000000000000n,
          balanceAtCheck: 2000000000000000000n, cidHash: CIDHASH, timestamp: 1790000000n,
        },
        signature: new Uint8Array(64).fill(9),
      },
    })
    const { execute } = await harness(digestWallet())
    const res = await execute('aol_attest_holding', args)
    expect(res.isError).toBe(false)
    const body = JSON.parse((res.content as Array<{ text: string }>)[0]?.text ?? '{}')
    expect(body).toMatchObject({
      evmAddress: HOLDER,
      chain: 'EthSepolia',
      tokenAddress: TOKEN,
      threshold: '1000000000000000000',
      balanceAtCheck: '2000000000000000000',
      cidHash: CIDHASH,
      timestamp: 1790000000,
      signature: '09'.repeat(64),
    })
  })
})

describe('receipt ledger', () => {
  // Well-known Hardhat test key #0 (public fixture, never funded, never a secret).
  const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f3ff80'
  const params = {
    evmAddress: HOLDER,
    chain: 'EthSepolia' as const,
    tokenAddress: TOKEN,
    threshold: 1000000000000000000n,
    cidHash: CIDHASH,
  }

  function stubMint(calls: { n: number }, timestamp = BigInt(Math.floor(Date.now() / 1000))) {
    internals.attest = async () => {
      calls.n += 1
      return {
        ok: {
          attestation: {
            evmAddress: HOLDER, tokenAddress: TOKEN, threshold: 1000000000000000000n,
            balanceAtCheck: 2000000000000000000n, cidHash: CIDHASH, timestamp,
          },
          signature: new Uint8Array(64).fill(9),
        },
      }
    }
  }

  function runtime(receiptsPath?: string) {
    return new AolRuntime({
      canisterId: '3gzy3-kaaaa-aaaan-q6y6q-cai',
      icpHost: 'https://icp-api.io',
      fetchRootKey: false,
      signGate: signGateFromTestKey(TEST_KEY),
      ...(receiptsPath !== undefined ? { receiptsPath } : {}),
    })
  }

  it('persists across runtimes: a second runtime replays with zero canister calls', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aol-ledger-'))
    try {
      const path = join(dir, 'receipts.json')
      const calls = { n: 0 }
      stubMint(calls)
      const first = await runtime(path).attestHolding(params)
      expect(calls.n).toBe(1)
      // Fresh runtime, stub now throws: any canister call fails the test.
      internals.attest = async () => { throw new Error('must not mint') }
      resetAttestDedup()
      const second = await runtime(path).attestHolding(params)
      expect(second).toEqual(first)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('prunes expired receipts: an old entry re-mints', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aol-ledger-'))
    try {
      const path = join(dir, 'receipts.json')
      const calls = { n: 0 }
      stubMint(calls, 1000000000n) // 2001: older than one epoch
      await runtime(path).attestHolding(params)
      expect(calls.n).toBe(1)
      resetAttestDedup()
      await runtime(path).attestHolding(params)
      expect(calls.n).toBe(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('single-flights concurrent identical calls (one mint)', async () => {
    const calls = { n: 0 }
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    internals.attest = async () => {
      calls.n += 1
      await gate
      return {
        ok: {
          attestation: {
            evmAddress: HOLDER, tokenAddress: TOKEN, threshold: 1000000000000000000n,
            balanceAtCheck: 2000000000000000000n, cidHash: CIDHASH, timestamp: BigInt(Math.floor(Date.now() / 1000)),
          },
          signature: new Uint8Array(64).fill(9),
        },
      }
    }
    const rt = runtime()
    const p1 = rt.attestHolding(params)
    const p2 = (async () => {
      await new Promise((r) => setTimeout(r, 20))
      return rt.attestHolding(params)
    })()
    await new Promise((r) => setTimeout(r, 50)) // both in flight: p1 mints, p2 joins it
    release()
    const [a, b] = await Promise.all([p1, p2])
    expect(a).toEqual(b)
    expect(calls.n).toBe(1)
  })
})
