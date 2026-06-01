// kb-client served-client endpoints (CASE-437): the running KB instance serves
// its own version-matched write/ingest client. Mounted PUBLIC-READ (before
// requireAuth) so headless clients can fetch with an API key, not a browser
// session. The bundle is non-secret distributable code.
//
//   GET {BASE_PATH}/server-api/kb-client/manifest      -> manifest (schema_version, files[], bundle_digest)
//   GET {BASE_PATH}/server-api/kb-client/download       -> JSON bundle { files: {name: content} } (one-shot)
//   GET {BASE_PATH}/server-api/kb-client/files/:name    -> a single bundle file (whitelisted)
//
// files[] and bundle_digest are DERIVED from the kb-client/ directory at serve
// time, so the served manifest can never drift from the actual bundle:
//   - schema_version (hand-set in manifest.json) = identity-model / WRITE-SAFETY
//     gate; the loaders refuse to write on mismatch (kb_client_handshake.py).
//   - bundle_digest (auto) = code/currency signal; a fetcher re-fetches when it
//     changes — no manual client_version bump to forget, no files[] to drift.
// Every route is a real handler so none falls through to the SPA catch-all.
import { Router } from 'express'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_DIR = path.resolve(__dirname, '..', 'kb-client')
const DOC_FILES = ['README.md'] // bundled + digested alongside the .py client code

// The runnable client = every .py in kb-client/ (excludes __pycache__, *.pyc,
// and dot/underscore temp files). Derived from disk so a new file is auto-served.
function listClientFiles(): string[] {
  return fs.readdirSync(CLIENT_DIR)
    .filter((n) => n.endsWith('.py') && !n.startsWith('_') && !n.startsWith('.'))
    .sort()
}

// Content digest over the client code + docs (NOT manifest.json, which carries
// the digest). Changes iff any served file changes — the currency signal.
function bundleDigest(pyFiles: string[]): string {
  const h = crypto.createHash('sha256')
  for (const name of [...pyFiles, ...DOC_FILES].sort()) {
    const fp = path.join(CLIENT_DIR, name)
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
  // re-fetches when bundle_digest changes.
  try {
    const m = buildManifest()
    const names = [...(m.files as string[]), 'manifest.json', ...DOC_FILES]
    const files: Record<string, string> = {}
    for (const name of names) {
      const fp = path.join(CLIENT_DIR, name)
      if (fp !== path.join(CLIENT_DIR, path.basename(name))) continue // traversal guard
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
  const allowed = new Set([...listClientFiles(), 'manifest.json', ...DOC_FILES])
  if (!allowed.has(name)) {
    res.status(404).json({ error: `not a kb-client file: ${name}` })
    return
  }
  const fp = path.join(CLIENT_DIR, name)
  if (fp !== path.join(CLIENT_DIR, path.basename(name))) {
    res.status(400).json({ error: 'bad path' })
    return
  }
  res.type('text/plain').sendFile(fp)
})

export default router
