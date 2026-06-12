// kb-client served-client endpoints (CASE-437): the running KB instance serves
// its own version-matched write/ingest client. Mounted PUBLIC-READ (before
// requireAuth) so headless clients can fetch with an API key, not a browser
// session. The bundle is non-secret distributable code.
//
//   GET {BASE_PATH}/server-api/kb-client/manifest      -> manifest (schema_version, files[], bundle_digest)
//   GET {BASE_PATH}/server-api/kb-client/download       -> JSON bundle { files: {name: content} } (one-shot)
//   GET {BASE_PATH}/server-api/kb-client/files/:name    -> a single bundle file (whitelisted)
//   GET {BASE_PATH}/server-api/kb-client/install        -> bootstrap shell script (curl | sh) (CASE-440)
//
// files[] and bundle_digest are DERIVED from the kb-client/ directory at serve
// time, so the served manifest can never drift from the actual bundle:
//   - schema_version (hand-set in manifest.json) = identity-model / WRITE-SAFETY
//     gate; the loaders refuse to write on mismatch (kb_client_handshake.py).
//   - bundle_digest (auto) = code/currency signal; a fetcher re-fetches when it
//     changes — no manual client_version bump to forget, no files[] to drift.
// Every route is a real handler so none falls through to the SPA catch-all.
// The whole /server-api/kb-client/ prefix is gateway-exempt from browser-auth
// (CASE-439, prefix-based), so new sub-routes need no gateway config.
import { Router } from 'express'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_DIR = path.resolve(__dirname, '..', 'kb-client')
// Bundled + digested alongside the .py client code. Since CASE-440 this
// includes the runner (kb-client.sh) and the bootstrap (install.sh) — the
// wrapper ships INSIDE the bundle; no FR-YAC checkout in the filing path.
const DOC_FILES = ['README.md', 'kb-client.sh', 'install.sh']
// The cross-YAC case playbook is served with the client (CASE-440: it is
// "how to use the client", so it is version-matched and digest-covered).
// Single source: docs/playbooks/case-workflow.md (synced from the gene-pool
// master) — NOT a second copy under kb-client/.
const PLAYBOOK_NAME = 'case-workflow.md'
const PLAYBOOK_PATH = path.resolve(__dirname, '..', 'docs', 'playbooks', PLAYBOOK_NAME)

// Every non-.py bundle entry, as (name, absolute path) — the playbook lives
// outside CLIENT_DIR.
function extraFiles(): Array<[string, string]> {
  return [
    ...DOC_FILES.map((n): [string, string] => [n, path.join(CLIENT_DIR, n)]),
    [PLAYBOOK_NAME, PLAYBOOK_PATH],
  ]
}

// The runnable client = every .py in kb-client/ (excludes __pycache__, *.pyc,
// and dot/underscore temp files). Derived from disk so a new file is auto-served.
function listClientFiles(): string[] {
  return fs.readdirSync(CLIENT_DIR)
    .filter((n) => n.endsWith('.py') && !n.startsWith('_') && !n.startsWith('.'))
    .sort()
}

// Content digest over the client code + docs + runner + playbook (NOT
// manifest.json, which carries the digest). Changes iff any served file
// changes — the currency signal.
function bundleDigest(pyFiles: string[]): string {
  const h = crypto.createHash('sha256')
  const entries: Array<[string, string]> = [
    ...pyFiles.map((n): [string, string] => [n, path.join(CLIENT_DIR, n)]),
    ...extraFiles(),
  ]
  for (const [name, fp] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
    if (fs.existsSync(fp)) {
      h.update(name + '\0')
      h.update(fs.readFileSync(fp))
      h.update('\0')
    }
  }
  return h.digest('hex')
}

// Served manifest = hand-set fields (manifest.json, {BASE_PATH} resolved) +
// derived files[] + bundle_digest.
function buildManifest(): Record<string, unknown> {
  const base = (process.env.APP_BASE_PATH || '').replace(/\/$/, '')
  const stat = JSON.parse(
    fs.readFileSync(path.join(CLIENT_DIR, 'manifest.json'), 'utf-8').replaceAll('{BASE_PATH}', base),
  )
  const files = listClientFiles()
  return { ...stat, files, bundle_digest: bundleDigest(files) }
}

const router = Router()

router.get('/manifest', (_req, res) => {
  try {
    res.json(buildManifest())
  } catch (e: unknown) {
    res.status(500).json({ error: `kb-client manifest unavailable: ${(e as Error).message}` })
  }
})

router.get('/download', (_req, res) => {
  // One-shot bundle. Dep-free (no tar/zip); the fetcher writes each entry and
  // re-fetches when bundle_digest changes. Includes the .py client, manifest,
  // README, the kb-client.sh runner + install.sh, and the case playbook.
  try {
    const m = buildManifest()
    const files: Record<string, string> = {}
    const entries: Array<[string, string]> = [
      ...(m.files as string[]).map((n): [string, string] => [n, path.join(CLIENT_DIR, n)]),
      ['manifest.json', path.join(CLIENT_DIR, 'manifest.json')],
      ...extraFiles(),
    ]
    for (const [name, fp] of entries) {
      if (path.basename(name) !== name) continue // traversal guard
      if (fs.existsSync(fp)) files[name] = fs.readFileSync(fp, 'utf-8')
    }
    res.json({
      client: m.client,
      client_version: m.client_version,
      schema_version: m.schema_version,
      bundle_digest: m.bundle_digest,
      files,
    })
  } catch (e: unknown) {
    res.status(500).json({ error: `kb-client bundle read failed: ${(e as Error).message}` })
  }
})

router.get('/files/:name', (req, res) => {
  const name = req.params.name
  const extras = new Map(extraFiles())
  const allowed = new Set([...listClientFiles(), 'manifest.json', ...extras.keys()])
  if (!allowed.has(name) || path.basename(name) !== name) {
    res.status(404).json({ error: `not a kb-client file: ${name}` })
    return
  }
  const fp = extras.get(name) ?? path.join(CLIENT_DIR, name)
  res.type('text/plain').sendFile(fp)
})

// CASE-440: the one-liner bootstrap — `curl -fsSk -H "X-API-Key: $KEY" …/install | sh`
// materializes the bundle (digest-checked) into the local cache. Real handler,
// so it cannot fall through to the SPA catch-all (the Day-65 /download lesson).
router.get('/install', (_req, res) => {
  const fp = path.join(CLIENT_DIR, 'install.sh')
  if (!fs.existsSync(fp)) {
    res.status(500).json({ error: 'install script missing from bundle dir' })
    return
  }
  res.type('text/x-shellscript').sendFile(fp)
})

export default router
