/**
 * Narrow typed port over `@xmtp/node-sdk` — exactly the surface the channel
 * consumes (client creation, conversation listing/lookup, message streaming,
 * consent updates, text sending), with the SDK's enums reduced to opaque
 * tokens this package passes back verbatim. The native module is imported
 * lazily so the package loads, mounts, and tests without it; tests substitute
 * {@link internals.sdk}.
 *
 * @module dsh-channel-xmtp/xmtp
 */

/** EOA signer contract the XMTP client consumes; signatures are raw bytes. */
export interface XmtpSigner {
  readonly type: 'EOA'
  getIdentifier(): { identifier: string; identifierKind: unknown }
  signMessage(message: string): Promise<Uint8Array>
}

/** One decoded inbound message. */
export interface XmtpDecodedMessage {
  readonly id: string
  readonly conversationId: string
  readonly senderInboxId: string
  readonly content: unknown
  readonly sentAt: Date
}

/** XMTP attachment (decrypted). */
export interface XmtpAttachment {
  readonly filename?: string
  readonly mimeType: string
  readonly content: Uint8Array
}

/** XMTP remote attachment (encrypted URL). */
export interface XmtpRemoteAttachment {
  readonly url: string
  readonly contentDigest: string
  readonly secret: Uint8Array
  readonly salt: Uint8Array
  readonly nonce: Uint8Array
  readonly scheme: string
  readonly contentLength?: number
  readonly filename?: string
}

/** One conversation handle. */
export interface XmtpConversation {
  sendText(text: string): Promise<unknown>
  sendAttachment?(attachment: XmtpAttachment): Promise<unknown>
  sendRemoteAttachment?(remoteAttachment: XmtpRemoteAttachment): Promise<unknown>
  consentState(): unknown
  updateConsentState(state: unknown): Promise<void> | void
}

/** Live message stream handle. */
export interface XmtpStream {
  end(): Promise<void>
}

/** The client surface the channel uses. */
export interface XmtpClient {
  readonly inboxId?: string
  readonly conversations: {
    sync(): Promise<void>
    list(): Promise<XmtpConversation[]>
    getConversationById(id: string): Promise<XmtpConversation | undefined>
    streamAllMessages(options: {
      consentStates: unknown[]
      onValue: (message: XmtpDecodedMessage) => void
      onError: (error: Error) => void
    }): Promise<XmtpStream>
  }
}

/** Client construction options. */
export interface XmtpClientOptions {
  env: string
  dbPath?: string
  dbEncryptionKey?: Uint8Array
}

/** The complete port: constructor plus the enum/predicate tokens the calls need. */
export interface XmtpSdk {
  createClient(signer: XmtpSigner, options: XmtpClientOptions): Promise<XmtpClient>
  /** Predicate for plain-text messages. */
  isText(message: XmtpDecodedMessage): boolean
  /** Predicate for remote-attachment messages. */
  isRemoteAttachment(message: XmtpDecodedMessage): boolean
  /** Predicate for inline attachment messages. */
  isAttachment(message: XmtpDecodedMessage): boolean
  /** Decrypt a remote attachment's encrypted bytes. */
  decryptAttachment(encryptedBytes: Uint8Array, remoteAttachment: XmtpRemoteAttachment): XmtpAttachment
  /** `IdentifierKind.Ethereum` token for signer identifiers. */
  readonly ethereumIdentifierKind: unknown
  /** `ConsentState.Allowed` token. */
  readonly consentAllowed: unknown
  /** `ConsentState.Unknown` token. */
  readonly consentUnknown: unknown
}

/**
 * Test seam: when `sdk` is set, {@link loadXmtpSdk} returns it and the native
 * module is never imported.
 */
export const internals: { sdk: XmtpSdk | undefined } = { sdk: undefined }

/** Shape of the real `@xmtp/node-sdk` module, as far as this port reaches into it. */
interface XmtpNodeSdkModule {
  Client: { create(signer: XmtpSigner, options: XmtpClientOptions): Promise<XmtpClient> }
  ConsentState: { Allowed: unknown; Unknown: unknown }
  IdentifierKind: { Ethereum: unknown }
  isText(message: XmtpDecodedMessage): boolean
  isRemoteAttachment(message: XmtpDecodedMessage): boolean
  isAttachment(message: XmtpDecodedMessage): boolean
  decryptAttachment(encryptedBytes: Uint8Array, remote: XmtpRemoteAttachment): XmtpAttachment
}

/**
 * Resolve the XMTP SDK, lazily importing it on first use.
 * @returns the narrow sdk port.
 * @throws an actionable error when the SDK is not installed.
 */
export async function loadXmtpSdk(): Promise<XmtpSdk> {
  if (internals.sdk !== undefined) return internals.sdk
  let sdk: XmtpNodeSdkModule
  try {
    sdk = await import('@xmtp/node-sdk') as unknown as XmtpNodeSdkModule
  } catch (cause) {
    throw new Error(
      'dsh-channel-xmtp: @xmtp/node-sdk is not installed. '
      + 'Install it into the profile (dsh plugin --profile <name> add @xmtp/node-sdk) to run the channel.',
      { cause },
    )
  }
  return {
    createClient: (signer, options) => sdk.Client.create(signer, options),
    isText: message => sdk.isText(message),
    isRemoteAttachment: message => {
      try { return (sdk as unknown as { isRemoteAttachment: (m: XmtpDecodedMessage) => boolean }).isRemoteAttachment(message) } catch { return false }
    },
    isAttachment: message => {
      try { return (sdk as unknown as { isAttachment: (m: XmtpDecodedMessage) => boolean }).isAttachment(message) } catch { return false }
    },
    decryptAttachment: (bytes, remote) => (sdk as unknown as { decryptAttachment: (b: Uint8Array, r: XmtpRemoteAttachment) => XmtpAttachment }).decryptAttachment(bytes, remote),
    ethereumIdentifierKind: sdk.IdentifierKind.Ethereum,
    consentAllowed: sdk.ConsentState.Allowed,
    consentUnknown: sdk.ConsentState.Unknown,
  }
}

/**
 * Decode a hex signature (with or without `0x`) into the raw bytes XMTP
 * signers return.
 * @param hex - hex-encoded signature from the wallet seam.
 * @returns the signature bytes.
 */
export function hexToBytes(hex: string): Uint8Array {
  const body = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex
  if (body.length === 0 || body.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(body)) {
    throw new Error(`dsh-channel-xmtp: signature is not valid hex (${body.length} chars)`)
  }
  const bytes = new Uint8Array(body.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(body.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}
