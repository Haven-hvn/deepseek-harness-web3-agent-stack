/**
 * Output-contract proofs for dsh-arkiv tools.
 *
 * The registry validates every tool result against its declared output
 * schema (dsh-tools ≥0.1.7-rc.2 rejects mismatches as tool errors), so these
 * specs pin each schema against representative values using the registry's
 * own validator — no chain, no network.
 */

import { describe, expect, it } from 'vitest'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { CREATE_RESULT_SCHEMA, QUERY_RESULT_SCHEMA, inject, toJsonSafeRecord } from '../src/index.ts'

describe('arkiv output contracts', () => {
  it('arkiv_query accepts an entity list (array-rooted)', () => {
    expect(validateJsonSchemaValue(QUERY_RESULT_SCHEMA, [], 'value')).toEqual([])
    expect(validateJsonSchemaValue(QUERY_RESULT_SCHEMA, [{ key: '0x1', owner: '0x2' }], 'value')).toEqual([])
  })

  it('arkiv_query rejects a non-list', () => {
    expect(validateJsonSchemaValue(QUERY_RESULT_SCHEMA, { key: '0x1' }, 'value').length).toBeGreaterThan(0)
  })

  it('arkiv_create_entity accepts the projected {key, owner, txHash} shape', () => {
    expect(
      validateJsonSchemaValue(CREATE_RESULT_SCHEMA, { key: '0x1', owner: '0x2', txHash: '0x3' }, 'value'),
    ).toEqual([])
  })

  it('arkiv_query projects SDK records to lossless JSON (bigint/bytes boundary)', () => {
    // Live failure: raw hits carry bigint expiresAt + Uint8Array payload,
    // which the registry rejects as "not lossless JSON". The projection
    // keeps type-exact attributes, stringifies big expiries, and turns the
    // payload into a content pointer.
    const projected = toJsonSafeRecord({
      key: '0x1',
      owner: '0x2',
      payload: new TextEncoder().encode('{}'),
      contentType: 'application/json',
      attributes: { grp: 'haven.video.full', gate_type: 4n, gate_chain: 314159 },
      expiresAt: 1791072000n,
    })
    expect(validateJsonSchemaValue(QUERY_RESULT_SCHEMA, [projected], 'value')).toEqual([])
    expect(JSON.parse(JSON.stringify([projected]))).toEqual([projected])
    expect(projected).toMatchObject({
      key: '0x1',
      attributes: { grp: 'haven.video.full', gate_type: 4, gate_chain: 314159 },
      expiresAt: 1791072000,
      payloadBytes: 2,
    })
    expect(typeof (projected as Record<string, unknown>).payloadSha256).toBe('string')
    expect('payload' in projected).toBe(false)
  })

  it('arkiv_create_entity rejects undeclared keys (why execute projects the record)', () => {
    // The full ArkivEntityRecord carries payload bytes + attributes; the
    // strict schema forbids them, so execute must project before returning.
    const violations = validateJsonSchemaValue(
      CREATE_RESULT_SCHEMA,
      { key: '0x1', owner: '0x2', txHash: '0x3', payload: '...', contentType: 'application/json' },
      'value',
    )
    expect(violations.length).toBeGreaterThan(0)
  })

  it('injects credentials: signing reads ctx.credentials (privateKeyRef)', () => {
    // Live failure: without the declaration Cordis throws 'cannot get
    // property "credentials" without inject' on every signing path.
    expect([...inject]).toEqual(expect.arrayContaining(['wallet', 'tools', 'credentials']))
  })
})

describe('arkiv patch args', () => {
  it('whole-record rewrites ride attributes on set (patch ignores attributes)', async () => {
    // Live incident: updateEntity passed `attributes` to patchEntity,
    // which the SDK silently ignores — three green txs, stale attrs.
    const { patchArgsForUpdate } = await import('../src/arkiv.ts')
    const tagged = { grp: { tag: 'str' }, gate_type: { tag: 'i32' } }
    const args = patchArgsForUpdate({
      key: '0xabc' as `0x${string}`,
      payload: new TextEncoder().encode('{}'),
      contentType: 'application/json',
      attributes: tagged,
    })
    expect(args).toMatchObject({ entityKey: '0xabc', contentType: 'application/json' })
    expect(args.set).toBe(tagged)
    expect('attributes' in args).toBe(false)
  })
})
