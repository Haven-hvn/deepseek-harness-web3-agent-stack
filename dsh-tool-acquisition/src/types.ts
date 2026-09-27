/**
 * Shared shapes for the acquisition arm.
 *
 * The lifecycle mirrors the reference `DownloadClient`/`ClientStatus` pair:
 * submit a payload, get back an opaque handle, poll the handle until it
 * reaches a terminal state. Handles are persisted in a JSON store so a
 * poll after an agent restart still resolves.
 *
 * @module dsh-tool-acquisition/types
 */

/** Torrent backends, tried in configured order. */
export const TORRENT_CLIENTS = ['qbittorrent', 'transmission'] as const
/** One torrent backend. */
export type TorrentClientName = (typeof TORRENT_CLIENTS)[number]

/** Download states. `completed`/`failed`/`missing` are terminal. */
export type AcquireState = 'queued' | 'downloading' | 'completed' | 'failed' | 'missing'

/** How completed files enter the workspace (the *arr convention). */
export type ImportMode = 'hardlink' | 'copy' | 'move' | 'inplace'

/** `all` keeps every match; `largest` keeps only the biggest file. */
export type SelectMode = 'all' | 'largest'

/** Stable failure codes. Messages never contain secrets. */
export type AcquisitionErrorCode =
  | 'ACQUIRE_NOT_CONFIGURED'
  | 'ACQUIRE_INVALID_REQUEST'
  | 'ACQUIRE_UNSAFE_URL'
  | 'ACQUIRE_FETCH_ERROR'
  | 'ACQUIRE_TOO_LARGE'
  | 'ACQUIRE_INVALID_TORRENT'
  | 'ACQUIRE_NO_BACKEND'
  | 'ACQUIRE_BACKEND_ERROR'
  | 'ACQUIRE_BACKEND_AUTH'
  | 'ACQUIRE_PROWLARR_AUTH'
  | 'ACQUIRE_NOT_FOUND'
  | 'ACQUIRE_UNSUPPORTED'
  | 'ACQUIRE_SELECT_REJECTED'

/** A Prowlarr release reference, as returned by `prowlarr_search` (redacted form). */
export interface ProwlarrReleaseRef {
  /** Redacted proxy link; the arm re-attaches the API key server-side. Never model-supplied with a key. */
  downloadUrl?: string
  magnetUrl?: string
  guid?: string
  indexerId?: number
  protocol?: string
  title?: string
}

/** One acquired content file. */
export interface AcquiredFile {
  path: string
  size: number
  mime: string
}

/** Submit/poll result. `files` is populated once `state` is `completed`. */
export interface AcquireResult {
  handle: string
  state: AcquireState
  progress: number
  files: AcquiredFile[]
  error?: string
  backend?: string
}

/** Backend poll answer (Haven `ClientStatus` shape). */
export interface BackendStatus {
  state: AcquireState
  progress: number
  contentPath?: string
  files: string[]
  error?: string
}

/** A torrent payload: magnet URI or raw `.torrent` bytes. */
export interface TorrentPayload {
  magnet?: string
  torrent?: Uint8Array
  infoHash?: string
}

/** Persisted submit record. The backend `handle` is backend-opaque JSON. */
export interface StoredAcquisition {
  id: string
  backend: string
  handle: Record<string, unknown>
  title: string
  createdAt: string
  updatedAt: string
  state: AcquireState
  progress: number
  files: AcquiredFile[]
  error?: string
  /**
   * Content identity for exactly-once resubmits (`torrent:<infohash>`,
   * `url-sha:<hex>`, `ref-sha:<hex>`). Absent on pre-exactly-once records
   * and unparseable magnets, which never dedup.
   */
  contentKey?: string
  /** Alias keys resolving to the same record (e.g. the URL that discovered the torrent). */
  aliases?: string[]
}
