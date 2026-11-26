// no-body-timeout.cjs — preloaded via `--require` in dsh-acp-wrapper.sh.
//
// Why: DSH reaches OpenAI-compatible providers through undici's global
// dispatcher. undici's defaults are 300 s for body/header timeouts, and neither
// pi-ai nor the DSH provider profile can raise them. A slow local model (e.g.
// a JIT-loaded 27B in LM Studio) can go silent longer than that mid-stream and
// the turn dies with UND_ERR_BODY_TIMEOUT. This installs a dispatcher with
// one-hour timers, matching OMB_TURN_STALL_MS,
// OPENMAUS_ACP_PROMPT_IDLE_TIMEOUT_MS and the `spark` provider timeouts. The
// one-hour watchdogs still bound a genuinely dead request.
//
// The undici copy bundled with DSH is used when resolvable; if a future DSH
// layout moves it, the default dispatcher is kept rather than blocking boot.
'use strict';

const { createRequire } = require('node:module');

const ONE_HOUR_MS = 3_600_000;
const MARKER = '--require /opt/agent/no-body-timeout.cjs';

function loadCandidates() {
  return [
    () => require('undici'),
    () => createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json')('undici'),
    () => require('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/undici'),
    () => require('/opt/stack/node_modules/undici'),
    () => require('/app/node_modules/undici'),
  ];
}

function install() {
  for (const load of loadCandidates()) {
    try {
      const undici = load();
      if (typeof undici.setGlobalDispatcher === 'function' && typeof undici.Agent === 'function') {
        undici.setGlobalDispatcher(new undici.Agent({ headersTimeout: ONE_HOUR_MS, bodyTimeout: ONE_HOUR_MS }));
        return true;
      }
    } catch {
      // Try the next candidate path.
    }
  }
  return false;
}

// Only auto-install when actually preloaded by NODE_OPTIONS (unit tests import
// this module without the marker and must not mutate the global dispatcher).
if (typeof process.env.NODE_OPTIONS === 'string' && process.env.NODE_OPTIONS.includes(MARKER)) {
  install();
}

module.exports = { ONE_HOUR_MS, MARKER, install };
