import { describe, expect, it } from 'vitest'
import { normalizeEvmKey } from '../keys.mjs'

// Synthetic test vector only — never a real secret.
const GOOD = `0x${'ab'.repeat(32)}`

describe('normalizeEvmKey (bring-your-own AGENT_EVM_KEY)', () => {
  it('accepts a 0x-prefixed 32-byte hex key', () => {
    expect(normalizeEvmKey(GOOD)).toBe(GOOD.toLowerCase())
  })

  it('trims whitespace and lowercases', () => {
    expect(normalizeEvmKey(`  ${GOOD.toUpperCase()}\n`)).toBe(GOOD.toLowerCase())
  })

  it('rejects missing prefix, short keys, and non-hex', () => {
    expect(() => normalizeEvmKey(GOOD.slice(2))).toThrow(/AGENT_EVM_KEY/)
    expect(() => normalizeEvmKey('0x1234')).toThrow(/AGENT_EVM_KEY/)
    expect(() => normalizeEvmKey(`0x${'zz'.padEnd(64, '0')}`)).toThrow(/AGENT_EVM_KEY/)
    expect(() => normalizeEvmKey('not a key')).toThrow(/AGENT_EVM_KEY/)
  })
})
