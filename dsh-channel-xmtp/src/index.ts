/**
 * XMTP channel for dsh: direct agent↔user messaging over the XMTP network,
 * ported from Haven's `XmtpChannel` (haven-adapters).
 *
 * Concept transfer:
 *
 * - **Identity = wallet signature.** Haven built its EOA signer from a raw
 *   `walletAddress` + `signMessage` callback pair handed in by the host. Here
 *   the signer is the `ctx.wallet` seam: each XMTP signature request runs
 *   dsh-wallet's resolve → load → sign → drop pipeline, so the Ethereum key
 *   resolves per signature at the operation boundary and this channel never
 *   holds key material.
 * - **MessageBus → per-conversation agents.** Haven published
 *   `InboundMessage`s onto a bus keyed by `sessionKey(channel, chatId)`. Here
 *   each XMTP conversation maps to one dsh agent (`ctx.agents.create` with a
 *   deterministic session id).
 * - **State machine → plugin lifecycle.** Haven's
 *   Disconnected/Connecting/Connected/Reconnecting machine becomes a plain
 *   reconnect loop with the same policy (attempt cap, fixed delay), reported
 *   through `xmtp/status` events; disposal is the plugin effect.
 * - Preserved verbatim: text-only + own-message + active-conversation
 *   filters, dedup set (cap 5000, prune to half), consent auto-allow sweep
 *   every 15s.
 *
 * Transport model (the `dsh-acp` bridge precedent): the channel is a session
 * OBSERVER, not a turn caller. Inbound only enqueues (`agent.followup`, or
 * `agent.steer` under `busyInbound: steer`) and never awaits a turn.
 * Outbound is one path for every turn, whoever started it: committed
 * session events (`session/event`) are buffered per conversation and drive
 * a send tail that advances a persisted cursor and sends assistant output to the
 * conversation. Events older than this process's live observation (restart
 * catch-up) are read once through `ctx.sessionQuery.observeSession`; the
 * deprecated synchronous Session history readers are not used. Turns an
 * XMTP inbound started are correlated through
 * `agent/inbox/claimed` (message id → turn) for the reply outbox; turns
 * something else started (background-job wakes, schedules, subagent
 * returns) are sent as proactive messages. An empty turn sends nothing.
 *
 * @module dsh-channel-xmtp
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: carries the `ctx.wallet` Context declaration.
import type {} from 'dsh-wallet'
import { hexToBytes, loadXmtpSdk } from './xmtp.ts'
import type { XmtpClient, XmtpConversation, XmtpDecodedMessage, XmtpSdk, XmtpSigner, XmtpStream } from './xmtp.ts'
import type { XmtpChannelStatus, XmtpOutboundKind } from './types.ts'
// Type-only: carries the `xmtp/inbound`, `xmtp/outbound`, and `xmtp/status` event declarations.
import type {} from './types.ts'

export type { XmtpChannelStatus, XmtpInboundEvent, XmtpOutboundEvent, XmtpOutboundKind, XmtpStatusEvent } from './types.ts'
export { hexToBytes, internals, loadXmtpSdk } from './xmtp.ts'

/** Cordis plugin name. */
export const name = 'channel-xmtp'
/** Signing identity, agent factory, model selection, and the db-key credential seam. */
export const inject = ['wallet', 'agents', 'agentDefaultModel', 'credentials']

/** Haven `XmtpChannel` defaults, ported verbatim. */
export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10
export const DEFAULT_RECONNECT_DELAY_MS = 5_000
export const CONSENT_SWEEP_INTERVAL_MS = 15_000
export const MAX_DEDUP_SIZE = 5_000
/** Default busy acknowledgment; `busyAck: ''` disables it. */
export const DEFAULT_BUSY_ACK = "Still working on the previous request — I'll get to this next."
/** Outbox value for an inbound admitted to its agent but not yet answered. */
export const OUTBOX_ACCEPTED = 'accepted'
/**
 * Bound for one send-tail task (flush + sends). A stuck send (wedged turn,
 * hanging transport) must fail loud instead of blocking its conversation
 * forever: without this, every later flush queues behind an unsettled
 * promise and the conversation goes silent with no error anywhere. Ten
 * minutes clears the slowest observed turns with wide margin.
 */
export const DELIVER_TIMEOUT_MS = 10 * 60 * 1_000
/**
 * Test seam for the deliver bound: specs shorten the watchdog without
 * touching the production default. Not part of the plugin contract.
 */
export const deliveryPolicy = { timeoutMs: DELIVER_TIMEOUT_MS }

/** Plugin configuration. */
export interface Config {
  /**
   * Configured `dsh-wallet` wallet name providing the channel's Ethereum
   * identity. Every XMTP signature request signs through this wallet.
   */
  wallet: string
  /** XMTP network: `production`, `dev`, or `local`. */
  env: 'production' | 'dev' | 'local'
  /** Local XMTP database path; the SDK default when absent. */
  dbPath?: string
  /**
   * Credential *reference* (`ctx.credentials` semantics) naming the hex
   * encryption key of the local XMTP database. Resolved at each connect —
   * never a key value in configuration (Haven carried the raw
   * `dbEncryptionKey` in config; that does not transfer).
   */
  dbEncryptionKeyRef?: string
  /**
   * When set, only messages from this conversation reach the agent (Haven's
   * `setActiveGroupId`, moved from a runtime setter to configuration).
   */
  activeConversationId?: string
  /** Session-id prefix distinguishing parallel channel mounts. */
  channelName?: string
  /** Consecutive failed reconnects before the channel gives up. */
  maxReconnectAttempts?: number
  /** Delay between reconnect attempts. */
  reconnectDelayMs?: number
  /**
   * Convos layer: when `convos:true`, the channel also handles Convos invites
   * (base64url `popup.convos.org/v2?i=<slug>`). Convos is XMTP + `convos.org/*`
   * codecs (join_request/invite_join_error) on the same libxmtp Client, with
   * per-conversation singleton inbox semantics. The wallet seam still provides
   * identity; Convos invite minting/listening reuses the XMTP client.
   */
  convos?: boolean
  /** Optional Convos invite URL to expose via xmtp/status (for QR). */
  convosInviteUrl?: string
  /**
   * Channel-state file for exactly-once delivery. Persists (a) the inbound
   * outbox `(conversationId, inboundMessageId) → sentMessageId | 'accepted'`
   * so a redelivered inbound (reconnect replay, restart) reaches its agent
   * once, and (b) each conversation's outbound session cursor so a restart
   * sends output produced but not yet sent, and never re-sends output
   * already sent. When absent all of it is memory-only.
   */
  outboxPath?: string
  /**
   * When assistant output reaches XMTP:
   * - `turn` (default): once per turn, at its close, the turn's final
   *   assistant text plus every image it produced — one reply per turn;
   * - `message`: every assistant message as it commits — intermediate
   *   narration ("starting the encode…") reaches the user live.
   */
  replyMode?: 'turn' | 'message'
  /**
   * Text sent once per running interval when an inbound arrives while the
   * conversation's agent is mid-turn, so a long turn never looks like a dead
   * channel. Empty string disables.
   */
  busyAck?: string
  /**
   * How an inbound that arrives mid-turn enters the agent:
   * - `queue` (default): its own follow-up turn after the running one;
   * - `steer`: joins the running turn at its next step boundary (the model
   *   sees it mid-pipeline; pair with `replyMode: message` for a live answer).
   */
  busyInbound?: 'queue' | 'steer'
}

/** Config schema. */
export const Config: z<Config> = z.object({
  wallet: z.string().required(),
  env: z.union(['production', 'dev', 'local']).required(),
  dbPath: z.string(),
  dbEncryptionKeyRef: z.string(),
  activeConversationId: z.string(),
  channelName: z.string().default('xmtp'),
  maxReconnectAttempts: z.number().step(1).min(0).default(DEFAULT_MAX_RECONNECT_ATTEMPTS),
  reconnectDelayMs: z.number().step(1).min(0).default(DEFAULT_RECONNECT_DELAY_MS),
  convos: z.boolean().default(false),
  convosInviteUrl: z.string(),
  outboxPath: z.string(),
  replyMode: z.union(['turn', 'message']).default('turn'),
  busyAck: z.string().default(DEFAULT_BUSY_ACK),
  busyInbound: z.union(['queue', 'steer']).default('queue'),
})

/** One image block an assistant message carried. */
type ImageBlock = { type: 'image'; attachment: unknown }

/** Text (joined text blocks) and images of one `assistant/message` event. */
function assistantContent(event: SessionEvent): { text: string; images: ImageBlock[] } {
  if (event.type !== 'assistant/message') return { text: '', images: [] }
  const blocks = event.data.message.content as Array<{ type: string; text?: string; attachment?: unknown }>
  const text = blocks
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text ?? '')
    .join('')
  const images = blocks.filter((block): block is ImageBlock => block.type === 'image' && block.attachment !== undefined)
  return { text, images }
}

/**
 * Fold the assistant's markdown into chat-shaped plain text. Replies leave
 * over the XMTP text codec, which has no markdown renderer, so `*emphasis*`
 * would arrive literally. Idempotent on already-plain input; URLs, `0x…`
 * hashes, `- ` bullets, and numbered lists pass through untouched.
 */
export function toPlainText(reply: string): string {
  // Fold markdown links first: protecting their URLs would split the pattern.
  const linked = reply.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1: $2')
  // Split on protected spans (URLs, hex hashes) so folding never touches them.
  const parts = linked.split(/(https?:\/\/[^\s)>\]]+|0x[0-9a-fA-F]+)/g)
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = foldMarkdown(parts[i] ?? '')
  }
  const lines = parts.join('').split('\n').map((line) => line.replace(/[ \t]+$/g, ''))
  const out: string[] = []
  let blanks = 0
  for (const line of lines) {
    if (line.trim() === '') {
      blanks += 1
      if (blanks <= 1) out.push('')
      continue
    }
    blanks = 0
    out.push(line)
  }
  const folded = out.join('\n').trim()
  return folded === '' ? reply : folded
}

/** Strip markdown syntax from one unprotected span, keeping its text. */
function foldMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1: $2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[*-]{3,}\s*$/gm, '')
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[a-z]*\n?/gi, ''))
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?;:]|$)/gm, '$1$2')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?;:]|$)/gm, '$1$2')
    .replace(/`([^`\n]+)`/g, '$1')
}

/** Assistant output accumulated for one turn under `replyMode: turn`. */
interface TurnBuffer {
  turn: number
  /** The turn's last non-empty assistant text (its final answer). */
  text: string
  images: ImageBlock[]
}

/** Persisted channel state (outbox file). Version 1 carried `entries` only. */
interface OutboxFile {
  version: 1 | 2
  entries: Array<[string, string]>
  /** Version 2: `conversationId → last handled session seq` (inclusive). */
  cursors?: Array<[string, number]>
}

/** Thrown when a send cannot happen yet (no client); the cursor holds and a later trigger retries. */
class NotConnectedError extends Error {}

/** Session event types the outbound path reads; everything else is ignored. */
const OUTPUT_EVENT_TYPES: ReadonlySet<string> = new Set(['turn/start', 'assistant/message', 'turn/end'])

/**
 * Committed output events of one conversation's current Session, pushed by
 * `session/event`. `liveFrom` is the first seq this process could observe;
 * anything older is read once through `ctx.sessionQuery` (restart catch-up).
 */
interface ObservedSession {
  session: Session
  liveFrom: number
  events: SessionEvent[]
}

/** The slice of `ctx.sessionQuery` (dsh-session-query, mounted by dsh-base) the catch-up read uses. */
interface SessionQueryLike {
  observeSession(sessionId: SessionId, options?: { projectionMode?: 'all' | 'none' }): Promise<{
    readonly events: readonly SessionEvent[]
    [Symbol.dispose](): void
  }>
}

/** The channel: one XMTP client, its stream lifecycle, and the conversation→agent map. */
class XmtpChannelRuntime {
  private status: XmtpChannelStatus = 'disconnected'
  private client: XmtpClient | undefined
  private stream: XmtpStream | undefined
  private sdk: XmtpSdk | undefined
  private reconnectAttempts = 0
  private stopped = false
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private sweepTimer: ReturnType<typeof setInterval> | undefined
  /** Dedup by message id, insertion-ordered so pruning drops the oldest half. */
  private readonly seen = new Set<string>()
  /**
   * Inbound outbox: `(conversationId, inboundMessageId) → sentMessageId`,
   * or {@link OUTBOX_ACCEPTED} once admitted but before its reply. Either
   * value marks the inbound handled, so redelivery never re-enters an agent.
   */
  private readonly outbox = new Map<string, string>()
  /**
   * Outbound cursor per conversation: the last session seq whose output is
   * handled (sent, or deliberately silent). Persisted with the outbox.
   */
  private readonly cursors = new Map<string, number>()
  /** Pushed output events per conversation, pruned as the cursor advances. */
  private readonly observed = new Map<string, ObservedSession>()
  /** Agent handles this channel created or resumed, per conversation. */
  private readonly handles = new Map<string, Promise<AgentHandle>>()
  /** Conversations whose agent creation/resume is still pending. */
  private readonly creating = new Set<string>()
  /** Session id → conversation id for every conversation this channel serves. */
  private readonly conversationsBySession = new Map<string, string>()
  /** Per-conversation admission chains: inbound enters its agent in arrival order. */
  private readonly admissions = new Map<string, Promise<void>>()
  /** Per-conversation send tails: every outbound send for one conversation is ordered. */
  private readonly sendTails = new Map<string, Promise<void>>()
  /** Conversations with a flush queued on their send tail and not yet started. */
  private readonly flushQueued = new Set<string>()
  /** dsh message id → the XMTP inbound it carries, until the agent claims it. */
  private readonly pendingInbound = new Map<string, { conversationId: string; inboundMessageId: string }>()
  /** `conversationId\nturn` → the XMTP inbound that turn answers. */
  private readonly turnInbound = new Map<string, string>()
  /** Conversations already acked during their agent's current running interval. */
  private readonly acked = new Set<string>()
  /** Serialized outbox persistence (one writer at a time; last state wins). */
  private persistTail: Promise<void> = Promise.resolve()
  private persistPending = false

  constructor(private readonly ctx: Context, private readonly config: Config) {}

  /** Enter the connect loop; never throws (failures feed the reconnect policy). */
  async start(): Promise<void> {
    this.setStatus('connecting', 'starting')
    this.observeAgents()
    await this.loadOutbox()
    await this.connect()
  }

  // ── Outbox / cursor persistence ────────────────────────────────────────────

  /** Outbox key for one inbound message. */
  private static outboxKey(conversationId: string, inboundMessageId: string): string {
    return `${conversationId}\n${inboundMessageId}`
  }

  /**
   * Load the persisted outbox and cursors, if any. Best-effort: a missing or
   * corrupt file starts empty (at-least-once delivery), never blocks connecting.
   */
  private async loadOutbox(): Promise<void> {
    const path = this.config.outboxPath
    if (path === undefined || path === '') return
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'))
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.log(`[xmtp] outbox unreadable (${path}), starting empty: ${error instanceof Error ? error.message : String(error)}`)
      }
      return
    }
    const file = (parsed !== null && typeof parsed === 'object' ? parsed : {}) as Partial<OutboxFile>
    const entries = file.entries
    if (!Array.isArray(entries)) {
      console.log(`[xmtp] outbox corrupt (${path}), starting empty`)
      return
    }
    for (const entry of entries) {
      if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string') {
        this.outbox.set(entry[0], entry[1])
      }
    }
    // Version 1 files have no cursors: each conversation seeds from its
    // session's current end on first attach, so pre-upgrade history is never re-sent.
    if (Array.isArray(file.cursors)) {
      for (const entry of file.cursors) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && Number.isSafeInteger(entry[1])) {
          this.cursors.set(entry[0], entry[1])
        }
      }
    }
    this.pruneOutbox()
  }

  /** Drop the oldest half past the cap (the `seen` rule). */
  private pruneOutbox(): void {
    if (this.outbox.size <= MAX_DEDUP_SIZE) return
    for (const key of this.outbox.keys()) {
      if (this.outbox.size <= MAX_DEDUP_SIZE / 2) break
      this.outbox.delete(key)
    }
  }

  /**
   * Persist outbox + cursors. Writers serialize on one tail and coalesce:
   * a call during a write schedules exactly one more write of the latest
   * state. Best-effort — a failed write degrades to memory-only and never
   * fails a delivery.
   */
  private persist(): Promise<void> {
    const path = this.config.outboxPath
    if (path === undefined || path === '') return Promise.resolve()
    if (this.persistPending) return this.persistTail
    this.persistPending = true
    this.persistTail = this.persistTail.then(async () => {
      this.persistPending = false
      const file: OutboxFile = {
        version: 2,
        entries: [...this.outbox.entries()],
        cursors: [...this.cursors.entries()],
      }
      try {
        await mkdir(dirname(path), { recursive: true })
        const tmp = join(dirname(path), `.outbox.${Date.now()}.${Math.floor(Math.random() * 1e9)}.tmp`)
        await writeFile(tmp, JSON.stringify(file))
        await rename(tmp, path)
      } catch (error: unknown) {
        console.log(`[xmtp] outbox persist failed (${path}), memory-only: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    return this.persistTail
  }

  /** The id a send returned, normalized for the outbox. */
  private static sentId(sent: unknown): string {
    if (typeof sent === 'string') return sent
    if (sent !== null && typeof sent === 'object' && 'id' in sent && typeof (sent as { id: unknown }).id === 'string') {
      return (sent as { id: string }).id
    }
    return 'sent'
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Tear everything down: stream, sweep, timers, and every owned agent. */
  async stop(): Promise<void> {
    this.stopped = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer)
    this.sweepTimer = undefined
    await this.stream?.end().catch(() => undefined)
    this.stream = undefined
    this.client = undefined
    // Let in-flight sends settle so the cursor on disk matches what was sent.
    await Promise.allSettled([...this.sendTails.values()])
    await this.persist()
    for (const pending of this.handles.values()) {
      await pending.then(handle => handle.dispose()).catch(() => undefined)
    }
    this.handles.clear()
    this.setStatus('disconnected', 'stopped')
  }

  private setStatus(status: XmtpChannelStatus, reason: string): void {
    if (this.status === status) return
    console.log(`[xmtp] status ${this.status} -> ${status}: ${reason}`)
    this.status = status
    this.ctx.emit('xmtp/status', { status, reason })
  }

  /**
   * The EOA signer: identity through `ctx.wallet`. Each `signMessage` call is
   * one wallet operation — the credential resolves inside it and is dropped.
   */
  private buildSigner(sdk: XmtpSdk, address: string): XmtpSigner {
    const wallet = this.config.wallet
    const ctx = this.ctx
    return {
      type: 'EOA',
      getIdentifier: () => ({ identifier: address.toLowerCase(), identifierKind: sdk.ethereumIdentifierKind }),
      signMessage: async (message: string) => hexToBytes((await ctx.wallet.signMessage(wallet, message)).signature),
    }
  }

  /** One connect attempt; failure schedules a bounded retry. */
  private async connect(): Promise<void> {
    if (this.stopped) return
    try {
      const sdk = this.sdk ?? await loadXmtpSdk()
      this.sdk = sdk
      const address = await this.ctx.wallet.address(this.config.wallet)
      const dbEncryptionKey = await this.resolveDbKey()
      const client = await sdk.createClient(this.buildSigner(sdk, address), {
        env: this.config.env,
        ...this.config.dbPath !== undefined ? { dbPath: this.config.dbPath } : {},
        ...dbEncryptionKey !== undefined ? { dbEncryptionKey } : {},
      })
      if (this.stopped) return
      this.client = client
      await this.sweepConsent(client, sdk)
      this.stream = await client.conversations.streamAllMessages({
        consentStates: [sdk.consentAllowed, sdk.consentUnknown],
        onValue: (message) => { this.onMessage(message) },
        onError: (error) => { void this.reconnect(`stream error: ${error.message}`) },
      })
      if (this.stopped) { await this.stream.end().catch(() => undefined); return }
      this.reconnectAttempts = 0
      this.sweepTimer ??= setInterval(() => {
        if (this.client !== undefined && this.sdk !== undefined) {
          void this.sweepConsent(this.client, this.sdk)
        }
        // Retry trigger for sends that failed while disconnected.
        this.flushAll()
      }, CONSENT_SWEEP_INTERVAL_MS)
      // Convos layer: same XMTP client, Convos is XMTP + convos.org codecs.
      // Invite is base64url `popup.convos.org/v2?i=<slug>`; the slug is already valid for this client.
      // No extra client needed — the same inbox handles both vanilla DMs and Convos groups.
      if (this.config.convos) {
        const invite = this.config.convosInviteUrl ?? `https://popup.convos.org/v2?i=<mint via convos conversation invite ${this.config.channelName ?? 'xmtp'}>`
        this.setStatus('connected', `connected as ${address.toLowerCase()} (convos invite: ${invite})`)
      } else {
        this.setStatus('connected', `connected as ${address.toLowerCase()}`)
      }
      this.resumeKnownConversations()
    } catch (error) {
      await this.reconnect(error instanceof Error ? error.message : String(error))
    }
  }

  /** Bounded fixed-delay retry (Haven's Reconnecting state). */
  private async reconnect(reason: string): Promise<void> {
    if (this.stopped) return
    await this.stream?.end().catch(() => undefined)
    this.stream = undefined
    this.client = undefined
    this.reconnectAttempts += 1
    if (this.reconnectAttempts > (this.config.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS)) {
      this.setStatus('disconnected', `reconnect attempts exhausted: ${reason}`)
      return
    }
    this.setStatus('reconnecting', reason)
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      void this.connect()
    }, this.config.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS)
    this.timers.add(timer)
  }

  /** Resolve the db encryption key reference NOW (per connect), never cached. */
  private async resolveDbKey(): Promise<Uint8Array | undefined> {
    if (this.config.dbEncryptionKeyRef === undefined) return undefined
    const ref = credentialRef(this.config.dbEncryptionKeyRef)
    const resolved = await this.ctx.credentials.resolve(ref)
    if (resolved === undefined) {
      throw new Error(
        `dsh-channel-xmtp: credential reference "${this.config.dbEncryptionKeyRef}" resolves to no value — `
        + 'configure it with your credential provider before connecting',
      )
    }
    return hexToBytes(resolved.value)
  }

  /** Consent auto-allow sweep, ported verbatim: individual failures are swallowed. */
  private async sweepConsent(client: XmtpClient, sdk: XmtpSdk): Promise<void> {
    try {
      await client.conversations.sync()
      const conversations = await client.conversations.list()
      console.log(`[xmtp] sweep ${conversations.length} convos`)
      for (const conversation of conversations) {
        try {
          const cs = conversation.consentState()
          const id = (conversation as unknown as { id?: string }).id ?? String((conversation as unknown as { conversationId?: string }).conversationId ?? '').slice(0, 8)
          if (cs !== sdk.consentAllowed) {
            console.log(`[xmtp] sweep allow ${id} ${String(cs)} -> ${String(sdk.consentAllowed)}`)
            await conversation.updateConsentState(sdk.consentAllowed)
          }
        } catch (e) {
          console.log(`[xmtp] sweep consent fail ${String((e as Error)?.message ?? e).slice(0, 120)}`)
        }
      }
    } catch (e) {
      console.log(`[xmtp] sweep failed ${String((e as Error)?.message ?? e).slice(0, 200)}`)
    }
  }

  // ── Agent observation (the outbound side) ──────────────────────────────────

  /** Session id of one conversation's agent. */
  private sessionIdFor(conversationId: string): SessionId {
    return SessionId(`${this.config.channelName ?? 'xmtp'}-${conversationId}`)
  }

  /** The live agent currently registered for a conversation, if any (replacement-safe). */
  private liveAgent(conversationId: string): Agent | undefined {
    return this.ctx.agents.get(this.sessionIdFor(conversationId))
  }

  /** The served conversation an agent belongs to, when its live session is the one observed. */
  private conversationOf(agent: Agent): string | undefined {
    return this.conversationsBySession.get(String(agent.session.id))
  }

  /**
   * Subscribe to the agent/session events the transport needs. Listeners
   * on the plugin context are untagged, so scope-filtered dispatch admits
   * them for every agent; each handler filters to served conversations.
   */
  private observeAgents(): void {
    this.ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (this.stopped) return
      const conversationId = this.conversationsBySession.get(String(session.id))
      if (conversationId === undefined) return
      // A same-id impostor or a retired Session is not ours to project.
      if (this.liveAgent(conversationId)?.session !== session) return
      if (!OUTPUT_EVENT_TYPES.has(event.type)) return
      this.observe(conversationId, session, Number(event.seq)).events.push(event)
      const relevant = this.config.replyMode === 'message'
        ? event.type === 'assistant/message' || event.type === 'turn/end'
        : event.type === 'turn/end'
      if (relevant) this.scheduleFlush(conversationId)
    })

    this.ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      const pending = this.pendingInbound.get(String(message.id))
      if (pending === undefined) return
      this.pendingInbound.delete(String(message.id))
      if (this.conversationOf(agent) !== pending.conversationId) return
      this.turnInbound.set(`${pending.conversationId}\n${turn}`, pending.inboundMessageId)
    })

    this.ctx.on('agent/inbox/discarded', ({ message }) => {
      this.pendingInbound.delete(String(message.id))
    })

    this.ctx.on('agent/status', ({ agent, status }) => {
      const conversationId = this.conversationOf(agent)
      if (conversationId === undefined) return
      if (status === 'idle') {
        this.acked.delete(conversationId)
        // Safety net: anything committed but not yet flushed goes out now.
        this.scheduleFlush(conversationId)
      }
    })
  }

  /**
   * The observation record for a conversation's current Session, (re)started
   * when the Session object changes (agent replacement, resume). A fresh
   * record can see events from `liveFrom` on; older ones need catch-up.
   */
  private observe(conversationId: string, session: Session, liveFrom: number): ObservedSession {
    const current = this.observed.get(conversationId)
    if (current?.session === session) return current
    const fresh: ObservedSession = { session, liveFrom, events: [] }
    this.observed.set(conversationId, fresh)
    return fresh
  }

  /**
   * Output events after `cursor` and before `end`: pushed events, preceded,
   * when the cursor predates what this process observed live, by one
   * `ctx.sessionQuery` read of the gap. Without the query service the gap is
   * skipped (logged) and the cursor jumps to the live edge — output is never
   * replayed twice, but pre-restart unsent output is then lost.
   * @returns the events to process in seq order, or undefined after a skip.
   */
  private async pendingEvents(conversationId: string, session: Session, cursor: number, end: number): Promise<readonly SessionEvent[] | undefined> {
    const record = this.observe(conversationId, session, end)
    const buffered = record.events.filter(event => Number(event.seq) > cursor && Number(event.seq) < end)
    if (cursor + 1 >= record.liveFrom) return buffered
    const query = this.ctx.get('sessionQuery') as unknown as SessionQueryLike | undefined
    if (query !== undefined && typeof query.observeSession === 'function') {
      try {
        const observation = await query.observeSession(session.id, { projectionMode: 'none' })
        try {
          const caught = observation.events.filter(event => Number(event.seq) > cursor
            && Number(event.seq) < record.liveFrom && OUTPUT_EVENT_TYPES.has(event.type))
          return [...caught, ...buffered]
        } finally {
          observation[Symbol.dispose]()
        }
      } catch (error) {
        console.log(`[xmtp] catch-up read failed ${conversationId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    console.log(`[xmtp] ${conversationId.slice(0, 8)}: events ${cursor + 1}..${record.liveFrom - 1} unreadable (no sessionQuery); skipping to the live edge`)
    this.cursors.set(conversationId, record.liveFrom - 1)
    await this.persist()
    return undefined
  }

  /** Drop pushed events at or before the cursor. */
  private pruneObserved(conversationId: string): void {
    const record = this.observed.get(conversationId)
    const cursor = this.cursors.get(conversationId)
    if (record === undefined || cursor === undefined) return
    record.events = record.events.filter(event => Number(event.seq) > cursor)
  }

  /**
   * Queue one flush on the conversation's send tail. Coalesces: at most one
   * flush waits behind a running one, and a flush reads everything committed
   * by the time it starts.
   */
  private scheduleFlush(conversationId: string): void {
    if (this.stopped || this.flushQueued.has(conversationId)) return
    this.flushQueued.add(conversationId)
    this.enqueueSend(conversationId, async () => {
      this.flushQueued.delete(conversationId)
      await this.flush(conversationId)
    })
  }

  /** Flush every served conversation (retry trigger). */
  private flushAll(): void {
    for (const conversationId of new Set(this.conversationsBySession.values())) this.scheduleFlush(conversationId)
  }

  /** Append one task to a conversation's send tail; failures are logged, never thrown. */
  private enqueueSend(conversationId: string, task: () => Promise<void>): Promise<void> {
    const prev = this.sendTails.get(conversationId) ?? Promise.resolve()
    const cur = prev.then(() => this.runBounded(conversationId, task)).catch((error: unknown) => {
      if (error instanceof NotConnectedError) return
      console.log(`[xmtp] send failed ${conversationId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`)
    })
    this.sendTails.set(conversationId, cur)
    void cur.then(() => { if (this.sendTails.get(conversationId) === cur) this.sendTails.delete(conversationId) })
    return cur
  }

  /**
   * Run one send-tail task bounded by the deliver policy (see
   * {@link DELIVER_TIMEOUT_MS}). A rejection clears the tail through the
   * normal `enqueueSend` cleanup, so later flushes still run instead of
   * wedging behind a corpse.
   */
  private async runBounded(conversationId: string, task: () => Promise<void>): Promise<void> {
    const timeoutMs = deliveryPolicy.timeoutMs
    let fireTimeout: () => void = () => {}
    const watchdog = new Promise<never>((_, reject) => {
      fireTimeout = () => {
        reject(new Error(
          `deliver timeout for conversation ${conversationId.slice(0, 8)} after ${timeoutMs}ms — `
          + 'a stuck send was blocking this conversation',
        ))
      }
    })
    const timer = setTimeout(fireTimeout, timeoutMs)
    try {
      await Promise.race([task(), watchdog])
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Send everything committed after the conversation's cursor. Under
   * `replyMode: turn` the cursor advances only at closed turns, so an open
   * turn is re-read by a later flush; under `message` it advances per
   * assistant message. A send failure leaves the cursor at the last fully
   * sent boundary and a later trigger (next event, idle, sweep, reconnect)
   * retries — at-least-once, never skipped.
   */
  private async flush(conversationId: string): Promise<void> {
    if (this.stopped) return
    const agent = this.liveAgent(conversationId)
    if (agent === undefined) return
    const session = agent.session
    const end = Number(session.seq)
    let cursor = this.cursors.get(conversationId)
    if (cursor === undefined || cursor >= end) {
      // No cursor (fresh mount, v1 outbox) or a log shorter than the cursor
      // (the Session was replaced): start from now, never replay history.
      this.cursors.set(conversationId, end - 1)
      if (cursor !== undefined) console.log(`[xmtp] cursor reset ${conversationId.slice(0, 8)}: ${cursor} >= log end ${end}`)
      this.pruneObserved(conversationId)
      await this.persist()
      return
    }
    if (cursor === end - 1) return
    const events = await this.pendingEvents(conversationId, session, cursor, end)
    if (events === undefined) {
      this.pruneObserved(conversationId)
      return
    }
    let buffer: TurnBuffer | undefined
    for (const event of events) {
      if (this.config.replyMode === 'message') {
        if (event.type === 'assistant/message') {
          const { text, images } = assistantContent(event)
          if (text !== '' || images.length > 0) {
            await this.sendOutput(conversationId, event.data.turn, text, images, false)
          }
          cursor = Number(event.seq)
        } else if (event.type === 'turn/end') {
          this.settleTurn(conversationId, event.data.turn)
          cursor = Number(event.seq)
        } else {
          continue
        }
      } else {
        if (event.type === 'turn/start') {
          buffer = { turn: event.data.turn, text: '', images: [] }
          continue
        }
        if (event.type === 'assistant/message') {
          buffer ??= { turn: event.data.turn, text: '', images: [] }
          const { text, images } = assistantContent(event)
          if (text !== '') buffer.text = text
          buffer.images.push(...images)
          continue
        }
        if (event.type !== 'turn/end') continue
        const turn = event.data.turn
        if (buffer !== undefined && buffer.turn === turn && (buffer.text !== '' || buffer.images.length > 0)) {
          await this.sendOutput(conversationId, turn, buffer.text, buffer.images, true)
        } else {
          // Silence convention: a turn that produced no assistant output sends nothing.
          this.settleTurn(conversationId, turn)
        }
        buffer = undefined
        cursor = Number(event.seq)
      }
      this.cursors.set(conversationId, cursor)
      this.pruneObserved(conversationId)
      await this.persist()
    }
  }

  /** Forget a closed turn's inbound correlation without sending. */
  private settleTurn(conversationId: string, turn: number): void {
    this.turnInbound.delete(`${conversationId}\n${turn}`)
  }

  /**
   * Send one turn's (or one message's) output: images first, then text.
   * Records the reply outbox entry when the turn answers an XMTP inbound.
   * @param closesTurn - whether this send completes the turn (drop its correlation after).
   */
  private async sendOutput(conversationId: string, turn: number, text: string, images: ImageBlock[], closesTurn: boolean): Promise<void> {
    const conversation = await this.conversation(conversationId)
    if (conversation === undefined) {
      console.log(`[xmtp] conversation ${conversationId.slice(0, 8)} not found; dropping turn ${turn} output`)
      if (closesTurn) this.settleTurn(conversationId, turn)
      return
    }
    let sent: unknown
    let sentAny = false
    for (const image of images) {
      const result = await this.sendImage(conversation, image)
      if (result !== undefined) { sent = result; sentAny = true }
    }
    if (text !== '') {
      sent = await conversation.sendText(toPlainText(text))
      sentAny = true
    }
    const key = `${conversationId}\n${turn}`
    const inboundMessageId = this.turnInbound.get(key)
    if (closesTurn) this.turnInbound.delete(key)
    if (!sentAny) return
    if (inboundMessageId !== undefined) {
      this.outbox.set(XmtpChannelRuntime.outboxKey(conversationId, inboundMessageId), XmtpChannelRuntime.sentId(sent))
      this.pruneOutbox()
    }
    this.emitOutbound(conversationId, inboundMessageId === undefined ? 'proactive' : 'reply', turn, inboundMessageId)
  }

  /** Send one stored image as an XMTP attachment; undefined when it cannot be sent. */
  private async sendImage(conversation: XmtpConversation, image: ImageBlock): Promise<unknown> {
    const attachments = (this.ctx as unknown as { attachments?: { readImage: (r: unknown) => Promise<{ data: Uint8Array; mediaType: string; filename?: string }> } }).attachments
    if (attachments === undefined || typeof conversation.sendAttachment !== 'function') return undefined
    try {
      const stored = await attachments.readImage(image.attachment)
      return await conversation.sendAttachment({
        mimeType: stored.mediaType,
        content: stored.data,
        ...stored.filename !== undefined ? { filename: stored.filename } : {},
      })
    } catch (error) {
      console.log(`[xmtp] image send failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /** Resolve a conversation handle; throws {@link NotConnectedError} when offline. */
  private async conversation(conversationId: string): Promise<XmtpConversation | undefined> {
    const client = this.client
    if (client === undefined) throw new NotConnectedError('not connected')
    try { await client.conversations.sync() } catch {}
    return client.conversations.getConversationById(conversationId)
  }

  private emitOutbound(conversationId: string, kind: XmtpOutboundKind, turn?: number, inboundMessageId?: string): void {
    this.ctx.emit('xmtp/outbound', {
      conversationId,
      kind,
      ...turn !== undefined ? { turn } : {},
      ...inboundMessageId !== undefined ? { inboundMessageId } : {},
    })
  }

  /**
   * After connect: resume the agent of every conversation with a persisted
   * cursor and flush it, so output committed before a crash (or while
   * offline) is sent without waiting for the next inbound.
   */
  private resumeKnownConversations(): void {
    for (const conversationId of this.cursors.keys()) {
      if (this.config.activeConversationId !== undefined && conversationId !== this.config.activeConversationId) continue
      this.agentFor(conversationId)
        .then(() => { this.scheduleFlush(conversationId) })
        .catch((error: unknown) => {
          console.log(`[xmtp] resume ${conversationId.slice(0, 8)} failed: ${error instanceof Error ? error.message : String(error)}`)
        })
    }
  }

  // ── Inbound ────────────────────────────────────────────────────────────────

  /**
   * Haven's inbound filter order: text/attachment → own → active-conversation
   * → outbox → dedup. Accepted messages are admitted on the conversation's
   * admission chain, which only ever waits on content resolution and agent
   * creation — never on a turn.
   */
  private onMessage(message: XmtpDecodedMessage): void {
    if (this.stopped || this.sdk === undefined) return
    const sdk = this.sdk
    const isText = typeof sdk.isText === 'function' && sdk.isText(message) && typeof message.content === 'string'
    const isRemote = typeof sdk.isRemoteAttachment === 'function' && sdk.isRemoteAttachment(message)
    const isAttach = typeof sdk.isAttachment === 'function' && sdk.isAttachment(message)
    if (!isText && !isRemote && !isAttach) return
    if (message.senderInboxId === this.client?.inboxId) return
    if (this.config.activeConversationId !== undefined
      && message.conversationId !== this.config.activeConversationId) return
    if (this.outbox.has(XmtpChannelRuntime.outboxKey(message.conversationId, message.id))) return
    if (this.seen.has(message.id)) return
    this.seen.add(message.id)
    if (this.seen.size > MAX_DEDUP_SIZE) {
      for (const id of this.seen) {
        if (this.seen.size <= MAX_DEDUP_SIZE / 2) break
        this.seen.delete(id)
      }
    }
    console.log('[xmtp] inbound', JSON.stringify({ id: message.id.slice(0, 8), conv: message.conversationId.slice(0, 8), kind: isText ? 'text' : 'attachment' }))
    this.ctx.emit('xmtp/inbound', {
      messageId: message.id,
      conversationId: message.conversationId,
      senderInboxId: message.senderInboxId,
      sentAtMs: message.sentAt.getTime(),
    })
    void this.admit(message)
  }

  /**
   * Admit one inbound to its conversation's agent: resolve content, ack if
   * the agent is mid-turn, enqueue, record the correlation, mark the inbound
   * accepted. Ordered per conversation; returns once enqueued, never after a turn.
   */
  private admit(message: XmtpDecodedMessage): Promise<void> {
    const conversationId = message.conversationId
    const prev = this.admissions.get(conversationId) ?? Promise.resolve()
    const cur = prev.then(async () => {
      if (this.stopped) return
      const content = await this.resolveAttachmentContent(message)
      if (content.length === 0) return
      await this.agentFor(conversationId)
      const agent = this.liveAgent(conversationId)
      if (agent === undefined || this.stopped) return
      const busy = agent.status === 'running'
      if (busy) this.sendBusyAck(conversationId)
      // `source.kind: 'user'` is load-bearing: tool-jobs refills its
      // per-owner wake budget (maxConsecutiveWakes) only on user-sourced claims.
      const userMessage = createUserMessage({ content: content as never, source: { kind: 'user' } })
      this.pendingInbound.set(String(userMessage.id), { conversationId, inboundMessageId: message.id })
      // Bounded like `seen`: an entry whose message is never claimed or discarded must not leak.
      if (this.pendingInbound.size > MAX_DEDUP_SIZE) {
        for (const id of this.pendingInbound.keys()) {
          if (this.pendingInbound.size <= MAX_DEDUP_SIZE / 2) break
          this.pendingInbound.delete(id)
        }
      }
      if (busy && this.config.busyInbound === 'steer') agent.steer(userMessage)
      else agent.followup(userMessage)
      console.log('[xmtp] admitted', conversationId.slice(0, 8), busy ? `(busy, ${this.config.busyInbound ?? 'queue'})` : '')
      // The inbox splice is now in the session log; flush it before marking the
      // inbound handled so a crash cannot lose a message the outbox says arrived.
      await this.flushSession(agent)
      // The turn may already have answered (fast model): never overwrite its sent id.
      const key = XmtpChannelRuntime.outboxKey(conversationId, message.id)
      if (!this.outbox.has(key)) this.outbox.set(key, OUTBOX_ACCEPTED)
      this.pruneOutbox()
      await this.persist()
    }).catch((error: unknown) => {
      console.error('[xmtp] admit failed', error instanceof Error ? error.message : String(error))
    })
    this.admissions.set(conversationId, cur)
    void cur.then(() => { if (this.admissions.get(conversationId) === cur) this.admissions.delete(conversationId) })
    return cur
  }

  /** Best-effort durable flush of the agent's session (no-op without a session store that flushes). */
  private async flushSession(agent: Agent): Promise<void> {
    const sessions = this.ctx.get('sessions') as unknown as { flush?: (session: Session) => Promise<void> } | undefined
    try {
      await sessions?.flush?.(agent.session)
    } catch (error) {
      console.log(`[xmtp] session flush failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Send the busy ack once per running interval (reset when the agent goes idle). */
  private sendBusyAck(conversationId: string): void {
    const text = this.config.busyAck ?? DEFAULT_BUSY_ACK
    if (text === '' || this.acked.has(conversationId)) return
    this.acked.add(conversationId)
    void this.enqueueSend(conversationId, async () => {
      const conversation = await this.conversation(conversationId)
      if (conversation === undefined) return
      await conversation.sendText(text)
      this.emitOutbound(conversationId, 'ack')
    })
  }

  private async resolveAttachmentContent(message: XmtpDecodedMessage): Promise<Array<{ type: 'text'; text: string } | { type: 'image'; attachment: unknown }>> {
    const sdk = this.sdk as XmtpSdk
    if (typeof sdk.isText === 'function' && sdk.isText(message) && typeof message.content === 'string') {
      return [{ type: 'text', text: message.content }]
    }
    if (typeof sdk.isRemoteAttachment === 'function' && sdk.isRemoteAttachment(message)) {
      try {
        const remote = message.content as unknown as import('./xmtp.ts').XmtpRemoteAttachment
        const res = await fetch(remote.url)
        if (!res.ok) throw new Error(`fetch ${remote.url} ${res.status}`)
        const encrypted = new Uint8Array(await res.arrayBuffer())
        const attachment = sdk.decryptAttachment(encrypted, remote)
        const mimeType: string = attachment.mimeType ?? 'image/png'
        const data: Uint8Array = attachment.content
        const filename: string | undefined = attachment.filename ?? remote.filename
        // Only image types go through the attachment store; other files become text description
        const isImage = mimeType.startsWith('image/')
        if (isImage && (this.ctx as unknown as { attachments?: unknown }).attachments) {
          try {
            const ref = await (this.ctx as unknown as { attachments: { saveImage: (i: unknown) => Promise<unknown> } }).attachments.saveImage({ data, mediaType: mimeType as never, filename })
            return [{ type: 'image', attachment: ref }]
          } catch {
            // saveImage validation failed (too large, unsupported) — fall back to text notice
          }
        }
        if (isImage) {
          // No attachment store — still deliver as text with filename hint
          return [{ type: 'text', text: `[image ${filename ?? mimeType} ${data.byteLength} bytes — attachment store unavailable]` }]
        }
        return [{ type: 'text', text: `[file ${filename ?? 'attachment'} ${mimeType} ${data.byteLength} bytes]` }]
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        return [{ type: 'text', text: `[failed to fetch remote attachment: ${msg}]` }]
      }
    }
    if (typeof sdk.isAttachment === 'function' && sdk.isAttachment(message)) {
      try {
        const att = message.content as { mimeType: string; content: Uint8Array; filename?: string }
        const mimeType = att.mimeType ?? 'application/octet-stream'
        const data = att.content
        const filename = att.filename
        const isImage = mimeType.startsWith('image/')
        if (isImage && (this.ctx as unknown as { attachments?: unknown }).attachments) {
          try {
            const ref = await (this.ctx as unknown as { attachments: { saveImage: (i: unknown) => Promise<unknown> } }).attachments.saveImage({ data, mediaType: mimeType as never, filename })
            return [{ type: 'image', attachment: ref }]
          } catch {}
        }
        return [{ type: 'text', text: `[file ${filename ?? 'attachment'} ${mimeType} ${data.byteLength} bytes]` }]
      } catch {
        return [{ type: 'text', text: '[attachment could not be decoded]' }]
      }
    }
    return [{ type: 'text', text: String(message.content ?? '') }]
  }

  /**
   * One agent per conversation, created on first message or resumed after a
   * restart (headless-runner precedent for creation). Registers the
   * conversation for observation and seeds its outbound cursor from the
   * session's current end when it has none, so attaching never replays history.
   */
  private agentFor(conversationId: string): Promise<AgentHandle> {
    const existing = this.handles.get(conversationId)
    // A pending creation is shared (inbound admission and connect-time resume
    // can race); a settled one is reused only while its agent is still live.
    if (existing !== undefined && (this.creating.has(conversationId) || this.liveAgent(conversationId) !== undefined)) {
      return existing
    }
    const selection = this.ctx.agentDefaultModel.currentSelection()
    const sessionId = this.sessionIdFor(conversationId)
    const agentOptions = { provider: selection.provider, model: selection.model }
    const setup = (agentCtx: Context) => {
      const selected: ModelSelectionRef = { current: selection, assembled: undefined }
      installModelSelection(agentCtx, selected)
    }
    // Sessions persist across restarts while this map does not: recreating an
    // agent for a known conversation resumes the persisted session instead of
    // failing on the duplicate id (api-session-controller precedent).
    const created = this.ctx.agents.create({ sessionId, meta: { cwd: process.cwd() }, agentOptions, setup })
      .catch((error: unknown) => {
        if (!/already exists/.test(String((error as { message?: unknown })?.message ?? error))) throw error
        return this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
      })
      .then(async (handle) => {
        this.conversationsBySession.set(String(sessionId), conversationId)
        // Push observation starts here; older events are cursor-seeded or caught up.
        this.observe(conversationId, handle.agent.session, Number(handle.agent.session.seq))
        if (!this.cursors.has(conversationId)) {
          this.cursors.set(conversationId, Number(handle.agent.session.seq) - 1)
          await this.persist()
        }
        return handle
      })
    this.handles.set(conversationId, created)
    this.creating.add(conversationId)
    created.then(
      () => { if (this.handles.get(conversationId) === created) this.creating.delete(conversationId) },
      () => {
        if (this.handles.get(conversationId) !== created) return
        this.creating.delete(conversationId)
        this.handles.delete(conversationId)
      },
    )
    return created
  }
}

/** Test seam: the most recently mounted channel runtime. */
export const internalChannel: { current: XmtpChannelRuntime | undefined } = { current: undefined }

/**
 * Mount the channel: start the connect loop as a disposable effect.
 * @param ctx - Plugin context.
 * @param config - Validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const channel = new XmtpChannelRuntime(ctx, config)
  internalChannel.current = channel
  ctx.effect(() => {
    void channel.start()
    return async () => {
      if (internalChannel.current === channel) internalChannel.current = undefined
      await channel.stop()
    }
  })
}
