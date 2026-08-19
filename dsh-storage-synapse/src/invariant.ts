/**
 * Package-owned invariant companion for `dsh-storage-synapse`: every
 * `synapse/pinned` audit event carries a non-empty CID. The package owns no
 * mutable local state (pin truth lives on the node), so the checkable
 * relation is the audit stream's own well-formedness — an empty CID would
 * mean the runtime emitted a commit for an operation the node could not have
 * performed.
 * @module dsh-storage-synapse/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { SynapsePinnedEvent } from './types.ts'

const PACKAGE_NAME = 'dsh-storage-synapse'

/** Cordis companion plugin name. */
export const name = 'storage-synapse-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Install the pinned-audit well-formedness check. */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  ctx.on('synapse/pinned', (event: SynapsePinnedEvent) => {
    if (event.cid.length === 0) {
      fail('synapse/pinned emitted with an empty cid')
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
