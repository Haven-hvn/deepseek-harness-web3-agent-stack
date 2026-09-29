# Proactive send gap: problem space

Date: 2026-09-28. Component: `dsh-channel-xmtp`. Status: observed in production (Herald, native systemd install).

## The incident

On 2026-09-28 ~20:56 EDT, the operator sent `Go` over XMTP/Convos, authorizing
Herald's merged-album pipeline. The turn ran **~48 minutes** (torrent download
+ ffmpeg stitch of Black Sabbath *Master of Reality* FLACs into a 165MB MP3).
At 21:33 the operator asked "Ok did you download and stitch the album
together?" and got silence until 21:49, when both the pipeline result and the
queued answer delivered at once.

Log evidence (`journalctl -u herald-agent`):

- `20:56:26 onMessage "Go"` → `deliver start` only at `21:00:41`
  (chained behind the previous turn).
- `21:33:30 onMessage "did you download and stitch…"` → **no**
  `deliver start` until `21:49:09`.
- Between those timestamps: only `sweep 1 convos` heartbeats. No errors.
  The agent was healthy and working; the operator saw a dead channel.

## Root cause 1: serial per-conversation delivery (by design)

`deliver()` (`src/index.ts`) chains one promise per conversation id:
each inbound message waits for the previous turn's full completion
(`followup` → `whenIdle` → snapshot → `sendText`) before it even starts.
Cross-conversation delivery is concurrent, but within one conversation it is
strictly one turn at a time. A 48-minute pipeline turn therefore holds the
slot for 48 minutes, and follow-ups queue with **no acknowledgment**.

This ordering is deliberate — concurrent turns on one session would cross
replies and interleave tool calls — but the queue is mute.

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

This is a web3-channel fault, but the harness invited it:

- dsh has **no transport / proactive-outbound concept**. Its native clients
  (web, desktop, CLI) are session observers that render session events live,
  so woken turns are visible with no send step. Nothing named "proactive"
  exists in the subsystem docs as a messaging pattern.
- The channel followed the harness's headless-runner precedent
  (followup → whenIdle → read result), correct for headless, wrong for a
  bidirectional chat transport on a self-waking session.
- The harness *does* emit everything a transport needs
  (`agent/status` idle/running transitions, `agent/inbox/*` events, session
  snapshots) — there was just no contract telling a bridge author to observe
  them.

## Scope of the gap

Any session-initiated speech on a conversation agent is currently lost:

1. Job completion wake turns (`bash` background jobs, subagent children).
2. Schedule reminder turns (once `dsh-schedule` is mounted).
3. Any future `followup` not originating from an inbound XMTP message.

Secondary effects: the operator cannot distinguish "working" from "dead";
long pipelines block all chat on that conversation; retries/duplicate prompts
pile up behind the running turn.
