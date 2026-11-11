// Run with plain Node (it strips the types): node --test server/lib/claims.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { holds, leaseUntil, ruleFor, verdict, type Claim, type ClaimRule } from './claims.ts'

const now = new Date('2026-11-11T12:00:00Z')
const later = '2026-11-11T13:00:00Z'
const past = '2026-11-11T11:00:00Z'

let n = 0
function claim(kind: string, holder: string, since: string, over: Partial<Claim> = {}): Claim {
  n += 1
  return {
    document_id: `doc-${String(n).padStart(3, '0')}`, case_number: 1259, claim_kind: kind, holder,
    state: 'active', since, lease_until: later, ...over,
  }
}

const rules: ClaimRule[] = [
  { claim_kind: 'implement', max_holders: 1, excludes: ['respond'], lease_minutes: 90 },
  { claim_kind: 'review', max_holders: 2, excludes: [], lease_minutes: 30 },
]

test('what holds a case', () => {
  assert.equal(holds(claim('respond', 'a', past), now), true)
  assert.equal(holds(claim('respond', 'a', past, { lease_until: past }), now), false, 'lease ran out')
  assert.equal(holds(claim('respond', 'a', past, { state: 'parked', lease_until: null }), now), true, 'parked has no lease')
  assert.equal(holds(claim('respond', 'a', past, { state: 'released' }), now), false)
})

test('rules: a document, else the defaults', () => {
  assert.deepEqual(ruleFor('implement', rules), rules[0])
  assert.deepEqual(ruleFor('respond', rules), { claim_kind: 'respond', max_holders: 1, excludes: [], lease_minutes: 60 })
  assert.equal(leaseUntil('implement', rules, now), '2026-11-11T13:30:00.000Z')
})

test('one holder per kind: the later claimant loses, the earlier wins', () => {
  const first = claim('respond', 'S1', '2026-11-11T11:59:00Z')
  const second = claim('respond', 'S2', '2026-11-11T11:59:30Z')
  const all = [first, second]
  assert.deepEqual(verdict(first, all, rules, now), { ok: true })
  const v = verdict(second, all, rules, now)
  assert.equal(v.ok, false)
  assert.ok(!v.ok && v.reason.includes('S1'))
})

test('a race in the same instant is decided by document_id, the same way for both', () => {
  const a = claim('respond', 'S1', '2026-11-11T11:59:00Z', { document_id: 'doc-a' })
  const b = claim('respond', 'S2', '2026-11-11T11:59:00Z', { document_id: 'doc-b' })
  assert.equal(verdict(a, [a, b], rules, now).ok, true)
  assert.equal(verdict(b, [b, a], rules, now).ok, false)
})

test('max_holders above one', () => {
  const r1 = claim('review', 'R1', '2026-11-11T11:00:00Z')
  const r2 = claim('review', 'R2', '2026-11-11T11:01:00Z')
  const r3 = claim('review', 'R3', '2026-11-11T11:02:00Z')
  const all = [r1, r2, r3]
  assert.equal(verdict(r2, all, rules, now).ok, true)
  assert.equal(verdict(r3, all, rules, now).ok, false)
})

test('exclusion works in both directions, and only an earlier claim blocks', () => {
  const impl = claim('implement', 'I', '2026-11-11T11:00:00Z')
  const resp = claim('respond', 'R', '2026-11-11T11:05:00Z')
  assert.equal(verdict(resp, [impl, resp], rules, now).ok, false, 'respond after implement: blocked by implement\'s rule')
  const resp0 = claim('respond', 'R', '2026-11-11T10:00:00Z')
  const impl1 = claim('implement', 'I', '2026-11-11T10:05:00Z')
  assert.equal(verdict(impl1, [resp0, impl1], rules, now).ok, false, 'implement after respond: same rule, read the other way')
  assert.equal(verdict(resp0, [resp0, impl1], rules, now).ok, true, 'the earlier claim is not blocked by a later one')
})

test('released, expired and own claims never block', () => {
  const gone = claim('respond', 'S1', '2026-11-11T10:00:00Z', { state: 'released' })
  const stale = claim('respond', 'S2', '2026-11-11T10:30:00Z', { lease_until: past })
  const mine = claim('respond', 'S3', '2026-11-11T11:00:00Z')
  assert.deepEqual(verdict(mine, [gone, stale, mine], rules, now), { ok: true })
  const parked = claim('implement', 'P', '2026-11-11T09:00:00Z', { state: 'parked', lease_until: null })
  assert.equal(verdict(mine, [parked, mine], rules, now).ok, false, 'a parked implement still excludes respond')
})
