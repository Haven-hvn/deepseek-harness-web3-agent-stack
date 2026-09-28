/**
 * Arkiv entity storage for DSH — ctx.arkiv + arkiv_create_entity / arkiv_query tools.
 * Filecoin Onchain Cloud is Synapse; Arkiv is the entity chain (Tiramisu testnet).
 * This ports the reference services/arkiv_sync.py (ArkivSyncConfig, create_entity) to DSH's
 * isolated-bundles-coupled-at-seams model: TypeScript/Node v22/Cordis, gated credentials.
 *
 * This harness is Haven-specific: every write is validated against the Haven
 * application protocol (ARKIV_FORMAT v2.3.0 — see ./haven.ts) BEFORE signing.
 * Attributes arrive as a plain Record<string, unknown> like the reference, and
 * are normalized to the reference `str|int` wire (full/generic groups) or the
 * spec's tagged SDK values (drip groups) before the ledger keys them, so
 * retries with differently-cased hex still hit the same ledger entry.
 *
 * @module dsh-arkiv
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
// Type-only: the read-back hook contract (runtime access to the guard stays
// optional via `ctx.reflect.get`, so this plugin mounts cleanly unguarded).
import type { CheckContext, CheckDecision } from 'dsh-exactly-once';
import { ArkivBackend } from './arkiv.ts';
import { normalizeHavenWhere, validateHavenWrite } from './haven.ts';
import type { ArkivEntityRecord } from './types.ts';

export type { ArkivEntityRecord } from './types.ts';
export {
  CHAIN_VARIANT_TO_EIP155,
  HAVEN_BTL_FULL_S,
  HAVEN_BTL_PART_S,
  HAVEN_BTL_SERIES_S,
  HAVEN_CONTENT_TYPE,
  HAVEN_FORMAT_VERSION,
  HAVEN_GROUPS,
  MIME_TO_ENUM,
  normalizeHavenWhere,
  validateHavenWrite,
} from './haven.ts';
export type { HavenGroupClass, HavenNormalizedWrite } from './haven.ts';

export const name = 'storage-arkiv';
export const inject = ['wallet', 'tools'] as const;

export interface Config {
  wallet: string;
  privateKeyRef: string;
  rpcUrl: string;
  chainId?: number;
}

export const Config: z<Config> = z.object({
  wallet: z.string().required(),
  privateKeyRef: z.string().required(),
  rpcUrl: z.string().required(),
  chainId: z.number().default(8453),
});

/** Stable stringify with sorted object keys (retry-identical args hash identically). */
function stableStringify(value: unknown): string {
  // Bigints (u256 cells) are unquoted with an `n` suffix: distinct from both
  // numbers and quoted strings, so the ledger key never collides across types.
  if (typeof value === 'bigint') return `${value}n`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
}

/** Content identity for one create: payload bytes + content type + attributes. */
function createKeyFor(params: { payload: Uint8Array; contentType: string; attributes?: Record<string, unknown> }): string {
  const hash = createHash('sha256');
  hash.update(params.contentType);
  hash.update('\n');
  hash.update(stableStringify(params.attributes ?? {}));
  hash.update('\n');
  hash.update(params.payload);
  return `create:${hash.digest('hex')}`;
}

/** Content identity for one batch: the ordered per-record create keys (order matters — keys map positionally). */
function batchKeyFor(records: Array<{ payload: Uint8Array; contentType: string; attributes: Record<string, unknown> }>): string {
  const hash = createHash('sha256');
  hash.update(records.map(record => createKeyFor(record)).join('\n'));
  return `batch:${hash.digest('hex')}`;
}

/** Content identity for one update: the entity key plus the new content. */
function updateKeyFor(params: { key: `0x${string}`; payload: Uint8Array; contentType: string; attributes?: Record<string, unknown> }): string {
  const hash = createHash('sha256');
  hash.update(params.key.toLowerCase());
  hash.update('\n');
  hash.update(params.contentType);
  hash.update('\n');
  hash.update(stableStringify(params.attributes ?? {}));
  hash.update('\n');
  hash.update(params.payload);
  return `update:${hash.digest('hex')}`;
}

/** Best-effort payload bytes out of an entity query hit (SDK shape varies). */
function queryPayloadBytes(entity: { payload?: unknown }): Uint8Array | undefined {
  const payload = entity.payload;
  if (payload instanceof Uint8Array) return payload;
  if (typeof payload === 'string' && payload.startsWith('0x')) {
    try {
      const body = payload.slice(2);
      const bytes = new Uint8Array(body.length / 2);
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Number.parseInt(body.slice(index * 2, index * 2 + 2), 16);
      }
      return bytes;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export class ArkivRuntime {
  private backend: ArkivBackend | null = null;
  /**
   * Create attempts by content key (in-flight AND settled: a settled
   * promise replays its record). Failed attempts are dropped so repeats
   * retry; a rejected promise is never replayed.
   */
  private readonly creates = new Map<string, Promise<ArkivEntityRecord>>();
  /** Update attempts by (key, content): same settled-replay / failed-retry rule. */
  private readonly updates = new Map<string, Promise<{ txHash: `0x${string}` }>>();
  /** Batch attempts by ordered content: one execute() per batch, same replay rule. */
  private readonly batches = new Map<string, Promise<Array<{ key: `0x${string}`; txHash: `0x${string}` }>>>();
  /** Disposers for the lazily registered exactly-once hooks (none while unguarded). */
  private hookDisposers: Array<() => void> | undefined;
  private readonly _privateKeyRef: string;
  private readonly _rpcUrl: string;
  private readonly _chainId?: number;

  constructor(private readonly ctx: Context, private readonly wallet: string, opts: { privateKeyRef: string; rpcUrl: string; chainId?: number }) {
    if (!opts.privateKeyRef || !opts.rpcUrl) throw new Error('dsh-arkiv: privateKeyRef+rpcUrl required');
    this._privateKeyRef = opts.privateKeyRef;
    this._rpcUrl = opts.rpcUrl;
    this._chainId = opts.chainId;
  }

  private async resolvePrivateKey(): Promise<string> {
    const ref = this._privateKeyRef;
    const creds: any = (this.ctx as any).credentials;
    let v: string | undefined;
    if (creds?.resolve) {
      try {
        const resolved = await creds.resolve(ref);
        v = typeof resolved === 'string' ? resolved : resolved?.value;
      } catch {}
    }
    if (!v) v = process.env[ref];
    if (!v) throw new Error(`dsh-arkiv: credential ${ref} not found (set ${ref} in the credential store or env)`);
    return v;
  }

  private async ensureBackend(): Promise<ArkivBackend> {
    if (this.backend) return this.backend;
    const getPrivateKey = () => this.resolvePrivateKey();
    this.backend = new ArkivBackend({ privateKeyRef: this._privateKeyRef, getPrivateKey, rpcUrl: this._rpcUrl, chainId: this._chainId });
    return this.backend;
  }

  /**
   * Register the create/update read-back hooks once the guard is present.
   * Lazy (called from every write path) so registration never depends on
   * plugin mount order; a no-op while unguarded, idempotent once registered.
   */
  hook(): void {
    if (this.hookDisposers !== undefined) return;
    const guard = this.ctx.reflect.get('exactlyOnce') as
      | { registerCheck?: (name: string, fn: (check: CheckContext) => Promise<CheckDecision>) => () => void }
      | undefined;
    if (guard === null || guard === undefined || typeof guard.registerCheck !== 'function') return;
    this.hookDisposers = [
      guard.registerCheck('arkiv_create_entity', check => this.checkCreate(check.args)),
      guard.registerCheck('arkiv_update_entity', check => this.checkUpdate(check.args)),
      guard.registerCheck('arkiv_create_entities', check => this.checkBatch(check.args)),
    ];
  }

  /** Retire the read-back hooks (plugin disposal). */
  unhook(): void {
    for (const dispose of this.hookDisposers ?? []) {
      try {
        dispose();
      } catch {}
    }
    this.hookDisposers = undefined;
  }

  /**
   * Read-back hook for `arkiv_create_entity` repeats after ambiguous
   * outcomes: settled attempts replay; in-flight attempts report unknown
   * (the body attaches on dispatch); ledger misses with attributes fall
   * through to an entity query with a payload-hash match (restart cover).
   * Invalid Haven records report unknown (the re-dispatch rethrows the
   * validation error, exactly like the first attempt).
   */
  async checkCreate(input: unknown): Promise<CheckDecision> {
    this.hook();
    const args = (input ?? {}) as { path?: unknown; payload?: unknown; contentType?: unknown; attributes?: unknown; expiresIn?: unknown };
    let payload: Uint8Array;
    try {
      if (typeof args.path === 'string' && args.path !== '') {
        payload = await readFile(args.path);
      } else if (typeof args.payload === 'string') {
        payload = Buffer.from(args.payload, 'utf8');
      } else {
        return { kind: 'unknown' };
      }
    } catch {
      return { kind: 'unknown' };
    }
    if (typeof args.contentType !== 'string' || args.contentType === '') return { kind: 'unknown' };
    const attributes = (typeof args.attributes === 'object' && args.attributes !== null
      ? args.attributes as Record<string, unknown>
      : undefined);
    let write: { payload: Uint8Array; attributes: Record<string, unknown> };
    try {
      write = validateHavenWrite({
        payload,
        contentType: args.contentType,
        ...(attributes !== undefined ? { attributes } : {}),
        ...(typeof args.expiresIn === 'number' ? { expiresIn: args.expiresIn } : {}),
      });
    } catch {
      return { kind: 'unknown' };
    }
    const key = createKeyFor({
      payload: write.payload,
      contentType: args.contentType,
      attributes: write.attributes,
    });
    const prior = this.creates.get(key);
    if (prior !== undefined) {
      try {
        const record = await prior;
        return { kind: 'replay', value: { key: record.key, owner: record.owner, txHash: record.txHash } };
      } catch {
        return { kind: 'unknown' }; // in flight or failed: the body attaches or retries
      }
    }
    // Restart cover: the ledger is gone, but an attributes-targeted query
    // plus a payload-hash match still proves the create committed. A query
    // hit cannot recover the creation txHash, so the replay value says so.
    // (The write validated above, so normalized attributes always exist.)
    try {
      const found = await this.findCommitted({ payload: write.payload, contentType: args.contentType, attributes: write.attributes });
      if (found !== undefined) {
        return {
          kind: 'replay',
          value: {
            key: found.key,
            owner: found.owner,
            txHash: `unknown:verified-by-query:${found.key}`,
          },
        };
      }
    } catch {
      // The chain cannot answer: fall through to unknown.
    }
    return { kind: 'unknown' };
  }

  /**
   * One record's restart cover: the attributes-targeted query plus a
   * payload-hash match. Shared by the single and batch read-back hooks.
   */
  private async findCommitted(record: { payload: Uint8Array; contentType: string; attributes: Record<string, unknown> }): Promise<{ key: `0x${string}`; owner: `0x${string}` } | undefined> {
    const entities = await this.queryEntities({ where: record.attributes, limit: 25 });
    const want = createHash('sha256').update(record.payload).digest('hex');
    for (const entity of entities) {
      const bytes = queryPayloadBytes(entity);
      if (bytes === undefined) continue;
      if (createHash('sha256').update(bytes).digest('hex') !== want) continue;
      if (entity.contentType !== undefined && entity.contentType !== record.contentType) continue;
      return { key: entity.key, owner: entity.owner };
    }
    return undefined;
  }

  /**
   * Read-back hook for `arkiv_update_entity` repeats: settled attempts
   * replay, everything else reports unknown (a re-patch of identical
   * content converges anyway; invalid records report unknown and the
   * re-dispatch rethrows the validation error).
   */
  async checkUpdate(input: unknown): Promise<CheckDecision> {
    this.hook();
    const args = (input ?? {}) as { key?: unknown; path?: unknown; payload?: unknown; contentType?: unknown; attributes?: unknown; expiresIn?: unknown };
    if (typeof args.key !== 'string' || !args.key.startsWith('0x')) return { kind: 'unknown' };
    let payload: Uint8Array;
    try {
      if (typeof args.path === 'string' && args.path !== '') {
        payload = await readFile(args.path);
      } else {
        payload = Buffer.from(typeof args.payload === 'string' ? args.payload : '', 'utf8');
      }
    } catch {
      return { kind: 'unknown' };
    }
    if (typeof args.contentType !== 'string' || args.contentType === '') return { kind: 'unknown' };
    const updateAttributes = (typeof args.attributes === 'object' && args.attributes !== null
      ? args.attributes as Record<string, unknown>
      : undefined);
    let write: { payload: Uint8Array; attributes: Record<string, unknown> };
    try {
      write = validateHavenWrite({
        payload,
        contentType: args.contentType,
        ...(updateAttributes !== undefined ? { attributes: updateAttributes } : {}),
        ...(typeof args.expiresIn === 'number' ? { expiresIn: args.expiresIn } : {}),
      });
    } catch {
      return { kind: 'unknown' };
    }
    const prior = this.updates.get(updateKeyFor({
      key: args.key as `0x${string}`,
      payload: write.payload,
      contentType: args.contentType,
      attributes: write.attributes,
    }));
    if (prior === undefined) return { kind: 'unknown' };
    try {
      return { kind: 'replay', value: await prior };
    } catch {
      return { kind: 'unknown' };
    }
  }

  /**
   * Read-back hook for `arkiv_create_entities` repeats: settled batches
   * replay; the restart cover replays only when EVERY record is found
   * (one execute() is atomic, so a partial hit contradicts commit and
   * reports unknown for the model to investigate, never a replay).
   */
  async checkBatch(input: unknown): Promise<CheckDecision> {
    this.hook();
    const args = (input ?? {}) as { entities?: unknown };
    if (!Array.isArray(args.entities) || args.entities.length === 0) return { kind: 'unknown' };
    const writes: Array<{ payload: Uint8Array; contentType: string; attributes: Record<string, unknown> }> = [];
    for (const entry of args.entities) {
      const record = (entry ?? {}) as { path?: unknown; payload?: unknown; contentType?: unknown; attributes?: unknown; expiresIn?: unknown };
      let payload: Uint8Array;
      try {
        if (typeof record.path === 'string' && record.path !== '') {
          payload = await readFile(record.path);
        } else if (typeof record.payload === 'string') {
          payload = Buffer.from(record.payload, 'utf8');
        } else {
          return { kind: 'unknown' };
        }
      } catch {
        return { kind: 'unknown' };
      }
      if (typeof record.contentType !== 'string' || record.contentType === '') return { kind: 'unknown' };
      const attributes = (typeof record.attributes === 'object' && record.attributes !== null
        ? record.attributes as Record<string, unknown>
        : undefined);
      try {
        writes.push(validateHavenWrite({
          payload,
          contentType: record.contentType,
          ...(attributes !== undefined ? { attributes } : {}),
          ...(typeof record.expiresIn === 'number' ? { expiresIn: record.expiresIn } : {}),
        }));
      } catch {
        return { kind: 'unknown' };
      }
    }
    const prior = this.batches.get(batchKeyFor(writes));
    if (prior !== undefined) {
      try {
        return { kind: 'replay', value: await prior };
      } catch {
        return { kind: 'unknown' };
      }
    }
    try {
      const found: Array<{ key: `0x${string}`; txHash: string }> = [];
      for (const write of writes) {
        const hit = await this.findCommitted({ payload: write.payload, contentType: write.contentType, attributes: write.attributes });
        if (hit === undefined) return { kind: 'unknown' };
        found.push({ key: hit.key, txHash: `unknown:verified-by-query:${hit.key}` });
      }
      return { kind: 'replay', value: found };
    } catch {
      return { kind: 'unknown' };
    }
  }

  async createEntity(params: { payload: Uint8Array; contentType: string; attributes?: Record<string, unknown>; expiresIn?: number }): Promise<ArkivEntityRecord> {
    this.hook();
    // Fail-closed Haven validation FIRST: invalid records throw before the
    // ledger keys them, so no invalid attempt is ever replayed or sent.
    const write = validateHavenWrite(params);
    const key = createKeyFor({ payload: write.payload, contentType: write.contentType, attributes: write.attributes });
    const prior = this.creates.get(key);
    if (prior !== undefined) return prior;
    const task = this.doCreate({ payload: write.payload, contentType: write.contentType, attributes: write.attributes, expiresIn: write.expiresIn });
    this.creates.set(key, task);
    // Failed attempts must not replay: drop them so the repeat retries.
    // (The caller's await still observes the rejection; this sink only
    // guards the ledger's own reference.)
    task.catch(() => {
      if (this.creates.get(key) === task) this.creates.delete(key);
    });
    return task;
  }

  private async doCreate(params: { payload: Uint8Array; contentType: string; attributes?: Record<string, unknown>; expiresIn?: number }): Promise<ArkivEntityRecord> {
    const be = await this.ensureBackend();
    const { key, txHash } = await be.createEntity(params);
    const record: ArkivEntityRecord = { key, owner: '0x' as any, payload: params.payload, contentType: params.contentType, attributes: params.attributes, txHash };
    this.emitCreated(record);
    return record;
  }

  /**
   * One per-record creation event, shared by the single and batch paths.
   * (`arkiv/created` is a custom event with no global Events-map entry,
   * hence the overload complaint — same as before this method existed.)
   */
  private emitCreated(record: ArkivEntityRecord): void {
    this.ctx.emit('arkiv/created', record);
  }

  /**
   * N creates in one chain transaction (atomic all-or-nothing). Every
   * record validates BEFORE anything is sent, so one bad record rejects
   * the whole batch. Singletons delegate to the single path (dedup
   * parity, like the reference `len == 1` short-circuit).
   */
  async createEntities(records: Array<{ payload: Uint8Array; contentType: string; attributes?: Record<string, unknown>; expiresIn?: number }>): Promise<Array<{ key: `0x${string}`; txHash: `0x${string}` }>> {
    this.hook();
    if (records.length === 0) throw new Error('dsh-arkiv: batch needs at least one entity');
    if (records.length === 1) {
      const only = records[0] as { payload: Uint8Array; contentType: string; attributes?: Record<string, unknown>; expiresIn?: number };
      const record = await this.createEntity(only);
      return [{ key: record.key, txHash: record.txHash as `0x${string}` }];
    }
    const writes = records.map(record => validateHavenWrite(record));
    const key = batchKeyFor(writes);
    const prior = this.batches.get(key);
    if (prior !== undefined) return prior;
    const task = this.doBatch(writes);
    this.batches.set(key, task);
    task.catch(() => {
      if (this.batches.get(key) === task) this.batches.delete(key);
    });
    return task;
  }

  private async doBatch(writes: Array<{ payload: Uint8Array; contentType: string; attributes: Record<string, unknown>; expiresIn: number }>): Promise<Array<{ key: `0x${string}`; txHash: `0x${string}` }>> {
    const be = await this.ensureBackend();
    const results = await be.createEntities(writes);
    // One event per minted record (same shape as the single path, in order).
    for (const [index, write] of writes.entries()) {
      const hit = results[index] as { key: `0x${string}`; txHash: `0x${string}` };
      this.emitCreated({
        key: hit.key,
        owner: '0x' as any,
        payload: write.payload,
        contentType: write.contentType,
        attributes: write.attributes,
        txHash: hit.txHash,
      });
    }
    return results;
  }

  async updateEntity(params: { key: `0x${string}`; payload: Uint8Array; contentType: string; attributes?: Record<string, unknown>; expiresIn?: number }): Promise<{ txHash: `0x${string}` }> {
    this.hook();
    // Updates rewrite the whole record (like the reference patch path), so the
    // complete Haven record validates exactly like a create.
    const write = validateHavenWrite(params);
    const key = updateKeyFor({ key: params.key, payload: write.payload, contentType: write.contentType, attributes: write.attributes });
    const prior = this.updates.get(key);
    if (prior !== undefined) return prior;
    const task = this.doUpdate({ key: params.key, payload: write.payload, contentType: write.contentType, attributes: write.attributes, expiresIn: write.expiresIn });
    this.updates.set(key, task);
    task.catch(() => {
      if (this.updates.get(key) === task) this.updates.delete(key);
    });
    return task;
  }

  private async doUpdate(params: { key: `0x${string}`; payload: Uint8Array; contentType: string; attributes?: Record<string, unknown>; expiresIn?: number }): Promise<{ txHash: `0x${string}` }> {
    const be = await this.ensureBackend();
    return be.updateEntity(params);
  }

  async queryEntities(query: { where?: Record<string, unknown>; limit?: number }): Promise<ArkivEntityRecord[]> {
    const be = await this.ensureBackend();
    const where = normalizeHavenWhere(query.where);
    const entities = await be.queryEntities({ where, limit: query.limit });
    return entities as ArkivEntityRecord[];
  }
}

export const CREATE_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    key: { type: 'string', required: true },
    owner: { type: 'string', required: true },
    txHash: { type: 'string', required: true },
  },
} as const;

/** Array-rooted: entity query returns a JSON list (the registry validates tool output against this schema). */
export const QUERY_RESULT_SCHEMA = {
  type: 'array',
  items: { type: 'object', additionalProperties: true },
} as const;

/** bigint → number when exact, else a decimal string (lossless-JSON rule). */
function safeNumber(value: bigint): number | string {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= -BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value.toString(10)
}

/** Deep bigint/bytes → JSON conversion for SDK-shaped values. */
function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return safeNumber(value)
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`
  if (Array.isArray(value)) return value.map(toJsonSafe)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toJsonSafe(v)]))
  }
  return value
}

/**
 * Lossless-JSON projection for one entity query hit (tool-output boundary
 * only — the runtime keeps raw bytes/bigints for its read-back hooks).
 * Payload bytes become a content pointer (sha256 + size), never raw bytes.
 */
export function toJsonSafeRecord(record: ArkivEntityRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (record.key !== undefined) out.key = record.key
  if (record.owner !== undefined) out.owner = record.owner
  if (record.contentType !== undefined) out.contentType = record.contentType
  if (record.txHash !== undefined) out.txHash = record.txHash
  if (record.expiresAt !== undefined) out.expiresAt = typeof record.expiresAt === 'bigint' ? safeNumber(record.expiresAt) : record.expiresAt
  if (record.attributes !== undefined) out.attributes = toJsonSafe(record.attributes)
  if (record.payload !== undefined) {
    out.payloadSha256 = createHash('sha256').update(record.payload).digest('hex')
    out.payloadBytes = record.payload.length
  }
  return out
}

/** Batch creates return one {key, txHash} per record, in order (one shared txHash). */
export const BATCH_RESULT_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      key: { type: 'string', required: true },
      txHash: { type: 'string', required: true },
    },
  },
} as const;

export function apply(ctx: Context, config: Config): void {
  const arkiv = new ArkivRuntime(ctx, config.wallet, { privateKeyRef: config.privateKeyRef, rpcUrl: config.rpcUrl, chainId: config.chainId });
  ctx.provide('arkiv', arkiv);

  // The read-back hooks register lazily from the runtime's write paths
  // (mount-order-proof); this effect only retires them on disposal.
  ctx.effect(() => () => arkiv.unhook());

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'arkiv_create_entity',
    description: 'Create a Haven Arkiv entity (ARKIV_FORMAT v2.3.0 — enforced before signing). Attributes: grp (haven.video.full / haven.audio.full / haven.image.full / haven.text.full / haven.file.full / haven.video.drip.series / haven.video.drip.part, or custom dot hierarchy), title, gate corpus (gate_type 1|3|4 numeric, gate_token 0x, gate_chain EIP id, gate_threshold as u256: safe-integer number or decimal string, must equal gate JSON threshold; gate_epoch for v3 — NOT epoch), sha256_ct (64 hex), mime enum 0-14 only (no duration_s/duration keys on generic groups; MIME strings ride payload ct instead), dur_s video-only. Payload is JSON: piece (encrypted) XOR fcid (clear), gate JSON string (version == gate_type), size/pt_hash/vlm/seg/codecs/src/creator/phash/attn, plus name (+ct when MIME has no enum code) on audio/generic groups. Drip series payload is {targets, creator?, mime?}; drip parts carry series_ref + mcap_usd. Deleted v1.x keys are rejected. expiresIn seconds (defaults 4w full/generic, 52w series, 12w parts).',
    parameters: {
      path: { type: 'string', description: 'Local file holding the JSON payload. Exactly one of path or payload.' },
      payload: { type: 'string', description: 'JSON payload string (utf8) if no file. Exactly one of path or payload.' },
      contentType: { type: 'string', description: 'Must be application/json (Haven entities are JSON records)', required: true } as any,
      attributes: { type: 'object', additionalProperties: true, description: 'Haven attributes Record<string, unknown> (grp/title/gate corpus/sha256_ct/mime/dur_s or drip coordinates)', required: true } as any,
      expiresIn: { type: 'number', description: 'Seconds until expiry (default per group: 4w full/generic, 52w series, 12w parts)' } as any,
    },
    output: { schema: CREATE_RESULT_SCHEMA, render: (_args, value) => [{ type: 'text', text: `${(value as any).key}: created tx ${(value as any).txHash}` }] },
    async execute(args: { path?: string; payload?: string; contentType: string; attributes?: Record<string, unknown>; expiresIn?: number }, exec): Promise<{ key: string; owner: string; txHash: string }> {
      if ((args.path === undefined) === (args.payload === undefined)) throw new Error('provide exactly one of path or payload');
      const payload = args.path !== undefined ? await readFile(args.path) : Buffer.from(args.payload as string, 'utf8');
      const record = await arkiv.createEntity({ payload, contentType: args.contentType, attributes: args.attributes, expiresIn: args.expiresIn });
      // Project to the declared output shape: the full record carries payload
      // bytes that are neither JSON nor model-meaningful, and the registry
      // rejects undeclared keys under additionalProperties:false.
      return { key: record.key as string, owner: record.owner as string, txHash: record.txHash as string };
    },
    presentCall: args => ({ card: 'generic', title: `Create Arkiv entity ${args.path ? basename(args.path) : 'payload'}`, kind: 'execute' }),
  })));

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'arkiv_update_entity',
    description: 'Rewrite a Haven Arkiv entity (same ARKIV_FORMAT v2.3.0 shape as create — send the complete record, not a sparse patch). Validated before signing.',
    parameters: {
      key: { type: 'string', required: true, description: 'Entity key 0x...' },
      path: { type: 'string', description: 'Local file holding the new JSON payload' } as any,
      payload: { type: 'string', description: 'New JSON payload string if no file' } as any,
      contentType: { type: 'string', required: true, description: 'Must be application/json' } as any,
      attributes: { type: 'object', additionalProperties: true, description: 'Complete Haven attributes for the rewritten record', required: true } as any,
      expiresIn: { type: 'number', description: 'Extend expiry seconds (default per group)' } as any,
    },
    output: { schema: { type: 'object', additionalProperties: true } as any, render: (_args, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    async execute(args: { key: string; path?: string; payload?: string; contentType: string; attributes?: Record<string, unknown>; expiresIn?: number }, exec) {
      const p = args.path !== undefined ? await readFile(args.path) : Buffer.from(args.payload ?? '', 'utf8');
      return arkiv.updateEntity({ key: args.key as `0x${string}`, payload: p, contentType: args.contentType, attributes: args.attributes, expiresIn: args.expiresIn });
    },
    presentCall: args => ({ card: 'generic', title: `Update Arkiv ${args.key}`, kind: 'execute' }),
  })));

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'arkiv_create_entities',
    description: 'Create N Haven Arkiv entities in ONE chain transaction (atomic all-or-nothing — for multi-record releases like a drip series plus its parts). Every record validates exactly like arkiv_create_entity before anything is sent; one bad record rejects the whole batch. Singletons behave as one create.',
    parameters: {
      entities: {
        type: 'array',
        required: true,
        description: 'Records in mint order: each {path|payload, contentType:"application/json", attributes, expiresIn?} like arkiv_create_entity.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', description: 'Local file holding the JSON payload. Exactly one of path or payload per record.' },
            payload: { type: 'string', description: 'JSON payload string (utf8) if no file.' },
            contentType: { type: 'string', description: 'Must be application/json', required: true },
            attributes: { type: 'object', additionalProperties: true, description: 'Haven attributes for this record', required: true },
            expiresIn: { type: 'number', description: 'Seconds until expiry (default per group)' },
          },
        },
      } as any,
    },
    output: {
      schema: BATCH_RESULT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: (value as Array<{ key: string; txHash: string }>).map(hit => `${hit.key}: created tx ${hit.txHash}`).join('\n'),
      }],
    },
    async execute(args: { entities: Array<{ path?: string; payload?: string; contentType: string; attributes?: Record<string, unknown>; expiresIn?: number }> }): Promise<Array<{ key: string; txHash: string }>> {
      if (!Array.isArray(args.entities) || args.entities.length === 0) throw new Error('provide at least one entity');
      const records: Array<{ payload: Uint8Array; contentType: string; attributes?: Record<string, unknown>; expiresIn?: number }> = [];
      for (const [index, entry] of args.entities.entries()) {
        if ((entry.path === undefined) === (entry.payload === undefined)) {
          throw new Error(`entity ${index}: provide exactly one of path or payload`);
        }
        records.push({
          payload: entry.path !== undefined ? await readFile(entry.path) : Buffer.from(entry.payload as string, 'utf8'),
          contentType: entry.contentType,
          ...(entry.attributes !== undefined ? { attributes: entry.attributes } : {}),
          ...(entry.expiresIn !== undefined ? { expiresIn: entry.expiresIn } : {}),
        });
      }
      const results = await arkiv.createEntities(records);
      return results as Array<{ key: string; txHash: string }>;
    },
    presentCall: (args: { entities: unknown }) => ({ card: 'generic', title: `Create ${Array.isArray(args.entities) ? args.entities.length : 0} Arkiv entities (batch)`, kind: 'execute' }),
  })));

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'arkiv_query',
    description: 'Query Haven Arkiv entities by attributes (all filters ANDed). Comparisons are type-exact: numbers stay numbers (gate_type 4, not "4"), hex is lowercased, series_ref matches the series entity key.',
    parameters: {
      where: { type: 'object', additionalProperties: true, description: 'Attribute filter, e.g. {grp:"haven.video.full", gate_type:3} or {sha256_ct:"<64 hex>"}' } as any,
      limit: { type: 'number', description: 'Max results' } as any,
    },
    output: { schema: QUERY_RESULT_SCHEMA, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args: { where?: Record<string, unknown>; limit?: number }, exec): Promise<Record<string, unknown>[]> {
      const hits = await arkiv.queryEntities({ where: args.where, limit: args.limit });
      return hits.map(toJsonSafeRecord);
    },
    presentCall: args => ({ card: 'generic', title: `Query Arkiv ${JSON.stringify(args.where ?? {})}`, kind: 'read' }),
  })));
}
