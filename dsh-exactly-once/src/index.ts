/**
 * Exactly-once guard for dsh write tools: `ctx.exactlyOnce` plus a
 * `tools/execute` wrapper, shaped after the timeout-policy and treasury
 * precedents.
 *
 * The guard is transparent and model-invisible — no tools, no parameters.
 * Write calls (the `writes` patterns) are deduped by `(agent, callId)`,
 * in-process repeats replay the recorded result, and exact repeats
 * after ambiguous outcomes consult per-tool read-back hooks registered
 * through `ctx.exactlyOnce.registerCheck` (with cold repeat evidence
 * folded from the session ledger). Everything else passes through with
 * zero tracking.
 *
 * @module dsh-exactly-once
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: carries the `agent/pre-step` event declaration (the repeat
// reset below) without a runtime dependency on the agent loop.
import type {} from '@deepseek-ai/dsh-agent'
import { ExactlyOnceRuntime } from './guard.ts'

export { ExactlyOnceRuntime } from './guard.ts'
export type { GuardOptions } from './guard.ts'
export { canonicalize } from './canonical.ts'
export type { CheckCommittedFn, CheckContext, CheckDecision, LastOutcome } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    exactlyOnce: ExactlyOnceRuntime
  }
}

/** Cordis plugin name. */
export const name = 'exactly-once'
/** The tool registry this plugin wraps. Agent sessions arrive on executions. */
export const inject = ['tools']

/**
 * Stack write tools guarded by default. `*_submit` covers the
 * configurable acquisition prefix (`toolPrefix` renames the pair).
 */
export const DEFAULT_WRITES: readonly string[] = [
  'synapse_pin',
  '*_submit',
  'arkiv_create_entity',
  'arkiv_update_entity',
  'erc8004_register',
  'rr_launch',
  'rr_sweep',
  'rr_heartbeat',
  'aol_decrypt',
]

/** Plugin configuration. */
export interface Config {
  /**
   * Tool-name `*`-wildcard patterns selecting the guarded writes.
   * Missing means the stack default; pass an explicit empty list plus
   * `exempt: ['*']` to mount the seam with no guarding.
   */
  writes?: string[]
  /** Tool-name patterns fully transparent to the guard (exempt wins). */
  exempt?: string[]
}

export const Config: z<Config> = z.object({
  writes: z.array(z.string()).default([...DEFAULT_WRITES]),
  exempt: z.array(z.string()).default([]),
})

/** Fully compiled configuration used by the runtime. */
export interface ResolvedConfig {
  readonly writes: readonly RegExp[]
  readonly exempt: readonly RegExp[]
}

/** Compile one `*`-wildcard pattern to an anchored RegExp (treasury rule). */
export function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

/**
 * Compile the write/exempt patterns; a missing list means the default.
 * @param config - validated plugin config.
 * @returns compiled patterns.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  return {
    writes: (config.writes ?? [...DEFAULT_WRITES]).map(wildcardToRegExp),
    exempt: (config.exempt ?? []).map(wildcardToRegExp),
  }
}

/**
 * Provide `ctx.exactlyOnce` and wrap `tools/execute`.
 * @param ctx - plugin context carrying `ctx.tools`.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const runtime = new ExactlyOnceRuntime({ writes: resolved.writes, exempt: resolved.exempt })
  ctx.provide('exactlyOnce', runtime)
  ctx.on('tools/execute', (exec, next) => runtime.wrap(exec, next))
  ctx.on('agent/pre-step', ({ agent, messages }, next) => {
    if (messages.some(message => message.source.kind === 'user')) runtime.resetAgent(agent)
    return next()
  })
}
