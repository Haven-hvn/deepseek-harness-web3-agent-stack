/**
 * Type surface of the Synapse pinning seam: the `ctx.synapse` Context
 * declaration and the audit events for pin and Filecoin Pay funding commits.
 * Types only — no runtime code.
 *
 * @module dsh-storage-synapse/types
 */

import type { SynapseRuntime } from './index.ts'

/** Audit payload of one completed pin operation. */
export interface SynapsePinnedEvent {
  /** The content identifier that was pinned or renewed. */
  readonly cid: string
}

/**
 * Audit payload emitted when USDFC is deposited into Filecoin Pay and/or
 * Warm Storage operator allowances are updated. Capital allocation between
 * the agent's EOA and its Filecoin Pay escrow — distinct from burned expenses.
 */
export interface SynapseFundedEvent {
  /** Signing EOA address on Filecoin. */
  readonly address: string
  /** Human-readable Filecoin network name (e.g. `Filecoin - Calibration testnet`). */
  readonly network: string
  /** Normalized chain slug (`filecoin-calibration` | `filecoin`). */
  readonly chain: string
  /** USDFC deposited in this operation, decimal string (e.g. `"2.62"`, `"0"` for approval-only). */
  readonly depositedUsdfc: string
  /** USDFC deposited in smallest units (18 decimals, decimal string). */
  readonly depositedRaw: string
  /** Post-commit gross USDFC deposited in Filecoin Pay, decimal string. */
  readonly totalDepositedUsdfc: string
  /** Post-commit gross USDFC deposited in Filecoin Pay (18 decimals, decimal string). */
  readonly totalDepositedRaw: string
  /** Whether Warm Storage operator allowances were configured or updated. */
  readonly allowancesUpdated: boolean
  /** Deposit (or permit+deposit+approve) transaction hash when funds moved. */
  readonly txHash?: string | undefined
  /** Standalone allowance approval transaction hash when no deposit occurred. */
  readonly allowanceTxHash?: string | undefined
  /** Why funding ran (e.g. `auto-setup`, `piece-upload`, `runway-with-piece`, `target-deposit`, `approve-only`). */
  readonly reason: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Synapse storage seam: store / retrieve / pin / pin-status / payments / fund. */
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

    /**
     * Filecoin Pay deposit and/or Warm Storage operator approval committed on-chain.
     * @param event - post-commit funding summary and tx hash(es).
     * @mode emit
     */
    'synapse/funded'(event: SynapseFundedEvent): void
  }
}
