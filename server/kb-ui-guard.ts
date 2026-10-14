/**
 * Guard for the browser → KB gateway bridge (/server-api/kb-ui).
 *
 * The bridge mounts the whole gateway for a signed-in browser session and injects
 * the install's API key, a wip-admins key. Unguarded, a session could call any
 * gateway verb: write any document type, create a knowledge domain. The UI needs a
 * handful of writes, so this admits exactly those and refuses the rest:
 *   - GET / HEAD, which read;
 *   - POST /edges with one of the relationship picker's three edge types;
 *   - POST /write/CASE_RESPONSE creating a close or comment response, attributed to
 *     the web UI and linked to its case by RESPONDS_TO (case close / reopen);
 *   - POST /write/CASE_RECORD patching only `status` to open or closed, located by
 *     case_number (the other half of close / reopen);
 *   - POST /write/<type> patching only `topics`, located by document_id (the topic
 *     picker).
 * Anything else answers 405 before it reaches the gateway. The CLI's own mount
 * (/server-api/kb, with the caller's key) is unaffected.
 *
 * Mounted after the JSON body parser, so req.body is the parsed request.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express'

// Must match src/lib/kbGateway.ts WEB_UI_AUTHOR.
export const WEB_UI_AUTHOR = 'WEB-UI'

const UI_EDGE_TYPES = new Set(['REFERENCES', 'RELATES_TO', 'SUPERSEDES'])
const UI_RESPONSE_KINDS = new Set(['close', 'comment'])
const UI_CASE_STATUSES = new Set(['open', 'closed'])

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>

function isObj(v: unknown): v is AnyObj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function onlyKeys(o: AnyObj, keys: string[]): boolean {
  const k = Object.keys(o)
  return k.length === keys.length && keys.every((x) => k.includes(x))
}

// Returns why the request is refused, or null when the UI is allowed to make it.
function refusal(req: Request): string | null {
  if (req.method === 'GET' || req.method === 'HEAD') return null
  if (req.method !== 'POST') return `${req.method} is not used by the KB UI`
  const path = req.path.replace(/\/+$/, '')
  const b: AnyObj = isObj(req.body) ? req.body : {}

  if (path === '/edges') {
    return UI_EDGE_TYPES.has(String(b.type)) ? null : `edge type ${b.type} is not one the KB UI creates`
  }

  const m = path.match(/^\/write\/([A-Za-z0-9_]+)$/)
  if (!m) return `POST ${path} is not used by the KB UI`
  const type = m[1]
  const allowedTop = b.patch !== undefined ? ['patch', 'match'] : ['data', 'edges']
  if (!Object.keys(b).every((k) => allowedTop.includes(k))) {
    return `the KB UI does not send ${Object.keys(b).filter((k) => !allowedTop.includes(k)).join(', ')}`
  }

  if (b.patch !== undefined) {
    if (!isObj(b.patch) || !isObj(b.match)) return 'patch and match must be objects'
    if (onlyKeys(b.patch, ['topics'])) {
      if (!Array.isArray(b.patch.topics) || !b.patch.topics.every((t: unknown) => typeof t === 'string')) {
        return 'topics must be a list of topic values'
      }
      return onlyKeys(b.match, ['document_id']) ? null : 'a topics patch is located by document_id'
    }
    if (type === 'CASE_RECORD' && onlyKeys(b.patch, ['status'])) {
      if (!UI_CASE_STATUSES.has(String(b.patch.status))) return `the KB UI only sets a case to open or closed`
      return onlyKeys(b.match, ['case_number']) ? null : 'a case status patch is located by case_number'
    }
    return `the KB UI does not patch ${Object.keys(b.patch).join(', ')} on ${type}`
  }

  if (type !== 'CASE_RESPONSE') return `the KB UI does not create ${type} documents`
  const d: AnyObj = isObj(b.data) ? b.data : {}
  if (d.author !== WEB_UI_AUTHOR) return `a response from the KB UI is attributed to ${WEB_UI_AUTHOR}`
  if (!UI_RESPONSE_KINDS.has(String(d.response_kind))) {
    return `the KB UI writes only close and comment responses`
  }
  const edges: unknown[] = Array.isArray(b.edges) ? b.edges : []
  const linksOwnCase =
    edges.length === 1 &&
    isObj(edges[0]) &&
    edges[0].type === 'RESPONDS_TO' &&
    edges[0].target_type === 'CASE_RECORD' &&
    String(edges[0].target_key) === String(d.case_number)
  return linksOwnCase ? null : 'a response from the KB UI is linked to its own case by RESPONDS_TO, and nothing else'
}

export function kbUiGuard(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const why = refusal(req)
    if (why === null) return next()
    res.status(405).json({ error: `Not allowed from the KB UI: ${why}` })
  }
}
