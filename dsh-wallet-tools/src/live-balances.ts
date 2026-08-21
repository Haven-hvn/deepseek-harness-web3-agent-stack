/**
 * Live on-chain balance fetching via public JSON-RPC.
 *
 * Professional, dependency-free implementation: uses native `fetch` + `AbortController`
 * for timeouts, sequential RPC fallback per chain, isolated per-chain error handling,
 * and price-aware `usdEstimate` derivation. No external RPC SDK required — keeps the
 * bundle minimal and auditable.
 *
 * Chain coverage:
 * - `ethereum` (EVM, chainId 1): native ETH via `eth_getBalance`, USDC via `eth_call` `balanceOf`
 * - `filecoin` (FEVM, chainId 314): native FIL via `eth_getBalance` on GLIF
 * - `filecoin-calibration` (FEVM, chainId 314159): native tFIL via `eth_getBalance` on calibration GLIF
 *
 * USDFC contracts are deployment-specific and therefore configurable; when absent
 * USDFC is reported as unavailable rather than silently zeroed.
 *
 * @module dsh-wallet-tools/live-balances
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Chain RPC configuration. `chain` must match treasury's `ChainBalance.chain`. */
export interface RpcChainConfig {
  readonly chain: string
  readonly chainId: number
  readonly rpcUrls: readonly string[]
  readonly nativeToken: string
  readonly nativeDecimals: number
  readonly label?: string
}

/** ERC-20 token configuration for `eth_call` balanceOf. */
export interface Erc20TokenConfig {
  readonly chain: string
  readonly token: string
  readonly address: string // 0x…
  readonly decimals: number
}

/** One fetched raw balance (smallest unit) with diagnostic context. */
export interface RawBalance {
  readonly chain: string
  readonly token: string
  readonly raw: bigint
  readonly decimals: number
  readonly rpcUrl: string
  readonly contractAddress?: string
}

/** Treasury-shaped balance with USD estimate in micro-USD. */
export interface LiveTreasuryBalance {
  readonly chain: string
  readonly token: string
  readonly amount: number // smallest unit as number (treasury schema requires number)
  readonly usdEstimate: number // micro-USD (USD * 1e6), integer
  readonly raw: bigint
  readonly priceUsd: number
  readonly rpcUrl: string
}

/** Result of a chain-wide fetch attempt. */
export interface ChainFetchResult {
  readonly chain: string
  readonly success: boolean
  readonly balances: readonly LiveTreasuryBalance[]
  readonly error?: string
  readonly durationMs: number
}

/** Aggregate live fetch result. */
export interface LiveFetchResult {
  readonly walletAddress: string
  readonly chains: readonly ChainFetchResult[]
  readonly totalValueUsd: number // micro-USD
  readonly fetchedAt: string // ISO timestamp
  readonly priceSource: string
}

// ---------------------------------------------------------------------------
// Defaults — auditable, overrideable via plugin config
// ---------------------------------------------------------------------------

/**
 * Default chain registry. Uses public, permissionless RPCs verified at authoring:
 * - ethereum.publicnode.com — working for eth_getBalance + eth_call
 * - api.node.glif.io/rpc/v1 — Filecoin FEVM mainnet
 * - api.calibration.node.glif.io/rpc/v1 — Filecoin calibration (where tFIL lives)
 *
 * Fallbacks are ordered: first success wins, no speculative retries across chains.
 */
export const DEFAULT_CHAINS: readonly RpcChainConfig[] = [
  {
    chain: 'ethereum',
    chainId: 1,
    rpcUrls: [
      'https://ethereum.publicnode.com',
      'https://eth.meowrpc.com',
    ],
    nativeToken: 'ETH',
    nativeDecimals: 18,
    label: 'Ethereum Mainnet',
  },
  {
    chain: 'filecoin',
    chainId: 314,
    rpcUrls: [
      'https://api.node.glif.io/rpc/v1',
    ],
    nativeToken: 'FIL',
    nativeDecimals: 18,
    label: 'Filecoin FEVM Mainnet',
  },
  {
    chain: 'filecoin-calibration',
    chainId: 314159,
    rpcUrls: [
      'https://api.calibration.node.glif.io/rpc/v1',
      'https://filecoin-calibration.chainup.net/rpc/v1',
    ],
    nativeToken: 'tFIL',
    nativeDecimals: 18,
    label: 'Filecoin Calibration Testnet',
  },
] as const

/**
 * Default ERC-20 registry. Canonical verified contracts:
 * - ethereum:USDC (Circle)
 * - filecoin:USDFC (Filecoin mainnet)
 * - filecoin-calibration:USDFC (Filecoin calibration testnet)
 */
export const DEFAULT_TOKENS: readonly Erc20TokenConfig[] = [
  {
    chain: 'ethereum',
    token: 'USDC',
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    decimals: 6,
  },
  {
    chain: 'filecoin',
    token: 'USDFC',
    address: '0x80B98d3aa09ffff255c3ba4A241111Ff1262F045',
    decimals: 18,
  },
  {
    chain: 'filecoin-calibration',
    token: 'USDFC',
    address: '0xb3042734b608a1B16e9e86B374A3f3e389B4cDf0',
    decimals: 18,
  },
] as const

// ---------------------------------------------------------------------------
// Low-level RPC helpers — pure, testable, no side effects beyond fetch
// ---------------------------------------------------------------------------

const JSON_RPC_TIMEOUT_MS_DEFAULT = 6_000
const PRICE_TIMEOUT_MS = 4_000

/** Minimal JSON-RPC envelope. */
interface JsonRpcRequest {
  readonly jsonrpc: '2.0'
  readonly id: number
  readonly method: string
  readonly params: readonly unknown[]
}
interface JsonRpcSuccess {
  readonly jsonrpc: '2.0'
  readonly id: number
  readonly result: unknown
}
interface JsonRpcError {
  readonly jsonrpc: '2.0'
  readonly id: number
  readonly error: { readonly code: number; readonly message: string; readonly data?: unknown }
}
type JsonRpcResponse = JsonRpcSuccess | JsonRpcError

function isSuccess(r: JsonRpcResponse): r is JsonRpcSuccess {
  return (r as JsonRpcSuccess).result !== undefined && (r as JsonRpcError).error === undefined
}

/**
 * Perform a single JSON-RPC call with timeout. Throws on transport or RPC error.
 * Uses `AbortController` so a hung RPC does not stall the entire batch.
 */
export async function rpcCall(
  rpcUrl: string,
  method: string,
  params: readonly unknown[],
  timeoutMs: number = JSON_RPC_TIMEOUT_MS_DEFAULT,
): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const payload: JsonRpcRequest = { jsonrpc: '2.0', id: 1, method, params }
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`)
    }
    const data = (await res.json()) as JsonRpcResponse
    if (!isSuccess(data)) {
      const msg = (data as JsonRpcError).error?.message ?? 'unknown RPC error'
      const code = (data as JsonRpcError).error?.code
      throw new Error(`RPC ${method} failed${code !== undefined ? ` (${code})` : ''}: ${msg}`)
    }
    return data.result
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`RPC ${method} timed out after ${timeoutMs}ms @ ${rpcUrl}`)
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Try RPC URLs sequentially until one succeeds. Returns the result + the winning URL,
 * or throws the last error. This gives us fallback without parallel thundering-herd.
 */
export async function rpcCallWithFallback(
  rpcUrls: readonly string[],
  method: string,
  params: readonly unknown[],
  timeoutMs: number = JSON_RPC_TIMEOUT_MS_DEFAULT,
): Promise<{ result: unknown; rpcUrl: string }> {
  let lastError: unknown
  for (const url of rpcUrls) {
    try {
      const result = await rpcCall(url, method, params, timeoutMs)
      return { result, rpcUrl: url }
    } catch (err) {
      lastError = err
      // Try next URL — do not log here; caller aggregates diagnostics
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

// ---------------------------------------------------------------------------
// Hex / amount helpers
// ---------------------------------------------------------------------------

/** Parse a 0x hex quantity to bigint. Throws on malformed input. */
export function parseHexQuantity(hex: unknown): bigint {
  if (typeof hex !== 'string') throw new Error(`expected hex string, got ${typeof hex}`)
  const h = hex.trim()
  if (!h.startsWith('0x') && !h.startsWith('0X')) throw new Error(`expected 0x prefix, got "${h.slice(0, 20)}"`)
  if (h.length === 2) return BigInt(0)
  return BigInt(h)
}

/** Encode ERC-20 `balanceOf(address)` calldata. */
export function encodeBalanceOf(walletAddress: string): string {
  const addr = walletAddress.startsWith('0x') ? walletAddress : `0x${walletAddress}`
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new Error(`invalid wallet address: ${walletAddress}`)
  const stripped = addr.slice(2).toLowerCase()
  // selector 0x70a08231 + left-padded 32-byte address
  return `0x70a08231${'0'.repeat(24)}${stripped}`
}

// ---------------------------------------------------------------------------
// Price oracle — Coingecko with graceful degradation
// ---------------------------------------------------------------------------

export interface PriceMap {
  readonly get: (token: string) => number | undefined
  readonly source: string
}

/**
 * Fetch USD prices for native assets. Falls back to static estimates when
 * the oracle is unreachable — the caller still gets balances, just with
 * estimated valuation.
 */
export async function fetchPrices(): Promise<PriceMap> {
  const fallback = new Map<string, number>([
    ['ETH', 3000],
    ['FIL', 4.0],
    ['tFIL', 0],
    ['USDC', 1],
    ['USDFC', 1],
  ])
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), PRICE_TIMEOUT_MS)
    try {
      const url = 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum,filecoin&vs_currencies=usd'
      const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`price HTTP ${res.status}`)
      const data = (await res.json()) as Record<string, { usd: number }>
      const eth = data['ethereum']?.usd
      const fil = data['filecoin']?.usd
      if (typeof eth === 'number' && Number.isFinite(eth)) fallback.set('ETH', eth)
      if (typeof fil === 'number' && Number.isFinite(fil)) {
        fallback.set('FIL', fil)
        // tFIL is testnet FIL — price 0 by definition (no market), but keep FIL for reference
      }
      return {
        get: (token: string) => fallback.get(token),
        source: 'coingecko',
      }
    } finally {
      clearTimeout(timeout)
    }
  } catch {
    return {
      get: (token: string) => fallback.get(token),
      source: 'fallback-static',
    }
  }
}

/**
 * Convert a raw bigint amount to micro-USD.
 * @param raw - amount in smallest unit
 * @param decimals - token decimals (6 for USDC, 18 for ETH/FIL)
 * @param priceUsd - price of one whole token in USD
 * @returns integer micro-USD (USD * 1e6), suitable for treasury `usdEstimate`
 */
export function toMicroUsd(raw: bigint, decimals: number, priceUsd: number): number {
  if (priceUsd === 0) return 0
  const divisor = BigInt(10) ** BigInt(decimals)
  // Do integer arithmetic where possible, then apply price
  // Use floating for price multiplication — micro-USD fits in 53-bit for realistic values
  const whole = Number(raw) / Number(divisor)
  return Math.round(whole * priceUsd * 1_000_000)
}

// ---------------------------------------------------------------------------
// Balance fetchers — one per asset class
// ---------------------------------------------------------------------------

/** Fetch native balance (ETH/FIL/tFIL) via eth_getBalance. */
export async function fetchNativeBalance(
  chain: RpcChainConfig,
  walletAddress: string,
  timeoutMs: number = JSON_RPC_TIMEOUT_MS_DEFAULT,
): Promise<RawBalance> {
  const { result, rpcUrl } = await rpcCallWithFallback(chain.rpcUrls, 'eth_getBalance', [walletAddress, 'latest'], timeoutMs)
  const raw = parseHexQuantity(result as string)
  return { chain: chain.chain, token: chain.nativeToken, raw, decimals: chain.nativeDecimals, rpcUrl }
}

/** Fetch ERC-20 balance via eth_call balanceOf. */
export async function fetchErc20Balance(
  token: Erc20TokenConfig,
  chain: RpcChainConfig,
  walletAddress: string,
  timeoutMs: number = JSON_RPC_TIMEOUT_MS_DEFAULT,
): Promise<RawBalance> {
  const data = encodeBalanceOf(walletAddress)
  const { result, rpcUrl } = await rpcCallWithFallback(
    chain.rpcUrls,
    'eth_call',
    [{ to: token.address, data }, 'latest'],
    timeoutMs,
  )
  const raw = parseHexQuantity(result as string)
  return { chain: token.chain, token: token.token, raw, decimals: token.decimals, rpcUrl, contractAddress: token.address }
}

// ---------------------------------------------------------------------------
// Orchestrator — fetch all chains/tokens in parallel with isolated failures
// ---------------------------------------------------------------------------

export interface FetchOptions {
  readonly timeoutMs?: number
  readonly priceMap?: PriceMap
}

/**
 * Fetch live balances for every configured chain and token.
 * Each chain is isolated: a failure on one chain does not abort others.
 * Each token within a chain is also isolated.
 */
export async function fetchAllLiveBalances(
  walletAddress: string,
  chains: readonly RpcChainConfig[] = DEFAULT_CHAINS,
  tokens: readonly Erc20TokenConfig[] = DEFAULT_TOKENS,
  options: FetchOptions = {},
): Promise<LiveFetchResult> {
  const timeoutMs = options.timeoutMs ?? JSON_RPC_TIMEOUT_MS_DEFAULT
  const priceMap = options.priceMap ?? await fetchPrices()

  // Normalize address: checksum not required, but must be 0x-prefixed and 40 hex chars
  const normalizedAddress = walletAddress.startsWith('0x') ? walletAddress : `0x${walletAddress}`
  if (!/^0x[0-9a-fA-F]{40}$/.test(normalizedAddress)) {
    throw new Error(`invalid wallet address for live fetch: ${walletAddress}`)
  }

  const chainResults = await Promise.all(
    chains.map(async (chain): Promise<ChainFetchResult> => {
      const start = Date.now()
      const balances: LiveTreasuryBalance[] = []
      let success = true
      let error: string | undefined

      // Group tokens by chain
      const chainTokens = tokens.filter(t => t.chain === chain.chain)

      // Fetch native + tokens in parallel but isolated
      const tasks: Array<Promise<RawBalance>> = [
        fetchNativeBalance(chain, normalizedAddress, timeoutMs),
        ...chainTokens.map(t => fetchErc20Balance(t, chain, normalizedAddress, timeoutMs)),
      ]

      const settled = await Promise.allSettled(tasks)
      for (const s of settled) {
        if (s.status === 'fulfilled') {
          const raw = s.value
          const price = priceMap.get(raw.token) ?? 0
          const usdEstimate = toMicroUsd(raw.raw, raw.decimals, price)
          // treasury `amount` is number in smallest unit — BigInt -> Number is lossy above 2^53
          // but matches domain's z.number() schema and existing 1e18 storage convention
          const amount = Number(raw.raw)
          balances.push({
            chain: raw.chain,
            token: raw.token,
            amount: Number.isFinite(amount) ? amount : 0,
            usdEstimate,
            raw: raw.raw,
            priceUsd: price,
            rpcUrl: raw.rpcUrl,
          })
        } else {
          // Isolated failure: mark chain as partially failed but keep other balances
          success = false
          const msg = s.reason instanceof Error ? s.reason.message : String(s.reason)
          error = error ? `${error}; ${msg}` : msg
        }
      }

      // If every task failed, this chain result is a full failure
      if (balances.length === 0 && settled.every(r => r.status === 'rejected')) {
        success = false
      }

      return {
        chain: chain.chain,
        success: success && balances.length > 0,
        balances,
        ...(error ? { error } : {}),
        durationMs: Date.now() - start,
      }
    }),
  )

  const totalValueUsd = chainResults.reduce(
    (sum, c) => sum + c.balances.reduce((s, b) => s + b.usdEstimate, 0),
    0,
  )

  return {
    walletAddress: normalizedAddress,
    chains: chainResults,
    totalValueUsd,
    fetchedAt: new Date().toISOString(),
    priceSource: priceMap.source,
  }
}

// ---------------------------------------------------------------------------
// Treasury conversion & presentation helpers
// ---------------------------------------------------------------------------

/** Convert a `LiveFetchResult` into the `ChainBalance[]` shape expected by `ctx.treasury.updateBalances`. */
export function toTreasuryBalances(result: LiveFetchResult): Array<{ chain: string; token: string; amount: number; usdEstimate: number }> {
  const out: Array<{ chain: string; token: string; amount: number; usdEstimate: number }> = []
  for (const chain of result.chains) {
    for (const b of chain.balances) {
      out.push({ chain: b.chain, token: b.token, amount: b.amount, usdEstimate: b.usdEstimate })
    }
  }
  return out
}

/** Token decimals registry for display — extends with chain defaults as fallback. */
const DISPLAY_DECIMALS: Record<string, number> = { USDC: 6, USDFC: 18, ETH: 18, FIL: 18, tFIL: 18 }

/**
 * Format a raw smallest-unit amount as a human-readable string.
 * Caps to 6 decimals for readability, strips trailing zeros.
 */
export function formatLiveAmount(token: string, raw: bigint | number, decimalsHint?: number): string {
  const d = decimalsHint ?? DISPLAY_DECIMALS[token] ?? 18
  const rawBig = typeof raw === 'bigint' ? raw : BigInt(Math.round(raw))
  const divisor = BigInt(10) ** BigInt(d)
  const whole = rawBig / divisor
  const frac = rawBig % divisor
  if (frac === BigInt(0)) return whole.toString()
  const fracStr = frac.toString().padStart(d, '0').replace(/0+$/, '')
  const display = `${whole.toString()}.${fracStr}`
  // Cap to 6 decimals for UI
  if (display.includes('.')) {
    const [w, f] = display.split('.') as [string, string]
    const capped = f.slice(0, 6)
    const trimmed = capped.replace(/0+$/, '')
    return trimmed.length === 0 ? w : `${w}.${trimmed}`
  }
  return display
}

/**
 * Format a bigint hex-derived amount given token decimals.
 * Convenience overload that accepts the bigint raw directly.
 */
export function formatRawAmount(token: string, raw: bigint, decimals: number): string {
  return formatLiveAmount(token, raw, decimals)
}
