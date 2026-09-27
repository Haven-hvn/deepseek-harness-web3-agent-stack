import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { refreshLive } from './live.ts'
import type { CatalogRow, IdentityRow, LedgerRow, TreasuryPill } from './snapshot.ts'
import { ObservatoryStore } from './store.ts'

export const name = 'observatory'
export const inject = [] as const

export interface Config {
  dir?: string
  pollMs?: number
  qbittorrentUrl?: string
  transmissionUrl?: string
  prowlarrUrl?: string
  supervisorSock?: string
  acquireStore?: string
}

export const Config: z<Config> = z.object({
  dir: z.string().default('/data/observatory'),
  pollMs: z.number().default(15_000),
  qbittorrentUrl: z.string().default('http://127.0.0.1:8080'),
  transmissionUrl: z.string().default('http://127.0.0.1:9091'),
  prowlarrUrl: z.string().default('http://127.0.0.1:9696'),
  supervisorSock: z.string().default('/data/supervisor.sock'),
  acquireStore: z.string().default('/data/downloads/acquire/acquisitions.json'),
})

export function apply(ctx: Context, config: Config): void {
  const store = new ObservatoryStore(config.dir ?? '/data/observatory')
  const catalog = new Map<string, CatalogRow>()
  let treasury: TreasuryPill | null = null
  let identity: IdentityRow | null = null
  let xmtp: { status: string; reason?: string } | null = null
  const on = ctx.on.bind(ctx) as (event: string, fn: (payload: Record<string, unknown>) => void) => void

  on('treasury/expense', expense => {
    const row: LedgerRow = {
      ts: Number(expense['timestamp'] ?? Date.now()),
      kind: 'burn',
      category: String(expense['category'] ?? 'tools'),
      amount: Number(expense['amount'] ?? 0),
      token: typeof expense['token'] === 'string' ? expense['token'] : undefined,
    }
    store.append(row)
    if (expense['category'] === 'inference') {
      store.append({
        ts: row.ts,
        kind: 'tokens',
        usd: row.amount,
        amount: row.amount,
        tokens: typeof expense['tokens'] === 'number' ? expense['tokens'] : undefined,
        model: typeof expense['model'] === 'string' ? expense['model'] : undefined,
        token: row.token,
      })
    }
  })

  on('treasury/state-changed', change => {
    const report = (change['report'] ?? {}) as Record<string, unknown>
    treasury = {
      state: String(change['current'] ?? report['state'] ?? 'unknown'),
      totalValueUsd: Number(report['totalValueUsd'] ?? 0),
      dailyBurnUsd: Number(report['dailyBurnUsd'] ?? 0),
      runwayDays: Number(report['runwayDays'] ?? 0),
      budget: report['budget'],
    }
    store.append({
      ts: Date.now(),
      kind: 'state',
      previous: String(change['previous'] ?? ''),
      current: String(change['current'] ?? ''),
    })
  })

  on('wallet/balances', payload => {
    const balances = Array.isArray(payload['balances']) ? payload['balances'] as Array<Record<string, unknown>> : []
    const address = typeof payload['address'] === 'string' ? payload['address'] : undefined
    for (const balance of balances) {
      store.append({
        ts: Date.now(),
        kind: 'balance',
        chain: String(balance['chain'] ?? ''),
        token: String(balance['token'] ?? ''),
        amount: Number(balance['amount'] ?? 0),
        usd: Number(balance['usd'] ?? balance['usdEstimate'] ?? 0),
        address,
      })
    }
  })

  on('rr/launched', payload => {
    store.append({
      ts: Date.now(),
      kind: 'launch',
      chain: String(payload['chain'] ?? ''),
      token: typeof payload['token'] === 'string' ? payload['token'] : undefined,
      symbol: typeof payload['symbol'] === 'string' ? payload['symbol'] : undefined,
      tx: typeof payload['tx'] === 'string' ? payload['tx'] : undefined,
      factory: typeof payload['factory'] === 'string' ? payload['factory'] : undefined,
      seedUsd: typeof payload['seedUsd'] === 'number' ? payload['seedUsd'] : undefined,
    })
  })

  on('rr/swept', payload => {
    store.append({
      ts: Date.now(),
      kind: 'revenue',
      stream: 'royalty',
      amount: Number(payload['amount'] ?? 0),
      token: typeof payload['token'] === 'string' ? payload['token'] : undefined,
      tx: typeof payload['tx'] === 'string' ? payload['tx'] : undefined,
      chain: typeof payload['chain'] === 'string' ? payload['chain'] : undefined,
    })
  })

  on('catalog/upsert', payload => {
    const cid = String(payload['cid'] ?? '')
    if (!cid) return
    const prev = catalog.get(cid)
    const gate = payload['gate']
    catalog.set(cid, {
      cid,
      gate: gate === 'aol' || gate === 'nft' || gate === 'memecoin' || gate === 'datadao' ? gate : (prev?.gate ?? 'none'),
      provider: typeof payload['provider'] === 'string' ? payload['provider'] : prev?.provider,
      expiresAt: typeof payload['expiresAt'] === 'number' ? payload['expiresAt'] : prev?.expiresAt,
      redundancy: typeof payload['redundancy'] === 'number' ? payload['redundancy'] : prev?.redundancy,
      token: typeof payload['token'] === 'string' ? payload['token'] : prev?.token,
      chain: typeof payload['chain'] === 'string' ? payload['chain'] : prev?.chain,
      threshold: typeof payload['threshold'] === 'string' ? payload['threshold'] : prev?.threshold,
    })
  })

  on('synapse/pinned', payload => {
    const cid = String(payload['cid'] ?? '')
    if (!cid) return
    const prev = catalog.get(cid)
    catalog.set(cid, { cid, gate: prev?.gate ?? 'none', provider: prev?.provider, expiresAt: prev?.expiresAt, redundancy: prev?.redundancy, token: prev?.token, chain: prev?.chain, threshold: prev?.threshold })
  })

  on('erc8004/registered', payload => {
    identity = {
      agentId: payload['agentId'] !== undefined ? String(payload['agentId']) : undefined,
      tokenUri: typeof payload['tokenUri'] === 'string' ? payload['tokenUri'] : undefined,
      tx: typeof payload['txHash'] === 'string' ? payload['txHash'] : undefined,
      owner: typeof payload['owner'] === 'string' ? payload['owner'] : undefined,
    }
  })

  on('xmtp/status', payload => {
    xmtp = { status: String(payload['status'] ?? 'unknown'), reason: typeof payload['reason'] === 'string' ? payload['reason'] : undefined }
  })

  const tick = () => {
    void refreshLive({
      qbittorrentUrl: config.qbittorrentUrl ?? 'http://127.0.0.1:8080',
      transmissionUrl: config.transmissionUrl ?? 'http://127.0.0.1:9091',
      prowlarrUrl: config.prowlarrUrl ?? 'http://127.0.0.1:9696',
      supervisorSock: config.supervisorSock ?? '/data/supervisor.sock',
      acquireStore: config.acquireStore ?? '/data/downloads/acquire/acquisitions.json',
    }, [...catalog.values()], treasury, identity, xmtp).then(live => store.writeLive(live)).catch(() => undefined)
  }
  tick()
  const timer = setInterval(tick, config.pollMs ?? 15_000)
  ctx.on('dispose', () => clearInterval(timer))
}
