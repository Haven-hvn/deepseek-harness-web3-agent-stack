/**
 * Package-owned invariant companion for `dsh-wallet-ethereum`.
 * @module dsh-wallet-ethereum/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-wallet-ethereum'

/** Cordis companion plugin name. */
export const name = 'wallet-ethereum-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this stateless provider plugin owns no package-local
 * event stream or mutable data relation — it only registers adapters on the
 * wallet seam, whose `wallet/signed` ↔ configuration relation is checked by
 * the seam owner (`dsh-wallet/invariant`), and OWS owns key custody on its
 * side of the process boundary.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
