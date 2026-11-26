/**
 * Arkiv transport — Filecoin-style gated via @arkiv-network/sdk.
 * Mirrors the reference services/arkiv_sync.py (ArkivSyncConfig + create_entity via privateKey+rpcUrl).
 * No raw key in memory beyond the operation — per-call gate like synapse & xmtp.
 */

import type { Hex } from 'viem';
import type { CreateEntityReturnType, ExecuteBatchReturnType } from '@arkiv-network/sdk';
import type { Schema } from '@arkiv-network/sdk/schema';
import { schemaForGrp } from './schemas.ts';
import { HAVEN_BTL_FULL_S, HAVEN_BTL_PART_S, HAVEN_BTL_SERIES_S } from './haven.ts';

export interface ArkivBackendOpts {
  privateKeyRef: string;
  getPrivateKey: () => Promise<string>;
  rpcUrl: string;
  chainId?: number;
  /**
   * Arkiv RPC access key, spliced into the Rabdi chain's RPC path so
   * requests leave the heavily rate-limited public endpoint. Not a secret
   * (it ships with any app that talks to the chain); `""` keeps the public
   * endpoint and the SDK's one-time warning.
   */
  accessKey?: string;
  /**
   * Optional fixed schema for every write. Unset: `schemaForGrp` picks the
   * Haven media schema from the record's `grp`. dsh-board passes its
   * BOARD_SCHEMA here — board attributes are not HavenFullSchema columns.
   */
  schema?: Schema;
}

/**
 * Minimal wallet-client surface for creates. The result type is the SDK's
 * own `CreateEntityReturnType` (`{ entityKey, txHash, expiresAt }`) — NOT
 * `{ key }`: the SDK names the minted key `entityKey`, and reading `key`
 * yields `undefined`. The compiler pins this: if the SDK ever renames the
 * field, both this signature and the mapper below break loudly.
 */
export interface ArkivCreateClient {
  createEntity: (schema: Schema, values: Record<string, unknown>, options: { expiration: unknown }) => Promise<CreateEntityReturnType>;
}

/**
 * patchEntity args for a whole-record rewrite. Attributes ride `set`:
 * the SDK silently ignores an `attributes` key on patch (create is the
 * only call that takes one), so passing `attributes` looks green while
 * every attribute goes stale — live incident, three no-op rewrites.
 * Values arrive bare from validateHavenWrite (the schema columns coerce
 * them) and pass through untouched.
 */
export function patchArgsForUpdate(params: {
  key: Hex; payload: Uint8Array; contentType: string; attributes?: Record<string, unknown>;
}): { entityKey: Hex; payload: Uint8Array; contentType: string; set: Record<string, unknown> } {
  return {
    entityKey: params.key,
    payload: params.payload,
    contentType: params.contentType,
    set: params.attributes ?? {},
  };
}

/** One create through an explicit client (the backend delegates to this). */
export async function createEntityWithClient(
  client: ArkivCreateClient,
  params: { payload: Uint8Array; contentType: string; attributes?: Record<string, unknown>; expiresIn?: number; grp?: string; schema?: Schema },
): Promise<{ key: Hex; txHash: Hex }> {
  const { ExpirationTime } = await import('@arkiv-network/sdk');
  const grp = typeof params.attributes?.grp === 'string' ? params.attributes.grp : params.grp;
  const schema = params.schema ?? schemaForGrp(grp ?? 'haven.video.full');
  const values: Record<string, unknown> = {
    ...params.attributes,
    payload: params.payload,
    content_type: params.contentType,
  };
  const fallbackS = grp === 'haven.video.drip.series' ? HAVEN_BTL_SERIES_S
    : grp === 'haven.video.drip.part' ? HAVEN_BTL_PART_S
    : HAVEN_BTL_FULL_S;
  const options = {
    expiration: params.expiresIn ? ExpirationTime.fromSeconds(params.expiresIn) : ExpirationTime.fromSeconds(fallbackS),
  };
  const { entityKey, txHash } = await client.createEntity(schema, values, options);
  return { key: entityKey, txHash };
}

/** Minimal wallet-client surface for batch creates (`createdEntities` is in batch order). */
export interface ArkivBatchClient {
  executeBatch: (data: any) => Promise<ExecuteBatchReturnType>;
}

/** N creates through an explicit client, keys mapped positionally (the backend delegates to this). */
export async function createEntitiesWithClient(
  client: ArkivBatchClient,
  records: Array<{ payload: Uint8Array; contentType: string; attributes?: Record<string, unknown>; expiresIn?: number; grp?: string; schema?: Schema }>,
): Promise<Array<{ key: Hex; txHash: Hex }>> {
  const { ExpirationTime } = await import('@arkiv-network/sdk');
  const creates = records.map(record => {
    const grp = typeof record.attributes?.grp === 'string' ? record.attributes.grp : record.grp;
    const schema = record.schema ?? schemaForGrp(grp ?? 'haven.video.full');
    const values: Record<string, unknown> = {
      ...record.attributes,
      payload: record.payload,
      content_type: record.contentType,
    };
    const fallbackS = grp === 'haven.video.drip.series' ? HAVEN_BTL_SERIES_S
      : grp === 'haven.video.drip.part' ? HAVEN_BTL_PART_S
      : HAVEN_BTL_FULL_S;
    return {
      schema,
      values,
      expiration: record.expiresIn ? ExpirationTime.fromSeconds(record.expiresIn) : ExpirationTime.fromSeconds(fallbackS),
    };
  });
  const { txHash, createdEntities } = await client.executeBatch({ creates });
  // The SDK asserts receipt counts itself; this backstop keeps a short
  // result from silently mis-mapping keys to records.
  if (createdEntities.length !== records.length) {
    throw new Error(`dsh-arkiv: batch created ${createdEntities.length} entities for ${records.length} records (order unmapped; read them back)`);
  }
  return createdEntities.map(key => ({ key, txHash }));
}

/** Minimal chain shape the resolver needs (viem chain objects satisfy this). */
export interface ArkivChains {
  rabdi: (options: { accessKey: string }) => { id: number };
  localhost: { id: number };
}

/**
 * Resolve the viem chain for an rpcUrl. @arkiv-network/sdk@1.x ships
 * `rabdi` (testnet, access-key gated) and `localhost` — there is no mainnet
 * export, so mainnet URLs fail loud instead of building a client with an
 * undefined chain.
 */
export function resolveChainForRpcUrl(rpcUrl: string, chains: ArkivChains, accessKey: string): { id: number } {
  if (rpcUrl.includes('mainnet')) {
    throw new Error('dsh-arkiv: @arkiv-network/sdk@1.x ships no mainnet chain (rabdi/localhost only); use a testnet rpcUrl');
  }
  if (rpcUrl.includes('localhost') || rpcUrl.includes('127.0.0.1')) return chains.localhost;
  return chains.rabdi({ accessKey });
}

export class ArkivBackend {
  constructor(private readonly opts: ArkivBackendOpts) {}

  private async getWalletClient(): Promise<any> {
    const { createWalletClient } = await import('@arkiv-network/sdk');
    const { privateKeyToAccount } = await import('viem/accounts');
    const chains = await import('@arkiv-network/sdk/chains');
    const pk = (await this.opts.getPrivateKey()) as Hex;
    const account = privateKeyToAccount(pk);
    const chain = resolveChainForRpcUrl(this.opts.rpcUrl, chains, this.opts.accessKey ?? '');
    const transport = (await import('viem')).http(this.opts.rpcUrl);
    // Use createWalletClient from @arkiv-network/sdk which extends viem with Arkiv actions
    const client = createWalletClient({
      chain,
      transport,
      account,
    } as any);
    return client;
  }

  private async getPublicClient(): Promise<any> {
    const { createPublicClient } = await import('@arkiv-network/sdk');
    const chains = await import('@arkiv-network/sdk/chains');
    const chain = resolveChainForRpcUrl(this.opts.rpcUrl, chains, this.opts.accessKey ?? '');
    const client = createPublicClient({
      chain,
      transport: (await import('viem')).http(this.opts.rpcUrl),
    } as any);
    return client;
  }

  async createEntity(params: { payload: Uint8Array; contentType: string; attributes?: Record<string, unknown>; expiresIn?: number; grp?: string }): Promise<{ key: Hex; txHash: Hex }> {
    const client = await this.getWalletClient();
    return createEntityWithClient(client as ArkivCreateClient, { ...params, schema: this.opts.schema });
  }

  /**
   * N creates in ONE `execute` transaction (atomic all-or-nothing), like
   * the reference `batch_sync_contexts` multi path. Every record validates
   * before this runs, so a chain revert is gas/chain state — never shape.
   */
  async createEntities(records: Array<{ payload: Uint8Array; contentType: string; attributes?: Record<string, unknown>; expiresIn?: number; grp?: string }>): Promise<Array<{ key: Hex; txHash: Hex }>> {
    const client = await this.getWalletClient();
    return createEntitiesWithClient(client as ArkivBatchClient, records.map(record => ({ ...record, schema: this.opts.schema })));
  }

  async updateEntity(params: { key: Hex; payload: Uint8Array; contentType: string; attributes?: Record<string, unknown>; expiresIn?: number; grp?: string }): Promise<{ txHash: Hex }> {
    const client = await this.getWalletClient();
    const grp = typeof params.attributes?.grp === 'string' ? params.attributes.grp : params.grp;
    const schema = this.opts.schema ?? schemaForGrp(grp ?? 'haven.video.full');
    const { ExpirationTime } = await import('@arkiv-network/sdk');
    const values: Record<string, unknown> = {
      ...params.attributes,
      payload: params.payload,
      content_type: params.contentType,
    };
    // SDK 1.x: patchEntity takes ONE params object {schema, entityKey, set, unset}
    // and cannot move the expiry — that is extendEntity's job.
    const { txHash } = await (client as any).patchEntity({ schema, entityKey: params.key, set: values });
    if (params.expiresIn) {
      const expiration = ExpirationTime.fromSeconds(params.expiresIn);
      await (client as any).extendEntity({ entityKey: params.key, expiration });
    }
    return { txHash };
  }

  async extendEntity(params: { key: Hex; expiresIn: number }): Promise<{ txHash: Hex }> {
    const client = await this.getWalletClient();
    const { ExpirationTime } = await import('@arkiv-network/sdk');
    const expiration = ExpirationTime.fromSeconds(params.expiresIn);
    const { txHash } = await (client as any).extendEntity({ entityKey: params.key, expiration });
    return { txHash };
  }

  async queryEntities(query: { where?: Record<string, unknown>; limit?: number }): Promise<any[]> {
    const client = await this.getPublicClient();
    // Use arkiv query builder: select + where + fetch
    let builder: any = client.select({
      $key: true,
      $owner: true,
      $creator: true,
      $createdAt: true,
      $expiresAt: true,
      $attributes: true,
      payload: true,
      content_type: true,
    });
    if (query.where) {
      const { and, eq } = await import('@arkiv-network/sdk/query');
      // Every filter entry ANDed: single-entry {sha256_ct} dedup lookups and
      // multi-entry {grp, gate_type} feed scopes share one path. Values are
      // pre-normalized (haven.ts) to the wire types they compare against.
      const entries = Object.entries(query.where);
      if (entries.length === 1) {
        const [k, v] = entries[0] as [string, unknown];
        builder = builder.where(eq(k, v as any));
      } else if (entries.length > 1) {
        builder = builder.where(and(entries.map(([k, v]) => eq(k, v as any))));
      }
    }
    if (query.limit) builder = builder.limit(query.limit);
    const result = await builder.fetch();
    return result.entities ?? result;
  }
}
