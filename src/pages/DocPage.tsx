import { Fragment, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useDocument, useTemplate } from '@wip/react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import { ArrowLeft } from 'lucide-react'
import { PrepareButtons } from '../components/PrepareButtons'
import { FlagModal } from '../components/FlagModal'
import { RelationshipGraph } from '../components/RelationshipGraph'
import { parseCaseTitle } from '../lib/casePrefix'

const COMMON_FIELDS = new Set(['title', 'authored_by', 'doc_status', 'tags', 'root', 'body'])

function metaLabel(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

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
  const navigate = useNavigate()
  const location = useLocation()
  const [flagOpen, setFlagOpen] = useState(false)
  const { data: doc, isLoading: docLoading, error: docError } = useDocument(id)
  const { data: template } = useTemplate(doc?.template_id ?? '')

  // location.key === 'default' means the user landed directly on this URL
  // with no prior history (deep-link / refresh) — navigate(-1) would leave
  // the app, so fall back to the start page.
  function goBack() {
    if (location.key === 'default') navigate('/')
    else navigate(-1)
  }

  // CASE-303: ?include=peers embeds the peer doc in each relationship item,
  // collapsing what was a 1+N round-trip waterfall into a single REST call.
  const { data: rels } = useQuery<RelationshipsResponse>({
    queryKey: ['relationships', id],
    queryFn: async () => {
      const res = await fetch(
        `${import.meta.env.BASE_URL}wip/api/document-store/documents/${id}/relationships?include=peers`,
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
  if (docLoading) return <p className="text-text-muted">Loading…</p>
  if (docError) return <p className="text-danger">Failed to load doc: {(docError as Error).message}</p>
  if (!doc) return <p className="text-text-muted">Not found.</p>

  const data = (doc.data ?? {}) as Record<string, unknown>
  const fields: TemplateField[] = (template?.fields as TemplateField[] | undefined) ?? []
  const structured = fields.filter((f) => !COMMON_FIELDS.has(f.name) && data[f.name] !== undefined)
  const body = typeof data.body === 'string' ? data.body : ''
  const isRoot = data.root === true
  const orphan = !isRoot && incoming.length === 0 && outgoing.length === 0

  // Surface metadata.custom alongside template-defined data fields. Render
  // every key (no hide list) in insertion order from the API response —
  // Peter explicitly wants the full audit trail visible (CASE-322, closed).
  // The loader (FRanC's `tools/kb-bulk-mirror.py` + `tools/add-to-kb.py`)
  // owns field order; current order is provenance → workflow → origin.
  const metaCustom = (doc.metadata as { custom?: Record<string, unknown> } | undefined)?.custom ?? {}
  const metaEntries = Object.entries(metaCustom).filter(
    ([, v]) => v !== '' && v !== null && v !== undefined,
  )

  const hasEdges = incoming.length > 0 || outgoing.length > 0

  return (
    <>
      {hasEdges && (
        <RelationshipGraph
          selfId={id}
          selfTitle={(data.title as string) || ''}
          selfTemplate={doc.template_value ?? ''}
          incoming={incoming}
          outgoing={outgoing}
        />
      )}
      <div
      className={
        hasEdges
          ? 'grid gap-10 md:grid-cols-[minmax(0,1fr)_16rem]'
          : 'mx-auto max-w-5xl'
      }
    >
      <article className="min-w-0">
        <header className="mb-6">
          <div className="mb-3 flex items-center gap-3">
            <button
              type="button"
              onClick={goBack}
              className="-ml-1 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-muted hover:bg-background hover:text-text focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back
            </button>
            <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider">
              <span className="rounded bg-gray-100 px-1.5 py-0.5 text-text-muted">
                {doc.template_value}
              </span>
              {isRoot && (
                <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">root</span>
              )}
              {orphan && (
                <span className="rounded bg-accent/10 px-1.5 py-0.5 text-accent">orphan</span>
              )}
            </div>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-text">
            {(data.title as string) || '(untitled)'}
          </h1>
          <p className="mt-1.5 text-xs text-text-muted">
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
                <span key={t} className="rounded bg-gray-100 px-2 py-0.5 text-xs text-text-muted">
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
            className="rounded-md border border-accent/20 bg-accent/5 px-3 py-1 text-xs font-medium text-accent hover:bg-accent/10 focus:outline-none focus:ring-2 focus:ring-accent/40"
          >
            Flag for YAC
          </button>
          <PrepareButtons docId={id} docTitle={(data.title as string) || '(untitled)'} />
        </div>

        {(structured.length > 0 || metaEntries.length > 0) && (
          <dl className="mb-8 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
            {structured.map((f) => (
              <Fragment key={f.name}>
                <dt className="text-text-muted">{f.label || f.name}</dt>
                <dd className="text-text">
                  <FieldValue value={data[f.name]} />
                </dd>
              </Fragment>
            ))}
            {metaEntries.map(([k, v]) => (
              <Fragment key={`meta:${k}`}>
                <dt className="text-text-muted">{metaLabel(k)}</dt>
                <dd className="text-text">
                  <FieldValue value={v} />
                </dd>
              </Fragment>
            ))}
          </dl>
        )}

        {body && (
          <div className="prose prose-gray prose-sm max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkFrontmatter]}>{body}</ReactMarkdown>
          </div>
        )}

        {!body && structured.length === 0 && (
          <p className="text-sm text-text-muted">(no content)</p>
        )}
      </article>

      {hasEdges && (
        <aside>
          <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
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
    </>
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
    return <p className="mb-4 text-sm text-text-muted">No {label.toLowerCase()} edges.</p>
  }
  return (
    <div className="mb-4">
      <h3 className="mb-1 text-xs font-semibold text-text-muted">{label}</h3>
      <ul className="space-y-2 text-sm">
        {items.map((r) => {
          const peerId = r.data.target_ref === selfId ? r.data.source_ref : r.data.target_ref
          if (!peerId) return null
          const peer = r.peer
          const errorCode = r.peer_error_code
          const isInactive = peer?.status === 'inactive'
          const parsed = parseCaseTitle(peer?.data?.title)
          const fullTitle = peer?.data?.title || peerId
          return (
            <li key={r.document_id}>
              <Link
                to={`/doc/${peerId}`}
                className="block rounded px-1 py-1 hover:bg-background"
                title={fullTitle}
              >
                {/* Top row: case-number chip + slug title */}
                <div className="flex items-baseline gap-1.5">
                  {parsed.caseNumber !== null && (
                    <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-primary">
                      CASE-{parsed.caseNumber}
                    </span>
                  )}
                  <span
                    className={`min-w-0 truncate text-sm ${isInactive ? 'text-text-muted' : 'text-text'}`}
                  >
                    {parsed.slug || (
                      <span className="font-mono text-xs text-text-muted">{peerId}</span>
                    )}
                  </span>
                </div>
                {/* Bottom row: edge-type + peer-template + status pills */}
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                    {r.template_value}
                  </span>
                  {peer && peer.template_value !== 'CASE_RECORD' && (
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                      {peer.template_value}
                    </span>
                  )}
                  {isInactive && (
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                      inactive
                    </span>
                  )}
                  {errorCode && (
                    <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
                      {errorCode}
                    </span>
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
