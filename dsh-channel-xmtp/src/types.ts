/**
 * Type surface of the XMTP channel: inbound/status event payloads and the
 * seam's Cordis event declarations. Types only — no runtime code.
 *
 * @module dsh-channel-xmtp/types
 */

/** Connection lifecycle states (haven-core XmtpChannel machine states). */
export type XmtpChannelStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected'

/** One accepted inbound message — identity facts, before agent delivery. */
export interface XmtpInboundEvent {
  /** XMTP message id. */
  readonly messageId: string
  /** XMTP conversation (group) id. */
  readonly conversationId: string
  /** Sender's XMTP inbox id. */
  readonly senderInboxId: string
  /** Unix ms the message was sent. */
  readonly sentAtMs: number
}

/**
 * Why one outbound XMTP send happened:
 * - `reply` — the assistant output of a turn an XMTP inbound started;
 * - `proactive` — assistant output of a turn something else started (a
 *   background-job wake, a schedule, a subagent return, …);
 * - `ack` — the busy acknowledgment sent when an inbound queues behind a
 *   running turn.
 */
export type XmtpOutboundKind = 'reply' | 'proactive' | 'ack'

/** One message sent to an XMTP conversation. */
export interface XmtpOutboundEvent {
  /** XMTP conversation (group) id. */
  readonly conversationId: string
  /** What triggered the send. */
  readonly kind: XmtpOutboundKind
  /** Agent turn whose output was sent (absent for `ack`). */
  readonly turn?: number
  /** The inbound XMTP message this answers, when known. */
  readonly inboundMessageId?: string
}

/** One connection-state transition. */
export interface XmtpStatusEvent {
  /** New status. */
  readonly status: XmtpChannelStatus
  /** Human-readable cause (connect success, stream error text, retry exhaustion…). */
  readonly reason: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One inbound XMTP message passed the channel's filters (text-only, not
     * own, active-group, dedup) and is about to enter its agent's inbox.
     * @param event - message identity facts; never content.
     * @mode emit
     */
    'xmtp/inbound'(event: XmtpInboundEvent): void

    /**
     * The channel sent one message to a conversation (reply, proactive
     * turn output, or busy ack). Fires after the send succeeded.
     * @param event - conversation, trigger kind, and turn/inbound correlation; never content.
     * @mode emit
     */
    'xmtp/outbound'(event: XmtpOutboundEvent): void

    /**
     * The channel's connection state changed.
     * @param event - the new status and why.
     * @mode emit
     */
    'xmtp/status'(event: XmtpStatusEvent): void
  }
}
