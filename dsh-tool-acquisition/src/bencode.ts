/**
 * Minimal bencode decoder plus torrent and magnet helpers. Ported from
 * Haven CLI's `acquisition/bencode.py`: only what acquisition needs —
 * validate a `.torrent`, compute its v1 info-hash from the raw `info`
 * bytes, list its files, and parse the info-hash out of a magnet link.
 *
 * @module dsh-tool-acquisition/bencode
 */

import { createHash } from 'node:crypto'
import { AcquisitionError } from './errors.ts'

const MAX_DEPTH = 64

type BencodeValue = number | Uint8Array | BencodeValue[] | Map<string, BencodeValue>

function fail(message: string): never {
  throw new AcquisitionError(message, 'ACQUIRE_INVALID_TORRENT', { permanent: true })
}

function decodeAt(data: Uint8Array, pos: number, depth: number, spans: Map<string, { start: number; end: number }> | undefined): { value: BencodeValue; end: number } {
  if (depth > MAX_DEPTH) fail('nesting too deep')
  if (pos >= data.length) fail('unexpected end of data')
  const lead = data[pos] ?? 0
  if (lead === 0x69) { // i
    let end = pos + 1
    while (end < data.length && data[end] !== 0x65) end += 1
    if (end >= data.length) fail('unterminated integer')
    const raw = Buffer.from(data.slice(pos + 1, end)).toString('ascii')
    if (!/^-?\d+$/.test(raw) || ((raw.startsWith('-0') || (raw.startsWith('0') && raw !== '0')))) fail(`invalid integer '${raw}'`)
    return { value: Number(raw), end: end + 1 }
  }
  if (lead === 0x6c) { // l
    let cursor = pos + 1
    const items: BencodeValue[] = []
    while ((data[cursor] ?? 0) !== 0x65) {
      const item = decodeAt(data, cursor, depth + 1, undefined)
      items.push(item.value)
      cursor = item.end
    }
    return { value: items, end: cursor + 1 }
  }
  if (lead === 0x64) { // d
    let cursor = pos + 1
    const result = new Map<string, BencodeValue>()
    while ((data[cursor] ?? 0) !== 0x65) {
      const key = decodeAt(data, cursor, depth + 1, undefined)
      if (!(key.value instanceof Uint8Array)) fail('dictionary key is not a string')
      const name = Buffer.from(key.value).toString('latin1')
      const start = key.end
      const val = decodeAt(data, start, depth + 1, undefined)
      if (spans !== undefined && depth === 0) spans.set(name, { start, end: val.end })
      result.set(name, val.value)
      cursor = val.end
    }
    return { value: result, end: cursor + 1 }
  }
  if (lead >= 0x30 && lead <= 0x39) {
    let colon = pos
    while (colon < data.length && data[colon] !== 0x3a) colon += 1
    if (colon >= data.length) fail('unterminated string length')
    const length = Number(Buffer.from(data.slice(pos, colon)).toString('ascii'))
    if (!Number.isInteger(length) || length < 0) fail('invalid string length')
    const start = colon + 1
    const end = start + length
    if (end > data.length) fail('string runs past end of data')
    return { value: data.slice(start, end), end }
  }
  fail(`unexpected byte 0x${lead.toString(16)} at ${pos}`)
}

/** Decode a complete bencoded value. */
export function decode(data: Uint8Array): BencodeValue {
  try {
    return decodeAt(data, 0, 0, undefined).value
  } catch (error: unknown) {
    if (error instanceof AcquisitionError) throw error
    fail(`invalid bencoded data: ${String(error)}`)
  }
}

/** One file inside a torrent. */
export interface TorrentFile {
  path: string
  size: number
}

/** Facts parsed from a `.torrent` file. */
export interface TorrentMeta {
  /** v1 SHA-1 hex; `''` for v2-only torrents. */
  infoHash: string
  name: string
  files: TorrentFile[]
  priv: boolean
  totalSize: number
}

function utf8(raw: BencodeValue | undefined): string {
  if (raw instanceof Uint8Array) return Buffer.from(raw).toString('utf8')
  return String(raw ?? '')
}

function walkV2Tree(tree: Map<string, BencodeValue>, prefix: string[], out: TorrentFile[]): void {
  for (const [key, value] of tree) {
    if (key === '' && value instanceof Map) {
      const length = value.get('length')
      out.push({ path: prefix.join('/'), size: typeof length === 'number' ? length : 0 })
    } else if (value instanceof Map) {
      walkV2Tree(value, [...prefix, key], out)
    }
  }
}

/**
 * Validate a `.torrent` and extract hash, name, and file list.
 * @throws AcquisitionError (`ACQUIRE_INVALID_TORRENT`) when `data` is not a torrent.
 */
export function parseTorrent(data: Uint8Array): TorrentMeta {
  const spans = new Map<string, { start: number; end: number }>()
  let root: BencodeValue
  try {
    root = decodeAt(data, 0, 0, spans).value
  } catch (error: unknown) {
    if (error instanceof AcquisitionError) throw error
    fail(`invalid bencoded data: ${String(error)}`)
  }
  if (!(root instanceof Map)) fail('not a torrent: top level is not a dictionary')
  const info = root.get('info')
  if (!(info instanceof Map)) fail('not a torrent: missing info dictionary')
  const span = spans.get('info')
  if (span === undefined) fail('not a torrent: cannot locate info dictionary')
  const infoHash = info.has('pieces') ? createHash('sha1').update(data.slice(span.start, span.end)).digest('hex') : ''
  const name = utf8(info.get('name.utf-8') ?? info.get('name'))
  const files: TorrentFile[] = []
  const multi = info.get('files')
  if (Array.isArray(multi)) {
    for (const entry of multi) {
      if (!(entry instanceof Map)) continue
      const parts = entry.get('path.utf-8') ?? entry.get('path')
      if (!Array.isArray(parts)) continue
      const rel = parts.filter((p): p is Uint8Array => p instanceof Uint8Array).map(p => Buffer.from(p).toString('utf8')).join('/')
      const length = entry.get('length')
      files.push({ path: name !== '' ? `${name}/${rel}` : rel, size: typeof length === 'number' ? length : 0 })
    }
  } else if (typeof info.get('length') === 'number') {
    files.push({ path: name, size: info.get('length') as number })
  } else {
    const tree = info.get('file tree')
    if (tree instanceof Map) walkV2Tree(tree, name !== '' ? [name] : [], files)
  }
  return { infoHash, name, files, priv: info.get('private') === 1, totalSize: files.reduce((n, f) => n + f.size, 0) }
}

/** Whether `data` parses as a `.torrent`. */
export function isTorrent(data: Uint8Array): boolean {
  try {
    parseTorrent(data)
    return true
  } catch {
    return false
  }
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Decode an unpadded base32 string (magnet `btih`). */
export function base32Decode(value: string): Uint8Array {
  let bits = 0
  let width = 0
  const out: number[] = []
  for (const char of value.toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(char)
    if (index < 0) fail(`invalid base32 character '${char}'`)
    bits = (bits << 5) | index
    width += 5
    if (width >= 8) {
      width -= 8
      out.push((bits >>> width) & 0xff)
    }
  }
  return new Uint8Array(out)
}

/** Lower-case hex v1 info-hash from a magnet URI (hex or base32 `btih`). */
export function magnetInfoHash(uri: string): string | undefined {
  if (!uri.toLowerCase().startsWith('magnet:')) return undefined
  let query: URLSearchParams
  try {
    query = new URL(uri).searchParams
  } catch {
    return undefined
  }
  for (const xt of query.getAll('xt')) {
    if (!xt.toLowerCase().startsWith('urn:btih:')) continue
    const value = xt.slice(9)
    if (/^[0-9a-fA-F]{40}$/.test(value)) return value.toLowerCase()
    if (/^[A-Za-z2-7]{32}$/.test(value)) {
      try {
        return Buffer.from(base32Decode(value)).toString('hex')
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

/** Display name (`dn`) from a magnet URI, if present. */
export function magnetDisplayName(uri: string): string | undefined {
  try {
    return new URL(uri).searchParams.get('dn') ?? undefined
  } catch {
    return undefined
  }
}
