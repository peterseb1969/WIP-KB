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
import { CORPUS_NS } from './namespaces'

const GW_BASE = `${import.meta.env.BASE_URL}server-api/kb-ui`

export const WEB_UI_AUTHOR = 'WEB-UI'

/** POST JSON to a gateway verb; surface the gateway's `{error}` message on failure. */
async function gwPost<T = unknown>(path: string, body: unknown): Promise<T> {
  // Every write lands in the knowledge base being viewed. Without the parameter the
  // gateway falls back to its default domain, so under /ns/<other>/ a case action
  // would patch the default domain's case with the same number. (A Library-owned
  // type is still routed to the Library namespace by the gateway.)
  const sep = path.includes('?') ? '&' : '?'
  const res = await fetch(`${GW_BASE}${path}${sep}namespace=${encodeURIComponent(CORPUS_NS)}`, {
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
 * Replace a document's `topics` via `/write/<type>` (patch mode, matched on
 * document_id). Sending the whole array rather than a delta is deliberate: JSON
 * Merge Patch replaces arrays wholesale, so a full list is what the wire format
 * actually means, and add and remove become the same call.
 *
 * Values are term VALUES, not ids — document validation resolves them against
 * the template's terminology, which is also what rejects anything that is not a
 * real topic. The picker offers selection only, so the vocabulary stays the
 * authority rather than whatever a user could type.
 *
 * The type is passed because the gateway routes a write to the type's home
 * namespace: LIBRARY_DOC lands in the Library namespace, everything else in the
 * corpus, and the caller does not have to know which.
 */
export function patchDocTopics(
  templateValue: string,
  documentId: string,
  topics: string[],
): Promise<{ document_id: string; result: string }> {
  return gwPost(`/write/${templateValue}`, {
    patch: { topics },
    match: { document_id: documentId },
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

/** A failed gateway read; `status` lets a caller tell "not there" from "broken". */
export class GatewayError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

/** GET a gateway read; surface the gateway's `{error}` message on failure. */
async function gwGet<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${GW_BASE}${path}`)
  const text = await res.text()
  let json: unknown
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    json = { error: text }
  }
  if (!res.ok) {
    const msg = (json as { error?: string })?.error || `${res.status} ${res.statusText}`
    throw new GatewayError(msg, res.status)
  }
  return json as T
}

export interface BriefItem {
  handle: string
  document_id: string
  title: string | null
  created_at: string | null
  updated_at: string | null
  status?: string | null
  target_yac?: string | null
  started_at?: string | null
  ended_at?: string | null
  description?: string | null
  path?: string | null
  synced_from_sha?: string | null
}

export interface BriefSection {
  total: number | null
  items: BriefItem[]
  unavailable?: boolean
}

export interface ProjectBrief {
  app: string
  namespace: string
  as_of: string
  project: {
    document_id: string
    title: string | null
    scope: string | null
    repo_ids: string[]
    tooling: {
      file_id: string
      filename: string | null
      size_bytes: number | null
      content_type: string | null
    } | null
    updated_at: string | null
  } | null
  notes: string[]
  sections: Record<string, BriefSection>
}

/**
 * A project's brief from the gateway's `/projects/:app/brief` — the same read a
 * project's Claude gets at session start. `app` is any spelling of the project's
 * KB_APP term; the gateway resolves it.
 */
export function fetchProjectBrief(app: string, namespace: string): Promise<ProjectBrief> {
  return gwGet(`/projects/${encodeURIComponent(app)}/brief?namespace=${encodeURIComponent(namespace)}`)
}

/** Download link for a project's tooling archive, served as stored. */
export function projectToolingUrl(app: string, namespace: string): string {
  return `${GW_BASE}/projects/${encodeURIComponent(app)}/tooling?namespace=${encodeURIComponent(namespace)}`
}
