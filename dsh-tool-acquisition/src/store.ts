/**
 * Persistent handle store. Submit records outlive the agent process in a
 * JSON file (atomic tmp+rename writes), so `acquire_status` resolves a
 * handle after a restart — the same role as Haven CLI's
 * `AcquisitionStore`, minus retry bookkeeping (the agent owns retries).
 *
 * @module dsh-tool-acquisition/store
 */

import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { AcquisitionError } from './errors.ts'
import type { StoredAcquisition } from './types.ts'

const STORE_VERSION = 1

interface StoreFile {
  version: number
  records: Record<string, StoredAcquisition>
}

/** JSON-file acquisition record store with a process-local write mutex. */
export class HandleStore {
  private mutex: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    const run = this.mutex.then(work)
    this.mutex = run.then(() => undefined, () => undefined)
    return run
  }

  private async load(): Promise<StoreFile> {
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<StoreFile>
      if (parsed.version !== STORE_VERSION || typeof parsed.records !== 'object' || parsed.records === null) {
        return { version: STORE_VERSION, records: {} }
      }
      return { version: STORE_VERSION, records: parsed.records as Record<string, StoredAcquisition> }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { version: STORE_VERSION, records: {} }
      throw new AcquisitionError(`cannot read handle store: ${String(error)}`, 'ACQUIRE_BACKEND_ERROR', { cause: error })
    }
  }

  private async save(store: StoreFile): Promise<void> {
    await fs.mkdir(dirname(this.file), { recursive: true })
    const tmp = join(dirname(this.file), `.${Date.now()}.${Math.floor(Math.random() * 1e9)}.tmp`)
    await fs.writeFile(tmp, JSON.stringify(store))
    await fs.rename(tmp, this.file)
  }

  /** Insert or replace a record. */
  async put(record: StoredAcquisition): Promise<void> {
    await this.withLock(async () => {
      const store = await this.load()
      store.records[record.id] = record
      await this.save(store)
    })
  }

  /** Fetch a record by handle id. */
  async get(id: string): Promise<StoredAcquisition | undefined> {
    const store = await this.load()
    return store.records[id]
  }

  /**
   * Fetch the live record for one content key: a non-terminal record when
   * one exists, else the newest completed one. Failed/missing records are
   * retryable, so they never match — a resubmit after one starts fresh.
   */
  async findByContentKey(key: string): Promise<StoredAcquisition | undefined> {
    let completed: StoredAcquisition | undefined
    for (const record of Object.values((await this.load()).records)) {
      if (record.contentKey !== key && !(record.aliases ?? []).includes(key)) continue
      if (record.state === 'completed') {
        completed = record
        continue
      }
      if (record.state === 'failed' || record.state === 'missing') continue
      return record
    }
    return completed
  }

  /** Delete a record. */
  async remove(id: string): Promise<void> {
    await this.withLock(async () => {
      const store = await this.load()
      delete store.records[id]
      await this.save(store)
    })
  }

  /** Every record (diagnostics). */
  async all(): Promise<StoredAcquisition[]> {
    return Object.values((await this.load()).records)
  }
}
