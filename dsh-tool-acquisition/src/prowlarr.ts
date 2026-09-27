/**
 * Prowlarr download-proxy resolution. The `downloadUrl` from
 * `prowlarr_search` is redacted (no API key); this client re-attaches the
 * key server-side via the `X-Api-Key` header — never the `apikey` query
 * parameter — and refuses to send it to any non-Prowlarr origin.
 *
 * Ported from the reference `services/prowlarr.py` (`proxy_url`,
 * `open_download`) plus the redirect branch of the Prowlarr plugin's
 * `_fetch_via_prowlarr`.
 *
 * @module dsh-tool-acquisition/prowlarr
 */

import { createWriteStream, promises as fs } from 'node:fs'
import { join } from 'node:path'
import { AcquisitionError } from './errors.ts'
import type { FetchFn, FetchedFile } from './fetch.ts'
import { detectMime, extensionForMime } from './filetype.ts'
import { safeFilename } from './fetch.ts'
import { describeUrl, stripSensitiveParams } from './redact.ts'

/** Prowlarr proxy path: `{urlBase}/{indexerId}/download`. */
export const PROXY_PATH = /\/\d+\/download$/

/**
 * Map a Prowlarr download-proxy link onto the configured origin.
 * Prowlarr builds proxy links from the Host it was reached by, which may
 * differ from `baseUrl` behind Docker or a reverse proxy. Returns
 * `undefined` when `link` is not a proxy link.
 */
export function proxyUrl(link: string, baseUrl: string, apiKey: string): string | undefined {
  let parts: URL
  try {
    parts = new URL(link)
  } catch {
    return undefined
  }
  if (!PROXY_PATH.test(parts.pathname)) return undefined
  const base = new URL(baseUrl.replace(/\/+$/, ''))
  const stripped = stripSensitiveParams(`x:?${parts.search.slice(1)}`, [apiKey])
  const query = stripped.includes('?') ? stripped.split('?', 2)[1] ?? '' : ''
  return `${base.protocol}//${base.host}${parts.pathname}${query !== '' ? `?${query}` : ''}`
}

/** Resolution of one Prowlarr download link. */
export type ProwlarrResolution =
  | { kind: 'magnet'; magnet: string }
  | { kind: 'redirect'; target: string }
  | { kind: 'file'; file: FetchedFile }

/** Options for {@link ProwlarrDownload}. */
export interface ProwlarrDownloadOptions {
  baseUrl: string
  apiKey: string
  timeoutMs: number
  maxBytes: number
  userAgent: string
  fetchFn?: FetchFn
}

/** Authenticated Prowlarr download-proxy client (key in header only). */
export class ProwlarrDownload {
  private readonly origin: string
  private readonly fetchFn: FetchFn

  constructor(private readonly options: ProwlarrDownloadOptions) {
    const base = new URL(options.baseUrl.replace(/\/+$/, ''))
    this.origin = `${base.protocol}//${base.host}`.toLowerCase()
    this.fetchFn = options.fetchFn ?? fetch
  }

  /** Whether the client has enough configuration to make a request. */
  configured(): boolean {
    return this.options.apiKey.length > 0 && URL.canParse(this.options.baseUrl)
  }

  private isProwlarrOrigin(link: string): boolean {
    try {
      const parts = new URL(link)
      return `${parts.protocol}//${parts.host}`.toLowerCase() === this.origin
    } catch {
      return false
    }
  }

  /**
   * Resolve one download link from a Prowlarr release.
   *
   * - magnet links (or proxy links redirecting to one) → `magnet`
   * - proxy links redirecting externally → `redirect` (fetch without credentials)
   - proxy-link bodies → `file` (spooled to `spoolDir` with a byte cap)
   * - non-proxy links → `redirect` (fetch like any third-party URL)
   */
  async resolve(link: string, spoolDir: string, filenameHint: string, signal?: AbortSignal): Promise<ProwlarrResolution> {
    if (link.toLowerCase().startsWith('magnet:')) return { kind: 'magnet', magnet: link }
    if (!this.configured()) {
      throw new AcquisitionError(
        'Prowlarr is not configured: set `prowlarrApiKey` (or PROWLARR_API_KEY) and a valid `prowlarrUrl`',
        'ACQUIRE_NOT_CONFIGURED',
        { permanent: true },
      )
    }
    const proxied = proxyUrl(link, this.options.baseUrl, this.options.apiKey)
    const target = proxied ?? link
    if (!this.isProwlarrOrigin(target)) return { kind: 'redirect', target }

    const timeout = AbortSignal.timeout(this.options.timeoutMs)
    const combined = signal !== undefined ? AbortSignal.any([signal, timeout]) : timeout
    let response: Response
    try {
      response = await this.fetchFn(target, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'x-api-key': this.options.apiKey, accept: '*/*', 'user-agent': this.options.userAgent },
        signal: combined,
      })
    } catch (error: unknown) {
      if (signal?.aborted === true) throw new AcquisitionError('Prowlarr download aborted', 'ACQUIRE_FETCH_ERROR', { cause: error })
      if (timeout.aborted) {
        throw new AcquisitionError(`Prowlarr download timed out after ${this.options.timeoutMs}ms`, 'ACQUIRE_FETCH_ERROR', { cause: error })
      }
      throw new AcquisitionError(`Prowlarr download request failed: ${String(error)}`, 'ACQUIRE_FETCH_ERROR', { cause: error })
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location') ?? ''
      await response.body?.cancel().catch(() => undefined)
      if (location === '') throw new AcquisitionError('Prowlarr redirect without Location', 'ACQUIRE_FETCH_ERROR', { permanent: true })
      const absolute = new URL(location, target).toString()
      if (absolute.toLowerCase().startsWith('magnet:')) return { kind: 'magnet', magnet: absolute }
      return { kind: 'redirect', target: absolute }
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined)
      throw new AcquisitionError(
        `Prowlarr rejected the API key for downloads (HTTP ${response.status})`,
        'ACQUIRE_PROWLARR_AUTH',
        { permanent: true },
      )
    }
    if (response.status >= 400) {
      const status = response.status
      const body = (await response.text().catch(() => '')).slice(0, 500)
      const retryHeader = response.headers.get('retry-after') ?? ''
      const retryAfterMs = /^\d+$/.test(retryHeader) ? Number(retryHeader) * 1000 : undefined
      const transient = status === 408 || status === 429 || status >= 500
      throw new AcquisitionError(`Prowlarr download failed (HTTP ${status})${body !== '' ? `: ${body.slice(0, 200)}` : ''}`, 'ACQUIRE_FETCH_ERROR', {
        permanent: !transient,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      })
    }

    await fs.mkdir(spoolDir, { recursive: true })
    const name = safeFilename(filenameHint !== '' ? filenameHint : 'prowlarr-download')
    const settled = join(spoolDir, name)
    const part = `${settled}.part`
    let written = 0
    const out = createWriteStream(part)
    try {
      if (response.body === null) throw new Error('empty response body')
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        written += chunk.length
        if (written > this.options.maxBytes) {
          out.destroy()
          await fs.unlink(part).catch(() => undefined)
          throw new AcquisitionError(`Prowlarr download exceeded the ${this.options.maxBytes} byte cap`, 'ACQUIRE_TOO_LARGE', { permanent: true })
        }
        const ok = out.write(chunk)
        if (!ok) await new Promise<void>(resolve => out.once('drain', () => resolve()))
      }
    } catch (error: unknown) {
      out.destroy()
      await fs.unlink(part).catch(() => undefined)
      if (error instanceof AcquisitionError) throw error
      throw new AcquisitionError(`Prowlarr download failed mid-body: ${String(error)}`, 'ACQUIRE_FETCH_ERROR', { cause: error })
    } finally {
      if (!out.destroyed) {
        await new Promise<void>((resolve, reject) => {
          out.on('finish', () => resolve())
          out.on('error', reject)
          out.end()
        }).catch(() => undefined)
      }
    }
    const mime = detectMime(part)
    const wanted = extensionForMime(mime)
    const finalPath = wanted !== '' && !settled.toLowerCase().endsWith(wanted) ? `${settled}${wanted}` : settled
    await fs.rename(part, finalPath)
    return {
      kind: 'file',
      file: { path: finalPath, size: written, mime, finalUrl: describeUrl(target), contentType: response.headers.get('content-type') ?? '' },
    }
  }
}
