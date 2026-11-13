import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { fetchAwaitingOwner } from '../lib/reporting'
import { formatWipDateTime } from '../lib/datetime'

/**
 * Cases whose questions to the owner wait for an answer: a response ended with a
 * `## Questions` section and no person has written in the thread since. Oldest
 * question first. Each row opens the case, where the Answer box sits under the
 * thread. Hidden when nothing waits.
 */
export function WaitingPanel({ namespace }: { namespace: string }) {
  const { data } = useQuery({
    queryKey: ['awaiting-owner', namespace],
    queryFn: () => fetchAwaitingOwner(namespace),
    staleTime: 15_000,
  })
  if (!data?.length) return null
  return (
    <section className="mb-6 rounded-lg border border-primary/30 bg-surface px-4 py-3">
      <h2 className="text-sm font-semibold text-text">
        Waiting for you <span className="font-normal text-text-muted">({data.length})</span>
      </h2>
      <ul className="divide-y divide-gray-100">
        {data.map((c) => (
          <li key={c.caseNumber} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 py-1.5 text-sm">
            <Link to={`/doc/${c.caseDocumentId}`} className="font-mono text-xs text-primary hover:underline">
              CASE-{c.caseNumber}
            </Link>
            <span className="min-w-0 flex-1 truncate text-text" title={c.title ?? undefined}>{c.title ?? ''}</span>
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
              {c.questions} question{c.questions === 1 ? '' : 's'}
            </span>
            <span className="text-xs text-text-muted" title={`Asked in CASE-${c.caseNumber}#${c.responseSeq}`}>
              {c.askedBy.replace(/-\d{8}-\d{4,6}$/, '')} · {formatWipDateTime(c.askedAt)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
