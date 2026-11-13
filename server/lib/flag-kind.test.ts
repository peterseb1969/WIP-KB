import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setFlagKind } from './flag-kind.ts'

test('a flag on a version with kind gets kind = flag_type', () => {
  const d: Record<string, unknown> = { flag_type: 'respond' }
  setFlagKind(d, 4, 4)
  assert.equal(d.kind, 'respond')
})

test('a kind the client sent is replaced by flag_type', () => {
  const d: Record<string, unknown> = { flag_type: 'implement', kind: 'respond' }
  setFlagKind(d, 4, 4)
  assert.equal(d.kind, 'implement')
})

test('an older pinned version, or a namespace without the field, gets no kind', () => {
  for (const [ver, kv] of [[3, 4], [3, null]] as const) {
    const d: Record<string, unknown> = { flag_type: 'respond', kind: 'respond' }
    setFlagKind(d, ver, kv)
    assert.equal('kind' in d, false)
  }
})

test('no pinned version resolves to the latest, which declares kind', () => {
  const d: Record<string, unknown> = { flag_type: 'respond' }
  setFlagKind(d, undefined, 4)
  assert.equal(d.kind, 'respond')
})
