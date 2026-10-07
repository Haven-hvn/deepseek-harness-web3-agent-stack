# dsh-channel-xmtp

XMTP channel for DeepSeek Harness: direct agent↔user messaging over the XMTP
network, ported from Haven's `XmtpChannel` (haven-adapters).

Inbound XMTP text reaches a dsh agent; assistant output is sent back to the
same conversation — both replies to inbound and output of turns the channel
did not start (background-job completion wakes, subagent returns,
schedules). Identity is an Ethereum EOA signed through `dsh-wallet` — this
channel never holds key material.

## Transport model

The channel is a session **observer** (the `dsh-acp` bridge pattern), not a
turn caller:

- **Inbound only enqueues.** `agent.followup` (or `agent.steer` with
  `busyInbound: steer`), never awaiting a turn. An inbound that arrives
  while the agent is mid-turn gets one busy ack per running interval and
  runs as its own turn afterwards.
- **One outbound path for every turn.** Committed session events drive a
  per-conversation send tail that reads forward from a persisted cursor.
  Turns an inbound started (correlated through `agent/inbox/claimed`) are
  `reply` sends; every other turn is `proactive`. A turn with no assistant
  output sends nothing.
- **Exactly-once across restarts** with `outboxPath`: the inbound outbox
  stops redelivered messages re-entering the agent; the outbound cursor
  makes a restart send committed-but-unsent output and never re-send.

Pair it with `tool-jobs.maxConsecutiveWakes` in the profile so a
self-waking job chain cannot spam the chat.

## Concept transfer

| Haven `XmtpChannel` | Here |
| --- | --- |
| `walletAddress` + `signMessage` callback config | the `ctx.wallet` seam: each XMTP signature runs dsh-wallet's resolve → load → sign → drop pipeline |
| `InboundMessage` → MessageBus → AgentLoop session per `sessionKey(channel, chatId)` | one dsh agent per conversation (`ctx.agents.create`, session id `<channelName>-<conversationId>`), inbound via `agent.followup`, output via a `session/event` observer → `conversation.sendText` |
| Disconnected/Connecting/Connected/Reconnecting machine | reconnect loop with the same policy (attempt cap 10, delay 5000ms), reported as `xmtp/status` events |
| `dbEncryptionKey` (raw hex in config) | `dbEncryptionKeyRef` — a `ctx.credentials` reference resolved at each connect |
| `setActiveGroupId()` runtime setter | `activeConversationId` config |
| text-only / own-message / dedup filters, consent auto-allow sweep (15s), dedup cap 5000 → prune to half | preserved verbatim |

Not ported: the installation-limit auto-revocation recovery (deep SDK surface;
revoke stale installations with XMTP tooling if `Client.create` reports the
limit).

## Install

```sh
dsh plugin --profile <name> add /path/to/dsh-wallet /path/to/dsh-wallet-ethereum /path/to/dsh-channel-xmtp @xmtp/node-sdk
```

All bundles are independent; each inserts only its own row. `@xmtp/node-sdk`
is an optional peer — the package loads, mounts, and tests without it (lazy
import with an actionable error; tests substitute `internals.sdk`). The
channel requires the agent stack (agents/sessions/llm) present in any
agent-running profile.

## Configuration

```yaml
- id: channel-xmtp
  name: 'dsh-channel-xmtp'
  config:
    wallet: agent              # dsh-wallet entry (EVM — XMTP identity is an Ethereum EOA)
    env: production            # production | dev | local
    channelName: xmtp          # session-id prefix; distinguishes parallel mounts
    # dbPath: /var/lib/dsh/xmtp.db3
    # dbEncryptionKeyRef: XMTP_DB_KEY   # credential REFERENCE, never a key value
    # activeConversationId: <id>        # restrict to one conversation
    # maxReconnectAttempts: 10
    # reconnectDelayMs: 5000
    # outboxPath: /var/lib/dsh/xmtp-outbox.json  # inbound outbox + outbound cursors
    # replyMode: turn          # turn: one reply per turn | message: every assistant message live
    # busyInbound: queue       # queue: own turn after the running one | steer: joins the running turn
    # busyAck: "Still working on the previous request — I'll get to this next."  # '' disables

# Recommended alongside: bound background-job wakes per conversation agent.
- id: tool-jobs
  config:
    maxConsecutiveWakes: 3
```

## Events

- `xmtp/inbound` `{ messageId, conversationId, senderInboxId, sentAtMs }` —
  one accepted inbound message (post-filter, pre-agent). Never carries content.
- `xmtp/outbound` `{ conversationId, kind, turn?, inboundMessageId? }` — one
  successful send; `kind` is `reply`, `proactive`, or `ack`. Never carries content.
- `xmtp/status` `{ status, reason }` — connection lifecycle
  (`connecting` / `connected` / `reconnecting` / `disconnected`).

## Custody

The signer's `signMessage` is one `ctx.wallet.signMessage` operation per XMTP
signature request: the wallet credential resolves inside that call and is
dropped on return. Configuration carries wallet *names* and credential
*references* only.
