# Migration: dsh 0.1.7-rc.2 → 0.2.1-alpha.1

Date: 2026-10-03. Scope: every stack package, `docker/`, `native/`.
Status: code complete, **not yet built, installed, or tested** — see
"Before deploying".

## Why this version

`0.2.1-alpha.1` is the `alpha` dist-tag (published 2026-10-03); `latest` and
`next` are `0.2.0-rc.2` (2026-09-29). It is the first train without
`@deepseek-ai/dsh-invariants`, and the agent/session/tool APIs this stack uses
are unchanged from 0.1.7-rc.2. It is an alpha: expect follow-up
pre-releases, and re-pin deliberately rather than floating.

## What changed

| Area | Change |
|---|---|
| Pins (16 `package.json`) | `@deepseek-ai/dsh-*` peers exact `0.2.1-alpha.1`, dev `=0.2.1-alpha.1`; `@deepseek-ai/cordis` `~4.0.5-alpha.1`; `@deepseek-ai/schemastery` `~3.18.5-alpha.1` (matches upstream's published ranges: exact for dsh, tilde for vendor). |
| Plugin compatibility gate | `dsh plugin add` and profile boot semver-check every `@deepseek-ai/dsh-*` **peer** against the running CLI and deny mismatches (already present in 0.1.7-rc.2; it is why peers and the CLI version must move together). |
| `dsh-invariants` removed upstream | Deleted `src/invariant.ts`, the `./invariant` export, the tsdown entry, and the dependency in `dsh-wallet`, `dsh-wallet-ethereum`, `dsh-treasury`, `dsh-storage-synapse`, `dsh-channel-xmtp` (and the dev dep in `dsh-erc8004`). No patch file mounted a companion. |
| Former invariant checks | Kept as vitest assertions: wallet/signed ↔ configured wallets (`dsh-wallet/tests/wallet.spec.ts`), treasury/state-changed ↔ `computeTreasuryState` (`dsh-treasury/tests/treasury.spec.ts`), one xmtp/inbound per id (`dsh-channel-xmtp/tests/xmtp.spec.ts`). synapse's non-empty-CID check is already asserted; wallet-ethereum's was empty. |
| `dsh-channel-xmtp` history reads | `Session.snapshotEvents()` is deprecated for new production callers upstream. The channel now buffers its output events from `session/event` and reads the pre-restart gap once via `ctx.sessionQuery.observeSession` (dsh-base mounts `session-query-sqlite`; `openAt: never` keeps the service up). Without `sessionQuery` the gap is skipped and logged, never replayed. |
| CLI | `docker/Dockerfile`: `npm i -g @deepseek-ai/dsh@0.2.1-alpha.1`. `native/README.md`: same, as an explicit step. |
| Node | Dockerfile base `node:22.23-bookworm-slim` (upstream engines: `^22.19.0 \|\| >=24.0.0`). Native hosts need Node ≥ 22.19. |

Unchanged and verified against upstream source / published types: every
`dsh-tools`, `dsh-llm`, `dsh-storage*`, `dsh-credentials`,
`dsh-launch-environment`, `dsh-token-meter` symbol the stack imports; agent,
session and system-prompt APIs and events; base patch row ids and config
schemas used by `herald.patch.yml` / `profile.patch.yml` (`tool-jobs`,
`agent-default-model`, `llm-pi-ai` providers/`retryPolicy`/`compat`,
`system-prompt.personaPrefix`); CLI flags and env vars.

## Behavioral changes Herald gets (tarball diff, 0.1.7-rc.2 → 0.2.1-alpha.1)

- **Step-failure tool-call recovery (dsh-agent-loop).** A step that fails
  after the model requested tools (e.g. retries exhausted on a 429) now
  records `TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN` results for the pending
  calls live, instead of leaving them unanswered until the next restart's
  repair. `dsh-exactly-once` already treats any non-success as needing a
  read-back check, so the two compose.
- **Contained listener failures.** `llm/adapters-updated` and the credential
  reload no longer rethrow `INVARIANT` failures; they log and keep going.
- **bash tool guidance.** Added delete/move target verification and
  `${VAR:?}` guards to the tool description.
- **pi-ai 0.85.1 → 0.87.1** inside dsh-llm-pi-ai, with the tool-argument
  parse patch re-based. Error classification (429 → `RATE_LIMIT`, transport,
  413) and dsh-llm-retry are byte-identical, so the Upstage retry policy
  behaves exactly as before.

Unchanged (byte-identical lib): tool-jobs, jobs-local, bash-sandbox,
subprocess-local, timeout policy, spill, compaction, token-meter,
atomic-write, session persistence durability, session query. Session format
stays v4 with no rewrite on open, so a rollback to 0.1.7-rc.2 can still read
sessions written by 0.2.1. `DSH_TELEMETRY_DISABLED=1` still disables all
telemetry, including the new `otel` base row.

## Before deploying

1. **Lockfile regenerated** (2026-10-03, pnpm 11.7.0 — the Dockerfile's
   version — `--lockfile-only` from scratch, against haven-aol and
   mint-glue-graduate checked out at the Dockerfile's pinned refs): every
   `@deepseek-ai/*` package resolves to `0.2.1-alpha.1` (cordis
   `4.0.5-alpha.1`, schemastery `3.18.5-alpha.1`), no `dsh-invariants`, and
   `pnpm peers check` reports no issues. Outside `@deepseek-ai`, 40 entries
   moved by patch/minor within existing ranges (rolldown 1.2.12, vite 8.3.2,
   chai 6.3.0, sentry 10.76.0, node-addon-require-builtin 0.1.7, …). The
   pre-regeneration lockfile is in the backup as `pnpm-lock.yaml.pre-regen`.
2. `pnpm -r build && pnpm test` (and `pnpm typecheck`).
3. Native: `npm i -g @deepseek-ai/dsh@0.2.1-alpha.1`, rebuild, then
   `dsh --profile herald --dump-config` before `systemctl restart herald-agent`.
   A denied bundle prints an `allow-version … --accept-risk` remedy — don't
   take it; it means a pin was missed.
4. Docker: rebuild; the image gate (`dsh plugin add`, `--dump-default-config`,
   import gate) exercises the compatibility check at build time. Existing
   `/data` volumes get their profile install replaced from the new skeleton
   on first boot (`refresh_profile_install` in `docker/entrypoint.sh`), so
   the old 0.1.7 profile install is not left in place.

## Known follow-ups

- `dsh-exactly-once/src/guard.ts` still calls `session.snapshotEvents()`
  (pre-existing; upstream permits existing callers for now). Migrate it to an
  incremental `session/event` fold before upstream removes the reader.
- Rollback: the pre-migration tree was copied to
  `../.backup-web3-stack-pre-0.2.1-20261003113948`.
