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

## Cross-namespace Library → KB links (spike finding, APP-KB-20260628)
Spiked. The platform constraint is decisive:
- **Cross-namespace relationship/edge documents are NOT supported in v2** — the
  document-store rejects them with `cross_namespace_relationship`. So a `library` edge
  type targeting a `kb-libdev` doc is a dead end (the edge *type* can be created if you
  name the foreign template by canonical `template_id`, but the edge *document* fails).
- **A plain document reference FIELD works cross-namespace** — a `LIBRARY_DOC` field
  `reference_type: document` whose `target_templates` is the foreign template's
  canonical `template_id` validates fine, given `allowed_external_refs`.

**Therefore:** Library → KB links are modelled as a **reference field** on LIBRARY_DOC
(e.g. a future `kb_refs` array), NOT an edge. `SEE_ALSO` (library-internal) stays an edge.
Deferred until the linking feature is built — it's an additive non-identity field then
(PoNIF #2 corollary, no migration). Candidate BE-YAC note: cross-namespace relationships
unsupported is a hard constraint for multi-namespace apps.

Note: cross-namespace `target_templates` (and any foreign template ref) must be the
canonical `template_id`, not the value — value resolution does not traverse
`allowed_external_refs`.

## Dev vs deployed
In dev the KB-corpus namespace is `kb-libdev` and this namespace is `library`, both on
localhost:8443. A deployed instance substitutes its own namespace names; `namespace.json`
records the dev values. **Never seed against prod `kb.internal`.**
