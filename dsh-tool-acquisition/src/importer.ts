/**
 * Bring completed files into the workspace. Ported from the reference
 * `acquisition/importer.py`: files produced by an external download client
 * usually must stay where they are (the client keeps seeding them), so
 * import modes mirror the *arr convention — `hardlink` (default),
 * `copy`, `move`, `inplace` — plus `remote=local` path mappings for
 * clients that see a different filesystem.
 *
 * @module dsh-tool-acquisition/importer
 */

import { copyFileSync, existsSync, linkSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { safeFilename } from './fetch.ts'
import type { ImportMode } from './types.ts'

/** Options for {@link importFiles}. */
export interface ImportOptions {
  mode?: ImportMode
  /** Preserve relative structure below this directory (when a directory). */
  root?: string
}

function uniqueTarget(path: string): string {
  if (!existsSync(path)) return path
  const dot = path.lastIndexOf('.')
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const stem = dot > slash ? path.slice(0, dot) : path
  const suffix = dot > slash ? path.slice(dot) : ''
  for (let n = 1; n < 10_000; n += 1) {
    const candidate = `${stem} (${n})${suffix}`
    if (!existsSync(candidate)) return candidate
  }
  throw new Error(`no free name near ${path}`)
}

/**
 * Place `files` under `destDir` according to `mode`.
 * Returns the paths the next stage should ingest.
 */
export function importFiles(files: ReadonlyArray<string>, destDir: string, options: ImportOptions = {}): string[] {
  const mode = options.mode ?? 'hardlink'
  if (mode !== 'hardlink' && mode !== 'copy' && mode !== 'move' && mode !== 'inplace') {
    throw new Error(`import mode must be one of hardlink, copy, move, inplace; got '${mode}'`)
  }
  const results: string[] = []
  for (const src of files) {
    if (mode === 'inplace') {
      results.push(src)
      continue
    }
    let relParts: string[]
    if (options.root !== undefined) {
      try {
        if (statSync(options.root).isDirectory()) {
          const rel = relative(options.root, src)
          relParts = rel !== '' && !rel.startsWith('..') ? rel.split(sep) : [src.split(sep).pop() ?? src]
        } else {
          relParts = [src.split(sep).pop() ?? src]
        }
      } catch {
        relParts = [src.split(sep).pop() ?? src]
      }
    } else {
      relParts = [src.split(sep).pop() ?? src]
    }
    let target = join(destDir, ...relParts.map(p => safeFilename(p)))
    mkdirSync(dirname(target), { recursive: true })
    try {
      if (existsSync(target) && statSync(target).size === statSync(src).size && statSync(target).ino === statSync(src).ino) {
        results.push(target)
        continue
      }
    } catch {
      // Stat race: fall through and pick a unique name.
    }
    target = uniqueTarget(target)
    if (mode === 'move') {
      renameSync(src, target)
    } else if (mode === 'hardlink') {
      try {
        linkSync(src, target)
      } catch {
        copyFileSync(src, target) // across filesystems
      }
    } else {
      copyFileSync(src, target)
    }
    results.push(target)
  }
  return results
}

/**
 * Translate a download-client path to a local path. Each mapping is
 * `"remote=local"`; the longest matching remote prefix wins.
 */
export function applyPathMappings(path: string, mappings: ReadonlyArray<string>): string {
  let best: { remote: string; local: string } | undefined
  const normalized = path.replace(/\\/g, '/')
  for (const mapping of mappings) {
    const eq = mapping.indexOf('=')
    if (eq < 0) continue
    const remote = mapping.slice(0, eq).trim().replace(/\\/g, '/').replace(/\/+$/, '')
    if (remote === '') continue
    const matches = normalized === remote || normalized.startsWith(`${remote}/`)
    if (matches && (best === undefined || remote.length > best.remote.length)) {
      best = { remote, local: mapping.slice(eq + 1).trim().replace(/[/\\]+$/, '') }
    }
  }
  if (best === undefined) return path
  return `${best.local}${normalized.slice(best.remote.length)}`
}
