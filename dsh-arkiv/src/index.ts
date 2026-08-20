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

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
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

export class ArkivRuntime {
  private backend: ArkivBackend | null = null;
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

  async createEntity(params: { payload: Uint8Array; contentType: string; attributes?: Record<string, unknown>; expiresIn?: number }): Promise<ArkivEntityRecord> {
    const be = await this.ensureBackend();
    const { key, txHash } = await be.createEntity(params);
    const record: ArkivEntityRecord = { key, owner: '0x' as any, payload: params.payload, contentType: params.contentType, attributes: params.attributes, txHash };
    this.ctx.emit('arkiv/created', record);
    return record;
  }

  async updateEntity(params: { key: `0x${string}`; payload: Uint8Array; contentType: string; attributes?: Record<string, unknown>; expiresIn?: number }): Promise<{ txHash: `0x${string}` }> {
    const be = await this.ensureBackend();
    return be.updateEntity(params);
  }

  async queryEntities(query: { where?: Record<string, unknown>; limit?: number }): Promise<ArkivEntityRecord[]> {
    const be = await this.ensureBackend();
    const entities = await be.queryEntities(query);
    return entities as ArkivEntityRecord[];
  }
}

const CREATE_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    key: { type: 'string', required: true },
    owner: { type: 'string', required: true },
    txHash: { type: 'string', required: true },
  },
} as const;

export function apply(ctx: Context, config: Config): void {
  const arkiv = new ArkivRuntime(ctx, config.wallet, { privateKeyRef: config.privateKeyRef, rpcUrl: config.rpcUrl, chainId: config.chainId });
  ctx.provide('arkiv', arkiv);

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
    async execute(args: { path?: string; payload?: string; contentType: string; attributes?: Record<string, unknown>; expiresIn?: number }, exec): Promise<ArkivEntityRecord> {
      if ((args.path === undefined) === (args.payload === undefined)) throw new Error('provide exactly one of path or payload');
      const payload = args.path !== undefined ? await readFile(args.path) : Buffer.from(args.payload as string, 'utf8');
      return arkiv.createEntity({ payload, contentType: args.contentType, attributes: args.attributes, expiresIn: args.expiresIn });
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
    output: { schema: { type: 'object', additionalProperties: true } as any, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args: { where?: Record<string, unknown>; limit?: number }, exec): Promise<ArkivEntityRecord[]> {
      return arkiv.queryEntities({ where: args.where, limit: args.limit });
    },
    presentCall: args => ({ card: 'generic', title: `Query Arkiv ${JSON.stringify(args.where ?? {})}`, kind: 'read' }),
  })));
}
