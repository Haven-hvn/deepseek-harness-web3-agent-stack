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
 * signature; see README spike). Keys never appear in outputs or events;
 * epoch/vetKeys persist to keyStorePath when configured, else stay in
 * memory (see ./keyStore.ts).
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
export { KEY_STORE_VERSION, loadKeyStore, saveKeyStore } from './keyStore.ts'
export type { AolDecryptedEvent, AolSealedEvent, AolSigningError } from './types.ts'

/** Cordis plugin name. */
export const name = 'haven-aol'
/**
 * Only the tool registry blocks mounting. The wallet is best-effort via
 * ctx.get(): reads (gate_info/epoch/market_cap) never sign, and aol_decrypt
 * fails loud with an actionable error when no wallet is mounted.
 */
// 'wallet': decrypt signs the EIP-712 gate request via requireWallet —
// without the declaration Cordis throws 'cannot get property "wallet"
// without inject'. ('synapse' stays undeclared: cid-decrypt degrades to
// a friendly error via optionalSynapse instead of dormancy.)
export const inject = ['tools', 'wallet'] as const

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
  /**
   * Durable key file for epoch/vetKeys (e.g. `/data/haven-aol/keys.json`).
   * Unset keeps the memory-only behavior (keys cleared on restart).
   */
  readonly keyStorePath?: string
}

export const Config: z<Config> = z.object({
  wallet: z.string().required(),
  canisterId: z.string().default('gny6k-fqaaa-aaaab-ag3ra-cai'),
  icpHost: z.string().default('https://icp-api.io'),
  fetchRootKey: z.boolean().default(false),
  eip712ChainId: z.number(),
  eip712VerifyingContract: z.string(),
  keyStorePath: z.string(),
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
  // Undeclared-seam access throws in Cordis by design; absence must degrade
  // to the friendly cid-decrypt error, never to the inject exception.
  let s: SynapseSeam | undefined
  try {
    s = (ctx as unknown as { synapse?: SynapseSeam }).synapse
  } catch {
    return undefined
  }
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
    ...(config.keyStorePath !== undefined ? { keyStorePath: config.keyStorePath } : {}),
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
    ...(config.keyStorePath !== undefined ? { keyStorePath: config.keyStorePath } : {}),
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

  /**
   * Exactly one of inline JSON or a sidecar path. The metadata is
   * byte-load-bearing (tokenAddress case feeds the case-sensitive
   * derivation preimage), so callers holding a sidecar file must pass
   * the path and never retype the JSON — a one-character case drift
   * derives a different vetKey and the IBE open fails although the
   * gate terms all read correct.
   */
  const gateMetadataFromArgs = async (
    args: { gateMetadataJson?: string; gateMetadataPath?: string }, tool: string,
  ): Promise<string> => {
    const inline = args.gateMetadataJson !== undefined && args.gateMetadataJson !== ''
    const fromPath = args.gateMetadataPath !== undefined && args.gateMetadataPath !== ''
    if (inline === fromPath) {
      throw new Error(`dsh-haven-aol: ${tool} needs exactly one of gateMetadataJson or gateMetadataPath`)
    }
    if (fromPath) return readFile(args.gateMetadataPath as string, 'utf8')
    return args.gateMetadataJson as string
  }

  // ── aol_gate_info (read, pure) ────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'aol_gate_info',
    description:
      'Inspect Haven-AOL gate metadata (v1/v3/v4): version, chain, token, threshold, epoch, and for v4 the market-cap target + Bond pin check. Pure read, no network. Call before aol_decrypt to decide whether a decrypt is worth attempting.',
    parameters: {
      gateMetadataJson: { type: 'string', description: 'Gate metadata JSON (from upload sidecar / Arkiv entity / .encmeta). Exactly one of gateMetadataJson or gateMetadataPath.' },
      gateMetadataPath: { type: 'string', description: 'Path to a gate sidecar JSON file (byte-exact, no retyping). Exactly one of gateMetadataJson or gateMetadataPath.' },
    },
    output: { schema: { type: 'object', additionalProperties: true } as never, render: (_a, v) => renderJson(v) as never },
    execute: async (args: { gateMetadataJson?: string; gateMetadataPath?: string }): Promise<unknown> => {
      const summary = aol.gateInfo(await gateMetadataFromArgs(args, 'aol_gate_info'))
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
      gateMetadataJson: { type: 'string', description: 'Gate metadata JSON for this file. Exactly one of gateMetadataJson or gateMetadataPath.' },
      gateMetadataPath: { type: 'string', description: 'Path to the gate sidecar JSON file (byte-exact, prefer over retyping). Exactly one of gateMetadataJson or gateMetadataPath.' },
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
      path?: string; cid?: string; gateMetadataJson?: string; gateMetadataPath?: string; outputPath: string
      eip712ChainId?: number; eip712VerifyingContract?: string; nonce?: string
    }, exec): Promise<{ outputPath: string; bytes: number; version: 1 | 3 | 4 }> => {
      if ((args.path === undefined) === (args.cid === undefined)) {
        throw new Error('provide exactly one of path or cid')
      }
      const gateMetadataJson = await gateMetadataFromArgs(args, 'aol_decrypt')
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
      const summary = aol.gateInfo(gateMetadataJson)
      const common = {
        evmAddress,
        gateMetadataJson,
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
      'Seal a file under a new Haven-AOL token gate (v1 per-file, v3 epoch corpus, v4 market-cap drip): wraps an AES-256-GCM content key (shared per epoch bucket for v3, fresh per seal for v1/v4, fresh IV per seal always) under the canister verification key, and builds gate metadata JSON. Writes sealed bytes to outputPath plus a gate sidecar (<outputPath>.gate.json, the durable gateMetadataJson — restarts lose in-turn results, never this file) and returns paths + byte count + gateMetadataJson + key commitment. Threshold must be > 0 (the canister rejects 0); free content ships clear — no seal, no gate, no canister call. Fails closed on non-Bond v4 oracles.',
    parameters: {
      path: { type: 'string', required: true, description: 'Local file to seal.' },
      outputPath: { type: 'string', required: true, description: 'Where to write the sealed bytes.' },
      version: { type: 'number', required: true, description: 'Gate version: 1 (per-file), 3 (epoch corpus), or 4 (market-cap drip).' },
      chain: { type: 'string', required: true, description: 'SDK chain name (EthMainnet, BaseMainnet, ArbitrumOne, OptimismMainnet, EthSepolia).' },
      tokenAddress: { type: 'string', required: true, description: 'Gate token contract address (0x...).' },
      threshold: { type: 'string', required: true, description: 'Minimum balance in smallest token units (raw integer string). Must be > 0 — the canister rejects 0; free content ships clear (pin plaintext, catalog fcid), never sealed.' },
      cid: { type: 'string', description: 'Gate CID the seal binds to. Default: sha256:<hex-of-plaintext> (for pre-upload seals).' },
      epoch: { type: 'number', description: 'v3/v4 epoch (default: current from aol_epoch).' },
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
          gateMetadataPath: { type: 'string', required: true },
          keySha256: { type: 'string', required: true },
        },
      } as never,
      render: (_a, v) => [{ type: 'text', text: `sealed ${(v as { bytes: number }).bytes} bytes → ${(v as { outputPath: string }).outputPath} (gate ${(v as { gateMetadataPath: string }).gateMetadataPath})` }] as never,
    },
    isConcurrencySafe: () => true,
    execute: async (args: {
      path: string; outputPath: string; version: number; chain: string; tokenAddress: string
      threshold: string; cid?: string; epoch?: number; marketCapTarget?: string; oracleAddress?: string
    }): Promise<{ outputPath: string; bytes: number; version: 1 | 3 | 4; gateMetadataJson: string; gateMetadataPath: string; keySha256: string }> => {
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
      // Durable twin: the gate JSON is load-bearing for verify/decrypt/catalog,
      // and in-turn results die on restart — the sidecar must not.
      const gateMetadataPath = `${args.outputPath}.gate.json`
      await writeFile(gateMetadataPath, sealed.gateMetadataJson, 'utf8')
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
        gateMetadataPath,
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
