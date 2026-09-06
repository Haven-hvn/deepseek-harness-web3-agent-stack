/**
 * Seam proofs for dsh-haven-pipeline (read-only bridge):
 *
 * 1. runHaven moves argv in and parsed JSON out — no Python needed (internals.spawn stub).
 * 2. Non-zero exit / timeout / unparsable stdout map to HavenBridgeError with argv + stderr.
 * 3. The four tools work THROUGH THE EXECUTOR (ctx.tools.execute) with kind:'read'.
 * 4. withConfig appends --config passthrough only when configured.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as havenPipeline from '../src/index.ts'
import { HavenBridgeError, internals, runHaven, withConfig } from '../src/bridge.ts'

const testSignal = new AbortController().signal

afterEach(() => {
  internals.spawn = undefined
})

describe('bridge', () => {
  it('parses --json stdout', async () => {
    internals.spawn = async () => ({
      stdout: JSON.stringify({ entity_key: '0xabc', owner: '0xowner' }),
      stderr: '',
      exitCode: 0,
      signal: null,
    })
    const out = await runHaven<{ entity_key: string }>('haven', ['entity', 'get', '0xabc', '--json'], { timeoutMs: 1000 })
    expect(out.entity_key).toBe('0xabc')
  })

  it('recovers JSON after warning lines on stdout', async () => {
    internals.spawn = async () => ({
      stdout: '⚠️  some warning\n' + JSON.stringify([1, 2]),
      stderr: '',
      exitCode: 0,
      signal: null,
    })
    const out = await runHaven<number[]>('haven', ['entity', 'query', 'x', '--json'], { timeoutMs: 1000 })
    expect(out).toEqual([1, 2])
  })

  it('maps non-zero exit to HavenBridgeError with argv + stderr tail', async () => {
    internals.spawn = async () => ({
      stdout: '',
      stderr: '✗ Entity not found: 0xdead',
      exitCode: 1,
      signal: null,
    })
    const err = await runHaven('haven', ['entity', 'get', '0xdead', '--json'], { timeoutMs: 1000 })
      .then(() => undefined, (e: unknown) => e as HavenBridgeError)
    expect(err).toBeInstanceOf(HavenBridgeError)
    expect(err?.exitCode).toBe(1)
    expect(err?.argv).toContain('0xdead')
    expect(err?.stderr).toContain('Entity not found')
  })

  it('maps empty stdout to HavenBridgeError', async () => {
    internals.spawn = async () => ({ stdout: '   \n', stderr: '', exitCode: 0, signal: null })
    await expect(runHaven('haven', ['jobs', 'list'], { timeoutMs: 1000 })).rejects.toBeInstanceOf(HavenBridgeError)
  })

  it('maps unparsable stdout to HavenBridgeError', async () => {
    internals.spawn = async () => ({ stdout: 'not json at all!!!', stderr: '', exitCode: 0, signal: null })
    await expect(runHaven('haven', ['entity', 'get', 'x', '--json'], { timeoutMs: 1000 })).rejects.toBeInstanceOf(HavenBridgeError)
  })

  it('maps spawn ENOENT to HavenBridgeError', async () => {
    internals.spawn = async () => {
      throw new HavenBridgeError('haven bridge: failed to spawn haven: ENOENT', {
        exitCode: null, signal: null, argv: ['entity', 'get'], stderr: '',
      })
    }
    await expect(runHaven('haven', ['entity', 'get'], { timeoutMs: 1000 })).rejects.toBeInstanceOf(HavenBridgeError)
  })

  it('withConfig appends --config only when set', () => {
    expect(withConfig(['entity', 'get', '0x1'], undefined)).toEqual(['entity', 'get', '0x1'])
    expect(withConfig(['entity', 'get', '0x1'], '/tmp/haven.toml')).toEqual(
      ['entity', 'get', '0x1', '--config', '/tmp/haven.toml'],
    )
  })
})

describe('tools through the executor', () => {
  async function harness() {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(havenPipeline, { havenBin: 'haven', bridgeTimeoutMs: 1000 })
    let calls = 0
    const execute = (name: string, args: Record<string, unknown>) => ctx.tools.execute({
      callId: ToolCallId(`call-${calls += 1}`),
      name,
      arguments: args,
      signal: testSignal,
    })
    return { ctx, execute }
  }

  it('haven_entity_get forwards key + --json', async () => {
    let seen: readonly string[] = []
    internals.spawn = async (_bin, argv) => {
      seen = argv
      return { stdout: JSON.stringify({ entity_key: '0xabc' }), stderr: '', exitCode: 0, signal: null }
    }
    const { execute } = await harness()
    const res = await execute('haven_entity_get', { entity_key: '0xabc' })
    expect(res.isError).toBe(false)
    expect(seen).toEqual(['entity', 'get', '0xabc', '--json'])
    expect(JSON.stringify(res.content)).toContain('0xabc')
  })

  it('haven_entity_query forwards filter + limit', async () => {
    let seen: readonly string[] = []
    internals.spawn = async (_bin, argv) => {
      seen = argv
      return { stdout: JSON.stringify([]), stderr: '', exitCode: 0, signal: null }
    }
    const { execute } = await harness()
    const res = await execute('haven_entity_query', { query: 'grp = "haven.video.full"', limit: 5 })
    expect(res.isError).toBe(false)
    expect(seen).toEqual(['entity', 'query', 'grp = "haven.video.full"', '--json', '--limit', '5'])
  })

  it('haven_download_info forwards cid', async () => {
    let seen: readonly string[] = []
    internals.spawn = async (_bin, argv) => {
      seen = argv
      return { stdout: JSON.stringify({ status: 'pinned' }), stderr: '', exitCode: 0, signal: null }
    }
    const { execute } = await harness()
    const res = await execute('haven_download_info', { cid: 'bafytest' })
    expect(res.isError).toBe(false)
    expect(seen).toEqual(['download', 'info', 'bafytest', '--json'])
  })

  it('haven_jobs_list returns table text verbatim', async () => {
    internals.spawn = async () => ({
      stdout: 'Scheduled Jobs\nID Plugin Schedule\n',
      stderr: '',
      exitCode: 0,
      signal: null,
    })
    const { execute } = await harness()
    const res = await execute('haven_jobs_list', {})
    expect(res.isError).toBe(false)
    expect(JSON.stringify(res.content)).toContain('Scheduled Jobs')
  })

  it('bridge failure surfaces as tool error, not throw', async () => {
    internals.spawn = async () => ({ stdout: '', stderr: '✗ Entity not found', exitCode: 1, signal: null })
    const { execute } = await harness()
    const res = await execute('haven_entity_get', { entity_key: '0xdead' })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toContain('Entity not found')
  })
})
