/**
 * Canonical JSON for tool-argument identity: the same value always yields
 * the same key regardless of property order (the repeat-tool-reminder
 * identity rule). JSON semantics otherwise — `undefined` object members
 * are dropped, array holes become `null`.
 *
 * @module dsh-exactly-once/canonical
 */

/** Render one value in canonical form (total: cycles become a marker). */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sort(value, new Set())) ?? 'null'
}

function sort(value: unknown, seen: Set<object>): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    const out = value.map(entry => {
      const sorted = sort(entry, seen)
      return sorted === undefined ? null : sorted
    })
    seen.delete(value)
    return out
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    const record = value as Record<string, unknown>
    const entries: Array<readonly [string, unknown]> = []
    for (const key of Object.keys(record).sort()) {
      const sorted = sort(record[key], seen)
      if (sorted !== undefined) entries.push([key, sorted])
    }
    seen.delete(value)
    return Object.fromEntries(entries)
  }
  return typeof value === 'function' || typeof value === 'symbol' ? undefined : value
}
