import { questionsMarker, threadCounts, threadMarker, type ThreadSummary } from '../../server/lib/case-thread'

/**
 * A case's thread at a glance on the case list: response counts ("R1 I1 C3":
 * respond, implement, comment, close) and a marker when the case was reopened
 * or still waits for its first answer. Read-only.
 */
export function ThreadChip({ thread }: { thread: ThreadSummary | undefined }) {
  if (!thread) return null
  const counts = threadCounts(thread)
  const marker = threadMarker(thread)
  const asks = questionsMarker(thread)
  return (
    <>
      {asks && (
        <span
          title="A response asks you questions, and no one has answered them yet"
          className="rounded-full bg-primary px-2 py-0.5 text-xs text-white"
        >
          {asks}
        </span>
      )}
      {counts && (
        <span
          title="Responses: R respond, I implement, C comment, X close"
          className="rounded-full bg-gray-100 px-2 py-0.5 font-mono text-xs text-text-muted"
        >
          {counts}
        </span>
      )}
      {marker && (
        <span
          title={thread.reopened
            ? (thread.reanswered
              ? 'Finished once (implemented or closed), reopened, and answered again since'
              : 'Finished once (implemented or closed), then reopened')
            : 'Open and not answered yet: no respond response'}
          className={thread.reopened
            ? 'rounded-full bg-danger/10 px-2 py-0.5 text-xs text-danger'
            : 'rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary'}
        >
          {marker}
        </span>
      )}
    </>
  )
}
