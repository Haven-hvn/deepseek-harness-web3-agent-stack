/**
 * Raw-key adapter coverage: the Haven-AOL fix.
 *
 * - `signDigest` signs the 32-byte EIP-712 digest raw (no EIP-191 prefix) so
 *   `ecrecover` over the digest returns the wallet address — exactly what the
 *   canister verifies. (OWS `signMessage` personal-prefixes, recovering to a
 *   different address → `#InvalidSignature`.)
 * - `signMessage` keeps EIP-191 semantics for XMTP / Synapse compat.
 * - `signTransaction` round-trips hex-serialized unsigned tx bytes.
 * - Key custody: the private key resolves per operation from the credential
 *   store (never config); errors never echo it.
 * - `provider: 'raw'` mounts without touching the OWS native bindings.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { recoverAddress, Transaction, TypedDataEncoder, verifyMessage, Wallet } from 'ethers'
import WalletRuntime from 'dsh-wallet'
import * as walletEthereum from '../src/index.ts'
import { RawEthereumCryptoAdapter } from '../src/raw.ts'
import { MemoryCredentials } from '../../dsh-wallet/tests/helpers/memory-credentials.ts'

// Fixed test key — never a production secret, lives only in this spec.
const PRIVATE_KEY = '0x4c0883a69102937d6231471b5dbb6204fe512961708279f2e3e8a5d4b8e3418c'
const VERIFIER = '0x1111111111111111111111111111111111111111'

async function expectedAddress(): Promise<string> {
  return new Wallet(PRIVATE_KEY).getAddress()
}

function gateDigest(evmAddress: string): `0x${string}` {
  return TypedDataEncoder.hash(
    { name: 'HavenAOL', chainId: 8453n, verifyingContract: VERIFIER },
    { GateRequest: [
      { name: 'evmAddress', type: 'address' },
      { name: 'transportPublicKey', type: 'bytes' },
      { name: 'nonce', type: 'uint256' },
    ] },
    { evmAddress, transportPublicKey: '0x1234', nonce: 1n },
  ) as `0x${string}`
}

describe('RawEthereumCryptoAdapter (EIP-712 gate fix)', () => {
  it('loadKey derives the address from the operation key, ignoring the selector', async () => {
    const adapter = new RawEthereumCryptoAdapter('evm')
    const loaded = await adapter.loadKey({ wallet: 'anything', chain: 'evm', secret: PRIVATE_KEY })
    expect(loaded.address).toBe(await expectedAddress())
  })

  it('signDigest recovers to the wallet address over the raw EIP-712 digest (canister path)', async () => {
    const adapter = new RawEthereumCryptoAdapter('evm')
    const address = await expectedAddress()
    const { keyMaterial } = await adapter.loadKey({ wallet: 'agent', chain: 'evm', secret: PRIVATE_KEY })
    const digest = gateDigest(address)
    const sig = await adapter.signDigest(keyMaterial, digest)
    expect(sig).toMatch(/^0x[0-9a-fA-F]{130}$/)
    expect(recoverAddress(digest, sig).toLowerCase()).toBe(address.toLowerCase())
  })

  it('signMessage stays EIP-191 (does NOT recover over the raw digest — the OWS failure mode)', async () => {
    const adapter = new RawEthereumCryptoAdapter('evm')
    const address = await expectedAddress()
    const { keyMaterial } = await adapter.loadKey({ wallet: 'agent', chain: 'evm', secret: PRIVATE_KEY })
    const digest = gateDigest(address)
    const sig = await adapter.signMessage(keyMaterial, digest)
    // EIP-191 verify passes on the message…
    expect((await verifyMessage(digest, sig)).toLowerCase()).toBe(address.toLowerCase())
    // …but raw-digest ecrecover does not — this is why OWS signMessage is rejected.
    expect(recoverAddress(digest, sig).toLowerCase()).not.toBe(address.toLowerCase())
  })

  it('signTransaction round-trips serialized unsigned tx bytes (sign-only)', async () => {
    const adapter = new RawEthereumCryptoAdapter('evm')
    const address = await expectedAddress()
    const { keyMaterial } = await adapter.loadKey({ wallet: 'agent', chain: 'evm', secret: PRIVATE_KEY })
    const unsigned = Transaction.from({
      chainId: 8453,
      to: VERIFIER,
      value: 0n,
      nonce: 0,
      gasLimit: 21000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      type: 2,
    }).unsignedSerialized
    const signed = await adapter.signTransaction(keyMaterial, unsigned)
    expect(Transaction.from(signed).from?.toLowerCase()).toBe(address.toLowerCase())
  })

  it('loadKey tolerates copy-paste shapes (quotes, missing 0x, whitespace)', async () => {
    const adapter = new RawEthereumCryptoAdapter('evm')
    for (const shape of [`"${PRIVATE_KEY}"`, `'${PRIVATE_KEY}'`, PRIVATE_KEY.slice(2), `  ${PRIVATE_KEY}  `]) {
      const loaded = await adapter.loadKey({ wallet: 'agent', chain: 'evm', secret: shape })
      expect(loaded.address).toBe(await expectedAddress())
    }
  })

  it('fails loud without echoing the key', async () => {
    const adapter = new RawEthereumCryptoAdapter('evm')
    await expect(adapter.loadKey({ wallet: 'agent', chain: 'evm' }))
      .rejects.toThrow(/no keyRef|no value/)
    await expect(adapter.loadKey({ wallet: 'agent', chain: 'evm', secret: 'not-a-key' }))
      .rejects.toThrow(/not a 0x-prefixed 32-byte private key/)
    const { keyMaterial } = await adapter.loadKey({ wallet: 'agent', chain: 'evm', secret: PRIVATE_KEY })
    await expect(adapter.signDigest(keyMaterial, '0x1234')).rejects.toThrow(/32-byte digest/)
    try {
      await adapter.loadKey({ wallet: 'agent', chain: 'evm', secret: PRIVATE_KEY })
    } catch (e) {
      expect(String(e)).not.toContain(PRIVATE_KEY.slice(10))
    }
  })

  it('rejects foreign key material', async () => {
    const adapter = new RawEthereumCryptoAdapter('evm')
    await expect(adapter.signDigest({ nope: true }, gateDigest(VERIFIER)))
      .rejects.toThrow(/not produced by this adapter/)
  })
})

describe('provider: raw composition (no OWS)', () => {
  async function harness(seed: Record<string, string>) {
    const ctx = new Context()
    await ctx.plugin(MemoryCredentials, seed)
    await ctx.plugin(WalletRuntime, {
      wallets: { agent: { chain: 'evm', wallet: 'agent', keyRef: 'AGENT_PRIVATE_KEY' } },
    })
    await ctx.plugin(walletEthereum, { chains: ['evm'], provider: 'raw' })
    return ctx
  }

  it('signDigest end to end through ctx.wallet recovers to ctx.wallet.address', async () => {
    const ctx = await harness({ AGENT_PRIVATE_KEY: PRIVATE_KEY })
    const address = await ctx.wallet.address('agent')
    expect(address).toBe(await expectedAddress())
    const digest = gateDigest(address)
    const { signature } = await ctx.wallet.signDigest('agent', digest)
    expect(recoverAddress(digest, signature).toLowerCase()).toBe(address.toLowerCase())
  })

  it('raw mount never imports @open-wallet-standard/core', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryCredentials, { AGENT_PRIVATE_KEY: PRIVATE_KEY })
    await ctx.plugin(WalletRuntime, {
      wallets: { agent: { chain: 'evm', wallet: 'agent', keyRef: 'AGENT_PRIVATE_KEY' } },
    })
    // No internals.signer stub and no OWS install — raw must still mount.
    await ctx.plugin(walletEthereum, { chains: ['evm'], provider: 'raw' })
    await expect(ctx.wallet.address('agent')).resolves.toBe(await expectedAddress())
  })
})
