import { test } from 'node:test'
import assert from 'node:assert/strict'
import { refusal } from './kb-ui-guard.ts'

const post = (path: string, body: unknown) => ({ method: 'POST', path, body })

test('withdrawing a flag by document_id is admitted', () => {
  assert.equal(refusal(post('/write/FLAG_RECORD', {
    patch: { doc_status: 'archived' }, match: { document_id: '01a1da16-3759-74cf-8406-6f1d16af492b' },
  })), null)
})

test('a flag cannot be re-armed, dispatched or otherwise edited from the UI', () => {
  for (const patch of [{ doc_status: 'published' }, { doc_status: 'dispatched' }, { doc_status: 'deprecated' },
    { doc_status: 'archived', target_yac: 'APP-KB' }, { worker: 'RESPOND-YAC' }]) {
    assert.notEqual(refusal(post('/write/FLAG_RECORD', { patch, match: { document_id: 'x' } })), null, JSON.stringify(patch))
  }
})

test('a withdraw is located by document_id only', () => {
  assert.notEqual(refusal(post('/write/FLAG_RECORD', {
    patch: { doc_status: 'archived' }, match: { flag_type: 'implement' },
  })), null)
})

test('doc_status is not patchable on any other type', () => {
  assert.notEqual(refusal(post('/write/CASE_RECORD', {
    patch: { doc_status: 'archived' }, match: { document_id: 'x' },
  })), null)
})

test('the existing UI writes still pass', () => {
  assert.equal(refusal(post('/write/CASE_RECORD', { patch: { status: 'closed' }, match: { case_number: 1 } })), null)
  assert.equal(refusal(post('/write/CASE_RECORD', { patch: { topics: ['kb-app'] }, match: { document_id: 'x' } })), null)
})
