/**
 * Arkiv entity storage for DSH — ctx.arkiv + arkiv_create_entity / arkiv_query tools.
 * Filecoin Onchain Cloud is Synapse; Arkiv is the entity chain (Braga Hoodi testnet / mainnet).
 * This ports haven_cli/services/arkiv_sync.py (ArkivSyncConfig, create_entity) to DSH's
 * isolated-bundles-coupled-at-seams model: TypeScript/Node v22/Cordis, gated credentials.
 *
 * Entity definition is conformant with arkiv-sdk-js/src/types/entity.ts (EntityFields)
 * — haven-core has no Arkiv entity type, so canonical is arkiv-sdk-js. Haven's
 * arkiv_sync builds attributes as plain Record<string, unknown> with payload+contentType
 * + expiresIn; we preserve that shape so a haven-cli export can be re-imported as DSH.
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
import type { ArkivEntityRecord } from './types.ts';

export type { ArkivEntityRecord } from './types.ts';

export const name = 'storage-arkiv';
export const inject = {
  required: ['wallet', 'tools'],
  optional: ['credentials'],
} as const;

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
    if (creds?.get) { try { v = creds.get(ref) as string | undefined; } catch {} }
    if (!v) v = process.env[ref];
    if (!v) throw new Error(`dsh-arkiv: credential ${ref} not found (set ${ref} env or OWS vault)`);
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
   */
  async checkCreate(input: unknown): Promise<CheckDecision> {
    this.hook();
    const args = (input ?? {}) as { path?: unknown; payload?: unknown; contentType?: unknown; attributes?: unknown };
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
    const key = createKeyFor({
      payload,
      contentType: args.contentType,
      ...(attributes !== undefined ? { attributes } : {}),
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
    if (attributes === undefined) return { kind: 'unknown' };
    try {
      const entities = await this.queryEntities({ where: attributes, limit: 25 });
      const want = createHash('sha256').update(payload).digest('hex');
      for (const entity of entities) {
        const bytes = queryPayloadBytes(entity);
        if (bytes === undefined) continue;
        if (createHash('sha256').update(bytes).digest('hex') !== want) continue;
        if (entity.contentType !== undefined && entity.contentType !== args.contentType) continue;
        return {
          kind: 'replay',
          value: {
            key: entity.key,
            owner: entity.owner,
            txHash: `unknown:verified-by-query:${entity.key}`,
          },
        };
      }
    } catch {
      // The chain cannot answer: fall through to unknown.
    }
    return { kind: 'unknown' };
  }

  /**
   * Read-back hook for `arkiv_update_entity` repeats: settled attempts
   * replay, everything else reports unknown (a re-patch of identical
   * content converges anyway).
   */
  async checkUpdate(input: unknown): Promise<CheckDecision> {
    this.hook();
    const args = (input ?? {}) as { key?: unknown; path?: unknown; payload?: unknown; contentType?: unknown; attributes?: unknown };
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
    const prior = this.updates.get(updateKeyFor({
      key: args.key as `0x${string}`,
      payload,
      contentType: args.contentType,
      ...(updateAttributes !== undefined ? { attributes: updateAttributes } : {}),
    }));
    if (prior === undefined) return { kind: 'unknown' };
    try {
      return { kind: 'replay', value: await prior };
    } catch {
      return { kind: 'unknown' };
    }
  }

  async createEntity(params: { payload: Uint8Array; contentType: string; attributes?: Record<string, unknown>; expiresIn?: number }): Promise<ArkivEntityRecord> {
    this.hook();
    const key = createKeyFor(params);
    const prior = this.creates.get(key);
    if (prior !== undefined) return prior;
    const task = this.doCreate(params);
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
    this.ctx.emit('arkiv/created', record);
    return record;
  }

  async updateEntity(params: { key: `0x${string}`; payload: Uint8Array; contentType: string; attributes?: Record<string, unknown>; expiresIn?: number }): Promise<{ txHash: `0x${string}` }> {
    this.hook();
    const key = updateKeyFor(params);
    const prior = this.updates.get(key);
    if (prior !== undefined) return prior;
    const task = this.doUpdate(params);
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
    const entities = await be.queryEntities(query);
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

export function apply(ctx: Context, config: Config): void {
  const arkiv = new ArkivRuntime(ctx, config.wallet, { privateKeyRef: config.privateKeyRef, rpcUrl: config.rpcUrl, chainId: config.chainId });
  ctx.provide('arkiv', arkiv);

  // The read-back hooks register lazily from the runtime's write paths
  // (mount-order-proof); this effect only retires them on disposal.
  ctx.effect(() => () => arkiv.unhook());

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'arkiv_create_entity',
    description: 'Create an Arkiv entity (permanent queryable record) — payload+contentType+attributes, expiresIn seconds. Mirrors haven_cli arkiv_sync create_entity.',
    parameters: {
      path: { type: 'string', description: 'Local file to use as payload. Exactly one of path or payload.' },
      payload: { type: 'string', description: 'Raw payload string (utf8) if no file. Exactly one of path or payload.' },
      contentType: { type: 'string', description: 'MIME content type, e.g. application/json', required: true } as any,
      attributes: { type: 'object', description: 'Plain attributes Record<string, unknown> (haven entity attributes)' } as any,
      expiresIn: { type: 'number', description: 'Seconds until expiry (default 4 weeks)' } as any,
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
    description: 'Update an existing Arkiv entity — payload+contentType+attributes. Mirrors haven_cli arkiv_sync update_entity.',
    parameters: {
      key: { type: 'string', required: true, description: 'Entity key 0x...' },
      path: { type: 'string', description: 'Local file for new payload' } as any,
      payload: { type: 'string', description: 'Raw payload string if no file' } as any,
      contentType: { type: 'string', required: true } as any,
      attributes: { type: 'object', description: 'Attributes to patch' } as any,
      expiresIn: { type: 'number', description: 'Extend expiry seconds' } as any,
    },
    output: { schema: { type: 'object', additionalProperties: true } as any, render: (_args, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    async execute(args: { key: string; path?: string; payload?: string; contentType: string; attributes?: Record<string, unknown>; expiresIn?: number }, exec) {
      const p = args.path !== undefined ? await readFile(args.path) : Buffer.from(args.payload ?? '', 'utf8');
      return arkiv.updateEntity({ key: args.key as `0x${string}`, payload: p, contentType: args.contentType, attributes: args.attributes, expiresIn: args.expiresIn });
    },
    presentCall: args => ({ card: 'generic', title: `Update Arkiv ${args.key}`, kind: 'execute' }),
  })));

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'arkiv_query',
    description: 'Query Arkiv entities by attributes (haven-spec entity query).',
    parameters: {
      where: { type: 'object', description: 'Attribute filter, e.g. {category:"doc"}' } as any,
      limit: { type: 'number', description: 'Max results' } as any,
    },
    output: { schema: QUERY_RESULT_SCHEMA, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args: { where?: Record<string, unknown>; limit?: number }, exec): Promise<ArkivEntityRecord[]> {
      return arkiv.queryEntities({ where: args.where, limit: args.limit });
    },
    presentCall: args => ({ card: 'generic', title: `Query Arkiv ${JSON.stringify(args.where ?? {})}`, kind: 'read' }),
  })));
}
