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

import { resolveWipKey } from './wip-key.js'

const WIP_BASE_URL = process.env.WIP_BASE_URL || 'https://wip-kb.local'
const WIP_API_KEY = resolveWipKey()

// `key` overrides the server's own key. The gateway passes the caller's key so a
// namespace created from the CLI is created with the caller's authority, never
// the server's; BootstrapGate passes none and keeps using the server key.
function headers(key?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-API-Key': key || WIP_API_KEY,
  }
}

export async function wipGet(path: string, key?: string): Promise<unknown> {
  const res = await fetch(`${WIP_BASE_URL}${path}`, { headers: headers(key) })
  if (!res.ok) throw new Error(`WIP GET ${path}: ${res.status} ${res.statusText}`)
  return res.json()
}

export async function wipPost(path: string, body: unknown, key?: string): Promise<unknown> {
  const res = await fetch(`${WIP_BASE_URL}${path}`, {
    method: 'POST',
    headers: headers(key),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`WIP POST ${path}: ${res.status} ${res.statusText}`)
  return res.json()
}

export async function wipPut(path: string, body: unknown, key?: string): Promise<unknown> {
  const res = await fetch(`${WIP_BASE_URL}${path}`, {
    method: 'PUT',
    headers: headers(key),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`WIP PUT ${path}: ${res.status} ${res.statusText}`)
  return res.json()
}
