/**
 * Seal-side primitives for Haven-AOL: AES-256-GCM file encryption,
 * IBE key-wrapping under the canister's verification key, and v1 gate
 * metadata construction.
 *
 * Sourcing rules (same as aol.ts — do not break):
 * - Derivation inputs, epochs, v3/v4 metadata build/parse, and EIP-712
 *   builders come from the `haven-aol` SDK verbatim. Only the v1 metadata
 *   builder is ported here (from `haven-aol` Python `core.py`: the TS SDK
 *   never grew one), and it round-trips through the SDK's own v1 parser.
 * - AES-GCM mirrors the SDK's `decryptFile` byte-for-byte (WebCrypto,
 *   `[12-byte IV][ciphertext+tag]`); Python `encrypt_file` produces the
 *   identical layout.
 * - IBE wrapping calls `@icp-sdk/vetkeys` `IbeCiphertext.encrypt` with the
 *   canister-fetched verification key (never a locally derived guess):
 *   the DPK comes from `getVetKDPublicKey[V3][V4]`, exactly like the
 *   Python sealer's `_get_or_cache_derived_public_key`.
 *
 * Custody: v1/v4 AES keys and all IBE plaintexts stay inside the sealing
 * call; v3 epoch keys live in the epoch cache, which a configured
 * keyStorePath keeps across restarts (see `./keyStore.ts`). The only
 * key-derived output is the SHA-256 commitment (`keySha256`), which
 * proves which key sealed a file without revealing it.
 *
 * @module dsh-haven-aol/seal
 */

import { randomBytes } from 'node:crypto'
import { DerivedPublicKey, IbeCiphertext, IbeIdentity, IbeSeed } from '@icp-sdk/vetkeys'
import { VALID_CHAINS } from 'haven-aol'

/** v1 gate metadata JSON shape (mirrors the SDK's parsed `GateMetadata`). */
export interface GateMetadataV1Json {
  version: 1
  cid: string
  chain: string
  tokenAddress: string
  threshold: string
  encryptedAesKey: string
}

const TOKEN_ADDR_RE = /^0x[0-9a-fA-F]{40}$/

function requireChain(chain: string): void {
  if (!(VALID_CHAINS as readonly string[]).includes(chain)) {
    throw new Error(`dsh-haven-aol: invalid chain ${JSON.stringify(chain)} (want one of ${(VALID_CHAINS as readonly string[]).join(', ')})`)
  }
}

function requireTokenAddress(tokenAddress: string): void {
  if (!TOKEN_ADDR_RE.test(tokenAddress)) {
    throw new Error(`dsh-haven-aol: invalid token address ${JSON.stringify(tokenAddress)} (want 0x + 40 hex)`)
  }
}

function requireThreshold(threshold: bigint | number): bigint {
  const value = typeof threshold === 'bigint' ? threshold : BigInt(Math.trunc(threshold))
  if (value <= 0n) throw new Error(`dsh-haven-aol: threshold must be > 0, got ${String(threshold)} (free content ships clear — never sealed)`)
  return value
}

/**
 * Build v1 gate metadata (ported from Python `core.build_gate_metadata`:
 * field order and threshold-as-string match; the TS SDK has no v1
 * builder). Validates like the v3/v4 SDK builders.
 */
export function buildGateMetadataV1(args: {
  cid: string
  chain: string
  tokenAddress: string
  threshold: bigint | number
  encryptedAesKey: string
}): GateMetadataV1Json {
  requireChain(args.chain)
  requireTokenAddress(args.tokenAddress)
  const threshold = requireThreshold(args.threshold)
  if (typeof args.cid !== 'string' || args.cid.length === 0) {
    throw new Error('dsh-haven-aol: cid must be a non-empty string')
  }
  if (typeof args.encryptedAesKey !== 'string' || args.encryptedAesKey.length === 0) {
    throw new Error('dsh-haven-aol: encryptedAesKey must be a non-empty base64 string')
  }
  return {
    version: 1,
    cid: args.cid,
    chain: args.chain,
    tokenAddress: args.tokenAddress,
    threshold: threshold.toString(),
    encryptedAesKey: args.encryptedAesKey,
  }
}

/** Canonical v1 JSON: fixed field order, matching the SDK v3/v4 serializers. */
export function gateMetadataV1ToJson(meta: GateMetadataV1Json): string {
  if (meta.version !== 1) {
    throw new Error(`dsh-haven-aol: gateMetadataV1ToJson expects version=1, got ${String(meta.version)}`)
  }
  return JSON.stringify({
    version: meta.version,
    cid: meta.cid,
    chain: meta.chain,
    tokenAddress: meta.tokenAddress,
    threshold: meta.threshold,
    encryptedAesKey: meta.encryptedAesKey,
  })
}

/** Copy Uint8Array to a fresh ArrayBuffer (mirrors the SDK's decrypt helper). */
function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(u.length)
  new Uint8Array(buf).set(u)
  return buf
}

/**
 * AES-256-GCM encrypt. Output format `[12-byte IV][ciphertext+tag]`
 * decrypts with the SDK's `decryptFile` and Python's AESGCM alike.
 * @param plaintext - bytes to seal.
 * @param aesKey - 32-byte key (per-seal for v1/v4, per-epoch-bucket for v3).
 * @returns sealed bytes plus the IV (also prefixed in the output). The IV is
 * fresh randomness per call — sharing a key across seals stays sound.
 */
export async function encryptFileAesGcm(plaintext: Uint8Array, aesKey: Uint8Array): Promise<{ sealed: Uint8Array; iv: Uint8Array }> {
  if (aesKey.length !== 32) {
    throw new Error(`dsh-haven-aol: AES key must be 32 bytes, got ${aesKey.length}`)
  }
  const iv = new Uint8Array(randomBytes(12))
  const key = await crypto.subtle.importKey('raw', toArrayBuffer(aesKey), { name: 'AES-GCM' }, false, ['encrypt'])
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, key, toArrayBuffer(plaintext))
  const sealed = new Uint8Array(12 + ciphertext.byteLength)
  sealed.set(iv, 0)
  sealed.set(new Uint8Array(ciphertext), 12)
  return { sealed, iv }
}

/**
 * IBE-wrap one AES key under a canister verification key.
 * @param dpkBytes - `getVetKDPublicKey[V3][V4]` bytes for the gate version.
 * @param derivationInput - SDK-computed derivation input (the IBE identity).
 * @param aesKey - 32-byte AES key.
 * @returns standard-base64 serialized `IbeCiphertext` (the gate's `encryptedAesKey`).
 */
export function ibeEncryptAesKey(dpkBytes: Uint8Array, derivationInput: Uint8Array, aesKey: Uint8Array): string {
  if (aesKey.length !== 32) {
    throw new Error(`dsh-haven-aol: AES key must be 32 bytes, got ${aesKey.length}`)
  }
  const dpk = DerivedPublicKey.deserialize(dpkBytes)
  const identity = IbeIdentity.fromBytes(derivationInput)
  const ciphertext = IbeCiphertext.encrypt(dpk, identity, aesKey, IbeSeed.random())
  return Buffer.from(ciphertext.serialize()).toString('base64')
}

/** Fresh 256-bit AES content key. */
export function freshAesKey(): Uint8Array {
  return new Uint8Array(randomBytes(32))
}
