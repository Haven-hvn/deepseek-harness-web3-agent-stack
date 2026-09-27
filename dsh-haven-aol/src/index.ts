/**
 * dsh-haven-aol — Haven-AOL token-gated decryption for dsh.
 *
 * `ctx.aol` (AolRuntime) plus four model-facing tools over the `haven-aol`
 * TS SDK and the ICP backend canister:
 *
 * - `aol_gate_info` — parse any-version gate metadata (v1/v3/v4). Pure read.
 * - `aol_epoch` — current 30-day epoch + rollover. Pure read.
 * - `aol_market_cap` — live v4 market cap in whole reserve units. Read.
 * - `aol_decrypt` — end-to-end gated decrypt (v1/v3/v4 dispatch). Execute.
 *
 * Custody: the EIP-712 gate signature is the only signing operation and it
 * goes through the signGate seam (default fail-loud AolSigningError —
 * ctx.wallet.signMessage is EIP-191, the canister needs a raw EIP-712 digest
 * signature; see README spike). VetKD/AES/transport keys stay inside the
 * executing tool call and never appear in outputs or events.
 *
 * Deferred, deliberately absent: attestHolding (no wrapper in any SDK yet),
 * encrypt-side (IBE-encrypt against @icp-sdk/vetkeys unverified).
 *
 * @module dsh-haven-aol
 */

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from 'dsh-wallet'
import { AolRuntime, type Chain } from './aol.ts'
import type { SignGate } from './aol.ts'
import { signGateFromTestKey } from './test_signer.ts'
import type { AolDecryptedEvent, AolSealedEvent } from './types.ts'

export { AolRuntime, HavenAolError, freshNonce, type Chain, type SignGate } from './aol.ts'
export type { SealParams, SealResult } from './aol.ts'
export { EpochAesKeyCache, VetKeyCache, makeEpochCacheKey, vetKeySlot } from './keyCache.ts'
export type { EpochAesKey, EpochBucket } from './keyCache.ts'
export type { AolDecryptedEvent, AolSealedEvent, AolSigningError } from './types.ts'

/** Cordis plugin name. */
export const name = 'haven-aol'
/**
 * Only the tool registry blocks mounting. The wallet is best-effort via
 * ctx.get(): reads (gate_info/epoch/market_cap) never sign, and aol_decrypt
 * fails loud with an actionable error when no wallet is mounted.
 */
export const inject = ['tools'] as const

/** Plugin configuration — public endpoints + wallet name only. No secrets. */
export interface Config {
  /** Configured `dsh-wallet` wallet name that signs gate requests. Required. */
  readonly wallet: string
  /** Haven-AOL backend canister id (default: mainnet). */
  readonly canisterId?: string
  /** ICP host for the anonymous agent. */
  readonly icpHost?: string
  /** Fetch the IC root key (local replica / testnets only — never mainnet). */
  readonly fetchRootKey?: boolean
  /** Default EIP-712 chain id for gate requests (per-call override wins). */
  readonly eip712ChainId?: number
  /** Default EIP-712 verifying contract (per-call override wins). */
  readonly eip712VerifyingContract?: string
}

export const Config: z<Config> = z.object({
  wallet: z.string().required(),
  canisterId: z.string().default('gny6k-fqaaa-aaaab-ag3ra-cai'),
  icpHost: z.string().default('https://icp-api.io'),
  fetchRootKey: z.boolean().default(false),
  eip712ChainId: z.number(),
  eip712VerifyingContract: z.string(),
})

interface WalletSeam {
  address(name: string): Promise<string>
  /** Vault raw-digest sign (dsh-wallet sign-digest passthrough). Optional until the wallet chain supports it. */
  signDigest?(name: string, digestHex: string): Promise<{ address: string; signature: string } | string>
}

function requireWallet(ctx: Context): WalletSeam {
  const w = (ctx as unknown as { wallet?: WalletSeam }).wallet
  if (!w || typeof w.address !== 'function') {
    throw new Error('dsh-haven-aol: ctx.wallet missing — check cordis.patch.yml mount order')
  }
  return w
}

interface SynapseSeam {
  retrieve(cid: string, signal?: AbortSignal): Promise<Uint8Array>
}

function optionalSynapse(ctx: Context): SynapseSeam | undefined {
  const s = (ctx as unknown as { synapse?: SynapseSeam }).synapse
  if (!s || typeof s.retrieve !== 'function') return undefined
  return s
}

function renderJson(value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * Provide `ctx.aol` and register the four tools.
 * @param ctx - Plugin context.
 * @param config - Validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  // TEST-ONLY: raw-key EIP-712 digest signer. Never set in production —
  // production signing must come from a vault-backed signDigest.
  const testKey = (globalThis.process?.env?.HAVEN_AOL_TEST_PRIVATE_KEY ?? '').trim()
  let testSignGate: SignGate | undefined
  if (testKey) {
    console.warn('[dsh-haven-aol] TEST-ONLY HAVEN_AOL_TEST_PRIVATE_KEY set — raw digest signing enabled')
    testSignGate = signGateFromTestKey(testKey)
  }
  const aol = new AolRuntime({
    canisterId: config.canisterId ?? 'gny6k-fqaaa-aaaab-ag3ra-cai',
    icpHost: config.icpHost ?? 'https://icp-api.io',
    fetchRootKey: config.fetchRootKey ?? false,
    ...(config.eip712ChainId !== undefined ? { eip712ChainId: BigInt(config.eip712ChainId) } : {}),
    ...(config.eip712VerifyingContract !== undefined ? { eip712VerifyingContract: config.eip712VerifyingContract } : {}),
    ...(testSignGate ? { signGate: testSignGate } : {}),
    // signGate stays unset otherwise: gate signing is fail-loud until a
    // vault signDigest (or the TEST-ONLY key above) is available.
  })
  const baseOpts = {
    canisterId: config.canisterId ?? 'gny6k-fqaaa-aaaab-ag3ra-cai',
    icpHost: config.icpHost ?? 'https://icp-api.io',
    fetchRootKey: config.fetchRootKey ?? false,
    ...(config.eip712ChainId !== undefined ? { eip712ChainId: BigInt(config.eip712ChainId) } : {}),
    ...(config.eip712VerifyingContract !== undefined ? { eip712VerifyingContract: config.eip712VerifyingContract } : {}),
  }
  /** Per-call runtime: vault signDigest first, TEST-ONLY key fallback, else fail-loud. */
  function runtimeForCall(wallet: WalletSeam): AolRuntime {
    if (typeof wallet.signDigest === 'function') {
      const signGate: SignGate = async (digestHex) => {
        const res = await wallet.signDigest!(config.wallet, digestHex)
        const sig = typeof res === 'string' ? res : res.signature
        return sig as `0x${string}`
      }
      return new AolRuntime({ ...baseOpts, signGate })
    }
    return aol
  }
  ctx.provide('aol', aol)

  const signalOf = (exec: unknown): AbortSignal | undefined =>
    (exec as { signal?: AbortSignal } | undefined)?.signal

  // ── aol_gate_info (read, pure) ────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'aol_gate_info',
    description:
      'Inspect Haven-AOL gate metadata (v1/v3/v4): version, chain, token, threshold, epoch, and for v4 the market-cap target + Bond pin check. Pure read, no network. Call before aol_decrypt to decide whether a decrypt is worth attempting.',
    parameters: {
      gateMetadataJson: { type: 'string', required: true, description: 'Gate metadata JSON (from upload sidecar / Arkiv entity / .encmeta).' },
    },
    output: { schema: { type: 'object', additionalProperties: true } as never, render: (_a, v) => renderJson(v) as never },
    execute: async (args: { gateMetadataJson: string }): Promise<unknown> => {
      const summary = aol.gateInfo(args.gateMetadataJson)
      ctx.emit('catalog/upsert', {
        cid: summary.cid,
        gate: 'aol',
        token: summary.tokenAddress,
        chain: summary.chain,
        threshold: summary.threshold,
      })
      return summary
    },
    presentCall: () => ({ card: 'generic', title: 'Haven-AOL gate info', kind: 'read' }),
  })))

  // ── aol_epoch (read, pure) ────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'aol_epoch',
    description:
      'Current Haven-AOL 30-day epoch and next rollover (advisory — the canister rejects future epochs authoritatively). Use to choose the epoch for an upload or interpret a v3/v4 gate.',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true } as never, render: (_a, v) => renderJson(v) as never },
    execute: async (): Promise<unknown> => aol.epoch(),
    presentCall: () => ({ card: 'generic', title: 'Haven-AOL epoch', kind: 'read' }),
  })))

  // ── aol_market_cap (read, canister diagnostic) ────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'aol_market_cap',
    description:
      'Live v4 market cap for a token in whole reserve units (whole ETH for native-reserve tokens) via the canister burst cache (300s). Fails closed client-side on non-Bond oracles. Call to check whether a v4 drip chunk has unlocked before attempting aol_decrypt.',
    parameters: {
      chain: { type: 'string', required: true, description: 'SDK chain name (EthMainnet, BaseMainnet, ArbitrumOne, OptimismMainnet, EthSepolia).' },
      tokenAddress: { type: 'string', required: true, description: 'Gate token contract address (0x...).' },
      oracleAddress: { type: 'string', required: true, description: 'Must be the chain Bond contract (see BOND_ADDRESSES).' },
    },
    output: { schema: { type: 'object', additionalProperties: true } as never, render: (_a, v) => renderJson(v) as never },
    execute: async (args: { chain: string; tokenAddress: string; oracleAddress: string }): Promise<unknown> =>
      aol.marketCap(args.chain as Chain, args.tokenAddress, args.oracleAddress),
    presentCall: args => ({ card: 'generic', title: `Haven-AOL market cap ${args.tokenAddress}`, kind: 'read' }),
  })))

  // ── aol_decrypt (execute) ─────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'aol_decrypt',
    description:
      'Decrypt a Haven-AOL token-gated file (v1/v3/v4 auto-dispatch from gate metadata). Signs the EIP-712 gate request with the agent wallet, requests the VetKD key from the ICP canister (balance-checked), unwraps the AES key and decrypts locally. Writes plaintext to outputPath and returns path + byte count — keys never leave the call. Gate denials (InsufficientBalance, MarketCapNotReached, InvalidSignature) surface as tool errors.',
    parameters: {
      path: { type: 'string', description: 'Local encrypted file. Exactly one of path or cid.' },
      cid: { type: 'string', description: 'Filecoin CID to fetch via ctx.synapse first. Exactly one of path or cid.' },
      gateMetadataJson: { type: 'string', required: true, description: 'Gate metadata JSON for this file.' },
      outputPath: { type: 'string', required: true, description: 'Where to write the plaintext.' },
      eip712ChainId: { type: 'number', description: 'EIP-712 domain chain id (falls back to plugin config).' },
      eip712VerifyingContract: { type: 'string', description: 'EIP-712 verifying contract (falls back to plugin config).' },
      nonce: { type: 'string', description: 'Hex nonce override (default: fresh random; canister rejects replays).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          outputPath: { type: 'string', required: true },
          bytes: { type: 'number', required: true },
          version: { type: 'number', required: true },
        },
      } as never,
      render: (_a, v) => [{ type: 'text', text: `decrypted ${(v as { bytes: number }).bytes} bytes → ${(v as { outputPath: string }).outputPath}` }] as never,
    },
    execute: async (args: {
      path?: string; cid?: string; gateMetadataJson: string; outputPath: string
      eip712ChainId?: number; eip712VerifyingContract?: string; nonce?: string
    }, exec): Promise<{ outputPath: string; bytes: number; version: 1 | 3 | 4 }> => {
      if ((args.path === undefined) === (args.cid === undefined)) {
        throw new Error('provide exactly one of path or cid')
      }
      const wallet = requireWallet(ctx)
      const evmAddress = await wallet.address(config.wallet)
      const rt = runtimeForCall(wallet)
      let encrypted: Uint8Array
      if (args.path !== undefined) {
        encrypted = await readFile(args.path)
      } else {
        const synapse = optionalSynapse(ctx)
        if (!synapse) {
          throw new Error('dsh-haven-aol: cid given but ctx.synapse is not mounted — install dsh-storage-synapse or pass path')
        }
        encrypted = await synapse.retrieve(args.cid as string, signalOf(exec))
      }
      const summary = aol.gateInfo(args.gateMetadataJson)
      const common = {
        evmAddress,
        gateMetadataJson: args.gateMetadataJson,
        encryptedFileBytes: encrypted,
        ...(args.eip712ChainId !== undefined ? { eip712ChainId: BigInt(args.eip712ChainId) } : {}),
        ...(args.eip712VerifyingContract !== undefined ? { eip712VerifyingContract: args.eip712VerifyingContract } : {}),
        ...(args.nonce !== undefined ? { nonce: BigInt(args.nonce) } : {}),
      }
      let plaintext: Uint8Array
      if (summary.version === 1) plaintext = await rt.decryptV1(common as never)
      else if (summary.version === 3) plaintext = await rt.decryptV3(common as never)
      else plaintext = await rt.decryptV4(common as never)
      await writeFile(args.outputPath, plaintext)
      const event: AolDecryptedEvent = {
        version: summary.version, cid: summary.cid, outputPath: args.outputPath, bytes: plaintext.length,
      }
      ctx.emit('aol/decrypted', event as never)
      return { outputPath: args.outputPath, bytes: plaintext.length, version: summary.version }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Haven-AOL decrypt ${args.path !== undefined ? basename(args.path) : args.cid ?? ''}`,
      kind: 'execute',
    }),
  })))

  // ── aol_seal (execute, local + one free DPK query) ───────────────────
  // No wallet, no signature: sealing wraps an AES key locally under the
  // canister's verification key (v3 shares one key per epoch bucket;
  // v1/v4 mint per seal; IVs are fresh per seal in all versions). Not
  // exactly-once guarded on purpose: every seal's bytes are unique, so
  // a repeat seals a *different* valid pair rather than replaying —
  // downstream (pin, catalog) always consumes the latest result.
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'aol_seal',
    description:
      'Seal a file under a new Haven-AOL token gate (v1 per-file, v3 epoch corpus, v4 market-cap drip): wraps an AES-256-GCM content key (shared per epoch bucket for v3, fresh per seal for v1/v4, fresh IV per seal always) under the canister verification key, and builds gate metadata JSON. Writes sealed bytes to outputPath and returns path + byte count + gateMetadataJson + key commitment. Fails closed on non-Bond v4 oracles.',
    parameters: {
      path: { type: 'string', required: true, description: 'Local file to seal.' },
      outputPath: { type: 'string', required: true, description: 'Where to write the sealed bytes.' },
      version: { type: 'number', required: true, description: 'Gate version: 1 (per-file), 3 (epoch corpus), or 4 (market-cap drip).' },
      chain: { type: 'string', required: true, description: 'SDK chain name (EthMainnet, BaseMainnet, ArbitrumOne, OptimismMainnet, EthSepolia).' },
      tokenAddress: { type: 'string', required: true, description: 'Gate token contract address (0x...).' },
      threshold: { type: 'string', required: true, description: 'Minimum balance in smallest token units (raw integer string). 0 seals free-tier at the eternal epoch (v3/v4).' },
      cid: { type: 'string', description: 'Gate CID the seal binds to. Default: sha256:<hex-of-plaintext> (haven-cli convention, for pre-upload seals).' },
      epoch: { type: 'number', description: 'v3/v4 epoch (default: current from aol_epoch; forced 0 when threshold is 0).' },
      marketCapTarget: { type: 'string', description: 'v4 unlock rung in whole reserve units (required for v4).' },
      oracleAddress: { type: 'string', description: 'v4 oracle (required for v4; must be the chain Bond contract).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          outputPath: { type: 'string', required: true },
          bytes: { type: 'number', required: true },
          version: { type: 'number', required: true },
          gateMetadataJson: { type: 'string', required: true },
          keySha256: { type: 'string', required: true },
        },
      } as never,
      render: (_a, v) => [{ type: 'text', text: `sealed ${(v as { bytes: number }).bytes} bytes → ${(v as { outputPath: string }).outputPath}` }] as never,
    },
    isConcurrencySafe: () => true,
    execute: async (args: {
      path: string; outputPath: string; version: number; chain: string; tokenAddress: string
      threshold: string; cid?: string; epoch?: number; marketCapTarget?: string; oracleAddress?: string
    }): Promise<{ outputPath: string; bytes: number; version: 1 | 3 | 4; gateMetadataJson: string; keySha256: string }> => {
      if (args.version !== 1 && args.version !== 3 && args.version !== 4) {
        throw new Error(`dsh-haven-aol: unsupported seal version ${String(args.version)} (want 1, 3, or 4)`)
      }
      let threshold: bigint
      try {
        threshold = BigInt((args.threshold ?? '').trim())
      } catch {
        throw new Error('dsh-haven-aol: threshold must be a raw-integer string (smallest token units)')
      }
      if (args.epoch !== undefined && (!Number.isInteger(args.epoch) || args.epoch < 0)) {
        throw new Error('dsh-haven-aol: epoch must be a non-negative integer')
      }
      let marketCapTarget: bigint | undefined
      if (args.marketCapTarget !== undefined) {
        try {
          marketCapTarget = BigInt(args.marketCapTarget.trim())
        } catch {
          throw new Error('dsh-haven-aol: marketCapTarget must be a raw-integer string (whole reserve units)')
        }
        if (marketCapTarget < 0n) throw new Error('dsh-haven-aol: marketCapTarget must be a non-negative integer')
      }
      const plaintext = await readFile(args.path)
      const cid = args.cid !== undefined && args.cid !== ''
        ? args.cid
        : `sha256:${createHash('sha256').update(plaintext).digest('hex')}`
      const sealed = await aol.seal({
        version: args.version,
        cid,
        chain: args.chain as Chain,
        tokenAddress: args.tokenAddress,
        threshold,
        ...(args.epoch !== undefined ? { epoch: args.epoch } : {}),
        ...(marketCapTarget !== undefined ? { marketCapTarget } : {}),
        ...(args.oracleAddress !== undefined ? { oracleAddress: args.oracleAddress } : {}),
        plaintext,
      })
      await writeFile(args.outputPath, sealed.sealedBytes)
      const event: AolSealedEvent = {
        version: sealed.version, cid, outputPath: args.outputPath, bytes: sealed.sealedBytes.length,
        keySha256: sealed.keySha256,
      }
      ctx.emit('aol/sealed', event as never)
      return {
        outputPath: args.outputPath,
        bytes: sealed.sealedBytes.length,
        version: sealed.version,
        gateMetadataJson: sealed.gateMetadataJson,
        keySha256: sealed.keySha256,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Haven-AOL seal ${basename(args.path ?? '')} (v${args.version ?? '?'})`,
      kind: 'execute',
    }),
  })))
}
