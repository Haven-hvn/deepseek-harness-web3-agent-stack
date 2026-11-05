/**
 * The exactly-once wrapper (`ctx.exactlyOnce`): a `tools/execute`
 * around-guard for write tools, shaped after timeout-policy.
 *
 * Three mechanisms, all model-invisible:
 *
 * 1. **Redelivery dedup by call identity.** The agent loop assigns one
 *    `callId` per model call block, so the same call dispatched twice
 *    shares `(agent, rootCallId, callId)` while a model retry is a new
 *    block. A repeat of an in-flight call attaches to it; a repeat of a
 *    settled call replays the recorded result. The tool body runs once.
 * 2. **Session ledger repeat evidence.** Canonical values are
 *    deliberately omitted from durable events, so settled successes
 *    cannot rebuild from the log — and need not: the harness never
 *    re-dispatches a settled callId after restart (repair closes
 *    dangling calls with synthetic `TOOL_OUTCOME_UNKNOWN` /
 *    `TOOL_NOT_STARTED` errors instead). What survives a restart is the
 *    repeat question, answered by folding `tool/call` + `tool/result`
 *    pairs into last-outcome evidence per (agent, tool, arguments).
 * 3. **Repeat-after-ambiguous checks.** An exact `(agent, tool,
 *    canonical-args)` repeat following a non-success consults that
 *    tool's read-back hook when one is registered
 *    (`registerCheck`); without a hook the call dispatches and the
 *    attempt is recorded. Ambiguous errors (timeout, abort, unclassified
 *    throws — never validation errors, never denials, which bypass this
 *    stage) carry an attempt trailer so the model knows a retry of the
 *    exact call is ledger-checked first.
 *
 * Reads and unlisted tools pass straight through with zero tracking.
 *
 * @module dsh-exactly-once/guard
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { canonicalize } from './canonical.ts'
import type { CheckCommittedFn, LastOutcome } from './types.ts'

/**
 * Error codes whose effects may already have committed: a retry must be
 * checked, never blind. `undefined` (an unclassified throw, which carries
 * no structured identity) counts as ambiguous too. Classified tool and
 * validation failures (`INVALID_ARGS`, treasury denials, `ACQUIRE_*`)
 * are never stamped.
 */
const AMBIGUOUS_CODES = new Set(['TOOL_TIMEOUT', 'ABORTED', 'ABORTED_BEFORE_DISPATCH'])

/** Least session surface the cold path needs (structural: no session dep). */
interface SessionLike {
  readonly seq?: number
  snapshotEvents(): readonly unknown[]
}

/** Monotonic sequence number carried by one durable session event. */
function eventSeq(event: unknown): number | null {
  if (event === null || typeof event !== 'object') return null
  const seq = (event as { seq?: unknown }).seq
  return typeof seq === 'number' && Number.isFinite(seq) ? seq : null
}

/** Derived, mutable idempotency evidence for one session. */
interface ColdState {
  /** Call identities seen so far, keyed by session-local callId. */
  readonly calls: Map<string, { name: string; argsKey: string }>
  /** Last observed outcome per (agent, tool, canonical args). */
  readonly lastByIdentity: Map<string, LastOutcome>
  /** Last durable event sequence fully folded, or null when seq is unavailable. */
  cursorSeq: number | null
  /** Number of durable events folded so far (fallback when seq is unavailable). */
  processedCount: number
  /** Agent scope the index was built for. */
  agentPart: string
  /** Whether the index has been initialized. */
  built: boolean
}

/** Per-session cold state. Folds are synchronous and therefore atomic in JS. */
interface ColdEntry {
  state: ColdState
}

/** Options for {@link ExactlyOnceRuntime}. */
export interface GuardOptions {
  /** Compiled `*`-wildcard patterns selecting the guarded write tools. */
  readonly writes: readonly RegExp[]
  /** Compiled patterns fully transparent to the guard (neither deduped nor tracked). */
  readonly exempt: readonly RegExp[]
  /** Clock (tests pin this; production uses `Date.now`). */
  readonly now?: () => number
}

interface SettledEntry {
  readonly result: ToolExecutionResult
  readonly at: number
}

interface OutcomeEntry extends LastOutcome {
  readonly name: string
}

/** Lossless clone through JSON (results are lossless-JSON by contract). */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** The `ctx.exactlyOnce` seam: the wrapper plus the read-back registry. */
export class ExactlyOnceRuntime {
  private readonly writes: readonly RegExp[]
  private readonly exempt: readonly RegExp[]
  private readonly now: () => number
  private readonly checks = new Map<string, CheckCommittedFn>()
  private readonly inFlight = new Map<string, Promise<ToolExecutionResult>>()
  private readonly settled = new Map<string, SettledEntry>()
  private readonly outcomes = new Map<string, OutcomeEntry>()
  private readonly agentIds = new WeakMap<object, string>()
  private readonly cold = new WeakMap<object, ColdEntry>()
  private agentSeq = 0
  private attempts = 0

  constructor(options: GuardOptions) {
    this.writes = options.writes
    this.exempt = options.exempt
    this.now = options.now ?? Date.now
  }

  /** Whether a tool name is guarded (exempt wins over writes). */
  isWrite(name: string): boolean {
    if (this.exempt.some(pattern => pattern.test(name))) return false
    return this.writes.some(pattern => pattern.test(name))
  }

  /**
   * Register one tool's commit check, consulted before re-dispatching an
   * exact repeat that follows a non-success.
   * @param name - guarded tool name.
   * @param fn - the read-back hook.
   * @returns the disposer that unregisters the hook.
   */
  registerCheck(name: string, fn: CheckCommittedFn): () => void {
    this.checks.set(name, fn)
    return () => {
      if (this.checks.get(name) === fn) this.checks.delete(name)
    }
  }

  /**
   * Forget one agent's repeat chains. A user interjection starts a new
   * context; repetition across it is not a retry (repeat-tool-reminder
   * parity). In-flight and settled call records are untouched — redelivery
   * dedup must survive interjections.
   * @param agent - the agent scope whose chains reset.
   */
  resetAgent(agent: object): void {
    const id = this.agentIds.get(agent)
    if (id === undefined) return
    const prefix = `${id}|`
    for (const key of [...this.outcomes.keys()]) {
      if (key.startsWith(prefix)) this.outcomes.delete(key)
    }
  }

  /**
   * Guard one dispatch: attach, replay, check, or run.
   * @param exec - the pending write call (name, parsed arguments, caller agent).
   * @param next - the downstream pipeline (further wrappers, then the body).
   * @returns the dispatch outcome, possibly replayed without running the body.
   */
  async wrap(exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> {
    if (!this.isWrite(exec.name)) return next()
    const key = this.callKey(exec)
    const inflight = this.inFlight.get(key)
    if (inflight !== undefined) return inflight
    const prior = this.settled.get(key)
    if (prior !== undefined) return cloneJson(prior.result)
    const cold = this.scanSession(exec)
    const identity = this.identityKey(exec)
    const last = this.outcomes.get(identity) ?? cold?.lastByIdentity.get(identity)
    if (last !== undefined && last.isError) {
      const hook = this.checks.get(exec.name)
      if (hook !== undefined) {
        const decision = await hook({ args: exec.arguments, callId: String(exec.callId), lastOutcome: last })
        if (decision.kind === 'replay') {
          // The value rides back through registry normalization, which
          // validates it against the tool's output schema and renders it;
          // wrapper-authored content would be discarded there anyway.
          const replayed: ToolExecutionResult = {
            content: [],
            isError: false,
            value: cloneJson(decision.value) as Exclude<ToolExecutionResult['value'], undefined>,
          }
          this.settled.set(key, { result: cloneJson(replayed), at: this.now() })
          this.outcomes.set(identity, { name: exec.name, isError: false, code: undefined, at: this.now() })
          return replayed
        }
        // 'proceed' and 'unknown' both dispatch: liveness wins and the
        // attempt is recorded below for the next repeat.
      }
    }
    let resolveAttempt!: (result: ToolExecutionResult) => void
    let rejectAttempt!: (error: unknown) => void
    const attempt = new Promise<ToolExecutionResult>((resolve, reject) => {
      resolveAttempt = resolve
      rejectAttempt = reject
    })
    // An unwaited rejection must never surface as unhandled: waiters attach
    // by awaiting the same promise, which remains legal alongside this sink.
    void attempt.catch(() => undefined)
    this.inFlight.set(key, attempt)
    try {
      const result = await next()
      const stamped = this.maybeStamp(result)
      this.settled.set(key, { result: cloneJson(stamped), at: this.now() })
      this.outcomes.set(identity, {
        name: exec.name,
        isError: stamped.isError,
        code: stamped.error?.info?.code,
        at: this.now(),
      })
      resolveAttempt(stamped)
      return stamped
    } catch (error: unknown) {
      this.outcomes.set(identity, { name: exec.name, isError: true, code: undefined, at: this.now() })
      rejectAttempt(error)
      throw error
    } finally {
      this.inFlight.delete(key)
    }
  }

  /** Stable per-agent scope tag (`-` for agentless direct callers). */
  private agentPart(agent: unknown): string {
    if (agent === null || (typeof agent !== 'object' && typeof agent !== 'function')) return '-'
    const scope = agent as object
    let id = this.agentIds.get(scope)
    if (id === undefined) {
      this.agentSeq += 1
      id = `a${this.agentSeq}`
      this.agentIds.set(scope, id)
    }
    return id
  }

  /** One model call block: shared by redeliveries, fresh on model retries. */
  private callKey(exec: ToolDispatchExecution): string {
    return `${this.agentPart(exec.agent)}|${String(exec.rootCallId)}|${String(exec.callId)}`
  }

  /** One retry identity: same agent, tool, and canonical arguments. */
  private identityKey(exec: ToolDispatchExecution): string {
    return `${this.agentPart(exec.agent)}|${exec.name}|${canonicalize(exec.arguments)}`
  }

  /**
   * Stamp ambiguous write errors with an attempt trailer so a retrying
   * model knows the exact call is ledger-checked first. Successes and
   * classified failures pass through byte-identical.
   */
  private maybeStamp(result: ToolExecutionResult): ToolExecutionResult {
    if (!result.isError) return result
    const code = result.error?.info?.code
    if (code !== undefined && !AMBIGUOUS_CODES.has(code)) return result
    this.attempts += 1
    const trailer: ContentBlock = {
      type: 'text',
      text: `[exactly-once attempt eo_${this.attempts}: effect state unknown — retrying this exact call is checked against the attempt ledger before re-dispatch.]`,
    }
    return { ...result, content: [...result.content, trailer] }
  }

  /**
   * Fold durable session events into cold repeat evidence incrementally.
   *
   * The session event log is the source of truth. The cold index is only a
   * derived cache, so it is initialized once and then extended with events
   * appended after its cursor. A full rebuild happens on first access, after
   * a restart (empty cache), on cache eviction, or when the cursor no longer
   * aligns with the append-only event log.
   */
  private scanSession(exec: ToolDispatchExecution): ColdState | undefined {
    const holder = exec.agent as unknown as { session?: unknown } | undefined
    const session = holder?.session as SessionLike | undefined
    if (session === null || session === undefined || typeof session.snapshotEvents !== 'function') return undefined
    const sessionObj = session as unknown as object
    const entry = this.ensureColdEntry(sessionObj)
    const agentPart = this.agentPart(exec.agent)
    const events = session.snapshotEvents()
    const state = entry.state

    // A different agent scope means the identity keys would change; rebuild.
    if (state.built && state.agentPart !== '' && state.agentPart !== agentPart) {
      this.resetColdState(state)
    }

    // Validate the append-only cursor. Any mismatch or shrinkage forces a
    // full rebuild instead of trusting a stale or misaligned index.
    if (state.built) {
      const prefixAligned =
        state.processedCount <= events.length &&
        (state.cursorSeq === null ||
          events.slice(0, state.processedCount).every(event => {
            const seq = eventSeq(event)
            return seq === null || seq <= state.cursorSeq!
          }))
      if (!prefixAligned) this.resetColdState(state)
    }

    let toProcess: readonly unknown[]
    if (!state.built) {
      toProcess = events
      this.resetColdState(state)
    } else if (state.cursorSeq !== null) {
      toProcess = events.filter(event => {
        const seq = eventSeq(event)
        return seq !== null && seq > state.cursorSeq!
      })
    } else {
      toProcess = events.slice(state.processedCount)
    }

    // Fold only the unprocessed suffix. Preserve input order unless every
    // new event carries a sequence number, in which case fold in seq order.
    const allHaveSeq = toProcess.length > 0 && toProcess.every(event => eventSeq(event) !== null)
    const ordered = allHaveSeq
      ? [...toProcess].sort((a, b) => eventSeq(a)! - eventSeq(b)!)
      : [...toProcess]
    if (ordered.length > 0) {
      state.agentPart = agentPart
      foldColdEvents(ordered, state)
    } else if (state.agentPart === '') {
      state.agentPart = agentPart
    }

    state.processedCount = events.length
    if (ordered.length > 0) {
      const lastSeq = eventSeq(ordered[ordered.length - 1])
      if (lastSeq !== null) state.cursorSeq = lastSeq
    } else if (events.length > 0) {
      const lastSeq = eventSeq(events[events.length - 1])
      if (lastSeq !== null && (state.cursorSeq === null || lastSeq > state.cursorSeq)) {
        state.cursorSeq = lastSeq
      }
    }
    state.built = true
    return entry.state
  }

  private ensureColdEntry(sessionObj: object): ColdEntry {
    let entry = this.cold.get(sessionObj)
    if (entry === undefined) {
      entry = {
        state: {
          calls: new Map(),
          lastByIdentity: new Map(),
          cursorSeq: null,
          processedCount: 0,
          agentPart: '',
          built: false,
        },
      }
      this.cold.set(sessionObj, entry)
    }
    return entry
  }

  private resetColdState(state: ColdState): void {
    state.calls.clear()
    state.lastByIdentity.clear()
    state.cursorSeq = null
    state.processedCount = 0
    state.agentPart = ''
    state.built = false
  }
}

/**
 * Fold `tool/call` + `tool/result` events into last-outcome evidence per
 * retry identity. Result identity reads `toolCallId` (falling back to
 * `source.callId`, the repair-closer path) — the loop never stores a bare
 * `message.callId`.
 *
 * Synthetic repair results (`TOOL_NOT_STARTED`, `TOOL_OUTCOME_UNKNOWN`) are
 * folded like any other `tool/result`, preserving the existing behavior.
 */
function foldColdEvents(events: readonly unknown[], state: ColdState): void {
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const record = event as { type?: unknown; data?: unknown }
    if (record.data === null || typeof record.data !== 'object') continue
    const data = record.data as Record<string, unknown>
    if (record.type === 'tool/call') {
      if (typeof data['callId'] === 'string' && typeof data['name'] === 'string') {
        state.calls.set(data['callId'], {
          name: data['name'],
          argsKey: canonicalize(data['arguments']),
        })
      }
    } else if (record.type === 'tool/result') {
      const message = data['message']
      if (message === null || typeof message !== 'object') continue
      const result = message as Record<string, unknown>
      const source = result['source']
      const sourceCallId =
        source !== null && typeof source === 'object'
          ? (source as Record<string, unknown>)['callId']
          : undefined
      const callId =
        typeof result['toolCallId'] === 'string'
          ? result['toolCallId']
          : typeof sourceCallId === 'string'
            ? sourceCallId
            : undefined
      if (callId === undefined) continue
      const call = state.calls.get(callId)
      if (call === undefined) continue
      const info = data['error'] as { code?: unknown } | null
      state.lastByIdentity.set(`${state.agentPart}|${call.name}|${call.argsKey}`, {
        isError: result['isError'] === true,
        code: typeof info?.code === 'string' ? info.code : undefined,
        at: 0,
      })
    }
  }
}
