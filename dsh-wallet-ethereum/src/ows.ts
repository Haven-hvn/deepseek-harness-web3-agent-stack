/**
 * Typed port over the `@open-wallet-standard/core` Node bindings (NAPI: the
 * Rust core runs in-process). Only the operations this adapter uses are
 * declared — wallet lookup and the two sign-only signing calls; `signAndSend`
 * is deliberately absent (broadcasting is out of the adapter contract, per
 * the haven-adapters OWS migration plan).
 *
 * The native module is imported lazily so this package loads, mounts, and
 * tests without the binding present; the import failure message is
 * actionable. Tests substitute {@link internals.signer}.
 *
 * @module dsh-wallet-ethereum/ows
 */

/** One derived account of an OWS vault wallet. */
export interface OwsAccountInfo {
  /** CAIP-2 chain id (e.g. `eip155:1`). */
  readonly chainId: string
  /** Chain-native address. */
  readonly address: string
  /** BIP-44 derivation path. */
  readonly derivationPath: string
}

/** OWS vault wallet metadata. */
export interface OwsWalletInfo {
  /** UUID v4. */
  readonly id: string
  /** Wallet name. */
  readonly name: string
  /** Derived accounts across the vault's chain set. */
  readonly accounts: readonly OwsAccountInfo[]
}

/** Signature result of one OWS signing call. */
export interface OwsSignResult {
  /** Hex-encoded signature. */
  readonly signature: string
  /** EVM/Tron recovery id (v value), when applicable. */
  readonly recoveryId?: number
}

/**
 * The exact OWS surface this adapter consumes. Parameter order mirrors the
 * NAPI functions (`docs/sdk-node.md`): the credential — the vault passphrase
 * or an `ows_key_…` API token — is passed per call and triggers policy
 * evaluation before decryption; key material is zeroized inside OWS after
 * each operation (key isolation).
 */
export interface OwsSigner {
  getWallet(nameOrId: string, vaultPath?: string): OwsWalletInfo
  signMessage(
    wallet: string,
    chain: string,
    message: string,
    passphrase?: string,
    encoding?: string,
    index?: number,
    vaultPath?: string,
  ): OwsSignResult
  signTransaction(
    wallet: string,
    chain: string,
    txHex: string,
    passphrase?: string,
    index?: number,
    vaultPath?: string,
  ): OwsSignResult
}

/**
 * Test seam: when `signer` is set, {@link loadOwsSigner} returns it and the
 * native module is never imported. Mirrors the dsh `internals` override
 * precedent (e.g. `dsh-headless`).
 */
export const internals: { signer: OwsSigner | undefined } = { signer: undefined }

/**
 * Resolve the OWS signer, lazily importing the native bindings on first use.
 * @returns the signer surface.
 * @throws an actionable error when the bindings are not installed.
 */
export async function loadOwsSigner(): Promise<OwsSigner> {
  if (internals.signer !== undefined) return internals.signer
  try {
    // Dynamic import: the optional native dependency is touched only when a
    // real operation needs it, so composition and tests never require it.
    const ows = await import('@open-wallet-standard/core')
    return ows as unknown as OwsSigner
  } catch (cause) {
    throw new Error(
      'dsh-wallet-ethereum: @open-wallet-standard/core is not installed. '
      + 'Install it into the profile (dsh plugin --profile <name> add @open-wallet-standard/core) — '
      + 'it ships prebuilt native binaries for macOS (arm64, x64) and Linux (x64, arm64).',
      { cause },
    )
  }
}
