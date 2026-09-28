/**
 * Download/acquisition tools for dsh: the missing arm between
 * `prowlarr_search` and `synapse_pin`.
 *
 * Registers two tools (names prefixed by `toolPrefix`):
 *
 * - `<prefix>_submit` — download one source: a magnet link, a direct
 *   http(s) URL, or a Prowlarr release reference (`downloadUrl` /
 *   `magnetUrl` from `prowlarr_search`). Torrents go to a download
 *   client (qBittorrent, then Transmission); direct files are fetched
 *   under guardrails. Returns an opaque handle plus the first state.
 * - `<prefix>_status` — poll a handle; finalizes (select + import) when
 *   the client reports completion. Handles persist across restarts.
 *
 * Secrets (Prowlarr key, client passwords) live in config or env and are
 * never exposed to the model: tool outputs carry redacted URLs and local
 * paths only.
 *
 * @module dsh-tool-acquisition
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
// Type-only: the read-back hook contract (runtime access to the guard stays
// optional via `ctx.reflect.get`, so this plugin mounts cleanly unguarded).
import type { CheckContext, CheckDecision } from 'dsh-exactly-once'
import { AcquireService } from './acquire.ts'
import type { AcquireServiceOptions } from './acquire.ts'
import { AcquisitionError } from './errors.ts'
import type { ImportMode, SelectMode, TorrentClientName } from './types.ts'
import { TORRENT_CLIENTS } from './types.ts'
import type { AcquireResult } from './types.ts'

export { AcquireService } from './acquire.ts'
export type { AcquireServiceOptions, AcquireSubmitInput } from './acquire.ts'
export * from './types.ts'
export * from './errors.ts'
export * from './redact.ts'
export * from './fetchSafety.ts'
export * from './filetype.ts'
export * from './bencode.ts'
export * from './fetch.ts'
export * from './prowlarr.ts'
export * from './qbittorrent.ts'
export * from './transmission.ts'
export * from './selection.ts'
export * from './importer.ts'
export * from './store.ts'

/** Cordis plugin name. */
export const name = 'tool-acquisition'
/** The tool registry this plugin registers into. */
export const inject = ['tools']

/** Environment variable consulted when `prowlarrApiKey` is not configured. */
export const PROWLARR_API_KEY_ENV = 'PROWLARR_API_KEY'
/** Environment variable consulted when `prowlarrUrl` is not configured. */
export const PROWLARR_URL_ENV = 'PROWLARR_URL'
/** Environment variable consulted when `qbittorrentPassword` is not configured. */
export const QBITTORRENT_PASSWORD_ENV = 'QBITTORRENT_PASSWORD'
/** Environment variable consulted when `transmissionPassword` is not configured. */
export const TRANSMISSION_PASSWORD_ENV = 'TRANSMISSION_PASSWORD'
/** Environment variable consulted when `downloadDir` is not configured. */
export const DOWNLOAD_DIR_ENV = 'ACQUIRE_DOWNLOAD_DIR'

export const DEFAULT_PROWLARR_URL = 'http://localhost:9696'
export const DEFAULT_TOOL_PREFIX = 'acquire'
export const DEFAULT_DOWNLOAD_DIR = './downloads-acquisition'
export const DEFAULT_USER_AGENT = 'dsh-tool-acquisition/0.1.0'

/** Plugin configuration. Every field is optional; flat by stack convention. */
export interface Config {
  /** Prowlarr origin plus URL base. Falls back to `$PROWLARR_URL`, then `http://localhost:9696`. */
  prowlarrUrl?: string
  /** Prowlarr API key (server-side only). Falls back to `$PROWLARR_API_KEY`. */
  prowlarrApiKey?: string
  /** Tool-name prefix; distinguishes parallel mounts. */
  toolPrefix?: string
  /** Torrent backends in try order. Empty = `['qbittorrent', 'transmission']`. */
  torrentClients?: string[]
  /** qBittorrent Web UI origin, e.g. `http://localhost:8080`. Empty = backend disabled. */
  qbittorrentUrl?: string
  qbittorrentUsername?: string
  /** Falls back to `$QBITTORRENT_PASSWORD`. */
  qbittorrentPassword?: string
  qbittorrentCategory?: string
  qbittorrentSavePath?: string
  /** `remote=local` path mappings. */
  qbittorrentPathMappings?: string[]
  /** Transmission RPC origin, e.g. `http://localhost:9091`. Empty = backend disabled. */
  transmissionUrl?: string
  transmissionUsername?: string
  /** Falls back to `$TRANSMISSION_PASSWORD`. */
  transmissionPassword?: string
  transmissionDownloadDir?: string
  transmissionLabels?: boolean
  /** `remote=local` path mappings. */
  transmissionPathMappings?: string[]
  /** Work dir for spool files, imports, and the handle store. Falls back to `$ACQUIRE_DOWNLOAD_DIR`. */
  downloadDir?: string
  /** Byte cap for a single direct/Prowlarr-body fetch. */
  maxBytes?: number
  /** Per-request timeout for fetches (ms). */
  fetchTimeoutMs?: number
  /** Per-request timeout for client/Prowlarr API calls (ms). */
  clientTimeoutMs?: number
  /** Redirect hops followed per fetch. */
  maxRedirects?: number
  /** Host allowlist for third-party fetches. Empty = any public host. */
  allowedHosts?: string[]
  /** Permit loopback/private/link-local fetch targets (tests, LAN indexers). */
  allowPrivateHosts?: boolean
  /** User-Agent for outbound fetches. */
  userAgent?: string
  /** Accepted content types (kinds, `*`, or MIME globs). Empty = accept everything. */
  accept?: string[]
  /** Rejected content types. */
  reject?: string[]
  /** `all` keeps every match; `largest` keeps only the biggest file. */
  selectMode?: string
  /** Max files kept per acquisition. */
  maxFiles?: number
  /** Min/max accepted file size in bytes (0 max = unlimited). */
  minFileBytes?: number
  maxFileBytes?: number
  /** `hardlink` (default), `copy`, `move`, or `inplace`. */
  importMode?: string
  /** Poll interval while waiting (ms). */
  pollIntervalMs?: number
  /** Inline wait budget per submit when the call names none (ms). */
  defaultWaitMs?: number
  /** Hard upper bound on `waitMs` (ms). */
  maxWaitMs?: number
}

const TOOL_PREFIX_PATTERN = /^[a-z][a-z0-9_]{0,31}$/

export const Config: z<Config> = z.object({
  prowlarrUrl: z.string(),
  prowlarrApiKey: z.string(),
  toolPrefix: z.string().pattern(TOOL_PREFIX_PATTERN),
  torrentClients: z.array(z.string()),
  qbittorrentUrl: z.string(),
  qbittorrentUsername: z.string(),
  qbittorrentPassword: z.string(),
  qbittorrentCategory: z.string(),
  qbittorrentSavePath: z.string(),
  qbittorrentPathMappings: z.array(z.string()),
  transmissionUrl: z.string(),
  transmissionUsername: z.string(),
  transmissionPassword: z.string(),
  transmissionDownloadDir: z.string(),
  transmissionLabels: z.boolean(),
  transmissionPathMappings: z.array(z.string()),
  downloadDir: z.string(),
  maxBytes: z.number().step(1).min(1),
  fetchTimeoutMs: z.number().step(1).min(1),
  clientTimeoutMs: z.number().step(1).min(1),
  maxRedirects: z.number().step(1).min(0),
  allowedHosts: z.array(z.string()),
  allowPrivateHosts: z.boolean(),
  userAgent: z.string(),
  accept: z.array(z.string()),
  reject: z.array(z.string()),
  selectMode: z.string(),
  maxFiles: z.number().step(1).min(1),
  minFileBytes: z.number().step(1).min(0),
  maxFileBytes: z.number().step(1).min(0),
  importMode: z.string(),
  pollIntervalMs: z.number().step(1).min(100),
  defaultWaitMs: z.number().step(1).min(0),
  maxWaitMs: z.number().step(1).min(0),
})

/** Fully defaulted configuration used by the tools. */
export interface ResolvedConfig {
  prowlarrUrl: string
  prowlarrApiKey: string
  toolPrefix: string
  torrentClients: TorrentClientName[]
  qbittorrentUrl: string
  qbittorrentUsername: string
  qbittorrentPassword: string
  qbittorrentCategory: string
  qbittorrentSavePath: string
  qbittorrentPathMappings: string[]
  transmissionUrl: string
  transmissionUsername: string
  transmissionPassword: string
  transmissionDownloadDir: string
  transmissionLabels: boolean
  transmissionPathMappings: string[]
  downloadDir: string
  maxBytes: number
  fetchTimeoutMs: number
  clientTimeoutMs: number
  maxRedirects: number
  allowedHosts: string[]
  allowPrivateHosts: boolean
  userAgent: string
  accept: string[]
  reject: string[]
  selectMode: SelectMode
  maxFiles: number
  minFileBytes: number
  maxFileBytes: number
  importMode: ImportMode
  pollIntervalMs: number
  defaultWaitMs: number
  maxWaitMs: number
}

const SELECT_MODES: ReadonlyArray<string> = ['all', 'largest']
const IMPORT_MODES: ReadonlyArray<string> = ['hardlink', 'copy', 'move', 'inplace']

/**
 * Apply environment and constant defaults; fail loud on invalid enums.
 * @param config - validated plugin config.
 * @param env - variable lookup (the launch environment in production).
 * @returns resolved config.
 */
export function resolveConfig(config: Config, env: (name: string) => string | undefined): ResolvedConfig {
  // Schemastery fills missing arrays as [] (see Config({})), so empty
  // means "default" here, matching the stack's "empty = all" convention.
  const rawClients = config.torrentClients ?? []
  for (const client of rawClients) {
    if (!(TORRENT_CLIENTS as ReadonlyArray<string>).includes(client)) {
      throw new Error(`torrentClients: unknown backend '${client}' (want ${TORRENT_CLIENTS.join(', ')})`)
    }
  }
  const clients = rawClients.length > 0 ? rawClients : [...TORRENT_CLIENTS]
  const accept = config.accept ?? []
  const toolPrefix = config.toolPrefix ?? DEFAULT_TOOL_PREFIX
  const selectMode = config.selectMode ?? 'all'
  if (!SELECT_MODES.includes(selectMode)) throw new Error(`selectMode: want one of ${SELECT_MODES.join(', ')}; got '${selectMode}'`)
  const importMode = config.importMode ?? 'hardlink'
  if (!IMPORT_MODES.includes(importMode)) throw new Error(`importMode: want one of ${IMPORT_MODES.join(', ')}; got '${importMode}'`)
  return {
    prowlarrUrl: config.prowlarrUrl ?? env(PROWLARR_URL_ENV) ?? DEFAULT_PROWLARR_URL,
    prowlarrApiKey: config.prowlarrApiKey ?? env(PROWLARR_API_KEY_ENV) ?? '',
    toolPrefix,
    torrentClients: clients as TorrentClientName[],
    qbittorrentUrl: config.qbittorrentUrl ?? '',
    qbittorrentUsername: config.qbittorrentUsername ?? '',
    qbittorrentPassword: config.qbittorrentPassword ?? env(QBITTORRENT_PASSWORD_ENV) ?? '',
    qbittorrentCategory: config.qbittorrentCategory ?? '',
    qbittorrentSavePath: config.qbittorrentSavePath ?? '',
    qbittorrentPathMappings: config.qbittorrentPathMappings ?? [],
    transmissionUrl: config.transmissionUrl ?? '',
    transmissionUsername: config.transmissionUsername ?? '',
    transmissionPassword: config.transmissionPassword ?? env(TRANSMISSION_PASSWORD_ENV) ?? '',
    transmissionDownloadDir: config.transmissionDownloadDir ?? '',
    transmissionLabels: config.transmissionLabels ?? true,
    transmissionPathMappings: config.transmissionPathMappings ?? [],
    downloadDir: config.downloadDir ?? env(DOWNLOAD_DIR_ENV) ?? DEFAULT_DOWNLOAD_DIR,
    maxBytes: config.maxBytes ?? 2 * 1024 ** 3,
    fetchTimeoutMs: config.fetchTimeoutMs ?? 120_000,
    clientTimeoutMs: config.clientTimeoutMs ?? 30_000,
    maxRedirects: config.maxRedirects ?? 5,
    allowedHosts: config.allowedHosts ?? [],
    allowPrivateHosts: config.allowPrivateHosts ?? false,
    userAgent: config.userAgent ?? DEFAULT_USER_AGENT,
    accept: accept.length > 0 ? accept : ['*'],
    reject: config.reject ?? [],
    selectMode: selectMode as SelectMode,
    maxFiles: config.maxFiles ?? 1000,
    minFileBytes: config.minFileBytes ?? 0,
    maxFileBytes: config.maxFileBytes ?? 0,
    importMode: importMode as ImportMode,
    pollIntervalMs: config.pollIntervalMs ?? 2_000,
    defaultWaitMs: config.defaultWaitMs ?? 30_000,
    maxWaitMs: config.maxWaitMs ?? 280_000,
  }
}

/** Build an {@link AcquireService} from resolved config. */
export function createService(config: ResolvedConfig): AcquireService {
  const options: AcquireServiceOptions = {
    prowlarrBaseUrl: config.prowlarrUrl,
    prowlarrApiKey: config.prowlarrApiKey,
    prowlarrTimeoutMs: config.clientTimeoutMs,
    torrentClients: config.torrentClients,
    clientTimeoutMs: config.clientTimeoutMs,
    downloadDir: config.downloadDir,
    fetchPolicy: {
      maxBytes: config.maxBytes,
      timeoutMs: config.fetchTimeoutMs,
      maxRedirects: config.maxRedirects,
      allowedHosts: config.allowedHosts,
      allowPrivateHosts: config.allowPrivateHosts,
      userAgent: config.userAgent,
    },
    selection: {
      accept: config.accept,
      reject: config.reject,
      minSize: config.minFileBytes,
      maxSize: config.maxFileBytes,
      mode: config.selectMode,
      maxFiles: config.maxFiles,
    },
    importMode: config.importMode,
    pollIntervalMs: config.pollIntervalMs,
    defaultWaitMs: config.defaultWaitMs,
    maxWaitMs: config.maxWaitMs,
  }
  if (config.qbittorrentUrl !== '') {
    options.qbittorrent = {
      url: config.qbittorrentUrl,
      username: config.qbittorrentUsername,
      password: config.qbittorrentPassword,
      category: config.qbittorrentCategory,
      savePath: config.qbittorrentSavePath,
      pathMappings: config.qbittorrentPathMappings,
    }
  }
  if (config.transmissionUrl !== '') {
    options.transmission = {
      url: config.transmissionUrl,
      username: config.transmissionUsername,
      password: config.transmissionPassword,
      downloadDir: config.transmissionDownloadDir,
      labels: config.transmissionLabels,
      pathMappings: config.transmissionPathMappings,
    }
  }
  return new AcquireService(options)
}

// ── Output schemas ─────────────────────────────────────────────────────────

const acquiredFileSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    size: { type: 'integer', required: true, description: 'Bytes' },
    mime: { type: 'string', required: true },
  },
} as const

const acquireResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    handle: { type: 'string', required: true, description: 'Opaque handle for acquire_status' },
    state: { type: 'string', enum: ['queued', 'downloading', 'completed', 'failed', 'missing'], required: true },
    progress: { type: 'number', required: true, description: '0..1' },
    files: { type: 'array', items: acquiredFileSchema, required: true },
    error: { type: 'string' },
    backend: { type: 'string', description: 'qbittorrent, transmission, or absent for direct fetches' },
  },
} as const

// ── Rendering ──────────────────────────────────────────────────────────────

/** Human-readable byte size. */
export function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
}

/** Model-facing text for a submit/poll result. */
export function formatAcquire(value: AcquireResult, statusTool: string): string {
  const lines = [`${value.handle}: ${value.state} (${Math.round(value.progress * 100)}%)${value.backend !== undefined ? ` via ${value.backend}` : ''}`]
  for (const file of value.files) {
    lines.push(`- ${file.path} (${formatSize(file.size)}, ${file.mime})`)
  }
  if (value.error !== undefined) lines.push(`error: ${value.error}`)
  if (value.state === 'queued' || value.state === 'downloading') {
    lines.push(`Poll with ${statusTool} (handle "${value.handle}") until completed.`)
  }
  return lines.join('\n')
}

// ── Tools ──────────────────────────────────────────────────────────────────

/** Throw a validation failure the model can act on. */
function invalid(message: string): never {
  throw new AcquisitionError(message, 'ACQUIRE_INVALID_REQUEST', { permanent: true })
}

/** Optional exactly-once wiring for the submit tool (registrar closes over the host ctx). */
export interface CreateToolsHooks {
  ensureSubmitHook?: () => void
}

/**
 * Build the two tool definitions over one service and resolved config.
 * Exposed for tests and for hosts that register tools themselves.
 * @param service - acquisition service.
 * @param config - resolved config.
 * @param hooks - optional exactly-once hook registrar (wired by `apply`).
 * @returns `[submitTool, statusTool]`.
 */
export function createTools(service: AcquireService, config: ResolvedConfig, hooks?: CreateToolsHooks): [ToolDefinition, ToolDefinition] {
  const submitName = `${config.toolPrefix}_submit`
  const statusName = `${config.toolPrefix}_status`

  const submit = defineTool({
    name: submitName,
    description: [
      'Download one source into local files: a magnet link, a direct http(s) URL, or a Prowlarr release',
      'reference (ref, downloadUrl, or magnetUrl from prowlarr_search; the API key is attached server-side).',
      'Prefer ref: it resolves to the byte-exact links, while the long URLs are easy to mistranscribe.',
      'Torrents download via a torrent client; direct files are fetched with guardrails.',
      `Returns an opaque handle. When the state is queued/downloading, poll ${statusName}.`,
    ].join(' '),
    parameters: {
      magnet: { type: 'string', description: 'Magnet URI (exactly one source per call)' },
      url: { type: 'string', description: 'Direct http(s) URL (exactly one source per call)' },
      ref: { type: 'string', description: 'Short release ref from prowlarr_search (the ref: line; preferred over copying links)' },
      downloadUrl: { type: 'string', description: 'Prowlarr download link from prowlarr_search (the downloadUrl: line; redacted form is fine — never the info page URL, which fails)' },
      magnetUrl: { type: 'string', description: 'Prowlarr magnet link from prowlarr_search' },
      title: { type: 'string', description: 'Display title for the acquisition' },
      waitMs: { type: 'integer', description: `Inline wait budget in ms (default ${config.defaultWaitMs}, max ${config.maxWaitMs}; 0 returns after submit)` },
    },
    output: {
      schema: acquireResultSchema,
      render: (_args, value) => [{ type: 'text', text: formatAcquire(value as AcquireResult, statusName) }],
      presentationMeta: (_args, value) => {
        const result = value as AcquireResult
        return { state: result.state, files: result.files.length }
      },
    },
    timeoutMs: config.maxWaitMs + 60_000,
    // No isConcurrencySafe: submit mutates (queues a download), so parallel
    // identical submits must serialize instead of racing the attempt ledger.
    presentCall: args => ({
      card: 'generic',
      title: `Acquire ${(args as { title?: string }).title ?? (args as { magnet?: string }).magnet ?? (args as { url?: string }).url ?? (args as { downloadUrl?: string }).downloadUrl ?? 'download'}`,
      kind: 'execute',
    }),
    async execute(args, exec) {
      hooks?.ensureSubmitHook?.()
      const input = args as {
        magnet?: string; url?: string; ref?: string; downloadUrl?: string; magnetUrl?: string; title?: string; waitMs?: number
      }
      if (input.waitMs !== undefined && (!Number.isInteger(input.waitMs) || input.waitMs < 0)) {
        invalid('waitMs must be a non-negative integer')
      }
      return await service.submit(
        {
          ...(input.magnet !== undefined ? { magnet: input.magnet } : {}),
          ...(input.url !== undefined ? { url: input.url } : {}),
          ...(input.ref !== undefined ? { ref: input.ref } : {}),
          ...(input.downloadUrl !== undefined ? { downloadUrl: input.downloadUrl } : {}),
          ...(input.magnetUrl !== undefined ? { magnetUrl: input.magnetUrl } : {}),
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.waitMs !== undefined ? { waitMs: Math.min(input.waitMs, config.maxWaitMs) } : {}),
        },
        exec.signal,
      )
    },
  })

  const status = defineTool({
    name: statusName,
    description: [
      'Poll an acquisition handle from',
      `${submitName}. Finalizes (selects and imports content files) when the download completes.`,
      'Handles persist across restarts; terminal states replay their stored result.',
    ].join(' '),
    parameters: {
      handle: { type: 'string', required: true, description: 'Opaque handle from acquire_submit' },
    },
    output: {
      schema: acquireResultSchema,
      render: (_args, value) => [{ type: 'text', text: formatAcquire(value as AcquireResult, statusName) }],
    },
    timeoutMs: config.clientTimeoutMs + 60_000,
    isConcurrencySafe: () => true,
    presentCall: args => ({ card: 'generic', title: `Acquisition status ${(args as { handle?: string }).handle ?? ''}`, kind: 'read' }),
    async execute(args, exec) {
      const handle = (args as { handle?: string }).handle ?? ''
      if (handle === '') invalid('handle must not be empty')
      return await service.status(handle, exec.signal)
    },
  })

  return [submit, status]
}

/**
 * Register the acquisition tools.
 * @param ctx - plugin context carrying `ctx.tools`.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const environment = launchEnvironmentOf(ctx)
  // A blank variable counts as unset so an exported-but-empty value cannot blank a default.
  const resolved = resolveConfig(config, (varName) => {
    const value = environment.get(varName)?.value
    return value !== undefined && value !== '' ? value : undefined
  })
  if (resolved.qbittorrentUrl === '' && resolved.transmissionUrl === '') {
    console.warn('[tool-acquisition] no torrent client configured (qbittorrentUrl/transmissionUrl); magnet and .torrent submits will fail with ACQUIRE_NO_BACKEND')
  }
  const service = createService(resolved)
  // Exactly-once: the submit read-back hook registers lazily from the
  // submit path (mount-order-proof); unguarded mounts simply skip it. The
  // registration is process-lifetime, like the tools themselves.
  const submitName = `${resolved.toolPrefix}_submit`
  let submitHooked = false
  const ensureSubmitHook = (): void => {
    if (submitHooked) return
    const guard = ctx.reflect.get('exactlyOnce') as
      | { registerCheck?: (name: string, fn: (check: CheckContext) => Promise<CheckDecision>) => () => void }
      | undefined
    if (guard === null || guard === undefined || typeof guard.registerCheck !== 'function') return
    guard.registerCheck(submitName, check => service.checkSubmit(check.args))
    submitHooked = true
  }
  for (const tool of createTools(service, resolved, { ensureSubmitHook })) ctx.tools.register(tool)
}
