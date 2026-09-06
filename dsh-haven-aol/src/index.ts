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

import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from 'dsh-wallet'
import { AolRuntime, type Chain } from './aol.ts'
import type { AolDecryptedEvent } from './types.ts'

export { AolRuntime, HavenAolError, freshNonce, type Chain, type SignGate } from './aol.ts'
export type { AolDecryptedEvent, AolSigningError } from './types.ts'

/** Cordis plugin name. */
export const name = 'haven-aol'
/** Signing identity (OWS, via the signGate seam once wired) and the tool registry. */
export const inject = ['wallet', 'tools'] as const

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
  canisterId: z.string().default('dciac-uaaaa-aaaad-qlzuq-cai'),
  icpHost: z.string().default('https://icp-api.io'),
  fetchRootKey: z.boolean().default(false),
  eip712ChainId: z.number(),
  eip712VerifyingContract: z.string(),
})

interface WalletSeam {
  address(name: string): Promise<string>
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
  const aol = new AolRuntime({
    canisterId: config.canisterId ?? 'dciac-uaaaa-aaaad-qlzuq-cai',
    icpHost: config.icpHost ?? 'https://icp-api.io',
    fetchRootKey: config.fetchRootKey ?? false,
    ...(config.eip712ChainId !== undefined ? { eip712ChainId: BigInt(config.eip712ChainId) } : {}),
    ...(config.eip712VerifyingContract !== undefined ? { eip712VerifyingContract: config.eip712VerifyingContract } : {}),
    // signGate stays unset: gate signing is fail-loud until the OWS
    // raw-digest spike resolves (README). Inject it here when wired.
  })
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
    execute: async (args: { gateMetadataJson: string }): Promise<unknown> => aol.gateInfo(args.gateMetadataJson),
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
      if (summary.version === 1) plaintext = await aol.decryptV1(common as never)
      else if (summary.version === 3) plaintext = await aol.decryptV3(common as never)
      else plaintext = await aol.decryptV4(common as never)
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
}
