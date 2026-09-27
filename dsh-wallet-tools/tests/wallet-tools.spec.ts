/**
 * Executor proofs for dsh-wallet-tools (offline paths).
 *
 * Both tools declare string outputs and the registry validates results
 * strictly, so executing them through the real executor with stub seams
 * proves the string contract end to end. Live RPC is disabled: these specs
 * cover the treasury-read path only.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as walletTools from '../src/index.ts'

const ADDR = '0xa85dD3FbD8C2c831Ef156036F14638CcFf03b44e'
const testSignal = new AbortController().signal

async function harness() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.provide('wallet', {
    address: async () => ADDR,
    list: () => [{ name: 'agent', chain: 'evm', wallet: 'agent' }],
  })
  ctx.provide('treasury', {
    report: () => ({
      state: 'funded',
      totalValueUsd: 100_000_000,
      dailyBurnUsd: 0,
      runwayDays: 365,
      balances: [{ chain: 'ethereum', token: 'USDC', amount: 100_000_000, usdEstimate: 100_000_000 }],
      recentExpenses: [],
    }),
  })
  await ctx.plugin(walletTools, { wallet: 'agent', liveBalances: false })
  let calls = 0
  const execute = (name: string, args: Record<string, unknown>) => ctx.tools.execute({
    callId: ToolCallId(`call-${calls += 1}`),
    name,
    arguments: args,
    signal: testSignal,
  })
  return { execute }
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
})
