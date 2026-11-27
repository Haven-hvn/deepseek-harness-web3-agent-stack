/**
 * Filecoin Synapse transport for dsh-storage-synapse.
 *
 * Port of the reference js-services/synapse-wrapper.ts (filecoin-pin +
 * @filoz/synapse-sdk) — Filecoin Onchain Cloud only, no Kubo/localhost.
 * Uploads pay USDFC on calibration/mainnet via https://api.calibration.node.glif.io/rpc/v1
 * (plain HTTPS — Glif's wss endpoint fails SDK setup; `wss://` configs are
 * normalized to `https://` by normalizeRpcUrl).
 * No localhost:5001, no Kubo HTTP fallback.
 *
 * OWS / raw-key wallet seam (filecoin-pin AccountConfig): Synapse is
 * initialized with a pre-created viem Account whose signing callbacks
 * delegate to `ctx.wallet` — no raw private key in this package, its
 * configuration, or the process between requests.
 *
 * Payment model: Filecoin Onchain Cloud separates liquid EOA `USDFC` from
 * `Filecoin Pay` contract deposits (locked + available) and Warm Storage
 * operator allowances. This backend owns that EOA ↔ Filecoin Pay rail:
 * read-only status/cost inspection, idempotent deposit+approval (deposit-only,
 * never withdraws), and preflight + policy-bounded auto-funding before uploads.
 */

export type Cid = string

export interface PinStatus {
  readonly cid: Cid
  readonly provider: string
  readonly expiresAt: number
  readonly redundancy: number
  /** CommP piece CID carrying the root (present when the ledger maps it) — gated-record writers address this, never the root. */
  readonly pieceCid?: string | undefined
}

/** Dry-run cost & readiness estimate for uploading a specific byte size. */
export interface PaymentEstimate {
  readonly fileSizeBytes: number
  readonly copies: number
  readonly withCDN: boolean
  readonly newDataSetCount: number
  readonly ready: boolean
  readonly depositNeededRaw: string
  readonly depositNeededUsdfc: string
  readonly canSelfFundFromWallet: boolean
  readonly walletShortfallRaw: string
  readonly walletShortfallUsdfc: string
  readonly reasonCode: string
}

/** Complete read-only snapshot of EOA + Filecoin Pay (Warm Storage) state. */
export interface PaymentStatusSnapshot {
  readonly network: string
  /** Normalized chain slug (`filecoin-calibration` | `filecoin`). */
  readonly chain: string
  readonly chainId: number
  readonly address: string
  readonly filBalanceRaw: string
  readonly filBalance: string
  readonly hasSufficientGas: boolean
  /** Liquid USDFC in the agent's EOA wallet (not yet deposited into Filecoin Pay). */
  readonly walletUsdfcRaw: string
  readonly walletUsdfc: string
  /** Gross USDFC held in the Filecoin Pay contract (locked + available). */
  readonly depositedUsdfcRaw: string
  readonly depositedUsdfc: string
  /** USDFC currently reserved as lockup by active Warm Storage rails. */
  readonly lockedUsdfcRaw: string
  readonly lockedUsdfc: string
  /** Net USDFC in Filecoin Pay free above lockup & debt. */
  readonly availableUsdfcRaw: string
  readonly availableUsdfc: string
  readonly warmStorageApproved: boolean
  readonly needsAllowanceUpdate: boolean
  readonly spendRatePerDayRaw: string
  readonly spendRatePerDayUsdfc: string
  readonly runwayState: 'no-spend' | 'active'
  readonly runwayDays: number
  readonly runwayHours: number
  readonly coverageDays: number
  readonly coverageHours: number
  readonly estimate?: PaymentEstimate | undefined
}

/** Declarative, deposit-only funding target (never withdraws). */
export interface FundRequest {
  /** First-time / auto setup: covers dataset reserve + CDN lockups + 1 USDFC runway for configured copies. */
  readonly setup?: boolean | undefined
  /** Minimum gross deposited USDFC balance in Filecoin Pay (decimal string, e.g. `"5"` or `"2.62"`). */
  readonly targetDepositUsdfc?: string | undefined
  /** Minimum net storage runway in days (e.g. `30`). May be combined with `fileSizeBytes`. */
  readonly targetRunwayDays?: number | undefined
  /** Upcoming file/CAR size in bytes to include in the deposit calculation. */
  readonly fileSizeBytes?: number | undefined
  /** Optional ceiling on how much USDFC this single call may deposit (decimal string). */
  readonly maxDepositUsdfc?: string | undefined
}

/** Verified post-commit outcome of a Filecoin Pay funding/approval operation. */
export interface FundResult {
  readonly adjusted: boolean
  readonly allowancesUpdated: boolean
  readonly depositedRaw: string
  readonly depositedUsdfc: string
  readonly transactionHash?: string | undefined
  readonly allowanceTransactionHash?: string | undefined
  readonly reason: string
  readonly status: PaymentStatusSnapshot
}

export const internals: { fetch: typeof globalThis.fetch | undefined } = { fetch: undefined }
export function resolveFetch(): typeof globalThis.fetch { return internals.fetch ?? globalThis.fetch }
export function httpError(operation: string, response: Response): Error {
  return new Error(`dsh-storage-synapse: ${operation} failed: ${response.status} ${response.statusText}`)
}

export type SynapseMode = 'filecoin'

/** What a store commits: the CAR root plus the PDP piece that carries it. */
export interface PieceLedgerEntry {
  pieceCid: string
  providerId?: string | undefined
  storedAt: string
}

export const PIECE_LEDGER_VERSION = 1

/** Default per-operation auto-fund ceiling in whole USDFC. */
export const DEFAULT_MAX_AUTO_FUND_USDFC = '10'
/** Default net storage runway target (days) when auto-funding uploads. */
export const DEFAULT_AUTO_FUND_RUNWAY_DAYS = 30

const WEI_18 = 10n ** 18n
const INSUFFICIENT_LOCKUP_RE = /InsufficientLockupFunds[\s\S]*?\(\s*0x[0-9a-fA-F]+\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/

/** Format an 18-decimal token bigint cleanly without trailing fractional zeros. */
export function formatFixed18(raw: bigint, maxDecimals = 6): string {
  const negative = raw < 0n
  const abs = negative ? -raw : raw
  const whole = abs / WEI_18
  const frac = abs % WEI_18
  if (frac === 0n) return `${negative ? '-' : ''}${whole}`
  const padded = frac.toString().padStart(18, '0')
  const trimmedFull = padded.replace(/0+$/, '')
  // Preserve enough precision so tiny non-zero values (e.g. 0.0000001) don't collapse to "0".
  const sliceLen = Math.max(maxDecimals, padded.search(/[1-9]/) + 2)
  const capped = trimmedFull.slice(0, sliceLen).replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}.${capped || trimmedFull}`
}

/** Parse a non-negative whole-token decimal string (18 decimals) into wei. Throws loudly on invalid input. */
export function parseFixed18(value: string, fieldName = 'amount'): bigint {
  const trimmed = value.trim()
  if (!/^\d+(?:\.\d{1,18})?$/.test(trimmed)) {
    throw new Error(`dsh-storage-synapse: invalid ${fieldName} ${JSON.stringify(value)} — expected a non-negative decimal USDFC string (up to 18 decimals, e.g. "2.62")`)
  }
  const [wholePart, fracPart = ''] = trimmed.split('.')
  const whole = BigInt(wholePart || '0')
  const frac = BigInt(fracPart.padEnd(18, '0'))
  return whole * WEI_18 + frac
}

/** Normalize chainId / networkMode into the workspace's canonical Filecoin chain slug. */
export function chainSlugForNetwork(chainId?: number, networkMode?: 'calibration' | 'mainnet'): string {
  if (chainId === 314) return 'filecoin'
  if (chainId === 314159) return 'filecoin-calibration'
  return networkMode === 'mainnet' ? 'filecoin' : 'filecoin-calibration'
}

/** Walk an error + nested cause chain into a single searchable string. */
function collectErrorText(error: unknown, depth = 0): string {
  if (error === null || error === undefined || depth > 10) return ''
  if (typeof error === 'string') return error
  if (typeof error === 'object') {
    const rec = error as { message?: unknown; cause?: unknown }
    const msg = typeof rec.message === 'string' ? rec.message : ''
    return `${msg}\n${collectErrorText(rec.cause, depth + 1)}`
  }
  return String(error)
}

/** Parse WarmStorage `InsufficientLockupFunds(payer, minimumRequired, available)` from an error chain. */
export function parseInsufficientLockup(error: unknown): { minimumRequired: bigint; available: bigint } | null {
  const match = collectErrorText(error).match(INSUFFICIENT_LOCKUP_RE)
  if (!match?.[1] || !match[2]) return null
  return { minimumRequired: BigInt(match[1]), available: BigInt(match[2]) }
}

/**
 * Translate a WarmStorage `InsufficientLockupFunds` revert into a clear,
 * agent-actionable error naming USDFC amounts (not raw 18-decimal wei).
 */
export function decorateLockupError(error: unknown, address?: string): Error | null {
  const shortfall = parseInsufficientLockup(error)
  if (shortfall === null) return null
  const missing = shortfall.minimumRequired > shortfall.available
    ? shortfall.minimumRequired - shortfall.available
    : 0n
  const who = address ? ` for ${address}` : ''
  return new Error(
    `dsh-storage-synapse: insufficient USDFC locked in Filecoin Pay${who} — `
    + `Warm Storage requires ${formatFixed18(shortfall.minimumRequired)} USDFC available, `
    + `only ${formatFixed18(shortfall.available)} USDFC is available `
    + `(shortfall ${formatFixed18(missing)} USDFC; native FIL gas cannot pay for storage). `
    + `Call synapse_payment_status to inspect wallet vs. Filecoin Pay balances, or synapse_fund to deposit USDFC.`,
    { cause: error instanceof Error ? error : undefined },
  )
}

/**
 * Provider-selection failures happen before anything is committed: no dataset,
 * no lockup, no spend — the SDK throws while choosing who stores the bytes.
 * Safe to retry with different selection inputs; anything later in the flow
 * (mid-upload faults) must surface, never silently re-drive, because the
 * first attempt may have locked funds.
 */
export function isProviderSelectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return message.includes('No endorsed provider available')
}

/**
 * Log-safe preview: upload results carry BigInts (dataset ids, fees) that
 * crash bare JSON.stringify — turning a committed pin into a thrown error.
 */
export function preview(value: unknown, max = 500): string {
  try {
    return (JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? `${entry}n` : entry) ?? '').slice(0, max)
  } catch {
    return String(value).slice(0, max)
  }
}

type SynapseInstance = import('@filoz/synapse-sdk').Synapse
type Account = import('viem').Account

export interface FilecoinBackendOpts {
  /** Resolver that returns a viem Account delegating to ctx.wallet — per operation, never cached. */
  getAccount: () => Promise<Account>
  rpcUrl: string
  networkMode?: 'calibration' | 'mainnet' | undefined
  withCDN?: boolean | undefined
  copies?: number | undefined
  excludeProviderIds?: bigint[] | undefined
  providerIds?: bigint[] | undefined
  /** Optional JSON path persisting the root→piece ledger across restarts (best-effort, 0600). */
  pieceLedgerPath?: string | undefined
  /**
   * Automatically approve Warm Storage and top up Filecoin Pay from wallet USDFC
   * before uploading when deposited funds or allowances are insufficient.
   * Default `true` everywhere (bounded by `maxAutoFundUsdfc`).
   */
  autoFund?: boolean | undefined
  /** Maximum USDFC a single auto-fund operation may deposit (decimal string, default `"10"`). */
  maxAutoFundUsdfc?: string | undefined
  /** Target net storage runway in days when auto-funding uploads (default `30`). */
  autoFundRunwayDays?: number | undefined
  /** Wallet-lane serializer (`ctx.wallet.withLock`) for nonce-bearing on-chain transactions. */
  withWalletLock?: (<T>(task: () => Promise<T>) => Promise<T>) | undefined
  /** Audit callback invoked strictly after an on-chain Filecoin Pay funding/approval commits. */
  onFunded?: ((result: FundResult) => void) | undefined
}

/**
 * Glif's calibration WebSocket endpoint fails SDK setup with viem's
 * "An unknown RPC error occurred ... non-101 status code", while the same
 * URL over HTTPS works. Normalize websocket schemes to plain HTTP(S) up
 * front so a `wss://` rpcUrl can never break initialization — the SDK's
 * subscriptions do not need a raw socket here (chain reads already go
 * over HTTPS in `providerUrls`).
 */
export function normalizeRpcUrl(rpcUrl: string): string {
  return rpcUrl.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:')
}

export class FilecoinBackend {
  private synapse: SynapseInstance | null = null
  /** Root CID → piece that carries it. checkPin verifies the piece live; without an entry it cannot map root→piece. */
  private readonly pieces = new Map<string, PieceLedgerEntry>()
  private ledgerLoaded = false
  private readonly opts: FilecoinBackendOpts

  constructor(opts: FilecoinBackendOpts) {
    this.opts = { ...opts, rpcUrl: normalizeRpcUrl(opts.rpcUrl) }
  }

  /** Run a nonce-bearing on-chain step inside the wallet lane when provided. */
  private async runLocked<T>(task: () => Promise<T>): Promise<T> {
    return this.opts.withWalletLock ? await this.opts.withWalletLock(task) : await task()
  }

  /** Load the persisted ledger once; missing/corrupt/legacy files start empty, never throw. */
  private async ensureLedger(): Promise<void> {
    if (this.ledgerLoaded) return
    this.ledgerLoaded = true
    if (!this.opts.pieceLedgerPath) return
    try {
      const { readFile } = await import('node:fs/promises')
      const raw = JSON.parse(await readFile(this.opts.pieceLedgerPath, 'utf8')) as {
        version?: unknown; pieces?: Record<string, { pieceCid?: unknown; providerId?: unknown; storedAt?: unknown }>
      }
      if (raw?.version !== PIECE_LEDGER_VERSION || typeof raw?.pieces !== 'object' || raw.pieces === null) return
      const { tryFrom: tryPieceFrom } = await import('@filoz/synapse-core/piece')
      for (const [cid, entry] of Object.entries(raw.pieces)) {
        // Only canonical PieceCIDs enter the ledger: a malformed entry can
        // never be verified live, and handing it on would catalog bytes no
        // player can address.
        const piece = typeof entry?.pieceCid === 'string' ? tryPieceFrom(entry.pieceCid) : null
        if (piece !== null) {
          this.pieces.set(cid, {
            pieceCid: piece.toString(),
            providerId: typeof entry.providerId === 'string' ? entry.providerId : undefined,
            storedAt: typeof entry.storedAt === 'string' ? entry.storedAt : new Date(0).toISOString(),
          })
        }
      }
      console.log(`[synapse] piece ledger loaded ${this.pieces.size} entries from ${this.opts.pieceLedgerPath}`)
    } catch (e: any) {
      console.log(`[synapse] piece ledger unreadable (${e?.message ?? e}) — starting empty`)
    }
  }

  /** Persist the ledger atomically (tmp + rename, 0600); failures degrade to memory-only, never throw. */
  private async persistLedger(): Promise<void> {
    if (!this.opts.pieceLedgerPath) return
    try {
      const { mkdir, rename, writeFile } = await import('node:fs/promises')
      const { dirname } = await import('node:path')
      await mkdir(dirname(this.opts.pieceLedgerPath), { recursive: true })
      const body = JSON.stringify({ version: PIECE_LEDGER_VERSION, pieces: Object.fromEntries(this.pieces) })
      const tmp = `${this.opts.pieceLedgerPath}.tmp-${process.pid}`
      await writeFile(tmp, body, { mode: 0o600 })
      await rename(tmp, this.opts.pieceLedgerPath)
    } catch (e: any) {
      console.log(`[synapse] piece ledger save failed (${e?.message ?? e}) — memory-only`)
    }
  }

  private async ensureSynapse(): Promise<SynapseInstance> {
    if (this.synapse) return this.synapse
    const { initializeSynapse } = await import('filecoin-pin/core/synapse')
    const account = await this.opts.getAccount()
    // filecoin-pin AccountConfig: { account, rpcUrl, withCDN } — wallet-gated, no privateKey
    const synapse: SynapseInstance = await (initializeSynapse as any)({
      account,
      rpcUrl: this.opts.rpcUrl,
      ...(this.opts.withCDN !== undefined ? { withCDN: this.opts.withCDN } : {}),
    })
    this.synapse = synapse
    return synapse
  }

  /** Resolve candidate storage contexts for cost estimation (mirrors upload's exclusion fallback). */
  private async resolveEstimateContexts(synapse: any): Promise<any[] | undefined> {
    if (typeof synapse?.storage?.createContexts !== 'function') return undefined
    const copies = this.opts.providerIds?.length ?? this.opts.copies ?? 1
    const buildArgs = (excludeProviderIds?: bigint[]) => ({
      copies,
      ...(this.opts.providerIds ? { providerIds: this.opts.providerIds } : {}),
      ...(excludeProviderIds?.length ? { excludeProviderIds } : {}),
      withCDN: this.opts.withCDN === true,
    })
    try {
      return await synapse.storage.createContexts(buildArgs(this.opts.excludeProviderIds))
    } catch (err: unknown) {
      if (this.opts.excludeProviderIds?.length && !this.opts.providerIds && isProviderSelectionError(err)) {
        try {
          return await synapse.storage.createContexts(buildArgs(undefined))
        } catch {
          return undefined
        }
      }
      return undefined
    }
  }

  /**
   * Read live on-chain payment state (EOA gas + EOA USDFC + Filecoin Pay deposit/lockup/runway +
   * Warm Storage operator approval). Pure read — zero signing, zero spend.
   */
  async paymentStatus(opts?: { fileSizeBytes?: number; targetRunwayDays?: number }): Promise<PaymentStatusSnapshot> {
    const synapse: any = await this.ensureSynapse()
    const payments = await import('filecoin-pin/core/payments')
    const [status, accountSummary, allowanceCheck] = await Promise.all([
      payments.getPaymentStatus(synapse),
      synapse.payments.accountSummary({}),
      payments.checkAllowances(synapse),
    ])
    const runway = payments.toStorageRunwaySummary(accountSummary)
    const chain = chainSlugForNetwork(status.chainId, this.opts.networkMode)
    const hasSufficientGas = status.filBalance >= payments.MIN_FIL_FOR_GAS
    let estimate: PaymentEstimate | undefined

    if (opts?.fileSizeBytes !== undefined) {
      const plan = await this.planForPiece(synapse, payments, status, accountSummary, opts.fileSizeBytes, opts.targetRunwayDays)
      const depositNeeded = plan.delta > 0n ? plan.delta : 0n
      const walletShortfall = depositNeeded > status.walletUsdfcBalance ? depositNeeded - status.walletUsdfcBalance : 0n
      estimate = {
        fileSizeBytes: opts.fileSizeBytes,
        copies: this.opts.providerIds?.length ?? this.opts.copies ?? 1,
        withCDN: this.opts.withCDN === true,
        newDataSetCount: plan.newDataSetCount,
        ready: hasSufficientGas && !allowanceCheck.needsUpdate && depositNeeded === 0n,
        depositNeededRaw: depositNeeded.toString(),
        depositNeededUsdfc: formatFixed18(depositNeeded),
        canSelfFundFromWallet: hasSufficientGas && walletShortfall === 0n,
        walletShortfallRaw: walletShortfall.toString(),
        walletShortfallUsdfc: formatFixed18(walletShortfall),
        reasonCode: plan.reasonCode,
      }
    }

    return {
      network: status.network,
      chain,
      chainId: status.chainId,
      address: status.address,
      filBalanceRaw: status.filBalance.toString(),
      filBalance: formatFixed18(status.filBalance),
      hasSufficientGas,
      walletUsdfcRaw: status.walletUsdfcBalance.toString(),
      walletUsdfc: formatFixed18(status.walletUsdfcBalance),
      depositedUsdfcRaw: status.filecoinPayBalance.toString(),
      depositedUsdfc: formatFixed18(status.filecoinPayBalance),
      lockedUsdfcRaw: runway.lockupUsed.toString(),
      lockedUsdfc: formatFixed18(runway.lockupUsed),
      availableUsdfcRaw: runway.availableFunds.toString(),
      availableUsdfc: formatFixed18(runway.availableFunds),
      warmStorageApproved: Boolean(status.currentAllowances?.isApproved) && !allowanceCheck.needsUpdate,
      needsAllowanceUpdate: allowanceCheck.needsUpdate,
      spendRatePerDayRaw: runway.perDay.toString(),
      spendRatePerDayUsdfc: formatFixed18(runway.perDay),
      runwayState: runway.state,
      runwayDays: runway.runwayDays,
      runwayHours: runway.runwayHours,
      coverageDays: runway.coverageDays,
      coverageHours: runway.coverageHours,
      ...(estimate !== undefined ? { estimate } : {}),
    }
  }

  /**
   * Compute exact deposit delta needed for an upload of `fileSizeBytes` + `targetRunwayDays`.
   * Prefers reserve-aware `calculateMultiContextCosts` when storage contexts resolve, and
   * falls back cleanly to priceList-based calculation otherwise.
   */
  private async planForPiece(
    synapse: any,
    payments: typeof import('filecoin-pin/core/payments'),
    status: Awaited<ReturnType<typeof import('filecoin-pin/core/payments').getPaymentStatus>>,
    accountSummary: any,
    fileSizeBytes: number,
    targetRunwayDays?: number,
  ): Promise<{ delta: bigint; newDataSetCount: number; reasonCode: string }> {
    const days = Math.max(0, Math.floor(targetRunwayDays ?? this.opts.autoFundRunwayDays ?? DEFAULT_AUTO_FUND_RUNWAY_DAYS))
    const copies = this.opts.providerIds?.length ?? this.opts.copies ?? 1
    const withCDN = this.opts.withCDN === true
    const contexts = await this.resolveEstimateContexts(synapse)

    if (contexts && contexts.length > 0 && typeof synapse?.storage?.calculateMultiContextCosts === 'function') {
      const { TIME_CONSTANTS } = await import('@filoz/synapse-sdk')
      const uploadCosts = await synapse.storage.calculateMultiContextCosts(contexts, {
        pieceSizes: [BigInt(Math.max(1, fileSizeBytes))],
        ...(days > 0 ? { extraRunwayEpochs: BigInt(days) * TIME_CONSTANTS.EPOCHS_PER_DAY } : {}),
      })
      const newDataSetCount = contexts.filter((c: any) => c.dataSetId === null || c.dataSetId === undefined).length
      const plan = payments.calculateFilecoinPayFundingPlan({
        status,
        accountSummary,
        targetRunwayDays: days,
        pieceSizeBytes: fileSizeBytes,
        newDataSetCount,
        withCDN,
        uploadCosts,
        mode: 'minimum',
        allowWithdraw: false,
      })
      return { delta: plan.delta > 0n ? plan.delta : 0n, newDataSetCount, reasonCode: plan.reasonCode }
    }

    // Fallback when context resolution is unavailable (e.g. offline/mocked storage manager).
    const storageInfo = await synapse.storage.getStorageInfo()
    const priceList = storageInfo.pricing.priceList
    const newDataSetCount = status.filecoinPayBalance === 0n ? copies : 0
    const plan = payments.calculateFilecoinPayFundingPlan({
      status,
      accountSummary,
      targetRunwayDays: days,
      pieceSizeBytes: fileSizeBytes,
      priceList,
      newDataSetCount,
      withCDN,
      mode: 'minimum',
      allowWithdraw: false,
    })
    return { delta: plan.delta > 0n ? plan.delta : 0n, newDataSetCount, reasonCode: plan.reasonCode }
  }

  /**
   * Declarative, idempotent Filecoin Pay funding & Warm Storage operator approval.
   * Deposit-only — never withdraws USDFC back out of Filecoin Pay.
   * Safe to retry after crashes/timeouts: if the target balance and operator approval
   * are already met on-chain, performs zero transactions and returns verified status.
   */
  async fund(req: FundRequest = {}): Promise<FundResult> {
    if (req.targetDepositUsdfc !== undefined && req.targetRunwayDays !== undefined) {
      throw new Error('dsh-storage-synapse: specify either targetDepositUsdfc or targetRunwayDays, not both')
    }
    if (req.setup && (req.targetDepositUsdfc !== undefined || req.targetRunwayDays !== undefined)) {
      throw new Error('dsh-storage-synapse: setup cannot be combined with targetDepositUsdfc or targetRunwayDays')
    }
    if (req.targetRunwayDays !== undefined && (!Number.isFinite(req.targetRunwayDays) || req.targetRunwayDays < 0)) {
      throw new Error(`dsh-storage-synapse: targetRunwayDays must be a non-negative number, got ${req.targetRunwayDays}`)
    }
    if (req.fileSizeBytes !== undefined && (!Number.isFinite(req.fileSizeBytes) || req.fileSizeBytes < 0)) {
      throw new Error(`dsh-storage-synapse: fileSizeBytes must be a non-negative number, got ${req.fileSizeBytes}`)
    }
    const maxDepositCap = req.maxDepositUsdfc !== undefined ? parseFixed18(req.maxDepositUsdfc, 'maxDepositUsdfc') : undefined

    const synapse: any = await this.ensureSynapse()
    const payments = await import('filecoin-pin/core/payments')
    const [status, accountSummary, allowanceCheck] = await Promise.all([
      payments.getPaymentStatus(synapse),
      synapse.payments.accountSummary({}),
      payments.checkAllowances(synapse),
    ])
    const isCalibnet = status.chainId === 314159
    const chain = chainSlugForNetwork(status.chainId, this.opts.networkMode)
    const copies = this.opts.providerIds?.length ?? this.opts.copies ?? 1

    let delta = 0n
    let reason = 'already-funded'

    if (req.targetDepositUsdfc !== undefined) {
      const target = parseFixed18(req.targetDepositUsdfc, 'targetDepositUsdfc')
      delta = target > status.filecoinPayBalance ? target - status.filecoinPayBalance : 0n
      reason = delta > 0n ? 'target-deposit' : 'already-funded'
    } else if (req.fileSizeBytes !== undefined) {
      const planned = await this.planForPiece(synapse, payments, status, accountSummary, req.fileSizeBytes, req.targetRunwayDays)
      delta = planned.delta
      reason = delta > 0n ? planned.reasonCode : 'already-funded'
    } else if (req.targetRunwayDays !== undefined) {
      if (accountSummary.lockupRatePerEpoch > 0n) {
        const plan = payments.calculateFilecoinPayFundingPlan({
          status,
          accountSummary,
          targetRunwayDays: req.targetRunwayDays,
          mode: 'minimum',
          allowWithdraw: false,
        })
        delta = plan.delta > 0n ? plan.delta : 0n
        reason = delta > 0n ? plan.reasonCode : 'already-funded'
      } else {
        // No active spend yet: bootstrap with auto-setup target so the agent has initial dataset + runway funds.
        const storageInfo = await synapse.storage.getStorageInfo()
        const { targetBalance } = payments.computeAutoSetupTargetBalance({
          filecoinPayBalance: status.filecoinPayBalance,
          availableFunds: accountSummary.availableFunds,
          copies,
          priceList: storageInfo.pricing.priceList,
        })
        delta = targetBalance > status.filecoinPayBalance ? targetBalance - status.filecoinPayBalance : 0n
        reason = delta > 0n ? 'auto-setup' : 'already-funded'
      }
    } else {
      // Default (`setup: true` or empty `{}`): auto-setup from live on-chain pricing.
      const storageInfo = await synapse.storage.getStorageInfo()
      const { targetBalance } = payments.computeAutoSetupTargetBalance({
        filecoinPayBalance: status.filecoinPayBalance,
        availableFunds: accountSummary.availableFunds,
        copies,
        priceList: storageInfo.pricing.priceList,
      })
      delta = targetBalance > status.filecoinPayBalance ? targetBalance - status.filecoinPayBalance : 0n
      reason = delta > 0n ? 'auto-setup' : 'already-funded'
    }

    const needsDeposit = delta > 0n
    const needsApproval = allowanceCheck.needsUpdate

    if (!needsDeposit && !needsApproval) {
      const currentSnap = await this.paymentStatus(
        req.fileSizeBytes !== undefined ? { fileSizeBytes: req.fileSizeBytes, targetRunwayDays: req.targetRunwayDays } : undefined,
      )
      return {
        adjusted: false,
        allowancesUpdated: false,
        depositedRaw: '0',
        depositedUsdfc: '0',
        reason: 'already-funded',
        status: currentSnap,
      }
    }

    // Validate native gas before attempting any on-chain transaction.
    const gasCheck = payments.validateGasRequirement(status.filBalance, isCalibnet)
    if (!gasCheck.isValid) {
      const help = gasCheck.helpMessage ? ` ${gasCheck.helpMessage}` : ''
      throw new Error(
        `dsh-storage-synapse: cannot fund Filecoin Pay on ${chain} for ${status.address} — ${gasCheck.errorMessage}.${help}`,
      )
    }

    if (needsDeposit) {
      if (maxDepositCap !== undefined && delta > maxDepositCap) {
        throw new Error(
          `dsh-storage-synapse: required Filecoin Pay deposit (${formatFixed18(delta)} USDFC) exceeds `
          + `configured cap (${formatFixed18(maxDepositCap)} USDFC) for ${status.address} on ${chain}. `
          + `Wallet holds ${formatFixed18(status.walletUsdfcBalance)} USDFC; call synapse_fund with an explicit `
          + `maxDepositUsdfc or targetDepositUsdfc to authorize a larger deposit.`,
        )
      }
      if (status.walletUsdfcBalance < delta) {
        const shortfall = delta - status.walletUsdfcBalance
        const help = payments.getUsdfcAcquisitionHelpMessage(isCalibnet)
        throw new Error(
          `dsh-storage-synapse: insufficient USDFC in wallet ${status.address} on ${chain} to fund Filecoin Pay — `
          + `need ${formatFixed18(delta)} USDFC deposit, wallet holds ${formatFixed18(status.walletUsdfcBalance)} USDFC `
          + `(Filecoin Pay deposited: ${formatFixed18(status.filecoinPayBalance)} USDFC; shortfall: ${formatFixed18(shortfall)} USDFC; `
          + `native FIL gas cannot substitute for USDFC). Fund the wallet with USDFC first. ${help}`,
        )
      }
    }

    let transactionHash: string | undefined
    let allowanceTransactionHash: string | undefined
    let allowancesUpdated = false

    await this.runLocked(async () => {
      if (needsDeposit) {
        console.log(`[synapse] depositing ${formatFixed18(delta)} USDFC into Filecoin Pay (needsApproval=${needsApproval}, reason=${reason})`)
        const { depositTx } = await payments.depositUSDFC(synapse, delta)
        transactionHash = depositTx
        allowancesUpdated = needsApproval
        console.log(`[synapse] deposit committed tx=${depositTx}`)
      } else if (needsApproval) {
        console.log('[synapse] setting Warm Storage operator allowances (deposit already sufficient)')
        const res = await payments.checkAndSetAllowances(synapse)
        allowancesUpdated = res.updated
        allowanceTransactionHash = res.transactionHash
        reason = res.updated ? 'approve-only' : 'already-funded'
        console.log(`[synapse] allowances updated=${res.updated} tx=${res.transactionHash ?? '(none)'}`)
      }
    })

    // Read back fresh on-chain state after commit as authoritative evidence.
    const postStatus = await this.paymentStatus(
      req.fileSizeBytes !== undefined ? { fileSizeBytes: req.fileSizeBytes, targetRunwayDays: req.targetRunwayDays } : undefined,
    )
    const result: FundResult = {
      adjusted: needsDeposit || allowancesUpdated,
      allowancesUpdated,
      depositedRaw: delta.toString(),
      depositedUsdfc: formatFixed18(delta),
      ...(transactionHash !== undefined ? { transactionHash } : {}),
      ...(allowanceTransactionHash !== undefined ? { allowanceTransactionHash } : {}),
      reason: needsDeposit ? reason : (allowancesUpdated ? 'approve-only' : 'already-funded'),
      status: postStatus,
    }
    if (result.adjusted) {
      try {
        this.opts.onFunded?.(result)
      } catch {}
    }
    return result
  }

  /**
   * Preflight payment readiness before transferring bytes to any storage provider.
   * When `autoFund` is enabled (default `true` everywhere), tops up Filecoin Pay from
   * wallet USDFC and approves Warm Storage automatically up to `maxAutoFundUsdfc`.
   * Fails loud and early on gas shortage, wallet USDFC shortage, cap exceeded, or
   * `autoFund: false` — never wasting upload bandwidth only to revert on-chain.
   */
  private async preflightUploadFunding(synapse: any, carSizeBytes: number): Promise<void> {
    // Skip only when running against a bare test stub that lacks the SDK payment surface.
    if (typeof synapse?.payments?.accountSummary !== 'function') return

    const snap = await this.paymentStatus({
      fileSizeBytes: carSizeBytes,
      targetRunwayDays: this.opts.autoFundRunwayDays ?? DEFAULT_AUTO_FUND_RUNWAY_DAYS,
    })
    const estimate = snap.estimate
    if (!estimate || estimate.ready) return

    const isCalibnet = snap.chainId === 314159
    if (!snap.hasSufficientGas) {
      const payments = await import('filecoin-pin/core/payments')
      const gasCheck = payments.validateGasRequirement(BigInt(snap.filBalanceRaw), isCalibnet)
      const help = gasCheck.helpMessage ? ` ${gasCheck.helpMessage}` : ''
      throw new Error(
        `dsh-storage-synapse: cannot upload on ${snap.chain} for ${snap.address} — ${gasCheck.errorMessage}.${help}`,
      )
    }

    const needed = BigInt(estimate.depositNeededRaw)
    const walletUsdfc = BigInt(snap.walletUsdfcRaw)
    if (needed > walletUsdfc) {
      const payments = await import('filecoin-pin/core/payments')
      const help = payments.getUsdfcAcquisitionHelpMessage(isCalibnet)
      throw new Error(
        `dsh-storage-synapse: insufficient USDFC to pin on ${snap.chain} for ${snap.address} — `
        + `upload needs ${estimate.depositNeededUsdfc} USDFC deposited into Filecoin Pay, `
        + `but wallet holds ${snap.walletUsdfc} USDFC and Filecoin Pay has ${snap.availableUsdfc} USDFC available `
        + `(${snap.depositedUsdfc} deposited, ${snap.lockedUsdfc} locked; shortfall: ${estimate.walletShortfallUsdfc} USDFC; `
        + `native FIL gas cannot pay for storage). Fund ${snap.address} with USDFC first. ${help}`,
      )
    }

    const autoFundEnabled = this.opts.autoFund ?? true
    if (!autoFundEnabled) {
      const parts: string[] = []
      if (needed > 0n) parts.push(`deposit ${estimate.depositNeededUsdfc} USDFC into Filecoin Pay`)
      if (snap.needsAllowanceUpdate) parts.push('approve Warm Storage operator allowances')
      throw new Error(
        `dsh-storage-synapse: Filecoin Pay not ready on ${snap.chain} for ${snap.address} (autoFund is disabled) — `
        + `need to ${parts.join(' and ')}. Wallet holds ${snap.walletUsdfc} USDFC (deposited: ${snap.depositedUsdfc}, `
        + `available: ${snap.availableUsdfc}). Call synapse_fund first, then retry synapse_pin.`,
      )
    }

    const capStr = this.opts.maxAutoFundUsdfc ?? DEFAULT_MAX_AUTO_FUND_USDFC
    await this.fund({
      fileSizeBytes: carSizeBytes,
      targetRunwayDays: this.opts.autoFundRunwayDays ?? DEFAULT_AUTO_FUND_RUNWAY_DAYS,
      maxDepositUsdfc: capStr,
    })
  }

  async store(data: Uint8Array, opts?: { onProgress?: (event: unknown) => void; signal?: AbortSignal }): Promise<{ cid: Cid; pieceCid?: string | undefined }> {
    console.log(`[synapse] store start bytes=${data.length}`)
    const synapse = await this.ensureSynapse()
    console.log(`[synapse] synapse ready`)
    const { executeUpload } = await import('filecoin-pin/core/upload')
    const { CID } = await import('multiformats/cid')
    const { packSingleBlockCar } = await import('./singleBlockCar.ts')
    // Single-block CAR at every size (see ./singleBlockCar.ts): chunked
    // UnixFS roots fail readers' root check, one raw block always strips.
    // In-memory — no temp input file, nothing to clean up on any exit.
    const car = packSingleBlockCar(data)
    const carBytes = car.carBytes
    console.log(`[synapse] CAR built rootCid=${car.rootCid} carBytes=${carBytes.length}`)
    // Preflight gas, Warm Storage allowances, and Filecoin Pay capacity BEFORE
    // streaming bytes to any storage provider (auto-funding from wallet USDFC
    // by default within maxAutoFundUsdfc).
    await this.preflightUploadFunding(synapse, carBytes.length)
    const rootCid: any = CID.parse(car.rootCid)
    const log = (lvl: string, ...a: any[]) => { try { console.log(`[synapse:${lvl}]`, ...a) } catch {} }
    const logger: any = { debug: (...a: any[]) => log('debug', ...a), info: (...a: any[]) => log('info', ...a), warn: (...a: any[]) => log('warn', ...a), error: (...a: any[]) => log('error', ...a) }
    const baseOpts: any = {
      logger,
      ipniValidation: { enabled: false },
      ...(opts?.onProgress ? { onProgress: opts.onProgress } : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
      ...(this.opts.copies !== undefined ? { copies: this.opts.copies } : {}),
      ...(this.opts.providerIds ? { providerIds: this.opts.providerIds } : {}),
    }
    let result: any
    try {
      result = await this.runUpload(executeUpload, synapse, carBytes, rootCid, baseOpts, this.opts.excludeProviderIds, 'primary')
    } catch (primaryError: unknown) {
      // Calibration's endorsed set is tiny (it has been exactly the once-excluded
      // [4, 9]) and it shifts without notice — a stale exclusion list fails
      // selection with zero candidates. One fallback without exclusions, loudly
      // logged; explicit providerIds are the operator's deliberate target and
      // are never second-guessed.
      if (this.opts.excludeProviderIds?.length && !this.opts.providerIds && isProviderSelectionError(primaryError)) {
        console.log(`[synapse] primary selection failed with exclusions [${this.opts.excludeProviderIds.join(',')}]; retrying once without exclusions`)
        try {
          result = await this.runUpload(executeUpload, synapse, carBytes, rootCid, baseOpts, undefined, 'fallback-no-exclusions')
        } catch (fallbackError: unknown) {
          throw decorateLockupError(fallbackError) ?? fallbackError
        }
      } else {
        throw decorateLockupError(primaryError) ?? primaryError
      }
    }
    const cid: string = car?.rootCid ?? result?.cid ?? result?.rootCid ?? ''
    if (!cid) throw new Error('dsh-storage-synapse: filecoin store returned empty CID')
    // Canonicalize through the PieceCID parser before anything records it:
    // an unparseable piece (truncated, wrong codec, root CID in its place)
    // fails the upload here instead of reaching a catalog downstream.
    const rawPiece: unknown = result?.pieceCid ?? result?.piece
    let pieceCid: string | undefined
    if (typeof rawPiece === 'string' && rawPiece !== '') {
      const { tryFrom: tryPieceFrom } = await import('@filoz/synapse-core/piece')
      const parsed = tryPieceFrom(rawPiece)
      if (parsed === null) {
        throw new Error(`dsh-storage-synapse: upload returned an invalid PieceCID (${JSON.stringify(rawPiece)}) — refusing to record an unaddressable piece`)
      }
      pieceCid = parsed.toString()
    }
    // Record the root→piece mapping checkPin verifies against. The first copy's
    // provider is a hint only — verification sweeps every approved provider.
    if (typeof pieceCid === 'string' && pieceCid !== '') {
      const firstCopy = Array.isArray(result?.copies) ? result.copies[0] : undefined
      const providerId = firstCopy?.providerId
      await this.ensureLedger()
      this.pieces.set(cid, {
        pieceCid,
        providerId: typeof providerId === 'bigint' ? providerId.toString() : undefined,
        storedAt: new Date().toISOString(),
      })
      await this.persistLedger()
    }
    return { cid, pieceCid }
  }

  /** One upload attempt against filecoin-pin; selection inputs vary per attempt, the CAR is built once. */
  private async runUpload(
    executeUpload: unknown,
    synapse: SynapseInstance,
    carBytes: any,
    rootCid: any,
    baseOpts: any,
    excludeProviderIds: bigint[] | undefined,
    label: string,
  ): Promise<any> {
    const uploadOpts: any = {
      ...baseOpts,
      ...(excludeProviderIds?.length ? { excludeProviderIds } : {}),
    }
    console.log(`[synapse] executeUpload start copies=${this.opts.copies} exclude=${excludeProviderIds?.join(',') ?? '(none)'} attempt=${label}`)
    try {
      const result = await (executeUpload as any)(synapse, carBytes, rootCid, uploadOpts)
      console.log(`[synapse] executeUpload done result=${preview(result)}`)
      return result
    } catch (e: any) {
      console.log(`[synapse] executeUpload error attempt=${label} ${e?.message ?? e} ${e?.stack?.slice(0, 500) ?? ''}`)
      throw e
    }
  }

  async retrieve(cid: Cid, signal?: AbortSignal): Promise<Uint8Array> {
    const synapse: any = await this.ensureSynapse()
    if (typeof synapse.download === 'function') {
      const out: Uint8Array = await synapse.download(cid, { signal } as any)
      return out
    }
    throw new Error(`dsh-storage-synapse: retrieve(${cid}) not yet wired for filecoin backend without synapse.download`)
  }

  /**
   * True liveness read: the ledger maps the root CID to its PDP piece, and the
   * piece is asked for live on the approved providers (`findPiece`). A root CID
   * alone cannot derive its piece (commP needs the bytes), so CIDs this backend
   * never stored — or stored before the ledger existed — answer "not pinned"
   * rather than guess. Fail-soft throughout: an unreadable network is
   * unhealthy, never an exception.
   */
  async checkPin(cid: Cid): Promise<PinStatus> {
    const notPinned = { cid, provider: 'filecoin', expiresAt: -1, redundancy: 0 }
    try {
      await this.ensureLedger()
      const entry = this.pieces.get(cid)
      if (!entry) return notPinned
      const { findPiece } = await import('@filoz/synapse-core/sp')
      const { from: pieceFrom } = await import('@filoz/synapse-core/piece')
      const piece = pieceFrom(entry.pieceCid)
      for (const serviceURL of await this.providerUrls(entry.providerId)) {
        try {
          await findPiece({ serviceURL, pieceCid: piece, timeout: 15000 })
          console.log(`[synapse] checkPin ${cid} pinned (piece ${entry.pieceCid} on ${serviceURL})`)
          return { cid, provider: 'filecoin', expiresAt: 0, redundancy: 1, pieceCid: entry.pieceCid }
        } catch {
          // This provider doesn't hold it — try the next.
        }
      }
    } catch (e: any) {
      console.log(`[synapse] checkPin ${cid} unreadable (${e?.message ?? e}) — reporting not pinned`)
    }
    return notPinned
  }

  /** Approved providers' PDP URLs, recorded provider first (fresh list every call — the set shifts). */
  private async providerUrls(preferredId?: string): Promise<string[]> {
    const { createPublicClient, http } = await import('viem')
    const chains = await import('@filoz/synapse-core/chains')
    const { getApprovedPDPProviders } = await import('@filoz/synapse-core/sp-registry')
    // Chain reads go over HTTPS; ws(s) endpoints serve the SDK's subscriptions instead.
    const httpUrl = this.opts.rpcUrl.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:')
    const chain = this.opts.networkMode === 'mainnet' ? chains.mainnet : chains.calibration
    const client = createPublicClient({ chain, transport: http(httpUrl) })
    const providers = await getApprovedPDPProviders(client)
    const urls = providers
      .map((p: any) => ({ id: String(p?.id ?? ''), url: p?.pdp?.serviceURL as string | undefined }))
      .filter((p: { id: string; url: string | undefined }): p is { id: string; url: string } => typeof p.url === 'string' && p.url !== '')
    urls.sort((a, b) => (a.id === preferredId ? -1 : b.id === preferredId ? 1 : 0))
    return urls.map(p => p.url)
  }

  async pin(cid: Cid): Promise<PinStatus> {
    // Honest liveness read: report the real pin status. A freshly uploaded
    // piece may not be findable yet (PDP finalization / IPNI validation
    // pending), so returning a forced redundancy:1 here would mask that and
    // make the tool disagree with synapse_pin_status. Callers that need the
    // piece live should poll synapse_pin_status until redundancy > 0.
    return await this.checkPin(cid)
  }
}
