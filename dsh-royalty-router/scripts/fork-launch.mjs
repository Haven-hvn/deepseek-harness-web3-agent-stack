// Local-fork launch helper via the SDK path (no plugin tools).
// Funds the caller with fork-local play WETH, then build -> approve ->
// simulate -> send. Prints FORK_TOKEN / FORK_ROUTER / FORK_POOL_ID exports
// for the venue step. Fork-only: never point at mainnet.
//
// Usage (PowerShell, from dsh-royalty-router/):
//   $env:FORK_RPC="http://127.0.0.1:8545"
//   $env:FORK_FACTORY="0xB3B2..."
//   node scripts/fork-launch.mjs             # cheap 3% fixture
//   node scripts/fork-launch.mjs recommended # 20-step recommended model
import { createPublicClient, createWalletClient, http, erc20Abi } from 'viem'
import { base } from 'viem/chains'
import { privateKeyToAccount, toAccount } from 'viem/accounts'
import {
  adviseIntent,
  buildLaunch,
  deployments,
  launch,
  recommendedIntent,
  routerStatus,
} from '@royalty-router/sdk'

const RPC = process.env.FORK_RPC ?? process.env.RPC ?? 'http://127.0.0.1:8545'
const FACTORY = process.env.FORK_FACTORY ?? process.env.FACTORY
if (!FACTORY) throw new Error('set FORK_FACTORY to the deployed factory address')
// Well-known Anvil default key #0 (public, worthless, fork-only).
const PK = process.env.FORK_PK ?? '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const WETH = '0x4200000000000000000000000000000000000006'

const mode = process.argv[2] ?? 'cheap'
if (mode !== 'cheap' && mode !== 'recommended') {
  throw new Error('usage: node scripts/fork-launch.mjs [cheap|recommended]')
}

const account = privateKeyToAccount(PK)
const client = createPublicClient({ chain: base, transport: http(RPC) })
const wallet = createWalletClient({ account, chain: base, transport: http(RPC) })
const d = { ...deployments[base.id], factory: FACTORY }
const symbol = `FORK${Math.floor(Math.random() * 1_000_000)}`

let intent
if (mode === 'cheap') {
  // sdk/example.intent.json shape: 3 steps, 3% royalty, hard seed.
  intent = {
    name: 'Fork Launch Probe',
    symbol,
    reserveToken: WETH,
    feeRecipient: account.address,
    mintRoyaltyBps: 300,
    burnRoyaltyBps: 300,
    steps: [
      { rangeTo: 1000n * 10n ** 18n, price: 0n },
      { rangeTo: 100000n * 10n ** 18n, price: 10n ** 14n },
      { rangeTo: 1000000n * 10n ** 18n, price: 10n ** 15n },
    ],
    curveMint: 5000n * 10n ** 18n,
    seed: { tokens: 4000n * 10n ** 18n, secondary: 4n * 10n ** 17n },
  }
} else {
  intent = recommendedIntent({
    name: 'Fork Recommended Probe',
    symbol,
    reserveToken: WETH,
    feeRecipient: account.address,
    curve: {
      freeRange: 1000n * 10n ** 18n,
      maxSupply: 1000000n * 10n ** 18n,
      startPrice: 10n ** 14n,
      endPrice: 10n ** 15n,
    },
  })
}

console.log('advice', JSON.stringify(adviseIntent(intent)))
const built = await buildLaunch(client, d, intent)
console.log('predictedToken', built.predictedToken)
console.log('poolId        ', built.poolId)
console.log('value         ', built.value.toString())

// The launch pulls maxReserveIn WETH from the caller: deal it from the WETH
// contract's own balance via impersonation (local fork funds).
if (built.args.maxReserveIn > 0n) {
  await client.request({ method: 'anvil_impersonateAccount', params: [WETH] })
  try {
    const bank = createWalletClient({
      account: toAccount(WETH),
      chain: base,
      transport: http(RPC),
    })
    const fundHash = await bank.writeContract({
      address: WETH,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [account.address, built.args.maxReserveIn],
    })
    await client.waitForTransactionReceipt({ hash: fundHash })
  } finally {
    await client.request({ method: 'anvil_stopImpersonatingAccount', params: [WETH] })
  }
}

const res = await launch(client, wallet, d, built) // approve -> simulate -> send
console.log('launched', JSON.stringify(res))
const st = await routerStatus(client, res.router)
console.log(
  'routerStatus',
  JSON.stringify(st, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
)
console.log(`$env:FORK_TOKEN="${res.token}"`)
console.log(`$env:FORK_ROUTER="${res.router}"`)
console.log(`$env:FORK_POOL_ID="${res.poolId}"`)
