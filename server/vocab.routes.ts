/**
 * Vocabulary curation (CASE-828) — add a term, or an alias to a term, in one of the
 * KB's own controlled vocabularies, from the app's Settings page.
 *
 * Deliberately small: not a terminology manager (that is the WIP Console's job).
 * - Admin-only — gated by requireAdmin() at the mount in index.ts.
 * - An allowlist of vocabularies. KB_APP (a project is a KB_APP term) and
 *   SESSION_ROLE (each app YAC needs one) are flat lists where a new value is all
 *   that is needed. KB_TOPIC is not here: a topic needs a parent and a relation
 *   type, and the taxonomy is deprecate-don't-delete.
 * - Add-only. No rename, no deprecate, no delete.
 * - Scoped to one knowledge domain per request (?namespace=), because every domain
 *   carries its own copy of these vocabularies.
 * - Alias additions are merged here, server-side: WIP's term update REPLACES the
 *   alias list, so a browser that sent only the new alias would erase the others.
 *
 * It also reports seed drift: how the live vocabulary differs from
 * server/seed/terminologies/<T>.json, which is what bootstraps and new domains are
 * seeded from. A term added here is missing from every domain created afterwards
 * until the seed file is updated, so the difference is shown where it is made.
 */
import { Router, type Request, type Response } from 'express'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SEED_TERMINOLOGIES = join(__dirname, 'seed', 'terminologies')
const WIP_BASE = (process.env.WIP_BASE_URL || 'https://wip-kb.local').replace(/\/$/, '')
const NS_DEFAULT = process.env.WIP_NAMESPACE || 'kb'

export const EDITABLE_VOCABULARIES = ['KB_APP', 'SESSION_ROLE'] as const

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

interface TermView {
  term_id: string
  value: string
  label: string
  description: string | null
  sort_order: number
  aliases: string[]
  status: string
}

interface SeedTerm {
  value: string
  label: string
  description: string | null
  sort_order: number
  aliases: string[]
}

type Drift =
  | { value: string; kind: 'not_in_seed'; seed_entry: AnyObj }
  | { value: string; kind: 'not_live' }
  | { value: string; kind: 'differs'; fields: Array<{ field: string; seed: unknown; live: unknown }> }

function nsOf(req: Request): string {
  const ns = String(req.query.namespace || NS_DEFAULT)
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(ns)) throw new HttpError(400, `invalid namespace '${ns}'`)
  return ns
}

function vocabOf(req: Request): string {
  const t = String(req.params.terminology)
  if (!(EDITABLE_VOCABULARIES as readonly string[]).includes(t)) {
    throw new HttpError(403, `${t} is not editable here; editable: ${EDITABLE_VOCABULARIES.join(', ')}`)
  }
  return t
}

function toView(t: AnyObj): TermView {
  return {
    term_id: t.term_id,
    value: t.value,
    label: t.label ?? t.value,
    description: t.description ?? null,
    sort_order: t.sort_order ?? 0,
    aliases: Array.isArray(t.aliases) ? t.aliases : [],
    status: t.status ?? 'active',
  }
}

function readSeed(terminology: string): SeedTerm[] | null {
  try {
    const raw = JSON.parse(readFileSync(join(SEED_TERMINOLOGIES, `${terminology}.json`), 'utf-8'))
    return (raw.terms ?? []).map((t: AnyObj) => ({
      value: t.value,
      label: t.label ?? t.value,
      description: t.description ?? null,
      sort_order: t.sort_order ?? 0,
      aliases: Array.isArray(t.aliases) ? t.aliases : [],
    }))
  } catch {
    return null
  }
}

// The entry a seed file would need for a term it lacks, in the seed's own shape.
function seedEntry(t: TermView): AnyObj {
  const e: AnyObj = { value: t.value, label: t.label, sort_order: t.sort_order }
  if (t.aliases.length) e.aliases = t.aliases
  if (t.description) e.description = t.description
  return e
}

function resolvedAliases(value: string, aliases: string[]): string[] {
  const own = value.toLowerCase()
  return [...new Set(aliases.map((a) => a.toLowerCase()))].filter((a) => a !== own).sort()
}

function seedDrift(live: TermView[], seed: SeedTerm[]): Drift[] {
  const out: Drift[] = []
  const seedBy = new Map(seed.map((s) => [s.value, s]))
  const liveBy = new Map(live.map((t) => [t.value, t]))
  for (const t of live) {
    if (t.status !== 'active') continue
    const s = seedBy.get(t.value)
    if (!s) {
      out.push({ value: t.value, kind: 'not_in_seed', seed_entry: seedEntry(t) })
      continue
    }
    const fields: Array<{ field: string; seed: unknown; live: unknown }> = []
    if (s.label !== t.label) fields.push({ field: 'label', seed: s.label, live: t.label })
    if ((s.description ?? null) !== (t.description ?? null)) {
      fields.push({ field: 'description', seed: s.description, live: t.description })
    }
    if (s.sort_order !== t.sort_order) fields.push({ field: 'sort_order', seed: s.sort_order, live: t.sort_order })
    // Compared as the spellings each side RESOLVES, not as literal lists: WIP
    // matches case-insensitively and drops an alias that only re-cases the value or
    // another alias, while older seed entries still list such variants.
    const sa = resolvedAliases(t.value, s.aliases)
    const la = resolvedAliases(t.value, t.aliases)
    if (sa.join('\u0000') !== la.join('\u0000')) {
      fields.push({ field: 'aliases', seed: [...s.aliases].sort(), live: [...t.aliases].sort() })
    }
    if (fields.length) out.push({ value: t.value, kind: 'differs', fields })
  }
  for (const s of seed) {
    if (!liveBy.has(s.value)) out.push({ value: s.value, kind: 'not_live' })
  }
  return out
}

export default function vocabRoutes(wipKey: string): Router {
  const router = Router()

  async function wip(method: string, path: string, body?: unknown): Promise<AnyObj> {
    const res = await fetch(`${WIP_BASE}${path}`, {
      method,
      headers: { 'X-API-Key': wipKey, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let json: AnyObj = {}
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      json = { detail: text }
    }
    if (!res.ok) {
      const detail = typeof json.detail === 'string' ? json.detail : JSON.stringify(json.detail ?? json)
      throw new HttpError(res.status === 404 ? 404 : 502, `WIP ${method} ${path.split('?')[0]}: ${res.status} ${detail}`)
    }
    return json
  }

  // A bulk write answers 200 even when its one item failed; the item says so.
  function firstResult(r: AnyObj): AnyObj {
    const item = (r.results ?? [])[0] ?? {}
    if (item.status === 'error') {
      const code = item.error_code ? ` (${item.error_code})` : ''
      throw new HttpError(409, `${item.error ?? 'rejected'}${code}`)
    }
    return item
  }

  async function terminologyId(terminology: string, ns: string): Promise<string> {
    const t = await wip('GET', `/api/def-store/terminologies/by-value/${terminology}?namespace=${encodeURIComponent(ns)}`)
    return t.terminology_id
  }

  async function liveTerms(terminology: string, ns: string): Promise<{ terminology_id: string; terms: TermView[] }> {
    const tid = await terminologyId(terminology, ns)
    const r = await wip('GET', `/api/def-store/terminologies/${tid}/terms?page_size=1000&namespace=${encodeURIComponent(ns)}`)
    const terms = ((r.items ?? []) as AnyObj[]).map(toView)
    terms.sort((a, b) => a.sort_order - b.sort_order || a.value.localeCompare(b.value))
    return { terminology_id: tid, terms }
  }

  function fail(res: Response, e: unknown): void {
    const status = e instanceof HttpError ? e.status : 500
    res.status(status).json({ error: (e as Error).message })
  }

  // GET /vocab?namespace= — every editable vocabulary in the domain, with seed drift.
  router.get('/', async (req, res) => {
    try {
      const ns = nsOf(req)
      const vocabularies = await Promise.all(
        EDITABLE_VOCABULARIES.map(async (terminology) => {
          try {
            const { terminology_id, terms } = await liveTerms(terminology, ns)
            const seed = readSeed(terminology)
            return {
              terminology,
              terminology_id,
              terms,
              seed_file: `server/seed/terminologies/${terminology}.json`,
              seed_drift: seed ? seedDrift(terms, seed) : null,
            }
          } catch (e) {
            return { terminology, error: (e as Error).message }
          }
        }),
      )
      res.json({ namespace: ns, vocabularies })
    } catch (e) {
      fail(res, e)
    }
  })

  // POST /vocab/:terminology/terms?namespace= {value, label?, description?, sort_order?}
  router.post('/:terminology/terms', async (req, res) => {
    try {
      const ns = nsOf(req)
      const terminology = vocabOf(req)
      const b = req.body ?? {}
      const value = typeof b.value === 'string' ? b.value.trim() : ''
      if (!value) throw new HttpError(400, 'value is required')
      const item: AnyObj = { value }
      if (typeof b.label === 'string' && b.label.trim()) item.label = b.label.trim()
      if (typeof b.description === 'string' && b.description.trim()) item.description = b.description.trim()
      if (b.sort_order !== undefined && b.sort_order !== null && b.sort_order !== '') {
        const n = Number(b.sort_order)
        if (!Number.isInteger(n)) throw new HttpError(400, 'sort_order must be an integer')
        item.sort_order = n
      }
      const tid = await terminologyId(terminology, ns)
      const r = await wip('POST', `/api/def-store/terminologies/${tid}/terms?namespace=${encodeURIComponent(ns)}`, [item])
      const result = firstResult(r)
      const { terms } = await liveTerms(terminology, ns)
      const created = terms.find((t) => t.value === value) ?? null
      res.status(201).json({ namespace: ns, terminology, status: result.status ?? 'created', term: created })
    } catch (e) {
      fail(res, e)
    }
  })

  // POST /vocab/:terminology/terms/:termId/aliases?namespace= {alias}
  router.post('/:terminology/terms/:termId/aliases', async (req, res) => {
    try {
      const ns = nsOf(req)
      const terminology = vocabOf(req)
      const alias = typeof req.body?.alias === 'string' ? req.body.alias.trim() : ''
      if (!alias) throw new HttpError(400, 'alias is required')
      const { terms } = await liveTerms(terminology, ns)
      // Looked up within the allowlisted vocabulary, so a term id from any other
      // terminology is refused rather than edited.
      const term = terms.find((t) => t.term_id === String(req.params.termId))
      if (!term) throw new HttpError(404, `no term ${String(req.params.termId)} in ${terminology} (${ns})`)
      if (term.status !== 'active') throw new HttpError(409, `${term.value} is ${term.status}; aliases are added to active terms only`)
      // WIP rejects a name equal to the term's own value or one it already has, and
      // matches values case-insensitively anyway — so either is a no-op, not an error.
      const lower = alias.toLowerCase()
      if (term.value.toLowerCase() === lower || term.aliases.some((a) => a.toLowerCase() === lower)) {
        res.json({ namespace: ns, terminology, status: 'unchanged', reason: `'${alias}' already resolves to ${term.value}`, term })
        return
      }
      // Another term already answering to this spelling would make it ambiguous.
      const clash = terms.find(
        (t) => t.term_id !== term.term_id && (t.value.toLowerCase() === lower || t.aliases.some((a) => a.toLowerCase() === lower)),
      )
      if (clash) throw new HttpError(409, `'${alias}' already resolves to ${clash.value}`)
      const r = await wip('PUT', `/api/def-store/terms?namespace=${encodeURIComponent(ns)}`, [
        { term_id: term.term_id, aliases: [...term.aliases, alias] },
      ])
      const result = firstResult(r)
      const after = (await liveTerms(terminology, ns)).terms.find((t) => t.term_id === term.term_id) ?? null
      res.json({ namespace: ns, terminology, status: result.status ?? 'updated', term: after })
    } catch (e) {
      fail(res, e)
    }
  })

  return router
}
