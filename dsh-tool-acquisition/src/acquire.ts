/**
 * Acquisition orchestration: turn one submit call (magnet, direct URL, or
 * Prowlarr release reference) into local files. Ports the strategy of
 * Haven CLI's Prowlarr plugin (`_acquire`/`_submit`/`_wait`):
 *
 * - magnets and `.torrent` bodies go to a torrent client (qBittorrent,
 *   then Transmission), polled until the wait budget runs out
 * - direct URLs and Prowlarr bodies that sniff as content are fetched,
 *   type-checked, and imported inline
 * - NZBs are refused: Usenet backends (SABnzbd/NZBGet) are out of scope
 *   for this arm
 *
 * Every submit persists a record, so `status` replays terminal results
 * and resumes polling pending ones — including after a restart.
 *
 * @module dsh-tool-acquisition/acquire
 */

import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { isTorrent, magnetDisplayName, parseTorrent } from './bencode.ts'
import { AcquisitionError } from './errors.ts'
import type { FetchFn, FetchedFile, FetchPolicy } from './fetch.ts'
import { fetchDirect, safeFilename } from './fetch.ts'
import { mediaKind } from './filetype.ts'
import { importFiles } from './importer.ts'
import { ProwlarrDownload } from './prowlarr.ts'
import { QBittorrentClient } from './qbittorrent.ts'
import type { QBittorrentOptions } from './qbittorrent.ts'
import { describeUrl } from './redact.ts'
import { SelectionPolicy } from './selection.ts'
import type { SelectionOptions } from './selection.ts'
import { HandleStore } from './store.ts'
import { TransmissionClient } from './transmission.ts'
import type { TransmissionOptions } from './transmission.ts'
import type { AcquiredFile, AcquireResult, AcquireState, BackendStatus, ImportMode, StoredAcquisition, TorrentClientName, TorrentPayload } from './types.ts'

/** One submit call (flat: mirrors the tool parameters). */
export interface AcquireSubmitInput {
  magnet?: string
  url?: string
  downloadUrl?: string
  magnetUrl?: string
  guid?: string
  indexerId?: number
  protocol?: string
  title?: string
  waitMs?: number
}

/** Options for {@link AcquireService}. */
export interface AcquireServiceOptions {
  prowlarrBaseUrl: string
  prowlarrApiKey: string
  prowlarrTimeoutMs: number
  torrentClients: TorrentClientName[]
  qbittorrent?: Omit<QBittorrentOptions, 'fetchFn' | 'timeoutMs'>
  transmission?: Omit<TransmissionOptions, 'fetchFn' | 'timeoutMs'>
  clientTimeoutMs: number
  downloadDir: string
  fetchPolicy: Omit<FetchPolicy, 'extraHeaders'>
  selection: SelectionOptions
  importMode: ImportMode
  pollIntervalMs: number
  defaultWaitMs: number
  maxWaitMs: number
  fetchFn?: FetchFn
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(new Error('aborted'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function terminal(state: AcquireState): boolean {
  return state === 'completed' || state === 'failed' || state === 'missing'
}

/** Submits downloads and polls them to completion. */
export class AcquireService {
  private readonly store: HandleStore
  private readonly fetchFn: FetchFn | undefined

  constructor(private readonly options: AcquireServiceOptions) {
    this.store = new HandleStore(join(options.downloadDir, 'acquisition-handles.json'))
    this.fetchFn = options.fetchFn
  }

  /** Backend handle store (diagnostics, tests). */
  handles(): HandleStore {
    return this.store
  }

  private clientTimeout(): number {
    return this.options.clientTimeoutMs
  }

  private makeBackend(name: TorrentClientName): QBittorrentClient | TransmissionClient {
    if (name === 'qbittorrent') {
      const cfg = this.options.qbittorrent
      if (cfg === undefined || cfg.url === '') throw new AcquisitionError('qbittorrent is not configured', 'ACQUIRE_NOT_CONFIGURED')
      return new QBittorrentClient({ ...cfg, timeoutMs: this.clientTimeout(), ...(this.fetchFn !== undefined ? { fetchFn: this.fetchFn } : {}) })
    }
    const cfg = this.options.transmission
    if (cfg === undefined || cfg.url === '') throw new AcquisitionError('transmission is not configured', 'ACQUIRE_NOT_CONFIGURED')
    return new TransmissionClient({ ...cfg, timeoutMs: this.clientTimeout(), ...(this.fetchFn !== undefined ? { fetchFn: this.fetchFn } : {}) })
  }

  private prowlarr(): ProwlarrDownload {
    return new ProwlarrDownload({
      baseUrl: this.options.prowlarrBaseUrl,
      apiKey: this.options.prowlarrApiKey,
      timeoutMs: this.options.prowlarrTimeoutMs,
      maxBytes: this.options.fetchPolicy.maxBytes,
      userAgent: this.options.fetchPolicy.userAgent,
      ...(this.fetchFn !== undefined ? { fetchFn: this.fetchFn } : {}),
    })
  }

  /**
   * Submit one source for download.
   * @param input - exactly one of `magnet`, `url`, or (`downloadUrl`/`magnetUrl`).
   * @param signal - caller cancellation.
   */
  async submit(input: AcquireSubmitInput, signal?: AbortSignal): Promise<AcquireResult> {
    const sources = [
      input.magnet !== undefined && input.magnet !== '' ? 'magnet' : undefined,
      input.url !== undefined && input.url !== '' ? 'url' : undefined,
      (input.downloadUrl !== undefined && input.downloadUrl !== '') || (input.magnetUrl !== undefined && input.magnetUrl !== '') ? 'prowlarr' : undefined,
    ].filter((s): s is string => s !== undefined)
    if (sources.length === 0) {
      throw new AcquisitionError('one source is required: magnet, url, or downloadUrl/magnetUrl', 'ACQUIRE_INVALID_REQUEST', { permanent: true })
    }
    if (sources.length > 1) {
      throw new AcquisitionError(`only one source per call; got ${sources.join(' + ')}`, 'ACQUIRE_INVALID_REQUEST', { permanent: true })
    }
    const waitMs = Math.min(Math.max(0, input.waitMs ?? this.options.defaultWaitMs), this.options.maxWaitMs)
    const id = `acq_${randomBytes(8).toString('hex')}`
    const workDir = join(this.options.downloadDir, 'files', id)

    const title = AcquireService.displayTitle(input, id)
    if (input.magnet !== undefined && input.magnet !== '') {
      return await this.submitTorrent(id, { magnet: input.magnet }, title, waitMs, signal)
    }
    if (input.url !== undefined && input.url !== '') {
      const outcome = await fetchDirect(input.url, workDir, { ...this.options.fetchPolicy }, {
        filenameHint: safeFilename(title),
        ...(this.fetchFn !== undefined ? { fetchFn: this.fetchFn } : {}),
        ...(signal !== undefined ? { signal } : {}),
      })
      if (outcome.kind === 'magnet') {
        return await this.submitTorrent(id, { magnet: outcome.magnet }, title, waitMs, signal)
      }
      return await this.branchFetchedFile(id, outcome.file, title, waitMs, signal)
    }
    // Prowlarr release reference. Either field may hold the proxy link
    // (indexers disagree) or a real magnet; resolve() sorts out all three.
    const link = input.downloadUrl !== undefined && input.downloadUrl !== ''
      ? input.downloadUrl
      : (input.magnetUrl ?? '')
    if (link === '') {
      throw new AcquisitionError('prowlarr reference needs downloadUrl or magnetUrl', 'ACQUIRE_INVALID_REQUEST', { permanent: true })
    }
    const resolved = await this.prowlarr().resolve(link, workDir, safeFilename(title), signal)
    if (resolved.kind === 'magnet') {
      return await this.submitTorrent(id, { magnet: resolved.magnet }, title, waitMs, signal)
    }
    if (resolved.kind === 'redirect') {
      const outcome = await fetchDirect(resolved.target, workDir, { ...this.options.fetchPolicy }, {
        filenameHint: safeFilename(title),
        ...(this.fetchFn !== undefined ? { fetchFn: this.fetchFn } : {}),
        ...(signal !== undefined ? { signal } : {}),
      })
      if (outcome.kind === 'magnet') {
        return await this.submitTorrent(id, { magnet: outcome.magnet }, title, waitMs, signal)
      }
      return await this.branchFetchedFile(id, outcome.file, title, waitMs, signal)
    }
    return await this.branchFetchedFile(id, resolved.file, title, waitMs, signal)
  }

  /** Current state of a handle; finalizes (select+import) on completion. */
  async status(handleId: string, signal?: AbortSignal): Promise<AcquireResult> {
    const record = await this.store.get(handleId)
    if (record === undefined) {
      throw new AcquisitionError(`unknown handle '${handleId}'`, 'ACQUIRE_NOT_FOUND', { permanent: true })
    }
    if (terminal(record.state)) return this.render(record)
    const backend = this.makeBackend(record.backend as TorrentClientName)
    let current: BackendStatus
    try {
      current = await backend.status(record.handle, ...(signal !== undefined ? [signal] : []))
    } catch (error: unknown) {
      if (error instanceof AcquisitionError && error.code === 'ACQUIRE_NOT_CONFIGURED') throw error
      throw error
    }
    if (current.state === 'completed' && current.contentPath !== undefined) {
      return await this.finalize(record, current.contentPath)
    }
    if (current.state === 'failed' || current.state === 'missing') {
      const updated: StoredAcquisition = {
        ...record,
        state: current.state,
        progress: current.progress,
        updatedAt: new Date().toISOString(),
        ...(current.error !== undefined && current.error !== '' ? { error: current.error } : {}),
      }
      await this.store.put(updated)
      return this.render(updated)
    }
    const updated: StoredAcquisition = { ...record, state: current.state, progress: current.progress, updatedAt: new Date().toISOString() }
    await this.store.put(updated)
    return this.render(updated)
  }

  private render(record: StoredAcquisition): AcquireResult {
    return {
      handle: record.id,
      state: record.state,
      progress: record.progress,
      files: record.files,
      ...(record.error !== undefined ? { error: record.error } : {}),
      ...(record.backend !== 'direct' ? { backend: record.backend } : {}),
    }
  }

  /** Route one fetched file: torrent pointer → client, NZB → refused, content → select+import. */
  private async branchFetchedFile(
    id: string,
    file: FetchedFile,
    title: string,
    waitMs: number,
    signal: AbortSignal | undefined,
  ): Promise<AcquireResult> {
    const kind = mediaKind(file.mime)
    if (kind === 'torrent') {
      return await this.submitTorrentBytes(id, await fs.readFile(file.path), file.path, title, waitMs, signal)
    }
    if (kind === 'nzb') {
      await fs.unlink(file.path).catch(() => undefined)
      throw new AcquisitionError(
        'release is an NZB but no Usenet backend is configured (this arm supports torrents and direct downloads only)',
        'ACQUIRE_UNSUPPORTED',
        { permanent: true },
      )
    }
    if (file.mime === 'application/octet-stream') {
      const data = await fs.readFile(file.path)
      if (isTorrent(data)) return await this.submitTorrentBytes(id, data, file.path, title, waitMs, signal)
    }
    // Content file: type check only (no name-based exclusions for a single download).
    const single = new SelectionPolicy({
      accept: [...(this.options.selection.accept ?? ['*'])],
      reject: [...(this.options.selection.reject ?? [])],
      ...(this.options.selection.minSize !== undefined ? { minSize: this.options.selection.minSize } : {}),
      ...(this.options.selection.maxSize !== undefined ? { maxSize: this.options.selection.maxSize } : {}),
      excludePatterns: [],
      mode: 'all',
      maxFiles: 1,
    })
    const chosen = single.selectFiles(file.path)
    if (chosen.length === 0) {
      await fs.unlink(file.path).catch(() => undefined)
      throw new AcquisitionError(
        `downloaded file is ${file.mime}, which accept/reject does not allow`,
        'ACQUIRE_SELECT_REJECTED',
        { permanent: true },
      )
    }
    const destDir = join(this.options.downloadDir, 'imports', id)
    const imported = importFiles([file.path], destDir, { mode: this.options.importMode, root: dirname(file.path) })
    const first = imported[0] as string
    const record: StoredAcquisition = {
      id,
      backend: 'direct',
      handle: {},
      title,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      state: 'completed',
      progress: 1,
      files: [{ path: first, size: file.size, mime: file.mime }],
    }
    await this.store.put(record)
    return this.render(record)
  }

  /** Submit a torrent payload, trying backends in order, then poll within the wait budget. */
  private async submitTorrent(
    id: string,
    payload: TorrentPayload,
    title: string,
    waitMs: number,
    signal: AbortSignal | undefined,
  ): Promise<AcquireResult> {
    if (this.options.torrentClients.length === 0) {
      throw new AcquisitionError('release is a torrent but no torrent client is configured', 'ACQUIRE_NO_BACKEND', { permanent: true })
    }
    let handle: Record<string, unknown> | undefined
    let backendName: TorrentClientName | undefined
    let lastError: AcquisitionError | undefined
    for (const name of this.options.torrentClients) {
      try {
        const backend = this.makeBackend(name)
        handle = await backend.submit(payload, `acquire-${id}`, ...(signal !== undefined ? [signal] : []))
        backendName = name
        break
      } catch (error: unknown) {
        if (!(error instanceof AcquisitionError)) throw error
        // The payload's fault (or otherwise hopeless): no other backend can help.
        if (error.permanent) throw error
        lastError = error
      }
    }
    if (handle === undefined || backendName === undefined) {
      throw lastError ?? new AcquisitionError('no torrent client is configured', 'ACQUIRE_NO_BACKEND', { permanent: true })
    }
    const backend = this.makeBackend(backendName)
    const now = new Date().toISOString()
    let record: StoredAcquisition = {
      id, backend: backendName, handle, title,
      createdAt: now, updatedAt: now, state: 'queued', progress: 0, files: [],
    }
    await this.store.put(record)

    const deadline = Date.now() + waitMs
    for (;;) {
      let current: BackendStatus
      try {
        current = await backend.status(record.handle, ...(signal !== undefined ? [signal] : []))
      } catch (error: unknown) {
        if (error instanceof AcquisitionError && error.code === 'ACQUIRE_NOT_CONFIGURED') throw error
        throw error
      }
      if (current.state === 'completed' && current.contentPath !== undefined) return await this.finalize(record, current.contentPath)
      if (current.state === 'failed' || current.state === 'missing') {
        record = {
          ...record,
          state: current.state,
          progress: current.progress,
          updatedAt: new Date().toISOString(),
          ...(current.error !== undefined && current.error !== '' ? { error: current.error } : {}),
        }
        await this.store.put(record)
        return this.render(record)
      }
      record = { ...record, state: current.state, progress: current.progress, updatedAt: new Date().toISOString() }
      await this.store.put(record)
      if (Date.now() >= deadline) return this.render(record)
      try {
        await sleep(Math.min(this.options.pollIntervalMs, Math.max(0, deadline - Date.now())), ...(signal !== undefined ? [signal] : []))
      } catch {
        return this.render(record)
      }
    }
  }

  /** Select content files out of a completed download and import them. */
  private async finalize(record: StoredAcquisition, contentPath: string): Promise<AcquireResult> {
    const selection = new SelectionPolicy({ ...this.options.selection })
    const files = selection.selectFiles(contentPath)
    if (files.length === 0) {
      const updated: StoredAcquisition = {
        ...record, state: 'failed', progress: 1, updatedAt: new Date().toISOString(),
        error: 'no files matched the accepted types',
      }
      await this.store.put(updated)
      return this.render(updated)
    }
    let root: string | undefined
    try {
      root = (await fs.stat(contentPath)).isDirectory() ? contentPath : dirname(contentPath)
    } catch {
      root = undefined
    }
    const destDir = join(this.options.downloadDir, 'imports', record.id)
    // importFiles preserves order: imported[i] holds the content of files[i].
    const imported = importFiles(files.map(f => f.path), destDir, {
      mode: this.options.importMode,
      ...(root !== undefined ? { root } : {}),
    })
    const resolved: AcquiredFile[] = []
    for (const [index, path] of imported.entries()) {
      const source = files[index] as AcquiredFile
      let size = source.size
      try {
        size = (await fs.stat(path)).size
      } catch {
        // Keep the selected size.
      }
      resolved.push({ path, size, mime: source.mime })
    }
    const updated: StoredAcquisition = { ...record, state: 'completed', progress: 1, updatedAt: new Date().toISOString(), files: resolved }
    await this.store.put(updated)
    return this.render(updated)
  }

  /** Submit raw `.torrent` bytes (the spool file is removed once parsed). */
  private async submitTorrentBytes(
    id: string,
    data: Uint8Array,
    spoolPath: string,
    title: string,
    waitMs: number,
    signal: AbortSignal | undefined,
  ): Promise<AcquireResult> {
    const meta = parseTorrent(data)
    await fs.unlink(spoolPath).catch(() => undefined)
    const payload: TorrentPayload = {
      torrent: data,
      ...(meta.infoHash !== '' ? { infoHash: meta.infoHash } : {}),
    }
    return await this.submitTorrent(id, payload, title, waitMs, signal)
  }

  /** Display title for a source (exported for tests). */
  static displayTitle(input: AcquireSubmitInput, fallback: string): string {
    if (input.title !== undefined && input.title !== '') return input.title
    for (const candidate of [input.magnet, input.magnetUrl]) {
      if (candidate !== undefined && candidate !== '') {
        const dn = magnetDisplayName(candidate)
        if (dn !== undefined) return dn
      }
    }
    if (input.url !== undefined && input.url !== '') {
      try {
        const base = decodeURIComponent(basename(new URL(input.url).pathname))
        if (base !== '') return base
      } catch {
        // Fall through to the link/guid fallbacks.
      }
    }
    const link = (input.downloadUrl !== undefined && input.downloadUrl !== '' ? input.downloadUrl : undefined)
      ?? input.magnetUrl
    if (link !== undefined && link !== '') return describeUrl(link)
    return input.guid ?? fallback
  }
}
