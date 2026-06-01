# kb-client — the KB write/ingest client

The loaders that ingest cases / journals / sessions / stats into a KB instance's
`kb` namespace. **Owned by APP-KB-YAC** and **served from the running KB instance**
(downloadable from the app, versioned with the server) — see CASE-437 and
`FR-YAC/papers/kb-client-ownership-and-distribution.md`.

Any client of a KB instance fetches *this* client from *that* instance
(`GET {BASE_PATH}/server-api/kb-client/download` — one-shot JSON bundle — or
`/files/<name>` per file) and runs it. The client is version-matched to the
server: it checks its `schema_version` against the instance manifest
(`{BASE_PATH}/server-api/kb-client/manifest`) and refuses to write on mismatch
(`kb_client_handshake.py`), so schema skew is impossible by construction.

## Roster
| File | Role |
|---|---|
| `kb_write_core.py` | Shared core (stdlib-only): doc builders, `detect_document_meta`, `VALID_TARGETS`, `DOC_PATH_RE`, edge derivation (CASE-407). Imported by the entry scripts. |
| `add-to-kb.py` | Single-file mirror to the canonical instance. CASE_RECORD → resolve-then-update (resolve `CASE-<n>` → PATCH in place, else create); SESSION/JOURNEY/DOCUMENT → upsert by their own identity. |
| `kb-bulk-mirror.py` | Bulk mirror (cases → resolve-then-update; journeys/documents → upsert-by-identity). |
| `case-fetch.py` | REST-canonical case/journal read (CASE-393). |
| `case-update.py` | kb-native case state push (`respond`) — PATCHes the case in place and sets `data.status` (CASE-396/425). |
| `case_allocate.py` | Case-number allocator — allocate-then-create on the atomic synonym claim; replaces `case-helper.sh claim` (CASE-425/427). |
| `stats-to-kb.py` | Git-stats snapshot loader. |
| `kb_client_handshake.py` | No-skew schema handshake (`verify_from_env`) — refuses to write on client/instance `schema_version` mismatch. |

## Status — v2 client (CASE-425 / 437)
`schema_version: v2`. The v2 identity model is **Mixed** — only CASE_RECORD changes:

- **CASE_RECORD:** identity = the registry-assigned `document_id` (UUID); `case_number`
  is a display field whose uniqueness + human handle are carried by a `CASE-<n>`
  Registry synonym; `identity_fields: []`. Allocation = allocate-then-create on the
  atomic synonym claim (CASE-427/436); re-mirror = resolve-then-update.
- **SESSION / JOURNEY_ENTRY / DOCUMENT:** keep their `identity_fields`
  (`session_id` / `title` / `path`) — unique by construction, no allocation (C7).
- **Single canonical instance** (dual-write retired): one target.
- The v2 client is **backward-compatible with a still-v1 CASE_RECORD template**, so it
  is safe to run before the template flip (PATCH-by-id is version-agnostic; create
  still upserts under v1).

## Running
Run from inside `kb-client/` (so `from kb_write_core import …` resolves), e.g.
`python3 kb-client/add-to-kb.py <flat-file>`.

Env:
- `KB_BASE_URL` / `KB_KEY_FILE` — the canonical instance + admin key (default
  `https://wip-kb.local`).
- `KB_NAMESPACE` (default `kb`), `KB_VERIFY_TLS` (default `false`).
- `KB_APP_URL` / `KB_APP_BASE_PATH` — the KB app endpoint serving the manifest, for
  the handshake (distinct from the WIP backend `KB_BASE_URL`). Unset → handshake
  skipped (warn-and-continue if unreachable).
