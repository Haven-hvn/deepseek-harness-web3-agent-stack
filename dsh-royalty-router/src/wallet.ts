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
 * `wallet` name is configured. (The plugin declares the wallet seam in
 * `inject`, so this module is reachable wherever the plugin mounts.)
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
      const { signature } = await walletSeam.signTransaction(walletName, serialized);
      return assembleSignedTransaction(transaction, signature as string);
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

/**
 * Normalize the provider-dependent `signTransaction` seam result into the
 * complete signed transaction viem expects callers to broadcast.
 *
 * The seam does not standardize this: the `raw` adapter returns a full
 * signed tx, while OWS returns a bare 65-byte RSV (`0x` + 130 hex chars).
 * A bare signature handed to `sendRawTransaction` fails node-side with
 * "invalid string length" — exactly what the first fork rehearsal hit —
 * so RSV input is combined with the unsigned transaction here. No new
 * custody code: the signature still comes per operation from `ctx.wallet`.
 */
export async function assembleSignedTransaction(
  transaction: unknown,
  signature: string,
): Promise<`0x${string}`> {
  if (typeof signature !== "string") {
    throw new Error("dsh-royalty-router: wallet seam returned a non-hex signature");
  }
  // OWS returns bare 65-byte RSV as 130 hex chars WITHOUT a 0x prefix;
  // other providers may return 0x-prefixed RSV or a full signed tx.
  const hex = signature.startsWith("0x") ? signature.slice(2) : signature;
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length === 0) {
    throw new Error("dsh-royalty-router: wallet seam returned a non-hex signature");
  }
  if (hex.length !== 130) return `0x${hex}` as `0x${string}`;
  const { serializeTransaction } = await import("viem");
  const v = parseInt(hex.slice(128, 130), 16);
  if (!Number.isInteger(v) || v > 28) {
    throw new Error("dsh-royalty-router: wallet seam returned a malformed RSV signature");
  }
  return serializeTransaction(transaction as never, {
    r: `0x${hex.slice(0, 64)}`,
    s: `0x${hex.slice(64, 128)}`,
    yParity: v >= 27 ? v - 27 : v,
  } as never) as `0x${string}`;
}
