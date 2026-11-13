import { wipFetchJson } from './wipBulk'
import { wipClient } from './wipClient'
import { applyHistory, summariseThread, type ThreadEntry, type ThreadSummary } from '../../server/lib/case-thread'
export type { ThreadSummary } from '../../server/lib/case-thread'
import { sqlHolds, sqlLapsed } from '../../server/lib/claims'

// Read-only SQL against the reporting-sync PostgreSQL layer. Tables are per
// template — "<namespace>"."doc_<template_value>", one row per latest document
// version. This is the sanctioned summary/aggregation path (the FTS architecture
// paper): it projects only the header columns the list UIs render and NEVER ships
// `data.body`. The whole-document list fetch it replaces pulled every doc, bodies
// and all — ~12 MB over VPN just to render the start page (CASE-687).

export interface ReportResult<T = Record<string, unknown>> {
  columns: string[]
  rows: T[]
  row_count: number
  truncated: boolean
}

// The endpoint caps at 1000 rows unless max_rows is supplied; pass it whenever a
// query's own LIMITs allow more so results are never silently truncated.
export async function reportingQuery<T = Record<string, unknown>>(
  namespace: string,
  sql: string,
  maxRows?: number,
): Promise<ReportResult<T>> {
  const body: Record<string, unknown> = { namespace, sql }
  if (maxRows != null) body.max_rows = maxRows
  return wipFetchJson<ReportResult<T>>('/api/reporting-sync/query', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

// A document reduced to the header fields the list/summary UIs render — no body.
export interface HeaderDoc {
  document_id: string
  namespace: string
  template_value: string
  created_at: string
  updated_at: string
  data: {
    title?: string
    // Every mint type's human handle is <PREFIX>-<n> backed by an integer number
    // field. They are loaded (not just case_number) so the search page can resolve
    // a typed number to any minted doc — integers carry no FTS index, so a bare
    // number can only ever be matched client-side against these.
    case_number?: number
    // CASE_RESPONSE's per-case sequence — the "#3" in the CASE-<n>#<seq> handle.
    // Loaded so a response FTS hit can be labelled when it folds into its case.
    response_seq?: number
    fireside_number?: number
    paper_number?: number
    lesson_number?: number
    decision_number?: number
    authored_by?: string
    session_id?: string
    path?: string
    status?: string // workflow status (data.status) — the reporting `data_status` column
    doc_status?: string
    owner?: string // YAC_MEMORY carries its author here, not in authored_by (CASE-603)
    // Facet fields the search rail reads (present only on the templates that
    // declare them: kind→DOCUMENT, severity/severity_term_id/app/app_term_id/component→CASE_RECORD,
    // release→LIBRARY_DOC). app_term_id resolves the canonical KB_APP term (CASE-422)
    // in place of the document's term_references, which reporting does not carry.
    kind?: string
    severity?: string
    severity_term_id?: string
    app?: string
    app_term_id?: string
    release?: string
    component?: string
    // KB_TOPIC term values (CASE-760 Phase 2). Reporting stores the term array
    // as one jsonb column (no row flattening); surfaced via the template's
    // cross_version_view declaration, since a post-split default view keeps its
    // creation-time shape and does not widen on new template versions.
    topics?: string[]
  }
}

// One template's box on the start page: its TRUE total count plus the latest N
// header rows (client-side search/sort/paginate runs over `items`; `truncated`
// flags that the group has more than the loaded window).
export interface SummaryGroup {
  templateValue: string
  count: number
  items: HeaderDoc[]
  newest: string
  truncated: boolean
}

export interface KbSummary {
  groups: SummaryGroup[]
  caseStats: { open: number; responded: number }
}

// Namespaces are interpolated into SQL, always inside quotes ('…' literals and
// "…" schema identifiers). The shown domain can come from the URL (DECISION-1), so
// the shape is enforced: a namespace slug, hyphens included (`dev-proj-a`), and
// never a quote.
const NS_RE = /^[a-z][a-z0-9_-]*$/

// Reporting retains soft-deleted documents as rows (the kb namespace runs
// deletion_mode: retain), flagged with the platform lifecycle column
// status = 'deleted'. The document-store's query surface defaults to
// active-only; every reporting query that ENUMERATES content (counts, latest
// lists, the corpus, flags, edge degrees) must apply the same default, or the
// UI shows retired docs the API-based surfaces correctly hide. Lookups that
// RESOLVE an existing reference by id (fetchDocTitlesByIds) deliberately skip
// this filter: a doc that points at a retired doc must still render that
// reference — retired means invisible to new reads, not broken for old ones.
const ONLY_ACTIVE = `status = 'active'`

// Header columns projected when the template has them (document_id / created_at /
// updated_at are on every doc table). `data_status` carries the workflow status
// (data.status); top-level `status` is the WIP lifecycle, not what the UI means.
// A doc table exposing NONE of these is an edge type (relationship) → skipped.
const HEADER_COLS: Record<string, string> = {
  title: 'text',
  case_number: 'integer',
  response_seq: 'integer',
  fireside_number: 'integer',
  paper_number: 'integer',
  lesson_number: 'integer',
  decision_number: 'integer',
  authored_by: 'text',
  session_id: 'text',
  path: 'text',
  data_status: 'text',
  doc_status: 'text',
  owner: 'text',
  kind: 'text',
  severity: 'text',
  severity_term_id: 'text',
  app: 'text',
  app_term_id: 'text',
  release: 'text',
  component: 'text',
  topics: 'jsonb',
}

interface RawHeaderRow {
  document_id: string
  created_at: string
  updated_at: string
  template_value: string
  title: string | null
  case_number: number | null
  response_seq: number | null
  fireside_number: number | null
  paper_number: number | null
  lesson_number: number | null
  decision_number: number | null
  authored_by: string | null
  session_id: string | null
  path: string | null
  data_status: string | null
  doc_status: string | null
  owner: string | null
  kind: string | null
  severity: string | null
  severity_term_id: string | null
  app: string | null
  app_term_id: string | null
  release: string | null
  component: string | null
  // jsonb — arrives as a JSON-encoded string from the reporting endpoint
  topics: string | string[] | null
}

// The reporting API's own view of which relation is an entity's query surface
// (CASE-715). Post-split, ONE template owns three relations that all return the
// same rows — the physical `doc_<v>__vN` table, the `doc_<v>__entities` view, and
// the bare `doc_<v>` view. A `LIKE 'doc_%'` sweep keeps all three and counts every
// document three times (localhost read "4926 docs across 34 types" against a
// ground truth of 3,410).
const REL_RE = /^doc_[a-z0-9_]+$/

// Ask the API which relations to query rather than parsing names. A suffix
// heuristic works today and breaks on the first template that reaches v2 (a new
// `__v2` to chase) — the `entities` grouping exists to retire exactly that.
// Uses the client's typed reporting service (@wip/client >= 0.36.0), so the
// response shape is version-tracked with the platform instead of hand-declared
// here: ReportEntity documents that `row_count` is the entity's document count
// under latest_only, which is the invariant this whole path depends on.
async function fetchCanonicalRelations(namespace: string): Promise<string[]> {
  const d = await wipClient.reporting.listTables(undefined, namespace)
  // Post-split: `entities` names the default view per entity. Pre-split (what
  // kb.internal still runs): no grouping, and the flat list is already one table
  // per entity — the bare name is deliberately identical in both worlds, so the
  // rest of this module needs no branch.
  const names = d.entities?.length
    ? d.entities.map((e) => (e.default_view_present === false ? e.entities_view : e.default_view))
    : (d.tables ?? []).map((t) => t.name)
  // Names are interpolated into SQL identifiers below; the API is trusted but the
  // guard is cheap and keeps that assumption from becoming load-bearing.
  return [...new Set(names.filter((n): n is string => !!n && REL_RE.test(n)))]
}

// Per namespace: which canonical doc_<stem> relations exist and which header
// columns each has.
async function fetchTableColumns(namespace: string): Promise<Map<string, Set<string>>> {
  const relations = await fetchCanonicalRelations(namespace)
  if (relations.length === 0) return new Map()
  const cols = Object.keys(HEADER_COLS)
    .map((c) => `'${c}'`)
    .join(',')
  const sql =
    `SELECT table_name, column_name FROM information_schema.columns ` +
    `WHERE table_schema = '${namespace}' ` +
    `AND table_name IN (${relations.map((r) => `'${r}'`).join(',')}) ` +
    `AND column_name IN (${cols})`
  const { rows } = await reportingQuery<{ table_name: string; column_name: string }>(namespace, sql)
  const map = new Map<string, Set<string>>()
  for (const r of rows) {
    const stem = r.table_name.replace(/^doc_/, '')
    if (!map.has(stem)) map.set(stem, new Set())
    map.get(stem)!.add(r.column_name)
  }
  return map
}

// The header column projection for one table (fixed order across every branch so
// positional UNIONs line up): present columns by name, absent ones as typed NULLs.
function headerProjection(present: Set<string>): string {
  return Object.entries(HEADER_COLS)
    .map(([c, type]) => (present.has(c) ? c : `NULL::${type} AS ${c}`))
    .join(', ')
}

function toHeaderDoc(r: RawHeaderRow, namespace: string): HeaderDoc {
  const data: HeaderDoc['data'] = {}
  if (r.title != null) data.title = r.title
  if (r.case_number != null) data.case_number = r.case_number
  if (r.response_seq != null) data.response_seq = r.response_seq
  if (r.fireside_number != null) data.fireside_number = r.fireside_number
  if (r.paper_number != null) data.paper_number = r.paper_number
  if (r.lesson_number != null) data.lesson_number = r.lesson_number
  if (r.decision_number != null) data.decision_number = r.decision_number
  if (r.authored_by != null) data.authored_by = r.authored_by
  if (r.session_id != null) data.session_id = r.session_id
  if (r.path != null) data.path = r.path
  if (r.data_status != null) data.status = r.data_status
  if (r.doc_status != null) data.doc_status = r.doc_status
  if (r.owner != null) data.owner = r.owner
  if (r.kind != null) data.kind = r.kind
  if (r.severity != null) data.severity = r.severity
  if (r.severity_term_id != null) data.severity_term_id = r.severity_term_id
  if (r.app != null) data.app = r.app
  if (r.app_term_id != null) data.app_term_id = r.app_term_id
  if (r.release != null) data.release = r.release
  if (r.component != null) data.component = r.component
  if (r.topics != null) {
    try {
      const t = typeof r.topics === 'string' ? JSON.parse(r.topics) : r.topics
      if (Array.isArray(t) && t.length > 0) data.topics = t.filter((x) => typeof x === 'string')
    } catch {
      // malformed jsonb payload — treat as untagged rather than failing the row
    }
  }
  return {
    document_id: r.document_id,
    namespace,
    template_value: r.template_value,
    created_at: r.created_at,
    updated_at: r.updated_at,
    data,
  }
}

// Entity tables in a namespace: content-bearing (≥1 header column) and not hidden.
function entityTables(
  tables: Map<string, Set<string>>,
  hidden: Set<string>,
): Array<[stem: string, present: Set<string>]> {
  return [...tables].filter(
    ([stem, present]) => present.size > 0 && !hidden.has(stem.toUpperCase()),
  )
}

interface NsSummary {
  counts: Map<string, number>
  rows: HeaderDoc[]
  caseStatus: Map<string, number>
}

async function fetchNamespaceSummary(
  namespace: string,
  hidden: Set<string>,
  limit: number,
): Promise<NsSummary> {
  if (!NS_RE.test(namespace)) throw new Error(`invalid namespace: ${namespace}`)
  const tables = entityTables(await fetchTableColumns(namespace), hidden)
  if (tables.length === 0) {
    return { counts: new Map(), rows: [], caseStatus: new Map() }
  }

  const countsSql = tables
    .map(([stem]) => `SELECT '${stem.toUpperCase()}' AS t, count(*)::int AS c FROM "${namespace}"."doc_${stem}" WHERE ${ONLY_ACTIVE}`)
    .join(' UNION ALL ')

  // Each per-table branch is LIMIT-bounded, so the union is ≤ tables×limit rows —
  // size max_rows to that so the cap never truncates a summary.
  const latestSql = tables
    .map(
      ([stem, present]) =>
        `(SELECT document_id, created_at, updated_at, ${headerProjection(present)}, ` +
        `'${stem.toUpperCase()}' AS template_value ` +
        `FROM "${namespace}"."doc_${stem}" WHERE ${ONLY_ACTIVE} ORDER BY updated_at DESC LIMIT ${limit})`,
    )
    .join('\nUNION ALL\n')

  const hasCases = tables.some(([stem]) => stem === 'case_record')

  const [countsRes, latestRes, caseRes] = await Promise.all([
    reportingQuery<{ t: string; c: number }>(namespace, countsSql),
    reportingQuery<RawHeaderRow>(namespace, latestSql, tables.length * limit + 100),
    hasCases
      ? reportingQuery<{ ds: string | null; c: number }>(
          namespace,
          `SELECT data_status AS ds, count(*)::int AS c FROM "${namespace}"."doc_case_record" WHERE ${ONLY_ACTIVE} GROUP BY data_status`,
        )
      : Promise.resolve(null),
  ])

  const counts = new Map<string, number>()
  for (const r of countsRes.rows) counts.set(r.t, r.c)
  const caseStatus = new Map<string, number>()
  for (const r of caseRes?.rows ?? []) if (r.ds) caseStatus.set(r.ds, r.c)

  return { counts, rows: latestRes.rows.map((r) => toHeaderDoc(r, namespace)), caseStatus }
}

// Build the start-page summary from reporting: per-type counts + the latest N
// header rows per type + case open/responded counts. Two queries per namespace
// (plus a schema probe and, where cases live, a status aggregation) — replaces the
// whole-corpus, full-body document sweep (CASE-687). `hidden` is the set of
// UPPER_SNAKE template values to omit (structural/config types, CASE_RESPONSE).
export async function fetchSummary(
  namespaces: string[],
  hidden: Set<string>,
  limit = 200,
): Promise<KbSummary> {
  const perNs = await Promise.all(
    namespaces.map((ns) => fetchNamespaceSummary(ns, hidden, limit)),
  )

  const countByType = new Map<string, number>()
  const itemsByType = new Map<string, HeaderDoc[]>()
  const caseStats = { open: 0, responded: 0 }
  for (const ns of perNs) {
    for (const [t, c] of ns.counts) countByType.set(t, (countByType.get(t) ?? 0) + c)
    for (const d of ns.rows) {
      const arr = itemsByType.get(d.template_value) ?? []
      arr.push(d)
      itemsByType.set(d.template_value, arr)
    }
    caseStats.open += ns.caseStatus.get('open') ?? 0
    caseStats.responded += ns.caseStatus.get('responded') ?? 0
  }

  const groups: SummaryGroup[] = []
  for (const [templateValue, count] of countByType) {
    if (count === 0) continue
    const items = (itemsByType.get(templateValue) ?? []).sort((a, b) =>
      b.updated_at.localeCompare(a.updated_at),
    )
    groups.push({
      templateValue,
      count,
      items,
      newest: items[0]?.updated_at ?? '',
      truncated: count > items.length,
    })
  }
  groups.sort((a, b) => b.newest.localeCompare(a.newest))

  return { groups, caseStats }
}

// Every entity document across the given namespaces, header fields only (no body),
// for the search page's browse set + facet rails + FTS-hit hydration. One schema
// probe + one UNION-of-all-entity-tables query per namespace, bounded by max_rows
// (well above the current corpus; header rows are tiny). Replaces the whole-corpus
// full-body fetch (CASE-687 Phase 2). `hidden` omits structural types but KEEPS
// CASE_RESPONSE, which search surfaces on demand.
export async function fetchCorpusHeaders(
  namespaces: string[],
  hidden: Set<string>,
): Promise<HeaderDoc[]> {
  const perNs = await Promise.all(
    namespaces.map(async (ns) => {
      if (!NS_RE.test(ns)) throw new Error(`invalid namespace: ${ns}`)
      const tables = entityTables(await fetchTableColumns(ns), hidden)
      if (tables.length === 0) return []
      const sql = tables
        .map(
          ([stem, present]) =>
            `SELECT document_id, created_at, updated_at, ${headerProjection(present)}, ` +
            `'${stem.toUpperCase()}' AS template_value FROM "${ns}"."doc_${stem}" WHERE ${ONLY_ACTIVE}`,
        )
        .join('\nUNION ALL\n')
      const { rows } = await reportingQuery<RawHeaderRow>(ns, sql, 50000)
      return rows.map((r) => toHeaderDoc(r, ns))
    }),
  )
  return perNs.flat()
}

// ── Per-document-view lookups (CASE-687 Tier 2) ──────────────────────────────
// DocPage used to fire one request PER related item (per peer, per reference, per
// flag). These fold each fan-out into a single reporting query keyed by id.

// document_ids are Registry UUIDs; guard before inlining into SQL.
const ID_RE = /^[0-9a-f][0-9a-f-]{15,}$/i

const quoteIds = (ids: string[]): string | null => {
  const clean = [...new Set(ids.filter((id) => ID_RE.test(id)))]
  return clean.length ? clean.map((id) => `'${id}'`).join(',') : null
}

export interface RefTitle {
  title: string
  templateValue: string
  namespace: string
}

// Titles for a set of document ids (any entity type) across namespaces — one query
// per namespace, replacing DocPage's per-reference full-document fetches.
// No ONLY_ACTIVE filter here, on purpose: these ids come from existing documents'
// references, and a reference to a retired doc must keep resolving to its title.
export async function fetchDocTitlesByIds(
  namespaces: string[],
  ids: string[],
): Promise<Map<string, RefTitle>> {
  const idList = quoteIds(ids)
  const out = new Map<string, RefTitle>()
  if (!idList) return out
  await Promise.all(
    namespaces.map(async (ns) => {
      if (!NS_RE.test(ns)) return
      const tables = entityTables(await fetchTableColumns(ns), new Set())
      if (tables.length === 0) return
      const sql = tables
        .map(
          ([stem, present]) =>
            `SELECT document_id, ${present.has('title') ? 'title' : 'NULL::text AS title'}, ` +
            `'${stem.toUpperCase()}' AS template_value FROM "${ns}"."doc_${stem}" ` +
            `WHERE document_id IN (${idList})`,
        )
        .join(' UNION ALL ')
      const { rows } = await reportingQuery<{
        document_id: string
        title: string | null
        template_value: string
      }>(ns, sql)
      for (const r of rows)
        out.set(r.document_id, {
          title: r.title ?? '',
          templateValue: r.template_value,
          namespace: ns,
        })
    }),
  )
  return out
}

// target_yac for a set of FLAG_RECORD ids — one query replacing DocPage's per-flag
// full-document fetches. Flags live in the flagged document's namespace.
export async function fetchFlagTargets(
  namespace: string,
  ids: string[],
): Promise<Map<string, string>> {
  if (!NS_RE.test(namespace)) throw new Error(`invalid namespace: ${namespace}`)
  const idList = quoteIds(ids)
  const out = new Map<string, string>()
  if (!idList) return out
  const { rows } = await reportingQuery<{ document_id: string; target_yac: string | null }>(
    namespace,
    `SELECT document_id, target_yac FROM "${namespace}"."doc_flag_record" WHERE ${ONLY_ACTIVE} AND document_id IN (${idList})`,
  )
  for (const r of rows) if (r.target_yac) out.set(r.document_id, r.target_yac)
  return out
}

// Claims holding cases: who is working on each case, for which kind of work. A
// claim holds while it is parked, or active with a lease that has not run out
// (server/lib/claims.ts has the same rule). One query for a page of cases. A
// namespace without the claim model (not yet migrated, or a corpus created before
// it) has no claims. Its table is looked up first, rather than the query being
// tried and its error swallowed: a failed request is logged by the browser on every
// page, and reads as a fault where nothing is wrong.
export interface CaseClaimView {
  kind: string
  holder: string
  state: 'active' | 'parked'
  leaseUntil: string | null
}
export async function fetchCaseClaims(
  namespace: string,
  caseNumbers: number[],
): Promise<Map<number, CaseClaimView[]>> {
  if (!NS_RE.test(namespace)) throw new Error(`invalid namespace: ${namespace}`)
  const nums = [...new Set(caseNumbers.filter((n) => Number.isInteger(n)))]
  const out = new Map<number, CaseClaimView[]>()
  if (!nums.length) return out
  const { rows: has } = await reportingQuery<{ present: boolean }>(
    namespace,
    `SELECT to_regclass('"${namespace}"."doc_case_claim"') IS NOT NULL AS present`,
  )
  if (!has[0]?.present) return out
  const { rows } = await reportingQuery<{ case_number: number; claim_kind: string; holder: string; state: string; lease_until: string | null }>(
    namespace,
    `SELECT case_number, claim_kind, holder, state, lease_until FROM "${namespace}"."doc_case_claim"`
      + ` WHERE ${ONLY_ACTIVE} AND state IN ('active', 'parked') AND case_number IN (${nums.join(',')})`,
  )
  const now = Date.now()
  for (const r of rows) {
    if (r.state === 'active' && !(r.lease_until && Date.parse(r.lease_until) > now)) continue
    const list = out.get(r.case_number) ?? []
    list.push({ kind: r.claim_kind, holder: r.holder, state: r.state as 'active' | 'parked', leaseUntil: r.lease_until })
    out.set(r.case_number, list)
  }
  return out
}

// Every claim in progress across the KB, for the home page's panel: claims that
// hold a case (parked first, then by soonest lease end) and lapsed ones (active,
// lease ran out, never released). The rule is server/lib/claims.ts, shared with
// the gateway's GET /claims that kbc reads. A namespace without the claim model
// has none.
export interface ClaimInProgress {
  caseNumber: number
  caseDocumentId: string | null
  title: string | null
  caseStatus: string | null
  kind: string
  holder: string
  state: 'active' | 'parked'
  since: string | null
  leaseUntil: string | null
  note: string | null
  lapsed: boolean
}
export async function fetchClaimsInProgress(namespace: string): Promise<{ holding: ClaimInProgress[]; lapsed: ClaimInProgress[] }> {
  if (!NS_RE.test(namespace)) throw new Error(`invalid namespace: ${namespace}`)
  const empty = { holding: [], lapsed: [] }
  const { rows: has } = await reportingQuery<{ present: boolean }>(
    namespace,
    `SELECT to_regclass('"${namespace}"."doc_case_claim"') IS NOT NULL AS present`,
  )
  if (!has[0]?.present) return empty
  const { rows } = await reportingQuery<{
    case_number: number; claim_kind: string; holder: string; state: string; since: string | null
    lease_until: string | null; note: string | null; title: string | null; case_status: string | null; lapsed: boolean
    case_document_id: string | null
  }>(
    namespace,
    `SELECT c.case_number, c.claim_kind, c.holder, c.state, c.since, c.lease_until, c.note,`
      + ` r.title, r.data_status AS case_status, r.document_id AS case_document_id, ${sqlLapsed('c.')} AS lapsed`
      + ` FROM "${namespace}"."doc_case_claim" c`
      + ` LEFT JOIN "${namespace}"."doc_case_record" r ON r.case_number = c.case_number AND r.${ONLY_ACTIVE}`
      + ` WHERE c.${ONLY_ACTIVE} AND (${sqlHolds('c.')} OR ${sqlLapsed('c.')})`,
    50000,
  )
  const all: ClaimInProgress[] = rows.map((r) => ({
    caseNumber: r.case_number, caseDocumentId: r.case_document_id, title: r.title, caseStatus: r.case_status, kind: r.claim_kind,
    holder: r.holder, state: r.state as 'active' | 'parked', since: r.since, leaseUntil: r.lease_until,
    note: r.note, lapsed: !!r.lapsed,
  }))
  const t = (s: string | null) => (s ? Date.parse(s) : 0)
  return {
    holding: all.filter((c) => !c.lapsed).sort((a, b) =>
      (a.state === 'parked' ? 0 : 1) - (b.state === 'parked' ? 0 : 1)
      || (a.state === 'parked' ? t(a.since) - t(b.since) : t(a.leaseUntil) - t(b.leaseUntil))),
    lapsed: all.filter((c) => c.lapsed).sort((a, b) => t(a.leaseUntil) - t(b.leaseUntil)),
  }
}

// What each listed case's response thread says: counts by kind, reopened, never
// answered. The rule is server/lib/case-thread.ts, shared with the gateway's
// /cases, so the list and kbc agree. One reporting query for a page of cases; a
// case the thread cannot settle (open, no answer, possibly a reopen from before
// threaded responses) has its earlier versions read, which is rare. A namespace
// without responses yet has no thread table: then every case has an empty thread.
export interface ThreadCase {
  caseNumber: number
  documentId: string
  status: string | null | undefined
}
export async function fetchCaseThreads(
  namespace: string,
  cases: ThreadCase[],
): Promise<Map<number, ThreadSummary>> {
  if (!NS_RE.test(namespace)) throw new Error(`invalid namespace: ${namespace}`)
  const byNum = new Map(cases.filter((c) => Number.isInteger(c.caseNumber)).map((c) => [c.caseNumber, c]))
  const out = new Map<number, ThreadSummary>()
  if (!byNum.size) return out
  const { rows: has } = await reportingQuery<{ present: boolean }>(
    namespace,
    `SELECT to_regclass('"${namespace}"."doc_case_response"') IS NOT NULL AS present`,
  )
  const entries = new Map<number, ThreadEntry[]>()
  if (has[0]?.present) {
    const { rows } = await reportingQuery<{ case_number: number; response_kind: string; response_seq: number }>(
      namespace,
      `SELECT case_number, response_kind, response_seq FROM "${namespace}"."doc_case_response"`
        + ` WHERE ${ONLY_ACTIVE} AND case_number IN (${[...byNum.keys()].join(',')})`,
      50000,
    )
    for (const r of rows) {
      const list = entries.get(r.case_number) ?? []
      list.push({ response_kind: r.response_kind, response_seq: r.response_seq })
      entries.set(r.case_number, list)
    }
  }
  for (const [n, c] of byNum) {
    let s = summariseThread(c.status, entries.get(n) ?? [])
    if (s.needsHistory) s = applyHistory(s, await earlierCaseStatuses(namespace, c.documentId))
    out.set(n, s)
  }
  return out
}

// The workflow statuses a case had before its current version, newest first,
// stopping at the first finished one. Reporting keeps only the latest version.
async function earlierCaseStatuses(namespace: string, documentId: string): Promise<string[]> {
  try {
    const ns = encodeURIComponent(namespace)
    const v = await wipFetchJson<{ current_version: number; versions: Array<{ version: number }> }>(
      `/api/document-store/documents/${documentId}/versions?namespace=${ns}`)
    const older = v.versions.map((x) => x.version).filter((n) => n < v.current_version).sort((a, b) => b - a).slice(0, 25)
    const out: string[] = []
    for (const n of older) {
      const d = await wipFetchJson<{ data?: { status?: string } }>(
        `/api/document-store/documents/${documentId}/versions/${n}?namespace=${ns}`)
      out.push(d.data?.status ?? '')
      if (out[out.length - 1] === 'implemented' || out[out.length - 1] === 'closed') break
    }
    return out
  } catch {
    return []
  }
}

// Which of a set of documents carry an OUTSTANDING respond flag — one asked for and
// not yet answered:
//   'pending'    — written (doc_status 'published'), not yet dispatched;
//   'dispatched' — dispatched, and the case has no response created since the flag
//                  was last written (re-arm or dispatch). A dispatch that has not
//                  produced its response yet must not invite another click: every
//                  re-arm is dispatched again and can produce another response.
// A response created after the flag clears it: the flag did its job, and flagging
// again means asking for another response. For a document that is not a case
// there are no responses to wait for, so only 'pending' applies.
// One query for a whole result page. A flag names its document in
// flagged_document, a plain string: usually the document ID, occasionally a case
// handle (CASE-<n>), so both forms are matched and folded back to the ID.
export type OutstandingFlag = 'pending' | 'dispatched'
const CASE_HANDLE_RE = /^CASE-\d+$/
export async function fetchOutstandingRespondFlags(
  namespace: string,
  docs: Array<{ documentId: string; caseNumber?: number | null }>,
): Promise<Map<string, OutstandingFlag>> {
  if (!NS_RE.test(namespace)) throw new Error(`invalid namespace: ${namespace}`)
  const byKey = new Map<string, string>()
  for (const d of docs) {
    if (ID_RE.test(d.documentId)) byKey.set(d.documentId, d.documentId)
    if (d.caseNumber != null) {
      const handle = `CASE-${d.caseNumber}`
      if (CASE_HANDLE_RE.test(handle)) byKey.set(handle, d.documentId)
    }
  }
  const out = new Map<string, OutstandingFlag>()
  if (!byKey.size) return out
  const list = [...byKey.keys()].map((k) => `'${k}'`).join(',')
  const ns = `"${namespace}"`
  const { rows } = await reportingQuery<{ flagged_document: string; doc_status: string }>(
    namespace,
    `SELECT f.flagged_document, f.doc_status FROM ${ns}."doc_flag_record" f`
      + ` LEFT JOIN ${ns}."doc_case_record" c ON c.${ONLY_ACTIVE}`
      + ` AND f.flagged_document IN (c.document_id, 'CASE-' || c.case_number)`
      + ` WHERE f.${ONLY_ACTIVE} AND f.flag_type = 'respond' AND f.flagged_document IN (${list})`
      + ` AND (f.doc_status = 'published' OR (c.case_number IS NOT NULL AND NOT EXISTS (`
      + `SELECT 1 FROM ${ns}."doc_case_response" r WHERE r.${ONLY_ACTIVE}`
      + ` AND r.case_number = c.case_number AND r.created_at > f.updated_at)))`,
  )
  for (const r of rows) {
    const id = byKey.get(r.flagged_document)
    if (id) out.set(id, r.doc_status === 'published' ? 'pending' : 'dispatched')
  }
  return out
}

// Relationship degree (edges touching each id, both directions, all edge types) for
// a set of peer documents — one query across the namespace's edge tables, replacing
// DocPage's per-peer /relationships round-trip for the "more-neighbors" badge.
export async function fetchPeerDegrees(
  namespace: string,
  ids: string[],
): Promise<Map<string, number>> {
  if (!NS_RE.test(namespace)) throw new Error(`invalid namespace: ${namespace}`)
  const idList = quoteIds(ids)
  if (!idList) return new Map()
  const views = await edgeViews(namespace)
  if (views.length === 0) return new Map()
  const union = views
    .flatMap((v) => [
      `SELECT source_ref AS ref FROM "${namespace}"."${v}" WHERE ${ONLY_ACTIVE}`,
      `SELECT target_ref AS ref FROM "${namespace}"."${v}" WHERE ${ONLY_ACTIVE}`,
    ])
    .join(' UNION ALL ')
  const { rows } = await reportingQuery<{ ref: string; c: number }>(
    namespace,
    `SELECT ref, count(*)::int AS c FROM (${union}) e WHERE ref IN (${idList}) GROUP BY ref`,
    10000,
  )
  return new Map(rows.map((r) => [r.ref, r.c]))
}

// The edge-type relations to query: one entity view per edge type ("doc_<type>").
// Each edge type also has a physical table per template version (doc_<type>__v<N>)
// and an __entities relation with the same rows, so selecting every relation that
// has a source_ref column counts each edge several times.
async function edgeViews(namespace: string): Promise<string[]> {
  const { rows } = await reportingQuery<{ table_name: string }>(
    namespace,
    `SELECT DISTINCT table_name FROM information_schema.columns ` +
      `WHERE table_schema = '${namespace}' AND table_name LIKE 'doc_%' AND column_name = 'source_ref'`,
  )
  return rows.map((r) => r.table_name).filter((t) => !/__(v\d+|entities)$/.test(t))
}

export interface EdgeRow {
  edgeType: string // template value, e.g. REFERENCES
  sourceId: string
  targetId: string
}

// Every active edge with either end in `ids`, across all edge types — one query.
// The case page uses it for its responses' own links, which the case's
// relationships call does not return because they belong to the response documents.
export async function fetchEdgesTouching(namespace: string, ids: string[]): Promise<EdgeRow[]> {
  if (!NS_RE.test(namespace)) throw new Error(`invalid namespace: ${namespace}`)
  const idList = quoteIds(ids)
  if (!idList) return []
  const views = await edgeViews(namespace)
  if (views.length === 0) return []
  const sql = views
    .map(
      (v) =>
        `SELECT '${v.slice('doc_'.length).toUpperCase()}' AS edge_type, source_ref, target_ref ` +
        `FROM "${namespace}"."${v}" WHERE ${ONLY_ACTIVE} ` +
        `AND (source_ref IN (${idList}) OR target_ref IN (${idList}))`,
    )
    .join(' UNION ALL ')
  const { rows } = await reportingQuery<{ edge_type: string; source_ref: string; target_ref: string }>(
    namespace,
    sql,
    10000,
  )
  return rows.map((r) => ({ edgeType: r.edge_type, sourceId: r.source_ref, targetId: r.target_ref }))
}
