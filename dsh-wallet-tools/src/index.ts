import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from 'dsh-wallet'

export const name = 'wallet-tools'
export const inject = ['wallet', 'tools', 'treasury']

export interface Config {
  wallet: string
}
export const Config: z<Config> = z.object({
  wallet: z.string().required(),
})

export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'wallet_info',
    description: 'Get the agent EVM wallet address and funding instructions. Call when user asks what is your address, wallet, balance, or how to fund you. Returns address, chain, treasury state, balances and funding guidance.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render(_args: unknown, value: string) { return [{ type: 'text', text: value }] as never },
    },
    execute: async () => {
      const address = await (ctx as unknown as { wallet: { address: (n: string) => Promise<string>; list: () => Array<{ name: string; chain: string; wallet: string }> } }).wallet.address(config.wallet)
      const list = (ctx as unknown as { wallet: { list: () => Array<{ name: string; chain: string; wallet: string }> } }).wallet.list().find(w => w.name === config.wallet)
      let treasuryInfo = 'Treasury (ctx.treasury) is manual ledger — shows UNFUNDED until admin runs ctx.treasury.updateBalances([{chain:"ethereum",token:"USDC",amount,usdEstimate}]), but XMTP messaging is live.'
      try {
        const treasury = (ctx as unknown as { treasury?: { report: () => { state: string; totalValueUsd: number; runwayDays: number; balances: Array<{ chain: string; token: string; amount: number; usdEstimate: number }> } } }).treasury
        if (treasury && typeof treasury.report === 'function') {
          const report = treasury.report()
          const totalUsd = (report.totalValueUsd / 1e6).toFixed(2)
          const balancesDesc = report.balances.map(b => `${b.chain}:${b.token} ${b.amount} ($${(b.usdEstimate/1e6).toFixed(2)})`).join(', ') || 'none'
          treasuryInfo = `Treasury state: ${report.state} total $${totalUsd} runway ${report.runwayDays}d balances [${balancesDesc}]`
        }
      } catch {}
      return `Wallet ${config.wallet}: address ${address} chain ${list?.chain ?? 'evm'} (OWS vault ${list?.wallet ?? config.wallet}). ${treasuryInfo} To fund: send USDC/USDFC or native gas to ${address} on Filecoin FEVM / Ethereum.`
    },
  })))
}
