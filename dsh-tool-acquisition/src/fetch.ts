/**
 * Guarded HTTP downloads for URLs from third-party data. Ported from the
 * reference `acquisition/http_fetch.py`: every hop (including each redirect) is
 * checked with {@link checkFetchTarget}; bodies stream to a `.part` file
 * with a hard byte cap and are atomically renamed once complete; the saved
 * file gets an extension matching its sniffed content so type checks work
 * even when the server lied.
 *
 * @module dsh-tool-acquisition/fetch
 */

import { createWriteStream, promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { checkFetchTarget } from './fetchSafety.ts'
import { AcquisitionError } from './errors.ts'
import { detectMime, extensionForMime } from './filetype.ts'
import { describeUrl } from './redact.ts'

export const DEFAULT_USER_AGENT = 'dsh-tool-acquisition/0.1.0'
const CHUNK_HARD_CAP_BYTES = 256 * 1024 * 1024

/** Injectable fetch (tests pass a stub; production uses global fetch). */
export type FetchFn = typeof fetch

/** Limits applied to one download. */
export interface FetchPolicy {
  maxBytes: number
  timeoutMs: number
  maxRedirects: number
  allowedHosts: ReadonlyArray<string>
  allowPrivateHosts: boolean
  userAgent: string
  extraHeaders?: Record<string, string>
}

/** A completed guarded download. */
export interface FetchedFile {
  path: string
  size: number
  mime: string
  finalUrl: string
  contentType: string
}

/** Either a saved file or a magnet link discovered via redirect. */
export type FetchOutcome = { kind: 'file'; file: FetchedFile } | { kind: 'magnet'; magnet: string }

const UNSAFE_NAME = /[^\w.\- ()[\]+,]+/gu

/** A filesystem-safe single path component derived from `name`. */
export function safeFilename(name: string, fallback = 'download', maxLen = 180): string {
  let out = name.replace(/\//g, ' ').replace(/\\/g, ' ').trim()
  try {
    out = decodeURIComponent(out)
  } catch {
    // Keep the raw text when it is not valid percent-encoding.
  }
  out = out.replace(UNSAFE_NAME, '_').replace(/^[ ._]+|[ ._]+$/g, '')
  if (out === '') out = fallback
  if (out.length > maxLen) {
    const dot = out.lastIndexOf('.')
    const ext = dot >= 0 ? out.slice(dot + 1) : ''
    if (dot >= 0 && ext.length > 0 && ext.length <= 10) out = `${out.slice(0, Math.max(0, maxLen - ext.length - 1))}.${ext}`
    else out = out.slice(0, maxLen)
  }
  return out
}

function filenameFromDisposition(value: string): string | undefined {
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/.exec(value)
  if (star?.[1] !== undefined) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''))
    } catch {
      return star[1].trim()
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/.exec(value)
  return plain?.[1] !== undefined ? plain[1].trim() : undefined
}

function fail(message: string, options?: { permanent?: boolean; retryAfterMs?: number; cause?: unknown }): never {
  throw new AcquisitionError(message, options?.permanent === true ? 'ACQUIRE_FETCH_ERROR' : 'ACQUIRE_FETCH_ERROR', {
    permanent: options?.permanent ?? false,
    ...(options?.retryAfterMs !== undefined ? { retryAfterMs: options.retryAfterMs } : {}),
    ...(options?.cause !== undefined ? { cause: options.cause } : {}),
  })
}

/**
 * Fetch `url` into `destDir` under guardrails.
 *
 * @param url - http(s) URL (magnet links are returned as-is without fetching).
 * @param destDir - directory receiving the file (created when missing).
 * @param policy - byte/timeout/redirect/host limits.
 * @param options - filename hint, fetch seam, and abort signal.
 */
export async function fetchDirect(
  url: string,
  destDir: string,
  policy: FetchPolicy,
  options: { filenameHint?: string; fetchFn?: FetchFn; signal?: AbortSignal } = {},
): Promise<FetchOutcome> {
  if (url.toLowerCase().startsWith('magnet:')) return { kind: 'magnet', magnet: url }
  const fetchFn = options.fetchFn ?? fetch
  await fs.mkdir(destDir, { recursive: true })

  let current = url
  let response: Response | undefined
  for (let hop = 0; hop <= policy.maxRedirects; hop += 1) {
    await checkFetchTarget(current, {
      allowedHosts: policy.allowedHosts,
      allowPrivate: policy.allowPrivateHosts,
    })
    const timeout = AbortSignal.timeout(policy.timeoutMs)
    const signal = options.signal !== undefined ? AbortSignal.any([options.signal, timeout]) : timeout
    try {
      response = await fetchFn(current, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'user-agent': policy.userAgent, accept: '*/*', ...policy.extraHeaders },
        signal,
      })
    } catch (error: unknown) {
      if (options.signal?.aborted === true) fail('download aborted', { cause: error })
      if (timeout.aborted) fail(`download of ${describeUrl(current)} timed out after ${policy.timeoutMs}ms`, { cause: error })
      fail(`download of ${describeUrl(current)} failed: ${String(error)}`, { cause: error })
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location') ?? ''
      await response.body?.cancel().catch(() => undefined)
      if (location === '') fail('redirect without Location', { permanent: true })
      const target = new URL(location, current).toString()
      if (target.toLowerCase().startsWith('magnet:')) return { kind: 'magnet', magnet: target }
      current = target
      response = undefined
      continue
    }
    break
  }
  if (response === undefined) fail(`too many redirects (>${policy.maxRedirects})`, { permanent: true })
  const final = response

  if (final.status >= 400) {
    const status = final.status
    const body = (await final.text().catch(() => '')).slice(0, 500)
    const retryHeader = final.headers.get('retry-after') ?? ''
    const retryAfterMs = /^\d+$/.test(retryHeader) ? Number(retryHeader) * 1000 : undefined
    const transient = status === 408 || status === 429 || status >= 500
    fail(`download failed (HTTP ${status})${body !== '' ? `: ${body.slice(0, 200)}` : ''}`, {
      permanent: !transient,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    })
  }

  const declared = Number(final.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > policy.maxBytes) {
    await final.body?.cancel().catch(() => undefined)
    throw new AcquisitionError(
      `download is ${declared} bytes, over the ${policy.maxBytes} byte cap`,
      'ACQUIRE_TOO_LARGE',
      { permanent: true },
    )
  }

  const disposition = final.headers.get('content-disposition') ?? ''
  const hinted = filenameFromDisposition(disposition) ?? options.filenameHint ?? basename(new URL(current).pathname) ?? ''
  const name = safeFilename(hinted !== '' ? hinted : 'download')
  const target = join(destDir, name)
  const part = `${target}.part`
  const hardCap = Math.min(policy.maxBytes, CHUNK_HARD_CAP_BYTES)

  let written = 0
  const out = createWriteStream(part)
  try {
    if (final.body === null) throw new Error('empty response body')
    for await (const chunk of final.body as unknown as AsyncIterable<Uint8Array>) {
      written += chunk.length
      if (written > hardCap) {
        out.destroy()
        await fs.unlink(part).catch(() => undefined)
        throw new AcquisitionError(
          `download exceeded the ${policy.maxBytes} byte cap`,
          'ACQUIRE_TOO_LARGE',
          { permanent: true },
        )
      }
      const ok = out.write(chunk)
      if (!ok) await new Promise<void>(resolve => out.once('drain', () => resolve()))
    }
  } catch (error: unknown) {
    out.destroy()
    await fs.unlink(part).catch(() => undefined)
    if (error instanceof AcquisitionError) throw error
    if (options.signal?.aborted === true) fail('download aborted', { cause: error })
    fail(`download of ${describeUrl(current)} failed mid-body: ${String(error)}`, { cause: error })
  } finally {
    if (!out.destroyed) {
      await new Promise<void>((resolve, reject) => {
        out.on('finish', () => resolve())
        out.on('error', reject)
        out.end()
      }).catch(() => undefined)
    }
  }

  // Extension fix: the server may have lied, so the saved file gets an
  // extension matching its sniffed content.
  const mime = detectMime(part)
  const wanted = extensionForMime(mime)
  let settled = target
  if (wanted !== '' && !target.toLowerCase().endsWith(wanted)) settled = `${target}${wanted}`
  await fs.rename(part, settled)

  let size = written
  try {
    size = (await fs.stat(settled)).size
  } catch {
    // Keep the streamed count.
  }
  return {
    kind: 'file',
    file: {
      path: settled,
      size,
      mime,
      finalUrl: describeUrl(current),
      contentType: final.headers.get('content-type') ?? '',
    },
  }
}

/** Write in-memory `bytes` to `destDir` as a fetched file (Prowlarr bodies, tests). */
export async function saveBytes(
  bytes: Uint8Array,
  destDir: string,
  filenameHint: string,
  finalUrl: string,
): Promise<FetchedFile> {
  await fs.mkdir(destDir, { recursive: true })
  const target = join(destDir, safeFilename(filenameHint !== '' ? filenameHint : 'download'))
  const part = `${target}.part`
  await fs.writeFile(part, bytes)
  const mime = detectMime(part)
  const wanted = extensionForMime(mime)
  const settled = wanted !== '' && !target.toLowerCase().endsWith(wanted) ? `${target}${wanted}` : target
  await fs.rename(part, settled)
  return { path: settled, size: bytes.length, mime, finalUrl: describeUrl(finalUrl), contentType: '' }
}

/** Parent directory of `file` (import root helper). */
export function parentDir(file: string): string {
  return dirname(file)
}
