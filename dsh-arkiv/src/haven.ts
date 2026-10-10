/**
 * Haven application-protocol enforcement for Arkiv entities (ARKIV_FORMAT v2.2.0).
 *
 * This harness is Haven-specific: every entity written through
 * `arkiv_create_entity` / `arkiv_update_entity` must conform to the Haven
 * data format, and the runtime rejects anything else BEFORE signing.
 * Reference: `services/arkiv_sync.py`
 * (`_build_attributes`, `_build_payload`, Tiramisu cell limits) — the
 * tables below are a TypeScript port of its wire rules, made fail-closed:
 * where the reference implementation derives attributes from its pipeline
 * context (consistent
 * by construction), the harness receives attributes and payload as
 * separate model-supplied values and must cross-check them.
 *
 * Two wire encodings, matching the two established writers:
 * - Full / generic / custom groups: the reference `str|int` wire. The Python
 *   SDK expresses only those two annotation types, so `gate_token` and
 *   `sha256_ct` are lowercase-hex STRINGS and every numeric fact is a
 *   plain int (which the chain stores as the one numeric kind, matching
 *   JS `i32(...)` queries). The harness normalizes to exactly this so
 *   dedup queries (`sha256_ct = str('…')`) keep hitting rows written by
 *   the other established writer. One exception: `gate_threshold` is a
 *   tagged `u256` cell, because real ERC-20 thresholds (1e18 and beyond)
 *   do not fit i32 — an i32 threshold made every genuine gate unwritable.
 *   Readers already parse u64/u256 cells; nothing filters on threshold.
 * - Drip series / parts: the spec's tagged JS-SDK wire (`addr`, `bytes32`,
 *   `key`, `i32`, `str`), matching the dapp publisher — notably
 *   `series_ref` as `key`, which the one-query fan-out depends on.
 *
 * @module dsh-arkiv/haven
 */

import { addr, bytes32, i32, key, str, u256, U256_MAX } from '@arkiv-network/sdk/attr';

/** Spec version this module enforces (bump with ARKIV_FORMAT.md). */
export const HAVEN_FORMAT_VERSION = '2.3.0';

/** Usenet-style group taxonomy (spec §Taxonomy). */
export const HAVEN_GROUPS = {
  videoFull: 'haven.video.full',
  dripSeries: 'haven.video.drip.series',
  dripPart: 'haven.video.drip.part',
  audioFull: 'haven.audio.full',
  imageFull: 'haven.image.full',
  textFull: 'haven.text.full',
  fileFull: 'haven.file.full',
  metaGate: 'haven.meta.gate',
} as const;

/** Groups the harness refuses to write (reserved, no reader contract yet). */
export const HAVEN_RESERVED_GROUPS: ReadonlySet<string> = new Set([
  // haven.audio.full was reserved through v2.1.0 (audio rode haven.video.full);
  // v2.2.0 gives audio its own group, validated as the generic-file record.
  HAVEN_GROUPS.metaGate, // future shared gate-corpus records
]);

/** Valid `grp` override: lowercase dot hierarchy, ≥2 labels (reference `_GROUP_PATTERN`). */
const GROUP_PATTERN = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)+$/;

/** Arkiv `str` slots are 128 bytes (reference `TITLE_MAX_BYTES`). */
export const HAVEN_TITLE_MAX_BYTES = 128;

/** Upper bound on the serialized `x` (extra provenance) payload object. */
export const HAVEN_PAYLOAD_EXTRA_MAX_BYTES = 2048;

/** Haven-AOL chain variant → EIP-155 id (reference `CHAIN_VARIANT_TO_EIP155`). */
export const CHAIN_VARIANT_TO_EIP155: Readonly<Record<string, number>> = {
  EthMainnet: 1,
  EthSepolia: 11155111,
  ArbitrumOne: 42161,
  BaseMainnet: 8453,
  OptimismMainnet: 10,
};

/** Chain variants the gate JSON may name (haven-aol `VALID_CHAINS`). */
export const HAVEN_CHAIN_VARIANTS: ReadonlySet<string> = new Set(Object.keys(CHAIN_VARIANT_TO_EIP155));

/** Shared MIME enum (spec §MIME enum). Extend by appending, never renumber. */
export const MIME_TO_ENUM: Readonly<Record<string, number>> = {
  'video/mp4': 1,
  'video/webm': 2,
  'video/quicktime': 3,
  'audio/mpeg': 4,
  'audio/wav': 5,
  'audio/ogg': 6,
  'image/png': 7,
  'image/jpeg': 8,
  'image/webp': 9,
  'image/gif': 10,
  'image/svg+xml': 11,
  'text/plain': 12,
  'text/markdown': 13,
  'application/pdf': 14,
};

/** Highest assigned MIME enum code (`0` = unknown). */
export const MIME_ENUM_MAX = 14;

/** Chain cell limits (reference Tiramisu dialect: engine caps, backstop only). */
export const HAVEN_MAX_ATTRIBUTES = 32;
export const HAVEN_MAX_PAYLOAD_BYTES = 128 * 1024;

/** Arkiv block time in seconds: lifetimes must be a multiple of this. */
export const HAVEN_BLOCK_TIME_S = 2;

/** `i32` range (spec numeric facts must fit; the reference raises at encode time). */
export const HAVEN_I32_MIN = -(2 ** 31);
export const HAVEN_I32_MAX = 2 ** 31 - 1;

/** BTL defaults in seconds (spec §Expiry): 4w full/generic, 52w series, 12w parts. */
export const HAVEN_BTL_FULL_S = 4 * 7 * 24 * 60 * 60;
export const HAVEN_BTL_SERIES_S = 52 * 7 * 24 * 60 * 60;
export const HAVEN_BTL_PART_S = 12 * 7 * 24 * 60 * 60;

/** Haven payloads are JSON records; the reference implementation hardcodes this content type. */
export const HAVEN_CONTENT_TYPE = 'application/json';

/**
 * Attribute keys deleted in 2.0.0 — do not write, do not read
 * (spec §Deleted in 2.0.0). Writes carrying any of these are rejected.
 */
export const HAVEN_DELETED_ATTRIBUTES: ReadonlySet<string> = new Set([
  'project', 'type', 'category', 'tags', 'language', 'is_encrypted', 'encrypted_cid',
  'cid_hash', 'created_at', 'updated_at', 'created_at_ts', 'creator_handle', 'source_uri',
  'phash', 'analysis_model', 'mint_id', 'published_by', 'oracle_address', 'description',
  'thumbnail_cid', 'gate_version',
]);

/** v1.x → v2.0.0 payload renames (spec §Payload schema): old keys are rejected. */
export const HAVEN_RENAMED_PAYLOAD_KEYS: Readonly<Record<string, string>> = {
  filecoin_root_cid: 'fcid / piece',
  piece_cid: 'piece',
  encryption_metadata: 'gate',
  cid_encryption_metadata: 'cid_gate',
  content_file_size: 'size',
  file_size: 'size',
  original_hash: 'pt_hash',
  vlm_json_cid: 'vlm',
  analysis_model: 'vlm_model',
  source_uri: 'src',
  creator_handle: 'creator',
  codec_variants: 'codecs',
  segment_metadata: 'seg',
  attestation: 'attn',
};

/** Payload mirrors dropped in 2.0.0: infer from attributes / gate / system cells. */
export const HAVEN_DROPPED_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  'is_encrypted', 'cid_hash', 'gate_type', 'epoch', 'duration', 'content_mime_type',
  'expires_at_block', 'created_at_block', 'has_ai_data', 'description',
]);

/** `Ident32` name grammar (reference `_TIRAMISU_NAME_RE`). */
const ATTR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/;

/** Query-language words the engine rejects as attribute names. */
const ATTR_RESERVED_NAMES: ReadonlySet<string> = new Set([
  'and', 'or', 'not', 'true', 'false', 'startswith', 'exists', 'typeof',
  'bool', 'i32', 'u64', 'u256', 'dec', 'bytes32', 'bytes', 'str', 'addr', 'key',
]);

/** System attributes legal in a query filter (never in a write). */
const QUERY_SYSTEM_ATTRS: ReadonlySet<string> = new Set(['$key', '$owner', '$creator', '$expiresAt']);

const HEX40 = /^0x[0-9a-fA-F]{40}$/;
const HEX64_BARE = /^[0-9a-fA-F]{64}$/;
const HEX64 = /^(?:0x)?[0-9a-fA-F]{64}$/;

export type HavenGroupClass = 'video' | 'generic' | 'series' | 'part';

export interface HavenNormalizedWrite {
  /** Group class the record validated as. */
  grpClass: HavenGroupClass;
  /** The `grp` value (known group or custom override). */
  grp: string;
  /** Attributes exactly as they will be written (reference `str|int` wire for full/generic, tagged SDK values for drips). */
  attributes: Record<string, unknown>;
  /** Payload bytes, unchanged. */
  payload: Uint8Array;
  contentType: string;
  /** Caller value, or the per-group BTL default when omitted. */
  expiresIn: number;
}

function fail(message: string): never {
  throw new Error(`dsh-arkiv: haven ${message}`);
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strict i32: a real integer number — never a string, never a bool. */
function requireI32(name: string, value: unknown): number {
  if (typeof value === 'boolean') fail(`${name} must be an i32 number, got boolean (comparisons are type-exact)`);
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    fail(`${name} must be an i32 number, got ${typeof value} ${JSON.stringify(value)} (a str "4" never matches i32(4))`);
  }
  if (value < HAVEN_I32_MIN || value > HAVEN_I32_MAX) fail(`${name}=${value} does not fit i32`);
  return value;
}

function requireNonNegativeI32(name: string, value: unknown): number {
  const parsed = requireI32(name, value);
  if (parsed < 0) fail(`${name} must be >= 0, got ${parsed}`);
  return parsed;
}

/**
 * Token-amount threshold: a safe-integer number or an exact decimal string,
 * always compared and stored as bigint (u256 cell). Plain JSON numbers lose
 * precision past 2**53, so callers with wei-scale thresholds SHOULD pass
 * strings — but 1e18-scale safe values keep working as numbers.
 * Always > 0: the canister rejects threshold 0 (#InvalidThreshold), so a
 * gated record carrying 0 is free content burned through encryption —
 * free content ships as a clear fcid record instead.
 */
function requireThreshold(name: string, value: unknown): bigint {
  if (typeof value === 'boolean') fail(`${name} must be a u256 token amount > 0 (safe-integer number or decimal string), got boolean`);
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) fail(`${name} must be an integer, got ${value}`);
    if (value <= 0) fail(`${name} must be > 0, got ${value} (free content ships clear: fcid record, no gate)`);
    if (!Number.isSafeInteger(value)) fail(`${name}=${value} is not a safe integer — pass a decimal string for exact u256`);
    return BigInt(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = BigInt(value);
    if (parsed === 0n) fail(`${name} must be > 0, got "0" (free content ships clear: fcid record, no gate)`);
    if (parsed > U256_MAX) fail(`${name} exceeds u256`);
    return parsed;
  }
  fail(`${name} must be a u256 token amount > 0 (safe-integer number or decimal string), got ${JSON.stringify(value)}`);
}

function requireStr128(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${name} must be a non-empty str`);
  if (utf8Bytes(value) > HAVEN_TITLE_MAX_BYTES) {
    fail(`${name} is ${utf8Bytes(value)} bytes, over the 128-byte str limit`);
  }
  return value;
}

/** `0x` + 40 hex, any case → lowercase (reference wire keeps the `0x`, lowercased). */
function requireTokenAddress(name: string, value: unknown): string {
  if (typeof value !== 'string' || !HEX40.test(value)) {
    fail(`${name} must be a 0x address (40 hex), got ${JSON.stringify(value)}`);
  }
  return value.toLowerCase();
}

/** 64 hex with or without `0x` → bare lowercase (reference `hexdigest()` shape). */
function requireSha256Ct(name: string, value: unknown): string {
  if (typeof value !== 'string' || !HEX64.test(value)) {
    fail(`${name} must be a sha256 digest (64 hex, optional 0x), got ${JSON.stringify(value)}`);
  }
  return value.toLowerCase().replace(/^0x/, '');
}

/** 32-byte entity key, `0x` + 64 hex (any case) → lowercase. */
function requireEntityKey(name: string, value: unknown): string {
  if (typeof value !== 'string' || !HEX64.test(value) || value.toLowerCase().startsWith('0x') === false) {
    if (typeof value === 'string' && HEX64_BARE.test(value)) return `0x${value.toLowerCase()}`;
    fail(`${name} must be a 32-byte entity key (0x + 64 hex), got ${JSON.stringify(value)}`);
  }
  return value.toLowerCase();
}

function validateAttrName(name: string): void {
  if (name.startsWith('$')) fail(`attribute ${JSON.stringify(name)}: '$' is reserved for system attributes`);
  const raw = utf8Bytes(name);
  if (raw > 32 || !ATTR_NAME_PATTERN.test(name)) {
    fail(`attribute ${JSON.stringify(name)}: must match [A-Za-z][A-Za-z0-9._-]* and fit in 32 bytes`);
  }
  if (ATTR_RESERVED_NAMES.has(name.toLowerCase())) fail(`attribute ${JSON.stringify(name)}: reserved by the query language`);
}

function classifyGroup(grp: unknown): { grp: string; grpClass: HavenGroupClass } {
  if (typeof grp !== 'string' || grp.length === 0) fail(`grp is required (one of haven.video.full, haven.audio.full, haven.image.full, haven.text.full, haven.file.full, haven.video.drip.series, haven.video.drip.part, or a custom lowercase dot hierarchy)`);
  if (HAVEN_RESERVED_GROUPS.has(grp)) {
    fail(`${grp} is reserved (no writer contract exists yet)`);
  }
  switch (grp) {
    case HAVEN_GROUPS.videoFull: return { grp, grpClass: 'video' };
    case HAVEN_GROUPS.audioFull:
    case HAVEN_GROUPS.imageFull:
    case HAVEN_GROUPS.textFull:
    case HAVEN_GROUPS.fileFull: return { grp, grpClass: 'generic' };
    case HAVEN_GROUPS.dripSeries: return { grp, grpClass: 'series' };
    case HAVEN_GROUPS.dripPart: return { grp, grpClass: 'part' };
    default: break;
  }
  if (utf8Bytes(grp) <= HAVEN_TITLE_MAX_BYTES && GROUP_PATTERN.test(grp)) return { grp, grpClass: 'generic' };
  fail(`invalid grp ${JSON.stringify(grp)} (want a known haven group or a lowercase dot hierarchy of ≥2 labels, ≤128 B)`);
}

interface GateJson {
  version: number;
  cid: string;
  chain: string;
  tokenAddress: string;
  /** Raw threshold spelling (frozen verbose form is a string). */
  threshold: unknown;
  epoch?: unknown;
  marketCapTarget?: unknown;
  oracleAddress?: unknown;
  encryptedAesKey: string;
}

const GATE_KEYS_V1 = ['version', 'cid', 'chain', 'tokenAddress', 'threshold', 'encryptedAesKey'] as const;
const GATE_KEYS_V3 = [...GATE_KEYS_V1, 'epoch'] as const;
const GATE_KEYS_V4 = [...GATE_KEYS_V3, 'marketCapTarget', 'oracleAddress'] as const;

/** Structural gate check (reference `is_gate_metadata_any`, extended to v4). Returns the parsed gate. */
function parseGateJson(field: string, raw: unknown): GateJson {
  if (typeof raw !== 'string' || raw.length === 0) fail(`${field} must be a gate JSON string`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(`${field} is not valid JSON`);
  }
  if (!isRecord(parsed)) fail(`${field} must decode to a JSON object`);
  const version = parsed.version;
  // Pre-empt the bool-is-an-int ambiguity (reference `parse_gate_metadata`): a
  // literal `true` must never route to the v1 parser.
  if (typeof version === 'boolean') fail(`${field}.version must be 1, 3, or 4, got boolean`);
  const required = version === 1 ? GATE_KEYS_V1 : version === 3 ? GATE_KEYS_V3 : version === 4 ? GATE_KEYS_V4 : null;
  if (required === null) fail(`${field}.version must be 1, 3, or 4, got ${JSON.stringify(version)}`);
  for (const gateKey of required) {
    if (!(gateKey in parsed)) fail(`${field} is missing required v${version} key ${JSON.stringify(gateKey)}`);
  }
  const gate = parsed as unknown as GateJson;
  if (typeof gate.cid !== 'string' || gate.cid.length === 0) fail(`${field}.cid must be a non-empty string`);
  if (!HAVEN_CHAIN_VARIANTS.has(gate.chain)) {
    fail(`${field}.chain ${JSON.stringify(gate.chain)} is not a known Haven-AOL variant (want one of ${[...HAVEN_CHAIN_VARIANTS].join(', ')})`);
  }
  if (typeof gate.tokenAddress !== 'string' || !HEX40.test(gate.tokenAddress)) {
    fail(`${field}.tokenAddress must be a 0x address, got ${JSON.stringify(gate.tokenAddress)}`);
  }
  if (typeof gate.encryptedAesKey !== 'string' || gate.encryptedAesKey.length === 0) {
    fail(`${field}.encryptedAesKey must be a non-empty base64 string`);
  }
  if (version !== 1 && (typeof gate.epoch !== 'number' || !Number.isInteger(gate.epoch) || gate.epoch < 0)) {
    fail(`${field}.epoch must be a non-negative integer for v${version}`);
  }
  if (version === 4) {
    if (typeof gate.marketCapTarget !== 'number' || !Number.isInteger(gate.marketCapTarget) || gate.marketCapTarget < 0) {
      fail(`${field}.marketCapTarget must be a non-negative integer (whole reserve units)`);
    }
    if (typeof gate.oracleAddress !== 'string' || !HEX40.test(gate.oracleAddress)) {
      fail(`${field}.oracleAddress must be a 0x address, got ${JSON.stringify(gate.oracleAddress)}`);
    }
  }
  return gate;
}

/** Numeric threshold out of the frozen verbose spelling (string) or a bare int. */
function gateThresholdValue(field: string, threshold: unknown): bigint {
  if (typeof threshold === 'number') {
    if (!Number.isInteger(threshold) || threshold <= 0) fail(`${field}.threshold must be a positive integer (free content ships clear — gates carry threshold > 0), got ${threshold}`);
    return BigInt(threshold);
  }
  if (typeof threshold === 'string' && /^\d+$/.test(threshold)) {
    if (BigInt(threshold) === 0n) fail(`${field}.threshold must be a positive integer (free content ships clear — gates carry threshold > 0), got "0"`);
    return BigInt(threshold);
  }
  fail(`${field}.threshold must be a positive integer (frozen spelling is a string), got ${JSON.stringify(threshold)}`);
}

function defaultExpiresIn(grpClass: HavenGroupClass): number {
  switch (grpClass) {
    case 'series': return HAVEN_BTL_SERIES_S;
    case 'part': return HAVEN_BTL_PART_S;
    default: return HAVEN_BTL_FULL_S;
  }
}

/**
 * Validate one Haven entity write and normalize it to its wire encoding.
 * Fail-closed: any deviation from ARKIV_FORMAT v2.2.0 throws before anything
 * is signed. Normalization is what makes retries identical: hex lowercased,
 * `0x` stripped where the reference wire is bare, drip facts wrapped in their
 * spec-tagged SDK values.
 */
export function validateHavenWrite(input: {
  payload: Uint8Array;
  contentType: string;
  attributes?: Record<string, unknown>;
  expiresIn?: number;
}): HavenNormalizedWrite {
  if (input.contentType !== HAVEN_CONTENT_TYPE) {
    fail(`contentType must be ${JSON.stringify(HAVEN_CONTENT_TYPE)} (Haven entities are JSON records), got ${JSON.stringify(input.contentType)}`);
  }
  if (input.payload.length > HAVEN_MAX_PAYLOAD_BYTES) {
    fail(`payload is ${input.payload.length} bytes, over the ${HAVEN_MAX_PAYLOAD_BYTES}-byte chain limit`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(input.payload).toString('utf8'));
  } catch {
    fail('payload must be a JSON object (Haven record with piece⊕fcid + gate)');
  }
  if (!isRecord(payload)) fail('payload must be a JSON object (Haven record with piece⊕fcid + gate)');

  if (!isRecord(input.attributes)) fail('attributes are required (grp, title, gate corpus, sha256_ct, …)');
  const attributes = input.attributes;
  if (Object.keys(attributes).length > HAVEN_MAX_ATTRIBUTES) {
    fail(`carries ${Object.keys(attributes).length} attributes, over the ${HAVEN_MAX_ATTRIBUTES} chain limit`);
  }
  for (const name of Object.keys(attributes)) validateAttrName(name);
  for (const name of Object.keys(attributes)) {
    if (HAVEN_DELETED_ATTRIBUTES.has(name)) fail(`attribute ${JSON.stringify(name)} was deleted in 2.0.0 (do not write, do not read)`);
  }

  const { grp, grpClass } = classifyGroup(attributes.grp);

  // Payload renames + mirrors are rejected for every group class: the old
  // names never appear on the wire, and mirrors only duplicate bytes.
  for (const name of Object.keys(payload)) {
    const renamed = HAVEN_RENAMED_PAYLOAD_KEYS[name];
    if (renamed !== undefined) fail(`payload key ${JSON.stringify(name)} was renamed to ${JSON.stringify(renamed)} in 2.0.0`);
    if (HAVEN_DROPPED_PAYLOAD_KEYS.has(name)) fail(`payload key ${JSON.stringify(name)} was dropped in 2.0.0 (mirrors are forbidden)`);
  }

  switch (grpClass) {
    case 'series': return finishSeries({ grp, payload, raw: input.payload, attributes, expiresIn: input.expiresIn });
    case 'part': return finishPart({ grp, payload, raw: input.payload, attributes, expiresIn: input.expiresIn });
    default: return finishFull({ grp, grpClass, payload, raw: input.payload, attributes, expiresIn: input.expiresIn });
  }
}

function resolveExpiresIn(grpClass: HavenGroupClass, expiresIn: unknown): number {
  if (expiresIn === undefined) return defaultExpiresIn(grpClass);
  if (typeof expiresIn !== 'number' || !Number.isInteger(expiresIn) || expiresIn <= 0) {
    fail(`expiresIn must be a positive integer (seconds), got ${JSON.stringify(expiresIn)}`);
  }
  // Arkiv counts lifetimes in blocks: the chain cannot store a duration
  // that is not a whole number of 2s blocks (SDK `toBlocks` rejects it),
  // so reject here — before the ledger — with the usable neighbors.
  if (expiresIn % HAVEN_BLOCK_TIME_S !== 0) {
    fail(`expiresIn must be a multiple of the ${HAVEN_BLOCK_TIME_S}s block time, got ${expiresIn} (try ${expiresIn - 1} or ${expiresIn + 1})`);
  }
  return expiresIn;
}

/** CommP piece CIDs are base32 `bafk…` (v1/v2) — the only value `piece` may carry. */
const COMMP_PATTERN = /^bafk[a-z2-7]+$/;

function requireCommP(where: string, value: unknown): string {
  if (typeof value !== 'string' || !COMMP_PATTERN.test(value)) {
    fail(`${where} must be the CommP piece CID (bafk… base32), got ${JSON.stringify(value)} — gated records address the Filecoin piece, never the UnixFS root`);
  }
  return value;
}

/** Shared payload helpers for full/generic records. */
function requireLocator(payload: Record<string, unknown>): { locator: string; gated: boolean } {
  const piece = payload.piece;
  const fcid = payload.fcid;
  if (piece !== undefined && fcid !== undefined) fail('payload carries both piece and fcid — encrypted records carry piece, clear records carry fcid, never both');
  if (typeof piece === 'string' && piece.length > 0) return { locator: requireCommP('payload piece', piece), gated: true };
  if (typeof fcid === 'string' && fcid.length > 0) return { locator: fcid, gated: false };
  fail('payload needs exactly one locator: piece (encrypted) or fcid (clear)');
}

function validateCommonPayloadExtras(payload: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const name of Object.keys(payload)) {
    if (!allowed.has(name)) fail(`payload key ${JSON.stringify(name)} is not in the ${HAVEN_FORMAT_VERSION} record for this group`);
  }
  if (payload.size !== undefined && (typeof payload.size !== 'number' || !Number.isInteger(payload.size) || payload.size < 0)) {
    fail(`payload size must be a non-negative integer, got ${JSON.stringify(payload.size)}`);
  }
  if (payload.pt_hash !== undefined) {
    if (typeof payload.pt_hash !== 'string' || !HEX64.test(payload.pt_hash)) {
      fail(`payload pt_hash must be a sha256 digest (64 hex, optional 0x), got ${JSON.stringify(payload.pt_hash)}`);
    }
  }
  if (payload.seg !== undefined) {
    if (!isRecord(payload.seg) || typeof payload.seg.segment_index !== 'number' || !Number.isInteger(payload.seg.segment_index)) {
      fail('payload seg must be an object with an integer segment_index');
    }
  }
  if (payload.codecs !== undefined) {
    if (!Array.isArray(payload.codecs) || payload.codecs.some(codec => typeof codec !== 'string')) {
      fail('payload codecs must be an array of strings');
    }
  }
  for (const name of ['vlm', 'vlm_model', 'src', 'creator', 'phash'] as const) {
    if (payload[name] !== undefined && (typeof payload[name] !== 'string' || (payload[name] as string).length === 0)) {
      fail(`payload ${name} must be a non-empty string`);
    }
  }
  if (payload.attn !== undefined && !isRecord(payload.attn)) fail('payload attn must be an object (single attestation or merkle-v2)');
  if (payload.x !== undefined) {
    if (!isRecord(payload.x)) fail('payload x must be a small JSON object');
    const encoded = JSON.stringify(payload.x);
    if (utf8Bytes(encoded) > HAVEN_PAYLOAD_EXTRA_MAX_BYTES) {
      fail(`payload x is ${utf8Bytes(encoded)} bytes, over the ${HAVEN_PAYLOAD_EXTRA_MAX_BYTES}-byte limit`);
    }
  }
}

const FULL_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  'piece', 'fcid', 'gate', 'cid_gate', 'size', 'pt_hash', 'seg', 'codecs',
  'vlm', 'vlm_model', 'src', 'creator', 'phash', 'attn', 'x',
]);

const GENERIC_PAYLOAD_KEYS: ReadonlySet<string> = new Set([...FULL_PAYLOAD_KEYS, 'name', 'ct']);

function finishFull(args: {
  grp: string;
  grpClass: 'video' | 'generic';
  payload: Record<string, unknown>;
  raw: Uint8Array;
  attributes: Record<string, unknown>;
  expiresIn: unknown;
}): HavenNormalizedWrite {
  const { grp, grpClass, payload, attributes } = args;
  // Name/MIME-string placement first, so the error names the rule instead
  // of the generic allowlist below.
  if (grpClass === 'generic') {
    if (typeof payload.name !== 'string' || payload.name.length === 0) fail(`payload name is required for ${grp} (restores the file name on download)`);
  } else {
    if (payload.name !== undefined) fail(`payload name is generic-file only (video records carry the title attribute instead)`);
    if (payload.ct !== undefined) fail('payload ct is generic-file only (video records omit mime when the enum has no code)');
  }
  if (payload.ct !== undefined && (typeof payload.ct !== 'string' || !payload.ct.includes('/'))) {
    fail(`payload ct must be a MIME string, got ${JSON.stringify(payload.ct)}`);
  }
  const allowedPayload = grpClass === 'video' ? FULL_PAYLOAD_KEYS : GENERIC_PAYLOAD_KEYS;
  validateCommonPayloadExtras(payload, allowedPayload);
  const { gated } = requireLocator(payload);

  let gate: GateJson | null = null;
  if (gated) {
    if (payload.gate === undefined) fail('encrypted payload (piece) requires the gate JSON string');
    gate = parseGateJson('payload gate', payload.gate);
  } else {
    if (payload.gate !== undefined || payload.cid_gate !== undefined) {
      fail('clear payload (fcid) must not carry gate or cid_gate');
    }
  }
  if (payload.cid_gate !== undefined) {
    if (!gated) fail('clear payload (fcid) must not carry cid_gate');
    parseGateJson('payload cid_gate', payload.cid_gate);
  }

  const normalized: Record<string, unknown> = { grp };
  normalized.title = requireStr128('title', attributes.title);

  if (gated && gate !== null) {
    const gateType = requireI32('gate_type', attributes.gate_type);
    if (gateType !== 1 && gateType !== 3) fail(`gate_type must be 1|3 for ${grp} (v4 drips live under haven.video.drip.*), got ${gateType}`);
    if (gate.version !== gateType) fail(`gate_type (${gateType}) != gate.version (${gate.version}) — they must agree numerically`);
    normalized.gate_type = gateType;
    const token = requireTokenAddress('gate_token', attributes.gate_token);
    if (gate.tokenAddress.toLowerCase() !== token) {
      fail(`gate_token (${token}) != gate.tokenAddress (${gate.tokenAddress.toLowerCase()})`);
    }
    normalized.gate_token = token;
    const chainId = requireI32('gate_chain', attributes.gate_chain);
    const wantChain = CHAIN_VARIANT_TO_EIP155[gate.chain];
    if (wantChain === undefined) fail(`gate chain variant ${JSON.stringify(gate.chain)} has no EIP-155 mapping`);
    if (chainId !== wantChain) fail(`gate_chain (${chainId}) != EIP-155 id of gate.chain (${JSON.stringify(gate.chain)} → ${wantChain})`);
    if (chainId <= 0) fail(`gate_chain must be a positive EIP-155 id, got ${chainId}`);
    normalized.gate_chain = chainId;
    const threshold = requireThreshold('gate_threshold', attributes.gate_threshold);
    if (threshold !== gateThresholdValue('payload gate', gate.threshold)) {
      fail(`gate_threshold (${threshold}) != gate.threshold (${JSON.stringify(gate.threshold)})`);
    }
    normalized.gate_threshold = u256(threshold);
    if (gateType === 3) {
      if (attributes.gate_epoch === undefined) fail('gate_epoch is required for v3 (epoch corpus grouping)');
      const attrEpoch = requireNonNegativeI32('gate_epoch', attributes.gate_epoch);
      if (attrEpoch !== gate.epoch) fail(`gate_epoch (${attrEpoch}) != gate.epoch (${String(gate.epoch)})`);
      normalized.gate_epoch = attrEpoch;
    } else if (attributes.gate_epoch !== undefined) {
      fail('gate_epoch is v3 only (v1 records must not carry it)');
    }
  } else {
    for (const name of ['gate_type', 'gate_token', 'gate_chain', 'gate_threshold', 'gate_epoch'] as const) {
      if (attributes[name] !== undefined) fail(`clear payload (fcid) must not carry ${name} (no gate, no gate corpus)`);
    }
  }

  normalized.sha256_ct = requireSha256Ct('sha256_ct', attributes.sha256_ct);

  if (attributes.mime !== undefined) {
    const mime = requireI32('mime', attributes.mime);
    if (mime < 0 || mime > MIME_ENUM_MAX) fail(`mime must be 0..${MIME_ENUM_MAX} (0 = unknown), got ${mime}`);
    normalized.mime = mime;
    if (payload.ct !== undefined) fail('payload ct and the mime attribute are exclusive (ct only when the MIME has no enum code)');
  } else if (grpClass === 'generic' && payload.ct === undefined) {
    // Allowed: MIME unknown entirely (the reference implementation emits neither when the MIME
    // string itself is empty). Nothing to normalize.
  }

  if (attributes.dur_s !== undefined) {
    if (grpClass !== 'video') fail(`dur_s is video-only (generic groups carry the full attribute set minus dur_s)`);
    normalized.dur_s = requireNonNegativeI32('dur_s', attributes.dur_s);
  }

  const allowedAttrs = gated
    ? ['grp', 'title', 'gate_type', 'gate_token', 'gate_chain', 'gate_threshold', 'gate_epoch', 'sha256_ct', 'mime', 'dur_s']
    : ['grp', 'title', 'sha256_ct', 'mime', 'dur_s'];
  for (const name of Object.keys(attributes)) {
    if (!allowedAttrs.includes(name)) fail(`attribute ${JSON.stringify(name)} is not in the ${HAVEN_FORMAT_VERSION} ${grp} record`);
  }

  return {
    grpClass,
    grp,
    attributes: normalized,
    payload: args.raw,
    contentType: HAVEN_CONTENT_TYPE,
    expiresIn: resolveExpiresIn(grpClass, args.expiresIn),
  };
}

const SERIES_ATTRS = ['grp', 'title', 'gate_type', 'gate_token', 'gate_chain', 'gate_threshold', 'drip_id', 'drip_total'] as const;

function finishSeries(args: {
  grp: string;
  payload: Record<string, unknown>;
  raw: Uint8Array;
  attributes: Record<string, unknown>;
  expiresIn: unknown;
}): HavenNormalizedWrite {
  const { grp, payload, attributes } = args;
  for (const name of Object.keys(payload)) {
    if (name !== 'targets' && name !== 'creator' && name !== 'mime') {
      fail(`series payload carries ${JSON.stringify(name)} — series payload is { targets, creator?, mime? }`);
    }
  }
  if (!Array.isArray(payload.targets) || payload.targets.length === 0) {
    fail('series payload targets must be a non-empty array of whole-USD per-stage targets');
  }
  for (const target of payload.targets) {
    if (typeof target !== 'number' || !Number.isInteger(target) || target < 0) {
      fail(`series target must be a non-negative integer (whole USD), got ${JSON.stringify(target)}`);
    }
  }
  if (payload.creator !== undefined && typeof payload.creator !== 'string') fail('series payload creator must be a handle string');
  if (payload.mime !== undefined) {
    if (typeof payload.mime !== 'number' || !Number.isInteger(payload.mime) || payload.mime < 0 || payload.mime > MIME_ENUM_MAX) {
      fail(`series payload mime must be 0..${MIME_ENUM_MAX}, got ${JSON.stringify(payload.mime)}`);
    }
  }

  for (const name of Object.keys(attributes)) {
    if (!(SERIES_ATTRS as readonly string[]).includes(name)) fail(`attribute ${JSON.stringify(name)} is not in the ${HAVEN_FORMAT_VERSION} drip series record`);
  }
  const gateType = requireI32('gate_type', attributes.gate_type);
  if (gateType !== 4) fail(`gate_type must be 4 for ${grp}, got ${gateType}`);
  const dripTotal = requireI32('drip_total', attributes.drip_total);
  if (dripTotal < 1) fail(`drip_total must be >= 1, got ${dripTotal}`);
  if ((payload.targets as unknown[]).length !== dripTotal) {
    fail(`drip_total (${dripTotal}) != targets.length (${(payload.targets as unknown[]).length})`);
  }
  const chainId = requireI32('gate_chain', attributes.gate_chain);
  if (chainId <= 0) fail(`gate_chain must be a positive EIP-155 id, got ${chainId}`);

  // Drip wire is spec-tagged (dapp publisher): addr / i32 / str.
  const normalized: Record<string, unknown> = {
    grp: str(grp),
    title: str(requireStr128('title', attributes.title)),
    gate_type: i32(gateType),
    gate_token: addr(requireTokenAddress('gate_token', attributes.gate_token)),
    gate_chain: i32(chainId),
    gate_threshold: u256(requireThreshold('gate_threshold', attributes.gate_threshold)),
    drip_id: str(requireStr128('drip_id', attributes.drip_id)),
    drip_total: i32(dripTotal),
  };
  return {
    grpClass: 'series',
    grp,
    attributes: normalized,
    payload: args.raw,
    contentType: HAVEN_CONTENT_TYPE,
    expiresIn: resolveExpiresIn('series', args.expiresIn),
  };
}

const PART_ATTRS = ['grp', 'gate_type', 'drip_id', 'drip_idx', 'series_ref', 'mcap_usd', 'sha256_ct'] as const;

function finishPart(args: {
  grp: string;
  payload: Record<string, unknown>;
  raw: Uint8Array;
  attributes: Record<string, unknown>;
  expiresIn: unknown;
}): HavenNormalizedWrite {
  const { grp, payload, attributes } = args;
  for (const name of Object.keys(payload)) {
    if (name !== 'piece' && name !== 'gate') fail(`part payload carries ${JSON.stringify(name)} — part payload is exactly { piece, gate }`);
  }
  if (typeof payload.piece !== 'string' || payload.piece.length === 0) fail('part payload piece must be the ciphertext locator CID');
  requireCommP('part payload piece', payload.piece);
  if (payload.gate === undefined) fail('part payload requires the v4 gate JSON string');
  const gate = parseGateJson('payload gate', payload.gate);
  if (gate.version !== 4) fail(`part gate.version must be 4, got ${gate.version}`);
  // Parts are always gated bytes: a threshold-0 part gate is free content
  // burned through encryption, which the canister rejects.
  gateThresholdValue('payload gate', gate.threshold);

  for (const name of Object.keys(attributes)) {
    if (!(PART_ATTRS as readonly string[]).includes(name)) {
      const hint = name === 'title' ? ' (join the series once for the title)' : name === 'gate_token' ? ' (the full corpus triple lives on the series)' : '';
      fail(`attribute ${JSON.stringify(name)} is not in the ${HAVEN_FORMAT_VERSION} drip part record${hint}`);
    }
  }
  const gateType = requireI32('gate_type', attributes.gate_type);
  if (gateType !== 4) fail(`gate_type must be 4 for ${grp}, got ${gateType}`);

  const normalized: Record<string, unknown> = {
    grp: str(grp),
    gate_type: i32(gateType),
    drip_id: str(requireStr128('drip_id', attributes.drip_id)),
    drip_idx: i32(requireNonNegativeI32('drip_idx', attributes.drip_idx)),
    series_ref: key(requireEntityKey('series_ref', attributes.series_ref) as `0x${string}`),
    mcap_usd: i32(requireNonNegativeI32('mcap_usd', attributes.mcap_usd)),
    sha256_ct: bytes32(`0x${requireSha256Ct('sha256_ct', attributes.sha256_ct)}` as `0x${string}`),
  };
  return {
    grpClass: 'part',
    grp,
    attributes: normalized,
    payload: args.raw,
    contentType: HAVEN_CONTENT_TYPE,
    expiresIn: resolveExpiresIn('part', args.expiresIn),
  };
}

/**
 * Normalize a query filter to the wire types it will be compared against.
 * Reads stay lenient (old rows may carry deleted keys), but known keys are
 * normalized so lookups hit: hex lowercased, `series_ref` wrapped as `key`,
 * drip-part `sha256_ct` wrapped as `bytes32`. Numeric facts passed as
 * strings are rejected — a `str` filter never matches an `i32` cell, so a
 * silent miss is worse than an error.
 */
export function normalizeHavenWhere(where: Record<string, unknown> | undefined): Record<string, unknown> {
  if (where === undefined) return {};
  if (!isRecord(where)) fail('query filter must be an object');
  const normalized: Record<string, unknown> = {};
  const grp = where.grp;
  const dripPartScope = grp === HAVEN_GROUPS.dripPart;
  for (const [name, value] of Object.entries(where)) {
    if (QUERY_SYSTEM_ATTRS.has(name)) {
      normalized[name] = value;
      continue;
    }
    validateAttrName(name);
    // Already-tagged SDK values pass through untouched.
    if (isRecord(value) && typeof value.type === 'string' && 'value' in value) {
      normalized[name] = value;
      continue;
    }
    switch (name) {
      case 'gate_token':
        normalized[name] = typeof value === 'string' && HEX40.test(value) ? value.toLowerCase() : value;
        break;
      case 'sha256_ct':
        if (typeof value === 'string' && HEX64.test(value)) {
          const bare = value.toLowerCase().replace(/^0x/, '');
          normalized[name] = dripPartScope ? bytes32(`0x${bare}`) : bare;
        } else {
          normalized[name] = value;
        }
        break;
      case 'series_ref':
        normalized[name] = typeof value === 'string' && HEX64.test(value)
          ? key((value.toLowerCase().startsWith('0x') ? value.toLowerCase() : `0x${value.toLowerCase()}`) as `0x${string}`)
          : value;
        break;
      case 'gate_threshold':
        // Threshold cells are u256 (v2.3.0): tag the filter so type-exact
        // matching hits them. Strings stay exact past 2**53.
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
          normalized[name] = u256(BigInt(value));
        } else if (typeof value === 'string' && /^\d+$/.test(value) && BigInt(value) <= U256_MAX) {
          normalized[name] = u256(BigInt(value));
        } else {
          fail(`query filter ${name} must be a u256 amount (safe-integer number or decimal string), got ${JSON.stringify(value)}`);
        }
        break;
      case 'gate_type':
      case 'gate_chain':
      case 'gate_epoch':
      case 'mime':
      case 'dur_s':
      case 'drip_total':
      case 'drip_idx':
      case 'mcap_usd':
        if (typeof value === 'string') {
          fail(`query filter ${name} must be a number (i32 cells never match a str filter), got ${JSON.stringify(value)}`);
        }
        normalized[name] = value;
        break;
      default:
        normalized[name] = value;
        break;
    }
  }
  return normalized;
}
