/**
 * Wire types for the Prowlarr v1 REST API (`/api/v1/indexer`, `/api/v1/search`)
 * and the normalized, model-safe shapes this package returns. Types only.
 *
 * Wire shapes follow `Prowlarr.Api.V1` resources (System.Text.Json, camelCase,
 * enums serialized as camelCase strings). Every field is optional on the wire
 * side: the plugin treats Prowlarr as untrusted input and normalizes defensively.
 *
 * @module dsh-tool-prowlarr/types
 */

/** Newznab search mode accepted by `GET /api/v1/search?type=`. */
export type ProwlarrSearchType = 'search' | 'tvsearch' | 'movie' | 'music' | 'book'

/** All accepted search modes, in the order the tool schema advertises them. */
export const PROWLARR_SEARCH_TYPES: readonly ProwlarrSearchType[] = ['search', 'tvsearch', 'movie', 'music', 'book']

/** `IndexerCategory` (Newznab category, possibly with sub-categories). */
export interface ProwlarrWireCategory {
  id?: number
  name?: string
  subCategories?: ProwlarrWireCategory[]
}

/** `IndexerResource` subset the plugin reads. */
export interface ProwlarrWireIndexer {
  id?: number
  name?: string
  description?: string
  definitionName?: string
  enable?: boolean
  protocol?: string
  privacy?: string
  supportsSearch?: boolean
  supportsPagination?: boolean
  priority?: number
  tags?: number[]
  capabilities?: {
    limitsMax?: number | null
    limitsDefault?: number | null
    categories?: ProwlarrWireCategory[]
    searchParams?: string[]
    tvSearchParams?: string[]
    movieSearchParams?: string[]
    musicSearchParams?: string[]
    bookSearchParams?: string[]
  }
}

/** `ReleaseResource` subset the plugin reads. */
export interface ProwlarrWireRelease {
  guid?: string
  title?: string
  indexerId?: number
  indexer?: string
  protocol?: string
  publishDate?: string
  ageHours?: number
  size?: number
  files?: number | null
  grabs?: number | null
  seeders?: number | null
  leechers?: number | null
  infoUrl?: string | null
  commentUrl?: string | null
  downloadUrl?: string | null
  magnetUrl?: string | null
  categories?: ProwlarrWireCategory[]
}

/** A Newznab category as returned to the model (top level only). */
export interface ProwlarrCategory {
  id: number
  name: string
}

/** One configured indexer, normalized. */
export interface ProwlarrIndexer {
  id: number
  name: string
  enabled: boolean
  protocol: string
  privacy?: string
  description?: string
  definitionName?: string
  supportsSearch: boolean
  /** Search modes the indexer declares parameters for (`search`, `tvsearch`, …). */
  searchTypes: ProwlarrSearchType[]
  categories: ProwlarrCategory[]
}

/** One search hit, normalized. URLs never carry the Prowlarr API key. */
export interface ProwlarrRelease {
  title: string
  indexer: string
  indexerId: number
  protocol: string
  guid?: string
  publishDate?: string
  ageHours?: number
  size?: number
  files?: number
  grabs?: number
  seeders?: number
  leechers?: number
  infoUrl?: string
  commentUrl?: string
  downloadUrl?: string
  magnetUrl?: string
  /** Short server-side ref for these links (see `./links`); absent when the hit carries no fetchable link. */
  ref?: string
  categories: ProwlarrCategory[]
}

/** Fully resolved search request sent to Prowlarr. */
export interface ProwlarrSearchRequest {
  query: string
  type: ProwlarrSearchType
  indexerIds?: readonly number[]
  categories?: readonly number[]
  limit?: number
  offset?: number
}

/** Failure classes a caller can route on. */
export type ProwlarrErrorCode =
  | 'PROWLARR_NOT_CONFIGURED'
  | 'PROWLARR_INVALID_REQUEST'
  | 'PROWLARR_UNAUTHORIZED'
  | 'PROWLARR_HTTP_ERROR'
  | 'PROWLARR_NETWORK_ERROR'
  | 'PROWLARR_BAD_RESPONSE'
  | 'PROWLARR_TIMEOUT'
  | 'PROWLARR_ABORTED'
