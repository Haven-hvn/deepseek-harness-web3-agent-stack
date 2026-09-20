/**
 * Raw-key Ethereum adapter: implements the `dsh-wallet` `CryptoAdapter`
 * contract directly from a secp256k1 private key via `ethers` — no OWS vault.
 *
 * Custody: the private key arrives as `WalletKeySource.secret` (resolved per
 * operation through `ctx.credentials` from the wallet's `keyRef`, never from
 * configuration) and lives only in the operation-scoped key material, dropped
 * on return — the same resolve→load→sign→drop pipeline as the OWS adapter.
 * Configuration carries the credential NAME; a pasted key still fails the
 * `CredentialRef` pattern at plugin load.
 *
 * Why this exists: the Haven-AOL canister verifies `ecrecover` over the raw
 * EIP-712 gate digest (`\x19\x01‖domain‖structHash`). OWS `signMessage` is
 * EIP-191 (personal prefix), so its signatures recover to a different address
 * and the canister rejects them with `#InvalidSignature`. `signDigest` here
 * signs the 32-byte digest raw (`SigningKey.sign`, no prefix) — exactly what
 * the canister verifies (see `dsh-haven-aol/src/test_signer.ts`, promoted to
 * a production adapter here).
 *
 * @module dsh-wallet-ethereum/raw
 */

import { SigningKey, Transaction, Wallet } from 'ethers'
import type { CryptoAdapter, WalletAddress, WalletKeySource, WalletSignature } from 'dsh-wallet'

/**
 * Operation-scoped raw-key context — the adapter's `keyMaterial`. Holds the
 * private key for THIS operation only; callers drop it on return.
 */
export interface RawKeyContext {
  readonly chain: string
  readonly address: WalletAddress
  readonly privateKey: `0x${string}`
}

/** Narrow adapter-opaque key material back to the context this adapter minted. */
function asRawContext(keyMaterial: unknown): RawKeyContext {
  const context = keyMaterial as RawKeyContext | null
  if (
    context === null || typeof context !== 'object'
    || typeof context.address !== 'string' || typeof context.privateKey !== 'string'
  ) {
    throw new TypeError(
      'dsh-wallet-ethereum: keyMaterial was not produced by this adapter\'s loadKey — '
      + 'key material is operation-scoped and must not cross adapters',
    )
  }
  return context
}

/** Normalize + validate the operation secret as a 32-byte secp256k1 key. Never echoes the key. */
function normalizePrivateKey(secret: string | undefined): `0x${string}` {
  if (secret === undefined || secret.trim().length === 0) {
    throw new Error(
      'dsh-wallet-ethereum(raw): wallet declares no keyRef or the credential resolves to no value — '
      + 'configure keyRef to the env var holding the 0x-prefixed 32-byte private key',
    )
  }
  // Tolerate copy-paste shapes: surrounding whitespace/quotes (dotenv,
  // PowerShell) and a missing 0x prefix. Validation below stays strict.
  let cleaned = secret.trim()
  if (
    cleaned.length >= 2
    && ((cleaned.startsWith('"') && cleaned.endsWith('"'))
      || (cleaned.startsWith("'") && cleaned.endsWith("'")))
  ) {
    cleaned = cleaned.slice(1, -1).trim()
  }
  const normalized = cleaned.startsWith('0x') ? cleaned : `0x${cleaned}`
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(
      'dsh-wallet-ethereum(raw): resolved credential is not a 0x-prefixed 32-byte private key '
      + '(expected 66 chars, 0x + 64 hex)',
    )
  }
  return normalized as `0x${string}`
}

/**
 * The raw-key `CryptoAdapter`. Stateless across operations; every method
 * builds its state from the operation-scoped inputs.
 */
export class RawEthereumCryptoAdapter implements CryptoAdapter {
  constructor(private readonly chain: string) {}

  /**
   * Derive the EOA address from the operation's private key and mint the
   * operation-scoped signing context. The provider-scoped `source.wallet`
   * selector is ignored beyond diagnostics — the address comes from the key.
   */
  async loadKey(source: WalletKeySource): Promise<{ address: WalletAddress; keyMaterial: unknown }> {
    const privateKey = normalizePrivateKey(source.secret)
    let address: string
    try {
      address = await new Wallet(privateKey).getAddress()
    } catch (cause) {
      throw new Error('dsh-wallet-ethereum(raw): failed to derive address from the resolved key', { cause })
    }
    const keyMaterial: RawKeyContext = { chain: source.chain, address, privateKey }
    return { address, keyMaterial }
  }

  /**
   * Sign a message with EIP-191 semantics (ethers `signMessage`). Same
   * convention as the OWS adapter — keeps XMTP / Synapse compat.
   */
  async signMessage(keyMaterial: unknown, payload: string): Promise<WalletSignature> {
    const context = asRawContext(keyMaterial)
    const wallet = new Wallet(context.privateKey)
    if (wallet.address.toLowerCase() !== context.address.toLowerCase()) {
      throw new Error('dsh-wallet-ethereum(raw): key material address mismatch')
    }
    return wallet.signMessage(payload)
  }

  /**
   * Sign a serialized unsigned transaction (hex) — sign-only, never
   * broadcast. Parses via ethers `Transaction.from` then signs, so viem
   * `serializeTransaction` output (the Synapse / ERC-8004 path) round-trips.
   */
  async signTransaction(keyMaterial: unknown, payload: string): Promise<WalletSignature> {
    const context = asRawContext(keyMaterial)
    const wallet = new Wallet(context.privateKey)
    let tx: ReturnType<typeof Transaction.from>
    try {
      tx = Transaction.from(payload)
    } catch (cause) {
      throw new Error(
        'dsh-wallet-ethereum(raw): signTransaction expects hex-encoded serialized transaction bytes',
        { cause },
      )
    }
    try {
      return await wallet.signTransaction(tx)
    } catch (cause) {
      throw new Error('dsh-wallet-ethereum(raw): signTransaction failed', { cause })
    }
  }

  /**
   * Sign a raw 32-byte digest with secp256k1 (no EIP-191 prefix) — the
   * Haven-AOL gate path. `ecrecover` over this signature returns the
   * wallet address for the EIP-712 digest.
   */
  async signDigest(keyMaterial: unknown, digestHex: string): Promise<WalletSignature> {
    const context = asRawContext(keyMaterial)
    if (!/^0x[0-9a-fA-F]{64}$/.test(digestHex)) {
      throw new Error('dsh-wallet-ethereum(raw): signDigest expects a 0x-prefixed 32-byte digest hex string')
    }
    return new SigningKey(context.privateKey).sign(digestHex).serialized as `0x${string}`
  }
}
