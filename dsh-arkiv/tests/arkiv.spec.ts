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
import { CREATE_RESULT_SCHEMA, QUERY_RESULT_SCHEMA } from '../src/index.ts'

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
})
