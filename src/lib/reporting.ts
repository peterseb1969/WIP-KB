import { wipFetchJson } from './wipBulk'

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
    case_number?: number
    authored_by?: string
    session_id?: string
    path?: string
    status?: string // workflow status (data.status) — the reporting `data_status` column
    doc_status?: string
    owner?: string // YAC_MEMORY carries its author here, not in authored_by (CASE-603)
    // Facet fields the search rail reads (present only on the templates that
    // declare them: kind→DOCUMENT, severity/app/app_term_id/component→CASE_RECORD,
    // release→LIBRARY_DOC). app_term_id resolves the canonical KB_APP term (CASE-422)
    // in place of the document's term_references, which reporting does not carry.
    kind?: string
    severity?: string
    app?: string
    app_term_id?: string
    release?: string
    component?: string
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

// Namespaces come from app config (NAMESPACES), never user input — but they are
// interpolated into SQL identifiers, so validate the shape defensively.
const NS_RE = /^[a-z0-9_]+$/

// Header columns projected when the template has them (document_id / created_at /
// updated_at are on every doc table). `data_status` carries the workflow status
// (data.status); top-level `status` is the WIP lifecycle, not what the UI means.
// A doc table exposing NONE of these is an edge type (relationship) → skipped.
const HEADER_COLS: Record<string, string> = {
  title: 'text',
  case_number: 'integer',
  authored_by: 'text',
  session_id: 'text',
  path: 'text',
  data_status: 'text',
  doc_status: 'text',
  owner: 'text',
  kind: 'text',
  severity: 'text',
  app: 'text',
  app_term_id: 'text',
  release: 'text',
  component: 'text',
}

interface RawHeaderRow {
  document_id: string
  created_at: string
  updated_at: string
  template_value: string
  title: string | null
  case_number: number | null
  authored_by: string | null
  session_id: string | null
  path: string | null
  data_status: string | null
  doc_status: string | null
  owner: string | null
  kind: string | null
  severity: string | null
  app: string | null
  app_term_id: string | null
  release: string | null
  component: string | null
}

// Per namespace: which doc_<stem> tables exist and which header columns each has.
async function fetchTableColumns(namespace: string): Promise<Map<string, Set<string>>> {
  const cols = Object.keys(HEADER_COLS)
    .map((c) => `'${c}'`)
    .join(',')
  const sql =
    `SELECT table_name, column_name FROM information_schema.columns ` +
    `WHERE table_schema = '${namespace}' AND table_name LIKE 'doc_%' ` +
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
  if (r.authored_by != null) data.authored_by = r.authored_by
  if (r.session_id != null) data.session_id = r.session_id
  if (r.path != null) data.path = r.path
  if (r.data_status != null) data.status = r.data_status
  if (r.doc_status != null) data.doc_status = r.doc_status
  if (r.owner != null) data.owner = r.owner
  if (r.kind != null) data.kind = r.kind
  if (r.severity != null) data.severity = r.severity
  if (r.app != null) data.app = r.app
  if (r.app_term_id != null) data.app_term_id = r.app_term_id
  if (r.release != null) data.release = r.release
  if (r.component != null) data.component = r.component
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
    .map(([stem]) => `SELECT '${stem.toUpperCase()}' AS t, count(*)::int AS c FROM "${namespace}"."doc_${stem}"`)
    .join(' UNION ALL ')

  // Each per-table branch is LIMIT-bounded, so the union is ≤ tables×limit rows —
  // size max_rows to that so the cap never truncates a summary.
  const latestSql = tables
    .map(
      ([stem, present]) =>
        `(SELECT document_id, created_at, updated_at, ${headerProjection(present)}, ` +
        `'${stem.toUpperCase()}' AS template_value ` +
        `FROM "${namespace}"."doc_${stem}" ORDER BY updated_at DESC LIMIT ${limit})`,
    )
    .join('\nUNION ALL\n')

  const hasCases = tables.some(([stem]) => stem === 'case_record')

  const [countsRes, latestRes, caseRes] = await Promise.all([
    reportingQuery<{ t: string; c: number }>(namespace, countsSql),
    reportingQuery<RawHeaderRow>(namespace, latestSql, tables.length * limit + 100),
    hasCases
      ? reportingQuery<{ ds: string | null; c: number }>(
          namespace,
          `SELECT data_status AS ds, count(*)::int AS c FROM "${namespace}"."doc_case_record" GROUP BY data_status`,
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
            `'${stem.toUpperCase()}' AS template_value FROM "${ns}"."doc_${stem}"`,
        )
        .join('\nUNION ALL\n')
      const { rows } = await reportingQuery<RawHeaderRow>(ns, sql, 50000)
      return rows.map((r) => toHeaderDoc(r, ns))
    }),
  )
  return perNs.flat()
}
