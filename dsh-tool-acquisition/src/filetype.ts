/**
 * Content-based file type detection. Ported from Haven CLI's
 * `media/filetype.py`: magic bytes first, ZIP-container refinement, then
 * extension, then a text heuristic. Types are sniffed from content, never
 * trusted from extensions, because indexer files often lie.
 *
 * @module dsh-tool-acquisition/filetype
 */

import { readFileSync } from 'node:fs'

/** Coarse kinds, in the order checked by {@link mediaKind}. */
export const MEDIA_KINDS = ['video', 'audio', 'image', 'document', 'text', 'archive', 'torrent', 'nzb', 'other'] as const
/** One coarse kind. */
export type MediaKind = (typeof MEDIA_KINDS)[number]

/** Kinds that describe *where* content is, not content. Never archived as-is. */
export const POINTER_KINDS: ReadonlySet<string> = new Set(['torrent', 'nzb'])

export const TORRENT_MIME = 'application/x-bittorrent'
export const NZB_MIME = 'application/x-nzb'

const DOCUMENT_MIMES: ReadonlySet<string> = new Set([
  'application/pdf', 'application/epub+zip', 'application/x-mobipocket-ebook',
  'application/vnd.amazon.ebook', 'image/vnd.djvu', 'application/postscript',
  'application/rtf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
  'application/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation', 'application/x-fictionbook+xml',
  'application/vnd.comicbook+zip', 'application/vnd.comicbook-rar',
  'application/x-cbr', 'application/x-cbz',
])

const ARCHIVE_MIMES: ReadonlySet<string> = new Set([
  'application/zip', 'application/x-tar', 'application/gzip', 'application/x-gzip',
  'application/x-bzip2', 'application/x-xz', 'application/zstd',
  'application/x-7z-compressed', 'application/vnd.rar', 'application/x-rar-compressed',
  'application/x-iso9660-image',
])

const TEXT_APPLICATION_MIMES: ReadonlySet<string> = new Set([
  'application/json', 'application/xml', 'application/x-ndjson', 'application/yaml',
  'application/x-yaml', 'application/toml', 'application/x-tex', 'application/x-bibtex',
])

/** Extension (with dot) → MIME. Covers Haven's table plus common media types. */
const EXTENSION_MIMES: Readonly<Record<string, string>> = {
  '.epub': 'application/epub+zip', '.mobi': 'application/x-mobipocket-ebook',
  '.azw': 'application/vnd.amazon.ebook', '.azw3': 'application/vnd.amazon.ebook',
  '.djvu': 'image/vnd.djvu', '.djv': 'image/vnd.djvu', '.fb2': 'application/x-fictionbook+xml',
  '.cbz': 'application/vnd.comicbook+zip', '.cbr': 'application/vnd.comicbook-rar',
  '.mkv': 'video/x-matroska', '.mk3d': 'video/x-matroska', '.mka': 'audio/x-matroska',
  '.flac': 'audio/flac', '.opus': 'audio/ogg', '.oga': 'audio/ogg', '.ogv': 'video/ogg',
  '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.m4b': 'audio/mp4',
  '.ts': 'video/mp2t', '.mts': 'video/mp2t', '.m2ts': 'video/mp2t',
  '.webp': 'image/webp', '.avif': 'image/avif', '.heic': 'image/heic', '.heif': 'image/heif',
  '.md': 'text/markdown', '.markdown': 'text/markdown', '.tex': 'application/x-tex',
  '.bib': 'application/x-bibtex', '.ndjson': 'application/x-ndjson', '.jsonl': 'application/x-ndjson',
  '.yaml': 'application/yaml', '.yml': 'application/yaml', '.toml': 'application/toml',
  '.7z': 'application/x-7z-compressed', '.rar': 'application/vnd.rar', '.zst': 'application/zstd',
  '.xz': 'application/x-xz', '.iso': 'application/x-iso9660-image',
  '.torrent': TORRENT_MIME, '.nzb': NZB_MIME,
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.qt': 'video/quicktime',
  '.avi': 'video/x-msvideo', '.wmv': 'video/x-ms-wmv', '.asf': 'video/x-ms-asf',
  '.flv': 'video/x-flv', '.webm': 'video/webm', '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg',
  '.vob': 'video/dvd', '.3gp': 'video/3gpp', '.3g2': 'video/3gpp2', '.f4v': 'video/x-f4v',
  '.rm': 'video/x-pn-realvideo', '.rmvb': 'video/x-pn-realvideo', '.divx': 'video/divx',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.aac': 'audio/aac', '.wma': 'audio/x-ms-wma',
  '.aiff': 'audio/aiff', '.aif': 'audio/aiff', '.au': 'audio/basic', '.mid': 'audio/midi',
  '.midi': 'audio/midi', '.spx': 'audio/ogg', '.weba': 'audio/webm',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.bmp': 'image/bmp', '.tiff': 'image/tiff', '.tif': 'image/tiff', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.psd': 'image/vnd.adobe.photoshop',
  '.pdf': 'application/pdf', '.ps': 'application/postscript', '.rtf': 'application/rtf',
  '.doc': 'application/msword', '.xls': 'application/vnd.ms-excel', '.ppt': 'application/vnd.ms-powerpoint',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text', '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.zip': 'application/zip', '.tar': 'application/x-tar', '.gz': 'application/gzip',
  '.tgz': 'application/gzip', '.bz2': 'application/x-bzip2', '.tbz': 'application/x-bzip2',
  '.txt': 'text/plain', '.srt': 'text/plain', '.vtt': 'text/vtt', '.ass': 'text/plain',
  '.ssa': 'text/plain', '.cue': 'text/plain', '.nfo': 'text/plain', '.sfv': 'text/plain',
  '.csv': 'text/csv', '.json': 'application/json', '.xml': 'application/xml',
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.m3u': 'audio/x-mpegurl', '.m3u8': 'audio/x-mpegurl', '.pls': 'audio/x-scpls',
}

const SNIFF_BYTES = 4096

// A bencoded dict whose first (sorted) key is one a .torrent file can start with.
const TORRENT_START = /^d(8:announce|13:announce-list|7:comment|10:created by|13:creation date|8:encoding|4:info|8:url-list|5:nodes|9:httpseeds)/

function startsWith(head: Uint8Array, bytes: ArrayLike<number>): boolean {
  if (head.length < bytes.length) return false
  for (let i = 0; i < bytes.length; i += 1) {
    if (head[i] !== bytes[i]) return false
  }
  return true
}

function sliceAscii(head: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...head.slice(start, Math.min(end, head.length)))
}

function containsAscii(head: Uint8Array, needle: string, limit: number): boolean {
  const text = sliceAscii(head, 0, Math.min(limit, head.length)).toLowerCase()
  return text.includes(needle)
}

/**
 * MIME type from leading bytes alone, or `undefined` when unrecognized.
 * ZIP subtypes report as their container; use {@link detectMime} for files.
 */
export function sniffBytes(head: Uint8Array): string | undefined {
  if (head.length === 0) return undefined
  const ascii = sliceAscii(head, 0, Math.min(64, head.length))
  if (ascii.startsWith('%PDF-')) return 'application/pdf'
  if (ascii.startsWith('magnet:?')) return 'text/x-magnet'
  if (TORRENT_START.test(ascii)) return TORRENT_MIME
  // Strip BOM + whitespace for markup detection.
  let stripped = head
  while (stripped.length > 0) {
    const b = stripped[0] ?? 0
    if (b === 0x20 || b === 0x09 || b === 0x0d || b === 0x0a) {
      stripped = stripped.slice(1)
    } else if (stripped.length >= 3 && stripped[0] === 0xef && stripped[1] === 0xbb && stripped[2] === 0xbf) {
      stripped = stripped.slice(3)
    } else {
      break
    }
  }
  const markup = sliceAscii(stripped, 0, Math.min(512, stripped.length)).toLowerCase()
  if (markup.startsWith('<?xml') || markup.startsWith('<!doctype nzb') || markup.startsWith('<nzb')) {
    if (containsAscii(stripped, '<nzb', SNIFF_BYTES)) return NZB_MIME
    if (containsAscii(stripped, '<svg', SNIFF_BYTES)) return 'image/svg+xml'
    if (containsAscii(stripped, '<html', SNIFF_BYTES)) return 'text/html'
    return 'application/xml'
  }
  if (markup.startsWith('<!doctype html') || markup.startsWith('<html')) return 'text/html'
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return 'image/gif'
  if (sliceAscii(head, 0, 4) === 'RIFF' && sliceAscii(head, 8, 12) === 'WEBP') return 'image/webp'
  if (sliceAscii(head, 0, 4) === 'RIFF' && sliceAscii(head, 8, 12) === 'WAVE') return 'audio/wav'
  if (sliceAscii(head, 0, 4) === 'RIFF' && sliceAscii(head, 8, 12) === 'AVI ') return 'video/x-msvideo'
  if (ascii.startsWith('AT&TFORM') && sliceAscii(head, 12, 15) === 'DJV') return 'image/vnd.djvu'
  if (head.length >= 68 && sliceAscii(head, 60, 68) === 'BOOKMOBI') return 'application/x-mobipocket-ebook'
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) return 'application/zip'
  if (startsWith(head, [0x1f, 0x8b])) return 'application/gzip'
  if (ascii.startsWith('BZh')) return 'application/x-bzip2'
  if (startsWith(head, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return 'application/x-xz'
  if (startsWith(head, [0x28, 0xb5, 0x2f, 0xfd])) return 'application/zstd'
  if (startsWith(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return 'application/x-7z-compressed'
  if (startsWith(head, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return 'application/vnd.rar'
  if (head.length >= 262 && sliceAscii(head, 257, 262) === 'ustar') return 'application/x-tar'
  if (ascii.startsWith('fLaC')) return 'audio/flac'
  if (ascii.startsWith('OggS')) return 'audio/ogg'
  const b0 = head[0] ?? 0
  const b1 = head[1] ?? 0
  if (ascii.startsWith('ID3') || (head.length > 1 && b0 === 0xff && (b1 & 0xe0) === 0xe0 && b1 !== 0xff)) return 'audio/mpeg'
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return containsAscii(head, 'webm', 64) ? 'video/webm' : 'video/x-matroska'
  if (sliceAscii(head, 4, 8) === 'ftyp') {
    const brand = sliceAscii(head, 8, 12)
    if (brand === 'M4A ' || brand === 'M4B ') return 'audio/mp4'
    if (brand === 'qt  ') return 'video/quicktime'
    if (brand === 'avif' || brand === 'avis') return 'image/avif'
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1') return 'image/heic'
    return 'video/mp4'
  }
  if (ascii.startsWith('{\\rtf')) return 'application/rtf'
  if (ascii.startsWith('%!PS')) return 'application/postscript'
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'application/x-ole-storage'
  return undefined
}

/** List ZIP member names (lowercased) via the end-of-central-directory record. */
function zipMemberNames(data: Uint8Array): string[] | undefined {
  // EOCD is at most 64KB + 22 bytes from the end (comment).
  const tailStart = Math.max(0, data.length - (65557 + 22))
  const tail = data.slice(tailStart)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
      eocd = tailStart + i
      break
    }
  }
  if (eocd < 0 || eocd + 22 > data.length) return undefined
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const count = view.getUint16(eocd + 10, true)
  const dirOffset = view.getUint32(eocd + 16, true)
  if (dirOffset >= data.length || count > 100_000) return undefined
  const names: string[] = []
  let pos = dirOffset
  const decoder = new TextDecoder()
  for (let i = 0; i < count; i += 1) {
    if (pos + 46 > data.length) return undefined
    if (view.getUint32(pos, true) !== 0x02014b50) return undefined
    const nameLen = view.getUint16(pos + 28, true)
    const extraLen = view.getUint16(pos + 30, true)
    const commentLen = view.getUint16(pos + 32, true)
    if (pos + 46 + nameLen > data.length) return undefined
    names.push(decoder.decode(data.slice(pos + 46, pos + 46 + nameLen)).toLowerCase())
    pos += 46 + nameLen + extraLen + commentLen
    if (names.length > 100_000) return undefined
  }
  return names
}

/** Refine a ZIP container into EPUB / OOXML / CBZ / plain ZIP. */
function sniffZip(data: Uint8Array): string {
  try {
    const names = zipMemberNames(data)
    if (names === undefined) return 'application/zip'
    if (names.includes('mimetype')) {
      // EPUB and ODF store `mimetype` uncompressed as the first member; a
      // declared value there is authoritative.
      const text = new TextDecoder().decode(data.slice(0, Math.min(data.length, 4096)))
      const m = /application\/(epub\+zip|vnd\.oasis\.opendocument\.\w+)/.exec(text)
      if (m?.[0] !== undefined) return m[0]
    }
    if (names.includes('[content_types].xml')) {
      if (names.some(n => n.startsWith('word/'))) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      if (names.some(n => n.startsWith('xl/'))) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      if (names.some(n => n.startsWith('ppt/'))) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    }
    const imageExt = ['.jpg', '.jpeg', '.png', '.gif', '.webp']
    const files = names.filter(n => !n.endsWith('/'))
    if (files.length > 0 && files.every(n => imageExt.some(e => n.endsWith(e)) || n.endsWith('.xml'))) {
      return 'application/vnd.comicbook+zip'
    }
  } catch {
    // Fall through to plain ZIP.
  }
  return 'application/zip'
}

function looksLikeText(head: Uint8Array): boolean {
  if (head.length === 0) return false
  for (const b of head) {
    if (b === 0) return false
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head)
    return true
  } catch {
    // A multibyte sequence cut at the sniff boundary is still text.
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(head.slice(0, Math.max(0, head.length - 4)))
      return true
    } catch {
      return false
    }
  }
}

/** MIME type implied by the file extension, or `undefined`. */
export function mimeFromExtension(path: string): string | undefined {
  const dot = path.lastIndexOf('.')
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (dot < 0 || dot < slash) return undefined
  return EXTENSION_MIMES[path.slice(dot).toLowerCase()]
}

/**
 * Best-effort MIME type for a file.
 * Order: magic bytes → ZIP refinement → extension → text heuristic → octet-stream.
 */
export function detectMime(path: string): string {
  let head: Uint8Array
  try {
    head = readFileSync(path).slice(0, SNIFF_BYTES)
  } catch {
    return 'application/octet-stream'
  }
  const sniffed = sniffBytes(head)
  if (sniffed === 'application/zip') {
    try {
      return sniffZip(readFileSync(path))
    } catch {
      return 'application/zip'
    }
  }
  if (sniffed === 'application/x-ole-storage') return mimeFromExtension(path) ?? sniffed
  if (sniffed === 'application/xml') {
    const byExt = mimeFromExtension(path)
    if (byExt !== undefined && (byExt.includes('xml') || byExt.startsWith('text/'))) return byExt
    return sniffed
  }
  if (sniffed !== undefined) return sniffed
  return mimeFromExtension(path) ?? (looksLikeText(head) ? 'text/plain' : 'application/octet-stream')
}

/** Coarse kind for a MIME type (one of {@link MEDIA_KINDS}). */
export function mediaKind(mime: string | undefined): MediaKind {
  if (mime === undefined || mime === '') return 'other'
  const base = mime.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (base === TORRENT_MIME || base === 'text/x-magnet') return 'torrent'
  if (base === NZB_MIME) return 'nzb'
  if (DOCUMENT_MIMES.has(base)) return 'document'
  if (ARCHIVE_MIMES.has(base)) return 'archive'
  const major = base.split('/', 1)[0] ?? ''
  if (major === 'video' || major === 'audio' || major === 'image') return major
  if (major === 'text' || TEXT_APPLICATION_MIMES.has(base) || base.endsWith('+json') || base.endsWith('+xml')) return 'text'
  return 'other'
}

/** Glob-match `value` against a MIME pattern (`*` matches any run, `?` one char). Case-sensitive on already-lowered input. */
function globMatch(value: string, pattern: string): boolean {
  const rx = `^${pattern.split('').map(c => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('')}$`
  return new RegExp(rx).test(value)
}

/**
 * Whether `mime` matches any pattern. A pattern is a kind name, `*`/`any`,
 * or a MIME glob such as `application/pdf` or `image/*`.
 */
export function mimeMatches(mime: string | undefined, patterns: ReadonlyArray<string>): boolean {
  const base = (mime ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? ''
  const kind = mediaKind(base)
  for (const raw of patterns) {
    const pattern = raw.trim().toLowerCase()
    if (pattern === '') continue
    if (pattern === '*' || pattern === 'any' || pattern === '*/*') return true
    if ((MEDIA_KINDS as ReadonlyArray<string>).includes(pattern)) {
      if (pattern === kind) return true
      continue
    }
    if (globMatch(base, pattern)) return true
  }
  return false
}

const FALLBACK_EXTENSIONS: Readonly<Record<string, string>> = {
  'video/mp4': '.mp4', 'video/x-matroska': '.mkv', 'video/webm': '.webm',
  'video/x-msvideo': '.avi', 'video/quicktime': '.mov', 'video/mpeg': '.mpg',
  'audio/mpeg': '.mp3', 'audio/flac': '.flac', 'audio/ogg': '.ogg', 'audio/wav': '.wav',
  'audio/mp4': '.m4a', 'audio/aac': '.aac',
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/svg+xml': '.svg',
  'application/pdf': '.pdf', 'text/plain': '.txt', 'text/html': '.html',
  'application/json': '.json', 'application/xml': '.xml', 'text/csv': '.csv',
  'application/zip': '.zip', 'application/gzip': '.gz', 'application/x-tar': '.tar',
  'application/x-bzip2': '.bz2', 'application/x-xz': '.xz', 'application/zstd': '.zst',
  'application/x-7z-compressed': '.7z', 'application/vnd.rar': '.rar',
  'application/x-iso9660-image': '.iso', 'application/x-bittorrent': '.torrent',
  'application/x-nzb': '.nzb', 'text/x-magnet': '.magnet',
}

/** A reasonable file extension (with dot) for `mime`, or `''`. */
export function extensionForMime(mime: string): string {
  const base = mime.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  for (const [ext, known] of Object.entries(EXTENSION_MIMES)) {
    if (known === base) return ext
  }
  return FALLBACK_EXTENSIONS[base] ?? ''
}
