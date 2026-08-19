/**
 * Type surface of the treasury ledger: the report shape, mutation inputs, and
 * the seam's Cordis event declarations. Types only — no runtime code.
 *
 * @module dsh-treasury/types
 */

import type { BudgetAllocation, BudgetCategory, TreasuryState } from './haven.ts'
import type { ChainBalance, Expense } from './domain.ts'

/** Snapshot of economic state (haven-core `TreasuryReport`). All USD figures in µUSD. */
export interface TreasuryReport {
  /** Derived survival state. */
  readonly state: TreasuryState
  /** Current balances, one per chain+token. */
  readonly balances: readonly ChainBalance[]
  /** Total treasury value in µUSD (sum of balance estimates). */
  readonly totalValueUsd: number
  /** Daily burn in µUSD (configured fixed burn + trailing-window spend). */
  readonly dailyBurnUsd: number
  /** Whole days of runway at the current burn. */
  readonly runwayDays: number
  /** Percentage caps per category. */
  readonly budget: BudgetAllocation
  /** Most recent expenses, oldest first, bounded by the configured retention. */
  readonly recentExpenses: readonly Expense[]
}

/** Caller input for one expense; `timestamp` and identity are ledger-owned. */
export interface ExpenseInput {
  /** Budget category the spend accrues against. */
  readonly category: BudgetCategory
  /** Spend in µUSD (non-negative integer). */
  readonly amount: number
  /** Token or accounting unit; defaults to `USD`. */
  readonly token?: string
  /** Human-readable description of what was paid for. */
  readonly description?: string
}

/** Payload of one derived-state transition. */
export interface TreasuryStateChange {
  /** State before the transition. */
  readonly previous: TreasuryState
  /** State after the transition. */
  readonly current: TreasuryState
  /** Full report at the commit point of the mutation that caused the change. */
  readonly report: TreasuryReport
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The derived survival state changed. Emitted strictly after the durable
     * write that caused the change landed (the commit point), with the report
     * derived from the post-write ledger.
     * @param change - previous and current state plus the committed report.
     * @mode emit
     */
    'treasury/state-changed'(change: TreasuryStateChange): void

    /**
     * One expense landed durably in the ledger.
     * @param expense - the recorded expense.
     * @mode emit
     */
    'treasury/expense'(expense: Expense): void
  }
}
