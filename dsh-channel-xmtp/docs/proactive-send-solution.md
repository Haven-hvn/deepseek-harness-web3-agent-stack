# Proactive send: proposed solution

Companion to `proactive-send-problem.md`. Goal: session-initiated turns on a
conversation agent reach XMTP, and long pipelines stop holding chat hostage.

## Proposal A (core fix): session watcher with proactive send

Teach `XmtpChannelRuntime` to **observe** its conversation agents, not just
drive them.

### Mechanism

1. When the channel creates/resumes a conversation agent (`agentFor`), also
   subscribe to `agent/status` for that agent's session
   (`packages/core/agent`: payload `{ agent, status }`, `idle`/`running`,
   emitted on every transition).
2. Track per-conversation `lastSentSeq` (session seq of the last assistant
   content sent to XMTP).
3. On `running → idle` where the finished turn was **not** channel-initiated
   (i.e. no `deliver()` is mid-flight for that conversation):
   snapshot session events after `lastSentSeq`, extract assistant
   text/images with the existing `lastAssistantContent` helper, and
   `sendText`/send attachments exactly as `deliver()` does, then advance
   `lastSentSeq` and `recordOutbox` as today.
4. `deliver()` keeps its current behavior for channel-initiated turns and
   advances `lastSentSeq` past what it sends, so the watcher never
   double-sends. Guard the watcher callback with the same per-conversation
   chain (`this.deliveries`) so a woken turn racing an inbound message
   serializes instead of interleaving.

### Silence convention

An empty assistant reply sends nothing (the rule `deliver()` already uses).
Pair the watcher with a persona/process instruction: *"In turns woken by
background completions, speak only if the operator needs to know; otherwise
end the turn with no text."* This keeps routine completions (a cron probe, a
touched file) from spamming chat while letting real results through.

### Edge cases

- **Flapping / self-exciting chains.** A woken turn may start the job whose
  completion wakes it again. Honor `tool-jobs`' `maxConsecutiveWakes`
  semantics implicitly (past-budget notices wait silently; nothing wakes,
  nothing sends). Do not add a second budget in the channel.
- **Restart during a woken turn.** Jobs are process-local (`jobs-local`):
  they die with the process, so no orphan wake survives a restart. Sessions
  persist, but `lastSentSeq` is memory-only; on restart, seed it from the
  session's current seq so pre-restart content is never re-sent.
- **Outbox/dedup.** Reuse `recordOutbox(conversationId, …)` for proactive
  sends so the existing exactly-once accounting sees them. The send path is
  not a tool call, so `dsh-exactly-once`'s execute wrapper is uninvolved.
- **Non-text content.** Reuse the image/attachment branch of `deliver()`;
  woken turns can yield images the same way.

## Proposal B (quick win, ship first): acknowledge queued messages

If an inbound message arrives while a `deliver()` is mid-flight for that
conversation, immediately `sendText` a short acknowledgment
("Still working on it — I'll answer this next.") before chaining. Small,
contained, kills the "is he dead?" failure mode while A is built. Rate-limit
to one ack per in-flight turn so duplicate prompts don't spam.

## Proposal C (doctrine, no code): background long pipelines

Add to Herald's process: anything expected to run past a few minutes goes to
`run_in_background` (bash) or a subagent child; the chat turn replies
"started, I'll report back" and ends, freeing the conversation slot. The
completion wake turn (delivered by A) carries the result. This converts the
48-minute serial block into an async job with two short chat turns. Depends
on A — without proactive send, backgrounding makes results *less* visible,
not more.

## Out of scope (considered, rejected for now)

- **Parallel turns per conversation.** Breaks reply ordering and session
  coherence; the harness session model is one-turn-at-a-time. Not worth it.
- **Mounting `dsh-schedule`.** Useful later for cron reminders; orthogonal,
  and reminder turns are covered by A once mounted.
- **Harness-side transport contract.** Upstreaming a "proactive send" pattern
  to dsh would help future bridges, but nothing we need is blocked on it.

## Acceptance criteria

1. A background bash job (`run_in_background: true`, e.g. `sleep 20 && echo
   done`) completing on an idle conversation agent produces an XMTP message
   without any new inbound message. (Needs A + silence-convention prompt.)
2. An inbound message arriving mid-turn gets an ack within seconds, then its
   normal reply after the turn completes. (Needs B.)
3. No double-send: existing tests plus a new test driving a channel turn
   followed by a woken turn assert exactly one send per assistant segment.
4. Restart safety: restart mid-idle never re-sends old content.

## Rollout

1. Land B + tests; deploy to Herald native (`systemctl restart herald-agent`).
2. Land A + tests; verify criterion 1 against the live Herald convo with a
   trivial `sleep` job before trusting it with pipelines.
3. Add the C process note to `dsh-agent-herald/process.md`; verify with a
   real long-running background job.
4. Rebuild + republish the Docker image (CI does this on push to `main`).
