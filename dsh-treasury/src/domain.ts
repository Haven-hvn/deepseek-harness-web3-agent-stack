/**
 * Storage-domain declaration of the treasury ledger: balances and expenses as
 * schema-validated KV records (haven-core's `ChainBalance` and `Expense`
 * records as durable rows). Record schemas are zod per the storage-domain
 * convention; validation runs at the durable boundary on open.
 *
 * @module dsh-treasury/domain
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { BUDGET_CATEGORIES } from './haven.ts'
import type { BudgetCategory } from './haven.ts'

/** Integer micro-USD (USD × 1e6), non-negative. */
const microUsd = z.number().int().nonnegative()

/**
 * Balance on a single chain (haven-core `ChainBalance`): token amount in the
 * chain's smallest unit plus a µUSD estimate.
 */
export const chainBalanceSchema = z.object({
  /** Chain id (e.g. `ethereum`, `solana`). */
  chain: z.string().min(1),
  /** Token symbol (e.g. `ETH`, `USDC`). */
  token: z.string().min(1),
  /** Amount in the token's smallest unit (wei, lamports, …). */
  amount: z.number().nonnegative(),
  /** Approximate USD value in µUSD. */
  usdEstimate: microUsd,
})

export type ChainBalance = z.infer<typeof chainBalanceSchema>

/** Expense record for the ledger (haven-core `Expense`), keyed by expense id. */
export const expenseSchema = z.object({
  /** Unix ms when the expense was recorded. */
  timestamp: z.number().int().nonnegative(),
  /** Budget category the spend accrues against. */
  category: z.enum(BUDGET_CATEGORIES as [BudgetCategory, ...BudgetCategory[]]),
  /** Token or accounting unit the spend was denominated in (`USD` for metered costs). */
  token: z.string().min(1),
  /** Spend in µUSD. */
  amount: microUsd,
  /** Human-readable description of what was paid for. */
  description: z.string(),
})

export type Expense = z.infer<typeof expenseSchema>

/** Key of one balances row: `<chain>:<token>`. */
export function balanceKey(balance: Pick<ChainBalance, 'chain' | 'token'>): string {
  return `${balance.chain}:${balance.token}`
}

/**
 * The treasury domain: one `balances` row per chain+token, one `expenses`
 * row per recorded spend. No global slot — every derived figure (total
 * value, daily burn, runway, state) recomputes from rows, so there is no
 * second copy to drift.
 */
export const treasuryDomain = defineDomain({
  name: 'treasury',
  version: 1,
  tables: {
    balances: domainTable<string, ChainBalance>(chainBalanceSchema),
    expenses: domainTable<string, Expense>(expenseSchema),
  },
})

export type TreasuryDomain = typeof treasuryDomain
