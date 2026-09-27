import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as AcquisitionPlugin from '../src/index.ts'
import { AcquireService } from '../src/acquire.ts'
import type { AcquireServiceOptions } from '../src/acquire.ts'
import { QBittorrentClient } from '../src/qbittorrent.ts'
import { TransmissionClient } from '../src/transmission.ts'
import { resolveConfig } from '../src/index.ts'
import type { AcquireResult } from '../src/types.ts'

const PASS = 'client-secret'
const MAGNET = 'magnet:?xt=urn:btih:43f4001de4ab25d521c63684e2b69804193ed9d9&dn=Sintel'
const TORRENT = new TextEncoder().encode(
  'd8:announce8:http://x4:infod6:lengthi12345e4:name8:test.bin12:piece lengthi16384e6:pieces20:AAAAAAAAAAAAAAAAAAAAee',
)
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 1, 2, 3])

const tmpRoots: string[] = []
function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acq-svc-'))
  tmpRoots.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true })
})

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// ── Fake qBittorrent ─────────────────────────────────────────────────────────

let qb: Server
let qbUrl: string
let qbRequireAuth = false
let qbLogins = 0
let qbAdds: Buffer[] = []
let qbTorrents: Array<Record<string, unknown>> = []
let qbFailOnce403 = false
let qbAddReply = 'Ok.'

beforeAll(async () => {
  qb = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (req.method === 'POST' && url.pathname === '/api/v2/auth/login') {
      qbLogins += 1
      const params = new URLSearchParams((await readBody(req)).toString())
      if (params.get('username') === 'u' && params.get('password') === PASS) {
        res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'SID=fakesid; path=/' })
        res.end('Ok.')
      } else {
        res.writeHead(200, { 'content-type': 'text/plain' }); res.end('Fails.')
      }
      return
    }
    if (qbRequireAuth && !(req.headers.cookie ?? '').includes('SID=fakesid')) {
      res.writeHead(403, { 'content-type': 'text/plain' }); res.end('forbidden'); return
    }
    if (req.method === 'POST' && url.pathname === '/api/v2/torrents/add') {
      qbAdds.push(await readBody(req))
      res.writeHead(200, { 'content-type': 'text/plain' }); res.end(qbAddReply); return
    }
    if (req.method === 'GET' && url.pathname === '/api/v2/torrents/info') {
      if (qbFailOnce403) {
        qbFailOnce403 = false
        res.writeHead(403, { 'content-type': 'text/plain' }); res.end('forbidden'); return
      }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(qbTorrents)); return
    }
    if (req.method === 'GET' && url.pathname === '/api/v2/app/version') {
      res.writeHead(200, { 'content-type': 'text/plain' }); res.end('5.0.0'); return
    }
    res.writeHead(404); res.end()
  })
  const address = await new Promise<AddressInfo>((resolve) => {
    qb.listen(0, '127.0.0.1', () => { resolve(qb.address() as AddressInfo) })
  })
  qbUrl = `http://127.0.0.1:${String(address.port)}`
})
afterAll(async () => {
  await new Promise<void>((resolve) => { qb.close(() => { resolve() }) })
})
afterEach(() => {
  qbRequireAuth = false
  qbLogins = 0
  qbAdds = []
  qbTorrents = []
  qbFailOnce403 = false
  qbAddReply = 'Ok.'
})

describe('QBittorrentClient', () => {
  it('submits a magnet with auth bypass and tracks downloading → completed', async () => {
    const client = new QBittorrentClient({ url: qbUrl, pathMappings: ['/qb=/local'] })
    const handle = await client.submit({ magnet: MAGNET }, 'acquire-x')
    expect(handle).toEqual({ info_hash: '43f4001de4ab25d521c63684e2b69804193ed9d9', tag: 'acquire-x' })
    expect(qbLogins).toBe(0)
    expect(qbAdds).toHaveLength(1)
    expect(qbAdds[0]?.toString()).toContain(MAGNET)
    qbTorrents = [{ state: 'downloading', progress: 0.5 }]
    await expect(client.status(handle)).resolves.toMatchObject({ state: 'downloading', progress: 0.5 })
    qbTorrents = [{ state: 'uploading', progress: 1, content_path: '/qb/downloads/movie.mp4' }]
    await expect(client.status(handle)).resolves.toEqual({
      state: 'completed', progress: 1, contentPath: '/local/downloads/movie.mp4', files: [],
    })
    qbTorrents = []
    await expect(client.status(handle)).resolves.toMatchObject({ state: 'missing' })
    qbTorrents = [{ state: 'error', progress: 0.1 }]
    await expect(client.status(handle)).resolves.toMatchObject({ state: 'failed' })
    await expect(client.health()).resolves.toBe('qBittorrent 5.0.0')
  })
  it('logs in with a cookie and re-logins after a 403', async () => {
    qbRequireAuth = true
    const client = new QBittorrentClient({ url: qbUrl, username: 'u', password: PASS })
    await expect(client.health()).resolves.toBe('qBittorrent 5.0.0')
    expect(qbLogins).toBe(1)
    qbFailOnce403 = true
    qbTorrents = [{ state: 'metaDL', progress: 0 }]
    await expect(client.status({ info_hash: '', tag: 't' })).resolves.toMatchObject({ state: 'queued' })
    expect(qbLogins).toBe(2)
  })
  it('classifies bad credentials and rejected torrents', async () => {
    const bad = new QBittorrentClient({ url: qbUrl, username: 'u', password: 'wrong' })
    await expect(bad.health()).rejects.toMatchObject({ code: 'ACQUIRE_BACKEND_AUTH' })
    qbAddReply = 'Fails.'
    const client = new QBittorrentClient({ url: qbUrl })
    await expect(client.submit({ magnet: 'magnet:?xt=urn:other' }, 't')).rejects.toMatchObject({ code: 'ACQUIRE_BACKEND_ERROR' })
  })
  it('rejects invalid .torrent bytes without touching the network', async () => {
    const client = new QBittorrentClient({ url: qbUrl })
    await expect(client.submit({ torrent: new TextEncoder().encode('junk') }, 't'))
      .rejects.toMatchObject({ code: 'ACQUIRE_INVALID_TORRENT' })
    expect(qbAdds).toHaveLength(0)
  })
})

// ── Fake Transmission ────────────────────────────────────────────────────────

let tr: Server
let trUrl: string
let trRequireAuth = false
let trAdds: Array<Record<string, unknown>> = []
let trTorrents: Array<Record<string, unknown>> = []
let trAddDuplicate = false

beforeAll(async () => {
  tr = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (req.method !== 'POST' || !url.pathname.endsWith('/rpc')) {
      res.writeHead(404); res.end(); return
    }
    if (trRequireAuth && req.headers.authorization !== `Basic ${Buffer.from(`u:${PASS}`).toString('base64')}`) {
      res.writeHead(401); res.end(); return
    }
    if (req.headers['x-transmission-session-id'] !== 'sess') {
      res.writeHead(409, { 'x-transmission-session-id': 'sess' }); res.end(); return
    }
    const body = JSON.parse((await readBody(req)).toString()) as { method: string; arguments: Record<string, unknown> }
    const reply = (args: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ result: 'success', arguments: args }))
    }
    if (body.method === 'session-get') {
      reply({ version: '4.0.0' })
    } else if (body.method === 'torrent-add') {
      trAdds.push(body.arguments)
      if (trAddDuplicate) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ result: 'duplicate torrent', arguments: { 'torrent-duplicate': { hashString: 'ABCDEF0123456789' } } }))
      } else {
        reply({ 'torrent-added': { hashString: 'ABCDEF0123456789' } })
      }
    } else if (body.method === 'torrent-get') {
      reply({ torrents: trTorrents })
    } else {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ result: 'success', arguments: {} }))
    }
  })
  const address = await new Promise<AddressInfo>((resolve) => {
    tr.listen(0, '127.0.0.1', () => { resolve(tr.address() as AddressInfo) })
  })
  trUrl = `http://127.0.0.1:${String(address.port)}`
})
afterAll(async () => {
  await new Promise<void>((resolve) => { tr.close(() => { resolve() }) })
})
afterEach(() => {
  trRequireAuth = false
  trAdds = []
  trTorrents = []
  trAddDuplicate = false
})

describe('TransmissionClient', () => {
  it('negotiates the session, submits, and tracks to completion', async () => {
    const client = new TransmissionClient({ url: trUrl })
    const handle = await client.submit({ magnet: MAGNET }, 'acquire-x')
    expect(handle).toMatchObject({ info_hash: 'abcdef0123456789' })
    expect(trAdds[0]).toMatchObject({ filename: MAGNET, labels: ['acquire-x'], paused: false })
    trTorrents = [{ hashString: 'abcdef0123456789', status: 4, percentDone: 0.25, error: 0, leftUntilDone: 100 }]
    await expect(client.status(handle)).resolves.toMatchObject({ state: 'downloading', progress: 0.25 })
    trTorrents = [{
      hashString: 'abcdef0123456789', status: 6, percentDone: 1, error: 0, leftUntilDone: 0,
      downloadDir: '/tr/dl', name: 'movie.mp4',
    }]
    await expect(client.status(handle)).resolves.toEqual({
      state: 'completed', progress: 1, contentPath: '/tr/dl/movie.mp4', files: [],
    })
    trTorrents = []
    await expect(client.status(handle)).resolves.toMatchObject({ state: 'missing' })
    await expect(client.health()).resolves.toBe('Transmission 4.0.0')
  })
  it('accepts duplicates and classifies auth failures', async () => {
    trAddDuplicate = true
    const client = new TransmissionClient({ url: trUrl })
    await expect(client.submit({ magnet: MAGNET }, 't')).resolves.toMatchObject({ info_hash: 'abcdef0123456789' })
    trRequireAuth = true
    const authed = new TransmissionClient({ url: trUrl, username: 'u', password: PASS })
    await expect(authed.health()).resolves.toBe('Transmission 4.0.0')
    const bad = new TransmissionClient({ url: trUrl, username: 'u', password: 'wrong' })
    await expect(bad.health()).rejects.toMatchObject({ code: 'ACQUIRE_BACKEND_AUTH' })
  })
  it('submits raw .torrent bytes as base64 metainfo', async () => {
    const client = new TransmissionClient({ url: trUrl })
    await client.submit({ torrent: TORRENT }, 't')
    expect(typeof trAdds[0]?.['metainfo']).toBe('string')
    expect(Buffer.from(trAdds[0]?.['metainfo'] as string, 'base64').toString()).toContain('4:info')
  })
})

// ── Fake file + Prowlarr server ──────────────────────────────────────────────

let files: Server
let filesUrl: string
const routes: Record<string, { status: number; headers?: Record<string, string>; body: Uint8Array | string }> = {}
const PROWLARR_KEY = 'prowlarr-secret'

beforeAll(async () => {
  files = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/1/download') {
      if (req.headers['x-api-key'] !== PROWLARR_KEY) {
        res.writeHead(401); res.end('unauthorized'); return
      }
      res.writeHead(200, { 'content-type': 'application/x-bittorrent' }); res.end(Buffer.from(TORRENT)); return
    }
    if (url.pathname === '/2/download') {
      res.writeHead(200, { 'content-type': 'application/x-nzb' }); res.end('<?xml version="1.0"?><nzb></nzb>'); return
    }
    if (url.pathname === '/3/download') {
      res.writeHead(200, { 'content-type': 'application/x-bittorrent' }); res.end('d8:announce-truncated'); return
    }
    const route = routes[url.pathname]
    if (route === undefined) {
      res.writeHead(404); res.end(); return
    }
    res.writeHead(route.status, { 'content-type': 'application/octet-stream', ...route.headers })
    res.end(route.body)
  })
  const address = await new Promise<AddressInfo>((resolve) => {
    files.listen(0, '127.0.0.1', () => { resolve(files.address() as AddressInfo) })
  })
  filesUrl = `http://127.0.0.1:${String(address.port)}`
})
afterAll(async () => {
  await new Promise<void>((resolve) => { files.close(() => { resolve() }) })
})
afterEach(() => {
  for (const key of Object.keys(routes)) delete routes[key]
})

function serviceOptions(downloadDir: string, overrides: Partial<AcquireServiceOptions> = {}): AcquireServiceOptions {
  return {
    prowlarrBaseUrl: filesUrl,
    prowlarrApiKey: PROWLARR_KEY,
    prowlarrTimeoutMs: 5_000,
    torrentClients: ['qbittorrent', 'transmission'],
    qbittorrent: { url: qbUrl },
    transmission: { url: trUrl },
    clientTimeoutMs: 5_000,
    downloadDir,
    fetchPolicy: {
      maxBytes: 8 * 1024 * 1024,
      timeoutMs: 5_000,
      maxRedirects: 5,
      allowedHosts: [],
      allowPrivateHosts: true,
      userAgent: 'test',
    },
    selection: { accept: ['*'] },
    importMode: 'hardlink',
    pollIntervalMs: 10,
    defaultWaitMs: 0,
    maxWaitMs: 5_000,
    ...overrides,
  }
}

describe('AcquireService', () => {
  it('fetches a direct URL inline and replays the completed handle after a restart', async () => {
    routes['/doc'] = { status: 200, body: '%PDF-1.4 fake-bytes' }
    const dir = tmpRoot()
    const service = new AcquireService(serviceOptions(dir))
    const result = await service.submit({ url: `${filesUrl}/doc`, title: 'Doc' })
    expect(result.state).toBe('completed')
    expect(result.files).toHaveLength(1)
    expect(result.files[0]?.mime).toBe('application/pdf')
    expect(result.files[0]?.path.startsWith(join(dir, 'imports'))).toBe(true)
    expect(result.backend).toBeUndefined()
    // A new service over the same dir (a restart) replays the terminal record.
    const replayed = await new AcquireService(serviceOptions(dir)).status(result.handle)
    expect(replayed).toEqual(result)
  })
  it('submits a magnet, stays pending, then finalizes on status', async () => {
    const seed = join(tmpRoot(), 'seed')
    mkdirSync(seed, { recursive: true })
    writeFileSync(join(seed, 'movie.mp4'), Buffer.from(MP4))
    writeFileSync(join(seed, 'sample.mp4'), Buffer.from(MP4))
    writeFileSync(join(seed, 'info.nfo'), 'nfo')
    qbTorrents = [{ state: 'downloading', progress: 0.4 }]
    const dir = tmpRoot()
    const service = new AcquireService(serviceOptions(dir))
    const pending = await service.submit({ magnet: MAGNET, title: 'Film' })
    expect(pending.state).toBe('downloading')
    expect(pending.backend).toBe('qbittorrent')
    expect(pending.files).toEqual([])
    qbTorrents = [{ state: 'uploading', progress: 1, content_path: seed }]
    const done = await service.status(pending.handle)
    expect(done.state).toBe('completed')
    // Selection drops the sample and the .nfo.
    expect(done.files.map(f => f.path)).toHaveLength(1)
    expect(done.files[0]?.path.endsWith('movie.mp4')).toBe(true)
    expect(done.files[0]?.mime).toBe('video/mp4')
  })
  it('resolves a Prowlarr .torrent body through the client', async () => {
    const seed = join(tmpRoot(), 'f')
    writeFileSync(seed, Buffer.from(MP4))
    qbTorrents = [{ state: 'uploading', progress: 1, content_path: seed }]
    const dir = tmpRoot()
    const service = new AcquireService(serviceOptions(dir, { defaultWaitMs: 2_000 }))
    const result = await service.submit({ downloadUrl: `${filesUrl}/1/download?link=x`, title: 'Rel' })
    expect(result.state).toBe('completed')
    expect(qbAdds).toHaveLength(1)
    expect(qbAdds[0]?.toString()).toContain('release.torrent')
    expect(result.files).toHaveLength(1)
  })
  it('accepts the proxy link in either release field (indexers disagree)', async () => {
    const seed = join(tmpRoot(), 'g')
    writeFileSync(seed, Buffer.from(MP4))
    qbTorrents = [{ state: 'uploading', progress: 1, content_path: seed }]
    const dir = tmpRoot()
    const service = new AcquireService(serviceOptions(dir, { defaultWaitMs: 2_000 }))
    // magnetUrl holding an http proxy link (as limetorrents returns) resolves like downloadUrl.
    const result = await service.submit({ magnetUrl: `${filesUrl}/1/download?link=x`, title: 'Rel' })
    expect(result.state).toBe('completed')
    expect(qbAdds).toHaveLength(1)
    expect(result.files).toHaveLength(1)
  })
  it('refuses NZBs and invalid torrent bytes without failing over', async () => {
    const dir = tmpRoot()
    const service = new AcquireService(serviceOptions(dir))
    await expect(service.submit({ downloadUrl: `${filesUrl}/2/download`, title: 'N' }))
      .rejects.toMatchObject({ code: 'ACQUIRE_UNSUPPORTED' })
    // Truncated bencode sniffs as a torrent but does not parse: permanent, no failover.
    await expect(service.submit({ downloadUrl: `${filesUrl}/3/download`, title: 'B' }))
      .rejects.toMatchObject({ code: 'ACQUIRE_INVALID_TORRENT' })
    expect(qbAdds).toHaveLength(0)
    expect(trAdds).toHaveLength(0)
  })
  it('fails over to the next backend on transient errors', async () => {
    trTorrents = [{ hashString: 'abcdef0123456789', status: 4, percentDone: 0.1, error: 0, leftUntilDone: 10 }]
    const dir = tmpRoot()
    // Nothing listens on port 9: connection refused (transient) on the first backend.
    const service = new AcquireService(serviceOptions(dir, { qbittorrent: { url: 'http://127.0.0.1:9' } }))
    const result = await service.submit({ magnet: MAGNET })
    expect(result.backend).toBe('transmission')
    expect(result.state).toBe('downloading')
    expect(trAdds).toHaveLength(1)
  })
  it('validates sources and handles, and records backend failures', async () => {
    const dir = tmpRoot()
    const service = new AcquireService(serviceOptions(dir))
    await expect(service.submit({})).rejects.toMatchObject({ code: 'ACQUIRE_INVALID_REQUEST' })
    await expect(service.submit({ magnet: MAGNET, url: `${filesUrl}/x` })).rejects.toMatchObject({ code: 'ACQUIRE_INVALID_REQUEST' })
    await expect(service.status('acq_nope')).rejects.toMatchObject({ code: 'ACQUIRE_NOT_FOUND' })
    routes['/plain'] = { status: 200, body: 'just words' }
    const picky = new AcquireService(serviceOptions(dir, { selection: { accept: ['video'] } }))
    await expect(picky.submit({ url: `${filesUrl}/plain` })).rejects.toMatchObject({ code: 'ACQUIRE_SELECT_REJECTED' })
    qbTorrents = [{ state: 'missingFiles', progress: 0.9 }]
    const failed = await service.submit({ magnet: MAGNET })
    expect(failed.state).toBe('failed')
    expect(failed.error).toContain('qBittorrent')
    // Terminal records replay.
    await expect(service.status(failed.handle)).resolves.toMatchObject({ state: 'failed' })
  })
})

// ── config ─────────────────────────────────────────────────────────────────

describe('config', () => {
  it('falls back to environment then constants', () => {
    const env = (name: string): string | undefined =>
      ({ PROWLARR_API_KEY: 'env-key', PROWLARR_URL: 'http://env:9696', QBITTORRENT_PASSWORD: 'qp', ACQUIRE_DOWNLOAD_DIR: '/data' })[name]
    expect(resolveConfig({}, env)).toMatchObject({
      prowlarrApiKey: 'env-key', prowlarrUrl: 'http://env:9696', toolPrefix: 'acquire',
      qbittorrentPassword: 'qp', downloadDir: '/data', torrentClients: ['qbittorrent', 'transmission'],
      selectMode: 'all', importMode: 'hardlink',
    })
    expect(resolveConfig({}, () => undefined)).toMatchObject({ prowlarrApiKey: '', prowlarrUrl: 'http://localhost:9696' })
  })
  it('treats schemastery-filled empty arrays as defaults', () => {
    // Schemastery validates a missing array as []; that must mean "default",
    // or a bare mount would reject every download (accept: [] matches nothing).
    const validated = AcquisitionPlugin.Config({})
    expect(resolveConfig(validated, () => undefined)).toMatchObject({
      accept: ['*'],
      torrentClients: ['qbittorrent', 'transmission'],
    })
  })
  it('rejects unknown enums', () => {
    expect(() => resolveConfig({ torrentClients: ['deluge'] }, () => undefined)).toThrow("unknown backend 'deluge'")
    expect(() => resolveConfig({ selectMode: 'random' }, () => undefined)).toThrow('selectMode')
    expect(() => resolveConfig({ importMode: 'symlink' }, () => undefined)).toThrow('importMode')
  })
})

// ── tools through the real registry ────────────────────────────────────────

async function mount(config: AcquisitionPlugin.Config = {}): Promise<{
  ctx: Context
  call: (name: string, args: unknown) => Promise<{ isError: boolean; value: unknown; content: ReadonlyArray<{ type: string; text?: string }> }>
}> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AcquisitionPlugin, config)
  let n = 0
  const call = (name: string, args: unknown): Promise<{ isError: boolean; value: unknown; content: ReadonlyArray<{ type: string; text?: string }> }> =>
    ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`c${String(++n)}`), name, arguments: args }) as never
  return { ctx, call }
}

function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.map(block => block.text ?? '').join('')
}

describe('registered tools', () => {
  it('registers both tools under the configured prefix', async () => {
    const { ctx } = await mount({ downloadDir: tmpRoot(), toolPrefix: 'dl' })
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toContain('dl_submit')
    expect(names).toContain('dl_status')
    expect(names).not.toContain('acquire_submit')
  })
  it('submits and polls through the registry with rendered text', async () => {
    routes['/doc'] = { status: 200, body: '%PDF-1.4 fake-bytes' }
    const { call } = await mount({ downloadDir: tmpRoot(), allowPrivateHosts: true })
    const submitted = await call('acquire_submit', { url: `${filesUrl}/doc`, title: 'Doc' })
    expect(submitted.isError).toBe(false)
    const value = submitted.value as AcquireResult
    expect(value.state).toBe('completed')
    expect(value.files).toHaveLength(1)
    expect(textOf(submitted)).toContain('completed')
    expect(textOf(submitted)).toContain('.pdf')
    const polled = await call('acquire_status', { handle: value.handle })
    expect(polled.isError).toBe(false)
    expect((polled.value as AcquireResult).state).toBe('completed')
  })
  it('reports invalid input as tool errors', async () => {
    const { call } = await mount({ downloadDir: tmpRoot(), allowPrivateHosts: true })
    expect((await call('acquire_submit', {})).isError).toBe(true)
    expect((await call('acquire_submit', { url: `${filesUrl}/x`, waitMs: -1 })).isError).toBe(true)
    expect((await call('acquire_status', { handle: '' })).isError).toBe(true)
    expect((await call('acquire_status', { handle: 'acq_nope' })).isError).toBe(true)
  })
})
