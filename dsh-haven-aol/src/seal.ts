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
 * - AES-GCM file framing mirrors haven-cli's streaming encryptor
 *   byte-for-byte (`haven_aol_local.encrypt_file_streaming`, shared
 *   verbatim by `haven_aol_v3.encrypt_file_streaming_v3`): `[12-byte
 *   base IV][u32LE index][u32LE length][ciphertext+tag]*` over 1 MiB
 *   plaintext chunks, per-chunk IV = base IV XOR BE64(index) into
 *   bytes 4..12. Haven Mobile's `HavenCipher` streams this shape and
 *   refuses unframed payloads over 32 MiB — every seal ships framed.
 *   The legacy single-shot `[12-byte IV][ciphertext+tag]` layout
 *   (SDK `decryptFile`, Python `encrypt_bytes`) survives only on the
 *   decrypt side, for opening pre-framing rows.
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
 * Legacy AES-256-GCM single-shot encrypt (`[12-byte IV][ciphertext+tag]`,
 * the SDK `decryptFile` / Python `encrypt_bytes` layout). Files MUST NOT
 * seal this way — mobile refuses unframed payloads over 32 MiB. Kept for
 * small non-file payloads and legacy-compat tests; `seal()` uses
 * {@link encryptFileChunkedAesGcm}.
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

/** Plaintext bytes per AES-GCM chunk in framed seals (haven-cli `chunk_size` default). */
export const FRAMED_CHUNK_SIZE = 1024 * 1024

/**
 * Sanity bound on a declared chunk length: a corrupt header must not
 * become a huge alloc (haven-cli and mobile agree on 64 MiB).
 */
export const FRAMED_MAX_CHUNK_BYTES = 64 * 1024 * 1024

const FRAMED_BASE_IV_BYTES = 12
const FRAMED_HEADER_BYTES = 8
const GCM_TAG_BYTES = 16

function u32le(value: number): Uint8Array {
  const buf = new Uint8Array(4)
  new DataView(buf.buffer).setUint32(0, value, true)
  return buf
}

function readU32le(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, true)
}

/**
 * Per-chunk IV: base IV with the big-endian chunk index XORed into
 * bytes 4..12. Verbatim port of haven-cli `_derive_chunk_iv`
 * (mobile `HavenCipherImpl.deriveChunkIv` agrees).
 */
export function deriveChunkIv(baseIv: Uint8Array, chunkIndex: number): Uint8Array {
  if (baseIv.length !== FRAMED_BASE_IV_BYTES) {
    throw new Error(`dsh-haven-aol: base IV must be 12 bytes, got ${baseIv.length}`)
  }
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > 0xffffffff) {
    throw new Error(`dsh-haven-aol: chunk index must be a u32, got ${String(chunkIndex)}`)
  }
  const iv = new Uint8Array(baseIv)
  const counter = new Uint8Array(8)
  new DataView(counter.buffer).setBigUint64(0, BigInt(chunkIndex), false)
  for (let i = 0; i < 8; i++) {
    iv[i + 4] = (iv[i + 4] as number) ^ (counter[i] as number)
  }
  return iv
}

/**
 * Framed AES-256-GCM encrypt — the file seal format. Output `[12-byte
 * base IV][u32LE index][u32LE length][ciphertext+tag]*`, byte-identical
 * to haven-cli's streaming encryptor for the same key/IV/chunking
 * (pinned by golden vectors in tests).
 * @param plaintext - bytes to seal.
 * @param aesKey - 32-byte key (per-seal for v1/v4, per-epoch-bucket for v3).
 * @param opts - `chunkSize` defaults to 1 MiB (haven-cli); `baseIv`
 * overrides the fresh randomness (deterministic tests only).
 * @returns sealed bytes plus the base IV (also prefixed in the output).
 */
export async function encryptFileChunkedAesGcm(
  plaintext: Uint8Array,
  aesKey: Uint8Array,
  opts?: { chunkSize?: number; baseIv?: Uint8Array },
): Promise<{ sealed: Uint8Array; baseIv: Uint8Array }> {
  if (aesKey.length !== 32) {
    throw new Error(`dsh-haven-aol: AES key must be 32 bytes, got ${aesKey.length}`)
  }
  const chunkSize = opts?.chunkSize ?? FRAMED_CHUNK_SIZE
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error(`dsh-haven-aol: chunkSize must be a positive integer, got ${String(opts?.chunkSize)}`)
  }
  const baseIv = opts?.baseIv !== undefined ? new Uint8Array(opts.baseIv) : new Uint8Array(randomBytes(12))
  if (baseIv.length !== FRAMED_BASE_IV_BYTES) {
    throw new Error(`dsh-haven-aol: base IV must be 12 bytes, got ${baseIv.length}`)
  }
  const key = await crypto.subtle.importKey('raw', toArrayBuffer(aesKey), { name: 'AES-GCM' }, false, ['encrypt'])
  const frames: Uint8Array[] = [baseIv]
  let total = baseIv.length
  let index = 0
  for (let offset = 0; offset < plaintext.length; offset += chunkSize, index++) {
    const chunk = plaintext.subarray(offset, Math.min(offset + chunkSize, plaintext.length))
    const iv = deriveChunkIv(baseIv, index)
    const encrypted = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(iv) }, key, toArrayBuffer(chunk)))
    const header = new Uint8Array(FRAMED_HEADER_BYTES)
    header.set(u32le(index), 0)
    header.set(u32le(encrypted.length), 4)
    frames.push(header, encrypted)
    total += header.length + encrypted.length
  }
  const sealed = new Uint8Array(total)
  let at = 0
  for (const part of frames) {
    sealed.set(part, at)
    at += part.length
  }
  return { sealed, baseIv }
}

/**
 * Framing detector — the whole-buffer twin of mobile
 * `HavenCipherImpl.isChunkedFormat` (same field order, same bounds,
 * same fit check). A legacy payload's first eight ciphertext bytes are
 * effectively random, so clearing every constraint at once is a false
 * positive mobile accepts too.
 */
export function isChunkedPayload(data: Uint8Array): boolean {
  if (data.length < FRAMED_BASE_IV_BYTES + FRAMED_HEADER_BYTES) return false
  const index = readU32le(data, FRAMED_BASE_IV_BYTES)
  const length = readU32le(data, FRAMED_BASE_IV_BYTES + 4)
  return index === 0
    && length > GCM_TAG_BYTES
    && length <= FRAMED_MAX_CHUNK_BYTES
    && FRAMED_BASE_IV_BYTES + FRAMED_HEADER_BYTES + length <= data.length
}

/**
 * Framed AES-256-GCM decrypt. Header order, length bounds, and failure
 * names mirror mobile `HavenCipherImpl`, so one grep covers both stacks.
 */
export async function decryptFileChunked(sealed: Uint8Array, aesKey: Uint8Array): Promise<Uint8Array> {
  if (aesKey.length !== 32) {
    throw new Error(`dsh-haven-aol: AES key must be 32 bytes, got ${aesKey.length}`)
  }
  if (sealed.length < FRAMED_BASE_IV_BYTES + FRAMED_HEADER_BYTES) {
    throw new Error('dsh-haven-aol: framed payload too short for a base IV + chunk header')
  }
  const baseIv = sealed.subarray(0, FRAMED_BASE_IV_BYTES)
  const key = await crypto.subtle.importKey('raw', toArrayBuffer(aesKey), { name: 'AES-GCM' }, false, ['decrypt'])
  const parts: Uint8Array[] = []
  let total = 0
  let offset = FRAMED_BASE_IV_BYTES
  let expectedIndex = 0
  while (offset < sealed.length) {
    if (offset + FRAMED_HEADER_BYTES > sealed.length) {
      throw new Error(`dsh-haven-aol: truncated chunk header at ${offset}`)
    }
    const index = readU32le(sealed, offset)
    const length = readU32le(sealed, offset + 4)
    if (length <= GCM_TAG_BYTES || length > FRAMED_MAX_CHUNK_BYTES) {
      throw new Error(`dsh-haven-aol: chunk ${index} declares an invalid length (${length})`)
    }
    if (index !== expectedIndex) {
      throw new Error(`dsh-haven-aol: chunk order mismatch: expected ${expectedIndex}, got ${index}`)
    }
    const body = offset + FRAMED_HEADER_BYTES
    if (body + length > sealed.length) {
      throw new Error(`dsh-haven-aol: truncated chunk ${index} (declares ${length}, holds ${sealed.length - body})`)
    }
    const iv = deriveChunkIv(baseIv, index)
    const plain = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(sealed.subarray(body, body + length)),
    ))
    parts.push(plain)
    total += plain.length
    offset = body + length
    expectedIndex++
  }
  if (expectedIndex === 0) throw new Error('dsh-haven-aol: framed payload holds no chunks')
  const plaintext = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    plaintext.set(part, at)
    at += part.length
  }
  return plaintext
}

/**
 * Framing-aware file open: framed seals (everything `seal()` ships)
 * decrypt chunk-by-chunk; legacy single-shot rows (pre-framing seals)
 * open with the SDK-identical single-shot path. Whole-buffer by design —
 * the agent box has RAM; mobile's 32 MiB legacy streaming ceiling is a
 * device constraint, not a wire rule, so no cap is enforced here.
 */
export async function decryptFileAny(sealed: Uint8Array, aesKey: Uint8Array): Promise<Uint8Array> {
  if (isChunkedPayload(sealed)) return decryptFileChunked(sealed, aesKey)
  if (aesKey.length !== 32) {
    throw new Error(`dsh-haven-aol: AES key must be 32 bytes, got ${aesKey.length}`)
  }
  if (sealed.length < FRAMED_BASE_IV_BYTES) {
    throw new Error('dsh-haven-aol: encrypted data too short (missing IV)')
  }
  const key = await crypto.subtle.importKey('raw', toArrayBuffer(aesKey), { name: 'AES-GCM' }, false, ['decrypt'])
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(sealed.subarray(0, FRAMED_BASE_IV_BYTES)) },
    key,
    toArrayBuffer(sealed.subarray(FRAMED_BASE_IV_BYTES)),
  )
  return new Uint8Array(plaintext)
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
