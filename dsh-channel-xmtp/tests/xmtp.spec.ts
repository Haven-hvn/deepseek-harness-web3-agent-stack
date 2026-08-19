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
 * 4. Consent auto-allow sweep and the bounded reconnect policy.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WalletRuntime from 'dsh-wallet'
import type { CryptoAdapter, WalletKeySource } from 'dsh-wallet'
import * as channelXmtp from '../src/index.ts'
import { internals } from '../src/xmtp.ts'
import type {
  XmtpClient,
  XmtpClientOptions,
  XmtpConversation,
  XmtpDecodedMessage,
  XmtpSigner,
} from '../src/xmtp.ts'
import type { XmtpInboundEvent, XmtpStatusEvent } from '../src/types.ts'
import { MemoryCredentials } from '../../dsh-wallet/tests/helpers/memory-credentials.ts'

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

/** Scripted model recording every request. */
class MockLlmAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const text = 'agent reply'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** One recorded fake conversation. */
class FakeConversation implements XmtpConversation {
  readonly sent: string[] = []
  consent: unknown
  readonly consentUpdates: unknown[] = []

  constructor(consent: unknown) {
    this.consent = consent
  }

  async sendText(text: string): Promise<void> {
    this.sent.push(text)
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

// ── Harness ───────────────────────────────────────────────────────────────────

async function harness(config: Partial<channelXmtp.Config> = {}) {
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
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], llm)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'mock', model: 'mock' }),
  })
  const statuses: XmtpStatusEvent[] = []
  const inbounds: XmtpInboundEvent[] = []
  ctx.on('xmtp/status', event => void statuses.push(event))
  ctx.on('xmtp/inbound', event => void inbounds.push(event))
  await ctx.plugin(channelXmtp, { wallet: 'agent', env: 'dev', reconnectDelayMs: 0, ...config })
  // The connect loop runs off the mount fiber; wait for the stream to attach.
  if (world.createFailures === 0) {
    await vi.waitFor(() => { expect(world.onValue).toBeDefined() })
  }
  return { ctx, world, wallet, llm, statuses, inbounds }
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
    const { world, llm } = await harness()
    const conversation = new FakeConversation(ALLOWED)
    world.conversations.set('conv-1', conversation)

    world.onValue!(inbound())

    await vi.waitFor(() => { expect(conversation.sent).toEqual(['agent reply']) })
    // The model actually saw the user's text.
    expect(llm.requests).toHaveLength(1)
    const messages = llm.requests[0]!.messages
    const userMessage = messages.findLast(message => message.role === 'user')
    expect(JSON.stringify(userMessage?.content)).toContain('hello agent')
  })

  it('reuses one agent per conversation across messages', async () => {
    const { ctx, world } = await harness()
    const conversation = new FakeConversation(ALLOWED)
    world.conversations.set('conv-1', conversation)

    world.onValue!(inbound({ id: 'msg-a' }))
    world.onValue!(inbound({ id: 'msg-b', content: 'second' }))

    await vi.waitFor(() => { expect(conversation.sent).toHaveLength(2) })
    // One session identity for the whole conversation.
    const agent = ctx.agents.get(SessionId('xmtp-conv-1'))
    expect(agent).toBeDefined()
  })
})

// ── 4. Consent sweep and reconnect policy ─────────────────────────────────────

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
})
