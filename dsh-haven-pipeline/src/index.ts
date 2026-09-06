/**
 * dsh-haven-pipeline — read-only Haven CLI bridge.
 *
 * Four model-facing tools over a thin subprocess bridge (`haven ... --json`):
 * entity get / entity query / download info / jobs list. All are free reads
 * (`presentCall: {kind:'read'}`) — no signing, no spending, no treasury.
 *
 * Writes are deliberately absent. `upload file`, `download cid`, `jobs run`
 * need key material today (HAVEN_PRIVATE_KEY → NamedAccount.from_private_key)
 * and port natively to ctx.wallet + ctx.synapse + ctx.arkiv in a later phase
 * (viem toAccount delegating to OWS, same pattern as dsh-storage-synapse).
 * Bridging them via subprocess would put a raw key in the child env.
 *
 * @module dsh-haven-pipeline
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { runHaven, withConfig } from './bridge.ts'

export { HavenBridgeError, internals, runHaven, withConfig } from './bridge.ts'

/** Cordis plugin name. */
export const name = 'haven-pipeline'
/** Only the tool registry. No wallet (nothing signs), no treasury (reads are free). */
export const inject = ['tools'] as const

/** Plugin configuration — binary location and spawn bounds only. No secrets. */
export interface Config {
  /** Haven binary (PATH name or absolute path, e.g. venv bin). */
  readonly havenBin?: string
  /** Optional --config passthrough for every call. */
  readonly configFile?: string
  /** Per-call spawn timeout in ms. */
  readonly bridgeTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  havenBin: z.string().default('haven'),
  configFile: z.string(),
  bridgeTimeoutMs: z.number().default(60_000),
})

interface BridgeOpts {
  bin: string
  configFile?: string
  timeoutMs: number
}

function renderJson(value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * Register the four read-only bridge tools.
 * @param ctx - Plugin context carrying the tool registry.
 * @param config - Validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const opts: BridgeOpts = {
    bin: config.havenBin ?? 'haven',
    ...(config.configFile !== undefined ? { configFile: config.configFile } : {}),
    timeoutMs: config.bridgeTimeoutMs ?? 60_000,
  }

  const signalOf = (exec: unknown): AbortSignal | undefined =>
    (exec as { signal?: AbortSignal } | undefined)?.signal

  // ── haven entity get ──────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'haven_entity_get',
    description:
      'Get a Haven Arkiv entity by key. Read-only: queries the Arkiv chain and returns payload, attributes, and metadata as JSON. Use to verify uploads or inspect a record.',
    parameters: {
      entity_key: { type: 'string', required: true, description: 'Arkiv entity key (0x...).' },
      raw: { type: 'boolean', description: 'Return raw payload bytes without JSON parsing.' },
    },
    output: { schema: { type: 'object', additionalProperties: true } as never, render: (_a, v) => renderJson(v) as never },
    execute: async (args: { entity_key: string; raw?: boolean }, exec): Promise<unknown> => {
      const argv = withConfig(
        ['entity', 'get', args.entity_key, '--json', ...(args.raw === true ? ['--raw'] : [])],
        opts.configFile,
      )
      return runHaven(opts.bin, argv, { timeoutMs: opts.timeoutMs, signal: signalOf(exec) })
    },
    presentCall: args => ({ card: 'generic', title: `Haven entity ${args.entity_key}`, kind: 'read' }),
  })))

  // ── haven entity query ────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'haven_entity_query',
    description:
      'Query Haven Arkiv entities by attribute filter. Read-only. Filter syntax examples: \'sha256_ct = "abc123..."\', \'title = "My Video"\', \'grp = "haven.video.full"\'.',
    parameters: {
      query: { type: 'string', required: true, description: 'Arkiv query string.' },
      limit: { type: 'number', description: 'Max results (default 10).' },
    },
    output: { schema: { type: 'object', additionalProperties: true } as never, render: (_a, v) => renderJson(v) as never },
    execute: async (args: { query: string; limit?: number }, exec): Promise<unknown> => {
      const argv = withConfig(
        ['entity', 'query', args.query, '--json', '--limit', String(args.limit ?? 10)],
        opts.configFile,
      )
      return runHaven(opts.bin, argv, { timeoutMs: opts.timeoutMs, signal: signalOf(exec) })
    },
    presentCall: args => ({ card: 'generic', title: `Haven query ${args.query}`, kind: 'read' }),
  })))

  // ── haven download info ───────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'haven_download_info',
    description:
      'Get Filecoin storage status for a CID (deals, replicas, pin health). Read-only: no bytes are fetched. Use to check whether content is retrievable before downloading.',
    parameters: {
      cid: { type: 'string', required: true, description: 'Content ID (Qm... or baf...).' },
    },
    output: { schema: { type: 'object', additionalProperties: true } as never, render: (_a, v) => renderJson(v) as never },
    execute: async (args: { cid: string }, exec): Promise<unknown> => {
      const argv = withConfig(['download', 'info', args.cid, '--json'], opts.configFile)
      return runHaven(opts.bin, argv, { timeoutMs: opts.timeoutMs, signal: signalOf(exec) })
    },
    presentCall: args => ({ card: 'generic', title: `Haven CID info ${args.cid}`, kind: 'read' }),
  })))

  // ── haven jobs list ───────────────────────────────────────────────
  // NOTE: `haven jobs list` has no --json flag upstream (rich table only),
  // so this tool captures raw text and returns it verbatim. If --json lands
  // upstream, switch argv to ['jobs','list','--json',...] and parse as JSON.
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'haven_jobs_list',
    description:
      'List Haven scheduled jobs (plugin polling). Read-only: returns the CLI table text verbatim. Filter by active / paused / all.',
    parameters: {
      status: { type: 'string', description: 'Filter: active, paused, or all (default all).' },
    },
    output: { schema: { type: 'string' }, render(_a, v: string) { return [{ type: 'text', text: v }] as never } },
    execute: async (args: { status?: string }, exec): Promise<string> => {
      const { internals } = await import('./bridge.ts')
      const spawn = internals.spawn
      const argv = withConfig(
        ['jobs', 'list', ...(args.status ? ['--status', args.status] : [])],
        opts.configFile,
      )
      if (spawn) {
        // Under test seam, bridge text through runHaven-compatible path.
        const res = await spawn(opts.bin, argv, { timeoutMs: opts.timeoutMs, signal: signalOf(exec) })
        if (res.exitCode !== 0) throw new Error(`haven jobs list exited ${String(res.exitCode)}: ${res.stderr.slice(0, 500)}`)
        return res.stdout
      }
      const { spawnFile } = await import('node:child_process')
      return new Promise<string>((resolve, reject) => {
        const child = spawnFile(opts.bin, [...argv], { timeout: opts.timeoutMs })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (c: Buffer | string) => { stdout += String(c) })
        child.stderr.on('data', (c: Buffer | string) => { stderr += String(c) })
        child.on('error', (e: Error) => reject(new Error(`haven bridge: failed to spawn ${opts.bin}: ${e.message}`)))
        child.on('close', (code: number | null) => {
          if (code !== 0) reject(new Error(`haven jobs list exited ${String(code)}: ${stderr.slice(0, 500)}`))
          else resolve(stdout)
        })
      })
    },
    presentCall: () => ({ card: 'generic', title: 'Haven jobs list', kind: 'read' }),
  })))
}
