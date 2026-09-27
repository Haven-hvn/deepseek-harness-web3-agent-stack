import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSnapshot, EMPTY_LIVE, filterLedger, redact, roiFor } from '../src/snapshot.ts'
import type { LedgerRow } from '../src/snapshot.ts'
import { ObservatoryStore } from '../src/store.ts'

describe('snapshot', () => {
  it('drops names, paths, and prompts', () => {
    expect(redact({ name: 'secret.mkv', path: '/data/x', progress: 0.4, prompt: 'hi' })).toEqual({ progress: 0.4 })
  })

  it('filters ledger panels by window and token', () => {
    const now = 1_700_000_000_000
    const rows: LedgerRow[] = [
      { ts: now - 2 * 86400000, kind: 'burn', amount: 1, token: '0xabc' },
      { ts: now - 10 * 86400000, kind: 'burn', amount: 9, token: '0xabc' },
      { ts: now - 1000, kind: 'revenue', amount: 5, token: '0xdef' },
    ]
    expect(filterLedger(rows, { since: '7d', token: '0xabc' }, now)).toEqual([rows[0]])
  })

  it('computes ROI only from rows that share a token', () => {
    const launch: LedgerRow = { ts: 1, kind: 'launch', token: '0xabc' }
    const rows: LedgerRow[] = [
      launch,
      { ts: 2, kind: 'revenue', token: '0xabc', amount: 10 },
      { ts: 3, kind: 'burn', token: '0xabc', amount: 4 },
      { ts: 4, kind: 'burn', token: 'USD', amount: 99 },
    ]
    expect(roiFor(launch, rows)).toBe(6)
    const snap = buildSnapshot(rows, EMPTY_LIVE)
    expect((snap['launches'] as Array<{ roi: number }>)[0]?.roi).toBe(6)
  })

  it('appends a ledger row and overwrites live', () => {
    const store = new ObservatoryStore(join(mkdtempSync(join(tmpdir(), 'obs-')), 'observatory'))
    store.append({ ts: 1, kind: 'burn', amount: 3, category: 'inference', description: 'secret' } as LedgerRow & { description: string })
    expect(store.readLedger()[0]).toEqual({ ts: 1, kind: 'burn', amount: 3, category: 'inference' })
    store.writeLive({ ...EMPTY_LIVE, ts: 2, downloads: [{ client: 'qbittorrent', state: 'downloading', progress: 0.5, name: 'nope' } as never] })
    expect(store.readLive().downloads[0]).toEqual({ client: 'qbittorrent', state: 'downloading', progress: 0.5 })
  })
})
