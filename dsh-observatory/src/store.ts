import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EMPTY_LIVE, redact } from './snapshot.ts'
import type { LedgerRow, LiveFile } from './snapshot.ts'

const MAX_BYTES = 8 * 1024 * 1024

export class ObservatoryStore {
  readonly ledgerPath: string
  readonly livePath: string

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true })
    this.ledgerPath = join(dir, 'events.jsonl')
    this.livePath = join(dir, 'live.json')
  }

  append(row: LedgerRow): void {
    this.rotate()
    const clean = redact(row) as LedgerRow
    appendFileSync(this.ledgerPath, `${JSON.stringify(clean)}\n`)
  }

  readLedger(): LedgerRow[] {
    try {
      return readFileSync(this.ledgerPath, 'utf8')
        .split('\n')
        .filter(line => line.trim() !== '')
        .map(line => JSON.parse(line) as LedgerRow)
    } catch {
      return []
    }
  }

  writeLive(live: LiveFile): void {
    const clean = redact(live) as LiveFile
    const tmp = `${this.livePath}.tmp`
    writeFileSync(tmp, JSON.stringify(clean))
    renameSync(tmp, this.livePath)
  }

  readLive(): LiveFile {
    try {
      return { ...EMPTY_LIVE, ...(JSON.parse(readFileSync(this.livePath, 'utf8')) as LiveFile) }
    } catch {
      return { ...EMPTY_LIVE }
    }
  }

  private rotate(): void {
    try {
      if (statSync(this.ledgerPath).size < MAX_BYTES) return
      renameSync(this.ledgerPath, `${this.ledgerPath}.1`)
    } catch {
      // first write
    }
  }
}
