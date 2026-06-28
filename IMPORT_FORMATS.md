# IMPORT_FORMATS — WIP-KB

The **UI does not import data** — APP-KB is read-mostly (its one write is
flag-for-YAC). Content enters the KB through the **served kb-client CLI**
(`kb-client/kb-write.py`), which YACs run. This file documents that ingestion
format, since it's the actual data contract for getting docs into the KB.

## Source

Markdown files with YAML-ish frontmatter, authored by YACs (session reports, case
records, firesides, lessons, design decisions, doc mirrors) or computed (git
stats). All writes go through the gateway's single `POST /server-api/kb/write/:type`.

**Two namespaces, one receive surface (CASE-518).** The gateway routes each write to
the type's **home namespace** — corpus types (cases, decisions, …) to the KB corpus,
Library types (`LIBRARY_DOC`) to the Library namespace — so a producer just names the
type (`kb-write.py LIBRARY_DOC …`) and never specifies a namespace. The library is
**agnostic to who produces a doc or how** (generation is upstream); it owns only this
receive contract — the format and data fields.

## File type

UTF-8 Markdown. Frontmatter is a leading `---` fenced block of flat `key: value`
lines (simple scalars; light coercion: `true/false`→bool, numerics→number,
`[a, b]`→list). The body is everything after the fence and maps to `data.body`
unless frontmatter sets `body`.

```
kb-write.py <TYPE> <file.md>        # frontmatter → fields, body → data.body
kb-write.py <TYPE> -                # read from stdin
kb-write.py <TYPE> --json '{…}'     # raw data object
kb-write.py SESSION  reports/<id>/  # or reports/<id>/session.md → resolved to the dir
kb-write.py YAC_MEMORY <memory-dir> # one record per *.md file
options: --field k=v · --edge TYPE:target_type:target_key · --metadata '{…}' · --patch/--match
```

## Per-type field mapping (the extractors)

Most types use the generic `frontmatter → fields` mapping. A few have dedicated
extractors (`kb-write.py`):

| Type | Source → fields | Identity |
|---|---|---|
| `FIRESIDE` | `topic`/`title`/first-H1 → title; `participants`/`session` → authored_by; `time` → chat_date | mint, title |
| `DOCUMENT` | `--field path=, repo_origin=, kind=` required; title from frontmatter/H1/filename | repo_origin + path |
| `JOURNEY_ENTRY` | `day_number` from `--field` or `WIP_Journey_DayN.md` filename; title from H1 | day_number |
| `SESSION` | a `reports/<id>/` dir (or its `session.md`) → frontmatter fields + all `*.md` bundled into `body`; `continues_from` → CONTINUES_FROM edge | session_id |
| `YAC_MEMORY` | each `memory/*.md`: `name`→title, `description`, body; `type` (nested `metadata.type` **or** top-level) → memory_type; `originSessionId` → origin_session; `MEMORY.md` skipped | owner + mem_key (filename stem) |
| `GIT_STATS_SNAPSHOT` | computed from `git log` via `--git-repo`/`--git-date`/`--git-backfill` | repo + snapshot_date |

## Library docs (`LIBRARY_DOC`) — the Library receive contract

`LIBRARY_DOC` uses the **generic** `frontmatter → fields` mapping (no dedicated
extractor) and routes to the **Library namespace** automatically. A producer writes:

```
kb-write.py LIBRARY_DOC <file.md>
```

| Field | Frontmatter key | Notes |
|---|---|---|
| `slug` | `slug` | **identity** (with release). The manifest doc-slug, e.g. `document-store-api`. |
| `release` | `release` | **identity** (with slug). A `LIBRARY_RELEASE` term (`wip-v1`, `wip-v2`, …) — the product line; keeps v1/v2 libraries live in parallel. NOT the doc version. |
| `category` | `category` | A `LIBRARY_CATEGORY` term: `concept` \| `api` \| `lib` \| `cli`. |
| `title` | `title` | Display title. |
| `body` | *(markdown after the fence)* | The generated doc content. |
| `doc_status` | `doc_status` | `LIBRARY_STATUS` (`draft`/`published`/`deprecated`); defaults `published`. |
| `audience` | `audience` | Target reader (optional). |
| `source_scope` | `source_scope` | Array of code paths/sources the doc is generated from (provenance, optional). |
| `generated_from_rev` | `generated_from_rev` | Git rev at generation (provenance, optional). The library only carries it — it does not act on it. |
| `kb_refs` | `kb_refs` | Array of corpus `document_id`s — Library→KB cross-namespace links (optional). |
| `do_not_edit` | `do_not_edit` | Marks generated output; data only, not enforced. |

**Identity** is `[slug, release]` → natural-upsert: re-submitting the same slug+release
versions the existing doc in place (the regeneration history); a new `release` is a new
parallel document. `generated_from_rev` / `source_scope` are **provenance, never
identity** — putting the rev in identity would mint a duplicate per republish.

```markdown
---
slug: document-store-api
release: wip-v1
category: api
title: Document Store API
audience: integrators
source_scope: [schemas/document-store.json, components/document-store/src]
generated_from_rev: 69841f4f
kb_refs: [019f0b58-e426-727f-b49d-8d3abca4ef0b]
---

# Document Store API
… generated body …
```
→ `LIBRARY_DOC{ slug, release, category, title, audience, source_scope[],
generated_from_rev, kb_refs[], doc_status: published, body }` in the Library namespace.

## Transformations / normalization

- **Two YAC_MEMORY frontmatter shapes** are accepted: nested
  `metadata: { type, originSessionId }` and top-level `type:` + `originSessionId:`.
  `parse_frontmatter` flattens the nested block, so both surface as top-level keys;
  the loader strips surrounding quotes from `name`/`description`.
- **Datetimes** are normalized to naive `YYYY-MM-DDTHH:MM:SS` (trailing timezone
  stripped) to match the SESSION datetime fields.
- **Mint vs natural:** the gateway derives behaviour from a `WRITE_POLICY` doc per
  type — mint types get a number + synonym; natural types upsert by identity_fields.

## Known issues

- Frontmatter parsing is line-based and flat — no nested YAML beyond the
  one-level flatten the YAC_MEMORY shapes rely on; multi-line scalar values aren't
  supported.
- YAC_MEMORY upsert covers add/edit but not delete (a pruned local memory lingers
  `active` in kb — see KNOWN_ISSUES).
- A frontmatter-only `session.md` once 502'd on the file-path form; fixed by
  resolving the file to its report dir (CASE-503).

## Sample (YAC_MEMORY)

```markdown
---
name: dev-install-first-then-canonical
description: "Iterate on the hot-wired wip-local install; canonical gets one roll per increment."
metadata:
  type: feedback
  originSessionId: 14f04444-5d5d-42b1-a8ee-5d0c5627d8c1
---

Peter, 2026-06-12: iterate on localhost:8443 (bind-mounted checkout) …
```
→ `YAC_MEMORY{ owner: APP-KB, mem_key: dev-install-first-then-canonical,
title: dev-install-first-then-canonical, description: …, memory_type: feedback,
origin_session: 14f0…, body: "Peter, 2026-06-12: …" }`
