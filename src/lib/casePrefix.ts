export interface ParsedCaseTitle {
  caseNumber: number | null
  slug: string
  full: string
}

// Titles of CASE_RECORD docs follow "CASE-N: slug…" by FRanC's loader convention.
// Split the prefix out so renderers can show the case-number as a chip while
// keeping the slug as readable text. Falls back to the full title for non-case
// docs or titles that don't match the convention.
export function parseCaseTitle(title: string | undefined | null): ParsedCaseTitle {
  if (!title) return { caseNumber: null, slug: '', full: '' }
  const m = title.match(/^CASE-(\d+):\s*(.+)$/)
  if (m) return { caseNumber: parseInt(m[1]!, 10), slug: m[2]!, full: title }
  return { caseNumber: null, slug: title, full: title }
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
