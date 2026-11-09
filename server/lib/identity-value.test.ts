// Run with plain Node (it strips the types): node --test server/lib/identity-value.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { identityValue } from './identity-value.ts'

const caseTpl = { fields: [{ name: 'case_number', type: 'integer' }, { name: 'slug', type: 'string' }] }

test('a case handle names the case number on an integer identity field', () => {
  for (const k of ['CASE-1179', 'case-1179', ' CASE-1179 ', '#1179', '1179']) {
    assert.equal(identityValue(caseTpl, 'case_number', k), 1179, k)
  }
  assert.equal(identityValue(caseTpl, 'case_number', 1179), 1179)
})

test('anything else passes through unchanged', () => {
  assert.equal(identityValue(caseTpl, 'case_number', 'CASE-1179#3'), 'CASE-1179#3')
  assert.equal(identityValue(caseTpl, 'case_number', 'not-a-case'), 'not-a-case')
  assert.equal(identityValue(caseTpl, 'slug', 'CASE-1179'), 'CASE-1179')
  assert.equal(identityValue(caseTpl, 'unknown', 'CASE-1179'), 'CASE-1179')
  assert.equal(identityValue({}, 'case_number', 'CASE-1179'), 'CASE-1179')
})
