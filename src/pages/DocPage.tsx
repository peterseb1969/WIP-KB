import { Fragment, useMemo, useState } from 'react'
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
import { CaseThread, type ResponseDoc } from '../components/CaseThread'
import { parseCaseTitle, docLabel } from '../lib/casePrefix'
import { CORPUS_NS } from '../lib/namespaces'

const COMMON_FIELDS = new Set(['title', 'authored_by', 'doc_status', 'tags', 'root', 'body'])

function metaLabel(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

interface PeerProjection {
  document_id: string
  namespace: string
  template_value: string
  status?: string
  data?: { title?: string; doc_status?: string; status?: string; case_number?: number; session_id?: string; path?: string }
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
  array_item_type?: string
}

/** A field whose value(s) are document references (kb_refs → corpus docs). */
function isReferenceField(f: TemplateField): boolean {
  return f.type === 'reference' || (f.type === 'array' && f.array_item_type === 'reference')
}

interface RefDocMeta {
  title: string
  template_value: string
  namespace: string
}

/**
 * `/doc/:id` route — a single KB document: rendered markdown body, structured
 * fields, the RelationshipGraph, the inline CaseThread (CASE_RESPONSE replies),
 * the FlagModal (flag-for-YAC — the one UI write), and the PrepareButtons.
 */
export default function DocPage() {
  const { id = '' } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const [flagOpen, setFlagOpen] = useState(false)
  const { data: doc, isLoading: docLoading, error: docError } = useDocument(id)
  const { data: template } = useTemplate(doc?.template_id ?? '')

  // CASE-518: document-reference fields (e.g. LIBRARY_DOC.kb_refs → corpus docs)
  // store an array of document_ids. Collect them across all reference fields and
  // resolve each to a title/type for a readable link (the refs may live in another
  // namespace — reads are by global UUID, so no namespace needed).
  const refIds = useMemo(() => {
    const fields = (template?.fields as TemplateField[] | undefined) ?? []
    const data = (doc?.data ?? {}) as Record<string, unknown>
    const ids = new Set<string>()
    for (const f of fields) {
      if (!isReferenceField(f)) continue
      const v = data[f.name]
      if (typeof v === 'string') ids.add(v)
      else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') ids.add(x)
    }
    return Array.from(ids).sort()
  }, [template, doc])

  const { data: refDocs } = useQuery<Record<string, RefDocMeta>>({
    queryKey: ['kb-refs', refIds],
    queryFn: async () => {
      const base = import.meta.env.BASE_URL
      const out: Record<string, RefDocMeta> = {}
      await Promise.all(
        refIds.map(async (rid) => {
          const res = await fetch(`${base}wip/api/document-store/documents/${rid}`)
          if (!res.ok) return
          const d = await res.json()
          out[rid] = {
            title: d.data?.title ?? rid,
            template_value: d.template_value ?? '',
            namespace: d.namespace ?? '',
          }
        }),
      )
      return out
    },
    enabled: refIds.length > 0,
    staleTime: 30_000,
  })

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

  // CASE-506: a case's responses arrive as incoming RESPONDS_TO edges. Split them
  // out — they get dots in the graph + an inline collapsible thread, not generic
  // peer nodes / list rows.
  const isResponseEdge = (r: RelationshipItem) =>
    r.template_value === 'RESPONDS_TO' && r.peer?.template_value === 'CASE_RESPONSE'
  const responseEdges = incoming.filter(isResponseEdge)
  const incomingEdges = incoming.filter((r) => !isResponseEdge(r))

  // CASE-350: incoming SUPERSEDES = something newer replaces this doc.
  // Edge direction is newer→older, so source = replacing doc, target = this.
  const supersededBy = incoming.filter((r) => r.template_value === 'SUPERSEDES')

  // Per-peer degree fetch for the "more-neighbors" badge in the neighborhood
  // graph. Case-status now rides along in peer.data.status (CASE-408 migrated
  // CASE_RECORD's header_fields from `metadata.custom.case_status` to top-level
  // `status` after CASE-404 populated the field). Degree still needs a per-peer
  // round-trip because the peer projection doesn't carry relationship counts —
  // that'd be a separate platform request.
  const peerIds = useMemo(() => {
    const ids = new Set<string>()
    for (const e of rels?.items ?? []) {
      if (e.peer?.document_id) ids.add(e.peer.document_id)
    }
    return Array.from(ids).sort()
  }, [rels])
  const { data: peerEnrichment } = useQuery<Record<string, { hasMoreNeighbors: boolean }>>({
    queryKey: ['peer-degree', peerIds],
    queryFn: async () => {
      const result: Record<string, { hasMoreNeighbors: boolean }> = {}
      const base = import.meta.env.BASE_URL
      await Promise.all(
        peerIds.map(async (peerId) => {
          const relsRes = await fetch(`${base}wip/api/document-store/documents/${peerId}/relationships`)
          let degree = 0
          if (relsRes.ok) {
            const peerRels = await relsRes.json()
            degree = Array.isArray(peerRels?.items) ? peerRels.items.length : 0
          }
          result[peerId] = { hasMoreNeighbors: degree > 1 }
        }),
      )
      return result
    },
    enabled: peerIds.length > 0,
    staleTime: 30_000,
  })

  // CASE-506: the include=peers projection carries only title/status/case_number
  // for response peers — NOT body/response_kind/response_seq — so fetch each
  // response doc's full content (parallel batch, eager with the case view).
  // Sorted by response_seq for chronological thread order.
  const responseIds = useMemo(
    () =>
      (rels?.items ?? [])
        .filter(
          (r) =>
            r.data.target_ref === id &&
            r.template_value === 'RESPONDS_TO' &&
            r.peer?.template_value === 'CASE_RESPONSE' &&
            !!r.peer?.document_id,
        )
        .map((r) => r.peer!.document_id)
        .sort(),
    [rels, id],
  )
  const { data: responseDocs } = useQuery<ResponseDoc[]>({
    queryKey: ['case-responses', responseIds],
    queryFn: async () => {
      const base = import.meta.env.BASE_URL
      const docs = await Promise.all(
        responseIds.map(async (rid) => {
          const res = await fetch(`${base}wip/api/document-store/documents/${rid}`)
          return res.ok ? ((await res.json()) as ResponseDoc) : null
        }),
      )
      return docs
        .filter((d): d is ResponseDoc => !!d)
        .sort((a, b) => (a.data?.response_seq ?? 0) - (b.data?.response_seq ?? 0))
    },
    enabled: responseIds.length > 0,
    staleTime: 30_000,
  })

  if (!id) return null
  if (docLoading) return <p className="text-text-muted">Loading…</p>
  if (docError) return <p className="text-danger">Failed to load doc: {(docError as Error).message}</p>
  if (!doc) return <p className="text-text-muted">Not found.</p>

  const data = (doc.data ?? {}) as Record<string, unknown>
  const fields: TemplateField[] = (template?.fields as TemplateField[] | undefined) ?? []
  const structured = fields.filter((f) => !COMMON_FIELDS.has(f.name) && data[f.name] !== undefined)
  const body = typeof data.body === 'string' ? data.body : ''
  // CASE-464: gateway-filed cases carry their number in structured data.case_number,
  // not a "CASE-N:" title prefix. Source the header chip from the field, with the
  // legacy title prefix as fallback for pre-cutover cases.
  const selfParsed = parseCaseTitle(
    typeof data.title === 'string' ? data.title : '',
    typeof data.case_number === 'number' ? data.case_number : null,
  )
  const isRoot = data.root === true
  const orphan = !isRoot && incoming.length === 0 && outgoing.length === 0

  // Flag-for-YAC writes a FLAG_RECORD in the corpus namespace + a FLAGGED_FROM
  // edge to this doc. Cross-namespace relationships are unsupported (CASE-538),
  // so the flag affordance is corpus-only — Library docs (generated, read-only
  // output in their own namespace) don't show it.
  const canFlag = doc.namespace === CORPUS_NS

  // Surface metadata.custom alongside template-defined data fields. Render
  // every key (no hide list) in insertion order from the API response —
  // Peter explicitly wants the full audit trail visible (CASE-322, closed).
  // The loader (FRanC's `tools/kb-bulk-mirror.py` + `tools/add-to-kb.py`)
  // owns field order; current order is provenance → workflow → origin.
  const metaCustom = (doc.metadata as { custom?: Record<string, unknown> } | undefined)?.custom ?? {}
  const metaEntries = Object.entries(metaCustom).filter(
    ([, v]) => v !== '' && v !== null && v !== undefined,
  )

  // Responses are excluded from the edge sets — incomingEdges drives the aside
  // list and graph columns; the graph still renders for a responses-only case.
  const hasEdges = incomingEdges.length > 0 || outgoing.length > 0
  const hasGraph = hasEdges || responseEdges.length > 0

  return (
    <>
      {hasGraph && (
        <RelationshipGraph
          selfId={id}
          selfTitle={docLabel(data, id)}
          selfCaseNumber={selfParsed.caseNumber}
          selfTemplate={doc.template_value ?? ''}
          incoming={incomingEdges}
          outgoing={outgoing}
          enrichment={peerEnrichment ?? {}}
          responseCount={responseEdges.length}
          onResponsesClick={() =>
            document
              .getElementById('case-thread')
              ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }
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
        {supersededBy.length > 0 && (
          <div className="mb-4 rounded-md border border-primary/30 bg-primary/5 px-4 py-2.5 text-sm text-primary">
            <span className="font-medium">
              {supersededBy.length === 1 ? 'Superseded by' : 'Superseded by:'}
            </span>{' '}
            {supersededBy.map((r, i) => {
              const peerId = r.data.source_ref as string | undefined
              if (!peerId) return null
              const parsed = parseCaseTitle(r.peer?.data?.title, r.peer?.data?.case_number)
              const labelChip =
                parsed.caseNumber !== null ? `CASE-${parsed.caseNumber}` : null
              const slug = parsed.slug || r.peer?.data?.title || peerId
              return (
                <Fragment key={r.document_id}>
                  {i > 0 && <span className="text-text-muted">, </span>}
                  <Link
                    to={`/doc/${peerId}`}
                    className="underline-offset-2 hover:underline"
                    title={r.peer?.data?.title || peerId}
                  >
                    {labelChip ? (
                      <>
                        <span className="font-mono">{labelChip}</span>
                        {parsed.slug && <span className="text-text-muted"> · {parsed.slug}</span>}
                      </>
                    ) : (
                      <span>{slug}</span>
                    )}
                  </Link>
                </Fragment>
              )
            })}
            <span className="ml-1 text-text-muted">→</span>
          </div>
        )}
        {data.doc_status === 'deprecated' && (
          <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
            <span className="font-medium">This document is deprecated.</span>{' '}
            <span className="text-amber-800/80">
              No longer authoritative; reader discretion advised.
            </span>
          </div>
        )}
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
          <h1 className="flex items-baseline gap-2 text-2xl font-semibold tracking-tight text-text">
            {selfParsed.caseNumber !== null && (
              <span className="shrink-0 rounded bg-primary/10 px-2 py-0.5 font-mono text-lg font-semibold text-primary">
                CASE-{selfParsed.caseNumber}
              </span>
            )}
            <span>
              {(selfParsed.caseNumber !== null ? selfParsed.slug : docLabel(data, '')) ||
                '(untitled)'}
            </span>
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
          {canFlag && (
            <button
              type="button"
              onClick={() => setFlagOpen(true)}
              className="rounded-md border border-accent/20 bg-accent/5 px-3 py-1 text-xs font-medium text-accent hover:bg-accent/10 focus:outline-none focus:ring-2 focus:ring-accent/40"
            >
              Flag for YAC
            </button>
          )}
          <PrepareButtons docId={id} docTitle={docLabel(data, id)} />
        </div>

        {(structured.length > 0 || metaEntries.length > 0) && (
          <dl className="mb-8 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
            {structured.map((f) => (
              <Fragment key={f.name}>
                <dt className="text-text-muted">{f.label || f.name}</dt>
                <dd className="text-text">
                  {isReferenceField(f) ? (
                    <RefValue value={data[f.name]} refDocs={refDocs ?? {}} />
                  ) : (
                    <FieldValue value={data[f.name]} />
                  )}
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

        {/* CASE-506: inline collapsible response thread */}
        {responseDocs && responseDocs.length > 0 && <CaseThread responses={responseDocs} />}
      </article>

      {hasEdges && (
        <aside>
          <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
            Relationships
          </h2>
          <RelationshipList label="Incoming" items={incomingEdges} selfId={id} />
          <RelationshipList label="Outgoing" items={outgoing} selfId={id} />
        </aside>
      )}

      {flagOpen && (
        <FlagModal
          sourceDocId={id}
          sourceDocTitle={docLabel(data, id)}
          onClose={() => setFlagOpen(false)}
        />
      )}
    </div>
    </>
  )
}

// Renders document-reference values (a single id or an array) as links to the
// referenced docs, each labelled by title + a template chip. Reads resolve by
// global UUID, so a cross-namespace ref (Library → KB) links the same way.
function RefValue({
  value,
  refDocs,
}: {
  value: unknown
  refDocs: Record<string, RefDocMeta>
}) {
  const ids = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : typeof value === 'string'
      ? [value]
      : []
  if (ids.length === 0) return <span className="text-text-muted">—</span>
  return (
    <ul className="space-y-1">
      {ids.map((rid) => {
        const meta = refDocs[rid]
        return (
          <li key={rid} className="flex flex-wrap items-baseline gap-1.5">
            <Link to={`/doc/${rid}`} className="underline-offset-2 hover:underline">
              {meta?.title || <span className="font-mono text-xs">{rid}</span>}
            </Link>
            {meta?.template_value && (
              <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                {meta.template_value}
              </span>
            )}
          </li>
        )
      })}
    </ul>
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
          const fullTitle = docLabel(peer?.data, peerId)
          const parsed = parseCaseTitle(fullTitle, peer?.data?.case_number)
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
