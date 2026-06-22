/**
 * bootstrap-ns.ts — run the REAL app bootstrap against a throwaway namespace.
 *
 * The KB reload migration (CASE-490/491 radical reload) iterates into a fresh
 * namespace per attempt. Rather than re-implement seeding (and risk drift from
 * the field-mapping in server/lib/bootstrap.ts), this calls the actual
 * runBootstrap() via the KB_BOOTSTRAP_NAMESPACE test-harness override — so the
 * fresh namespace gets the exact (A) templates / terminologies / write-policies
 * the real BootstrapGate would create. Bootstrapping this way ALSO exercises the
 * real bootstrap path, which is half the point of the radical reload.
 *
 * localhost ONLY (CLAUDE.md: test in-flight code on localhost; never canonical).
 *
 * Usage:
 *   WIP_BASE_URL=https://localhost:8443 \
 *   WIP_API_KEY="$(cat ~/.wip-deploy/wip-local/secrets/api-key)" \
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 \
 *   KB_BOOTSTRAP_NAMESPACE=kb-mig-1 \
 *   npx tsx tools/bootstrap-ns.ts
 */
import { runBootstrap } from '../server/lib/bootstrap.js'

const ns = process.env.KB_BOOTSTRAP_NAMESPACE
const url = process.env.WIP_BASE_URL || ''

// Guardrails — this harness must never touch canonical or the real kb namespace.
if (!ns || ns === 'kb') {
  console.error('REFUSE: set KB_BOOTSTRAP_NAMESPACE to a throwaway namespace (not "kb").')
  process.exit(2)
}
if (!/localhost|127\.0\.0\.1/.test(url)) {
  console.error(`REFUSE: WIP_BASE_URL must be localhost for the migration harness (got "${url}").`)
  process.exit(2)
}

let failed = false
await runBootstrap((p) => {
  console.error(`[${p.done ? '✓' : '·'}] ${p.step}: ${p.detail}${p.error ? `  ERROR: ${p.error}` : ''}`)
  if (p.error) failed = true
})
if (failed) {
  console.error(`bootstrap reported an error for ns=${ns}`)
  process.exit(1)
}
console.error(`bootstrap complete for ns=${ns}`)
