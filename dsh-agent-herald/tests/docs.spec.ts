/**
 * Proofs for the Herald agent definition.
 *
 * The docs are the product: these specs pin their presence, their load
 * path (fail-loud when gutted), the section registration apply() performs
 * against a stubbed prompt registry, and anchor phrases that must survive
 * every edit (identity, gate versions, money loop, community covenant,
 * harness-native stages — and never a CLI mention).
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as agentHerald from '../src/index.ts'
import { apply, loadAgentDoc, packageRoot, SECTIONS } from '../src/index.ts'

describe('agent docs', () => {
  it('loads soul, process, workflow, and the protocol reference non-empty', () => {
    expect(SECTIONS).toHaveLength(4)
    for (const section of SECTIONS) {
      const text = loadAgentDoc(section.file)
      expect(text.length).toBeGreaterThan(500)
    }
  })

  it('soul anchors: identity, sovereignty, community covenant', () => {
    const soul = loadAgentDoc('soul.md')
    for (const anchor of [
      'Herald',
      'sovereign',
      'DataDAO',
      'covenant',
      'Exactly once per intent',
      'ERC-8004',
      'Never print private keys',
    ]) {
      expect(soul).toContain(anchor)
    }
  })

  it('process anchors: pipeline, gates, money loop, denials', () => {
    const process = loadAgentDoc('process.md')
    for (const anchor of [
      'release pipeline',
      'workflow.md',
      'aol_seal',
      'aol_gate_info',
      'synapse_pin',
      'arkiv_create_entity',
      'gate_type',
      'rr_launch',
      'rr_sweep',
      'rr_heartbeat',
      'get_balances',
      'acquire_submit',
      'prowlarr_search',
      'InsufficientBalance',
      'MarketCapNotReached',
      'erc8004_register',
      'wallet_info',
      'opt-in journal',
    ]) {
      expect(process).toContain(anchor)
    }
    // No shell-out sealing commands remain.
    expect(process).not.toContain('haven upload')
    expect(process).not.toContain('--encrypt')
    expect(process).not.toContain('haven_')
  })

  it('process §9: failure discipline rules and stand-down mechanism survive', () => {
    const process = loadAgentDoc('process.md')
    for (const anchor of [
      'Failure discipline',
      'Opaque values move by reference',
      'Two-strike stop rule',
      'Rate-limit stand-down',
      'cannot stop that loop',
      'open no further steps',
      'Outcome anchoring',
      'Provenance on every claimed value',
      '`web_search` is not provisioned',
    ]) {
      expect(process).toContain(anchor)
    }
  })

  it('process §10: long work runs in the background and silence is a valid answer', () => {
    const process = loadAgentDoc('process.md')
    for (const anchor of [
      'Long work and the chat channel',
      'run_in_background: true',
      'The completion wakes you',
      'job_output',
      'Silence is a valid answer',
      'an empty turn sends nothing',
      'Wake budget',
    ]) {
      expect(process).toContain(anchor)
    }
  })

  it('workflow anchors: stages and harness tools', () => {
    const workflow = loadAgentDoc('workflow.md')
    for (const anchor of [
      'stage manual',
      'Tier-1',
      'BEFORE sealing',
      'aol_seal',
      'synapse_pin',
      'arkiv_create_entity',
      'gate_type',
      'sha256_ct',
      'access path',
      'Deliberately absent',
    ]) {
      expect(workflow).toContain(anchor)
    }
    expect(workflow).not.toContain('haven upload')
    expect(workflow).not.toContain('haven_entity')
    expect(workflow).not.toContain('haven_download')
  })

  it('protocol anchors: three versions, derivation, math, errors', () => {
    const protocol = loadAgentDoc('reference/aol-protocol.md')
    for (const anchor of [
      'gny6k-fqaaa-aaaab-ag3ra-cai',
      'accessol_v1',
      'accessol_v3',
      'accessol_v4',
      '2,592,000',
      'Threshold-zero collapse',
      'Bond contract',
      'whole reserve units',
      'marginal',
      '300 seconds',
      'GateRequestV4',
      'InvalidSignature',
      'InvalidOracle',
      'EIP-191',
      'attestHolding',
    ]) {
      expect(protocol).toContain(anchor)
    }
  })

  it('docs never mention a CLI: no haven CLI, no shell-out', () => {
    for (const section of SECTIONS) {
      const text = loadAgentDoc(section.file)
      expect(text).not.toMatch(/haven[-_ ]cli/i)
      expect(text).not.toMatch(/\bCLI\b/)
      expect(text).not.toMatch(/shells? out/)
      expect(text).not.toMatch(/`haven`/)
    }
  })

  it('fails loud on a missing or empty doc', () => {
    expect(() => loadAgentDoc('soul.md', '/nonexistent-dir')).toThrow('cannot boot without soul.md')
    expect(() => loadAgentDoc('nope.md')).toThrow('cannot boot without nope.md')
  })
})

describe('section registration', () => {
  it('apply registers soul, process, workflow, and protocol in render order', () => {
    const section = vi.fn()
    apply({ systemPrompt: { section } } as never)
    expect(section).toHaveBeenCalledTimes(4)
    const calls = section.mock.calls.map(call => call[0] as { name: string; order: number; text: string })
    expect(calls.map(entry => entry.name)).toEqual(['agent:soul', 'agent:process', 'agent:workflow', 'agent:aol-protocol'])
    const orders = calls.map(entry => entry.order)
    expect([...orders].sort((a, b) => a - b)).toEqual(orders) // ascending render order
    expect(orders.every(order => order < 0)).toBe(true) // ahead of the persona prefix slot
    expect(calls[0]?.text).toContain('Herald')
    expect(calls[1]?.text).toContain('release pipeline')
    expect(calls[2]?.text).toContain('stage manual')
    expect(calls[3]?.text).toContain('accessol_v4')
  })

  it('package root resolves to the directory holding the docs', () => {
    expect(loadAgentDoc('soul.md', packageRoot())).toContain('Herald')
  })
})

describe('assembled prompt (real registry)', () => {
  it('mounts against the real prompt registry and renders Herald first', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(agentHerald as any, {})
    const assembly = await ctx.systemPrompt.assemble()
    const names = assembly.sections.map(section => section.name)
    expect(names).toEqual([
      'harness:identity',
      'agent:soul',
      'agent:process',
      'agent:workflow',
      'agent:aol-protocol',
      'deployment:persona-prefix',
      'deployment:persona-suffix',
    ])
    const rendered = renderPrompt(assembly)
    expect(rendered).toContain('You are **Herald**')
    expect(rendered).toContain('release pipeline')
    expect(rendered).toContain('stage manual')
    expect(rendered).toContain('accessol_v4')
    // Identity leads: soul renders before the (empty) deployment prefix slot.
    expect(rendered.indexOf('You are **Herald**')).toBeLessThan(rendered.length)
  })
})
