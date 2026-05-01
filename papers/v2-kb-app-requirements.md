# v2 KB App Requirements — APP-KB-YAC Spec

**Status:** v1 draft, 2026-04-25
**Owner:** FRanC (requirements + design). Implementation: APP-KB-YAC (TBD).
**Prerequisites:** BE-YAC's document-relationships extension. APP-KB-YAC cannot start until that lands and is exposed via the WIP REST API + MCP.
**Related papers:**
- `v2-kb-ux.md` — UX rationale, read first
- `v2-archetypes.md` — the `knowledgebase` archetype this app realizes
- `v2-process-seeds.md` — process context

---

## 0. How to Read This Document

This is a **spec**, not a tutorial. It tells APP-KB-YAC *what* to build and *how to know it's done*. It does not tell APP-KB-YAC *how* to write the code, which UI library to use beyond the canonical stack, or what colors to pick.

If something here contradicts `v2-kb-ux.md`, this document wins for v1 — the kb-ux paper is older and was written before some decisions landed.

If something here is silent and APP-KB-YAC needs an answer, **escalate to Peter via FRanC**, do not decide unilaterally. Section 15 lists the questions APP-KB-YAC should expect to surface.

---

## 1. Mission

APP-KB is the consumer-facing UI for the **WIP-hosted Knowledge Base** — the dogfooding of WIP for managing the WIP project's own knowledge.

Two user classes:
- **Peter** — reads, searches, navigates relationships, flags docs for follow-up. Never writes docs from the UI.
- **YACs** — read on session start (via MCP) to inherit team context; write back via slash commands (`/kb-persist <type>` etc.). YACs use the MCP, not APP-KB's UI.

The distinctive feature is **flag-for-YAC**: any doc can become a prompt for cross-agent work. The KB stops being a passive archive and becomes an actor that triggers conversations.

**APP-KB is read-mostly.** The only write surface in v1 is flag-for-YAC. All other persistence happens through YAC slash commands, not the UI.

**APP-KB is stateless.** It stores no per-user state, no local database, no client-side index. All state lives in WIP. Backup of APP-KB == backup of the `kb` namespace + the app's container image.

---

## 2. The Information Package APP-KB-YAC Receives

| Source | Channel | Provides |
|---|---|---|
| BE-YAC | WIP REST API + MCP — **served by the `wip-kb` instance, not `wip-stable`.** APP-KB-YAC's MCP config and base URL point at `wip-kb`'s ingress. | Data model, conventions, PoNIFs, development guide, **doc-relationships API** (Phase 0–7 + Phase 9 shipped Day 42; PoNIF #7/#8 registered), **full-text search API** (`/api/reporting-sync/search` with `?mode=auto\|substring`, field-level `full_text_indexed` flag — shipped Day 44 in BE-YAC's 4-commit arc) |
| Gene pool | `create-app-project.sh --preset query` | Stack, scaffold (incl. `AskBar.tsx` and the nl-query wiring), CLAUDE.md, slash commands, `technology-stack.md` (1) |
| FRanC | This document | Requirements, scope, acceptance criteria, discipline boundaries |
| FRanC | `papers/v2-kb-ux.md` | UX rationale and a *starting* doc-types / relationships catalogue |
| FRanC | `papers/v2-archetypes.md` | Archetype context (the `knowledgebase` archetype) |

**APP-KB-YAC owns the KB data model.** Specifically, APP-KB-YAC creates:
- The KB templates (the seven entity types + AGENT_IDENTITY reference + FLAG_RECORD entity — see §5)
- The relationship-type definitions (the ten edges from kb-ux §"Relationships (v1)")
- Any seed terminologies needed by the templates

This is the standard APP-YAC pattern: BE-YAC owns the platform; the APP-YAC owns its own data model.

(1) `technology-stack.md` propagation into new APP repos was a known gap — closed Day 43 (BE-YAC commit `b640758`). Note the file's *content currency* is a separate question (Peter's manual scan flagged it as outdated; DOC-YAC v2's audit run will surface it as a case before APP-KB-YAC inherits the propagated copy).

---

## 3. Architecture & Deployment

### 3.1 Stack and bootstrap

| Concern | Decision |
|---|---|
| Tech stack | Per `World-in-a-Pie/docs/technology-stack.md`. React + TypeScript + Vite + TanStack Query + Tailwind. No deviation in v1. |
| Bootstrap (repo) | `create-app-project.sh --preset query` (provides askBar scaffold + nl-query wiring) |
| User auth | OIDC, **same pattern as APP-RC** (via the `wip-auth` lib). The lib does the work; APP-KB-YAC consumes it. Multi-user implications fall out of the OIDC integration — v1 is effectively single-user (Peter), but no identity hardcoding. |
| Modify WIP code | **Never.** Per the Golden Rule (`wip://development-guide`). |

### 3.2 Hosting — k8s, dedicated `wip-kb` instance

| Concern | Decision |
|---|---|
| Production target | Kubernetes, in a dedicated `wip-kb` namespace running a **minimum-enhanced WIP instance** separate from `wip-stable` (see rationale below) |
| Dev/test target | Pi or localhost (existing pattern; APP-KB-YAC's working dev env) |
| Routing | Ingress at `/apps/kb/`, same multiplex pattern as APP-RC and APP-CT |
| Deployment manifest | Service + Deployment YAML following the `react-console.yaml` shape, but in the `wip-kb` namespace |
| Container image | Published to the same registry pattern as other WIP apps (e.g., `ghcr.io/<org>/kb:<tag>`) |
| Backup | APP-KB itself is stateless; backup of APP-KB = the `kb` namespace's documents inside the dedicated `wip-kb` WIP instance. Backup-restore round-trips on `wip-kb` get used freely (see below). |

**Why a dedicated WIP instance for the KB.** Switching from file-based YAC workflows (cases as `yac-discussions/CASE-*.md`, papers as files, journals on disk) to KB-based workflows is itself a productivity gain — and that switch needs only a *small subset* of v2 features (edge types and full-text search shipped Day 42–43; archetype enforcement still to come). It does not need the full v2 surface. The dedicated `wip-kb` instance is the **adoption layer** for v2: as more v2 features land, they deploy to `wip-kb` first; their real-workflow impact informs which v2 work gets prioritized next. APP-KB co-resides with its WIP backend in `wip-kb`. When enough v2 has shipped that `wip-kb` is the natural foundation for the next stable, the instance gets folded back into `wip-stable` or kept as a parallel — decision deferred.

**Backup/restore as ongoing regression test.** Backup–restore cycles on `wip-kb` get used freely (data isn't production-grade; round-trips are cheap and informative). Each cycle exercises the platform's backup/restore against real KB workload — itself a continuous regression check on platform features as they ship. Useful test surface in its own right.

**Optional green-blue deployment.** For safer rollouts of risky v2 features into `wip-kb`, the instance can be doubled as `wip-kb-green` / `wip-kb-blue` and switched between. Cheap because no production-grade SLAs constrain the interim instance.

### 3.3 Architectural rule — UI vs. MCP

| Caller | Talks to WIP via | Notes |
|---|---|---|
| **APP-KB UI (deterministic ops)** | **WIP REST API** | Reading docs, listing, traversing relationships, faceted filtering, flag-for-YAC writes — all REST |
| **APP-KB askBar** | **nl-query module** (provided by scaffold) | Agent-mediated retrieval; uses whatever stack the scaffold wires up — APP-KB-YAC does not redesign this |
| **YACs** | **MCP** | YACs are agents; MCP is for agents |

This rule is load-bearing. **Do not route deterministic UI calls through MCP.** MCP exists for agent consumption (LLM-mediated, non-deterministic). UI deterministic calls go through REST. Going UI → MCP → REST is two extra hops for zero benefit and couples the UI to MCP's evolution.

If APP-KB-YAC encounters a needed capability with no REST equivalent, **file a CASE for BE-YAC** — do not work around by routing through MCP from the UI.

### 3.4 Bootstrap on launch — offer-on-empty, use-on-exists

APP-KB checks its WIP namespace on launch and follows the **APP-CT pattern**:

- If the `kb` namespace **does not exist**: APP-KB shows a bootstrap offer to the user. The user can either (a) bootstrap a fresh namespace from APP-KB or (b) restore from a backup via the console first and then reload the app. APP-KB does **not** auto-bootstrap silently; the user explicitly initiates it.
- If the `kb` namespace **does exist**: APP-KB just uses it. No state comparison, no schema reconciliation, no "templates differ" check, no merge logic.

**Why this pattern:** rolling redeploys are normal on k8s — the app must come up cleanly against existing state. A "fail-if-exists" rule would block every redeployment. Conversely, an idempotent reconciler is a swamp (every "exists but differs" case demands a policy). The clean line is: the namespace's state is whatever it is; APP-KB does not try to fix it. Schema upgrades are a separate concern, handled by a YAC or a migration tool, not by app startup logic.

**Restore is not an app task.** If the user wants to drop the namespace and start fresh, or restore an old backup into the existing namespace, that's a console-initiated action (via `wip-deploy` / direct API). APP-KB does not provide UI for restore; the bootstrap offer just *mentions* it as an option the user may prefer.

**BOOTSTRAP_RECORD audit doc:** on user-initiated bootstrap, APP-KB writes one doc capturing:
- App version (e.g., `v0.3.1`)
- Bootstrap timestamp
- List of templates created (with their values)
- List of relationship types created
- The current commit SHA of APP-KB

This is the provenance trail. Future YACs reading the namespace can answer "who set this up, when, with what version?" without guessing. (No BOOTSTRAP_RECORD is written on the use-existing path — the existing namespace already has its own provenance trail from whoever created it.)

This pattern (offer-on-empty, use-on-exists, BOOTSTRAP_RECORD on bootstrap) is **general for all future apps**, not specific to APP-KB. A separate gene-pool addition will document this for `create-app-project.sh` and the APP CLAUDE.md heredoc.

---

## 4. Scope

### In v1

- All eight surfaces in §7
- All v1 doc types in §5 (FRanC's starting list; APP-KB-YAC may refine)
- All ten relationships in §6 — read/traverse/display only, never written from the UI
- Keyword search + faceted filters, surface TBD pending BE-YAC indexing architecture (§8)
- askBar (provided by scaffold's nl-query wiring)
- Flag-for-YAC modal, writes a `FLAG_RECORD` doc (not CASE_RECORD — see §5)
- Prepare-a-prompt helper on every doc view (§10) — three fixed intent buttons, no editor, no write
- doc_status visible as a read-only field on every doc
- OIDC user auth (via `wip-auth`)
- App-side namespace check: offer bootstrap on empty, use existing on present (§3.4); BOOTSTRAP_RECORD audit doc written on user-initiated bootstrap

### Parked for v1 — not built, not designed-around

- **Migration of legacy content.** No tooling to import `yac-discussions/`, `lessons.md`, `dayJournals/`, or `git-stats-overlay.csv`. The KB starts empty; YACs fill it as they work. Migration design happens **after** APP-KB v1 is shipped, or never — both acceptable.
- **Schema reconciliation between APP-KB's expected templates and what's in the existing namespace.** APP-KB uses what's there; schema upgrades are a YAC or migration-tool concern, not an app-startup concern.
- **Restore-from-backup UI.** Restore is a console action (user-initiated via `wip-deploy` / direct API), not an APP-KB feature.
- **Inline mid-session capture.** YAC-mediated only.
- **Direct doc authoring / editing in the UI.**
- **Template picker / relationship picker in the UI.** Relationships are written by YACs, displayed by APP-KB.
- **Status transitions / workflow management UI.** See §11.
- **Notifications, polling, ops queue.** No push, no real-time signals.
- **Per-user state.** No bookmarks, last-viewed, history, prefs. v1 is effectively single-user; if multi-user becomes real, designed then.
- **Cross-namespace federation.** KB namespace only.
- **Mobile-first design.** Desktop browser is the primary target.
- **Offline mode.**
- **Doc version timeline UI.** Versioning exists at the data layer (BE-YAC), not exposed in v1 UI.
- **Client-side full-text index.** Indexing is a data-layer concern (BE-YAC, see §8).

### Never (would change the app's identity)

- **Workflow / case-state-machine features.** If event/dispatch tracking becomes wanted, it's a separate app sharing the namespace, not a feature added to APP-KB. (See project memory `project_kb_app_separation.md`.)
- **YAC dispatch / orchestration.** APP-KB prepares prompts; the user dispatches. The KB never spawns sessions, never sends prompts to YACs directly.
- **Local persistence of any form** beyond the container's lifecycle. APP-KB is stateless.

---

## 5. Doc Types and Rendering

This is FRanC's **starting list**. APP-KB-YAC owns template creation as a v1 deliverable (per §2) and may refine field shapes. Don't add or rename the *types* without escalation; do refine the *fields* as APP-KB-YAC's design judgment dictates.

For UX rationale and field hints, see `v2-kb-ux.md` §"Doc Types (v1)".

| Template | Usage | Rendering mode | Origin in v1 |
|---|---|---|---|
| `CASE_RECORD` | entity | Mixed | Native — YACs file new cases as they arise (no legacy migration in v1) |
| `DESIGN_DECISION` | entity | Mixed | Native — YACs persist design decisions via `/kb-persist` |
| `LESSON` | entity | Mixed | Native — YACs persist lessons via `/lesson` (slash command writes to KB) |
| `FIRESIDE` | entity | Mixed | Native — YACs persist via `/kb-persist fireside` |
| `JOURNEY_ENTRY` | entity | Mixed | Native — FRanC persists day journals via `/kb-persist journey` |
| `GIT_STATS_SNAPSHOT` | entity | **Structured** | Native — generated by `/stats` writing into KB |
| `AGENT_IDENTITY` | reference | Mixed | Bootstrap-seeded for known YACs; new YACs add themselves |
| `FLAG_RECORD` | entity | Mixed | Created by APP-KB UI (the only UI write) — see §9 |
| `BOOTSTRAP_RECORD` | entity | Structured | Written once at namespace bootstrap (§3.4) |

**Rendering rules:**
- Every `entity` type has a `body` field of type `markdown` (except `GIT_STATS_SNAPSHOT` and `BOOTSTRAP_RECORD`, which are structured-only).
- Markdown body is rendered with a markdown library (links, code blocks, headings, tables, lists). The library choice is APP-KB-YAC's call.
- Structured fields appear above the body in the doc view.
- All `entity` docs display the common WIP fields: `authored_by`, `doc_status`, `created_at`, `updated_at`, `root` (if true).

**On CASE_RECORD field design:** APP-KB-YAC decides the structured-field shape. FRanC does **not** pre-specify severity, assignment, or similar JIRA-shaped fields — those are template-design decisions and importing them by reflex is exactly the slope §11 prevents. Start minimal: title, body, source-of-the-case, target YAC if applicable. Add fields when use reveals the need.

**On FLAG_RECORD field design:** APP-KB-YAC owns the schema. Required by §9: a body field for the user's question, a target_yac field, and the FLAGGED_FROM relationship to the source doc. Anything else is APP-KB-YAC's call.

---

## 6. Relationships

The ten edges from `v2-kb-ux.md` §"Relationships (v1)" — APP-KB-YAC creates these as relationship-type definitions during bootstrap.

APP-KB:

1. **Reads** all relationships of the displayed doc (incoming + outgoing) via the **WIP REST API**.
2. **Displays** them in a sidebar on the doc view, grouped by direction (incoming above, outgoing below) and labeled with the edge type.
3. **Lets the user click** any relationship to navigate to the related doc.
4. **Never writes** a relationship from the UI. Relationships are YAC-generated, on doc creation, via `/kb-persist`. **Exception:** flag-for-YAC writes one `FLAGGED_FROM` relationship as part of FLAG_RECORD creation (§9.1).

**Orphan handling:** docs with neither incoming nor outgoing relationships AND `root: false` are flagged in the UI as "orphan". APP-KB shows a small visual marker. No action is taken automatically — the marker exists so Peter can spot drift and ask a YAC to repair the link.

---

## 7. Surfaces

Each surface has: purpose, required behaviors (testable), explicitly-out-of-scope. **No pixel specs.** APP-KB-YAC chooses layout, navigation pattern, and visual design.

All UI data calls go through the **WIP REST API** unless explicitly noted otherwise (askBar is the exception — §3.3).

### 7.1 askBar (top, persistent)

**Purpose:** NL query against the KB (RAG/retrieval, KB-scoped, single-turn, stateless).

**Required behaviors:**
- Persistent across all surfaces (top of viewport).
- Built on the **scaffold's nl-query wiring** — APP-KB-YAC does not redesign this. The scaffold provides the implementation surface.
- Returns a synthesized answer (light synthesizer, not just a doc list — see kb-ux paper §"Open Questions" Q1).
- Cites the docs it drew on (clickable to doc view).
- Offers escalation to a YAC session when the query exceeds askBar's reach. The escalation is a **prepared prompt** the user copies (see §10), not an autodispatch.

**Out of scope:** multi-turn dialogue (use a YAC), cross-namespace queries, agent-action triggering.

### 7.2 Search results + facets

**Purpose:** Keyword search across the KB with faceted filtering.

**Required behaviors:**
- Free-text search box.
- Facet dimensions: type, author / participating YAC, date range, doc_status.
- Search uses the WIP REST API surface that BE-YAC exposes (which surface is TBD — see §8).
- Result list with type badge, title, author, last-updated, snippet.
- Click a result → doc view.

**Out of scope:** semantic search (askBar handles that), saved searches, search history.

### 7.3 Topic page

**Purpose:** Auto-aggregated current state of a concept (e.g., "v2 archetypes", "OIDC auth").

**Required behaviors:**
- Aggregation key: keyword match on title + tags (start simple; iterate per kb-ux §"Open Questions" Q3).
- Lists all docs touching the topic, grouped by type.
- Surfaces the most recent DESIGN_DECISION on the topic at the top.

**Out of scope:** hand-curated topic LOV in v1, topic editing, topic merge/split.

### 7.4 Document view + relationship sidebar

**Purpose:** Read a single doc; see + traverse its 1-hop neighborhood.

**Required behaviors:**
- Renders the doc per §5 rules (mixed: structured fields + markdown body).
- Sidebar lists incoming + outgoing relationships (via REST), grouped by direction, labeled with edge type.
- Click any relationship → navigate to the related doc.
- "Flag for YAC" button (§9.1).
- "Prepare a prompt" buttons (§10) — three of them.
- Doc metadata always visible: `authored_by`, `doc_status`, `created_at`, `updated_at`, `root` if true.
- Orphan marker if the doc has zero relationships and `root: false`.

**Out of scope:** inline editing, doc deletion (BE-YAC archives, never deletes), version timeline UI.

### 7.5 Connections view

**Purpose:** Show the path between two selected docs.

**Required behaviors:**
- Two-input form: source doc, target doc.
- Walks the shortest relationship path (via REST traversal API).
- Displays the chain of docs and edge types.
- Each step is clickable.

**Out of scope:** multi-source / multi-target, force-directed graph view, weighted-edge logic.

### 7.6 Lessons browser

**Purpose:** Pattern-spotting across the LESSON corpus.

**Required behaviors:**
- Lists all `LESSON` docs.
- Filterable by tag, source case (if any), date range.
- Tag cloud at the top showing tag frequency.
- Click a lesson → doc view.

**Out of scope:** lesson clustering, AI-suggested patterns, lesson authoring.

### 7.7 Git stats browser

**Purpose:** Browse `GIT_STATS_SNAPSHOT` docs.

**Required behaviors:**
- Lists all snapshots, sorted by date descending.
- Per-day drill view showing the structured stats fields.
- Optional: simple time-series chart for repo size or commit count.

**Out of scope:** custom dashboard builder, multi-repo overlays in v1.

### 7.8 Flag-for-YAC modal

**Purpose:** Turn any doc into a cross-agent prompt by creating a FLAG_RECORD.

See §9.1 for full mechanics.

---

## 8. Search — Pending Architecture Decision

Full-text search architecture is **out of scope for this spec** because it is most cleanly a property of the data layer (a `full_text_indexed: true` flag on a template field, with BE-YAC's reporting layer or doc-store maintaining the index). Multiple apps will eventually want full-text search; building it inside APP-KB duplicates work and pushes indexing concerns into the wrong layer.

**Required before APP-KB-YAC starts coding §7.2:**
- BE-YAC and FRanC agree on the indexing approach (likely a field-level flag + an index maintained by WIP).
- The WIP REST API exposes a search endpoint APP-KB can call.
- The shape of the response (snippets, ranking, facet counts) is documented.

**Until then:** APP-KB-YAC may stub §7.2 with a substring match against doc titles + structured fields. This is acceptable while the corpus is small (the KB starts empty). Real search lights up when BE-YAC ships the index.

**APP-KB does not run an index.** No client-side Lunr/MiniSearch/FlexSearch indexes. No custom server-side index inside the APP-KB container. The index lives where the data lives.

---

## 9. Write Discipline

APP-KB has **exactly one** write surface in v1: the flag-for-YAC modal (§9.1). All other writes happen through YAC slash commands, never through the UI. All writes go via the **WIP REST API**.

### 9.1 Flag-for-YAC

**Mechanics:**
1. User clicks the flag icon in any doc view.
2. Modal opens.
3. User picks a target YAC from a dropdown (BE-YAC, APP-RC, BUG-YAC, FRanC, "any").
4. User types the reason / question (free text, markdown allowed).
5. User confirms.
6. APP-KB calls the WIP REST API to create a `FLAG_RECORD` doc with:
   - `authored_by` set from the OIDC identity (Peter, in v1)
   - `doc_status` set to whatever APP-KB-YAC defines as the initial state for FLAG_RECORD
   - `target_yac` = the picked YAC
   - `body` = the user-typed reason
   - One `FLAGGED_FROM` relationship pointing to the source doc
7. Modal closes; APP-KB displays the prepared YAC prompt (§10) referencing the new flag so the user can copy it into a terminal.

**Why FLAG_RECORD and not CASE_RECORD:** keeping the type semantics precise. CASE_RECORD is a filed-bug or filed-question artifact YACs use among themselves. FLAG_RECORD is "Peter saw this doc and wants a YAC to look at it." A YAC handling a flag may decide it warrants a CASE_RECORD and file one — that's a YAC-side promotion, not an app-side coupling.

**Required validations:**
- Reason is not empty.
- Target YAC is one of the configured options.
- The source doc exists and is reachable at the moment of writing.

**Out of scope:**
- Editing or canceling a flag after creation (YACs handle that via `/kb` commands).
- Status transitions on the FLAG_RECORD (the doc's `doc_status` is set at creation; transitions happen via YAC writes only).

---

## 10. The "Prepare a Prompt" Helper

A clipboard helper, not a write. Goal: enrich an isolated doc ID with context so Peter can dispatch a YAC efficiently — not replace the YAC interaction.

**Trigger:** every doc view exposes three buttons. The flag-for-YAC modal also produces a copy-to-clipboard prompt on confirmation, using button (a) by default.

**Three fixed intent buttons** (v1):

| Button | Generated prompt template |
|---|---|
| (a) Read for design discussion | `Read the KB doc with WIP ID <id> ("<title>") to prepare for a design discussion.` |
| (b) Read and validate via codebase | `Read the KB doc with WIP ID <id> ("<title>") and validate the claims by investigating the codebase.` |
| (c) Read and create implementation plan | `Read the KB doc with WIP ID <id> ("<title>") and produce an implementation plan.` |

**Behavior:**
- Click → text on clipboard → brief "copied!" toast → done.
- No editor, no modal beyond the toast.
- The doc ID and title are auto-injected; the user does not edit them.
- If the prompt needs tweaking, the user does it in the terminal where they're pasting it. APP-KB does not provide an editor.

**Implementation:**
- The prompt strings come from a list (TS const array in the repo for v1). Adding a 4th intent later = edit the list, redeploy. No UI changes needed.
- If list-from-WIP becomes desirable (so the prompts can be edited via a YAC), that's a future evolution — same code path, different fetch source.

**Out of scope:**
- Autodispatch to a running session.
- Tracking whether the prompt was used.
- Per-doc-type variation. The three buttons are universal across all doc types; if a button doesn't fit the doc type, the user simply doesn't click it.

**This is not a write.** No KB doc is created or modified by clicking these buttons. The clipboard is not the KB.

---

## 11. State / Workflow Boundary

APP-KB displays state. APP-KB does not change state.

| State change | Where it happens |
|---|---|
| Create a doc | YAC slash command (e.g., `/kb-persist`) |
| Update a doc | YAC slash command |
| Change `doc_status` | YAC slash command (e.g., `/kb-publish`) |
| Add or remove a relationship | YAC slash command on doc create or update |
| Archive a doc | YAC slash command |
| Hard delete | Never (BE-YAC archives, never hard-deletes) |
| **Flag a doc to a YAC (FLAG_RECORD)** | **APP-KB UI (the only write)** |

The `doc_status` field is **visible** in every doc view but **never editable** from the UI in v1.

If you (APP-KB-YAC) feel tempted to add a button that changes a status, an assignment, or a tag — stop, surface the temptation as an open question, and wait for Peter to weigh in.

---

## 12. Discipline Boundaries

These rules are inherited from the gene pool and re-stated here because they are load-bearing for APP-KB:

1. **The Golden Rule.** Never modify WIP code. APP-KB consumes WIP via REST + (askBar) nl-query. If WIP doesn't expose what APP-KB needs, file a CASE for BE-YAC — do not work around.
2. **No fabricated config.** Environment variable names, REST endpoints, MCP tool names, template field names — verify by reading the canonical source. Do not invent.
3. **Architectural rule (§3.3).** UI → REST. askBar → nl-query. YAC → MCP. Do not blur the lines.
4. **Bootstrap is offer-on-empty, use-on-exists.** No silent auto-bootstrap, no schema reconciliation, no merge logic. Rolling redeploys must come up clean against existing state.
5. **APP-KB is stateless.** All state in WIP. No client-side index, no per-user prefs cache, no local DB.
6. **Every new doc declares a relationship or `root: true`.** When APP-KB creates a FLAG_RECORD via flag-for-YAC, the FLAGGED_FROM relationship is mandatory.
7. **Trust APP-KB-YAC on UI.** This document specifies behaviors, not pixels. Frontend craft is APP-KB-YAC's domain.
8. **Read before you write.** Before implementing any surface, APP-KB-YAC reads `wip://development-guide`, `wip://data-model`, `wip://conventions`, `wip://ponifs`, this document, `v2-kb-ux.md`. Sessions that begin without these reads start in drift.

---

## 13. Acceptance Criteria

APP-KB v1 is "done" when all of the following pass.

### Architecture
- [ ] App is created from `create-app-project.sh --preset query` and has `docs/technology-stack.md` checked in
- [ ] App's CLAUDE.md is the gene-pool default + KB-specific overlay (if any)
- [ ] Container image is published to the canonical registry
- [ ] App is deployed to k8s in the dedicated `wip-kb` namespace (alongside its dedicated WIP instance) via wip-deploy
- [ ] App is reachable at the configured ingress path `/apps/kb/`
- [ ] App authenticates the user via OIDC (`wip-auth`), same pattern as APP-RC
- [ ] App calls the WIP REST API for all deterministic ops; askBar uses scaffold nl-query; nothing else uses MCP
- [ ] App stores no state outside WIP (no local DB, no client-side index, no per-user prefs)

### Bootstrap
- [ ] On launch with no `kb` namespace: app shows a user-initiated bootstrap offer; on confirm, creates terminologies, templates, relationship types, and a `BOOTSTRAP_RECORD` audit doc
- [ ] On launch with an existing `kb` namespace: app uses it without modification; no schema check, no merge, no error
- [ ] The bootstrap offer mentions restore-from-backup as a console-initiated alternative the user may prefer
- [ ] BOOTSTRAP_RECORD (when written) captures app version, timestamp, what was created, and APP-KB's commit SHA
- [ ] Rolling redeploys against an existing namespace succeed without intervention

### Doc view (§7.4)
- [ ] All v1 doc types render correctly per §5 rules (verify by creating one doc of each type via a YAC and viewing it)
- [ ] Structured fields appear above the body
- [ ] Markdown body renders headings, code blocks, tables, links, lists
- [ ] Relationship sidebar shows incoming and outgoing relationships, grouped by direction, fetched via REST
- [ ] Clicking a relationship navigates to the related doc
- [ ] Common fields (`authored_by`, `doc_status`, `created_at`, `updated_at`, `root`) are visible
- [ ] Orphan marker appears for docs with zero relationships and `root: false`
- [ ] "Flag for YAC" button and three "Prepare a prompt" buttons are present and functional

### Search (§7.2, §8)
- [ ] Free-text search returns docs containing the query, using whichever WIP REST search surface is available at v1 ship time (substring stub acceptable until BE-YAC ships indexing)
- [ ] Faceted filters (type, author, date range, doc_status) narrow results correctly via REST query params

### askBar (§7.1)
- [ ] Persistent at top of every surface
- [ ] Returns a synthesized answer with cited docs (via scaffold's nl-query wiring)
- [ ] Citations are clickable
- [ ] Long-form / cross-source queries trigger an escalation prompt

### Topic page (§7.3)
- [ ] Aggregates docs by keyword + tag match
- [ ] Most-recent DESIGN_DECISION pinned at top
- [ ] Click into source docs

### Connections view (§7.5)
- [ ] Two-doc selection
- [ ] Shortest path is shown with edge labels
- [ ] Each step clickable

### Lessons browser (§7.6)
- [ ] Lists all LESSON docs
- [ ] Tag cloud reflects tag frequency
- [ ] Filters by tag, source case, date range

### Git stats browser (§7.7)
- [ ] Lists all GIT_STATS_SNAPSHOT docs sorted descending by date
- [ ] Per-day drill renders structured fields tabularly

### Flag-for-YAC (§9.1)
- [ ] Modal collects target YAC + reason
- [ ] On confirm, creates FLAG_RECORD via REST with FLAGGED_FROM relationship to source doc
- [ ] On confirm, displays prepared prompt (a) for the user to copy
- [ ] Reason cannot be empty

### Prepare-a-prompt (§10)
- [ ] Three fixed intent buttons available on every doc view
- [ ] Generated prompt references the doc's WIP ID and title (auto-injected)
- [ ] One-click copy to clipboard
- [ ] No editor, no per-doc-type variation
- [ ] Prompt strings come from a config list (extensible without UI work)

### Discipline
- [ ] No WIP source code modified by APP-KB-YAC during development
- [ ] No status transitions, no doc edits, no relationship writes from APP-KB UI (other than FLAGGED_FROM as part of flag-for-YAC)
- [ ] App is read-mostly: only flag-for-YAC writes
- [ ] No client-side index code
- [ ] No MCP calls from the UI; only askBar uses non-REST channels

---

## 14. Non-Goals (Explicit)

To prevent scope drift, these are *not* part of APP-KB v1:

- Any UI for changing doc status
- Any UI for editing doc content
- Any UI for creating or removing relationships (other than FLAGGED_FROM as part of flag-for-YAC)
- Any orchestration of YAC sessions (no spawning, no message-sending)
- Any feature beyond the three "prepare a prompt" buttons that touches YAC dispatch
- Any state-machine / workflow / kanban / board view
- Any notification or polling mechanism
- Any per-user state (bookmarks, last-viewed, history, prefs)
- Any cross-namespace query, federation, or aggregation
- Any client-side full-text index
- Any local persistence
- Any dependency on legacy markdown content (`yac-discussions/`, `lessons.md`, `dayJournals/`, etc.). The KB starts empty.
- Any schema-reconciliation logic on launch against an existing namespace.
- Any restore-from-backup UI. Restore is console-initiated.

---

## 15. Open Questions APP-KB-YAC Should Surface

APP-KB-YAC will hit decisions this spec doesn't answer. When it does, **escalate to Peter via FRanC**, do not decide unilaterally. Likely candidates:

1. **Empty-state UX.** The KB starts empty (no migration). What does APP-KB show on day 1 — an "ask a YAC to write the first doc" prompt? A walkthrough? A skeleton with placeholders? UX call.
2. **Doc deep-link format.** Shareable URLs to docs: `/apps/kb/doc/<wip-id>`? `/apps/kb/<type>/<slug>`? Affects search-result links, prepared prompts, etc.
3. **Citation rendering in askBar answers.** Inline footnote? Side panel? Trade-off between density and readability.
4. **FLAG_RECORD structured fields beyond the required minimum.** APP-KB-YAC may want one or two extras (e.g., a `priority` enum), but each addition is a JIRA-creep risk. Surface before adding.
5. **CASE_RECORD structured fields.** Same caution.
6. **doc_status semantics for FLAG_RECORD.** Reuse the standard `draft / reviewed / published / deprecated / archived` lifecycle, or define FLAG-specific states? APP-KB-YAC's call but worth a check-in.
7. **Schema-drift detection (deferred).** v1 does no comparison between APP-KB's expected schema and what's in the namespace. If a future need emerges (e.g., a YAC adds a new field that APP-KB doesn't know about), surface the case and let Peter decide whether it's an APP-KB concern or a separate tooling concern.

---

## 16. References

- `papers/v2-kb-ux.md` — UX rationale, doc-types catalogue, relationships taxonomy
- `papers/v2-archetypes.md` — the `knowledgebase` archetype
- `papers/v2-process-seeds.md` — process context
- `World-in-a-Pie/docs/technology-stack.md` — canonical stack
- `World-in-a-Pie/scripts/create-app-project.sh` — bootstrap script (use `--preset query`)
- `World-in-a-Pie/k8s/services/react-console.yaml` — k8s manifest pattern reference
- WIP REST API documentation (BE-YAC's domain)
- MCP resources: `wip://data-model`, `wip://conventions`, `wip://ponifs`, `wip://development-guide`
- Project memory `project_kb_app_separation.md` — the read-only-on-workflow rule
- Project memory `project_app_yac_genepool_techstack.md` — the technology-stack.md propagation gap

---

*Discipline summary in one paragraph: APP-KB is a stateless, read-mostly UI on the WIP-hosted KB in a dedicated `kb` namespace, deployed to k8s alongside other WIP services. Eight surfaces, nine doc types (FRanC's starting list, refinable by APP-KB-YAC), ten relationship edges, mixed rendering, OIDC auth via wip-auth. UI talks REST; askBar uses the scaffold's nl-query wiring; YACs go through MCP. The only UI write is flag-for-YAC, which creates a FLAG_RECORD with a FLAGGED_FROM relationship and produces a copy-pasteable prompt. Three fixed intent buttons enrich doc context for clipboard hand-off — no editor, no per-type variation, no write. Bootstrap is offer-on-empty, use-on-exists; no schema reconciliation, no merge logic — rolling redeploys come up clean against existing state. APP-KB-YAC owns the templates and the data model. No status transitions, no editing, no relationship writes, no autodispatch, no client-side index, no per-user state, no migration. If workflow is wanted later, it's a separate app sharing the namespace. Trust APP-KB-YAC for UI craft; constrain it on behavior, scope, and discipline. Done means every acceptance criterion in §13 ticks.*
