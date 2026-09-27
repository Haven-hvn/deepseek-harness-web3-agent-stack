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
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as GuardPlugin from '../src/index.ts'
import { ExactlyOnceRuntime } from '../src/guard.ts'
import { canonicalize } from '../src/canonical.ts'

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
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(GuardPlugin, {
    ...(options.writes !== undefined ? { writes: options.writes } : {}),
    ...(options.exempt !== undefined ? { exempt: options.exempt } : {}),
  })
  for (const tool of options.tools ?? []) ctx.tools.register(tool)
  let n = 0
  const call = (name: string, args: unknown, callId?: string): Promise<ToolExecutionResult> =>
    ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId(callId ?? `c${String(++n)}`),
      name,
      arguments: args,
    })
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

// ── cold session replay (direct wrapper) ─────────────────────────────────────

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

function sessionWith(callId: string, outcome: { text: string; isError: boolean }): {
  seq: number
  snapshotEvents: () => unknown[]
} {
  const call = { seq: 1, type: 'tool/call', data: { turn: 0, step: 0, callId, name: 'w_write', arguments: { v: 'a' } } }
  const result = {
    seq: 2,
    type: 'tool/result',
    data: {
      turn: 0,
      step: 0,
      // Real ToolResultMessage shape: identity rides toolCallId/source,
      // never a bare message.callId.
      message: {
        toolCallId: callId,
        source: { kind: 'tool', callId },
        content: [{ type: 'text', text: outcome.text }],
        isError: outcome.isError,
      },
    },
  }
  return { seq: 2, snapshotEvents: () => [call, result] }
}

describe('cold session replay', () => {
  it('does not replay recorded successes: values are not durable', async () => {
    // Canonical values are deliberately omitted from durable events, and
    // the harness never re-dispatches a settled callId after restart
    // (repair closes dangling calls with synthetic errors instead), so a
    // cold success is evidence, not a replay — the call dispatches.
    const runtime = new ExactlyOnceRuntime({ writes: [/.*/], exempt: [] })
    const agent = { session: sessionWith('X', { text: 'recorded', isError: false }) }
    const next = vi.fn(async (): Promise<ToolExecutionResult> => ({ content: [{ type: 'text', text: 'fresh' }], isError: false, value: 'fresh' }))
    const result = await runtime.wrap(fakeExec({ callId: 'X', agent }), next)
    expect(textOf(result)).toBe('fresh')
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('replays cold hook values without dispatching', async () => {
    const runtime = new ExactlyOnceRuntime({ writes: [/.*/], exempt: [] })
    runtime.registerCheck('w_write', () => ({ kind: 'replay', value: 'cold:tx_9' }))
    const agent = { session: sessionWith('old', { text: 'Error: boom', isError: true }) }
    const next = vi.fn(async (): Promise<ToolExecutionResult> => ({ content: [{ type: 'text', text: 'fresh' }], isError: false, value: 'fresh' }))
    const result = await runtime.wrap(fakeExec({ callId: 'new', agent }), next)
    expect(next).not.toHaveBeenCalled()
    expect((result as { value?: unknown }).value).toBe('cold:tx_9')
  })

  it('never replays recorded errors', async () => {
    const runtime = new ExactlyOnceRuntime({ writes: [/.*/], exempt: [] })
    const agent = { session: sessionWith('X', { text: 'Error: boom', isError: true }) }
    const next = vi.fn(async (): Promise<ToolExecutionResult> => ({ content: [{ type: 'text', text: 'fresh' }], isError: false, value: 'fresh' }))
    const result = await runtime.wrap(fakeExec({ callId: 'X', agent }), next)
    expect(textOf(result)).toBe('fresh')
    expect(next).toHaveBeenCalledTimes(1)
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
    const runtime = new ExactlyOnceRuntime({ writes: [/.*/], exempt: [] })
    const hook = vi.fn(() => ({ kind: 'proceed' }) as const)
    runtime.registerCheck('w_write', hook)
    const agent = { session: sessionWith('old', { text: 'Error: boom', isError: true }) }
    const next = vi.fn(async (): Promise<ToolExecutionResult> => ({ content: [{ type: 'text', text: 'fresh' }], isError: false, value: 'fresh' }))
    await runtime.wrap(fakeExec({ callId: 'new', agent }), next)
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
    for (const name of ['synapse_pin', 'acquire_submit', 'dl_submit', 'arkiv_create_entity', 'erc8004_register', 'rr_launch', 'rr_sweep', 'rr_heartbeat', 'aol_decrypt']) {
      expect(guarded(name)).toBe(true)
    }
    expect(guarded('wallet_info')).toBe(false)
    expect(guarded('acquire_status')).toBe(false)
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
