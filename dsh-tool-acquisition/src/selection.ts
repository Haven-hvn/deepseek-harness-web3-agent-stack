/**
 * Choose the content files inside a completed download. Ported from Haven
 * CLI's `acquisition/selection.py`: clients leave behind extras (`.nfo`,
 * samples, par2 sets); this filters a file or directory down to what
 * should be archived, by type, size, and name. Types are sniffed from
 * content, not trusted from extensions.
 *
 * @module dsh-tool-acquisition/selection
 */

import { lstatSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { detectMime, mediaKind, mimeFromExtension, mimeMatches, POINTER_KINDS } from './filetype.ts'
import type { AcquiredFile, SelectMode } from './types.ts'

/** Names skipped by default: samples, par2 sets, client temp files. */
export const DEFAULT_EXCLUDE_PATTERNS: ReadonlyArray<string> = [
  '(^|[\\W_])sample([\\W_]|$)',
  '\\.par2$',
  '\\.(nfo|sfv|srr|url|lnk|db|ds_store)$',
  '^\\.',
  '\\.(part|!qb|!ut|bc!|crdownload|tmp)$',
]

/** Options for {@link SelectionPolicy}. */
export interface SelectionOptions {
  accept?: ReadonlyArray<string>
  reject?: ReadonlyArray<string>
  minSize?: number
  /** 0 = unlimited. */
  maxSize?: number
  excludePatterns?: ReadonlyArray<string>
  mode?: SelectMode
  maxFiles?: number
}

/** Which files inside a download count as content. */
export class SelectionPolicy {
  private readonly accept: ReadonlyArray<string>
  private readonly reject: ReadonlyArray<string>
  private readonly minSize: number
  private readonly maxSize: number
  private readonly compiled: RegExp[]
  readonly mode: SelectMode
  private readonly maxFiles: number

  constructor(options: SelectionOptions = {}) {
    this.accept = options.accept ?? ['*']
    this.reject = options.reject ?? []
    this.minSize = options.minSize ?? 0
    this.maxSize = options.maxSize ?? 0
    this.mode = options.mode ?? 'all'
    this.maxFiles = options.maxFiles ?? 1000
    this.compiled = (options.excludePatterns ?? DEFAULT_EXCLUDE_PATTERNS).map(p => new RegExp(p, 'i'))
  }

  /** Whether `name` is excluded by pattern. */
  excludedName(name: string): boolean {
    return this.compiled.some(rx => rx.test(name))
  }

  /** Whether a MIME type is archivable content (never a pointer). */
  acceptsMime(mime: string | undefined): boolean {
    if (POINTER_KINDS.has(mediaKind(mime))) return false
    return mimeMatches(mime, this.accept) && !mimeMatches(mime, this.reject)
  }

  /** Decide from the file name alone; `undefined` when the extension is unknown. */
  acceptsName(name: string): boolean | undefined {
    const base = name.split('/').pop() ?? name
    if (this.excludedName(base)) return false
    const mime = mimeFromExtension(name)
    if (mime === undefined) return undefined
    return this.acceptsMime(mime)
  }

  /** Content files under `root` (a file or directory) satisfying the policy. */
  selectFiles(root: string): AcquiredFile[] {
    const chosen: AcquiredFile[] = []
    for (const path of iterFiles(root)) {
      const base = path.split('/').pop() ?? path
      if (this.excludedName(base)) continue
      let size: number
      try {
        size = statSync(path).size
      } catch {
        continue
      }
      if (size < this.minSize || (this.maxSize > 0 && size > this.maxSize)) continue
      const mime = detectMime(path)
      if (!this.acceptsMime(mime)) continue
      chosen.push({ path, size, mime })
      if (chosen.length >= this.maxFiles) break
    }
    if (this.mode === 'largest' && chosen.length > 0) {
      let best = chosen[0] as AcquiredFile
      for (const file of chosen) {
        if (file.size > best.size) best = file
      }
      return [best]
    }
    return chosen
  }
}

/** Files under `root`, sorted; symlinks are never followed. */
function iterFiles(root: string): string[] {
  const out: string[] = []
  let stat: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }
  try {
    stat = lstatSync(root)
  } catch {
    return out
  }
  if (stat.isSymbolicLink()) return out
  if (stat.isFile()) return [root]
  if (!stat.isDirectory()) return out
  const stack: string[] = [root]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries: string[]
    try {
      entries = readdirSync(dir).sort()
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry)
      let child: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }
      try {
        child = lstatSync(full)
      } catch {
        continue
      }
      if (child.isSymbolicLink()) continue
      if (child.isFile()) out.push(full)
      else if (child.isDirectory()) stack.push(full)
    }
  }
  return out.sort()
}
