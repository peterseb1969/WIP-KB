# kb-client — the KB read/write client

The client every YAC uses to talk to a KB instance. **All calls go through the
KB gateway API** (`{BASE_PATH}/server-api/kb/…`) — never the document-store
backend (CASE-482, the "straight to MongoDB" anti-pattern). Reads: cases,
journals, firesides, faceted lists. Writes: one path — `POST /write/:type` — the
client parses + validates the source and the gateway persists (mint or
natural-upsert per the type's `WRITE_POLICY` doc, edge-intents, and `{patch, match}`
field updates).

**Owned by APP-KB-YAC** and **served from the running KB instance** (downloadable,
versioned with the server) — see CASE-437 and
`FR-YAC/papers/kb-client-ownership-and-distribution.md`. Any client fetches *this*
client from *that* instance (`GET {BASE_PATH}/server-api/kb-client/download` —
one-shot JSON bundle — or `/files/<name>` per file) and runs it, refreshing on
`bundle_digest` change.

## Roster
| File | Role |
|---|---|
| `kb_client_core.py` | Shared core (stdlib-only): `.claude/kb.json` + API-key resolution (CASE-444/471), target config, and the gateway transport — `gw_get`/`gw_post` with local→remote failover. Imported by every script. |
| `case-fetch.py` | Read commands — `case` / `journey` / `list` / `fireside` — over the gateway (CASE-393/479/482). |
| `kb-write.py` | Write client — one generic surface over `POST /write/:type`; `--list` shows writable types via `GET /types` (CASE-482). |
| `stats-to-kb.py` | Git-stats snapshot computer — computes locally, writes via `/write/GIT_STATS_SNAPSHOT` (roster title/tags composed client-side). |
| `kb-client.sh` | The runner (CASE-440): fetch/refresh the bundle on `bundle_digest` change, then run a script with `PYTHONPATH` set. Ships inside the bundle — relocated out of FR-YAC. |
| `install.sh` | One-liner bootstrap (CASE-440): `curl -fsSk -H "X-API-Key: $KEY" {BASE_PATH}/server-api/kb-client/install \| sh` materializes the bundle to `~/.cache/wip-kb-client`. |
| `case-workflow.md` | The cross-YAC case playbook, served with the client (single source: `docs/playbooks/case-workflow.md`, synced from the gene-pool master). |

## Status — v3 (CASE-481 / 482)

One generic write path; per-type behaviour is **data**, not code:

- **Write surface:** `POST /write/:type` only. `{data, edges?}` creates / mints /
  upserts; `{patch, match:{field:value}}` partial-updates. Edge-intents
  (`CONTINUES_FROM`, `RESPONDS_TO`, `REFERENCES`) resolve by the target's identity
  field. The gateway parses no files — the client owns all source parsing + validation.
- **Identity:** mint types carry a KB-allocated number + synonym defined by a
  `WRITE_POLICY` document — CASE_RECORD→`CASE-<n>`,
  FIRESIDE/DESIGN_DECISION/LESSON/DOCUMENT, and CASE_RESPONSE→scoped `CASE-<n>#<seq>`
  (`scope_field` + `synonym_template`). Natural types upsert by their
  `identity_fields`. No `identity_fields: []` loophole.
- **Case flow:** file→`/write/CASE_RECORD`; respond→`/write/CASE_RESPONSE` +
  `RESPONDS_TO`; close→`--patch status=…`. The client enforces transition validity;
  the gateway is pure persistence.

## Versioning — two independent signals
- **`schema_version`** — RETIRED as a write gate (CASE-464 Roll B: no write
  paths remain in the bundle). Kept as an informational field describing the
  instance's identity model.
- **`bundle_digest`** (auto) = the **code/currency** signal — a sha256 the
  `/manifest` endpoint computes over the served files at request time. **A fetcher
  re-fetches when it changes.** `files[]` and `bundle_digest` are *derived from the
  `kb-client/` directory at serve time*, so the served manifest can never drift
  from the actual bundle and there's no manual version to forget (this is what
  caused the earlier "allocator missing from the bundle" / stale-cache misses).
- **`client_version`** is an informational human semver only — **not** the currency
  signal; use `bundle_digest`. (CASE-437.)

## Running
Normally invoked via the `kb-client.sh` runner (sets `PYTHONPATH`, derives the
instance from `.claude/kb.json`), e.g.
`bash ~/.cache/wip-kb-client/kb-client.sh case-fetch.py case 471`.

Env:
- **Single source of truth: `.claude/kb.json`** (`kb_app_url` + `kb_api_key_file`,
  CASE-471). The runner and `kb_client_core.py` derive `KB_BASE_URL` +
  `KB_API_KEY_FILE` from it when unset, so a hostname cutover is one edit there.
- `KB_BASE_URL` — the canonical instance (default `https://kb.internal`).
- `KB_API_KEY_FILE` — its key file (default `~/.wip-deploy/kb/secrets/api-key`).
  **One var across the whole bundle** (CASE-444); `KB_KEY_FILE` is accepted as a
  deprecated alias with a stderr warning. The default key pairs only with the
  default target: overriding `KB_BASE_URL` without setting `KB_API_KEY_FILE`
  fails loud instead of silently 401-ing with the canonical instance's key.
  No `/Users/<user>` literals — defaults derive from `$HOME`.
- `KB_LOCAL_URL` / `KB_LOCAL_KEY_FILE` — the optional local fast-path instance
  (`case-fetch` `KB_PREFER_LOCAL=1`, `stats-to-kb` local target);
  defaults `https://localhost:8443` + `~/.wip-deploy/wip-local/secrets/api-key`,
  same pairing guard.
- `KB_NAMESPACE` (default `kb`), `KB_VERIFY_TLS` (default `false`),
  `KB_DEV_ROOT` (default `~/Development` — flat-file repo roots).
- `KB_APP_URL` / `KB_APP_BASE_PATH` — the KB app endpoint (gateway verbs +
  served bundle), distinct from the WIP backend `KB_BASE_URL`. Default
  `https://kb.internal` + `/apps/kb`.
