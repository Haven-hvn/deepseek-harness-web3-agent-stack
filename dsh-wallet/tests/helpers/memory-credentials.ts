/**
 * In-memory `ctx.credentials` provider for wallet-seam tests: one
 * always-writable `memory` source seeded from plugin config. Mirrors the
 * upstream credentials package's own test double so consumer tests exercise
 * the real seam contract (empty value = absent; resolution per call).
 * Test infrastructure only — lives under `tests/`, never published.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'

/** Seeded in-memory credential source. */
export class MemoryCredentials extends CredentialProvider {
  private readonly store = new Map<string, string>()

  constructor(ctx: Context, seed: Record<string, string> = {}) {
    super(ctx)
    for (const [key, value] of Object.entries(seed)) this.store.set(key, value)
  }

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.store.get(ref)
    return Promise.resolve(value === undefined || value.length === 0
      ? undefined
      : { value, source: 'memory' })
  }

  override describe(ref: CredentialRef): Promise<CredentialInfo> {
    const value = this.store.get(ref)
    const configured = value !== undefined && value.length > 0
    return Promise.resolve({
      configured,
      ...configured ? { source: 'memory' } : {},
      writable: true,
    })
  }

  override set(ref: CredentialRef, value: string): Promise<void> {
    if (value.length === 0) {
      return Promise.reject(new Error('memory credentials: an empty value cannot be stored; use unset'))
    }
    this.store.set(ref, value)
    this.notifyUpdated(ref)
    return Promise.resolve()
  }

  override unset(ref: CredentialRef): Promise<void> {
    if (this.store.delete(ref)) {
      this.notifyUpdated(ref)
    }
    return Promise.resolve()
  }
}
