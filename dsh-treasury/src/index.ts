/**
 * The treasury ledger (`ctx.treasury`): haven-core's Treasury machine — the
 * economic survival engine — re-homed onto dsh seams. Balances and expenses
 * are schema-validated storage-domain records; FUNDED/LOW/CRITICAL/DEPLETED
 * is *derived* state recomputed from those records after every durable write
 * (never stored, so it cannot drift); enforcement lives in the companion
 * policy plugin (`dsh-treasury/policy`), which short-circuits `agent/request`
 * and `tools/pre-execute` off this ledger's authorization matrix.
 *
 * Write discipline: every mutation awaits the domain write chain (backend
 * durability first, then memory), and `treasury/state-changed` /
 * `treasury/expense` emit strictly after that commit point.
 *
 * @module dsh-treasury
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import {
  authorizeCost,
  BUDGET_CATEGORIES,
  computeRunway,
  computeTreasuryState,
  defaultBudgetAllocation,
} from './haven.ts'
import type { BudgetAllocation, BudgetCategory, CostDecision, TreasuryState } from './haven.ts'
import { balanceKey, treasuryDomain } from './domain.ts'
import type { ChainBalance, Expense, TreasuryDomain } from './domain.ts'
import type { ExpenseInput, TreasuryReport } from './types.ts'

export {
  authorizeCost,
  BUDGET_CATEGORIES,
  computeRunway,
  computeTreasuryState,
  CRITICAL_INFERENCE_CAP_USD,
  defaultBudgetAllocation,
  INFINITE_RUNWAY_DAYS,
  isBudgetAvailable,
} from './haven.ts'
export type { BudgetAllocation, BudgetCategory, CostDecision, TreasuryState } from './haven.ts'
export { balanceKey, chainBalanceSchema, expenseSchema, treasuryDomain } from './domain.ts'
export type { ChainBalance, Expense, TreasuryDomain } from './domain.ts'
export type { ExpenseInput, TreasuryReport, TreasuryStateChange } from './types.ts'

/** Stable machine-readable failure codes of the treasury ledger. */
export type TreasuryErrorCode = 'invalid-budget' | 'invalid-expense' | 'invalid-balance'

/** Structured treasury failure. */
export class TreasuryError extends Error {
  override readonly name = 'TreasuryError'
  /** Stable machine-readable code. */
  readonly code: TreasuryErrorCode

  constructor(code: TreasuryErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/** Cordis plugin name. */
export const name = 'treasury'

/** The domain form must be mounted before the ledger can open its records. */
export const inject = ['storageDomain']

/** Plugin configuration. */
export interface Config {
  /** Percentage caps per category; the six values must total 100. Defaults to the haven-core allocation. */
  budget?: BudgetAllocation
  /** Trailing window over which recorded expenses count toward burn (ms). */
  burnWindowMs?: number
  /**
   * Fixed daily burn in µUSD added on top of windowed spend — standing costs
   * (compute leases, pinning deals) the expense stream does not itself record.
   */
  fixedDailyBurnUsd?: number
  /** Maximum retained expense rows; recording past the cap prunes the oldest. */
  maxExpenses?: number
}

export const Config: z<Config> = z.object({
  budget: z.object({
    inference: z.number().required(),
    tools: z.number().required(),
    infrastructure: z.number().required(),
    storage: z.number().required(),
    messaging: z.number().required(),
    reserve: z.number().required(),
  }).default(defaultBudgetAllocation()),
  burnWindowMs: z.number().default(86_400_000),
  fixedDailyBurnUsd: z.number().default(0),
  maxExpenses: z.number().default(1000),
})

/** Validated config with defaults materialized. */
interface ResolvedConfig {
  readonly budget: BudgetAllocation
  readonly burnWindowMs: number
  readonly fixedDailyBurnUsd: number
  readonly maxExpenses: number
}

/** Fail loud on a budget that does not describe a whole treasury. */
function resolveBudget(budget: BudgetAllocation | undefined): BudgetAllocation {
  if (budget === undefined) return defaultBudgetAllocation()
  let total = 0
  for (const category of BUDGET_CATEGORIES) {
    const share = budget[category]
    if (!Number.isFinite(share) || share < 0 || share > 100) {
      throw new TreasuryError('invalid-budget', `budget.${category} must be a percentage in [0, 100], got ${share}`)
    }
    total += share
  }
  if (total !== 100) {
    throw new TreasuryError('invalid-budget', `budget percentages must total 100, got ${total}`)
  }
  return budget
}

/** Validate the remaining knobs. */
function resolveConfig(config: Config): ResolvedConfig {
  const burnWindowMs = config.burnWindowMs ?? 86_400_000
  if (!Number.isInteger(burnWindowMs) || burnWindowMs <= 0) {
    throw new TreasuryError('invalid-budget', `burnWindowMs must be a positive integer, got ${burnWindowMs}`)
  }
  const fixedDailyBurnUsd = config.fixedDailyBurnUsd ?? 0
  if (!Number.isInteger(fixedDailyBurnUsd) || fixedDailyBurnUsd < 0) {
    throw new TreasuryError('invalid-budget', `fixedDailyBurnUsd must be a non-negative integer (µUSD), got ${fixedDailyBurnUsd}`)
  }
  const maxExpenses = config.maxExpenses ?? 1000
  if (!Number.isInteger(maxExpenses) || maxExpenses < 1) {
    throw new TreasuryError('invalid-budget', `maxExpenses must be a positive integer, got ${maxExpenses}`)
  }
  return { budget: resolveBudget(config.budget), burnWindowMs, fixedDailyBurnUsd, maxExpenses }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    treasury: Treasury
  }
}

/**
 * The ledger service. Constructed over an already-open domain by `apply`;
 * every read derives from the domain's authoritative in-memory tables, every
 * write goes through its durable write chain.
 */
export class Treasury {
  private currentState: TreasuryState

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
    private readonly domain: Domain<TreasuryDomain>,
  ) {
    // Derive the boot state from persisted rows: a restart lands in the same
    // state the ledger last committed, without storing state anywhere.
    this.currentState = computeTreasuryState(this.runwayDays())
  }

  /** Current derived survival state. */
  state(): TreasuryState {
    return this.currentState
  }

  /** Full report snapshot (haven-core `TreasuryReport`), derived from current rows. */
  report(): TreasuryReport {
    const balances = [...this.domain.table('balances').entries()].map(([, balance]) => balance)
    const expenses = this.sortedExpenses().map(([, expense]) => expense)
    return {
      state: this.currentState,
      balances,
      totalValueUsd: this.totalValueUsd(),
      dailyBurnUsd: this.dailyBurnUsd(),
      runwayDays: this.runwayDays(),
      budget: this.config.budget,
      recentExpenses: expenses,
    }
  }

  /**
   * Authorize one pending cost against the current state and budget — the
   * haven-core `eCostAuthorize` request as a synchronous service call. Pure
   * read: recording the spend (if it happens) is the caller's separate,
   * post-commit step.
   * @param category - category of the pending cost.
   * @param estimatedCostUsd - pending cost in µUSD.
   * @returns the verdict with an actionable reason.
   */
  authorize(category: BudgetCategory, estimatedCostUsd: number): CostDecision {
    return authorizeCost(
      this.currentState,
      category,
      estimatedCostUsd,
      this.config.budget,
      this.spentPercentage(category),
    )
  }

  /**
   * Replace the balance sheet (haven-core `eBalanceUpdate`): upsert every
   * given row and delete rows absent from the update. Emits
   * `treasury/state-changed` after the last write lands when the derived
   * state moved.
   * @param balances - the complete new balance set.
   * @returns the post-commit report.
   */
  async updateBalances(balances: readonly ChainBalance[]): Promise<TreasuryReport> {
    const table = this.domain.table('balances')
    const keep = new Set<string>()
    for (const balance of balances) {
      validateBalance(balance)
      const key = balanceKey(balance)
      if (keep.has(key)) {
        throw new TreasuryError('invalid-balance', `duplicate balance row for ${key}`)
      }
      keep.add(key)
    }
    for (const key of [...table.keys()]) {
      if (!keep.has(key)) await table.delete(key)
    }
    for (const balance of balances) {
      await table.put(balanceKey(balance), balance)
    }
    return this.settle()
  }

  /**
   * Record one expense (haven-core `eExpenseRecord`): validate, write
   * durably, prune past retention, then emit `treasury/expense` (and
   * `treasury/state-changed` when the derived state moved).
   * @param input - category, µUSD amount, optional token and description.
   * @returns the post-commit report.
   */
  async recordExpense(input: ExpenseInput): Promise<TreasuryReport> {
    if (!BUDGET_CATEGORIES.includes(input.category)) {
      throw new TreasuryError('invalid-expense', `unknown budget category "${String(input.category)}"`)
    }
    if (!Number.isInteger(input.amount) || input.amount < 0) {
      throw new TreasuryError('invalid-expense', `expense amount must be a non-negative integer (µUSD), got ${input.amount}`)
    }
    const expense: Expense = {
      timestamp: Date.now(),
      category: input.category,
      token: input.token ?? 'USD',
      amount: input.amount,
      description: input.description ?? '',
    }
    const table = this.domain.table('expenses')
    await table.put(`exp-${expense.timestamp}-${randomUUID()}`, expense)
    // Bounded ledger: prune oldest rows beyond retention so burn derivation
    // and reports stay O(maxExpenses) forever.
    const sorted = this.sortedExpenses()
    for (let index = 0; index < sorted.length - this.config.maxExpenses; index += 1) {
      const entry = sorted[index]
      if (entry !== undefined) await table.delete(entry[0])
    }
    this.ctx.emit('treasury/expense', expense)
    return this.settle()
  }

  // ── derived figures (pure reads over domain tables) ────────────────────────

  private totalValueUsd(): number {
    let total = 0
    for (const [, balance] of this.domain.table('balances').entries()) {
      total += balance.usdEstimate
    }
    return total
  }

  /** Windowed spend scaled to per-day, plus the configured standing burn. */
  private dailyBurnUsd(): number {
    const cutoff = Date.now() - this.config.burnWindowMs
    let windowed = 0
    for (const [, expense] of this.domain.table('expenses').entries()) {
      if (expense.timestamp >= cutoff) windowed += expense.amount
    }
    const perDay = Math.ceil((windowed * 86_400_000) / this.config.burnWindowMs)
    return this.config.fixedDailyBurnUsd + perDay
  }

  private runwayDays(): number {
    return computeRunway(this.totalValueUsd(), this.dailyBurnUsd())
  }

  /**
   * Whole-percent share of treasury value already spent on one category
   * (haven-core `getCategorySpentPercentage`, including its zero-value rule:
   * an empty treasury reads as 100% spent).
   */
  private spentPercentage(category: BudgetCategory): number {
    const total = this.totalValueUsd()
    if (total === 0) return 100
    let spent = 0
    for (const [, expense] of this.domain.table('expenses').entries()) {
      if (expense.category === category) spent += expense.amount
    }
    return Math.floor((spent * 100) / total)
  }

  /** Expense entries oldest-first (key order breaks timestamp ties deterministically). */
  private sortedExpenses(): [string, Expense][] {
    return [...this.domain.table('expenses').entries()]
      .sort((a, b) => a[1].timestamp - b[1].timestamp || (a[0] < b[0] ? -1 : 1))
  }

  /** Recompute the derived state after a committed mutation and publish a transition. */
  private settle(): TreasuryReport {
    const next = computeTreasuryState(this.runwayDays())
    const previous = this.currentState
    this.currentState = next
    const report = this.report()
    if (next !== previous) {
      this.ctx.emit('treasury/state-changed', { previous, current: next, report })
    }
    return report
  }
}

/** Reject malformed balance rows before any write happens. */
function validateBalance(balance: ChainBalance): void {
  if (balance.chain.trim().length === 0 || balance.token.trim().length === 0) {
    throw new TreasuryError('invalid-balance', 'balance rows need non-empty chain and token')
  }
  if (!Number.isFinite(balance.amount) || balance.amount < 0) {
    throw new TreasuryError('invalid-balance', `balance amount must be non-negative, got ${balance.amount}`)
  }
  if (!Number.isInteger(balance.usdEstimate) || balance.usdEstimate < 0) {
    throw new TreasuryError('invalid-balance', `usdEstimate must be a non-negative integer (µUSD), got ${balance.usdEstimate}`)
  }
}

/**
 * Mount the ledger: open the treasury domain (records validate at this
 * durable boundary), tie its lifetime to the plugin, and provide
 * `ctx.treasury`.
 * @param ctx - plugin context carrying the domain form.
 * @param config - validated configuration.
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const resolved = resolveConfig(config)
  const domain = await ctx.storageDomain.open(treasuryDomain)
  ctx.effect(() => () => domain.close())
  ctx.provide('treasury', new Treasury(ctx, resolved, domain))
}
