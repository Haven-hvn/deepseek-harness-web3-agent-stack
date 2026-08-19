/**
 * Package-owned invariant companion for `dsh-wallet`: every `wallet/signed`
 * event must agree with the runtime's configured-wallet table (the owned
 * event-stream ↔ configuration relationship of this package). The runtime
 * emits strictly after an adapter operation for a configured wallet returns,
 * so at emission time the named wallet must exist and its configured chain
 * must equal the event's chain — any divergence means an emit path bypassed
 * `beginOperation`.
 * @module dsh-wallet/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { WalletSignedEvent } from './types.ts'
// Type-only: carries the `ctx.wallet` Context declaration.
import type {} from './index.ts'

const PACKAGE_NAME = 'dsh-wallet'

/** Cordis companion plugin name. */
export const name = 'wallet-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Install the signed-event ↔ configuration agreement check. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('wallet/signed', (event: WalletSignedEvent) => {
    const info = ctx.wallet.list().find(wallet => wallet.name === event.wallet)
    if (info === undefined) {
      return fail(`wallet/signed for "${event.wallet}" emitted while that wallet is not configured`)
    }
    if (info.chain !== event.chain) {
      return fail(
        `wallet/signed for "${event.wallet}" carries chain "${event.chain}" `
        + `but the wallet is configured for chain "${info.chain}"`,
      )
    }
  }, { global: true })
}, { inject: ['wallet'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
