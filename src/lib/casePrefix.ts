export interface ParsedCaseTitle {
  caseNumber: number | null
  slug: string
  full: string
}

// Resolve a CASE_RECORD's number + readable slug for rendering as a chip + title.
// The number's source of truth is the structured `data.case_number` field, set
// server-side by the gateway file verb (CASE-464). Pass it as `caseNumber`.
// The legacy "CASE-N: slug…" title prefix (FRanC's old loader convention) is kept
// as a fallback for docs filed before the cutover, whose titles bake the number in.
// Falls back to the full title for non-case docs / titles without a match.
export function parseCaseTitle(
  title: string | undefined | null,
  caseNumber?: number | null,
): ParsedCaseTitle {
  const full = title ?? ''
  const m = full.match(/^CASE-(\d+):\s*(.+)$/)
  const caseNum =
    typeof caseNumber === 'number' ? caseNumber : m ? parseInt(m[1]!, 10) : null
  // Strip a legacy "CASE-N: " prefix from the slug if present; else use the title as-is.
  const slug = m ? m[2]! : full
  return { caseNumber: caseNum, slug, full }
}

// List-row helper: the case-number (structured data.case_number, legacy title
// prefix as fallback) plus the slug to render beside it. num is null for
// non-case docs, so callers fall back to docLabel.
export function caseParts(data: { title?: unknown; case_number?: unknown }): {
  num: number | null
  slug: string
} {
  const title = typeof data.title === 'string' ? data.title : ''
  const num = typeof data.case_number === 'number' ? data.case_number : null
  const p = parseCaseTitle(title, num)
  return { num: p.caseNumber, slug: p.slug }
}

// Resolve the best human-readable label for a document. Most templates carry a
// `title`, but SESSION (CASE-389) uses `session_id` as its identifier and has no
// title field, and DOCUMENT (CASE-346) can fall back to its repo-relative `path`.
// Resolution order: title → session_id → path → the document_id as last resort.
// Returns null only when `documentId` is also falsy — callers that want an
// "(untitled)" placeholder can pass '' as documentId and check for null.
export function docLabel(
  data: { title?: unknown; session_id?: unknown; path?: unknown } | undefined,
  documentId: string,
): string {
  const pick = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v : null
  return pick(data?.title) ?? pick(data?.session_id) ?? pick(data?.path) ?? documentId
}
