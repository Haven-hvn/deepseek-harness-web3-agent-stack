/**
 * Classified acquisition failures. `message` never contains secrets —
 * every site redacts with {@link redactText} before throwing.
 *
 * @module dsh-tool-acquisition/errors
 */

import type { AcquisitionErrorCode } from './types.ts'

/** A classified acquisition failure. */
export class AcquisitionError extends Error {
  /** Machine-readable code. */
  readonly code: AcquisitionErrorCode
  /** True when retrying the same call cannot help. */
  readonly permanent: boolean
  /** Suggested wait before retrying, when known. */
  readonly retryAfterMs: number | undefined

  constructor(message: string, code: AcquisitionErrorCode, options?: { cause?: unknown; permanent?: boolean; retryAfterMs?: number }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'AcquisitionError'
    this.code = code
    this.permanent = options?.permanent ?? false
    this.retryAfterMs = options?.retryAfterMs
  }
}

/** An outbound fetch target derived from untrusted data was refused. Always permanent. */
export class UnsafeURLError extends AcquisitionError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'ACQUIRE_UNSAFE_URL', { ...options, permanent: true })
    this.name = 'UnsafeURLError'
  }
}
