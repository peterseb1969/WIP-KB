import { useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CORPUS_NS } from '../lib/namespaces'

// Admin-only vocabulary curation (CASE-828): add a term, or an alias to a term, in
// the allowlisted KB vocabularies of the domain being viewed, and see how the live
// terms differ from the seed files that bootstrap new domains. All writes go through
// the server's /server-api/vocab route, which merges aliases server-side.
const VOCAB_API = `${import.meta.env.BASE_URL}server-api/vocab`

interface Term {
  term_id: string
  value: string
  label: string
  description: string | null
  sort_order: number
  aliases: string[]
  status: string
}

type Drift =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | { value: string; kind: 'not_in_seed'; seed_entry: Record<string, any> }
  | { value: string; kind: 'not_live' }
  | { value: string; kind: 'differs'; fields: Array<{ field: string; seed: unknown; live: unknown }> }

interface Vocabulary {
  terminology: string
  terms?: Term[]
  seed_file?: string
  seed_drift?: Drift[] | null
  error?: string
}

async function vocabPost(path: string, body: unknown): Promise<{ status?: string; reason?: string }> {
  const res = await fetch(`${VOCAB_API}${path}?namespace=${encodeURIComponent(CORPUS_NS)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error || `${res.status} ${res.statusText}`)
  return json
}

function show(v: unknown): string {
  if (Array.isArray(v)) return v.length ? v.join(', ') : '(none)'
  if (v === null || v === undefined || v === '') return '(none)'
  return String(v)
}

function AliasInput({ terminology, term, onDone }: { terminology: string; term: Term; onDone: (msg: string, ok: boolean) => void }) {
  const [alias, setAlias] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!alias.trim()) return
    setBusy(true)
    try {
      const r = await vocabPost(`/${terminology}/terms/${term.term_id}/aliases`, { alias: alias.trim() })
      onDone(r.status === 'unchanged' ? r.reason || 'Nothing to add.' : `Added '${alias.trim()}' to ${term.value}.`, true)
      setAlias('')
    } catch (err) {
      onDone((err as Error).message, false)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit} className="flex items-center gap-1">
      <input
        value={alias}
        onChange={(e) => setAlias(e.target.value)}
        placeholder="add alias"
        aria-label={`Add alias to ${term.value}`}
        className="w-28 rounded border border-gray-300 px-1.5 py-0.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/40"
      />
      <button
        type="submit"
        disabled={busy || !alias.trim()}
        className="rounded border border-gray-300 px-1.5 py-0.5 text-xs text-text-muted hover:bg-background disabled:opacity-40"
      >
        Add
      </button>
    </form>
  )
}

function AddTermForm({ terminology, onDone }: { terminology: string; onDone: (msg: string, ok: boolean) => void }) {
  const [value, setValue] = useState('')
  const [label, setLabel] = useState('')
  const [description, setDescription] = useState('')
  const [sortOrder, setSortOrder] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      await vocabPost(`/${terminology}/terms`, { value: value.trim(), label, description, sort_order: sortOrder })
      onDone(`Added ${value.trim()} to ${terminology}.`, true)
      setValue('')
      setLabel('')
      setDescription('')
      setSortOrder('')
    } catch (err) {
      onDone((err as Error).message, false)
    } finally {
      setBusy(false)
    }
  }
  const field = 'rounded-md border border-gray-300 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40'
  return (
    <form onSubmit={submit} className="mt-3 flex flex-wrap items-center gap-2">
      <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="value" aria-label="Value" className={`${field} w-36`} />
      <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="label (optional)" aria-label="Label" className={`${field} w-36`} />
      <input
        value={sortOrder}
        onChange={(e) => setSortOrder(e.target.value)}
        placeholder="sort"
        inputMode="numeric"
        aria-label="Sort order"
        className={`${field} w-16`}
      />
      <input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="description (optional)"
        aria-label="Description"
        className={`${field} min-w-0 flex-1`}
      />
      <button
        type="submit"
        disabled={busy || !value.trim()}
        className="rounded-md bg-primary px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
      >
        Add term
      </button>
    </form>
  )
}

function DriftList({ vocab }: { vocab: Vocabulary }) {
  const drift = vocab.seed_drift
  if (drift === null || drift === undefined) {
    return <p className="mt-3 text-xs text-text-muted">No seed file found to compare with.</p>
  }
  if (drift.length === 0) {
    return <p className="mt-3 text-xs text-text-muted">Matches {vocab.seed_file}.</p>
  }
  return (
    <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
      <p className="font-medium">
        Differs from {vocab.seed_file} — new domains and fresh bootstraps get the seed, not these terms.
        Update the seed file in the repository to keep them.
      </p>
      <ul className="mt-2 space-y-1.5">
        {drift.map((d) => (
          <li key={`${d.kind}:${d.value}`}>
            <span className="font-mono">{d.value}</span>
            {d.kind === 'not_live' && ' — in the seed, not in this domain.'}
            {d.kind === 'differs' && (
              <span>
                {' — '}
                {d.fields.map((f) => `${f.field}: seed ${show(f.seed)} · live ${show(f.live)}`).join('; ')}
              </span>
            )}
            {d.kind === 'not_in_seed' && (
              <>
                {' — not in the seed. Entry to add:'}
                <pre className="mt-1 overflow-x-auto rounded bg-white/70 px-2 py-1 font-mono text-[11px] text-text">
                  {JSON.stringify(d.seed_entry)}
                </pre>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The Vocabulary section of the Settings page. Renders nothing for a non-admin. */
export function VocabularySettings() {
  const qc = useQueryClient()
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const q = useQuery<{ namespace: string; vocabularies: Vocabulary[] } | null>({
    queryKey: ['vocab', CORPUS_NS],
    queryFn: async () => {
      const res = await fetch(`${VOCAB_API}?namespace=${encodeURIComponent(CORPUS_NS)}`)
      if (res.status === 403) return null
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `${res.status} ${res.statusText}`)
      return json
    },
  })
  const done = (text: string, ok: boolean) => {
    setMsg({ text, ok })
    if (ok) qc.invalidateQueries({ queryKey: ['vocab', CORPUS_NS] })
  }

  if (q.data === null) return null
  return (
    <section className="mt-6 rounded-lg border border-gray-200 bg-surface p-5">
      <h2 className="font-medium">Vocabulary</h2>
      <p className="mt-1 text-sm text-text/70">
        Add a project (KB_APP) or a session role (SESSION_ROLE) in the <span className="font-mono">{CORPUS_NS}</span>{' '}
        knowledge base, or another spelling that should resolve to an existing one. Adding only — renaming and
        retiring terms stay in the WIP Console.
      </p>
      {msg && <p className={`mt-3 text-sm ${msg.ok ? 'text-green-700' : 'text-red-700'}`}>{msg.text}</p>}
      {q.isLoading && <p className="mt-4 text-sm text-text-muted">Loading…</p>}
      {q.error && <p className="mt-4 text-sm text-danger">{(q.error as Error).message}</p>}
      {q.data?.vocabularies.map((v) => (
        <div key={v.terminology} className="mt-6">
          <h3 className="font-mono text-sm font-semibold">{v.terminology}</h3>
          {v.error ? (
            <p className="mt-2 text-sm text-danger">{v.error}</p>
          ) : (
            <>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-text-muted">
                      <th className="py-1 pr-3 font-normal">Value</th>
                      <th className="py-1 pr-3 font-normal">Also resolves</th>
                      <th className="py-1 pr-3 font-normal">Sort</th>
                      <th className="py-1 font-normal" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {v.terms?.map((t) => (
                      <tr key={t.term_id} className={t.status !== 'active' ? 'opacity-50' : ''}>
                        <td className="py-1.5 pr-3 align-top">
                          <span className="font-mono">{t.value}</span>
                          {t.label !== t.value && <span className="text-text-muted"> · {t.label}</span>}
                          {t.description && <div className="text-xs text-text-muted">{t.description}</div>}
                        </td>
                        <td className="py-1.5 pr-3 align-top">
                          <div className="flex flex-wrap gap-1">
                            {t.aliases.map((a) => (
                              <span key={a} className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-text-muted">
                                {a}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="py-1.5 pr-3 align-top tabular-nums text-text-muted">{t.sort_order}</td>
                        <td className="py-1.5 align-top">
                          {t.status === 'active' ? (
                            <AliasInput terminology={v.terminology} term={t} onDone={done} />
                          ) : (
                            <span className="text-xs text-text-muted">{t.status}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <AddTermForm terminology={v.terminology} onDone={done} />
              <DriftList vocab={v} />
            </>
          )}
        </div>
      ))}
    </section>
  )
}
