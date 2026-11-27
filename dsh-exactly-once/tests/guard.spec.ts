/**
 * Exactly-once guard proofs: redelivery dedup, session-ledger replay, and
 * repeat-after-ambiguous checks.
 *
 * Registry-owned behavior (dedup, replay, transparency) is proven through
 * the real executor; cold-session behavior runs the wrapper directly with
 * fabricated session events, since only the agent loop appends those.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as GuardPlugin from '../src/index.ts'
import { ExactlyOnceRuntime } from '../src/guard.ts'
import { canonicalize } from '../src/canonical.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Non-user producer kind for interjection-reset coverage. */
    'exactly-once-test': { kind: 'exactly-once-test' }
  }
}

interface BodyControl {
  calls: unknown[]
  gate?: () => Promise<void>
  fail?: (call: unknown) => Error | undefined
  result?: (call: unknown) => string
}

function writeTool(name: string, control: BodyControl) {
  return defineTool({
    name,
    description: `${name} test write`,
    parameters: { v: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      control.calls.push(args)
      if (control.gate !== undefined) await control.gate()
      const error = control.fail?.(args)
      if (error !== undefined) throw error
      return control.result?.(args) ?? `ok:${args.v}`
    },
  })
}

async function mount(options: {
  writes?: string[]
  exempt?: string[]
  tools?: Array<ReturnType<typeof writeTool>>
}): Promise<{
  ctx: Context
  call: (name: string, args: unknown, callId?: string) => Promise<ToolExecutionResult>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(GuardPlugin, {
    ...(options.writes !== undefined ? { writes: options.writes } : {}),
    ...(options.exempt !== undefined ? { exempt: options.exempt } : {}),
  })
  for (const tool of options.tools ?? []) ctx.tools.register(tool)
  let n = 0
  const call = async (name: string, args: unknown, callId?: string): Promise<ToolExecutionResult> => {
    const batch = await ctx.tools.execute({
      signal: new AbortController().signal,
      calls: [{ type: 'tool-call', id: ToolCallId(callId ?? `c${String(++n)}`), name, arguments: JSON.stringify(args) }],
    })
    return batch.results[0]!.result
  }
  return { ctx, call }
}

function textOf(result: ToolExecutionResult): string {
  return result.content.map(block => {
    const text = (block as { text?: unknown }).text
    return typeof text === 'string' ? text : '[block]'
  }).join('')
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

// ── transparency ─────────────────────────────────────────────────────────────

describe('transparency', () => {
  it('passes unlisted tools through with zero tracking', async () => {
    const write = { calls: [] as unknown[] }
    const read = { calls: [] as unknown[] }
    const { call } = await mount({ writes: ['w_write'], tools: [writeTool('w_write', write), writeTool('r_read', read)] })
    await call('r_read', { v: 'a' }, 'same')
    await call('r_read', { v: 'a' }, 'same')
    expect(read.calls).toHaveLength(2)
    expect(write.calls).toHaveLength(0)
  })

  it('leaves read errors unstamped', async () => {
    const read = { calls: [] as unknown[], fail: () => new Error('nope') }
    const { call } = await mount({ writes: ['w_write'], tools: [writeTool('r_read', read)] })
    const result = await call('r_read', { v: 'a' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('nope')
    expect(textOf(result)).not.toContain('exactly-once')
  })

  it('lets exempt win over writes', async () => {
    const write = { calls: [] as unknown[] }
    const { call } = await mount({ writes: ['w_*'], exempt: ['w_write'], tools: [writeTool('w_write', write)] })
    await call('w_write', { v: 'a' }, 'same')
    await call('w_write', { v: 'a' }, 'same')
    expect(write.calls).toHaveLength(2)
  })
})

// ── redelivery through the executor ──────────────────────────────────────────

describe('redelivery through the executor', () => {
  it('runs the body once for concurrent redeliveries of one call', async () => {
    const gate = deferred()
    const write = { calls: [] as unknown[], gate: () => gate.promise }
    const { call } = await mount({ writes: ['w_write'], tools: [writeTool('w_write', write)] })
    const first = call('w_write', { v: 'a' }, 'same')
    const second = call('w_write', { v: 'a' }, 'same')
    await new Promise(done => setTimeout(done, 25))
    gate.resolve()
    const [r1, r2] = await Promise.all([first, second])
    expect(write.calls).toHaveLength(1)
    expect(textOf(r1)).toBe('ok:a')
    expect(textOf(r2)).toBe('ok:a')
  })

  it('replays the recorded result for sequential redeliveries', async () => {
    const write = { calls: [] as unknown[] }
    const { call } = await mount({ writes: ['w_write'], tools: [writeTool('w_write', write)] })
    expect(textOf(await call('w_write', { v: 'a' }, 'same'))).toBe('ok:a')
    expect(textOf(await call('w_write', { v: 'a' }, 'same'))).toBe('ok:a')
    expect(write.calls).toHaveLength(1)
  })

  it('dispatches distinct callIds independently, even after success', async () => {
    const write = { calls: [] as unknown[] }
    const { call } = await mount({ writes: ['w_write'], tools: [writeTool('w_write', write)] })
    expect(textOf(await call('w_write', { v: 'a' }, 'one'))).toBe('ok:a')
    // Same args, new call, previous success: a fresh intent, not a retry.
    expect(textOf(await call('w_write', { v: 'a' }, 'two'))).toBe('ok:a')
    expect(write.calls).toHaveLength(2)
  })
})

// ── repeat after ambiguous ───────────────────────────────────────────────────

describe('repeat after ambiguous', () => {
  it('re-dispatches when no hook is registered, stamping the error', async () => {
    const write: BodyControl = { calls: [] }
    write.fail = () => (write.calls.length === 1 ? new Error('boom') : undefined)
    const { call } = await mount({ writes: ['w_write'], tools: [writeTool('w_write', write)] })
    const failed = await call('w_write', { v: 'a' }, 'one')
    expect(failed.isError).toBe(true)
    expect(textOf(failed)).toContain('boom')
    expect(textOf(failed)).toContain('exactly-once attempt eo_1')
    const retried = await call('w_write', { v: 'a' }, 'two')
    expect(retried.isError).toBe(false)
    expect(write.calls).toHaveLength(2)
  })

  it('never stamps classified validation errors', async () => {
    const write = { calls: [] as unknown[] }
    const { call } = await mount({ writes: ['w_write'], tools: [writeTool('w_write', write)] })
    const result = await call('w_write', {})
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('invalid arguments')
    expect(textOf(result)).not.toContain('exactly-once')
  })

  it('replays a hook verdict instead of re-dispatching', async () => {
    const write: BodyControl = { calls: [] }
    write.fail = () => (write.calls.length === 1 ? new Error('timeout after broadcast') : undefined)
    const { ctx, call } = await mount({ writes: ['w_write'], tools: [writeTool('w_write', write)] })
    ctx.exactlyOnce.registerCheck('w_write', () => ({ kind: 'replay', value: 'recovered:tx_1' }))
    expect((await call('w_write', { v: 'a' }, 'one')).isError).toBe(true)
    const retried = await call('w_write', { v: 'a' }, 'two')
    expect(retried.isError).toBe(false)
    expect(textOf(retried)).toBe('recovered:tx_1')
    expect(write.calls).toHaveLength(1)
    // The replay resolved the ambiguity: the next identical call dispatches.
    expect(textOf(await call('w_write', { v: 'a' }, 'three'))).toBe('ok:a')
    expect(write.calls).toHaveLength(2)
  })

  it('fails loud when a hook replays a schema-violating value', async () => {
    const write: BodyControl = { calls: [] }
    write.fail = () => (write.calls.length === 1 ? new Error('boom') : undefined)
    const { ctx, call } = await mount({ writes: ['w_write'], tools: [writeTool('w_write', write)] })
    ctx.exactlyOnce.registerCheck('w_write', () => ({ kind: 'replay', value: 42 }))
    expect((await call('w_write', { v: 'a' }, 'one')).isError).toBe(true)
    // The stub output schema wants a string: the registry rejects the
    // hook's number instead of rendering garbage.
    expect((await call('w_write', { v: 'a' }, 'two')).isError).toBe(true)
    expect(write.calls).toHaveLength(1)
  })

  it('dispatches on proceed and unknown verdicts (liveness wins)', async () => {
    for (const kind of ['proceed', 'unknown'] as const) {
      const write: BodyControl = { calls: [] }
      write.fail = () => (write.calls.length === 1 ? new Error('boom') : undefined)
      const { ctx, call } = await mount({ writes: ['w_write'], tools: [writeTool('w_write', write)] })
      ctx.exactlyOnce.registerCheck('w_write', () => ({ kind }) as never)
      expect((await call('w_write', { v: 'a' }, 'one')).isError).toBe(true)
      const retried = await call('w_write', { v: 'a' }, 'two')
      expect(retried.isError).toBe(false)
      expect(write.calls).toHaveLength(2)
    }
  })
})

// ── cold session replay (projection-backed) ────────────────────────────────

function fakeExec(over: {
  callId: string
  rootCallId?: string
  name?: string
  args?: unknown
  agent?: unknown
}): ToolDispatchExecution {
  return {
    callId: over.callId,
    rootCallId: over.rootCallId ?? over.callId,
    name: over.name ?? 'w_write',
    arguments: over.args ?? { v: 'a' },
    signal: new AbortController().signal,
    ...(over.agent !== undefined ? { agent: over.agent } : {}),
  } as unknown as ToolDispatchExecution
}

/** Append one settled write call exactly as the tool batch logs it. */
function recordWrite(
  session: Session,
  callId: string,
  outcome: { text: string; isError: boolean; code?: string },
): void {
  session.append('tool/call', {
    turn: 0,
    step: 0,
    callId: ToolCallId(callId),
    name: 'w_write',
    arguments: JSON.stringify({ v: 'a' }),
  })
  session.append('tool/result', {
    turn: 0,
    step: 0,
    message: createToolResultMessage({
      callId: ToolCallId(callId),
      content: [{ type: 'text', text: outcome.text }],
      isError: outcome.isError,
    }),
    ...(outcome.code !== undefined ? { error: { name: 'Error', code: outcome.code } } : {}),
  }, { surfaceOp: 'append' })
}

function appendUserMessage(session: Session, kind: 'user' | 'exactly-once-test'): void {
  const source = kind === 'user'
    ? { kind: 'user' as const }
    : { kind: 'exactly-once-test' as const }
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'hi' }],
    source,
  }), { surfaceOp: 'append' })
}

const freshResult = async (): Promise<ToolExecutionResult> => ({
  content: [{ type: 'text', text: 'fresh' }],
  isError: false,
  value: 'fresh',
})

describe('cold session replay', () => {
  it('does not replay recorded successes: values are not durable', async () => {
    // Canonical values are deliberately omitted from durable events, and
    // the harness never re-dispatches a settled callId after restart
    // (repair closes dangling calls with synthetic errors instead), so a
    // cold success is evidence, not a replay — the call dispatches.
    const { ctx } = await mount({ writes: ['w_write'] })
    const session = ctx.sessions.create()
    recordWrite(session, 'X', { text: 'recorded', isError: false })
    const next = vi.fn(freshResult)
    const result = await ctx.exactlyOnce.wrap(fakeExec({ callId: 'X', agent: { session } }), next)
    expect(textOf(result)).toBe('fresh')
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('replays cold hook values without dispatching', async () => {
    const { ctx } = await mount({ writes: ['w_write'] })
    const session = ctx.sessions.create()
    recordWrite(session, 'old', { text: 'Error: boom', isError: true })
    ctx.exactlyOnce.registerCheck('w_write', () => ({ kind: 'replay', value: 'cold:tx_9' }))
    const next = vi.fn(freshResult)
    const result = await ctx.exactlyOnce.wrap(fakeExec({ callId: 'new', agent: { session } }), next)
    expect(next).not.toHaveBeenCalled()
    expect((result as { value?: unknown }).value).toBe('cold:tx_9')
  })

  it('never replays recorded errors', async () => {
    const { ctx } = await mount({ writes: ['w_write'] })
    const session = ctx.sessions.create()
    recordWrite(session, 'X', { text: 'Error: boom', isError: true })
    const next = vi.fn(freshResult)
    const result = await ctx.exactlyOnce.wrap(fakeExec({ callId: 'X', agent: { session } }), next)
    expect(textOf(result)).toBe('fresh')
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('matches retry identity across the raw-JSON arguments boundary', async () => {
    // `tool/call` persists the model's raw JSON string; dispatch parses it
    // before the wrapper sees `exec.arguments`. The projection parses the
    // same way, so a post-restart repeat of `{ v: 'a' }` finds the error.
    const { ctx } = await mount({ writes: ['w_write'] })
    const session = ctx.sessions.create()
    recordWrite(session, 'old', { text: 'Error: boom', isError: true, code: 'TOOL_TIMEOUT' })
    const hook = vi.fn(() => ({ kind: 'proceed' }) as const)
    ctx.exactlyOnce.registerCheck('w_write', hook)
    await ctx.exactlyOnce.wrap(fakeExec({ callId: 'new', agent: { session } }), vi.fn(freshResult))
    expect(hook).toHaveBeenCalledTimes(1)
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({
      lastOutcome: expect.objectContaining({ isError: true, code: 'TOOL_TIMEOUT' }),
    }))
  })

  it('clears cold evidence on a user interjection', async () => {
    const { ctx } = await mount({ writes: ['w_write'] })
    const session = ctx.sessions.create()
    recordWrite(session, 'old', { text: 'Error: boom', isError: true })
    appendUserMessage(session, 'user')
    const hook = vi.fn(() => ({ kind: 'proceed' }) as const)
    ctx.exactlyOnce.registerCheck('w_write', hook)
    await ctx.exactlyOnce.wrap(fakeExec({ callId: 'new', agent: { session } }), vi.fn(freshResult))
    expect(hook).not.toHaveBeenCalled()
  })

  it('keeps cold evidence across non-user user/messages', async () => {
    // Compaction checkpoints and injected context are user-role messages
    // with producer kinds other than `user`; they are not interjections.
    const { ctx } = await mount({ writes: ['w_write'] })
    const session = ctx.sessions.create()
    recordWrite(session, 'old', { text: 'Error: boom', isError: true })
    appendUserMessage(session, 'exactly-once-test')
    const hook = vi.fn(() => ({ kind: 'proceed' }) as const)
    ctx.exactlyOnce.registerCheck('w_write', hook)
    await ctx.exactlyOnce.wrap(fakeExec({ callId: 'new', agent: { session } }), vi.fn(freshResult))
    expect(hook).toHaveBeenCalledTimes(1)
  })

  it('keys nested calls on rootCallId', async () => {
    const runtime = new ExactlyOnceRuntime({ writes: [/.*/], exempt: [] })
    const next = vi.fn(async (): Promise<ToolExecutionResult> => ({ content: [{ type: 'text', text: 'fresh' }], isError: false, value: 'fresh' }))
    await runtime.wrap(fakeExec({ callId: 'sub', rootCallId: 'r1' }), next)
    await runtime.wrap(fakeExec({ callId: 'sub', rootCallId: 'r2' }), next)
    expect(next).toHaveBeenCalledTimes(2)
    await runtime.wrap(fakeExec({ callId: 'sub', rootCallId: 'r1' }), next)
    expect(next).toHaveBeenCalledTimes(2)
  })

  it('scopes call identity per agent', async () => {
    const runtime = new ExactlyOnceRuntime({ writes: [/.*/], exempt: [] })
    const next = vi.fn(async (): Promise<ToolExecutionResult> => ({ content: [{ type: 'text', text: 'fresh' }], isError: false, value: 'fresh' }))
    await runtime.wrap(fakeExec({ callId: 'X', agent: {} }), next)
    await runtime.wrap(fakeExec({ callId: 'X', agent: {} }), next)
    expect(next).toHaveBeenCalledTimes(2)
  })

  it('consults cold repeat evidence through hooks', async () => {
    const { ctx } = await mount({ writes: ['w_write'] })
    const session = ctx.sessions.create()
    recordWrite(session, 'old', { text: 'Error: boom', isError: true })
    const hook = vi.fn(() => ({ kind: 'proceed' }) as const)
    ctx.exactlyOnce.registerCheck('w_write', hook)
    const next = vi.fn(freshResult)
    await ctx.exactlyOnce.wrap(fakeExec({ callId: 'new', agent: { session } }), next)
    expect(hook).toHaveBeenCalledTimes(1)
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ callId: 'new' }))
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('resetAgent clears repeat chains', async () => {
    const runtime = new ExactlyOnceRuntime({ writes: [/.*/], exempt: [] })
    const hook = vi.fn(() => ({ kind: 'proceed' }) as const)
    runtime.registerCheck('w_write', hook)
    const agent = {}
    const failing = vi.fn(async (): Promise<ToolExecutionResult> => ({
      content: [{ type: 'text', text: 'Error: boom' }],
      isError: true,
      error: { message: 'boom' },
    }))
    await runtime.wrap(fakeExec({ callId: 'one', agent }), failing)
    await runtime.wrap(fakeExec({ callId: 'two', agent }), failing)
    expect(hook).toHaveBeenCalledTimes(1)
    runtime.resetAgent(agent)
    await runtime.wrap(fakeExec({ callId: 'three', agent }), failing)
    expect(hook).toHaveBeenCalledTimes(1)
  })
})

// ── config ───────────────────────────────────────────────────────────────────

describe('config', () => {
  it('guards the stack writes by default', () => {
    const resolved = GuardPlugin.resolveConfig({})
    const guarded = (name: string): boolean =>
      resolved.writes.some(pattern => pattern.test(name))
    for (const name of ['synapse_pin', 'synapse_fund', 'acquire_submit', 'dl_submit', 'arkiv_create_entity', 'arkiv_create_entities', 'arkiv_update_entity', 'erc8004_register', 'rr_launch', 'rr_sweep', 'rr_heartbeat', 'aol_decrypt']) {
      expect(guarded(name)).toBe(true)
    }
    expect(guarded('wallet_info')).toBe(false)
    expect(guarded('acquire_status')).toBe(false)
    expect(guarded('synapse_payment_status')).toBe(false)
  })

  it('lets explicit writes replace the default', () => {
    const resolved = GuardPlugin.resolveConfig({ writes: ['custom_write'] })
    expect(resolved.writes.some(pattern => pattern.test('custom_write'))).toBe(true)
    expect(resolved.writes.some(pattern => pattern.test('synapse_pin'))).toBe(false)
  })

  it('canonicalizes arguments regardless of property order', () => {
    expect(canonicalize({ b: 1, a: { y: 2, x: 1 } })).toBe(canonicalize({ a: { x: 1, y: 2 }, b: 1 }))
    expect(canonicalize({ a: 1 })).not.toBe(canonicalize({ a: 2 }))
  })
})
