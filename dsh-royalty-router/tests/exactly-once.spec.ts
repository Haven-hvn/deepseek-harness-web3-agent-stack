/**
 * Exactly-once proofs for dsh-royalty-router execute tools.
 *
 * No network, no harness: the attempt ledger (`ExecuteLedger`) runs against
 * injected send/verify callbacks, the commit-point read-backs
 * (`verifyLaunch`/`verifySweep`) run against a stubbed viem client, and the
 * hook factory (`createExecuteHooks`) runs over both. The fork suites cover
 * the live path.
 */

import { describe, expect, it } from 'vitest'
import { createExecuteHooks } from '../src/index.ts'
import { resolveDeployment } from '../src/chain.ts'
import { withWalletLane } from '../src/wallet.ts'
import {
  ExecuteLedger,
  heartbeatKeyFor,
  launchKeyFor,
  sweepKeyFor,
  verifyLaunch,
  verifySweep,
} from '../src/tools.ts'

const WETH = '0x4200000000000000000000000000000000000006'
const FEE_RECIPIENT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const ROUTER = '0x1111111111111111111111111111111111111111'

function geometricArgs() {
  return {
    name: 'Test Token',
    symbol: 'TT',
    reserveToken: WETH,
    feeRecipient: FEE_RECIPIENT,
    curve: {
      freeRange: '1000000000000000000000',
      maxSupply: '1000000000000000000000000',
      startPrice: '100000000000000',
      endPrice: '1000000000000000',
    },
  }
}

function deployment() {
  return resolveDeployment({ rpcUrl: 'https://mainnet.base.org', chainId: 8453 })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type AnyVerify = () => Promise<
  | { state: 'committed'; value: any }
  | { state: 'absent' }
  | { state: 'unreadable' }
>

function runOpts(overrides: { timeoutMs?: number; verify?: AnyVerify } = {}) {
  return {
    timeoutMs: 1_000,
    onTimeout: (ms: number) => new Error(`timed out after ${ms}ms`),
    ...overrides,
  }
}

describe('attempt keys', () => {
  it('launch keys are stable per intent and shade every field', () => {
    expect(launchKeyFor(geometricArgs())).toBe(launchKeyFor(geometricArgs()))
    expect(launchKeyFor({ ...geometricArgs(), symbol: 'OTHER' })).not.toBe(launchKeyFor(geometricArgs()))
    expect(launchKeyFor({ ...geometricArgs(), mintRoyaltyBps: 500 })).not.toBe(launchKeyFor(geometricArgs()))
    expect(() => launchKeyFor({ name: 'x', symbol: 'X', reserveToken: WETH, feeRecipient: FEE_RECIPIENT } as never))
      .toThrow('either curve')
  })

  it('sweep and heartbeat keys normalize routers and shade the floor', () => {
    expect(sweepKeyFor({ router: FEE_RECIPIENT })).toBe(sweepKeyFor({ router: FEE_RECIPIENT.toLowerCase(), minOut: '0' }))
    expect(sweepKeyFor({ router: ROUTER })).not.toBe(sweepKeyFor({ router: ROUTER, minOut: '100' }))
    expect(heartbeatKeyFor({ router: FEE_RECIPIENT })).toBe(heartbeatKeyFor({ router: FEE_RECIPIENT.toLowerCase() }))
    expect(() => sweepKeyFor({ router: 'nope' })).toThrow('0x-prefixed 20-byte address')
  })
})

describe('ExecuteLedger', () => {
  it('sends once and replays settled runs', async () => {
    const ledger = new ExecuteLedger()
    let sends = 0
    const send = async () => {
      sends += 1
      return { hash: '0xabc' }
    }
    const first = await ledger.run('k', send, runOpts())
    expect(first).toEqual({ value: { hash: '0xabc' }, source: 'sent' })
    const second = await ledger.run('k', send, runOpts())
    expect(second).toEqual({ value: { hash: '0xabc' }, source: 'ledger' })
    expect(sends).toBe(1)
    expect(ledger.peek('k')).toEqual({ kind: 'replay', value: { hash: '0xabc' } })
    expect(ledger.peek('missing')).toBeUndefined()
  })

  it('concurrent runs attach to one send', async () => {
    const ledger = new ExecuteLedger()
    let sends = 0
    const gate = deferred<string>()
    const send = async () => {
      sends += 1
      return gate.promise
    }
    const first = ledger.run('k', send, runOpts())
    const second = ledger.run('k', send, runOpts())
    expect(ledger.peek('k')).toEqual({ kind: 'unknown' }) // in flight
    gate.resolve('v')
    await expect(first).resolves.toEqual({ value: 'v', source: 'sent' })
    await expect(second).resolves.toEqual({ value: 'v', source: 'ledger' })
    expect(sends).toBe(1)
  })

  it('a timeout leaves the send live; the retry finds the late result', async () => {
    const ledger = new ExecuteLedger()
    let sends = 0
    const send = async () => {
      sends += 1
      await new Promise(done => setTimeout(done, 60))
      return 'late'
    }
    await expect(ledger.run('k', send, runOpts({ timeoutMs: 20 }))).rejects.toThrow('timed out after 20ms')
    await new Promise(done => setTimeout(done, 100)) // the raced send settles late
    await expect(ledger.run('k', send, runOpts())).resolves.toEqual({ value: 'late', source: 'ledger' })
    expect(sends).toBe(1)
  })

  it('a failed send retries instead of replaying', async () => {
    const ledger = new ExecuteLedger()
    let sends = 0
    const send = async () => {
      sends += 1
      if (sends === 1) throw new Error('reverted')
      return 'ok'
    }
    await expect(ledger.run('k', send, runOpts())).rejects.toThrow('reverted')
    expect(ledger.peek('k')).toBeUndefined()
    await expect(ledger.run('k', send, runOpts())).resolves.toEqual({ value: 'ok', source: 'sent' })
    expect(sends).toBe(2)
  })

  it('a synchronously throwing send rejects and stays retryable', async () => {
    const ledger = new ExecuteLedger()
    let sends = 0
    const send = () => {
      sends += 1
      if (sends === 1) throw new Error('invalid intent')
      return Promise.resolve('ok')
    }
    await expect(ledger.run('k', send, runOpts())).rejects.toThrow('invalid intent')
    await expect(ledger.run('k', send, runOpts())).resolves.toEqual({ value: 'ok', source: 'sent' })
    expect(sends).toBe(2)
  })

  it('verify-committed short-circuits without sending', async () => {
    const ledger = new ExecuteLedger()
    let sends = 0
    const run = () => ledger.run('k', async () => {
      sends += 1
      return 'sent-value'
    }, runOpts({ verify: async () => ({ state: 'committed', value: 'chain-value' }) }))
    await expect(run()).resolves.toEqual({ value: 'chain-value', source: 'verified' })
    expect(sends).toBe(0)
    await expect(run()).resolves.toEqual({ value: 'chain-value', source: 'ledger' })
    expect(sends).toBe(0)
  })

  it('verify-absent, verify-unreadable, and verify-throws all fall through to the send', async () => {
    for (const verify of [
      async () => ({ state: 'absent' as const }),
      async () => ({ state: 'unreadable' as const }),
      async () => { throw new Error('rpc down') },
    ]) {
      const ledger = new ExecuteLedger()
      let sends = 0
      const result = await ledger.run('k', async () => {
        sends += 1
        return 'sent-value'
      }, runOpts({ verify }))
      expect(result).toEqual({ value: 'sent-value', source: 'sent' })
      expect(sends).toBe(1)
    }
  })
})

describe('withWalletLane', () => {
  it('serializes through withLock when the seam provides it', async () => {
    const lanes: string[] = []
    const ctx = { wallet: { withLock: async (name: string, task: () => Promise<string>) => {
      lanes.push(name)
      return task()
    } } }
    await expect(withWalletLane(ctx, 'agent', async () => 'v')).resolves.toBe('v')
    expect(lanes).toEqual(['agent'])
  })

  it('runs direct where the seam predates withLock', async () => {
    await expect(withWalletLane({ wallet: {} }, 'agent', async () => 'v')).resolves.toBe('v')
    await expect(withWalletLane({}, 'agent', async () => 'v')).resolves.toBe('v')
  })
})

describe('verifyLaunch (stubbed client)', () => {
  function stubClient(impl: { exists?: boolean | Error; name?: string | Error }) {
    return {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'exists') {
          if (impl.exists instanceof Error) throw impl.exists
          return impl.exists ?? false
        }
        if (functionName === 'name') {
          if (impl.name instanceof Error) throw impl.name
          return impl.name
        }
        throw new Error(`unexpected call ${functionName}`)
      },
    }
  }

  it('taken + name match proves OUR launch (committed, honest markers)', async () => {
    const verdict = await verifyLaunch(stubClient({ exists: true, name: 'Test Token' }) as never, deployment(), geometricArgs())
    expect(verdict.state).toBe('committed')
    const value = (verdict as { state: 'committed'; value: Record<string, string> }).value
    expect(value['token']).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(value['poolId']).toMatch(/^0x[0-9a-f]{64}$/)
    expect(value['hash']).toContain('unknown:verified-on-chain')
    expect(value['router']).toContain('unknown:verified-on-chain')
  })

  it('an untaken symbol reads absent; an unreadable chain reads unreadable', async () => {
    await expect(verifyLaunch(stubClient({ exists: false }) as never, deployment(), geometricArgs()))
      .resolves.toEqual({ state: 'absent' })
    await expect(verifyLaunch(stubClient({ exists: new Error('rpc down') }) as never, deployment(), geometricArgs()))
      .resolves.toEqual({ state: 'unreadable' })
  })

  it("someone else's symbol (name mismatch) reads absent, never committed", async () => {
    await expect(verifyLaunch(stubClient({ exists: true, name: 'Someone Else' }) as never, deployment(), geometricArgs()))
      .resolves.toEqual({ state: 'absent' })
    await expect(verifyLaunch(stubClient({ exists: true, name: new Error('not erc20') }) as never, deployment(), geometricArgs()))
      .resolves.toEqual({ state: 'absent' })
  })

  it('invalid args read unreadable (the send surfaces the real error)', async () => {
    await expect(verifyLaunch(stubClient({ exists: true }) as never, deployment(), { symbol: 'X' } as never))
      .resolves.toEqual({ state: 'unreadable' })
  })
})

describe('verifySweep (stubbed client)', () => {
  function stubClient(impl: { pending?: bigint; minClaim?: bigint } | Error) {
    return {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (impl instanceof Error) throw impl
        switch (functionName) {
          case 'pending': return impl.pending ?? 0n
          case 'MIN_CLAIM': return impl.minClaim ?? 100n
          case 'RESERVE': return WETH
          case 'SECONDARY': return '0x0000000000000000000000000000000000000000'
          case 'TOKEN': return ROUTER
          case 'BOUNTY_BPS': return 100n
          case 'lastActive': return 1_700_000_000n
          case 'reclaimAt': return 1_800_000_000n
          case 'STALE_PERIOD': return 86400n
          case 'GRACE_PERIOD': return 86400n
          default: throw new Error(`unexpected call ${functionName}`)
        }
      },
    }
  }

  it('a non-ready router proves the sweep (committed, honest marker)', async () => {
    const verdict = await verifySweep(stubClient({ pending: 0n, minClaim: 100n }) as never, ROUTER as `0x${string}`)
    expect(verdict.state).toBe('committed')
    expect((verdict as { state: 'committed'; value: { hash: string; status: string } }).value)
      .toEqual({ hash: `unknown:verified-by-router-state:${ROUTER}`, status: 'success' })
  })

  it('a ready router reads absent; an unreadable chain reads unreadable', async () => {
    await expect(verifySweep(stubClient({ pending: 500n, minClaim: 100n }) as never, ROUTER as `0x${string}`))
      .resolves.toEqual({ state: 'absent' })
    await expect(verifySweep(stubClient(new Error('rpc down')) as never, ROUTER as `0x${string}`))
      .resolves.toEqual({ state: 'unreadable' })
  })
})

describe('createExecuteHooks', () => {
  function hooksWith(client: { readContract: (args: { functionName: string }) => Promise<unknown> }) {
    const ledger = new ExecuteLedger()
    const hooks = createExecuteHooks({ ledger, getClient: () => client as never, deployment: deployment() })
    return { ledger, hooks }
  }

  function launchCommittedClient() {
    return {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'exists') return true
        if (functionName === 'name') return 'Test Token'
        throw new Error(`unexpected call ${functionName}`)
      },
    }
  }

  it('checkLaunch replays settled, holds unknown in flight, verifies misses', async () => {
    const { hooks } = hooksWith(launchCommittedClient())
    // Ledger miss + chain committed → replay.
    const replay = await hooks.checkLaunch(geometricArgs())
    expect(replay.kind).toBe('replay')
    // Settled (via a ledger run) → replay of the recorded value.
    const ledger2 = new ExecuteLedger()
    await ledger2.run(launchKeyFor(geometricArgs()), async () => ({ hash: '0x1' }), runOpts())
    const hooks2 = createExecuteHooks({ ledger: ledger2, getClient: () => ({}) as never, deployment: deployment() })
    await expect(hooks2.checkLaunch(geometricArgs())).resolves.toEqual({ kind: 'replay', value: { hash: '0x1' } })
    // In flight → unknown (the body attaches on dispatch).
    const ledger3 = new ExecuteLedger()
    const gate = deferred<string>()
    const pending = ledger3.run(launchKeyFor(geometricArgs()), () => gate.promise, runOpts())
    const hooks3 = createExecuteHooks({ ledger: ledger3, getClient: () => ({}) as never, deployment: deployment() })
    await expect(hooks3.checkLaunch(geometricArgs())).resolves.toEqual({ kind: 'unknown' })
    gate.resolve('v')
    await pending
  })

  it('checkLaunch proceeds on proven absence, holds unknown when unreadable', async () => {
    const absent = hooksWith({ readContract: async () => false })
    await expect(absent.hooks.checkLaunch(geometricArgs())).resolves.toEqual({ kind: 'proceed' })
    const down = hooksWith({ readContract: async () => { throw new Error('rpc down') } })
    await expect(down.hooks.checkLaunch(geometricArgs())).resolves.toEqual({ kind: 'unknown' })
    await expect(down.hooks.checkLaunch({ nope: true })).resolves.toEqual({ kind: 'unknown' })
  })

  it('checkSweep replays swept routers and proceeds when ready', async () => {
    const swept = hooksWith({
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'pending') return 0n
        if (functionName === 'MIN_CLAIM') return 100n
        if (functionName === 'BOUNTY_BPS') return 100n
        if (functionName === 'lastActive' || functionName === 'reclaimAt') return 1_700_000_000n
        if (functionName === 'STALE_PERIOD' || functionName === 'GRACE_PERIOD') return 86400n
        return '0x0000000000000000000000000000000000000000'
      },
    })
    const replay = await swept.hooks.checkSweep({ router: ROUTER })
    expect(replay).toEqual({ kind: 'replay', value: { hash: `unknown:verified-by-router-state:${ROUTER}`, status: 'success' } })
    const ready = hooksWith({
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'pending') return 500n
        if (functionName === 'MIN_CLAIM') return 100n
        if (functionName === 'BOUNTY_BPS') return 100n
        if (functionName === 'lastActive' || functionName === 'reclaimAt') return 1_700_000_000n
        if (functionName === 'STALE_PERIOD' || functionName === 'GRACE_PERIOD') return 86400n
        return '0x0000000000000000000000000000000000000000'
      },
    })
    await expect(ready.hooks.checkSweep({ router: ROUTER })).resolves.toEqual({ kind: 'proceed' })
  })

  it('checkHeartbeat replays settled and holds unknown otherwise (no chain read-back)', async () => {
    const { ledger, hooks } = hooksWith({ readContract: async () => { throw new Error('must not be called') } })
    await expect(hooks.checkHeartbeat({ router: ROUTER })).resolves.toEqual({ kind: 'unknown' })
    await ledger.run(heartbeatKeyFor({ router: ROUTER }), async () => ({ transactionHash: '0x1', status: 'success' }), runOpts())
    await expect(hooks.checkHeartbeat({ router: ROUTER })).resolves.toEqual({
      kind: 'replay',
      value: { transactionHash: '0x1', status: 'success' },
    })
    await expect(hooks.checkHeartbeat({ router: 'nope' })).resolves.toEqual({ kind: 'unknown' })
  })
})
