# dsh-channel-xmtp

XMTP channel for DeepSeek Harness: direct agent↔user messaging over the XMTP
network, ported from Haven's `XmtpChannel` (haven-adapters).

Inbound XMTP text reaches a dsh agent; the assistant's reply text is sent back
to the same conversation. Identity is an Ethereum EOA signed through
`dsh-wallet` — this channel never holds key material.

## Concept transfer

| Haven `XmtpChannel` | Here |
| --- | --- |
| `walletAddress` + `signMessage` callback config | the `ctx.wallet` seam: each XMTP signature runs dsh-wallet's resolve → load → sign → drop pipeline |
| `InboundMessage` → MessageBus → AgentLoop session per `sessionKey(channel, chatId)` | one dsh agent per conversation (`ctx.agents.create`, session id `<channelName>-<conversationId>`), inbound via `agent.followup`, reply via `conversation.sendText` |
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
```

## Events

- `xmtp/inbound` `{ messageId, conversationId, senderInboxId, sentAtMs }` —
  one accepted inbound message (post-filter, pre-agent). Never carries content.
- `xmtp/status` `{ status, reason }` — connection lifecycle
  (`connecting` / `connected` / `reconnecting` / `disconnected`).

## Custody

The signer's `signMessage` is one `ctx.wallet.signMessage` operation per XMTP
signature request: the wallet credential resolves inside that call and is
dropped on return. Configuration carries wallet *names* and credential
*references* only.
