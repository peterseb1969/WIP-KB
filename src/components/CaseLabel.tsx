import { caseParts, docLabel } from '../lib/casePrefix'

// Shared list-row label for HomePage + SearchPage. For CASE_RECORD docs it shows
// a "CASE-N" chip + slug, sourcing the number from data.case_number (gateway-filed
// cases, CASE-464) with the legacy title prefix as fallback. Non-case docs fall
// back to docLabel (title → session_id → path).
/**
 * Compact identity label for a doc: a `CASE-<n>` chip when the doc has a
 * case_number, else a title/slug.
 * @param data - the doc's data (title, case_number, session_id, path) used to derive the label.
 */
export function CaseLabel({
  data,
}: {
  data: { title?: unknown; case_number?: unknown; session_id?: unknown; path?: unknown }
}) {
  const { num, slug } = caseParts(data)
  if (num !== null) {
    return (
      <span className="inline-flex items-baseline gap-1.5">
        <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 font-mono text-xs font-semibold text-primary">
          CASE-{num}
        </span>
        <span>{slug}</span>
      </span>
    )
  }
  const label = docLabel(data, '')
  return label ? <>{label}</> : <span className="italic text-text-muted">(untitled)</span>
}
