/**
 * qBittorrent Web API (v2) backend. Ported from the reference
 * `acquisition/clients/qbittorrent.py`: torrents are added with a unique
 * tag and looked up by info-hash when known, else by tag. Paths reported
 * by qBittorrent are translated through `pathMappings` for setups where
 * the client sees a different filesystem.
 *
 * @module dsh-tool-acquisition/qbittorrent
 */

import { magnetInfoHash, parseTorrent } from './bencode.ts'
import { AcquisitionError } from './errors.ts'
import type { FetchFn } from './fetch.ts'
import { applyPathMappings } from './importer.ts'
import { redactText } from './redact.ts'
import type { BackendStatus, TorrentPayload } from './types.ts'

const COMPLETE_STATES: ReadonlySet<string> = new Set([
  'uploading', 'stalledUP', 'pausedUP', 'stoppedUP', 'queuedUP', 'forcedUP', 'checkingUP',
])
const FAILED_STATES: ReadonlySet<string> = new Set(['error', 'missingFiles'])
const QUEUED_STATES: ReadonlySet<string> = new Set(['metaDL', 'queuedDL', 'checkingDL', 'checkingResumeData', 'allocating', 'moving'])

/** Options for {@link QBittorrentClient}. */
export interface QBittorrentOptions {
  url: string
  username?: string
  password?: string
  category?: string
  savePath?: string
  pathMappings?: ReadonlyArray<string>
  timeoutMs?: number
  fetchFn?: FetchFn
}

/** qBittorrent torrent backend. */
export class QBittorrentClient {
  static readonly protocol = 'torrent'
  readonly name = 'qbittorrent'

  private readonly baseUrl: string
  private readonly password: string
  private readonly fetchFn: FetchFn
  private readonly timeoutMs: number
  private loggedIn = false
  private cookie: string | undefined

  constructor(private readonly options: QBittorrentOptions) {
    if (options.url === '') throw new AcquisitionError('qbittorrentUrl is not configured', 'ACQUIRE_NOT_CONFIGURED', { permanent: true })
    this.baseUrl = options.url.replace(/\/+$/, '')
    this.password = options.password ?? ''
    this.fetchFn = options.fetchFn ?? fetch
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  private redact(text: string): string {
    return redactText(text, [this.password])
  }

  private setCookies(response: Response): void {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] }
    const cookies: string[] = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : []
    const single = response.headers.get('set-cookie')
    if (cookies.length === 0 && single !== null) cookies.push(single)
    for (const cookie of cookies) {
      const sid = /^SID=([^;]+)/.exec(cookie)?.[1]
      if (sid !== undefined && sid !== '') this.cookie = `SID=${sid}`
    }
  }

  private async login(signal?: AbortSignal): Promise<void> {
    const username = this.options.username ?? ''
    if (username === '' && this.password === '') {
      this.loggedIn = true // auth bypass for whitelisted subnets / localhost
      return
    }
    let response: Response
    try {
      response = await this.fetchFn(`${this.baseUrl}/api/v2/auth/login`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          referer: this.baseUrl, // qBittorrent's CSRF protection checks Referer/Origin.
          origin: this.baseUrl,
        },
        body: new URLSearchParams({ username, password: this.password }).toString(),
        signal: signal !== undefined ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error: unknown) {
      throw new AcquisitionError(this.redact(`qBittorrent login failed: ${String(error)}`), 'ACQUIRE_BACKEND_ERROR', { cause: error })
    }
    this.setCookies(response)
    if (response.status === 403) {
      throw new AcquisitionError('qBittorrent refused login (IP banned after failed attempts?)', 'ACQUIRE_BACKEND_AUTH', { permanent: true })
    }
    if (response.status !== 200 || (await response.text().catch(() => '')).trim() !== 'Ok.') {
      throw new AcquisitionError('qBittorrent login rejected: check qbittorrentUsername/password', 'ACQUIRE_BACKEND_AUTH', { permanent: true })
    }
    this.loggedIn = true
  }

  private async call(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    if (!this.loggedIn) await this.login(signal)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let response: Response
      try {
        const headers = new Headers(init.headers)
        headers.set('referer', this.baseUrl)
        headers.set('origin', this.baseUrl)
        if (this.cookie !== undefined) headers.set('cookie', this.cookie)
        response = await this.fetchFn(`${this.baseUrl}${path}`, {
          ...init,
          headers,
          redirect: 'error',
          signal: signal !== undefined ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
        })
      } catch (error: unknown) {
        throw new AcquisitionError(this.redact(`qBittorrent request ${path} failed: ${String(error)}`), 'ACQUIRE_BACKEND_ERROR', { cause: error })
      }
      this.setCookies(response)
      if (response.status === 403 && attempt === 0) {
        this.loggedIn = false
        await this.login(signal)
        continue
      }
      if (response.status >= 400) {
        const body = (await response.text().catch(() => '')).slice(0, 200)
        throw new AcquisitionError(
          this.redact(`qBittorrent ${path} returned HTTP ${response.status}: ${body}`),
          response.status === 401 || response.status === 403 ? 'ACQUIRE_BACKEND_AUTH' : 'ACQUIRE_BACKEND_ERROR',
          { permanent: response.status === 400 || response.status === 415 || response.status === 401 || response.status === 403 },
        )
      }
      return response
    }
    throw new AcquisitionError(`qBittorrent ${path}: authentication failed`, 'ACQUIRE_BACKEND_AUTH', { permanent: true })
  }

  /** Queue a torrent; returns a persistent handle. */
  async submit(payload: TorrentPayload, label: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (payload.magnet === undefined && payload.torrent === undefined) {
      throw new AcquisitionError('qBittorrent accepts torrents only', 'ACQUIRE_INVALID_REQUEST', { permanent: true })
    }
    const form = new FormData()
    form.set('tags', label)
    form.set('paused', 'false')
    form.set('stopped', 'false')
    if ((this.options.category ?? '') !== '') form.set('category', this.options.category ?? '')
    if ((this.options.savePath ?? '') !== '') form.set('savepath', this.options.savePath ?? '')
    let infoHash = payload.infoHash
    if (payload.torrent !== undefined) {
      const meta = parseTorrent(payload.torrent)
      if ((infoHash === undefined || infoHash === '') && meta.infoHash !== '') infoHash = meta.infoHash
      form.set('torrents', new Blob([payload.torrent as unknown as BlobPart], { type: 'application/x-bittorrent' }), 'release.torrent')
    } else {
      form.set('urls', payload.magnet ?? '')
      infoHash = infoHash ?? magnetInfoHash(payload.magnet ?? '')
    }
    const response = await this.call('/api/v2/torrents/add', { method: 'POST', body: form }, signal)
    const text = (await response.text().catch(() => '')).trim().toLowerCase()
    // qBittorrent answers "Fails." for duplicates too; the lookup in
    // status() finds an existing torrent when there is one.
    if (text.startsWith('fails') && (infoHash === undefined || infoHash === '')) {
      throw new AcquisitionError('qBittorrent rejected the torrent', 'ACQUIRE_BACKEND_ERROR', { permanent: true })
    }
    return { info_hash: infoHash ?? '', tag: label }
  }

  private async find(handle: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
    const params = typeof handle['info_hash'] === 'string' && handle['info_hash'] !== ''
      ? new URLSearchParams({ hashes: handle['info_hash'] })
      : new URLSearchParams({ tag: typeof handle['tag'] === 'string' ? handle['tag'] : '' })
    const response = await this.call(`/api/v2/torrents/info?${params.toString()}`, { method: 'GET' }, signal)
    let items: unknown
    try {
      items = await response.json()
    } catch (error: unknown) {
      throw new AcquisitionError('qBittorrent returned invalid JSON', 'ACQUIRE_BACKEND_ERROR', { cause: error })
    }
    if (!Array.isArray(items) || items.length === 0) return undefined
    const first: unknown = items[0]
    return typeof first === 'object' && first !== null ? (first as Record<string, unknown>) : undefined
  }

  /** Current state of a previously submitted download. */
  async status(handle: Record<string, unknown>, signal?: AbortSignal): Promise<BackendStatus> {
    const item = await this.find(handle, signal)
    if (item === undefined) return { state: 'missing', progress: 0, files: [], error: 'torrent not found in qBittorrent' }
    const state = String(item['state'] ?? '')
    const progress = Number(item['progress'] ?? 0) || 0
    if (FAILED_STATES.has(state)) {
      return { state: 'failed', progress, files: [], error: `qBittorrent state ${state}` }
    }
    if (COMPLETE_STATES.has(state) || progress >= 1) {
      const raw = typeof item['content_path'] === 'string' && item['content_path'] !== ''
        ? item['content_path']
        : `${String(item['save_path'] ?? '')}/${String(item['name'] ?? '')}`
      return {
        state: 'completed',
        progress: 1,
        contentPath: applyPathMappings(raw, this.options.pathMappings ?? []),
        files: [],
      }
    }
    if (QUEUED_STATES.has(state)) return { state: 'queued', progress, files: [] }
    return { state: 'downloading', progress, files: [] }
  }

  /** Short description of the backend when reachable. */
  async health(signal?: AbortSignal): Promise<string> {
    const response = await this.call('/api/v2/app/version', { method: 'GET' }, signal)
    return `qBittorrent ${(await response.text().catch(() => '')).trim()}`
  }
}
