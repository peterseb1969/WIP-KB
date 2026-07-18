import { Link } from 'react-router-dom'

interface CaseStatDoc {
  template_value: string
  data: { status?: string }
}

// Three clickable case-status stats — open, responded, and both — each linking to
// the CASE_RECORD search pre-filtered to that status (open → s=open, responded →
// s=responded, both → s=open,responded). `open` and `responded` are disjoint
// statuses, so the combined count is their sum. Hidden entirely when there are no
// open or responded cases — nothing actionable to link to.
//
// Counts are supplied directly (HomePage sources them from a reporting aggregation
// over ALL cases — CASE-687) or derived from an in-scope `docs` set (SearchPage,
// which still holds the corpus). Explicit counts win when provided.
const LINK =
  'rounded-md border border-gray-200 px-2.5 py-1 transition hover:border-primary/40 hover:bg-background'

export function CaseStats({
  docs,
  open: openProp,
  responded: respondedProp,
  className = '',
}: {
  docs?: CaseStatDoc[]
  open?: number
  responded?: number
  className?: string
}) {
  const cases = (docs ?? []).filter((d) => d.template_value === 'CASE_RECORD')
  const open = openProp ?? cases.filter((d) => d.data.status === 'open').length
  const responded = respondedProp ?? cases.filter((d) => d.data.status === 'responded').length
  if (open === 0 && responded === 0) return null

  const base = '/search?t=CASE_RECORD'
  return (
    <div className={`flex flex-wrap items-center gap-2 text-xs text-text-muted ${className}`}>
      <span className="font-medium">⚑ Cases</span>
      <Link to={`${base}&s=open`} className={LINK} title="Open cases">
        <span className="font-semibold text-text">{open}</span> open
      </Link>
      <Link to={`${base}&s=responded`} className={LINK} title="Responded cases">
        <span className="font-semibold text-text">{responded}</span> responded
      </Link>
      <Link to={`${base}&s=open,responded`} className={LINK} title="Open or responded cases">
        <span className="font-semibold text-text">{open + responded}</span> open&nbsp;or&nbsp;responded
      </Link>
    </div>
  )
}
