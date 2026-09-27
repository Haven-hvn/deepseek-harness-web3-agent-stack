/**
 * Outbound fetch-target validation for URLs from third-party data
 * (indexers, redirects). Ported from Haven CLI's
 * `services/url_safety.check_fetch_target`: scheme, optional host
 * allowlist, and a block on loopback / private / link-local / reserved
 * addresses to prevent SSRF.
 *
 * Note: resolution happens here and again inside the HTTP client, so a
 * hostile DNS server could still rebind between the two. Combine with
 * `allowedHosts` when that matters.
 *
 * @module dsh-tool-acquisition/fetchSafety
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { UnsafeURLError } from './errors.ts'

/** Case-insensitive host match; `example.org` also matches subdomains. A `*.` pattern matches subdomains only. */
export function hostMatches(host: string, patterns: ReadonlyArray<string>): boolean {
  const bare = host.toLowerCase().replace(/\.$/, '')
  for (const raw of patterns) {
    const pattern = raw.toLowerCase().trim().replace(/\.$/, '')
    if (pattern === '') continue
    if (pattern.startsWith('*.')) {
      if (bare.endsWith(pattern.slice(1))) return true
    } else if (bare === pattern || bare.endsWith(`.${pattern}`)) {
      return true
    }
  }
  return false
}

function ipv4ToInt(addr: string): number | undefined {
  const parts = addr.split('.')
  if (parts.length !== 4) return undefined
  let out = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const n = Number(part)
    if (n > 255) return undefined
    out = out * 256 + n
  }
  return out >>> 0
}

function inCidrV4(addr: number, base: string, bits: number): boolean {
  const baseInt = ipv4ToInt(base)
  if (baseInt === undefined) return false
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (addr & mask) === (baseInt & mask)
}

/** Non-public IPv4 ranges (loopback, private, link-local, shared, multicast, reserved, documentation). */
const IPV4_NON_PUBLIC: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.2.0', 24], ['192.168.0.0', 16],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]

function ipv4IsPublic(addr: string): boolean {
  const n = ipv4ToInt(addr)
  if (n === undefined) return false
  return !IPV4_NON_PUBLIC.some(([base, bits]) => inCidrV4(n, base, bits))
}

/** Expand an IPv6 literal to 8 hextets (no scope id). */
function expandIpv6(addr: string): number[] | undefined {
  const bare = addr.split('%')[0] ?? ''
  // IPv4-mapped tail (::ffff:a.b.c.d): translate to hextets.
  const lastColon = bare.lastIndexOf(':')
  let head = bare
  let tail: number[] = []
  if (lastColon >= 0 && bare.slice(lastColon + 1).includes('.')) {
    const v4 = ipv4ToInt(bare.slice(lastColon + 1))
    if (v4 === undefined) return undefined
    tail = [(v4 >>> 16) & 0xffff, v4 & 0xffff]
    head = bare.slice(0, lastColon)
    if (head.endsWith(':')) head = head.slice(0, -1)
  }
  const halves = head.split('::')
  if (halves.length > 2) return undefined
  const parse = (part: string): number[] | undefined => {
    if (part === '') return []
    const out: number[] = []
    for (const h of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(h)) return undefined
      out.push(Number.parseInt(h, 16))
    }
    return out
  }
  const left = parse(halves[0] ?? '')
  const right = halves.length === 2 ? parse(halves[1] ?? '') : []
  if (left === undefined || right === undefined) return undefined
  const missing = 8 - tail.length - left.length - right.length
  if (halves.length === 1 ? missing !== 0 : missing < 0) return undefined
  return [...left, ...new Array<number>(Math.max(0, missing)).fill(0), ...right, ...tail]
}

function ipv6IsPublic(addr: string): boolean {
  const h = expandIpv6(addr)
  if (h === undefined || h.length !== 8) return false
  const [h0 = 0, h1 = 0, h2 = 0, h3 = 0, h4 = 0, h5 = 0, h6 = 0, h7 = 0] = h
  if (h.every(v => v === 0)) return false // ::
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0 && h6 === 0 && h7 === 1) return false // ::1
  if ((h0 & 0xffc0) === 0xfe80) return false // fe80::/10 link-local
  if ((h0 & 0xfe00) === 0xfc00) return false // fc00::/7 unique-local
  if ((h0 & 0xff00) === 0xff00) return false // ff00::/8 multicast
  if (h0 === 0x2001 && h1 === 0x0db8) return false // 2001:db8::/32 documentation
  if (h0 === 0x0064 && h1 === 0xff9b) return false // 64:ff9b::/96 translation
  // ::ffff:0:0/96 — judge the embedded IPv4 address.
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff) {
    return ipv4IsPublic(`${(h6 >>> 8) & 0xff}.${h6 & 0xff}.${(h7 >>> 8) & 0xff}.${h7 & 0xff}`)
  }
  return true
}

/** Whether a literal IP address is routable on the public internet. */
export function ipIsPublic(addr: string): boolean {
  const family = isIP(addr)
  if (family === 4) return ipv4IsPublic(addr)
  if (family === 6) return ipv6IsPublic(addr)
  return false
}

/** Options for {@link checkFetchTarget}. */
export interface FetchTargetOptions {
  allowedHosts?: ReadonlyArray<string>
  allowPrivate?: boolean
  allowedSchemes?: ReadonlyArray<string>
}

/**
 * Validate an outbound fetch target derived from untrusted data.
 * @throws UnsafeURLError when the scheme, host, or resolved address is refused.
 */
export async function checkFetchTarget(url: string, options: FetchTargetOptions = {}): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch (error: unknown) {
    throw new UnsafeURLError(`invalid URL: ${String(error)}`, { cause: error })
  }
  const schemes = new Set((options.allowedSchemes ?? ['https', 'http']).map(s => s.toLowerCase()))
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase()
  if (!schemes.has(scheme)) throw new UnsafeURLError(`scheme '${scheme}' is not allowed`)
  const host = parsed.hostname
  if (host === '') throw new UnsafeURLError('URL has no host')
  const allowed = (options.allowedHosts ?? []).filter(h => h !== '')
  if (allowed.length > 0 && !hostMatches(host, allowed)) {
    throw new UnsafeURLError(`host '${host}' is not in allowedHosts`)
  }
  if (options.allowPrivate === true) return
  if (isIP(host) !== 0) {
    if (!ipIsPublic(host)) throw new UnsafeURLError(`address ${host} is not public (set allowPrivateHosts to permit)`)
    return
  }
  let records: Array<{ address: string }>
  try {
    records = await lookup(host, { all: true })
  } catch (error: unknown) {
    throw new UnsafeURLError(`cannot resolve '${host}': ${String(error)}`, { cause: error })
  }
  for (const record of records) {
    if (!ipIsPublic(record.address)) {
      throw new UnsafeURLError(`host '${host}' resolves to non-public address ${record.address} (set allowPrivateHosts to permit)`)
    }
  }
}
