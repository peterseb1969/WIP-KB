import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Link } from 'react-router-dom'
import { formatWipDateTime } from '../lib/datetime'

// CASE-506 (UI half): render a case's responses inline as collapsible sections,
// so the full thread reads on the case page with no separate navigation.
export interface ResponseDoc {
  document_id: string
  created_at?: string
  data?: {
    response_kind?: string
    author?: string
    response_seq?: number
    body?: string
  }
}

/** One relationship of a response to another document (other than its case). */
export interface ResponseLink {
  edgeType: string // e.g. REFERENCES
  outgoing: boolean // true: response → peer; false: peer → response
  peerId: string
  title: string
  templateValue: string
}

// response_kind → label + pill classes. Distinguishes a comment from a
// status-transition (respond/close/implement) at a glance.
interface KindStyle {
  label: string
  cls: string
}
const DEFAULT_KIND: KindStyle = { label: 'response', cls: 'bg-primary/10 text-primary' }
const KIND_STYLE: Record<string, KindStyle> = {
  respond: DEFAULT_KIND,
  comment: { label: 'comment', cls: 'bg-gray-100 text-text-muted' },
  close: { label: 'closed', cls: 'bg-gray-200 text-gray-600' },
  implement: { label: 'implemented', cls: 'bg-green-100 text-green-700' },
}

function LinkList({ links }: { links: ResponseLink[] }) {
  return (
    <ul className="mt-3 space-y-1 border-t border-gray-100 pt-2 text-xs">
      {links.map((l) => (
        <li key={`${l.edgeType}:${l.outgoing}:${l.peerId}`} className="flex items-baseline gap-2">
          <span className="shrink-0 text-text-muted">
            {l.outgoing ? '' : '← '}
            {l.edgeType.toLowerCase().replace(/_/g, ' ')}
          </span>
          <Link to={`/doc/${l.peerId}`} className="min-w-0 truncate text-primary underline-offset-2 hover:underline">
            {l.title || l.peerId}
          </Link>
          {l.templateValue && (
            <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-muted">
              {l.templateValue}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

/**
 * Inline, collapsible thread of a case's CASE_RESPONSE docs (seq-ordered, latest
 * auto-expanded, kind-colored). (CASE-506/511)
 * @param responses - the case's response docs.
 * @param links - each response's relationships to other documents, by response id.
 */
export function CaseThread({
  responses,
  links,
}: {
  responses: ResponseDoc[]
  links?: Record<string, ResponseLink[]>
}) {
  if (responses.length === 0) return null
  return (
    <section id="case-thread" className="mt-10 scroll-mt-4 border-t border-gray-100 pt-6">
      <h2 className="mb-4 text-sm font-semibold text-text">
        Responses <span className="text-text-muted">({responses.length})</span>
      </h2>
      <div className="space-y-2">
        {responses.map((r, i) => {
          const kind = r.data?.response_kind || 'respond'
          const style = KIND_STYLE[kind] ?? DEFAULT_KIND
          const seq = r.data?.response_seq
          const author = r.data?.author || 'unknown'
          const when = formatWipDateTime(r.created_at)
          const body = r.data?.body || ''
          const isLast = i === responses.length - 1 // auto-expand the most recent
          const own = links?.[r.document_id] ?? []
          return (
            <details
              key={r.document_id}
              open={isLast}
              className="rounded-md border border-gray-200 bg-surface"
            >
              <summary className="flex cursor-pointer items-center gap-2 px-4 py-2.5 text-sm">
                {seq !== undefined && (
                  <span className="font-mono text-xs text-text-muted">#{seq}</span>
                )}
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${style.cls}`}
                >
                  {style.label}
                </span>
                <span className="min-w-0 truncate text-text">{author}</span>
                {own.length > 0 && (
                  <span
                    className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary"
                    title={`${own.length} link${own.length === 1 ? '' : 's'} to other documents`}
                  >
                    {own.length} link{own.length === 1 ? '' : 's'}
                  </span>
                )}
                {when && <span className="ml-auto shrink-0 text-xs text-text-muted">{when}</span>}
              </summary>
              <div className="border-t border-gray-100 px-4 py-3">
                {body ? (
                  <div className="prose prose-gray prose-sm max-w-none">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
                  </div>
                ) : (
                  <p className="text-sm text-text-muted">(no content)</p>
                )}
                {own.length > 0 && <LinkList links={own} />}
              </div>
            </details>
          )
        })}
      </div>
    </section>
  )
}
