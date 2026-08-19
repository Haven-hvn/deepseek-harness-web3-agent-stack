/**
 * Treasury enforcement (`dsh-treasury/policy`): the plugin that makes the
 * ledger's survival gradient bite, following the dsh policy-plugin precedent
 * (`guard/`): listeners on the decision waterfalls, short-circuiting where
 * they own the decision.
 *
 * - `agent/request` — before each model call, price the pending request off
 *   `ctx.tokenMeter` (request pressure × configured µUSD-per-token rate),
 *   ask the ledger's per-state authorization matrix, and THROW without
 *   calling `next()` on denial. A request-middleware throw fails the request
 *   with no recovery offered (`agent/request-error` never sees it) — the
 *   loop's strongest halt.
 * - `tools/pre-execute` — gate cost-declared tool calls through the same
 *   matrix, returning `{ kind: 'deny', reason }` without `next()` on denial;
 *   the registry materializes the error result the model sees. Denial is
 *   enforced in the executor, so no alternate caller bypasses it.
 * - `tools/post-execute` — record an admitted call's declared cost once the
 *   call settles (observe-and-record: always delegates).
 *
 * Enforcement activates once the treasury has been funded (any balance row
 * exists — `ctx.treasury.updateBalances(...)`). A pristine, never-funded
 * ledger meters inference but denies nothing: haven-core's zero-value rule
 * ("an empty treasury reads as 100% spent") would otherwise brick a fresh
 * install before its first funding.
 *
 * @module dsh-treasury/policy
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreToolDecision, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
// Type-only: these carry the `agent/request` event declaration and the
// `ctx.tokenMeter` / `ctx.treasury` Context declarations, respectively.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from './index.ts'
import type { BudgetCategory, CostDecision } from './haven.ts'
import { BUDGET_CATEGORIES } from './haven.ts'

/** Cordis plugin name. */
export const name = 'treasury-policy'

/**
 * Required services: the ledger it enforces, the registry whose pipeline it
 * gates, and the meter that prices requests.
 */
export const inject = ['treasury', 'tools', 'tokenMeter']

/** Thrown to short-circuit `agent/request` when the treasury denies inference. */
export class TreasuryDeniedError extends Error {
  override readonly name = 'TreasuryDeniedError'
  /** Stable machine-readable code. */
  readonly code = 'TREASURY_DENIED' as const
  /** The ledger's verdict. */
  readonly decision: CostDecision

  constructor(message: string, decision: CostDecision) {
    super(message)
    this.decision = decision
  }
}

/** Plugin configuration. */
export interface Config {
  /**
   * Price of one million tokens in µUSD — how request pressure converts to
   * inference cost. Required: there is no universally correct model price;
   * state your deployment's (e.g. `2000000` = $2.00 per 1M tokens).
   */
  inferenceUsdPerMillionTokens: number
  /**
   * Declared per-call cost in µUSD by tool-name pattern (`*` wildcards, e.g.
   * `"wallet_*": 50000`). First matching pattern wins.
   */
  toolCosts?: Record<string, number>
  /**
   * Budget category by tool-name pattern; a call matching no pattern accrues
   * against `tools`. First matching pattern wins.
   */
  toolCategories?: Record<string, BudgetCategory>
  /** Per-call cost for tools matching no `toolCosts` pattern. */
  defaultToolCostUsd?: number
  /** Tool-name patterns fully transparent to the gate (neither gated nor metered). */
  exemptTools?: string[]
}

export const Config: z<Config> = z.object({
  inferenceUsdPerMillionTokens: z.number().required(),
  toolCosts: z.dict(z.number()).default({}),
  toolCategories: z.dict(z.string()).default({}),
  defaultToolCostUsd: z.number().default(0),
  exemptTools: z.array(z.string()).default([]),
})

/** Compile one `*`-wildcard pattern to an anchored RegExp (other metacharacters match literally). */
function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

/** One compiled pattern → value rule. */
interface Rule<T> {
  readonly pattern: RegExp
  readonly value: T
}

/** First matching rule's value, else the fallback. */
function firstMatch<T>(rules: readonly Rule<T>[], toolName: string, fallback: T): T {
  for (const rule of rules) {
    if (rule.pattern.test(toolName)) return rule.value
  }
  return fallback
}

/** Validated config with patterns compiled and numbers checked, fail-loud. */
interface ResolvedPolicyConfig {
  readonly usdPerMillionTokens: number
  readonly toolCosts: readonly Rule<number>[]
  readonly toolCategories: readonly Rule<BudgetCategory>[]
  readonly defaultToolCostUsd: number
  readonly exempt: readonly RegExp[]
}

function resolvePolicyConfig(config: Config): ResolvedPolicyConfig {
  const usdPerMillionTokens = config.inferenceUsdPerMillionTokens
  if (!Number.isInteger(usdPerMillionTokens) || usdPerMillionTokens < 0) {
    throw new Error(
      `treasury-policy: inferenceUsdPerMillionTokens must be a non-negative integer (µUSD per 1M tokens), got ${usdPerMillionTokens}`,
    )
  }
  const toolCosts = Object.entries(config.toolCosts ?? {}).map(([pattern, value]) => {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`treasury-policy: toolCosts["${pattern}"] must be a non-negative integer (µUSD), got ${value}`)
    }
    return { pattern: wildcardToRegExp(pattern), value }
  })
  const toolCategories = Object.entries(config.toolCategories ?? {}).map(([pattern, value]) => {
    if (!BUDGET_CATEGORIES.includes(value)) {
      throw new Error(
        `treasury-policy: toolCategories["${pattern}"] names unknown category "${value}" `
        + `(known: ${BUDGET_CATEGORIES.join(', ')})`,
      )
    }
    return { pattern: wildcardToRegExp(pattern), value }
  })
  const defaultToolCostUsd = config.defaultToolCostUsd ?? 0
  if (!Number.isInteger(defaultToolCostUsd) || defaultToolCostUsd < 0) {
    throw new Error(`treasury-policy: defaultToolCostUsd must be a non-negative integer (µUSD), got ${defaultToolCostUsd}`)
  }
  return {
    usdPerMillionTokens,
    toolCosts,
    toolCategories,
    defaultToolCostUsd,
    exempt: (config.exemptTools ?? []).map(wildcardToRegExp),
  }
}

/**
 * Install the enforcement listeners.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolvePolicyConfig(config)

  /** Whether enforcement is live: the treasury has been funded at least once. */
  function funded(): boolean {
    return ctx.treasury.report().balances.length > 0
  }

  // ── inference: gate + meter at the request boundary ────────────────────────
  ctx.on('agent/request', async ({ agent }, next) => {
    // Price the pending request off the durable session tail: request
    // pressure (tokens the next call will carry) × the configured rate.
    const measurement = ctx.tokenMeter.measure(agent.session)
    const estimatedCostUsd = Math.ceil((measurement.totalTokens * resolved.usdPerMillionTokens) / 1_000_000)
    if (funded()) {
      const decision = ctx.treasury.authorize('inference', estimatedCostUsd)
      if (!decision.approved) {
        // Short-circuit: no next(), and a middleware throw fails the request
        // without recovery — the strongest halt this seam offers.
        throw new TreasuryDeniedError(`treasury denied inference: ${decision.reason}`, decision)
      }
    }
    const callConfig = await next()
    // Meter after every downstream middleware agreed the request proceeds.
    // Fail-closed on ledger errors: a survival engine never runs unmetered.
    if (estimatedCostUsd > 0) {
      await ctx.treasury.recordExpense({
        category: 'inference',
        amount: estimatedCostUsd,
        description: `model request (~${measurement.totalTokens} tokens)`,
      })
    }
    return callConfig
  })

  // ── tools: gate at pre-execute, meter at post-execute ──────────────────────
  /** Calls this policy admitted, awaiting settlement (keyed by registry-owned execution token). */
  const admitted = new Map<ToolExecutionToken, { category: BudgetCategory; costUsd: number; tool: string }>()

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (resolved.exempt.some(pattern => pattern.test(exec.name))) return next()
    const costUsd = firstMatch(resolved.toolCosts, exec.name, resolved.defaultToolCostUsd)
    // A zero-cost call is not a spend: the inference gate owns survival
    // halting, and gating free reads would brick a depleted agent's ability
    // to even look at its situation.
    if (costUsd === 0) return next()
    const category = firstMatch(resolved.toolCategories, exec.name, 'tools')
    if (funded()) {
      const decision = ctx.treasury.authorize(category, costUsd)
      if (!decision.approved) {
        // Short-circuit: no next(). The registry materializes the error
        // result, so denial holds for every caller that reaches the executor.
        return { kind: 'deny', reason: `treasury denied ${exec.name}: ${decision.reason}` }
      }
    }
    admitted.set(exec.token, { category, costUsd, tool: exec.name })
    return next()
  })

  ctx.on('tools/post-execute', async (exec, _result, next) => {
    const pending = admitted.get(exec.token)
    if (pending !== undefined) {
      admitted.delete(exec.token)
      // Observe-and-record at settlement; the declared cost is an estimate,
      // recorded whether the call succeeded or failed (the spend — gas, API
      // fee — is typically incurred either way).
      await ctx.treasury.recordExpense({
        category: pending.category,
        amount: pending.costUsd,
        description: `tool ${pending.tool}`,
      })
    }
    return next()
  })
}
