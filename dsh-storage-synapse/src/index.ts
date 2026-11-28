/**
 * Synapse pinning & Filecoin Pay rail for dsh: `ctx.synapse` (store / retrieve /
 * pin / pin-status / paymentStatus / fund over Filecoin Onchain Cloud) plus
 * four model-facing tools — `synapse_pin`, `synapse_pin_status`,
 * `synapse_payment_status`, and `synapse_fund` — so any agent can inspect
 * wallet vs. Filecoin Pay balances, fund Warm Storage idempotently, and pin
 * files seamlessly.
 *
 * Custody & seam discipline:
 * - Every request is authenticated by a viem Account whose signing callbacks
 *   delegate to `ctx.wallet` (`signTransaction`, `signMessage`, and raw
 *   `signDigest` for EIP-712 / EIP-2612 permits). No private key or credential
 *   reference ever enters configuration.
 * - On-chain writes serialize through `ctx.wallet.withLock` (re-entrant-safe
 *   via `AsyncLocalStorage` so inner `signTransaction` callbacks never deadlock
 *   with outer `fund` locks).
 * - Enforcement belongs solely to `dsh-treasury/policy` when enabled; this
 *   plugin reports capital movements via `synapse/funded` and never enforces
 *   unilaterally or misclassifies escrowed USDFC deposits as single-day burn.
 *
 * @module dsh-storage-synapse
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
// Type-only: the read-back hook contract (runtime access to the guard stays
// optional via `ctx.reflect.get`, so this plugin mounts cleanly unguarded).
import type { CheckContext, CheckDecision } from 'dsh-exactly-once'
import { hashFileSha256 } from './singleBlockCar.ts'
import {
  DEFAULT_AUTO_FUND_RUNWAY_DAYS,
  DEFAULT_MAX_AUTO_FUND_USDFC,
  parseFixed18,
} from './synapse.ts'
import type {
  Cid,
  FundRequest,
  FundResult,
  PaymentEstimate,
  PaymentStatusSnapshot,
  PinStatus,
  StoreInput,
} from './synapse.ts'
import type { SynapseFundedEvent, SynapsePinnedEvent } from './types.ts'

export type {
  Cid,
  FundRequest,
  FundResult,
  PaymentEstimate,
  PaymentStatusSnapshot,
  PinStatus,
  StoreInput,
  StoreOptions,
} from './synapse.ts'
export type { SynapseFundedEvent, SynapsePinnedEvent } from './types.ts'

/**
 * Test seam: bounds the read-back retries that ride out Filecoin
 * eventual-consistency false negatives (production: three checks, 500ms
 * apart).
 */
export const internals = { checkRetries: 3, checkRetryMs: 500 }

/** Cordis plugin name. */
export const name = 'storage-synapse'
/** Signing identity (`ctx.wallet`) and the tool registry. */
export const inject = ['wallet', 'tools']

/** Plugin configuration — wallet-gated (AccountConfig), no privateKeyRef. */
export interface Config {
  /** Configured `dsh-wallet` wallet name that identifies the payer. Required. */
  wallet: string
  /** Filecoin RPC URL (e.g. https://api.calibration.node.glif.io/rpc/v1). Required. Websocket schemes are normalized to HTTP(S). */
  rpcUrl: string
  /** Filecoin network: calibration (default) or mainnet. */
  networkMode?: 'calibration' | 'mainnet'
  /** Whether to enable the Filecoin CDN for retrievals. */
  withCDN?: boolean
  /** Workaround for calibration #615: number of copies (default 1 to avoid 2-copy replication failure). */
  copies?: number
  /**
   * Provider IDs to exclude from auto-selection. Default empty: calibration's
   * endorsed set is tiny (observed as exactly [4, 9]) and excluding all of it
   * fails every upload with "No endorsed provider available". Exclude only a
   * provider you have live evidence is down; the store path retries once
   * without exclusions on selection failure anyway.
   */
  excludeProviderIds?: number[]
  /** Explicit provider IDs to use (overrides auto-selection). Never second-guessed by the retry path. */
  providerIds?: number[]
  /**
   * Optional JSON path persisting the root→piece ledger checkPin verifies
   * against. Without it the ledger is memory-only: restarts forget which
   * pieces carry which roots and status degrades to "not pinned".
   */
  pieceLedgerPath?: string
  /**
   * Automatically approve Warm Storage and deposit USDFC from the agent's
   * wallet into Filecoin Pay before uploading when available funds or
   * allowances are short. Default `true` everywhere (bounded by `maxAutoFundUsdfc`).
   */
  autoFund?: boolean
  /** Maximum USDFC a single auto-fund operation may deposit (decimal string, default `"10"`). */
  maxAutoFundUsdfc?: string
  /** Target net storage runway in days when auto-funding uploads (default `30`). */
  autoFundRunwayDays?: number
}

/** Config schema — no credential fields, only wallet name + public RPC URL + funding policy. */
export const Config: z<Config> = z.object({
  wallet: z.string().required(),
  rpcUrl: z.string().required(),
  networkMode: z.union(['calibration', 'mainnet']).default('calibration'),
  withCDN: z.boolean().default(true),
  copies: z.number().step(1).min(1).max(3).default(1),
  excludeProviderIds: z.array(z.number().step(1).min(0)).default([]),
  providerIds: z.array(z.number().step(1).min(0)),
  pieceLedgerPath: z.string(),
  autoFund: z.boolean().default(true),
  maxAutoFundUsdfc: z.string().default(DEFAULT_MAX_AUTO_FUND_USDFC),
  autoFundRunwayDays: z.number().step(1).min(0).default(DEFAULT_AUTO_FUND_RUNWAY_DAYS),
})

/**
 * The `ctx.synapse` seam: Filecoin Synapse SDK only (reference parity).
 * No Kubo, no localhost:5001 — uploads pay USDFC through Filecoin Pay via a
 * wallet-gated viem Account (no raw key).
 */
export class SynapseRuntime {
  private filecoin: import('./synapse.ts').FilecoinBackend | null = null
  /** Uploaded bytes by sha256: CIDs are content-deterministic, so a repeat stores once. */
  private readonly uploads = new Map<string, Cid>()
  /** Disposers for lazily registered exactly-once hooks (empty while unguarded). */
  private hookDisposers: Array<() => void> = []
  /** Re-entrancy marker so nested wallet-locked calls never deadlock the same wallet lane. */
  private readonly walletLockScope = new AsyncLocalStorage<boolean>()
  private readonly _rpcUrl: string
  private readonly _networkMode?: 'calibration' | 'mainnet' | undefined
  private readonly _withCDN?: boolean | undefined
  private readonly _copies: number
  private readonly _excludeProviderIds?: bigint[] | undefined
  private readonly _providerIds?: bigint[] | undefined
  private readonly _pieceLedgerPath?: string | undefined
  private readonly _autoFund: boolean
  private readonly _maxAutoFundUsdfc: string
  private readonly _autoFundRunwayDays: number

  constructor(
    private readonly ctx: Context,
    private readonly wallet: string,
    opts: {
      rpcUrl: string
      networkMode?: 'calibration' | 'mainnet' | undefined
      withCDN?: boolean | undefined
      copies?: number
      excludeProviderIds?: number[]
      providerIds?: number[]
      pieceLedgerPath?: string
      autoFund?: boolean
      maxAutoFundUsdfc?: string
      autoFundRunwayDays?: number
    },
  ) {
    if (!opts.rpcUrl) {
      throw new Error('dsh-storage-synapse: rpcUrl required (Filecoin-only, no Kubo fallback)')
    }
    this._rpcUrl = opts.rpcUrl
    this._networkMode = opts.networkMode
    this._withCDN = opts.withCDN
    this._copies = opts.copies ?? 1
    this._excludeProviderIds = opts.excludeProviderIds?.length ? opts.excludeProviderIds.map(n => BigInt(n)) : undefined
    this._providerIds = opts.providerIds?.length ? opts.providerIds.map(n => BigInt(n)) : undefined
    this._pieceLedgerPath = opts.pieceLedgerPath
    this._autoFund = opts.autoFund ?? true
    this._maxAutoFundUsdfc = opts.maxAutoFundUsdfc ?? DEFAULT_MAX_AUTO_FUND_USDFC
    this._autoFundRunwayDays = opts.autoFundRunwayDays ?? DEFAULT_AUTO_FUND_RUNWAY_DAYS
  }

  /** Run one task in the named wallet's exclusive lane without deadlocking on re-entry. */
  private async withWalletLock<T>(task: () => Promise<T>): Promise<T> {
    if (this.walletLockScope.getStore() === true) return await task()
    const walletSeam: any = (this.ctx as any).wallet
    if (walletSeam !== null && walletSeam !== undefined && typeof walletSeam.withLock === 'function') {
      return await walletSeam.withLock(this.wallet, () => this.walletLockScope.run(true, task))
    }
    return await this.walletLockScope.run(true, task)
  }

  /** Build a viem Account delegating signing to `ctx.wallet` (no raw key cached). */
  private async createAccount(): Promise<import('viem').Account> {
    const walletSeam: any = (this.ctx as any).wallet
    if (!walletSeam?.address || typeof walletSeam.signTransaction !== 'function') {
      throw new Error('dsh-storage-synapse: ctx.wallet not mounted or missing signTransaction (needs dsh-wallet + dsh-wallet-ethereum)')
    }
    const address = await walletSeam.address(this.wallet) as `0x${string}`
    const { toAccount } = await import('viem/accounts')
    const { serializeTransaction } = await import('viem')
    const walletName = this.wallet
    const withWalletLock = <T>(task: () => Promise<T>) => this.withWalletLock(task)
    return toAccount({
      address,
      async signMessage({ message }: { message: string | { raw: string | Uint8Array } }): Promise<`0x${string}`> {
        let payload: string
        if (typeof message === 'string') payload = message
        else if (typeof (message as any).raw === 'string') payload = (message as any).raw
        else if ((message as any).raw instanceof Uint8Array) payload = new TextDecoder().decode((message as any).raw)
        else payload = String(message)
        const { signature } = await walletSeam.signMessage(walletName, payload)
        return signature as `0x${string}`
      },
      async signTransaction(transaction: any): Promise<`0x${string}`> {
        return await withWalletLock(async () => {
          const serialized = serializeTransaction(transaction)
          const { signature: signedRaw } = await walletSeam.signTransaction(walletName, serialized)
          return signedRaw as `0x${string}`
        })
      },
      async signTypedData(typedData: any): Promise<`0x${string}`> {
        // Filecoin Synapse EIP-712: CreateDataSet / AddPieces / SchedulePieceRemovals /
        // TerminateService / ERC-2612 USDFC Permit (synapse-core typed-data).
        // The digest must be signed RAW (secp256k1 over the 32 bytes, like viem's
        // privateKeyToAccount). EIP-191 prefixing recovers to a garbage address on-chain.
        if (typeof walletSeam.signDigest !== 'function') {
          throw new Error(
            'dsh-storage-synapse: ctx.wallet lacks signDigest (needs dsh-wallet-ethereum with raw digest signing) — '
            + 'refusing to EIP-191-sign an EIP-712 digest',
          )
        }
        const { hashTypedData } = await import('viem')
        const digest = hashTypedData(typedData as any) as `0x${string}`
        const res = await walletSeam.signDigest(walletName, digest)
        const signature = typeof res === 'string' ? res : (res as { signature: string }).signature
        return signature as `0x${string}`
      },
    } as any)
  }

  private emitFunded(res: FundResult): void {
    const event: SynapseFundedEvent = {
      address: res.status.address,
      network: res.status.network,
      chain: res.status.chain,
      depositedUsdfc: res.depositedUsdfc,
      depositedRaw: res.depositedRaw,
      totalDepositedUsdfc: res.status.depositedUsdfc,
      totalDepositedRaw: res.status.depositedUsdfcRaw,
      allowancesUpdated: res.allowancesUpdated,
      ...(res.transactionHash !== undefined ? { txHash: res.transactionHash } : {}),
      ...(res.allowanceTransactionHash !== undefined ? { allowanceTxHash: res.allowanceTransactionHash } : {}),
      reason: res.reason,
    }
    this.ctx.emit('synapse/funded', event)
  }

  private async ensureBackend(): Promise<import('./synapse.ts').FilecoinBackend> {
    if (this.filecoin) return this.filecoin
    const { FilecoinBackend } = await import('./synapse.ts')
    const getAccount = () => this.createAccount()
    this.filecoin = new FilecoinBackend({
      getAccount,
      rpcUrl: this._rpcUrl,
      networkMode: this._networkMode,
      withCDN: this._withCDN,
      copies: this._copies,
      excludeProviderIds: this._excludeProviderIds,
      providerIds: this._providerIds,
      pieceLedgerPath: this._pieceLedgerPath,
      autoFund: this._autoFund,
      maxAutoFundUsdfc: this._maxAutoFundUsdfc,
      autoFundRunwayDays: this._autoFundRunwayDays,
      withWalletLock: task => this.withWalletLock(task),
      onFunded: res => this.emitFunded(res),
    })
    return this.filecoin
  }

  // @ts-ignore unused but documents mode
  private get backend(): 'filecoin' { return 'filecoin' as const }

  /**
   * Register the `synapse_pin` and `synapse_fund` read-back hooks once the
   * guard is present. Lazy (called from every write path) so registration
   * never depends on plugin mount order; a no-op while unguarded, idempotent
   * once registered.
   */
  hook(): void {
    if (this.hookDisposers.length > 0) return
    const guard = this.ctx.reflect.get('exactlyOnce') as
      | { registerCheck?: (name: string, fn: (check: CheckContext) => Promise<CheckDecision>) => () => void }
      | undefined
    if (guard === null || guard === undefined || typeof guard.registerCheck !== 'function') return
    this.hookDisposers = [
      guard.registerCheck('synapse_pin', check => this.checkPinTool(check.args)),
      guard.registerCheck('synapse_fund', check => this.checkFundTool(check.args)),
    ]
  }

  /** Retire all read-back hooks (plugin disposal). */
  unhook(): void {
    for (const dispose of this.hookDisposers.splice(0)) {
      try {
        dispose()
      } catch {}
    }
  }

  /**
   * Read-back hook for `synapse_pin` repeats after ambiguous outcomes. A
   * `cid` retry checks the pin directly; a `path` retry resolves by
   * content hash through the upload ledger, then checks the pin.
   */
  async checkPinTool(input: unknown): Promise<CheckDecision> {
    this.hook()
    const args = (input ?? {}) as { path?: unknown; cid?: unknown }
    if (typeof args.cid === 'string' && args.cid !== '') {
      return await this.checkPinned(args.cid)
    }
    if (typeof args.path === 'string' && args.path !== '') {
      let sha: string
      try {
        sha = (await hashFileSha256(args.path)).hex
      } catch {
        return { kind: 'unknown' }
      }
      const cid = this.uploads.get(sha)
      if (cid === undefined) return { kind: 'unknown' }
      return await this.checkPinned(cid)
    }
    return { kind: 'unknown' }
  }

  /**
   * Read-back hook for `synapse_fund` repeats after ambiguous outcomes.
   * Because funding targets are declarative, checking live on-chain Filecoin
   * Pay balance and Warm Storage approval tells us definitively whether the
   * prior broadcast already landed.
   */
  async checkFundTool(input: unknown): Promise<CheckDecision> {
    this.hook()
    const args = (input ?? {}) as {
      setup?: unknown
      targetDepositUsdfc?: unknown
      targetRunwayDays?: unknown
      path?: unknown
      fileSizeBytes?: unknown
    }
    try {
      let fileSizeBytes: number | undefined
      if (typeof args.fileSizeBytes === 'number' && Number.isFinite(args.fileSizeBytes) && args.fileSizeBytes >= 0) {
        fileSizeBytes = args.fileSizeBytes
      } else if (typeof args.path === 'string' && args.path !== '') {
        fileSizeBytes = (await stat(args.path)).size
      }
      const targetRunwayDays = typeof args.targetRunwayDays === 'number' && Number.isFinite(args.targetRunwayDays)
        ? args.targetRunwayDays
        : undefined
      const snap = await this.paymentStatus(
        fileSizeBytes !== undefined ? { fileSizeBytes, targetRunwayDays } : undefined,
      )
      if (snap.needsAllowanceUpdate) return { kind: 'proceed' }

      if (typeof args.targetDepositUsdfc === 'string' && args.targetDepositUsdfc.trim() !== '') {
        const target = parseFixed18(args.targetDepositUsdfc, 'targetDepositUsdfc')
        if (BigInt(snap.depositedUsdfcRaw) >= target) {
          return {
            kind: 'replay',
            value: {
              adjusted: false,
              allowancesUpdated: false,
              depositedRaw: '0',
              depositedUsdfc: '0',
              reason: 'already-funded',
              status: snap,
            } satisfies FundResult,
          }
        }
        return { kind: 'proceed' }
      }

      if (snap.estimate !== undefined) {
        if (snap.estimate.ready) {
          return {
            kind: 'replay',
            value: {
              adjusted: false,
              allowancesUpdated: false,
              depositedRaw: '0',
              depositedUsdfc: '0',
              reason: 'already-funded',
              status: snap,
            } satisfies FundResult,
          }
        }
        return { kind: 'proceed' }
      }

      if (targetRunwayDays !== undefined && snap.runwayState === 'active') {
        if (snap.runwayDays >= targetRunwayDays) {
          return {
            kind: 'replay',
            value: {
              adjusted: false,
              allowancesUpdated: false,
              depositedRaw: '0',
              depositedUsdfc: '0',
              reason: 'already-funded',
              status: snap,
            } satisfies FundResult,
          }
        }
        return { kind: 'proceed' }
      }

      // Auto-setup / unknown target: safe to proceed because fund() itself is idempotent on chain state.
      return { kind: 'proceed' }
    } catch {
      return { kind: 'unknown' }
    }
  }

  /** Pin verdict with bounded retries over Filecoin false negatives. */
  private async checkPinned(cid: Cid): Promise<CheckDecision> {
    for (let attempt = 0; attempt < internals.checkRetries; attempt += 1) {
      if (attempt > 0 && internals.checkRetryMs > 0) {
        await new Promise(done => setTimeout(done, internals.checkRetryMs))
      }
      let status: PinStatus
      try {
        status = await this.checkPin(cid)
      } catch {
        return { kind: 'unknown' } // the node cannot answer at all
      }
      if (status.redundancy > 0) return { kind: 'replay', value: status }
    }
    return { kind: 'proceed' }
  }

  /**
   * Read live on-chain Filecoin Pay & Warm Storage status (EOA gas, EOA USDFC,
   * Filecoin Pay gross/locked/available USDFC, Warm Storage approval, burn rate,
   * runway, and optional upload cost dry-run). Pure read — zero spend.
   */
  async paymentStatus(opts?: { fileSizeBytes?: number; targetRunwayDays?: number }): Promise<PaymentStatusSnapshot> {
    const be = await this.ensureBackend()
    return await be.paymentStatus(opts)
  }

  /**
   * Declaratively ensure Warm Storage operator approval and deposit USDFC from
   * the agent's wallet into Filecoin Pay to meet the requested target.
   * Deposit-only (never withdraws). Idempotent on chain state.
   */
  async fund(req?: FundRequest): Promise<FundResult> {
    this.hook()
    const be = await this.ensureBackend()
    return await be.fund(req)
  }

  /**
   * Store bytes or a local file on Filecoin (CIDv1). Repeat stores of identical
   * content return the recorded CID without re-uploading (CIDs are
   * content-deterministic). File inputs stream from disk without buffering the
   * payload in the Node heap.
   */
  async store(
    input: StoreInput,
    _signal?: AbortSignal,
    onProgress?: (event: unknown) => void,
  ): Promise<{ cid: Cid; pieceCid?: string | undefined }> {
    this.hook()
    let sha: string
    let digest: Uint8Array
    let size: number
    if (input instanceof Uint8Array) {
      const buf = createHash('sha256').update(input).digest()
      digest = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
      sha = buf.toString('hex')
      size = input.byteLength
    } else {
      const hashed = await hashFileSha256(input.path)
      digest = hashed.digest
      sha = hashed.hex
      size = hashed.size
    }
    const known = this.uploads.get(sha)
    if (known !== undefined) return { cid: known }
    const be = await this.ensureBackend()
    const stored = await be.store(input, { signal: _signal, onProgress, digest, size })
    this.uploads.set(sha, stored.cid)
    return stored
  }

  /** Retrieve stored bytes by CID. */
  async retrieve(cid: Cid, _signal?: AbortSignal): Promise<Uint8Array> {
    const be = await this.ensureBackend()
    return be.retrieve(cid, _signal)
  }

  /** Pin one CID (honest liveness read). Emits `synapse/pinned` at the commit point. */
  async pin(cid: Cid, _signal?: AbortSignal): Promise<PinStatus> {
    this.hook()
    const be = await this.ensureBackend()
    const st = await be.pin(cid)
    this.ctx.emit('synapse/pinned', { cid } satisfies SynapsePinnedEvent)
    return st
  }

  /** Check one CID's pin health. Fail-soft: unreachable status answers "not pinned". */
  async checkPin(cid: Cid, _signal?: AbortSignal): Promise<PinStatus> {
    const be = await this.ensureBackend()
    return be.checkPin(cid)
  }
}

/** JSON-schema of the pin-status value both pin tools return. */
const PIN_STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    cid: { type: 'string', required: true },
    provider: { type: 'string', required: true },
    expiresAt: { type: 'number', required: true, description: '0 = permanent, -1 = not pinned.' },
    redundancy: { type: 'number', required: true, description: 'Replica count; 0 = not pinned.' },
    pieceCid: { type: 'string', description: 'CommP piece CID carrying the root (present when the ledger maps it).' },
  },
} as const

const PAYMENT_ESTIMATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    fileSizeBytes: { type: 'number', required: true },
    copies: { type: 'number', required: true },
    withCDN: { type: 'boolean', required: true },
    newDataSetCount: { type: 'number', required: true },
    ready: { type: 'boolean', required: true },
    depositNeededRaw: { type: 'string', required: true },
    depositNeededUsdfc: { type: 'string', required: true },
    canSelfFundFromWallet: { type: 'boolean', required: true },
    walletShortfallRaw: { type: 'string', required: true },
    walletShortfallUsdfc: { type: 'string', required: true },
    reasonCode: { type: 'string', required: true },
  },
} as const

const PAYMENT_STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    network: { type: 'string', required: true },
    chain: { type: 'string', required: true },
    chainId: { type: 'number', required: true },
    address: { type: 'string', required: true },
    filBalanceRaw: { type: 'string', required: true },
    filBalance: { type: 'string', required: true },
    hasSufficientGas: { type: 'boolean', required: true },
    walletUsdfcRaw: { type: 'string', required: true },
    walletUsdfc: { type: 'string', required: true },
    depositedUsdfcRaw: { type: 'string', required: true },
    depositedUsdfc: { type: 'string', required: true },
    lockedUsdfcRaw: { type: 'string', required: true },
    lockedUsdfc: { type: 'string', required: true },
    availableUsdfcRaw: { type: 'string', required: true },
    availableUsdfc: { type: 'string', required: true },
    warmStorageApproved: { type: 'boolean', required: true },
    needsAllowanceUpdate: { type: 'boolean', required: true },
    spendRatePerDayRaw: { type: 'string', required: true },
    spendRatePerDayUsdfc: { type: 'string', required: true },
    runwayState: { type: 'string', required: true },
    runwayDays: { type: 'number', required: true },
    runwayHours: { type: 'number', required: true },
    coverageDays: { type: 'number', required: true },
    coverageHours: { type: 'number', required: true },
    estimate: PAYMENT_ESTIMATE_SCHEMA,
  },
} as const

const FUND_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    adjusted: { type: 'boolean', required: true },
    allowancesUpdated: { type: 'boolean', required: true },
    depositedRaw: { type: 'string', required: true },
    depositedUsdfc: { type: 'string', required: true },
    transactionHash: { type: 'string' },
    allowanceTransactionHash: { type: 'string' },
    reason: { type: 'string', required: true },
    status: PAYMENT_STATUS_SCHEMA,
  },
} as const

/** Render one pin status as the model-facing text block. */
function renderStatus(value: PinStatus): { type: 'text'; text: string }[] {
  const health = value.redundancy > 0 ? 'pinned' : 'not pinned'
  const piece = value.pieceCid !== undefined && value.pieceCid !== '' ? `, piece ${value.pieceCid}` : ''
  return [{ type: 'text', text: `${value.cid}: ${health} (provider ${value.provider}${piece})` }]
}

/** Render Filecoin Pay + wallet status clearly so any agent distinguishes wallet vs. contract balances. */
function renderPaymentStatus(value: PaymentStatusSnapshot): { type: 'text'; text: string }[] {
  const nativeSymbol = value.chainId === 314159 ? 'tFIL' : 'FIL'
  const runwayText = value.runwayState === 'active'
    ? `${value.runwayDays}d ${value.runwayHours}h net runway (${value.coverageDays}d ${value.coverageHours}h total coverage, burn ${value.spendRatePerDayUsdfc} USDFC/day)`
    : 'no active spend'
  const lines = [
    `Filecoin Pay status (${value.network}, ${value.chain}) for ${value.address}:`,
    `- Wallet: ${value.filBalance} ${nativeSymbol} (${value.hasSufficientGas ? 'gas ok' : 'INSUFFICIENT GAS'}), ${value.walletUsdfc} USDFC`,
    `- Filecoin Pay contract: ${value.depositedUsdfc} USDFC deposited (${value.availableUsdfc} available, ${value.lockedUsdfc} locked)`,
    `- Warm Storage operator: ${value.warmStorageApproved ? 'approved' : 'NOT approved (needs allowance update)'}`,
    `- Storage runway: ${runwayText}`,
  ]
  if (value.estimate !== undefined) {
    const est = value.estimate
    const verdict = est.ready
      ? 'ready (no deposit or approval needed)'
      : est.canSelfFundFromWallet
        ? `needs ${est.depositNeededUsdfc} USDFC deposit${value.needsAllowanceUpdate ? ' + Warm Storage approval' : ''} — wallet can self-fund`
        : `BLOCKED — needs ${est.depositNeededUsdfc} USDFC deposit (wallet shortfall: ${est.walletShortfallUsdfc} USDFC${value.hasSufficientGas ? '' : ', insufficient gas'})`
    lines.push(
      `- Upload estimate (${est.fileSizeBytes} bytes, copies=${est.copies}, withCDN=${est.withCDN}, newDataSets=${est.newDataSetCount}): ${verdict}`,
    )
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Render a funding/approval outcome with verified post-commit balances and tx hash(es). */
function renderFundResult(value: FundResult): { type: 'text'; text: string }[] {
  const summary = value.adjusted
    ? `Filecoin Pay updated (${value.reason}): deposited ${value.depositedUsdfc} USDFC`
      + `${value.allowancesUpdated ? ', Warm Storage operator approved' : ''}`
      + `${value.transactionHash ? `, tx ${value.transactionHash}` : ''}`
      + `${value.allowanceTransactionHash ? `, approval tx ${value.allowanceTransactionHash}` : ''}.`
    : 'Filecoin Pay already meets target (no deposit or approval transaction needed).'
  const statusText = renderPaymentStatus(value.status)[0]?.text ?? ''
  return [{ type: 'text', text: `${summary}\n${statusText}` }]
}

/**
 * Provide `ctx.synapse` and register the Filecoin Synapse pin & payment tools.
 * @param ctx - Plugin context.
 * @param config - Validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const synapse = new SynapseRuntime(ctx, config.wallet, {
    rpcUrl: config.rpcUrl,
    networkMode: config.networkMode,
    withCDN: config.withCDN,
    copies: (config as any).copies,
    excludeProviderIds: (config as any).excludeProviderIds?.length ? (config as any).excludeProviderIds : undefined,
    providerIds: (config as any).providerIds?.length ? (config as any).providerIds : undefined,
    pieceLedgerPath: (config as any).pieceLedgerPath,
    autoFund: (config as any).autoFund,
    maxAutoFundUsdfc: (config as any).maxAutoFundUsdfc,
    autoFundRunwayDays: (config as any).autoFundRunwayDays,
  })
  ctx.provide('synapse', synapse)

  // The read-back hooks register lazily from the runtime's write paths
  // (mount-order-proof); this effect only retires them on disposal.
  ctx.effect(() => () => synapse.unhook())

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'synapse_pin',
    description: 'Persist content on Filecoin Onchain Cloud (Warm Storage) and pin it. '
      + 'Give a local file path to upload and pin it (returns root CID and CommP pieceCid), or an existing CID to verify/renew it. '
      + 'Storage is paid in USDFC deposited in Filecoin Pay (not native FIL gas). When autoFund is enabled (default), '
      + 'missing Warm Storage approval and deposit shortfalls are automatically funded from wallet USDFC before uploading.',
    parameters: {
      path: { type: 'string', description: 'Local file to upload and pin. Exactly one of path or cid.' },
      cid: { type: 'string', description: 'Existing content identifier to pin or renew. Exactly one of path or cid.' },
    },
    output: { schema: PIN_STATUS_SCHEMA, render: (_args, value) => renderStatus(value) },
    async execute(args: { path?: string; cid?: string }, exec): Promise<PinStatus> {
      console.log(`[synapse_pin] called path=${args.path ?? ''} cid=${args.cid ?? ''}`)
      if ((args.path === undefined) === (args.cid === undefined)) {
        throw new Error('provide exactly one of path or cid')
      }
      const signal: AbortSignal | undefined = (exec as any)?.signal
      const onProgress = (event: unknown) => {
        try { console.log(`[synapse_pin] progress ${JSON.stringify(event)?.slice(0, 300)}`) } catch {}
        try { (exec as any)?.onProgress?.(event) } catch {}
        try { (synapse as any).ctx?.emit?.('synapse/progress', event as any) } catch {}
      }
      try {
        const cid = args.path !== undefined
          ? (await synapse.store({ path: args.path }, signal, onProgress)).cid
          : args.cid as Cid
        console.log(`[synapse_pin] store done cid=${cid}, pinning...`)
        const st = await synapse.pin(cid, signal)
        console.log(`[synapse_pin] done ${JSON.stringify(st)}`)
        return st
      } catch (e: any) {
        console.log(`[synapse_pin] error ${e?.message ?? e} ${e?.stack?.slice(0, 600) ?? ''}`)
        throw e
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Pin ${args.path !== undefined ? basename(args.path) : args.cid ?? ''} on Synapse`,
      kind: 'execute',
    }),
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'synapse_pin_status',
    description: 'Check whether a CID is currently pinned on Filecoin Warm Storage.',
    parameters: {
      cid: { type: 'string', required: true, description: 'Content identifier to check.' },
    },
    output: { schema: PIN_STATUS_SCHEMA, render: (_args, value) => renderStatus(value) },
    execute: (args: { cid: string }, exec): Promise<PinStatus> => synapse.checkPin(args.cid, (exec as any)?.signal),
    presentCall: args => ({ card: 'generic', title: `Pin status of ${args.cid}`, kind: 'read' }),
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'synapse_payment_status',
    description: 'Inspect Filecoin storage payment state without spending gas: reports wallet FIL/tFIL gas, '
      + 'wallet USDFC balance, Filecoin Pay contract deposit (gross, locked, available), Warm Storage operator approval, '
      + 'and storage runway. Pass an optional local file path or fileSizeBytes for a free dry-run upload cost estimate.',
    parameters: {
      path: { type: 'string', description: 'Optional local file path to estimate upload deposit requirements for.' },
      fileSizeBytes: { type: 'number', description: 'Optional byte size to estimate upload deposit requirements for (alternative to path).' },
      targetRunwayDays: { type: 'number', description: 'Optional net runway days to include in the upload estimate (default configured autoFundRunwayDays).' },
    },
    output: { schema: PAYMENT_STATUS_SCHEMA, render: (_args, value) => renderPaymentStatus(value) },
    async execute(args: { path?: string; fileSizeBytes?: number; targetRunwayDays?: number }): Promise<PaymentStatusSnapshot> {
      if (args.path !== undefined && args.fileSizeBytes !== undefined) {
        throw new Error('provide at most one of path or fileSizeBytes')
      }
      const fileSizeBytes = args.path !== undefined ? (await stat(args.path)).size : args.fileSizeBytes
      return await synapse.paymentStatus({
        ...(fileSizeBytes !== undefined ? { fileSizeBytes } : {}),
        ...(args.targetRunwayDays !== undefined ? { targetRunwayDays: args.targetRunwayDays } : {}),
      })
    },
    presentCall: args => ({
      card: 'generic',
      title: args.path !== undefined ? `Check Filecoin Pay readiness for ${basename(args.path)}` : 'Check Filecoin Pay status',
      kind: 'read',
    }),
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'synapse_fund',
    description: 'Declaratively approve the Filecoin Warm Storage operator and deposit USDFC from the agent wallet '
      + 'into the Filecoin Pay contract (deposit-only, never withdraws). Idempotent: if the target deposit/runway and '
      + 'Warm Storage approval are already met on-chain, sends no transaction. '
      + 'Omit all targets (or pass setup:true) for automatic first-time setup from live pricing; or pass targetDepositUsdfc, '
      + 'targetRunwayDays, or a file path/fileSizeBytes to fund for a specific upload.',
    parameters: {
      setup: { type: 'boolean', description: 'Run auto-setup from live pricing (initial dataset lockups + 1 USDFC runway). Default when no target is given.' },
      targetDepositUsdfc: { type: 'string', description: 'Minimum gross deposited USDFC balance in Filecoin Pay (decimal string, e.g. "5" or "2.62").' },
      targetRunwayDays: { type: 'number', description: 'Minimum net storage runway in days (e.g. 30). May be combined with path or fileSizeBytes.' },
      path: { type: 'string', description: 'Optional local file path to size the funding plan for.' },
      fileSizeBytes: { type: 'number', description: 'Optional upcoming file size in bytes (alternative to path).' },
      maxDepositUsdfc: { type: 'string', description: 'Optional maximum USDFC ceiling this call is allowed to deposit (decimal string).' },
    },
    output: { schema: FUND_RESULT_SCHEMA, render: (_args, value) => renderFundResult(value) },
    async execute(args: {
      setup?: boolean
      targetDepositUsdfc?: string
      targetRunwayDays?: number
      path?: string
      fileSizeBytes?: number
      maxDepositUsdfc?: string
    }): Promise<FundResult> {
      if (args.path !== undefined && args.fileSizeBytes !== undefined) {
        throw new Error('provide at most one of path or fileSizeBytes')
      }
      const fileSizeBytes = args.path !== undefined ? (await stat(args.path)).size : args.fileSizeBytes
      return await synapse.fund({
        setup: args.setup,
        targetDepositUsdfc: args.targetDepositUsdfc,
        targetRunwayDays: args.targetRunwayDays,
        fileSizeBytes,
        maxDepositUsdfc: args.maxDepositUsdfc,
      })
    },
    presentCall: args => ({
      card: 'generic',
      title: args.targetDepositUsdfc !== undefined
        ? `Fund Filecoin Pay to ${args.targetDepositUsdfc} USDFC`
        : args.targetRunwayDays !== undefined
          ? `Fund Filecoin Pay for ${args.targetRunwayDays}d runway`
          : args.path !== undefined
            ? `Fund Filecoin Pay for ${basename(args.path)}`
            : 'Setup & fund Filecoin Pay',
      kind: 'execute',
    }),
  })))
}
