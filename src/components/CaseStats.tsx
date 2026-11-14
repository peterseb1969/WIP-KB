import { Link } from 'react-router-dom'

interface CaseStatDoc {
  template_value: string
  data: { status?: string }
}

// Clickable case stats, each linking to the CASE_RECORD search pre-filtered: open,
// responded and both by status (s=open, s=responded, s=open,responded; the two are
// disjoint, so the combined count is their sum), and ready to implement — cases with
// an outstanding implement flag (flag=implement), which is not a status. Hidden
// entirely when none of them has anything to link to.
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
  readyToImplement,
  className = '',
}: {
  docs?: CaseStatDoc[]
  open?: number
  responded?: number
  /** Cases with an outstanding implement flag; the link is left out while unknown. */
  readyToImplement?: number
  className?: string
}) {
  const cases = (docs ?? []).filter((d) => d.template_value === 'CASE_RECORD')
  const open = openProp ?? cases.filter((d) => d.data.status === 'open').length
  const responded = respondedProp ?? cases.filter((d) => d.data.status === 'responded').length
  if (open === 0 && responded === 0 && !readyToImplement) return null

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
      {readyToImplement !== undefined && (
        <Link to={`${base}&flag=implement`} className={LINK} title="Cases with an implement flag no implement or close response has answered yet">
          <span className="font-semibold text-text">{readyToImplement}</span> ready&nbsp;to&nbsp;implement
        </Link>
      )}
    </div>
  )
}
