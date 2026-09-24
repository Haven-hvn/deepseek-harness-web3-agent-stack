/**
 * Fork venue + recommended-model proof. Reads only.
 *
 * Skipped unless `FORK_RPC` and `FORK_TOKEN` are set — the token is launched
 * out-of-band via `scripts/fork-launch.mjs`. Exercises the plugin's
 * `venueTool` against live fork state (previously stubbed-only), checks
 * `routerStatus` when `FORK_ROUTER` is set, and runs the recommended-model
 * pass (empty advice + dry-run predictions on the fork).
 *
 * Run: FORK_RPC=... FORK_TOKEN=0x... [FORK_ROUTER=0x...] pnpm vitest run dsh-royalty-router
 */

import { describe, expect, it } from 'vitest'
import { ZERO, poolIdOf, poolKeyFor, routerStatus } from '@royalty-router/sdk'
import {
  createClient,
  resolveChainOpts,
  resolveDeployment,
} from '../src/chain.ts'
import { adviseIntentTool, buildTool, venueTool } from '../src/tools.ts'

const WETH = '0x4200000000000000000000000000000000000006'
const FEE_RECIPIENT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

const forkToken = process.env.FORK_TOKEN
const forkRouter = process.env.FORK_ROUTER
const enabled = Boolean(process.env.FORK_RPC) && Boolean(forkToken)

function geometricArgs(symbol: string) {
  return {
    name: 'Test Token',
    symbol,
    reserveToken: WETH,
    feeRecipient: FEE_RECIPIENT,
    curve: {
      freeRange: '1000000000000000000000',
      maxSupply: '1000000000000000000000000',
      startPrice: '100000000000000',
      endPrice: '1000000000000000',
    },
  }
}

describe.skipIf(!enabled)('fork-venue', () => {
  it('quotes a buy on both venues with a crossover size', async () => {
    const opts = resolveChainOpts({})
    const deployment = resolveDeployment(opts)
    const deps = { client: createClient(opts), deployment }
    const res = (await venueTool(deps, {
      token: forkToken!,
      side: 'buy',
      amountIn: '10000000000000000',
    })) as {
      quote: { best: string }
      poolId: string
      crossoverSize: unknown
    }
    expect(['curve', 'pool']).toContain(res.quote.best)
    expect(res.poolId).toBe(
      poolIdOf(poolKeyFor(deployment, forkToken! as `0x${string}`, ZERO, 3000, 60)),
    )
    expect(res.crossoverSize === null || typeof res.crossoverSize === 'string').toBe(true)
  }, 60_000)

  it('quotes a sell on both venues', async () => {
    const opts = resolveChainOpts({})
    const deps = { client: createClient(opts), deployment: resolveDeployment(opts) }
    const res = (await venueTool(deps, {
      token: forkToken!,
      side: 'sell',
      amountIn: '1000000000000000000',
    })) as { quote: { best: string }; poolId: string }
    expect(['curve', 'pool']).toContain(res.quote.best)
    expect(res.poolId).toMatch(/^0x[0-9a-f]{64}$/)
  }, 60_000)

  it.skipIf(!forkRouter)('router status reads on the live router', async () => {
    const opts = resolveChainOpts({})
    const client = createClient(opts)
    const st = await routerStatus(client, forkRouter! as `0x${string}`)
    expect(st.minClaim).toBeGreaterThan(0n)
    expect(st.pending).toBeGreaterThanOrEqual(0n)
  }, 60_000)

  it('recommended model: empty advice + dry-run predicts on the fork', async () => {
    const symbol = `RFORK${Math.floor(Math.random() * 1_000_000)}`
    const args = geometricArgs(symbol)
    const adv = (await adviseIntentTool(args)) as { advice: unknown[] }
    expect(adv.advice).toEqual([])
    const opts = resolveChainOpts({})
    const deps = { client: createClient(opts), deployment: resolveDeployment(opts) }
    const res = (await buildTool(deps, args)) as {
      predictedToken: string
      poolId: string
    }
    expect(res.predictedToken).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(res.poolId).toMatch(/^0x[0-9a-f]{64}$/)
  }, 60_000)
})
