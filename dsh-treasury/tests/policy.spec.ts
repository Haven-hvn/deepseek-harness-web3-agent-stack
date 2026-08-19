/**
 * Enforcement-seam proofs for `dsh-treasury/policy`:
 *
 * 1. The treasury gate BLOCKS TOOL CALLS THROUGH THE EXECUTOR — denial is
 *    asserted on `ctx.tools.execute(...)` results, not on listener plumbing,
 *    so no alternate caller path can bypass it (dsh rule: "Enforce a decision
 *    in the operation that makes it... test denial through the executor").
 * 2. A denied model request SHORT-CIRCUITS `agent/request` — the mock adapter
 *    records zero dispatches and the turn ends in error, proving the throw
 *    happened before any provider traffic.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as treasury from '../src/index.ts'
import * as treasuryPolicy from '../src/policy.ts'
import { MemoryStorageBackend } from './helpers/memory-backend.ts'

const testSignal = new AbortController().signal

/** One µUSD balance row helper. */
function usd(usdEstimate: number) {
  return { chain: 'ethereum', token: 'USDC', amount: usdEstimate, usdEstimate }
}

/** Mount the storage stack + ledger + policy onto an existing context. */
async function mountTreasury(ctx: Context, options: {
  treasury?: treasury.Config
  policy?: Partial<treasuryPolicy.Config>
}) {
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend()
  ctx.storage.backend.register('memory', backend)
  ctx.provide(storageBackendServiceKey('memory'), backend)
  await ctx.plugin(storageDomain, { backend: 'memory' })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(treasury, options.treasury ?? {})
  await ctx.plugin(treasuryPolicy, {
    inferenceUsdPerMillionTokens: 2_000_000,
    ...options.policy,
  })
}

// ── Seam 1: the tool gate, proven through the executor ───────────────────────

describe('tools/pre-execute gate (through the executor)', () => {
  /** Tool-registry harness with one costed, one free, and one infra-classified tool. */
  async function toolHarness(options: {
    treasury?: treasury.Config
    policy?: Partial<treasuryPolicy.Config>
  }) {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await mountTreasury(ctx, {
      ...options,
      policy: {
        toolCosts: { 'paid_*': 50_000 },
        toolCategories: { paid_infra: 'infrastructure' },
        ...options.policy,
      },
    })
    const ran: string[] = []
    for (const toolName of ['paid_action', 'paid_infra', 'free_action']) {
      ctx.tools.register(defineContentToolFixture({
        name: toolName,
        description: 'test tool',
        parameters: {},
        async execute() {
          ran.push(toolName)
          return [{ type: 'text' as const, text: 'done' }]
        },
      }))
    }
    let calls = 0
    const execute = (name: string) => ctx.tools.execute({
      callId: CallId(`call-${calls += 1}`),
      name,
      arguments: {},
      signal: testSignal,
    })
    return { ctx, ran, execute }
  }

  it('DENIES a costed call in DEPLETED state: error result, tool body never runs', async () => {
    const { ctx, ran, execute } = await toolHarness({
      treasury: { fixedDailyBurnUsd: 1_000_000 },
    })
    // Funded once (a balance row exists) but fully drained: value 0 against a
    // standing burn → runway 0 → depleted.
    await ctx.treasury.updateBalances([usd(0)])
    expect(ctx.treasury.state()).toBe('depleted')

    const result = await execute('paid_action')
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{
      type: 'text',
      text: 'Error: treasury denied paid_action: DEPLETED — no funds available',
    }])
    expect(ran).toEqual([]) // enforcement, not decoration: the body never ran
  })

  it('allows the same call when funded, and meters it at settlement', async () => {
    const { ctx, ran, execute } = await toolHarness({})
    await ctx.treasury.updateBalances([usd(100_000_000)]) // $100, no burn → funded
    const result = await execute('paid_action')
    expect(result.isError).toBe(false)
    expect(ran).toEqual(['paid_action'])
    const recorded = ctx.treasury.report().recentExpenses
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({
      category: 'tools',
      amount: 50_000,
      description: 'tool paid_action',
    })
  })

  it('applies the CRITICAL matrix per category: infrastructure survives, tools do not', async () => {
    const { ctx, ran, execute } = await toolHarness({
      treasury: { fixedDailyBurnUsd: 1_000_000 },
    })
    await ctx.treasury.updateBalances([usd(5_000_000)]) // 5 days → critical
    expect(ctx.treasury.state()).toBe('critical')

    const denied = await execute('paid_action')
    expect(denied.isError).toBe(true)
    expect(denied.content[0]).toMatchObject({ text: expect.stringContaining('Denied in CRITICAL state') })

    const approved = await execute('paid_infra')
    expect(approved.isError).toBe(false)
    expect(ran).toEqual(['paid_infra'])
  })

  it('leaves zero-cost calls ungated even in DEPLETED (a free read is not a spend)', async () => {
    const { ctx, ran, execute } = await toolHarness({
      treasury: { fixedDailyBurnUsd: 1_000_000 },
    })
    await ctx.treasury.updateBalances([usd(0)])
    expect(ctx.treasury.state()).toBe('depleted')

    const result = await execute('free_action')
    expect(result.isError).toBe(false)
    expect(ran).toEqual(['free_action'])
    expect(ctx.treasury.report().recentExpenses).toEqual([]) // nothing to meter
  })

  it('exempt patterns are fully transparent: neither gated nor metered', async () => {
    const { ctx, ran, execute } = await toolHarness({
      treasury: { fixedDailyBurnUsd: 1_000_000 },
      policy: { exemptTools: ['paid_act*'] },
    })
    await ctx.treasury.updateBalances([usd(0)])
    expect(ctx.treasury.state()).toBe('depleted')

    const result = await execute('paid_action')
    expect(result.isError).toBe(false)
    expect(ran).toEqual(['paid_action'])
    expect(ctx.treasury.report().recentExpenses).toEqual([])
  })

  it('stays dormant before first funding: costed calls pass but are still metered', async () => {
    const { ctx, ran, execute } = await toolHarness({
      treasury: { fixedDailyBurnUsd: 1_000_000 }, // would be depleted if enforced
    })
    expect(ctx.treasury.report().balances).toHaveLength(0)

    const result = await execute('paid_action')
    expect(result.isError).toBe(false)
    expect(ran).toEqual(['paid_action'])
    expect(ctx.treasury.report().recentExpenses).toHaveLength(1)
  })
})

// ── Seam 2: the request gate, proven through the agent loop ──────────────────

/** Minimal scripted adapter recording every request it receives. */
class MockAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []

  constructor(private readonly script: StreamChunk[][]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (!entry) throw new Error('MockAdapter: script exhausted')
    for (const chunk of entry) yield chunk
  }
}

/** Scripted plain-text model response. */
function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

describe('agent/request gate (through the agent loop)', () => {
  async function loopHarness(options: {
    treasury?: treasury.Config
    policy?: Partial<treasuryPolicy.Config>
  }) {
    const adapter = new MockAdapter([textResponse('ok'), textResponse('ok')])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountTreasury(ctx, options)
    ctx.llm.registerAdapter(['mock'], adapter)
    return { ctx, adapter }
  }

  /** Drive one user turn to quiescence and return the turn-end reason. */
  async function runTurn(ctx: Context, sessionName: string) {
    const agent = ctx.agentLoop.create(SessionId(sessionName), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'go' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    const turnEnd = [...agent.session.events].reverse()
      .find((event): event is SessionEvent<'turn/end'> => event.type === 'turn/end')
    return { agent, turnEnd }
  }

  it('DEPLETED short-circuits before dispatch: zero provider requests, turn ends in error', async () => {
    const { ctx, adapter } = await loopHarness({
      treasury: { fixedDailyBurnUsd: 1_000_000 },
    })
    await ctx.treasury.updateBalances([usd(0)]) // funded once, fully drained → depleted
    expect(ctx.treasury.state()).toBe('depleted')

    const { turnEnd } = await runTurn(ctx, 'session-depleted')
    // THE seam proof: the model was never called.
    expect(adapter.requests).toHaveLength(0)
    expect(turnEnd?.data.reason.kind).toBe('error')
    const reason = turnEnd?.data.reason as { error?: { message?: string } } | undefined
    expect(reason?.error?.message ?? '').toContain('treasury denied inference')
    // Nothing was metered: no request happened.
    expect(ctx.treasury.report().recentExpenses).toEqual([])
  })

  it('FUNDED lets the request through and meters the estimated spend', async () => {
    const { ctx, adapter } = await loopHarness({})
    await ctx.treasury.updateBalances([usd(100_000_000_000)]) // $100k → comfortably funded

    const { turnEnd } = await runTurn(ctx, 'session-funded')
    expect(adapter.requests.length).toBeGreaterThan(0)
    expect(turnEnd?.data.reason.kind).toBe('completed')
    const inference = ctx.treasury.report().recentExpenses
      .filter(expense => expense.category === 'inference')
    expect(inference.length).toBeGreaterThan(0)
    expect(inference[0]?.amount).toBeGreaterThan(0)
    expect(inference[0]?.description).toMatch(/model request/)
  })

  it('CRITICAL applies the haven inference cap: expensive requests halt, cheap ones run', async () => {
    // Expensive: $100k per 1M tokens makes any request breach the $0.10 cap.
    const expensive = await loopHarness({
      treasury: { fixedDailyBurnUsd: 1_000_000 },
      policy: { inferenceUsdPerMillionTokens: 100_000_000_000 },
    })
    await expensive.ctx.treasury.updateBalances([usd(5_000_000)]) // 5 days → critical
    expect(expensive.ctx.treasury.state()).toBe('critical')
    await runTurn(expensive.ctx, 'session-critical-expensive')
    expect(expensive.adapter.requests).toHaveLength(0)

    // Cheap: 1 µUSD per 1M tokens stays far under the cap.
    const cheap = await loopHarness({
      treasury: { fixedDailyBurnUsd: 1_000_000 },
      policy: { inferenceUsdPerMillionTokens: 1 },
    })
    await cheap.ctx.treasury.updateBalances([usd(5_000_000)])
    expect(cheap.ctx.treasury.state()).toBe('critical')
    await runTurn(cheap.ctx, 'session-critical-cheap')
    expect(cheap.adapter.requests.length).toBeGreaterThan(0)
  })

  it('stays dormant before first funding: requests flow and are metered', async () => {
    const { ctx, adapter } = await loopHarness({
      treasury: { fixedDailyBurnUsd: 1_000_000 }, // would be depleted if enforced
    })
    const { turnEnd } = await runTurn(ctx, 'session-unfunded')
    expect(adapter.requests.length).toBeGreaterThan(0)
    expect(turnEnd?.data.reason.kind).toBe('completed')
    expect(ctx.treasury.report().recentExpenses.some(expense => expense.category === 'inference')).toBe(true)
  })
})
