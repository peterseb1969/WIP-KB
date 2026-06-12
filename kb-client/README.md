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
| `kb-client.sh` | The runner (CASE-440): fetch/refresh the bundle on `bundle_digest` change, then run a script with `PYTHONPATH` set. Ships inside the bundle — relocated out of FR-YAC. |
| `install.sh` | One-liner bootstrap (CASE-440): `curl -fsSk -H "X-API-Key: $KEY" {BASE_PATH}/server-api/kb-client/install \| sh` materializes the bundle to `~/.cache/wip-kb-client`. |
| `case-workflow.md` | The cross-YAC case playbook, served with the client (single source: `docs/playbooks/case-workflow.md`, synced from the gene-pool master). |

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

## Versioning — two independent signals
- **`schema_version`** (e.g. `v2`, hand-set) = the **identity-model / write-safety**
  gate. The served loaders refuse to write on a schema mismatch
  (`kb_client_handshake.py`), because a wrong identity model corrupts data (e.g. a
  v1 create-upsert client against a v2 `identity_fields:[]` template duplicates
  cases). **Bumps only on identity-model changes.**
- **`bundle_digest`** (auto) = the **code/currency** signal — a sha256 the
  `/manifest` endpoint computes over the served files at request time. **A fetcher
  re-fetches when it changes.** `files[]` and `bundle_digest` are *derived from the
  `kb-client/` directory at serve time*, so the served manifest can never drift
  from the actual bundle and there's no manual version to forget (this is what
  caused the earlier "allocator missing from the bundle" / stale-cache misses).
- **`client_version`** is an informational human semver only — **not** the currency
  signal; use `bundle_digest`. (CASE-437.)

## Running
Run from inside `kb-client/` (so `from kb_write_core import …` resolves), e.g.
`python3 kb-client/add-to-kb.py <flat-file>`.

Env:
- `KB_BASE_URL` — the canonical instance (default `https://wip-kb.local`).
- `KB_API_KEY_FILE` — its key file (default `~/.wip-deploy/wip-kb/secrets/api-key`).
  **One var across the whole bundle** (CASE-444); `KB_KEY_FILE` is accepted as a
  deprecated alias with a stderr warning. The default key pairs only with the
  default target: overriding `KB_BASE_URL` without setting `KB_API_KEY_FILE`
  fails loud instead of silently 401-ing with the canonical instance's key.
  No `/Users/<user>` literals — defaults derive from `$HOME`.
- `KB_LOCAL_URL` / `KB_LOCAL_KEY_FILE` — the optional local fast-path instance
  (`case-fetch`/`case-update` `KB_PREFER_LOCAL=1`, `stats-to-kb` local target);
  defaults `https://localhost:8443` + `~/.wip-deploy/wip-dev-local/secrets/api-key`,
  same pairing guard.
- `KB_NAMESPACE` (default `kb`), `KB_VERIFY_TLS` (default `false`),
  `KB_DEV_ROOT` (default `~/Development` — flat-file repo roots).
- `KB_APP_URL` / `KB_APP_BASE_PATH` — the KB app endpoint serving the manifest, for
  the handshake (distinct from the WIP backend `KB_BASE_URL`). Unset → handshake
  skipped (warn-and-continue if unreachable).
