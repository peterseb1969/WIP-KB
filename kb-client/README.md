# kb-client — the KB write/ingest client

The loaders that ingest cases / journals / sessions / stats into a KB instance's
`kb` namespace. **Owned by APP-KB-YAC** and **served from the running KB instance**
(downloadable from the app, versioned with the server) — see CASE-437 and
`FR-YAC/papers/kb-client-ownership-and-distribution.md`.

Any client of a KB instance fetches *this* client from *that* instance
(`GET {BASE_PATH}/server-api/kb-client/download`) and runs it. The client is
version-matched to the server it talks to, which makes schema skew impossible by
construction: a client checks `schema_version` against the instance manifest
(`{BASE_PATH}/server-api/kb-client/manifest`) and refuses to write on mismatch.

## Roster
| File | Role |
|---|---|
| `kb_write_core.py` | Shared core (stdlib-only): doc builders, `detect_document_meta`, `VALID_TARGETS`, `DOC_PATH_RE`, edge derivation (CASE-407). Imported by the entry scripts. |
| `add-to-kb.py` | Single-file dual-write mirror (local + remote, warn-and-continue). |
| `kb-bulk-mirror.py` | Bulk mirror. |
| `case-fetch.py` | REST-canonical case/journal read (CASE-393). |
| `case-update.py` | kb-native case state push — `respond` (CASE-396). |
| `stats-to-kb.py` | Git-stats snapshot loader. |

## Status
**Phase 1 (CASE-437): relocation only — behavior-identical copy of the FR-YAC
loaders.** FR-YAC's `tools/` copies remain the live path until the Phase 2 cutover
(v2 identity model + resolve-then-update + FRanC command rewire). Do not wire
production callers here yet.

- `schema_version: v1` (case_number identity) — current live model.
- Phase 2 flips to **v2** (CASE-425): `document_id`/UUID identity, `CASE-<n>`
  Registry synonym, `case_number` display, `identity_fields:[]`, allocate-then-create
  on the atomic synonym claim (CASE-427/436), re-mirror by resolve-then-update.

## Running
Run from inside `kb-client/` (so `from kb_write_core import …` resolves), e.g.
`python3 kb-client/add-to-kb.py <flat-file>`. Env mirrors the FR-YAC originals
(`KB_LOCAL_URL` / `KB_LOCAL_KEY_FILE` / `KB_BASE_URL` / `KB_API_KEY_FILE` /
`KB_NAMESPACE` / `KB_VERIFY_TLS`).
