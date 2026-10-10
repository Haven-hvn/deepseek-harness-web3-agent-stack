/**
 * Seam proofs for dsh-channel-xmtp:
 *
 * 1. IDENTITY THROUGH THE WALLET SEAM — the XMTP signer holds no key: every
 *    `signMessage` call is one `ctx.wallet` operation (credential resolved at
 *    that boundary, fresh per signature) and the returned bytes are the hex
 *    signature decoded.
 * 2. Haven's inbound filter contract survives: text-only, own-message skip,
 *    active-conversation restriction, dedup by message id.
 * 3. THE ROUND TRIP — inbound XMTP text reaches a real agent (the mock model
 *    records it) and the assistant's reply lands back in the SAME
 *    conversation via `sendText`.
 * 4. THE SESSION OBSERVER — output of turns the channel did NOT start
 *    (background-job wakes, schedules) reaches XMTP; inbound never waits on
 *    a turn; a mid-turn inbound is acked; each reply pairs with the turn
 *    that produced it; empty turns stay silent; nothing sends twice.
 * 5. Exactly-once across restarts: inbound outbox + outbound cursor.
 * 6. Consent auto-allow sweep and the bounded reconnect policy.
 * 7. WEDGED SENDS FAIL LOUD — a stuck send-tail task rejects after the
 *    deliver bound, and rejections clear the per-conversation tail so later
 *    flushes still run instead of wedging behind a corpse.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WalletRuntime from 'dsh-wallet'
import type { CryptoAdapter, WalletKeySource } from 'dsh-wallet'
import * as channelXmtp from '../src/index.ts'
import { deliveryPolicy, DELIVER_TIMEOUT_MS } from '../src/index.ts'
import { internals } from '../src/xmtp.ts'
import type {
  XmtpClient,
  XmtpClientOptions,
  XmtpConversation,
  XmtpDecodedMessage,
  XmtpSigner,
} from '../src/xmtp.ts'
import type { XmtpInboundEvent, XmtpOutboundEvent, XmtpStatusEvent } from '../src/types.ts'
import { MemoryCredentials } from '../../dsh-wallet/tests/helpers/memory-credentials.ts'

// A non-user message source, standing in for tool-jobs / schedule wakes (dsh-acp test precedent).
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'xmtp-test-wake': { kind: 'xmtp-test-wake' } & ContextFormed
  }
}

// ── Fakes ─────────────────────────────────────────────────────────────────────

/** Recording fake signer provider behind the wallet seam. */
class FakeWalletAdapter implements CryptoAdapter {
  readonly loadKeyCalls: WalletKeySource[] = []
  readonly signedPayloads: string[] = []

  async loadKey(source: WalletKeySource): Promise<{ address: string; keyMaterial: unknown }> {
    this.loadKeyCalls.push(source)
    return { address: '0xAbCd', keyMaterial: {} }
  }

  async signMessage(_material: unknown, payload: string): Promise<string> {
    this.signedPayloads.push(payload)
    // Two deterministic bytes so the hex→bytes bridge is checkable.
    return '0xbeef'
  }

  async signTransaction(): Promise<string> {
    throw new Error('the channel never signs transactions')
  }
}

/** One scripted model response: plain text (`''` = no text), or text released by a gate. */
type ScriptStep = string | { text: string; gate: Promise<void> }

/** A gate a test opens to let a "long" turn finish. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>((resolve) => { open = resolve })
  return { promise, open }
}

/** Scripted model recording every request; unscripted requests answer `agent reply`. */
class MockLlmAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  readonly script: ScriptStep[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const step = this.script.shift() ?? 'agent reply'
    let text: string
    if (typeof step === 'string') {
      text = step
    } else {
      await step.gate
      text = step.text
    }
    if (text !== '') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** One recorded fake conversation; each send returns a fresh id. */
class FakeConversation implements XmtpConversation {
  readonly sent: string[] = []
  consent: unknown
  readonly consentUpdates: unknown[] = []

  constructor(consent: unknown) {
    this.consent = consent
  }

  async sendText(text: string): Promise<string> {
    this.sent.push(text)
    return `sent-${this.sent.length}`
  }

  consentState(): unknown {
    return this.consent
  }

  updateConsentState(state: unknown): void {
    this.consentUpdates.push(state)
    this.consent = state
  }
}

const ALLOWED = 'consent:allowed'
const UNKNOWN = 'consent:unknown'
const ETH_KIND = 'identifier:ethereum'
const ACK = 'still working'

/** The whole fake XMTP world one test drives. */
interface FakeWorld {
  signer: XmtpSigner | undefined
  clientOptions: XmtpClientOptions | undefined
  conversations: Map<string, FakeConversation>
  onValue: ((message: XmtpDecodedMessage) => void) | undefined
  onError: ((error: Error) => void) | undefined
  createFailures: number
  streamEnds: number
}

/** Install a scripted SDK on the test seam and return its world. */
function fakeSdk(): FakeWorld {
  const world: FakeWorld = {
    signer: undefined,
    clientOptions: undefined,
    conversations: new Map(),
    onValue: undefined,
    onError: undefined,
    createFailures: 0,
    streamEnds: 0,
  }
  internals.sdk = {
    async createClient(signer, options) {
      if (world.createFailures > 0) {
        world.createFailures -= 1
        throw new Error('scripted create failure')
      }
      world.signer = signer
      world.clientOptions = options
      const client: XmtpClient = {
        inboxId: 'own-inbox',
        conversations: {
          async sync() {},
          async list() {
            return [...world.conversations.values()]
          },
          async getConversationById(id) {
            return world.conversations.get(id)
          },
          async streamAllMessages({ onValue, onError }) {
            world.onValue = onValue
            world.onError = onError
            return { end: async () => { world.streamEnds += 1 } }
          },
        },
      }
      return client
    },
    isText: message => typeof message.content === 'string' && !message.id.startsWith('nontext'),
    isRemoteAttachment: () => false,
    isAttachment: () => false,
    decryptAttachment: () => { throw new Error('no attachments in these tests') },
    ethereumIdentifierKind: ETH_KIND,
    consentAllowed: ALLOWED,
    consentUnknown: UNKNOWN,
  }
  return world
}

/** One inbound message with overridable identity fields. */
function inbound(overrides: Partial<XmtpDecodedMessage> = {}): XmtpDecodedMessage {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    senderInboxId: 'peer-inbox',
    content: 'hello agent',
    sentAt: new Date(1_700_000_000_000),
    ...overrides,
  }
}

/** A turn started by something other than XMTP (what a tool-jobs completion wake does). */
function wake(agent: Agent, text = 'background job finished'): void {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'xmtp-test-wake' },
  }))
}

/** Let stray async work land before asserting that nothing happened. */
const settle = (ms = 100) => new Promise(done => setTimeout(done, ms))

// ── Harness ───────────────────────────────────────────────────────────────────

async function harness(config: Partial<channelXmtp.Config> = {}, options: { sessionQuery?: boolean } = {}) {
  const world = fakeSdk()
  const wallet = new FakeWalletAdapter()
  const llm = new MockLlmAdapter()
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials, { AGENT_WALLET_PASSPHRASE: 'hunter2' })
  await ctx.plugin(WalletRuntime, {
    wallets: { agent: { chain: 'evm', wallet: 'agent-main', keyRef: 'AGENT_WALLET_PASSPHRASE' } },
  })
  ctx.wallet.register('evm', wallet)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], llm)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'mock', model: 'mock' }),
  })
  // Stand-in for dsh-session-query's observeSession (dsh-base mounts the real
  // one): the channel reads it only to catch up events older than its live
  // observation, i.e. after a restart.
  const catchUpReads: string[] = []
  if (options.sessionQuery !== false) ctx.provide('sessionQuery' as never, {
    observeSession: async (sessionId: SessionId) => {
      catchUpReads.push(String(sessionId))
      const live = ctx.agents.get(sessionId)
      if (live === undefined) throw new Error(`no session ${sessionId}`)
      return { events: live.session.snapshotEvents(), [Symbol.dispose]: () => {} }
    },
  } as never)
  const statuses: XmtpStatusEvent[] = []
  const inbounds: XmtpInboundEvent[] = []
  const outbounds: XmtpOutboundEvent[] = []
  ctx.on('xmtp/status', event => void statuses.push(event))
  ctx.on('xmtp/inbound', event => void inbounds.push(event))
  ctx.on('xmtp/outbound', event => void outbounds.push(event))
  // Ack disabled by default so send lists stay exact; ack tests opt in.
  await ctx.plugin(channelXmtp, { wallet: 'agent', env: 'dev', reconnectDelayMs: 0, busyAck: '', ...config })
  // The connect loop runs off the mount fiber; wait for the stream to attach.
  if (world.createFailures === 0) {
    await vi.waitFor(() => { expect(world.onValue).toBeDefined() })
  }
  const conversation = new FakeConversation(ALLOWED)
  world.conversations.set('conv-1', conversation)
  const agent = async (): Promise<Agent> => {
    let found: Agent | undefined
    await vi.waitFor(() => {
      found = ctx.agents.get(SessionId('xmtp-conv-1'))
      expect(found).toBeDefined()
    })
    return found!
  }
  return { ctx, world, wallet, llm, statuses, inbounds, outbounds, conversation, agent, catchUpReads }
}

/** The mounted runtime's private state, for restart simulation. */
function runtime(): any {
  return channelXmtp.internalChannel.current as any
}

afterEach(() => {
  internals.sdk = undefined
})

// ── 1. Identity through the wallet seam ───────────────────────────────────────

describe('the XMTP signer is the wallet seam', () => {
  it('presents the lowercase address with the Ethereum identifier kind', async () => {
    const { world } = await harness()
    expect(world.signer?.type).toBe('EOA')
    expect(world.signer?.getIdentifier()).toEqual({ identifier: '0xabcd', identifierKind: ETH_KIND })
  })

  it('each signature request is one wallet operation — key resolved per call, bytes decoded from hex', async () => {
    const { world, wallet } = await harness()
    const connectLoads = wallet.loadKeyCalls.length // address derivation at connect

    const first = await world.signer!.signMessage('xmtp-challenge-1')
    const second = await world.signer!.signMessage('xmtp-challenge-2')

    expect(wallet.signedPayloads).toEqual(['xmtp-challenge-1', 'xmtp-challenge-2'])
    // One fresh resolve→load per signature; nothing cached from connect.
    expect(wallet.loadKeyCalls.length).toBe(connectLoads + 2)
    expect(wallet.loadKeyCalls.at(-1)).toMatchObject({ wallet: 'agent-main', chain: 'evm', secret: 'hunter2' })
    expect([...first]).toEqual([0xbe, 0xef])
    expect([...second]).toEqual([0xbe, 0xef])
  })
})

// ── 2. Inbound filters ────────────────────────────────────────────────────────

describe('inbound filters (Haven contract)', () => {
  it('accepts text once and dedups repeats by message id', async () => {
    const { world, inbounds } = await harness()
    world.onValue!(inbound())
    world.onValue!(inbound()) // same id again
    expect(inbounds).toHaveLength(1)
    expect(inbounds[0]).toEqual({
      messageId: 'msg-1',
      conversationId: 'conv-1',
      senderInboxId: 'peer-inbox',
      sentAtMs: 1_700_000_000_000,
    })
  })

  it('skips non-text, own messages, and foreign conversations when restricted', async () => {
    const { world, inbounds } = await harness({ activeConversationId: 'conv-1' })
    world.onValue!(inbound({ id: 'nontext-1' })) // isText false
    world.onValue!(inbound({ id: 'msg-2', senderInboxId: 'own-inbox' })) // own echo
    world.onValue!(inbound({ id: 'msg-3', conversationId: 'conv-other' })) // foreign conversation
    world.onValue!(inbound({ id: 'msg-4', content: 42 })) // non-string content
    expect(inbounds).toEqual([])
  })
})

// ── 3. The agent round trip ───────────────────────────────────────────────────

describe('direct agent↔user round trip', () => {
  it('routes inbound text to a real agent and sends the reply back to the same conversation', async () => {
    const { world, llm, conversation, outbounds } = await harness()

    world.onValue!(inbound())

    await vi.waitFor(() => { expect(conversation.sent).toEqual(['agent reply']) })
    // The model actually saw the user's text.
    expect(llm.requests).toHaveLength(1)
    const messages = llm.requests[0]!.messages
    const userMessage = messages.findLast(message => message.role === 'user')
    expect(JSON.stringify(userMessage?.content)).toContain('hello agent')
    expect(outbounds).toEqual([{ conversationId: 'conv-1', kind: 'reply', turn: expect.any(Number), inboundMessageId: 'msg-1' }])
  })

  it('reuses one agent per conversation and answers each message once, in order', async () => {
    const { world, llm, conversation, agent } = await harness()
    llm.script.push('first answer', 'second answer')

    world.onValue!(inbound({ id: 'msg-a' }))
    world.onValue!(inbound({ id: 'msg-b', content: 'second' }))

    await vi.waitFor(() => { expect(conversation.sent).toEqual(['first answer', 'second answer']) })
    expect((await agent()).session.id).toBe(SessionId('xmtp-conv-1'))
    await settle()
    expect(conversation.sent).toHaveLength(2) // no double send at idle
  })

  it('sends the inbound to the model as a user-sourced message (wake budget refill contract)', async () => {
    const { world, conversation, agent } = await harness()
    world.onValue!(inbound())
    await vi.waitFor(() => { expect(conversation.sent).toHaveLength(1) })
    const users = (await agent()).session.snapshotEvents().filter(event => event.type === 'user/message')
    expect(users.map(event => (event.data as { source: { kind: string } }).source.kind)).toEqual(['user'])
  })
})

// ── 4. The session observer ───────────────────────────────────────────────────

describe('proactive send (session observer)', () => {
  it('sends output of a turn the channel did not start, with no new inbound', async () => {
    const { world, llm, conversation, outbounds, agent } = await harness()
    llm.script.push('hi', 'your job is done')
    world.onValue!(inbound())
    await vi.waitFor(() => { expect(conversation.sent).toEqual(['hi']) })

    wake(await agent())

    await vi.waitFor(() => { expect(conversation.sent).toEqual(['hi', 'your job is done']) })
    expect(outbounds.map(event => event.kind)).toEqual(['reply', 'proactive'])
    expect(outbounds[1]).not.toHaveProperty('inboundMessageId')
  })

  it('keeps an empty woken turn silent (silence convention)', async () => {
    const { world, llm, conversation, agent } = await harness()
    llm.script.push('hi', '')
    world.onValue!(inbound())
    await vi.waitFor(() => { expect(conversation.sent).toEqual(['hi']) })

    const subject = await agent()
    wake(subject)
    await vi.waitFor(() => { expect(llm.requests).toHaveLength(2) })
    await subject.whenIdle()
    await settle()
    expect(conversation.sent).toEqual(['hi'])
  })

  it('a woken turn queued behind a user turn does not replace the user reply', async () => {
    const { world, llm, conversation, outbounds, agent } = await harness()
    const slow = gate()
    llm.script.push({ text: 'user answer', gate: slow.promise }, 'woken answer')
    world.onValue!(inbound())
    const subject = await agent()
    await vi.waitFor(() => { expect(llm.requests).toHaveLength(1) })

    wake(subject) // queues behind the running user turn
    slow.open()

    await vi.waitFor(() => { expect(conversation.sent).toEqual(['user answer', 'woken answer']) })
    expect(outbounds.map(event => [event.kind, event.inboundMessageId])).toEqual([
      ['reply', 'msg-1'],
      ['proactive', undefined],
    ])
  })
})

describe('busy inbound (never waits on a turn)', () => {
  it('acks a mid-turn inbound immediately, once, then answers each in its own turn', async () => {
    const { world, llm, conversation, outbounds, inbounds } = await harness({ busyAck: ACK })
    const slow = gate()
    llm.script.push({ text: 'first answer', gate: slow.promise }, 'second answer')

    world.onValue!(inbound({ id: 'msg-1' }))
    await vi.waitFor(() => { expect(llm.requests).toHaveLength(1) })
    world.onValue!(inbound({ id: 'msg-2', content: 'status?' }))
    world.onValue!(inbound({ id: 'msg-3', content: 'hello??' }))

    // The ack lands while the first turn is still running — one per running interval.
    await vi.waitFor(() => { expect(conversation.sent).toEqual([ACK]) })
    await settle()
    expect(conversation.sent).toEqual([ACK])

    slow.open()
    await vi.waitFor(() => { expect(conversation.sent).toEqual([ACK, 'first answer', 'second answer', 'agent reply']) })
    expect(outbounds.map(event => [event.kind, event.inboundMessageId])).toEqual([
      ['ack', undefined],
      ['reply', 'msg-1'],
      ['reply', 'msg-2'],
      ['reply', 'msg-3'],
    ])
    // Former `dsh-channel-xmtp/invariant` companion (dsh 0.2.1 removed the
    // invariant service): one non-empty xmtp/inbound per message id.
    world.onValue!(inbound({ id: 'msg-2', content: 'status?' })) // redelivery
    const ids = inbounds.map(event => event.messageId)
    expect(ids.every(id => id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(['msg-1', 'msg-2', 'msg-3'])
  })

  it('does not ack an inbound that reaches an idle agent', async () => {
    const { world, conversation } = await harness({ busyAck: ACK })
    world.onValue!(inbound())
    await vi.waitFor(() => { expect(conversation.sent).toEqual(['agent reply']) })
  })
})

describe('replyMode: message', () => {
  it('sends each assistant message once as it commits (no repeat at turn close)', async () => {
    const { world, conversation, agent } = await harness({ replyMode: 'message' })
    world.onValue!(inbound())
    await vi.waitFor(() => { expect(conversation.sent).toEqual(['agent reply']) })
    await (await agent()).whenIdle()
    await settle()
    expect(conversation.sent).toEqual(['agent reply'])
  })
})

// ── 5. Exactly-once across restarts ───────────────────────────────────────────

describe('exactly-once across restarts', () => {
  async function tempDir() {
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'xmtp-outbox-'))
    return { path: join(dir, 'outbox.json'), cleanup: () => rm(dir, { recursive: true, force: true }) }
  }

  async function readState(path: string) {
    const { readFile } = await import('node:fs/promises')
    return JSON.parse(await readFile(path, 'utf8')) as { version: number; entries: Array<[string, string]>; cursors: Array<[string, number]> }
  }

  /** Drop all in-memory channel state, then reload it from disk (a process restart). */
  async function restart() {
    const channel = runtime()
    channel.seen.clear()
    channel.outbox.clear()
    channel.cursors.clear()
    // A new process has observed no events live: older ones need catch-up.
    channel.observed.clear()
    await channel.loadOutbox()
  }

  it('answers a redelivered inbound once and persists outbox + cursor', async () => {
    const tmp = await tempDir()
    try {
      const { world, llm, inbounds, conversation, agent } = await harness({ outboxPath: tmp.path })

      world.onValue!(inbound())
      await vi.waitFor(() => { expect(conversation.sent).toEqual(['agent reply']) })
      expect(inbounds).toHaveLength(1)

      const events = (await agent()).session.snapshotEvents()
      const lastTurnEnd = Number(events.findLast(event => event.type === 'turn/end')!.seq)
      await vi.waitFor(async () => {
        const state = await readState(tmp.path)
        expect(state.version).toBe(2)
        expect(state.entries).toEqual([['conv-1\nmsg-1', 'sent-1']])
        // turn mode: the cursor rests on the closed turn it sent
        expect(state.cursors).toEqual([['conv-1', lastTurnEnd]])
      })

      await restart()
      world.onValue!(inbound()) // same inbound redelivered
      await settle()
      expect(inbounds).toHaveLength(1) // skipped before emit — the agent never re-ran
      expect(llm.requests).toHaveLength(1)
      expect(conversation.sent).toEqual(['agent reply'])
    } finally {
      await tmp.cleanup()
    }
  })

  it('a restart never re-sends output already sent', async () => {
    const tmp = await tempDir()
    try {
      const { world, conversation } = await harness({ outboxPath: tmp.path })
      world.onValue!(inbound())
      await vi.waitFor(() => { expect(conversation.sent).toEqual(['agent reply']) })
      await vi.waitFor(async () => { expect((await readState(tmp.path)).cursors).toHaveLength(1) })

      await restart()
      runtime().scheduleFlush('conv-1')
      await settle()
      expect(conversation.sent).toEqual(['agent reply'])
    } finally {
      await tmp.cleanup()
    }
  })

  it('a restart sends output committed but not sent before the crash (sessionQuery catch-up)', async () => {
    const tmp = await tempDir()
    try {
      const { world, conversation, agent, catchUpReads } = await harness({ outboxPath: tmp.path })
      world.onValue!(inbound())
      await vi.waitFor(() => { expect(conversation.sent).toEqual(['agent reply']) })
      const subject = await agent()

      // Crash between commit and send: the persisted cursor predates the turn.
      const channel = runtime()
      channel.cursors.set('conv-1', -1)
      await channel.persist()
      await subject.whenIdle()

      await restart()
      channel.scheduleFlush('conv-1')
      await vi.waitFor(() => { expect(conversation.sent).toEqual(['agent reply', 'agent reply']) })
      await settle()
      expect(conversation.sent).toHaveLength(2) // exactly one catch-up send
      expect(catchUpReads).toEqual(['xmtp-conv-1']) // the gap came from sessionQuery, once
    } finally {
      await tmp.cleanup()
    }
  })

  it('without sessionQuery a restart gap is skipped, never replayed', async () => {
    const tmp = await tempDir()
    try {
      const { world, conversation, agent } = await harness({ outboxPath: tmp.path }, { sessionQuery: false })
      world.onValue!(inbound())
      await vi.waitFor(() => { expect(conversation.sent).toEqual(['agent reply']) })
      await (await agent()).whenIdle()

      const channel = runtime()
      await restart()
      channel.cursors.set('conv-1', -1) // cursor predates everything this process observed
      channel.scheduleFlush('conv-1')
      await settle()
      expect(conversation.sent).toEqual(['agent reply'])
      expect(channel.cursors.get('conv-1')).toBeGreaterThan(-1) // jumped to the live edge
    } finally {
      await tmp.cleanup()
    }
  })

  it('stays memory-only without outboxPath: a restart re-answers (documented)', async () => {
    const { world, llm, conversation } = await harness()

    world.onValue!(inbound())
    await vi.waitFor(() => { expect(conversation.sent).toEqual(['agent reply']) })

    const channel = runtime()
    expect(channel.outbox.size).toBe(1) // recorded in memory all the same
    channel.seen.clear()
    channel.outbox.clear()

    world.onValue!(inbound())
    await vi.waitFor(() => { expect(conversation.sent).toEqual(['agent reply', 'agent reply']) })
    expect(llm.requests).toHaveLength(2)
  })

  it('reads a version-1 outbox and seeds cursors without replaying history', async () => {
    const tmp = await tempDir()
    try {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(tmp.path, JSON.stringify({ version: 1, entries: [['conv-1\nold-msg', 'sent']] }))
      const { world, inbounds, conversation } = await harness({ outboxPath: tmp.path })
      world.onValue!(inbound({ id: 'old-msg' }))
      await settle()
      expect(inbounds).toEqual([]) // v1 entries still dedup
      world.onValue!(inbound({ id: 'new-msg' }))
      await vi.waitFor(() => { expect(conversation.sent).toEqual(['agent reply']) })
    } finally {
      await tmp.cleanup()
    }
  })
})

// ── 6. Consent sweep and reconnect policy ─────────────────────────────────────

describe('consent auto-allow sweep', () => {
  it('flips non-allowed conversations to allowed at connect', async () => {
    const world = fakeSdk()
    const pending = new FakeConversation(UNKNOWN)
    const already = new FakeConversation(ALLOWED)
    world.conversations.set('conv-pending', pending)
    world.conversations.set('conv-allowed', already)

    await harnessWithWorld(world)

    expect(pending.consentUpdates).toEqual([ALLOWED])
    expect(already.consentUpdates).toEqual([])
  })

  /** Same harness but over a pre-seeded world (fakeSdk already installed). */
  async function harnessWithWorld(world: FakeWorld) {
    const ctx = new Context()
    await ctx.plugin(MemoryCredentials, { AGENT_WALLET_PASSPHRASE: 'hunter2' })
    await ctx.plugin(WalletRuntime, {
      wallets: { agent: { chain: 'evm', wallet: 'agent-main', keyRef: 'AGENT_WALLET_PASSPHRASE' } },
    })
    ctx.wallet.register('evm', new FakeWalletAdapter())
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], new MockLlmAdapter())
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
    await ctx.plugin(channelXmtp, { wallet: 'agent', env: 'dev', reconnectDelayMs: 0 })
    await vi.waitFor(() => { expect(world.onValue).toBeDefined() })
    return ctx
  }
})

describe('reconnect policy', () => {
  it('a stream error reconnects and re-attaches the stream', async () => {
    const { world, statuses } = await harness()
    const attachesBefore = world.streamEnds

    world.onError!(new Error('stream dropped'))

    await vi.waitFor(() => {
      expect(statuses.map(status => status.status)).toContain('reconnecting')
    })
    await vi.waitFor(() => {
      expect(statuses.filter(status => status.status === 'connected')).toHaveLength(2)
    })
    expect(world.streamEnds).toBeGreaterThan(attachesBefore) // old stream released
  })

  it('gives up after the attempt cap and reports disconnected', async () => {
    const { world, statuses } = await harness({ maxReconnectAttempts: 1 })
    world.createFailures = 5 // every future connect fails

    world.onError!(new Error('stream dropped'))

    await vi.waitFor(() => {
      const last = statuses.at(-1)
      expect(last?.status).toBe('disconnected')
      expect(last?.reason).toContain('reconnect attempts exhausted')
    })
  })

  it('a send that fails while disconnected is retried after reconnect', async () => {
    const { world, conversation, agent } = await harness()
    world.onValue!(inbound())
    await vi.waitFor(() => { expect(conversation.sent).toEqual(['agent reply']) })
    const subject = await agent()

    const channel = runtime()
    const client = channel.client
    channel.client = undefined // offline: the next flush cannot send
    wake(subject)
    await subject.whenIdle()
    await settle()
    expect(conversation.sent).toEqual(['agent reply'])

    channel.client = client // back online; the sweep/idle/event triggers retry
    channel.scheduleFlush('conv-1')
    await vi.waitFor(() => { expect(conversation.sent).toEqual(['agent reply', 'agent reply']) })
  })
})

// ── Replies leave as plain chat text, never raw markdown ────────────────

describe('toPlainText (Convos renders the XMTP text codec literally)', () => {
  const { toPlainText } = channelXmtp

  it('folds the sweep reply into clean chat lines', () => {
    expect(toPlainText(
      '*Sweep complete.*\n\n'
      + '- *Router:* 0x12F65677d698C75eC5443f2B92f9BBAD331762b4\n'
      + '- *Tx hash:* 0x1dcd611035c187cc685627924ec2b1c41396d38a7a94f2b092da8e74ea237951\n'
      + '- *Status:* success\n\n'
      + 'Check [balances](https://example.com/b) or run `get_balances`.',
    )).toBe(
      'Sweep complete.\n\n'
      + '- Router: 0x12F65677d698C75eC5443f2B92f9BBAD331762b4\n'
      + '- Tx hash: 0x1dcd611035c187cc685627924ec2b1c41396d38a7a94f2b092da8e74ea237951\n'
      + '- Status: success\n\n'
      + 'Check balances: https://example.com/b or run get_balances.',
    )
  })

  it('unwraps bold, headings, quotes, rules, and fences; protects URLs and hashes', () => {
    expect(toPlainText('## Balances\n**total** __5__ `USD`')).toBe('Balances\ntotal 5 USD')
    expect(toPlainText('> quoted\n\n---\nnext')).toBe('quoted\n\nnext')
    expect(toPlainText('```js\nconst x = 2 * 3\n```')).toBe('const x = 2 * 3')
    expect(toPlainText('see https://a.b/c*d and 0xabc*def')).toBe('see https://a.b/c*d and 0xabc*def')
  })

  it('leaves unpaired markers, lists, and plain text alone; never swallows a reply', () => {
    expect(toPlainText('2 * 3 = 6 and a_b')).toBe('2 * 3 = 6 and a_b')
    expect(toPlainText('- one\n1. two\n\nplain')).toBe('- one\n1. two\n\nplain')
    expect(toPlainText('agent reply')).toBe('agent reply')
    expect(toPlainText('---')).toBe('---')
  })
})

// ── 7. Wedged sends fail loud, never silent ─────────────────────────────────

/** A conversation whose first send hangs forever, then behaves. */
class HangingOnceConversation extends FakeConversation {
  private hung = false

  override async sendText(text: string): Promise<string> {
    if (!this.hung) {
      this.hung = true
      await new Promise<never>(() => {})
    }
    return super.sendText(text)
  }
}

/** A conversation whose first send throws, then behaves. */
class FlakyOnceConversation extends FakeConversation {
  private failed = false

  override async sendText(text: string): Promise<string> {
    if (!this.failed) {
      this.failed = true
      throw new Error('scripted send failure')
    }
    return super.sendText(text)
  }
}

describe('deliver timeout (a stuck send must not wedge its conversation)', () => {
  it('a hung send rejects after the bound and the next message still runs', async () => {
    deliveryPolicy.timeoutMs = 200
    try {
      const { world } = await harness()
      const conversation = new HangingOnceConversation(ALLOWED)
      world.conversations.set('conv-1', conversation)

      world.onValue!(inbound({ id: 'msg-a' }))
      // Wait for the 200ms timeout to fire and the send tail to clear.
      await new Promise(resolve => setTimeout(resolve, 500))
      // The hung first send never completed; this second message's reply is the only one.
      world.onValue!(inbound({ id: 'msg-b', content: 'second' }))
      await vi.waitFor(() => { expect(conversation.sent).toHaveLength(1) }, { timeout: 10_000 })
      expect(conversation.sent).toEqual(['agent reply'])
    } finally {
      deliveryPolicy.timeoutMs = DELIVER_TIMEOUT_MS
    }
  })

  it('a rejected send clears the tail so later messages run', async () => {
    const { world } = await harness()
    const conversation = new FlakyOnceConversation(ALLOWED)
    world.conversations.set('conv-1', conversation)

    world.onValue!(inbound({ id: 'msg-a' }))
    world.onValue!(inbound({ id: 'msg-b', content: 'second' }))

    // Without tail cleanup on rejection, msg-b would stall behind the
    // failed msg-a send and nothing would ever arrive. The failed flush
    // retries from its cursor (at-least-once), so msg-a's reply lands on
    // retry and msg-b's follows: both arrive, nothing wedges.
    await vi.waitFor(() => { expect(conversation.sent).toHaveLength(2) }, { timeout: 10_000 })
    expect(conversation.sent).toEqual(['agent reply', 'agent reply'])
  })
})
