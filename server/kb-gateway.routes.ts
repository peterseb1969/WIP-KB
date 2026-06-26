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


type AnyObj = Record<string, any>

class WipError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

// Map document-store per-item error_codes to a precise client status (CASE-490
// fix #1, kb-gateway remainder). document-store is bulk-first (HTTP 200 with a
// per-item error_code), so a write the platform rejected on a precondition —
// e.g. `template_inactive`, a frozen template version — must surface as a
// branchable 4xx here, not a blanket 502 that reads as "the backend is down".
const ERROR_CODE_STATUS: Record<string, number> = {
  not_found: 404,
  forbidden: 403,
  archived: 409,
  template_inactive: 409,    // frozen template version (CASE-490)
  append_only: 409,          // identity-less template can't be PATCHed (CASE-478)
  concurrency_conflict: 409,
  identity_field_change: 422,
  validation_failed: 422,
  reference_violation: 422,
  internal_error: 502,
}
function statusForErrorCode(code?: string): number {
  return (code && ERROR_CODE_STATUS[code]) || 502
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

// Full-template cache — keyed by ns/value. template_id is stable across versions
// (PoNIF #2 corollary), and metadata.custom.write (the generic-write config) is
// fixed at bootstrap, so caching the whole template is safe and lets writeConfig()
// derive from it without a second fetch.
const tplCache = new Map<string, AnyObj>()
async function getTemplate(value: string, ns: string, key: string): Promise<AnyObj> {
  const ck = `${ns}/${value}`
  const hit = tplCache.get(ck)
  if (hit) return hit
  const t = await wipReq('GET', `/api/template-store/templates/by-value/${value}?namespace=${ns}`, key)
  if (!(t.id || t.template_id)) throw new WipError(502, `template ${value} has no id in ${ns}`)
  tplCache.set(ck, t)
  return t
}
async function templateId(value: string, ns: string, key: string): Promise<string> {
  const t = await getTemplate(value, ns, key)
  return t.id || t.template_id
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

// generic max(numberField) seed (best-effort; the synonym claim guards). When
// scope is given, the max is taken only within docs sharing that parent value
// (a per-parent sequence, e.g. response_seq within one case).
async function maxNumberField(templateValue: string, field: string, ns: string, key: string,
  scope?: { field: string; value: unknown }): Promise<number> {
  const filters = scope ? [{ field: `data.${scope.field}`, operator: 'eq', value: scope.value }] : []
  let mx = 0, page = 1
  for (;;) {
    // status: null spans ALL statuses (the query defaults to active-only). A
    // minted number is permanently spent once any doc holds it — including a
    // soft-deleted one whose CASE-<n> synonym is retained. Without this the
    // high-water mark regresses when the latest doc is soft-deleted, the next
    // mint re-allocates its number, and the create upserts (clobbers) the
    // retired doc as a new version instead of minting fresh (CASE-504).
    const d = await wipReq('POST', `/api/document-store/documents/query?namespace=${ns}`, key,
      { template_id: templateValue, filters, status: null, page, page_size: 100 })
    const items: AnyObj[] = d.items || []
    for (const it of items) { const v = it.data?.[field]; if (typeof v === 'number' && v > mx) mx = v }
    if (page >= (d.pages || 1) || items.length === 0) break
    page += 1
  }
  return mx
}

// Build a minted doc's synonym: a {field}-placeholder template ({<numberField>}=n,
// other keys from the doc), else the simple "<prefix>-<n>".
function buildSynonym(cfg: { prefix?: string; synonymTemplate?: string; numberField: string },
  n: number, data: AnyObj): string {
  if (cfg.synonymTemplate)
    return cfg.synonymTemplate.replace(/\{(\w+)\}/g, (_m, k) => String(k === cfg.numberField ? n : (data[k] ?? '')))
  return `${cfg.prefix}-${n}`
}

// Resolve-then-mint a per-type numbered, gateway-born doc (CASE-481). On first
// contact (nothing matches searchFilters) → allocate per-type max+1 and claim the
// <PREFIX>-<n> synonym atomically (retry on conflict = the uniqueness guard). On
// re-contact → reuse the existing number → versions in place (idempotent). The
// minted number is THE identity field; searchFilters is only the dedup key.
async function mintNumberedDoc(opts: {
  templateValue: string; numberField: string; synonymPrefix: string;
  searchFilters: AnyObj[]; data: AnyObj; metadata?: AnyObj; ns: string; key: string;
  scopeField?: string; synonymTemplate?: string;
}): Promise<{ number: number; synonym: string; document_id: string; result: string }> {
  const { templateValue, numberField, synonymPrefix, searchFilters, data, metadata, ns, key, scopeField, synonymTemplate } = opts
  const tid = await templateId(templateValue, ns, key)
  const meta = metadata ? { metadata } : {}
  const synCfg = { prefix: synonymPrefix, synonymTemplate, numberField }
  const scope = scopeField ? { field: scopeField, value: data[scopeField] } : undefined

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
      return { number: num, synonym: buildSynonym(synCfg, num, data), document_id: r.document_id, result: r.status }
    }
  }

  let n = (await maxNumberField(templateValue, numberField, ns, key, scope)) + 1
  for (let i = 0; i < ALLOC_MAX_RETRIES; i++) {
    const synonym = buildSynonym(synCfg, n, data)
    const d = await wipReq('POST', '/api/document-store/documents', key, [{
      template_id: tid, namespace: ns, created_by: 'kb-gateway',
      data: { ...data, [numberField]: n }, ...meta, synonyms: [{ value: synonym }],
    }])
    const r = (d.results || [])[0] || {}
    if (r.status === 'created' || r.status === 'updated')
      return { number: n, synonym, document_id: r.document_id, result: r.status }
    if (r.error_code === 'synonym_conflict' || /different entry/.test(r.error || '')) { n += 1; continue }
    throw new WipError(502, `${templateValue} mint failed at ${synonym}: ${r.error || JSON.stringify(r)}`)
  }
  throw new WipError(503, `${templateValue} allocation exhausted ${ALLOC_MAX_RETRIES} retries`)
}

// Per-type write config (CASE-481/482) lives as first-class WRITE_POLICY
// DOCUMENTS — not gateway code, not template metadata. Each policy doc is
// { doc_type, write_mode, number_field, synonym_prefix, search_key }; a
// write_mode of 'mint' means allocate a per-type number, else (or absent) the
// type writes by its natural identity. Loaded once per namespace and cached.
// Adding a mint type = add a WRITE_POLICY doc (a bootstrap seed), never a code edit.
// scopeField: when set, the number is a per-parent sequence (max within docs
// sharing the same data[scopeField]) — e.g. CASE_RESPONSE.response_seq scoped by
// case_number. synonymTemplate: when set, the synonym is the template with {field}
// placeholders filled from the doc ({<numberField>} = the minted n) — e.g.
// "CASE-{case_number}#{response_seq}"; else it is "<prefix>-<n>".
type MintCfg = { numberField: string; prefix: string; searchKey: string[]; scopeField?: string; synonymTemplate?: string }
const policyCache = new Map<string, Map<string, MintCfg>>()
async function loadPolicies(ns: string, key: string): Promise<Map<string, MintCfg>> {
  const hit = policyCache.get(ns)
  if (hit) return hit
  const m = new Map<string, MintCfg>()
  try {
    const d = await wipReq('POST', `/api/document-store/documents/query?namespace=${ns}`, key,
      { template_id: 'WRITE_POLICY', filters: [], page: 1, page_size: 100 })
    for (const it of (d.items || []) as AnyObj[]) {
      const p = it.data || {}
      if (p.doc_type && p.write_mode === 'mint' && p.number_field)
        m.set(p.doc_type, {
          numberField: p.number_field, prefix: p.synonym_prefix, searchKey: p.search_key || [],
          scopeField: p.scope_field || undefined, synonymTemplate: p.synonym_template || undefined,
        })
    }
    policyCache.set(ns, m)  // cache only on success — a transient error retries next write
  } catch (e) {
    // No WRITE_POLICY template/docs (un-migrated namespace) → every type writes
    // natural. Warn so a missing-policy misconfiguration isn't silent.
    console.warn(`[kb-gateway] WRITE_POLICY load failed for ns=${ns}; treating all types as natural: ${(e as Error).message}`)
  }
  return m
}
async function writeConfig(type: string, ns: string, key: string): Promise<MintCfg | null> {
  return (await loadPolicies(ns, key)).get(type) || null
}

// The single generic write seam (CASE-482): mint a per-type number when the type
// has write config (resolve-then-mint by its search key), else upsert by the
// template's natural identity. Every write verb routes through here — no bespoke
// per-type mint/upsert logic survives in the handlers.
async function genericWrite(type: string, data: AnyObj, opts: { metadata?: AnyObj; ns: string; key: string }): Promise<{ document_id: string; result: string; number?: number; synonym?: string }> {
  const { ns, key, metadata } = opts
  const cfg = await writeConfig(type, ns, key)
  if (cfg) {
    const searchFilters = cfg.searchKey.map((f) => ({ field: `data.${f}`, operator: 'eq', value: data[f] }))
    const m = await mintNumberedDoc({
      templateValue: type, numberField: cfg.numberField, synonymPrefix: cfg.prefix,
      searchFilters, data, metadata, ns, key,
      scopeField: cfg.scopeField, synonymTemplate: cfg.synonymTemplate,
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

// Resolve a logical reference to a document_id, generically: query the target
// template by its FIRST-CLASS identity field (identity_fields[0]). No per-type
// knowledge — the schema says how a type is identified. (CASE-482 edge-intent.)
async function resolveRef(targetType: string, targetKey: unknown, ns: string, key: string): Promise<string | null> {
  const t = await getTemplate(targetType, ns, key)
  const idField = (t.identity_fields || [])[0]
  if (!idField || targetKey === undefined || targetKey === null) return null
  const q = await wipReq('POST', `/api/document-store/documents/query?namespace=${ns}`, key, {
    template_id: targetType,
    filters: [{ field: `data.${idField}`, operator: 'eq', value: targetKey }],
    page: 1, page_size: 1,
  })
  return (q.items || [])[0]?.document_id || null
}

// Persist one edge (source -> target) of an edge type. Idempotent: edge identity
// is [source_ref, target_ref], versioned:false → re-writes overwrite in place.
async function writeEdge(edgeType: string, sourceId: string, targetId: string, ns: string, key: string): Promise<void> {
  const tid = await templateId(edgeType, ns, key)
  const d = await wipReq('POST', '/api/document-store/documents', key, [{
    template_id: tid, namespace: ns, created_by: 'kb-gateway',
    data: { source_ref: sourceId, target_ref: targetId },
    metadata: { edge_kind: edgeType, loader: 'kb-gateway' },
  }])
  const r = (d.results || [])[0] || {}
  if (!['created', 'updated', 'unchanged', 'skipped'].includes(r.status))
    throw new WipError(502, `${edgeType} edge failed: ${r.error || JSON.stringify(r)}`)
}

// Apply a list of logical edge-intents from a just-written source doc. Each is
// { type, target_type, target_key }; the source is always the written doc
// (source -> target). Unresolved targets are reported, not fatal (mirrors the
// loaders' "prior not present yet -> skipped; converges on re-write").
async function applyEdges(sourceId: string, edges: AnyObj[], ns: string, key: string): Promise<AnyObj[]> {
  const out: AnyObj[] = []
  for (const e of edges) {
    const targetId = await resolveRef(String(e.target_type), e.target_key, ns, key)
    if (!targetId) { out.push({ type: e.type, target_key: e.target_key, status: 'target_not_found' }); continue }
    await writeEdge(String(e.type), sourceId, targetId, ns, key)
    out.push({ type: e.type, target_key: e.target_key, status: 'linked' })
  }
  return out
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

// POST /write/:type — the single typed-write surface (CASE-482). Structured data
// in (the client owns all source parsing/validation); the gateway persists:
// mint or natural-upsert per the type's WRITE_POLICY, then links any edge-intents.
// Two shapes:
//   create/upsert: { data: {...}, metadata?, edges?: [{type, target_type, target_key}] }
//   partial patch: { patch: {...}, match: {<field>: value} } — resolve the doc by
//                  the match field, apply an RFC-7396 merge patch (if_match + retry
//                  on concurrency). Used for field updates like a case status change.
// Each edge is written source(the new doc) -> target(resolved by the target
// type's identity field). Unresolved targets are reported, not fatal.
router.post('/write/:type', async (req, res) => {
  const key = callerKey(req, res)
  if (!key) return
  const ns = String(req.query.namespace || NS_DEFAULT)
  const type = req.params.type
  const b: AnyObj = req.body || {}

  // --- patch mode: partial update of an existing doc, located by a match field ---
  if (b.patch && typeof b.patch === 'object' && !Array.isArray(b.patch)) {
    const match: AnyObj = b.match || {}
    const mf = Object.keys(match)[0]
    if (!mf) {
      res.status(422).json({ error: 'patch requires match: {<field>: value} to locate the doc' })
      return
    }
    try {
      for (let attempt = 0; attempt < PATCH_MAX_RETRIES; attempt++) {
        const q = await wipReq('POST', `/api/document-store/documents/query?namespace=${ns}`, key,
          { template_id: type, filters: [{ field: `data.${mf}`, operator: 'eq', value: match[mf] }], page: 1, page_size: 1 })
        const doc = (q.items || [])[0]
        if (!doc) {
          res.status(404).json({ error: `${type} where ${mf}=${match[mf]} not found in ${ns}` })
          return
        }
        const d = await wipReq('PATCH', `/api/document-store/documents?namespace=${ns}`, key,
          [{ document_id: doc.document_id, patch: b.patch, if_match: doc.version }])
        const r = (d.results || [])[0] || {}
        if (r.status === 'updated' || r.status === 'unchanged') {
          res.json({ type, document_id: doc.document_id, result: r.status, patched: true })
          return
        }
        if (r.error_code === 'concurrency_conflict') continue
        res.status(statusForErrorCode(r.error_code)).json({
          error_code: r.error_code || undefined,
          error: `${type} patch failed: ${r.error || JSON.stringify(r)}`,
        })
        return
      }
      res.status(409).json({ error: `${type} patch still conflicting after ${PATCH_MAX_RETRIES} retries` })
    } catch (e) {
      res.status(e instanceof WipError ? e.status : 500).json({ error: (e as Error).message })
    }
    return
  }

  // --- create / upsert mode ---
  const data: AnyObj = b.data || {}
  if (typeof data !== 'object' || Array.isArray(data) || !Object.keys(data).length) {
    res.status(422).json({ error: 'data (non-empty object) is required' })
    return
  }
  const edges: AnyObj[] = Array.isArray(b.edges) ? b.edges : []
  try {
    const w = await genericWrite(type, data, { metadata: b.metadata, ns, key })
    const edgeResults = edges.length ? await applyEdges(w.document_id, edges, ns, key) : []
    res.json({ type, ...w, ...(edges.length ? { edges: edgeResults } : {}) })
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
  // status accepts a comma list (eq for one, in for many); the rest are exact
  // matches on the first-class CASE_RECORD facets (CASE-482 — server-side
  // faceted filtering so the client never queries the store directly).
  if (req.query.status) {
    const vals = String(req.query.status).split(',').map((s) => s.trim()).filter(Boolean)
    if (vals.length === 1) filters.push({ field: 'data.status', operator: 'eq', value: vals[0] })
    else if (vals.length > 1) filters.push({ field: 'data.status', operator: 'in', value: vals })
  }
  for (const f of ['filed_by', 'severity', 'type', 'component', 'app']) {
    if (req.query[f]) filters.push({ field: `data.${f}`, operator: 'eq', value: String(req.query[f]) })
  }
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

// GET /types — the doc-type manifest the write client lists/validates against
// (CASE-482). Entity templates only; write_mode is derived from the same
// metadata.custom.write the gateway mints from ('mint' when present, else
// 'natural' upsert by identity). The schema is the single source — this just
// surfaces it, so the client never hand-maintains a type list.
router.get('/types', async (req, res) => {
  const key = callerKey(req, res)
  if (!key) return
  const ns = String(req.query.namespace || NS_DEFAULT)
  try {
    const [d, policies] = await Promise.all([
      wipReq('GET', `/api/template-store/templates?namespace=${ns}&page_size=100`, key),
      loadPolicies(ns, key),
    ])
    const types = (d.items || [])
      .filter((t: AnyObj) => (t.usage || 'entity') !== 'relationship')
      .map((t: AnyObj) => {
        const cfg = policies.get(t.value)
        return {
          type: t.value,
          label: t.label || t.value,
          write_mode: cfg ? 'mint' : 'natural',
          synonym_prefix: cfg?.prefix || null,
          identity_fields: t.identity_fields || [],
        }
      })
      .sort((a: AnyObj, b: AnyObj) => String(a.type).localeCompare(String(b.type)))
    res.json({ namespace: ns, total: types.length, types })
  } catch (e) {
    res.status(e instanceof WipError ? 502 : 500).json({ error: (e as Error).message })
  }
})

export default router
