/**
 * Pure survival-economics vocabulary ported from haven-core (`src/types.ts`,
 * `src/interfaces.ts`, and the `Treasury` machine's per-state authorization
 * matrix). No side effects, no IO — every function here is a direct concept
 * transfer with dsh-native shapes (lowercase string unions instead of enums;
 * integer micro-USD amounts throughout).
 *
 * Money precision: every USD amount in this package is an integer in
 * micro-USD (USD × 1e6), the same precision haven-core used for
 * `usdEstimate`/`totalValueUsd`.
 *
 * @module dsh-treasury/haven
 */

/**
 * Treasury health — the survival gradient (haven-core `TreasuryState`).
 * `funded`: runway > 30 days, normal operation. `low`: 7–30 days,
 * cost-conscious. `critical`: < 7 days, survival mode. `depleted`: cannot pay
 * for the next cycle.
 */
export type TreasuryState = 'funded' | 'low' | 'critical' | 'depleted'

/** Budget category for expense tracking (haven-core `BudgetCategory`). */
export type BudgetCategory =
  | 'inference'
  | 'tools'
  | 'infrastructure'
  | 'storage'
  | 'messaging'
  | 'reserve'

/** Every category, for iteration and validation. */
export const BUDGET_CATEGORIES: readonly BudgetCategory[] = [
  'inference', 'tools', 'infrastructure', 'storage', 'messaging', 'reserve',
]

/** Percentage caps per category; the six values must total 100. */
export interface BudgetAllocation {
  readonly inference: number
  readonly tools: number
  readonly infrastructure: number
  readonly storage: number
  readonly messaging: number
  readonly reserve: number
}

/** Sentinel runway when there is no burn (haven-core `computeRunway`). */
export const INFINITE_RUNWAY_DAYS = 9999

/**
 * Micro-USD ceiling under which inference stays authorized in `critical`
 * state (haven-core Treasury machine: "Allow inference only if very cheap",
 * total < 100000 µUSD = $0.10).
 */
export const CRITICAL_INFERENCE_CAP_USD = 100_000

/**
 * Default budget allocation — balanced, with storage and emergency reserves
 * (haven-core `defaultBudgetAllocation`). Total = 100.
 */
export function defaultBudgetAllocation(): BudgetAllocation {
  return {
    inference: 38,
    tools: 14,
    infrastructure: 28,
    storage: 5,
    messaging: 10,
    reserve: 5,
  }
}

/**
 * Compute runway in days from total value and daily burn (haven-core
 * `computeRunway`): `floor(total / burn)`, or {@link INFINITE_RUNWAY_DAYS}
 * when there is no burn.
 * @param totalValueUsd - treasury value in µUSD.
 * @param dailyBurnUsd - daily spend in µUSD.
 * @returns whole days of runway.
 */
export function computeRunway(totalValueUsd: number, dailyBurnUsd: number): number {
  if (dailyBurnUsd <= 0) return INFINITE_RUNWAY_DAYS
  return Math.floor(totalValueUsd / dailyBurnUsd)
}

/**
 * Derive the treasury state from runway days (haven-core
 * `computeTreasuryState`): > 30 `funded`, > 7 `low`, > 0 `critical`, else
 * `depleted`.
 * @param runwayDays - whole days of runway.
 * @returns the derived state.
 */
export function computeTreasuryState(runwayDays: number): TreasuryState {
  if (runwayDays > 30) return 'funded'
  if (runwayDays > 7) return 'low'
  if (runwayDays > 0) return 'critical'
  return 'depleted'
}

/**
 * Whether a category has remaining allocation (haven-core
 * `isBudgetAvailable`): spent percentage strictly below the category cap.
 * @param budget - percentage caps per category.
 * @param category - category under test.
 * @param spentPercentage - whole-percent share of treasury value already spent on the category.
 * @returns whether more spend fits the cap.
 */
export function isBudgetAvailable(
  budget: BudgetAllocation,
  category: BudgetCategory,
  spentPercentage: number,
): boolean {
  return spentPercentage < budget[category]
}

/** One authorization verdict (haven-core `eCostAuthorized` payload concept). */
export interface CostDecision {
  readonly approved: boolean
  readonly reason: string
}

/**
 * The per-state cost-authorization matrix, extracted from haven-core's
 * Treasury machine state handlers as one pure function:
 *
 * - `funded`: ordinary budget check per category.
 * - `low`: the reserve is locked; everything else is a budget check.
 * - `critical`: infrastructure and storage are life-or-death and always
 *   approve; inference approves only under
 *   {@link CRITICAL_INFERENCE_CAP_USD}; everything else is denied.
 * - `depleted`: everything is denied.
 *
 * @param state - current treasury state.
 * @param category - category of the pending cost.
 * @param estimatedCostUsd - pending cost in µUSD (used by the critical-inference rule).
 * @param budget - percentage caps per category.
 * @param spentPercentage - whole-percent share of treasury value already spent on the category.
 * @returns the verdict with a human-actionable reason.
 */
export function authorizeCost(
  state: TreasuryState,
  category: BudgetCategory,
  estimatedCostUsd: number,
  budget: BudgetAllocation,
  spentPercentage: number,
): CostDecision {
  switch (state) {
    case 'funded':
      return isBudgetAvailable(budget, category, spentPercentage)
        ? { approved: true, reason: 'Authorized' }
        : { approved: false, reason: `Budget limit reached for category "${category}"` }
    case 'low':
      if (category === 'reserve') {
        return { approved: false, reason: 'Reserve locked in LOW state' }
      }
      return isBudgetAvailable(budget, category, spentPercentage)
        ? { approved: true, reason: 'Authorized (cost-conscious)' }
        : { approved: false, reason: `Budget exhausted in LOW state for category "${category}"` }
    case 'critical':
      if (category === 'infrastructure') {
        return { approved: true, reason: 'Infrastructure authorized (survival)' }
      }
      if (category === 'storage') {
        return { approved: true, reason: 'Storage authorized (survival — memory persistence)' }
      }
      if (category === 'inference') {
        return estimatedCostUsd < CRITICAL_INFERENCE_CAP_USD
          ? { approved: true, reason: 'Minimal inference authorized (survival)' }
          : { approved: false, reason: 'Inference too expensive in CRITICAL state' }
      }
      return { approved: false, reason: `Denied in CRITICAL state (category "${category}")` }
    case 'depleted':
      return { approved: false, reason: 'DEPLETED — no funds available' }
    default:
      return state satisfies never
  }
}
