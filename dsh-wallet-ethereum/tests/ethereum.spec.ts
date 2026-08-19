/**
 * Contract-parity coverage for the OWS-backed adapter (migration-plan test
 * plan: wallet resolution, deterministic signature shape, sign-only
 * transactions, and clear error propagation for wallet-not-found /
 * policy-denied paths), plus the end-to-end seam flow: a CredentialRef
 * resolved by dsh-wallet arrives at OWS as the per-call credential.
 * The OWS SDK boundary is mocked through the package's `internals` seam.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WalletRuntime from 'dsh-wallet'
import * as walletEthereum from '../src/index.ts'
import { OwsEthereumCryptoAdapter, internals } from '../src/index.ts'
import type { OwsSigner, OwsWalletInfo } from '../src/ows.ts'
import { MemoryCredentials } from '../../dsh-wallet/tests/helpers/memory-credentials.ts'

const VAULT_WALLET: OwsWalletInfo = {
  id: 'a81c8f7e-2b1f-4d21-9f6a-58c6f3d3a001',
  name: 'agent-treasury',
  accounts: [
    { chainId: 'eip155:1', address: '0xCc1e2c3D077b7c0f5301ef400bDE30d0e23dF1C6', derivationPath: "m/44'/60'/0'/0/0" },
    { chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', address: 'DzkqyvQrBvLq', derivationPath: "m/44'/501'/0'/0'" },
  ],
}

/** Scripted OWS fake recording every call it receives. */
class FakeOws implements OwsSigner {
  readonly calls: { fn: string; args: unknown[] }[] = []
  failWith: string | undefined

  getWallet(nameOrId: string, vaultPath?: string): OwsWalletInfo {
    this.calls.push({ fn: 'getWallet', args: [nameOrId, vaultPath] })
    if (this.failWith !== undefined) throw new Error(this.failWith)
    if (nameOrId !== VAULT_WALLET.name && nameOrId !== VAULT_WALLET.id) {
      throw new Error('WALLET_NOT_FOUND: no wallet with the given ID exists')
    }
    return VAULT_WALLET
  }

  signMessage(...args: unknown[]): { signature: string; recoveryId?: number } {
    this.calls.push({ fn: 'signMessage', args })
    if (this.failWith !== undefined) throw new Error(this.failWith)
    return { signature: '0xmessagesig', recoveryId: 1 }
  }

  signTransaction(...args: unknown[]): { signature: string; recoveryId?: number } {
    this.calls.push({ fn: 'signTransaction', args })
    if (this.failWith !== undefined) throw new Error(this.failWith)
    return { signature: '0xtxsig' }
  }
}

afterEach(() => {
  internals.signer = undefined
})

describe('OwsEthereumCryptoAdapter contract parity', () => {
  const options = { accountIndex: 0 }

  it('loadKey resolves wallet identity and picks the chain-family account', async () => {
    const ows = new FakeOws()
    const adapter = new OwsEthereumCryptoAdapter(ows, 'evm', options)
    const loaded = await adapter.loadKey({ wallet: 'agent-treasury', chain: 'evm', secret: 'pw' })
    expect(loaded.address).toBe('0xCc1e2c3D077b7c0f5301ef400bDE30d0e23dF1C6')
    // keyMaterial is a typed session descriptor — never key bytes.
    expect(loaded.keyMaterial).toMatchObject({
      wallet: VAULT_WALLET.id,
      chain: 'evm',
      credential: 'pw',
      accountIndex: 0,
    })
  })

  it('loadKey translates WALLET_NOT_FOUND into an actionable message', async () => {
    const adapter = new OwsEthereumCryptoAdapter(new FakeOws(), 'evm', options)
    await expect(adapter.loadKey({ wallet: 'ghost', chain: 'evm' }))
      .rejects.toThrow(/no OWS vault wallet named "ghost" exists/)
  })

  it('loadKey fails loud when the vault wallet lacks the requested family', async () => {
    const adapter = new OwsEthereumCryptoAdapter(new FakeOws(), 'bitcoin', options)
    await expect(adapter.loadKey({ wallet: 'agent-treasury', chain: 'bitcoin' }))
      .rejects.toThrow(/has no bitcoin account/)
  })

  it('signMessage delegates to OWS with the operation credential and account index', async () => {
    const ows = new FakeOws()
    const adapter = new OwsEthereumCryptoAdapter(ows, 'evm', { accountIndex: 2, vaultPath: '/tmp/vault' })
    const { keyMaterial } = await adapter.loadKey({ wallet: 'agent-treasury', chain: 'evm', secret: 'ows_key_abc' })
    await expect(adapter.signMessage(keyMaterial, 'hello')).resolves.toBe('0xmessagesig')
    expect(ows.calls.at(-1)).toEqual({
      fn: 'signMessage',
      args: [VAULT_WALLET.id, 'evm', 'hello', 'ows_key_abc', undefined, 2, '/tmp/vault'],
    })
  })

  it('signTransaction is sign-only: delegates to signTransaction, never signAndSend', async () => {
    const ows = new FakeOws()
    const adapter = new OwsEthereumCryptoAdapter(ows, 'evm', options)
    const { keyMaterial } = await adapter.loadKey({ wallet: 'agent-treasury', chain: 'evm', secret: 'pw' })
    await expect(adapter.signTransaction(keyMaterial, '02f8deadbeef')).resolves.toBe('0xtxsig')
    expect(ows.calls.at(-1)).toEqual({
      fn: 'signTransaction',
      args: [VAULT_WALLET.id, 'evm', '02f8deadbeef', 'pw', 0, undefined],
    })
    expect(ows.calls.every(call => call.fn !== 'signAndSend')).toBe(true)
  })

  it('translates POLICY_DENIED and credential failures into actionable messages', async () => {
    const ows = new FakeOws()
    const adapter = new OwsEthereumCryptoAdapter(ows, 'evm', options)
    const { keyMaterial } = await adapter.loadKey({ wallet: 'agent-treasury', chain: 'evm', secret: 'pw' })

    ows.failWith = 'POLICY_DENIED: Request was rejected by the policy engine'
    await expect(adapter.signMessage(keyMaterial, 'x')).rejects.toThrow(/policy engine denied/)

    ows.failWith = 'INVALID_PASSPHRASE: Vault passphrase was incorrect'
    await expect(adapter.signMessage(keyMaterial, 'x')).rejects.toThrow(/not this vault's passphrase/)

    ows.failWith = 'API_KEY_EXPIRED: The API key has expired'
    await expect(adapter.signTransaction(keyMaterial, '02f8')).rejects.toThrow(/has expired/)
  })

  it('rejects key material minted by a different adapter', async () => {
    const adapter = new OwsEthereumCryptoAdapter(new FakeOws(), 'evm', options)
    await expect(adapter.signMessage({ some: 'foreign material' }, 'x'))
      .rejects.toThrow(/not produced by this adapter/)
  })
})

describe('plugin composition over the wallet seam', () => {
  async function harness(seed: Record<string, string>) {
    const ows = new FakeOws()
    internals.signer = ows
    const ctx = new Context()
    await ctx.plugin(MemoryCredentials, seed)
    await ctx.plugin(WalletRuntime, {
      wallets: { treasury: { chain: 'evm', wallet: 'agent-treasury', keyRef: 'OWS_CREDENTIAL' } },
    })
    await ctx.plugin(walletEthereum, { chains: ['evm'] })
    return { ctx, ows }
  }

  it('signs end to end: CredentialRef resolves per operation and reaches OWS as the credential', async () => {
    const { ctx, ows } = await harness({ OWS_CREDENTIAL: 'ows_key_live_token' })
    const result = await ctx.wallet.signMessage('treasury', 'attest')
    expect(result).toEqual({
      address: '0xCc1e2c3D077b7c0f5301ef400bDE30d0e23dF1C6',
      signature: '0xmessagesig',
    })
    const sign = ows.calls.find(call => call.fn === 'signMessage')
    expect(sign?.args[3]).toBe('ows_key_live_token')
  })

  it('registers only configured chain families and rejects unknown ones at load', async () => {
    internals.signer = new FakeOws()
    const ctx = new Context()
    await ctx.plugin(MemoryCredentials, {})
    await ctx.plugin(WalletRuntime, { wallets: {} })
    await expect(ctx.plugin(walletEthereum, { chains: ['evm', 'plasma'] }))
      .rejects.toThrow(/unknown chain family "plasma"/)
  })

  it('rejects a negative accountIndex at load', async () => {
    internals.signer = new FakeOws()
    const ctx = new Context()
    await ctx.plugin(MemoryCredentials, {})
    await ctx.plugin(WalletRuntime, { wallets: {} })
    await expect(ctx.plugin(walletEthereum, { accountIndex: -1 }))
      .rejects.toThrow(/accountIndex must be a non-negative integer/)
  })
})
