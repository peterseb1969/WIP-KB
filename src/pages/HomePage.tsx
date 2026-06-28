import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { wipFetchJson } from '../lib/wipBulk'
import { docLabel } from '../lib/casePrefix'
import { CaseLabel } from '../components/CaseLabel'
import { NAMESPACES } from '../lib/namespaces'

// Structural / config doc types — not KB content, hidden from the start page.
// (Edge types are filtered separately via the template usage flag.)
// CASE_RESPONSE is a scoped child of a CASE_RECORD (viewable inline in the case
// thread); as a standalone group box it's just a list of case numbers eating
// screen space, so it's hidden here too (CASE-533).
const HIDDEN_TYPES = new Set(['BOOTSTRAP_RECORD', 'WRITE_POLICY', 'CASE_RESPONSE'])

interface DocItem {
  document_id: string
  namespace: string
  template_value: string
  data: {
    title?: string
    authored_by?: string
    doc_status?: string
    case_number?: number
    status?: string
    [k: string]: unknown
  }
  metadata?: {
    custom?: {
      case_status?: string
      [k: string]: unknown
    }
  }
  created_at: string
  updated_at: string
}

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

interface Group {
  templateValue: string
  items: DocItem[]
  newest: string
}

type SortKey =
  | 'updated_desc'
  | 'updated_asc'
  | 'created_desc'
  | 'created_asc'
  | 'title_asc'
  | 'title_desc'
  | 'case_asc'
  | 'case_desc'

function compareCaseNumber(a: DocItem, b: DocItem, dir: 'asc' | 'desc'): number {
  const aN = typeof a.data.case_number === 'number' ? a.data.case_number : null
  const bN = typeof b.data.case_number === 'number' ? b.data.case_number : null
  if (aN === null && bN === null) return 0
  if (aN === null) return 1
  if (bN === null) return -1
  return dir === 'asc' ? aN - bN : bN - aN
}

type PageSize = 5 | 10 | 25 | -1

function groupAndSort(items: DocItem[]): Group[] {
  const map = new Map<string, DocItem[]>()
  for (const d of items) {
    const arr = map.get(d.template_value) ?? []
    arr.push(d)
    map.set(d.template_value, arr)
  }
  const groups: Group[] = []
  for (const [templateValue, arr] of map) {
    arr.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    groups.push({ templateValue, items: arr, newest: arr[0]!.updated_at })
  }
  groups.sort((a, b) => b.newest.localeCompare(a.newest))
  return groups
}

async function fetchNamespaceDocs(namespace: string): Promise<DocItem[]> {
  // Fetch page 1 to learn the page count, then fetch the rest CONCURRENTLY
  // (CASE-501): the old serial loop paid per-request RTT N times — the dominant
  // cost on kb.internal (Pi). Wall-clock is now ~2×RTT instead of N×RTT.
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
  // Tag each doc with its source namespace — the unified view spans two
  // namespaces (CASE-518), and DocItem.namespace drives per-namespace edge-type
  // filtering and (later) namespace-aware doc links.
  return items.map((d) => ({ ...d, namespace }))
}

// Unified fetch across all configured namespaces (corpus + library), merged.
async function fetchAllDocs(namespaces: string[]): Promise<DocItem[]> {
  const perNs = await Promise.all(namespaces.map(fetchNamespaceDocs))
  return perNs.flat()
}

// Edge-type templates, per namespace. Relationship docs must be filtered out of
// the start page; edge-type sets differ per namespace, so we key the filter on
// `${namespace}:${template_value}`.
async function fetchEdgeTypeKeys(namespaces: string[]): Promise<Set<string>> {
  const perNs = await Promise.all(
    namespaces.map(async (ns) => {
      const r = await wipFetchJson<TemplateListResponse>(
        `/api/template-store/templates?namespace=${ns}&latest_only=true&page_size=100`,
      )
      return r.items
        .filter((t) => t.usage === 'relationship')
        .map((t) => `${ns}:${t.value}`)
    }),
  )
  return new Set(perNs.flat())
}

// Windowed pager: 1, …, p-1, p, p+1, …, last (caps button count)
function pageWindow(current: number, total: number): (number | 'el')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const out: (number | 'el')[] = [1]
  const left = Math.max(2, current - 1)
  const right = Math.min(total - 1, current + 1)
  if (left > 2) out.push('el')
  for (let i = left; i <= right; i++) out.push(i)
  if (right < total - 1) out.push('el')
  out.push(total)
  return out
}

function DocGroupBox({ group }: { group: Group }) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('updated_desc')
  const [pageSize, setPageSize] = useState<PageSize>(5)
  const [page, setPage] = useState(1)

  useEffect(() => {
    setPage(1)
  }, [query, sort, pageSize])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return group.items
    return group.items.filter((d) => {
      const t = docLabel(d.data, '').toLowerCase()
      const a = (d.data.authored_by ?? '').toLowerCase()
      return t.includes(q) || a.includes(q)
    })
  }, [group.items, query])

  const sorted = useMemo(() => {
    const arr = [...filtered]
    arr.sort((a, b) => {
      switch (sort) {
        case 'updated_desc':
          return b.updated_at.localeCompare(a.updated_at)
        case 'updated_asc':
          return a.updated_at.localeCompare(b.updated_at)
        case 'created_desc':
          return b.created_at.localeCompare(a.created_at)
        case 'created_asc':
          return a.created_at.localeCompare(b.created_at)
        case 'title_asc':
          return docLabel(a.data, '').localeCompare(docLabel(b.data, ''))
        case 'title_desc':
          return docLabel(b.data, '').localeCompare(docLabel(a.data, ''))
        case 'case_asc':
          return compareCaseNumber(a, b, 'asc')
        case 'case_desc':
          return compareCaseNumber(a, b, 'desc')
      }
    })
    return arr
  }, [filtered, sort])

  const hasCases = useMemo(
    () => group.items.some((d) => typeof d.data.case_number === 'number'),
    [group.items],
  )

  const total = sorted.length
  const showAll = pageSize === -1
  const pageCount = showAll ? 1 : Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.min(page, pageCount)
  const visible = showAll ? sorted : sorted.slice((safePage - 1) * pageSize, safePage * pageSize)
  const rangeStart = total === 0 ? 0 : showAll ? 1 : (safePage - 1) * pageSize + 1
  const rangeEnd = showAll ? total : Math.min(safePage * pageSize, total)

  return (
    <details open className="group rounded-lg border border-gray-200 bg-surface">
      <summary className="flex cursor-pointer items-center gap-3 px-4 py-3 text-sm hover:bg-background">
        <span className="text-text-muted transition group-open:rotate-90">▸</span>
        <span className="font-semibold tracking-tight text-text">{group.templateValue}</span>
        <span className="text-xs text-text-muted">
          {group.items.length} doc{group.items.length === 1 ? '' : 's'}
        </span>
        <span className="ml-auto text-xs text-text-muted">
          latest {new Date(group.newest).toLocaleDateString()}
        </span>
      </summary>

      <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 px-4 py-2.5">
        <input
          type="search"
          placeholder="Search title or author"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="min-w-0 flex-1 rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          aria-label="Sort"
          className="rounded-md border border-gray-200 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
        >
          <option value="updated_desc">Updated · newest</option>
          <option value="updated_asc">Updated · oldest</option>
          <option value="created_desc">Created · newest</option>
          <option value="created_asc">Created · oldest</option>
          <option value="case_asc" disabled={!hasCases}>
            Case # · ascending
          </option>
          <option value="case_desc" disabled={!hasCases}>
            Case # · descending
          </option>
          <option value="title_asc">Title · A→Z</option>
          <option value="title_desc">Title · Z→A</option>
        </select>
        <select
          value={pageSize}
          onChange={(e) => setPageSize(parseInt(e.target.value, 10) as PageSize)}
          aria-label="Page size"
          className="rounded-md border border-gray-200 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
        >
          <option value={5}>5 / page</option>
          <option value={10}>10 / page</option>
          <option value={25}>25 / page</option>
          <option value={-1}>Show all</option>
        </select>
      </div>

      <ul className="divide-y divide-gray-100 border-t border-gray-100">
        {visible.length === 0 ? (
          <li className="px-4 py-3 text-sm italic text-text-muted">No matches</li>
        ) : (
          visible.map((d) => (
            <li key={d.document_id}>
              <Link
                to={`/doc/${d.document_id}`}
                className="block px-4 py-2.5 transition hover:bg-background"
              >
                <div className="text-sm text-text">
                  <CaseLabel data={d.data} />
                </div>
                <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-text-muted">
                  {d.data.authored_by && <span>{d.data.authored_by}</span>}
                  {workflowStatus(d) && <span>{workflowStatus(d)}</span>}
                  <span className="ml-auto">{new Date(d.updated_at).toLocaleString()}</span>
                </div>
              </Link>
            </li>
          ))
        )}
      </ul>

      {(showAll || pageCount > 1) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 px-4 py-2 text-xs text-text-muted">
          <span>
            {rangeStart === 0 ? '0' : `${rangeStart}–${rangeEnd}`} of {total}
            {query.trim() && ` (filtered)`}
          </span>
          {!showAll && pageCount > 1 && (
            <div className="flex flex-wrap items-center gap-1">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={safePage === 1}
                className="rounded-md border border-gray-200 px-2 py-0.5 hover:bg-background disabled:cursor-not-allowed disabled:opacity-40"
              >
                Prev
              </button>
              {pageWindow(safePage, pageCount).map((p, i) =>
                p === 'el' ? (
                  <span key={`el-${i}`} className="px-1">
                    …
                  </span>
                ) : (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPage(p)}
                    className={
                      p === safePage
                        ? 'rounded-md bg-primary px-2 py-0.5 font-medium text-white'
                        : 'rounded-md border border-gray-200 px-2 py-0.5 hover:bg-background'
                    }
                  >
                    {p}
                  </button>
                ),
              )}
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                disabled={safePage === pageCount}
                className="rounded-md border border-gray-200 px-2 py-0.5 hover:bg-background disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next
              </button>
              <button
                type="button"
                onClick={() => setPageSize(-1)}
                className="ml-1 rounded-md border border-primary/30 px-2 py-0.5 text-primary hover:bg-primary/5"
              >
                Show all
              </button>
            </div>
          )}
          {showAll && total > pageSize && (
            <button
              type="button"
              onClick={() => setPageSize(5)}
              className="rounded-md border border-primary/30 px-2 py-0.5 text-primary hover:bg-primary/5"
            >
              Limit to 5
            </button>
          )}
        </div>
      )}
    </details>
  )
}

/**
 * `/` route — the start page. Sweeps all docs (paged concurrently), groups them by
 * template_value newest-first, and renders a collapsible box per type with
 * per-group search/sort. HIDDEN_TYPES excludes structural/config types and
 * CASE_RESPONSE.
 */
export default function HomePage() {
  const nsKey = NAMESPACES.join(',')
  const { data, isLoading, error } = useQuery<DocItem[]>({
    queryKey: ['kb-docs-all', nsKey],
    queryFn: () => fetchAllDocs(NAMESPACES),
    staleTime: 30_000,
  })

  const { data: edgeTypeKeys } = useQuery<Set<string>>({
    queryKey: ['edge-type-keys', nsKey],
    queryFn: () => fetchEdgeTypeKeys(NAMESPACES),
    staleTime: 5 * 60_000,
  })

  if (isLoading) return <p className="text-sm text-text-muted">Loading…</p>
  if (error) return <p className="text-sm text-danger">Failed to load: {(error as Error).message}</p>

  const edgeKeys = edgeTypeKeys ?? new Set<string>()
  const allItems = data ?? []
  const items = allItems.filter(
    (d) =>
      !edgeKeys.has(`${d.namespace}:${d.template_value}`) &&
      !HIDDEN_TYPES.has(d.template_value),
  )

  if (items.length === 0) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <p className="max-w-md text-center text-text-muted">
          A YAC needs to write a doc before the UI is activated.
        </p>
      </div>
    )
  }

  const groups = groupAndSort(items)

  return (
    <div>
      <p className="mb-6 text-sm text-text-muted">
        {items.length} doc{items.length === 1 ? '' : 's'} across {groups.length} type
        {groups.length === 1 ? '' : 's'}.
      </p>

      <div className="space-y-3">
        {groups.map((g) => (
          <DocGroupBox key={g.templateValue} group={g} />
        ))}
      </div>
    </div>
  )
}
