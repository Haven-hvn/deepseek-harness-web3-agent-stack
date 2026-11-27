/**
 * Executor proofs for dsh-wallet-tools (offline treasury path + mocked live EOA
 * and Filecoin Pay contract balance separation).
 *
 * Both tools declare string outputs and the registry validates results
 * strictly, so executing them through the real executor with stub seams
 * proves the string contract end to end.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as walletTools from '../src/index.ts'

const ADDR = '0xa85dD3FbD8C2c831Ef156036F14638CcFf03b44e'
const testSignal = new AbortController().signal

afterEach(() => {
  vi.restoreAllMocks()
})

async function harness(opts?: {
  liveBalances?: boolean
  synapse?: { paymentStatus: () => Promise<unknown> }
  onUpdateBalances?: (rows: unknown[]) => void
}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  ctx.provide('wallet', {
    address: async () => ADDR,
    list: () => [{ name: 'agent', chain: 'evm', wallet: 'agent' }],
  })
  const balances: Array<{ chain: string; token: string; amount: number; usdEstimate: number }> = [
    { chain: 'ethereum', token: 'USDC', amount: 100_000_000, usdEstimate: 100_000_000 },
  ]
  ctx.provide('treasury', {
    report: () => ({
      state: 'funded',
      totalValueUsd: balances.reduce((s, b) => s + b.usdEstimate, 0),
      dailyBurnUsd: 0,
      runwayDays: 365,
      balances,
      recentExpenses: [],
    }),
    updateBalances: async (next: Array<{ chain: string; token: string; amount: number; usdEstimate: number }>) => {
      opts?.onUpdateBalances?.(next)
      balances.splice(0, balances.length, ...next)
      return { state: 'funded', runwayDays: 365, balances }
    },
  })
  if (opts?.synapse) {
    ctx.provide('synapse', opts.synapse)
  }
  await ctx.plugin(walletTools, {
    wallet: 'agent',
    liveBalances: opts?.liveBalances ?? false,
    chains: [
      {
        chain: 'filecoin-calibration',
        chainId: 314159,
        rpcUrls: ['https://rpc.calibration.test'],
        nativeToken: 'tFIL',
        nativeDecimals: 18,
        label: 'Filecoin calibration',
      },
    ],
    tokens: [
      {
        chain: 'filecoin-calibration',
        token: 'USDFC',
        address: '0xb3042734b608a1B16e9e86B374A3f3e389B4cDf0',
        decimals: 18,
      },
    ],
  })
  let calls = 0
  const execute = async (name: string, args: Record<string, unknown>) => {
    const batch = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: ToolCallId(`call-${calls += 1}`), name, arguments: JSON.stringify(args) }],
      signal: testSignal,
    })
    return batch.results[0]!.result
  }
  return { ctx, execute }
}

describe('wallet-tools through the executor', () => {
  it('wallet_info returns the live address as a string result', async () => {
    const { execute } = await harness()
    const res = await execute('wallet_info', {})
    expect(res.isError).toBe(false)
    expect(JSON.stringify(res.content)).toContain(ADDR)
    expect(JSON.stringify(res.content)).toContain('funded')
  })

  it('get_balances reads the treasury ledger as a string result', async () => {
    const { execute } = await harness()
    const res = await execute('get_balances', {})
    expect(res.isError).toBe(false)
    expect(JSON.stringify(res.content)).toContain('USDC')
  })

  it('get_balances reports unknown chain filters without throwing', async () => {
    const { execute } = await harness()
    const res = await execute('get_balances', { chain: 'nope' })
    expect(res.isError).toBe(false)
    expect(JSON.stringify(res.content)).toContain('No treasury balances')
  })

  it('counts wallet USDFC and Filecoin Pay contract USDFC separately in live output and treasury sync', async () => {
    // 200 tFIL native, 27.38 USDFC in wallet EOA, 2.62 USDFC in Filecoin Pay contract -> total $30.00.
    const walletUsdfcHex = '0x' + (27_380_000_000_000_000_000n).toString(16)
    const tfilHex = '0x' + (200_000_000_000_000_000_000n).toString(16)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.includes('coingecko')) {
        return new Response(JSON.stringify({ ethereum: { usd: 3000 }, filecoin: { usd: 4 } }), { status: 200 })
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { method: string }
      const result = body.method === 'eth_getBalance' ? tfilHex : walletUsdfcHex
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 })
    })

    let syncedRows: Array<{ chain: string; token: string; amount: number; usdEstimate: number }> = []
    const { execute } = await harness({
      liveBalances: true,
      onUpdateBalances: rows => { syncedRows = rows as typeof syncedRows },
      synapse: {
        paymentStatus: async () => ({
          chain: 'filecoin-calibration',
          network: 'Filecoin - Calibration testnet',
          address: ADDR,
          depositedUsdfcRaw: '2620000000000000000',
          depositedUsdfc: '2.62',
          lockedUsdfcRaw: '1620000000000000000',
          lockedUsdfc: '1.62',
          availableUsdfcRaw: '1000000000000000000',
          availableUsdfc: '1',
          warmStorageApproved: true,
          runwayState: 'active' as const,
          runwayDays: 30,
          runwayHours: 4,
        }),
      },
    })

    const res = await execute('get_balances', { live: true, sync: true })
    expect(res.isError).toBe(false)
    const text = (res.content[0] as { text: string }).text
    expect(text).toContain('[wallet, ok')
    expect(text).toContain('USDFC 27.38')
    expect(text).toContain('[Filecoin Pay contract]: USDFC 2.62 deposited (available 1, locked 1.62; Warm Storage approved; runway: 30d 4h)')
    expect(text).toContain('total ~$30.00')

    // Treasury stores wallet EOA USDFC and Filecoin Pay contract USDFC_PAY as distinct rows.
    expect(syncedRows.map(r => `${r.chain}:${r.token}`).sort()).toEqual([
      'filecoin-calibration:USDFC',
      'filecoin-calibration:USDFC_PAY',
      'filecoin-calibration:tFIL',
    ])
    const walletRow = syncedRows.find(r => r.token === 'USDFC')
    const contractRow = syncedRows.find(r => r.token === 'USDFC_PAY')
    expect(walletRow?.usdEstimate).toBe(27_380_000)
    expect(contractRow?.usdEstimate).toBe(2_620_000)

    // Subsequent cached treasury read preserves both buckets clearly.
    const cached = await execute('get_balances', {})
    const cachedText = (cached.content[0] as { text: string }).text
    expect(cachedText).toContain('filecoin-calibration:USDFC 27.38 USDFC')
    expect(cachedText).toContain('filecoin-calibration:USDFC_PAY (Filecoin Pay contract) 2.62 USDFC')
  })

  it('degrades gracefully when the Filecoin Pay contract probe fails without losing wallet balances', async () => {
    const walletUsdfcHex = '0x' + (30_000_000_000_000_000_000n).toString(16)
    const tfilHex = '0x' + (200_000_000_000_000_000_000n).toString(16)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.includes('coingecko')) return new Response('', { status: 503 })
      const body = JSON.parse(String(init?.body ?? '{}')) as { method: string }
      const result = body.method === 'eth_getBalance' ? tfilHex : walletUsdfcHex
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 })
    })

    const { execute } = await harness({
      liveBalances: true,
      synapse: {
        paymentStatus: async () => { throw new Error('calibnet RPC 502') },
      },
    })

    const res = await execute('get_balances', { live: true })
    expect(res.isError).toBe(false)
    const text = (res.content[0] as { text: string }).text
    expect(text).toContain('USDFC 30')
    expect(text).toContain('filecoin-pay [contract, unavailable]: calibnet RPC 502')
  })
})
