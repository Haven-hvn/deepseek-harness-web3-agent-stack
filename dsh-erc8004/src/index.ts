/**
 * ERC-8004 Identity Registry for DSH — ctx.erc8004 + erc8004_* tools.
 *
 * Two-plane port of the Filecoin Pin + ERC-8004 tutorial (docs.filecoin.io):
 * - Filecoin Pin: agent card JSON → IPFS CID (PDP proofs) via ctx.synapse (dsh-storage-synapse, USDFC)
 * - ERC-8004: register(string tokenURI) on Ethereum Sepolia 0x8004A818BFB912233c491871b3d84c89A494BD9e via wallet-gated signing
 *
 * Isolated bundle, coupled at seams:
 * - Injects wallet (signer identity) + tools + optional treasury/synapse/credentials — never stores a raw key.
 * - Filecoin: delegated entirely to ctx.synapse (its own per-operation gated credential) — no privateKey in this package.
 * - Ethereum Sepolia: viem publicClient + custom toAccount delegating signTransaction/signMessage to ctx.wallet (OWS vault), treasury authorize/recordExpense.
 *
 * @module dsh-erc8004
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
// Type-only: the read-back hook contract (runtime access to the guard stays
// optional via `ctx.reflect.get`, so this plugin mounts cleanly unguarded).
import type { CheckContext, CheckDecision } from 'dsh-exactly-once'
import { buildDefaultCard, Erc8004Backend, ERC8004_ABI, type AgentCard } from './erc8004.ts'
import type { Erc8004CardStoredEvent, Erc8004RegisteredEvent } from './types.ts'

export type { AgentCard } from './erc8004.ts'
export type { Erc8004CardStoredEvent, Erc8004RegisteredEvent } from './types.ts'

export const name = 'erc8004'
export const inject = ['wallet', 'tools'] as const

/** Test seam: bounds the register receipt wait (production: two minutes). */
export const internals = { receiptTimeoutMs: 120_000 }

/** One registration attempt, from first broadcast to mined. */
interface AttemptRecord {
  readonly tokenUri: string
  readonly cid: string
  txHash: `0x${string}` | undefined
  agentId: string | undefined
  pieceCid: string | undefined
  state: 'broadcast' | 'mined' | 'reverted'
}

/** Attempt key for one deterministic card build (filename shades the tokenUri). */
function cardKeyFor(card: AgentCard, filename: string): string {
  return `card:${createHash('sha256').update(`${filename}\n${JSON.stringify(card)}`).digest('hex')}`
}

/** Root CID out of an `ipfs://<cid>/...` tokenUri (same derivation as the tool). */
function cidFromTokenUri(tokenUri: string): string {
  return tokenUri.replace('ipfs://', '').split('/')[0] ?? ''
}

/** Whether an RPC failure means "unknown transaction" rather than node trouble. */
function isNotFoundMessage(error: unknown): boolean {
  return /not.?found|unknown transaction|does not exist|no transaction|not available/i.test(errorMessage(error))
}

/** Best-effort message out of an arbitrary thrown value. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    return error.message
  }
  return String(error)
}

/** Race one promise against a deadline (viem-version-proof receipt bound). */
async function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(onTimeout()), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/** Parse the ERC-721 tokenId out of a registration receipt's Transfer log. */
function parseAgentId(receipt: { logs?: Array<{ topics?: unknown[] }> } | null | undefined): string {
  try {
    const log = receipt?.logs?.find(entry => (entry.topics?.[0] as string | undefined)?.toLowerCase() === TRANSFER_TOPIC)
    const topic = log?.topics?.[3] as string | undefined
    if (topic !== undefined) return BigInt(topic).toString(10)
  } catch {}
  return '0'
}

export interface Config {
  wallet: string
  baseRpcUrl: string
  identityRegistry: string
  chainId: number
  agentName?: string | undefined
  agentDescription?: string | undefined
  mcpEndpoint?: string | undefined
  image?: string | undefined
}

export const Config: z<Config> = z.object({
  wallet: z.string().required(),
  baseRpcUrl: z.string().default('https://ethereum-sepolia-rpc.publicnode.com'),
  identityRegistry: z.string().default('0x8004A818BFB912233c491871b3d84c89A494BD9e'),
  chainId: z.number().default(11155111),
  agentName: z.string().default('DeepSeek Harness Agent'),
  image: z.string().default('https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png'),
  agentDescription: z.string().default('Autonomous agent on DeepSeek Harness (dsh-channel-xmtp + dsh-wallet + dsh-erc8004). Provides XMTP messaging, wallet tools, Filecoin Pin storage, and ERC-8004 verifiable identity.'),
  mcpEndpoint: z.string().default('https://api.githubcopilot.com/mcp/'),
})

export class Erc8004Runtime {
  private backend: Erc8004Backend | null = null
  /** Registration attempts by `uri:<tokenUri>` and `card:<sha256>` keys. */
  private readonly attempts = new Map<string, AttemptRecord>()
  /** In-flight receipt waits by txHash: concurrent registers attach, never re-send. */
  private readonly receipts = new Map<string, Promise<any>>()
  /** Disposer for the lazily registered exactly-once hook (none while unguarded). */
  private hookDisposer: (() => void) | undefined
  private readonly _baseRpcUrl: string
  private readonly _identityRegistry: `0x${string}`
  private readonly _chainId: number
  private readonly _agentName: string | undefined
  private readonly _agentDescription: string | undefined
  private readonly _mcpEndpoint: string | undefined
  private readonly _image: string | undefined

  constructor(
    private readonly ctx: Context,
    private readonly wallet: string,
    opts: {
      baseRpcUrl: string
      identityRegistry: `0x${string}`
      chainId: number
      agentName?: string | undefined
      agentDescription?: string | undefined
      mcpEndpoint?: string | undefined
      image?: string | undefined
    },
  ) {
    if (!opts.baseRpcUrl) throw new Error('dsh-erc8004: baseRpcUrl required')
    this._baseRpcUrl = opts.baseRpcUrl
    this._identityRegistry = opts.identityRegistry
    this._chainId = opts.chainId
    this._agentName = opts.agentName
    this._agentDescription = opts.agentDescription
    this._mcpEndpoint = opts.mcpEndpoint
    this._image = opts.image
  }

  private async ensureBackend(): Promise<Erc8004Backend> {
    if (this.backend) return this.backend
    this.backend = new Erc8004Backend({
      baseRpcUrl: this._baseRpcUrl,
      identityRegistry: this._identityRegistry,
      chainId: this._chainId,
    })
    return this.backend
  }

  /** Build a spec-compliant agent card for the given owner address. */
  buildCard(ownerAddress: string, overrides?: Partial<AgentCard>): AgentCard {
    const base = buildDefaultCard({
      ownerAddress,
      ...(this._agentName !== undefined ? { name: this._agentName } : {}),
      ...(this._agentDescription !== undefined ? { description: this._agentDescription } : {}),
      ...(this._image !== undefined ? { image: this._image } : {}),
      ...(this._mcpEndpoint !== undefined ? { mcpEndpoint: this._mcpEndpoint } : {}),
      chainId: this._chainId,
    })
    if (!overrides) return base
    return { ...base, ...overrides, endpoints: (overrides.endpoints as any) ?? base.endpoints }
  }

  /** Store card JSON on Filecoin via ctx.synapse and return CID + ipfs:// tokenURI. Emits erc8004/card-stored. */
  async storeCard(card: AgentCard, filename = 'agent-card.json'): Promise<{ cid: string; tokenUri: string; pieceCid?: string | undefined }> {
    const synapse: any = (this.ctx as any).synapse
    if (!synapse?.store) {
      throw new Error('dsh-erc8004: ctx.synapse not mounted — install dsh-storage-synapse for Filecoin Pin (PDP proofs). Card built but not pinned.')
    }
    const data = new TextEncoder().encode(JSON.stringify(card, null, 2))
    const { cid, pieceCid } = await synapse.store(data)
    const tokenUri = `ipfs://${cid}/${filename}`
    this.ctx.emit('erc8004/card-stored', { cid, tokenUri } satisfies Erc8004CardStoredEvent)
    return { cid, tokenUri, pieceCid }
  }

  /** Register tokenURI on the ERC-8004 Identity Registry via wallet-gated signing. Emits erc8004/registered. */
  async register(tokenUri: string): Promise<{ agentId: string; txHash: `0x${string}`; tokenUri: string }> {
    this.hook()
    for (;;) {
      // Plan and broadcast atomically in the wallet lane: concurrent
      // registers for one tokenUri converge on one record, and the
      // fetch-nonce → sign → send sequence never interleaves with another
      // sender on this wallet. The receipt wait stays outside the lane so
      // one slow chain never stalls the wallet.
      const action = await this.withWalletLock(() => this.planAndBroadcast(tokenUri))
      if (action.settled !== undefined) return action.settled
      const record = action.record
      if (record.txHash !== undefined && this.receipts.has(record.txHash)) {
        // A wait is already in flight for this broadcast (ours or a
        // concurrent register's): attach to it instead of re-sending.
        return await this.awaitSettle(record)
      }
      if (!action.fresh) {
        // A stale broadcast (an earlier wait ended without settling):
        // settle it against chain state first. Dropped/reverted loops back
        // to a fresh broadcast; pending throws instead of double-sending.
        const resolved = await this.resolveAttempt(record)
        if (resolved !== undefined) return resolved
        continue
      }
      return await this.awaitSettle(record)
    }
  }

  /** Run one task in this runtime's wallet lane (direct where the seam predates `withLock`). */
  private async withWalletLock<T>(task: () => Promise<T>): Promise<T> {
    const seam: any = (this.ctx as any).wallet
    if (seam !== null && seam !== undefined && typeof seam.withLock === 'function') {
      return await seam.withLock(this.wallet, task)
    }
    return await task()
  }

  /** Ledger plan plus, when needed, the broadcast itself. Runs inside the wallet lane. */
  private async planAndBroadcast(tokenUri: string): Promise<
    | { settled: { agentId: string; txHash: `0x${string}`; tokenUri: string } }
    | { settled: undefined; record: AttemptRecord; fresh: boolean }
  > {
    const prior = this.attempts.get(`uri:${tokenUri}`)
    if (prior !== undefined && prior.state === 'mined' && prior.agentId !== undefined && prior.txHash !== undefined) {
      return { settled: { agentId: prior.agentId, txHash: prior.txHash, tokenUri: prior.tokenUri } }
    }
    if (prior !== undefined && prior.state === 'broadcast' && prior.txHash !== undefined) {
      return { settled: undefined, record: prior, fresh: false }
    }
    // No prior, reverted, or provably dropped (txHash cleared): broadcast.
    // The prior object is reused so card-path metadata (pieceCid) survives.
    const record = await this.broadcastRegister(tokenUri, prior)
    return { settled: undefined, record, fresh: true }
  }

  /**
   * Register the `erc8004_register` read-back hook once the guard is
   * present. Lazy (called from every write path) so registration never
   * depends on plugin mount order; a no-op while unguarded, idempotent
   * once registered.
   */
  hook(): void {
    if (this.hookDisposer !== undefined) return
    const guard = this.ctx.reflect.get('exactlyOnce') as
      | { registerCheck?: (name: string, fn: (check: CheckContext) => Promise<CheckDecision>) => () => void }
      | undefined
    if (guard === null || guard === undefined || typeof guard.registerCheck !== 'function') return
    this.hookDisposer = guard.registerCheck('erc8004_register', check => this.checkRegister(check.args))
  }

  /** Retire the read-back hook (plugin disposal). */
  unhook(): void {
    try {
      this.hookDisposer?.()
    } catch {}
    this.hookDisposer = undefined
  }

  /**
   * Read-back hook for `erc8004_register` repeats after ambiguous
   * outcomes. A direct `tokenUri` retry resolves by attempt record; a
   * build-path retry rebuilds the deterministic card (pure plus one
   * address read — no storage spend) and resolves by card hash.
   * @param input - the retried tool arguments.
   * @returns replay when the registration is known-mined, proceed when it
   *   provably never committed, unknown otherwise.
   */
  async checkRegister(input: unknown): Promise<CheckDecision> {
    this.hook()
    const args = (input ?? {}) as {
      tokenUri?: unknown; name?: unknown; description?: unknown; mcpEndpoint?: unknown; filename?: unknown
    }
    if (typeof args.tokenUri === 'string' && args.tokenUri !== '') {
      return await this.checkTokenUri(args.tokenUri)
    }
    try {
      const walletSeam: any = (this.ctx as any).wallet
      const owner: string = await walletSeam.address(this.wallet)
      const overrides: Record<string, unknown> = {}
      if (typeof args.name === 'string') overrides['name'] = args.name
      if (typeof args.description === 'string') overrides['description'] = args.description
      if (typeof args.mcpEndpoint === 'string') overrides['mcpEndpoint'] = args.mcpEndpoint
      const card = this.buildCard(owner, overrides as never)
      const filename = typeof args.filename === 'string' ? args.filename : 'agent-card.json'
      const record = this.attempts.get(cardKeyFor(card, filename))
      if (record === undefined) return { kind: 'unknown' }
      return await this.checkRecord(record)
    } catch {
      return { kind: 'unknown' }
    }
  }

  /** Resolve one direct-`tokenUri` attempt to a hook verdict. */
  private async checkTokenUri(tokenUri: string): Promise<CheckDecision> {
    const record = this.attempts.get(`uri:${tokenUri}`)
    if (record === undefined) return { kind: 'unknown' }
    return await this.checkRecord(record)
  }

  /** Resolve one attempt record to a hook verdict. */
  private async checkRecord(record: AttemptRecord): Promise<CheckDecision> {
    if (record.state === 'mined' && record.agentId !== undefined && record.txHash !== undefined) {
      return {
        kind: 'replay',
        value: {
          agentId: record.agentId,
          tokenUri: record.tokenUri,
          txHash: record.txHash,
          cid: record.cid,
          ...(record.pieceCid !== undefined ? { pieceCid: record.pieceCid } : {}),
        },
      }
    }
    if (record.state === 'reverted' || record.txHash === undefined) return { kind: 'proceed' }
    try {
      const resolved = await this.resolveAttempt(record)
      if (resolved === undefined) return { kind: 'proceed' }
      return {
        kind: 'replay',
        value: {
          agentId: resolved.agentId,
          tokenUri: resolved.tokenUri,
          txHash: resolved.txHash,
          cid: record.cid,
          ...(record.pieceCid !== undefined ? { pieceCid: record.pieceCid } : {}),
        },
      }
    } catch {
      return { kind: 'unknown' }
    }
  }

  /**
   * Settle one prior attempt against chain state.
   * @param record - the recorded broadcast.
   * @returns the mined registration, or `undefined` when the broadcast is
   *   provably gone (dropped or reverted) and re-sending is safe. Throws
   *   when the chain cannot answer (pending or RPC failure): re-sending
   *   then would risk a duplicate.
   */
  private async resolveAttempt(record: AttemptRecord): Promise<{ agentId: string; txHash: `0x${string}`; tokenUri: string } | undefined> {
    if (record.state === 'mined' && record.agentId !== undefined && record.txHash !== undefined) {
      return { agentId: record.agentId, txHash: record.txHash, tokenUri: record.tokenUri }
    }
    if (record.state === 'reverted' || record.txHash === undefined) return undefined
    const be = await this.ensureBackend()
    const publicClient: any = await be.getPublicClient()
    let receipt: any = null
    try {
      receipt = await publicClient.getTransactionReceipt({ hash: record.txHash })
    } catch (error: unknown) {
      if (!isNotFoundMessage(error)) {
        throw new Error(`dsh-erc8004: cannot verify prior broadcast ${record.txHash} (${errorMessage(error)}) — retry later instead of re-sending`)
      }
      receipt = null
    }
    if (receipt === null || receipt === undefined) {
      // No receipt: dropped, or still mempool-pending? A pending tx must
      // never be re-sent under a fresh nonce.
      let pending: unknown = null
      try {
        pending = await publicClient.getTransaction({ hash: record.txHash })
      } catch {
        pending = null
      }
      if (pending !== null && pending !== undefined) {
        throw new Error(`dsh-erc8004: prior broadcast ${record.txHash} is still pending — wait for it instead of re-sending`)
      }
      // Provably nothing in flight: clear the hash so the next plan
      // re-broadcasts instead of resolving this record again.
      record.txHash = undefined
      return undefined
    }
    if (receipt.status !== 'success') {
      record.state = 'reverted'
      return undefined
    }
    const agentId = record.agentId ?? parseAgentId(receipt)
    record.agentId = agentId
    record.state = 'mined'
    return { agentId, txHash: record.txHash, tokenUri: record.tokenUri }
  }

  /**
   * Fetch-nonce → sign → send for one registration, recorded before
   * returning. Runs inside the wallet lane; the receipt wait in
   * {@link awaitSettle} runs outside it.
   */
  private async broadcastRegister(tokenUri: string, prior: AttemptRecord | undefined): Promise<AttemptRecord> {
    const walletSeam: any = (this.ctx as any).wallet
    const treasury: any = (() => {
      try { return (this.ctx as any).get?.('treasury') } catch {}
      try { return (this.ctx as any).treasury } catch { return undefined }
    })()
    if (!walletSeam?.address || typeof walletSeam.signTransaction !== 'function') {
      throw new Error('dsh-erc8004: ctx.wallet not mounted or missing signTransaction')
    }
    const owner: string = await walletSeam.address(this.wallet)

    // Treasury pre-check (if mounted) — authorize estimated gas cost, fail fast on DEPLETED
    const ESTIMATED_GAS_COST_USDC = 2_000 // ~$0.002 per register; treasury is µUSD, so 2000
    if (treasury?.authorize) {
      try {
        const decision = treasury.authorize('storage', ESTIMATED_GAS_COST_USDC)
        if (decision && decision.authorized === false) {
          throw new Error(`treasury blocked register: ${decision.reason ?? decision.code ?? 'insufficient funds'}`)
        }
      } catch (e) {
        if ((e as Error).message.includes('treasury blocked')) throw e
        // Non-fatal: treasury read should not block registration if it throws for other reasons
      }
    }

    const be = await this.ensureBackend()
    const publicClient: any = await be.getPublicClient()
    const { encodeFunctionData, serializeTransaction } = await import('viem')

    const data = encodeFunctionData({
      abi: ERC8004_ABI,
      functionName: 'register',
      args: [tokenUri],
    })

    // Prepare transaction request (nonce, gas, etc.) via publicClient
    const nonce = await publicClient.getTransactionCount({ address: owner as `0x${string}` })
    const gas = await publicClient.estimateGas({ account: owner as `0x${string}`, to: this._identityRegistry, data }).catch(() => 200_000n)
    let gasPrice: bigint | undefined
    try {
      gasPrice = await publicClient.getGasPrice()
    } catch { gasPrice = undefined }

    const tx: any = {
      to: this._identityRegistry as `0x${string}`,
      data,
      nonce,
      gas,
      ...(gasPrice !== undefined ? { gasPrice } : {}),
      chainId: this._chainId,
      type: 'legacy' as const,
    }

    const serializedUnsigned = serializeTransaction(tx as any)
    const { signature: signedRaw } = await walletSeam.signTransaction(this.wallet, serializedUnsigned)
    // wallet returns signed transaction hex (OWS sign-only) — send via publicClient
    const hash: `0x${string}` = await publicClient.sendRawTransaction({ serializedTransaction: signedRaw as `0x${string}` })

    const key = `uri:${tokenUri}`
    let record = prior ?? this.attempts.get(key)
    if (record === undefined) {
      record = { tokenUri, cid: cidFromTokenUri(tokenUri), txHash: undefined, agentId: undefined, pieceCid: undefined, state: 'broadcast' }
      this.attempts.set(key, record)
    }
    record.txHash = hash
    record.agentId = undefined
    record.state = 'broadcast'
    return record
  }

  /**
   * Wait for one broadcast's receipt (bounded), then settle the record,
   * record the treasury expense, and emit `erc8004/registered`. Runs
   * outside the wallet lane; concurrent settlers for one hash share a
   * single wait. A timeout throws but leaves the broadcast — and the
   * still-pending wait — as read-back evidence for the retry.
   */
  private async awaitSettle(record: AttemptRecord): Promise<{ agentId: string; txHash: `0x${string}`; tokenUri: string }> {
    const hash = record.txHash
    if (hash === undefined) throw new Error('dsh-erc8004: cannot settle a broadcast without a txHash')
    const treasury: any = (() => {
      try { return (this.ctx as any).get?.('treasury') } catch {}
      try { return (this.ctx as any).treasury } catch { return undefined }
    })()
    const be = await this.ensureBackend()
    const publicClient: any = await be.getPublicClient()
    const existing = this.receipts.get(hash)
    const wait: Promise<any> = existing ?? publicClient.waitForTransactionReceipt({ hash })
    if (existing === undefined) {
      this.receipts.set(hash, wait)
      const release = (): void => { if (this.receipts.get(hash) === wait) this.receipts.delete(hash) }
      wait.then(release, release)
    }
    let receipt: any
    try {
      receipt = await withTimeout(
        wait,
        internals.receiptTimeoutMs,
        () => new Error(`dsh-erc8004: no receipt for ${hash} after ${internals.receiptTimeoutMs}ms — the registration may have committed; retry and the attempt ledger resolves it before any re-send`),
      )
    } catch (error: unknown) {
      // Our budget ran out, not the chain's: unregister so the retry
      // settles this broadcast against chain state (resolveAttempt) instead
      // of attaching to a wait that may never resolve (dropped tx). The
      // wait itself keeps polling; a late receipt still settles whoever
      // holds it, and the record keeps the hash either way.
      if (this.receipts.get(hash) === wait) this.receipts.delete(hash)
      throw error
    }
    if (receipt === null || receipt === undefined || receipt.status !== 'success') {
      record.state = 'reverted'
      throw new Error(`dsh-erc8004: registration transaction ${hash} reverted on-chain (no effect committed)`)
    }
    const agentId = record.agentId ?? parseAgentId(receipt)
    record.agentId = agentId
    record.state = 'mined'

    // Treasury post-commit: record expense if mounted (best-effort)
    const ESTIMATED_GAS_COST_USDC = 2_000 // ~$0.002 per register; treasury is µUSD, so 2000
    if (treasury?.recordExpense || treasury?.addExpense) {
      try {
        const recordExpense = treasury.recordExpense ?? treasury.addExpense
        await recordExpense.call(treasury, { category: 'storage', amountUsd: ESTIMATED_GAS_COST_USDC / 1_000_000, description: `erc8004 register ${record.tokenUri}` })
      } catch {}
    } else if (treasury?.emit) {
      // Fallback: at least emit for policy visibility
      try { treasury.emit?.('expense', { category: 'storage', amount: ESTIMATED_GAS_COST_USDC }) } catch {}
    }

    const walletSeam: any = (this.ctx as any).wallet
    const owner: string = await walletSeam.address(this.wallet)
    this.ctx.emit('erc8004/registered', { agentId, tokenUri: record.tokenUri, txHash: hash, owner } satisfies Erc8004RegisteredEvent)
    return { agentId, txHash: hash, tokenUri: record.tokenUri }
  }

  /** Full flow: build card → store on Filecoin (via synapse) → register on Ethereum Sepolia (via wallet). */
  async registerAgent(overrides?: Partial<AgentCard> & { filename?: string | undefined }): Promise<{ card: AgentCard; cid: string; tokenUri: string; agentId: string; txHash: `0x${string}`; pieceCid?: string | undefined }> {
    this.hook()
    const walletSeam: any = (this.ctx as any).wallet
    if (!walletSeam?.address) throw new Error('dsh-erc8004: ctx.wallet not mounted')
    const owner = await walletSeam.address(this.wallet)
    const card = this.buildCard(owner, overrides)
    const filename = overrides?.filename ?? 'agent-card.json'
    // Resume: the same card rebuilds byte-identically, so a prior attempt
    // settles here with no re-pin and no re-send when already mined.
    const cardKey = cardKeyFor(card, filename)
    const prior = this.attempts.get(cardKey)
    if (prior !== undefined) {
      const resumed = await this.resolveAttempt(prior)
      if (resumed !== undefined) {
        return {
          card,
          cid: prior.cid,
          tokenUri: prior.tokenUri,
          agentId: resumed.agentId,
          txHash: resumed.txHash,
          ...(prior.pieceCid !== undefined ? { pieceCid: prior.pieceCid } : {}),
        }
      }
      // Dropped or reverted: the card is already pinned, so re-register
      // the same tokenUri without storing again. register() re-plans in
      // the wallet lane (never nested: this path holds no lock).
      const resent = await this.register(prior.tokenUri)
      return {
        card,
        cid: prior.cid,
        tokenUri: prior.tokenUri,
        agentId: resent.agentId,
        txHash: resent.txHash,
        ...(prior.pieceCid !== undefined ? { pieceCid: prior.pieceCid } : {}),
      }
    }
    const { cid, tokenUri, pieceCid } = await this.storeCard(card, filename)
    let record = this.attempts.get(`uri:${tokenUri}`)
    if (record === undefined) {
      record = { tokenUri, cid, txHash: undefined, agentId: undefined, pieceCid, state: 'broadcast' }
      this.attempts.set(`uri:${tokenUri}`, record)
    } else if (pieceCid !== undefined) {
      record.pieceCid = pieceCid
    }
    this.attempts.set(cardKey, record)
    const { agentId, txHash } = await this.register(tokenUri)
    return { card, cid, tokenUri, agentId, txHash, pieceCid }
  }

  async tokenURI(agentId: string | bigint): Promise<string> {
    const be = await this.ensureBackend()
    return be.tokenURI(agentId)
  }

  async ownerOf(agentId: string | bigint): Promise<string> {
    const be = await this.ensureBackend()
    return be.ownerOf(agentId)
  }

  get config() {
    return {
      wallet: this.wallet,
      baseRpcUrl: this._baseRpcUrl,
      identityRegistry: this._identityRegistry,
      chainId: this._chainId,
    }
  }
}

const REGISTER_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agentId: { type: 'string', required: true, description: 'ERC-721 tokenId (decimal string)' },
    tokenUri: { type: 'string', required: true, description: 'ipfs://<cid>/agent-card.json' },
    txHash: { type: 'string', required: true, description: 'Ethereum Sepolia registration tx hash' },
    cid: { type: 'string', required: true },
    pieceCid: { type: 'string', description: 'Filecoin piece CID when available' },
  },
} as const

const CARD_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    type: { type: 'string', required: true },
    name: { type: 'string', required: true },
    description: { type: 'string', required: true },
    image: { type: 'string' },
    endpoints: { type: 'array' },
    registrations: { type: 'array' },
    supportedTrust: { type: 'array' },
  },
} as const

export function apply(ctx: Context, config: Config): void {
  const runtime = new Erc8004Runtime(ctx, config.wallet, {
    baseRpcUrl: config.baseRpcUrl,
    identityRegistry: config.identityRegistry as `0x${string}`,
    chainId: config.chainId,
    ...(config.agentName !== undefined ? { agentName: config.agentName } : {}),
    ...(config.agentDescription !== undefined ? { agentDescription: config.agentDescription } : {}),
    ...(config.mcpEndpoint !== undefined ? { mcpEndpoint: config.mcpEndpoint } : {}),
    ...(config.image !== undefined ? { image: config.image } : {}),
  } as any)
  ctx.provide('erc8004', runtime)

  // The read-back hook registers lazily from the runtime's write paths
  // (mount-order-proof: no dependence on when the guard mounts); this
  // effect only retires the hook when the plugin goes down.
  ctx.effect(() => () => runtime.unhook())

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'erc8004_build_card',
        description:
          'Build an ERC-8004 registration-v1 agent card (type/name/description/endpoints/supportedTrust) for the agent wallet. Returns the card JSON. The agentWallet endpoint is eip155:chainId:address derived live via ctx.wallet.',
        parameters: {
          name: { type: 'string', description: 'Agent name override (default from config agentName)' },
          description: { type: 'string', description: 'Agent description override' },
          mcpEndpoint: { type: 'string', description: 'MCP endpoint URL override' },
          image: { type: 'string', description: 'Avatar/logo URL override' },
        },
        output: { schema: CARD_SCHEMA as any, render: (_a: unknown, v: unknown) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
        async execute(args: { name?: string | undefined; description?: string | undefined; mcpEndpoint?: string | undefined; image?: string | undefined }): Promise<any> {
          const walletSeam: any = (ctx as any).wallet
          const owner = await walletSeam.address(config.wallet)
          return runtime.buildCard(owner, {
            ...(args.name !== undefined ? { name: args.name } : {}),
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(args.image !== undefined ? { image: args.image } : {}),
            ...(args.mcpEndpoint !== undefined ? { endpoints: [
              { name: 'MCP', endpoint: args.mcpEndpoint, version: '1.0.0', capabilities: { tools: [{ name: 'xmtp', description: 'XMTP messaging' }] } },
              { name: 'agentWallet', endpoint: `eip155:${config.chainId}:${owner}` },
            ] } : {}),
          } as any)
        },
        presentCall: () => ({ card: 'generic', title: 'Build ERC-8004 agent card', kind: 'read' }),
      }),
    ),
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'erc8004_register',
        description:
          'Register the agent on the ERC-8004 Identity Registry (Ethereum Sepolia 0x8004...BD9e): build card → pin to Filecoin via ctx.synapse (PDP proofs) → register(string tokenURI) via ctx.wallet signTransaction + treasury (sign-only, ~0.001 ETH gas). Provide custom tokenUri to skip build+pin and register directly. Returns agentId (tokenId), tokenUri ipfs://<cid>/agent-card.json, txHash, and Filecoin CIDs.',
        parameters: {
          tokenUri: { type: 'string', description: 'Existing ipfs://<cid>/agent-card.json to register directly (skips build+pin)' },
          name: { type: 'string', description: 'Agent name override for the built card' },
          description: { type: 'string', description: 'Agent description override' },
          mcpEndpoint: { type: 'string', description: 'MCP endpoint override' },
          filename: { type: 'string', description: 'Card filename for tokenUri (default agent-card.json)' },
        },
        output: { schema: REGISTER_RESULT_SCHEMA, render: (_a: unknown, v: unknown) => [{ type: 'text', text: `Agent ${(v as any).agentId} registered: ${(v as any).tokenUri} tx ${(v as any).txHash} (CID ${(v as any).cid})` }] },
        async execute(args: { tokenUri?: string | undefined; name?: string | undefined; description?: string | undefined; mcpEndpoint?: string | undefined; filename?: string | undefined }): Promise<any> {
          if (args.tokenUri !== undefined) {
            const { agentId, txHash } = await runtime.register(args.tokenUri)
            const cid = args.tokenUri.replace('ipfs://', '').split('/')[0] ?? ''
            return { agentId, tokenUri: args.tokenUri, txHash, cid }
          }
          const overrides: any = {}
          if (args.name !== undefined) overrides.name = args.name
          if (args.description !== undefined) overrides.description = args.description
          if (args.mcpEndpoint !== undefined) overrides.mcpEndpoint = args.mcpEndpoint
          if (args.filename !== undefined) overrides.filename = args.filename
          const res = await runtime.registerAgent(overrides)
          return { agentId: res.agentId, tokenUri: res.tokenUri, txHash: res.txHash, cid: res.cid, ...(res.pieceCid !== undefined ? { pieceCid: res.pieceCid } : {}) }
        },
        presentCall: args => ({ card: 'generic', title: args.tokenUri ? `Register ERC-8004 ${args.tokenUri}` : 'Register ERC-8004 agent (Filecoin Pin + Ethereum Sepolia)', kind: 'execute' }),
      }),
    ),
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'erc8004_token_uri',
        description: 'Read the ERC-8004 tokenURI for an agentId (tokenId) via Ethereum Sepolia call tokenURI(uint256). Verifies on-chain registration.',
        parameters: {
          agentId: { type: 'string', required: true, description: 'Agent tokenId decimal string (from erc8004_register)' },
        },
        output: { schema: { type: 'string' }, render(_a: unknown, v: string) { return [{ type: 'text', text: v }] as never } },
        async execute(args: { agentId: string }): Promise<string> {
          return runtime.tokenURI(args.agentId)
        },
        presentCall: args => ({ card: 'generic', title: `ERC-8004 tokenURI #${args.agentId}`, kind: 'read' }),
      }),
    ),
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'erc8004_owner_of',
        description: 'Read ownerOf for an ERC-8004 agentId on Ethereum Sepolia.',
        parameters: {
          agentId: { type: 'string', required: true, description: 'Agent tokenId decimal string' },
        },
        output: { schema: { type: 'string' }, render(_a: unknown, v: string) { return [{ type: 'text', text: v }] as never } },
        async execute(args: { agentId: string }): Promise<string> {
          return runtime.ownerOf(args.agentId)
        },
        presentCall: args => ({ card: 'generic', title: `ERC-8004 ownerOf #${args.agentId}`, kind: 'read' }),
      }),
    ),
  )
}
