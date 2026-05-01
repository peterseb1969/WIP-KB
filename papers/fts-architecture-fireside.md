---
session: BE-YAC-20260425-1500
type: fireside
topic: full-text search architecture for the KB archetype
time: 2026-04-28 19:27
participants: Peter, BE-YAC-20260425-1500, FRanC (async, via Peter)
---

## Context

FRanC's `papers/v2-kb-app-requirements.md` §8 ("Search — Pending Architecture Decision") left the full-text indexing approach open: data-layer concern, BE-YAC + FRanC needed to agree before APP-KB-YAC could code §7.2 (search results + facets). Peter raised the topic mid-session as we waited for a Pi node to rejoin the microk8s cluster, framed around his proposal that full-text indexing is a config option on template fields backed by the database's native FTS capabilities. This fireside captures the design that closes §8.

## Options Considered

### Where the index lives

| Approach | Verdict |
|---|---|
| **APP-KB client-side index** (Lunr / MiniSearch / FlexSearch) | Rejected. Each app would reinvent it; whole corpus must ship to the browser; index re-syncs every load. |
| **MongoDB text index** (`db.collection.createIndex({field: "text"})`) | Rejected. One text index per collection, weaker ranking, no native snippet generation, cross-template search needs manual aggregation. Live with the write, but freshness isn't the binding constraint. |
| **PostgreSQL tsvector via reporting-sync** | **Chosen.** Reuses existing `reporting_config` + schema_manager pipeline; unlimited GIN indexes per table; native `ts_rank` and `ts_headline`; cross-template search via UNION ALL on `doc_*` tables; faceted counts as plain SQL aggregation. The reporting-sync lag is irrelevant for KB-shaped workloads. |

### Granularity of the flag

- **Template-level boolean** — too coarse; LESSON has a markdown body but also tags, source_case, etc. Most fields are not search targets.
- **Field-level flag (`full_text_indexed`)** — chosen. Matches the existing pattern where reporting config attaches to fields and templates carry only the rollup.

### Combined vs per-field tsvector

- **Single combined `to_tsvector(body || ' ' || title)`** — simpler but loses the ability to weight title hits above body hits, and forecloses per-field language tagging.
- **Per-field tsvector columns with a default weighted-OR query** — chosen. Title gets weight 'A', body 'B', etc. The "marginally more complex" cost is one-time; the flexibility lands every search query. Generalises beyond KB (CT trial titles vs descriptions, lesson titles vs body).

### Substring fallback

- **APP-KB-YAC stubs §7.2 with substring match against titles + structured fields** (FRanC's original §8 framing) — rejected on second look. Pushed indexing concerns into the wrong layer; same reason the real index belongs to BE-YAC.
- **Reporting-sync exposes `?mode=substring` (and `?mode=auto`) on the same `/api/reporting-sync/search` endpoint, shipped with the rollout** — chosen. Apps get a working search endpoint from day one; as `full_text_indexed` rolls out per-template, the same endpoint upgrades to real ranking transparently. `mode=auto` (default) picks tsvector if any indexed field matches the template, else substring — apps don't have to think about it.

## Decision

**Full-text search becomes a property of the data layer, owned by BE-YAC, configured per-field at template creation, materialised in PostgreSQL by reporting-sync, and exposed at a single REST surface that already exists (`/api/reporting-sync/search`).**

### Concrete shape

**On the template (FieldDefinition):**
```yaml
fields:
  body:
    type: string
    full_text_indexed: true     # truthy boolean = English default
  title:
    type: string
    full_text_indexed: en       # explicit language for future i18n
```

**On reporting-sync (schema_manager):** when a field declares `full_text_indexed`, generate a per-field column

```sql
<field>_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', strip_md(<field>))) STORED
CREATE INDEX ... USING GIN (<field>_tsv)
```

One column per indexed field. Future weighted-OR queries combine them (`setweight(title_tsv, 'A') || setweight(body_tsv, 'B')`).

**REST endpoint:** `/api/reporting-sync/search` (already wired; no new service):
- Inputs: `q`, `namespace`, `template?`, `type?`, `mode=auto|fts|substring` (default `auto`), `include_inactive=false` (default), pagination.
- Outputs: documents with `_score` and `_snippet` per hit.

**MCP:** the existing `mcp__wip__search` tool stays the agent-facing API; gains real ranking + snippets under the hood. No tool-name change needed.

### Question answers (FRanC's resolutions)

1. **Per-field tsvector, not single combined.** Default search combines fields with weights (title 'A', body 'B'); apps can override.
2. **`full_text_indexed: true` implies `sync_enabled: true`.** Conflict (`full_text_indexed: true` + `sync_enabled: false`) returns 422 at template-store. You can't index what you haven't synced; don't make users remember the dependency.
3. **Substring fallback ships with the rollout** as `?mode=substring` (or `?mode=auto`). Lives at the data layer for the same reason the index does. APP-KB-YAC does not write a stub.

### Two correctness flags

- **Markdown stripping before tokenisation.** `strip_md()` runs in reporting-sync before `to_tsvector`. Strip fences but **preserve code-block contents** so a search for `tsvector` finds it inside code samples. Strip link syntax `[text](url)`, headings, list bullets. Standard pre-processing.
- **`WHERE status = 'active'` default, `?include_inactive=true` opt-in.** Aligns with PoNIF #1 ("inactive means retired, not deleted") — inactive docs remain findable by deliberate query but don't clutter routine search.

### Snippet format

`ts_headline` defaults to HTML with `<b>` tags. APP-KB renders this straight in-page. Ship HTML by default; add `?snippet_format=text` only when a consumer asks. Don't over-design.

### Estimate

- ~1 commit: add `full_text_indexed` to `FieldDefinition` (template-store)
- ~3-5 commits: tsvector column generation + index DDL in schema_manager, `strip_md` preprocessing, refresh on template upgrade
- ~2 commits: `/api/reporting-sync/search` rewrite — tsvector path, ranking, snippets, facets, mode selection
- ~1 commit: `mcp__wip__search` docstring + arg validation update

Roughly 1-2 BE-YAC sessions of work.

## Deferred

- **Per-field language tagging.** The `full_text_indexed: en` form is reserved in the schema; v1 implementation accepts only `true`/`false`. Multi-language support comes when a real consumer asks.
- **Field weights other than (A=title, B=body).** Default is fine for v1. Custom weights via per-template config when a real consumer asks.
- **Faceted aggregations on indexed fields.** Faceting still goes through normal reporting columns; no special tsvector facet path. Revisit if APP-KB's §7.2 reveals a gap.
- **Cross-template search ranking.** v1 returns scores within a template. Cross-template UNION ALL results are returned with scores comparable only loosely. A scoring-normalisation pass is future work.

## Peter's Voice

> "I discussed with FRanC that this could be a config option on template creation (using the DBs full-text-indexing capabilities). Thoughts?"

FRanC, endorsing the recommendation:

> "BE-YAC's analysis holds up. Postgres tsvector via reporting-sync is the right call — the plumbing already exists, the multi-app reuse argument is sharp, the freshness penalty is irrelevant for KB-shaped workloads."

FRanC, on the §8 framing weakness:

> "This also closes a §8 framing weakness — I'd punted substring as 'APP-KB-YAC's stub responsibility.' That framing was actually wrong. The fallback should live with the data layer too, for the same reason the index does."

## Impact

### On BE-YAC

- New work item: implement field-level `full_text_indexed` end-to-end (template-store schema → reporting-sync DDL + sync → search endpoint upgrade). Estimate 1-2 sessions.
- Existing `mcp__wip__search` tool and `/api/reporting-sync/search` endpoint stay; semantics expand.

### On FRanC's spec

`papers/v2-kb-app-requirements.md` §8 needs a one-paragraph rewrite:
- Drop "Pending Architecture Decision" framing.
- Point at this fireside as the canonical design source.
- Restate APP-KB's consumption shape: `GET /api/reporting-sync/search?q=...&template=...&namespace=kb&mode=auto`.

### On APP-KB-YAC (when spawned)

- This fireside becomes part of onboarding reads alongside `v2-kb-app-requirements.md`, `v2-kb-ux.md`, `relationships-glossary.md`, `v2-archetypes.md`.
- §7.2 is no longer blocked behind a substring stub — `?mode=auto` means the endpoint works from day one and improves transparently as templates flag fields for indexing.
- APP-KB-YAC owns the field-flag decisions on KB templates (which fields on CASE_RECORD, DESIGN_DECISION, LESSON, FIRESIDE, etc. get `full_text_indexed: true`).

### On other apps

- APP-CT, APP-RC, future apps: same `/api/reporting-sync/search` endpoint, same `full_text_indexed` flag pattern. No per-app indexing code.

### Closes the standing item

FRanC's "item #4" — the search architecture blocker on APP-KB-YAC spawn — is resolved as soon as this fireside lands. All hard blockers cleared modulo the soft "wait for DOC-YAC's audit" consideration, which is Peter's call.
