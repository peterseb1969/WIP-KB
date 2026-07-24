import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Search as SearchIcon, X } from 'lucide-react'
import { wipFetchJson } from '../lib/wipBulk'
import { fetchCorpusHeaders, type HeaderDoc } from '../lib/reporting'
import { fetchTopicTree, type TopicNode, type TopicTree } from '../lib/topics'
import { sanitiseFtsSnippet } from '../lib/sanitiseSnippet'
import { docLabel } from '../lib/casePrefix'
import { CaseLabel } from '../components/CaseLabel'
import { CaseStats } from '../components/CaseStats'
import { CORPUS_NS, NAMESPACES } from '../lib/namespaces'

// Search renders header fields only (title/case/status/facets/snippet), so a doc
// here is the reporting-sourced HeaderDoc — no body is ever fetched (CASE-687).
type DocItem = HeaderDoc

// `data.app` canonicalization is now PLATFORM-owned (CASE-422): app is a
// term-ref field → KB_APP terminology, whose terms carry the operator spellings
// as synonyms. The gateway resolves the synonym at write into the doc's
// term_references[app].term_id; data.app keeps the raw input (Preserve-Original).
// So the facet reads the canonical value FROM the resolved term — no client-side
// alias table. A new app self-registers its term + synonyms in KB_APP (CASE-420)
// and surfaces here with zero code change. Falls back to raw data.app on docs
// that have no term_ref (pre-(A) data / unset app).
const EMPTY_APP_TERMS = new Map<string, string>()

// Structural types kept out of search. CASE_RESPONSE is NOT here — search
// surfaces it on demand via the type facet (CASE-533). The bootstrap record
// appears under both values: namespaces bootstrapped before the
// namespace-prefixing change carry the unprefixed BOOTSTRAP_RECORD, fresh
// bootstraps mint KB_BOOTSTRAP_RECORD.
const SEARCH_HIDDEN = new Set(['BOOTSTRAP_RECORD', 'KB_BOOTSTRAP_RECORD', 'WRITE_POLICY'])

// Mint types: template value → the integer field holding its handle number. Every
// one of these is an integer column with NO full-text index, so a typed number can
// only ever be resolved client-side against the loaded corpus (see the number jump
// below) — the FTS pass can never match it.
const NUMBER_FIELD = {
  CASE_RECORD: 'case_number',
  FIRESIDE: 'fireside_number',
  DOCUMENT: 'paper_number',
  LESSON: 'lesson_number',
  DESIGN_DECISION: 'decision_number',
} as const satisfies Record<string, keyof HeaderDoc['data']>

// The handle prefix a user types → its template value. DOCUMENT's Registry prefix is
// PAPER, which is why "paper 97" must resolve to a DOCUMENT.
const PREFIX_TYPE: Record<string, keyof typeof NUMBER_FIELD> = {
  case: 'CASE_RECORD',
  fireside: 'FIRESIDE',
  paper: 'DOCUMENT',
  lesson: 'LESSON',
  decision: 'DESIGN_DECISION',
}

// The facet lists raw template values, but DOCUMENT's human handle is PAPER-<n> —
// without naming both, a user hunting for "paper" concludes the type is missing.
const TYPE_LABEL: Record<string, string> = { DOCUMENT: 'DOCUMENT (paper)' }
const typeLabel = (t: string): string => TYPE_LABEL[t] ?? t

// Friendly, lowercase plurals for the scope line ("Searching cases, lessons, …").
// Falls back to the lowercased template value for any type not named here.
const SCOPE_LABEL: Record<string, string> = {
  CASE_RECORD: 'cases',
  CASE_RESPONSE: 'responses',
  DESIGN_DECISION: 'decisions',
  LESSON: 'lessons',
  FIRESIDE: 'firesides',
  SESSION: 'sessions',
  DOCUMENT: 'papers',
  JOURNEY_ENTRY: 'journal',
  YAC_MEMORY: 'memories',
  AGENT_IDENTITY: 'agents',
  FLAG_RECORD: 'flags',
  GIT_STATS_SNAPSHOT: 'git-stats',
  LIBRARY_DOC: 'library',
}
const scopeLabel = (t: string): string => SCOPE_LABEL[t] ?? t.toLowerCase()

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

// "Filed" sort: the doc was CREATED in kb when it was filed, so created_at IS the
// filing moment. Scoped to cases (case_number present) so non-case docs stay null
// and sort to the end. (Header docs come from reporting, which does not carry the
// legacy metadata.custom.filed_at; created_at is the filing moment for every
// gateway-filed case anyway — CASE-464/CASE-687.)
function filedAt(doc: DocItem): Date | null {
  if (typeof doc.data.case_number === 'number') {
    const d = new Date(doc.created_at)
    if (!isNaN(d.getTime())) return d
  }
  return null
}

// "Modified" sort: when the case last moved. A gateway status transition PATCHes
// the case doc, so updated_at tracks the last transition. (Reporting does not carry
// the legacy per-transition metadata.custom stamps, which are empty on gateway-era
// cases regardless — CASE-687.)
function statusModifiedAt(doc: DocItem): Date | null {
  if (typeof doc.data.case_number === 'number') {
    const d = new Date(doc.updated_at)
    if (!isNaN(d.getTime())) return d
  }
  return null
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

// Author attribution is free-form: clean session IDs ("APP-KB-20260628-014726"),
// composites ("BE-YAC-… / Peter", "Peter, APP-KB-…"), quoted, mixed-case ("FRANC"),
// or noise ("Day 30", a "CASE-36" ref). Explode each value into its constituent
// YAC roles so a doc lands in a facet bucket for EACH of its authors (CASE-518
// follow-up — Peter's call): split on / and ,, then per token strip surrounding
// quotes, a trailing parenthetical, the -YYYYMMDD[-HHMM(SS)] session suffix (4- OR
// 6-digit time — the 6-digit HHMMSS form minted by /wip-setup+/wip-wake was the bug
// that leaked ~79 raw authors), and an "app:" prefix; canonicalise casing; keep only
// tokens that look like a role.
function canonRole(t: string): string {
  const l = t.toLowerCase()
  if (l === 'franc') return 'FRanC'
  if (l === 'peter') return 'Peter'
  if (l === 'unknown') return 'unknown'
  if (/^user\d+$/.test(l)) return l.toUpperCase()
  return t.toUpperCase() // APP-KB, BE-YAC, DOC-YAC, …
}
function isRole(t: string): boolean {
  return (
    t === 'Peter' ||
    t === 'FRanC' ||
    t === 'unknown' ||
    /^USER\d+$/.test(t) ||
    /^[A-Z]{2,}(?:-[A-Z]{2,})*$/.test(t) // APP-KB, BE-YAC, DOC-YAC (all-caps, letters only)
  )
}
function docAuthors(s: string | undefined | null): string[] {
  if (!s) return []
  const roles = s
    .split(/[/,]/)
    .map((t) =>
      t
        .trim()
        .replace(/^["']+|["']+$/g, '')
        .replace(/\s*\(.*\)\s*$/, '')
        .replace(/-\d{8}(?:-\d{2,6})?$/, '')
        .replace(/^app:/i, '')
        .trim(),
    )
    .map(canonRole)
    .filter(isRole)
  return Array.from(new Set(roles))
}
// YAC_MEMORY records carry their author in `owner` (the YAC role that accrued the
// memory — already facet-clean), not `authored_by`. No other template defines an
// `owner` field, so this fallback fires only for memories and never mis-attributes
// another type. Without it, memory docs land in no author bucket (CASE-603).
function authorSource(d: DocItem): string | undefined {
  return d.data.authored_by ?? (typeof d.data.owner === 'string' ? d.data.owner : undefined)
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
  const oFilter = useMemo(() => csvSet(params.get('o')), [params])
  // Response matches FOLD into their parent case by default: a matching
  // CASE_RESPONSE contributes an attributed sub-hit under the case it belongs to
  // rather than a standalone row, and a case whose ONLY match is in a response
  // still appears. This replaces the old silent exclusion (an empty Type facet
  // used to mean "everything EXCEPT responses", so a term living only in a
  // response returned nothing, with no way to see why). Ticking CASE_RESPONSE in
  // the Type facet opts out of folding and lists raw response rows instead.
  const foldResponses = !tFilter.has('CASE_RESPONSE')
  const [page, setPage] = useState(1)

  const [draft, setDraft] = useState(query)
  useEffect(() => setDraft(query), [query])

  const nsKey = NAMESPACES.join(',')
  const allDocsQ = useQuery<DocItem[]>({
    queryKey: ['kb-corpus-headers', nsKey],
    queryFn: () => fetchCorpusHeaders(NAMESPACES, SEARCH_HIDDEN),
    staleTime: 30_000,
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
      // CASE-422 canonical app: resolve the reporting `app_term_id` (the resolved
      // KB_APP term) through the term map; fall back to the raw data.app.
      const canon = doc.data.app_term_id ? appTermMap.get(doc.data.app_term_id) : undefined
      return canon ?? doc.data.app
    },
    [appTermMap],
  )

  const docsById = useMemo(() => {
    const m = new Map<string, DocItem>()
    for (const d of allDocsQ.data ?? []) m.set(d.document_id, d)
    return m
  }, [allDocsQ.data])

  // Edge (relationship) and structural types are already excluded at the reporting
  // source (fetchCorpusHeaders), so the corpus is the browse/facet set as-is.
  const filterableDocs = useMemo(() => allDocsQ.data ?? [], [allDocsQ.data])

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
        new Set(filterableDocs.flatMap((d) => docAuthors(authorSource(d)))),
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

  // Topics = KB_TOPIC term values on the docs that carry them (CASE-760
  // Phase 2). A doc holds an ARRAY of topics. The facet renders the KB_TOPIC
  // ontology as a TREE, and selecting a topic filters by that topic PLUS all
  // its descendants (both relation types) — "backup-restore" matches a doc
  // tagged only "fresh-restore". Without a reachable taxonomy the facet
  // degrades to a flat list of the values present.
  const allTopics = useMemo(
    () =>
      Array.from(
        new Set(docsInTypeScope.flatMap((d) => d.data.topics ?? [])),
      ).sort(),
    [docsInTypeScope],
  )
  const topicTreeQ = useQuery<TopicTree | null>({
    queryKey: ['kb-topic-tree', CORPUS_NS],
    queryFn: () => fetchTopicTree(CORPUS_NS),
    staleTime: 5 * 60_000,
  })
  const topicTree = topicTreeQ.data ?? null
  // Open/closed branches of the Topic tree. Empty set = everything collapsed,
  // which is the default view; "Expand all" fills it with every parent value.
  const [openTopics, setOpenTopics] = useState<Set<string>>(new Set())
  const allTopicParents = useMemo(() => {
    const out = new Set<string>()
    const walk = (nodes: TopicNode[]) => {
      for (const n of nodes) {
        if (n.children.length > 0) {
          out.add(n.value)
          walk(n.children)
        }
      }
    }
    walk(topicTree?.roots ?? [])
    return out
  }, [topicTree])
  // The selected filter, expanded to descendant sets. null = no topic filter.
  const selectedTopics = useMemo(() => {
    if (oFilter.size === 0) return null
    const s = new Set<string>()
    for (const v of oFilter) {
      const exp = topicTree?.expansion.get(v)
      if (exp) exp.forEach((x) => s.add(x))
      else s.add(v)
    }
    return s
  }, [oFilter, topicTree])

  // A matching response, carried on its parent case's hit.
  type ResponseMatch = {
    documentId: string
    seq: number | null
    score: number | null
    snippet: string | null
  }
  type Hit = {
    doc: DocItem
    score: number | null
    snippet: string | null
    // Present on CASE_RECORD hits whose responses matched the query.
    responseMatches?: ResponseMatch[]
  }

  // case_number → the CASE_RECORD doc, so a response hit can find its parent.
  const caseByNumber = useMemo(() => {
    const m = new Map<number, DocItem>()
    for (const d of filterableDocs) {
      if (d.template_value !== 'CASE_RECORD') continue
      if (typeof d.data.case_number === 'number') m.set(d.data.case_number, d)
    }
    return m
  }, [filterableDocs])

  const hits: Hit[] = useMemo(() => {
    if (query.trim()) {
      // Number jump: a minted handle ("CASE-457", "FIRESIDE-21", "PAPER-97", "#457")
      // or a bare number resolves straight to that document. Mint-type numbers are
      // integers with no FTS index, so a typed number never matches FTS — it can only
      // be resolved here, against the loaded docs.
      const m = query.trim().match(/^(?:(case|fireside|paper|lesson|decision)[-\s]?|#)?(\d+)$/i)
      if (m) {
        const n = Number(m[2])
        // An explicit prefix pins the type. Otherwise a single selected type decides,
        // so "21" under the FIRESIDE filter finds fireside 21. With no prefix and no
        // single selection, a bare number still means "case" — unchanged behaviour.
        const pinned = m[1] ? PREFIX_TYPE[m[1].toLowerCase()] : undefined
        const selected = tFilter.size === 1 ? [...tFilter][0] : undefined
        const target: keyof typeof NUMBER_FIELD =
          pinned ??
          (selected && selected in NUMBER_FIELD
            ? (selected as keyof typeof NUMBER_FIELD)
            : 'CASE_RECORD')
        const doc = filterableDocs.find(
          (d) => d.template_value === target && d.data[NUMBER_FIELD[target]] === n,
        )
        if (doc) return [{ doc, score: null, snippet: null }]
      }
      const ftsHits = Object.values(searchQ.data?.results ?? {}).flatMap((b) => b.items)
      const seen = new Set<string>()
      const result: Hit[] = []
      // Response matches, grouped by their parent case's document_id, to be
      // attached after the main pass (the parent may appear before OR after the
      // response in the FTS result order).
      const byParent = new Map<string, ResponseMatch[]>()
      for (const h of ftsHits) {
        if (h.type !== 'document') continue
        if (seen.has(h.id)) continue
        seen.add(h.id)
        const doc = docsById.get(h.id)
        if (!doc) continue // docsById holds only entity docs (edges/structural excluded at source)
        if (doc.template_value === 'CASE_RESPONSE') {
          const parent =
            typeof doc.data.case_number === 'number'
              ? caseByNumber.get(doc.data.case_number)
              : undefined
          if (parent) {
            const arr = byParent.get(parent.document_id) ?? []
            arr.push({
              documentId: doc.document_id,
              seq: typeof doc.data.response_seq === 'number' ? doc.data.response_seq : null,
              score: h.score,
              snippet: h.snippet,
            })
            byParent.set(parent.document_id, arr)
          }
          // The response row itself stays in `hits` regardless: it keeps the Type
          // facet's CASE_RESPONSE count honest (so the count reflects real matches
          // and the type stays selectable) and becomes the visible row when the
          // user opts out of folding. `filtered` drops it while folding is on.
          // An orphan response (parent case not loaded) has no fold target, so
          // this row is also what keeps its match from vanishing entirely.
          result.push({ doc, score: h.score, snippet: h.snippet })
          continue
        }
        result.push({ doc, score: h.score, snippet: h.snippet })
      }
      // Attach response matches to parents already in the result set, and
      // synthesize a hit for any case that matched ONLY through its responses —
      // the case that used to be invisible.
      const inResult = new Set(result.map((r) => r.doc.document_id))
      for (const [parentId, matches] of byParent) {
        matches.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
        const existing = result.find((r) => r.doc.document_id === parentId)
        if (existing) {
          existing.responseMatches = matches
          continue
        }
        if (inResult.has(parentId)) continue
        const parent = docsById.get(parentId)
        if (!parent) continue
        // No body match of its own — rank it by its best-scoring response so it
        // sorts sensibly among body matches instead of falling to the bottom.
        const best = matches.reduce<number | null>(
          (mx, m) => (m.score != null && (mx == null || m.score > mx) ? m.score : mx),
          null,
        )
        result.push({ doc: parent, score: best, snippet: null, responseMatches: matches })
      }
      return result
    }
    return filterableDocs.map((d) => ({ doc: d, score: null, snippet: null }))
  }, [query, searchQ.data, docsById, filterableDocs, caseByNumber])

  const filtered = useMemo(
    () =>
      hits.filter(({ doc }) => {
        // While folding, a response is represented by the sub-hit on its parent
        // case, so its standalone row is dropped (it would double-report the same
        // match). Opting out of folding — ticking CASE_RESPONSE — lists them.
        if (doc.template_value === 'CASE_RESPONSE' && foldResponses) return false
        if (tFilter.size > 0 && !tFilter.has(doc.template_value)) return false
        if (sFilter.size > 0 && !sFilter.has(workflowStatus(doc) ?? '')) return false
        if (aFilter.size > 0 && !docAuthors(authorSource(doc)).some((r) => aFilter.has(r)))
          return false
        if (kFilter.size > 0 && !kFilter.has(doc.data.kind ?? '')) return false
        if (vFilter.size > 0 && !vFilter.has(doc.data.severity ?? '')) return false
        if (pFilter.size > 0 && !pFilter.has(appOf(doc) ?? '')) return false
        if (rFilter.size > 0 && !rFilter.has(doc.data.release ?? '')) return false
        if (selectedTopics && !(doc.data.topics ?? []).some((t) => selectedTopics.has(t)))
          return false
        return true
      }),
    [hits, tFilter, sFilter, aFilter, kFilter, vFilter, pFilter, rFilter, selectedTopics, appOf],
  )

  // Per-option counts for each facet. "What would the result count be if I
  // added THIS value to the filter set, given all OTHER active filters?" —
  // standard faceted-search semantics. Zero-counts stay visible (rendered
  // muted by FacetCheckbox) so the operator sees the "no current match"
  // signal without having to click.
  type FacetKey = 't' | 's' | 'a' | 'k' | 'v' | 'p' | 'r' | 'o'
  const facetCounts = useMemo(() => {
    function passes(doc: DocItem, skip: FacetKey): boolean {
      // Default-hidden CASE_RESPONSE shouldn't inflate other facets' counts, but
      // stays counted in the type facet itself (skip==='t') so it's selectable (CASE-533).
      if (skip !== 't' && doc.template_value === 'CASE_RESPONSE' && foldResponses)
        return false
      if (skip !== 't' && tFilter.size > 0 && !tFilter.has(doc.template_value)) return false
      if (skip !== 's' && sFilter.size > 0 && !sFilter.has(workflowStatus(doc) ?? '')) return false
      if (
        skip !== 'a' &&
        aFilter.size > 0 &&
        !docAuthors(authorSource(doc)).some((r) => aFilter.has(r))
      )
        return false
      if (skip !== 'k' && kFilter.size > 0 && !kFilter.has(doc.data.kind ?? '')) return false
      if (skip !== 'v' && vFilter.size > 0 && !vFilter.has(doc.data.severity ?? '')) return false
      if (skip !== 'p' && pFilter.size > 0 && !pFilter.has(appOf(doc) ?? '')) return false
      if (skip !== 'r' && rFilter.size > 0 && !rFilter.has(doc.data.release ?? '')) return false
      if (
        skip !== 'o' &&
        selectedTopics &&
        !(doc.data.topics ?? []).some((t) => selectedTopics.has(t))
      )
        return false
      return true
    }
    function bucket(
      skip: FacetKey,
      get: (d: DocItem) => string | string[] | undefined,
    ): Map<string, number> {
      const m = new Map<string, number>()
      for (const h of hits) {
        if (!passes(h.doc, skip)) continue
        const v = get(h.doc)
        const vals = Array.isArray(v) ? v : typeof v === 'string' ? [v] : []
        for (const x of vals) if (x.length > 0) m.set(x, (m.get(x) ?? 0) + 1)
      }
      return m
    }
    // Topic counts roll up: a node's count is the number of in-scope docs
    // tagged with the node OR any descendant — the same set selecting it
    // would filter to. Falls back to per-value counts without a tree.
    const oCounts = new Map<string, number>()
    if (topicTree) {
      for (const [val, exp] of topicTree.expansion) {
        let c = 0
        for (const h of hits) {
          if (!passes(h.doc, 'o')) continue
          if ((h.doc.data.topics ?? []).some((t) => exp.has(t))) c++
        }
        oCounts.set(val, c)
      }
    } else {
      for (const [k, v] of bucket('o', (d) => d.data.topics)) oCounts.set(k, v)
    }
    return {
      t: bucket('t', (d) => d.template_value),
      s: bucket('s', (d) => workflowStatus(d)),
      a: bucket('a', (d) => docAuthors(authorSource(d))),
      k: bucket('k', (d) => d.data.kind),
      v: bucket('v', (d) => d.data.severity),
      p: bucket('p', (d) => appOf(d)),
      r: bucket('r', (d) => d.data.release),
      o: oCounts,
    }
  }, [hits, tFilter, sFilter, aFilter, kFilter, vFilter, pFilter, rFilter, selectedTopics, topicTree, appOf])

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

  // Scope line: which types the current result set actually spans. With a type
  // filter active it's the selected types; otherwise every type present except
  // responses (which ride the separate include toggle). This is the disclosure
  // that makes "empty facet ≠ everything" visible instead of silent.
  const scopeTypeValues =
    tFilter.size > 0 ? [...tFilter].sort() : allTemplates.filter((t) => t !== 'CASE_RESPONSE')
  const scopeText = scopeTypeValues.map(scopeLabel).join(', ')

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

  // The Topic facet renders the KB_TOPIC ontology as an indented tree. Counts
  // and selection are subtree roll-ups (see selectedTopics/facetCounts.o), so
  // a parent row is a real filter, not a header. Every branch is collapsible,
  // starts collapsed, and collapse state is independent of selection — a
  // checked topic keeps filtering while its branch is folded away.
  function renderTopicNodes(
    nodes: TopicNode[],
    depth: number,
    // Label of the nearest selected ancestor, when one covers this branch.
    // Covered rows render checked-and-locked: the subtree roll-up already
    // includes them, and the toggleable selection truthfully lives on the
    // ancestor — an independently clickable child checkbox here would either
    // lie about state or need "split the parent" semantics.
    coveredBy: string | null = null,
  ): ReactNode[] {
    return nodes.flatMap((n) => {
      const isOpen = openTopics.has(n.value)
      const explicit = oFilter.has(n.value)
      const implied = coveredBy !== null
      const row = (
        <div key={n.value} className="flex items-center" style={{ paddingLeft: depth * 12 }}>
          {n.children.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                const next = new Set(openTopics)
                if (isOpen) next.delete(n.value)
                else next.add(n.value)
                setOpenTopics(next)
              }}
              aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${n.label}`}
              className="shrink-0 rounded p-0.5 text-text-muted hover:bg-background"
            >
              {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            </button>
          ) : (
            <span className="w-4 shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <FacetCheckbox
              label={n.label}
              count={facetCounts.o.get(n.value) ?? 0}
              checked={explicit || implied}
              disabled={implied}
              hint={implied ? `Included via "${coveredBy}"` : undefined}
              onChange={() => toggleSet('o', oFilter, n.value)}
            />
          </div>
        </div>
      )
      const childCover = coveredBy ?? (explicit ? n.label : null)
      return isOpen ? [row, ...renderTopicNodes(n.children, depth + 1, childCover)] : [row]
    })
  }

  const activeFilterCount =
    tFilter.size + sFilter.size + aFilter.size + kFilter.size + vFilter.size + pFilter.size + rFilter.size + oFilter.size
  const isLoading =
    allDocsQ.isLoading || (query.trim() && searchQ.isLoading)
  const error = allDocsQ.error ?? searchQ.error

  return (
    <div className="flex gap-6">
      {/* Facet rail */}
      <aside className="hidden w-60 shrink-0 lg:block">
        <div className="sticky top-4 space-y-5">
          <FacetSection title="Type" allOptions={allTemplates} defaultOpen>
            {allTemplates.map((t) => (
              <FacetCheckbox
                key={t}
                label={typeLabel(t)}
                count={facetCounts.t.get(t) ?? 0}
                checked={tFilter.has(t)}
                onChange={() => toggleSet('t', tFilter, t)}
              />
            ))}
          </FacetSection>
          <FacetSection title="Topic" allOptions={allTopics} defaultOpen>
            {topicTree && (
              <div className="mb-1 flex gap-2 px-1">
                <button
                  type="button"
                  onClick={() => setOpenTopics(new Set(allTopicParents))}
                  className="text-xs text-primary hover:underline"
                >
                  Expand all
                </button>
                <button
                  type="button"
                  onClick={() => setOpenTopics(new Set())}
                  className="text-xs text-primary hover:underline"
                >
                  Collapse all
                </button>
              </div>
            )}
            {topicTree
              ? renderTopicNodes(topicTree.roots, 0)
              : allTopics.map((o) => (
                  <FacetCheckbox
                    key={o}
                    label={o}
                    count={facetCounts.o.get(o) ?? 0}
                    checked={oFilter.has(o)}
                    onChange={() => toggleSet('o', oFilter, o)}
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

        <CaseStats docs={filterableDocs} className="mb-4" />

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

        {/* Scope line — what the result set actually spans, so "empty facet ≠
            everything" is visible, not silent. Responses ride an explicit toggle. */}
        {!isLoading && !error && allTemplates.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-x-1.5 text-xs text-text-muted">
            <span>
              {query.trim() ? 'Searching' : 'Browsing'} {scopeText || 'the corpus'}
            </span>
            {query.trim() && (
              <>
                <span aria-hidden>·</span>
                <span>
                  {foldResponses
                    ? 'case responses are searched too, shown under their case'
                    : 'responses listed as their own results'}
                </span>
              </>
            )}
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
            {visible.map(({ doc, score, snippet, responseMatches }) => (
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
                {/* Matching responses, attributed to the case they belong to.
                    Outside the row's <Link> — each is its own link, and an
                    anchor cannot nest inside another anchor. */}
                {foldResponses && responseMatches && responseMatches.length > 0 && (
                  <div className="border-t border-gray-100 bg-background/50 px-4 py-2">
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                      {responseMatches.length} matching{' '}
                      {responseMatches.length === 1 ? 'response' : 'responses'}
                    </p>
                    <ul className="space-y-1">
                      {responseMatches.map((rm) => (
                        <li key={rm.documentId}>
                          <Link
                            to={`/doc/${rm.documentId}`}
                            className="flex gap-2 rounded px-1.5 py-1 transition hover:bg-surface"
                          >
                            <span className="shrink-0 font-mono text-xs text-primary">
                              ↳ {rm.seq !== null ? `#${rm.seq}` : 'response'}
                            </span>
                            {rm.snippet && (
                              <span
                                className="fts-snippet min-w-0 flex-1 text-sm text-text-muted"
                                dangerouslySetInnerHTML={{
                                  __html: sanitiseFtsSnippet(rm.snippet),
                                }}
                              />
                            )}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
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
  disabled = false,
  hint,
}: {
  label: string
  count?: number
  checked: boolean
  onChange: () => void
  // A disabled row shows DERIVED state — e.g. a topic checked because a
  // selected ancestor's subtree covers it. The real selection lives elsewhere,
  // so the row is not clickable; `hint` says where.
  disabled?: boolean
  hint?: string
}) {
  // count === 0 → muted, so "blocks-me (0)" signals "no current match" at a glance
  const countMuted = count === 0
  return (
    <label
      title={hint}
      className={`flex items-center gap-2 rounded px-1 py-0.5 text-sm ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-background'}`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="h-3.5 w-3.5 rounded border-gray-300 text-primary focus:ring-primary/40 disabled:cursor-not-allowed"
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
