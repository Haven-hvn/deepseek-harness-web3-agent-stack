/**
 * `ProwlarrClient`: a minimal, read-only client for the Prowlarr v1 API.
 *
 * - Authenticates with the `X-Api-Key` header (never the `apikey` query
 *   parameter, which would land in proxy and access logs).
 * - Rejects HTTP redirects so the key is never replayed to another origin.
 * - Bounds every request by a client-side timeout composed with the caller's
 *   abort signal, and reports the two outcomes as distinct error codes.
 * - Normalizes every response and strips the API key from returned URLs:
 *   Prowlarr rewrites `downloadUrl`/`magnetUrl` into proxy links of the form
 *   `/{indexerId}/download?apikey=<key>&link=…`, which must never reach a model.
 *
 * @module dsh-tool-prowlarr/client
 */

import type {
  ProwlarrCategory,
  ProwlarrErrorCode,
  ProwlarrIndexer,
  ProwlarrRelease,
  ProwlarrSearchRequest,
  ProwlarrSearchType,
  ProwlarrWireCategory,
  ProwlarrWireIndexer,
  ProwlarrWireRelease,
} from './types.ts'

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'dsh-tool-prowlarr/0.1.0'

/** Placeholder substituted for any occurrence of the API key in model-facing text. */
export const REDACTED = '[REDACTED]'

/** A classified Prowlarr failure. `message` never contains the API key. */
export class ProwlarrError extends Error {
  constructor(message: string, readonly code: ProwlarrErrorCode, options?: { cause?: unknown; status?: number }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'ProwlarrError'
    if (options?.status !== undefined) this.status = options.status
  }

  /** HTTP status, when the failure came from a response. */
  readonly status?: number
}

/** Resolved client options. */
export interface ProwlarrClientOptions {
  /** Prowlarr origin plus optional URL base, e.g. `http://localhost:9696` or `https://host/prowlarr`. */
  baseUrl: string
  /** Prowlarr API key (Settings → General → Security). */
  apiKey: string
  /** Per-request timeout in milliseconds. */
  timeoutMs: number
}

/**
 * Remove the API key from one URL: drop any `apikey` query parameter
 * (case-insensitive) and replace any remaining literal occurrence.
 * @param url - URL as returned by Prowlarr.
 * @param apiKey - the configured key.
 * @returns the redacted URL, or `undefined` for a blank input.
 */
export function redactUrl(url: string | null | undefined, apiKey: string): string | undefined {
  if (url === null || url === undefined || url.trim() === '') return undefined
  let out = url
  if (URL.canParse(url)) {
    const parsed = new URL(url)
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.toLowerCase() === 'apikey') parsed.searchParams.delete(key)
    }
    out = parsed.toString()
  }
  return redactText(out, apiKey)
}

/**
 * Replace every literal occurrence of the API key in free text.
 * @param text - text that may echo request details.
 * @param apiKey - the configured key.
 * @returns the text with the key replaced by {@link REDACTED}.
 */
export function redactText(text: string, apiKey: string): string {
  return apiKey.length > 0 ? text.split(apiKey).join(REDACTED) : text
}

/** Top-level categories only; sub-categories are omitted to keep results compact. */
function mapCategories(categories: ProwlarrWireCategory[] | undefined): ProwlarrCategory[] {
  if (!Array.isArray(categories)) return []
  const out: ProwlarrCategory[] = []
  for (const category of categories) {
    if (typeof category?.id === 'number' && typeof category.name === 'string') {
      out.push({ id: category.id, name: category.name })
    }
  }
  return out
}

/** Optional finite, non-negative number or `undefined`. */
function count(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Optional non-blank string or `undefined`. */
function text(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Normalize one `IndexerResource`, or `undefined` when it lacks an id/name.
 * @param wire - raw indexer.
 * @returns normalized indexer.
 */
export function mapIndexer(wire: ProwlarrWireIndexer): ProwlarrIndexer | undefined {
  if (typeof wire?.id !== 'number' || typeof wire.name !== 'string') return undefined
  const caps = wire.capabilities ?? {}
  const supportsSearch = wire.supportsSearch !== false
  const searchTypes: ProwlarrSearchType[] = []
  if (supportsSearch) searchTypes.push('search')
  if ((caps.tvSearchParams?.length ?? 0) > 0) searchTypes.push('tvsearch')
  if ((caps.movieSearchParams?.length ?? 0) > 0) searchTypes.push('movie')
  if ((caps.musicSearchParams?.length ?? 0) > 0) searchTypes.push('music')
  if ((caps.bookSearchParams?.length ?? 0) > 0) searchTypes.push('book')
  const privacy = text(wire.privacy)
  const description = text(wire.description)
  const definitionName = text(wire.definitionName)
  return {
    id: wire.id,
    name: wire.name,
    enabled: wire.enable === true,
    protocol: text(wire.protocol) ?? 'unknown',
    ...privacy !== undefined ? { privacy } : {},
    ...description !== undefined ? { description } : {},
    ...definitionName !== undefined ? { definitionName } : {},
    supportsSearch,
    searchTypes,
    categories: mapCategories(caps.categories),
  }
}

/**
 * Normalize one `ReleaseResource`, or `undefined` when it has no title.
 * @param wire - raw release.
 * @param apiKey - key to strip from every URL.
 * @returns normalized release.
 */
export function mapRelease(wire: ProwlarrWireRelease, apiKey: string): ProwlarrRelease | undefined {
  const title = text(wire?.title)
  if (title === undefined) return undefined
  const fields: Omit<ProwlarrRelease, 'title' | 'indexer' | 'indexerId' | 'protocol' | 'categories'> = {}
  const guid = text(wire.guid)
  // Some indexers use the download link as the guid, so it is redacted too.
  if (guid !== undefined) fields.guid = redactUrl(guid, apiKey) ?? guid
  const publishDate = text(wire.publishDate)
  if (publishDate !== undefined) fields.publishDate = publishDate
  const ageHours = count(wire.ageHours)
  if (ageHours !== undefined) fields.ageHours = Math.round(ageHours * 10) / 10
  const size = count(wire.size)
  if (size !== undefined && size > 0) fields.size = size
  const files = count(wire.files)
  if (files !== undefined) fields.files = files
  const grabs = count(wire.grabs)
  if (grabs !== undefined) fields.grabs = grabs
  const seeders = count(wire.seeders)
  if (seeders !== undefined) fields.seeders = seeders
  const leechers = count(wire.leechers)
  if (leechers !== undefined) fields.leechers = leechers
  const infoUrl = redactUrl(wire.infoUrl, apiKey)
  if (infoUrl !== undefined) fields.infoUrl = infoUrl
  const commentUrl = redactUrl(wire.commentUrl, apiKey)
  if (commentUrl !== undefined) fields.commentUrl = commentUrl
  const downloadUrl = redactUrl(wire.downloadUrl ?? wire.magnetUrl, apiKey)
  if (downloadUrl !== undefined) fields.downloadUrl = downloadUrl
  return {
    title,
    indexer: text(wire.indexer) ?? 'unknown',
    indexerId: typeof wire.indexerId === 'number' ? wire.indexerId : -1,
    protocol: text(wire.protocol) ?? 'unknown',
    ...fields,
    categories: mapCategories(wire.categories),
  }
}

/** Read-only Prowlarr v1 client. */
export class ProwlarrClient {
  constructor(private readonly options: ProwlarrClientOptions) {}

  /** Whether the client has enough configuration to make a request. */
  configured(): boolean {
    return this.options.apiKey.length > 0 && URL.canParse(this.options.baseUrl)
  }

  /**
   * `GET /api/v1/indexer`, normalized.
   * @param signal - caller cancellation.
   * @returns every configured indexer, enabled or not.
   */
  async listIndexers(signal?: AbortSignal): Promise<ProwlarrIndexer[]> {
    const body = await this.get('/api/v1/indexer', new URLSearchParams(), signal)
    if (!Array.isArray(body)) throw new ProwlarrError('Prowlarr returned a non-array indexer list', 'PROWLARR_BAD_RESPONSE')
    return (body as ProwlarrWireIndexer[])
      .map(mapIndexer)
      .filter((indexer): indexer is ProwlarrIndexer => indexer !== undefined)
  }

  /**
   * `GET /api/v1/search`, normalized. Prowlarr fans out to the selected
   * indexers (all enabled indexers when `indexerIds` is absent).
   * @param request - resolved search request.
   * @param signal - caller cancellation.
   * @returns normalized releases in Prowlarr's order.
   */
  async search(request: ProwlarrSearchRequest, signal?: AbortSignal): Promise<ProwlarrRelease[]> {
    const params = new URLSearchParams({ query: request.query, type: request.type })
    // ASP.NET binds List<int> from repeated keys.
    for (const id of request.indexerIds ?? []) params.append('indexerIds', String(id))
    for (const category of request.categories ?? []) params.append('categories', String(category))
    if (request.limit !== undefined) params.set('limit', String(request.limit))
    if (request.offset !== undefined) params.set('offset', String(request.offset))
    const body = await this.get('/api/v1/search', params, signal)
    if (!Array.isArray(body)) throw new ProwlarrError('Prowlarr returned a non-array search result', 'PROWLARR_BAD_RESPONSE')
    return (body as ProwlarrWireRelease[])
      .map(release => mapRelease(release, this.options.apiKey))
      .filter((release): release is ProwlarrRelease => release !== undefined)
  }

  /** One authenticated GET returning parsed JSON; every failure is a {@link ProwlarrError}. */
  private async get(path: string, params: URLSearchParams, signal?: AbortSignal): Promise<unknown> {
    if (!this.configured()) {
      throw new ProwlarrError(
        'Prowlarr is not configured: set `apiKey` (or PROWLARR_API_KEY) and a valid `baseUrl`',
        'PROWLARR_NOT_CONFIGURED',
      )
    }
    const key = this.options.apiKey
    const url = new URL(this.options.baseUrl.replace(/\/+$/, '') + path)
    url.search = params.toString()
    const timeout = AbortSignal.timeout(this.options.timeoutMs)
    const combined = signal !== undefined ? AbortSignal.any([signal, timeout]) : timeout
    const classifyAbort = (error: unknown): ProwlarrError | undefined => {
      if (signal?.aborted === true) return new ProwlarrError('Prowlarr request aborted', 'PROWLARR_ABORTED', { cause: error })
      if (timeout.aborted) {
        return new ProwlarrError(`Prowlarr request timed out after ${this.options.timeoutMs}ms`, 'PROWLARR_TIMEOUT', { cause: error })
      }
      return undefined
    }

    let response: Response
    try {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'error',
        headers: { 'x-api-key': key, 'accept': 'application/json', 'user-agent': USER_AGENT },
        signal: combined,
      })
    } catch (error: unknown) {
      throw classifyAbort(error)
        ?? new ProwlarrError(redactText(`Prowlarr request failed: ${String(error)}`, key), 'PROWLARR_NETWORK_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let detail = ''
      try {
        detail = errorDetail(await response.json())
      } catch (error: unknown) {
        const aborted = classifyAbort(error)
        if (aborted !== undefined) throw aborted
        // Non-JSON error body (reverse proxy page, gateway error): the status is enough.
      }
      const code: ProwlarrErrorCode = status === 401 || status === 403 ? 'PROWLARR_UNAUTHORIZED' : 'PROWLARR_HTTP_ERROR'
      const message = `Prowlarr API error (HTTP ${status})${detail !== '' ? `: ${detail}` : ''}`
      throw new ProwlarrError(redactText(message, key), code, { status })
    }

    try {
      return await response.json()
    } catch (error: unknown) {
      throw classifyAbort(error)
        ?? new ProwlarrError('Prowlarr returned an unparseable response body', 'PROWLARR_BAD_RESPONSE', { cause: error })
    }
  }
}

/** Extract a human-readable message from Prowlarr's error envelopes. */
function errorDetail(body: unknown): string {
  if (Array.isArray(body)) {
    // FluentValidation: [{ propertyName, errorMessage }]
    return body
      .map(entry => (entry as { errorMessage?: unknown })?.errorMessage)
      .filter((message): message is string => typeof message === 'string' && message !== '')
      .join('; ')
  }
  if (body !== null && typeof body === 'object') {
    const { message, description } = body as { message?: unknown; description?: unknown }
    return [message, description].filter((part): part is string => typeof part === 'string' && part !== '').join(' — ')
  }
  return ''
}
