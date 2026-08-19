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
 *   deterministic session id), inbound text enters via `agent.followup`, and
 *   the assistant's reply text returns through `conversation.sendText`.
 * - **State machine → plugin lifecycle.** Haven's
 *   Disconnected/Connecting/Connected/Reconnecting machine becomes a plain
 *   reconnect loop with the same policy (attempt cap, fixed delay), reported
 *   through `xmtp/status` events; disposal is the plugin effect.
 * - Preserved verbatim: text-only + own-message + active-conversation
 *   filters, dedup set (cap 5000, prune to half), consent auto-allow sweep
 *   every 15s.
 *
 * @module dsh-channel-xmtp
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { AgentHandle, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: carries the `ctx.wallet` Context declaration.
import type {} from 'dsh-wallet'
import { hexToBytes, loadXmtpSdk } from './xmtp.ts'
import type { XmtpClient, XmtpDecodedMessage, XmtpSdk, XmtpSigner, XmtpStream } from './xmtp.ts'
import type { XmtpChannelStatus } from './types.ts'
// Type-only: carries the `xmtp/inbound` and `xmtp/status` event declarations.
import type {} from './types.ts'

export type { XmtpChannelStatus, XmtpInboundEvent, XmtpStatusEvent } from './types.ts'
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
})

/** Join the last assistant text appended at or after `firstSeq` (headless-runner `summarize` port). */
function lastAssistantText(events: readonly SessionEvent[], firstSeq: number): string {
  let text = ''
  for (const event of events) {
    if (event.seq < firstSeq || event.type !== 'assistant/message') continue
    const joined = event.data.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    if (joined !== '') text = joined
  }
  return text
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
  /** One live agent handle per conversation. */
  private readonly agents = new Map<string, Promise<AgentHandle>>()
  /** Per-conversation delivery chains: replies pair with their inbound in order. */
  private readonly deliveries = new Map<string, Promise<void>>()

  constructor(private readonly ctx: Context, private readonly config: Config) {}

  /** Enter the connect loop; never throws (failures feed the reconnect policy). */
  async start(): Promise<void> {
    this.setStatus('connecting', 'starting')
    await this.connect()
  }

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
    for (const pending of this.agents.values()) {
      await pending.then(handle => handle.dispose()).catch(() => undefined)
    }
    this.agents.clear()
    this.setStatus('disconnected', 'stopped')
  }

  private setStatus(status: XmtpChannelStatus, reason: string): void {
    if (this.status === status) return
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
      }, CONSENT_SWEEP_INTERVAL_MS)
      this.setStatus('connected', `connected as ${address.toLowerCase()}`)
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
      for (const conversation of conversations) {
        try {
          if (conversation.consentState() !== sdk.consentAllowed) {
            await conversation.updateConsentState(sdk.consentAllowed)
          }
        } catch {
          // One conversation's consent failure never blocks the sweep.
        }
      }
    } catch {
      // Sweep failures are transient; the next interval retries.
    }
  }

  /** Haven's inbound filter order: text → own → active-conversation → dedup. */
  private onMessage(message: XmtpDecodedMessage): void {
    if (this.stopped || this.sdk === undefined) return
    if (!this.sdk.isText(message) || typeof message.content !== 'string') return
    if (message.senderInboxId === this.client?.inboxId) return
    if (this.config.activeConversationId !== undefined
      && message.conversationId !== this.config.activeConversationId) return
    if (this.seen.has(message.id)) return
    this.seen.add(message.id)
    if (this.seen.size > MAX_DEDUP_SIZE) {
      // Ported policy: prune the oldest half (Sets iterate in insertion order).
      for (const id of this.seen) {
        if (this.seen.size <= MAX_DEDUP_SIZE / 2) break
        this.seen.delete(id)
      }
    }
    this.ctx.emit('xmtp/inbound', {
      messageId: message.id,
      conversationId: message.conversationId,
      senderInboxId: message.senderInboxId,
      sentAtMs: message.sentAt.getTime(),
    })
    const chain = this.deliveries.get(message.conversationId) ?? Promise.resolve()
    this.deliveries.set(message.conversationId, chain
      .then(() => this.deliver(message.conversationId, message.content as string))
      .catch(() => undefined))
  }

  /** Route one inbound text through the conversation's agent and send the reply back. */
  private async deliver(conversationId: string, text: string): Promise<void> {
    const agent = (await this.agentFor(conversationId)).agent
    await agent.whenIdle()
    const firstSeq = agent.session.seq
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    if (this.stopped) return
    const reply = lastAssistantText(agent.session.events, firstSeq)
    if (reply === '') return
    const conversation = await this.client?.conversations.getConversationById(conversationId)
    await conversation?.sendText(reply)
  }

  /** One agent per conversation, created on first message (headless-runner precedent). */
  private agentFor(conversationId: string): Promise<AgentHandle> {
    const existing = this.agents.get(conversationId)
    if (existing !== undefined) return existing
    const selection = this.ctx.agentDefaultModel.currentSelection()
    const created = this.ctx.agents.create({
      sessionId: SessionId(`${this.config.channelName ?? 'xmtp'}-${conversationId}`),
      meta: { cwd: process.cwd() },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx: Context) => {
        const selected: ModelSelectionRef = { current: selection, assembled: undefined }
        installModelSelection(agentCtx, selected)
      },
    })
    this.agents.set(conversationId, created)
    created.catch(() => this.agents.delete(conversationId))
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
