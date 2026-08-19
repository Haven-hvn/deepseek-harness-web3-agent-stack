/**
 * Type surface of the wallet capability seam: the provider contract (Haven's
 * `CryptoAdapter`, translated to dsh conventions), the operation-scoped key
 * source, and the seam's Cordis event declaration. Types only — no runtime
 * code.
 *
 * Concept lineage (haven-core `src/interfaces.ts` `CryptoAdapter`): the
 * three-method shape — load a key and derive the public address, sign a
 * message, sign a transaction, with `keyMaterial` opaque to everything but
 * the adapter that minted it — carries over verbatim. What changes is the key
 * source: Haven's `loadKey(keySource: string)` accepted `"env:VAR"` or a raw
 * `"0x..."` private key; here the runtime owns credential resolution through
 * `ctx.credentials` (a `CredentialRef` is a *reference* — an env-var-style
 * name — never a value), so an adapter receives a structured, operation-scoped
 * {@link WalletKeySource} instead of parsing prefixes, and raw keys can never
 * appear in configuration.
 *
 * @module dsh-wallet/types
 */

/** Chain-native public address derived by an adapter (e.g. `0x…` on EVM chains). */
export type WalletAddress = string

/** Hex-encoded signature returned by an adapter. */
export type WalletSignature = string

/**
 * Operation-scoped key source handed to {@link CryptoAdapter.loadKey}. Built
 * by the wallet runtime *inside* one operation: `secret` is the credential
 * value resolved through `ctx.credentials` at that moment, never cached and
 * never present in any configuration surface. What the secret *is* belongs to
 * the adapter's custody model: an OWS-backed adapter treats it as the vault
 * passphrase or `ows_key_…` API token that authorizes a signing session (the
 * private key itself never enters this process); a raw-key adapter would
 * treat it as key material. Either way it dies with the operation.
 */
export interface WalletKeySource {
  /** Provider-scoped wallet selector (an OWS vault wallet name/id, a key alias, …). */
  readonly wallet: string
  /** Chain family the operation targets (e.g. `evm`, `solana`). */
  readonly chain: string
  /** Resolved credential value for this one operation; absent when the wallet declares no `keyRef`. */
  readonly secret?: string
}

/**
 * The pluggable signing provider — Haven's `CryptoAdapter` contract as the
 * dsh provider seam. The wallet runtime never sees key bytes: `loadKey`
 * returns the public address plus adapter-opaque `keyMaterial`, and the
 * runtime hands that material straight back to the same adapter's signing
 * methods within the same operation, then drops every reference.
 */
export interface CryptoAdapter {
  /**
   * Establish an operation-scoped signing context and derive the public
   * address.
   * @param source - wallet selector, chain, and the just-resolved secret.
   * @returns the chain-native address and adapter-opaque key material.
   */
  loadKey(source: WalletKeySource): Promise<{ address: WalletAddress; keyMaterial: unknown }>

  /**
   * Sign an arbitrary message following the chain's message-signing
   * convention (EIP-191 on EVM).
   * @param keyMaterial - opaque material minted by {@link loadKey} in this operation.
   * @param payload - message text to sign.
   * @returns the hex-encoded signature.
   */
  signMessage(keyMaterial: unknown, payload: string): Promise<WalletSignature>

  /**
   * Sign an already-serialized transaction (hex-encoded bytes) WITHOUT
   * broadcasting it.
   * @param keyMaterial - opaque material minted by {@link loadKey} in this operation.
   * @param payload - hex-encoded serialized transaction bytes.
   * @returns the hex-encoded signature or signed payload.
   */
  signTransaction(keyMaterial: unknown, payload: string): Promise<WalletSignature>
}

/** One configured wallet: which chain family, which provider-scoped wallet, which credential *reference*. */
export interface WalletDescriptor {
  /** Chain family served by a registered adapter (e.g. `evm`). */
  readonly chain: string
  /** Provider-scoped wallet selector (e.g. the OWS vault wallet name). */
  readonly wallet: string
  /**
   * Credential *reference* (a POSIX-style environment-variable name) resolved
   * through `ctx.credentials` at each operation. Never a secret value — the
   * runtime rejects anything that does not parse as a reference.
   */
  readonly keyRef?: string
}

/** Safe description of one configured wallet for diagnostics and UIs — never a secret. */
export interface WalletInfo {
  /** Configured wallet name (the `ctx.wallet` operation key). */
  readonly name: string
  /** Chain family. */
  readonly chain: string
  /** Provider-scoped wallet selector. */
  readonly wallet: string
  /** Whether the wallet declares a credential reference. */
  readonly keyRefConfigured: boolean
  /** Whether an adapter for `chain` is currently registered. */
  readonly adapterRegistered: boolean
}

/** Audit payload of one completed signing operation. Carries identity facts only — never key material. */
export interface WalletSignedEvent {
  /** Configured wallet name. */
  readonly wallet: string
  /** Chain family. */
  readonly chain: string
  /** Which signing operation completed. */
  readonly operation: 'sign-message' | 'sign-transaction'
  /** Public address that signed. */
  readonly address: WalletAddress
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One signing operation completed through `ctx.wallet`. Emitted strictly
     * after the adapter returned (the commit point); observers get identity
     * facts, never material.
     * @param event - wallet, chain, operation kind, and signing address.
     * @mode emit
     */
    'wallet/signed'(event: WalletSignedEvent): void
  }
}
