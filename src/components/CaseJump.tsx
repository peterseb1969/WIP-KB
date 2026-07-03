import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { wipFetchJson } from '../lib/wipBulk'
import { CORPUS_NS } from '../lib/namespaces'

interface CaseHit {
  document_id: string
  title: string
  case: number
}

/**
 * Resolve a bare case number → { document_id, title } through the `/wip/*` proxy
 * (the browser's key-injecting path — the `/server-api/kb/*` gateway is CLI-only
 * and requires an X-API-Key). Two steps: the Registry resolves the `CASE-<n>`
 * synonym to a document_id, then a doc read supplies the title. Returns null when
 * the case doesn't exist (`status: not_found`); throws only on transport/5xx.
 */
async function fetchCase(n: string): Promise<CaseHit | null> {
  const lookup = await wipFetchJson<{ results?: Array<{ status?: string; entry_id?: string }> }>(
    '/api/registry/entries/lookup/by-key',
    {
      method: 'POST',
      body: JSON.stringify([
        {
          namespace: CORPUS_NS,
          entity_type: 'documents',
          composite_key: { value: `CASE-${n}` },
          search_synonyms: true,
        },
      ]),
    },
  )
  const r = (lookup.results ?? [])[0]
  if (!r || r.status !== 'found' || !r.entry_id) return null
  const doc = await wipFetchJson<{ data?: { title?: string } }>(
    `/api/document-store/documents/${r.entry_id}?namespace=${CORPUS_NS}`,
  )
  return { document_id: r.entry_id, title: doc.data?.title ?? '', case: Number(n) }
}

/**
 * Sidebar quick "jump to case" box. Digits-only input; after a 700ms pause it
 * previews the resolved `CASE-<n> · <title>` (or "no case <n>"); pressing Enter
 * navigates straight to that case's DocPage. Read-only navigation — no writes.
 */
export function CaseJump() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState('')
  const [debounced, setDebounced] = useState('')

  // 700ms debounce drives the title preview only; the jump is Enter-triggered.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), 700)
    return () => clearTimeout(t)
  }, [value])

  // Global "c" shortcut → focus the jump box (so `c544⏎` jumps from anywhere).
  // GUARDED: ignore the key when the user is typing in any editable element
  // (input/textarea/select/contenteditable) or holding a modifier (so Ctrl/⌘-C
  // copy still works), and preventDefault so the "c" doesn't land in the box.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== 'c' || e.metaKey || e.ctrlKey || e.altKey) return
      const el = e.target as HTMLElement | null
      const tag = el?.tagName
      if (el?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      e.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const preview = useQuery<CaseHit | null>({
    queryKey: ['case-jump', debounced],
    queryFn: () => fetchCase(debounced),
    enabled: debounced.length > 0,
    staleTime: 30_000,
    retry: false,
  })

  async function jump(e: FormEvent) {
    e.preventDefault()
    const n = value.trim()
    if (!n) return
    // Reuse the debounced preview's cache when it matches; otherwise fetch now
    // (the user hit Enter before the 700ms preview fired).
    let hit: CaseHit | null = null
    try {
      hit = await queryClient.fetchQuery({
        queryKey: ['case-jump', n],
        queryFn: () => fetchCase(n),
        staleTime: 30_000,
        retry: false,
      })
    } catch {
      return // transport error — leave the field; the preview reflects the state
    }
    if (hit?.document_id) {
      setValue('')
      setDebounced('')
      navigate(`/doc/${hit.document_id}`)
    }
    // miss → leave the field + the "no case <n>" preview in place
  }

  // Preview line: only meaningful once the debounced value matches what's typed.
  const showPreview = debounced.length > 0 && debounced === value.trim()
  let hint: { text: string; tone: 'muted' | 'ok' | 'miss' } | null = null
  if (showPreview) {
    if (preview.isLoading) hint = { text: '…', tone: 'muted' }
    else if (preview.data) hint = { text: `CASE-${preview.data.case} · ${preview.data.title}`, tone: 'ok' }
    else if (!preview.isError) hint = { text: `no case ${debounced}`, tone: 'miss' }
  }

  return (
    <form onSubmit={jump} className="px-3 py-1">
      <div className="flex items-center gap-1.5 rounded-md border border-gray-200 bg-background px-2 py-1 focus-within:ring-2 focus-within:ring-primary/40">
        <span className="text-sm text-text-muted">#</span>
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          value={value}
          onChange={(e) => setValue(e.target.value.replace(/\D/g, '').slice(0, 5))}
          placeholder="Case #"
          aria-label="Jump to case by number (press c to focus)"
          className="w-full bg-transparent text-sm text-text placeholder:text-text-muted focus:outline-none"
        />
        {/* discoverability hint for the global "c" focus shortcut; hidden once typing */}
        {!value && (
          <kbd className="rounded border border-gray-300 bg-surface px-1 text-[10px] leading-tight text-text-muted">
            c
          </kbd>
        )}
      </div>
      {hint && (
        <p
          className={`mt-1 line-clamp-3 break-words px-1 text-xs leading-snug ${
            hint.tone === 'miss' ? 'text-danger' : 'text-text-muted'
          }`}
          // Full title on hover (capped ~100 chars) — the inline preview clamps
          // to 3 lines in the narrow sidebar; the tooltip shows the rest.
          title={
            hint.tone === 'ok'
              ? hint.text.length > 100
                ? `${hint.text.slice(0, 99)}…`
                : hint.text
              : undefined
          }
        >
          {hint.text}
        </p>
      )}
    </form>
  )
}
