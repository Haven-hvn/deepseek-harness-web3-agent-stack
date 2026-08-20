/**
 * dsh-wallet-tools — live on-chain wallet tools.
 *
 * Two model-facing tools over the `dsh-wallet` + `dsh-treasury` seams:
 *
 * - `wallet_info` — authoritative EVM address + funding guidance + live balance hint.
 * - `get_balances` — the balance query surface. Supports:
 *   - `live: false` (default) — treasury ledger read (fast, cached).
 *   - `live: true` — public RPC fetch (authoritative, price-aware).
 *   - `refresh: true` — alias for live + automatic treasury sync.
 *   - `sync: true` — persist live result to `ctx.treasury.updateBalances`.
 *
 * Live fetching is handled by `./live-balances.ts`: native `fetch` + `AbortController`,
 * sequential RPC fallback per chain, isolated per-chain/per-token failures, and a
 * Coingecko price oracle with static fallback. No external RPC SDK — keeps the
 * bundle auditable and dependency-free.
 *
 * Professional discipline:
 * - BigInt for all on-chain quantities (no precision loss in transport).
 * - Zod-style `schemastery` validation on every config field (fail-loud).
 * - Graceful degradation: a single RPC failure never blanks the whole portfolio.
 * - Explicit provenance: every balance line tags `rpcUrl` + `priceSource`.
 *
 * @module dsh-wallet-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from 'dsh-wallet'

import {
  DEFAULT_CHAINS,
  DEFAULT_TOKENS,
  fetchAllLiveBalances,
  formatLiveAmount,
  toTreasuryBalances,
  type Erc20TokenConfig,
  type LiveFetchResult,
  type RpcChainConfig,
} from './live-balances.ts'

// Re-export live module for consumers that want to import it directly
export * from './live-balances.ts'

export const name = 'wallet-tools'
export const inject = ['wallet', 'tools', 'treasury'] as const

// ---------------------------------------------------------------------------
// Configuration — validated with schemastery, defaults are safe for prod
// ---------------------------------------------------------------------------

export interface Config {
  /** Configured wallet name whose address is returned by both tools. */
  readonly wallet: string
  /** When true, `get_balances` with `live`/`refresh` hits public RPCs. Default: true */
  readonly liveBalances?: boolean
  /** Per-call RPC timeout in ms (per URL, sequential fallback). */
  readonly rpcTimeoutMs?: number
  /** Override chain registry (e.g. add Base, Polygon). When omitted, {@link DEFAULT_CHAINS} is used. */
  readonly chains?: readonly RpcChainConfig[]
  /** Override token registry (e.g. add USDFC contract, extra ERC-20s). */
  readonly tokens?: readonly Erc20TokenConfig[]
  /** Disable price oracle and use static prices. Useful for offline / deterministic tests. */
  readonly disablePriceOracle?: boolean
}

export const Config: z<Config> = z.object({
  wallet: z.string().required(),
  liveBalances: z.boolean().default(true),
  rpcTimeoutMs: z.number().default(6_000),
  // chains/tokens are validated structurally when provided; undefined → defaults
  chains: z.array(z.object({
    chain: z.string().required(),
    chainId: z.number().required(),
    rpcUrls: z.array(z.string()).required(),
    nativeToken: z.string().required(),
    nativeDecimals: z.number().required(),
    label: z.string(),
  })).default(DEFAULT_CHAINS as unknown as RpcChainConfig[]),
  tokens: z.array(z.object({
    chain: z.string().required(),
    token: z.string().required(),
    address: z.string().required(),
    decimals: z.number().required(),
  })).default(DEFAULT_TOKENS as unknown as Erc20TokenConfig[]),
  disablePriceOracle: z.boolean().default(false),
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Narrow the treasury seam with explicit typing (avoids `as unknown` drift). */
interface TreasurySeam {
  report(): {
    state: string
    totalValueUsd: number
    dailyBurnUsd: number
    runwayDays: number
    balances: Array<{ chain: string; token: string; amount: number; usdEstimate: number }>
    recentExpenses: unknown[]
  }
  updateBalances(balances: readonly { chain: string; token: string; amount: number; usdEstimate: number }[]): Promise<{
    state: string
    runwayDays: number
    balances: Array<{ chain: string; token: string; amount: number; usdEstimate: number }>
  }>
}
interface WalletSeam {
  address(name: string): Promise<string>
  list(): Array<{ name: string; chain: string; wallet: string }>
}

/** Safely retrieve seams — throws a diagnosable error if the bundle is mis-mounted. */
function requireWallet(ctx: Context): WalletSeam {
  const w = (ctx as unknown as { wallet?: WalletSeam }).wallet
  if (!w || typeof w.address !== 'function') throw new Error('dsh-wallet seam not mounted (ctx.wallet missing) — check cordis.patch.yml mount order')
  return w
}
function requireTreasury(ctx: Context): TreasurySeam | undefined {
  const t = (ctx as unknown as { treasury?: TreasurySeam }).treasury
  if (!t || typeof t.report !== 'function') return undefined
  return t
}

/** Treasury display helper — read path only. */
function formatTreasuryTable(
  balances: Array<{ chain: string; token: string; amount: number; usdEstimate: number }>,
): string {
  if (balances.length === 0) return 'none'
  // Reuse live formatter via smallest-unit interpretation: treasury `amount` is already in
  // smallest units (wei / base units). Derive human string without losing precision for
  // large 18-decimal values by going through BigInt when possible.
  return balances
    .map(b => {
      const raw = BigInt(Math.round(b.amount))
      // Infer decimals from token via live registry
      const decimals = b.token === 'USDC' ? 6 : 18
      const human = formatLiveAmount(b.token, raw, decimals)
      return `${b.chain}:${b.token} ${human} ${b.token}`
    })
    .join(', ')
}

/** Format live result for model consumption — explicit, auditable, one line per chain. */
function formatLiveResult(result: LiveFetchResult, chainFilter?: string): string {
  const chains = chainFilter ? result.chains.filter(c => c.chain === chainFilter) : result.chains
  if (chains.length === 0) {
    return `Live fetch returned no chains for filter "${chainFilter}". Tried: ${result.chains.map(c => c.chain).join(', ')}.`
  }

  const lines: string[] = []
  let hasAnyBalance = false

  for (const chain of chains) {
    if (chain.balances.length === 0) {
      lines.push(`· ${chain.chain}: no balances — ${chain.error ?? 'unknown error'} (${chain.durationMs}ms)`)
      continue
    }
    hasAnyBalance = true
    const balStr = chain.balances
      .map(b => {
        const decimals = b.token === 'USDC' ? 6 : 18
        const h = formatLiveAmount(b.token, b.raw, decimals)
        const usd = b.usdEstimate === 0 ? 'price $0 (testnet)' : `$${(b.usdEstimate / 1_000_000).toFixed(2)}`
        return `${b.token} ${h} (${usd}, via ${b.rpcUrl})`
      })
      .join(', ')
    const status = chain.success ? 'ok' : `partial (${chain.error})`
    lines.push(`· ${chain.chain} [${status}, ${chain.durationMs}ms]: ${balStr}`)
  }

  const header = hasAnyBalance
    ? `LIVE balances for ${result.walletAddress} (fetched ${result.fetchedAt}, prices: ${result.priceSource}) — total ~$${(result.totalValueUsd / 1_000_000).toFixed(2)}`
    : `LIVE fetch for ${result.walletAddress} returned no spendable balances (fetched ${result.fetchedAt})`

  // Chain filter that yields zero despite success → explicit hint
  if (!hasAnyBalance && chainFilter) {
    return `${header}\n${lines.join('\n')}\nNo balances for chain "${chainFilter}". Try without a filter.`
  }
  return `${header}\n${lines.join('\n')}`
}

// ---------------------------------------------------------------------------
// Plugin apply — registers two tools
// ---------------------------------------------------------------------------

export function apply(ctx: Context, config: Config): void {
  const walletName = config.wallet
  const liveEnabled = config.liveBalances ?? true
  const timeoutMs = config.rpcTimeoutMs ?? 6_000
  const chains = (config.chains ?? DEFAULT_CHAINS) as readonly RpcChainConfig[]
  const tokens = (config.tokens ?? DEFAULT_TOKENS) as readonly Erc20TokenConfig[]

  // -----------------------------------------------------------------------
  // Tool 1: wallet_info — address + treasury hint + live probe (best-effort)
  // -----------------------------------------------------------------------
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'wallet_info',
        description:
          'Get the agent EVM wallet address and funding instructions. Call when user asks what is your address, wallet, balance, or how to fund you. Returns address, chain, treasury state, and (when live is enabled) a live RPC probe for the primary chain with fallback to treasury ledger.',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render(_args: unknown, value: string) {
            return [{ type: 'text', text: value }] as never
          },
        },
        execute: async () => {
          const wallet = requireWallet(ctx)
          const address = await wallet.address(walletName)
          const entry = wallet.list().find(w => w.name === walletName)

          // Treasury snapshot (always available when mounted)
          let treasuryInfo = 'Treasury (ctx.treasury) is manual ledger — shows UNFUNDED until ctx.treasury.updateBalances is called via live sync, but XMTP messaging is live.'
          const treasury = requireTreasury(ctx)
          if (treasury) {
            try {
              const report = treasury.report()
              const balancesDesc = formatTreasuryTable(report.balances)
              treasuryInfo = `Treasury state: ${report.state} runway ${report.runwayDays}d balances [${balancesDesc}] (total $${(report.totalValueUsd / 1_000_000).toFixed(2)}, burn $${(report.dailyBurnUsd / 1_000_000).toFixed(4)}/day)`
            } catch {
              // Keep generic fallback — treasury read should never crash wallet_info
            }
          }

          // Best-effort live probe (single chain, short timeout) — does not gate the response
          let liveHint = ''
          if (liveEnabled && treasury) {
            try {
              // Probe only calibration (the user's real chain) to keep wallet_info fast
              const calibration = chains.find(c => c.chain === 'filecoin-calibration')
                ?? chains.find(c => c.chain === 'filecoin')
                ?? chains[0]
              if (calibration) {
                const probed = await fetchAllLiveBalances(address, [calibration], tokens.filter(t => t.chain === calibration.chain), {
                  timeoutMs: Math.min(timeoutMs, 4_000),
                })
                const liveLine = formatLiveResult(probed)
                liveHint = `\nLive probe (${calibration.chain}): ${liveLine.replaceAll('\n', ' | ')}`
              }
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e)
              liveHint = `\nLive probe unavailable: ${msg} — treasury snapshot above is the durable fallback. Run get_balances with live:true for a full multi-chain fetch.`
            }
          } else if (!liveEnabled) {
            liveHint = '\nLive RPC disabled by config (liveBalances:false) — enable it or call get_balances with live:true for on-chain data.'
          }

          const chainLabel = entry?.chain ?? 'evm'
          const vaultLabel = entry?.wallet ?? walletName
          return `Wallet ${walletName}: address ${address} chain ${chainLabel} (OWS vault ${vaultLabel}). ${treasuryInfo}${liveHint} To fund: send USDC/USDFC or native gas to ${address} on Filecoin FEVM / Ethereum. Use get_balances {live:true} for authoritative on-chain balances.`
        },
      }),
    ),
  )

  // -----------------------------------------------------------------------
  // Tool 2: get_balances — treasury + live RPC with optional treasury sync
  // -----------------------------------------------------------------------
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'get_balances',
        description:
          'Lookup the agent own balances across all chains. By default reads the durable treasury ledger (fast). Pass live:true (or legacy refresh:true) to query public RPCs live (authoritative, price-aware, per-chain fallback). Pass sync:true to persist the live result to the treasury (updateBalances) so runway/state recompute. Chain-agnostic: iterates whatever chains/tokens are configured.',
        parameters: {
          chain: {
            type: 'string',
            description: 'Optional chain filter (e.g. ethereum, filecoin, filecoin-calibration). Omit for all chains.',
          },
          refresh: {
            type: 'boolean',
            description: 'Legacy alias for live:true + sync:true — refresh through durable write chain so derived variables recompute. Prefer live + sync.',
          },
          live: {
            type: 'boolean',
            description: 'When true, fetch authoritative balances from public RPCs (native fetch, fallback, isolated failures) instead of reading the treasury cache. Default false (treasury).',
          },
          sync: {
            type: 'boolean',
            description: 'When true with live, persist the live result to ctx.treasury.updateBalances so runway/state recompute durably. Default true when refresh:true, false otherwise.',
          },
        },
        output: {
          schema: { type: 'string' },
          render(_args: unknown, value: string) {
            return [{ type: 'text', text: value }] as never
          },
        },
        execute: async (args: { chain?: string; refresh?: boolean; live?: boolean; sync?: boolean }) => {
          const treasury = requireTreasury(ctx)

          // Determine intent: legacy refresh => live+sync
          const wantsLive = args.live === true || args.refresh === true
          const wantsSync = args.sync === true || args.refresh === true

          // Live path — authoritative RPC fetch
          if (wantsLive) {
            if (!liveEnabled) {
              return 'Live balances are disabled by plugin config (liveBalances:false). Set liveBalances:true in cordis.patch.yml or query the treasury ledger (call get_balances without live).'
            }

            const wallet = requireWallet(ctx)
            let address: string
            try {
              address = await wallet.address(walletName)
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e)
              return `Cannot fetch live balances: wallet "${walletName}" address unavailable — ${msg}`
            }

            // Chain-filtered fetch: narrow chain registry when filter is set
            const targetChains = args.chain ? chains.filter(c => c.chain === args.chain) : chains
            if (args.chain && targetChains.length === 0) {
              const known = chains.map(c => c.chain).join(', ')
              return `Unknown chain filter "${args.chain}". Known chains: ${known}. Omit the filter for all chains.`
            }

            let liveResult: LiveFetchResult
            try {
              liveResult = await fetchAllLiveBalances(address, targetChains, tokens, { timeoutMs })
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e)
              // Distinguish address / config errors from RPC errors
              const treasuryFallback = treasury ? (() => {
                try {
                  const r = treasury.report()
                  return ` Treasury fallback: state ${r.state} runway ${r.runwayDays}d balances [${formatTreasuryTable(r.balances)}]`
                } catch {
                  return ''
                }
              })() : ''
              return `Live fetch failed: ${msg}.${treasuryFallback}`
            }

            // Optionally sync to treasury (durably, so runway/state recompute)
            let syncNote = ''
            if (wantsSync && treasury) {
              try {
                // When a chain filter is active we must NOT blank other chains'
                // rows: read current treasury, replace only the fetched chains' slices.
                const treasuryBalances = toTreasuryBalances(liveResult)
                if (args.chain) {
                  const existing = treasury.report().balances.filter(b => b.chain !== args.chain)
                  const merged = [...existing, ...treasuryBalances]
                  const updated = await treasury.updateBalances(merged)
                  syncNote = `\nTreasury synced (chain ${args.chain}): state ${updated.state} runway ${updated.runwayDays}d.`
                } else {
                  // Full sync — whole sheet replace. Filter out zero-price testnet noise only
                  // if the sheet would otherwise be empty: keep whatever was fetched.
                  const updated = await treasury.updateBalances(treasuryBalances)
                  syncNote = `\nTreasury synced (all chains): state ${updated.state} runway ${updated.runwayDays}d.`
                }
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e)
                syncNote = `\nTreasury sync failed (live data NOT persisted): ${msg}`
              }
            } else if (wantsSync && !treasury) {
              syncNote = '\nTreasury sync requested but treasury seam is not mounted — live result not persisted.'
            } else if (!wantsSync) {
              syncNote = '\nTreasury NOT updated (pass sync:true or refresh:true to persist).'
            }

            // Also surface all wallet addresses agnostically
            let walletAddrs = ''
            try {
              const infos = wallet.list()
              if (infos.length > 1) {
                const parts = await Promise.all(
                  infos.map(async w => {
                    try {
                      return `${w.name}:${w.chain}=${await wallet.address(w.name)}`
                    } catch {
                      return `${w.name}:${w.chain}=<err>`
                    }
                  }),
                )
                walletAddrs = `\nWallets: ${parts.join(' | ')}`
              }
            } catch {}

            return `${formatLiveResult(liveResult, args.chain)}${syncNote}${walletAddrs}`
          }

          // -----------------------------------------------------------------
          // Treasury path — fast, durable, no RPC
          // -----------------------------------------------------------------
          if (!treasury) {
            return 'Treasury unavailable (ctx.treasury not mounted). Balances cannot be reported. Enable live:true to fetch directly from RPCs if liveBalances is enabled.'
          }

          let report: ReturnType<TreasurySeam['report']>
          try {
            report = treasury.report()
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            return `Treasury read failed: ${msg}. Try get_balances with live:true for a direct RPC check.`
          }

          // Chain-filtered view at presentation (not at seam)
          const view = args.chain ? report.balances.filter(b => b.chain === args.chain) : report.balances

          if (view.length === 0) {
            try {
              const wallet = requireWallet(ctx)
              const infos = wallet.list()
              const addrs = await Promise.all(
                infos.map(async w => {
                  try {
                    return `${w.name} (${w.chain}): ${await wallet.address(w.name)}`
                  } catch {
                    return `${w.name} (${w.chain}): <unavailable>`
                  }
                }),
              )
              const hint = liveEnabled
                ? ' Run get_balances with live:true for authoritative on-chain data (the treasury may be stale).'
                : ''
              return `No treasury balances for chain ${args.chain ?? 'any'} — state ${report.state} runway ${report.runwayDays}d. Wallets: ${addrs.join(' | ')}. Fund by sending native gas or tokens to the appropriate address.${hint}`
            } catch {
              return `No treasury balances for chain ${args.chain ?? 'any'} — state ${report.state} runway ${report.runwayDays}d.`
            }
          }

          const balancesDesc = formatTreasuryTable(view)

          let walletAddrs = ''
          try {
            const wallet = requireWallet(ctx)
            const infos = wallet.list()
            const first = infos[0]
            if (infos.length === 1 && first !== undefined && first.name === walletName) {
              const addr = await wallet.address(walletName)
              walletAddrs = ` Wallet ${walletName} (${first.chain}): ${addr}.`
            } else if (infos.length > 0) {
              const parts = await Promise.all(
                infos.map(async w => {
                  try {
                    return `${w.name}:${w.chain}=${await wallet.address(w.name)}`
                  } catch {
                    return `${w.name}:${w.chain}=<err>`
                  }
                }),
              )
              walletAddrs = ` Wallets: ${parts.join(' | ')}.`
            }
          } catch {}

          const liveHint = liveEnabled ? ' Add live:true for authoritative RPC balances.' : ''
          return `Treasury state: ${report.state} runway ${report.runwayDays}d balances [${balancesDesc}] (total $${(report.totalValueUsd / 1_000_000).toFixed(2)}).${walletAddrs}${liveHint}`
        },
      }),
    ),
  )
}
