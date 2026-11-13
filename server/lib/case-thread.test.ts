import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyHistory, summariseThread, threadCounts, threadMarker } from './case-thread.ts'

const t = (...kinds: string[]) => kinds.map((k, i) => ({ response_kind: k, response_seq: i + 1 }))

test('an open case with no responses is unanswered and needs a history check', () => {
  const s = summariseThread('open', [])
  assert.equal(s.unanswered, true)
  assert.equal(s.needsHistory, true)
  assert.equal(threadMarker(s), 'unanswered')
  assert.equal(threadCounts(s), '')
})

test('comments alone do not answer a case', () => {
  const s = summariseThread('open', t('comment', 'comment'))
  assert.equal(s.unanswered, true)
  assert.equal(threadCounts(s), 'C2')
})

test('an answered open case carries no marker', () => {
  const s = summariseThread('open', t('respond'))
  assert.equal(threadMarker(s), '')
  assert.equal(s.needsHistory, false)
})

test('an open case with an implement response was reopened (prod CASE-1276)', () => {
  const s = summariseThread('open', t('respond', 'comment', 'implement', 'comment', 'comment'))
  assert.equal(s.reopened, true)
  assert.equal(s.reanswered, false)
  assert.equal(s.unanswered, false)
  assert.equal(threadMarker(s), 'reopened')
  assert.equal(threadCounts(s), 'R1 I1 C3')
})

test('a respond after the implement marks it re-answered (prod CASE-1260)', () => {
  const s = summariseThread('responded', t('respond', 'comment', 'comment', 'implement', 'comment', 'respond'))
  assert.equal(threadMarker(s), 'reopened · re-answered')
})

test('a close counts like an implement', () => {
  assert.equal(summariseThread('open', t('respond', 'close')).reopened, true)
  assert.equal(threadCounts(summariseThread('open', t('close'))), 'X1')
})

test('an implemented or closed case is never reopened, whatever its thread', () => {
  for (const st of ['implemented', 'closed']) {
    const s = summariseThread(st, t('respond', 'implement', 'comment', 'respond', 'implement'))
    assert.equal(s.reopened, false)
    assert.equal(threadMarker(s), '')
  }
})

test('only an open case can be unanswered', () => {
  assert.equal(summariseThread('responded', []).unanswered, false)
  assert.equal(summariseThread('implemented', []).unanswered, false)
})

test('history: a pre-thread case once implemented is a reopen, not unanswered', () => {
  const s = applyHistory(summariseThread('open', []), ['open', 'implemented', 'open'])
  assert.equal(s.reopened, true)
  assert.equal(s.unanswered, false)
  assert.equal(s.needsHistory, false)
  assert.equal(threadMarker(s), 'reopened')
})

test('history: a case that was never finished stays unanswered', () => {
  const s = applyHistory(summariseThread('open', []), ['open', 'responded', 'open'])
  assert.equal(s.unanswered, true)
  assert.equal(s.reopened, false)
})

test('history is ignored where the thread already decided', () => {
  const s0 = summariseThread('open', t('respond'))
  assert.deepEqual(applyHistory(s0, ['implemented']), s0)
})
