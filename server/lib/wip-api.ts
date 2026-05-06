/**
 * Minimal server-side WIP REST helpers.
 *
 * GET / POST / PUT against `wip-kb` with X-API-Key auth. Self-signed TLS
 * is handled by NODE_TLS_REJECT_UNAUTHORIZED=0 in the dev:server script
 * (NOT in start/production — see CLAUDE.md).
 *
 * Scope is bootstrap-only on purpose. KB UI work happens through
 * @wip/client + @wip/react with the @wip/proxy middleware doing
 * auth injection at the proxy layer; these helpers are just the
 * server-side bootstrap path that runs before any of that exists.
 */

const WIP_BASE_URL = process.env.WIP_BASE_URL || 'https://wip-kb.local'
const WIP_API_KEY = process.env.WIP_API_KEY || ''

function headers(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-API-Key': WIP_API_KEY,
  }
}

export async function wipGet(path: string): Promise<unknown> {
  const res = await fetch(`${WIP_BASE_URL}${path}`, { headers: headers() })
  if (!res.ok) throw new Error(`WIP GET ${path}: ${res.status} ${res.statusText}`)
  return res.json()
}

export async function wipPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${WIP_BASE_URL}${path}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`WIP POST ${path}: ${res.status} ${res.statusText}`)
  return res.json()
}

export async function wipPut(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${WIP_BASE_URL}${path}`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`WIP PUT ${path}: ${res.status} ${res.statusText}`)
  return res.json()
}
