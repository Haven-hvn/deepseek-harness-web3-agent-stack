/**
 * dsh-royalty-router — mint.club graduation advisor + launcher for DeepSeek Harness.
 *
 * Six model-facing tools over `@royalty-router/sdk`:
 * - `rr_advise` — offline intent fill + model warnings (no RPC).
 * - `rr_venue` — live curve-vs-pool quote + crossover size (RPC reads).
 * - `rr_build` — launch dry-run: struct, value, approvals, predicted
 *   addresses. Requires a `factory` address (until the live factory is
 *   deployed, point at a local fork deployment); otherwise it fails with
 *   an actionable error.
 * - `rr_launch` — approve → simulate → send a launch (signs via `ctx.wallet`).
 * - `rr_sweep` — sweep a router's pending royalties into locked liquidity.
 * - `rr_heartbeat` — stamp router activity when no sweep is due.
 *
 * Reads are free (`presentCall: {kind:'read'}`) — no signing, no spending.
 * Execute tools (`presentCall: {kind:'execute'}`) sign per operation through
 * `ctx.wallet` (the dsh-storage-synapse `toAccount` bridge pattern; works
 * with both `ows` and `raw` providers) and need a `wallet` name in config
 * plus `dsh-wallet` + `dsh-wallet-ethereum` mounted. No new custody code:
 * configuration carries names, never keys.
 *
 * @module dsh-royalty-router
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createClient, resolveChainOpts, resolveDeployment } from './chain.ts'
import { createSigningWalletClient, requireWalletName } from './wallet.ts'
import { adviseIntentTool, buildTool, heartbeatTool, launchTool, sweepTool, venueTool } from './tools.ts'

export { createClient, resolveChainOpts, resolveDeployment } from './chain.ts'
export { createSigningAccount, createSigningWalletClient, requireWalletName } from './wallet.ts'
export * from './tools.ts'

/** Cordis plugin name. */
export const name = 'royalty-router'
/**
 * Only the tool registry — reads mount anywhere `tools` exists. Execute
 * tools additionally need `ctx.wallet` at call time and fail actionable
 * without it, so wallet-less profiles keep the advisor reads.
 */
export const inject = ['tools'] as const

/** Plugin configuration — RPC endpoint, chain, optional factory. No secrets. */
export interface Config {
  /** RPC endpoint (default Base public RPC). */
  readonly rpcUrl?: string
  /** EIP-155 chain id (default 8453 Base; the only SDK deployment). */
  readonly chainId?: number
  /**
   * RoyaltyRouterFactory override. Required for `rr_build` / `rr_launch`;
   * until the live factory is deployed, point at a local fork deployment.
   */
  readonly factory?: string
  /**
   * dsh-wallet name that signs `rr_launch` / `rr_sweep` / `rr_heartbeat`.
   * Reads work without it.
   */
  readonly wallet?: string
}

export const Config: z<Config> = z.object({
  rpcUrl: z.string().default('https://mainnet.base.org'),
  chainId: z.number().default(8453),
  factory: z.string(),
  wallet: z.string(),
})

function renderJson(value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

const curveShape = {
  freeRange: { type: 'string', required: true, description: 'Free-range tokens (wei, decimal string).' },
  maxSupply: { type: 'string', required: true, description: 'Max supply (wei, decimal string).' },
  startPrice: { type: 'string', required: true, description: 'First paid-step price, reserve wei per 1e18 tokens (decimal string).' },
  endPrice: { type: 'string', required: true, description: 'Last-step price (decimal string).' },
  steps: { type: 'number', description: 'Geometric steps (default 20).' },
} as const

const intentShape = {
  name: { type: 'string', required: true, description: 'Token name.' },
  symbol: { type: 'string', required: true, description: 'Token symbol (must be free on this chain).' },
  reserveToken: { type: 'string', required: true, description: 'mint.club reserve token (0x...).' },
  feeRecipient: { type: 'string', required: true, description: 'LP-fee remainder recipient (0x...).' },
  curve: { type: 'object', description: 'Geometric curve spec (recommended path; ignored when steps is given).' },
  steps: { type: 'array', description: 'Explicit [{rangeTo, price}] decimal-string steps (alternative to curve).' },
  mintRoyaltyBps: { type: 'number', description: 'Mint royalty bps (default 1500; required with explicit steps).' },
  burnRoyaltyBps: { type: 'number', description: 'Burn royalty bps (default 1500; required with explicit steps).' },
  curveMint: { type: 'string', description: 'Extra seed tokens minted from the curve (wei, decimal string).' },
  seed: { type: 'object', description: '{tokens, secondary} decimal-string seed targets.' },
  secondary: { type: 'string', description: "Pool's other side (0x...; default native)." },
  fee: { type: 'number', description: 'Pool fee pips (default 3000 = 0.3%).' },
  tickSpacing: { type: 'number', description: 'Pool tick spacing (default 60).' },
} as const

/**
 * Register the advisor + launcher tools.
 * @param ctx - Plugin context carrying the tool registry (and, for execute
 *   tools, the wallet seam).
 * @param config - Validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  // Fork env (FORK_RPC/FORK_FACTORY, else RPC/FACTORY) wins when set;
  // otherwise the profile config (or its defaults) stands.
  const opts = resolveChainOpts(config)
  const deployment = resolveDeployment(opts)
  const lazyClient = () => createClient(opts)
  // Signing client is lazy too: reads never touch ctx.wallet, and a missing
  // wallet name fails only when an execute tool actually runs.
  const executeDeps = async () => ({
    client: lazyClient(),
    deployment,
    wallet: await createSigningWalletClient(ctx, requireWalletName(config), opts),
  })

  // ── rr_advise (offline) ─────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'rr_advise',
    description:
      'Advise a mint.club graduation launch: fills the model-recommended intent (15% royalty both ways, 0.3% pool fee, smooth 20-step curve, hard seed) and reports where it departs from the model. Fully offline — no RPC, no key. Call before rr_build to decide whether a launch is worth attempting.',
    parameters: intentShape as never,
    output: { schema: { type: 'object', additionalProperties: true } as never, render: (_a, v) => renderJson(v) as never },
    execute: async (args: never): Promise<unknown> => adviseIntentTool(args as never),
    presentCall: () => ({ card: 'generic', title: 'Graduation advice', kind: 'read' }),
  })))

  // ── rr_venue (live reads) ───────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'rr_venue',
    description:
      'Quote one trade on both venues (mint.club curve vs GlueHook Uniswap V4 pool) plus the crossover size above which the curve wins. Live RPC reads only — no signing. amountIn is a decimal string (reserve wei for buy, token wei for sell).',
    parameters: {
      token: { type: 'string', required: true, description: 'Token address (0x...).' },
      secondary: { type: 'string', description: "Pool's other side (default native)." },
      fee: { type: 'number', description: 'Pool fee pips (default 3000).' },
      tickSpacing: { type: 'number', description: 'Pool tick spacing (default 60).' },
      side: { type: 'string', required: true, description: '"buy" or "sell".' },
      amountIn: { type: 'string', required: true, description: 'Exact trade size (decimal string).' },
    } as never,
    output: { schema: { type: 'object', additionalProperties: true } as never, render: (_a, v) => renderJson(v) as never },
    execute: async (args: never): Promise<unknown> =>
      venueTool({ client: lazyClient(), deployment }, args as never),
    presentCall: args => ({ card: 'generic', title: `Venue quote ${(args as { token: string }).token}`, kind: 'read' }),
  })))

  // ── rr_build (dry-run, needs factory) ───────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'rr_build',
    description:
      'Dry-run a graduation launch: full Launch struct, msg.value, required approvals, predicted token and poolId. Reads live creationFee and symbol availability. Requires a factory address in plugin config (until the live factory is deployed, point at a local fork deployment). Signs nothing.',
    parameters: intentShape as never,
    output: { schema: { type: 'object', additionalProperties: true } as never, render: (_a, v) => renderJson(v) as never },
    execute: async (args: never): Promise<unknown> =>
      buildTool({ client: lazyClient(), deployment }, args as never),
    presentCall: () => ({ card: 'generic', title: 'Launch dry-run', kind: 'read' }),
  })))

  // ── rr_launch (approve → simulate → send; signs via ctx.wallet) ────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'rr_launch',
    description:
      'Launch a graduation: builds the intent, simulates (a revert costs nothing), then sends the factory launch. Caller must fund the reserve/seed and hold it in the configured wallet. Signs via ctx.wallet — no key material in Node or config. Simulate before sending, and on swapper routes quote a real minOut — the reference swapper trusts the caller-provided floor.',
    parameters: intentShape as never,
    output: { schema: { type: 'object', additionalProperties: true } as never, render: (_a, v) => renderJson(v) as never },
    execute: async (args: never): Promise<unknown> =>
      launchTool(await executeDeps(), args as never),
    presentCall: () => ({ card: 'generic', title: 'Graduation launch', kind: 'execute' }),
  })))

  // ── rr_sweep (keeper action; simulates first) ──────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'rr_sweep',
    description:
      'Sweep one router pending royalties into permanently locked pool liquidity (keeper keeps the bounty). Simulates first so a revert costs nothing. Call when the router is ready (pending clears MIN_CLAIM); otherwise use rr_heartbeat. Signs via ctx.wallet.',
    parameters: {
      router: { type: 'string', required: true, description: 'Router address (0x...).' },
      minOut: { type: 'string', description: 'Swap floor for swapper routes as a decimal string (default "0" — fine on swap-free routes).' },
    } as never,
    output: { schema: { type: 'object', additionalProperties: true } as never, render: (_a, v) => renderJson(v) as never },
    execute: async (args: never): Promise<unknown> =>
      sweepTool(await executeDeps(), args as never),
    presentCall: args => ({ card: 'generic', title: `Sweep ${(args as { router: string }).router}`, kind: 'execute' }),
  })))

  // ── rr_heartbeat (permissionless, moves no funds) ──────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'rr_heartbeat',
    description:
      'Stamp activity on a router with nothing worth sweeping so a live token never looks stale. Permissionless and moves no funds, but still sends a transaction — signs via ctx.wallet.',
    parameters: {
      router: { type: 'string', required: true, description: 'Router address (0x...).' },
    } as never,
    output: { schema: { type: 'object', additionalProperties: true } as never, render: (_a, v) => renderJson(v) as never },
    execute: async (args: never): Promise<unknown> =>
      heartbeatTool(await executeDeps(), args as never),
    presentCall: args => ({ card: 'generic', title: `Heartbeat ${(args as { router: string }).router}`, kind: 'execute' }),
  })))
}
