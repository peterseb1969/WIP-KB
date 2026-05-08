import { Fragment, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useDocument, useTemplate } from '@wip/react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { PrepareButtons } from '../components/PrepareButtons'
import { FlagModal } from '../components/FlagModal'

const COMMON_FIELDS = new Set(['title', 'authored_by', 'doc_status', 'tags', 'root', 'body'])

interface PeerProjection {
  document_id: string
  namespace: string
  template_value: string
  status?: string
  data?: { title?: string; doc_status?: string }
}
interface RelationshipItem {
  document_id: string
  template_value: string
  data: { source_ref?: string; target_ref?: string; [k: string]: unknown }
  peer?: PeerProjection | null
  peer_error_code?: 'not_found' | 'forbidden' | 'archived' | null
  peer_error?: string | null
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
  const [flagOpen, setFlagOpen] = useState(false)
  const { data: doc, isLoading: docLoading, error: docError } = useDocument(id)
  const { data: template } = useTemplate(doc?.template_id ?? '')

  // CASE-303: ?include=peers embeds the peer doc in each relationship item,
  // collapsing what was a 1+N round-trip waterfall into a single REST call.
  const { data: rels } = useQuery<RelationshipsResponse>({
    queryKey: ['relationships', id],
    queryFn: async () => {
      const res = await fetch(
        `/wip/api/document-store/documents/${id}/relationships?include=peers`,
      )
      if (!res.ok) throw new Error(`relationships ${res.status}`)
      return res.json()
    },
    enabled: !!id,
    staleTime: 30_000,
  })

  const incoming = (rels?.items ?? []).filter((r) => r.data.target_ref === id)
  const outgoing = (rels?.items ?? []).filter((r) => r.data.source_ref === id)

  if (!id) return null
  if (docLoading) return <p className="text-gray-500">Loading…</p>
  if (docError) return <p className="text-red-600">Failed to load doc: {(docError as Error).message}</p>
  if (!doc) return <p className="text-gray-500">Not found.</p>

  const data = (doc.data ?? {}) as Record<string, unknown>
  const fields: TemplateField[] = (template?.fields as TemplateField[] | undefined) ?? []
  const structured = fields.filter((f) => !COMMON_FIELDS.has(f.name) && data[f.name] !== undefined)
  const body = typeof data.body === 'string' ? data.body : ''
  const isRoot = data.root === true
  const orphan = !isRoot && incoming.length === 0 && outgoing.length === 0

  const hasEdges = incoming.length > 0 || outgoing.length > 0

  return (
    <div
      className={
        hasEdges
          ? 'grid gap-10 md:grid-cols-[minmax(0,1fr)_16rem]'
          : 'mx-auto max-w-5xl'
      }
    >
      <article className="min-w-0">
        <header className="mb-6">
          <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider">
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-600">
              {doc.template_value}
            </span>
            {isRoot && (
              <span className="rounded bg-blue-50 px-1.5 py-0.5 text-blue-700">root</span>
            )}
            {orphan && (
              <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-700">orphan</span>
            )}
          </div>
          <h1 className="mt-2 text-2xl font-medium tracking-tight text-gray-900">
            {(data.title as string) || '(untitled)'}
          </h1>
          <p className="mt-1.5 text-xs text-gray-500">
            {[
              typeof data.authored_by === 'string' && data.authored_by,
              typeof data.doc_status === 'string' && data.doc_status,
              doc.created_at && `created ${new Date(doc.created_at).toLocaleString()}`,
              doc.updated_at &&
                doc.updated_at !== doc.created_at &&
                `updated ${new Date(doc.updated_at).toLocaleString()}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {Array.isArray(data.tags) && data.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {(data.tags as string[]).map((t) => (
                <span key={t} className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                  {t}
                </span>
              ))}
            </div>
          )}
        </header>

        <div className="mb-8 flex flex-wrap items-center gap-2 border-y border-gray-100 py-2">
          <button
            type="button"
            onClick={() => setFlagOpen(true)}
            className="rounded border border-amber-300 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100"
          >
            Flag for YAC
          </button>
          <PrepareButtons docId={id} docTitle={(data.title as string) || '(untitled)'} />
        </div>

        {structured.length > 0 && (
          <dl className="mb-8 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
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
          <div className="prose prose-gray prose-sm max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
          </div>
        )}

        {!body && structured.length === 0 && (
          <p className="text-sm text-gray-500">(no content)</p>
        )}
      </article>

      {hasEdges && (
        <aside>
          <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
            Relationships
          </h2>
          <RelationshipList label="Incoming" items={incoming} selfId={id} />
          <RelationshipList label="Outgoing" items={outgoing} selfId={id} />
        </aside>
      )}

      {flagOpen && (
        <FlagModal
          sourceDocId={id}
          sourceDocTitle={(data.title as string) || '(untitled)'}
          onClose={() => setFlagOpen(false)}
        />
      )}
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
      <ul className="space-y-2 text-sm">
        {items.map((r) => {
          const peerId = r.data.target_ref === selfId ? r.data.source_ref : r.data.target_ref
          if (!peerId) return null
          const peer = r.peer
          const errorCode = r.peer_error_code
          const isInactive = peer?.status === 'inactive'
          return (
            <li key={r.document_id}>
              <Link to={`/doc/${peerId}`} className="block rounded px-1 py-0.5 hover:bg-gray-50">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-600">
                    {r.template_value}
                  </span>
                  {peer && (
                    <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-700">
                      {peer.template_value}
                    </span>
                  )}
                  {isInactive && (
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                      inactive
                    </span>
                  )}
                  {errorCode && (
                    <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                      {errorCode}
                    </span>
                  )}
                </div>
                <div
                  className={`mt-0.5 truncate text-sm ${isInactive ? 'text-gray-400' : 'text-gray-900'}`}
                  title={peer?.data?.title || peerId}
                >
                  {peer?.data?.title || (
                    <span className="font-mono text-xs text-gray-400">{peerId}</span>
                  )}
                </div>
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
