/**
 * Wallet bridge for dsh-royalty-router execute tools.
 *
 * Reuses the dsh-storage-synapse viem `toAccount` pattern: the plugin holds
 * no key material — every signature is delegated per-operation to
 * `ctx.wallet` (works with both `ows` and `raw` providers), so rotation
 * reaches the very next operation without restart. No new custody code.
 *
 * Reads never touch this module: only `rr_launch` / `rr_sweep` /
 * `rr_heartbeat` build a signing client through it, and only when a
 * `wallet` name is configured.
 *
 * @module dsh-royalty-router/wallet
 */

import { createWalletClient, http, type WalletClient } from "viem";
import { base } from "viem/chains";
import type { ChainOpts } from "./chain.ts";

/** Build a viem Account delegating signing to one configured dsh-wallet. */
export async function createSigningAccount(
  ctx: unknown,
  walletName: string,
): Promise<import("viem").Account> {
  const walletSeam: any = (ctx as any).wallet
  if (!walletSeam?.address || typeof walletSeam.signTransaction !== "function") {
    throw new Error(
      "dsh-royalty-router: ctx.wallet not mounted or missing signTransaction "
      + "(execute tools need dsh-wallet + dsh-wallet-ethereum; reads work without them)",
    );
  }
  const address = (await walletSeam.address(walletName)) as `0x${string}`;
  const { toAccount } = await import("viem/accounts");
  return toAccount({
    address,
    async signMessage({ message }: { message: string | { raw: string | Uint8Array } }): Promise<`0x${string}`> {
      let payload: string;
      if (typeof message === "string") payload = message;
      else if (typeof (message as any).raw === "string") payload = (message as any).raw;
      else if ((message as any).raw instanceof Uint8Array) payload = new TextDecoder().decode((message as any).raw);
      else payload = String(message);
      const { signature } = await walletSeam.signMessage(walletName, payload);
      return signature as `0x${string}`;
    },
    async signTransaction(transaction: any): Promise<`0x${string}`> {
      const { serializeTransaction } = await import("viem");
      const serialized = serializeTransaction(transaction);
      const { signature: signedRaw } = await walletSeam.signTransaction(walletName, serialized);
      return signedRaw as `0x${string}`;
    },
    async signTypedData(typedData: any): Promise<`0x${string}`> {
      const { hashTypedData } = await import("viem");
      const digest = hashTypedData(typedData as any) as `0x${string}`;
      const { signature } = await walletSeam.signMessage(walletName, digest);
      return signature as `0x${string}`;
    },
  } as any);
}

/**
 * Build the viem WalletClient the SDK's send path (`launch`, `sweep`,
 * `heartbeat`) expects: our bridged account over the configured RPC.
 */
export async function createSigningWalletClient(
  ctx: unknown,
  walletName: string,
  opts: ChainOpts,
): Promise<WalletClient> {
  if (opts.chainId !== base.id) {
    throw new Error(
      `dsh-royalty-router: unsupported chain ${opts.chainId} (known: ${base.id})`,
    );
  }
  const account = await createSigningAccount(ctx, walletName);
  return createWalletClient({ account, chain: base, transport: http(opts.rpcUrl) });
}

/** Resolve which configured wallet signs, or fail with an actionable error. */
export function requireWalletName(config: { wallet?: string }): string {
  if (config.wallet === undefined || config.wallet.trim() === "") {
    throw new Error(
      "dsh-royalty-router: execute tools need a 'wallet' in plugin config "
      + "(the dsh-wallet name that signs launches/sweeps); reads work without it",
    );
  }
  return config.wallet;
}
