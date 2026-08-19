/**
 * Seam proof for dsh-wallet: the credential behind a wallet resolves through
 * `ctx.credentials` ONLY at the operation boundary — never at plugin load,
 * never from configuration, never cached across operations — and raw key
 * material cannot enter configuration at all.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import WalletRuntime from '../src/index.ts'
import type { WalletError } from '../src/index.ts'
import type { CryptoAdapter, WalletKeySource } from '../src/types.ts'
import type { WalletSignedEvent } from '../src/types.ts'
import { MemoryCredentials } from './helpers/memory-credentials.ts'

/**
 * Recording fake adapter: captures every loadKey source and sign payload so
 * the suite can assert exactly WHEN secrets were materialized and WHAT the
 * provider saw. Address derivation is deterministic from the wallet selector.
 */
class FakeAdapter implements CryptoAdapter {
  readonly loadKeyCalls: WalletKeySource[] = []
  readonly signedPayloads: { kind: 'message' | 'transaction'; material: unknown; payload: string }[] = []

  async loadKey(source: WalletKeySource): Promise<{ address: string; keyMaterial: unknown }> {
    this.loadKeyCalls.push(source)
    return {
      address: `0xaddr-${source.wallet}`,
      keyMaterial: { session: source.wallet, secret: source.secret },
    }
  }

  async signMessage(keyMaterial: unknown, payload: string): Promise<string> {
    this.signedPayloads.push({ kind: 'message', material: keyMaterial, payload })
    return '0xsig-message'
  }

  async signTransaction(keyMaterial: unknown, payload: string): Promise<string> {
    this.signedPayloads.push({ kind: 'transaction', material: keyMaterial, payload })
    return '0xsig-transaction'
  }
}

/** Mount credentials + wallet runtime with one configured wallet. */
async function harness(options?: {
  seed?: Record<string, string>
  wallets?: Record<string, { chain: string; wallet: string; keyRef?: string }>
}) {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials, options?.seed ?? {})
  await ctx.plugin(WalletRuntime, {
    wallets: options?.wallets ?? {
      treasury: { chain: 'evm', wallet: 'agent-treasury', keyRef: 'HAVEN_WALLET_PASSPHRASE' },
    },
  })
  const adapter = new FakeAdapter()
  const dispose = ctx.wallet.register('evm', adapter)
  return { ctx, adapter, dispose }
}

describe('configuration can never carry a key', () => {
  it('rejects a raw hex private key where a keyRef belongs, at plugin load', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryCredentials, {})
    await expect(ctx.plugin(WalletRuntime, {
      wallets: {
        hot: {
          chain: 'evm',
          wallet: 'w',
          // A pasted 64-hex private key — syntactically impossible as a CredentialRef.
          keyRef: '0x4c0883a69102937d6231471b5dbb6204fe512961708279f2e3e8a5d4b8e3418c',
        },
      },
    })).rejects.toThrow(/not a credential reference/)
  })

  it('does not echo the rejected value back in the diagnostic', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryCredentials, {})
    const secret = '0x4c0883a69102937d6231471b5dbb6204fe512961708279f2e3e8a5d4b8e3418c'
    const failure = await ctx.plugin(WalletRuntime, {
      wallets: { hot: { chain: 'evm', wallet: 'w', keyRef: secret } },
    }).then(() => undefined, (error: unknown) => error as Error)
    expect(failure).toBeDefined()
    // The message stays actionable while quoting at most a truncated prefix.
    expect(failure?.message).not.toContain(secret)
    expect(failure?.message).toContain('never the secret itself')
  })

  it('rejects other non-reference shapes (spaces, ows tokens with dashes)', async () => {
    for (const keyRef of ['my passphrase', 'ows_key_a1b2-c3d4', 'goose puzzle decorate much']) {
      const ctx = new Context()
      await ctx.plugin(MemoryCredentials, {})
      await expect(ctx.plugin(WalletRuntime, {
        wallets: { w: { chain: 'evm', wallet: 'w', keyRef } },
      })).rejects.toThrow(/not a credential reference/)
    }
  })
})

describe('the key resolves only at the operation boundary', () => {
  it('never touches ctx.credentials at plugin load or adapter registration', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryCredentials, { HAVEN_WALLET_PASSPHRASE: 'hunter2' })
    const resolve = vi.spyOn(MemoryCredentials.prototype, 'resolve')
    try {
      await ctx.plugin(WalletRuntime, {
        wallets: { treasury: { chain: 'evm', wallet: 'agent-treasury', keyRef: 'HAVEN_WALLET_PASSPHRASE' } },
      })
      ctx.wallet.register('evm', new FakeAdapter())
      ctx.wallet.list()
      // Mounting, registering, and describing resolve nothing.
      expect(resolve).not.toHaveBeenCalled()
    } finally {
      resolve.mockRestore()
    }
  })

  it('resolves exactly once per signing operation and hands the value to the adapter', async () => {
    const { ctx, adapter } = await harness({ seed: { HAVEN_WALLET_PASSPHRASE: 'hunter2' } })
    const resolve = vi.spyOn(ctx.credentials, 'resolve')

    const first = await ctx.wallet.signMessage('treasury', 'hello world')
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(adapter.loadKeyCalls).toHaveLength(1)
    expect(adapter.loadKeyCalls[0]).toEqual({ wallet: 'agent-treasury', chain: 'evm', secret: 'hunter2' })
    expect(first).toEqual({ address: '0xaddr-agent-treasury', signature: '0xsig-message' })

    await ctx.wallet.signTransaction('treasury', '02f8deadbeef')
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(adapter.loadKeyCalls).toHaveLength(2)
  })

  it('sees a rotated credential on the very next operation (no caching)', async () => {
    const { ctx, adapter } = await harness({ seed: { HAVEN_WALLET_PASSPHRASE: 'before-rotation' } })
    await ctx.wallet.signMessage('treasury', 'one')
    expect(adapter.loadKeyCalls[0]?.secret).toBe('before-rotation')

    await ctx.credentials.set(credentialRef('HAVEN_WALLET_PASSPHRASE'), 'after-rotation')
    await ctx.wallet.signMessage('treasury', 'two')
    expect(adapter.loadKeyCalls[1]?.secret).toBe('after-rotation')
  })

  it('fails loud before touching the adapter when the reference is unconfigured', async () => {
    const { ctx, adapter } = await harness({ seed: {} })
    const failure = await ctx.wallet.signMessage('treasury', 'x')
      .then(() => undefined, (error: unknown) => error as WalletError)
    expect(failure?.code).toBe('credential-unconfigured')
    expect(adapter.loadKeyCalls).toHaveLength(0)
  })

  it('omits the secret entirely for a wallet with no keyRef', async () => {
    const { ctx, adapter } = await harness({
      wallets: { anon: { chain: 'evm', wallet: 'no-passphrase-wallet' } },
    })
    const resolve = vi.spyOn(ctx.credentials, 'resolve')
    await ctx.wallet.signMessage('anon', 'x')
    expect(resolve).not.toHaveBeenCalled()
    expect(adapter.loadKeyCalls[0]).toEqual({ wallet: 'no-passphrase-wallet', chain: 'evm' })
  })
})

describe('seam mechanics', () => {
  it('emits wallet/signed with identity facts only, after the adapter returned', async () => {
    const { ctx } = await harness({ seed: { HAVEN_WALLET_PASSPHRASE: 's3cret' } })
    const events: WalletSignedEvent[] = []
    ctx.on('wallet/signed', (event) => { events.push(event) })

    await ctx.wallet.signTransaction('treasury', '02f8')
    expect(events).toEqual([{
      wallet: 'treasury',
      chain: 'evm',
      operation: 'sign-transaction',
      address: '0xaddr-agent-treasury',
    }])
    // Nothing secret-shaped rides the event.
    expect(JSON.stringify(events)).not.toContain('s3cret')
  })

  it('address() runs the same per-operation pipeline', async () => {
    const { ctx, adapter } = await harness({ seed: { HAVEN_WALLET_PASSPHRASE: 'pw' } })
    await expect(ctx.wallet.address('treasury')).resolves.toBe('0xaddr-agent-treasury')
    expect(adapter.loadKeyCalls).toHaveLength(1)
  })

  it('fails loud on unknown wallets and unregistered chains', async () => {
    const { ctx, dispose } = await harness({ seed: { HAVEN_WALLET_PASSPHRASE: 'pw' } })
    await expect(ctx.wallet.signMessage('nope', 'x'))
      .rejects.toMatchObject({ name: 'WalletError', code: 'wallet-not-found' })

    dispose()
    await expect(ctx.wallet.signMessage('treasury', 'x'))
      .rejects.toMatchObject({ name: 'WalletError', code: 'chain-unsupported' })
  })

  it('register() disposers are stale-safe and duplicates fail loud', async () => {
    const { ctx, adapter, dispose } = await harness({ seed: { HAVEN_WALLET_PASSPHRASE: 'pw' } })
    expect(() => ctx.wallet.register('evm', new FakeAdapter()))
      .toThrow(/already registered/)

    dispose()
    const replacement = new FakeAdapter()
    const disposeReplacement = ctx.wallet.register('evm', replacement)
    // The FIRST registration's disposer fires again: it must not remove the successor.
    dispose()
    await ctx.wallet.signMessage('treasury', 'x')
    expect(replacement.loadKeyCalls).toHaveLength(1)
    expect(adapter.loadKeyCalls).toHaveLength(0)
    disposeReplacement()
  })

  it('list() reports configuration facts, never values', async () => {
    const { ctx } = await harness({ seed: { HAVEN_WALLET_PASSPHRASE: 'pw' } })
    expect(ctx.wallet.list()).toEqual([{
      name: 'treasury',
      chain: 'evm',
      wallet: 'agent-treasury',
      keyRefConfigured: true,
      adapterRegistered: true,
    }])
  })
})
