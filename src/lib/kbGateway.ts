// Browser → KB gateway bridge client (CASE-484).
//
// Case-write semantics — response_seq minting, the CASE-<n>#<seq> synonym, edge
// linking, status-transition persistence — live in the server-side KB gateway,
// the SAME core the `kb-write.py` CLI uses. The browser reaches that core through
// the authenticated `/server-api/kb-ui` bridge (which injects the API key); it
// never re-implements the mint or writes to the document-store directly. This is
// the human front-end on one shared core, not a second write path.
//
// Human-authored writes are attributed to WEB_UI_AUTHOR until a real
// human-attribution model lands (the open question on CASE-484).

// BASE_URL always ends in `/` (dev `/`, prod `/apps/kb/`); concatenating without
// a leading slash yields the right URL in both — same pattern as lib/wipBulk.ts.
const GW_BASE = `${import.meta.env.BASE_URL}server-api/kb-ui`

export const WEB_UI_AUTHOR = 'WEB-UI'

/** POST JSON to a gateway verb; surface the gateway's `{error}` message on failure. */
async function gwPost<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${GW_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json: unknown
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    json = { error: text }
  }
  if (!res.ok) {
    const msg = (json as { error?: string })?.error || `${res.status} ${res.statusText}`
    throw new Error(msg)
  }
  return json as T
}

export interface EdgeResult {
  type: string
  source: string
  target: string
  source_id: string
  target_id: string
  status: string
}

/**
 * Attach an edge between two existing docs via the gateway `/edges` verb.
 * source/target are document_ids or Registry handles (e.g. `CASE-484`); the
 * gateway resolves them. Idempotent — KB edge types are versioned:false with
 * identity [source_ref, target_ref], so re-adding overwrites in place.
 */
export function addEdge(type: string, source: string, target: string): Promise<EdgeResult> {
  return gwPost<EdgeResult>('/edges', { type, source, target })
}

export type ResponseKind = 'respond' | 'comment' | 'close' | 'implement'

/**
 * Append a CASE_RESPONSE to a case's thread via `/write/CASE_RESPONSE`, linked by
 * a RESPONDS_TO edge. The gateway mints response_seq (scoped to the case) and the
 * CASE-<n>#<seq> synonym — the browser sends neither. Attributed to WEB-UI.
 */
export function writeCaseResponse(
  caseNumber: number,
  kind: ResponseKind,
  body: string,
): Promise<{ document_id: string; number?: number; synonym?: string }> {
  return gwPost('/write/CASE_RESPONSE', {
    data: {
      case_number: caseNumber,
      response_kind: kind,
      body,
      author: WEB_UI_AUTHOR,
      doc_status: 'published',
    },
    edges: [{ type: 'RESPONDS_TO', target_type: 'CASE_RECORD', target_key: caseNumber }],
  })
}

/**
 * Patch a case's status via `/write/CASE_RECORD` (patch mode, matched on
 * case_number — CASE_RECORD's identity field). Used for the close/reopen
 * lifecycle transitions; the gateway applies an optimistic-concurrency merge patch.
 */
export function patchCaseStatus(
  caseNumber: number,
  status: string,
): Promise<{ document_id: string; result: string }> {
  return gwPost('/write/CASE_RECORD', {
    patch: { status },
    match: { case_number: caseNumber },
  })
}
