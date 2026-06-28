import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Search as SearchIcon, X } from 'lucide-react'
import { wipFetchJson } from '../lib/wipBulk'
import { sanitiseFtsSnippet } from '../lib/sanitiseSnippet'
import { docLabel } from '../lib/casePrefix'
import { CaseLabel } from '../components/CaseLabel'
import { CORPUS_NS, NAMESPACES } from '../lib/namespaces'

interface DocItem {
  document_id: string
  namespace: string
  template_value: string
  data: {
    title?: string
    session_id?: string
    path?: string
    authored_by?: string
    doc_status?: string
    case_number?: number
    kind?: string
    severity?: string
    app?: string
    status?: string
    release?: string
    [k: string]: unknown
  }
  metadata?: {
    custom?: {
      case_status?: string
      filed_at?: string
      responded_at?: string
      implemented_at?: string
      closed_at?: string
      [k: string]: unknown
    }
  }
  // Resolved term references (CASE-422): term fields (e.g. app → KB_APP) carry
  // the canonical term_id here, resolved at write — data.app keeps the raw input.
  term_references?: Array<{ field_path: string; term_id: string }>
  created_at: string
  updated_at: string
}

// `data.app` canonicalization is now PLATFORM-owned (CASE-422): app is a
// term-ref field → KB_APP terminology, whose terms carry the operator spellings
// as synonyms. The gateway resolves the synonym at write into the doc's
// term_references[app].term_id; data.app keeps the raw input (Preserve-Original).
// So the facet reads the canonical value FROM the resolved term — no client-side
// alias table. A new app self-registers its term + synonyms in KB_APP (CASE-420)
// and surfaces here with zero code change. Falls back to raw data.app on docs
// that have no term_ref (pre-(A) data / unset app).
const EMPTY_APP_TERMS = new Map<string, string>()
// Stable empty edge-key set so the filterableDocs memo dep doesn't churn before
// the edge-type query resolves.
const EMPTY_EDGE_KEYS = new Set<string>()

async function fetchAppTerms(namespace: string): Promise<Map<string, string>> {
  try {
    const t = await wipFetchJson<{ terminology_id?: string; id?: string }>(
      `/api/def-store/terminologies/by-value/KB_APP?namespace=${namespace}`,
    )
    const tid = t.terminology_id ?? t.id
    if (!tid) return EMPTY_APP_TERMS
    const terms = await wipFetchJson<{ items: Array<{ term_id: string; value: string }> }>(
      `/api/def-store/terminologies/${tid}/terms?namespace=${namespace}&page_size=100`,
    )
    return new Map((terms.items ?? []).map((x) => [x.term_id, x.value]))
  } catch {
    return EMPTY_APP_TERMS // no KB_APP yet (pre-(A)) → callers fall back to raw
  }
}

// "Filed" sort uses metadata.custom.filed_at — the case-frontmatter timestamp
// the operator wrote when filing. Durable, never updated by re-mirror.
// Gateway-filed cases (CASE-464) carry no filed_at; for those the doc was CREATED
// in kb at file time, so created_at IS the filing moment — fall back to it. Scoped
// to cases (case_number present) so non-case docs stay null and sort to the end.
function filedAt(doc: DocItem): Date | null {
  const s = doc.metadata?.custom?.filed_at
  if (typeof s === 'string' && s) {
    const d = new Date(s)
    if (!isNaN(d.getTime())) return d
  }
  if (typeof doc.data.case_number === 'number') {
    const d = new Date(doc.created_at)
    if (!isNaN(d.getTime())) return d
  }
  return null
}

// "Modified" sort uses the latest status-transition timestamp: max of
// filed_at, responded_at, implemented_at, closed_at. Reflects when the
// case actually moved, not when add-to-kb.py re-mirrored it (which is
// what `updated_at` records). Cases without any transitions return null
// and sort to the end (compareDate handles the null pushdown).
function statusModifiedAt(doc: DocItem): Date | null {
  const c = doc.metadata?.custom ?? {}
  const stamps: number[] = []
  for (const s of [c.filed_at, c.responded_at, c.implemented_at, c.closed_at]) {
    if (typeof s !== 'string' || !s) continue
    const d = new Date(s)
    if (!isNaN(d.getTime())) stamps.push(d.getTime())
  }
  return stamps.length > 0 ? new Date(Math.max(...stamps)) : null
}

// Sort docs without a timestamp to the end regardless of direction.
function compareDate(a: Date | null, b: Date | null, dir: 'asc' | 'desc'): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return dir === 'asc' ? a.getTime() - b.getTime() : b.getTime() - a.getTime()
}

// Workflow status (open, responded, implemented, closed, ...) is the structured
// data.status field (CASE-404), populated by the loaders + reporting `data_status`
// column. (Was metadata.custom.case_status, which the add-to-kb.py loader no longer
// writes — see CASE-437.) data.doc_status is the WIP lifecycle (always "published"
// for cases) — not what the user means by "status".
function workflowStatus(doc: DocItem): string | undefined {
  return doc.data?.status
}

interface ListResponse {
  items: DocItem[]
  total: number
  page: number
  page_size: number
  pages: number
}

interface TemplateInfo {
  value: string
  usage?: string
}
interface TemplateListResponse {
  items: TemplateInfo[]
}

interface FtsHit {
  type: string
  id: string
  value: string
  score: number | null
  snippet: string | null
  description?: string
  updated_at?: string
}

interface FtsTypeBucket {
  items: FtsHit[]
  total: number
  page: number
  page_size: number
  pages: number
}
interface FtsResponse {
  query: string
  mode: string
  results: Record<string, FtsTypeBucket>
}

const SORT_OPTIONS = [
  { key: 'relevance', label: 'Relevance' },
  { key: 'case_asc', label: 'Case # · ascending' },
  { key: 'case_desc', label: 'Case # · descending' },
  { key: 'filed_desc', label: 'Filed · newest' },
  { key: 'filed_asc', label: 'Filed · oldest' },
  { key: 'modified_desc', label: 'Modified · newest' },
  { key: 'modified_asc', label: 'Modified · oldest' },
  { key: 'updated_desc', label: 'Last KB mirror · newest' },
  { key: 'updated_asc', label: 'Last KB mirror · oldest' },
  { key: 'title_asc', label: 'Title · A→Z' },
  { key: 'title_desc', label: 'Title · Z→A' },
] as const
type SortKey = (typeof SORT_OPTIONS)[number]['key']

// Sort docs without a case_number to the end regardless of direction,
// so the option is meaningful on mixed-template result sets.
function compareCaseNumber(a: DocItem, b: DocItem, dir: 'asc' | 'desc'): number {
  const aN = typeof a.data.case_number === 'number' ? a.data.case_number : null
  const bN = typeof b.data.case_number === 'number' ? b.data.case_number : null
  if (aN === null && bN === null) return 0
  if (aN === null) return 1
  if (bN === null) return -1
  return dir === 'asc' ? aN - bN : bN - aN
}

const PAGE_SIZE = 25

async function fetchNamespaceDocs(namespace: string): Promise<DocItem[]> {
  // Fetch page 1 to learn the page count, then fetch the rest CONCURRENTLY
  // (CASE-501): the old serial loop paid per-request RTT N times — the dominant
  // cost on kb.internal (Pi). Wall-clock is now ~2×RTT instead of N×RTT.
  // NB: this list also hydrates FTS hits (docsById) + the facet rails, so it is
  // still fetched when a query is present — skipping it would empty both. The
  // durable fix (a server-side summary endpoint) is CASE-501 tier 2.
  const pageSize = 100
  const url = (page: number) =>
    `/api/document-store/documents?namespace=${namespace}&page_size=${pageSize}&latest_only=true&page=${page}`
  const first = await wipFetchJson<ListResponse>(url(1))
  const pages = first.pages || 1
  const items =
    pages <= 1
      ? first.items
      : [
          ...first.items,
          ...(
            await Promise.all(
              Array.from({ length: pages - 1 }, (_, i) =>
                wipFetchJson<ListResponse>(url(i + 2)),
              ),
            )
          ).flatMap((r) => r.items),
        ]
  return items.map((d) => ({ ...d, namespace }))
}

// Unified browse set across all configured namespaces (corpus + library).
async function fetchAllDocs(namespaces: string[]): Promise<DocItem[]> {
  const perNs = await Promise.all(namespaces.map(fetchNamespaceDocs))
  return perNs.flat()
}

// Edge-type templates keyed `${namespace}:${value}` — edge-type sets differ per
// namespace, and a relationship doc is filtered out of the candidate set by this key.
async function fetchEdgeTypeKeys(namespaces: string[]): Promise<Set<string>> {
  const perNs = await Promise.all(
    namespaces.map(async (ns) => {
      const r = await wipFetchJson<TemplateListResponse>(
        `/api/template-store/templates?namespace=${ns}&latest_only=true&page_size=100`,
      )
      return r.items.filter((t) => t.usage === 'relationship').map((t) => `${ns}:${t.value}`)
    }),
  )
  return new Set(perNs.flat())
}

// Unified FTS: fan out to each namespace's reporting-sync search and merge the
// per-type buckets. Hits carry global-UUID ids, so they join docsById (which
// spans both namespaces) regardless of source. One namespace erroring (e.g. no
// FTS data yet) must not sink the whole search, so each fetch is caught.
//
// `?namespace=` scopes the search to that namespace (filters `d.namespace = $N`),
// so each fan-out call is genuinely scoped — without it the search runs global
// across every namespace's reporting rows (CASE-541).
async function fetchSearch(
  namespaces: string[],
  query: string,
  mode: string,
): Promise<FtsResponse> {
  const perNs = await Promise.all(
    namespaces.map((ns) =>
      wipFetchJson<FtsResponse>(`/api/reporting-sync/search?namespace=${ns}`, {
        method: 'POST',
        body: JSON.stringify({ query, mode, types: ['document'], page_size: 100 }),
      }).catch(() => null),
    ),
  )
  const results: Record<string, FtsTypeBucket> = {}
  for (const r of perNs) {
    if (!r) continue
    for (const [type, bucket] of Object.entries(r.results ?? {})) {
      const existing = results[type]
      if (existing) {
        existing.items.push(...bucket.items)
        existing.total += bucket.total
      } else {
        results[type] = { ...bucket, items: [...bucket.items] }
      }
    }
  }
  return { query, mode, results }
}

function csvSet(s: string | null): Set<string> {
  return new Set((s ?? '').split(',').filter(Boolean))
}

// Author IDs carry a session suffix: "-YYYYMMDD-HHMM" (most YACs) or just
// "-YYYYMMDD" (FRanC); some entries are bare ("FRanC"). Strip whichever form
// is present so all sessions land in one facet bucket per YAC root.
function rootAuthor(s: string | undefined | null): string {
  if (!s) return ''
  return s.replace(/-\d{8}(?:-\d{2,4})?$/, '')
}

/**
 * `/search` route — faceted search over the corpus. Posts the query to
 * reporting-sync (`mode: auto|fts|substring`) and filters/ranks client-side with
 * URL-param facets (type/status/author/kind/severity/app). CASE_RESPONSE is
 * default-off but selectable.
 */
export default function SearchPage() {
  const [params, setParams] = useSearchParams()
  const query = params.get('q') ?? ''
  const mode = (params.get('mode') ?? 'auto') as 'auto' | 'fts' | 'substring'
  const sort = ((params.get('sort') ?? (query ? 'relevance' : 'filed_desc')) as SortKey)
  const tFilter = useMemo(() => csvSet(params.get('t')), [params])
  const sFilter = useMemo(() => csvSet(params.get('s')), [params])
  const aFilter = useMemo(() => csvSet(params.get('a')), [params])
  const kFilter = useMemo(() => csvSet(params.get('k')), [params])
  const vFilter = useMemo(() => csvSet(params.get('v')), [params])
  const pFilter = useMemo(() => csvSet(params.get('p')), [params])
  const rFilter = useMemo(() => csvSet(params.get('r')), [params])
  const [page, setPage] = useState(1)

  const [draft, setDraft] = useState(query)
  useEffect(() => setDraft(query), [query])

  const nsKey = NAMESPACES.join(',')
  const allDocsQ = useQuery<DocItem[]>({
    queryKey: ['kb-docs-all', nsKey],
    queryFn: () => fetchAllDocs(NAMESPACES),
    staleTime: 30_000,
  })

  const edgeKeysQ = useQuery<Set<string>>({
    queryKey: ['edge-type-keys', nsKey],
    queryFn: () => fetchEdgeTypeKeys(NAMESPACES),
    staleTime: 5 * 60_000,
  })

  const searchQ = useQuery<FtsResponse>({
    queryKey: ['fts-search', nsKey, query, mode],
    queryFn: () => fetchSearch(NAMESPACES, query, mode),
    enabled: query.trim().length > 0,
    staleTime: 30_000,
  })

  // CASE-422: resolve a doc's canonical app from its term_reference (term_id →
  // KB_APP value), falling back to the raw data.app when there is no term_ref.
  // KB_APP lives in the corpus namespace only, so this stays corpus-scoped.
  const appTermsQ = useQuery<Map<string, string>>({
    queryKey: ['kb-app-terms', CORPUS_NS],
    queryFn: () => fetchAppTerms(CORPUS_NS),
    staleTime: 5 * 60_000,
  })
  const appTermMap = appTermsQ.data ?? EMPTY_APP_TERMS
  const appOf = useCallback(
    (doc: DocItem): string | undefined => {
      const ref = doc.term_references?.find((r) => r.field_path === 'app')
      const canon = ref ? appTermMap.get(ref.term_id) : undefined
      return canon ?? doc.data.app
    },
    [appTermMap],
  )

  const edgeKeys = edgeKeysQ.data ?? EMPTY_EDGE_KEYS

  const docsById = useMemo(() => {
    const m = new Map<string, DocItem>()
    for (const d of allDocsQ.data ?? []) m.set(d.document_id, d)
    return m
  }, [allDocsQ.data])

  const filterableDocs = useMemo(
    () =>
      (allDocsQ.data ?? []).filter(
        (d) =>
          !edgeKeys.has(`${d.namespace}:${d.template_value}`) &&
          d.template_value !== 'BOOTSTRAP_RECORD',
      ),
    [allDocsQ.data, edgeKeys],
  )

  const allTemplates = useMemo(
    () => Array.from(new Set(filterableDocs.map((d) => d.template_value))).sort(),
    [filterableDocs],
  )
  // Status scope respects the current type filter: when the user filters to
  // types that have no workflow status (journeys, firesides), the rail's
  // Status section's option list is empty and FacetSection hides itself.
  const docsInTypeScope = useMemo(
    () =>
      tFilter.size === 0
        ? filterableDocs
        : filterableDocs.filter((d) => tFilter.has(d.template_value)),
    [filterableDocs, tFilter],
  )
  const allStatuses = useMemo(
    () =>
      Array.from(
        new Set(docsInTypeScope.map(workflowStatus).filter((s): s is string => Boolean(s))),
      ).sort(),
    [docsInTypeScope],
  )
  // Kind scope respects the type filter — same pattern as Status. Only DOCUMENT
  // instances carry `data.kind`, so the section auto-hides when the type filter
  // excludes DOCUMENT (FacetSection returns null on empty option list).
  const allKinds = useMemo(
    () =>
      Array.from(
        new Set(
          docsInTypeScope
            .map((d) => d.data.kind)
            .filter((k): k is string => typeof k === 'string' && k.length > 0),
        ),
      ).sort(),
    [docsInTypeScope],
  )
  // Severity lives on CASE_RECORD.data.severity (CASE-404 schema extension).
  // Scope respects the type filter, same pattern as Status/Kind — auto-hides
  // when the type filter excludes CASE_RECORD.
  const allSeverities = useMemo(
    () =>
      Array.from(
        new Set(
          docsInTypeScope
            .map((d) => d.data.severity)
            .filter((s): s is string => typeof s === 'string' && s.length > 0),
        ),
      ).sort(),
    [docsInTypeScope],
  )
  // App = the canonical KB_APP term resolved from each doc's term_reference
  // (CASE-422); the spelling variants live as KB_APP synonyms, so the facet
  // shows one bucket per app with no client-side alias map.
  const allApps = useMemo(
    () =>
      Array.from(
        new Set(
          docsInTypeScope
            .map((d) => appOf(d))
            .filter((s): s is string => typeof s === 'string' && s.length > 0),
        ),
      ).sort(),
    [docsInTypeScope, appOf],
  )
  const allAuthors = useMemo(
    () =>
      Array.from(
        new Set(
          filterableDocs
            .map((d) => rootAuthor(d.data.authored_by))
            .filter((s) => s.length > 0),
        ),
      ).sort(),
    [filterableDocs],
  )
  // Release = LIBRARY_DOC.data.release (wip-v1, wip-v2, …) — the product release
  // line. The whole point of parallel libraries (CASE-518): filter to one line.
  // Only LIBRARY_DOC carries it, so the section auto-hides when none is in scope.
  const allReleases = useMemo(
    () =>
      Array.from(
        new Set(
          docsInTypeScope
            .map((d) => d.data.release)
            .filter((s): s is string => typeof s === 'string' && s.length > 0),
        ),
      ).sort(),
    [docsInTypeScope],
  )

  type Hit = { doc: DocItem; score: number | null; snippet: string | null }
  const hits: Hit[] = useMemo(() => {
    if (query.trim()) {
      // Case-number jump: "457" / "CASE-457" / "#457" → the case with that number.
      // case_number is an integer (not an FTS-indexed string field), so a bare
      // number never matches FTS — resolve it directly against the loaded docs.
      const m = query.trim().match(/^(?:case-?|#)?(\d+)$/i)
      if (m) {
        const n = Number(m[1])
        const doc = filterableDocs.find(
          (d) => d.template_value === 'CASE_RECORD' && d.data.case_number === n,
        )
        if (doc) return [{ doc, score: null, snippet: null }]
      }
      const ftsHits = Object.values(searchQ.data?.results ?? {}).flatMap((b) => b.items)
      const seen = new Set<string>()
      const result: Hit[] = []
      for (const h of ftsHits) {
        if (h.type !== 'document') continue
        if (seen.has(h.id)) continue
        seen.add(h.id)
        const doc = docsById.get(h.id)
        if (!doc) continue
        if (edgeKeys.has(`${doc.namespace}:${doc.template_value}`) || doc.template_value === 'BOOTSTRAP_RECORD') continue
        result.push({ doc, score: h.score, snippet: h.snippet })
      }
      return result
    }
    return filterableDocs.map((d) => ({ doc: d, score: null, snippet: null }))
  }, [query, searchQ.data, docsById, edgeKeys, filterableDocs])

  const filtered = useMemo(
    () =>
      hits.filter(({ doc }) => {
        // CASE_RESPONSE is default-hidden noise (viewable inline under its parent
        // case); surface it only when explicitly selected in the type facet (CASE-533).
        if (doc.template_value === 'CASE_RESPONSE' && !tFilter.has('CASE_RESPONSE')) return false
        if (tFilter.size > 0 && !tFilter.has(doc.template_value)) return false
        if (sFilter.size > 0 && !sFilter.has(workflowStatus(doc) ?? '')) return false
        if (aFilter.size > 0 && !aFilter.has(rootAuthor(doc.data.authored_by))) return false
        if (kFilter.size > 0 && !kFilter.has(doc.data.kind ?? '')) return false
        if (vFilter.size > 0 && !vFilter.has(doc.data.severity ?? '')) return false
        if (pFilter.size > 0 && !pFilter.has(appOf(doc) ?? '')) return false
        if (rFilter.size > 0 && !rFilter.has(doc.data.release ?? '')) return false
        return true
      }),
    [hits, tFilter, sFilter, aFilter, kFilter, vFilter, pFilter, rFilter, appOf],
  )

  // Per-option counts for each facet. "What would the result count be if I
  // added THIS value to the filter set, given all OTHER active filters?" —
  // standard faceted-search semantics. Zero-counts stay visible (rendered
  // muted by FacetCheckbox) so the operator sees the "no current match"
  // signal without having to click.
  type FacetKey = 't' | 's' | 'a' | 'k' | 'v' | 'p' | 'r'
  const facetCounts = useMemo(() => {
    function passes(doc: DocItem, skip: FacetKey): boolean {
      // Default-hidden CASE_RESPONSE shouldn't inflate other facets' counts, but
      // stays counted in the type facet itself (skip==='t') so it's selectable (CASE-533).
      if (skip !== 't' && doc.template_value === 'CASE_RESPONSE' && !tFilter.has('CASE_RESPONSE'))
        return false
      if (skip !== 't' && tFilter.size > 0 && !tFilter.has(doc.template_value)) return false
      if (skip !== 's' && sFilter.size > 0 && !sFilter.has(workflowStatus(doc) ?? '')) return false
      if (skip !== 'a' && aFilter.size > 0 && !aFilter.has(rootAuthor(doc.data.authored_by))) return false
      if (skip !== 'k' && kFilter.size > 0 && !kFilter.has(doc.data.kind ?? '')) return false
      if (skip !== 'v' && vFilter.size > 0 && !vFilter.has(doc.data.severity ?? '')) return false
      if (skip !== 'p' && pFilter.size > 0 && !pFilter.has(appOf(doc) ?? '')) return false
      if (skip !== 'r' && rFilter.size > 0 && !rFilter.has(doc.data.release ?? '')) return false
      return true
    }
    function bucket(skip: FacetKey, get: (d: DocItem) => string | undefined): Map<string, number> {
      const m = new Map<string, number>()
      for (const h of hits) {
        if (!passes(h.doc, skip)) continue
        const v = get(h.doc)
        if (typeof v === 'string' && v.length > 0) m.set(v, (m.get(v) ?? 0) + 1)
      }
      return m
    }
    return {
      t: bucket('t', (d) => d.template_value),
      s: bucket('s', (d) => workflowStatus(d)),
      a: bucket('a', (d) => rootAuthor(d.data.authored_by) || undefined),
      k: bucket('k', (d) => d.data.kind),
      v: bucket('v', (d) => d.data.severity),
      p: bucket('p', (d) => appOf(d)),
      r: bucket('r', (d) => d.data.release),
    }
  }, [hits, tFilter, sFilter, aFilter, kFilter, vFilter, pFilter, rFilter, appOf])

  const hasCaseInScope = useMemo(
    () => filtered.some((h) => typeof h.doc.data.case_number === 'number'),
    [filtered],
  )

  const sorted = useMemo(() => {
    const arr = [...filtered]
    arr.sort((a, b) => {
      switch (sort) {
        case 'relevance':
          return (b.score ?? 0) - (a.score ?? 0)
        case 'case_asc':
          return compareCaseNumber(a.doc, b.doc, 'asc')
        case 'case_desc':
          return compareCaseNumber(a.doc, b.doc, 'desc')
        case 'filed_desc':
          return compareDate(filedAt(a.doc), filedAt(b.doc), 'desc')
        case 'filed_asc':
          return compareDate(filedAt(a.doc), filedAt(b.doc), 'asc')
        case 'modified_desc':
          return compareDate(statusModifiedAt(a.doc), statusModifiedAt(b.doc), 'desc')
        case 'modified_asc':
          return compareDate(statusModifiedAt(a.doc), statusModifiedAt(b.doc), 'asc')
        case 'updated_desc':
          return b.doc.updated_at.localeCompare(a.doc.updated_at)
        case 'updated_asc':
          return a.doc.updated_at.localeCompare(b.doc.updated_at)
        case 'title_asc':
          return docLabel(a.doc.data, '').localeCompare(docLabel(b.doc.data, ''))
        case 'title_desc':
          return docLabel(b.doc.data, '').localeCompare(docLabel(a.doc.data, ''))
      }
    })
    return arr
  }, [filtered, sort])

  useEffect(() => {
    setPage(1)
  }, [query, mode, sort, params])

  const total = sorted.length
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const safePage = Math.min(page, pageCount)
  const visible = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(params)
    if (value === null || value === '') next.delete(key)
    else next.set(key, value)
    setParams(next, { replace: true })
  }
  function toggleSet(key: string, current: Set<string>, value: string) {
    const next = new Set(current)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    setParam(key, Array.from(next).join(','))
  }
  function clearAll() {
    setParams(new URLSearchParams(), { replace: true })
    setDraft('')
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setParam('q', draft.trim() || null)
  }

  const activeFilterCount =
    tFilter.size + sFilter.size + aFilter.size + kFilter.size + vFilter.size + pFilter.size + rFilter.size
  const isLoading =
    allDocsQ.isLoading || edgeKeysQ.isLoading || (query.trim() && searchQ.isLoading)
  const error = allDocsQ.error ?? edgeKeysQ.error ?? searchQ.error

  return (
    <div className="flex gap-6">
      {/* Facet rail */}
      <aside className="hidden w-60 shrink-0 lg:block">
        <div className="sticky top-4 space-y-5">
          <FacetSection title="Type" allOptions={allTemplates} defaultOpen>
            {allTemplates.map((t) => (
              <FacetCheckbox
                key={t}
                label={t}
                count={facetCounts.t.get(t) ?? 0}
                checked={tFilter.has(t)}
                onChange={() => toggleSet('t', tFilter, t)}
              />
            ))}
          </FacetSection>
          <FacetSection title="Release" allOptions={allReleases} defaultOpen>
            {allReleases.map((r) => (
              <FacetCheckbox
                key={r}
                label={r}
                count={facetCounts.r.get(r) ?? 0}
                checked={rFilter.has(r)}
                onChange={() => toggleSet('r', rFilter, r)}
              />
            ))}
          </FacetSection>
          <FacetSection title="Status" allOptions={allStatuses} defaultOpen>
            {allStatuses.map((s) => (
              <FacetCheckbox
                key={s}
                label={s}
                count={facetCounts.s.get(s) ?? 0}
                checked={sFilter.has(s)}
                onChange={() => toggleSet('s', sFilter, s)}
              />
            ))}
          </FacetSection>
          <FacetSection title="Severity" allOptions={allSeverities}>
            {allSeverities.map((v) => (
              <FacetCheckbox
                key={v}
                label={v}
                count={facetCounts.v.get(v) ?? 0}
                checked={vFilter.has(v)}
                onChange={() => toggleSet('v', vFilter, v)}
              />
            ))}
          </FacetSection>
          <FacetSection title="App" allOptions={allApps}>
            {allApps.map((p) => (
              <FacetCheckbox
                key={p}
                label={p}
                count={facetCounts.p.get(p) ?? 0}
                checked={pFilter.has(p)}
                onChange={() => toggleSet('p', pFilter, p)}
              />
            ))}
          </FacetSection>
          <FacetSection title="Kind" allOptions={allKinds}>
            {allKinds.map((k) => (
              <FacetCheckbox
                key={k}
                label={k}
                count={facetCounts.k.get(k) ?? 0}
                checked={kFilter.has(k)}
                onChange={() => toggleSet('k', kFilter, k)}
              />
            ))}
          </FacetSection>
          <FacetSection title="Author" allOptions={allAuthors}>
            {allAuthors.map((a) => (
              <FacetCheckbox
                key={a}
                label={a}
                count={facetCounts.a.get(a) ?? 0}
                checked={aFilter.has(a)}
                onChange={() => toggleSet('a', aFilter, a)}
              />
            ))}
          </FacetSection>
          {activeFilterCount > 0 && (
            <button
              type="button"
              onClick={clearAll}
              className="rounded-md border border-primary/30 px-3 py-1 text-xs text-primary hover:bg-primary/5 focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              Clear all filters
            </button>
          )}
        </div>
      </aside>

      {/* Results column */}
      <div className="min-w-0 flex-1">
        <form onSubmit={onSubmit} className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
            <input
              type="search"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Search title, body, snippets…"
              autoFocus
              className="w-full rounded-md border border-gray-200 py-2 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>
          <select
            value={mode}
            onChange={(e) => setParam('mode', e.target.value)}
            aria-label="Search mode"
            className="rounded-md border border-gray-200 px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            <option value="auto">Auto</option>
            <option value="fts">FTS</option>
            <option value="substring">Substring</option>
          </select>
          <select
            value={sort}
            onChange={(e) => setParam('sort', e.target.value)}
            aria-label="Sort"
            className="rounded-md border border-gray-200 px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            {SORT_OPTIONS.map((o) => {
              const isDisabled =
                (o.key === 'relevance' && !query.trim()) ||
                ((o.key === 'case_asc' || o.key === 'case_desc') && !hasCaseInScope)
              return (
                <option key={o.key} value={o.key} disabled={isDisabled}>
                  {o.label}
                </option>
              )
            })}
          </select>
          <button
            type="submit"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            Search
          </button>
        </form>

        {/* Active filter chips */}
        {activeFilterCount > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-text-muted">Filters:</span>
            {[...tFilter].map((v) => (
              <FilterChip key={`t:${v}`} label={v} onRemove={() => toggleSet('t', tFilter, v)} />
            ))}
            {[...sFilter].map((v) => (
              <FilterChip key={`s:${v}`} label={v} onRemove={() => toggleSet('s', sFilter, v)} />
            ))}
            {[...vFilter].map((v) => (
              <FilterChip key={`v:${v}`} label={v} onRemove={() => toggleSet('v', vFilter, v)} />
            ))}
            {[...pFilter].map((v) => (
              <FilterChip key={`p:${v}`} label={v} onRemove={() => toggleSet('p', pFilter, v)} />
            ))}
            {[...kFilter].map((v) => (
              <FilterChip key={`k:${v}`} label={v} onRemove={() => toggleSet('k', kFilter, v)} />
            ))}
            {[...aFilter].map((v) => (
              <FilterChip key={`a:${v}`} label={v} onRemove={() => toggleSet('a', aFilter, v)} />
            ))}
          </div>
        )}

        {/* Results meta */}
        <div className="mb-3 flex items-center justify-between text-xs text-text-muted">
          <span>
            {isLoading
              ? 'Loading…'
              : error
                ? 'Error'
                : `${total} result${total === 1 ? '' : 's'}${query.trim() ? ` for "${query.trim()}"` : ''}`}
          </span>
          {pageCount > 1 && (
            <span>
              Page {safePage} of {pageCount}
            </span>
          )}
        </div>

        {/* Empty / error / list */}
        {error ? (
          <p className="rounded-lg border border-danger/20 bg-danger/5 p-4 text-sm text-danger">
            Failed to load: {(error as Error).message}
          </p>
        ) : !isLoading && total === 0 ? (
          <EmptyState query={query} onBrowse={(t) => toggleSet('t', new Set(), t)} templates={allTemplates} />
        ) : (
          <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-surface">
            {visible.map(({ doc, score, snippet }) => (
              <li key={doc.document_id}>
                <Link
                  to={`/doc/${doc.document_id}`}
                  className="block px-4 py-3 transition hover:bg-background"
                >
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span className="text-sm font-medium text-text">
                          <CaseLabel data={doc.data} />
                        </span>
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                          {doc.template_value}
                        </span>
                        {workflowStatus(doc) && (
                          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-text-muted">
                            {workflowStatus(doc)}
                          </span>
                        )}
                      </div>
                      {snippet && (
                        <p
                          className="fts-snippet mt-1.5 text-sm text-text-muted"
                          dangerouslySetInnerHTML={{ __html: sanitiseFtsSnippet(snippet) }}
                        />
                      )}
                      <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-text-muted">
                        {doc.data.authored_by && <span>{doc.data.authored_by}</span>}
                        <span>{new Date(doc.updated_at).toLocaleString()}</span>
                        {score !== null && score !== undefined && (
                          <span className="ml-auto">score {score.toFixed(2)}</span>
                        )}
                      </div>
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {/* Pager */}
        {pageCount > 1 && (
          <div className="mt-4 flex items-center justify-center gap-1 text-xs">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={safePage === 1}
              className="rounded-md border border-gray-200 px-2 py-1 hover:bg-background disabled:cursor-not-allowed disabled:opacity-40"
            >
              Prev
            </button>
            <span className="px-2 text-text-muted">
              {safePage} / {pageCount}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
              disabled={safePage === pageCount}
              className="rounded-md border border-gray-200 px-2 py-1 hover:bg-background disabled:cursor-not-allowed disabled:opacity-40"
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function FacetSection({
  title,
  allOptions,
  defaultOpen = false,
  children,
}: {
  title: string
  allOptions: string[]
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  if (allOptions.length === 0) return null
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mb-2 flex w-full items-center gap-1 text-xs font-medium uppercase tracking-wide text-text-muted hover:text-text"
      >
        {open ? (
          <ChevronDown className="h-3 w-3" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3 w-3" aria-hidden="true" />
        )}
        <span>{title}</span>
        <span className="ml-1 text-[10px] tabular-nums text-text-muted/70">({allOptions.length})</span>
      </button>
      {open && <div className="max-h-60 space-y-1 overflow-y-auto pr-1">{children}</div>}
    </div>
  )
}

function FacetCheckbox({
  label,
  count,
  checked,
  onChange,
}: {
  label: string
  count?: number
  checked: boolean
  onChange: () => void
}) {
  // count === 0 → muted, so "blocks-me (0)" signals "no current match" at a glance
  const countMuted = count === 0
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-background">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="h-3.5 w-3.5 rounded border-gray-300 text-primary focus:ring-primary/40"
      />
      <span className={`min-w-0 flex-1 truncate ${checked ? 'font-medium text-text' : 'text-text'}`}>
        {label}
      </span>
      {count !== undefined && (
        <span className={`tabular-nums text-[11px] ${countMuted ? 'text-text-muted/50' : 'text-text-muted'}`}>
          {count}
        </span>
      )}
    </label>
  )
}

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-primary">
      <span className="font-medium">{label}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove filter ${label}`}
        className="rounded-full p-0.5 hover:bg-primary/20"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  )
}

function EmptyState({
  query,
  templates,
  onBrowse,
}: {
  query: string
  templates: string[]
  onBrowse: (t: string) => void
}) {
  if (query.trim()) {
    return (
      <div className="rounded-lg border border-gray-200 bg-surface px-6 py-12 text-center">
        <p className="text-sm font-medium text-text">No results for "{query.trim()}"</p>
        <p className="mt-1 text-sm text-text-muted">
          Try a shorter query, or switch the search mode to Substring.
        </p>
      </div>
    )
  }
  return (
    <div className="rounded-lg border border-gray-200 bg-surface px-6 py-10">
      <p className="text-sm text-text-muted">
        Type a query above, or browse by type:
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {templates.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => onBrowse(t)}
            className="rounded-full border border-gray-200 bg-surface px-3 py-1 text-xs text-text hover:border-primary/30 hover:text-primary"
          >
            {t}
          </button>
        ))}
      </div>
    </div>
  )
}
