/**
 * Package-owned invariant companion for `dsh-channel-xmtp`: the inbound
 * audit stream must respect the channel's own dedup contract — one
 * `xmtp/inbound` per message id. A repeated id means a filter-path change
 * bypassed the dedup set and the same message reached an agent twice.
 * @module dsh-channel-xmtp/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { XmtpInboundEvent } from './types.ts'

const PACKAGE_NAME = 'dsh-channel-xmtp'

/** Cordis companion plugin name. */
export const name = 'channel-xmtp-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Bound the checker's own memory the same way the channel bounds its dedup set. */
const MAX_TRACKED_IDS = 5_000

/** Install the inbound-dedup agreement check. */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  const seen = new Set<string>()
  ctx.on('xmtp/inbound', (event: XmtpInboundEvent) => {
    if (event.messageId.length === 0) {
      return fail('xmtp/inbound emitted with an empty messageId')
    }
    if (seen.has(event.messageId)) {
      return fail(`xmtp/inbound emitted twice for message "${event.messageId}" — the dedup filter was bypassed`)
    }
    seen.add(event.messageId)
    if (seen.size > MAX_TRACKED_IDS) {
      for (const id of seen) {
        if (seen.size <= MAX_TRACKED_IDS / 2) break
        seen.delete(id)
      }
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
