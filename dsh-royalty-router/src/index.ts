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
 * configuration carries names, never keys. The plugin declares
 * `inject = ['tools', 'wallet']`, so both must be mounted (reads never call
 * the seam, but Cordis forbids touching undeclared services).
 *
 * @module dsh-royalty-router
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Deployment } from '@royalty-router/sdk'
import type { PublicClient } from 'viem'
// Type-only: the read-back hook contract (runtime access to the guard stays
// optional via `ctx.reflect.get`, so this plugin mounts cleanly unguarded).
import type { CheckContext, CheckDecision } from 'dsh-exactly-once'
import { createClient, resolveChainOpts, resolveDeployment } from './chain.ts'
import { createSigningWalletClient, requireWalletName, withWalletLane } from './wallet.ts'
import {
  adviseIntentTool,
  assertAddress,
  buildTool,
  ExecuteLedger,
  heartbeatKeyFor,
  heartbeatTool,
  internals,
  launchKeyFor,
  launchTool,
  sweepKeyFor,
  sweepTool,
  venueTool,
  verifyLaunch,
  verifySweep,
} from './tools.ts'
import type { HeartbeatArgs, IntentArgs, SweepArgs } from './tools.ts'

export { createClient, resolveChainOpts, resolveDeployment } from './chain.ts'
export { createSigningAccount, createSigningWalletClient, requireWalletName, withWalletLane } from './wallet.ts'
export * from './tools.ts'

/** Cordis plugin name. */
export const name = 'royalty-router'
/**
 * Tool registry plus the wallet seam. Cordis only lets a plugin touch
 * services it declares, so the wallet must be listed even though only the
 * execute tools call it — reads never invoke `ctx.wallet`, but the plugin
 * stays dormant where `dsh-wallet` is not mounted (same shape as
 * `dsh-storage-synapse`). `dsh-wallet-ethereum` is additionally required
 * for actual signing.
 */
export const inject = ['tools', 'wallet'] as const

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
  symbol: { type: 'string', required: true, description: 'Token symbol, must be free on this chain.' },
  reserveToken: { type: 'string', required: true, description: 'mint.club reserve token (0x...).' },
  feeRecipient: { type: 'string', required: true, description: 'LP-fee remainder recipient (0x...).' },
  curve: { type: 'object', additionalProperties: true, description: 'Geometric curve spec; ignored when steps is given. Standard: {freeRange:"1000000000000000000000", maxSupply:"1000000000000000000000000", startPrice:"100000000000000", endPrice:"1000000000000000"}. All values MUST be decimal strings in quotes (wei); JSON numbers are rejected as lossy.' },
  steps: { type: 'array', description: 'Explicit [{rangeTo, price}] steps (alternative to curve). rangeTo/price MUST be decimal strings in quotes; JSON numbers are rejected as lossy.' },
  mintRoyaltyBps: { type: 'number', description: 'Mint royalty bps (default 1500).' },
  burnRoyaltyBps: { type: 'number', description: 'Burn royalty bps (default 1500).' },
  curveMint: { type: 'string', description: 'Seed tokens minted from the curve (wei). MUST be a decimal string in quotes.' },
  seed: { type: 'object', additionalProperties: true, description: '{tokens, secondary} seed targets (wei). Both MUST be decimal strings in quotes.' },
  secondary: { type: 'string', description: "Pool's other side (0x...; default native)." },
  fee: { type: 'number', description: 'Pool fee pips (default 3000).' },
  tickSpacing: { type: 'number', description: 'Pool tick spacing (default 60).' },
} as const

/** What the execute read-back hooks consult: the attempt ledger plus chain reads. */
export interface ExecuteHookDeps {
  ledger: ExecuteLedger
  getClient: () => PublicClient
  deployment: Deployment
}

/**
 * Build the exactly-once read-back hooks for the three execute tools over
 * one ledger: settled attempts replay, in-flight attempts report unknown
 * (the body attaches on dispatch), and ledger misses fall through to
 * chain read-back — `proceed` only on proven absence, `unknown` when the
 * chain cannot answer. Exported for tests; `apply` registers these lazily.
 */
export function createExecuteHooks(deps: ExecuteHookDeps): {
  checkLaunch: (input: unknown) => Promise<CheckDecision>
  checkSweep: (input: unknown) => Promise<CheckDecision>
  checkHeartbeat: (input: unknown) => Promise<CheckDecision>
} {
  const checkLaunch = async (input: unknown): Promise<CheckDecision> => {
    let key: string
    try {
      key = launchKeyFor(input as IntentArgs)
    } catch {
      return { kind: 'unknown' } // invalid args: the send surfaces the real error
    }
    const hit = deps.ledger.peek(key)
    if (hit !== undefined) return hit.kind === 'replay' ? { kind: 'replay', value: hit.value } : { kind: 'unknown' }
    let verdict: Awaited<ReturnType<typeof verifyLaunch>>
    try {
      verdict = await verifyLaunch(deps.getClient(), deps.deployment, input as IntentArgs)
    } catch {
      return { kind: 'unknown' }
    }
    if (verdict.state === 'committed') return { kind: 'replay', value: verdict.value }
    if (verdict.state === 'absent') return { kind: 'proceed' }
    return { kind: 'unknown' }
  }
  const checkSweep = async (input: unknown): Promise<CheckDecision> => {
    let key: string
    try {
      key = sweepKeyFor(input as SweepArgs)
    } catch {
      return { kind: 'unknown' }
    }
    const hit = deps.ledger.peek(key)
    if (hit !== undefined) return hit.kind === 'replay' ? { kind: 'replay', value: hit.value } : { kind: 'unknown' }
    let verdict: Awaited<ReturnType<typeof verifySweep>>
    try {
      verdict = await verifySweep(deps.getClient(), assertAddress((input as SweepArgs).router, 'router'))
    } catch {
      return { kind: 'unknown' }
    }
    if (verdict.state === 'committed') return { kind: 'replay', value: verdict.value }
    if (verdict.state === 'absent') return { kind: 'proceed' }
    return { kind: 'unknown' }
  }
  const checkHeartbeat = async (input: unknown): Promise<CheckDecision> => {
    // No reliable chain read-back (lastActive is unattributable across
    // keepers); a re-heartbeat is cheap and moves no funds.
    let key: string
    try {
      key = heartbeatKeyFor(input as HeartbeatArgs)
    } catch {
      return { kind: 'unknown' }
    }
    const hit = deps.ledger.peek(key)
    if (hit === undefined) return { kind: 'unknown' }
    return hit.kind === 'replay' ? { kind: 'replay', value: hit.value } : { kind: 'unknown' }
  }
  return { checkLaunch, checkSweep, checkHeartbeat }
}

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
  // Exactly-once: one attempt ledger per mount plus lazily registered
  // read-back hooks (mount-order-proof: each execute call hooks up when the
  // guard is present, and works unguarded otherwise).
  const ledger = new ExecuteLedger()
  const hooks = createExecuteHooks({ ledger, getClient: lazyClient, deployment })
  let hooked = false
  const hookDisposers: Array<() => void> = []
  function ensureHooks(): void {
    if (hooked) return
    const guard = ctx.reflect.get('exactlyOnce') as
      | { registerCheck?: (name: string, fn: (check: CheckContext) => Promise<CheckDecision>) => () => void }
      | undefined
    if (guard === null || guard === undefined || typeof guard.registerCheck !== 'function') return
    hookDisposers.push(
      guard.registerCheck('rr_launch', check => hooks.checkLaunch(check.args)),
      guard.registerCheck('rr_sweep', check => hooks.checkSweep(check.args)),
      guard.registerCheck('rr_heartbeat', check => hooks.checkHeartbeat(check.args)),
    )
    hooked = true
  }
  ctx.effect(() => () => {
    for (const dispose of hookDisposers.splice(0)) {
      try {
        dispose()
      } catch {}
    }
    hooked = false
  })

  // ── rr_advise (offline) ─────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'rr_advise',
    description:
      'Advise a mint.club graduation launch: fills the model-recommended intent and reports departures from it. Fully offline — no RPC, no key.',
    parameters: intentShape as never,
    output: { schema: { type: 'object', additionalProperties: true } as never, render: (_a, v) => renderJson(v) as never },
    execute: async (args: never): Promise<unknown> => adviseIntentTool(args as never),
    presentCall: () => ({ card: 'generic', title: 'Graduation advice', kind: 'read' }),
  })))

  // ── rr_venue (live reads) ───────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'rr_venue',
    description:
      'Quote one trade on both venues (mint.club curve vs pool) plus the crossover size. Reads only. amountIn is a decimal string (reserve wei to buy, token wei to sell).',
    parameters: {
      token: { type: 'string', required: true, description: 'Token address (0x...).' },
      secondary: { type: 'string', description: "Pool's other side (default native)." },
      fee: { type: 'number', description: 'Pool fee pips (default 3000).' },
      tickSpacing: { type: 'number', description: 'Pool tick spacing (default 60).' },
      side: { type: 'string', required: true, description: '"buy" or "sell".' },
      amountIn: { type: 'string', required: true, description: 'Exact trade size. MUST be a decimal string in quotes (reserve wei to buy, token wei to sell); JSON numbers are rejected as lossy.' },
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
      'Dry-run a graduation launch: struct, msg.value, approvals, predicted token and poolId. Needs a factory address. Signs nothing.',
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
      'Launch a graduation: build intent, simulate, then send. Caller funds the reserve/seed in the configured wallet. Signs via ctx.wallet. On swapper routes quote a real minOut.',
    parameters: intentShape as never,
    output: { schema: { type: 'object', additionalProperties: true } as never, render: (_a, v) => renderJson(v) as never },
    execute: async (args: never): Promise<unknown> => {
      ensureHooks()
      const intentArgs = args as unknown as IntentArgs
      const key = launchKeyFor(intentArgs)
      const walletName = requireWalletName(config)
      const deps = await executeDeps()
      const { value: result, source } = await ledger.run(key,
        () => withWalletLane(ctx, walletName, () => launchTool(deps, intentArgs)),
        {
          timeoutMs: internals.executeTimeoutMs,
          onTimeout: (ms) => new Error(
            `dsh-royalty-router: rr_launch timed out after ${ms}ms — the launch may have committed; `
            + 'retry and the attempt ledger resolves it before any re-send',
          ),
          verify: () => verifyLaunch(deps.client, deployment, intentArgs),
        })
      if (source !== 'ledger') {
        const row = result as { token?: string; tokenAddress?: string; symbol?: string; txHash?: string; hash?: string; factory?: string }
        ctx.emit('rr/launched', {
          chain: String(config.chainId ?? ''),
          token: row?.token ?? row?.tokenAddress,
          symbol: row?.symbol,
          tx: row?.txHash ?? row?.hash,
          factory: row?.factory,
        })
      }
      return result
    },
    presentCall: () => ({ card: 'generic', title: 'Graduation launch', kind: 'execute' }),
  })))

  // ── rr_sweep (keeper action; simulates first) ──────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'rr_sweep',
    description:
      'Sweep the pending royalties of one router into locked liquidity. Call when ready (pending clears MIN_CLAIM); else rr_heartbeat. Signs via ctx.wallet.',
    parameters: {
      router: { type: 'string', required: true, description: 'Router address (0x...).' },
      minOut: { type: 'string', description: 'Swap floor for swapper routes. MUST be a decimal string in quotes (default "0").' },
    } as never,
    output: { schema: { type: 'object', additionalProperties: true } as never, render: (_a, v) => renderJson(v) as never },
    execute: async (args: never): Promise<unknown> => {
      ensureHooks()
      const sweepArgs = args as unknown as SweepArgs
      const key = sweepKeyFor(sweepArgs)
      const walletName = requireWalletName(config)
      const deps = await executeDeps()
      const { value: result, source } = await ledger.run(key,
        () => withWalletLane(ctx, walletName, () => sweepTool(deps, sweepArgs)),
        {
          timeoutMs: internals.executeTimeoutMs,
          onTimeout: (ms) => new Error(
            `dsh-royalty-router: rr_sweep timed out after ${ms}ms — the sweep may have committed; `
            + 'retry and the attempt ledger resolves it before any re-send',
          ),
          verify: () => verifySweep(deps.client, assertAddress(sweepArgs.router, 'router')),
        })
      if (source !== 'ledger') {
        const row = result as { token?: string; txHash?: string; hash?: string; amount?: number }
        ctx.emit('rr/swept', {
          chain: String(config.chainId ?? ''),
          token: row?.token,
          tx: row?.txHash ?? row?.hash,
          amount: row?.amount,
        })
      }
      return result
    },
    presentCall: args => ({ card: 'generic', title: `Sweep ${(args as { router: string }).router}`, kind: 'execute' }),
  })))

  // ── rr_heartbeat (permissionless, moves no funds) ──────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'rr_heartbeat',
    description:
      'Stamp activity on a router with nothing worth sweeping. Moves no funds; still sends a tx. Signs via ctx.wallet.',
    parameters: {
      router: { type: 'string', required: true, description: 'Router address (0x...).' },
    } as never,
    output: { schema: { type: 'object', additionalProperties: true } as never, render: (_a, v) => renderJson(v) as never },
    execute: async (args: never): Promise<unknown> => {
      ensureHooks()
      const heartbeatArgs = args as unknown as HeartbeatArgs
      const key = heartbeatKeyFor(heartbeatArgs)
      const walletName = requireWalletName(config)
      const deps = await executeDeps()
      // No chain read-back: lastActive is unattributable across keepers.
      const { value } = await ledger.run(key,
        () => withWalletLane(ctx, walletName, () => heartbeatTool(deps, heartbeatArgs)),
        {
          timeoutMs: internals.executeTimeoutMs,
          onTimeout: (ms) => new Error(
            `dsh-royalty-router: rr_heartbeat timed out after ${ms}ms — the stamp may have committed; `
            + 'retry and the attempt ledger resolves it before any re-send',
          ),
        })
      return value
    },
    presentCall: args => ({ card: 'generic', title: `Heartbeat ${(args as { router: string }).router}`, kind: 'execute' }),
  })))
}
