import { describe, expect, it } from 'vitest'
import { page } from '../src/ui.ts'

describe('dashboard ui', () => {
  it('brands the page as the dsh-haven read-only observatory', () => {
    expect(page).toContain('dsh-haven web3 agent')
    expect(page).toContain('read-only · redacted')
    expect(page).toContain('agent observatory')
    expect(page).toContain('xmtp-ind')
    expect(page).not.toContain('<select')
  })

  it('renders all nine panels and fetches them from /snapshot', () => {
    expect(page).toContain("fetch('/snapshot?since=' + since)")
    for (const id of ['status', 'downloads', 'treasury', 'balances', 'burn', 'tokens', 'revenue', 'launches', 'catalog']) {
      expect(page).toContain("'" + id + "'")
    }
  })

  it('ships the haven design tokens', () => {
    expect(page).toContain('#f9f6f1')
    expect(page).toContain('#ff7329')
    expect(page).toContain('Geist Mono')
    expect(page).toContain('tabular-nums')
  })
})
