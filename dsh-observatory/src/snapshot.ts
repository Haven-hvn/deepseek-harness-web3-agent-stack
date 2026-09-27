/**
 * Ledger rows, live file, and the public snapshot. No wallet, viem, or qBit.
 * @module dsh-observatory/snapshot
 */

export const LEDGER_KINDS = ['burn', 'balance', 'tokens', 'revenue', 'launch', 'state'] as const
export type LedgerKind = (typeof LEDGER_KINDS)[number]

export interface LedgerRow {
  ts: number
  kind: LedgerKind
  category?: string
  amount?: number
  token?: string
  chain?: string
  address?: string
  usd?: number
  tokens?: number
  model?: string
  stream?: 'royalty' | 'gate' | 'other'
  cid?: string
  tx?: string
  symbol?: string
  factory?: string
  seedUsd?: number
  previous?: string
  current?: string
}

export interface LiveFile {
  ts: number
  status: StatusRow[]
  downloads: DownloadRow[]
  treasury: TreasuryPill | null
  catalog: CatalogRow[]
  identity: IdentityRow | null
  xmtp: { status: string; reason?: string } | null
}

export interface StatusRow {
  program: string
  state: string
  uptime?: string
}

export interface DownloadRow {
  client: string
  state: string
  progress: number
  bytesLeft?: number
  speed?: number
}

export interface TreasuryPill {
  state: string
  totalValueUsd: number
  dailyBurnUsd: number
  runwayDays: number
  budget?: unknown
}

export interface CatalogRow {
  cid: string
  provider?: string
  expiresAt?: number
  redundancy?: number
  gate: 'none' | 'aol' | 'nft' | 'memecoin' | 'datadao'
  token?: string
  chain?: string
  threshold?: string
  price?: number
}

export interface IdentityRow {
  agentId?: string
  tokenUri?: string
  tx?: string
  owner?: string
}

const DROP = new Set([
  'name', 'path', 'magnet', 'hash', 'infohash', 'info_hash', 'save_path', 'savepath',
  'content_path', 'contentpath', 'description', 'prompt', 'text', 'body', 'payload',
  'title', 'indexer', 'downloadurl', 'magneturl', 'encryptedaeskey', 'filename',
])

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (DROP.has(key.toLowerCase())) continue
    out[key] = redact(child)
  }
  return out
}

export function explorerUrl(chain: string | number | undefined, kind: 'address' | 'tx', value: string | undefined): string | undefined {
  if (!value) return undefined
  const id = String(chain ?? '')
  const host =
    id === '84532' || id === 'base-sepolia' ? 'https://sepolia.basescan.org' :
    id === '11155111' || id === 'sepolia' ? 'https://sepolia.etherscan.io' :
    id === '314159' || id === 'filecoin-calibration' ? 'https://calibration.filfox.info/en' :
    id === '8453' || id === 'base' ? 'https://basescan.org' :
    id === '1' || id === 'ethereum' ? 'https://etherscan.io' :
    undefined
  if (!host) return undefined
  if (host.includes('filfox')) return kind === 'tx' ? `${host}/message/${value}` : `${host}/address/${value}`
  return kind === 'tx' ? `${host}/tx/${value}` : `${host}/address/${value}`
}

export function sinceMs(since: string | null, now = Date.now()): number | undefined {
  if (since === '24h') return now - 24 * 60 * 60 * 1000
  if (since === '7d') return now - 7 * 24 * 60 * 60 * 1000
  if (since === '30d') return now - 30 * 24 * 60 * 60 * 1000
  return undefined
}

export function filterLedger(rows: readonly LedgerRow[], query: { kind?: string | null; since?: string | null; token?: string | null }, now = Date.now()): LedgerRow[] {
  const cut = sinceMs(query.since ?? null, now)
  return rows.filter(row => {
    if (query.kind && row.kind !== query.kind) return false
    if (query.token && row.token !== query.token && row.cid !== query.token) return false
    if (cut !== undefined && row.ts < cut) return false
    return true
  })
}

export function roiFor(launch: LedgerRow, rows: readonly LedgerRow[]): number {
  if (!launch.token) return 0
  let revenue = 0
  let cost = 0
  for (const row of rows) {
    if (row.token !== launch.token && row.cid !== launch.token) continue
    if (row.kind === 'revenue') revenue += row.amount ?? 0
    if (row.kind === 'burn' || row.kind === 'tokens') cost += row.amount ?? row.usd ?? 0
  }
  return revenue - cost
}

export function buildSnapshot(rows: readonly LedgerRow[], live: LiveFile, query: { since?: string | null; token?: string | null } = {}): Record<string, unknown> {
  const windowed = filterLedger(rows, query)
  const launches = windowed.filter(row => row.kind === 'launch').map(row => ({
    ...row,
    explorer: explorerUrl(row.chain, 'tx', row.tx) ?? explorerUrl(row.chain, 'address', row.token),
    roi: roiFor(row, rows),
  }))
  const withLink = (row: LedgerRow) => ({
    ...row,
    explorer: explorerUrl(row.chain, 'address', row.address) ?? explorerUrl(row.chain, 'tx', row.tx) ?? explorerUrl(row.chain, 'address', row.token),
  })
  return {
    generatedAt: Date.now(),
    status: live.status,
    downloads: live.downloads,
    treasury: live.treasury,
    balances: windowed.filter(row => row.kind === 'balance').map(withLink),
    burn: windowed.filter(row => row.kind === 'burn'),
    tokens: windowed.filter(row => row.kind === 'tokens'),
    revenue: windowed.filter(row => row.kind === 'revenue').map(withLink),
    launches,
    catalog: live.catalog.map(row => ({ ...row, explorer: explorerUrl(row.chain, 'address', row.token) })),
    identity: live.identity ? { ...live.identity, explorer: explorerUrl(undefined, 'tx', live.identity.tx) } : null,
    xmtp: live.xmtp,
  }
}

export const EMPTY_LIVE: LiveFile = {
  ts: 0,
  status: [],
  downloads: [],
  treasury: null,
  catalog: [],
  identity: null,
  xmtp: null,
}
