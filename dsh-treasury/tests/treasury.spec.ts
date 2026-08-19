/**
 * Ledger coverage: the pure haven-core port (runway/state/budget matrix),
 * durable balance/expense records over the storage domain, derived-state
 * transitions emitted at commit points, and restart persistence.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import * as treasury from '../src/index.ts'
import {
  authorizeCost,
  computeRunway,
  computeTreasuryState,
  CRITICAL_INFERENCE_CAP_USD,
  defaultBudgetAllocation,
  INFINITE_RUNWAY_DAYS,
} from '../src/haven.ts'
import type { TreasuryStateChange } from '../src/types.ts'
import type { Expense } from '../src/domain.ts'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'

/** One µUSD balance row helper. */
function usd(usdEstimate: number, token = 'USDC') {
  return { chain: 'ethereum', token, amount: usdEstimate, usdEstimate }
}

/** Boot storage hub + memory backend + domain form + the treasury ledger. */
async function harness(options?: { pool?: MemoryMediaPool; config?: treasury.Config }) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(options?.pool)
  ctx.storage.backend.register('memory', backend)
  // Backend plugins provide this lifecycle key; the domain form injects it.
  ctx.provide(storageBackendServiceKey('memory'), backend)
  await ctx.plugin(storageDomain, { backend: 'memory' })
  await ctx.plugin(treasury, options?.config ?? {})
  const changes: TreasuryStateChange[] = []
  const expenses: Expense[] = []
  ctx.on('treasury/state-changed', (change) => { changes.push(change) })
  ctx.on('treasury/expense', (expense) => { expenses.push(expense) })
  return { ctx, changes, expenses, pool: backend.pool }
}

describe('haven-core concept port (pure)', () => {
  it('computeRunway floors and treats no burn as effectively infinite', () => {
    expect(computeRunway(100, 0)).toBe(INFINITE_RUNWAY_DAYS)
    expect(computeRunway(100, -5)).toBe(INFINITE_RUNWAY_DAYS)
    expect(computeRunway(100, 3)).toBe(33)
    expect(computeRunway(0, 3)).toBe(0)
  })

  it('computeTreasuryState keeps the haven thresholds exactly', () => {
    expect(computeTreasuryState(31)).toBe('funded')
    expect(computeTreasuryState(30)).toBe('low')
    expect(computeTreasuryState(8)).toBe('low')
    expect(computeTreasuryState(7)).toBe('critical')
    expect(computeTreasuryState(1)).toBe('critical')
    expect(computeTreasuryState(0)).toBe('depleted')
  })

  it('authorizeCost reproduces the per-state matrix', () => {
    const budget = defaultBudgetAllocation()
    // funded: plain budget check.
    expect(authorizeCost('funded', 'inference', 1, budget, 0).approved).toBe(true)
    expect(authorizeCost('funded', 'inference', 1, budget, 38).approved).toBe(false)
    // low: reserve locked, others budget-checked.
    expect(authorizeCost('low', 'reserve', 1, budget, 0)).toMatchObject({ approved: false })
    expect(authorizeCost('low', 'tools', 1, budget, 0).approved).toBe(true)
    // critical: infrastructure/storage survive, inference only under the cap, rest denied.
    expect(authorizeCost('critical', 'infrastructure', 10 ** 9, budget, 99).approved).toBe(true)
    expect(authorizeCost('critical', 'storage', 10 ** 9, budget, 99).approved).toBe(true)
    expect(authorizeCost('critical', 'inference', CRITICAL_INFERENCE_CAP_USD - 1, budget, 0).approved).toBe(true)
    expect(authorizeCost('critical', 'inference', CRITICAL_INFERENCE_CAP_USD, budget, 0).approved).toBe(false)
    expect(authorizeCost('critical', 'tools', 1, budget, 0).approved).toBe(false)
    // depleted: everything denied.
    expect(authorizeCost('depleted', 'infrastructure', 0, budget, 0).approved).toBe(false)
  })
})

describe('config validation fails loud', () => {
  it('rejects a budget that does not total 100', async () => {
    const bad = await harness({
      config: { budget: { inference: 50, tools: 50, infrastructure: 10, storage: 0, messaging: 0, reserve: 0 } },
    }).then(() => undefined, (error: unknown) => error as Error)
    expect(bad?.message).toMatch(/must total 100/)
  })

  it('rejects a non-positive burn window and negative fixed burn', async () => {
    await expect(harness({ config: { burnWindowMs: 0 } })).rejects.toThrow(/positive integer/)
    await expect(harness({ config: { fixedDailyBurnUsd: -1 } })).rejects.toThrow(/non-negative integer/)
  })
})

describe('balances and derived state', () => {
  it('reports totals and stays funded with no burn', async () => {
    const { ctx } = await harness()
    const report = await ctx.treasury.updateBalances([usd(40_000_000), usd(10_000_000, 'ETH')])
    expect(report.totalValueUsd).toBe(50_000_000)
    expect(report.dailyBurnUsd).toBe(0)
    expect(report.runwayDays).toBe(INFINITE_RUNWAY_DAYS)
    expect(report.state).toBe('funded')
    expect(ctx.treasury.state()).toBe('funded')
  })

  it('replaces the balance sheet: absent rows are deleted, duplicates rejected', async () => {
    const { ctx } = await harness()
    await ctx.treasury.updateBalances([usd(1_000_000), usd(2_000_000, 'ETH')])
    const report = await ctx.treasury.updateBalances([usd(3_000_000)])
    expect(report.balances).toEqual([usd(3_000_000)])
    await expect(ctx.treasury.updateBalances([usd(1), usd(2)]))
      .rejects.toMatchObject({ code: 'invalid-balance' })
  })

  it('walks the survival gradient off balance updates, one event per transition', async () => {
    // A configured standing burn of $1/day makes runway purely a function of value.
    const { ctx, changes } = await harness({ config: { fixedDailyBurnUsd: 1_000_000 } })
    expect(ctx.treasury.state()).toBe('depleted') // boot: no value, standing burn

    await ctx.treasury.updateBalances([usd(40_000_000)]) // 40 days
    await ctx.treasury.updateBalances([usd(20_000_000)]) // 20 days
    await ctx.treasury.updateBalances([usd(5_000_000)]) // 5 days
    await ctx.treasury.updateBalances([]) // drained

    expect(changes.map(change => `${change.previous}->${change.current}`)).toEqual([
      'depleted->funded',
      'funded->low',
      'low->critical',
      'critical->depleted',
    ])
    // Each event carries the committed report it was derived from.
    expect(changes[2]?.report.runwayDays).toBe(5)
    expect(changes[2]?.report.state).toBe('critical')
  })
})

describe('expenses', () => {
  it('records durably, emits treasury/expense, and recomputes burn and state', async () => {
    const { ctx, changes, expenses } = await harness()
    await ctx.treasury.updateBalances([usd(10_000_000)]) // $10
    const report = await ctx.treasury.recordExpense({
      category: 'inference',
      amount: 400_000,
      description: 'model request',
    })
    expect(expenses).toHaveLength(1)
    expect(expenses[0]).toMatchObject({ category: 'inference', amount: 400_000, token: 'USD' })
    // $0.40 in the trailing day → runway floor(10M/400k) = 25 days → low.
    expect(report.dailyBurnUsd).toBe(400_000)
    expect(report.runwayDays).toBe(25)
    expect(report.state).toBe('low')
    expect(changes.at(-1)).toMatchObject({ previous: 'funded', current: 'low' })
  })

  it('validates category and amount before any write', async () => {
    const { ctx } = await harness()
    await expect(ctx.treasury.recordExpense({ category: 'inference', amount: 1.5 }))
      .rejects.toMatchObject({ code: 'invalid-expense' })
    await expect(ctx.treasury.recordExpense({ category: 'snacks' as never, amount: 1 }))
      .rejects.toMatchObject({ code: 'invalid-expense' })
  })

  it('prunes the oldest rows beyond maxExpenses', async () => {
    const { ctx } = await harness({ config: { maxExpenses: 3 } })
    for (let index = 0; index < 5; index += 1) {
      await ctx.treasury.recordExpense({ category: 'tools', amount: index, description: `spend ${index}` })
    }
    expect(ctx.treasury.report().recentExpenses).toHaveLength(3)
  })

  it('authorize() reflects live category spend against the budget', async () => {
    const { ctx } = await harness({ config: { burnWindowMs: 30 * 86_400_000 } })
    await ctx.treasury.updateBalances([usd(1_000_000)]) // $1 treasury
    // Spend 38% of treasury value on inference — the category cap exactly.
    // Long window keeps daily burn low so state stays funded.
    await ctx.treasury.recordExpense({ category: 'inference', amount: 380_000 })
    expect(ctx.treasury.state()).toBe('funded')
    expect(ctx.treasury.authorize('inference', 1).approved).toBe(false)
    expect(ctx.treasury.authorize('tools', 1).approved).toBe(true)
  })
})

describe('persistence across restarts', () => {
  it('reopens the same medium with records intact and re-derives the boot state', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness({ pool, config: { fixedDailyBurnUsd: 1_000_000 } })
    await first.ctx.treasury.updateBalances([usd(5_000_000)])
    await first.ctx.treasury.recordExpense({ category: 'tools', amount: 42, description: 'gas' })
    expect(first.ctx.treasury.state()).toBe('critical')

    const second = await harness({ pool, config: { fixedDailyBurnUsd: 1_000_000 } })
    const report = second.ctx.treasury.report()
    expect(report.balances).toEqual([usd(5_000_000)])
    expect(report.recentExpenses).toHaveLength(1)
    expect(report.recentExpenses[0]).toMatchObject({ category: 'tools', amount: 42 })
    // Boot state is derived from rows, not stored: same rows, same state.
    expect(second.ctx.treasury.state()).toBe('critical')
  })
})
