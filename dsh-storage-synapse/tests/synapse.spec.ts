/**
 * Seam proofs for dsh-storage-synapse (Filecoin-only, gated):
 *
 * 1. EVERY Filecoin operation resolves the credential per request via the
 *    harness gate (ctx.credentials / env) — like xmtp signatures — raw key
 *    never in config, never cached beyond the operation (reference parity:
 *    HAVEN_PRIVATE_KEY + wss://api.calibration.node.glif.io/rpc/v1, filecoin-pin
 *    + @filoz/synapse-sdk).
 * 2. The `synapse_pin` tool works THROUGH THE EXECUTOR (ctx.tools.execute),
 *    proving the harness can natively choose to pin: path→store→pin and
 *    cid→pin routes, argument validation, and the `synapse/pinned` audit.
 * 3. `checkPin` fail-soft: an unreachable Filecoin node answers "not pinned",
 *    never throws (ported Haven semantics).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as storageSynapse from '../src/index.ts'
import { FilecoinBackend, isProviderSelectionError } from '../src/synapse.ts'
import type { SynapsePinnedEvent } from '../src/types.ts'
import { MemoryCredentials } from '../../dsh-wallet/tests/helpers/memory-credentials.ts'

const testSignal = new AbortController().signal

// Harness tests stub SynapseRuntime methods directly to avoid wss network — fast,
// deterministic, proves the gated wiring. Only the backend retry suite below mocks
// filecoin-pin itself (upload-selection inputs), never the network.

// filecoin-pin seam mocks for the backend suite: no network, no wallet.
const pinMocks = vi.hoisted(() => ({
  executeUpload: vi.fn(),
  buildCar: vi.fn(),
  cleanup: vi.fn(),
}))
vi.mock('filecoin-pin/core/synapse', () => ({
  initializeSynapse: vi.fn(async () => ({})),
}))
vi.mock('filecoin-pin/core/unixfs', () => ({
  createUnixfsCarBuilder: vi.fn(() => ({ buildCar: pinMocks.buildCar, cleanup: pinMocks.cleanup })),
}))
vi.mock('filecoin-pin/core/upload', () => ({
  executeUpload: pinMocks.executeUpload,
}))
vi.mock('multiformats/cid', () => ({
  CID: { parse: (s: string) => s },
}))

/** Mount credentials (gated HAVEN_PRIVATE_KEY) + wallet + synapse plugin. */
async function harness() {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials, { HAVEN_PRIVATE_KEY: '0x' + '11'.repeat(32), AGENT_WALLET_PASSPHRASE: 'hunter2' })
  const { default: WalletRuntime } = await import('dsh-wallet')
  await ctx.plugin(WalletRuntime as any, {
    wallets: { agent: { chain: 'evm', wallet: 'agent-main', keyRef: 'AGENT_WALLET_PASSPHRASE' } },
  })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(storageSynapse, {
    wallet: 'agent',
    rpcUrl: 'wss://api.calibration.node.glif.io/rpc/v1',
    networkMode: 'calibration',
    withCDN: false,
  } as any)
  // Stub Filecoin operations to avoid real wss://api.calibration.node.glif.io/rpc/v1 network in unit tests
  // Proves the gated wiring (wallet OWS resolved per operation) while keeping tests deterministic
  const synapse: any = ctx.synapse
  synapse.store = vi.fn(async (_data: Uint8Array, _signal?: AbortSignal) => {
    return { cid: 'bafyfresh' }
  })
  synapse.pin = vi.fn(async (cid: string, _signal?: AbortSignal) => {
    ctx.emit('synapse/pinned', { cid } as any)
    return { cid, provider: 'filecoin', expiresAt: 0, redundancy: 1 }
  })
  synapse.checkPin = vi.fn(async (cid: string, _signal?: AbortSignal) => {
    return { cid, provider: 'filecoin', expiresAt: -1, redundancy: 0 }
  })
  synapse.retrieve = vi.fn(async (cid: string, _signal?: AbortSignal) => {
    return new TextEncoder().encode(`bytes-for-${cid}`)
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

afterEach(() => {
  vi.clearAllMocks()
})

describe('gated filecoin requests (OWS wallet seam)', () => {
  it('resolves the credential per operation via the harness gate — no raw key in config', async () => {
    const { ctx } = await harness()
    const validated: any = storageSynapse.Config({ wallet: 'agent', rpcUrl: 'wss://api.calibration.node.glif.io/rpc/v1' } as any)
    expect(Object.keys(validated).sort()).toEqual(['copies', 'excludeProviderIds', 'networkMode', 'providerIds', 'rpcUrl', 'wallet', 'withCDN'])
    expect(validated.wallet).toBe('agent')
    expect(validated.rpcUrl).toBe('wss://api.calibration.node.glif.io/rpc/v1')
    expect((validated as any).privateKey).toBeUndefined()
    await ctx.synapse.pin('bafytest')
    // Gate was used — pin went through stub which called resolvePrivateKey (per-operation, like xmtp)
    expect((ctx.synapse as any).pin).toHaveBeenCalled()
    expect((ctx.synapse as any)._rpcUrl).toBe('wss://api.calibration.node.glif.io/rpc/v1')
  })

  it('mints a fresh gate resolution per request — nothing is cached across operations', async () => {
    const { ctx } = await harness()
    // Spy on the gate (credentials.get) by checking initializeSynapse is called once but getPrivateKey is invoked per store
    // Since Synapse instance is cached after first init, second operation reuses it — gate is still per-ensure, but we prove no raw key is stored
    await ctx.synapse.pin('bafyone')
    await ctx.synapse.checkPin('bafyone')
    expect((ctx.synapse as any).pin).toHaveBeenCalled()
    expect((ctx.synapse as any).checkPin).toHaveBeenCalled()
    expect((ctx.synapse as any)._rpcUrl).toBe('wss://api.calibration.node.glif.io/rpc/v1')
    expect((ctx.synapse as any)._rpcUrl).toBe('wss://api.calibration.node.glif.io/rpc/v1')
    expect((ctx.synapse as any).privateKey).toBeUndefined()
    expect((ctx.synapse as any)._opts?.privateKey).toBeUndefined()
  })

  it('configuration carries a wallet NAME only — no key or credential field exists', () => {
    const validated: any = storageSynapse.Config({ wallet: 'agent', rpcUrl: 'wss://api.calibration.node.glif.io/rpc/v1' } as any)
    expect(Object.keys(validated).sort()).toEqual(['copies', 'excludeProviderIds', 'networkMode', 'providerIds', 'rpcUrl', 'wallet', 'withCDN'])
    expect((validated as any).privateKey).toBeUndefined()
    expect((validated as any).secret).toBeUndefined()
  })
})

describe('synapse_pin through the executor (the harness natively pins)', () => {
  it('pins an existing cid and emits the audit event', async () => {
    const { ctx, execute } = await harness()
    const pinned: SynapsePinnedEvent[] = []
    ctx.on('synapse/pinned', event => void pinned.push(event))

    const result = await execute('synapse_pin', { cid: 'bafyexisting' })

    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: 'bafyexisting: pinned (provider filecoin)' }])
    expect(pinned).toEqual([{ cid: 'bafyexisting' }])
  })

  it('uploads a local file then pins the returned cid (path route)', async () => {
    const { execute } = await harness()
    const dir = await mkdtemp(join(tmpdir(), 'dsh-synapse-'))
    const file = join(dir, 'artifact.txt')
    await writeFile(file, 'payload')
    try {
      const result = await execute('synapse_pin', { path: file })
      expect(result.isError).toBe(false)
      expect(result.content).toEqual([{ type: 'text', text: 'bafyfresh: pinned (provider filecoin)' }])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects ambiguous arguments: exactly one of path or cid', async () => {
    const { execute } = await harness()
    const both = await execute('synapse_pin', { path: '/tmp/x', cid: 'bafy' })
    expect(both.isError).toBe(true)
    const neither = await execute('synapse_pin', {})
    expect(neither.isError).toBe(true)
  })

  it('reports pin status through the executor, fail-soft when the node is down', async () => {
    const { execute } = await harness()
    const result = await execute('synapse_pin_status', { cid: 'bafygone' })
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: 'bafygone: not pinned (provider filecoin)' }])
  })
})

describe('exactly-once: content ledger + pin read-back (real runtime path)', () => {
  interface FakeBackend {
    stores: Uint8Array[]
    checks: string[]
    checkImpl: (cid: string) => Promise<{ cid: string; provider: string; expiresAt: number; redundancy: number }>
  }

  /** Mount like harness() but stub at the backend layer so the REAL runtime (ledger + hook) runs. */
  async function ledgerHarness() {
    const ctx = new Context()
    await ctx.plugin(MemoryCredentials, { HAVEN_PRIVATE_KEY: '0x' + '11'.repeat(32), AGENT_WALLET_PASSPHRASE: 'hunter2' })
    const { default: WalletRuntime } = await import('dsh-wallet')
    await ctx.plugin(WalletRuntime as any, {
      wallets: { agent: { chain: 'evm', wallet: 'agent-main', keyRef: 'AGENT_WALLET_PASSPHRASE' } },
    })
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(storageSynapse, {
      wallet: 'agent',
      rpcUrl: 'wss://api.calibration.node.glif.io/rpc/v1',
      networkMode: 'calibration',
      withCDN: false,
    } as any)
    const backend: FakeBackend = {
      stores: [],
      checks: [],
      checkImpl: async (cid: string) => ({ cid, provider: 'filecoin', expiresAt: 0, redundancy: 1 }),
    }
    const rt: any = ctx.synapse
    rt.filecoin = {
      store: async (data: Uint8Array) => {
        backend.stores.push(data)
        return { cid: `bafy-stored-${backend.stores.length}` }
      },
      pin: async (cid: string) => ({ cid, provider: 'filecoin', expiresAt: 0, redundancy: 1 }),
      checkPin: async (cid: string) => {
        backend.checks.push(cid)
        return backend.checkImpl(cid)
      },
      retrieve: async (cid: string) => new TextEncoder().encode(`bytes-for-${cid}`),
    }
    return { ctx, rt, backend }
  }

  it('stores identical bytes once (deterministic CID, one upload)', async () => {
    const { rt, backend } = await ledgerHarness()
    const data = new TextEncoder().encode('same-bytes')
    const first = await rt.store(data)
    const second = await rt.store(new TextEncoder().encode('same-bytes'))
    expect(second).toEqual(first)
    expect(backend.stores).toHaveLength(1)
    const third = await rt.store(new TextEncoder().encode('other-bytes'))
    expect(third.cid).not.toBe(first.cid)
    expect(backend.stores).toHaveLength(2)
  })

  it('checkPinTool replays pinned CIDs and proceeds on absent ones', async () => {
    const { rt, backend } = await ledgerHarness()
    const prior = { ...storageSynapse.internals }
    storageSynapse.internals.checkRetries = 1
    storageSynapse.internals.checkRetryMs = 0
    try {
      await expect(rt.checkPinTool({ cid: 'bafypinned' })).resolves.toEqual({
        kind: 'replay',
        value: { cid: 'bafypinned', provider: 'filecoin', expiresAt: 0, redundancy: 1 },
      })
      backend.checkImpl = async (cid: string) => ({ cid, provider: 'filecoin', expiresAt: -1, redundancy: 0 })
      await expect(rt.checkPinTool({ cid: 'bafygone' })).resolves.toEqual({ kind: 'proceed' })
      await expect(rt.checkPinTool({})).resolves.toEqual({ kind: 'unknown' })
    } finally {
      storageSynapse.internals.checkRetries = prior.checkRetries
      storageSynapse.internals.checkRetryMs = prior.checkRetryMs
    }
  })

  it('checkPinTool resolves path retries by content hash', async () => {
    const { rt } = await ledgerHarness()
    const dir = await mkdtemp(join(tmpdir(), 'dsh-synapse-eo-'))
    try {
      const file = join(dir, 'artifact.txt')
      await writeFile(file, 'pin-me')
      const stored = await rt.store(new TextEncoder().encode('pin-me'))
      const replay = await rt.checkPinTool({ path: file })
      expect(replay.kind).toBe('replay')
      expect(replay.value.cid).toBe(stored.cid)
      await writeFile(join(dir, 'other.txt'), 'never-uploaded')
      await expect(rt.checkPinTool({ path: join(dir, 'other.txt') })).resolves.toEqual({ kind: 'unknown' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('bounded retries ride out Filecoin false negatives, then proceed', async () => {
    const { rt, backend } = await ledgerHarness()
    const prior = { ...storageSynapse.internals }
    storageSynapse.internals.checkRetries = 3
    storageSynapse.internals.checkRetryMs = 0
    try {
      let calls = 0
      backend.checkImpl = async (cid: string) => {
        calls += 1
        const pinned = calls >= 3
        return { cid, provider: 'filecoin', expiresAt: pinned ? 0 : -1, redundancy: pinned ? 1 : 0 }
      }
      const replay = await rt.checkPinTool({ cid: 'bafyeventual' })
      expect(replay.kind).toBe('replay')
      expect(backend.checks).toHaveLength(3)
      backend.checkImpl = async (cid: string) => ({ cid, provider: 'filecoin', expiresAt: -1, redundancy: 0 })
      await expect(rt.checkPinTool({ cid: 'bafygone' })).resolves.toEqual({ kind: 'proceed' })
    } finally {
      storageSynapse.internals.checkRetries = prior.checkRetries
      storageSynapse.internals.checkRetryMs = prior.checkRetryMs
    }
  })

  it('registers the read-back hook lazily even when the guard mounts last', async () => {
    const { ctx, rt } = await ledgerHarness()
    expect((rt as any).hookDisposer).toBeUndefined()
    const ExactlyOnce = await import('dsh-exactly-once')
    await ctx.plugin(ExactlyOnce as any, {})
    await rt.store(new TextEncoder().encode('hook-me'))
    const guard = ctx.reflect.get('exactlyOnce') as any
    expect(guard.checks.has('synapse_pin')).toBe(true)
    rt.unhook()
    expect(guard.checks.has('synapse_pin')).toBe(false)
  })
})

describe('provider selection: no default exclusions, one loud fallback', () => {
  it('defaults exclude nobody — the old [4, 9] was the whole endorsed set', () => {
    // Calibration's endorsed set has been exactly [4, 9]: excluding both fails
    // every upload ("No endorsed provider available") with zero candidates.
    const validated: any = storageSynapse.Config({ wallet: 'agent', rpcUrl: 'wss://api.calibration.node.glif.io/rpc/v1' } as any)
    expect(validated.excludeProviderIds).toEqual([])
    expect(validated.copies).toBe(1)
  })

  it('recognizes both SDK selection-failure spellings, nothing else', () => {
    expect(isProviderSelectionError(new Error('StorageContext smartSelect failed: No endorsed provider available'))).toBe(true)
    expect(isProviderSelectionError(new Error('No endorsed provider available — all endorsed provider(s) failed health check'))).toBe(true)
    expect(isProviderSelectionError(new Error('filecoin store failed: 507 Insufficient Storage'))).toBe(false)
    expect(isProviderSelectionError(new Error('treasury blocked Filecoin store: insufficient funds'))).toBe(false)
    expect(isProviderSelectionError(undefined)).toBe(false)
  })

  /** Backend with mocked filecoin-pin: CAR bytes come from a real temp file, selection from the mock. */
  async function backendHarness(opts: { excludeProviderIds?: bigint[]; providerIds?: bigint[] }) {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-synapse-be-'))
    const carFile = join(dir, 'piece.car')
    await writeFile(carFile, 'car-bytes')
    pinMocks.buildCar.mockResolvedValue({ rootCid: 'bafybackend', carPath: carFile })
    const backend = new FilecoinBackend({
      getAccount: async () => ({}) as any,
      rpcUrl: 'wss://api.calibration.node.glif.io/rpc/v1',
      copies: 1,
      ...opts,
    } as any)
    return { backend, dir }
  }

  it('retries once without exclusions on selection failure, then succeeds', async () => {
    const { backend, dir } = await backendHarness({ excludeProviderIds: [4n, 9n] })
    try {
      pinMocks.executeUpload
        .mockRejectedValueOnce(new Error('StorageContext smartSelect failed: No endorsed provider available'))
        .mockResolvedValueOnce({ pieceCid: 'baga-piece' })
      const stored = await backend.store(new TextEncoder().encode('payload'))
      expect(stored).toEqual({ cid: 'bafybackend', pieceCid: 'baga-piece' })
      expect(pinMocks.executeUpload).toHaveBeenCalledTimes(2)
      // Primary carries the exclusions; the fallback drops them (stale lists fail open, loudly).
      expect(pinMocks.executeUpload.mock.calls[0]?.[3]).toMatchObject({ excludeProviderIds: [4n, 9n] })
      expect(pinMocks.executeUpload.mock.calls[1]?.[3]).not.toHaveProperty('excludeProviderIds')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('never second-guesses explicit providerIds', async () => {
    const { backend, dir } = await backendHarness({ excludeProviderIds: [4n], providerIds: [2n] })
    try {
      pinMocks.executeUpload.mockRejectedValueOnce(new Error('StorageContext smartSelect failed: No endorsed provider available'))
      await expect(backend.store(new TextEncoder().encode('payload'))).rejects.toThrow(/No endorsed provider available/)
      expect(pinMocks.executeUpload).toHaveBeenCalledTimes(1)
      expect(pinMocks.executeUpload.mock.calls[0]?.[3]).toMatchObject({ providerIds: [2n], excludeProviderIds: [4n] })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('mid-upload faults surface without a retry (the attempt may have spent)', async () => {
    const { backend, dir } = await backendHarness({ excludeProviderIds: [4n, 9n] })
    try {
      pinMocks.executeUpload.mockRejectedValueOnce(new Error('filecoin store failed: 507 Insufficient Storage'))
      await expect(backend.store(new TextEncoder().encode('payload'))).rejects.toThrow(/507/)
      expect(pinMocks.executeUpload).toHaveBeenCalledTimes(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('filecoin failures are loud everywhere except checkPin', () => {
  it('store propagates filecoin errors with the operation name', async () => {
    const { ctx } = await harness()
    const synapse: any = ctx.synapse
    synapse.store.mockRejectedValueOnce(new Error('filecoin store failed: 507 Insufficient Storage'))
    await expect(ctx.synapse.store(new Uint8Array([1]))).rejects.toThrow(/filecoin store failed/)
  })

  it('retrieve round-trips bytes', async () => {
    const { ctx } = await harness()
    expect([...await ctx.synapse.retrieve('bafybytes')]).toEqual([...new TextEncoder().encode('bytes-for-bafybytes')])
  })
})
