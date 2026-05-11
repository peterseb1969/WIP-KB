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
