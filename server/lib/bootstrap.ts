/**
 * Server-side bootstrap library — the offer-on-empty / use-on-exists pattern.
 *
 * Adapted from templates/bootstrap/bootstrap.server.ts.template. APP-KB
 * additions to the gene-pool body:
 *   - NAMESPACE = 'kb' (DESIGN.md namespace discipline; never created from
 *     the dev workflow — only here at runtime on user-confirmed bootstrap).
 *   - mapField() extended to forward `full_text_indexed` and `default_value`
 *     from seed JSON to the WIP API. APP-KB needs both: FTS on
 *     title/body/topic/description, and defaults for doc_status + root.
 *     Filed upstream in CASE-292 / future gene-pool patch.
 *
 * Three rules (per CLAUDE.md "Bootstrap on Launch — BootstrapGate"):
 *   1. If the namespace does NOT exist on launch, the app shows the user
 *      an explicit bootstrap offer. We do NOT auto-bootstrap silently.
 *   2. If the namespace DOES exist, the app uses it as-is. No schema
 *      reconciliation, no "templates differ" check. Rolling redeploys
 *      against an existing namespace must come up clean.
 *   3. On user-initiated bootstrap, write one BOOTSTRAP_RECORD audit doc
 *      capturing app version, timestamp, what was created, and the
 *      current commit SHA.
 *
 * Restore is NOT an app concern. The bootstrap UI MENTIONS restore as an
 * alternative the user may prefer; it does not provide UI for it.
 */

import { wipGet, wipPost, wipPut } from './wip-api.js'
import { readFileSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SEED_DIR = join(__dirname, '..', 'seed')

const NAMESPACE = 'kb'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>

export type BootstrapStatus = 'unknown' | 'wip_unreachable' | 'needs_bootstrap' | 'ready'

export interface BootstrapProgress {
  step: string
  detail: string
  done: boolean
  error?: string
}

/**
 * Check if WIP is reachable and whether the namespace exists.
 */
export async function checkStatus(): Promise<BootstrapStatus> {
  let namespaces: Array<{ prefix: string }>
  try {
    namespaces = (await wipGet('/api/registry/namespaces')) as Array<{ prefix: string }>
  } catch {
    return 'wip_unreachable'
  }

  return namespaces.some((ns) => ns.prefix === NAMESPACE) ? 'ready' : 'needs_bootstrap'
}

/**
 * Run the full bootstrap. Calls onProgress for each step.
 *
 * Order: namespace → terminologies (with terms inline) → ontology
 * term-relations → templates (in filename-sorted order so dependencies
 * resolve) → BOOTSTRAP_RECORD audit doc.
 */
export async function runBootstrap(
  onProgress: (p: BootstrapProgress) => void,
): Promise<void> {
  const progress = (step: string, detail: string) =>
    onProgress({ step, detail, done: false })

  const startedAt = new Date().toISOString()
  const templatesCreated: string[] = []
  const edgeTypesCreated: string[] = []
  const terminologiesCreated: string[] = []

  try {
    // Step 1: Create namespace (idempotent upsert via PUT)
    progress('namespace', `Creating ${NAMESPACE} namespace...`)
    await wipPut(`/api/registry/namespaces/${NAMESPACE}`, {
      description: `${NAMESPACE} app data (bootstrap created)`,
    })

    // Step 2: Load and create terminologies
    progress('terminologies', 'Loading seed data...')
    const termFiles = readdirSync(join(SEED_DIR, 'terminologies'))
      .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
      .sort()

    const terminologies: AnyObj[] = []
    for (const file of termFiles) {
      const data = JSON.parse(readFileSync(join(SEED_DIR, 'terminologies', file), 'utf-8'))
      terminologies.push(data)
    }

    progress('terminologies', `Creating ${terminologies.length} terminologies...`)
    const termBulk = terminologies.map((t) => ({
      value: t.value,
      label: t.label,
      description: t.description || '',
      namespace: NAMESPACE,
      ...(t.mutable ? { mutable: true } : {}),
    }))
    const termResult = (await wipPost('/api/def-store/terminologies', termBulk)) as {
      results: Array<{ status: string; id: string; error?: string }>
    }

    // Build value → terminology_id map
    const termIdMap = new Map<string, string>()
    for (const [i, r] of termResult.results.entries()) {
      const term = terminologies[i]
      if (r?.id && term) {
        termIdMap.set(term.value, r.id)
        terminologiesCreated.push(term.value)
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
      await wipPost(`/api/def-store/terminologies/${termId}/terms`, terms)
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
      await wipPost(
        `/api/def-store/ontology/term-relations?namespace=${NAMESPACE}`,
        allRelations,
      )
    }

    // Step 5: Create templates (sorted by filename prefix for dependency order)
    const templateFiles = readdirSync(join(SEED_DIR, 'templates'))
      .filter((f) => f.endsWith('.json'))
      .sort()

    progress('templates', `Creating ${templateFiles.length} templates...`)
    for (const file of templateFiles) {
      const data = JSON.parse(readFileSync(join(SEED_DIR, 'templates', file), 'utf-8'))
      progress('templates', `Creating ${data.value}...`)

      const template: AnyObj = {
        value: data.value,
        label: data.label,
        description: data.description || '',
        namespace: NAMESPACE,
        identity_fields: data.identity_fields || [],
        fields: data.fields.map((f: AnyObj) => mapField(f)),
      }

      // Forward edge-type metadata when present (PoNIF #7).
      if (data.usage && data.usage !== 'entity') template.usage = data.usage
      if (data.source_templates) template.source_templates = data.source_templates
      if (data.target_templates) template.target_templates = data.target_templates
      if (data.versioned === false) template.versioned = false

      if (data.reporting) template.reporting = data.reporting

      await wipPost('/api/template-store/templates?on_conflict=validate', [template])

      if (data.usage === 'relationship') edgeTypesCreated.push(data.value)
      else templatesCreated.push(data.value)
    }

    // Wait for template cache to refresh (PoNIF #6 — wip://ponifs).
    progress('cache', 'Waiting for template cache to refresh...')
    await new Promise((resolve) => setTimeout(resolve, 6000))

    // Step 6: Write the BOOTSTRAP_RECORD audit doc.
    progress('audit', 'Writing BOOTSTRAP_RECORD audit doc...')
    await writeBootstrapRecord({
      startedAt,
      templatesCreated,
      edgeTypesCreated,
      terminologiesCreated,
    })

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
 * Write the BOOTSTRAP_RECORD audit doc.
 *
 * Canonical fields (DESIGN.md §5.9 / §7):
 *   - bootstrap_id: unique ID for this bootstrap run (timestamp-based)
 *   - app_version: from process.env.APP_VERSION
 *   - bootstrapped_at: ISO timestamp when bootstrap *started*
 *   - commit_sha: from process.env.GIT_COMMIT_SHA
 *   - templates_created / edge_types_created / terminologies_created
 *
 * AGENT_IDENTITY seeding (USER1 + 7 YACs) is APP-KB-YAC's responsibility
 * post-bootstrap, not part of this audit doc.
 */
async function writeBootstrapRecord(meta: {
  startedAt: string
  templatesCreated: string[]
  edgeTypesCreated: string[]
  terminologiesCreated: string[]
}): Promise<void> {
  const bootstrapId = `bootstrap-${meta.startedAt.replace(/[:.]/g, '-')}`
  const doc = {
    template_value: 'BOOTSTRAP_RECORD',
    namespace: NAMESPACE,
    data: {
      bootstrap_id: bootstrapId,
      title: `KB bootstrap ${meta.startedAt.slice(0, 16).replace('T', ' ')}`,
      authored_by: 'app:APP-KB',
      app_version: process.env.APP_VERSION || 'unknown',
      bootstrapped_at: meta.startedAt,
      commit_sha: process.env.GIT_COMMIT_SHA || 'unknown',
      templates_created: meta.templatesCreated,
      edge_types_created: meta.edgeTypesCreated,
      terminologies_created: meta.terminologiesCreated,
    },
  }
  await wipPost('/api/document-store/documents', [doc])
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
