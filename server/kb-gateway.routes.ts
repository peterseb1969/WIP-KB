// KB write-gateway (CASE-464 Phase 1): domain write verbs for cases.
// "No script writes directly to WIP — it goes through the app that owns the
// domain" (Peter, 2026-06-03/12; spec: FR-YAC/papers/kb-write-gateway-design.md).
//
//   POST {BASE_PATH}/server-api/kb/cases                 -> allocate + create (file flow)
//   POST {BASE_PATH}/server-api/kb/cases/:n/respond      -> append Response,  open -> responded
//   POST {BASE_PATH}/server-api/kb/cases/:n/comment      -> append Comment,   no transition
//   POST {BASE_PATH}/server-api/kb/cases/:n/close        -> append Resolution, -> closed
//   POST {BASE_PATH}/server-api/kb/cases/:n/implement    -> append Implementation, -> implemented
//
// Design rules (the case response is the contract):
// - UN-PRIVILEGED: every WIP call executes with the CALLER's X-API-Key. The
//   gateway adds domain semantics, never privilege; authz stays platform-side.
// - Thin-wrapper discipline: every endpoint = orchestrate N existing WIP calls
//   + enforce one domain rule. No state lives here.
// - Append semantics via the platform's if_match optimistic concurrency: a
//   comment/response POST re-reads and retries on concurrency_conflict, so two
//   agents writing the same case both land (the CASE-462 race class).
// - Server-side status machine: illegal transitions are 422, not discipline.
// - Mounted PUBLIC (before requireAuth) like kb-client.routes; the gateway
//   browser-auth exemption is the manifest route line (CASE-439 pattern).
import { Router, type Request, type Response } from 'express'

const WIP_BASE = (process.env.WIP_BASE_URL || 'https://wip-kb.local').replace(/\/$/, '')
const NS_DEFAULT = 'kb' // namespace discipline; ?namespace= override exists for test harnesses
const ALLOC_MAX_RETRIES = 100
const PATCH_MAX_RETRIES = 3

// verb -> { section heading, target status (null = no transition) }
const VERBS: Record<string, { heading: string; to: string | null }> = {
  respond: { heading: 'Response', to: 'responded' },
  comment: { heading: 'Comment', to: null },
  close: { heading: 'Resolution', to: 'closed' },
  implement: { heading: 'Implementation', to: 'implemented' },
}
// status machine: which target statuses are legal from a given current status
const TRANSITIONS: Record<string, string[]> = {
  open: ['responded', 'closed', 'implemented'],
  responded: ['closed', 'implemented'],
  closed: [],
  implemented: [],
}

type AnyObj = Record<string, any>

class WipError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

async function wipReq(method: string, path: string, key: string, body?: unknown): Promise<AnyObj> {
  const resp = await fetch(`${WIP_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await resp.text()
  let data: AnyObj
  try { data = JSON.parse(text) } catch { data = { raw: text } }
  if (!resp.ok) throw new WipError(resp.status, `WIP ${method} ${path} -> ${resp.status}: ${text.slice(0, 300)}`)
  return data
}

// template_id cache — template_id is stable across versions (PoNIF #2 corollary)
const tplCache = new Map<string, string>()
async function templateId(value: string, ns: string, key: string): Promise<string> {
  const ck = `${ns}/${value}`
  const hit = tplCache.get(ck)
  if (hit) return hit
  const t = await wipReq('GET', `/api/template-store/templates/by-value/${value}?namespace=${ns}`, key)
  const id = t.id || t.template_id
  if (!id) throw new WipError(502, `template ${value} has no id in ${ns}`)
  tplCache.set(ck, id)
  return id
}

// CASE-<n> Registry synonym -> document_id (the v2 resolution handle, CASE-425)
async function resolveCase(n: number, ns: string, key: string): Promise<string | null> {
  const d = await wipReq('POST', '/api/registry/entries/lookup/by-key', key, [{
    namespace: ns, entity_type: 'documents',
    composite_key: { value: `CASE-${n}` }, search_synonyms: true,
  }])
  const r = (d.results || [])[0] || {}
  return r.status === 'found' ? r.entry_id : null
}

async function getDoc(id: string, ns: string, key: string): Promise<AnyObj> {
  return wipReq('GET', `/api/document-store/documents/${id}?namespace=${ns}`, key)
}

// best-effort seed; the atomic synonym claim is the correctness guard
async function maxCaseNumber(ns: string, key: string): Promise<number> {
  let mx = 0, page = 1
  for (;;) {
    const d = await wipReq('POST', `/api/document-store/documents/query?namespace=${ns}`, key,
      { template_id: 'CASE_RECORD', filters: [], page, page_size: 100 })
    const items: AnyObj[] = d.items || []
    for (const it of items) {
      const n = it.data?.case_number
      if (typeof n === 'number' && n > mx) mx = n
    }
    if (page >= (d.pages || 1) || items.length === 0) break
    page += 1
  }
  return mx
}

// derive REFERENCES edges from related CASE-<n> mentions (unresolved -> skipped,
// same contract as the loaders; re-runs dedup via the edge's identity fields)
async function deriveReferences(sourceId: string, related: string[], ns: string, key: string): Promise<number> {
  const targets: string[] = []
  for (const m of related) {
    const num = /CASE-?(\d+)/i.exec(m)?.[1]
    if (!num) continue
    const tid = await resolveCase(parseInt(num, 10), ns, key)
    if (tid && tid !== sourceId && !targets.includes(tid)) targets.push(tid)
  }
  if (targets.length === 0) return 0
  const refTpl = await templateId('REFERENCES', ns, key)
  const edges = targets.map((t) => ({
    template_id: refTpl, namespace: ns, created_by: 'kb-gateway',
    data: { source_ref: sourceId, target_ref: t },
    metadata: { edge_kind: 'REFERENCES', loader: 'kb-gateway' },
  }))
  const d = await wipReq('POST', '/api/document-store/documents', key, edges)
  return (d.results || []).filter((r: AnyObj) => ['created', 'updated', 'skipped', 'unchanged'].includes(r.status)).length
}

function parseRelated(rel: unknown): string[] {
  if (Array.isArray(rel)) return rel.map(String)
  if (typeof rel === 'string') return rel.split(/[,\s]+/).filter(Boolean)
  return []
}

function nowStamp(): string {
  const d = new Date()
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// rewrite the `status:` line inside the body's YAML frontmatter so the stored
// flat-file text and data.status cannot diverge (the CASE-462 drift class)
function rewriteFrontmatterStatus(body: string, to: string): string {
  const m = /^---\n([\s\S]*?)\n---/.exec(body)
  if (!m || m[1] === undefined) return body
  const inner = m[1]
  const fm = inner.replace(/^status:.*$/m, `status: ${to}`)
  return body.slice(0, 4) + fm + body.slice(4 + inner.length)
}

const router = Router()

function callerKey(req: Request, res: Response): string | null {
  const key = (req.header('x-api-key') || '').trim()
  if (!key) {
    res.status(401).json({ error: 'X-API-Key required — the gateway executes WIP calls with the caller\'s key' })
    return null
  }
  return key
}

// POST /cases — file flow: allocate-then-create on the atomic synonym claim
router.post('/cases', async (req, res) => {
  const key = callerKey(req, res)
  if (!key) return
  const ns = String(req.query.namespace || NS_DEFAULT)
  const b: AnyObj = req.body || {}
  if (!b.title || !b.filed_by) {
    res.status(422).json({ error: 'title and filed_by are required' })
    return
  }
  try {
    const tid = await templateId('CASE_RECORD', ns, key)
    const data = {
      title: String(b.title), body: String(b.body || ''),
      authored_by: String(b.filed_by), doc_status: 'published',
      tags: ['case-mirror', 'status-open'], root: true,
      source_yac: String(b.filed_by), target_yac: String(b.target_yac || 'any'),
      status: 'open', severity: String(b.severity || ''), type: String(b.type || ''),
      component: String(b.component || ''), filed_by: String(b.filed_by),
      app: String(b.app || ''),
    }
    let n = (await maxCaseNumber(ns, key)) + 1
    for (let i = 0; i < ALLOC_MAX_RETRIES; i++) {
      const d = await wipReq('POST', '/api/document-store/documents', key, [{
        template_id: tid, namespace: ns, created_by: 'kb-gateway',
        data: { ...data, case_number: n },
        synonyms: [{ value: `CASE-${n}` }],
      }])
      const r = (d.results || [])[0] || {}
      if (r.status === 'created' || r.status === 'updated') {
        const edges = await deriveReferences(r.document_id, parseRelated(b.related), ns, key)
        res.status(201).json({ case: n, synonym: `CASE-${n}`, document_id: r.document_id, edges })
        return
      }
      if (r.error_code === 'synonym_conflict' || /different entry/.test(r.error || '')) {
        n += 1 // concurrent filer claimed CASE-n — advance and retry
        continue
      }
      res.status(502).json({ error: `allocate failed at CASE-${n}: ${r.error || JSON.stringify(r)}` })
      return
    }
    res.status(503).json({ error: `allocation exhausted ${ALLOC_MAX_RETRIES} retries` })
  } catch (e) {
    const s = e instanceof WipError ? 502 : 500
    res.status(s).json({ error: (e as Error).message })
  }
})

// POST /cases/:n/<verb> — append a section, apply the status machine.
// Optimistic concurrency: read -> append -> PATCH with if_match; retry on
// concurrency_conflict so concurrent writers both land.
router.post('/cases/:n/:verb', async (req, res) => {
  const key = callerKey(req, res)
  if (!key) return
  const verb = VERBS[req.params.verb]
  if (!verb) {
    res.status(404).json({ error: `unknown verb '${req.params.verb}' (respond|comment|close|implement)` })
    return
  }
  const n = parseInt(req.params.n, 10)
  if (!Number.isFinite(n)) {
    res.status(422).json({ error: 'case number must be an integer' })
    return
  }
  const ns = String(req.query.namespace || NS_DEFAULT)
  const b: AnyObj = req.body || {}
  if (!b.text || !b.author) {
    res.status(422).json({ error: 'text and author are required' })
    return
  }
  try {
    const docId = await resolveCase(n, ns, key)
    if (!docId) {
      res.status(404).json({ error: `CASE-${n} not found in ${ns}` })
      return
    }
    for (let attempt = 0; attempt < PATCH_MAX_RETRIES; attempt++) {
      const doc = await getDoc(docId, ns, key)
      const data: AnyObj = doc.data || {}
      const current = String(data.status || 'open')
      if (verb.to) {
        const legal = TRANSITIONS[current] ?? []
        if (!legal.includes(verb.to)) {
          res.status(422).json({
            error: `illegal transition: ${current} -> ${verb.to} for CASE-${n}`,
            legal_transitions: legal,
          })
          return
        }
      }
      const section = `\n## ${verb.heading} — ${b.author} (${nowStamp()})\n\n${String(b.text).trim()}\n`
      let newBody = String(data.body || '') + section
      const patch: AnyObj = { body: newBody }
      if (verb.to) {
        newBody = rewriteFrontmatterStatus(newBody, verb.to)
        patch.body = newBody
        patch.status = verb.to
        patch.tags = [...(data.tags || []).filter((t: string) => !t.startsWith('status-')), `status-${verb.to}`]
      }
      const d = await wipReq('PATCH', `/api/document-store/documents?namespace=${ns}`, key,
        [{ document_id: docId, patch, if_match: doc.version }])
      const r = (d.results || [])[0] || {}
      if (r.status === 'updated' || r.status === 'unchanged') {
        res.json({ case: n, document_id: docId, status: verb.to || current, doc_version: (doc.version || 0) + 1 })
        return
      }
      if (r.error_code === 'concurrency_conflict') continue // raced — re-read and retry
      res.status(502).json({ error: `patch failed: ${r.error || JSON.stringify(r)}` })
      return
    }
    res.status(409).json({ error: `CASE-${n}: still conflicting after ${PATCH_MAX_RETRIES} retries` })
  } catch (e) {
    const s = e instanceof WipError ? 502 : 500
    res.status(s).json({ error: (e as Error).message })
  }
})

export default router
