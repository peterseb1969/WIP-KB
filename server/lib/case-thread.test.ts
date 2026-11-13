import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyHistory, byPerson, questionsMarker, summariseThread, threadCounts, threadMarker } from './case-thread.ts'

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

const q = (seq: number, kind: string, author: string, questions?: number) =>
  ({ response_kind: kind, response_seq: seq, author, questions })

test('questions with no later answer by a person wait for the owner', () => {
  const s = summariseThread('responded', [q(1, 'respond', 'RESPOND-YAC-20261113-074000', 3)])
  assert.equal(s.awaitingOwner, true)
  assert.equal(s.openQuestions, 3)
  assert.equal(questionsMarker(s), '3 questions')
})

test("an agent's later comment does not answer the owner's questions", () => {
  const s = summariseThread('responded', [q(1, 'respond', 'RESPOND-YAC-20261113-074000', 1), q(2, 'comment', 'FRanC-20261112-094321')])
  assert.equal(s.awaitingOwner, true)
  assert.equal(questionsMarker(s), '1 question')
})

test('a later response by a person (email or WEB-UI) answers them', () => {
  for (const who of ['peter@example.org', 'WEB-UI']) {
    const s = summariseThread('responded', [q(1, 'respond', 'RESPOND-YAC-20261113-074000', 2), q(2, 'comment', who)])
    assert.equal(s.awaitingOwner, false)
    assert.equal(s.openQuestions, 0)
  }
})

test('new questions after an answer wait again', () => {
  const s = summariseThread('responded', [
    q(1, 'respond', 'RESPOND-YAC-20261113-074000', 2), q(2, 'comment', 'peter@example.org'),
    q(3, 'respond', 'RESPOND-YAC-20261113-090000', 1)])
  assert.equal(s.awaitingOwner, true)
  assert.equal(s.openQuestions, 1)
})

test('a finished case waits for nothing', () => {
  for (const st of ['implemented', 'closed']) {
    assert.equal(summariseThread(st, [q(1, 'respond', 'RESPOND-YAC-20261113-074000', 2)]).awaitingOwner, false)
  }
})

test('responses without questions never wait', () => {
  assert.equal(summariseThread('responded', [q(1, 'respond', 'BE-YAC-20261113-005434')]).awaitingOwner, false)
})

test('byPerson tells people from agents', () => {
  assert.equal(byPerson('peter@example.org'), true)
  assert.equal(byPerson('WEB-UI'), true)
  assert.equal(byPerson('APP-KB-20261112-234407'), false)
  assert.equal(byPerson(null), false)
})
