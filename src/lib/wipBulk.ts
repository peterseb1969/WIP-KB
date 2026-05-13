interface BulkItemResult {
  index?: number
  status?: string
  id?: string
  error?: string
  error_code?: string
}

interface BulkResponse {
  results?: BulkItemResult[]
}

export function assertBulkSuccess(response: unknown, context: string): BulkItemResult[] {
  const r = response as BulkResponse | BulkItemResult[]
  const items: BulkItemResult[] = Array.isArray(r) ? r : (r.results ?? [])
  const errors = items.filter((i) => i.status === 'error')
  if (errors.length > 0) {
    const summary = errors
      .map((e) => `[${e.index ?? '?'}] ${e.error_code || ''} ${e.error || 'unknown'}`.trim())
      .join('; ')
    throw new Error(`${context}: ${errors.length}/${items.length} items failed — ${summary}`)
  }
  return items
}

// Vite BASE_URL always ends in `/`. In dev it's `/`; in prod (behind
// ingress) it's `/apps/kb/`. Concatenating without a leading slash on
// `wip` gives the right URL in both contexts.
const WIP_BASE = `${import.meta.env.BASE_URL}wip`

export async function wipFetchJson<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${WIP_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path}: ${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}
