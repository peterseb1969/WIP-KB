/**
 * Guard for the browser's /wip proxy.
 *
 * The proxy forwards to WIP with the install's API key, and that key is in
 * wip-admins: unguarded, any signed-in browser session could do anything an
 * administrator can — delete a namespace, mint an API key, rewrite a template. The
 * UI needs far less: it reads, and it writes exactly one thing directly, a
 * flag-for-YAC (a FLAG_RECORD plus its FLAGGED_FROM edge). Every other UI write
 * goes through the KB gateway or an admin-gated server route. So this lets through:
 *   - GET / HEAD / OPTIONS, which read;
 *   - POST to the endpoints that are reads with a request body (queries, search,
 *     registry lookup);
 *   - POST /api/document-store/documents when every item is a FLAG_RECORD or a
 *     FLAGGED_FROM document, checked against those templates' ids in the item's
 *     own namespace.
 * Everything else is refused with 405 before it reaches WIP.
 *
 * Mounted ahead of wipProxy, which streams the request body upstream as it
 * arrives. So the guard decides on method and path alone and leaves the body
 * unread, except for a document create: that body has to be read to be checked,
 * after which the proxy has nothing left to stream, so the guard forwards an
 * allowed create to WIP itself.
 */
import express, { type Request, type Response, type NextFunction, type RequestHandler } from 'express'

const WIP_BASE = (process.env.WIP_BASE_URL || 'https://wip-kb.local').replace(/\/$/, '')

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

// POST endpoints whose request body is a query, not a write.
const READ_POSTS = new Set([
  '/api/document-store/documents/query',
  '/api/reporting-sync/search',
  '/api/reporting-sync/query',
  '/api/registry/entries/lookup/by-key',
])

const DOCUMENT_CREATE = '/api/document-store/documents'
const FLAG_TEMPLATES = ['FLAG_RECORD', 'FLAGGED_FROM']

function refuse(res: Response, status: number, error: string): void {
  res.status(status).json({ error })
}

export function wipProxyGuard(wipKey: string): RequestHandler {
  // The ids of FLAG_RECORD and FLAGGED_FROM in one namespace.
  async function flagTemplateIds(ns: string): Promise<Set<string>> {
    const ids = new Set<string>()
    await Promise.all(
      FLAG_TEMPLATES.map(async (value) => {
        const r = await fetch(
          `${WIP_BASE}/api/template-store/templates/by-value/${value}?namespace=${encodeURIComponent(ns)}`,
          { headers: { 'X-API-Key': wipKey } },
        )
        if (r.ok) {
          const t = await r.json()
          if (t?.template_id) ids.add(t.template_id)
        }
      }),
    )
    return ids
  }

  // Forward an already-read document create, relaying WIP's answer as it came.
  async function forwardCreate(req: Request, res: Response, body: Buffer): Promise<void> {
    const upstream = await fetch(`${WIP_BASE}${req.url}`, {
      method: 'POST',
      headers: { 'X-API-Key': wipKey, 'Content-Type': req.headers['content-type'] || 'application/json' },
      body: new Uint8Array(body),
    })
    res.status(upstream.status)
    const ct = upstream.headers.get('content-type')
    if (ct) res.setHeader('content-type', ct)
    res.send(Buffer.from(await upstream.arrayBuffer()))
  }

  const rawBody = express.raw({ type: '*/*', limit: '100mb' })

  const guard = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (READ_METHODS.has(req.method)) return next()
    const path = req.path.replace(/\/+$/, '')
    if (req.method === 'POST' && READ_POSTS.has(path)) return next()
    if (req.method === 'POST' && path === DOCUMENT_CREATE) {
      await new Promise<void>((resolve, reject) => rawBody(req, res, (err?: unknown) => (err ? reject(err) : resolve())))
      let items: unknown
      try {
        items = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf-8') : '')
      } catch {
        return refuse(res, 400, 'document create body is not JSON')
      }
      if (!Array.isArray(items) || items.length === 0) {
        return refuse(res, 400, 'document create body must be a non-empty array')
      }
      const byNs = new Map<string, Set<string>>()
      for (const it of items as Array<Record<string, unknown>>) {
        const ns = typeof it?.namespace === 'string' ? it.namespace : ''
        const tid = typeof it?.template_id === 'string' ? it.template_id : ''
        if (!ns || !tid) {
          return refuse(res, 403, 'a document created from the browser must name its namespace and template_id')
        }
        if (!byNs.has(ns)) byNs.set(ns, await flagTemplateIds(ns))
        if (!byNs.get(ns)!.has(tid)) {
          return refuse(
            res,
            403,
            'the browser may create only FLAG_RECORD and FLAGGED_FROM documents directly; other writes go through the KB gateway',
          )
        }
      }
      return forwardCreate(req, res, req.body as Buffer)
    }
    refuse(res, 405, `${req.method} ${path} is not allowed through the KB's WIP proxy; it is read-only apart from flag-for-YAC`)
  }

  return (req, res, next) => void guard(req, res, next).catch(next)
}
