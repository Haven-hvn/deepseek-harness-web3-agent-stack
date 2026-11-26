/**
 * acp-stdout-guard.mjs — Node `--import` preload for `dsh --profile acp`.
 *
 * `@deepseek-ai/dsh-acp` writes newline-delimited JSON-RPC frames directly to
 * `process.stdout` (via `Writable.toWeb(process.stdout)`). Several web3 stack
 * plugins and third-party SDKs emit operational diagnostics with `console.log`.
 * Routing `console.{log,info,debug,dir,table}` to stderr keeps stdout strictly
 * JSON-RPC without modifying upstream SDKs, while stripping this preload from
 * `NODE_OPTIONS` so child Node processes spawned by the bash tool keep normal
 * stdout behavior.
 */

export const GUARD_MARKER = '--import /opt/agent/acp-stdout-guard.mjs';

/**
 * Remove a specific `--import <path>` flag from a `NODE_OPTIONS` string while
 * preserving any other flags.
 */
export function stripImportFromNodeOptions(raw, marker = GUARD_MARKER) {
  if (typeof raw !== 'string' || raw.trim() === '') return '';
  const withoutMarker = raw.split(marker).join(' ');
  return withoutMarker.replace(/\s+/g, ' ').trim();
}

/**
 * Redirect `console.{log,info,debug,dir,table}` on the given console object to
 * `console.error` so diagnostics reach stderr instead of stdout.
 */
export function installStdoutGuard(targetConsole = console, env = process.env) {
  const toStderr = targetConsole.error.bind(targetConsole);
  targetConsole.log = toStderr;
  targetConsole.info = toStderr;
  targetConsole.debug = toStderr;
  targetConsole.dir = toStderr;
  targetConsole.table = toStderr;

  if (env && typeof env.NODE_OPTIONS === 'string') {
    const cleaned = stripImportFromNodeOptions(env.NODE_OPTIONS);
    if (cleaned) env.NODE_OPTIONS = cleaned;
    else delete env.NODE_OPTIONS;
  }
}

// Auto-install only when preloaded via NODE_OPTIONS (not when imported by unit tests).
if (typeof process.env.NODE_OPTIONS === 'string' && process.env.NODE_OPTIONS.includes(GUARD_MARKER)) {
  installStdoutGuard(console, process.env);
}
