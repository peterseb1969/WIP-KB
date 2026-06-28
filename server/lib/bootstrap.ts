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
}

/**
 * Resolve the namespaces to bootstrap from env.
 *
 * - Corpus namespace = KB_BOOTSTRAP_NAMESPACE (test-harness override) ||
 *   WIP_NAMESPACE || 'kb'. Production is 'kb' (BootstrapGate offer-on-empty).
 * - Library namespace = KB_LIBRARY_NAMESPACE (empty / unset = single-namespace,
 *   no library). Suppressed when KB_BOOTSTRAP_NAMESPACE is set, so the test
 *   harness (tools/bootstrap-ns.ts) bootstraps exactly one throwaway namespace.
 *
 * The library's allowed_external_refs is resolved to the ACTUAL corpus namespace
 * name — the seed's namespace.json carries the dev value (kb-libdev), but a
 * deployment picks its own corpus name, so we substitute it here.
 */
function buildPlans(): NamespacePlan[] {
  const corpus = process.env.KB_BOOTSTRAP_NAMESPACE || process.env.WIP_NAMESPACE || 'kb'
  const libraryNs = process.env.KB_BOOTSTRAP_NAMESPACE
    ? ''
    : process.env.KB_LIBRARY_NAMESPACE || ''

  const plans: NamespacePlan[] = [
    {
      namespace: corpus,
      seedDir: SEED_DIR,
      nsCreate: { description: `${corpus} app data (bootstrap created)` },
      writePolicies: true,
      audit: true,
      label: 'corpus',
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
    for (const plan of plans) {
      await seedNamespace(plan, onProgress, created)
    }

    // BOOTSTRAP_RECORD goes to the corpus namespace (only it carries the
    // template), recording everything created across both namespaces.
    const auditPlan = plans.find((p) => p.audit)
    if (auditPlan) {
      onProgress({ step: 'audit', detail: 'Writing BOOTSTRAP_RECORD audit doc...', done: false })
      await writeBootstrapRecord(auditPlan.namespace, { startedAt, ...created })
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
    const data = JSON.parse(readFileSync(join(seedDir, 'terminologies', file), 'utf-8'))
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

  // Step 4: Create ontology term-relations (none in v1, but keep the
  // loop in place for forward-compat if a future seed adds them).
  const allRelations: AnyObj[] = []
  for (const termData of terminologies) {
    const rels = termData.ontology?.relationships || []
    for (const rel of rels) {
      allRelations.push({
        source_term_id: rel.source,
        target_term_id: rel.target,
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
    const data = JSON.parse(readFileSync(join(seedDir, 'templates', file), 'utf-8'))
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
  // Resolve BOOTSTRAP_RECORD's template_id (and version) first. The
  // /api/document-store/documents endpoint requires template_id —
  // template_value is not auto-resolved at this surface. Per PoNIF #6,
  // pass an explicit template_version so the document validates against
  // the version we just created, not "latest" from cache.
  const tmpl = (await wipGet(
    `/api/template-store/templates/by-value/BOOTSTRAP_RECORD?namespace=${namespace}`,
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
