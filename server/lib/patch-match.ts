// How a patch write locates the one document it changes.
//
// A patch is { patch, match }. `match` names fields that, together, must
// identify exactly ONE document: every key is a filter (AND), and a match that
// several documents satisfy is refused rather than resolved to whichever came
// first. Patching an arbitrary one of several documents silently replaced
// another case's response once; a refusal is the only safe answer.
//
// `document_id` is the exception: it fetches the document directly, so it must
// stand alone.
//
// No imports on purpose: the tests run this file with plain `node --test`.

export type MatchFilter = { field: string; operator: 'eq'; value: unknown }

export type MatchProblem = { status: 422; error: string }

// Rows per query when checking a match. Several rows of ONE document (more than
// one active version) are still one match; more distinct documents than fit
// here are certainly ambiguous.
export const MATCH_PAGE_SIZE = 25

export function validateMatch(match: Record<string, unknown>): MatchProblem | null {
  const keys = Object.keys(match)
  if (keys.length === 0) {
    return { status: 422, error: 'patch requires match: {<field>: value, …} to locate the doc' }
  }
  if (keys.includes('document_id') && keys.length > 1) {
    return {
      status: 422,
      error: 'match on document_id locates the doc by itself; drop the other match fields',
    }
  }
  return null
}

export function matchFilters(match: Record<string, unknown>): MatchFilter[] {
  return Object.entries(match).map(([k, v]) => ({ field: `data.${k}`, operator: 'eq', value: v }))
}

export function describeMatch(match: Record<string, unknown>): string {
  return Object.entries(match).map(([k, v]) => `${k}=${v}`).join(', ')
}

export type MatchOutcome<T> =
  | { kind: 'none' }
  | { kind: 'one'; doc: T }
  | { kind: 'ambiguous'; count: number }

// Decide from one query page: `items` (at most MATCH_PAGE_SIZE rows) and the
// query's `total`.
export function resolveMatch<T extends { document_id?: unknown }>(
  items: T[],
  total: number,
): MatchOutcome<T> {
  const ids = new Set(items.map((d) => String(d.document_id)))
  if (ids.size === 0) return { kind: 'none' }
  if (ids.size > 1) return { kind: 'ambiguous', count: ids.size }
  // One document on this page; more rows than the page holds means the page
  // did not see everything, so it cannot vouch for uniqueness.
  const [first] = items
  if (first === undefined || total > items.length) return { kind: 'ambiguous', count: total }
  return { kind: 'one', doc: first }
}
