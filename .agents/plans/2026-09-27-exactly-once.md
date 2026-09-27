## Goal

Harness-native exactly-once for write side effects, model-invisible by default: redelivered tool calls never re-dispatch, retries after ambiguous outcomes read back before re-dispatching, and no new parameters appear on any tool schema. No harness fork required for the core guarantee.

## Success Criteria

- The same `(agent, callId)` dispatched twice executes its body once; the second dispatch gets the recorded result — covering transport redelivery including PTC sub-dispatches.
- An exact repeat of a write after an error/timeout triggers read-back first; re-dispatch happens only on proven non-commit, and no-read-path tools echo a retry key instead.
- Chain writes from one wallet are serialized; timeout-after-broadcast resolves via receipt/tx lookup with a single on-chain tx.
- XMTP sends at most one reply per inbound message across redelivery and restart; acquisition maps one intent to one handle with no cross-backend double-queue.
- Model schemas unchanged; full web3 suite green plus new redelivery/timeout/read-back specs.

## Approach

Decisions, with the harness evidence behind each:

1. **Dedup identity is `callId`, not args-hash, not model keys.** The agent loop sets `callId: block.id` per model call block (`packages/core/agent-loop/src/tool-calls.ts`); a redelivered call shares it, a model retry is a new block. Exact and transparent.
2. **The ledger is the session log, not a new store.** `tool/call` is flushed durable before dispatch (checkpoint-policy `tools/execute` wrapper + `agent/pre-step`), `tool/result` after; query via the agent session / `ToolHistoryProjection`. Restart-safe, scoped per conversation — matching the one-agent-per-XMTP-conversation shape.
3. **The seam is a `tools/execute` around-wrapper** (timeout-policy shape: return the recorded `ToolExecutionResult` without `next()`), because `tools/pre-execute` allows only allow/deny/cancel/ask with input rewriting explicitly excluded, and `tools/post-execute` runs after the body already ran.
4. **Retry-after-ambiguous reuses the repeat signal**, not new keys: `repeat-tool-reminder` already tracks exact `(name, canonical args)` runs per agent in post-execute (advisory only, reset on user message). For writes, an exact repeat after non-success runs read-back first; keys are echoed in error results only for the no-read-path case — exactly where the cited paper says they are irreplaceable.
5. **No-fork first.** The web3 stack pins registry `@deepseek-ai/dsh-tools =0.1.7-rc.2` (pnpm store, not linked to `/root/deepseek-harness`), so deep edits need a wiring change (link override / patch / upstream) plus singleton-`Symbol` care. The wrapper achieves the guarantee on pinned deps; scheduler-native dedup is an optional Phase 3.
6. **Rejected:** per-tool model-visible keys (schema/token cost, hallucinable); bespoke ledger (new infra, new drift); longer waits (paper: loses to keys under heavy tails); verification-only without keys (provably insufficient under late commits).
7. **Publish split:** one commit per phase, in order, then push (per your standing instruction).

## Steps

**Phase 1 — guard + ledger replay (web3 stack only, no fork)**

1. New `dsh-exactly-once` plugin (proposed path): `tools/execute` wrapper with treasury-style write-tool name patterns; in-flight map keyed `(agent?, rootCallId, callId)` including PTC `parent` sub-dispatches (attach, don't re-run); settled lookup in session history returning the recorded result without dispatch.
2. Repeat-after-ambiguous tracking per `(agent, name, canonical args)` mirroring repeat-tool-reminder (left untouched): exact write-repeat after non-success consults that tool's `checkCommitted` read-back when one exists (Phase 2 adds them); without a hook, allow re-dispatch but record the attempt and echo a retry key in errors. Net of Phase 1: redelivery and in-flight double-submit solved exactly; ambiguous-retry read-back arrives per tool in Phase 2.
3. Writes exclusive: drop `isConcurrencySafe: () => true` from `acquire_submit` (keep `acquire_status` read-safe); verify the other write tools omit it (default exclusive barrier).
4. Persona: three-line exactly-once instruction in `dsh-persona` and the container profile — on tool error/timeout call the matching status/read tool before resubmitting; never report success without read-back evidence.

**Phase 2 — commit points (web3 stack only)**

5. `dsh-wallet`: per-wallet-name mutex over fetch-nonce→sign→send plus a pre-broadcast `(attempt → txHash/nonce)` record for read-back.
6. `erc8004_register`, `rr_launch`/`rr_sweep`/`rr_heartbeat`: bounded receipt wait with documented timeout; `checkCommitted` via tx/receipt lookup plus `tokenURI`/`ownerOf` / router state; `registerAgent` resumable (reuse CID, single `register` tx).
7. XMTP outbox: persist `(conversationId, inboundMessageId) → sentMessageId`; one `sendText` per inbound across redelivery and restart (also hardens the memory-only 5000-entry seen-set).
8. Acquisition: `HandleStore` attempt→handle map; resubmit resolves by content identity (infohash/URL) with backend status check; failover records the committing backend before polling so a qBittorrent timeout-after-queue never also queues Transmission. No arg injection needed anywhere — read-back is by content identity and session history.
9. Synapse/Arkiv: `checkCommitted` by content identity (deterministic CID; entity attribute query) plus attempt records. `aol_decrypt` needs no change (local overwrite converges; fresh nonce per actual dispatch stays).

**Phase 3 — deep harness (optional, deferred by default)**

10. Scheduler `callId` dedup in `prepareScheduledExecution`, first-class model-invisible `effects`/`checkCommitted` on `ToolDefinition`, and the wiring decision (link override vs pnpm patch vs upstream). Skipped unless you ask.

## Validation Plan

- New specs per unit (proposed `dsh-exactly-once/tests/*.spec.ts` + per-package specs): same-`callId` double dispatch → one body run; in-flight attach; restart replay from seeded session events with no body run; exact-repeat-after-timeout → read-back invoked, no re-dispatch when committed; chain timeout-after-broadcast → single txHash; duplicate XMTP inbound → one `sendText`; same-magnet resubmit and failover-timeout → one backend torrent, one handle.
- Commands per unit, e.g. `pnpm vitest run dsh-exactly-once/tests/guard.spec.ts`; then full `pnpm vitest run`, `pnpm typecheck`, `pnpm -r run build`; container boot gates per `HANDOFF.md` (zero failed imports, QR present) after guard install.
- Highest-risk: the chain timeout-after-broadcast single-tx test and the wrapper session-replay test — they prove read-back-not-resend on the money path and replay without a body run.
- Phase 3 if taken: harness focused `vitest run packages/core/tools/tests/tools.spec.ts` from `/root/deepseek-harness` plus the web3 suite against rewired deps.

## Risks / Open Questions

- Session-query cost in the hot path: in-memory `(agent, callId)` index with session as cold backup; assert bounded lookups in the wrapper spec.
- Treasury re-meters replayed successes (post-execute records estimates per settlement): accepted estimate noise; exempting replays is a follow-up, out of scope.
- Filecoin eventual-consistency false negatives: bounded read-back retries with documented timeout; inconclusive outcomes echo a retry key for an operator decision.
- Cross-conversation same-intent retries need explicit keys: out of scope (rare). PTC mode needs no change (keys include sub-call identity; programs are already told to inspect before retrying).
- Open questions: None.
