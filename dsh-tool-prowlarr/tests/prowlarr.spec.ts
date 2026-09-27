import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ProwlarrPlugin from '../src/index.ts'
import {
  Config,
  formatSize,
  mapIndexer,
  mapRelease,
  ProwlarrClient,
  redactUrl,
  resolveConfig,
} from '../src/index.ts'

const KEY = 'abc123secretkey'

// ── Fake Prowlarr ──────────────────────────────────────────────────────────

const indexersFixture = [
  {
    id: 1, name: 'arXiv', definitionName: 'arxiv', enable: true, protocol: 'usenet', privacy: 'public', supportsSearch: true,
    description: 'Open-access preprints',
    capabilities: { categories: [{ id: 7000, name: 'Books', subCategories: [{ id: 7020, name: 'Books/EBook' }] }], searchParams: ['q'], bookSearchParams: ['q', 'title', 'author'] },
  },
  { id: 2, name: 'SomeTracker', enable: false, protocol: 'torrent', privacy: 'private', supportsSearch: true, capabilities: { categories: [{ id: 2000, name: 'Movies' }], searchParams: ['q'], movieSearchParams: ['q', 'imdbId'] } },
  { id: 3, name: 'Other', enable: true, protocol: 'torrent', capabilities: {} },
  { name: 'no-id' },
]

function release(n: number, indexerId = 1): Record<string, unknown> {
  return {
    guid: `https://arxiv.org/abs/2609.0000${n}`,
    title: `Paper ${n}`,
    indexerId,
    indexer: 'arXiv',
    protocol: 'usenet',
    publishDate: '2026-09-25T00:00:00Z',
    ageHours: 12.345,
    size: 2048,
    grabs: null,
    seeders: null,
    infoUrl: `https://arxiv.org/abs/2609.0000${n}`,
    downloadUrl: `http://localhost:9696/1/download?apikey=${KEY}&link=abc&file=Paper`,
    categories: [{ id: 7000, name: 'Books', subCategories: [] }],
  }
}

let server: Server
let baseUrl: string
let requests: IncomingMessage[] = []
let searchReleases: unknown[] = [release(1), release(2), release(3)]
let failWith: { status: number; body: string } | undefined

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(req)
    if (req.headers['x-api-key'] !== KEY) {
      res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: 'Unauthorized' })); return
    }
    if (failWith !== undefined) {
      res.writeHead(failWith.status, { 'content-type': 'application/json' }); res.end(failWith.body); return
    }
    const url = new URL(req.url ?? '/', 'http://x')
    res.writeHead(200, { 'content-type': 'application/json' })
    if (url.pathname === '/prowlarr/api/v1/indexer') res.end(JSON.stringify(indexersFixture))
    else if (url.pathname === '/prowlarr/api/v1/search') res.end(JSON.stringify(searchReleases))
    else { res.statusCode = 404; res.end('{}') }
  })
  const address = await new Promise<AddressInfo>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve(server.address() as AddressInfo) }) })
  baseUrl = `http://127.0.0.1:${String(address.port)}/prowlarr/`
})
afterAll(async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) })
afterEach(() => { requests = []; failWith = undefined; searchReleases = [release(1), release(2), release(3)]; vi.unstubAllGlobals() })

// ── Harness mount ──────────────────────────────────────────────────────────

async function mount(config: ProwlarrPlugin.Config = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ProwlarrPlugin, { baseUrl, apiKey: KEY, ...config })
  let n = 0
  const call = (name: string, args: unknown) => ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`c${++n}`), name, arguments: args })
  return { ctx, call }
}

function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.map(block => block.text ?? '').join('')
}

// ── Pure mapping ───────────────────────────────────────────────────────────

describe('redaction', () => {
  it('drops the apikey query parameter regardless of case and keeps the rest', () => {
    expect(redactUrl(`http://h/1/download?APIKEY=${KEY}&link=x`, KEY)).toBe('http://h/1/download?link=x')
  })
  it('replaces a literal key elsewhere in the string', () => {
    expect(redactUrl(`http://h/${KEY}/x`, KEY)).toBe('http://h/[REDACTED]/x')
  })
  it('returns undefined for blank input', () => {
    expect(redactUrl('  ', KEY)).toBeUndefined()
    expect(redactUrl(null, KEY)).toBeUndefined()
  })
})

describe('mapping', () => {
  it('normalizes an indexer with search types and top-level categories', () => {
    expect(mapIndexer(indexersFixture[0] as never)).toEqual({
      id: 1, name: 'arXiv', enabled: true, protocol: 'usenet', privacy: 'public', description: 'Open-access preprints', definitionName: 'arxiv',
      supportsSearch: true, searchTypes: ['search', 'book'], categories: [{ id: 7000, name: 'Books' }],
    })
    expect(mapIndexer({ name: 'no-id' })).toBeUndefined()
  })

  it('normalizes a release, omits nulls, rounds age, and never leaks the key', () => {
    const mapped = mapRelease(release(1) as never, KEY)
    expect(mapped).toMatchObject({ title: 'Paper 1', indexerId: 1, ageHours: 12.3, size: 2048, infoUrl: 'https://arxiv.org/abs/2609.00001' })
    expect(mapped).not.toHaveProperty('grabs')
    expect(mapped).not.toHaveProperty('seeders')
    expect(JSON.stringify(mapped)).not.toContain(KEY)
    expect(mapRelease({ title: '  ' }, KEY)).toBeUndefined()
  })

  it('keeps downloadUrl and magnetUrl as separate redacted fields', () => {
    const both = mapRelease({
      title: 'Both', indexerId: 1,
      downloadUrl: `http://h/1/download?apikey=${KEY}&link=x`,
      magnetUrl: 'magnet:?xt=urn:btih:abc',
    } as never, KEY)
    expect(both).toMatchObject({
      downloadUrl: 'http://h/1/download?link=x',
      magnetUrl: 'magnet:?xt=urn:btih:abc',
    })
    // TPB shape: the proxy link lives in magnetUrl, downloadUrl is empty.
    const tpb = mapRelease({
      title: 'Tpb', indexerId: 1,
      magnetUrl: `http://h/1/download?apikey=${KEY}&link=x`,
    } as never, KEY)
    expect(tpb).toMatchObject({ magnetUrl: 'http://h/1/download?link=x' })
    expect(tpb).not.toHaveProperty('downloadUrl')
    expect(JSON.stringify([both, tpb])).not.toContain(KEY)
  })

  it('formats sizes', () => {
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(1536)).toBe('1.5 KB')
    expect(formatSize(5 * 1024 ** 3)).toBe('5.0 GB')
  })
})

describe('config', () => {
  it('falls back to environment then constants', () => {
    const env = (name: string) => ({ PROWLARR_API_KEY: 'env-key', PROWLARR_URL: 'http://env:9696' } as Record<string, string>)[name]
    expect(resolveConfig({}, env)).toMatchObject({ apiKey: 'env-key', baseUrl: 'http://env:9696', toolPrefix: 'prowlarr', defaultLimit: 25, maxLimit: 100 })
    expect(resolveConfig({}, () => undefined)).toMatchObject({ apiKey: '', baseUrl: 'http://localhost:9696' })
  })
  it('clamps defaultLimit to maxLimit', () => {
    expect(resolveConfig({ defaultLimit: 50, maxLimit: 10 }, () => undefined).defaultLimit).toBe(10)
  })
  it('rejects an invalid tool prefix', () => {
    expect(() => Config({ toolPrefix: 'Bad-Prefix' })).toThrow()
  })
})

// ── Client over HTTP ───────────────────────────────────────────────────────

describe('ProwlarrClient', () => {
  it('sends the key as a header, never as a query parameter, and encodes list params as repeated keys', async () => {
    const client = new ProwlarrClient({ baseUrl, apiKey: KEY, timeoutMs: 5_000 })
    await client.search({ query: 'large language models', type: 'book', indexerIds: [1, 3], categories: [7000], limit: 5, offset: 10 })
    const url = new URL(requests[0]!.url!, 'http://x')
    expect(url.pathname).toBe('/prowlarr/api/v1/search')
    expect(url.searchParams.get('query')).toBe('large language models')
    expect(url.searchParams.get('type')).toBe('book')
    expect(url.searchParams.getAll('indexerIds')).toEqual(['1', '3'])
    expect(url.searchParams.getAll('categories')).toEqual(['7000'])
    expect(url.searchParams.get('limit')).toBe('5')
    expect(url.searchParams.get('offset')).toBe('10')
    expect(url.search.toLowerCase()).not.toContain('apikey')
  })

  it('classifies 401 as PROWLARR_UNAUTHORIZED', async () => {
    const client = new ProwlarrClient({ baseUrl, apiKey: 'wrong', timeoutMs: 5_000 })
    await expect(client.listIndexers()).rejects.toMatchObject({ code: 'PROWLARR_UNAUTHORIZED', status: 401 })
  })

  it('surfaces Prowlarr error detail with the key redacted', async () => {
    failWith = { status: 400, body: JSON.stringify({ message: `bad request for ${KEY}` }) }
    const client = new ProwlarrClient({ baseUrl, apiKey: KEY, timeoutMs: 5_000 })
    const error = await client.search({ query: 'x', type: 'search' }).then(() => new Error('expected rejection'), (e: unknown) => e as Error)
    expect(error).toMatchObject({ code: 'PROWLARR_HTTP_ERROR' })
    expect(error.message).toContain('bad request for [REDACTED]')
    expect(error.message).not.toContain(KEY)
  })

  it('keeps the status line for a non-JSON error body', async () => {
    failWith = { status: 502, body: '<html>bad gateway</html>' }
    const client = new ProwlarrClient({ baseUrl, apiKey: KEY, timeoutMs: 5_000 })
    await expect(client.listIndexers()).rejects.toMatchObject({ code: 'PROWLARR_HTTP_ERROR', message: 'Prowlarr API error (HTTP 502)' })
  })

  it('rejects a wrong-shape success body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"not":"an array"}', { status: 200 })))
    const client = new ProwlarrClient({ baseUrl, apiKey: KEY, timeoutMs: 5_000 })
    await expect(client.search({ query: 'x', type: 'search' })).rejects.toMatchObject({ code: 'PROWLARR_BAD_RESPONSE' })
  })

  it('distinguishes caller abort from timeout', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => { reject(init.signal!.reason) })
    })))
    const timedOut = new ProwlarrClient({ baseUrl, apiKey: KEY, timeoutMs: 20 })
    await expect(timedOut.listIndexers()).rejects.toMatchObject({ code: 'PROWLARR_TIMEOUT' })
    const controller = new AbortController()
    const pending = new ProwlarrClient({ baseUrl, apiKey: KEY, timeoutMs: 5_000 }).listIndexers(controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'PROWLARR_ABORTED' })
  })

  it('refuses redirects so the key is never replayed to another origin', async () => {
    const fetchMock = vi.fn(async () => new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await new ProwlarrClient({ baseUrl, apiKey: KEY, timeoutMs: 5_000 }).listIndexers()
    expect((fetchMock.mock.calls[0] as unknown as [unknown, RequestInit])[1].redirect).toBe('error')
  })

  it('fails fast when unconfigured', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(new ProwlarrClient({ baseUrl, apiKey: '', timeoutMs: 5_000 }).listIndexers()).rejects.toMatchObject({ code: 'PROWLARR_NOT_CONFIGURED' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ── Tools through the real registry ────────────────────────────────────────

describe('registered tools', () => {
  it('registers both tools under the configured prefix', async () => {
    const { ctx } = await mount({ toolPrefix: 'papers' })
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toContain('papers_search')
    expect(names).toContain('papers_indexers')
    expect(names).not.toContain('prowlarr_search')
  })

  it('lists enabled indexers by default and filters by name', async () => {
    const { call } = await mount()
    const all = await call('prowlarr_indexers', {})
    expect(all.isError).toBe(false)
    expect((all.value as { indexers: { id: number }[] }).indexers.map(i => i.id)).toEqual([1, 3])
    const withDisabled = await call('prowlarr_indexers', { includeDisabled: true })
    expect((withDisabled.value as { indexers: unknown[] }).indexers).toHaveLength(3)
    const filtered = await call('prowlarr_indexers', { nameContains: 'ARX' })
    expect((filtered.value as { indexers: { name: string }[] }).indexers.map(i => i.name)).toEqual(['arXiv'])
    expect(textOf(filtered)).toContain('#1 arXiv')
  })

  it('searches with config defaults and returns a canonical value plus rendered text', async () => {
    const { call } = await mount({ defaultIndexerIds: [1], defaultCategories: [7000], defaultSearchType: 'book' })
    const result = await call('prowlarr_search', { query: '  diffusion models ' })
    expect(result.isError).toBe(false)
    const url = new URL(requests[0]!.url!, 'http://x')
    expect(url.searchParams.get('query')).toBe('diffusion models')
    expect(url.searchParams.get('type')).toBe('book')
    expect(url.searchParams.getAll('indexerIds')).toEqual(['1'])
    expect(url.searchParams.getAll('categories')).toEqual(['7000'])
    expect(result.value).toMatchObject({ query: 'diffusion models', type: 'book', indexerIds: [1], total: 3, truncated: false })
    const text = textOf(result)
    expect(text).toContain('1. Paper 1')
    expect(text).toContain('https://arxiv.org/abs/2609.00001')
    expect(text).toContain('untrusted data')
    expect(JSON.stringify(result.value) + text).not.toContain(KEY)
  })

  it('lets call arguments override defaults', async () => {
    const { call } = await mount({ defaultIndexerIds: [1], defaultCategories: [7000] })
    await call('prowlarr_search', { query: 'q', indexerIds: [3], categories: [2000], type: 'movie' })
    const url = new URL(requests[0]!.url!, 'http://x')
    expect(url.searchParams.getAll('indexerIds')).toEqual(['3'])
    expect(url.searchParams.getAll('categories')).toEqual(['2000'])
    expect(url.searchParams.get('type')).toBe('movie')
  })

  it('enforces the final result bound even though Prowlarr limits per indexer', async () => {
    searchReleases = Array.from({ length: 12 }, (_, i) => release(i + 1))
    const { call } = await mount({ maxLimit: 5 })
    const result = await call('prowlarr_search', { query: 'q', limit: 50 })
    expect(new URL(requests[0]!.url!, 'http://x').searchParams.get('limit')).toBe('5')
    expect(result.value).toMatchObject({ total: 12, truncated: true })
    expect((result.value as { results: unknown[] }).results).toHaveLength(5)
    expect(textOf(result)).toContain('truncated from 12')
  })

  it('confines searches to allowedIndexerIds', async () => {
    const { call } = await mount({ allowedIndexerIds: [1] })
    await call('prowlarr_search', { query: 'q' })
    expect(new URL(requests[0]!.url!, 'http://x').searchParams.getAll('indexerIds')).toEqual(['1'])
    const denied = await call('prowlarr_search', { query: 'q', indexerIds: [2] })
    expect(denied.isError).toBe(true)
    expect(textOf(denied)).toContain('not allowed')
    expect(requests).toHaveLength(1)
    const listed = await call('prowlarr_indexers', { includeDisabled: true })
    expect((listed.value as { indexers: { id: number }[] }).indexers.map(i => i.id)).toEqual([1])
  })

  it('reports invalid input and upstream failures as tool errors', async () => {
    const { call } = await mount()
    expect((await call('prowlarr_search', { query: '   ' })).isError).toBe(true)
    expect((await call('prowlarr_search', { query: 'q', limit: 0 })).isError).toBe(true)
    expect((await call('prowlarr_search', {})).isError).toBe(true)
    failWith = { status: 500, body: '{"message":"indexer exploded"}' }
    const failed = await call('prowlarr_search', { query: 'q' })
    expect(failed.isError).toBe(true)
    expect(textOf(failed)).toContain('indexer exploded')
  })

  it('renders an empty result plainly', async () => {
    searchReleases = []
    const { call } = await mount()
    const result = await call('prowlarr_search', { query: 'nothing' })
    expect(textOf(result)).toContain('No results for "nothing"')
  })
})
