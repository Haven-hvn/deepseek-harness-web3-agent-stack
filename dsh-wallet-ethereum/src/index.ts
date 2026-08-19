/**
 * OWS-backed Ethereum wallet provider: implements the `dsh-wallet`
 * `CryptoAdapter` contract (Haven's adapter shape) by delegating every
 * cryptographic operation to Open Wallet Standard bindings. Private keys live
 * in the OWS vault and never enter this process — `keyMaterial` here is a
 * typed *session descriptor* (wallet id, chain, credential, account index),
 * and OWS decrypts, signs, and zeroizes per call behind its own policy
 * engine.
 *
 * This realizes the haven-adapters OWS migration plan
 * (`docs/01-ows-crypto-adapter-migration-plan.md`) as a dsh plugin:
 * `loadKey` resolves wallet identity (name/id → accounts) instead of parsing
 * key strings, `signMessage` maps to OWS `signMessage`, `signTransaction`
 * maps to OWS sign-only `signTransaction` (never `signAndSend`), and OWS
 * failures translate to actionable adapter-level errors. Multi-chain parity
 * comes free: OWS derives all chain families from one vault wallet, so the
 * same adapter class serves any family listed in `chains` — `evm` is simply
 * this package's default.
 *
 * @module dsh-wallet-ethereum
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { CryptoAdapter, WalletAddress, WalletKeySource, WalletSignature } from 'dsh-wallet'
import { internals, loadOwsSigner } from './ows.ts'
import type { OwsSigner, OwsWalletInfo } from './ows.ts'

export { internals, loadOwsSigner } from './ows.ts'
export type { OwsAccountInfo, OwsSignResult, OwsSigner, OwsWalletInfo } from './ows.ts'

/** Cordis plugin name. */
export const name = 'wallet-ethereum'

/** The wallet seam must exist before the provider can register. */
export const inject = ['wallet']

/**
 * Map from OWS chain-family key to its CAIP-2 chain-id prefix, used to pick
 * the matching account off a vault wallet (`docs/07-supported-chains.md`).
 */
const CHAIN_FAMILY_PREFIXES: Record<string, string> = {
  evm: 'eip155:',
  solana: 'solana:',
  bitcoin: 'bip122:',
  cosmos: 'cosmos:',
  tron: 'tron:',
  ton: 'ton:',
  sui: 'sui:',
  xrpl: 'xrpl:',
  filecoin: 'fil:',
}

/** Plugin configuration. */
export interface Config {
  /**
   * Chain families to register this OWS adapter for. `evm` is the package's
   * reason to exist; add other families only when your deployment signs on
   * them through the same vault.
   */
  chains?: string[]
  /** OWS vault directory root; omit for the OWS default (`~/.ows`). */
  vaultPath?: string
  /** Account index within each wallet's derivation path. */
  accountIndex?: number
}

export const Config: z<Config> = z.object({
  chains: z.array(z.string()).default(['evm']),
  vaultPath: z.string(),
  accountIndex: z.number().default(0),
})

/**
 * Operation-scoped OWS session descriptor — the adapter's `keyMaterial`.
 * Typed (the migration plan bans `any`) and free of key bytes: the private
 * key stays in the OWS vault; `credential` is the passphrase or `ows_key_…`
 * token that authorizes THIS operation and dies with it.
 */
export interface OwsKeyContext {
  readonly wallet: string
  readonly chain: string
  readonly address: WalletAddress
  readonly credential?: string
  readonly accountIndex: number
  readonly vaultPath?: string
}

/** Translate one OWS failure into an actionable adapter-level error. */
function translateOwsError(operation: string, wallet: string, chain: string, cause: unknown): Error {
  const text = cause instanceof Error ? cause.message : String(cause)
  const advice
    = text.includes('WALLET_NOT_FOUND')
      ? `no OWS vault wallet named "${wallet}" exists — create or import it (ows wallet create/import)`
      : text.includes('POLICY_DENIED')
        ? 'the OWS policy engine denied this operation for the supplied API key — review the key\'s policies'
        : text.includes('INVALID_PASSPHRASE')
          ? 'the resolved credential is not this vault\'s passphrase — check the credential your keyRef references'
          : text.includes('API_KEY_EXPIRED')
            ? 'the resolved ows_key_… API token has expired — issue a new one and update the referenced credential'
            : text.includes('API_KEY_NOT_FOUND')
              ? 'the resolved ows_key_… API token does not resolve to a key — it may have been revoked'
              : text.includes('CHAIN_NOT_SUPPORTED') || text.includes('CAIP_PARSE_ERROR')
                ? `OWS has no signer for chain "${chain}"`
                : text
  return new Error(`dsh-wallet-ethereum: ${operation} failed for wallet "${wallet}" on "${chain}": ${advice}`, { cause })
}

/** Narrow adapter-opaque key material back to the context this adapter minted. */
function asOwsContext(keyMaterial: unknown): OwsKeyContext {
  const context = keyMaterial as OwsKeyContext | null
  if (
    context === null || typeof context !== 'object'
    || typeof context.wallet !== 'string' || typeof context.chain !== 'string'
  ) {
    throw new TypeError(
      'dsh-wallet-ethereum: keyMaterial was not produced by this adapter\'s loadKey — '
      + 'key material is operation-scoped and must not cross adapters',
    )
  }
  return context
}

/** Pick the account matching one chain family off a vault wallet. */
function accountAddress(info: OwsWalletInfo, chain: string, wallet: string): WalletAddress {
  const prefix = CHAIN_FAMILY_PREFIXES[chain]
  if (prefix === undefined) {
    throw new Error(
      `dsh-wallet-ethereum: unknown chain family "${chain}" `
      + `(known: ${Object.keys(CHAIN_FAMILY_PREFIXES).join(', ')})`,
    )
  }
  const account = info.accounts.find(candidate => candidate.chainId.startsWith(prefix))
  if (account === undefined) {
    throw new Error(
      `dsh-wallet-ethereum: OWS wallet "${wallet}" has no ${chain} account `
      + `(accounts: ${info.accounts.map(candidate => candidate.chainId).join(', ') || 'none'})`,
    )
  }
  return account.address
}

/**
 * The OWS-backed `CryptoAdapter`. One instance serves one chain family;
 * construction is cheap and holds no secrets — every method builds its state
 * from the operation-scoped inputs.
 */
export class OwsEthereumCryptoAdapter implements CryptoAdapter {
  constructor(
    private readonly signer: OwsSigner,
    private readonly chain: string,
    private readonly options: { accountIndex: number; vaultPath?: string },
  ) {}

  /**
   * Resolve wallet identity and mint the operation-scoped session descriptor.
   * @param source - wallet selector, chain, and the operation's credential.
   * @returns the chain-native address and the typed OWS context.
   */
  async loadKey(source: WalletKeySource): Promise<{ address: WalletAddress; keyMaterial: unknown }> {
    let info: OwsWalletInfo
    try {
      info = this.signer.getWallet(source.wallet, this.options.vaultPath)
    } catch (cause) {
      throw translateOwsError('loadKey', source.wallet, source.chain, cause)
    }
    const address = accountAddress(info, source.chain, source.wallet)
    const keyMaterial: OwsKeyContext = {
      wallet: info.id,
      chain: source.chain,
      address,
      accountIndex: this.options.accountIndex,
      ...source.secret === undefined ? {} : { credential: source.secret },
      ...this.options.vaultPath === undefined ? {} : { vaultPath: this.options.vaultPath },
    }
    return { address, keyMaterial }
  }

  /**
   * Sign a message through OWS (EIP-191 semantics on EVM chains).
   * @param keyMaterial - the {@link OwsKeyContext} minted by this operation's loadKey.
   * @param payload - message text to sign.
   * @returns the hex-encoded signature.
   */
  async signMessage(keyMaterial: unknown, payload: string): Promise<WalletSignature> {
    const context = asOwsContext(keyMaterial)
    try {
      const result = this.signer.signMessage(
        context.wallet,
        context.chain,
        payload,
        context.credential,
        undefined,
        context.accountIndex,
        context.vaultPath,
      )
      return result.signature
    } catch (cause) {
      throw translateOwsError('signMessage', context.wallet, context.chain, cause)
    }
  }

  /**
   * Sign a serialized transaction through OWS — sign-only, never
   * `signAndSend` (broadcast is the caller's separate concern).
   * @param keyMaterial - the {@link OwsKeyContext} minted by this operation's loadKey.
   * @param payload - hex-encoded serialized transaction bytes.
   * @returns the hex-encoded signature / signed payload.
   */
  async signTransaction(keyMaterial: unknown, payload: string): Promise<WalletSignature> {
    const context = asOwsContext(keyMaterial)
    try {
      const result = this.signer.signTransaction(
        context.wallet,
        context.chain,
        payload,
        context.credential,
        context.accountIndex,
        context.vaultPath,
      )
      return result.signature
    } catch (cause) {
      throw translateOwsError('signTransaction', context.wallet, context.chain, cause)
    }
  }
}

/**
 * Register the OWS adapter for each configured chain family. The signer
 * resolves once at mount ({@link internals} override first, native bindings
 * otherwise) and registrations unwind with the plugin.
 * @param ctx - plugin context carrying the wallet seam.
 * @param config - validated configuration.
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const chains = [...new Set(config.chains ?? ['evm'])]
  const accountIndex = config.accountIndex ?? 0
  if (!Number.isInteger(accountIndex) || accountIndex < 0) {
    throw new Error(`dsh-wallet-ethereum: accountIndex must be a non-negative integer, got ${accountIndex}`)
  }
  const signer = internals.signer ?? await loadOwsSigner()
  for (const chain of chains) {
    if (CHAIN_FAMILY_PREFIXES[chain] === undefined) {
      throw new Error(
        `dsh-wallet-ethereum: unknown chain family "${chain}" `
        + `(known: ${Object.keys(CHAIN_FAMILY_PREFIXES).join(', ')})`,
      )
    }
    const adapter = new OwsEthereumCryptoAdapter(signer, chain, {
      accountIndex,
      ...config.vaultPath === undefined ? {} : { vaultPath: config.vaultPath },
    })
    ctx.effect(() => ctx.wallet.register(chain, adapter))
  }
}
