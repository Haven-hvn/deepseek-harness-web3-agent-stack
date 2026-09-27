/**
 * Exactly-once guard vocabulary: the read-back hook contract shared by the
 * wrapper (this package) and the write tools that register hooks through
 * the `ctx.exactlyOnce` seam.
 *
 * Hooks live in a side registry, not on `ToolDefinition`: `defineTool`
 * builds a fresh definition object with known fields only, so extra
 * properties would be dropped. Tools register with optional chaining so
 * they mount cleanly where the guard is absent:
 * `ctx.effect(() => ctx.exactlyOnce?.registerCheck(name, fn) ?? noop)`.
 *
 * @module dsh-exactly-once/types
 */

/** Last settled outcome of one (agent, tool, canonical-args) identity. */
export interface LastOutcome {
  readonly isError: boolean
  readonly code: string | undefined
  readonly at: number
}

/**
 * Read-back verdict for a repeat-after-ambiguous write.
 *
 * - `replay` — the effect already committed; the registry validates
 *   `value` against the tool's output schema and renders it, exactly as
 *   if the body had returned it. A value that violates the schema fails
 *   loud as a tool-output error (a hook bug, never silent).
 * - `proceed` — proven not committed; dispatch normally.
 * - `unknown` — the read-back could not tell (e.g. RPC down); the wrapper
 *   dispatches to preserve liveness and records the attempt.
 */
export type CheckDecision =
  | { kind: 'replay'; value: unknown }
  | { kind: 'proceed' }
  | { kind: 'unknown'; reason?: string }

/** Evidence handed to a read-back hook. */
export interface CheckContext {
  readonly args: unknown
  readonly callId: string
  readonly lastOutcome: LastOutcome
}

/** Per-tool commit check consulted before re-dispatching an ambiguous repeat. */
export type CheckCommittedFn = (ctx: CheckContext) => Promise<CheckDecision> | CheckDecision
