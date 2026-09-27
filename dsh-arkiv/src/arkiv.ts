/**
 * Arkiv transport — Filecoin-style gated via @arkiv-network/sdk.
 * Mirrors haven_cli/services/arkiv_sync.py (ArkivSyncConfig + create_entity via privateKey+rpcUrl).
 * No raw key in memory beyond the operation — per-call gate like synapse & xmtp.
 */

import type { Hex } from 'viem';

export interface ArkivBackendOpts {
  privateKeyRef: string;
  getPrivateKey: () => Promise<string>;
  rpcUrl: string;
  chainId?: number;
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
    const { ExpirationTime } = await import('@arkiv-network/sdk');
    const expires = params.expiresIn ? ExpirationTime.fromSeconds(BigInt(params.expiresIn)) : ExpirationTime.fromDays(28);
    const { key, txHash } = await client.createEntity({
      payload: params.payload,
      contentType: params.contentType,
      attributes: params.attributes ?? {},
      expires,
    });
    return { key, txHash };
  }

  async updateEntity(params: { key: Hex; payload: Uint8Array; contentType: string; attributes?: Record<string, unknown>; expiresIn?: number }): Promise<{ txHash: Hex }> {
    const client = await this.getWalletClient();
    const { ExpirationTime } = await import('@arkiv-network/sdk');
    const expires = params.expiresIn ? ExpirationTime.fromSeconds(BigInt(params.expiresIn)) : undefined;
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
    const expires = ExpirationTime.fromSeconds(BigInt(params.expiresIn));
    const { txHash } = await (client as any).extendEntity({ entityKey: params.key, expires });
    return { txHash };
  }

  async queryEntities(query: { where?: Record<string, unknown>; limit?: number }): Promise<any[]> {
    const client = await this.getPublicClient();
    // Use arkiv query builder: select + where + fetch
    let builder: any = client.select({ key: true, owner: true, payload: true, contentType: true, attributes: true, expiresAt: true });
    if (query.where) {
      const { eq } = await import('@arkiv-network/sdk/query');
      // Simple where: first entry
      const entries = Object.entries(query.where);
      if (entries.length > 0) {
        const [k, v] = entries[0] as [string, unknown];
        builder = builder.where(eq(k, v as any));
      }
    }
    if (query.limit) builder = builder.limit(query.limit);
    const result = await builder.fetch();
    return result.entities ?? result;
  }
}
