/**
 * The server's own WIP API key, resolved one way for every caller.
 *
 * File first (WIP_API_KEY_FILE), then the inline WIP_API_KEY, then ''. A
 * deployment that provides the key as a file picks up a replaced key on
 * restart; an inline value alone can be left behind by a key change and keep
 * being sent after WIP has stopped accepting it. Every server path that calls
 * WIP with the app's key (the /wip proxy bridge, the bootstrap status check,
 * gateway type and topic enumeration, the askBar's MCP calls) must use this,
 * so they cannot disagree about which key is current.
 */

import { readFileSync } from 'fs'

export function resolveWipKey(): string {
  const f = process.env.WIP_API_KEY_FILE
  if (f) {
    try { return readFileSync(f, 'utf-8').trim() } catch { /* fall back to inline */ }
  }
  return process.env.WIP_API_KEY || ''
}
