/**
 * Service Definition and single runtime of the wallet capability seam
 * (`ctx.wallet`). The runtime owns *which* wallets exist (configuration
 * carries chain, provider-scoped wallet selector, and a credential
 * *reference*) and *when* secrets exist (resolved through `ctx.credentials`
 * inside each operation, handed to the chain adapter, then dropped). Chain
 * adapters — Haven's `CryptoAdapter` contract, see `src/types.ts` — own the
 * cryptography and register per chain family.
 *
 * Custody invariant (haven-core `WalletIdentity`: "the private key NEVER
 * leaves this machine boundary — other machines request signatures, they
 * don't access keys"), translated to dsh seams:
 *
 * - Configuration rows carry `keyRef` — a `CredentialRef`-shaped *name*. A
 *   raw key pasted where a reference belongs fails loud at plugin load: key
 *   material cannot syntactically be a reference.
 * - No secret and no adapter `keyMaterial` outlives one operation. Resolution
 *   is per call (`ctx.credentials` contract: consumers re-resolve at each
 *   operation and must not cache), so a rotated credential reaches the next
 *   signature without any restart.
 * - Consumers receive addresses and signatures; the seam exposes no key-bytes
 *   surface at all.
 *
 * @module dsh-wallet
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {
  CryptoAdapter,
  WalletAddress,
  WalletDescriptor,
  WalletInfo,
  WalletKeySource,
  WalletSignature,
  WalletSignedEvent,
} from './types.ts'

export type {
  CryptoAdapter,
  WalletAddress,
  WalletDescriptor,
  WalletInfo,
  WalletKeySource,
  WalletSignature,
  WalletSignedEvent,
} from './types.ts'

/** Stable machine-readable failure codes of the wallet seam. */
export type WalletErrorCode =
  | 'wallet-not-found'
  | 'chain-unsupported'
  | 'credential-unconfigured'
  | 'invalid-key-ref'
  | 'duplicate-adapter'

/** Structured wallet-seam failure: every message is actionable without exposing secrets. */
export class WalletError extends Error {
  override readonly name = 'WalletError'
  /** Stable machine-readable code. */
  readonly code: WalletErrorCode

  constructor(code: WalletErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.code = code
  }
}

/** Plugin configuration: named wallets over registered chain adapters. */
export interface Config {
  /**
   * Configured wallets keyed by the name consumers pass to operations.
   * `keyRef` is a credential *reference* (`ctx.credentials` semantics: a
   * POSIX-style environment-variable name such as `HAVEN_WALLET_PASSPHRASE`),
   * never a secret value.
   */
  wallets?: Record<string, WalletDescriptor>
}

export const Config: z<Config> = z.object({
  wallets: z.dict(z.object({
    chain: z.string().required(),
    wallet: z.string().required(),
    keyRef: z.string(),
  })).default({}),
})

/** One validated wallet entry with its branded reference resolved once at load. */
interface ResolvedDescriptor {
  readonly chain: string
  readonly wallet: string
  readonly keyRef?: CredentialRef
}

/**
 * Validate one configured descriptor at plugin load, failing loud on
 * anything that could smuggle key material into configuration. The
 * `CredentialRef` brand pattern (a POSIX shell identifier) is the enforcement
 * mechanism: no hex private key, mnemonic phrase, `0x…` string, or
 * `ows_key_…` token body survives it, and the error says what belongs here
 * instead.
 */
function resolveDescriptor(name: string, descriptor: WalletDescriptor): ResolvedDescriptor {
  if (descriptor.chain.trim().length === 0) {
    throw new WalletError('invalid-key-ref', `wallet "${name}": chain must be a non-empty chain family (e.g. "evm")`)
  }
  if (descriptor.wallet.trim().length === 0) {
    throw new WalletError('invalid-key-ref', `wallet "${name}": wallet must be a non-empty provider-scoped selector`)
  }
  if (descriptor.keyRef === undefined) {
    return { chain: descriptor.chain, wallet: descriptor.wallet }
  }
  try {
    return {
      chain: descriptor.chain,
      wallet: descriptor.wallet,
      keyRef: credentialRef(descriptor.keyRef),
    }
  } catch (cause) {
    throw new WalletError(
      'invalid-key-ref',
      `wallet "${name}": keyRef ${JSON.stringify(truncateForDiagnostics(descriptor.keyRef))} is not a credential reference. `
      + 'Configuration carries the NAME of a credential (a POSIX-style environment-variable name, e.g. '
      + '"HAVEN_WALLET_PASSPHRASE"), never the secret itself — store the value with your credential provider '
      + 'and reference it here.',
      { cause },
    )
  }
}

/**
 * Bound how much of a rejected `keyRef` a diagnostic quotes. The rejected
 * value might BE a pasted secret; the error must stay actionable without
 * echoing it.
 */
function truncateForDiagnostics(value: string): string {
  return value.length <= 8 ? value : `${value.slice(0, 8)}… (${value.length} chars)`
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    wallet: WalletRuntime
  }
}

/**
 * The wallet runtime (`ctx.wallet`): a per-chain adapter registry plus the
 * per-operation resolve→load→sign→drop pipeline.
 */
export class WalletRuntime extends Service {
  static inject = ['credentials']
  static Config: z<Config> = Config

  private readonly adapters = new Map<string, CryptoAdapter>()
  private readonly wallets = new Map<string, ResolvedDescriptor>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'wallet')
    for (const [name, descriptor] of Object.entries(config.wallets ?? {})) {
      this.wallets.set(name, resolveDescriptor(name, descriptor))
    }
  }

  /**
   * Register one chain family's adapter. Registration is an effect: the
   * returned disposer removes exactly this registration (stale disposers of a
   * replaced registration are no-ops).
   * @param chain - chain family key (e.g. `evm`).
   * @param adapter - the provider implementation.
   * @returns the disposer that unregisters the adapter.
   */
  register(chain: string, adapter: CryptoAdapter): () => void {
    if (this.adapters.has(chain)) {
      throw new WalletError('duplicate-adapter', `an adapter for chain "${chain}" is already registered`)
    }
    this.adapters.set(chain, adapter)
    return () => {
      if (this.adapters.get(chain) === adapter) {
        this.adapters.delete(chain)
      }
    }
  }

  /**
   * Describe every configured wallet for diagnostics — names, chains, and
   * configuration facts; never secrets.
   * @returns a fresh snapshot array.
   */
  list(): WalletInfo[] {
    return [...this.wallets.entries()].map(([name, descriptor]) => ({
      name,
      chain: descriptor.chain,
      wallet: descriptor.wallet,
      keyRefConfigured: descriptor.keyRef !== undefined,
      adapterRegistered: this.adapters.has(descriptor.chain),
    }))
  }

  /**
   * Derive one wallet's public address. Runs the full per-operation pipeline
   * (resolve → loadKey) and drops the operation context on return.
   * @param name - configured wallet name.
   * @returns the chain-native public address.
   */
  async address(name: string): Promise<WalletAddress> {
    const { adapter, source } = await this.beginOperation(name)
    const { address } = await adapter.loadKey(source)
    return address
  }

  /**
   * Sign an arbitrary message with one configured wallet.
   * @param name - configured wallet name.
   * @param payload - message text to sign.
   * @returns the signing address and hex-encoded signature.
   */
  signMessage(name: string, payload: string): Promise<{ address: WalletAddress; signature: WalletSignature }> {
    return this.sign(name, 'sign-message', payload)
  }

  /**
   * Sign an already-serialized transaction (hex-encoded bytes) with one
   * configured wallet. Sign-only — broadcasting is a separate concern owned
   * by whoever holds the signed payload.
   * @param name - configured wallet name.
   * @param payload - hex-encoded serialized transaction bytes.
   * @returns the signing address and hex-encoded signature.
   */
  signTransaction(name: string, payload: string): Promise<{ address: WalletAddress; signature: WalletSignature }> {
    return this.sign(name, 'sign-transaction', payload)
  }

  /** The shared operation pipeline behind both signing entry points. */
  private async sign(
    name: string,
    operation: WalletSignedEvent['operation'],
    payload: string,
  ): Promise<{ address: WalletAddress; signature: WalletSignature }> {
    const { adapter, descriptor, source } = await this.beginOperation(name)
    const { address, keyMaterial } = await adapter.loadKey(source)
    const signature = operation === 'sign-message'
      ? await adapter.signMessage(keyMaterial, payload)
      : await adapter.signTransaction(keyMaterial, payload)
    // Commit point: the adapter returned. Observers get identity facts only.
    this.ctx.emit('wallet/signed', { wallet: name, chain: descriptor.chain, operation, address })
    return { address, signature }
  }

  /**
   * Open one operation: look up the wallet and adapter, then resolve the
   * credential reference NOW — this call, not plugin load, is the only place
   * a secret value exists, and it lives in the returned operation-scoped
   * {@link WalletKeySource} that callers drop on return. Per the
   * `ctx.credentials` contract the resolution is never cached, so a rotated
   * credential reaches the very next operation.
   */
  private async beginOperation(name: string): Promise<{
    adapter: CryptoAdapter
    descriptor: ResolvedDescriptor
    source: WalletKeySource
  }> {
    const descriptor = this.wallets.get(name)
    if (descriptor === undefined) {
      const known = [...this.wallets.keys()].join(', ') || 'none'
      throw new WalletError('wallet-not-found', `wallet "${name}" is not configured (configured: ${known})`)
    }
    const adapter = this.adapters.get(descriptor.chain)
    if (adapter === undefined) {
      const registered = [...this.adapters.keys()].join(', ') || 'none'
      throw new WalletError(
        'chain-unsupported',
        `no adapter is registered for chain "${descriptor.chain}" (registered: ${registered}) — `
        + 'load a wallet provider plugin (e.g. dsh-wallet-ethereum) for this chain family',
      )
    }
    if (descriptor.keyRef === undefined) {
      return { adapter, descriptor, source: { wallet: descriptor.wallet, chain: descriptor.chain } }
    }
    const resolved = await this.ctx.credentials.resolve(descriptor.keyRef)
    if (resolved === undefined) {
      throw new WalletError(
        'credential-unconfigured',
        `wallet "${name}": credential reference "${descriptor.keyRef}" resolves to no value — `
        + 'configure it with your credential provider before signing',
      )
    }
    return {
      adapter,
      descriptor,
      source: { wallet: descriptor.wallet, chain: descriptor.chain, secret: resolved.value },
    }
  }
}

// Service packages default-export their service class and nothing else
// plugin-shaped (dsh packages/AGENTS.md): mixing a default export with a
// function-plugin `apply` makes the Loader drop the plugin namespace.
export default WalletRuntime
