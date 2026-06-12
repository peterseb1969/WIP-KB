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

// ---------------------------------------------------------------------------
// Phase 2 (CASE-464): session / journey / stats mirror verbs. All three are
// create-upserts on templates that KEEP their identity_fields (Mixed model,
// C7) — the platform's identity hash is the dedup; re-mirrors converge.

// naive ISO — WIP's datetime validator rejects any UTC offset (CASE-389)
function normalizeIsoDt(s: string): string {
  const t = (s || '').trim()
  if (!t) return t
  const m = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?)(?:[Zz]|[+-]\d{2}:?\d{2})?$/.exec(t)
  return m && m[1] ? m[1].replace(' ', 'T') : t
}

function parseFrontmatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---/.exec(text)
  const fm: Record<string, string> = {}
  if (!m || !m[1]) return fm
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':')
    if (i < 1 || line.trimStart().startsWith('#')) continue
    fm[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return fm
}

const EDITOR_BACKUP_RE = /(~|\.bak|\.swp|\.orig)$/

// POST /sessions/mirror — { session_id, files: {name: content} }
// Body composition (session.md first, siblings alphabetical, "## <name>"
// headers) is a domain convention, so it lives HERE, not in callers.
router.post('/sessions/mirror', async (req, res) => {
  const key = callerKey(req, res)
  if (!key) return
  const ns = String(req.query.namespace || NS_DEFAULT)
  const b: AnyObj = req.body || {}
  const sessionId = String(b.session_id || '')
  const files: Record<string, string> = b.files || {}
  if (!sessionId || typeof files['session.md'] !== 'string') {
    res.status(422).json({ error: 'session_id and files["session.md"] are required' })
    return
  }
  try {
    const fm = parseFrontmatter(files['session.md'])
    let role = fm.role || ''
    if (!role) role = /^([A-Z][A-Z-]+?)-\d{8}/.exec(sessionId)?.[1] || ''
    let startedAt = fm.started_at || ''
    if (!startedAt) {
      const m = /(\d{8})-(\d{4,6})$/.exec(sessionId)
      if (m && m[1] && m[2]) {
        const d = m[1], t = m[2].padEnd(6, '0')
        startedAt = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`
      }
    }
    const names = Object.keys(files).filter((n) => n.endsWith('.md') && !EDITOR_BACKUP_RE.test(n)).sort()
    const ordered = ['session.md', ...names.filter((n) => n !== 'session.md')]
    const body = ordered.map((n) => `## ${n}\n\n${files[n]}`).join('\n\n')

    const data: AnyObj = {
      session_id: sessionId, role,
      started_at: normalizeIsoDt(startedAt),
      status: fm.status || 'active',
      body,
    }
    if (fm.continues_from) data.continues_from = fm.continues_from.trim()
    if (fm.ended_at) data.ended_at = normalizeIsoDt(fm.ended_at)

    const tid = await templateId('SESSION', ns, key)
    const d = await wipReq('POST', '/api/document-store/documents', key, [{
      template_id: tid, namespace: ns, created_by: 'kb-gateway',
      data,
      metadata: { flat_file_mirror: `reports/${sessionId}/session.md`, loader: 'kb-gateway' },
    }])
    const r = (d.results || [])[0] || {}
    if (!['created', 'updated', 'unchanged', 'skipped'].includes(r.status)) { // skipped = identical re-mirror, a success for upserts
      res.status(502).json({ error: `session mirror failed: ${r.error || JSON.stringify(r)}` })
      return
    }
    // CONTINUES_FROM edge (CASE-389 §D): this session -> the prior one.
    // Prior not mirrored yet -> skipped; the next re-mirror converges.
    let edge = 'none'
    if (data.continues_from) {
      const q = await wipReq('POST', `/api/document-store/documents/query?namespace=${ns}`, key, {
        template_id: 'SESSION',
        filters: [{ field: 'data.session_id', operator: 'eq', value: data.continues_from }],
        page: 1, page_size: 1,
      })
      const prior = (q.items || [])[0]
      if (prior) {
        const cfTpl = await templateId('CONTINUES_FROM', ns, key)
        const ed = await wipReq('POST', '/api/document-store/documents', key, [{
          template_id: cfTpl, namespace: ns, created_by: 'kb-gateway',
          data: { source_ref: r.document_id, target_ref: prior.document_id },
          metadata: { edge_kind: 'CONTINUES_FROM', loader: 'kb-gateway' },
        }])
        const er = (ed.results || [])[0] || {}
        edge = ['created', 'updated', 'skipped', 'unchanged'].includes(er.status) ? er.status : `error: ${er.error}`
      } else {
        edge = 'target-not-in-kb-skipped'
      }
    }
    res.json({ session_id: sessionId, document_id: r.document_id, result: r.status, continues_from_edge: edge })
  } catch (e) {
    res.status(e instanceof WipError ? 502 : 500).json({ error: (e as Error).message })
  }
})

// POST /journeys/mirror — { filename, body } (filename carries day number,
// per the WIP_Journey_DayN[.5|_Intermezzo].md convention — CASE-309)
const DAY_ONE = Date.UTC(2026, 2, 14) // 2026-03-14
router.post('/journeys/mirror', async (req, res) => {
  const key = callerKey(req, res)
  if (!key) return
  const ns = String(req.query.namespace || NS_DEFAULT)
  const b: AnyObj = req.body || {}
  const fname = String(b.filename || '')
  const text = String(b.body || '')
  let dayNum: number | null = null
  let m = /^WIP_Journey_Day(\d+)_Intermezzo\.md$/.exec(fname)
  if (m && m[1]) dayNum = parseFloat(m[1]) + 0.5
  else {
    m = /^WIP_Journey_Day(\d+(?:\.\d+)?)\.md$/.exec(fname)
    if (m && m[1]) dayNum = parseFloat(m[1])
  }
  if (dayNum === null || !text) {
    res.status(422).json({ error: 'filename (WIP_Journey_DayN….md) and body are required' })
    return
  }
  try {
    const titleNum = Number.isInteger(dayNum) ? String(dayNum) : String(dayNum)
    let title = `Day ${titleNum}`
    const tm = /^#[^\n]*?Day\s+\S+:\s*(.+)$/m.exec(text)
    if (tm && tm[1]) title = `Day ${titleNum}: ${tm[1].trim()}`
    // journey_date: **Date:** header (Month D[, ranges] YYYY) else DAY_ONE+N-1
    let journeyDate = new Date(DAY_ONE + (Math.trunc(dayNum) - 1) * 86400000).toISOString().slice(0, 10)
    const dm = /\*\*Date:\*\*[^\n]*?\b(January|February|March|April|May|June|July|August|September|October|November|December)\b\s+(\d{1,2})/.exec(text.slice(0, 1500))
    const line = /\*\*Date:\*\*([^\n]+)/.exec(text.slice(0, 1500))?.[1] || ''
    const year = /\b(20\d{2})\b/.exec(line)?.[1]
    if (dm && dm[1] && dm[2] && year) {
      const months = ['January','February','March','April','May','June','July','August','September','October','November','December']
      const mo = String(months.indexOf(dm[1]) + 1).padStart(2, '0')
      journeyDate = `${year}-${mo}-${dm[2].padStart(2, '0')}`
    }
    const tid = await templateId('JOURNEY_ENTRY', ns, key)
    const d = await wipReq('POST', '/api/document-store/documents', key, [{
      template_id: tid, namespace: ns, created_by: 'kb-gateway',
      data: {
        title, body: text, authored_by: String(b.authored_by || 'FRanC'),
        doc_status: 'published', tags: ['journey-mirror', `day-${dayNum}`],
        root: true, journey_date: journeyDate, day_number: dayNum,
      },
      metadata: { flat_file_mirror: `dayJournals/${fname}`, loader: 'kb-gateway' },
    }])
    const r = (d.results || [])[0] || {}
    if (!['created', 'updated', 'unchanged', 'skipped'].includes(r.status)) { // skipped = identical re-mirror, a success for upserts
      res.status(502).json({ error: `journey mirror failed: ${r.error || JSON.stringify(r)}` })
      return
    }
    res.json({ title, document_id: r.document_id, result: r.status })
  } catch (e) {
    res.status(e instanceof WipError ? 502 : 500).json({ error: (e as Error).message })
  }
})

// POST /stats/snapshot — computed git stats from the machine that has the
// repos; title/tags/shape composed server-side (the roster class, CASE-453)
router.post('/stats/snapshot', async (req, res) => {
  const key = callerKey(req, res)
  if (!key) return
  const ns = String(req.query.namespace || NS_DEFAULT)
  const b: AnyObj = req.body || {}
  const repo = String(b.repo || '')
  const date = String(b.snapshot_date || '')
  if (!repo || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(422).json({ error: 'repo and snapshot_date (YYYY-MM-DD) are required' })
    return
  }
  const ints: AnyObj = {}
  for (const f of ['commits', 'lines_added', 'lines_removed', 'files_changed', 'contributors']) {
    const v = Number(b[f])
    if (!Number.isInteger(v) || v < 0) {
      res.status(422).json({ error: `${f} must be a non-negative integer` })
      return
    }
    ints[f] = v
  }
  try {
    const tid = await templateId('GIT_STATS_SNAPSHOT', ns, key)
    const d = await wipReq('POST', '/api/document-store/documents', key, [{
      template_id: tid, namespace: ns, created_by: 'kb-gateway',
      data: {
        title: `${repo} — ${date}`, authored_by: String(b.authored_by || 'FRanC'),
        doc_status: 'published', tags: ['git-stats', `repo-${repo}`, `date-${date}`],
        root: false, snapshot_date: date, repo, ...ints,
      },
      metadata: { loader: 'kb-gateway' },
    }])
    const r = (d.results || [])[0] || {}
    if (!['created', 'updated', 'unchanged', 'skipped'].includes(r.status)) { // skipped = identical re-mirror, a success for upserts
      res.status(502).json({ error: `stats snapshot failed: ${r.error || JSON.stringify(r)}` })
      return
    }
    res.json({ repo, snapshot_date: date, document_id: r.document_id, result: r.status })
  } catch (e) {
    res.status(e instanceof WipError ? 502 : 500).json({ error: (e as Error).message })
  }
})

// ---------------------------------------------------------------------------
// Phase 3 (CASE-464): read API — the surface /catch-up & friends re-source
// from once FS reads retire (kb-only blocker 6). Thin projections over
// documents/query; caller's key, page_size capped at the platform's 100.

function pageParams(req: Request): { page: number; pageSize: number } {
  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1)
  const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.page_size || '50'), 10) || 50))
  return { page, pageSize }
}

function caseProjection(it: AnyObj): AnyObj {
  const d = it.data || {}
  return {
    case: d.case_number, title: d.title, status: d.status,
    severity: d.severity || '', type: d.type || '', component: d.component || '',
    filed_by: d.filed_by || '', app: d.app || '', target_yac: d.target_yac || '',
    document_id: it.document_id, doc_version: it.version, updated_at: it.updated_at,
  }
}

// GET /cases?status=&since=&page=&page_size=  (since: ISO date, on updated_at)
router.get('/cases', async (req, res) => {
  const key = callerKey(req, res)
  if (!key) return
  const ns = String(req.query.namespace || NS_DEFAULT)
  const { page, pageSize } = pageParams(req)
  const filters: AnyObj[] = []
  if (req.query.status) filters.push({ field: 'data.status', operator: 'eq', value: String(req.query.status) })
  if (req.query.since) filters.push({ field: 'updated_at', operator: 'gte', value: String(req.query.since) })
  try {
    const d = await wipReq('POST', `/api/document-store/documents/query?namespace=${ns}`, key,
      { template_id: 'CASE_RECORD', filters, page, page_size: pageSize })
    res.json({ total: d.total, page: d.page, pages: d.pages, items: (d.items || []).map(caseProjection) })
  } catch (e) {
    res.status(e instanceof WipError ? 502 : 500).json({ error: (e as Error).message })
  }
})

// GET /cases/:n — full case incl. body, resolved via the CASE-<n> synonym
router.get('/cases/:n', async (req, res) => {
  const key = callerKey(req, res)
  if (!key) return
  const n = parseInt(req.params.n, 10)
  if (!Number.isFinite(n)) {
    res.status(422).json({ error: 'case number must be an integer' })
    return
  }
  const ns = String(req.query.namespace || NS_DEFAULT)
  try {
    const docId = await resolveCase(n, ns, key)
    if (!docId) {
      res.status(404).json({ error: `CASE-${n} not found in ${ns}` })
      return
    }
    const doc = await getDoc(docId, ns, key)
    res.json({ ...caseProjection(doc), body: doc.data?.body || '' })
  } catch (e) {
    res.status(e instanceof WipError ? 502 : 500).json({ error: (e as Error).message })
  }
})

// GET /sessions?role=&status=&page=&page_size=[&include_body=1]
router.get('/sessions', async (req, res) => {
  const key = callerKey(req, res)
  if (!key) return
  const ns = String(req.query.namespace || NS_DEFAULT)
  const { page, pageSize } = pageParams(req)
  const filters: AnyObj[] = []
  if (req.query.role) filters.push({ field: 'data.role', operator: 'eq', value: String(req.query.role) })
  if (req.query.status) filters.push({ field: 'data.status', operator: 'eq', value: String(req.query.status) })
  const includeBody = req.query.include_body === '1'
  try {
    const d = await wipReq('POST', `/api/document-store/documents/query?namespace=${ns}`, key,
      { template_id: 'SESSION', filters, page, page_size: pageSize })
    const items = (d.items || []).map((it: AnyObj) => {
      const s = it.data || {}
      const out: AnyObj = {
        session_id: s.session_id, role: s.role, status: s.status,
        started_at: s.started_at, ended_at: s.ended_at || null,
        continues_from: s.continues_from || null,
        document_id: it.document_id, doc_version: it.version, updated_at: it.updated_at,
      }
      if (includeBody) out.body = s.body || ''
      return out
    })
    res.json({ total: d.total, page: d.page, pages: d.pages, items })
  } catch (e) {
    res.status(e instanceof WipError ? 502 : 500).json({ error: (e as Error).message })
  }
})

// GET /journeys/:day — one journal entry by day number (fractional ok: 7.5)
router.get('/journeys/:day', async (req, res) => {
  const key = callerKey(req, res)
  if (!key) return
  const day = parseFloat(req.params.day)
  if (!Number.isFinite(day)) {
    res.status(422).json({ error: 'day must be a number (fractional allowed, e.g. 7.5)' })
    return
  }
  const ns = String(req.query.namespace || NS_DEFAULT)
  try {
    const d = await wipReq('POST', `/api/document-store/documents/query?namespace=${ns}`, key,
      { template_id: 'JOURNEY_ENTRY', filters: [{ field: 'data.day_number', operator: 'eq', value: day }], page: 1, page_size: 2 })
    const it = (d.items || [])[0]
    if (!it) {
      res.status(404).json({ error: `no journal entry for day ${day} in ${ns}` })
      return
    }
    const j = it.data || {}
    res.json({
      title: j.title, day_number: j.day_number, journey_date: j.journey_date,
      body: j.body || '', document_id: it.document_id, doc_version: it.version,
    })
  } catch (e) {
    res.status(e instanceof WipError ? 502 : 500).json({ error: (e as Error).message })
  }
})

export default router
