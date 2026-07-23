import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { wipKeys } from '@wip/react'
import { wipFetchJson } from '../lib/wipBulk'
import { addEdge } from '../lib/kbGateway'
import { CORPUS_NS } from '../lib/namespaces'

// The curated subset of the 10 KB edge types that make sense as a human-authored
// doc→doc link. The rest carry workflow or YAC-write semantics (RESPONDS_TO,
// FLAGGED_FROM, CONTINUES_FROM, AGENT_PARTICIPATED, …) and are created by their
// own flows, never hand-picked here. SUPERSEDES is directional newer→older, and
// the source is always the doc you're viewing — so "this doc supersedes CASE-n".
const EDGE_TYPES = [
  { value: 'REFERENCES', label: 'references' },
  { value: 'RELATES_TO', label: 'relates to' },
  { value: 'SUPERSEDES', label: 'supersedes' },
] as const

interface CasePreview {
  id: string
  title: string
}

// Resolve CASE-<n> → { document_id, title } through the browser's key-injecting
// /wip proxy: the Registry resolves the synonym, then a doc read supplies the
// title. Returns null on a miss. Mirrors CaseJump's resolver.
async function resolveCase(n: string): Promise<CasePreview | null> {
  const lookup = await wipFetchJson<{ results?: Array<{ status?: string; entry_id?: string }> }>(
    '/api/registry/entries/lookup/by-key',
    {
      method: 'POST',
      body: JSON.stringify([
        { namespace: CORPUS_NS, entity_type: 'documents', composite_key: { value: `CASE-${n}` }, search_synonyms: true },
      ]),
    },
  )
  const r = (lookup.results ?? [])[0]
  if (!r || r.status !== 'found' || !r.entry_id) return null
  const doc = await wipFetchJson<{ data?: { title?: string } }>(
    `/api/document-store/documents/${r.entry_id}?namespace=${CORPUS_NS}`,
  )
  return { id: r.entry_id, title: doc.data?.title ?? '' }
}

/**
 * Add a relationship from this doc to another case — increment 1 of the KB UI
 * write path (CASE-484). Pure selection: pick an edge type from the curated list
 * and a target case number; the edge is written through the gateway `/edges`
 * verb (idempotent). No freeform text, no lifecycle change. Corpus-only, since
 * cross-namespace edges are unsupported (CASE-538), matching the flag affordance.
 * @param sourceDocId - the doc being linked FROM (fixed to the current view).
 */
export function RelationshipPicker({ sourceDocId }: { sourceDocId: string }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [edgeType, setEdgeType] = useState<(typeof EDGE_TYPES)[number]['value']>('REFERENCES')
  const [num, setNum] = useState('')
  const [debounced, setDebounced] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(num), 500)
    return () => clearTimeout(t)
  }, [num])

  const preview = useQuery<CasePreview | null>({
    queryKey: ['rel-target', debounced],
    queryFn: () => resolveCase(debounced),
    enabled: open && debounced.length > 0,
    staleTime: 30_000,
    retry: false,
  })

  const target = debounced === num.trim() && num.trim().length > 0 ? preview.data : undefined
  const isSelf = !!target && target.id === sourceDocId

  async function submit() {
    if (!target || isSelf) return
    setSubmitting(true)
    setError(null)
    try {
      await addEdge(edgeType, sourceDocId, `CASE-${num.trim()}`)
      qc.invalidateQueries({ queryKey: ['relationships', sourceDocId] })
      qc.invalidateQueries({ queryKey: wipKeys.documents.relationships(sourceDocId) })
      setDone(true)
      setNum('')
      setDebounced('')
      setTimeout(() => setDone(false), 2500)
      setOpen(false)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-primary/20 bg-primary/5 px-3 py-1 text-xs font-medium text-primary hover:bg-primary/10 focus:outline-none focus:ring-2 focus:ring-primary/40"
      >
        {done ? 'Linked ✓' : '+ Add relationship'}
      </button>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-primary/20 bg-primary/5 px-3 py-2">
      <span className="text-xs text-text-muted">This doc</span>
      <select
        value={edgeType}
        onChange={(e) => setEdgeType(e.target.value as (typeof EDGE_TYPES)[number]['value'])}
        className="rounded border border-gray-300 bg-surface px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-primary/40"
      >
        {EDGE_TYPES.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>
      <div className="flex items-center gap-1 rounded border border-gray-300 bg-surface px-2 py-1">
        <span className="text-xs text-text-muted">CASE-</span>
        <input
          autoFocus
          type="text"
          inputMode="numeric"
          value={num}
          onChange={(e) => setNum(e.target.value.replace(/\D/g, '').slice(0, 5))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') setOpen(false)
          }}
          placeholder="#"
          aria-label="Target case number"
          className="w-16 bg-transparent text-xs text-text placeholder:text-text-muted focus:outline-none"
        />
      </div>
      <button
        type="button"
        onClick={submit}
        disabled={submitting || !target || isSelf}
        className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-white hover:bg-primary-light focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? 'Linking…' : 'Add'}
      </button>
      <button
        type="button"
        onClick={() => { setOpen(false); setError(null) }}
        className="rounded-md px-2 py-1 text-xs text-text-muted hover:bg-background focus:outline-none focus:ring-2 focus:ring-primary/40"
      >
        Cancel
      </button>
      <span className="w-full text-xs">
        {isSelf ? (
          <span className="text-danger">A doc can't link to itself.</span>
        ) : target ? (
          <span className="text-text-muted">→ CASE-{num.trim()} · {target.title || '(untitled)'}</span>
        ) : debounced && debounced === num.trim() && !preview.isLoading ? (
          <span className="text-danger">no case {debounced}</span>
        ) : error ? (
          <span className="text-danger">{error}</span>
        ) : (
          <span className="text-text-muted">Pick an edge type and a target case.</span>
        )}
      </span>
    </div>
  )
}
