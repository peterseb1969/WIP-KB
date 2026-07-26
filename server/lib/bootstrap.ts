/**
 * Server-side bootstrap library — the offer-on-empty / use-on-exists pattern.
 *
 * Two-namespace aware (CASE-518): bootstraps a KB-corpus namespace (server/seed/)
 * and, when configured, a Technical Library namespace (server/seed-library/). Each
 * namespace is seeded from its own dir through the identical seed flow; the library
 * namespace is created with `allowed_external_refs` pointing at the corpus namespace
 * so Library docs can reference corpus docs (Library → KB reference fields; CASE-538
 * — relationships can't cross namespaces, plain refs can).
 *
 * Three rules (per CLAUDE.md "Bootstrap on Launch — BootstrapGate"):
 *   1. If a configured namespace does NOT exist on launch, the app shows the user
 *      an explicit bootstrap offer. We do NOT auto-bootstrap silently.
 *   2. If all configured namespaces DO exist, the app uses them as-is. No schema
 *      reconciliation, no "templates differ" check. Rolling redeploys against
 *      existing namespaces must come up clean.
 *   3. On user-initiated bootstrap, write one BOOTSTRAP_RECORD audit doc (in the
 *      corpus namespace — only it carries the template) capturing app version,
 *      timestamp, everything created across both namespaces, and the commit SHA.
 *
 * Restore is NOT an app concern. The bootstrap UI MENTIONS restore as an
 * alternative the user may prefer; it does not provide UI for it.
 */

import { wipGet, wipPost, wipPut } from './wip-api.js'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SEED_DIR = join(__dirname, '..', 'seed')
const SEED_LIBRARY_DIR = join(__dirname, '..', 'seed-library')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>

/**
 * One namespace to bootstrap: its name, the seed dir to read from, the
 * create-body for the namespace upsert, and whether it carries write-policies /
 * the audit record.
 */
interface NamespacePlan {
  namespace: string
  seedDir: string
  nsCreate: AnyObj
  writePolicies: boolean
  audit: boolean
  label: string
  /**
   * `${NAME}` tokens substituted into this plan's seed files before parsing.
   *
   * Exists because a reference to a terminology in ANOTHER namespace must name
   * that namespace explicitly — bare values resolve own-namespace only, by
   * deliberate platform contract (CASE-813). A literal `kb:KB_TOPIC` in a seed
   * would be as unportable as a hardcoded UUID, since the corpus namespace is
   * deployment-configurable, so seeds write `${CORPUS_NS}:KB_TOPIC` and the
   * deployment's own configured name is filled in here.
   */
  placeholders: Record<string, string>
}

/**
 * Read a seed file, substitute `${NAME}` placeholders, then parse.
 *
 * An unsubstituted placeholder is fatal: it would otherwise reach the API as a
 * literal `${…}` and fail far from its cause, or worse, be stored verbatim.
 */
function readSeedJson(path: string, placeholders: Record<string, string>): AnyObj {
  let text = readFileSync(path, 'utf-8')
  for (const [name, value] of Object.entries(placeholders)) {
    text = text.split(`\${${name}}`).join(value)
  }
  const leftover = text.match(/\$\{[A-Z_][A-Z0-9_]*\}/)
  if (leftover) {
    throw new Error(`${path}: unsubstituted placeholder ${leftover[0]} (known: ${Object.keys(placeholders).join(', ') || 'none'})`)
  }
  return JSON.parse(text)
}

// The bootstrap provenance template's value is namespace-prefixed
// (<NS_PREFIX>_BOOTSTRAP_RECORD): every app used to mint the same literal
// BOOTSTRAP_RECORD from its own seed copy, so any merge of two app-derived
// namespaces collided on that one template and refused — and a prefixed record
// carried into a merged namespace is self-labeling foreign history. Derived
// from the app's CANONICAL corpus namespace, not the per-run override: the
// seed file carries this same literal value, and seed and lookup must agree
// even when the test harness bootstraps into a scratch namespace. Namespaces
// bootstrapped before this change keep their unprefixed BOOTSTRAP_RECORD —
// a template's value is its identity; renaming would be a fork.
const CANONICAL_CORPUS_NS = 'kb'
export const BOOTSTRAP_RECORD_VALUE = `${CANONICAL_CORPUS_NS.toUpperCase().replace(/-/g, '_')}_BOOTSTRAP_RECORD`

/**
 * Resolve the namespaces to bootstrap from env.
 *
 * - Corpus namespace = KB_BOOTSTRAP_NAMESPACE (test-harness override) ||
 *   WIP_NAMESPACE || 'kb'. Production is 'kb' (BootstrapGate offer-on-empty).
 * - Library namespace = KB_LIBRARY_NAMESPACE || 'library' — two-namespace by
 *   default (CASE-518 cutover). Suppressed when KB_BOOTSTRAP_NAMESPACE is set, so
 *   the test harness (tools/bootstrap-ns.ts) bootstraps exactly one throwaway namespace.
 *
 * The library's allowed_external_refs is resolved to the ACTUAL corpus namespace
 * name — the seed's namespace.json carries the dev value (kb-libdev), but a
 * deployment picks its own corpus name, so we substitute it here.
 */
function buildPlans(): NamespacePlan[] {
  const corpus = process.env.KB_BOOTSTRAP_NAMESPACE || process.env.WIP_NAMESPACE || CANONICAL_CORPUS_NS
  const libraryNs = process.env.KB_BOOTSTRAP_NAMESPACE
    ? '' // single-namespace test harness (tools/bootstrap-ns.ts)
    : process.env.KB_LIBRARY_NAMESPACE || 'library' // two-namespace by default (CASE-518)

  const plans: NamespacePlan[] = [
    {
      namespace: corpus,
      seedDir: SEED_DIR,
      nsCreate: { description: `${corpus} app data (bootstrap created)` },
      writePolicies: true,
      audit: true,
      label: 'corpus',
      placeholders: { CORPUS_NS: corpus },
    },
  ]

  if (libraryNs && existsSync(SEED_LIBRARY_DIR)) {
    let cfg: AnyObj = {}
    try {
      cfg = JSON.parse(readFileSync(join(SEED_LIBRARY_DIR, 'namespace.json'), 'utf-8'))
    } catch {
      cfg = {}
    }
    plans.push({
      namespace: libraryNs,
      seedDir: SEED_LIBRARY_DIR,
      nsCreate: {
        description: cfg.description || `${libraryNs} app data (bootstrap created)`,
        isolation_mode: cfg.isolation_mode || 'open',
        allowed_external_refs: [corpus],
        ...(cfg.deletion_mode ? { deletion_mode: cfg.deletion_mode } : {}),
      },
      writePolicies: false,
      audit: false,
      label: 'library',
      placeholders: { CORPUS_NS: corpus, LIBRARY_NS: libraryNs },
    })
  }

  return plans
}

interface BulkItemResult {
  index?: number
  status?: string
  id?: string
  error?: string
  error_code?: string
}

/**
 * Throw if any item in a bulk-write response has status='error'.
 *
 * Per PoNIF #4 (Bulk-First — 200 OK Always), WIP write APIs return HTTP
 * 200 even when individual items fail; the per-item status is in
 * `results[].status`. wipPost only validates HTTP status, so without
 * this check, per-item errors are silently dropped.
 */
function assertBulkSuccess(response: unknown, context: string): void {
  const r = response as { results?: BulkItemResult[] } | BulkItemResult[]
  const items = Array.isArray(r) ? r : r.results || []
  const errors = items.filter((i) => i.status === 'error')
  if (errors.length) {
    const summary = errors
      .map((e) => `[${e.index ?? '?'}] ${e.error_code || ''} ${e.error || 'unknown'}`.trim())
      .join('; ')
    throw new Error(`${context}: ${errors.length}/${items.length} items failed — ${summary}`)
  }
}

export type BootstrapStatus = 'unknown' | 'wip_unreachable' | 'needs_bootstrap' | 'ready'

export interface BootstrapProgress {
  step: string
  detail: string
  done: boolean
  error?: string
}

/**
 * Check if WIP is reachable and whether ALL configured namespaces exist.
 * 'ready' only when every planned namespace is present; if any is missing the
 * app offers bootstrap.
 */
export async function checkStatus(): Promise<BootstrapStatus> {
  let namespaces: Array<{ prefix: string }>
  try {
    namespaces = (await wipGet('/api/registry/namespaces')) as Array<{ prefix: string }>
  } catch {
    return 'wip_unreachable'
  }

  const have = new Set(namespaces.map((ns) => ns.prefix))
  const plans = buildPlans()
  return plans.every((p) => have.has(p.namespace)) ? 'ready' : 'needs_bootstrap'
}

/** Accumulates everything created across all namespaces for the audit record. */
interface Created {
  templatesCreated: string[]
  edgeTypesCreated: string[]
  terminologiesCreated: string[]
}

/**
 * Run the full bootstrap across all configured namespaces. Calls onProgress for
 * each step. One BOOTSTRAP_RECORD audit doc is written to the corpus namespace
 * at the end, capturing entities created across every namespace.
 */
export async function runBootstrap(
  onProgress: (p: BootstrapProgress) => void,
): Promise<void> {
  const startedAt = new Date().toISOString()
  const plans = buildPlans()
  const created: Created = {
    templatesCreated: [],
    edgeTypesCreated: [],
    terminologiesCreated: [],
  }

  try {
    // Per-namespace use-on-exists (CASE-518 review #3): seed ONLY the namespaces
    // that don't exist yet. checkStatus offers bootstrap when ANY planned namespace
    // is missing; without this guard, confirming would re-run the seed against an
    // already-populated namespace (e.g. an existing canonical `kb`) — re-writing
    // WRITE_POLICY docs and, since terminology creates use no on_conflict, aborting
    // on the first `already_exists`. An existing namespace is used as-is.
    let existing: Set<string>
    try {
      const nss = (await wipGet('/api/registry/namespaces')) as Array<{ prefix: string }>
      existing = new Set(nss.map((n) => n.prefix))
    } catch {
      existing = new Set()
    }
    for (const plan of plans) {
      if (existing.has(plan.namespace)) {
        onProgress({
          step: 'skip',
          detail: `[${plan.label}] ${plan.namespace} already exists — using as-is (no re-seed)`,
          done: false,
        })
        continue
      }
      await seedNamespace(plan, onProgress, created)
    }

    // BOOTSTRAP_RECORD goes to the corpus namespace (only it carries the
    // template), recording everything created across both namespaces. Best-effort:
    // the audit is provenance, not load-bearing, and must not fail the bootstrap
    // (e.g. if the corpus was skipped as already-existing but lacks the template).
    const auditPlan = plans.find((p) => p.audit)
    if (auditPlan) {
      onProgress({ step: 'audit', detail: 'Writing BOOTSTRAP_RECORD audit doc...', done: false })
      try {
        await writeBootstrapRecord(auditPlan.namespace, { startedAt, ...created })
      } catch (err) {
        onProgress({
          step: 'audit',
          detail: `BOOTSTRAP_RECORD skipped (${(err as Error).message})`,
          done: false,
        })
      }
    }

    onProgress({ step: 'done', detail: 'Bootstrap complete', done: true })
  } catch (err) {
    onProgress({
      step: 'error',
      detail: (err as Error).message,
      done: true,
      error: (err as Error).message,
    })
    throw err
  }
}

/**
 * Seed a single namespace from its seed dir: namespace upsert → terminologies
 * (with terms) → ontology term-relations → templates → (optional) write-policies.
 * Appends created entity values to `created` for the shared audit record.
 *
 * Order: namespace → terminologies → terms → term-relations → templates
 * (filename-sorted so dependencies resolve) → cache settle → write-policies.
 */
async function seedNamespace(
  plan: NamespacePlan,
  onProgress: (p: BootstrapProgress) => void,
  created: Created,
): Promise<void> {
  const { namespace, seedDir } = plan
  const progress = (step: string, detail: string) =>
    onProgress({ step, detail: `[${plan.label}] ${detail}`, done: false })

  // Step 1: Create namespace (idempotent upsert via PUT) with its config
  // (description, and for the library: isolation_mode + allowed_external_refs).
  progress('namespace', `Creating ${namespace} namespace...`)
  await wipPut(`/api/registry/namespaces/${namespace}`, plan.nsCreate)

  // Step 2: Load and create terminologies
  progress('terminologies', 'Loading seed data...')
  const termFiles = readdirSync(join(seedDir, 'terminologies'))
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .sort()

  const terminologies: AnyObj[] = []
  for (const file of termFiles) {
    const data = readSeedJson(join(seedDir, 'terminologies', file), plan.placeholders)
    terminologies.push(data)
  }

  progress('terminologies', `Creating ${terminologies.length} terminologies...`)
  const termBulk = terminologies.map((t) => ({
    value: t.value,
    label: t.label,
    description: t.description || '',
    namespace,
    ...(t.mutable ? { mutable: true } : {}),
  }))
  const termResult = (await wipPost('/api/def-store/terminologies', termBulk)) as {
    results: Array<{ status: string; id: string; error?: string }>
  }
  assertBulkSuccess(termResult, `terminologies create [${plan.label}]`)

  // Build value → terminology_id map
  const termIdMap = new Map<string, string>()
  for (const [i, r] of termResult.results.entries()) {
    const term = terminologies[i]
    if (r?.id && term) {
      termIdMap.set(term.value, r.id)
      created.terminologiesCreated.push(term.value)
    }
  }

  // Step 3: Create terms for each terminology
  let totalTerms = 0
  for (const termData of terminologies) {
    const terms = termData.terms || []
    if (!terms.length) continue

    const termId = termIdMap.get(termData.value)
    if (!termId) continue

    progress('terms', `Creating ${terms.length} terms for ${termData.value}...`)
    const termsResult = await wipPost(`/api/def-store/terminologies/${termId}/terms`, terms)
    assertBulkSuccess(termsResult, `terms for ${termData.value} [${plan.label}]`)
    totalTerms += terms.length
  }
  progress('terms', `Created ${totalTerms} terms across ${terminologies.length} terminologies`)

  // Step 4: Create ontology term-relations (KB_TOPIC's hierarchy, CASE-760).
  //
  // Seeds address the endpoints by TERM VALUE — stable, readable, and what a
  // human writes — but the API takes term_ids. The 2-part "TERMINOLOGY:VALUE"
  // shorthand is NOT an alternative: def-store rejects it with 422 on every term
  // endpoint, reads and writes alike. So resolve values to ids here, by reading
  // back the terminology's terms (rather than trusting ids in the bulk-create
  // response, which lets a re-run over existing terms resolve identically).
  // Only fetched for terminologies that actually declare relationships.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const allRelations: AnyObj[] = []
  for (const termData of terminologies) {
    const rels = termData.ontology?.relationships || []
    if (!rels.length) continue

    const terminologyId = termIdMap.get(termData.value)
    if (!terminologyId) continue
    const listed = (await wipGet(
      `/api/def-store/terminologies/${terminologyId}/terms?namespace=${namespace}&page_size=100`,
    )) as { items?: Array<{ term_id: string; value: string }> }
    const idByValue = new Map((listed.items ?? []).map((t) => [t.value, t.term_id]))

    // An unresolvable ref is fatal, not skippable: dropping it would bootstrap a
    // taxonomy silently missing an edge, and nothing downstream would notice.
    const resolve = (ref: string, side: string): string => {
      if (UUID_RE.test(ref)) return ref
      const id = idByValue.get(ref)
      if (!id) {
        throw new Error(
          `ontology relation ${side} "${ref}" matches no term in ${termData.value} [${plan.label}]`,
        )
      }
      return id
    }

    for (const rel of rels) {
      allRelations.push({
        source_term_id: resolve(rel.source, 'source'),
        target_term_id: resolve(rel.target, 'target'),
        relation_type: rel.type,
      })
    }
  }

  if (allRelations.length) {
    progress('term-relations', `Creating ${allRelations.length} ontology term-relations...`)
    const relResult = await wipPost(
      `/api/def-store/ontology/term-relations?namespace=${namespace}`,
      allRelations,
    )
    assertBulkSuccess(relResult, `ontology term-relations [${plan.label}]`)
  }

  // Step 5: Create templates (sorted by filename prefix for dependency order)
  const templateFiles = readdirSync(join(seedDir, 'templates'))
    .filter((f) => f.endsWith('.json'))
    .sort()

  progress('templates', `Creating ${templateFiles.length} templates...`)
  for (const file of templateFiles) {
    const data = readSeedJson(join(seedDir, 'templates', file), plan.placeholders)
    progress('templates', `Creating ${data.value}...`)

    const template: AnyObj = {
      value: data.value,
      label: data.label,
      description: data.description || '',
      namespace,
      identity_fields: data.identity_fields || [],
      fields: data.fields.map((f: AnyObj) => mapField(f)),
    }

    // Forward edge-type metadata when present (PoNIF #7).
    if (data.usage && data.usage !== 'entity') template.usage = data.usage
    if (data.source_templates) template.source_templates = data.source_templates
    if (data.target_templates) template.target_templates = data.target_templates
    if (data.versioned === false) template.versioned = false

    if (data.header_fields) template.header_fields = data.header_fields
    if (data.reporting) template.reporting = data.reporting

    const tmplResult = await wipPost(
      '/api/template-store/templates?on_conflict=validate',
      [template],
    )
    assertBulkSuccess(tmplResult, `template ${data.value} [${plan.label}]`)

    if (data.usage === 'relationship') created.edgeTypesCreated.push(data.value)
    else created.templatesCreated.push(data.value)
  }

  // Wait for template cache to refresh (PoNIF #6 — wip://ponifs).
  progress('cache', 'Waiting for template cache to refresh...')
  await new Promise((resolve) => setTimeout(resolve, 6000))

  // Step 6: Seed the WRITE_POLICY config docs (CASE-482) — first-class data
  // the gateway derives per-type write behaviour from. Corpus only; the library
  // has no mint policies (LIBRARY_DOC is natural-upsert).
  if (plan.writePolicies) {
    progress('write-policies', 'Seeding WRITE_POLICY config docs...')
    await writeWritePolicies(namespace, seedDir)
  }
}

/**
 * Seed the WRITE_POLICY config documents (CASE-482) for a namespace.
 *
 * One doc per doc_type that needs non-default write behaviour, from
 * <seedDir>/write-policies.json. These ARE the source the gateway reads to decide
 * mint-vs-natural per type — config as first-class data, not gateway code or
 * template metadata. Idempotent: identity is doc_type, so re-bootstrap updates
 * in place. Types absent here write by natural identity. No-op if the file is
 * absent (e.g. the library seed has no write-policies).
 */
async function writeWritePolicies(namespace: string, seedDir: string): Promise<void> {
  const policiesPath = join(seedDir, 'write-policies.json')
  if (!existsSync(policiesPath)) return
  const policies: AnyObj[] = JSON.parse(readFileSync(policiesPath, 'utf-8'))
  if (!policies.length) return
  const tmpl = (await wipGet(
    `/api/template-store/templates/by-value/WRITE_POLICY?namespace=${namespace}`,
  )) as { template_id: string; version: number }
  const docs = policies.map((p) => ({
    template_id: tmpl.template_id,
    template_version: tmpl.version,
    namespace,
    data: p,
  }))
  const result = await wipPost('/api/document-store/documents', docs)
  assertBulkSuccess(result, 'WRITE_POLICY docs')
}

/**
 * Write the BOOTSTRAP_RECORD audit doc into the corpus namespace.
 *
 * Canonical fields (DESIGN.md §5.9 / §7):
 *   - bootstrap_id: unique ID for this bootstrap run (timestamp-based)
 *   - app_version: from process.env.APP_VERSION
 *   - bootstrapped_at: ISO timestamp when bootstrap *started*
 *   - commit_sha: from process.env.GIT_COMMIT_SHA
 *   - templates_created / edge_types_created / terminologies_created (aggregated
 *     across every namespace seeded in this run)
 *
 * AGENT_IDENTITY seeding (USER1 + 7 YACs) is APP-KB-YAC's responsibility
 * post-bootstrap, not part of this audit doc.
 */
async function writeBootstrapRecord(
  namespace: string,
  meta: {
    startedAt: string
    templatesCreated: string[]
    edgeTypesCreated: string[]
    terminologiesCreated: string[]
  },
): Promise<void> {
  // Resolve the bootstrap-record template_id (and version) first — by the
  // namespace-prefixed value the seed just created (BOOTSTRAP_RECORD_VALUE).
  // The /api/document-store/documents endpoint requires template_id —
  // template_value is not auto-resolved at this surface. Per PoNIF #6,
  // pass an explicit template_version so the document validates against
  // the version we just created, not "latest" from cache.
  const tmpl = (await wipGet(
    `/api/template-store/templates/by-value/${BOOTSTRAP_RECORD_VALUE}?namespace=${namespace}`,
  )) as { template_id: string; version: number }

  const bootstrapId = `bootstrap-${meta.startedAt.replace(/[:.]/g, '-')}`
  const doc = {
    template_id: tmpl.template_id,
    template_version: tmpl.version,
    namespace,
    data: {
      bootstrap_id: bootstrapId,
      title: `KB bootstrap ${meta.startedAt.slice(0, 16).replace('T', ' ')}`,
      authored_by: 'app:APP-KB',
      doc_status: 'published',
      app_version: process.env.APP_VERSION || 'unknown',
      bootstrapped_at: meta.startedAt,
      commit_sha: process.env.GIT_COMMIT_SHA || 'unknown',
      templates_created: meta.templatesCreated,
      edge_types_created: meta.edgeTypesCreated,
      terminologies_created: meta.terminologiesCreated,
    },
  }
  const result = await wipPost('/api/document-store/documents', [doc])
  assertBulkSuccess(result, 'BOOTSTRAP_RECORD write')
}


/**
 * Map a seed field definition to WIP template field format.
 *
 * APP-KB additions (vs gene-pool template):
 *   - full_text_indexed: forwarded so per-field FTS works.
 *   - default_value: forwarded (uses !== undefined so `false` survives).
 */
function mapField(f: AnyObj): AnyObj {
  const field: AnyObj = {
    name: f.name,
    label: f.label,
    type: f.type,
  }

  if (f.mandatory) field.mandatory = true
  if (f.terminology_ref) field.terminology_ref = f.terminology_ref
  if (f.semantic_type) field.semantic_type = f.semantic_type

  if (f.reference_type) field.reference_type = f.reference_type
  if (f.target_templates) field.target_templates = f.target_templates

  if (f.type === 'array') {
    if (f.items?.type) field.array_item_type = f.items.type
    else if (f.array_item_type) field.array_item_type = f.array_item_type

    if (f.items?.terminology_ref) field.array_terminology_ref = f.items.terminology_ref
    else if (f.array_terminology_ref) field.array_terminology_ref = f.array_terminology_ref
  }

  if (f.type === 'file' && f.file_config) {
    field.file_config = {
      multiple: f.file_config.multiple ?? false,
      ...(f.file_config.max_count ? { max_files: f.file_config.max_count } : {}),
      ...(f.file_config.max_files ? { max_files: f.file_config.max_files } : {}),
      ...(f.file_config.max_size_mb ? { max_size_mb: f.file_config.max_size_mb } : {}),
      ...(f.file_config.accept ? { allowed_types: [f.file_config.accept] } : {}),
      ...(f.file_config.allowed_types ? { allowed_types: f.file_config.allowed_types } : {}),
    }
  }

  if (f.validation) field.validation = f.validation
  if (f.enum) field.validation = { ...field.validation, enum: f.enum }

  if (f.full_text_indexed) field.full_text_indexed = f.full_text_indexed
  if (f.default_value !== undefined) field.default_value = f.default_value

  return field
}
