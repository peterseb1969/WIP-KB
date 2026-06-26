import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

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

export function CaseThread({ responses }: { responses: ResponseDoc[] }) {
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
          const when = r.created_at ? new Date(r.created_at).toLocaleString() : ''
          const body = r.data?.body || ''
          const isLast = i === responses.length - 1 // auto-expand the most recent
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
              </div>
            </details>
          )
        })}
      </div>
    </section>
  )
}
