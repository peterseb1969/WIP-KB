# WIP Relationships — Terminology & Graph-Theory Reference

**Status:** Reference, 2026-04-25. Synthesizes the post-Phase-0 naming and the graph-theory shape of WIP's relationship subsystems.
**Owner:** FRanC (definition authority for terminology + design-paper synthesis).
**Companion:**
- `World-in-a-Pie/docs/design/document-relationships.md` — BE-YAC's authoritative design for the document-relationship feature
- `wip://data-model` — MCP resource, canonical entity-shape definitions
- `papers/v2-kb-ux.md` — KB-specific edge taxonomy

---

## 0. Why This Paper Exists

WIP has **two distinct relationship subsystems**, and they were deliberately renamed in Phase 0 (April 2026) so they could coexist without confusion. Almost every terminology mistake about WIP relationships traces back to mixing the two layers up.

This paper is the canonical reference for which word means what, what graph-theory primitives WIP supports, and where the performance edges are.

---

## 1. The Framing — Two Layers, Two Words

| Layer | Connects | Word reserved for it |
|---|---|---|
| **Ontology layer** | term ↔ term (within or across terminologies) | **relation** (singular: term-relation) |
| **Document layer** | document ↔ document | **relationship** |

> "After the rename, the word 'relationship' in WIP consistently means 'document-to-document typed edge.' The word 'relation' is for ontology edges between terms (OBO-style)." — `document-relationships.md` line 180

Use **relation** when you mean a term-to-term edge. Use **relationship** when you mean a document-to-document edge. When you want to abstract over both layers, use the graph-theory term: **edge**.

---

## 2. Graph Theory — The Bits That Matter for WIP

WIP is a **property graph** with directed edges, allowing multigraph and cyclic structures. The traversal primitive is depth-bounded BFS via MongoDB `$graphLookup`.

### 2.1 The five dichotomies that decide your data shape

| Dichotomy | WIP's choice | Why it matters |
|---|---|---|
| **Directed vs. undirected** | **Directed.** Every edge has a source and a target. | Even semantically-symmetric edges (`RELATES_TO`) are stored directed. Apps must walk both ways if they want symmetric semantics. |
| **Simple vs. multigraph** | **Multigraph.** Multiple edges between the same pair of nodes are allowed. | "Experiment used bevacizumab twice, at different timepoints" is a real WIP case. The author opts into dedup via `identity_fields`. |
| **Cyclic vs. acyclic** | **Cycles allowed at platform level.** | Document relationships *can* form cycles. Term ontologies *should* be DAGs by ontology convention, but the platform doesn't enforce DAG-ness. |
| **Property graph vs. RDF triple** | **Property graph.** Edges carry their own properties. | This is the central modeling choice — the lab-journal example (50µg, 10mg/mL, role=catalyst on the *edge*, not the molecule) is exactly why WIP picked property-graph-shaped relationships over RDF. |
| **Homogeneous vs. typed** | **Typed.** Every node has a template; every edge has a relationship template with `source_templates` / `target_templates` constraints. | Edges are *partially bipartite* by construction — `EXPERIMENT_INPUT` only goes from `{EXPERIMENT, ASSAY}` to `{MOLECULE, BIOSPECIMEN, ...}`. Validated on write. |

**Property graph vs. RDF, briefly:** RDF says everything is a triple `(subject, predicate, object)` with no room for edge data. To attach a property like "role=catalyst" you'd need another triple about the triple (reification), which is awkward. Property graphs let edges carry their own properties natively. WIP is property-graph-shaped because that matches biology.

### 2.2 Walking the graph — paths, traversal, depth

| Concept | Definition | WIP relevance |
|---|---|---|
| **Path** | Sequence of edges from one node to another. | KB connections view walks the shortest path. |
| **Hop** | One edge step in a path. | `depth=1` = one hop. |
| **Reachability** | Can you get from A to B by following edges? | Direction-sensitive: A might reach B via outgoing but not incoming. Hence the `direction=outgoing|incoming|both` flag. |
| **Shortest path** | Path with fewest edges between A and B. | KB connections view + edge-label display. |
| **Traversal** | Walking outward from a starting node up to some depth. | `GET /documents/{id}/traverse?depth=N` — returns a tree rooted at the start, branching by depth and direction. |
| **Tree (from a traversal)** | Connected acyclic graph with one path between any two nodes. | Even when the underlying graph has cycles, the traversal *response* is a tree because `$graphLookup` dedupes by `_id` — each node visited at most once. |
| **Depth cap** | Maximum hops the traversal will follow. | WIP caps at 10. Performance + cycle-stop safeguard. |

> "MongoDB has no hard limit but performance degrades with depth × average degree. 10 is generous enough for real lineage; anything deeper is an analytical query that belongs in Postgres." — design doc

### 2.3 Connectedness — where orphans come from

| Concept | Definition | WIP relevance |
|---|---|---|
| **Connected component** | A maximal subgraph where every node can reach every other (ignoring direction). | A KB with multiple components is fragmented. |
| **Orphan** | A node in its own component of size 1. | The KB orphan marker is exactly this: docs with zero in-edges and zero out-edges and `root: false`. |
| **Hub** | A node with many edges. | High-degree nodes "where everything connects through" — `JOURNEY_ENTRY` likely becomes a hub in the KB. |
| **Bridge** | An edge whose removal would disconnect a component. | WIP doesn't compute these but they matter when archiving — archive a bridge edge and you fragment the graph. |

The orphan-discipline rule in the KB ("every new doc declares a relationship or `root: true`") is doing graph-theory work: it prevents component fragmentation by enforcing that every node either belongs to the connected mass or explicitly opts out as a designated entry point.

### 2.4 Ontology-specific shape

These are conventions on top of the graph primitives, specific to ontology work. Biology has been here for decades — these names mean what they mean in the Gene Ontology, ChEBI, UBERON, etc.

| Concept | Definition | WIP relevance |
|---|---|---|
| **DAG (Directed Acyclic Graph)** | Directed, no cycles. The ontologists' default. | Real ontologies are DAGs. WIP doesn't enforce DAG-ness, but `is_a`/`part_of` are conventionally DAG-forming. |
| **Hierarchy** | Structure formed by `is_a` (and sometimes `part_of`) edges. | Walked via `get_term_hierarchy`. |
| **Subsumption** | "X subsumes Y" iff Y `is_a` X. | The is_a relation is the subsumption relation. |
| **Ancestor / descendant** | Transitive closure of hierarchy edges. | "All ancestors of `mitochondrion`" → walk `is_a`/`part_of` upward without bound. |
| **Parent / child** | One-hop ancestor / descendant. | Immediate generalization / specialization. |
| **Lowest Common Ancestor (LCA)** | Deepest node that's an ancestor of both X and Y. | "What do mitochondrion and chloroplast have in common?" → LCA in GO would be `organelle`. WIP does not compute LCA out of the box. |
| **Polyhierarchy** | A node with multiple parents. | Real ontologies are almost always polyhierarchical. WIP supports trivially because edges are independent. |
| **Reasoning** | Inferring new relations from declared ones. | WIP does **not** do reasoning. If A `is_a` B and B `is_a` C, WIP stores both but does not auto-infer A `is_a` C. Apps compute via traversal. |

### 2.5 The performance shape — one formula

> "Performance degrades with **depth × average degree**." — design doc

Two consequences for WIP design:

- **Depth-2 with degree-100 nodes** returns ~10,000 edges. Same as depth-4 with degree-10. Graph shape determines depth you can ask for.
- **Hub nodes are hot.** Traversals that touch a hub explode from there. `JOURNEY_ENTRY` docs referencing 50 things will dominate any traversal crossing them.

Mitigations on the API: the `types` filter (limits which edge types are walked), the `direction` filter, and `active_only`. Use them.

### 2.6 What WIP **doesn't** do

| Not supported | Why it's fine for now |
|---|---|
| Path enumeration ("all paths from A to B") | Exponential in the worst case. Reachability + shortest path cover real needs. |
| Reasoning / transitive closure inference | Apps compute via traversal when needed. |
| Graph isomorphism / subgraph matching | Not WIP-shaped; reporting-layer SQL JOINs cover most "find all X with edges of type Y" queries. |
| Edge-level versioning independent of doc versioning | Relationship documents version like any other; the edge IS the doc. |
| Cross-namespace edges | Rejected at write time in v2. Defer to Theme 3. |
| Meta-relationships (edges between edges) | Out of scope v2 (recursive complexity). |
| Materialized views, reachability indexes, precomputed transitive closure | Out of scope v2. Future "saved reports" feature is the right home. |

---

## 3. Core Data-Model Anchor Terms

The terms on which everything else is built. From `wip://data-model`.

| Term | Definition |
|---|---|
| **Terminology** | A controlled vocabulary (e.g., `COUNTRY`, `GENDER`). Has terms. |
| **Term** | An entry in a terminology (e.g., `GB` in `COUNTRY`). Has value, label, aliases, description. |
| **Template** | A document schema — like a form definition. Versioned fields, identity_fields, optional `usage` annotation. |
| **Document** | An instance of a template — a filled-in form. Validated against the template. |
| **Reference field** | A field whose `reference_type` points at one of: `document`, `term`, `terminology`, `template`. The pointer-shaped field type. |
| **Registry** | The canonical-ID assignment service. Every WIP entity has a UUID7; synonyms resolve to it. |

---

## 4. The Ontology Layer — Term-Relations

Edges between **terms**. Used to model OBO-style ontologies (GO, anatomy, etc.). Hierarchy + cross-references between vocabulary entries.

### 4.1 Vocabulary

| Term | Definition |
|---|---|
| **Term-relation** | A typed edge between two terms. Fields: `source_term_id`, `target_term_id`, `relationship_type`. (Yes, the *field name* is still `relationship_type` — only surface naming was renamed; field names stayed for backward compat with extension files.) |
| **Relationship type (in term-relation context)** | The kind of edge: `is_a`, `part_of`, `has_part`, `regulates`, `positively_regulates`, `negatively_regulates`. (OBO-style.) |
| **Ontology** | The conceptual layer formed by all term-relations. |
| **Term hierarchy** | The DAG implied by `is_a`/`part_of` edges among terms. Walked via `get_term_hierarchy`. |
| **OBO Graph JSON** | Standard exchange format for bulk-loading term-relations. |
| **Ancestors / descendants / parents / children** | Standard ontology traversal directions. |

### 4.2 API surface (post-Phase-0 rename)

| Surface | Path / name |
|---|---|
| HTTP | `/api/def-store/ontology/term-relations` |
| MCP tools | `create_term_relations`, `list_term_relations`, `delete_term_relations`, `get_term_hierarchy` |
| Mongo collection | `term_relations` |
| NATS subject | `wip.term_relations.>` |
| NATS event types | `TERM_RELATION_CREATED`, `TERM_RELATION_DELETED` |
| Model class | `TermRelation` |

### 4.3 Naming quirk worth knowing

The system-terminology data identifier `_ONTOLOGY_RELATIONSHIP_TYPES` was **not** renamed. Renaming it would silently break apps' `_ONTOLOGY_RELATIONSHIP_TYPES_EXT.json` extension files. The constant in code is `TERM_RELATION_TYPES_TERMINOLOGY_VALUE`, but its value is still the old string. Documented in the design doc — no fix planned.

---

## 5. The Document Layer — Relationships

Edges between **documents**, themselves stored as documents. The whole point of the upcoming Phase 1–5 work.

### 5.1 Vocabulary

| Term | Definition |
|---|---|
| **Relationship document** | A document whose template has `usage: relationship`. Carries edge properties (role, quantity, etc.) in addition to its endpoints. Often shortened to "relationship." |
| **`usage` annotation** | New top-level field on every template. Values: `entity` (default — full document lifecycle), `reference` (LOV — separate Theme), `relationship` (typed property-carrying edge). |
| **`source_templates` / `target_templates`** | Template-level lists: which document templates are valid endpoints for this relationship. Required when `usage: relationship`. |
| **`source_ref` / `target_ref`** | The two **mandatory** reference fields on every relationship template. Names are conventional (not config) — query APIs and indexes assume them. Both have `reference_type: document`. |
| **Edge properties** | Any non-endpoint fields on a relationship document (`role`, `quantity`, `concentration`, etc.). The whole reason relationship-as-document exists: data that belongs to the *interaction*, not to either endpoint. |
| **`identity_fields`** (on relationship templates) | Optional dedup tuple. Default leaves it to the template author. Common form: `[source_ref, target_ref, role]`. |
| **`versioned`** (template flag) | `true` (default) → updates create new versions. `false` → overwrite-in-place (latest-only relationships). |
| **Cross-namespace relationship** | A relationship whose source, target, and edge are not all in the same namespace. **Rejected at write time** in v2 (`cross_namespace_relationship` error). |
| **Meta-relationship** | A relationship whose endpoint is itself a relationship document. **Out of scope** for v2. |
| **Self-loop** | `source_ref == target_ref`. Allowed at the platform level (e.g., a doc supersedes a prior version of itself). |

### 5.2 API surface (Phase 1–5)

| Surface | Path / name |
|---|---|
| HTTP | `GET /api/document-store/documents/{id}/relationships`, `GET /api/document-store/documents/{id}/traverse` |
| MCP tools | `get_document_relationships`, `traverse_documents` |
| Storage | Regular namespaced `documents_<ns>` collection, with conditional indexes on `data.source_ref` and `data.target_ref` for relationship templates |
| Postgres reporting (when present) | Two extra indexed columns `source_ref_id` / `target_ref_id` on the template's reporting table, enabling SQL JOINs |
| NATS event payload | Includes `template_usage`, `source_ref_resolved`, `target_ref_resolved`, `source_template_value`, `target_template_value` (so subscribers don't have to chase references) |

### 5.3 Validation at write time

On `create_document` against a relationship template, in order:

1. Standard template validation (all fields, reference resolution).
2. `source_ref` must resolve to a document whose template is in `source_templates`.
3. `target_ref` must resolve to a document whose template is in `target_templates`.
4. Cross-namespace → reject with `cross_namespace_relationship`.
5. Archived/hard-deleted target → reject (standard reference-integrity).

---

## 6. Graph Terms ↔ WIP Mapping

The Rosetta stone for reading the design doc and graph theory in the same sitting.

| Graph term | WIP meaning |
|---|---|
| **Node** | A document (any document, not just relationship documents) |
| **Edge** | A relationship document (in the document layer) — or a term-relation row (in the ontology layer) |
| **Endpoint** | The source or target document of an edge |
| **Direction** | `outgoing` (from this doc), `incoming` (to this doc), `both` |
| **Depth** | Number of hops in a traversal. Capped at 10. |
| **Hop** | A single edge step |
| **Self-loop** | Edge where source == target |
| **Traversal** | Walking from a starting document, returning a tree (rooted at start, branching by direction & depth) |
| **`$graphLookup`** | The MongoDB primitive that does the traversal |

> "Response: tree structure rooted at the document, with **edges = relationship documents, nodes = documents reached**." — design doc line 143

---

## 7. KB-Specific Edge Taxonomy (the ten v1 edges)

These are *names of relationship templates* that the KB will define — not platform-level concepts. Each is a `usage: relationship` template. Edge properties (date, context, etc.) can ride on any of them.

| Edge name | Direction | Source → Target | Meaning |
|---|---|---|---|
| `IMPACTS` | directed | Decision → Decision | Source affects target |
| `REALIZES` | directed | Code/feature → Decision | Source implements target |
| `LEARNED_FROM` | directed | Lesson → Case | Source derived from target |
| `DECIDED_BY` | directed | Decision → Fireside | Source came out of target |
| `SUPERSEDES` | directed | Decision → Decision | Source replaces target |
| `FLAGGED_FROM` | directed | Case → (any) | Source raised from target |
| `AGENT_PARTICIPATED` | directed | Fireside → AgentIdentity | Agent took part in source |
| `FROM_DAY` | directed | GitStatsSnapshot → JourneyEntry | Source produced on that day |
| `REFERENCES` | directed | any → any | General cross-link |
| `RELATES_TO` | undirected (semantic) | any → any | Loose association |

(From `papers/v2-kb-ux.md` §"Relationships (v1)".)

---

## 8. Quick Examples — Graph Concepts Grounded in WIP

| Scenario | Graph term | WIP shape |
|---|---|---|
| "All experiments that used bevacizumab" | Direction-sensitive reachability, depth=1, type=`EXPERIMENT_INPUT`, direction=incoming on the molecule node | One MongoDB query against the relationship template's source_ref / target_ref index |
| "What ancestors does this anatomy term have?" | Transitive closure on `is_a` over the term hierarchy | `get_term_hierarchy` walks it |
| "How do CASE-42 and the v2-archetypes paper relate?" | Shortest path between two nodes, undirected | KB connections view |
| "Find docs nobody links to and that link to nothing" | Components of size 1 | Orphan filter — query for docs with zero relationships and `root: false` |
| "Decision X impacts decision Y impacts decision Z" | Directed path of `IMPACTS` edges | Traverse from X with `types=IMPACTS`, depth=2 |
| "Reachability from EXPERIMENT-42 through any edge" | Multi-type traversal | Traverse with `types` unspecified (all types), `direction=both` |

---

## 9. Vocabulary Cheat-Sheet

When in doubt:

- **"relation"** = ontology edge between **terms**. Singular form: term-relation. *Don't* call it "relationship."
- **"relationship"** = typed document edge. Singular form: relationship document, or the (legacy) field name `relationship_type` on term-relations notwithstanding. *Don't* call it a "relation" if it's between documents.
- **"edge"** / **"node"** = graph-theory speak when you want to abstract over both layers.
- **"reference"** = the field-type primitive that any pointer-shaped field uses (one document → one entity). A relationship document has *two* reference fields (`source_ref`, `target_ref`) plus its own properties.
- **A "template with `usage: relationship`"** is the formal way to say "a relationship-shaped doc type."
- **"Ontology"** vs. **"graph"** — ontology implies an `is_a` hierarchy with reasoning conventions (DAG, polyhierarchy, subsumption). Graph is the broader mathematical structure. Ontology ⊂ graph.

---

## 10. What WIP Reasonably Could Add Later (Not Promises)

For completeness — concepts the platform doesn't have but might grow toward:

- **Reasoning / transitive closure** — could be added as a query option on traversal (`?inferred=true`). Today: app responsibility.
- **Materialized views / saved reports** — see feature seeds Theme 10. Would cover precomputed reachability and frequency aggregations.
- **Cross-namespace relationships** — Theme 3 will revisit. Today: rejected at write.
- **Meta-relationships** — recursive complexity; deferred indefinitely.
- **Graph DBMS integration** (Neo4j, Dgraph, etc.) — explicitly rejected for v2. MongoDB `$graphLookup` + Postgres JOINs cover requirements.

---

## References

- `World-in-a-Pie/docs/design/document-relationships.md` — authoritative design for the document-relationship feature
- `World-in-a-Pie/docs/design/document-relationships-implementation.md` — phase decomposition (Phase 0 done; Phases 1–5 in flight)
- `wip://data-model` — MCP resource, canonical entity-shape definitions
- `wip://conventions` — bulk-first 200 OK, identity-based dedup, etc.
- `papers/v2-kb-ux.md` — KB UX paper, ten-edge taxonomy
- `papers/v2-kb-app-requirements.md` — APP-KB-YAC spec
- `World-in-a-Pie/docs/design/reference-fields.md` — foundation for the document-layer relationships
- `reports/BE-YAC-20260409-1636/fireside-v2-design-seeds.md` Theme 8 — the original feature-seed discussion that produced this design

---

*One-paragraph summary: WIP has two relationship subsystems, deliberately named differently after Phase 0. **Term-relations** are OBO-style edges between terms (is_a, part_of, etc.) — used for ontologies. **Relationships** are typed property-carrying edges between documents, themselves stored as documents whose template has `usage: relationship`. Both are directed, both can form multigraphs, both allow cycles. WIP is a property graph (edges carry their own data), traversal is depth-bounded BFS via MongoDB `$graphLookup`, and the performance edge is depth × average degree. WIP does not do reasoning, transitive closure inference, path enumeration, cross-namespace edges, or meta-relationships. The KB's ten edge taxonomy (IMPACTS, SUPERSEDES, FLAGGED_FROM, etc.) lives in the document layer, as relationship templates.*
