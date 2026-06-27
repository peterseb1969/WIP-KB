# WIP_DEPENDENCIES — WIP-KB

The contract between APP-KB and WIP. All entities live in the **`kb`** namespace and
are created by `BootstrapGate` from `server/seed/`. The data-model *rationale* is in
**DESIGN.md**; this file is the inventory the next session (or `/add-app`) needs.

- **Seed location:** `server/seed/terminologies/*.json`, `server/seed/templates/*.json`
  (filename-prefixed for create order), `server/seed/write-policies.json`.
- **Namespace:** `kb` (production) / `dev-kb` (iteration sandbox). The privileged
  admin key is cross-namespace — always pass `namespace` explicitly on MCP calls.
- **Ownership:** APP-KB owns the `kb` schema. All entities here are created by this
  app; none are reused from other apps, and no template references another app's
  templates (the KB is a self-contained corpus). Shared/platform terminologies are
  not used today.

## Terminologies (8)

| Value | Used for |
|---|---|
| `KB_DOC_KIND` | Discriminates `DOCUMENT` mirrors (paper / playbook / guide). Mutable. |
| `KB_DOC_STATUS` | Document lifecycle status. |
| `KB_APP` | App/source facet (which constellation app a record belongs to). |
| `KB_TARGET_YAC` | Case routing target (FRanC / BE-YAC / any). |
| `KB_WRITE_MODE` | mint vs natural — referenced by the write-policy model. |
| `SESSION_ROLE` | YAC role on a `SESSION` (APP-KB, BE-YAC, FRanC, …). |
| `SESSION_STATUS` | active / closed. |
| `KB_MEMORY_TYPE` | `YAC_MEMORY` classification: user / feedback / project / reference (CASE-507). |

## Entity & config templates (14)

Identity fields drive upsert (same identity → new version; different → new doc).
"Mint" types get a gateway-allocated number + `CASE-`/`PAPER-`-style synonym via a
`WRITE_POLICY` doc; all others upsert by their natural identity_fields.

| Template | Identity fields | Write mode | What it is | FTS fields |
|---|---|---|---|---|
| `CASE_RECORD` | `case_number` | mint (`CASE-<n>`) | Cross-agent cases (bug/request/gap) | title, body |
| `CASE_RESPONSE` | `case_number` + `response_seq` (scoped) | mint (`CASE-<n>#<seq>`) | Case responses/comments | body |
| `DESIGN_DECISION` | mint (`DECISION-<n>`) | mint | Recorded decisions | title, body |
| `LESSON` | mint (`LESSON-<n>`) | mint | Lessons learned | title, body |
| `FIRESIDE` | mint (`FIRESIDE-<n>`) | mint | Design-chat transcripts | title, body |
| `DOCUMENT` | `repo_origin` + `path` (mint `PAPER-<n>`) | mint | Markdown doc mirrors (kind via `KB_DOC_KIND`) | title, body |
| `JOURNEY_ENTRY` | `day_number` | natural | Per-day journey narrative | title, body |
| `GIT_STATS_SNAPSHOT` | `repo` + `snapshot_date` | natural | Per-repo/day git stats | — |
| `SESSION` | `session_id` | natural | One YAC context-window of work | session_id, body |
| `YAC_MEMORY` | `owner` + `mem_key` | natural | A YAC's persisted memory file (CASE-507) | title, description, body |
| `FLAG_RECORD` | (flag identity) | natural (UI write) | **The one UI write** — flag-for-YAC | title, body |
| `AGENT_IDENTITY` | (agent key) | natural (reference) | YAC identity records | — |
| `BOOTSTRAP_RECORD` | `bootstrap_id` | natural | Bootstrap provenance audit | — |
| `WRITE_POLICY` | `doc_type` | natural (config) | Per-type mint/natural config the gateway reads (CASE-482) | — |

> The identity/field details per template are in DESIGN.md §5 and the seed JSON.
> `full_text_indexed: true` on a string field requires the field to be synced; it
> produces `<field>_search` + `<field>_tsv` columns in the reporting table.

## Edge types (12, `usage: relationship`)

| Edge | Connects | Notes |
|---|---|---|
| `REFERENCES` | any → any (generic citation) | Endpoints incl. `YAC_MEMORY` (widened, CASE-507/515). `versioned: false`. |
| `RESPONDS_TO` | CASE_RESPONSE → CASE_RECORD | Case thread linkage. |
| `CONTINUES_FROM` | SESSION → SESSION | Session rollover chain. |
| `FLAGGED_FROM` | FLAG_RECORD → source doc | The flag-for-YAC edge. |
| `SUPERSEDES` | doc → doc | Replacement. |
| `IMPACTS` / `REALIZES` / `LEARNED_FROM` / `DECIDED_BY` / `AGENT_PARTICIPATED` / `FROM_DAY` / `RELATES_TO` | per DESIGN.md §6 | Domain relationships. |

**Edge endpoint caveat:** an edge type's `source_templates`/`target_templates` are
append-only — widen via `add_edge_type_endpoints` (`POST /templates/{id}/endpoints`,
CASE-515), never delete+recreate (strands existing edges).

## Reporting / FTS

Templates with `full_text_indexed` string fields sync to Postgres `doc_<template>`
tables with `tsvector` columns. Search uses `POST /api/reporting-sync/search`; raw
analytics use `run_report_query`. All 72+ YAC_MEMORY rows are FTS-indexed and
searchable (verified — see CHANGELOG / CASE-530).

## External data / integrations

- **Anthropic API** — the askBar's NL-query agent (`@anthropic-ai/sdk`), keyed by
  `ANTHROPIC_API_KEY[_FILE]` or set at runtime via Settings.
- **WIP MCP** (`MCP_URL` → `wip-router:8080/mcp`) — the askBar's tool access.
- No other external APIs; the KB corpus is self-contained.
