# Proactive send gap: problem space

Date: 2026-09-28. Component: `dsh-channel-xmtp`. Status: observed in production (Herald, native systemd install). Resolved by the session-observer redesign — see `proactive-send-solution.md`.

## The incident

On 2026-09-28 ~20:56 EDT, the operator sent `Go` over XMTP/Convos, authorizing
a long task. The turn ran **~48 minutes** (deliver start 21:00:41 → reply echo
21:49:09), ending with Herald confirming the completed result. The per-minute
decomposition of that window (tool calls vs. LLM roundtrips vs. status
polling) was not traced.
At 21:33 the operator sent a follow-up asking for a status update and got
silence until 21:49:09, when the long turn's result delivered and the queued
question's turn *started* (its reply followed after; the exact second was not
pinned).

Log evidence (`journalctl -u herald-agent`):

- `20:56:26 onMessage "Go"` → `deliver start` only at `21:00:41`
  (chained behind the previous turn).
- `21:33:30 onMessage "<status follow-up>"` → **no**
  `deliver start` until `21:49:09`.
- Between those timestamps: only `sweep 1 convos` heartbeats. No errors.
  The agent was healthy and working; the operator saw a dead channel.

## Root cause 1: serial per-conversation delivery (by design)

`deliver()` (`src/index.ts`, pre-redesign) chained one promise per conversation id:
each inbound message waits for the previous turn's full completion
(`followup` → `whenIdle` → snapshot → `sendText`) before it even starts.
Cross-conversation delivery is concurrent, but within one conversation it is
strictly one turn at a time. A 48-minute pipeline turn therefore holds the
slot for 48 minutes, and follow-ups queue with **no acknowledgment**.

Nothing blocked the Node event loop (the stream kept receiving and sweeps
kept firing); the *continuation* of each queued message waited. The
one-turn-at-a-time ordering is a real session constraint — concurrent turns
would cross replies and interleave tool calls — but the channel enforced it
itself, by awaiting turns, and the queue was mute.

## Root cause 2: reactive-only send (the design fault)

The channel only sends replies for turns **it** initiated inside `deliver()`.
It treats the agent session as a function (message in → reply out) while the
harness treats it as a live room that can speak on its own:

- `dsh-tool-jobs` wakes an **idle** owner with `agent.followup(notice)` on
  every uncollected background completion (default `wakeup` delivery).
  Herald mounts the full jobs stack via `dsh-base` (`dsh-jobs-local`,
  `dsh-tool-jobs`, `dsh-tool-bash` with `run_in_background`).
- `dsh-schedule` reminders (not currently mounted) arrive the same way, as
  follow-up turns.
- Subagent returns, workflow results, and any other `followup` from another
  source behave identically.

When such a turn runs outside `deliver()`, its assistant output lands in the
session and **nothing sends it to XMTP**. The model "replies" into the void;
the user never sees it. The incident above did not even reach this failure —
the pipeline ran *inside* a chat turn — but any move to background pipelines
(which the fix for root cause 1 requires) walks straight into it.

## Why the harness didn't catch it

This is a web3-channel fault. The harness did not invite it — the
channel copied the wrong upstream precedent:

- The harness's two-way transport bridge, `dsh-acp`, already implements
  the pattern a chat channel needs: inbound `followup` without awaiting
  the turn, every committed `assistant/message` streamed from
  `session/event` through one ordered output tail regardless of who
  started the turn, and prompt↔turn correlation through
  `agent/inbox/claimed` (its `turns.spec.ts` covers an autonomous turn
  racing a client turn). The native clients (web, desktop, CLI) are
  session observers the same way.
- The channel instead followed the headless runner
  (followup → whenIdle → read result). That runner is only correct
  because it owns its agent *exclusively*; its own source refuses to adopt
  a live agent because "`whenIdle` is not a single-message signal" and
  would fold another owner's turns — even their final answer — into the
  run. Herald's conversation agents are not exclusive: `tool-jobs`,
  subagents, and schedules all `followup` them.
- Upstream primitives behave exactly as documented: `followup()` is
  enqueue-and-wake and safe while running; `whenIdle()` is whole-agent
  quiescence; `agent/status`, `agent/inbox/claimed`, and `session/event`
  publish everything a transport needs. Nothing upstream needs to change.

## A second, latent bug in the same code

Because `deliver()` read "the last assistant text since `firstSeq` after
`whenIdle()`", any woken turn queued behind a user turn ran inside the
same idle interval, and its text **replaced** the user's reply. The
per-conversation delivery chain existed partly to stop two inbound
messages from collapsing into one interval the same way.

## Scope of the gap

Any session-initiated speech on a conversation agent is currently lost:

1. Job completion wake turns (`bash` background jobs, subagent children).
2. Schedule reminder turns (once `dsh-schedule` is mounted).
3. Any future `followup` not originating from an inbound XMTP message.

Secondary effects: the operator cannot distinguish "working" from "dead";
long pipelines block all chat on that conversation; retries/duplicate prompts
pile up behind the running turn.
