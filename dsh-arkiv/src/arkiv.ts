/**
 * Arkiv transport — Filecoin-style gated via @arkiv-network/sdk.
 * Mirrors haven_cli/services/arkiv_sync.py (ArkivSyncConfig + create_entity via privateKey+rpcUrl).
 * No raw key in memory beyond the operation — per-call gate like synapse & xmtp.
 */

import type { Hex } from 'viem';
import type { CreateEntityReturnType } from '@arkiv-network/sdk';

export interface ArkivBackendOpts {
  privateKeyRef: string;
  getPrivateKey: () => Promise<string>;
  rpcUrl: string;
  chainId?: number;
}

/**
 * Minimal wallet-client surface for creates. The result type is the SDK's
 * own `CreateEntityReturnType` (`{ entityKey, txHash, expiresAt }`) — NOT
 * `{ key }`: the SDK names the minted key `entityKey`, and reading `key`
 * yields `undefined`. The compiler pins this: if the SDK ever renames the
 * field, both this signature and the mapper below break loudly.
 */
export interface ArkivCreateClient {
  createEntity: (data: any) => Promise<CreateEntityReturnType>;
}

/** One create through an explicit client (the backend delegates to this). */
export async function createEntityWithClient(
  client: ArkivCreateClient,
  params: { payload: Uint8Array; contentType: string; attributes?: Record<string, unknown>; expiresIn?: number },
): Promise<{ key: Hex; txHash: Hex }> {
  const { ExpirationTime } = await import('@arkiv-network/sdk');
  // Plain number, NOT BigInt: the SDK's toBlocks rejects non-numbers, and
  // requires a positive multiple of the 2s block time (haven.ts enforces
  // both before the ledger keys the write).
  const expires = params.expiresIn ? ExpirationTime.fromSeconds(params.expiresIn) : ExpirationTime.fromDays(28);
  const { entityKey, txHash } = await client.createEntity({
    payload: params.payload,
    contentType: params.contentType,
    attributes: params.attributes ?? {},
    expires,
  });
  return { key: entityKey, txHash };
}

/** Minimal chain shape the resolver needs (viem chain objects satisfy this). */
export interface ArkivChains {
  tiramisu: { id: number };
  localhost: { id: number };
}

/**
 * Resolve the viem chain for an rpcUrl. @arkiv-network/sdk@0.8.1 ships
 * only `tiramisu` (testnet) and `localhost` chains — there is no mainnet
 * export, so mainnet URLs fail loud instead of building a client with an
 * undefined chain.
 */
export function resolveChainForRpcUrl(rpcUrl: string, chains: ArkivChains): { id: number } {
  if (rpcUrl.includes('mainnet')) {
    throw new Error('dsh-arkiv: @arkiv-network/sdk@0.8.1 ships no mainnet chain (tiramisu/localhost only); use a testnet rpcUrl');
  }
  if (rpcUrl.includes('localhost') || rpcUrl.includes('127.0.0.1')) return chains.localhost;
  return chains.tiramisu;
}

export class ArkivBackend {
  constructor(private readonly opts: ArkivBackendOpts) {}

  private async getWalletClient(): Promise<any> {
    const { createWalletClient, http } = await import('@arkiv-network/sdk');
    const { privateKeyToAccount } = await import('viem/accounts');
    const chains = await import('@arkiv-network/sdk/chains');
    const pk = (await this.opts.getPrivateKey()) as Hex;
    const account = privateKeyToAccount(pk);
    const chain = resolveChainForRpcUrl(this.opts.rpcUrl, chains);
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
    const chain = resolveChainForRpcUrl(this.opts.rpcUrl, chains);
    const client = createPublicClient({
      chain,
      transport: (await import('viem')).http(this.opts.rpcUrl),
    } as any);
    return client;
  }

  async createEntity(params: { payload: Uint8Array; contentType: string; attributes?: Record<string, unknown>; expiresIn?: number }): Promise<{ key: Hex; txHash: Hex }> {
    const client = await this.getWalletClient();
    return createEntityWithClient(client as ArkivCreateClient, params);
  }

  async updateEntity(params: { key: Hex; payload: Uint8Array; contentType: string; attributes?: Record<string, unknown>; expiresIn?: number }): Promise<{ txHash: Hex }> {
    const client = await this.getWalletClient();
    const { ExpirationTime } = await import('@arkiv-network/sdk');
    const expires = params.expiresIn ? ExpirationTime.fromSeconds(params.expiresIn) : undefined;
    const { txHash } = await (client as any).patchEntity({
      entityKey: params.key,
      payload: params.payload,
      contentType: params.contentType,
      attributes: params.attributes,
      expires,
    });
    return { txHash };
  }

  async extendEntity(params: { key: Hex; expiresIn: number }): Promise<{ txHash: Hex }> {
    const client = await this.getWalletClient();
    const { ExpirationTime } = await import('@arkiv-network/sdk');
    const expires = ExpirationTime.fromSeconds(params.expiresIn);
    const { txHash } = await (client as any).extendEntity({ entityKey: params.key, expires });
    return { txHash };
  }

  async queryEntities(query: { where?: Record<string, unknown>; limit?: number }): Promise<any[]> {
    const client = await this.getPublicClient();
    // Use arkiv query builder: select + where + fetch
    let builder: any = client.select({ key: true, owner: true, payload: true, contentType: true, attributes: true, expiresAt: true });
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
