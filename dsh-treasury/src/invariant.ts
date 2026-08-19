/**
 * Package-owned invariant companion for `dsh-treasury`: every
 * `treasury/state-changed` event must agree with the pure derivation — the
 * owned event-stream ↔ derived-state relationship of this package. The
 * ledger derives `state` from `runwayDays` via `computeTreasuryState` and
 * emits at the mutation's commit point, so the event's `current` state and
 * the report it carries must be mutually consistent; divergence means an
 * emit path bypassed `settle()`.
 * @module dsh-treasury/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { computeTreasuryState } from './haven.ts'
import type { TreasuryStateChange } from './types.ts'

const PACKAGE_NAME = 'dsh-treasury'

/** Cordis companion plugin name. */
export const name = 'treasury-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Install the state-changed ↔ derivation agreement check. */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  ctx.on('treasury/state-changed', (change: TreasuryStateChange) => {
    const derived = computeTreasuryState(change.report.runwayDays)
    if (change.current !== derived) {
      return fail(
        `treasury/state-changed carries state "${change.current}" but its report derives `
        + `"${derived}" from runwayDays=${change.report.runwayDays}`,
      )
    }
    if (change.report.state !== change.current) {
      return fail(
        `treasury/state-changed carries state "${change.current}" but its report says "${change.report.state}"`,
      )
    }
    if (change.previous === change.current) {
      return fail(`treasury/state-changed emitted without a transition (both states "${change.current}")`)
    }
  }, { global: true })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
