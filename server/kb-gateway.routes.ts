// KB write-gateway (CASE-464 Phase 1): domain write verbs for cases.
// "No script writes directly to WIP — it goes through the app that owns the
// domain" (Peter, 2026-06-03/12; spec: FR-YAC/papers/kb-write-gateway-design.md).
//
//   POST {BASE_PATH}/server-api/kb/cases                 -> allocate + create (file flow)
//   (case respond/comment/close/implement/reopen all ride POST /write/:type —
//   a CASE_RESPONSE doc plus a CASE_RECORD status patch; the per-case POST
//   verbs that once lived here are retired. Transition VALIDITY is enforced
//   caller-side by the served playbook; this gateway persists what it is sent.)
//
// Design rules (the case response is the contract):
// - UN-PRIVILEGED: every WIP call executes with the CALLER's X-API-Key. The
//   gateway adds domain semantics, never privilege; authz stays platform-side.
// - Thin-wrapper discipline: every endpoint = orchestrate N existing WIP calls
//   + enforce one domain rule. No state lives here.
// - Append semantics via the platform's if_match optimistic concurrency: a
//   comment/response POST re-reads and retries on concurrency_conflict, so two
//   agents writing the same case both land (the CASE-462 race class).
// - Status-transition validity is the CALLER's job (served playbook); the
//   gateway persists any status the schema accepts. It stopped being a
//   server-side machine when the per-case verbs retired into /write/:type.
// - Mounted PUBLIC (before requireAuth) like kb-client.routes; the gateway
//   browser-auth exemption is the manifest route line (CASE-439 pattern).
import { createHash } from 'node:crypto'
import { Router, type Request, type Response } from 'express'

const WIP_BASE = (process.env.WIP_BASE_URL || 'https://wip-kb.local').replace(/\/$/, '')
// The gateway's default namespace is the KB corpus (cases, decisions, …).
// Env-driven so a deployment / dev branch points at its own corpus namespace
// (kb-libdev on lib-dev). The ?namespace= override still rides every handler.
const NS_DEFAULT = process.env.WIP_NAMESPACE || 'kb'
// The Library namespace (CASE-518). When set, a write whose TYPE is owned by the
// Library namespace routes there — the gateway is the single receive surface for
// both namespaces, agnostic to who produces the doc or how. Empty = single-namespace.
const NS_LIBRARY = process.env.KB_LIBRARY_NAMESPACE || 'library'
// Type discovery is metadata, not data: `/types` enumerates with the gateway's own
// key (the cross-namespace key the proxy uses to browse both namespaces) so a
// namespace-SCOPED caller still sees every writable type — including Library types
// whose namespace their own key can't LIST (CASE-573). Empty in dev without
// WIP_API_KEY → the handler falls back to the caller's key (original behaviour).
const GATEWAY_KEY = process.env.WIP_API_KEY || ''
const ALLOC_MAX_RETRIES = 100
const PATCH_MAX_RETRIES = 3


type AnyObj = Record<string, any>

class WipError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

/**
 * HTTP status for an error escaping a route handler.
 *
 * `WipError` has always carried a status and the handlers used to discard it,
 * answering a flat 502 for everything. That made a rejection the CALLER must fix
 * indistinguishable from a transient upstream blip — so a client retried it, got
 * the identical refusal, and retried again. A 4xx the write path chose
 * deliberately now survives to the wire.
 *
 * Anything else from a WipError is an upstream failure and stays 502 rather than
 * passing the platform's own status through: a 500 from document-store is not
 * this gateway failing, and answering 500 would claim it was.
 */
function errStatus(e: unknown): number {
  if (!(e instanceof WipError)) return 500
  return e.status >= 400 && e.status < 500 ? e.status : 502
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

// Type → home namespace (CASE-518). A doc type lives in exactly one configured
// namespace; the gateway routes a write there so a producer just says "write a
// LIBRARY_DOC" without knowing namespaces. Library-owned types (LIBRARY_DOC, …)
// route to NS_LIBRARY authoritatively — a LIBRARY_DOC can only live there, so an
// inbound ?namespace= pin (the kb-client always sends its configured one) must not
// misroute it. Everything else keeps the corpus default + ?namespace= override.
// Cached per type (a template's home doesn't move).
// Positive-only cache (CASE-518 review #5): we cache only types KNOWN to be
// Library-owned. A negative is NOT cached — otherwise a LIBRARY_DOC write attempted
// before the Library template exists would cache `false` forever and route to the
// corpus until process restart. Re-checking a miss each time is cheap and correct.
const libTypeCache = new Set<string>()
async function libraryOwnsType(type: string, key: string): Promise<boolean> {
  if (!NS_LIBRARY) return false
  if (libTypeCache.has(type)) return true
  const t = await wipReq('GET', `/api/template-store/templates/by-value/${type}?namespace=${NS_LIBRARY}`, key)
    .catch(() => null)
  const owns = !!(t && (t.id || t.template_id))
  if (owns) libTypeCache.add(type)
  return owns
}
async function resolveWriteNs(type: string, reqNs: string | undefined, key: string): Promise<string> {
  if (await libraryOwnsType(type, key)) return NS_LIBRARY
  return reqNs || NS_DEFAULT
}

// Registry synonym -> document_id (the v2 resolution handle, CASE-425). Every minted
// handle resolves through this one lookup — CASE-<n>, FIRESIDE-<n>, LESSON-<n>,
// DECISION-<n>, PAPER-<n> — so a read route accepts any valid handle for a document
// exactly as it accepts the canonical id (Vision.md, "References Must Resolve").
async function resolveSynonym(value: string, ns: string, key: string): Promise<string | null> {
  const d = await wipReq('POST', '/api/registry/entries/lookup/by-key', key, [{
    namespace: ns, entity_type: 'documents',
    composite_key: { value }, search_synonyms: true,
  }])
  const r = (d.results || [])[0] || {}
  return r.status === 'found' ? r.entry_id : null
}
const resolveCase = (n: number, ns: string, key: string) => resolveSynonym(`CASE-${n}`, ns, key)

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
// --- content identity -------------------------------------------------------
// A content hash and an identity are different keys and neither can do the
// other's job. Identity must survive an edit (it is what makes the edit a new
// VERSION rather than a new document); a content hash must change on every edit,
// which is the property identity must not have. Using a hash as identity would
// fork a document on every save — PoNIF #3's "never put changing data in
// identity fields" wearing a different hat.
//
// So this hash never touches identity. It answers one question the address
// cannot: are two records holding the same bytes under two different
// identities? That is the shape a mis-derived address produces, and it is
// invisible to a search key that is itself derived from the bad address.
//
// Computed here, over the body the KB actually stores, rather than requiring
// writers to send one — every writer gets the guard, including the browser, and
// nothing has to be rolled out first. A git blob id (`git hash-object`) is the
// better key for comparing against a file ON DISK and belongs in
// `synced_from_sha`, which is a separate question from this one.
const CONTENT_HASHED_TYPES = new Set(['DOCUMENT'])

function contentHash(body: unknown): string | null {
  if (typeof body !== 'string' || !body) return null
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

/**
 * The repo-relative path — a document's address WITHIN its repository, once
 * `repo_id` says which repository that is.
 *
 * Mirrors prefix the path with the repo directory name, which is the same
 * checkout-dependent string that forked this corpus. Deriving the tail here
 * means a writer can send either form and land on the same address, so the
 * store's key and the writer's paths never have to change in step.
 *
 * Conditional on purpose. PAPER-1 predates the prefixing convention and is
 * already repo-relative ("papers/…" under origin FR-YAC): an unconditional
 * "strip the first segment" would turn it into a path no document has. Strip
 * only when the prefix is actually the origin, which also makes this idempotent.
 */
function pathTail(path: unknown, repoOrigin: unknown): string | null {
  if (typeof path !== 'string' || !path) return null
  if (typeof repoOrigin !== 'string' || !repoOrigin) return path
  const prefix = `${repoOrigin}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

/**
 * Refuse to mint a NEW identity for content that already exists under another
 * one. Returns the offending doc when the write should be rejected.
 *
 * Deliberately scoped to the mint-a-new-number path: re-writing the same content
 * to the SAME identity is an upsert and must stay one. Only the branch that is
 * about to allocate a fresh number asks this question.
 */
async function findContentTwin(
  templateValue: string, hash: string, numberField: string, ns: string, key: string,
): Promise<AnyObj | null> {
  const q = await wipReq('POST', `/api/document-store/documents/query?namespace=${ns}`, key, {
    template_id: templateValue,
    filters: [{ field: 'data.content_hash', operator: 'eq', value: hash }],
    page: 1, page_size: 1,
  }).catch(() => null)
  const hit = (q?.items || [])[0]
  return hit && typeof hit.data?.[numberField] === 'number' ? hit : null
}

// Fields the KB CURATES and no source repo knows about. A write is a full
// replace of `data`, so any such field the writer omits is destroyed — and the
// writers that omit them are exactly the ones that cannot know them.
//
// `topics` is the case that bit: the drift gate mirrors a paper with
//   kbc kb-write.py DOCUMENT <file> --field path= --field repo_origin= \
//                                   --field repo_id= --field kind=
// and the paper's own frontmatter carries no `topics:` line, so every re-mirror
// of a changed paper silently cleared its tags. derivedTopics() could not save
// them: it derives from the INCOMING data's component/app, which DOCUMENT does
// not have, and never reads the document already in the store.
//
// This is the loss that was blamed on migrate-then-PATCH and went undiagnosed
// through two sessions. Neither of those drops anything — measured across 103
// papers, every data key preserved. The mirror upsert did, quietly, on every run.
const CURATED_FIELDS = ['topics']

function carryCurated(data: AnyObj, existing: AnyObj | undefined): AnyObj {
  if (!existing?.data) return data
  let out = data
  for (const f of CURATED_FIELDS) {
    const incoming = out[f]
    const has = Array.isArray(incoming) ? incoming.length > 0 : incoming !== undefined && incoming !== null && incoming !== ''
    if (has) continue                      // an explicit value always wins
    const prior = existing.data[f]
    const priorHas = Array.isArray(prior) ? prior.length > 0 : prior !== undefined && prior !== null && prior !== ''
    if (priorHas) out = { ...out, [f]: prior }
  }
  return out
}

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

  // An explicit number is a CORRECTION, not an allocation.
  //
  // Without this branch the gateway decides the number solely from search_key, on
  // both paths — match reuses the FOUND document's number, no-match allocates a
  // fresh one — so a caller-supplied number is discarded either way. That is what
  // makes an address change impossible: move a paper between repositories and the
  // probe misses, so naming the document you meant to update gets you a NEW one
  // instead. The corpus grows a duplicate at precisely the moment someone was
  // trying to correct it.
  //
  // The platform has no such difficulty. identity_fields is [numberField], so a
  // write carrying that number is an ordinary identity upsert — same hash, new
  // version, same document_id, existing Registry synonym still resolving. The
  // gateway was the only thing in the way.
  //
  // Only an EXISTING number is honoured. Accepting any number would let a caller
  // invent one and leave a gap behind it, which is the "never reason about the
  // next number" rule the mint exists to enforce: allocation stays the gateway's
  // job, correction becomes the caller's.
  //
  // The content-twin guard below is deliberately NOT applied here. It defends the
  // allocation of a new identity; re-writing content to the address it already
  // occupies is an upsert, not a fork.
  const explicit = data[numberField]
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    const q = await wipReq('POST', `/api/document-store/documents/query?namespace=${ns}`, key,
      { template_id: templateValue, page: 1, page_size: 1,
        filters: [{ field: `data.${numberField}`, operator: 'eq', value: explicit }] })
    const target = (q.items || [])[0]
    if (!target) {
      throw new WipError(422,
        `${templateValue} refused: ${numberField}=${JSON.stringify(explicit)} does not exist. `
        + `An explicit ${numberField} UPDATES the document that already carries it — it cannot allocate a `
        + `new one, because allocation is the gateway's job and a caller-chosen number leaves a gap. `
        + `Omit ${numberField} to have the next one assigned.`)
    }
    const d = await wipReq('POST', '/api/document-store/documents', key, [{
      template_id: tid, namespace: ns, created_by: 'kb-gateway',
      data: carryCurated(data, target), ...meta,
    }])
    const r = (d.results || [])[0] || {}
    if (!['created', 'updated', 'unchanged', 'skipped'].includes(r.status))
      throw new WipError(502, `${templateValue} update at ${numberField}=${explicit} failed: ${r.error || JSON.stringify(r)}`)
    return {
      number: Number(explicit), synonym: buildSynonym(synCfg, Number(explicit), data),
      document_id: r.document_id, result: r.status,
    }
  }

  if (searchFilters.length) {
    const q = await wipReq('POST', `/api/document-store/documents/query?namespace=${ns}`, key,
      { template_id: templateValue, filters: searchFilters, page: 1, page_size: 1 })
    const existing = (q.items || [])[0]
    if (existing && typeof existing.data?.[numberField] === 'number') {
      const num = existing.data[numberField]
      const d = await wipReq('POST', '/api/document-store/documents', key, [{
        template_id: tid, namespace: ns, created_by: 'kb-gateway',
        data: { ...carryCurated(data, existing), [numberField]: num }, ...meta,
      }])
      const r = (d.results || [])[0] || {}
      if (!['created', 'updated', 'unchanged', 'skipped'].includes(r.status))
        throw new WipError(502, `${templateValue} re-mint failed: ${r.error || JSON.stringify(r)}`)
      return { number: num, synonym: buildSynonym(synCfg, num, data), document_id: r.document_id, result: r.status }
    }
  }

  // About to allocate a NEW identity. If these exact bytes already live under a
  // different one, that is a fork — almost always a mis-derived address (a
  // second clone, a rename) rather than a genuinely new document. Reject with
  // the existing handle so the writer can correct the address instead of the
  // corpus growing a second answer to the same question. CASE-825: eighteen
  // papers were minted this way, silently, and each clone's own gate then read
  // its own set as clean.
  const twinHash = data.content_hash
  if (typeof twinHash === 'string' && twinHash) {
    const twin = await findContentTwin(templateValue, twinHash, numberField, ns, key)
    if (twin) {
      const handle = buildSynonym(synCfg, twin.data[numberField], twin.data)
      throw new WipError(409,
        `${templateValue} refused: identical content already exists as ${handle} `
        + `(${Object.entries(searchFilters.reduce((a: AnyObj, f: AnyObj) => (a[String(f.field).replace(/^data\./, '')] = f.value, a), {}))
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')} did not match it). `
        + `Writing the same content under a second identity forks the corpus; correct the address, or PATCH ${handle}.`)
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
type MintCfg = { numberField: string; prefix: string; searchKey: string[]; searchKeyFallback?: string[]; scopeField?: string; synonymTemplate?: string }
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
          searchKeyFallback: p.search_key_fallback || undefined,
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

// --- topic fallback -------------------------------------------------------
// A doc whose template offers a topic field but whose author left it empty is
// invisible to topic navigation, and the facet is only as good as its coverage.
// So a write with no topics gets a baseline derived from the facets the doc
// already carries.
//
// The component/app -> topic mapping is NOT held here. It lives in the topic
// vocabulary itself, as term aliases: the term `mcp` carries the alias
// `mcp-server`, so a case filed against component `mcp-server` resolves to it.
// That keeps one statement of the mapping — adding an alias to the vocabulary
// teaches every writer at once, and there is no second copy in this file to
// drift out of step with it.
//
// Which vocabulary is likewise read off the template's own field definition
// rather than named here, so this code carries no knowledge of a specific
// terminology, only of the shape "an array-of-terms field called topics".
const TOPIC_FIELD = 'topics'
// Deliberately a short, closed list rather than "every field that happens to
// resolve": a facet not meant as a subject would tag documents silently and
// wrongly, and a wrong topic is worse than a missing one because it surfaces
// the doc under a subject it has nothing to do with.
const TOPIC_SOURCE_FIELDS = ['component', 'app']
const TOPIC_MAX = 6

// value-or-alias (lowercased) -> canonical term value, per terminology.
// `null` caches "this template has no topic field", so the common case costs
// nothing after the first write.
const topicVocabCache = new Map<string, Map<string, string> | null>()

async function topicVocab(tpl: AnyObj, ns: string, key: string): Promise<Map<string, string> | null> {
  const field = (tpl.fields || []).find((f: AnyObj) => f.name === TOPIC_FIELD && f.array_item_type === 'term')
  const ref = field?.array_terminology_ref
  if (!ref) return null
  const ck = `${ns}/${ref}`
  if (topicVocabCache.has(ck)) return topicVocabCache.get(ck) || null
  try {
    // Terms must be listed from the namespace that OWNS the terminology. A
    // cross-namespace list (library asking for a kb vocabulary) answers 200
    // with zero items rather than an error, which would read as "no aliases
    // are configured" and silently disable the fallback. The terminology
    // resolves from any namespace and reports its home, so ask it first.
    const term = await wipReq('GET', `/api/def-store/terminologies/${ref}?namespace=${ns}`, key)
    const homeNs = term.namespace || ns
    const d = await wipReq('GET',
      `/api/def-store/terminologies/${ref}/terms?namespace=${homeNs}&page_size=1000`, key)
    const items: AnyObj[] = d.items || []
    if (!items.length) {
      // Distinguish "vocabulary is empty" from "every doc happens to be
      // untaggable" — the two look identical downstream.
      console.warn(`[kb-gateway] topic vocabulary ${ref} resolved to 0 terms in ${homeNs}; topic fallback disabled`)
      topicVocabCache.set(ck, null)
      return null
    }
    const m = new Map<string, string>()
    for (const t of items) {
      const v = String(t.value)
      m.set(v.toLowerCase(), v)
      for (const a of (t.aliases || [])) m.set(String(a).toLowerCase(), v)
    }
    topicVocabCache.set(ck, m)
    return m
  } catch (e) {
    // A transient def-store failure must not fail the write — the doc is still
    // correct without topics, and the sweep re-tags it later. Not cached, so
    // the next write retries.
    console.warn(`[kb-gateway] topic vocabulary ${ref} unreadable; writing without topics: ${(e as Error).message}`)
    return null
  }
}

// Returns the topics to write, or null to leave the field alone. An explicit
// value always wins: the author said what the doc is about, and a derived
// baseline must never overwrite that.
async function derivedTopics(tpl: AnyObj, data: AnyObj, ns: string, key: string): Promise<string[] | null> {
  const supplied = data[TOPIC_FIELD]
  if (Array.isArray(supplied) ? supplied.length : supplied != null) return null
  const vocab = await topicVocab(tpl, ns, key)
  if (!vocab) return null
  const out: string[] = []
  for (const f of TOPIC_SOURCE_FIELDS) {
    const raw = data[f]
    if (typeof raw !== 'string') continue
    // component is a comma list on some types and a single value on others.
    for (const part of raw.split(',')) {
      const hit = vocab.get(part.trim().toLowerCase())
      if (hit && !out.includes(hit)) out.push(hit)
    }
  }
  return out.length ? out.slice(0, TOPIC_MAX) : null
}

// The single generic write seam (CASE-482): mint a per-type number when the type
// has write config (resolve-then-mint by its search key), else upsert by the
// template's natural identity. Every write verb routes through here — no bespoke
// per-type mint/upsert logic survives in the handlers.
async function genericWrite(type: string, data: AnyObj, opts: { metadata?: AnyObj; ns: string; key: string }): Promise<{ document_id: string; result: string; number?: number; synonym?: string }> {
  const { ns, key, metadata } = opts
  // Derive here rather than in the route handler so every writer gets the same
  // baseline — the served client, the browser bridge, and anything added later
  // — instead of each having to remember to tag.
  const topics = await derivedTopics(await getTemplate(type, ns, key), data, ns, key)
  if (topics) data = { ...data, [TOPIC_FIELD]: topics }
  // Stamp the content hash before the write so the value stored and the value
  // the fork guard compares are the same one, always, for every writer.
  if (CONTENT_HASHED_TYPES.has(type) && data.content_hash === undefined) {
    const h = contentHash(data.body)
    if (h) data = { ...data, content_hash: h }
  }
  // Derive the repo-relative path. Both the prefixed form a mirror sends today
  // and a bare repo-relative one land on the same value, so writers never have
  // to change in step with the store — the coordination this would otherwise
  // need is deleted rather than scheduled.
  if (CONTENT_HASHED_TYPES.has(type) && data.path_tail === undefined) {
    const t = pathTail(data.path, data.repo_origin)
    if (t) data = { ...data, path_tail: t }
  }
  const cfg = await writeConfig(type, ns, key)
  if (cfg) {
    // A search key is only usable if the incoming write carries every component.
    // When it does not — an older writer that has not started sending repo_id —
    // fall back to the key the policy declares for that case rather than
    // filtering on undefined, which matches nothing and mints a duplicate. That
    // is the CASE-825 failure re-created by the fix meant to prevent it.
    const complete = (k: string[]) => k.length > 0 && k.every((f) => data[f] !== undefined && data[f] !== null && data[f] !== '')
    const effectiveKey = complete(cfg.searchKey) ? cfg.searchKey
      : (complete(cfg.searchKeyFallback || []) ? cfg.searchKeyFallback! : cfg.searchKey)
    if (effectiveKey !== cfg.searchKey) {
      console.warn(`[kb-gateway] ${type}: search key ${JSON.stringify(cfg.searchKey)} incomplete on this write; `
        + `falling back to ${JSON.stringify(effectiveKey)}`)
    }
    const searchFilters = effectiveKey.map((f) => ({ field: `data.${f}`, operator: 'eq', value: data[f] }))
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
// Edge-write REJECTIONS are per-edge too (CASE-630): the source doc and any
// earlier edges have already persisted, so aborting the request as a 5xx made
// the caller misread a validation rejection as transport failure and retry
// with a duplicating re-post. The write returns 200 with per-edge status —
// the platform's own bulk-first convention — and a failed intent is retried
// via POST /edges, not by re-creating the document.
async function applyEdges(sourceId: string, edges: AnyObj[], ns: string, key: string): Promise<AnyObj[]> {
  const out: AnyObj[] = []
  for (const e of edges) {
    const targetId = await resolveRef(String(e.target_type), e.target_key, ns, key)
    if (!targetId) { out.push({ type: e.type, target_key: e.target_key, status: 'target_not_found' }); continue }
    try {
      await writeEdge(String(e.type), sourceId, targetId, ns, key)
      out.push({ type: e.type, target_key: e.target_key, status: 'linked' })
    } catch (err) {
      out.push({ type: e.type, target_key: e.target_key, status: 'error', error: (err as Error).message })
    }
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
  const type = req.params.type
  // Route by the type's home namespace (CASE-518): Library-owned types → the
  // Library namespace, everything else → corpus (with the ?namespace= override).
  let ns: string
  try {
    ns = await resolveWriteNs(type, req.query.namespace ? String(req.query.namespace) : undefined, key)
  } catch (e) {
    const we = e as WipError
    return res.status(we.status || 502).json({ error: we.message })
  }
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
        // match on document_id fetches directly — the escape hatch for types
        // whose identity is composite (FLAG_RECORD: [flag_type, flagged_document]),
        // where no single data field locates the doc. The flags dispatcher
        // consumes a flag by the id the /flags projection returned.
        let doc: AnyObj | undefined
        if (mf === 'document_id') {
          try {
            doc = await wipReq('GET', `/api/document-store/documents/${match[mf]}?namespace=${ns}`, key)
          } catch { /* not found → 404 below */ }
        } else {
          const q = await wipReq('POST', `/api/document-store/documents/query?namespace=${ns}`, key,
            { template_id: type, filters: [{ field: `data.${mf}`, operator: 'eq', value: match[mf] }], page: 1, page_size: 1 })
          doc = (q.items || [])[0]
        }
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
      res.status(errStatus(e)).json({ error: (e as Error).message })
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
    res.status(errStatus(e)).json({ error: (e as Error).message })
  }
})

// GET /read/:type — the generic typed-READ surface, symmetric to POST /write/:type
// (CASE-683). Read/write parity as an invariant: every type the client can WRITE it
// can READ, by construction — no bespoke per-type endpoint, so a new type is readable
// the day it becomes writable. The purpose-built read verbs (/cases, /journeys/:day,
// /firesides, /library-docs, /sessions, /flags) keep their earned projections; this is
// the long-tail floor, deliberately shapeless. Every non-reserved query param becomes
// an eq-filter on data.<param>, so a type's identity fields filter for free
// (/read/YAC_MEMORY?owner=FRanC, /read/GIT_STATS_SNAPSHOT?snapshot_date=…&repo=…) with
// zero per-type code. Namespace routing reuses the write side's resolver (CASE-518),
// so DOCUMENT (papers) and Library-owned types land in the right namespace. Rows are
// returned raw — no shaping. Default read-allowed for every real type; a per-type read
// policy is a knob to add THEN if a type ever needs restricted reads, not now.
const READ_RESERVED = new Set(['namespace', 'page', 'page_size'])
router.get('/read/:type', async (req, res) => {
  const key = callerKey(req, res)
  if (!key) return
  const type = req.params.type
  const reqNs = req.query.namespace ? String(req.query.namespace) : undefined
  let ns: string
  try {
    ns = await resolveWriteNs(type, reqNs, key)
  } catch (e) {
    return res.status((e as WipError).status || 502).json({ error: (e as Error).message })
  }
  // Validate the type resolves to a real template → a clean 404 for unknown types,
  // rather than an opaque store error on template_id.
  try {
    await templateId(type, ns, key)
  } catch {
    return res.status(404).json({ error: `unknown type '${type}' in namespace ${ns}` })
  }
  const { page, pageSize } = pageParams(req)
  const filters: AnyObj[] = []
  for (const [k, v] of Object.entries(req.query)) {
    if (READ_RESERVED.has(k) || v == null) continue
    const s = String(v).trim()
    // Query params always arrive as strings, but a mint type's <type>_number identity
    // field is stored as a JSON number — an eq against the string form can never match,
    // which silently made every numeric identity field unfilterable. Match BOTH
    // representations via `in` so a genuinely-string field that happens to hold digits
    // keeps matching too. The round-trip check (String(n) === s) keeps non-canonical
    // forms ("007", "1e3") on the string path, where they belong.
    const n = Number(s)
    if (s !== '' && Number.isFinite(n) && String(n) === s)
      filters.push({ field: `data.${k}`, operator: 'in', value: [s, n] })
    else
      filters.push({ field: `data.${k}`, operator: 'eq', value: String(v) })
  }
  try {
    const d = await wipReq('POST', `/api/document-store/documents/query?namespace=${ns}`, key,
      { template_id: type, filters, page, page_size: pageSize })
    res.json({
      type, namespace: ns, total: d.total, page: d.page, pages: d.pages,
      items: (d.items || []).map((it: AnyObj) => ({
        document_id: it.document_id, version: it.version,
        data: it.data || {}, metadata: it.metadata || {},
        created_at: it.created_at, updated_at: it.updated_at,
      })),
    })
  } catch (e) {
    res.status(errStatus(e)).json({ error: (e as Error).message })
  }
})

// ---------------------------------------------------------------------------
// Edge surface (CASE-630): attach/inspect edges on EXISTING docs — the
// sanctioned recovery for a failed edge intent from /write/:type (before this,
// the only "retry" was a duplicating document re-post).

// Resolve a doc handle to a document_id: a raw id passes through; anything
// else resolves as a Registry synonym (the CASE-425 pattern) — CASE-627,
// the scoped CASE-629#1, LESSON-12, etc. Session ids are NOT synonyms:
// SESSION mirrors are upserted by their natural identity (data.session_id)
// and never claim a Registry entry, so a session-id-shaped handle that
// misses the synonym lookup falls back to the same identity-field query the
// write path's edge intents use (CASE-669 — the read path previously
// covered only synonyms, making session ids unresolvable despite being
// documented handles).
async function resolveHandle(handle: string, ns: string, key: string): Promise<string | null> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(handle)) return handle
  const d = await wipReq('POST', '/api/registry/entries/lookup/by-key', key, [{
    namespace: ns, entity_type: 'documents',
    composite_key: { value: handle }, search_synonyms: true,
  }])
  const r = (d.results || [])[0] || {}
  if (r.status === 'found') return r.entry_id
  // <ROLE>-<YYYYMMDD>-<HHMMSS> (legacy sessions used minute precision).
  if (/^[a-z][a-z0-9-]*-\d{8}-\d{4,6}$/i.test(handle)) {
    return resolveRef('SESSION', handle, ns, key)
  }
  return null
}

// POST /edges  { type, source, target } — source/target are document_ids or
// Registry synonyms. Naturally idempotent: the KB edge types are
// versioned:false with identity [source_ref, target_ref], so re-adding an
// existing edge overwrites in place (status 'linked' either way).
router.post('/edges', async (req, res) => {
  const key = callerKey(req, res)
  if (!key) return
  const b: AnyObj = req.body || {}
  const type = String(b.type || '').trim()
  const source = String(b.source || '').trim()
  const target = String(b.target || '').trim()
  if (!type || !source || !target) {
    return res.status(422).json({ error: 'type, source and target are required' })
  }
  const ns = String(req.query.namespace || NS_DEFAULT)
  try {
    const sourceId = await resolveHandle(source, ns, key)
    if (!sourceId) return res.status(404).json({ error: `source ${source} not found in ${ns}` })
    const targetId = await resolveHandle(target, ns, key)
    if (!targetId) return res.status(404).json({ error: `target ${target} not found in ${ns}` })
    await writeEdge(type, sourceId, targetId, ns, key)
    res.json({ type, source, target, source_id: sourceId, target_id: targetId, status: 'linked' })
  } catch (e) {
    // writeEdge failures are platform VALIDATION rejections (e.g. endpoint
    // family), not transport — 422, with the platform's message passed through.
    const msg = (e as Error).message
    res.status(e instanceof WipError ? 422 : 500).json({ error: msg })
  }
})

// GET /edges/:handle — every edge touching the doc (either direction), so a
// failed/forgotten intent is diagnosable without a raw document-store read.
router.get('/edges/:handle', async (req, res) => {
  const key = callerKey(req, res)
  if (!key) return
  const ns = String(req.query.namespace || NS_DEFAULT)
  try {
    const id = await resolveHandle(String(req.params.handle), ns, key)
    if (!id) return res.status(404).json({ error: `${req.params.handle} not found in ${ns}` })
    const d = await wipReq('GET', `/api/document-store/documents/${id}/relationships?namespace=${ns}`, key)
    res.json({ handle: req.params.handle, document_id: id, relationships: d })
  } catch (e) {
    res.status(errStatus(e)).json({ error: (e as Error).message })
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
    res.status(errStatus(e)).json({ error: (e as Error).message })
  }
})

// GET /flags?target_yac=&doc_status=&target_type=&page=&page_size=
// The flag-for-YAC read surface for the deterministic dispatcher: FLAG_RECORD
// projections joined to their flagged target, so a poller gets actionable rows
// (case_number included when the target is a case) in one call.
// Lifecycle contract: doc_status 'published' = pending dispatch (the default
// filter); the dispatcher marks a flag consumed by patching it to 'dispatched'
// via /write/FLAG_RECORD with match: {document_id: <flag_id>}. Re-flagging in
// the UI upserts the same identity back to published (re-arms the trigger).
// doc_status=all disables the status filter. target_type filters on the
// RESOLVED target's template value post-query, so `total` reflects the status/
// yac filters only — fine at flag volumes, revisit if flags ever number 100s.
router.get('/flags', async (req, res) => {
  const key = callerKey(req, res)
  if (!key) return
  const ns = String(req.query.namespace || NS_DEFAULT)
  const { page, pageSize } = pageParams(req)
  const filters: AnyObj[] = []
  const status = String(req.query.doc_status || 'published')
  if (status !== 'all') filters.push({ field: 'data.doc_status', operator: 'eq', value: status })
  if (req.query.target_yac)
    filters.push({ field: 'data.target_yac', operator: 'eq', value: String(req.query.target_yac) })
  try {
    const d = await wipReq('POST', `/api/document-store/documents/query?namespace=${ns}`, key,
      { template_id: 'FLAG_RECORD', filters, page, page_size: pageSize })
    const items: AnyObj[] = []
    for (const it of (d.items || []) as AnyObj[]) {
      const f = it.data || {}
      let target: AnyObj = { document_id: f.flagged_document }
      try {
        const t = await wipReq('GET', `/api/document-store/documents/${f.flagged_document}?namespace=${ns}`, key)
        target = {
          document_id: f.flagged_document,
          template_value: t.template_value || '',
          case_number: t.data?.case_number,
          title: t.data?.title || t.data?.slug || '',
        }
      } catch { /* target unresolvable — surface the raw id so the row is still actionable */ }
      if (req.query.target_type && target.template_value !== String(req.query.target_type)) continue
      items.push({
        flag_id: it.document_id, flag_type: f.flag_type, target_yac: f.target_yac,
        doc_status: f.doc_status, title: f.title, authored_by: f.authored_by,
        created_at: it.created_at, updated_at: it.updated_at, target,
      })
    }
    res.json({ total: d.total, page: d.page, pages: d.pages, items })
  } catch (e) {
    res.status(errStatus(e)).json({ error: (e as Error).message })
  }
})

// Build the ACTIVE-only response thread for a case, ordered by response_seq.
// The query's status defaults to active, so soft-deleted responses are excluded.
async function fetchCaseResponses(n: number, ns: string, key: string): Promise<AnyObj[]> {
  const all: AnyObj[] = []
  let page = 1
  for (;;) {
    const d = await wipReq('POST', `/api/document-store/documents/query?namespace=${ns}`, key,
      { template_id: 'CASE_RESPONSE',
        filters: [{ field: 'data.case_number', operator: 'eq', value: n }],
        page, page_size: 100 })
    for (const it of (d.items || []) as AnyObj[]) {
      all.push({
        seq: it.data?.response_seq,
        kind: it.data?.response_kind,
        author: it.data?.author,
        created_at: it.created_at,
        document_id: it.document_id,
        body: it.data?.body || '',
      })
    }
    if (page >= (d.pages || 1) || (d.items || []).length === 0) break
    page += 1
  }
  return all.sort((a, b) => ((a.seq as number) ?? 0) - ((b.seq as number) ?? 0))
}

// GET /cases/:n?view=both|case|responses[&response=latest|<seq>]
// Default view=both → case fields + body + the response thread (fulfils the
// `/wip-case read` "body + all responses" contract). view=case → case only;
// view=responses → { case_number, responses[] }. The response selector
// (latest | <seq>) narrows to one response; an explicit seq miss is 404.
// Responses are active-only. Resolved via the CASE-<n> synonym.
router.get('/cases/:n', async (req, res) => {
  const key = callerKey(req, res)
  if (!key) return
  const n = parseInt(req.params.n, 10)
  if (!Number.isFinite(n)) {
    res.status(422).json({ error: 'case number must be an integer' })
    return
  }
  const ns = String(req.query.namespace || NS_DEFAULT)
  const view = String(req.query.view || 'both')
  if (!['both', 'case', 'responses'].includes(view)) {
    res.status(422).json({ error: 'view must be one of: both, case, responses' })
    return
  }
  const respSel = req.query.response !== undefined ? String(req.query.response) : null
  if (respSel !== null && view === 'case') {
    res.status(422).json({ error: 'response selector requires view=responses or view=both' })
    return
  }
  try {
    const docId = await resolveCase(n, ns, key)
    if (!docId) {
      res.status(404).json({ error: `CASE-${n} not found in ${ns}` })
      return
    }
    const out: AnyObj = {}
    if (view === 'case' || view === 'both') {
      const doc = await getDoc(docId, ns, key)
      Object.assign(out, caseProjection(doc), { body: doc.data?.body || '' })
    }
    if (view === 'responses' || view === 'both') {
      out.case_number = n
      let responses = await fetchCaseResponses(n, ns, key)
      if (respSel !== null) {
        if (respSel === 'latest') {
          responses = responses.slice(-1)
        } else {
          const seq = parseInt(respSel, 10)
          if (!Number.isFinite(seq)) {
            res.status(422).json({ error: "response must be an integer or 'latest'" })
            return
          }
          const found = responses.find((r) => r.seq === seq)
          if (!found) {
            res.status(404).json({ error: `CASE-${n}#${seq} not found` })
            return
          }
          responses = [found]
        }
      }
      out.responses = responses
    }
    res.json(out)
  } catch (e) {
    res.status(errStatus(e)).json({ error: (e as Error).message })
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
    res.status(errStatus(e)).json({ error: (e as Error).message })
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
    res.status(errStatus(e)).json({ error: (e as Error).message })
  }
})

function firesideProjection(it: AnyObj): AnyObj {
  const d = it.data || {}
  return {
    // fireside_number is the human handle (FIRESIDE-<n>); without it in the projection
    // a consumer can't discover N from a listing and can't fetch by number.
    fireside_number: d.fireside_number ?? null,
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
    res.status(errStatus(e)).json({ error: (e as Error).message })
  }
})

// GET /firesides/:id — full fireside incl. body. FIRESIDE is a mint type
// (synonym_prefix FIRESIDE, number_field fireside_number), so :id accepts a
// FIRESIDE-<n> synonym, a bare <n>, or a document_id — any valid handle resolves like
// the canonical id. Discover numbers/ids via GET /firesides.
router.get('/firesides/:id', async (req, res) => {
  const key = callerKey(req, res)
  if (!key) return
  const ns = String(req.query.namespace || NS_DEFAULT)
  try {
    let id = req.params.id
    const num = /^(?:FIRESIDE-)?(\d+)$/i.exec(id)
    if (num) {
      const resolved = await resolveSynonym(`FIRESIDE-${num[1]}`, ns, key)
      if (!resolved) {
        res.status(404).json({ error: `fireside ${req.params.id} not found in ${ns}` })
        return
      }
      id = resolved
    }
    const doc = await getDoc(id, ns, key)
    res.json({ ...firesideProjection(doc), body: doc.data?.body || '' })
  } catch (e) {
    if (e instanceof WipError && e.status === 404) {
      res.status(404).json({ error: `fireside ${req.params.id} not found in ${ns}` })
      return
    }
    res.status(errStatus(e)).json({ error: (e as Error).message })
  }
})

function libraryDocProjection(it: AnyObj): AnyObj {
  const d = it.data || {}
  return {
    slug: d.slug, title: d.title, release: d.release || '',
    category: d.category || '', audience: d.audience || '', tags: d.tags || [],
    doc_status: d.doc_status || '',
    document_id: it.document_id, doc_version: it.version, updated_at: it.updated_at,
  }
}

// GET /library-docs?release=&category=&audience=&page=&page_size= — discovery list
// of PUBLISHED LIBRARY_DOCs (bodies omitted, like /firesides). CASE-616: the read
// surface for WEB-YAC's export pipeline. Library-owned type → NS_LIBRARY
// AUTHORITATIVELY: an inbound ?namespace= is IGNORED, because the served client
// pins its configured namespace (usually 'kb') on every call, which would misroute
// a library read to the corpus — the same trap the write path solves (CASE-518).
router.get('/library-docs', async (req, res) => {
  const key = callerKey(req, res)
  if (!key) return
  if (!NS_LIBRARY) { // no Library namespace configured → nothing to list
    res.json({ total: 0, page: 1, pages: 1, items: [] })
    return
  }
  const ns = NS_LIBRARY
  const { page, pageSize } = pageParams(req)
  // doc_status=published is enforced, not a caller option — only published docs
  // are in scope for the public website (CASE-616 / CASE-611).
  const filters: AnyObj[] = [{ field: 'data.doc_status', operator: 'eq', value: 'published' }]
  for (const f of ['release', 'category', 'audience']) {
    if (req.query[f]) filters.push({ field: `data.${f}`, operator: 'eq', value: String(req.query[f]) })
  }
  try {
    const d = await wipReq('POST', `/api/document-store/documents/query?namespace=${ns}`, key,
      { template_id: 'LIBRARY_DOC', filters, page, page_size: pageSize })
    res.json({ total: d.total, page: d.page, pages: d.pages, items: (d.items || []).map(libraryDocProjection) })
  } catch (e) {
    res.status(errStatus(e)).json({ error: (e as Error).message })
  }
})

// GET /library-docs/:slug?release= — one PUBLISHED LIBRARY_DOC incl. body. Identity
// is [slug, release], so release is required to disambiguate across release lines
// (a slug can exist in wip-v1 and wip-v2). Discover slugs via GET /library-docs.
// NS_LIBRARY is authoritative (see the list route) — inbound ?namespace= ignored.
router.get('/library-docs/:slug', async (req, res) => {
  const key = callerKey(req, res)
  if (!key) return
  const release = req.query.release !== undefined ? String(req.query.release) : ''
  if (!release) {
    res.status(422).json({ error: 'release query param is required — LIBRARY_DOC identity is [slug, release]' })
    return
  }
  if (!NS_LIBRARY) {
    res.status(404).json({ error: 'no Library namespace configured' })
    return
  }
  const ns = NS_LIBRARY
  try {
    const d = await wipReq('POST', `/api/document-store/documents/query?namespace=${ns}`, key,
      { template_id: 'LIBRARY_DOC',
        filters: [
          { field: 'data.slug', operator: 'eq', value: req.params.slug },
          { field: 'data.release', operator: 'eq', value: release },
          { field: 'data.doc_status', operator: 'eq', value: 'published' },
        ], page: 1, page_size: 2 })
    const it = (d.items || [])[0]
    if (!it) {
      res.status(404).json({ error: `no published LIBRARY_DOC '${req.params.slug}' for release ${release} in ${ns}` })
      return
    }
    res.json({ ...libraryDocProjection(it), body: it.data?.body || '' })
  } catch (e) {
    res.status(errStatus(e)).json({ error: (e as Error).message })
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
  // Enumerate with the gateway key so a namespace-scoped caller still discovers
  // Library types their own key can't LIST (CASE-573); callerKey stays the auth gate.
  const enumKey = GATEWAY_KEY || key
  // Span every configured namespace (CASE-518): a producer's --list must show
  // Library types (LIBRARY_DOC) alongside corpus types; each type is tagged with
  // its home namespace. An explicit ?namespace= still scopes to one.
  const namespaces = req.query.namespace
    ? [String(req.query.namespace)]
    : [NS_DEFAULT, ...(NS_LIBRARY ? [NS_LIBRARY] : [])]
  try {
    const perNs = await Promise.all(
      namespaces.map(async (ns) => {
        const [d, policies] = await Promise.all([
          // latest_only so a multi-version template (e.g. LIBRARY_DOC v1+v2) lists once.
          wipReq('GET', `/api/template-store/templates?namespace=${ns}&latest_only=true&page_size=100`, enumKey),
          loadPolicies(ns, enumKey),
        ])
        return (d.items || [])
          .filter((t: AnyObj) => (t.usage || 'entity') !== 'relationship')
          .map((t: AnyObj) => {
            const cfg = policies.get(t.value)
            return {
              type: t.value,
              namespace: ns,
              label: t.label || t.value,
              write_mode: cfg ? 'mint' : 'natural',
              synonym_prefix: cfg?.prefix || null,
              identity_fields: t.identity_fields || [],
            }
          })
      }),
    )
    const types = perNs.flat().sort((a: AnyObj, b: AnyObj) => String(a.type).localeCompare(String(b.type)))
    // `namespace` (the corpus/first) is kept for back-compat alongside `namespaces`
    // (CASE-518 review #6) — a consumer reading the old top-level field still works.
    res.json({ namespace: namespaces[0], namespaces, total: types.length, types })
  } catch (e) {
    res.status(errStatus(e)).json({ error: (e as Error).message })
  }
})

// GET /topics?type=CASE_RECORD — the topic vocabulary a writer must pick from.
//
// The write path VALIDATES `topics` against this vocabulary and rejects unknown
// values, and the playbook instructs writers to "pick 1–4 from KB_TOPIC" — but the
// only way to see it was the Topic facet in the browser, which an agent filing
// through the served client does not have. A required, validated field with no
// machine-readable domain leaves guess-and-retry against a live gateway as the
// only discovery path; on canonical that mints real case numbers to learn a
// vocabulary. Reported by a BE-YAC whose write was rejected on two invented tags.
//
// Which vocabulary is read off the template's own `topics` field, exactly as the
// write-time fallback does — this route names no terminology, so a type pointed at
// a different vocabulary is answered correctly without touching this code.
//
// The hierarchy is part of the answer, not decoration: tagging a leaf surfaces the
// doc under its ancestors, so a writer choosing between a parent and its child is
// making a real choice and needs to see the shape. Aliases likewise — they are
// accepted spellings, and hiding them makes a valid tag look invalid.
router.get('/topics', async (req, res) => {
  const key = callerKey(req, res)
  if (!key) return
  const enumKey = GATEWAY_KEY || key
  const type = String(req.query.type || 'CASE_RECORD').toUpperCase()
  const ns = req.query.namespace ? String(req.query.namespace) : NS_DEFAULT
  try {
    const tpl = await wipReq('GET',
      `/api/template-store/templates/by-value/${encodeURIComponent(type)}?namespace=${ns}`, enumKey)
    const field = (tpl.fields || []).find(
      (f: AnyObj) => f.name === TOPIC_FIELD && f.array_item_type === 'term')
    const ref = field?.array_terminology_ref
    if (!ref) {
      return res.status(404).json({
        error: `${type} has no '${TOPIC_FIELD}' term-array field — it carries no topic vocabulary`,
      })
    }
    // Terms list from the namespace that OWNS the terminology; a cross-namespace
    // list answers 200 with zero items rather than erroring, which would read as
    // "the vocabulary is empty" and quietly hand back nothing to pick from.
    const term = await wipReq('GET', `/api/def-store/terminologies/${ref}?namespace=${ns}`, enumKey)
    const homeNs = term.namespace || ns
    const [termsResp, relResp] = await Promise.all([
      wipReq('GET', `/api/def-store/terminologies/${ref}/terms?namespace=${homeNs}&page_size=1000`, enumKey),
      wipReq('GET', `/api/def-store/ontology/term-relations/all?namespace=${homeNs}&page_size=1000`, enumKey),
    ])
    const terms: AnyObj[] = (termsResp.items || []).filter((t: AnyObj) => t.status === 'active')
    // child value -> {parent, relation}. The relations listing is namespace-wide,
    // so restrict to relations whose BOTH ends live in this terminology.
    const parentOf = new Map<string, { parent: string; relation: string }>()
    const children = new Map<string, string[]>()
    for (const r of (relResp.items || []) as AnyObj[]) {
      if (r.status !== 'active') continue
      if (r.source_terminology_id !== ref || r.target_terminology_id !== ref) continue
      const child = String(r.source_term_value), parent = String(r.target_term_value)
      if (parentOf.has(child)) continue
      parentOf.set(child, { parent, relation: String(r.relation_type) })
      children.set(parent, [...(children.get(parent) ?? []), child])
    }
    const byValue = new Map(terms.map((t) => [String(t.value), t]))
    const sortVals = (vals: string[]) =>
      [...new Set(vals)].sort((a, b) =>
        (byValue.get(a)?.sort_order ?? 0) - (byValue.get(b)?.sort_order ?? 0) || a.localeCompare(b))
    // Depth-first from the roots so the flat list PRINTS as the tree it is.
    const out: AnyObj[] = []
    const walk = (value: string, depth: number, seen: Set<string>) => {
      const t = byValue.get(value)
      if (!t || seen.has(value)) return
      const link = parentOf.get(value)
      out.push({
        value,
        label: t.label || value,
        aliases: t.aliases || [],
        parent: link?.parent ?? null,
        relation: link?.relation ?? null,
        depth,
      })
      for (const c of sortVals(children.get(value) ?? [])) walk(c, depth + 1, new Set([...seen, value]))
    }
    for (const v of sortVals([...byValue.keys()].filter((v) => !parentOf.has(v)))) walk(v, 0, new Set())
    // A term whose parent is missing or cycles would never be reached by the walk.
    // Emit it flat rather than dropping it: an unreachable term is still a legal
    // tag, and silently omitting it recreates this route's own bug one level down.
    for (const v of sortVals([...byValue.keys()])) {
      if (out.some((o) => o.value === v)) continue
      const link = parentOf.get(v)
      const t = byValue.get(v) as AnyObj
      out.push({
        value: v, label: t.label || v, aliases: t.aliases || [],
        parent: link?.parent ?? null, relation: link?.relation ?? null, depth: 0, orphaned: true,
      })
    }
    res.json({
      type, terminology: term.value || String(ref), namespace: homeNs,
      total: out.length, topics: out,
    })
  } catch (e) {
    res.status(errStatus(e)).json({ error: (e as Error).message })
  }
})

// ---------------------------------------------------------------------------
// Full-text search (CASE-707). The structured verbs above filter on values you
// already know; this is the "which docs mention X" surface. Without it an agent's
// only options were grep-after-fetch or raw reporting SQL — and the SQL detour is
// exactly what the gateway-only discipline exists to prevent.
//
// kb + library are ONE corpus: the fan-out mirrors the UI's, including its
// per-namespace catch, because a namespace with no FTS data yet must not sink the
// whole search.

// Namespaces reach SQL as identifiers; they come from env, not callers, but are
// validated anyway. Document ids are interpolated into IN-lists — guard likewise.
const SQL_NAME_RE = /^[a-z0-9_]+$/
const SQL_ID_RE = /^[0-9a-f][0-9a-f-]{15,}$/i

// FTS hits carry the template value but NO title, and a title is what makes a
// result readable. Enrich with ONE reporting query per namespace (a UNION over the
// matched types' tables) rather than N per-document fetches.
async function titlesForHits(ns: string, hits: AnyObj[], key: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const byStem = new Map<string, string[]>()
  for (const h of hits) {
    const stem = String(h.value ?? '').toLowerCase()
    const id = String(h.id ?? '')
    if (!SQL_NAME_RE.test(stem) || !SQL_ID_RE.test(id)) continue
    byStem.set(stem, [...(byStem.get(stem) ?? []), id])
  }
  if (byStem.size === 0) return out
  const stems = [...byStem.keys()]
  // Only union tables that actually expose `title` — one missing column would
  // error the entire union and cost every result its title.
  const probe = await wipReq('POST', '/api/reporting-sync/query', key, {
    namespace: ns,
    sql:
      `SELECT table_name FROM information_schema.columns WHERE table_schema = '${ns}' ` +
      `AND column_name = 'title' AND table_name IN (${stems.map((s) => `'doc_${s}'`).join(',')})`,
    max_rows: 200,
  })
  const titled = new Set((probe.rows ?? []).map((r: AnyObj) => String(r.table_name)))
  const parts = stems
    .filter((s) => titled.has(`doc_${s}`))
    .map(
      (s) =>
        `SELECT document_id, title FROM "${ns}"."doc_${s}" ` +
        `WHERE document_id IN (${(byStem.get(s) as string[]).map((i) => `'${i}'`).join(',')})`,
    )
  if (parts.length === 0) return out
  const d = await wipReq('POST', '/api/reporting-sync/query', key, {
    namespace: ns, sql: parts.join('\nUNION ALL\n'), max_rows: 2000,
  })
  for (const r of d.rows ?? []) if (r.title) out.set(String(r.document_id), String(r.title))
  return out
}

// GET /search?q=&mode=auto|fts|substring&type=&limit=
router.get('/search', async (req, res) => {
  const key = callerKey(req, res)
  if (!key) return
  const q = String(req.query.q ?? '').trim()
  if (!q) return res.status(400).json({ error: 'q is required' })
  const raw = String(req.query.mode ?? 'auto')
  const mode = ['auto', 'fts', 'substring'].includes(raw) ? raw : 'auto'
  const typeFilter = req.query.type ? String(req.query.type).toUpperCase() : null
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100)
  const namespaces = [...new Set([NS_DEFAULT, NS_LIBRARY])].filter((n) => SQL_NAME_RE.test(n))

  const perNs = await Promise.all(
    namespaces.map(async (ns) => {
      try {
        // The type filter is DELEGATED to reporting-sync rather than applied here.
        // Filtering locally on each hit's reported type meant two places decided
        // what a type name matches, and they disagreed the moment the reporting
        // layer changed how it names things (CASE-810: hits came back as
        // CASE_RECORD__V1, so an equality test against CASE_RECORD silently kept
        // nothing). It also made the platform's unmatched-template signal
        // unreachable — it can only report on a filter it was actually given.
        const r = await wipReq(
          'POST', `/api/reporting-sync/search?namespace=${encodeURIComponent(ns)}`, key,
          { query: q, mode, types: ['document'], page_size: 100, ...(typeFilter ? { template: typeFilter } : {}) },
        )
        const hits: AnyObj[] = Object.values(r.results ?? {}).flatMap(
          (b) => ((b as AnyObj).items as AnyObj[]) ?? [],
        )
        const titles = await titlesForHits(ns, hits, key)
        return {
          // null (not false) when the platform predates the signal — absence of
          // evidence, which must not be reported as a matched filter (CASE-811).
          unmatched: r.unmatched_template === undefined ? null : r.unmatched_template != null,
          items: hits.map((h) => ({
            document_id: h.id,
            template_value: h.value ?? null,
            namespace: ns,
            title: titles.get(String(h.id)) ?? null,
            score: h.score == null ? null : Number(h.score),
            // Snippet carries the platform's <b> highlight markup and embedded
            // newlines; passed through as-is so each consumer renders it its own way.
            snippet: h.snippet ?? null,
            updated_at: h.updated_at ?? null,
          })),
        }
      } catch {
        // A namespace with no FTS data must not sink the whole search — and it
        // reports no verdict on the filter, rather than a negative one.
        return { unmatched: null, items: [] as AnyObj[] }
      }
    }),
  )
  const all = perNs.flatMap((p) => p.items).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  // Search spans namespaces, so a type is only "unmatched" when EVERY namespace
  // that answered said so — matching in one is enough to make the filter valid.
  // Namespaces that errored or gave no verdict abstain; if none gave a verdict,
  // the answer is null (unknown), never a false negative.
  const verdicts = perNs.map((p) => p.unmatched).filter((v): v is boolean => v !== null)
  const unmatchedTemplate =
    typeFilter && verdicts.length > 0 && verdicts.every(Boolean) ? typeFilter : null
  // Report the cap rather than silently truncating: the per-namespace page_size
  // above is itself a window, so `truncated` means "there is more", not a total.
  res.json({
    query: q, mode, namespaces, type: typeFilter,
    // Echoes the requested type when it matched no reporting table in any
    // namespace searched — so a caller can tell a bad type name from a genuine
    // zero-result instead of reading silence as an answer (CASE-811).
    unmatched_template: unmatchedTemplate,
    returned: Math.min(all.length, limit), truncated: all.length > limit,
    items: all.slice(0, limit),
  })
})

export default router
