/**
 * Offline seam proofs for dsh-royalty-router tool logic.
 *
 * No network, no harness: exercises the pure functions in src/tools.ts
 * (intent construction, model advice, JSON safety, factory guard) plus a
 * stubbed viem client for the venue math. The fork suites cover the live
 * path — the plugin's reads are thin wrappers over SDK calls already
 * covered by sdk/test/.
 */

import { describe, expect, it } from 'vitest'
import {
  adviseIntentTool,
  big,
  buildIntent,
  buildTool,
  jsonSafe,
  num,
  venueTool,
} from '../src/tools.ts'
import { assembleSignedTransaction } from '../src/wallet.ts'
import { resolveDeployment } from '../src/chain.ts'

const WETH = '0x4200000000000000000000000000000000000006'
const FEE_RECIPIENT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

function geometricArgs() {
  return {
    name: 'Test Token',
    symbol: 'TT',
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

describe('adviseIntentTool (offline)', () => {
  it('recommended fill matches the model defaults with empty advice', async () => {
    const res = await adviseIntentTool(geometricArgs()) as {
      intent: { mintRoyaltyBps: number; burnRoyaltyBps: number }
      advice: unknown[]
      bandBps: number
    }
    expect(res.intent.mintRoyaltyBps).toBe(1500)
    expect(res.intent.burnRoyaltyBps).toBe(1500)
    expect(res.advice).toEqual([])
    expect(res.bandBps).toBe(3529) // 15%/15% → 35% band per SDK docs
  })

  it('flags a 3% explicit-curve intent (sdk/example.intent.json shape)', async () => {
    const res = await adviseIntentTool({
      name: 'Royalty Router Demo',
      symbol: 'RRDEMO-7f3a',
      reserveToken: WETH,
      feeRecipient: FEE_RECIPIENT,
      mintRoyaltyBps: 300,
      burnRoyaltyBps: 300,
      steps: [
        { rangeTo: '1000000000000000000000', price: '0' },
        { rangeTo: '100000000000000000000000', price: '100000000000000' },
        { rangeTo: '1000000000000000000000000', price: '1000000000000000' },
      ],
      curveMint: '5000000000000000000000',
      seed: { tokens: '4000000000000000000000', secondary: '400000000000000000' },
    }) as { advice: { code: string }[] }
    expect(res.advice.map(a => a.code)).toContain('royalty-low')
  })

  it('flags coarse steps', async () => {
    const args = geometricArgs()
    const res = await adviseIntentTool({
      ...args,
      steps: [
        { rangeTo: '1000000000000000000000', price: '0' },
        { rangeTo: '500000000000000000000000', price: '100000000000000' },
        // 10× jump: hands the pool's reserve to arbitrageurs at the boundary
        { rangeTo: '1000000000000000000000000', price: '1000000000000000' },
      ],
      mintRoyaltyBps: 1500,
      burnRoyaltyBps: 1500,
      seed: { tokens: '800000000000000000000', secondary: '80000000000000000' },
    }) as { advice: { code: string }[] }
    expect(res.advice.map(a => a.code)).toContain('steps-coarse')
  })

  it('requires royalties and seed with explicit steps', async () => {
    await expect(adviseIntentTool({
      ...geometricArgs(),
      steps: [{ rangeTo: '1000', price: '0' }],
    } as never)).rejects.toThrow('require mintRoyaltyBps and burnRoyaltyBps')
  })

  it('requires curve or steps', async () => {
    await expect(adviseIntentTool({
      name: 'x', symbol: 'X', reserveToken: WETH, feeRecipient: FEE_RECIPIENT,
    } as never)).rejects.toThrow('either curve')
  })
})

describe('input validation', () => {
  it('rejects malformed addresses without echoing input', async () => {
    await expect(adviseIntentTool({
      ...geometricArgs(), reserveToken: 'not-an-address',
    })).rejects.toThrow('reserveToken must be a 0x-prefixed 20-byte address')
  })

  it('rejects non-decimal bigints', () => {
    expect(() => big('12.5', 'amountIn')).toThrow('decimal-string integer')
    expect(() => big('', 'amountIn')).toThrow('decimal-string integer')
    expect(big('  1000  ', 'amountIn')).toBe(1000n)
  })

  it('accepts quoted-or-plain numbers both ways (no caller trap)', () => {
    expect(num(1500, 'mintRoyaltyBps')).toBe(1500)
    expect(num('1500', 'mintRoyaltyBps')).toBe(1500)
    expect(() => num('12.5', 'fee')).toThrow('must be a number')
    expect(() => num('abc', 'fee')).toThrow('must be a number')
    expect(big(1000, 'curveMint')).toBe(1000n)
    expect(big('1000', 'curveMint')).toBe(1000n)
    expect(() => big(1e21, 'curveMint')).toThrow('decimal-string integer')
  })
})

describe('jsonSafe', () => {
  it('renders nested bigints as decimal strings and guards Infinity', () => {
    expect(jsonSafe({ a: 10n, b: [1n, { c: 2n }], d: Infinity, e: 'x' }))
      .toEqual({ a: '10', b: ['1', { c: '2' }], d: 'infinity', e: 'x' })
  })

  it('drops undefined object values and nulls array holes (harness lossless rule)', () => {
    expect(jsonSafe({ a: 1, b: undefined, c: { d: undefined, e: 2 } }))
      .toEqual({ a: 1, c: { e: 2 } })
    expect(jsonSafe([1, undefined, 2])).toEqual([1, null, 2])
  })
})

describe('buildTool factory guard', () => {
  it('fails actionable without a factory address', async () => {
    const deployment = resolveDeployment({ rpcUrl: 'https://mainnet.base.org', chainId: 8453 })
    await expect(buildTool(
      { client: undefined as never, deployment },
      geometricArgs(),
    )).rejects.toThrow("no factory configured")
  })

  it('rejects unknown chains', () => {
    expect(() => resolveDeployment({ rpcUrl: 'https://x', chainId: 1 }))
      .toThrow('unsupported chain 1')
  })
})

describe('venueTool (stubbed client)', () => {
  // readVenueState call order: getSteps, tokenBond, totalSupply, slot0, liquidity.
  function stubClient() {
    const calls: string[] = []
    return {
      calls,
      client: {
        readContract: async (args: { functionName: string }) => {
          calls.push(args.functionName)
          switch (args.functionName) {
            case 'getSteps':
              return [
                { rangeTo: 1000000000000000000000n, price: 0n },
                { rangeTo: 1000000000000000000000000n, price: 100000000000000n },
              ]
            case 'tokenBond':
              return [WETH, 1500, 1500, 0, WETH, 0n] as const
            case 'totalSupply':
              return 500000000000000000000000n
            case 'extsload':
              // slot0 then liquidity (low 160 / 128 bits carry the values)
              return calls.filter(c => c === 'extsload').length === 1
                ? `0x${(2n ** 96n).toString(16).padStart(64, '0')}`
                : `0x${(1000000n).toString(16).padStart(64, '0')}`
            default:
              throw new Error(`unexpected call ${args.functionName}`)
          }
        },
      },
    }
  }

  it('quotes both venues and returns a poolId', async () => {
    const { client } = stubClient()
    const deployment = resolveDeployment({ rpcUrl: 'https://mainnet.base.org', chainId: 8453 })
    const res = await venueTool({ client: client as never, deployment }, {
      token: '0x1111111111111111111111111111111111111111',
      side: 'buy',
      amountIn: '10000000000000000',
    }) as { quote: { best: string }; poolId: string; crossoverSize: unknown }
    expect(['curve', 'pool']).toContain(res.quote.best)
    expect(res.poolId).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('rejects a bad side', async () => {
    const deployment = resolveDeployment({ rpcUrl: 'https://mainnet.base.org', chainId: 8453 })
    await expect(venueTool({ client: undefined as never, deployment }, {
      token: WETH, side: 'hold', amountIn: '1',
    } as never)).rejects.toThrow('"buy" or "sell"')
  })
})

describe('buildIntent', () => {
  it('applies royalty overrides on the geometric path', () => {
    const intent = buildIntent({ ...geometricArgs(), mintRoyaltyBps: 500, burnRoyaltyBps: 500 })
    expect(intent.mintRoyaltyBps).toBe(500)
    expect(intent.steps.length).toBeGreaterThan(2)
  })
})

describe('assembleSignedTransaction (offline, local secp256k1 only)', () => {
  it('combines a bare RSV into a signed tx recovering the signer; passes full txs through', async () => {
    const { keccak256, serializeTransaction } = await import('viem')
    const { privateKeyToAccount } = await import('viem/accounts')
    // Well-known Anvil default key #0 (public, worthless, fork-only).
    const account = privateKeyToAccount(
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    )
    const unsigned = {
      chainId: 8453,
      to: '0x1111111111111111111111111111111111111111',
      value: 100n,
      nonce: 7,
      gas: 100000n,
      maxFeePerGas: 1000000000n,
      maxPriorityFeePerGas: 1000000000n,
      type: 'eip1559',
      data: '0x1234',
    } as const
    // What OWS returns for the same payload: bare 65-byte RSV.
    const digest = keccak256(serializeTransaction(unsigned as never))
    const rsv = await account.sign({ hash: digest })
    expect(rsv.length).toBe(132)
    // Byte-identical to viem's own native signing: the strongest possible
    // assertion (viem's parseTransaction never populates `from`, so compare
    // bytes and recover explicitly instead).
    const native = await account.signTransaction(unsigned as never)
    const assembled = await assembleSignedTransaction(unsigned, rsv)
    expect(assembled).toBe(native)
    const { recoverAddress } = await import('viem')
    await expect(recoverAddress({ hash: digest, signature: rsv as never })).resolves.toBe(account.address)
    // OWS shape: bare 65-byte RSV as 130 prefix-less hex chars.
    const assembledBare = await assembleSignedTransaction(unsigned, rsv.slice(2))
    expect(assembledBare).toBe(native)
    // Raw-provider shape (already-signed tx) passes through untouched.
    const signed = await account.signTransaction(unsigned as never)
    await expect(assembleSignedTransaction(unsigned, signed)).resolves.toBe(signed)
    // 130 hex chars with an impossible v byte are rejected, not broadcast.
    await expect(assembleSignedTransaction(unsigned, `${rsv.slice(0, 130)}ff`)).rejects.toThrow('malformed RSV')
    await expect(assembleSignedTransaction(unsigned, 'not-hex')).rejects.toThrow('non-hex signature')
  })
})
