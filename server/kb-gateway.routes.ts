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

// best-effort seed for the per-case response sequence; the CASE-<n>#<seq>
// synonym claim is the atomic correctness guard (mirrors maxCaseNumber).
async function maxResponseSeq(caseNumber: number, ns: string, key: string): Promise<number> {
  let mx = 0, page = 1
  for (;;) {
    const d = await wipReq('POST', `/api/document-store/documents/query?namespace=${ns}`, key,
      { template_id: 'CASE_RESPONSE', filters: [{ field: 'data.case_number', operator: 'eq', value: caseNumber }], page, page_size: 100 })
    const items: AnyObj[] = d.items || []
    for (const it of items) {
      const s = it.data?.response_seq
      if (typeof s === 'number' && s > mx) mx = s
    }
    if (page >= (d.pages || 1) || items.length === 0) break
    page += 1
  }
  return mx
}

// generic per-type max(numberField) seed (best-effort; the synonym claim guards)
async function maxNumberField(templateValue: string, field: string, ns: string, key: string): Promise<number> {
  let mx = 0, page = 1
  for (;;) {
    const d = await wipReq('POST', `/api/document-store/documents/query?namespace=${ns}`, key,
      { template_id: templateValue, filters: [], page, page_size: 100 })
    const items: AnyObj[] = d.items || []
    for (const it of items) { const v = it.data?.[field]; if (typeof v === 'number' && v > mx) mx = v }
    if (page >= (d.pages || 1) || items.length === 0) break
    page += 1
  }
  return mx
}

// Resolve-then-mint a per-type numbered, gateway-born doc (CASE-481). On first
// contact (nothing matches searchFilters) → allocate per-type max+1 and claim the
// <PREFIX>-<n> synonym atomically (retry on conflict = the uniqueness guard). On
// re-contact → reuse the existing number → versions in place (idempotent). The
// minted number is THE identity field; searchFilters is only the dedup key.
async function mintNumberedDoc(opts: {
  templateValue: string; numberField: string; synonymPrefix: string;
  searchFilters: AnyObj[]; data: AnyObj; metadata?: AnyObj; ns: string; key: string;
}): Promise<{ number: number; synonym: string; document_id: string; result: string }> {
  const { templateValue, numberField, synonymPrefix, searchFilters, data, metadata, ns, key } = opts
  const tid = await templateId(templateValue, ns, key)
  const meta = metadata ? { metadata } : {}

  if (searchFilters.length) {
    const q = await wipReq('POST', `/api/document-store/documents/query?namespace=${ns}`, key,
      { template_id: templateValue, filters: searchFilters, page: 1, page_size: 1 })
    const existing = (q.items || [])[0]
    if (existing && typeof existing.data?.[numberField] === 'number') {
      const num = existing.data[numberField]
      const d = await wipReq('POST', '/api/document-store/documents', key, [{
        template_id: tid, namespace: ns, created_by: 'kb-gateway', data: { ...data, [numberField]: num }, ...meta,
      }])
      const r = (d.results || [])[0] || {}
      if (!['created', 'updated', 'unchanged', 'skipped'].includes(r.status))
        throw new WipError(502, `${templateValue} re-mint failed: ${r.error || JSON.stringify(r)}`)
      return { number: num, synonym: `${synonymPrefix}-${num}`, document_id: r.document_id, result: r.status }
    }
  }

  let n = (await maxNumberField(templateValue, numberField, ns, key)) + 1
  for (let i = 0; i < ALLOC_MAX_RETRIES; i++) {
    const d = await wipReq('POST', '/api/document-store/documents', key, [{
      template_id: tid, namespace: ns, created_by: 'kb-gateway',
      data: { ...data, [numberField]: n }, ...meta, synonyms: [{ value: `${synonymPrefix}-${n}` }],
    }])
    const r = (d.results || [])[0] || {}
    if (r.status === 'created' || r.status === 'updated')
      return { number: n, synonym: `${synonymPrefix}-${n}`, document_id: r.document_id, result: r.status }
    if (r.error_code === 'synonym_conflict' || /different entry/.test(r.error || '')) { n += 1; continue }
    throw new WipError(502, `${templateValue} mint failed at ${synonymPrefix}-${n}: ${r.error || JSON.stringify(r)}`)
  }
  throw new WipError(503, `${templateValue} allocation exhausted ${ALLOC_MAX_RETRIES} retries`)
}

// Per-type write config (CASE-481/482). END-STATE: derive from the template's
// metadata.custom.write (templates persist a metadata.custom slot) so the schema
// is the single source — kept behind writeConfig() so that move is one function,
// no call-site churn. Types absent here write by their natural identity (upsert).
const WRITE_CONFIG: Record<string, { numberField: string; prefix: string; searchKey: string[] }> = {
  CASE_RECORD:     { numberField: 'case_number',     prefix: 'CASE',     searchKey: [] },
  FIRESIDE:        { numberField: 'fireside_number', prefix: 'FIRESIDE', searchKey: ['title'] },
  DESIGN_DECISION: { numberField: 'decision_number', prefix: 'DECISION', searchKey: ['title'] },
  LESSON:          { numberField: 'lesson_number',   prefix: 'LESSON',   searchKey: ['title'] },
  DOCUMENT:        { numberField: 'paper_number',    prefix: 'PAPER',    searchKey: ['repo_origin', 'path'] },
}
function writeConfig(type: string): { numberField: string; prefix: string; searchKey: string[] } | null {
  return WRITE_CONFIG[type] || null
}

// The single generic write seam (CASE-482): mint a per-type number when the type
// has write config (resolve-then-mint by its search key), else upsert by the
// template's natural identity. Every write verb routes through here — no bespoke
// per-type mint/upsert logic survives in the handlers.
async function genericWrite(type: string, data: AnyObj, opts: { metadata?: AnyObj; ns: string; key: string }): Promise<{ document_id: string; result: string; number?: number; synonym?: string }> {
  const { ns, key, metadata } = opts
  const cfg = writeConfig(type)
  if (cfg) {
    const searchFilters = cfg.searchKey.map((f) => ({ field: `data.${f}`, operator: 'eq', value: data[f] }))
    const m = await mintNumberedDoc({
      templateValue: type, numberField: cfg.numberField, synonymPrefix: cfg.prefix,
      searchFilters, data, metadata, ns, key,
    })
    return { document_id: m.document_id, result: m.result, number: m.number, synonym: m.synonym }
  }
  const tid = await templateId(type, ns, key)
  const d = await wipReq('POST', '/api/document-store/documents', key, [{
    template_id: tid, namespace: ns, created_by: 'kb-gateway', data, ...(metadata ? { metadata } : {}),
  }])
  const r = (d.results || [])[0] || {}
  if (!['created', 'updated', 'unchanged', 'skipped'].includes(r.status))
    throw new WipError(502, `${type} write failed: ${r.error || JSON.stringify(r)}`)
  return { document_id: r.document_id, result: r.status }
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
    const data = {
      title: String(b.title), body: String(b.body || ''),
      authored_by: String(b.filed_by), doc_status: 'published',
      tags: ['case-mirror', 'status-open'], root: true,
      source_yac: String(b.filed_by), target_yac: String(b.target_yac || 'any'),
      status: 'open', severity: String(b.severity || ''), type: String(b.type || ''),
      component: String(b.component || ''), filed_by: String(b.filed_by),
      app: String(b.app || ''),
    }
    // Capture the filing timestamp into metadata.custom.filed_at (the UI's "Filed" sort reads it).
    const fm = parseFrontmatter(String(b.body || ''))
    const filedAt = fm.filed && /^\d{4}-\d{2}-\d{2}/.test(fm.filed) ? fm.filed : nowStamp()
    // Generic write (CASE_RECORD config = mint case_number; empty search key → always a fresh number).
    const w = await genericWrite('CASE_RECORD', data, { metadata: { custom: { filed_at: filedAt }, loader: 'kb-gateway' }, ns, key })
    const edges = await deriveReferences(w.document_id, parseRelated(b.related), ns, key)
    res.status(201).json({ case: w.number, synonym: w.synonym, document_id: w.document_id, edges })
  } catch (e) {
    const s = e instanceof WipError ? 502 : 500
    res.status(s).json({ error: (e as Error).message })
  }
})

// POST /cases/:n/<verb> — v3 (CASE-481 fork 3): discourse becomes its own
// CASE_RESPONSE doc + RESPONDS_TO edge (append-only, immutable); status changes
// are a field update on the CASE_RECORD (which now has identity, so this is a
// clean versioned PATCH, not the old zero-identity loophole). The case body is
// NO LONGER appended to — status lives on the case, conversation in response docs.
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
    const caseDocId = await resolveCase(n, ns, key)
    if (!caseDocId) {
      res.status(404).json({ error: `CASE-${n} not found in ${ns}` })
      return
    }
    // Status transition check against the case's current status.
    const caseDoc = await getDoc(caseDocId, ns, key)
    const current = String((caseDoc.data || {}).status || 'open')
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

    // 1) Create the CASE_RESPONSE. response_seq is per-case monotonic; the
    //    CASE-<n>#<seq> synonym claim is the atomic guard + the human handle.
    const respTid = await templateId('CASE_RESPONSE', ns, key)
    let seq = (await maxResponseSeq(n, ns, key)) + 1
    let responseId = ''
    for (let i = 0; i < ALLOC_MAX_RETRIES; i++) {
      const d = await wipReq('POST', '/api/document-store/documents', key, [{
        template_id: respTid, namespace: ns, created_by: 'kb-gateway',
        data: {
          case_number: n, response_seq: seq, response_kind: req.params.verb,
          body: String(b.text).trim(), author: String(b.author), doc_status: 'published',
        },
        synonyms: [{ value: `CASE-${n}#${seq}` }],
      }])
      const r = (d.results || [])[0] || {}
      if (r.status === 'created' || r.status === 'updated') { responseId = r.document_id; break }
      if (r.error_code === 'synonym_conflict' || /different entry/.test(r.error || '')) { seq += 1; continue }
      res.status(502).json({ error: `response create failed at CASE-${n}#${seq}: ${r.error || JSON.stringify(r)}` })
      return
    }
    if (!responseId) {
      res.status(503).json({ error: `response allocation exhausted ${ALLOC_MAX_RETRIES} retries` })
      return
    }

    // 2) RESPONDS_TO edge: response -> case (idempotent on [source_ref, target_ref]).
    const edgeTid = await templateId('RESPONDS_TO', ns, key)
    await wipReq('POST', '/api/document-store/documents', key, [{
      template_id: edgeTid, namespace: ns, created_by: 'kb-gateway',
      data: { source_ref: responseId, target_ref: caseDocId },
    }])

    // 3) Status transition (respond/close/implement) — a versioned field update
    //    on the case; the body is untouched. if_match + retry on concurrency.
    let newStatus = current
    if (verb.to) {
      let ok = false
      for (let attempt = 0; attempt < PATCH_MAX_RETRIES; attempt++) {
        const fresh = await getDoc(caseDocId, ns, key)
        const fdata: AnyObj = fresh.data || {}
        const patch: AnyObj = {
          status: verb.to,
          tags: [...(fdata.tags || []).filter((t: string) => !t.startsWith('status-')), `status-${verb.to}`],
        }
        const d = await wipReq('PATCH', `/api/document-store/documents?namespace=${ns}`, key,
          [{ document_id: caseDocId, patch, if_match: fresh.version }])
        const r = (d.results || [])[0] || {}
        if (r.status === 'updated' || r.status === 'unchanged') { newStatus = verb.to; ok = true; break }
        if (r.error_code === 'concurrency_conflict') continue
        res.status(502).json({ error: `status update failed: ${r.error || JSON.stringify(r)}` })
        return
      }
      if (!ok) {
        res.status(409).json({ error: `CASE-${n}: status update still conflicting after ${PATCH_MAX_RETRIES} retries (response CASE-${n}#${seq} was recorded)` })
        return
      }
    }

    res.json({
      case: n, response_seq: seq, response_handle: `CASE-${n}#${seq}`,
      response_document_id: responseId, status: newStatus,
    })
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

    // Generic write (SESSION has no write config → natural upsert by session_id).
    const w = await genericWrite('SESSION', data, { metadata: { flat_file_mirror: `reports/${sessionId}/session.md`, loader: 'kb-gateway' }, ns, key })
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
          data: { source_ref: w.document_id, target_ref: prior.document_id },
          metadata: { edge_kind: 'CONTINUES_FROM', loader: 'kb-gateway' },
        }])
        const er = (ed.results || [])[0] || {}
        edge = ['created', 'updated', 'skipped', 'unchanged'].includes(er.status) ? er.status : `error: ${er.error}`
      } else {
        edge = 'target-not-in-kb-skipped'
      }
    }
    res.json({ session_id: sessionId, document_id: w.document_id, result: w.result, continues_from_edge: edge })
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
    // Generic write (JOURNEY_ENTRY has no write config → natural upsert by day_number).
    const w = await genericWrite('JOURNEY_ENTRY', {
      title, body: text, authored_by: String(b.authored_by || 'FRanC'),
      doc_status: 'published', tags: ['journey-mirror', `day-${dayNum}`],
      root: true, journey_date: journeyDate, day_number: dayNum,
    }, { metadata: { flat_file_mirror: `dayJournals/${fname}`, loader: 'kb-gateway' }, ns, key })
    res.json({ title, document_id: w.document_id, result: w.result })
  } catch (e) {
    res.status(e instanceof WipError ? 502 : 500).json({ error: (e as Error).message })
  }
})

// POST /documents/mirror — papers/docs (DOCUMENT, CASE-346). The caller
// supplies what only it knows (repo origin, repo-relative path, kind); the
// domain conventions (title fallback, frontmatter strip) live here.
router.post('/documents/mirror', async (req, res) => {
  const key = callerKey(req, res)
  if (!key) return
  const ns = String(req.query.namespace || NS_DEFAULT)
  const b: AnyObj = req.body || {}
  const relPath = String(b.path || '')
  const repoOrigin = String(b.repo_origin || '')
  const kind = String(b.kind || '')
  const text = String(b.body || '')
  if (!relPath || !repoOrigin || !kind || !text) {
    res.status(422).json({ error: 'path, repo_origin, kind and body are required' })
    return
  }
  try {
    const fm = parseFrontmatter(text)
    let title = String(b.title || fm.title || '').trim()
    if (!title) {
      const h1 = /^#\s+(.+)$/m.exec(text)
      title = h1 && h1[1] ? h1[1].trim() : relPath.split('/').pop()!.replace(/\.md$/, '')
    }
    const fmEnd = /^---\n[\s\S]*?\n---\s*\n?/.exec(text)
    const body = fmEnd && text.slice(fmEnd[0].length).trim() ? text.slice(fmEnd[0].length) : text
    const data: AnyObj = {
      path: relPath, repo_origin: repoOrigin, title, body, kind,
      doc_status: 'published',
    }
    if (b.authored_by || fm.authored_by) data.authored_by = String(b.authored_by || fm.authored_by)
    const tags = Array.isArray(b.tags) ? b.tags.map(String)
      : (fm.tags || '').split(',').map((t: string) => t.trim()).filter(Boolean)
    if (tags.length) data.tags = tags
    // Generic write (DOCUMENT config = mint paper_number, dedup by repo_origin+path;
    // path is no longer identity — collides across repos + breaks on rename).
    const minted = await genericWrite('DOCUMENT', data, {
      metadata: { flat_file_mirror: relPath, kind, loader: 'kb-gateway' },
      ns, key,
    })
    res.json({ path: relPath, title, paper_number: minted.number, synonym: minted.synonym, document_id: minted.document_id, result: minted.result })
  } catch (e) {
    res.status(e instanceof WipError ? 502 : 500).json({ error: (e as Error).message })
  }
})

// POST /firesides/mirror — fireside / design-chat transcripts (FIRESIDE, CASE-479).
// FIRESIDE has its own identity (title) plus topic/chat_date FTS fields that
// DOCUMENT lacks, so firesides get a dedicated verb rather than folding into
// /documents/mirror. Caller supplies the transcript + what only it knows
// (session origin, participants); domain conventions (title/topic/date
// fallbacks, frontmatter strip) live here. Upsert by title → re-mirror = new
// version (PoNIF #3), idempotent.
router.post('/firesides/mirror', async (req, res) => {
  const key = callerKey(req, res)
  if (!key) return
  const ns = String(req.query.namespace || NS_DEFAULT)
  const b: AnyObj = req.body || {}
  const text = String(b.body || '')
  if (!text) {
    res.status(422).json({ error: 'body is required' })
    return
  }
  try {
    const fm = parseFrontmatter(text)
    let title = String(b.title || fm.title || fm.topic || '').trim()
    if (!title) {
      const h1 = /^#\s+(.+)$/m.exec(text)
      title = h1 && h1[1] ? h1[1].trim() : ''
    }
    if (!title) {
      res.status(422).json({ error: 'title unresolved (pass title, or frontmatter title/topic, or an H1)' })
      return
    }
    const authoredBy = String(b.authored_by || fm.authored_by || fm.participants || fm.session || '').trim()
    if (!authoredBy) {
      res.status(422).json({ error: 'authored_by unresolved (pass authored_by, or frontmatter participants/session)' })
      return
    }
    const fmEnd = /^---\n[\s\S]*?\n---\s*\n?/.exec(text)
    const body = fmEnd && text.slice(fmEnd[0].length).trim() ? text.slice(fmEnd[0].length) : text
    const data: AnyObj = {
      title, body, authored_by: authoredBy,
      doc_status: String(b.doc_status || fm.doc_status || 'published'),
    }
    if (b.topic || fm.topic) data.topic = String(b.topic || fm.topic)
    const chat = String(b.chat_date || fm.chat_date || fm.time || '').slice(0, 10)
    if (/^\d{4}-\d{2}-\d{2}$/.test(chat)) data.chat_date = chat
    if (typeof b.root === 'boolean') data.root = b.root
    const tags = Array.isArray(b.tags) ? b.tags.map(String)
      : (fm.tags || '').split(',').map((t: string) => t.trim()).filter(Boolean)
    if (tags.length) data.tags = tags
    // Generic write (FIRESIDE config = mint fireside_number, dedup by title).
    const minted = await genericWrite('FIRESIDE', data, {
      metadata: { session_id: b.session_id || fm.session || null, flat_file_mirror: b.path || null, loader: 'kb-gateway' },
      ns, key,
    })
    res.json({ title, fireside_number: minted.number, synonym: minted.synonym, document_id: minted.document_id, result: minted.result })
  } catch (e) {
    res.status(e instanceof WipError ? 502 : 500).json({ error: (e as Error).message })
  }
})

// POST /write/:type — the generic typed-write surface (CASE-482). The uniform
// migration target for every doc type: mint or natural-upsert per the type's
// config/identity. Body = { data: {...}, metadata?: {...} }. Type-specific source
// parsing (frontmatter→fields) is the caller's job; this is the write seam itself.
// Makes any template writable — incl. the previously-orphaned DESIGN_DECISION /
// LESSON (no bespoke verb needed).
router.post('/write/:type', async (req, res) => {
  const key = callerKey(req, res)
  if (!key) return
  const ns = String(req.query.namespace || NS_DEFAULT)
  const type = req.params.type
  const b: AnyObj = req.body || {}
  const data: AnyObj = b.data || {}
  if (typeof data !== 'object' || Array.isArray(data) || !Object.keys(data).length) {
    res.status(422).json({ error: 'data (non-empty object) is required' })
    return
  }
  try {
    const w = await genericWrite(type, data, { metadata: b.metadata, ns, key })
    res.json({ type, ...w })
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
    // Generic write (GIT_STATS_SNAPSHOT has no write config → natural upsert by [snapshot_date, repo]).
    const w = await genericWrite('GIT_STATS_SNAPSHOT', {
      title: `${repo} — ${date}`, authored_by: String(b.authored_by || 'FRanC'),
      doc_status: 'published', tags: ['git-stats', `repo-${repo}`, `date-${date}`],
      root: false, snapshot_date: date, repo, ...ints,
    }, { metadata: { loader: 'kb-gateway' }, ns, key })
    res.json({ repo, snapshot_date: date, document_id: w.document_id, result: w.result })
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

function firesideProjection(it: AnyObj): AnyObj {
  const d = it.data || {}
  return {
    title: d.title, topic: d.topic || '', authored_by: d.authored_by || '',
    chat_date: d.chat_date || null, doc_status: d.doc_status || '',
    tags: d.tags || [], root: d.root || false,
    document_id: it.document_id, doc_version: it.version, updated_at: it.updated_at,
  }
}

// GET /firesides?topic=&author=&since=&page=&page_size=  — discovery list (bodies omitted)
router.get('/firesides', async (req, res) => {
  const key = callerKey(req, res)
  if (!key) return
  const ns = String(req.query.namespace || NS_DEFAULT)
  const { page, pageSize } = pageParams(req)
  const filters: AnyObj[] = []
  if (req.query.topic) filters.push({ field: 'data.topic', operator: 'eq', value: String(req.query.topic) })
  if (req.query.author) filters.push({ field: 'data.authored_by', operator: 'eq', value: String(req.query.author) })
  if (req.query.since) filters.push({ field: 'updated_at', operator: 'gte', value: String(req.query.since) })
  try {
    const d = await wipReq('POST', `/api/document-store/documents/query?namespace=${ns}`, key,
      { template_id: 'FIRESIDE', filters, page, page_size: pageSize })
    res.json({ total: d.total, page: d.page, pages: d.pages, items: (d.items || []).map(firesideProjection) })
  } catch (e) {
    res.status(e instanceof WipError ? 502 : 500).json({ error: (e as Error).message })
  }
})

// GET /firesides/:id — full fireside incl. body, by document_id (identity is title;
// no number/synonym). Discover ids via GET /firesides, then fetch here.
router.get('/firesides/:id', async (req, res) => {
  const key = callerKey(req, res)
  if (!key) return
  const ns = String(req.query.namespace || NS_DEFAULT)
  try {
    const doc = await getDoc(req.params.id, ns, key)
    res.json({ ...firesideProjection(doc), body: doc.data?.body || '' })
  } catch (e) {
    if (e instanceof WipError && e.status === 404) {
      res.status(404).json({ error: `fireside ${req.params.id} not found in ${ns}` })
      return
    }
    res.status(e instanceof WipError ? 502 : 500).json({ error: (e as Error).message })
  }
})

export default router
