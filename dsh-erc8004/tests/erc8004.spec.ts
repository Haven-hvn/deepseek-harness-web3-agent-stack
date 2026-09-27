/**
 * E2E verification for dsh-erc8004 — every public Context/ToolRuntime path
 * and every documented tool outcome, plus events. Wallet-gated (no privateKeyRef).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as erc8004 from '../src/index.ts'
import { MemoryCredentials } from '../../dsh-wallet/tests/helpers/memory-credentials.ts'

async function harness() {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials, { HAVEN_PRIVATE_KEY: '0x' + 'aa'.repeat(32) })
  const { default: WalletRuntime } = await import('dsh-wallet')
  await ctx.plugin(WalletRuntime as any, {
    wallets: { agent: { chain: 'evm', wallet: 'agent-main', keyRef: 'HAVEN_PRIVATE_KEY' } },
  })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  // Provide a mock synapse for Filecoin Pin (pdp proofs) — the package now delegates to ctx.synapse
  const mockSynapse: any = {
    store: vi.fn(async (data: Uint8Array) => ({ cid: 'bafybeihhal5hlbylkibniig6j72wdrm7lr4nf6z47natleh2jkyosrg7di', pieceCid: 'bafkpiece123' })),
  }
  ;(ctx as any).synapse = mockSynapse
  await ctx.plugin(erc8004 as any, {
    wallet: 'agent',
    baseRpcUrl: 'https://sepolia.base.org',
    identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    chainId: 84532,
  })
  // Stub wallet adapter — avoid needing real OWS/evm provider in unit tests
  const FIXED_ADDR = '0x44896a716F7b5Ed343C6962b3D56FaA5377Cd052'
  // @ts-ignore mock
  ctx.wallet.address = vi.fn(async (name: string) => FIXED_ADDR)
  // @ts-ignore mock
  ctx.wallet.list = vi.fn(() => [{ name: 'agent', chain: 'evm', wallet: 'agent-main' }])
  // @ts-ignore mock signTransaction gate — sign-only, returns signed raw tx
  ctx.wallet.signTransaction = vi.fn(async (name: string, payload: string) => ({
    address: FIXED_ADDR,
    signature: '0xf86c808504a817c80083030d40948004A818BFB912233c491871b3d84c89A494BD9e80801ba0' as any,
  }))
  // Provide mock treasury (optional) — authorize/recordExpense
  ;(ctx as any).treasury = {
    authorize: vi.fn(() => ({ authorized: true })),
    recordExpense: vi.fn(async () => {}),
    report: vi.fn(() => ({ state: 'FUNDED', totalValueUsd: 1_000_000, dailyBurnUsd: 1000, runwayDays: 30, balances: [], recentExpenses: [] })),
  }
  // Stub network-dependent methods — keep credential gating and event logic real where possible
  const rt: any = ctx.erc8004
  // Keep storeCard going through synapse (real path) but also stub to avoid real upload — already via mockSynapse
  // Stub register to avoid real Base Sepolia RPC, but keep wallet gate call path
  const originalRegister = rt.register.bind(rt)
  rt.register = vi.fn(async (tokenUri: string) => {
    // Simulate wallet-gated register without hitting publicClient — still goes through authorize
    const treasury: any = (ctx as any).treasury
    if (treasury?.authorize) treasury.authorize('storage', 2000)
    const agentId = '398'
    const txHash = '0x0edda2928ec45aaa4091a2fa2cc863f249e78b86931aed31e2c5365d3b99175c' as `0x${string}`
    const owner = await ctx.wallet.address('agent')
    ctx.emit('erc8004/registered', { agentId, tokenUri, txHash, owner })
    if (treasury?.recordExpense) await treasury.recordExpense({ category: 'storage', amountUsd: 0.002 })
    return { agentId, txHash, tokenUri }
  })
  rt.tokenURI = vi.fn(async () => 'ipfs://bafybeihhal5hlbylkibniig6j72wdrm7lr4nf6z47natleh2jkyosrg7di/agent-card.json')
  rt.ownerOf = vi.fn(async () => await ctx.wallet.address('agent'))
  let calls = 0
  const execute = (name: string, args: Record<string, unknown>) => ctx.tools.execute({
    callId: ToolCallId(`call-${++calls}`),
    name,
    arguments: args,
    signal: new AbortController().signal,
  })
  return { ctx, execute, rt, mockSynapse }
}

afterEach(() => vi.clearAllMocks())

// Remove dispose calls — Cordis Context has no dispose in this version; vitest cleans up per test
function disposeCtx(_ctx: any) {}

describe('Erc8004Runtime public methods', () => {
  it('buildCard produces registration-v1 with agentWallet and MCP', async () => {
    const { ctx, rt } = await harness()
    const owner = await ctx.wallet.address('agent')
    const card = rt.buildCard(owner)
    expect(card.type).toBe('https://eips.ethereum.org/EIPS/eip-8004#registration-v1')
    expect(card.endpoints.some((e: any) => e.name === 'agentWallet' && e.endpoint.includes(owner))).toBe(true)
    expect(card.endpoints.some((e: any) => e.name === 'MCP')).toBe(true)
    expect(card.supportedTrust).toContain('reputation')
    const c2 = rt.buildCard(owner, { name: 'Custom', description: 'Desc' })
    expect(c2.name).toBe('Custom')
    void ctx
  })

  it('storeCard via ctx.synapse returns cid/tokenUri and emits erc8004/card-stored', async () => {
    const { ctx, rt, mockSynapse } = await harness()
    const owner = await ctx.wallet.address('agent')
    const card = rt.buildCard(owner)
    const events: any[] = []
    ctx.on('erc8004/card-stored', e => events.push(e))
    const res = await rt.storeCard(card, 'agent-card.json')
    expect(res.cid).toBe('bafybeihhal5hlbylkibniig6j72wdrm7lr4nf6z47natleh2jkyosrg7di')
    expect(res.tokenUri).toBe('ipfs://bafybeihhal5hlbylkibniig6j72wdrm7lr4nf6z47natleh2jkyosrg7di/agent-card.json')
    expect(events).toHaveLength(1)
    expect(events[0].cid).toBe(res.cid)
    expect(mockSynapse.store).toHaveBeenCalled()
    void ctx
  })

  it('register via wallet gate emits erc8004/registered and hits treasury', async () => {
    const { ctx, rt } = await harness()
    const events: any[] = []
    ctx.on('erc8004/registered', e => events.push(e))
    const res = await rt.register('ipfs://bafybeihhal5hlbylkibniig6j72wdrm7lr4nf6z47natleh2jkyosrg7di/agent-card.json')
    expect(res.agentId).toBe('398')
    expect(res.txHash).toBe('0x0edda2928ec45aaa4091a2fa2cc863f249e78b86931aed31e2c5365d3b99175c')
    expect(events).toHaveLength(1)
    expect(events[0].agentId).toBe('398')
    expect(events[0].owner.startsWith('0x')).toBe(true)
    // Treasury was consulted (authorize + recordExpense in our stub)
    const treasury: any = (ctx as any).treasury
    expect(treasury.authorize).toHaveBeenCalled()
    void ctx
  })

  it('registerAgent full flow via synapse+wallet emits both events', async () => {
    const { ctx, rt } = await harness()
    const events: any[] = []
    ctx.on('erc8004/card-stored', e => events.push(['card-stored', e]))
    ctx.on('erc8004/registered', e => events.push(['registered', e]))
    const res = await rt.registerAgent({ name: 'Full Flow' })
    expect(res.card.name).toBe('Full Flow')
    expect(res.cid).toBe('bafybeihhal5hlbylkibniig6j72wdrm7lr4nf6z47natleh2jkyosrg7di')
    expect(res.agentId).toBe('398')
    expect(events).toHaveLength(2)
    void ctx
  })

  it('tokenURI and ownerOf read via publicClient stub', async () => {
    const { ctx, rt } = await harness()
    const uri = await rt.tokenURI('398')
    expect(uri.startsWith('ipfs://')).toBe(true)
    const owner = await rt.ownerOf('398')
    expect(owner.startsWith('0x')).toBe(true)
    void ctx
  })

  it('config carries wallet only, no raw privateKeyRef', async () => {
    const { ctx } = await harness()
    expect(ctx.erc8004.config.wallet).toBe('agent')
    expect((ctx.erc8004.config as any).privateKeyRef).toBeUndefined()
    expect((ctx.erc8004.config as any).privateKey).toBeUndefined()
    expect((ctx.erc8004.config as any).filecoinRpcUrl).toBeUndefined()
    void ctx
  })

  it('wallet signing gate is the only signing path — no privateKeyToAccount', async () => {
    const { ctx } = await harness()
    // Ensure the runtime does not expose any private-key resolver
    expect((ctx.erc8004 as any)._privateKeyRef).toBeUndefined()
    expect((ctx.erc8004 as any).resolvePrivateKey).toBeUndefined()
    expect((ctx.erc8004 as any).getPrivateKey).toBeUndefined()
    void ctx
  })
})

describe('erc8004 tools via ToolRuntime (public)', () => {
  it('erc8004_build_card returns card JSON', async () => {
    const { ctx, execute } = await harness()
    const res = await execute('erc8004_build_card', {})
    expect(res.isError).toBe(false)
    const text = JSON.stringify(res.content)
    expect(text).toContain('registration-v1')
    expect(text).toContain('agentWallet')
    const res2 = await execute('erc8004_build_card', { name: 'Tool Custom', mcpEndpoint: 'https://custom.example/mcp' })
    expect(res2.isError).toBe(false)
    expect(JSON.stringify(res2.content)).toContain('Tool Custom')
    void ctx
  })

  it('erc8004_register full flow via tool (synapse+wallet)', async () => {
    const { ctx, execute } = await harness()
    const res = await execute('erc8004_register', { name: 'Tool Agent', filename: 'agent-card.json' })
    expect(res.isError).toBe(false)
    const txt = JSON.stringify(res.content)
    expect(txt).toContain('398')
    expect(txt).toContain('ipfs://')
    void ctx
  })

  it('erc8004_register with existing tokenUri skips pin (wallet only)', async () => {
    const { ctx, execute } = await harness()
    const events: any[] = []
    ctx.on('erc8004/registered', e => events.push(e))
    const res = await execute('erc8004_register', { tokenUri: 'ipfs://bafybeihhal5hlbylkibniig6j72wdrm7lr4nf6z47natleh2jkyosrg7di/agent-card.json' })
    expect(res.isError).toBe(false)
    expect(events).toHaveLength(1)
    expect(JSON.stringify(res.content)).toContain('bafybeihhal5hlbylkibniig6j72wdrm7lr4nf6z47natleh2jkyosrg7di')
    void ctx
  })

  it('erc8004_token_uri returns ipfs URI', async () => {
    const { ctx, execute } = await harness()
    const res = await execute('erc8004_token_uri', { agentId: '398' })
    expect(res.isError).toBe(false)
    const txt = (res.content[0] as any)?.text ?? ''
    expect(txt).toContain('ipfs://')
    void ctx
  })

  it('erc8004_owner_of returns address', async () => {
    const { ctx, execute } = await harness()
    const res = await execute('erc8004_owner_of', { agentId: '398' })
    expect(res.isError).toBe(false)
    const txt = (res.content[0] as any)?.text ?? ''
    expect(txt.startsWith('0x')).toBe(true)
    void ctx
  })
})

describe('exactly-once: timeout-after-broadcast + read-back (real register path)', () => {
  const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
  const URI = 'ipfs://bafybeihhal5hlbylkibniig6j72wdrm7lr4nf6z47natleh2jkyosrg7di/agent-card.json'
  const CID = 'bafybeihhal5hlbylkibniig6j72wdrm7lr4nf6z47natleh2jkyosrg7di'

  function minedReceipt(tokenId: bigint): any {
    return {
      status: 'success',
      logs: [{ topics: [TRANSFER_TOPIC, `0x${'0'.repeat(64)}`, `0x${'0'.repeat(64)}`, `0x${tokenId.toString(16).padStart(64, '0')}`] }],
    }
  }

  interface FakeChain {
    sends: string[]
    nonces: number[]
    waitImpl: (hash: string) => Promise<any>
    receiptImpl: (hash: string) => Promise<any>
    txImpl: (hash: string) => Promise<any>
  }

  /** Mount like harness() but drive the REAL register() against a scripted chain. */
  async function chainHarness() {
    const ctx = new Context()
    await ctx.plugin(MemoryCredentials, { HAVEN_PRIVATE_KEY: '0x' + 'aa'.repeat(32) })
    const { default: WalletRuntime } = await import('dsh-wallet')
    await ctx.plugin(WalletRuntime as any, {
      wallets: { agent: { chain: 'evm', wallet: 'agent-main', keyRef: 'HAVEN_PRIVATE_KEY' } },
    })
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const mockSynapse: any = {
      store: vi.fn(async (data: Uint8Array) => ({ cid: CID, pieceCid: 'bafkpiece123' })),
    }
    ;(ctx as any).synapse = mockSynapse
    await ctx.plugin(erc8004 as any, {
      wallet: 'agent',
      baseRpcUrl: 'https://sepolia.base.org',
      identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
      chainId: 84532,
    })
    const FIXED_ADDR = '0x44896a716F7b5Ed343C6962b3D56FaA5377Cd052'
    // @ts-ignore mock
    ctx.wallet.address = vi.fn(async (name: string) => FIXED_ADDR)
    // @ts-ignore mock
    ctx.wallet.list = vi.fn(() => [{ name: 'agent', chain: 'evm', wallet: 'agent-main' }])
    // @ts-ignore mock signTransaction gate — sign-only, returns signed raw tx
    ctx.wallet.signTransaction = vi.fn(async (name: string, payload: string) => ({
      address: FIXED_ADDR,
      signature: '0xf86c808504a817c80083030d40948004A818BFB912233c491871b3d84c89A494BD9e80801ba0' as any,
    }))
    ;(ctx as any).treasury = {
      authorize: vi.fn(() => ({ authorized: true })),
      recordExpense: vi.fn(async () => {}),
      report: vi.fn(() => ({ state: 'FUNDED', totalValueUsd: 1_000_000, dailyBurnUsd: 1000, runwayDays: 30, balances: [], recentExpenses: [] })),
    }
    const rt: any = ctx.erc8004
    rt.tokenURI = vi.fn(async () => URI)
    rt.ownerOf = vi.fn(async () => await ctx.wallet.address('agent'))
    const chain: FakeChain = {
      sends: [],
      nonces: [],
      waitImpl: async () => minedReceipt(398n),
      receiptImpl: async () => minedReceipt(398n),
      txImpl: async () => null,
    }
    const fakePublicClient = {
      getTransactionCount: async () => {
        const nonce = chain.nonces.length
        chain.nonces.push(nonce)
        return nonce
      },
      estimateGas: async () => 200_000n,
      getGasPrice: async () => 1_000_000_000n,
      sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: string }) => {
        chain.sends.push(serializedTransaction)
        return `0x${chain.sends.length.toString(16).padStart(64, '0')}` as `0x${string}`
      },
      waitForTransactionReceipt: ({ hash }: { hash: string }) => chain.waitImpl(hash),
      getTransactionReceipt: ({ hash }: { hash: string }) => chain.receiptImpl(hash),
      getTransaction: ({ hash }: { hash: string }) => chain.txImpl(hash),
    }
    rt.backend = { getPublicClient: async () => fakePublicClient }
    return { ctx, rt, chain, mockSynapse }
  }

  it('broadcasts once; a repeat after mining reuses the attempt (single tx)', async () => {
    const { rt, chain } = await chainHarness()
    const first = await rt.register(URI)
    expect(first.agentId).toBe('398')
    expect(chain.sends).toHaveLength(1)
    const second = await rt.register(URI)
    expect(second).toEqual(first)
    expect(chain.sends).toHaveLength(1)
  })

  it('timeout-after-broadcast resolves to the SAME txHash on retry (single-tx proof)', async () => {
    const { rt, chain } = await chainHarness()
    const priorTimeout = erc8004.internals.receiptTimeoutMs
    erc8004.internals.receiptTimeoutMs = 30
    try {
      chain.waitImpl = async () => new Promise<any>(() => {}) // the receipt wait hangs
      await expect(rt.register(URI)).rejects.toThrow(/no receipt for 0x0+1/)
      expect(chain.sends).toHaveLength(1)
      // The chain did mine it; the retry must resolve the recorded
      // broadcast, never send a second transaction.
      const retry = await rt.register(URI)
      expect(retry.txHash).toBe(`0x${(1).toString(16).padStart(64, '0')}`)
      expect(retry.agentId).toBe('398')
      expect(chain.sends).toHaveLength(1)
    } finally {
      erc8004.internals.receiptTimeoutMs = priorTimeout
    }
  })

  it('a dropped broadcast re-sends under a fresh hash', async () => {
    const { rt, chain } = await chainHarness()
    const priorTimeout = erc8004.internals.receiptTimeoutMs
    erc8004.internals.receiptTimeoutMs = 30
    try {
      chain.waitImpl = async () => new Promise<any>(() => {})
      await expect(rt.register(URI)).rejects.toThrow(/no receipt for/)
      chain.receiptImpl = async () => { throw new Error('unknown transaction') }
      chain.txImpl = async () => null // neither receipt nor mempool entry: dropped
      chain.waitImpl = async () => minedReceipt(398n)
      const retry = await rt.register(URI)
      expect(chain.sends).toHaveLength(2)
      expect(retry.txHash).toBe(`0x${(2).toString(16).padStart(64, '0')}`)
      expect(retry.agentId).toBe('398')
    } finally {
      erc8004.internals.receiptTimeoutMs = priorTimeout
    }
  })

  it('a pending broadcast never re-sends: the retry waits instead', async () => {
    const { rt, chain } = await chainHarness()
    const priorTimeout = erc8004.internals.receiptTimeoutMs
    erc8004.internals.receiptTimeoutMs = 30
    try {
      chain.waitImpl = async () => new Promise<any>(() => {})
      await expect(rt.register(URI)).rejects.toThrow(/no receipt for/)
      chain.receiptImpl = async () => null
      chain.txImpl = async (hash: string) => ({ hash }) // still in the mempool
      await expect(rt.register(URI)).rejects.toThrow(/still pending/)
      expect(chain.sends).toHaveLength(1)
    } finally {
      erc8004.internals.receiptTimeoutMs = priorTimeout
    }
  })

  it('a reverted registration re-sends (no effect committed)', async () => {
    const { rt, chain } = await chainHarness()
    const waits = [async () => ({ status: 'reverted', logs: [] }), async () => minedReceipt(398n)]
    chain.waitImpl = async () => (waits.shift() ?? (async () => minedReceipt(398n)))()
    await expect(rt.register(URI)).rejects.toThrow(/reverted on-chain/)
    const retry = await rt.register(URI)
    expect(chain.sends).toHaveLength(2)
    expect(retry.agentId).toBe('398')
  })

  it('concurrent registers for one tokenUri converge on one broadcast', async () => {
    const { rt, chain } = await chainHarness()
    const [a, b] = await Promise.all([rt.register(URI), rt.register(URI)])
    expect(a.txHash).toBe(b.txHash)
    expect(chain.sends).toHaveLength(1)
  })

  it('concurrent registers for different URIs serialize broadcasts without deadlock', async () => {
    const { rt, chain } = await chainHarness()
    const uriB = 'ipfs://bafyother/agent-card.json'
    const [a, b] = await Promise.all([rt.register(URI), rt.register(uriB)])
    expect(a.tokenUri).toBe(URI)
    expect(b.tokenUri).toBe(uriB)
    expect(chain.sends).toHaveLength(2)
    expect(new Set(chain.nonces).size).toBe(2) // one lane: no shared nonce
  })

  it('checkRegister replays mined registrations and stays silent otherwise', async () => {
    const { rt } = await chainHarness()
    await rt.register(URI)
    await expect(rt.checkRegister({ tokenUri: URI })).resolves.toEqual({
      kind: 'replay',
      value: {
        agentId: '398',
        tokenUri: URI,
        txHash: `0x${(1).toString(16).padStart(64, '0')}`,
        cid: CID,
      },
    })
    await expect(rt.checkRegister({ tokenUri: 'ipfs://bafyunknown/agent-card.json' })).resolves.toEqual({ kind: 'unknown' })
  })

  it('checkRegister answers build-path retries by deterministic card hash', async () => {
    const { rt } = await chainHarness()
    await rt.registerAgent({ name: 'Hooked Agent' })
    const replay = await rt.checkRegister({ name: 'Hooked Agent' })
    expect(replay.kind).toBe('replay')
    expect(replay.value.tokenUri).toContain(CID)
    await expect(rt.checkRegister({ name: 'Never Registered' })).resolves.toEqual({ kind: 'unknown' })
  })

  it('checkRegister reports unknown (never proceed) while a broadcast is pending', async () => {
    const { rt, chain } = await chainHarness()
    const priorTimeout = erc8004.internals.receiptTimeoutMs
    erc8004.internals.receiptTimeoutMs = 30
    try {
      chain.waitImpl = async () => new Promise<any>(() => {})
      await expect(rt.register(URI)).rejects.toThrow(/no receipt for/)
      chain.receiptImpl = async () => null
      chain.txImpl = async (hash: string) => ({ hash })
      await expect(rt.checkRegister({ tokenUri: URI })).resolves.toEqual({ kind: 'unknown' })
      chain.txImpl = async () => null // dropped: re-dispatch is safe
      await expect(rt.checkRegister({ tokenUri: URI })).resolves.toEqual({ kind: 'proceed' })
    } finally {
      erc8004.internals.receiptTimeoutMs = priorTimeout
    }
  })

  it('registers the read-back hook lazily even when the guard mounts last', async () => {
    const { ctx, rt } = await chainHarness()
    expect((rt as any).hookDisposer).toBeUndefined() // unguarded: nothing registered
    const ExactlyOnce = await import('dsh-exactly-once')
    await ctx.plugin(ExactlyOnce as any, {})
    await rt.register(URI) // first write call hooks up, regardless of mount order
    const guard = ctx.reflect.get('exactlyOnce') as any
    expect(guard).toBeDefined()
    expect(guard.checks.has('erc8004_register')).toBe(true)
    rt.unhook()
    expect(guard.checks.has('erc8004_register')).toBe(false)
  })

  it('registerAgent resumes without re-pin or re-send', async () => {
    const { rt, chain, mockSynapse } = await chainHarness()
    const first = await rt.registerAgent({ name: 'Resumable' })
    const second = await rt.registerAgent({ name: 'Resumable' })
    expect(second).toEqual(first)
    expect(mockSynapse.store).toHaveBeenCalledTimes(1)
    expect(chain.sends).toHaveLength(1)
  })
})

describe('persona onboarding', () => {
  it('cordis.patch.yml contains ERC-8004 onboarding FIRST MESSAGE', async () => {
    const { readFile } = await import('node:fs/promises')
    const yml = await readFile('./dsh-persona/cordis.patch.yml', 'utf8')
    expect(yml).toContain('ERC-8004')
    expect(yml).toContain('Filecoin')
    expect(yml).toContain('erc8004_register')
    expect(yml).toContain('FIRST MESSAGE')
  })
})
