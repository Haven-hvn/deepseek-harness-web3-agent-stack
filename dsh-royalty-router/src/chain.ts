/**
 * Chain + RPC wiring for dsh-royalty-router.
 *
 * Resolves the SDK `Deployment` for the configured chain (factory optional)
 * and builds a viem public client. Reads only — no wallet, no signing.
 *
 * @module dsh-royalty-router/chain
 */

import { createPublicClient, http, type PublicClient } from "viem";
import { base } from "viem/chains";
import { deployments, type Deployment } from "@royalty-router/sdk";

export interface ChainOpts {
  /** RPC endpoint (e.g. https://mainnet.base.org). */
  rpcUrl: string;
  /** EIP-155 chain id. Known: 8453 (Base). */
  chainId: number;
  /** RoyaltyRouterFactory override. Required for `rr_build` / `rr_launch`;
   * until the live factory is deployed, point at a deployed factory
   * address (e.g. on a local fork). */
  factory?: `0x${string}`;
}

/** Production default: Base public RPC (local forks override via env). */
export const DEFAULT_RPC_URL = 'https://mainnet.base.org'
/** The only chain the SDK has a deployment for. */
export const DEFAULT_CHAIN_ID = 8453

const FACTORY_RE = /^0x[0-9a-fA-F]{40}$/

/**
 * Fork overrides from the environment. `FORK_RPC` / `FORK_FACTORY` win;
 * plain `RPC` / `FACTORY` (the `rr` CLI convention) are the fallback.
 * Empty strings count as unset. A malformed factory fails loud — a silent
 * ignore would point `rr_build` at a mainnet deployment with no factory.
 */
export function forkEnv(): { rpcUrl?: string; factory?: `0x${string}` } {
  const rpcRaw = process.env.FORK_RPC ?? process.env.RPC
  const rpcUrl = rpcRaw !== undefined && rpcRaw.trim() !== '' ? rpcRaw : undefined
  const factoryRaw = process.env.FORK_FACTORY ?? process.env.FACTORY
  if (factoryRaw !== undefined && factoryRaw.trim() !== '' && !FACTORY_RE.test(factoryRaw)) {
    throw new Error('dsh-royalty-router: FORK_FACTORY/FACTORY must be a 0x-prefixed 20-byte address')
  }
  const factory = factoryRaw !== undefined && factoryRaw.trim() !== ''
    ? factoryRaw as `0x${string}`
    : undefined
  return factory === undefined
    ? (rpcUrl === undefined ? {} : { rpcUrl })
    : (rpcUrl === undefined ? { factory } : { rpcUrl, factory })
}

/**
 * Merge plugin config with fork env overrides: env (when set) > config >
 * built-in defaults. Production defaults are untouched — with no env set
 * the result is exactly what the profile config (or its defaults) says.
 */
export function resolveChainOpts(config: {
  rpcUrl?: string
  chainId?: number
  factory?: string
}): ChainOpts {
  const env = forkEnv()
  let factory = env.factory
  if (factory === undefined && config.factory !== undefined) {
    if (!FACTORY_RE.test(config.factory)) {
      throw new Error('dsh-royalty-router: factory must be a 0x-prefixed 20-byte address')
    }
    factory = config.factory as `0x${string}`
  }
  return {
    rpcUrl: env.rpcUrl ?? config.rpcUrl ?? DEFAULT_RPC_URL,
    chainId: config.chainId ?? DEFAULT_CHAIN_ID,
    ...(factory === undefined ? {} : { factory }),
  }
}

/** Resolve the SDK deployment, merging an optional factory override. */
export function resolveDeployment(opts: ChainOpts): Deployment {
  const d = (deployments as Record<number, Deployment | undefined>)[opts.chainId];
  if (!d) {
    throw new Error(
      `dsh-royalty-router: unsupported chain ${opts.chainId} `
      + `(known: ${Object.keys(deployments).join(", ")})`,
    );
  }
  return opts.factory ? { ...d, factory: opts.factory } : d;
}

/** Build a viem public client for the configured chain. */
export function createClient(opts: ChainOpts): PublicClient {
  if (opts.chainId !== base.id) {
    throw new Error(
      `dsh-royalty-router: unsupported chain ${opts.chainId} (known: ${base.id})`,
    );
  }
  if (!opts.rpcUrl) throw new Error("dsh-royalty-router: rpcUrl is required");
  return createPublicClient({ chain: base, transport: http(opts.rpcUrl) });
}
