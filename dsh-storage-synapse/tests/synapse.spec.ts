/**
 * Seam proofs for dsh-storage-synapse:
 *
 * 1. EVERY node request is authenticated by a fresh wallet signature —
 *    `ctx.wallet.signMessage` runs once per request (credential resolved at
 *    that operation boundary), the challenge is bound to the operation path,
 *    and no storage credential exists anywhere in configuration.
 * 2. The `synapse_pin` tool works THROUGH THE EXECUTOR (`ctx.tools.execute`),
 *    proving the harness can natively choose to pin: path→store→pin and
 *    cid→pin routes, argument validation, and the `synapse/pinned` audit.
 * 3. `checkPin` fail-soft: an unreachable node answers "not pinned", never
 *    throws (ported Haven semantics).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WalletRuntime from 'dsh-wallet'
import type { CryptoAdapter, WalletKeySource } from 'dsh-wallet'
import * as storageSynapse from '../src/index.ts'
import { internals } from '../src/synapse.ts'
import type { SynapsePinnedEvent } from '../src/types.ts'
import { MemoryCredentials } from '../../dsh-wallet/tests/helpers/memory-credentials.ts'

const testSignal = new AbortController().signal

/** Recording fake signer: counts operations so per-request signing is provable. */
class FakeAdapter implements CryptoAdapter {
  readonly loadKeyCalls: WalletKeySource[] = []
  readonly signedPayloads: string[] = []

  async loadKey(source: WalletKeySource): Promise<{ address: string; keyMaterial: unknown }> {
    this.loadKeyCalls.push(source)
    return { address: '0xagent', keyMaterial: { secret: source.secret } }
  }

  async signMessage(_material: unknown, payload: string): Promise<string> {
    this.signedPayloads.push(payload)
    return `0xsig-${this.signedPayloads.length}`
  }

  async signTransaction(): Promise<string> {
    throw new Error('synapse never signs transactions')
  }
}

/** One recorded HTTP exchange. */
interface RecordedRequest {
  url: string
  headers: Record<string, string>
}

/** Recording fake node: canned JSON per API path. */
function fakeNode(responses: Record<string, unknown>) {
  const requests: RecordedRequest[] = []
  internals.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, headers: { ...(init?.headers as Record<string, string>) } })
    const path = Object.keys(responses).find(candidate => url.includes(candidate))
    if (path === undefined) return new Response('unknown path', { status: 500, statusText: 'Test' })
    return new Response(JSON.stringify(responses[path]), { status: 200 })
  }) as typeof globalThis.fetch
  return requests
}

/** Mount credentials + wallet (fake evm adapter) + the synapse plugin. */
async function harness() {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials, { AGENT_WALLET_PASSPHRASE: 'hunter2' })
  await ctx.plugin(WalletRuntime, {
    wallets: { agent: { chain: 'evm', wallet: 'agent-main', keyRef: 'AGENT_WALLET_PASSPHRASE' } },
  })
  const adapter = new FakeAdapter()
  ctx.wallet.register('evm', adapter)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(storageSynapse, { url: 'http://node.test:5001', wallet: 'agent' })
  let calls = 0
  const execute = (name: string, args: Record<string, unknown>) => ctx.tools.execute({
    callId: CallId(`call-${calls += 1}`),
    name,
    arguments: args,
    signal: testSignal,
  })
  return { ctx, adapter, execute }
}

afterEach(() => {
  internals.fetch = undefined
})

describe('wallet-signed requests (the steering seam)', () => {
  it('signs every request through ctx.wallet with an operation-bound challenge', async () => {
    const { ctx, adapter } = await harness()
    const requests = fakeNode({ '/api/v0/pin/add': {} })

    await ctx.synapse.pin('bafytest')

    // One request, one wallet operation: the credential resolved inside it.
    expect(requests).toHaveLength(1)
    expect(adapter.loadKeyCalls).toHaveLength(1)
    expect(adapter.loadKeyCalls[0]).toMatchObject({ wallet: 'agent-main', chain: 'evm', secret: 'hunter2' })
    expect(adapter.signedPayloads).toHaveLength(1)
    // The challenge binds the signature to THIS operation's path.
    expect(adapter.signedPayloads[0]).toMatch(/^synapse:pin\/add:\d+$/)
    const request = requests[0]!
    expect(request.headers['x-synapse-address']).toBe('0xagent')
    expect(request.headers['x-synapse-challenge']).toBe(adapter.signedPayloads[0])
    expect(request.headers['x-synapse-signature']).toBe('0xsig-1')
  })

  it('mints a FRESH signature per request — nothing is reused across operations', async () => {
    const { ctx, adapter } = await harness()
    const requests = fakeNode({ '/api/v0/pin/add': {}, '/api/v0/pin/ls': { Keys: {} } })

    await ctx.synapse.pin('bafyone')
    await ctx.synapse.checkPin('bafyone')

    expect(adapter.loadKeyCalls).toHaveLength(2) // one resolve→load per request
    expect(adapter.signedPayloads).toHaveLength(2)
    expect(adapter.signedPayloads[0]).not.toBe(adapter.signedPayloads[1])
    expect(requests[0]!.headers['x-synapse-signature']).toBe('0xsig-1')
    expect(requests[1]!.headers['x-synapse-signature']).toBe('0xsig-2')
  })

  it('configuration carries a wallet NAME only — no key or credential field exists', () => {
    // Compile-time + schema fact: Config has exactly url and wallet.
    const validated = storageSynapse.Config({ wallet: 'agent' })
    expect(Object.keys(validated).sort()).toEqual(['url', 'wallet'])
  })
})

describe('synapse_pin through the executor (the harness natively pins)', () => {
  it('pins an existing cid and emits the audit event', async () => {
    const { ctx, execute } = await harness()
    fakeNode({ '/api/v0/pin/add': {} })
    const pinned: SynapsePinnedEvent[] = []
    ctx.on('synapse/pinned', event => void pinned.push(event))

    const result = await execute('synapse_pin', { cid: 'bafyexisting' })

    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: 'bafyexisting: pinned (provider synapse)' }])
    expect(pinned).toEqual([{ cid: 'bafyexisting' }])
  })

  it('uploads a local file then pins the returned cid (path route)', async () => {
    const { execute } = await harness()
    const requests = fakeNode({ '/api/v0/add': { Hash: 'bafyfresh' }, '/api/v0/pin/add': {} })
    const dir = await mkdtemp(join(tmpdir(), 'dsh-synapse-'))
    const file = join(dir, 'artifact.txt')
    await writeFile(file, 'payload')
    try {
      const result = await execute('synapse_pin', { path: file })
      expect(result.isError).toBe(false)
      expect(result.content).toEqual([{ type: 'text', text: 'bafyfresh: pinned (provider synapse)' }])
      // store first (cid-version=1), then explicit pin of the returned cid.
      expect(requests.map(request => request.url)).toEqual([
        'http://node.test:5001/api/v0/add?cid-version=1',
        'http://node.test:5001/api/v0/pin/add?arg=bafyfresh',
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects ambiguous arguments: exactly one of path or cid', async () => {
    const { execute } = await harness()
    fakeNode({})
    const both = await execute('synapse_pin', { path: '/tmp/x', cid: 'bafy' })
    expect(both.isError).toBe(true)
    const neither = await execute('synapse_pin', {})
    expect(neither.isError).toBe(true)
  })

  it('reports pin status through the executor, fail-soft when the node is down', async () => {
    const { execute } = await harness()
    internals.fetch = (async () => { throw new Error('ECONNREFUSED') }) as typeof globalThis.fetch
    const result = await execute('synapse_pin_status', { cid: 'bafygone' })
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: 'bafygone: not pinned (provider synapse)' }])
  })
})

describe('http failures are loud everywhere except checkPin', () => {
  it('store propagates node errors with the operation name', async () => {
    const { ctx } = await harness()
    internals.fetch = (async () => new Response('full', { status: 507, statusText: 'Insufficient Storage' })) as typeof globalThis.fetch
    await expect(ctx.synapse.store(new Uint8Array([1]))).rejects.toThrow(/add failed: 507/)
  })

  it('retrieve round-trips bytes', async () => {
    const { ctx } = await harness()
    internals.fetch = (async () => new Response(new Uint8Array([104, 105]))) as typeof globalThis.fetch
    expect([...await ctx.synapse.retrieve('bafybytes')]).toEqual([104, 105])
  })
})
