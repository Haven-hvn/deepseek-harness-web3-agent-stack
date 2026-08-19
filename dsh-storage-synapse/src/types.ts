/**
 * Type surface of the Synapse pinning seam: the `ctx.synapse` Context
 * declaration and the audit event of a completed pin. Types only — no
 * runtime code.
 *
 * @module dsh-storage-synapse/types
 */

import type { SynapseRuntime } from './index.ts'

/** Audit payload of one completed pin operation. */
export interface SynapsePinnedEvent {
  /** The content identifier that was pinned or renewed. */
  readonly cid: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Synapse storage seam: store / retrieve / pin / pin-status. */
    synapse: SynapseRuntime
  }

  interface Events {
    /**
     * One pin operation committed on the Synapse node (fresh pin or renewal
     * — the node treats both as `pin/add`).
     * @param event - the pinned CID.
     * @mode emit
     */
    'synapse/pinned'(event: SynapsePinnedEvent): void
  }
}
