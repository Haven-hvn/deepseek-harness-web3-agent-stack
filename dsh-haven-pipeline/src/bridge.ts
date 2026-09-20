/**
 * Thin subprocess bridge to the Haven Python CLI (read-only).
 *
 * Spawns `haven <args> --json`, captures stdout, parses JSON, maps failures
 * to {@link HavenBridgeError}. No secrets pass through here: the child
 * inherits the ambient process env (where HAVEN_PRIVATE_KEY already lives
 * for the Python Arkiv client constructor). The bridge never reads, writes,
 * or forwards any key material — it only moves argv in and JSON out.
 *
 * Test seam: {@link internals.spawn} replaces child_process.spawnFile in
 * tests so no Python is needed in CI.
 *
 * @module dsh-haven-pipeline/bridge
 */

import { spawnFile } from 'node:child_process'

/** Stable failure of one haven CLI invocation. */
export class HavenBridgeError extends Error {
  override readonly name = 'HavenBridgeError'
  /** Process exit code (null when killed by signal/timeout). */
  readonly exitCode: number | null
  /** Signal that killed the child, if any. */
  readonly signal: string | null
  /** Exact argv passed to the haven binary (for diagnostics). */
  readonly argv: readonly string[]
  /** Stderr tail (truncated) — where typer/rich print failures. */
  readonly stderr: string

  constructor(message: string, opts: {
    exitCode: number | null
    signal: string | null
    argv: readonly string[]
    stderr: string
  }) {
    super(message, opts.exitCode !== null ? undefined : undefined)
    this.exitCode = opts.exitCode
    this.signal = opts.signal
    this.argv = opts.argv
    this.stderr = opts.stderr
  }
}

/** One spawned call — injectable for tests. */
export type SpawnFn = (
  bin: string,
  argv: readonly string[],
  opts: { timeoutMs: number; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: string | null }>

async function defaultSpawn(
  bin: string,
  argv: readonly string[],
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: string | null }> {
  return new Promise((resolve, reject) => {
    const child = spawnFile(bin, [...argv], { timeout: opts.timeoutMs })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer | string) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk: Buffer | string) => { stderr += String(chunk) })
    child.on('error', (err: Error) => {
      // ENOENT (missing binary) surfaces here, not via close.
      reject(new HavenBridgeError(`haven bridge: failed to spawn ${bin}: ${err.message}`, {
        exitCode: null,
        signal: null,
        argv,
        stderr: stderr.slice(-2000),
      }))
    })
    if (opts.signal) {
      if (opts.signal.aborted) child.kill()
      else opts.signal.addEventListener('abort', () => child.kill(), { once: true })
    }
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      resolve({ stdout, stderr, exitCode: code, signal: signal ?? null })
    })
  })
}

/** Test seam: when set, {@link runHaven} uses it instead of spawning. */
export const internals: { spawn: SpawnFn | undefined } = { spawn: undefined }

function resolveSpawn(): SpawnFn {
  return internals.spawn ?? defaultSpawn
}

/**
 * Run one haven CLI command and return its parsed `--json` stdout.
 * @param bin - haven binary (absolute path or PATH name).
 * @param argv - arguments excluding the binary (must already include --json where supported).
 * @param opts - timeout and optional abort signal.
 * @returns parsed JSON (object, array, or scalar per command).
 * @throws HavenBridgeError on spawn failure, non-zero exit, timeout, or unparsable stdout.
 */
export async function runHaven<T = unknown>(
  bin: string,
  argv: readonly string[],
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<T> {
  const spawn = resolveSpawn()
  let result: { stdout: string; stderr: string; exitCode: number | null; signal: string | null }
  try {
    result = await spawn(bin, argv, opts)
  } catch (err) {
    if (err instanceof HavenBridgeError) throw err
    const msg = err instanceof Error ? err.message : String(err)
    throw new HavenBridgeError(`haven bridge: spawn failed: ${msg}`, {
      exitCode: null,
      signal: null,
      argv,
      stderr: '',
    })
  }
  if (result.exitCode !== 0) {
    const tail = result.stderr.slice(-2000) || result.stdout.slice(-2000)
    const reason = result.signal === 'SIGTERM' || result.exitCode === null
      ? `timed out after ${opts.timeoutMs}ms`
      : `exited with code ${String(result.exitCode)}`
    throw new HavenBridgeError(`haven ${argv.join(' ')} ${reason}: ${tail.slice(0, 500)}`, {
      exitCode: result.exitCode,
      signal: result.signal,
      argv,
      stderr: tail,
    })
  }
  // haven --json prints the JSON document to stdout; rich tables go to stdout
  // only without --json, so a successful --json call must parse cleanly.
  // Some commands print warnings to stdout before the document — recover by
  // scanning for the first JSON start character.
  const text = result.stdout.trim()
  if (text.length === 0) {
    throw new HavenBridgeError(`haven ${argv.join(' ')} returned empty stdout`, {
      exitCode: result.exitCode,
      signal: result.signal,
      argv,
      stderr: result.stderr.slice(-2000),
    })
  }
  const start = text.search(/[{["\d-]/)
  const candidate = start > 0 ? text.slice(start) : text
  try {
    return JSON.parse(candidate) as T
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new HavenBridgeError(
      `haven ${argv.join(' ')} returned unparsable JSON: ${msg} (stdout head: ${candidate.slice(0, 200)})`,
      { exitCode: result.exitCode, signal: result.signal, argv, stderr: result.stderr.slice(-2000) },
    )
  }
}

/**
 * Build argv with optional shared flags.
 * @param base - command argv before shared flags.
 * @param configFile - optional --config passthrough.
 */
export function withConfig(base: readonly string[], configFile?: string): string[] {
  if (configFile) return [...base, '--config', configFile]
  return [...base]
}
