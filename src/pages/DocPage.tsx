import { Fragment } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useDocument, useTemplate } from '@wip/react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const COMMON_FIELDS = new Set(['title', 'authored_by', 'doc_status', 'tags', 'root', 'body'])

interface RelationshipItem {
  document_id: string
  template_value: string
  data: { source_ref?: string; target_ref?: string; [k: string]: unknown }
}
interface RelationshipsResponse {
  items: RelationshipItem[]
  total: number
}
interface TemplateField {
  name: string
  label?: string
  type?: string
}

export default function DocPage() {
  const { id = '' } = useParams<{ id: string }>()
  const { data: doc, isLoading: docLoading, error: docError } = useDocument(id)
  const { data: template } = useTemplate(doc?.template_id ?? '')

  const { data: rels } = useQuery<RelationshipsResponse>({
    queryKey: ['relationships', id],
    queryFn: async () => {
      const res = await fetch(`/wip/api/document-store/documents/${id}/relationships`)
      if (!res.ok) throw new Error(`relationships ${res.status}`)
      return res.json()
    },
    enabled: !!id,
    staleTime: 30_000,
  })

  if (!id) return null
  if (docLoading) return <p className="text-gray-500">Loading…</p>
  if (docError) return <p className="text-red-600">Failed to load doc: {(docError as Error).message}</p>
  if (!doc) return <p className="text-gray-500">Not found.</p>

  const data = (doc.data ?? {}) as Record<string, unknown>
  const fields: TemplateField[] = (template?.fields as TemplateField[] | undefined) ?? []
  const structured = fields.filter((f) => !COMMON_FIELDS.has(f.name) && data[f.name] !== undefined)
  const body = typeof data.body === 'string' ? data.body : ''
  const isRoot = data.root === true
  const incoming = (rels?.items ?? []).filter((r) => r.data.target_ref === id)
  const outgoing = (rels?.items ?? []).filter((r) => r.data.source_ref === id)
  const orphan = !isRoot && incoming.length === 0 && outgoing.length === 0

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_18rem]">
      <article>
        <header className="mb-6 border-b border-gray-200 pb-4">
          <div className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wide">
            <span className="rounded bg-gray-200 px-2 py-0.5 text-gray-700">{doc.template_value}</span>
            {isRoot && <span className="rounded bg-blue-100 px-2 py-0.5 text-blue-700">root</span>}
            {orphan && <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-700">orphan</span>}
          </div>
          <h1 className="mt-2 text-3xl font-semibold text-gray-900">
            {(data.title as string) || '(untitled)'}
          </h1>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-600">
            {typeof data.authored_by === 'string' && <span>by {data.authored_by}</span>}
            {typeof data.doc_status === 'string' && <span>· {data.doc_status}</span>}
            {doc.created_at && <span>· created {new Date(doc.created_at).toLocaleString()}</span>}
            {doc.updated_at && doc.updated_at !== doc.created_at && (
              <span>· updated {new Date(doc.updated_at).toLocaleString()}</span>
            )}
          </div>
          {Array.isArray(data.tags) && data.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {(data.tags as string[]).map((t) => (
                <span key={t} className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
                  {t}
                </span>
              ))}
            </div>
          )}
        </header>

        {structured.length > 0 && (
          <dl className="mb-6 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
            {structured.map((f) => (
              <Fragment key={f.name}>
                <dt className="text-gray-500">{f.label || f.name}</dt>
                <dd className="text-gray-900">
                  <FieldValue value={data[f.name]} />
                </dd>
              </Fragment>
            ))}
          </dl>
        )}

        {body && (
          <div className="prose prose-gray max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
          </div>
        )}

        {!body && structured.length === 0 && (
          <p className="text-sm text-gray-500">(no content)</p>
        )}
      </article>

      <aside>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Relationships
        </h2>
        <RelationshipList label="Incoming" items={incoming} selfId={id} />
        <RelationshipList label="Outgoing" items={outgoing} selfId={id} />
      </aside>
    </div>
  )
}

function FieldValue({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    return (
      <ul className="list-disc pl-5">
        {value.map((v, i) => (
          <li key={i}>{String(v)}</li>
        ))}
      </ul>
    )
  }
  if (value && typeof value === 'object') {
    return <code className="text-xs">{JSON.stringify(value)}</code>
  }
  return <>{String(value)}</>
}

function RelationshipList({
  label,
  items,
  selfId,
}: {
  label: string
  items: RelationshipItem[]
  selfId: string
}) {
  if (items.length === 0) {
    return <p className="mb-4 text-sm text-gray-500">No {label.toLowerCase()} edges.</p>
  }
  return (
    <div className="mb-4">
      <h3 className="mb-1 text-xs font-semibold text-gray-600">{label}</h3>
      <ul className="space-y-1 text-sm">
        {items.map((r) => {
          const peer = r.data.target_ref === selfId ? r.data.source_ref : r.data.target_ref
          if (!peer) return null
          return (
            <li key={r.document_id} className="flex items-baseline gap-2">
              <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-600">
                {r.template_value}
              </span>
              <Link
                to={`/doc/${peer}`}
                className="truncate font-mono text-xs text-blue-600 hover:underline"
                title={peer}
              >
                {peer}
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
