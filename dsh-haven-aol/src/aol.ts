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
 * - The single signature in every flow (EIP-712 gate request) goes through
 *   the signGate seam. Default is fail-loud (AolSigningError): ctx.wallet
 *   signs EIP-191 and the canister needs a raw EIP-712 digest signature.
 *
 * @module dsh-haven-aol/aol
 */

import { randomBytes } from 'node:crypto'
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
  buildGateRequestTypedData,
  buildGateRequestV3TypedData,
  buildGateRequestV4TypedData,
  parseSignatureHex,
  createTransportKeyPair,
  recoverVetKey,
  ibeDecryptAesKey,
  decryptFile,
  requestDecryptionKey,
  HavenAolError,
  type Chain,
} from 'haven-aol'
import { AolSigningError } from './types.ts'

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
} = { requestV1: undefined, requestV3: undefined, requestV4: undefined, marketCap: undefined }

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
}

const idlFactoryV3V4 = () =>
  IDL.Service({
    requestDecryptionKeyV3: IDL.Func([GateRequestV3Type], [GateResultVariant], []),
    requestDecryptionKeyV4: IDL.Func([GateRequestV4Type], [GateResultVariant], []),
    getMarketCap: IDL.Func([ChainVariant, IDL.Text, IDL.Text], [MarketCapResultVariant], []),
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

export interface AolRuntimeOpts {
  canisterId: string
  icpHost: string
  fetchRootKey: boolean
  eip712ChainId?: bigint
  eip712VerifyingContract?: string
  /** Raw-digest signer. Unset → every gated call throws AolSigningError (fail-loud). */
  signGate?: SignGate
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

export class AolRuntime {
  constructor(private readonly opts: AolRuntimeOpts) {
    if (!opts.canisterId || !opts.icpHost) throw new Error('dsh-haven-aol: canisterId+icpHost required')
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

  private gateDefaults(common: Partial<Pick<GateCallCommon, 'eip712ChainId' | 'eip712VerifyingContract'>>): {
    eip712ChainId: bigint
    eip712VerifyingContract: string
  } {
    const chainId = common.eip712ChainId ?? this.opts.eip712ChainId
    const verifier = common.eip712VerifyingContract ?? this.opts.eip712VerifyingContract
    if (chainId === undefined || !verifier) {
      throw new Error(
        'dsh-haven-aol: eip712ChainId + eip712VerifyingContract required per call or in cordis.patch.yml config',
      )
    }
    return { eip712ChainId: chainId, eip712VerifyingContract: verifier }
  }

  /** v1 end-to-end decrypt. Keys stay inside this call; returns plaintext. */
  async decryptV1(params: GateCallCommon & { gateMetadataJson: string; encryptedFileBytes: Uint8Array }): Promise<Uint8Array> {
    const metadata = parseGateMetadata(params.gateMetadataJson)
    const derivationInput = await computeDerivationInput(
      metadata.chain, metadata.tokenAddress, metadata.threshold, metadata.cid)
    const agent = await this.agent()
    const { secretKey, publicKey } = createTransportKeyPair()
    const nonce = params.nonce ?? freshNonce()
    const { eip712ChainId, eip712VerifyingContract } = this.gateDefaults(params)
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
    const vetKey = recoverVetKey(result.ok.encryptedKey, secretKey, result.ok.verificationKey, derivationInput)
    const aesKey = ibeDecryptAesKey(metadata.encryptedAesKey, vetKey)
    return decryptFile(params.encryptedFileBytes, aesKey)
  }

  /** v3 end-to-end decrypt (corpus+epoch). Same key-custody contract as v1. */
  async decryptV3(params: GateCallCommon & { gateMetadataJson: string; encryptedFileBytes: Uint8Array }): Promise<Uint8Array> {
    const { buildGateRequestV3TypedData: buildV3 } = await import('haven-aol')
    const metadata = parseGateMetadataV3(params.gateMetadataJson)
    if (!metadata) throw new Error('dsh-haven-aol: not v3 gate metadata')
    const derivationInput = await computeDerivationInputV3(
      metadata.chain, metadata.tokenAddress, BigInt(metadata.threshold), metadata.epoch)
    const agent = await this.agent()
    const { secretKey, publicKey } = createTransportKeyPair()
    const nonce = params.nonce ?? freshNonce()
    const { eip712ChainId, eip712VerifyingContract } = this.gateDefaults(params)
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
    const vetKey = recoverVetKey(result.ok.encryptedKey, secretKey, result.ok.verificationKey, derivationInput)
    const aesKey = ibeDecryptAesKey(metadata.encryptedAesKey, vetKey)
    return decryptFile(params.encryptedFileBytes, aesKey)
  }

  /** v4 end-to-end decrypt (market-cap drip). Fails closed client-side on non-Bond oracles. */
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
    const agent = await this.agent()
    const { secretKey, publicKey } = createTransportKeyPair()
    const nonce = params.nonce ?? freshNonce()
    const { eip712ChainId, eip712VerifyingContract } = this.gateDefaults(params)
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
    const vetKey = recoverVetKey(result.ok.encryptedKey, secretKey, result.ok.verificationKey, derivationInput)
    const aesKey = ibeDecryptAesKey(metadata.encryptedAesKey, vetKey)
    return decryptFile(params.encryptedFileBytes, aesKey)
  }
}
