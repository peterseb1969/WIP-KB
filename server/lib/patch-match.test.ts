// Run with plain Node (it strips the types): node --test server/lib/patch-match.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MATCH_PAGE_SIZE, describeMatch, matchFilters, resolveMatch, validateMatch } from './patch-match.ts'

test('every match key becomes a filter', () => {
  assert.deepEqual(matchFilters({ case_number: 959, response_seq: 3 }), [
    { field: 'data.case_number', operator: 'eq', value: 959 },
    { field: 'data.response_seq', operator: 'eq', value: 3 },
  ])
  assert.equal(describeMatch({ case_number: 959, response_seq: 3 }), 'case_number=959, response_seq=3')
})

test('an empty match, or document_id with other keys, is refused', () => {
  assert.equal(validateMatch({})?.status, 422)
  assert.equal(validateMatch({ document_id: 'x', case_number: 1 })?.status, 422)
  assert.equal(validateMatch({ document_id: 'x' }), null)
  assert.equal(validateMatch({ case_number: 1, response_seq: 2 }), null)
})

test('two documents matching is ambiguous, not the first one', () => {
  // The observed misfire: case_number alone matched two responses.
  const outcome = resolveMatch([{ document_id: 'A' }, { document_id: 'B' }], 2)
  assert.deepEqual(outcome, { kind: 'ambiguous', count: 2 })
})

test('one document is the match; several active versions of it still are one', () => {
  assert.deepEqual(resolveMatch([{ document_id: 'A' }], 1), { kind: 'one', doc: { document_id: 'A' } })
  const rows = [{ document_id: 'A', version: 2 }, { document_id: 'A', version: 1 }]
  assert.equal(resolveMatch(rows, 2).kind, 'one')
})

test('no hit is none', () => {
  assert.deepEqual(resolveMatch([], 0), { kind: 'none' })
})

test('more hits than the page holds cannot vouch for uniqueness', () => {
  const page = Array.from({ length: MATCH_PAGE_SIZE }, () => ({ document_id: 'A' }))
  assert.equal(resolveMatch(page, MATCH_PAGE_SIZE + 3).kind, 'ambiguous')
})
