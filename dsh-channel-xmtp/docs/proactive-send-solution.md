# Proactive send: solution (implemented)

Companion to `proactive-send-problem.md`. Goal: session-initiated turns on a
conversation agent reach XMTP, and long pipelines stop holding chat hostage.

The earlier draft proposed a watcher *beside* the old `deliver()` (two send
paths, an "is a channel turn mid-flight?" check, a seeded-from-now
`lastSentSeq`). That kept two colors — channel-started turns and everything
else — and would have needed coordination to avoid double sends and lost
output. The implemented design removes the distinction instead, porting the
upstream `dsh-acp` bridge pattern: the channel is a **session observer**,
not a turn caller.

## Design

### Inbound: enqueue only

`onMessage` keeps Haven's filters (text/attachment → own → active
conversation → outbox → dedup), then `admit()` on a short per-conversation
admission chain that waits only on attachment resolution and agent
creation — **never on a turn**:

1. Resolve content; get or resume the conversation agent.
2. If the agent is `running`, send the busy ack (once per running interval;
   reset on `agent/status` idle).
3. `agent.followup(message)` (or `agent.steer` under `busyInbound: steer`).
   `source.kind` stays `'user'`: `tool-jobs` refills its
   `maxConsecutiveWakes` budget only on user-sourced inbox claims.
4. Record `dshMessageId → inboundMessageId`; flush the session; mark the
   inbound `accepted` in the outbox so redelivery never re-enters the agent.

The harness inbox owns the one-turn-at-a-time ordering. The channel no
longer enforces it by awaiting.

### Outbound: one path for every turn

- `agent/inbox/claimed` maps the dsh message id to its `turn`, giving
  `(conversation, turn) → inboundMessageId` for turns XMTP started.
- `session/event` (`turn/end`, plus `assistant/message` under
  `replyMode: message`) and `agent/status` idle schedule a **flush** on the
  conversation's send tail (coalesced, strictly ordered with acks).
- A flush reads the committed range after the conversation's **persisted
  cursor** — output events buffered from `session/event`, plus a one-time
  `ctx.sessionQuery.observeSession` read for any pre-restart gap — and per
  closed turn sends its final assistant text plus every image it produced.
  Turns with an inbound id record a reply in the outbox; others are
  `proactive`. Empty turns send nothing (silence convention). The cursor
  advances per closed turn (or per message in `message` mode) and persists
  after each send, so a crash re-sends at most one turn's output and never
  skips one.
- Sends that cannot happen (disconnected) leave the cursor in place; the
  next event, idle transition, the 15 s sweep, or reconnect retries.
- On connect, every conversation with a persisted cursor is resumed and
  flushed, so output committed before a restart or while offline goes out
  without waiting for the next inbound.
- Live agents are always looked up via `ctx.agents.get(sessionId)` and
  events are accepted only from that agent's current `Session`, so an agent
  replacement (compaction/clear) is followed and impostors are ignored. A
  cursor beyond a replaced session's log end resets to "now".

### Config additions

| Key | Default | Meaning |
|---|---|---|
| `replyMode` | `turn` | `turn`: one reply per turn (final text + images). `message`: every assistant message as it commits. |
| `busyAck` | short notice | Sent once when an inbound queues behind a running turn; `''` disables. |
| `busyInbound` | `queue` | `queue`: own follow-up turn. `steer`: joins the running turn at its next step. |
| `outboxPath` | — | Now also persists outbound cursors (file version 2; version 1 files load, cursors seed from the session end). |

New event: `xmtp/outbound { conversationId, kind: reply | proactive | ack, turn?, inboundMessageId? }`.

### Deployment (both native and docker profiles)

- `tool-jobs.maxConsecutiveWakes: 3` — bounds the self-exciting chain the
  harness otherwise leaves unbounded; past the budget notices are injected
  silently until the operator writes. The channel adds no second budget.
- `dsh-agent-herald/process.md` §10 — background anything past a few
  minutes (`run_in_background: true`), reply briefly and end the turn;
  speak in woken turns only when the operator needs to know.

## Edge cases

- **Woken turn queued behind a user turn.** Each turn is sent at its own
  `turn/end`; the user's reply is no longer replaced (test: "a woken turn
  queued behind a user turn does not replace the user reply").
- **Restart during or after a turn.** Persisted cursor: already-sent output
  never repeats, committed-but-unsent output is sent on reconnect.
- **Restart before a queued inbound runs.** The inbox splice is flushed
  before the inbound is marked `accepted`; the resumed session restores the
  inbox. Correlation (`dshMessageId → inbound`) is memory-only, so such a
  reply is sent as `proactive` without a reply outbox entry — harmless,
  because the inbound is already marked accepted.
- **Jobs are process-local** (`jobs-local`): they die with the process, so
  no orphan wake survives a restart.
- **Scope.** Channel listeners are untagged, so scope-filtered agent and
  session events reach them for every agent; handlers filter to served
  conversations.

## Out of scope (considered, rejected)

- **Parallel turns per conversation.** Breaks reply ordering and session
  coherence; the harness session model is one-turn-at-a-time.
- **MCP Tasks / a networked job seam.** Same "someone must observe the
  completion" requirement; adds polling without closing the gap. Revisit
  only for jobs that must survive restarts.
- **Upstream changes.** None needed; `dsh-acp` is the precedent.

## Acceptance criteria → tests (`tests/xmtp.spec.ts`)

1. Background completion on an idle agent produces an XMTP message with no
   inbound — "sends output of a turn the channel did not start".
2. Mid-turn inbound is acked within the turn, then answered in its own turn
   — "acks a mid-turn inbound immediately, once…".
3. No double send — round-trip, `message`-mode, and restart tests assert
   exact send lists after idle settles.
4. Restart safety — "a restart never re-sends output already sent" and
   "a restart sends output committed but not sent before the crash".

## Rollout

1. Build + test the stack (`pnpm -r build`, `pnpm test`).
2. Native: deploy, `systemctl restart herald-agent`; verify criterion 1
   live with a trivial `sleep 20 && echo done` background job.
3. Docker: CI rebuilds on push to `main`; existing `/data` volumes pick up
   the new profile layer per `docker/README.md` (profile patch refresh).
