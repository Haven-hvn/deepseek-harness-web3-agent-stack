import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { CatalogRow, DownloadRow, LiveFile, StatusRow, TreasuryPill } from './snapshot.ts'

const exec = promisify(execFile)

export interface LiveConfig {
  qbittorrentUrl: string
  transmissionUrl: string
  prowlarrUrl: string
  supervisorSock: string
  acquireStore: string
}

export async function refreshLive(config: LiveConfig, catalog: CatalogRow[], treasury: TreasuryPill | null, identity: LiveFile['identity'], xmtp: LiveFile['xmtp']): Promise<LiveFile> {
  const [status, qbit, transmission, acquire, prowlarr] = await Promise.all([
    supervisorStatus(config.supervisorSock),
    qbitDownloads(config.qbittorrentUrl),
    transmissionDownloads(config.transmissionUrl),
    acquireDownloads(config.acquireStore),
    ping(config.prowlarrUrl, '/ping'),
  ])
  const programs = status.filter(row => row.program !== 'prowlarr')
  programs.push({ program: 'prowlarr', state: prowlarr ? 'RUNNING' : 'DOWN' })
  if (!programs.some(row => row.program === 'qbittorrent')) {
    programs.push({ program: 'qbittorrent', state: qbit.up ? 'RUNNING' : 'DOWN' })
  }
  if (!programs.some(row => row.program === 'transmission')) {
    programs.push({ program: 'transmission', state: transmission.up ? 'RUNNING' : 'DOWN' })
  }
  return {
    ts: Date.now(),
    status: programs,
    downloads: [...qbit.rows, ...transmission.rows, ...acquire],
    treasury,
    catalog,
    identity,
    xmtp,
  }
}

async function supervisorStatus(sock: string): Promise<StatusRow[]> {
  try {
    const { stdout } = await exec('supervisorctl', ['-s', `unix://${sock}`, 'status'], { timeout: 4000 })
    return stdout.split('\n').filter(Boolean).map(line => {
      const [program, state, ...rest] = line.trim().split(/\s+/)
      return { program: program ?? 'unknown', state: state ?? 'UNKNOWN', uptime: rest.join(' ') || undefined }
    })
  } catch {
    return []
  }
}

async function ping(origin: string, path: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(3000) })
    return response.ok
  } catch {
    return false
  }
}

async function qbitDownloads(origin: string): Promise<{ up: boolean; rows: DownloadRow[] }> {
  try {
    const response = await fetch(`${origin}/api/v2/torrents/info`, { signal: AbortSignal.timeout(4000) })
    if (!response.ok) return { up: false, rows: [] }
    const items = await response.json() as Array<Record<string, unknown>>
    return {
      up: true,
      rows: items.map(item => ({
        client: 'qbittorrent',
        state: String(item['state'] ?? 'unknown'),
        progress: Number(item['progress'] ?? 0) || 0,
        bytesLeft: Number(item['amount_left'] ?? 0) || 0,
        speed: Number(item['dlspeed'] ?? 0) || 0,
      })),
    }
  } catch {
    return { up: false, rows: [] }
  }
}

async function transmissionDownloads(origin: string): Promise<{ up: boolean; rows: DownloadRow[] }> {
  try {
    const response = await fetch(`${origin}/transmission/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'torrent-get', arguments: { fields: ['percentDone', 'status', 'rateDownload', 'leftUntilDone'] } }),
      signal: AbortSignal.timeout(4000),
    })
    if (response.status === 409) return { up: true, rows: [] }
    if (!response.ok) return { up: false, rows: [] }
    const body = await response.json() as { arguments?: { torrents?: Array<Record<string, unknown>> } }
    const torrents = body.arguments?.torrents ?? []
    return {
      up: true,
      rows: torrents.map(item => ({
        client: 'transmission',
        state: String(item['status'] ?? 'unknown'),
        progress: Number(item['percentDone'] ?? 0) || 0,
        bytesLeft: Number(item['leftUntilDone'] ?? 0) || 0,
        speed: Number(item['rateDownload'] ?? 0) || 0,
      })),
    }
  } catch {
    return { up: false, rows: [] }
  }
}

async function acquireDownloads(file: string): Promise<DownloadRow[]> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { records?: Record<string, Record<string, unknown>> }
    const records = parsed.records ?? {}
    return Object.values(records).map(record => ({
      client: 'acquire',
      state: String(record['state'] ?? 'unknown'),
      progress: Number(record['progress'] ?? 0) || 0,
    }))
  } catch {
    return []
  }
}
