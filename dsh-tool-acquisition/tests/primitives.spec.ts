import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  base32Decode,
  decode,
  isTorrent,
  magnetDisplayName,
  magnetInfoHash,
  parseTorrent,
} from '../src/bencode.ts'
import { AcquisitionError, UnsafeURLError } from '../src/errors.ts'
import { fetchDirect, safeFilename } from '../src/fetch.ts'
import { checkFetchTarget, hostMatches, ipIsPublic } from '../src/fetchSafety.ts'
import {
  detectMime,
  extensionForMime,
  mediaKind,
  mimeFromExtension,
  mimeMatches,
  sniffBytes,
} from '../src/filetype.ts'
import { applyPathMappings, importFiles } from '../src/importer.ts'
import { ProwlarrDownload, proxyUrl } from '../src/prowlarr.ts'
import {
  describeUrl,
  hasTokenLikeSegment,
  isSensitiveParam,
  publicUrl,
  redactText,
  stripSensitiveParams,
} from '../src/redact.ts'
import { SelectionPolicy } from '../src/selection.ts'
import { HandleStore } from '../src/store.ts'

const KEY = 'abc123secretkey'
const tmpRoots: string[] = []
function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acq-prim-'))
  tmpRoots.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true })
})

// ── redact ─────────────────────────────────────────────────────────────────

describe('redact', () => {
  it('replaces known secrets and ignores short ones', () => {
    expect(redactText(`key=${KEY} ok`, [KEY])).toBe('key=[REDACTED] ok')
    expect(redactText('abc', ['abc'])).toBe('abc')
    expect(redactText('x', [undefined])).toBe('x')
  })
  it('spots credential-like query parameters', () => {
    for (const name of ['apikey', 'API_KEY', 'passkey', 'torrent_pass', 'auth-token', 'sid']) {
      expect(isSensitiveParam(name)).toBe(true)
    }
    expect(isSensitiveParam('link')).toBe(false)
    expect(isSensitiveParam('file')).toBe(false)
  })
  it('strips sensitive params and userinfo but keeps the usable rest', () => {
    expect(stripSensitiveParams(`http://user:pw@h/1/download?apikey=${KEY}&link=x&file=y`, [KEY]))
      .toBe('http://h/1/download?link=x&file=y')
    expect(stripSensitiveParams('not a url', [KEY])).toBe('not a url')
  })
  it('detects token-like path segments', () => {
    expect(hasTokenLikeSegment('http://h/rss/AbC123xYz901234567890/foo')).toBe(true)
    expect(hasTokenLikeSegment('http://h/1/download')).toBe(false)
    expect(hasTokenLikeSegment('::::')).toBe(true)
  })
  it('publishes only clean http(s) URLs', () => {
    expect(publicUrl('magnet:?xt=urn:btih:abc')).toBeUndefined()
    expect(publicUrl(`https://u:p@h/path?apikey=${KEY}&a=b#frag`, [KEY])).toBe('https://h/path?a=b')
    expect(publicUrl(`https://h/${KEY}/x`, [KEY])).toBeUndefined()
    expect(publicUrl('https://h/rss/AbC123xYz901234567890', [], { rejectTokenPaths: true })).toBeUndefined()
    expect(publicUrl('  ')).toBeUndefined()
  })
  it('describes URLs without secrets', () => {
    expect(describeUrl('magnet:?xt=urn:btih:abc')).toBe('magnet:<…>')
    expect(describeUrl(`https://h:8443/a/b?apikey=${KEY}`)).toBe('https://h/…')
    expect(describeUrl('::::')).toBe('<invalid url>')
  })
})

// ── fetchSafety ────────────────────────────────────────────────────────────

describe('fetchSafety', () => {
  it('matches hosts with subdomain semantics', () => {
    expect(hostMatches('sub.example.org', ['example.org'])).toBe(true)
    expect(hostMatches('example.org', ['example.org'])).toBe(true)
    expect(hostMatches('example.org', ['*.example.org'])).toBe(false)
    expect(hostMatches('sub.example.org', ['*.example.org'])).toBe(true)
    expect(hostMatches('evil.org', ['example.org'])).toBe(false)
    expect(hostMatches('Example.ORG.', ['example.org'])).toBe(true)
  })
  it('classifies literal IPs', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.1.1', '0.0.0.0', '224.0.0.1', '100.64.0.1', '192.0.2.1', '::1', '::', 'fe80::1', 'fc00::1', 'ff02::1', '2001:db8::1', '::ffff:127.0.0.1']) {
      expect(ipIsPublic(ip)).toBe(false)
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      expect(ipIsPublic(ip)).toBe(true)
    }
    expect(ipIsPublic('not-an-ip')).toBe(false)
  })
  it('refuses bad schemes, unlisted hosts, and private literals', async () => {
    await expect(checkFetchTarget('ftp://h/x')).rejects.toBeInstanceOf(UnsafeURLError)
    await expect(checkFetchTarget('http://evil.org/x', { allowedHosts: ['example.org'] })).rejects.toThrow('not in allowedHosts')
    await expect(checkFetchTarget('http://127.0.0.1:9/x')).rejects.toThrow('not public')
    await checkFetchTarget('http://127.0.0.1:9/x', { allowPrivate: true })
  })
  it('refuses non-public DNS resolutions without allowPrivate', async () => {
    // localhost resolves to loopback (or fails to resolve); either way it throws.
    await expect(checkFetchTarget('http://localhost:9/x')).rejects.toBeInstanceOf(UnsafeURLError)
    await checkFetchTarget('http://localhost:9/x', { allowPrivate: true })
  })
})

// ── filetype ───────────────────────────────────────────────────────────────

function bytes(ascii: string): Uint8Array {
  return new TextEncoder().encode(ascii)
}

describe('filetype', () => {
  it('sniffs magic bytes', () => {
    expect(sniffBytes(bytes('%PDF-1.7'))).toBe('application/pdf')
    expect(sniffBytes(bytes('magnet:?xt=urn:btih:x'))).toBe('text/x-magnet')
    expect(sniffBytes(bytes('d8:announce4:infoe'))).toBe('application/x-bittorrent')
    expect(sniffBytes(bytes('<?xml version="1.0"?><nzb>'))).toBe('application/x-nzb')
    expect(sniffBytes(bytes('<?xml version="1.0"?><svg>'))).toBe('image/svg+xml')
    expect(sniffBytes(bytes('<!DOCTYPE html><html>'))).toBe('text/html')
    expect(sniffBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
    expect(sniffBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe('application/zip')
    expect(sniffBytes(new Uint8Array([0x1f, 0x8b, 0x08]))).toBe('application/gzip')
    expect(sniffBytes(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x77, 0x65, 0x62, 0x6d]))).toBe('video/webm')
    expect(sniffBytes(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))).toBe('video/x-matroska')
    expect(sniffBytes(bytes('fLaC'))).toBe('audio/flac')
    expect(sniffBytes(bytes('OggS'))).toBe('audio/ogg')
    expect(sniffBytes(bytes('ID3'))).toBe('audio/mpeg')
    expect(sniffBytes(new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]))).toBe('video/mp4')
    expect(sniffBytes(new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]))).toBe('audio/mp4')
    expect(sniffBytes(bytes('AT&TFORMxxxxDJV'))).toBe('image/vnd.djvu')
    expect(sniffBytes(bytes('plain text here'))).toBeUndefined()
    expect(sniffBytes(new Uint8Array(0))).toBeUndefined()
  })
  it('classifies kinds and matches patterns', () => {
    expect(mediaKind('application/x-bittorrent')).toBe('torrent')
    expect(mediaKind('text/x-magnet')).toBe('torrent')
    expect(mediaKind('application/x-nzb')).toBe('nzb')
    expect(mediaKind('application/epub+zip')).toBe('document')
    expect(mediaKind('application/zip')).toBe('archive')
    expect(mediaKind('video/mp4')).toBe('video')
    expect(mediaKind('application/vnd.api+json')).toBe('text')
    expect(mediaKind(undefined)).toBe('other')
    expect(mimeMatches('video/mp4', ['video'])).toBe(true)
    expect(mimeMatches('video/mp4', ['*'])).toBe(true)
    expect(mimeMatches('image/png', ['image/*'])).toBe(true)
    expect(mimeMatches('application/pdf', ['application/pdf'])).toBe(true)
    expect(mimeMatches('video/mp4', ['audio'])).toBe(false)
    expect(mimeMatches('video/mp4; charset=x', ['video'])).toBe(true)
  })
  it('maps extensions both ways', () => {
    expect(mimeFromExtension('Show.S01E01.mkv')).toBe('video/x-matroska')
    expect(mimeFromExtension('/tmp/a.MP4')).toBe('video/mp4')
    expect(mimeFromExtension('noext')).toBeUndefined()
    expect(extensionForMime('video/mp4')).toBe('.mp4')
    expect(extensionForMime('application/x-bittorrent')).toBe('.torrent')
    expect(extensionForMime('application/unknown-xyz')).toBe('')
  })
  it('detects from content before extension, with text and octet fallbacks', () => {
    const dir = tmpRoot()
    const lying = join(dir, 'movie.mp4')
    writeFileSync(lying, '%PDF-1.4 fake')
    expect(detectMime(lying)).toBe('application/pdf')
    const extOnly = join(dir, 'clip.mp4')
    writeFileSync(extOnly, 'no magic here at all, just words')
    expect(detectMime(extOnly)).toBe('video/mp4')
    const text = join(dir, 'notes.unknownext')
    writeFileSync(text, 'plain words')
    expect(detectMime(text)).toBe('text/plain')
    const binary = join(dir, 'blob.unknownext')
    writeFileSync(binary, new Uint8Array([0, 1, 2, 3, 255, 254]))
    expect(detectMime(binary)).toBe('application/octet-stream')
    expect(detectMime(join(dir, 'missing'))).toBe('application/octet-stream')
  })

  it('refines zip containers', () => {
    const dir = tmpRoot()
    const zip = makeZip([{ name: 'a.txt', data: bytes('hello') }])
    const plain = join(dir, 'a.zip')
    writeFileSync(plain, zip)
    expect(detectMime(plain)).toBe('application/zip')
    const cbz = makeZip([{ name: 'p1.jpg', data: bytes('x') }, { name: 'p2.png', data: bytes('y') }])
    const comic = join(dir, 'c.zip')
    writeFileSync(comic, cbz)
    expect(detectMime(comic)).toBe('application/vnd.comicbook+zip')
    const ooxml = makeZip([{ name: '[Content_Types].xml', data: bytes('x') }, { name: 'word/doc.xml', data: bytes('y') }])
    const doc = join(dir, 'd.zip')
    writeFileSync(doc, ooxml)
    expect(detectMime(doc)).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  })
})

/** Build a minimal stored (uncompressed) ZIP from members. */
function makeZip(members: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const enc = new TextEncoder()
  const locals: number[] = []
  const central: number[] = []
  let offset = 0
  for (const m of members) {
    const name = Array.from(enc.encode(m.name))
    const local: number[] = []
    const u32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
    const u16 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff]
    local.push(...[0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
    local.push(...u32(0), ...u32(m.data.length), ...u32(m.data.length), ...u16(name.length), ...u16(0), ...name)
    locals.push(...local, ...Array.from(m.data))
    central.push(
      ...[0x50, 0x4b, 0x01, 0x02, 0x14, 0x00, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
      ...u32(0), ...u32(m.data.length), ...u32(m.data.length), ...u16(name.length),
      ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name,
    )
    offset += local.length + m.data.length
  }
  const dirOffset = locals.length
  const u32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
  const u16 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff]
  const eocd = [0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00, ...u16(members.length), ...u16(members.length), ...u32(central.length), ...u32(dirOffset), ...u16(0)]
  return new Uint8Array([...locals, ...central, ...eocd])
}

// ── bencode ────────────────────────────────────────────────────────────────

describe('bencode', () => {
  it('decodes integers, strings, lists, and dicts', () => {
    expect(decode(bytes('i42e'))).toBe(42)
    expect(Buffer.from(decode(bytes('4:spam')) as Uint8Array).toString()).toBe('spam')
    const list = decode(bytes('l4:spam4:eggse')) as unknown[]
    expect(list).toHaveLength(2)
    const dict = decode(bytes('d3:cow3:moo4:spam4:eggse')) as Map<string, Uint8Array>
    expect(Buffer.from(dict.get('cow') as Uint8Array).toString()).toBe('moo')
  })
  it('rejects malformed input', () => {
    expect(() => decode(bytes('i03e'))).toThrow('invalid integer')
    expect(() => decode(bytes('4:spa'))).toThrow('past end')
    expect(() => decode(bytes('i42'))).toThrow()
    expect(() => decode(bytes('x'))).toThrow('unexpected byte')
    expect(() => decode(new TextEncoder().encode(`${'l'.repeat(70)}${'e'.repeat(70)}`))).toThrow('nesting too deep')
  })
  it('parses a torrent and hashes the raw info dict', () => {
    const info = 'd6:lengthi12345e4:name8:test.bin12:piece lengthi16384e6:pieces20:AAAAAAAAAAAAAAAAAAAA'
    const torrent = new TextEncoder().encode(`d8:announce8:http://x4:info${info}ee`)
    const meta = parseTorrent(torrent)
    expect(meta.name).toBe('test.bin')
    expect(meta.files).toEqual([{ path: 'test.bin', size: 12345 }])
    expect(meta.priv).toBe(false)
    expect(meta.totalSize).toBe(12345)
    // The hashed span is the full info dict including its closing 'e'.
    expect(meta.infoHash).toBe(createHash('sha1').update(`${info}e`, 'latin1').digest('hex'))
    expect(isTorrent(torrent)).toBe(true)
    expect(isTorrent(bytes('not a torrent'))).toBe(false)
  })
  it('extracts info-hashes and display names from magnets', () => {
    const hex = '43f4001de4ab25d521c63684e2b69804193ed9d9'
    expect(magnetInfoHash(`magnet:?xt=urn:btih:${hex}&dn=Sintel`)).toBe(hex)
    expect(magnetInfoHash('magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBe('00'.repeat(20))
    expect(magnetInfoHash('magnet:?xt=urn:btih:ZZZ')).toBeUndefined()
    expect(magnetInfoHash('http://h/x')).toBeUndefined()
    expect(magnetDisplayName(`magnet:?xt=urn:btih:${hex}&dn=Sintel`)).toBe('Sintel')
    expect(magnetDisplayName('magnet:?xt=urn:btih:abc')).toBeUndefined()
  })
  it('decodes base32', () => {
    expect(Buffer.from(base32Decode('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toString('hex')).toBe('00'.repeat(20))
    expect(() => base32Decode('!!!!')).toThrow('invalid base32')
  })
})

// ── selection ──────────────────────────────────────────────────────────────

describe('selection', () => {
  it('filters by type, size, and name with content sniffing', () => {
    const dir = tmpRoot()
    const mp4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 1, 2, 3])
    writeFileSync(join(dir, 'movie.mp4'), mp4)
    writeFileSync(join(dir, 'sample-movie.mp4'), mp4)
    writeFileSync(join(dir, 'notes.txt'), 'hello')
    writeFileSync(join(dir, 'info.nfo'), 'nfo')
    const policy = new SelectionPolicy({ accept: ['video'] })
    expect(policy.selectFiles(dir).map(f => f.path)).toEqual([join(dir, 'movie.mp4')])
    expect(new SelectionPolicy({ accept: ['*'] }).selectFiles(dir).map(f => f.path).sort()).toEqual(
      [join(dir, 'movie.mp4'), join(dir, 'notes.txt')].sort(),
    )
    expect(new SelectionPolicy({ accept: ['*'], reject: ['text'] }).selectFiles(dir)).toHaveLength(1)
    expect(new SelectionPolicy({ accept: ['*'], minSize: 1_000_000 }).selectFiles(dir)).toHaveLength(0)
  })
  it('keeps only the largest in largest mode', () => {
    const dir = tmpRoot()
    writeFileSync(join(dir, 'a.bin'), new Uint8Array([1, 2, 3]))
    writeFileSync(join(dir, 'b.bin'), new Uint8Array([1, 2, 3, 4, 5]))
    const chosen = new SelectionPolicy({ accept: ['*'], mode: 'largest' }).selectFiles(dir)
    expect(chosen).toHaveLength(1)
    expect(chosen[0]?.path).toBe(join(dir, 'b.bin'))
  })
  it('accepts a lone file and answers unknown extensions with undefined', () => {
    const dir = tmpRoot()
    const file = join(dir, 'clip.mp4')
    writeFileSync(file, 'words without magic')
    expect(new SelectionPolicy({ accept: ['video'] }).selectFiles(file)).toHaveLength(1)
    const policy = new SelectionPolicy()
    expect(policy.acceptsName('x.weirdext99')).toBeUndefined()
    expect(policy.acceptsName('sample-x.mp4')).toBe(false)
    expect(policy.selectFiles(join(dir, 'missing'))).toEqual([])
  })
})

// ── importer ───────────────────────────────────────────────────────────────

describe('importer', () => {
  it('maps the longest matching remote prefix', () => {
    expect(applyPathMappings('/downloads/a/b', ['/downloads=/mnt'])).toBe('/mnt/a/b')
    expect(applyPathMappings('/downloads/a', ['/downloads=/mnt', '/downloads/a=/ssd'])).toBe('/ssd')
    expect(applyPathMappings('C:\\dl\\a', ['C:/dl=/mnt'])).toBe('/mnt/a')
    expect(applyPathMappings('/other/a', ['/downloads=/mnt'])).toBe('/other/a')
    expect(applyPathMappings('/downloads/a', ['no-equals-here'])).toBe('/downloads/a')
  })
  it('imports by hardlink, copy, move, and inplace', () => {
    const dir = tmpRoot()
    const src = join(dir, 'src')
    mkdirSync(join(src, 'sub'), { recursive: true })
    writeFileSync(join(src, 'sub', 'f.txt'), 'data')
    const file = join(src, 'sub', 'f.txt')
    const hard = importFiles([file], join(dir, 'hard'), { mode: 'hardlink', root: src })
    expect(hard).toEqual([join(dir, 'hard', 'sub', 'f.txt')])
    expect(statSync(hard[0] as string).ino).toBe(statSync(file).ino)
    const copied = importFiles([file], join(dir, 'copy'), { mode: 'copy' })
    expect(statSync(copied[0] as string).ino).not.toBe(statSync(file).ino)
    expect(importFiles([file], join(dir, 'nope'), { mode: 'inplace' })).toEqual([file])
    const moved = importFiles([copied[0] as string], join(dir, 'moved'), { mode: 'move' })
    expect(moved).toHaveLength(1)
    expect(() => importFiles([file], dir, { mode: 'bogus' as never })).toThrow('import mode')
  })
})

// ── store ──────────────────────────────────────────────────────────────────

describe('store', () => {
  it('round-trips records and tolerates a missing file', async () => {
    const dir = tmpRoot()
    const store = new HandleStore(join(dir, 'handles.json'))
    await expect(store.get('nope')).resolves.toBeUndefined()
    const record = {
      id: 'acq_1', backend: 'qbittorrent', handle: { info_hash: 'abc' }, title: 't',
      createdAt: '2026-01-01', updatedAt: '2026-01-01', state: 'queued' as const, progress: 0, files: [],
    }
    await store.put(record)
    await expect(store.get('acq_1')).resolves.toEqual(record)
    // A fresh instance (a restart) still resolves the handle.
    await expect(new HandleStore(join(dir, 'handles.json')).get('acq_1')).resolves.toEqual(record)
    await store.remove('acq_1')
    await expect(store.get('acq_1')).resolves.toBeUndefined()
    await expect(store.all()).resolves.toEqual([])
  })
  it('rejects a corrupt store file', async () => {
    const dir = tmpRoot()
    const file = join(dir, 'handles.json')
    writeFileSync(file, '{not json')
    await expect(new HandleStore(file).get('x')).rejects.toBeInstanceOf(AcquisitionError)
  })
})

// ── fetch + prowlarr over fake HTTP ────────────────────────────────────────

let server: Server
let origin: string
const bodies: Record<string, { status: number; headers?: Record<string, string>; body: Uint8Array | string }> = {}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/1/download') {
      if (req.headers['x-api-key'] !== KEY) {
        res.writeHead(401, { 'content-type': 'text/plain' }); res.end('unauthorized'); return
      }
      res.writeHead(200, { 'content-type': 'application/x-bittorrent' })
      res.end(Buffer.from('d8:announce8:http://x4:infod6:lengthi1e4:name8:test.bin12:piece lengthi1e6:pieces20:AAAAAAAAAAAAAAAAAAAAee'))
      return
    }
    if (url.pathname === '/2/download') {
      res.writeHead(302, { location: `${origin}/external/file.bin` }); res.end(); return
    }
    if (url.pathname === '/redir') {
      res.writeHead(302, { location: '/file' }); res.end(); return
    }
    if (url.pathname === '/tomagnet') {
      res.writeHead(302, { location: 'magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }); res.end(); return
    }
    if (url.pathname === '/loop') {
      res.writeHead(302, { location: '/loop' }); res.end(); return
    }
    const route = bodies[url.pathname]
    if (route === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' }); res.end('nope'); return
    }
    res.writeHead(route.status, { 'content-type': 'application/octet-stream', ...route.headers })
    res.end(route.body)
  })
  const address = await new Promise<AddressInfo>((resolve) => {
    server.listen(0, '127.0.0.1', () => { resolve(server.address() as AddressInfo) })
  })
  origin = `http://127.0.0.1:${String(address.port)}`
})
afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
})

const POLICY = {
  maxBytes: 1024 * 1024,
  timeoutMs: 5_000,
  maxRedirects: 5,
  allowedHosts: [] as string[],
  allowPrivateHosts: true,
  userAgent: 'test',
}

describe('fetch', () => {
  it('sanitizes filenames', () => {
    expect(safeFilename('../../etc/passwd')).not.toContain('/')
    expect(safeFilename('  ')).toBe('download')
    expect(safeFilename('a'.repeat(300)).length).toBeLessThanOrEqual(180)
    expect(safeFilename('hello world.mp4')).toBe('hello world.mp4')
  })
  it('downloads a file and fixes its extension from sniffed content', async () => {
    bodies['/file'] = { status: 200, body: '%PDF-1.4 fake-bytes' }
    const outcome = await fetchDirect(`${origin}/file`, tmpRoot(), POLICY, { filenameHint: 'report' })
    expect(outcome.kind).toBe('file')
    if (outcome.kind !== 'file') return
    expect(outcome.file.path.endsWith('.pdf')).toBe(true)
    expect(outcome.file.mime).toBe('application/pdf')
    // describeUrl keeps scheme://host only (no port), matching the reference implementation.
    expect(outcome.file.finalUrl).toBe('http://127.0.0.1/…')
  })
  it('follows redirects, surfaces magnets, and bounds loops', async () => {
    bodies['/file'] = { status: 200, body: 'data' }
    const followed = await fetchDirect(`${origin}/redir`, tmpRoot(), POLICY, { filenameHint: 'f' })
    expect(followed.kind).toBe('file')
    const magnet = await fetchDirect(`${origin}/tomagnet`, tmpRoot(), POLICY)
    expect(magnet).toEqual({ kind: 'magnet', magnet: 'magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })
    await expect(fetchDirect(`${origin}/loop`, tmpRoot(), POLICY)).rejects.toMatchObject({ code: 'ACQUIRE_FETCH_ERROR' })
  })
  it('classifies HTTP failures and enforces the byte cap', async () => {
    await expect(fetchDirect(`${origin}/missing`, tmpRoot(), POLICY)).rejects.toMatchObject({ code: 'ACQUIRE_FETCH_ERROR' })
    bodies['/big'] = { status: 200, headers: { 'content-length': '999999999' }, body: 'x' }
    await expect(fetchDirect(`${origin}/big`, tmpRoot(), POLICY)).rejects.toMatchObject({ code: 'ACQUIRE_TOO_LARGE' })
    bodies['/stream-big'] = { status: 200, body: 'y'.repeat(100) }
    await expect(fetchDirect(`${origin}/stream-big`, tmpRoot(), { ...POLICY, maxBytes: 10 })).rejects.toMatchObject({ code: 'ACQUIRE_TOO_LARGE' })
  })
  it('refuses private targets unless allowed', async () => {
    bodies['/file'] = { status: 200, body: 'data' }
    await expect(fetchDirect(`${origin}/file`, tmpRoot(), { ...POLICY, allowPrivateHosts: false }))
      .rejects.toBeInstanceOf(UnsafeURLError)
  })
})

describe('prowlarr proxy', () => {
  it('maps proxy links onto the configured origin without secrets', () => {
    expect(proxyUrl(`http://other:9999/prowlarr/1/download?apikey=${KEY}&link=x`, `${origin}/prowlarr`, KEY))
      .toBe(`${origin}/prowlarr/1/download?link=x`)
    expect(proxyUrl(`${origin}/external/file.bin`, origin, KEY)).toBeUndefined()
    expect(proxyUrl('::::', origin, KEY)).toBeUndefined()
  })
  it('resolves magnets and external links without network', async () => {
    const client = new ProwlarrDownload({ baseUrl: origin, apiKey: KEY, timeoutMs: 5_000, maxBytes: 1024, userAgent: 'test' })
    await expect(client.resolve('magnet:?xt=urn:btih:x', tmpRoot(), 't'))
      .resolves.toEqual({ kind: 'magnet', magnet: 'magnet:?xt=urn:btih:x' })
    // Off-origin links resolve without network; same-origin links are fetched.
    await expect(client.resolve('http://example.com/external/file.bin', tmpRoot(), 't'))
      .resolves.toEqual({ kind: 'redirect', target: 'http://example.com/external/file.bin' })
  })
  it('fetches proxy bodies with the key in the header only', async () => {
    const client = new ProwlarrDownload({ baseUrl: origin, apiKey: KEY, timeoutMs: 5_000, maxBytes: 1024 * 1024, userAgent: 'test' })
    const resolved = await client.resolve(`${origin}/1/download?apikey=${KEY}&link=x`, tmpRoot(), 'rel')
    expect(resolved.kind).toBe('file')
    if (resolved.kind !== 'file') return
    expect(resolved.file.mime).toBe('application/x-bittorrent')
    expect(resolved.file.path.endsWith('.torrent')).toBe(true)
  })
  it('follows proxy redirects without credentials and classifies auth failures', async () => {
    const client = new ProwlarrDownload({ baseUrl: origin, apiKey: KEY, timeoutMs: 5_000, maxBytes: 1024, userAgent: 'test' })
    await expect(client.resolve(`${origin}/2/download`, tmpRoot(), 't'))
      .resolves.toEqual({ kind: 'redirect', target: `${origin}/external/file.bin` })
    const wrong = new ProwlarrDownload({ baseUrl: origin, apiKey: 'wrong', timeoutMs: 5_000, maxBytes: 1024, userAgent: 'test' })
    await expect(wrong.resolve(`${origin}/1/download`, tmpRoot(), 't')).rejects.toMatchObject({ code: 'ACQUIRE_PROWLARR_AUTH' })
    const unconfigured = new ProwlarrDownload({ baseUrl: origin, apiKey: '', timeoutMs: 5_000, maxBytes: 1024, userAgent: 'test' })
    await expect(unconfigured.resolve(`${origin}/1/download`, tmpRoot(), 't')).rejects.toMatchObject({ code: 'ACQUIRE_NOT_CONFIGURED' })
  })
})
