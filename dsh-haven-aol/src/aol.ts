/**
 * AolRuntime — Haven-AOL token-gated decrypt over the `haven-aol` TS SDK
 * and the ICP backend canister.
 *
 * Sourcing rules (do not break):
 * - Pure protocol (derivation preimages, epoch, metadata build/parse,
 *   EIP-712 typed-data builders) comes from the `haven-aol` SDK verbatim.
 *   Those symbols are fixture-pinned byte-for-byte across Motoko / Python /
 *   TypeScript (tests/fixtures/derivation-{v3,v4}-vectors.json) — never
 *   re-derive them here.
 * - v1 canister calls go through the SDK's own wrappers (`canister.ts`).
 * - v3/v4 canister calls are vendored here following the SDK's IDL-factory
 *   pattern exactly; record shapes are copied from
 *   `src/backend/backend.did` (GateRequestV3, GateRequestV4) including the
 *   full GateError variant (InvalidEpoch, MarketCapNotReached, InvalidOracle).
 *   Upstream these to the SDK when convenient; until then they live here.
 *   The seal path vendors one more query the SDK lacks,
 *   `getVetKDPublicKeyV3` (backend.did: `() -> (blob) query`), for the
 *   same reason.
 * - Seal-side (encrypt) primitives live in `./seal.ts`: the v1 metadata
 *   builder is ported from Python `core.py` (the TS SDK never grew one);
 *   v3/v4 builders, derivation inputs, and AES/IBE wire formats stay
 *   SDK-verbatim. The IBE wrap always uses the canister-fetched
 *   verification key, never a locally derived guess.
 * - The single signature in every flow (EIP-712 gate request) goes through
 *   the signGate seam. Default is fail-loud (AolSigningError): ctx.wallet
 *   signs EIP-191 and the canister needs a raw EIP-712 digest signature.
 *
 * @module dsh-haven-aol/aol
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  Actor,
  HttpAgent,
  AnonymousIdentity,
  type ActorMethod,
  type ActorSubclass,
} from '@icp-sdk/core/agent'
import { IDL } from '@icp-sdk/core/candid'
import { TypedDataEncoder } from 'ethers'
import {
  parseGateMetadataAny,
  parseGateMetadata,
  parseGateMetadataV3,
  // NOTE: parseGateMetadataAny dispatches v1/v3 only (SDK metadata.ts) —
  // v4 is parsed explicitly in gateInfo(). Both are SDK-verbatim parsers.
  parseGateMetadataV4,
  isBondAddress,
  currentEpoch,
  EPOCH_LENGTH_SECONDS,
  computeDerivationInput,
  computeDerivationInputV3,
  computeDerivationInputV4,
  buildGateMetadataV3,
  gateMetadataV3ToJson,
  buildGateMetadataV4,
  gateMetadataV4ToJson,
  buildGateRequestTypedData,
  buildGateRequestV3TypedData,
  buildGateRequestV4TypedData,
  parseSignatureHex,
  createTransportKeyPair,
  recoverVetKey,
  ibeDecryptAesKey,
  decryptFile,
  requestDecryptionKey,
  fetchVerificationKey,
  fetchVerificationKeyV4,
  HavenAolError,
  type Chain,
} from 'haven-aol'
import type { VetKey } from '@icp-sdk/vetkeys'
import { AolSigningError } from './types.ts'
import {
  EpochAesKeyCache,
  VetKeyCache,
  vetKeySlot,
} from './keyCache.ts'
import { loadKeyStore, saveKeyStore } from './keyStore.ts'
import {
  buildGateMetadataV1,
  gateMetadataV1ToJson,
  encryptFileAesGcm,
  freshAesKey,
  ibeEncryptAesKey,
} from './seal.ts'

export { HavenAolError }
export type { Chain }

/** Sign a 32-byte EIP-712 digest (0x hex) → 65-byte signature (0x hex). */
export type SignGate = (digestHex: `0x${string}`) => Promise<`0x${string}`>

/** Test seam: stub canister request fns without network. */
export const internals: {
  requestV1: typeof requestDecryptionKey | undefined
  requestV3: RequestV3Fn | undefined
  requestV4: RequestV4Fn | undefined
  marketCap: MarketCapFn | undefined
  dpk: ((version: 1 | 3 | 4) => Promise<Uint8Array>) | undefined
} = { requestV1: undefined, requestV3: undefined, requestV4: undefined, marketCap: undefined, dpk: undefined }

// ── Vendored v3/v4 IDL (backend.did GateRequestV3/GateRequestV4 + full GateError) ──
// Mirrors the SDK's canister.ts factory style. Candid field order matches the
// .did record order; blob ↔ Uint8Array; nat ↔ bigint.

const ChainVariant = IDL.Variant({
  EthMainnet: IDL.Null,
  EthSepolia: IDL.Null,
  ArbitrumOne: IDL.Null,
  BaseMainnet: IDL.Null,
  OptimismMainnet: IDL.Null,
})

const FullGateErrorVariant = IDL.Variant({
  InsufficientBalance: IDL.Record({ required: IDL.Nat, actual: IDL.Nat }),
  InvalidAddress: IDL.Text,
  InvalidThreshold: IDL.Null,
  EvmRpcError: IDL.Text,
  VetKDError: IDL.Text,
  InvalidSignature: IDL.Text,
  NonceAlreadyUsed: IDL.Null,
  InvalidEpoch: IDL.Null,
  MarketCapNotReached: IDL.Record({ required: IDL.Nat, actual: IDL.Nat }),
  InvalidOracle: IDL.Text,
})

const GateResultVariant = IDL.Variant({
  ok: IDL.Record({
    encrypted_key: IDL.Vec(IDL.Nat8),
    verification_key: IDL.Vec(IDL.Nat8),
  }),
  err: FullGateErrorVariant,
})

const GateRequestV3Type = IDL.Record({
  chain: ChainVariant,
  tokenAddress: IDL.Text,
  threshold: IDL.Nat,
  epoch: IDL.Nat,
  evmAddress: IDL.Text,
  transportPublicKey: IDL.Vec(IDL.Nat8),
  nonce: IDL.Nat,
  signature: IDL.Vec(IDL.Nat8),
  eip712ChainId: IDL.Nat,
  eip712VerifyingContract: IDL.Text,
})

const GateRequestV4Type = IDL.Record({
  chain: ChainVariant,
  tokenAddress: IDL.Text,
  threshold: IDL.Nat,
  epoch: IDL.Nat,
  marketCapTarget: IDL.Nat,
  oracleAddress: IDL.Text,
  evmAddress: IDL.Text,
  transportPublicKey: IDL.Vec(IDL.Nat8),
  nonce: IDL.Nat,
  signature: IDL.Vec(IDL.Nat8),
  eip712ChainId: IDL.Nat,
  eip712VerifyingContract: IDL.Text,
})

const MarketCapResultVariant = IDL.Variant({ ok: IDL.Nat, err: IDL.Text })

interface AolV3V4Actor {
  requestDecryptionKeyV3: ActorMethod<[Record<string, unknown>], { ok: { encrypted_key: Uint8Array | number[]; verification_key: Uint8Array | number[] } } | { err: unknown }>
  requestDecryptionKeyV4: ActorMethod<[Record<string, unknown>], { ok: { encrypted_key: Uint8Array | number[]; verification_key: Uint8Array | number[] } } | { err: unknown }>
  getMarketCap: ActorMethod<[Record<string, null>, string, string], { ok: bigint } | { err: string }>
  /** Vendored: the SDK exposes v1/v4 DPK queries but no v3 one. backend.did: `() -> (blob) query`. */
  getVetKDPublicKeyV3: ActorMethod<[], Uint8Array | number[]>
}

const idlFactoryV3V4 = () =>
  IDL.Service({
    requestDecryptionKeyV3: IDL.Func([GateRequestV3Type], [GateResultVariant], []),
    requestDecryptionKeyV4: IDL.Func([GateRequestV4Type], [GateResultVariant], []),
    getMarketCap: IDL.Func([ChainVariant, IDL.Text, IDL.Text], [MarketCapResultVariant], []),
    getVetKDPublicKeyV3: IDL.Func([], [IDL.Vec(IDL.Nat8)], ['query']),
  })

const actorCache = new WeakMap<HttpAgent, Map<string, ActorSubclass<AolV3V4Actor>>>()

function getActor(agent: HttpAgent, canisterId: string): ActorSubclass<AolV3V4Actor> {
  let byCanister = actorCache.get(agent)
  if (!byCanister) {
    byCanister = new Map()
    actorCache.set(agent, byCanister)
  }
  let actor = byCanister.get(canisterId)
  if (!actor) {
    actor = Actor.createActor<AolV3V4Actor>(idlFactoryV3V4, { agent, canisterId })
    byCanister.set(canisterId, actor)
  }
  return actor
}

export interface GateKeyMaterial {
  encryptedKey: Uint8Array
  verificationKey: Uint8Array
}

export type RequestV3Fn = (
  agent: HttpAgent,
  canisterId: string,
  request: {
    chain: Chain; tokenAddress: string; threshold: bigint; epoch: bigint
    evmAddress: string; transportPublicKey: Uint8Array; nonce: bigint
    signature: Uint8Array; eip712ChainId: bigint; eip712VerifyingContract: string
  },
) => Promise<{ ok: GateKeyMaterial } | { err: unknown }>

export type RequestV4Fn = (
  agent: HttpAgent,
  canisterId: string,
  request: {
    chain: Chain; tokenAddress: string; threshold: bigint; epoch: bigint
    marketCapTarget: bigint; oracleAddress: string
    evmAddress: string; transportPublicKey: Uint8Array; nonce: bigint
    signature: Uint8Array; eip712ChainId: bigint; eip712VerifyingContract: string
  },
) => Promise<{ ok: GateKeyMaterial } | { err: unknown }>

export type MarketCapFn = (
  agent: HttpAgent,
  canisterId: string,
  chain: Chain,
  tokenAddress: string,
  oracleAddress: string,
) => Promise<{ ok: bigint } | { err: string }>

function chainRecord(chain: Chain): Record<string, null> {
  return { [chain]: null }
}

async function liveRequestV3(
  agent: HttpAgent,
  canisterId: string,
  request: Parameters<RequestV3Fn>[2],
): Promise<{ ok: GateKeyMaterial } | { err: unknown }> {
  const actor = getActor(agent, canisterId)
  const raw = await actor.requestDecryptionKeyV3({
    chain: chainRecord(request.chain),
    tokenAddress: request.tokenAddress,
    threshold: request.threshold,
    epoch: request.epoch,
    evmAddress: request.evmAddress,
    transportPublicKey: request.transportPublicKey,
    nonce: request.nonce,
    signature: request.signature,
    eip712ChainId: request.eip712ChainId,
    eip712VerifyingContract: request.eip712VerifyingContract,
  })
  if ('ok' in raw) {
    return {
      ok: {
        encryptedKey: new Uint8Array(raw.ok.encrypted_key),
        verificationKey: new Uint8Array(raw.ok.verification_key),
      },
    }
  }
  return { err: (raw as { err: unknown }).err }
}

async function liveRequestV4(
  agent: HttpAgent,
  canisterId: string,
  request: Parameters<RequestV4Fn>[2],
): Promise<{ ok: GateKeyMaterial } | { err: unknown }> {
  const actor = getActor(agent, canisterId)
  const raw = await actor.requestDecryptionKeyV4({
    chain: chainRecord(request.chain),
    tokenAddress: request.tokenAddress,
    threshold: request.threshold,
    epoch: request.epoch,
    marketCapTarget: request.marketCapTarget,
    oracleAddress: request.oracleAddress,
    evmAddress: request.evmAddress,
    transportPublicKey: request.transportPublicKey,
    nonce: request.nonce,
    signature: request.signature,
    eip712ChainId: request.eip712ChainId,
    eip712VerifyingContract: request.eip712VerifyingContract,
  })
  if ('ok' in raw) {
    return {
      ok: {
        encryptedKey: new Uint8Array(raw.ok.encrypted_key),
        verificationKey: new Uint8Array(raw.ok.verification_key),
      },
    }
  }
  return { err: (raw as { err: unknown }).err }
}

async function liveMarketCap(
  agent: HttpAgent,
  canisterId: string,
  chain: Chain,
  tokenAddress: string,
  oracleAddress: string,
): Promise<{ ok: bigint } | { err: string }> {
  const actor = getActor(agent, canisterId)
  const raw = await actor.getMarketCap(chainRecord(chain), tokenAddress, oracleAddress)
  if ('ok' in raw) return { ok: BigInt((raw as { ok: bigint }).ok) }
  return { err: String((raw as { err: string }).err) }
}

/** Vendored v3 verification-key query (free query, like the SDK's v1/v4 ones). */
async function liveDpkV3(agent: HttpAgent, canisterId: string): Promise<Uint8Array> {
  const actor = getActor(agent, canisterId)
  return new Uint8Array(await actor.getVetKDPublicKeyV3())
}

// ── Digest + nonce helpers ──────────────────────────────────────────

/** EIP-712 digest for an SDK-built typed-data payload (ethers, like eth_account). */
function typedDigest(typed: {
  domain: { name: string; chainId: bigint; verifyingContract: string }
  types: Record<string, Array<{ name: string; type: string }>>
  message: Record<string, unknown>
}): `0x${string}` {
  const { EIP712Domain: _omit, ...types } = typed.types
  return TypedDataEncoder.hash(
    typed.domain as never,
    types as never,
    typed.message as never,
  ) as `0x${string}`
}

/** Fresh 256-bit single-use nonce (canister rejects replays). */
export function freshNonce(): bigint {
  return BigInt('0x' + randomBytes(32).toString('hex'))
}

/**
 * Stage-aware unwrap: vetkeys throws bare 'Decryption failed' from three
 * different local stages (transport unwrap inside recoverVetKey, IBE epoch-key
 * open, file AES-GCM open). Name the stage and keep the cause, or a holder
 * misdiagnoses crypto failures as balance denials.
 */
function unwrapStage<T>(stage: string, fn: () => T): T {
  try {
    return fn()
  } catch (e: unknown) {
    const cause = e instanceof Error ? e.message : String(e)
    throw new Error(`dsh-haven-aol: ${stage} failed (${cause})`)
  }
}

async function unwrapStageAsync<T>(stage: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e: unknown) {
    const cause = e instanceof Error ? e.message : String(e)
    throw new Error(`dsh-haven-aol: ${stage} failed (${cause})`)
  }
}

/** Chain variant → EIP-155 id (mirrors dsh-arkiv's reference table). */
const CHAIN_VARIANT_TO_EIP155: Readonly<Record<string, number>> = {
  EthMainnet: 1,
  EthSepolia: 11155111,
  ArbitrumOne: 42161,
  BaseMainnet: 8453,
  OptimismMainnet: 10,
}

/** Zero verifier: the mobile/dapp EIP-712 default (canister rebuilds the separator from request values). */
const ZERO_VERIFIER = '0x0000000000000000000000000000000000000000'

export interface AolRuntimeOpts {
  canisterId: string
  icpHost: string
  fetchRootKey: boolean
  eip712ChainId?: bigint
  eip712VerifyingContract?: string
  /** Raw-digest signer. Unset → every gated call throws AolSigningError (fail-loud). */
  signGate?: SignGate
  /**
   * Durable key file (versioned JSON, 0600, atomic writes). Set →
   * epoch/vetKeys load once on first use and every fill persists
   * (merge-on-save across runtimes); unset → memory-only.
   */
  keyStorePath?: string
}

export interface GateCallCommon {
  evmAddress: string
  eip712ChainId: bigint
  eip712VerifyingContract: string
  nonce?: bigint
}

/** Parsed gate summary (all versions). */
export interface GateSummary {
  version: 1 | 3 | 4
  cid: string
  chain: Chain
  tokenAddress: string
  threshold: string
  epoch?: number
  marketCapTarget?: number
  oracleAddress?: string
  bondPinned?: boolean
}

/** Seal inputs: one file plus its gate policy. */
export interface SealParams {
  version: 1 | 3 | 4
  /** Gate CID. Unknown pre-upload → `sha256:<hex-of-plaintext>`. */
  cid: string
  chain: Chain
  tokenAddress: string
  /** Minimum balance in smallest token units. */
  threshold: bigint
  /** v3/v4 epoch (default: current; forced 0 when threshold is 0). */
  epoch?: number
  /** v4 unlock rung in whole reserve units (required for v4). */
  marketCapTarget?: bigint
  /** v4 oracle (required for v4; must be the chain Bond contract). */
  oracleAddress?: string
  plaintext: Uint8Array
}

/** Seal outputs: sealed bytes plus gate metadata. */
export interface SealResult {
  sealedBytes: Uint8Array
  gateMetadataJson: string
  version: 1 | 3 | 4
  /**
   * SHA-256 of the AES content key: proves which key sealed a file
   * without revealing it. A bucket commitment for v3 (stable across the
   * epoch), per-seal for v1/v4.
   */
  keySha256: string
}

export class AolRuntime {
  /** Verification keys by version (canister constants per key_id+context; cached per runtime). */
  private readonly dpkCache = new Map<1 | 3 | 4, Uint8Array>()
  /**
   * v3 seal-side epoch keys: one AES key + wrapped blob per
   * (chain, token, threshold, epoch) bucket. Memory-first; a
   * configured keyStorePath also keeps them across restarts.
   */
  readonly epochKeys = new EpochAesKeyCache()
  /**
   * Decrypt-side recovered vetKeys by derivation input: one signed gate
   * round-trip per bucket, then local unwraps. Same custody as above.
   */
  readonly vetKeys = new VetKeyCache()
  /** Single-flight key-store load (first seal/decrypt only). */
  private keyStoreLoad: Promise<void> | undefined
  /** Chained key-store saves (each save snapshots current maps). */
  private saveChain: Promise<void> = Promise.resolve()
  /** Cache sizes at the last save: memory hits skip the rewrite. */
  private savedSizes = { epochs: 0, vetKeys: 0 }

  constructor(private readonly opts: AolRuntimeOpts) {
    if (!opts.canisterId || !opts.icpHost) throw new Error('dsh-haven-aol: canisterId+icpHost required')
  }

  /**
   * Load the key store once (no-op without keyStorePath or when
   * already loaded). Best-effort — failures start empty, never throw.
   */
  private ensureKeyStore(): Promise<void> {
    const path = this.opts.keyStorePath
    if (path === undefined || path === '') return Promise.resolve()
    if (this.keyStoreLoad === undefined) {
      this.keyStoreLoad = (async () => {
        await loadKeyStore(path, this.epochKeys, this.vetKeys)
        this.savedSizes = { epochs: this.epochKeys.size, vetKeys: this.vetKeys.size }
      })()
    }
    return this.keyStoreLoad
  }

  /**
   * Persist both caches when they grew since the last save, and wait
   * for the write — callers return only once the fill is durable.
   * Chained so concurrent fills serialize; best-effort, never throws.
   * No-op without keyStorePath; memory hits skip with no IO at all.
   */
  private async persistKeys(): Promise<void> {
    const path = this.opts.keyStorePath
    if (path === undefined || path === '') return
    if (this.epochKeys.size === this.savedSizes.epochs && this.vetKeys.size === this.savedSizes.vetKeys) return
    this.saveChain = this.saveChain.then(async () => {
      await saveKeyStore(path, this.epochKeys, this.vetKeys)
      this.savedSizes = { epochs: this.epochKeys.size, vetKeys: this.vetKeys.size }
    })
    await this.saveChain
  }

  /**
   * Flush both caches to the key store now (waits for the write).
   * Covers direct cache installs, which bypass the seal/decrypt save
   * hooks. No-op without keyStorePath; failures log, never throw.
   */
  async flushKeys(): Promise<void> {
    const path = this.opts.keyStorePath
    if (path === undefined || path === '') return
    await this.ensureKeyStore()
    await this.persistKeys()
  }

  /**
   * vetKey fetch that loads the store first and persists fills (the
   * single choke point for all three decrypt paths).
   */
  private async cachedVetKey(slot: string, fetcher: () => Promise<VetKey>): Promise<VetKey> {
    await this.ensureKeyStore()
    const hit = await this.vetKeys.getOrFetch(slot, fetcher)
    await this.persistKeys()
    return hit
  }

  /** Current 30-day epoch (advisory — canister is authoritative, rejects future epochs). */
  epoch(): { epoch: number; epochLengthSeconds: number; nextRolloverUnix: number } {
    const epoch = currentEpoch()
    return { epoch, epochLengthSeconds: EPOCH_LENGTH_SECONDS, nextRolloverUnix: (epoch + 1) * EPOCH_LENGTH_SECONDS }
  }

  /** Parse any-version gate metadata into a model-readable summary. Pure, no IO. */
  gateInfo(gateMetadataJson: string): GateSummary {
    const meta = (parseGateMetadataAny(gateMetadataJson) ?? parseGateMetadataV4(gateMetadataJson)) as unknown as
      | { version: 1; cid: string; chain: Chain; tokenAddress: string; threshold: bigint; encryptedAesKey: string }
      | { version: 3; cid: string; chain: Chain; tokenAddress: string; threshold: string; epoch: number; encryptedAesKey: string }
      | { version: 4; cid: string; chain: Chain; tokenAddress: string; threshold: string; epoch: number; marketCapTarget: number; oracleAddress: string; encryptedAesKey: string }
      | null
    if (!meta) throw new Error('dsh-haven-aol: unparsable gate metadata (not v1/v3/v4)')
    const base = {
      cid: meta.cid,
      chain: meta.chain,
      tokenAddress: meta.tokenAddress,
      threshold: String(meta.threshold),
    }
    if (meta.version === 1) return { version: 1, ...base }
    if (meta.version === 3) return { version: 3, ...base, epoch: meta.epoch }
    return {
      version: 4,
      ...base,
      epoch: meta.epoch,
      marketCapTarget: meta.marketCapTarget,
      oracleAddress: meta.oracleAddress,
      bondPinned: isBondAddress(meta.chain, meta.oracleAddress),
    }
  }

  /** Live market cap in whole reserve units (v4 diagnostic; 300s canister burst cache). */
  async marketCap(chain: Chain, tokenAddress: string, oracleAddress: string): Promise<{ capReserveUnits: string; bondPinned: boolean }> {
    if (!isBondAddress(chain, oracleAddress)) {
      throw new Error(
        `dsh-haven-aol: oracleAddress ${oracleAddress} is not the ${chain} Bond contract — `
        + 'the canister fails closed on non-Bond oracles. Refusing before touching the chain.',
      )
    }
    const agent = await this.agent()
    const fn = internals.marketCap ?? liveMarketCap
    const res = await fn(agent, this.opts.canisterId, chain, tokenAddress, oracleAddress)
    if ('err' in res) throw new Error(`dsh-haven-aol: getMarketCap failed: ${res.err}`)
    return { capReserveUnits: res.ok.toString(), bondPinned: true }
  }

  private async agent(): Promise<HttpAgent> {
    const agent = await HttpAgent.create({ host: this.opts.icpHost, identity: new AnonymousIdentity() })
    if (this.opts.fetchRootKey) await agent.fetchRootKey()
    return agent
  }

  private async signOrThrow(digestHex: `0x${string}`): Promise<Uint8Array> {
    if (!this.opts.signGate) {
      throw new AolSigningError(
        'dsh-haven-aol: EIP-712 gate signing is unwired. ctx.wallet.signMessage is EIP-191 '
        + '(personal prefix); the canister verifies ecrecover over the raw EIP-712 digest, so a '
        + 'personal-prefixed signature is rejected with #InvalidSignature. Resolve the OWS '
        + 'encoding spike (README) then inject signGate. No signature was produced.',
      )
    }
    return parseSignatureHex(await this.opts.signGate(digestHex))
  }

  private gateDefaults(
    common: Partial<Pick<GateCallCommon, 'eip712ChainId' | 'eip712VerifyingContract'>>,
    chainVariant?: string,
  ): {
    eip712ChainId: bigint
    eip712VerifyingContract: string
  } {
    // Precedence: per-call > config > gate's own chain + zero verifier (the
    // mobile/dapp default — the canister rebuilds the separator from the
    // request values, so self-consistency is what matters, and the gate's
    // chain commits the signature to the chain actually checked).
    const chainId = common.eip712ChainId ?? this.opts.eip712ChainId
      ?? (chainVariant !== undefined ? CHAIN_VARIANT_TO_EIP155[chainVariant] : undefined)
    const verifier = common.eip712VerifyingContract ?? this.opts.eip712VerifyingContract
      ?? ZERO_VERIFIER
    if (chainId === undefined || !verifier) {
      throw new Error(
        'dsh-haven-aol: eip712ChainId + eip712VerifyingContract required per call or in cordis.patch.yml config',
      )
    }
    return { eip712ChainId: BigInt(chainId), eip712VerifyingContract: verifier }
  }

  /** v1 end-to-end decrypt. The recovered vetKey is cached by derivation input (exact-file repeats skip the gate call); returns plaintext. */
  async decryptV1(params: GateCallCommon & { gateMetadataJson: string; encryptedFileBytes: Uint8Array }): Promise<Uint8Array> {
    const metadata = parseGateMetadata(params.gateMetadataJson)
    const derivationInput = await computeDerivationInput(
      metadata.chain, metadata.tokenAddress, metadata.threshold, metadata.cid)
    const vetKey = await this.cachedVetKey(vetKeySlot(derivationInput), async () => {
      const agent = await this.agent()
      const { secretKey, publicKey } = createTransportKeyPair()
      const nonce = params.nonce ?? freshNonce()
      const { eip712ChainId, eip712VerifyingContract } = this.gateDefaults(params, metadata.chain)
      const typed = buildGateRequestTypedData({
        evmAddress: params.evmAddress, transportPublicKey: publicKey, nonce,
        eip712ChainId, eip712VerifyingContract,
      })
      const signature = await this.signOrThrow(typedDigest(typed))
      const fn = internals.requestV1 ?? requestDecryptionKey
      const result = await fn(agent, this.opts.canisterId, {
        chain: metadata.chain, tokenAddress: metadata.tokenAddress, threshold: metadata.threshold,
        cid: metadata.cid, evmAddress: params.evmAddress, transportPublicKey: publicKey,
        nonce, signature, eip712ChainId, eip712VerifyingContract,
      })
      if ('err' in result) throw new HavenAolError(result.err)
      return unwrapStage('v1 vetKey transport unwrap', () =>
        recoverVetKey(result.ok.encryptedKey, secretKey, result.ok.verificationKey, derivationInput))
    })
    const aesKey = unwrapStage('v1 epoch-key IBE unwrap', () => ibeDecryptAesKey(metadata.encryptedAesKey, vetKey))
    return unwrapStageAsync('v1 file AES-GCM open', () => decryptFile(params.encryptedFileBytes, aesKey))
  }

  /**
   * v3 end-to-end decrypt (corpus+epoch). One signed gate round-trip per
   * bucket, then local unwraps: the vetKey cache keys off the derivation
   * input computed from the gate METADATA epoch (never the wall clock),
   * so old-epoch files stay decryptable past rollover.
   */
  async decryptV3(params: GateCallCommon & { gateMetadataJson: string; encryptedFileBytes: Uint8Array }): Promise<Uint8Array> {
    const { buildGateRequestV3TypedData: buildV3 } = await import('haven-aol')
    const metadata = parseGateMetadataV3(params.gateMetadataJson)
    if (!metadata) throw new Error('dsh-haven-aol: not v3 gate metadata')
    const derivationInput = await computeDerivationInputV3(
      metadata.chain, metadata.tokenAddress, BigInt(metadata.threshold), metadata.epoch)
    const vetKey = await this.cachedVetKey(vetKeySlot(derivationInput), async () => {
      const agent = await this.agent()
      const { secretKey, publicKey } = createTransportKeyPair()
      const nonce = params.nonce ?? freshNonce()
      const { eip712ChainId, eip712VerifyingContract } = this.gateDefaults(params, metadata.chain)
      const typed = buildV3({
        evmAddress: params.evmAddress, transportPublicKey: publicKey, epoch: metadata.epoch, nonce,
        eip712ChainId, eip712VerifyingContract,
      })
      const signature = await this.signOrThrow(typedDigest(typed as never))
      const fn = internals.requestV3 ?? liveRequestV3
      const result = await fn(agent, this.opts.canisterId, {
        chain: metadata.chain, tokenAddress: metadata.tokenAddress, threshold: BigInt(metadata.threshold),
        epoch: BigInt(metadata.epoch), evmAddress: params.evmAddress, transportPublicKey: publicKey,
        nonce, signature, eip712ChainId, eip712VerifyingContract,
      })
      if ('err' in result) throw new HavenAolError(result.err)
      return unwrapStage('v3 vetKey transport unwrap', () =>
        recoverVetKey(result.ok.encryptedKey, secretKey, result.ok.verificationKey, derivationInput))
    })
    const aesKey = unwrapStage('v3 epoch-key IBE unwrap', () => ibeDecryptAesKey(metadata.encryptedAesKey, vetKey))
    return unwrapStageAsync('v3 file AES-GCM open', () => decryptFile(params.encryptedFileBytes, aesKey))
  }

  /** v4 end-to-end decrypt (market-cap drip). Fails closed client-side on non-Bond oracles; same vetKey caching as v3 (per rung). */
  async decryptV4(params: GateCallCommon & { gateMetadataJson: string; encryptedFileBytes: Uint8Array }): Promise<Uint8Array> {
    const { buildGateRequestV4TypedData: buildV4 } = await import('haven-aol')
    const metadata = parseGateMetadataV4(params.gateMetadataJson)
    if (!metadata) throw new Error('dsh-haven-aol: not v4 gate metadata')
    if (!isBondAddress(metadata.chain, metadata.oracleAddress)) {
      throw new Error(
        `dsh-haven-aol: oracleAddress ${metadata.oracleAddress} is not the ${metadata.chain} Bond contract — `
        + 'the canister fails closed (#InvalidOracle). Refusing before spending a gate call.',
      )
    }
    const derivationInput = await computeDerivationInputV4(
      metadata.chain, metadata.tokenAddress, BigInt(metadata.threshold), metadata.epoch, metadata.marketCapTarget)
    const vetKey = await this.cachedVetKey(vetKeySlot(derivationInput), async () => {
      const agent = await this.agent()
      const { secretKey, publicKey } = createTransportKeyPair()
      const nonce = params.nonce ?? freshNonce()
      const { eip712ChainId, eip712VerifyingContract } = this.gateDefaults(params, metadata.chain)
      const typed = buildV4({
        evmAddress: params.evmAddress, transportPublicKey: publicKey, epoch: metadata.epoch,
        marketCapTarget: metadata.marketCapTarget, nonce,
        eip712ChainId, eip712VerifyingContract,
      })
      const signature = await this.signOrThrow(typedDigest(typed as never))
      const fn = internals.requestV4 ?? liveRequestV4
      const result = await fn(agent, this.opts.canisterId, {
        chain: metadata.chain, tokenAddress: metadata.tokenAddress, threshold: BigInt(metadata.threshold),
        epoch: BigInt(metadata.epoch), marketCapTarget: BigInt(metadata.marketCapTarget),
        oracleAddress: metadata.oracleAddress, evmAddress: params.evmAddress,
        transportPublicKey: publicKey, nonce, signature, eip712ChainId, eip712VerifyingContract,
      })
      if ('err' in result) throw new HavenAolError(result.err)
      return unwrapStage('v4 vetKey transport unwrap', () =>
        recoverVetKey(result.ok.encryptedKey, secretKey, result.ok.verificationKey, derivationInput))
    })
    const aesKey = unwrapStage('v4 epoch-key IBE unwrap', () => ibeDecryptAesKey(metadata.encryptedAesKey, vetKey))
    return unwrapStageAsync('v4 file AES-GCM open', () => decryptFile(params.encryptedFileBytes, aesKey))
  }

  /**
   * Seal bytes under a new gate: an AES-256-GCM content key,
   * IBE-wrapped under the canister's verification key, plus gate
   * metadata JSON. No wallet, no signature — sealing is local plus one
   * free DPK query (cached per version).
   *
   * v3 seals share one AES key per (chain, token, threshold, epoch)
   * bucket: every file in the epoch carries the same `encryptedAesKey`
   * blob. v1 (per-file) and v4 (per-rung — sharing across rungs would
   * let one unlock open later files) mint a fresh key per seal. IVs
   * stay fresh per seal in all versions, so every seal's bytes are
   * still unique — repeats never reproduce a release.
   */
  async seal(params: SealParams): Promise<SealResult> {
    await this.ensureKeyStore()
    if (params.version !== 1 && params.version !== 3 && params.version !== 4) {
      throw new Error(`dsh-haven-aol: unsupported seal version ${String(params.version)} (want 1, 3, or 4)`)
    }
    if (params.threshold < 0n) {
      throw new Error('dsh-haven-aol: threshold must be a non-negative integer')
    }
    // Canonicalize the token BEFORE wrap+metadata: the derivation preimage
    // hashes tokenAddress VERBATIM (spec: casing preserved on all three
    // stacks — Motoko, Python, TS), while the epoch cache slots lowercase.
    // A mixed-case caller would otherwise mint a wrap the cache serves
    // under a slot whose derivation differs → a self-inconsistent seal
    // whose IBE open fails at 'epoch-key IBE unwrap' although every gate
    // term is correct. Lowercase matches the cache slot and the canister's
    // balance-check normalization. Decrypt stays verbatim: third-party
    // seals keep whatever case they were wrapped under.
    const tokenAddress = params.tokenAddress.toLowerCase()
    // Threshold-zero collapse (canister rule): free content seals at the
    // eternal epoch, matching what the decrypt side derives.
    const epoch = params.threshold === 0n ? 0 : (params.epoch ?? currentEpoch())
    if (params.version === 4) {
      if (params.marketCapTarget === undefined) {
        throw new Error('dsh-haven-aol: v4 seals require marketCapTarget (whole reserve units)')
      }
      if (params.oracleAddress === undefined || !isBondAddress(params.chain, params.oracleAddress)) {
        throw new Error(
          `dsh-haven-aol: oracleAddress ${params.oracleAddress ?? '(missing)'} is not the ${params.chain} Bond contract — `
          + 'the canister fails closed (#InvalidOracle). Refusing to seal an unopenable file.',
        )
      }
    }
    const derivationInput = params.version === 1
      ? await computeDerivationInput(params.chain, tokenAddress, params.threshold, params.cid)
      : params.version === 3
        ? await computeDerivationInputV3(params.chain, tokenAddress, params.threshold, epoch)
        : await computeDerivationInputV4(
          params.chain, tokenAddress, params.threshold, epoch, params.marketCapTarget as bigint)
    let aesKey: Uint8Array
    let wrapped: string
    if (params.version === 3) {
      const hit = await this.epochKeys.getOrCreate(
        { chain: params.chain, tokenAddress, threshold: params.threshold, epoch },
        async () => {
          const dpk = await this.verificationKey(3)
          const raw = freshAesKey()
          return { rawKey: raw, wrappedB64: this.wrapOrThrow(3, dpk, derivationInput, raw) }
        },
      )
      await this.persistKeys()
      aesKey = hit.rawKey
      wrapped = hit.wrappedB64
    } else {
      const dpk = await this.verificationKey(params.version)
      aesKey = freshAesKey()
      wrapped = this.wrapOrThrow(params.version, dpk, derivationInput, aesKey)
    }
    const { sealed: sealedBytes } = await encryptFileAesGcm(params.plaintext, aesKey)
    const gateMetadataJson = params.version === 1
      ? gateMetadataV1ToJson(buildGateMetadataV1({
        cid: params.cid, chain: params.chain, tokenAddress,
        threshold: params.threshold, encryptedAesKey: wrapped,
      }))
      : params.version === 3
        ? gateMetadataV3ToJson(buildGateMetadataV3({
          cid: params.cid, chain: params.chain, tokenAddress,
          threshold: params.threshold, epoch, encryptedAesKey: wrapped,
        }))
        : gateMetadataV4ToJson(buildGateMetadataV4({
          cid: params.cid, chain: params.chain, tokenAddress,
          threshold: params.threshold, epoch, marketCapTarget: params.marketCapTarget as bigint,
          oracleAddress: params.oracleAddress as string, encryptedAesKey: wrapped,
        }))
    return {
      sealedBytes,
      gateMetadataJson,
      version: params.version,
      keySha256: createHash('sha256').update(aesKey).digest('hex'),
    }
  }

  /** IBE-wrap one AES key, failing closed (an unopenable file is never sealed). */
  private wrapOrThrow(version: 1 | 3 | 4, dpk: Uint8Array, derivationInput: Uint8Array, aesKey: Uint8Array): string {
    try {
      return ibeEncryptAesKey(dpk, derivationInput, aesKey)
    } catch (error: unknown) {
      throw new Error(
        `dsh-haven-aol: IBE wrap failed under the v${version} verification key `
        + '(refusing to seal an unopenable file)',
        { cause: error },
      )
    }
  }

  /** Version verification key: stub, cache, or live canister query. */
  private async verificationKey(version: 1 | 3 | 4): Promise<Uint8Array> {
    if (internals.dpk !== undefined) return internals.dpk(version)
    const cached = this.dpkCache.get(version)
    if (cached !== undefined) return cached
    const agent = await this.agent()
    const key = version === 1
      ? await fetchVerificationKey(agent, this.opts.canisterId)
      : version === 3
        ? await liveDpkV3(agent, this.opts.canisterId)
        : await fetchVerificationKeyV4(agent, this.opts.canisterId)
    this.dpkCache.set(version, key)
    return key
  }
}
