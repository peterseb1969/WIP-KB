// Claims on a case: who holds it for which kind of work, and whether a new claim
// may hold it. Pure decisions over claims and rules the caller has read; the KB
// gateway does the reads and writes.
//
// A claim HOLDS the case while it is parked (no lease: work waiting on a decision)
// or active with a lease that has not run out. Released and expired claims hold
// nothing; they stay as history.
//
// Whether a claim may hold is decided by the CLAIM_RULE of its kind: at most
// max_holders claims of one kind at once, and no claim together with a holding
// claim of a kind either one's rule excludes. Each holder's claim is its own
// document, so the platform cannot refuse a second claimant; the gateway writes
// the claim first and then judges it against every holding claim on the case,
// read from the document store. Two claimants racing each other read the same set
// and order it the same way (since, then document_id), so they reach the same
// verdict without a lock: the claim that came later loses and is released.

export interface Claim {
  document_id: string
  case_number: number
  claim_kind: string
  holder: string
  state: string
  since: string
  lease_until?: string | null
  note?: string | null
}

export interface ClaimRule {
  claim_kind: string
  max_holders: number
  excludes: string[]
  lease_minutes: number
}

export const DEFAULT_RULE: Omit<ClaimRule, 'claim_kind'> = { max_holders: 1, excludes: [], lease_minutes: 60 }

/** The rule for a kind: its CLAIM_RULE document, or the defaults. */
export function ruleFor(kind: string, rules: ClaimRule[]): ClaimRule {
  const r = rules.find((x) => x.claim_kind === kind)
  return {
    claim_kind: kind,
    max_holders: r?.max_holders ?? DEFAULT_RULE.max_holders,
    excludes: r?.excludes ?? DEFAULT_RULE.excludes,
    lease_minutes: r?.lease_minutes ?? DEFAULT_RULE.lease_minutes,
  }
}

/** Whether a claim holds its case at `now`. */
export function holds(c: Claim, now: Date): boolean {
  if (c.state === 'parked') return true
  if (c.state !== 'active') return false
  return !!c.lease_until && Date.parse(c.lease_until) > now.getTime()
}

/**
 * `holds` as an SQL condition over the CASE_CLAIM reporting view, for readers that
 * list claims across the KB (the gateway's GET /claims, the home page's panel).
 * `p` is the table alias with its dot ("c.") or "".
 */
export function sqlHolds(p = ''): string {
  return `(${p}state = 'parked' OR (${p}state = 'active' AND ${p}lease_until::timestamptz > now()))`
}

/** An active claim whose lease ran out and was never released: what an agent that stopped mid-work leaves. */
export function sqlLapsed(p = ''): string {
  return `(${p}state = 'active' AND (${p}lease_until IS NULL OR ${p}lease_until::timestamptz <= now()))`
}

/** Earlier first: by since, then document_id, so every reader orders claims alike. */
export function claimOrder(a: Claim, b: Claim): number {
  const t = Date.parse(a.since) - Date.parse(b.since)
  if (t !== 0) return t
  return a.document_id < b.document_id ? -1 : a.document_id > b.document_id ? 1 : 0
}

/** Two kinds conflict when either one's rule excludes the other. */
export function excludesEachOther(a: string, b: string, rules: ClaimRule[]): boolean {
  return ruleFor(a, rules).excludes.includes(b) || ruleFor(b, rules).excludes.includes(a)
}

export type Verdict = { ok: true } | { ok: false; blockers: Claim[]; reason: string }

/**
 * May `mine` hold its case, given every claim on the case (mine included, as
 * written)? Only claims that came EARLIER than mine can block it: a later claim
 * that conflicts with mine is the one that loses, when its own verdict is taken.
 */
export function verdict(mine: Claim, claims: Claim[], rules: ClaimRule[], now: Date): Verdict {
  const earlier = claims
    .filter((c) => c.document_id !== mine.document_id && holds(c, now) && claimOrder(c, mine) < 0)
    .sort(claimOrder)
  const rule = ruleFor(mine.claim_kind, rules)
  const sameKind = earlier.filter((c) => c.claim_kind === mine.claim_kind)
  if (sameKind.length >= rule.max_holders) {
    return {
      ok: false,
      blockers: sameKind,
      reason: `${mine.claim_kind} is held by ${sameKind.map((c) => c.holder).join(', ')}`
        + ` (at most ${rule.max_holders} at once)`,
    }
  }
  const excluding = earlier.filter((c) => c.claim_kind !== mine.claim_kind
    && excludesEachOther(c.claim_kind, mine.claim_kind, rules))
  if (excluding.length) {
    return {
      ok: false,
      blockers: excluding,
      reason: excluding.map((c) => `${c.claim_kind} is held by ${c.holder}`).join('; ')
        + `, and ${mine.claim_kind} cannot be held at the same time`,
    }
  }
  return { ok: true }
}

/** The lease end for a claim acquired or renewed at `now`. */
export function leaseUntil(kind: string, rules: ClaimRule[], now: Date): string {
  return new Date(now.getTime() + ruleFor(kind, rules).lease_minutes * 60_000).toISOString()
}
