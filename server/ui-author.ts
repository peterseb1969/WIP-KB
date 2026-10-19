/**
 * Who a browser write is attributed to.
 *
 * The signed-in user's email, from X-WIP-User: the router's auth gateway sets it,
 * and requireAuth() sets it from the OIDC session when the app does its own login.
 * Both run before the UI's write paths. Without either (an install with no
 * authentication, e.g. local dev) the write is attributed to WEB-UI.
 *
 * The guards stamp this onto the write server-side, replacing whatever the browser
 * sent, so a session cannot attribute a write to someone else.
 */
import type { Request } from 'express'

export const WEB_UI_AUTHOR = 'WEB-UI'

export function uiAuthor(req: Request): string {
  const header = req.headers['x-wip-user']
  const user = (Array.isArray(header) ? header[0] : header)?.trim()
  return user || req.session?.user?.email || WEB_UI_AUTHOR
}
