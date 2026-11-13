import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { fetchClaimsInProgress, type ClaimInProgress } from '../lib/reporting'
import { formatWipDateTime } from '../lib/datetime'

/** How long ago an ISO time was, coarsely: 40m, 5h, 3d. */
function ago(iso: string | null): string {
  if (!iso) return '?'
  const mins = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000))
  return mins < 120 ? `${mins}m` : mins < 48 * 60 ? `${Math.floor(mins / 60)}h` : `${Math.floor(mins / 1440)}d`
}

function ClaimRow({ c }: { c: ClaimInProgress }) {
  const when = c.lapsed
    ? `lease ran out ${ago(c.leaseUntil)} ago`
    : c.state === 'parked'
      ? `parked ${ago(c.since)}`
      : `lease until ${c.leaseUntil ? formatWipDateTime(c.leaseUntil) : '?'}`
  const handle = `CASE-${c.caseNumber}`
  return (
    <li className={`flex flex-wrap items-baseline gap-x-2 gap-y-1 py-1.5 text-sm ${c.lapsed ? 'opacity-60' : ''}`}>
      {c.caseDocumentId
        ? <Link to={`/doc/${c.caseDocumentId}`} className="font-mono text-xs text-primary hover:underline">{handle}</Link>
        : <span className="font-mono text-xs text-text-muted">{handle}</span>}
      <span className="min-w-0 flex-1 truncate text-text" title={c.title ?? undefined}>{c.title ?? ''}</span>
      <span
        className="rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent"
        title={c.note ? `Note: ${c.note}` : undefined}
      >
        {c.kind} · {c.holder}
      </span>
      <span className="text-xs text-text-muted" title={c.leaseUntil ?? c.since ?? undefined}>{when}</span>
    </li>
  )
}

/**
 * Everything in progress across the KB: every claim that holds a case (parked
 * first, then by soonest lease end), and claims whose lease ran out without a
 * release. Read-only: claims are taken and released by agents through kbc.
 * Hidden when nothing is claimed.
 */
export function InProgressPanel({ namespace }: { namespace: string }) {
  const { data } = useQuery({
    queryKey: ['claims-in-progress', namespace],
    queryFn: () => fetchClaimsInProgress(namespace),
    staleTime: 15_000,
  })
  if (!data || (!data.holding.length && !data.lapsed.length)) return null
  return (
    <section className="mb-6 rounded-lg border border-gray-200 bg-surface px-4 py-3">
      <h2 className="text-sm font-semibold text-text">
        In progress <span className="font-normal text-text-muted">({data.holding.length})</span>
      </h2>
      {data.holding.length > 0
        ? <ul className="divide-y divide-gray-100">{data.holding.map((c) => <ClaimRow key={`${c.caseNumber}/${c.kind}/${c.holder}`} c={c} />)}</ul>
        : <p className="py-1.5 text-sm text-text-muted">Nothing is claimed right now.</p>}
      {data.lapsed.length > 0 && (
        <>
          <h3 className="mt-3 text-xs font-medium text-text-muted" title="Active claims whose lease passed and were never released: usually an agent that stopped mid-work">
            Lease ran out, never released ({data.lapsed.length})
          </h3>
          <ul className="divide-y divide-gray-100">{data.lapsed.map((c) => <ClaimRow key={`${c.caseNumber}/${c.kind}/${c.holder}`} c={c} />)}</ul>
        </>
      )}
    </section>
  )
}
