# server/seed-library — the `library` namespace seed (CASE-518)

The **WIP Technical Library**: generated-from-code human docs as a first-class,
queryable KB doc-type, living in a **second namespace** alongside the KB corpus.
This is the two-namespace KB model (branch `lib-dev`). The KB-corpus namespace is
seeded from `server/seed/` (the existing 14-template model); this dir seeds the
`library` namespace.

## Why a second namespace
Per CASE-518: a dedicated namespace gives the Library a clean **audience/access**
boundary (outward-facing product docs vs the internal corpus) and a clean
**export/import unit** for cross-instance distribution. Set `allowed_external_refs`
to the KB-corpus namespace so Library docs can reference corpus docs (Library → KB).

## The model
- **`LIBRARY_DOC`** (entity) — identity **`[slug, release]`**, natural-upsert
  (versions-in-place). One record per (manifest slug, product release line).
- **`LIBRARY_RELEASE`** (term, alias-free) — `wip-v1`, `wip-v2`, … the product
  release line. Part of identity → v1/v2 libraries stay live in parallel.
- **`LIBRARY_CATEGORY`** (term) — `concept | api | lib | cli`, the generation family.
- **`LIBRARY_STATUS`** (term) — `draft | published | deprecated`, library-local so the
  namespace stays self-contained for export.
- **`SEE_ALSO`** (edge, `versioned:false`) — LIBRARY_DOC ↔ LIBRARY_DOC "see also".

## The three version concepts (keep them separate)
| Concept | Where | Example | Identity? |
|---|---|---|---|
| Release line | `release` field | `wip-v1` | **yes** — a new line is a new doc |
| Document version | automatic per `document_id` | v1→v2→v3 | no — this *is* the regen history |
| Generated-from rev | `generated_from_rev` field | git SHA | no — **provenance**, volatile |

`source_scope` + `generated_from_rev` are provenance, **never** identity. Putting the
volatile SHA in identity would mint a duplicate per republish (CASE-316/317 class).

## Term-as-identity rule (spike finding, APP-KB-20260628)
WIP computes the identity hash over the **raw submitted value**, not the resolved
`term_id`. So a term used in `identity_fields` **must not carry aliases** — an alias
submission produces a different hash and orphan-duplicates. `LIBRARY_RELEASE` is
deliberately alias-free; the generator emits canonical release values only.
(Candidate BE-YAC note: hashing the resolved `term_id` would make term-identity robust.)

## Cross-namespace Library → KB edges
`allowed_external_refs` is set, but the cross-namespace edge type (LIBRARY_DOC →
KB-corpus doc) is **not yet modelled** here — it needs its own spike (does an edge-type
`target_templates` resolve a cross-namespace template, and does the edge document
validate?). `SEE_ALSO` is library-internal for now.

## Dev vs deployed
In dev the KB-corpus namespace is `kb-libdev` and this namespace is `library`, both on
localhost:8443. A deployed instance substitutes its own namespace names; `namespace.json`
records the dev values. **Never seed against prod `kb.internal`.**
