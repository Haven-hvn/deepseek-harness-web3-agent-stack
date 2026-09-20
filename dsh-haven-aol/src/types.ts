/**
 * Shared types for dsh-haven-aol: audit events and the fail-loud
 * gate-signing error. Key material never appears in any of these —
 * VetKD/AES/transport keys stay inside the executing tool call.
 *
 * @module dsh-haven-aol/types
 */

/** Audit: a gated file was decrypted and written to disk. */
export interface AolDecryptedEvent {
  /** Gate protocol version that authorized the decrypt. */
  readonly version: 1 | 3 | 4
  /** Content identifier that was decrypted. */
  readonly cid: string
  /** Where the plaintext was written. */
  readonly outputPath: string
  /** Plaintext byte length. */
  readonly bytes: number
}

/**
 * Fail-loud gate-signing error.
 *
 * Thrown when a decrypt needs an EIP-712 gate signature but no raw-digest
 * signer is wired. ctx.wallet.signMessage is EIP-191 (personal prefix);
 * the canister verifies ecrecover over the raw EIP-712 digest, so a
 * personal-prefixed signature is rejected with #InvalidSignature. Resolve
 * the OWS encoding spike (README) then inject a signGate — this error
 * guarantees no silently-invalid signature is ever produced.
 */
export class AolSigningError extends Error {
  override readonly name = 'AolSigningError'
}
