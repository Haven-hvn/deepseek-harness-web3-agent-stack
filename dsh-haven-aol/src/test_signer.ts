/**
 * TEST-ONLY raw EIP-712 digest signer for `dsh-haven-aol`.
 *
 * OWS `signMessage` is EIP-191 (personal prefix); the canister verifies
 * ecrecover over the raw EIP-712 digest, so the default seam fails loud.
 * For local flow testing only, sign the digest directly from a raw
 * secp256k1 private key (env only, never config/disk):
 *
 *   HAVEN_AOL_TEST_PRIVATE_KEY=0x... pnpm vitest
 *
 * Uses ethers SigningKey.sign (no prefix). Production must use a
 * vault-backed signDigest entry point instead.
 *
 * @module dsh-haven-aol/test_signer
 */

import { SigningKey } from 'ethers'
import type { SignGate } from './aol.ts'

/** Build a SignGate that signs the 32-byte digest raw (no EIP-191 prefix). */
export function signGateFromTestKey(privateKeyHex: string): SignGate {
  const normalized = privateKeyHex.trim().startsWith('0x')
    ? privateKeyHex.trim() as `0x${string}`
    : (`0x${privateKeyHex.trim()}` as `0x${string}`)
  const key = new SigningKey(normalized)
  return async (digestHex: `0x${string}`): Promise<`0x${string}`> =>
    key.sign(digestHex).serialized as `0x${string}`
}
