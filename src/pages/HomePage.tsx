import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { wipFetchJson } from '../lib/wipBulk'

const NAMESPACE = 'kb'

interface DocItem {
  document_id: string
  template_value: string
  data: { title?: string; authored_by?: string; doc_status?: string; [k: string]: unknown }
  created_at: string
  updated_at: string
}

interface ListResponse {
  items: DocItem[]
  total: number
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

export default function HomePage() {
  const { data, isLoading, error } = useQuery<ListResponse>({
    queryKey: ['kb-docs', NAMESPACE],
    queryFn: () =>
      wipFetchJson<ListResponse>(
        `/api/document-store/documents?namespace=${NAMESPACE}&page_size=100&latest_only=true`,
      ),
    staleTime: 30_000,
  })

  const { data: templates } = useQuery<TemplateListResponse>({
    queryKey: ['templates', NAMESPACE],
    queryFn: () =>
      wipFetchJson<TemplateListResponse>(
        `/api/template-store/templates?namespace=${NAMESPACE}&latest_only=true&page_size=100`,
      ),
    staleTime: 5 * 60_000,
  })

  if (isLoading) return <p className="text-sm text-text-muted">Loading…</p>
  if (error) return <p className="text-sm text-danger">Failed to load: {(error as Error).message}</p>

  const edgeTypes = new Set(
    (templates?.items ?? []).filter((t) => t.usage === 'relationship').map((t) => t.value),
  )

  const allItems = data?.items ?? []
  const items = allItems.filter((d) => !edgeTypes.has(d.template_value))
  const userContent = items.filter((d) => d.template_value !== 'BOOTSTRAP_RECORD')

  if (userContent.length === 0) {
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
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-text">Knowledge Base</h1>
      <p className="mb-6 text-sm text-text-muted">
        {items.length} doc{items.length === 1 ? '' : 's'} across {groups.length} type
        {groups.length === 1 ? '' : 's'}. Newest first within each type.
      </p>

      <div className="space-y-3">
        {groups.map((g) => (
          <details key={g.templateValue} open className="group rounded-lg border border-gray-200 bg-surface">
            <summary className="flex cursor-pointer items-center gap-3 px-4 py-3 text-sm hover:bg-background">
              <span className="text-text-muted transition group-open:rotate-90">▸</span>
              <span className="font-semibold tracking-tight text-text">{g.templateValue}</span>
              <span className="text-xs text-text-muted">
                {g.items.length} doc{g.items.length === 1 ? '' : 's'}
              </span>
              <span className="ml-auto text-xs text-text-muted">
                latest {new Date(g.newest).toLocaleDateString()}
              </span>
            </summary>
            <ul className="divide-y divide-gray-100 border-t border-gray-100">
              {g.items.map((d) => (
                <li key={d.document_id}>
                  <Link
                    to={`/doc/${d.document_id}`}
                    className="block px-4 py-2.5 transition hover:bg-background"
                  >
                    <div className="text-sm text-text">
                      {d.data.title || <span className="italic text-text-muted">(untitled)</span>}
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-text-muted">
                      {d.data.authored_by && <span>{d.data.authored_by}</span>}
                      {d.data.doc_status && <span>{d.data.doc_status}</span>}
                      <span className="ml-auto">{new Date(d.updated_at).toLocaleString()}</span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </details>
        ))}
      </div>
    </div>
  )
}
