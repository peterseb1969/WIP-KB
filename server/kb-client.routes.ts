// kb-client served-client endpoints (CASE-437): the running KB instance serves
// its own version-matched write/ingest client. Mounted PUBLIC-READ (before
// requireAuth) so headless clients can fetch with an API key, not a browser
// session. The bundle is non-secret distributable code.
//
//   GET {BASE_PATH}/server-api/kb-client/manifest      -> manifest.json (schema_version, file list)
//   GET {BASE_PATH}/server-api/kb-client/download       -> JSON bundle { files: {name: content} } (one-shot)
//   GET {BASE_PATH}/server-api/kb-client/files/:name    -> a single bundle file (whitelisted)
//
// /download returns a dep-free JSON bundle (no tar/zip); /files is the per-file
// alternative. The manifest's schema_version is the no-skew handshake key
// (kb_client_handshake.py). Every route is a real handler so none falls through
// to the SPA catch-all.
import { Router } from 'express'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_DIR = path.resolve(__dirname, '..', 'kb-client')

const router = Router()

interface Manifest {
  files: string[]
  [k: string]: unknown
}

function loadManifest(): Manifest {
  return JSON.parse(fs.readFileSync(path.join(CLIENT_DIR, 'manifest.json'), 'utf-8'))
}

router.get('/manifest', (_req, res) => {
  try {
    const base = (process.env.APP_BASE_PATH || '').replace(/\/$/, '')
    const resolved = JSON.parse(fs.readFileSync(path.join(CLIENT_DIR, 'manifest.json'), 'utf-8')
      .replaceAll('{BASE_PATH}', base))
    res.json(resolved)
  } catch (e: unknown) {
    res.status(500).json({ error: `kb-client manifest unavailable: ${(e as Error).message}` })
  }
})

router.get('/download', (_req, res) => {
  // One-shot bundle: { client, client_version, schema_version, files: {name: content} }.
  // Dep-free (no tar/zip); the client-fetcher writes each entry to its kb-client dir.
  let manifest: Manifest
  try {
    manifest = loadManifest()
  } catch (e: unknown) {
    res.status(500).json({ error: `kb-client manifest unavailable: ${(e as Error).message}` })
    return
  }
  const names = [...manifest.files, 'manifest.json', 'README.md']
  const files: Record<string, string> = {}
  try {
    for (const name of names) {
      const fp = path.join(CLIENT_DIR, name)
      if (fp !== path.join(CLIENT_DIR, path.basename(name))) continue // path-traversal guard
      if (fs.existsSync(fp)) files[name] = fs.readFileSync(fp, 'utf-8')
    }
  } catch (e: unknown) {
    res.status(500).json({ error: `kb-client bundle read failed: ${(e as Error).message}` })
    return
  }
  res.json({
    client: manifest.client,
    client_version: manifest.client_version,
    schema_version: manifest.schema_version,
    files,
  })
})

router.get('/files/:name', (req, res) => {
  let manifest: Manifest
  try {
    manifest = loadManifest()
  } catch (e: unknown) {
    res.status(500).json({ error: `kb-client manifest unavailable: ${(e as Error).message}` })
    return
  }
  const name = req.params.name
  // Whitelist to the manifest's declared files — never serve arbitrary paths.
  const allowed = new Set([...manifest.files, 'manifest.json', 'README.md', 'kb_client_handshake.py'])
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
