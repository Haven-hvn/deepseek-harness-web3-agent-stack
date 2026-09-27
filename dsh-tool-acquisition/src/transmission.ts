/**
 * Transmission RPC backend. Ported from Haven CLI's
 * `acquisition/clients/transmission.py` (session-id handshake, torrent-add
 * with labels, torrent-get polling).
 *
 * @module dsh-tool-acquisition/transmission
 */

import { magnetInfoHash, parseTorrent } from './bencode.ts'
import { AcquisitionError } from './errors.ts'
import type { FetchFn } from './fetch.ts'
import { applyPathMappings } from './importer.ts'
import { redactText } from './redact.ts'
import type { BackendStatus, TorrentPayload } from './types.ts'

const SESSION_HEADER = 'x-transmission-session-id'
// torrent-get "status": 0 stopped, 1 check-wait, 2 check, 3 download-wait,
// 4 download, 5 seed-wait, 6 seed.

/** Options for {@link TransmissionClient}. */
export interface TransmissionOptions {
  url: string
  username?: string
  password?: string
  downloadDir?: string
  labels?: boolean
  pathMappings?: ReadonlyArray<string>
  timeoutMs?: number
  fetchFn?: FetchFn
}

/** Transmission torrent backend. */
export class TransmissionClient {
  static readonly protocol = 'torrent'
  readonly name = 'transmission'

  private readonly rpcUrl: string
  private readonly password: string
  private readonly authHeader: string | undefined
  private readonly fetchFn: FetchFn
  private readonly timeoutMs: number
  private sessionId = ''

  constructor(private readonly options: TransmissionOptions) {
    if (options.url === '') throw new AcquisitionError('transmissionUrl is not configured', 'ACQUIRE_NOT_CONFIGURED', { permanent: true })
    const base = options.url.replace(/\/+$/, '')
    this.rpcUrl = base.endsWith('/rpc') ? base : `${base}/transmission/rpc`
    this.password = options.password ?? ''
    const username = options.username ?? ''
    this.authHeader = username !== '' || this.password !== ''
      ? `Basic ${Buffer.from(`${username}:${this.password}`).toString('base64')}`
      : undefined
    this.fetchFn = options.fetchFn ?? fetch
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  private redact(text: string): string {
    return redactText(text, [this.password])
  }

  private async rpc(method: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const body = JSON.stringify({ method, arguments: args })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let response: Response
      try {
        const headers: Record<string, string> = { 'content-type': 'application/json', [SESSION_HEADER]: this.sessionId }
        if (this.authHeader !== undefined) headers['authorization'] = this.authHeader
        response = await this.fetchFn(this.rpcUrl, {
          method: 'POST',
          redirect: 'error',
          headers,
          body,
          signal: signal !== undefined ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
        })
      } catch (error: unknown) {
        throw new AcquisitionError(this.redact(`Transmission RPC failed: ${String(error)}`), 'ACQUIRE_BACKEND_ERROR', { cause: error })
      }
      if (response.status === 409) {
        this.sessionId = response.headers.get(SESSION_HEADER) ?? ''
        continue
      }
      if (response.status === 401) throw new AcquisitionError('Transmission rejected credentials', 'ACQUIRE_BACKEND_AUTH', { permanent: true })
      if (response.status >= 400) {
        throw new AcquisitionError(this.redact(`Transmission RPC HTTP ${response.status}`), 'ACQUIRE_BACKEND_ERROR')
      }
      let data: { result?: unknown; arguments?: unknown }
      try {
        data = (await response.json()) as { result?: unknown; arguments?: unknown }
      } catch (error: unknown) {
        throw new AcquisitionError('Transmission returned invalid JSON', 'ACQUIRE_BACKEND_ERROR', { cause: error })
      }
      const result = String(data.result ?? '')
      if (method === 'torrent-add' && result.toLowerCase().includes('duplicate')) {
        return (data.arguments as Record<string, unknown> | undefined) ?? {}
      }
      if (result !== 'success') {
        throw new AcquisitionError(this.redact(`Transmission ${method}: ${String(data.result)}`), 'ACQUIRE_BACKEND_ERROR', {
          permanent: method === 'torrent-add',
        })
      }
      return (data.arguments as Record<string, unknown> | undefined) ?? {}
    }
    throw new AcquisitionError('Transmission session negotiation failed', 'ACQUIRE_BACKEND_ERROR')
  }

  /** Queue a torrent; returns a persistent handle. */
  async submit(payload: TorrentPayload, label: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (payload.magnet === undefined && payload.torrent === undefined) {
      throw new AcquisitionError('Transmission accepts torrents only', 'ACQUIRE_INVALID_REQUEST', { permanent: true })
    }
    const args: Record<string, unknown> = { paused: false }
    if ((this.options.downloadDir ?? '') !== '') args['download-dir'] = this.options.downloadDir
    if ((this.options.labels ?? true) === true) args['labels'] = [label]
    let infoHash = payload.infoHash
    if (payload.torrent !== undefined) {
      const meta = parseTorrent(payload.torrent)
      if ((infoHash === undefined || infoHash === '') && meta.infoHash !== '') infoHash = meta.infoHash
      args['metainfo'] = Buffer.from(payload.torrent).toString('base64')
    } else {
      args['filename'] = payload.magnet
      infoHash = infoHash ?? magnetInfoHash(payload.magnet ?? '')
    }
    const result = await this.rpc('torrent-add', args, signal)
    const added = (result['torrent-added'] as Record<string, unknown> | undefined)
      ?? (result['torrent-duplicate'] as Record<string, unknown> | undefined)
      ?? {}
    const hash = String(added['hashString'] ?? infoHash ?? '').toLowerCase()
    if (hash === '') throw new AcquisitionError('Transmission did not report an info-hash', 'ACQUIRE_BACKEND_ERROR', { permanent: true })
    return { info_hash: hash, label }
  }

  /** Current state of a previously submitted download. */
  async status(handle: Record<string, unknown>, signal?: AbortSignal): Promise<BackendStatus> {
    const fields = ['hashString', 'status', 'percentDone', 'downloadDir', 'name', 'error', 'errorString', 'leftUntilDone']
    const result = await this.rpc('torrent-get', { ids: [String(handle['info_hash'] ?? '')], fields }, signal)
    const torrents = (result['torrents'] as Array<Record<string, unknown>> | undefined) ?? []
    if (torrents.length === 0) return { state: 'missing', progress: 0, files: [], error: 'torrent not found in Transmission' }
    const item = torrents[0] as Record<string, unknown>
    const progress = Number(item['percentDone'] ?? 0) || 0
    if (Number(item['error'] ?? 0) !== 0) {
      return { state: 'failed', progress, files: [], error: String(item['errorString'] ?? 'error') }
    }
    const status = Number(item['status'] ?? 0)
    if (progress >= 1 && Number(item['leftUntilDone'] ?? 0) === 0 && status !== 1 && status !== 2) {
      const raw = `${String(item['downloadDir'] ?? '')}/${String(item['name'] ?? '')}`
      return {
        state: 'completed',
        progress: 1,
        contentPath: applyPathMappings(raw, this.options.pathMappings ?? []),
        files: [],
      }
    }
    return { state: status === 0 || status === 1 || status === 2 || status === 3 ? 'queued' : 'downloading', progress, files: [] }
  }

  /** Short description of the backend when reachable. */
  async health(signal?: AbortSignal): Promise<string> {
    const result = await this.rpc('session-get', { fields: ['version'] }, signal)
    return `Transmission ${String(result['version'] ?? '?')}`
  }
}
