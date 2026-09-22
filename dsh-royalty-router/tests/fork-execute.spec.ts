/**
 * Fork execute proof for dsh-royalty-router.
 *
 * Skipped unless `FORK_RPC` and `FORK_FACTORY` are set. Sends REAL
 * transactions on the throwaway fork with play funds: fund caller (WETH via
 * impersonation + approval) → `launchTool` → `sweepTool` → `heartbeatTool`.
 * The plugin tool functions take an injected wallet client, so no harness
 * (and no `ctx.wallet` mock) is needed — the fork ANVIL key signs directly.
 * Creates real tokens/routers on the fork; never touches production.
 *
 * Run: FORK_RPC=http://127.0.0.1:8545 FORK_FACTORY=0x... pnpm vitest run dsh-royalty-router
 */

import { describe, expect, it } from 'vitest'
import { createWalletClient, erc20Abi, http } from 'viem'
import { base } from 'viem/chains'
import { privateKeyToAccount, toAccount } from 'viem/accounts'
import { routerStatus, buildLaunch } from '@royalty-router/sdk'
import {
  createClient,
  resolveChainOpts,
  resolveDeployment,
} from '../src/chain.ts'
import { requireWalletName } from '../src/wallet.ts'
import {
  buildIntent,
  buildTool,
  heartbeatTool,
  launchTool,
  sweepTool,
} from '../src/tools.ts'

const WETH = '0x4200000000000000000000000000000000000006'
const ANVIL_DEFAULT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
// Well-known Anvil default key #0 (public, worthless, fork-only).
const FORK_PK = process.env.FORK_PK
  ?? '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

const forkEnabled = Boolean(process.env.FORK_RPC) && Boolean(process.env.FORK_FACTORY)

/** Cheap 3%-curve probe intent (sdk/example.intent.json shape). */
function cheapIntent(symbol: string) {
  return {
    name: 'Fork Execute Probe',
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

describe('execute arg validation (offline)', () => {
  it('rejects a malformed router without touching the network', async () => {
    await expect(sweepTool(
      { client: undefined as never, deployment: undefined as never, wallet: undefined as never },
      { router: 'not-an-address' },
    )).rejects.toThrow('router must be a 0x-prefixed 20-byte address')
    await expect(heartbeatTool(
      { client: undefined as never, deployment: undefined as never, wallet: undefined as never },
      { router: '0x1234' },
    )).rejects.toThrow('router must be a 0x-prefixed 20-byte address')
  })

  it('rejects a non-decimal minOut without touching the network', async () => {
    await expect(sweepTool(
      { client: undefined as never, deployment: undefined as never, wallet: undefined as never },
      { router: ANVIL_DEFAULT, minOut: '12.5' },
    )).rejects.toThrow('minOut must be a decimal-string integer')
  })

  it('launchTool fails actionable without a factory (offline)', async () => {
    const deployment = resolveDeployment({ rpcUrl: 'https://mainnet.base.org', chainId: 8453 })
    await expect(launchTool(
      { client: undefined as never, deployment, wallet: undefined as never },
      cheapIntent('FORKX'),
    )).rejects.toThrow('no factory configured')
  })

  it('requireWalletName fails actionable without a wallet name (offline)', () => {
    expect(() => requireWalletName({})).toThrow("need a 'wallet' in plugin config")
    expect(requireWalletName({ wallet: 'my-wallet' })).toBe('my-wallet')
  })
})

describe.skipIf(!forkEnabled)('fork-execute (real txs, play funds)', () => {
  // Sequential: launch → sweep → heartbeat share the launched router.
  let launchedRouter = ''
  let launchedToken = ''

  it('launchTool launches for real and matches the dry-run prediction', async () => {
    const symbol = `FX${Math.floor(Math.random() * 1_000_000)}`
    const opts = resolveChainOpts({})
    const client = createClient(opts)
    const deployment = resolveDeployment(opts)
    const factory = deployment.factory!
    const wallet = createWalletClient({
      account: privateKeyToAccount(FORK_PK as `0x${string}`),
      chain: base,
      transport: http(opts.rpcUrl),
    })

    // Dry-run first: the prediction the launch must match, plus the reserve need.
    const dry = (await buildTool({ client, deployment }, cheapIntent(symbol))) as {
      predictedToken: string
    }
    const need = (
      await buildLaunch(client, deployment, buildIntent(cheapIntent(symbol)))
    ).args.maxReserveIn

    // Fork-local funding (play funds): deal the reserve, approve the factory.
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
        args: [ANVIL_DEFAULT, need],
      })
      await client.waitForTransactionReceipt({ hash: fundHash })
    } finally {
      await client.request({ method: 'anvil_stopImpersonatingAccount' as never, params: [WETH] } as never)
    }
    const approveHash = await wallet.writeContract({
      address: WETH,
      abi: erc20Abi,
      functionName: 'approve',
      args: [factory, need],
    })
    await client.waitForTransactionReceipt({ hash: approveHash })

    const res = (await launchTool({ client, deployment, wallet }, cheapIntent(symbol))) as {
      hash: string
      token: string
      router: string
      poolId: string
    }
    expect(res.hash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(res.token.toLowerCase()).toBe(dry.predictedToken.toLowerCase())
    expect(res.router).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(res.poolId).toMatch(/^0x[0-9a-f]{64}$/)
    launchedRouter = res.router
    launchedToken = res.token
  }, 180_000)

  it('sweepTool sweeps the seed-mint royalty into locked liquidity', async () => {
    const opts = resolveChainOpts({})
    const client = createClient(opts)
    const deployment = resolveDeployment(opts)
    const wallet = createWalletClient({
      account: privateKeyToAccount(FORK_PK as `0x${string}`),
      chain: base,
      transport: http(opts.rpcUrl),
    })
    const before = await routerStatus(client, launchedRouter as `0x${string}`)
    expect(before.pending).toBeGreaterThan(0n)
    const res = (await sweepTool(
      { client, deployment, wallet },
      { router: launchedRouter },
    )) as { hash: string; status: string }
    expect(res.hash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(res.status).toBe('success')
    const after = await routerStatus(client, launchedRouter as `0x${string}`)
    expect(after.pending).toBeLessThan(before.pending)
    expect(launchedToken).toMatch(/^0x[0-9a-fA-F]{40}$/)
  }, 120_000)

  it('heartbeatTool stamps activity without moving funds', async () => {
    const opts = resolveChainOpts({})
    const client = createClient(opts)
    const deployment = resolveDeployment(opts)
    const wallet = createWalletClient({
      account: privateKeyToAccount(FORK_PK as `0x${string}`),
      chain: base,
      transport: http(opts.rpcUrl),
    })
    const res = (await heartbeatTool(
      { client, deployment, wallet },
      { router: launchedRouter },
    )) as { transactionHash: string; status: string }
    expect(res.transactionHash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(res.status).toBe('success')
  }, 120_000)
})
