/**
 * URL hygiene for anything that leaves the process. Ported from the reference
 * `services/url_safety.py` (same semantics, same parameter table):
 *
 * - {@link redactText} — replace known secrets in free text.
 * - {@link publicUrl} — a version of a URL safe to *publish* (http(s) only,
 *   no userinfo, no credential-like params, no known secrets).
 * - {@link stripSensitiveParams} — drop credential-like params from a URL
 *   we still need to *use*.
 * - {@link describeUrl} — a secret-free `scheme://host/…` log label.
 *
 * @module dsh-tool-acquisition/redact
 */

/** Placeholder substituted for secrets in model-facing text. */
export const REDACTED = '[REDACTED]'

/**
 * Query parameters treated as credentials (compared case-insensitively,
 * `-`/`_` ignored). Covers Prowlarr/*arr API keys and private-tracker
 * passkey spellings.
 */
export const SENSITIVE_QUERY_PARAMS: ReadonlySet<string> = new Set([
  'apikey', 'key', 'token', 'accesstoken', 'auth', 'authkey', 'authtoken',
  'passkey', 'torrentpass', 'rsskey', 'secret', 'password', 'pass',
  'sig', 'signature', 'uid', 'session', 'sessionid', 'sid',
])

function normParam(name: string): string {
  return name.replace(/[-_]/g, '').toLowerCase()
}

/** Whether a query parameter name looks like a credential. */
export function isSensitiveParam(name: string): boolean {
  return SENSITIVE_QUERY_PARAMS.has(normParam(name))
}

/** Replace every occurrence of each non-trivial secret in `text`. */
export function redactText(text: string, secrets: ReadonlyArray<string | undefined> = []): string {
  let out = text
  for (const secret of secrets) {
    if (secret !== undefined && secret.length >= 4) out = out.split(secret).join(REDACTED)
  }
  return out
}

/**
 * Drop credential-like query params and userinfo; keep everything else.
 * Accepts any scheme and never returns `undefined` — for URLs we use.
 */
export function stripSensitiveParams(url: string, secrets: ReadonlyArray<string | undefined> = []): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return redactText(url, secrets)
  }
  parsed.username = ''
  parsed.password = ''
  const kept = new URLSearchParams()
  for (const [k, v] of parsed.searchParams) {
    if (!isSensitiveParam(k)) kept.append(k, v)
  }
  parsed.search = kept.toString()
  return redactText(parsed.toString(), secrets)
}

const TOKEN_SEGMENT = /^[A-Za-z0-9_-]{20,}$/

/**
 * Whether a URL path segment looks like an embedded credential: 20+
 * `[A-Za-z0-9_-]` chars containing both letters and digits.
 */
export function hasTokenLikeSegment(url: string): boolean {
  let path: string
  try {
    path = new URL(url).pathname
  } catch {
    return true
  }
  for (const segment of path.split('/')) {
    if (TOKEN_SEGMENT.test(segment) && /[A-Za-z]/.test(segment) && /\d/.test(segment)) return true
  }
  return false
}

/**
 * A version of `url` safe to publish, or `undefined` if there is none.
 * Only http/https URLs with a host qualify; fragments are removed.
 */
export function publicUrl(
  url: string | undefined,
  secrets: ReadonlyArray<string | undefined> = [],
  options?: { rejectTokenPaths?: boolean },
): string | undefined {
  if (url === undefined || url.trim() === '') return undefined
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return undefined
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.hostname === '') return undefined
  const secretValues = secrets.filter((s): s is string => s !== undefined && s.length >= 4)
  parsed.username = ''
  parsed.password = ''
  parsed.hash = ''
  const kept = new URLSearchParams()
  for (const [k, v] of parsed.searchParams) {
    if (!isSensitiveParam(k)) kept.append(k, v)
  }
  parsed.search = kept.toString()
  const rebuilt = parsed.toString()
  if (secretValues.some(secret => rebuilt.includes(secret))) return undefined
  if (options?.rejectTokenPaths === true && hasTokenLikeSegment(rebuilt)) return undefined
  return rebuilt
}

/** Short, secret-free description of a URL for logs: `scheme://host/…`. */
export function describeUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return '<invalid url>'
  }
  if (parsed.protocol === 'magnet:') return 'magnet:<…>'
  const host = parsed.hostname
  return parsed.pathname !== '' && parsed.pathname !== '/' ? `${parsed.protocol}//${host}/…` : `${parsed.protocol}//${host}/`
}
