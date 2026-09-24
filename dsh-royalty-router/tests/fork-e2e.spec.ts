/**
 * Fork E2E proof for dsh-royalty-router.
 *
 * Skipped unless `FORK_RPC` and `FORK_FACTORY` are set (env wiring).
 * Tests 1–6 are pure reads. Test 7 funds the probe caller with fork-local
 * play funds (WETH from the WETH contract's own balance via impersonation,
 * plus an approval tx) so the `eth_call` launch simulation can pull the
 * curve-mint reserve — mirroring the Solidity fork test's deal+approve.
 * Nothing leaves the fork: no router is created, no production touched.
 *
 * Run: FORK_RPC=http://127.0.0.1:8545 FORK_FACTORY=0x... pnpm vitest run dsh-royalty-router
 */

import { describe, expect, it } from 'vitest'
import { createWalletClient, erc20Abi, http } from 'viem'
import { base } from 'viem/chains'
import { privateKeyToAccount, toAccount } from 'viem/accounts'
import {
  bondAbi,
  buildLaunch,
  factoryAbi,
  simulateLaunch,
} from '@royalty-router/sdk'
import {
  createClient,
  resolveChainOpts,
  resolveDeployment,
} from '../src/chain.ts'
import { adviseIntentTool, buildIntent, buildTool } from '../src/tools.ts'

const WETH = '0x4200000000000000000000000000000000000006'
// Anvil default account 0 — pre-funded on the fork, used as eth_call
// `from` and fee recipient.
const ANVIL_DEFAULT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
// Well-known Anvil default key #0 (public, worthless, fork-only) — lets the
// probe caller approve the factory on the local fork.
const ANVIL_DEFAULT_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

const forkEnabled = Boolean(process.env.FORK_RPC) && Boolean(process.env.FORK_FACTORY)

/** Cheap 3%-curve probe intent (sdk/example.intent.json shape). */
function cheapIntent(symbol: string) {
  return {
    name: 'Fork E2E Probe',
    symbol,
    reserveToken: WETH,
    feeRecipient: ANVIL_DEFAULT,
    mintRoyaltyBps: 300,
    burnRoyaltyBps: 300,
    steps: [
      { rangeTo: '1000000000000000000000', price: '0' },
      { rangeTo: '100000000000000000000000', price: '100000000000000' },
      { rangeTo: '1000000000000000000000000', price: '1000000000000000' },
    ],
    curveMint: '5000000000000000000000',
    seed: { tokens: '4000000000000000000000', secondary: '400000000000000000' },
  }
}

describe.skipIf(!forkEnabled)('fork-e2e', () => {
  it('env resolves to the configured RPC + factory', () => {
    const opts = resolveChainOpts({})
    expect(opts.rpcUrl).toBe(process.env.FORK_RPC ?? process.env.RPC)
    expect(opts.factory).toBe(process.env.FORK_FACTORY ?? process.env.FACTORY)
    expect(opts.chainId).toBe(8453)
    const deployment = resolveDeployment(opts)
    expect(deployment.factory).toBe(opts.factory)
    expect(deployment.bond).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  it('fork answers as Base (chain 8453)', async () => {
    const opts = resolveChainOpts({})
    const client = createClient(opts)
    await expect(client.getChainId()).resolves.toBe(8453)
  }, 60_000)

  it('fork carries live Base state: bond creationFee > 0', async () => {
    const client = createClient(resolveChainOpts({}))
    const deployment = resolveDeployment(resolveChainOpts({}))
    const fee = (await client.readContract({
      address: deployment.bond,
      abi: bondAbi,
      functionName: 'creationFee',
    })) as bigint
    expect(fee).toBeGreaterThan(0n)
  }, 60_000)

  it('fork factory answers: feeInfo matches the deployment', async () => {
    const opts = resolveChainOpts({})
    const client = createClient(opts)
    const deployment = resolveDeployment(opts)
    const [dao, daoBps] = (await client.readContract({
      address: deployment.factory!,
      abi: factoryAbi,
      functionName: 'feeInfo',
    })) as [`0x${string}`, number]
    expect(dao.toLowerCase()).toBe(ANVIL_DEFAULT.toLowerCase())
    expect(Number(daoBps)).toBe(1000)
  }, 60_000)

  it('advise flags the cheap 3% probe (royalty-low)', async () => {
    const res = (await adviseIntentTool(cheapIntent('FORKADVISE'))) as {
      advice: { code: string }[]
    }
    expect(res.advice.map((a) => a.code)).toContain('royalty-low')
  })

  it('rr_build dry-run predicts token + poolId on the fork', async () => {
    const symbol = `FORK${Math.floor(Math.random() * 1_000_000)}`
    const opts = resolveChainOpts({})
    const deps = { client: createClient(opts), deployment: resolveDeployment(opts) }
    const res = (await buildTool(deps, cheapIntent(symbol))) as {
      predictedToken: string
      poolId: string
      value: string
    }
    expect(res.predictedToken).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(res.poolId).toMatch(/^0x[0-9a-f]{64}$/)
    expect(BigInt(res.value)).toBeGreaterThan(0n)
  }, 60_000)

  it('simulateLaunch succeeds after fork-local funding (no router created)', async () => {
    const symbol = `FORK${Math.floor(Math.random() * 1_000_000)}`
    const opts = resolveChainOpts({})
    const client = createClient(opts)
    const deployment = resolveDeployment(opts)
    const factory = deployment.factory!
    const built = await buildLaunch(client, deployment, buildIntent(cheapIntent(symbol)))

    // Fork-local funding (play funds): the launch pulls `maxReserveIn` WETH
    // from the caller, so deal it from the WETH contract's own balance via
    // impersonation, then approve the factory from the probe caller.
    await client.request({ method: 'anvil_impersonateAccount' as never, params: [WETH] } as never)
    try {
      const bank = createWalletClient({
        account: toAccount(WETH as `0x${string}`),
        chain: base,
        transport: http(opts.rpcUrl),
      })
      const fundHash = await bank.writeContract({
        address: WETH,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [ANVIL_DEFAULT, built.args.maxReserveIn],
      })
      await client.waitForTransactionReceipt({ hash: fundHash })
    } finally {
      await client.request({ method: 'anvil_stopImpersonatingAccount' as never, params: [WETH] } as never)
    }
    const caller = createWalletClient({
      account: privateKeyToAccount(ANVIL_DEFAULT_KEY),
      chain: base,
      transport: http(opts.rpcUrl),
    })
    const approveHash = await caller.writeContract({
      address: WETH,
      abi: erc20Abi,
      functionName: 'approve',
      args: [factory, built.args.maxReserveIn],
    })
    await client.waitForTransactionReceipt({ hash: approveHash })

    const sim = await simulateLaunch(client, deployment, built, ANVIL_DEFAULT)
    expect(sim.token.toLowerCase()).toBe(built.predictedToken.toLowerCase())
    expect(sim.router).toMatch(/^0x[0-9a-fA-F]{40}$/)
  }, 120_000)
})
