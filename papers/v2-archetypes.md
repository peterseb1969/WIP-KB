# v2 Archetypes — Working Document

**Status:** Working draft. Based on 2026-04-16 brainstorm with Peter, expanded 2026-04-17 (rename `activity-journal` → `event-journal`, add `tracker`, add `plan`). Agent-constraints design 2026-04-17 (enforcement arsenal, dev/run split, `/wip-status`, `/wip-new-app`, "Leaving the Rails"). Expanded 2026-04-18 with two named principles (**Minimum Effective Guardrail**, **Discrete Modes, Explicit Transitions**), **cross-archetype add-ons** as peer to modules, **state-as-field+version** pattern, and build-time sketches for five archetypes (corkboard, event-journal, tracker, plan, knowledgebase). Remaining archetypes (authoring, integration) and plumbing details pending.

**Relationship to existing docs:**
- `FR-YAC/reports/BE-YAC-20260409-1636/fireside-v2-design-seeds.md` — Theme 11 introduced archetypes as developer experience foundation. This document is the concrete expansion.
- `FR-YAC/papers/v2-process-seeds.md` — process seeds apply across archetypes; this doc defines the archetypes the processes serve.
- `World-in-a-Pie/docs/design/wip-deploy-v2.md` — the deployer that renders archetype-driven configurations.

---

## The Principle

An archetype is a **contract** between the deployment, the developer experience, and the runtime guarantees. It declares:

- Which components are deployed
- Which modules are enabled
- What consistency guarantees the API provides
- What the data lifecycle looks like (mutable vs versioned, deletion semantics)
- What templates and scaffolding the `create-app-project.sh` produces
- What guidance the archetype-specific CLAUDE.md gives the agent
- What the agent should push back on

**The bargain:** follow the rails and get speed + quality for free. Go off-rail and you own the consequences. The platform respects expertise; it just doesn't pretend that AI agents have it. An archetype isn't a cage — it's the shortest path to "the thing works in production the way it works in dev."

**Archetypes are declared at deployment time.** They travel with the codebase (CLAUDE.md and manifest) so subsequent agents inherit the constraints without having to ask.

---

## The Seven Archetypes

### 1. `corkboard`

**The pattern:** a flexible, queryable store for personal stuff — shopping lists, recipes, ideas, ToDOs, home inventory, reading lists, travel journals, book notes, garden tracker. A backend for your corkboard.

**Data characteristics:**
- Data originates in the user's head, not external sources
- Everything mutable — recipes get edited, ideas get revised, terminology extensible by default
- Deletion is fine — nothing is an audit trail
- Single user (or small trusted group)

**Required components:** core (MongoDB, Registry, def-store, template-store, document-store) + auth-gateway + Dex + Caddy.

**Optional modules:** `files` (for photos, receipt scans), `nl-query` (the askBar — highly recommended, it's what turns "flexible store" into "useful").

**Excluded:** PostgreSQL, reporting-sync, ingest-gateway.

**Consistency contract:** eventually consistent. Writes return when MongoDB acks. UI reads MongoDB directly. No analytics, no await semantics.

**Namespace model:** one namespace per corkboard project.

**Defaults:**
- `deletion_mode: full` (hard delete allowed)
- Terminologies `mutable: true, extensible: true`
- No backup schedule prescribed (data isn't precious enough)

**Example scaffolded templates:** `CORK_ITEM` (generic), plus domain-specific suggestions (`RECIPE`, `TODO`, `IDEA`, `NOTE`).

**Agent guidance summary:**
- Mutable is default; don't overthink identity fields
- Deletion is fine; no need to preserve history
- If the use case needs analytics, push back: "This looks like integration, not corkboard."

**Similar use case examples:** shopping lists, recipes, ideas, ToDos, reading lists with tags, home inventory, travel journals, D&D character vault (personal), garden tracker, book notes, household maintenance log.

---

### 2. `authoring`

**The pattern:** single-author, long-form content where drafts matter and deletion is destruction. AuthorAssist is the canonical example. Also: diaries, letters, cookbooks (your own tested recipes, v3 after the correction), journals, memoirs, personal research notebooks, typing practice libraries with history, correspondence archives.

**Data characteristics:**
- Content IS the work — no source system to re-pull from
- Version history matters (v3 vs v7 of a chapter is meaningful)
- Deletion is loss, not cleanup
- Value increases over time — accumulated intent is irreplaceable
- Single author (or tightly coordinated co-authors)

**Required components:** core + auth-gateway + Dex + Caddy.

**Optional modules:** `files` (recommended — photos, scans, audio attachments), `nl-query` (useful for navigating long works), `backup-schedule` (load-bearing — these docs can't be reconstructed from anywhere else).

**Excluded:** PostgreSQL, reporting-sync, ingest-gateway.

**Consistency contract:** eventually consistent. Writes return when MongoDB acks. The single-author pattern means there are no concurrent write conflicts worth worrying about.

**Namespace model:** one namespace per authoring project.

**Defaults:**
- `deletion_mode: retain` (soft delete only; hard delete requires explicit override)
- Terminologies `mutable: false` (categorization should be stable)
- Backup schedule **required** — the scaffold asks about backup destination during install
- Version history on all templates by default

**Agent guidance summary:**
- Never suggest deletion as cleanup
- Every edit creates a version
- If the user asks "remove old drafts," push back: "The archetype preserves drafts. Are you sure? Alternative: archive them."
- Tooling specialization happens *inside* the archetype (scene editor vs letter composer vs journal entry)

**Similar use case examples:** novels, screenplays, cookbooks (your own recipes), diaries, correspondence archives, photo books with captions, genealogy/family history, memoirs, personal research notebooks, teaching materials, curriculum design.

---

### 3. `integration`

**The pattern:** multi-source normalized analytics. Multiple capture apps or importers feed a shared dataset; a dedicated analytics UI sits on top. You don't own the data — you collect, normalize, and analyze. Canonical examples: ClinTrial Explorer, a financial analysis project pulling statements, receipts, market data, inflation, energy prices.

**Data characteristics:**
- Data comes from external sources (scans, imports, APIs)
- Must match the source — normalization is part of the value
- Deletion is fine — re-import from source recovers
- Analytics is primary, not incidental
- Multiple apps typically — capture apps write, analytics apps read

**Required components:** core + auth-gateway + Dex + Caddy + **PostgreSQL** + **reporting-sync**.

**Optional modules:** `files` (most integrations want this — receipts, PDFs, supporting docs), `nl-query` (recommended — "ask your data" is the killer feature).

**Excluded:** ingest-gateway (integration uses scheduled imports or app-mediated capture, not async bulk ingestion).

**Consistency contract:** eventually consistent. Writes return fast; analytics queries may lag seconds-to-minutes behind writes. Batch imports explicitly accept this — the pattern is "capture, sync, analyze," not "capture and immediately analyze this moment."

**Namespace model:** **one namespace per project** (not per source). All finance data in `finance`; all energy data in `energy`. This is the critical design call:
- Cross-source queries are trivial SQL
- Shared terminologies just work (currencies, countries, asset classes)
- References cross source boundaries freely within the namespace
- Backup is one coherent archive
- The "semantic space" is unified

**Defaults:**
- `deletion_mode: full` (hard delete allowed — re-import is the recovery path)
- Terminologies `mutable: true, extensible: true` (external data surprises you)
- **Templates include lineage fields by default:** `source_url`, `source_date`, `imported_at`, `import_run_id`
- **Mapping tables pre-scaffolded** (v2 Theme 9): external data is messy, normalization is hard-won knowledge that must persist

**Agent guidance summary:**
- User-originated data in an integration namespace is a smell — push back
- Original data may be re-imported; user-derived data (queries, dashboards, annotations, classification rules) must survive re-import
- Every document should have lineage — where did it come from, when, from which run?
- If asked "store a user note on this trial," propose: (a) a separate `annotations` template that references the original, or (b) a separate namespace with a different archetype
- If asked to compute aggregations in app code, push back: "Integration has PostgreSQL. Use SQL."

**Similar use case examples:** clinical trials exploration (ClinTrial), financial analysis (statements + markets + inflation + energy prices), scientific literature monitoring (PubMed), competitive intelligence (public company filings), real estate market analysis (MLS + property records), sports statistics aggregation, weather data archives.

---

### 4. `knowledgebase`

**The pattern:** an authoritative information hub with mixed origin — some content authored internally, some integrated externally, with relationships as first-class citizens. The canonical example: **WIP-as-nucleus-for-YACs** — the cell part that contains the genetic information, consulted by every YAC for context. Also: personal knowledge bases (Zettelkasten style), research libraries (own interpretations + imported papers), team wikis with structured metadata.

**Data characteristics:**
- Mixed origin — authored pieces AND integrated external sources, peer in status
- The **graph matters more than the document** — relationships, cross-references, citations are the core data
- Search and traversal are primary access patterns, not linear reading
- Multi-contributor by design — humans + agents co-write
- Deletion is not fine — authored pieces can't be re-imported

**Required components:** core + auth-gateway + Dex + Caddy.

**Optional modules:** `files` (often needed — PDFs, images, attached documents), `nl-query` (essential — navigating the graph without NL is painful), `analytics` (optional — PostgreSQL if the knowledge base has quantitative dimensions).

**Excluded:** ingest-gateway (import pattern is scheduled, not async bulk).

**Consistency contract:** eventually consistent. Writes return fast. Relationship queries may briefly lag but this is acceptable — knowledge graphs don't need millisecond consistency.

**Namespace model:** typically one namespace per knowledge domain. Multiple YACs or users contributing to the same knowledge base share the namespace.

**Defaults:**
- `deletion_mode: retain` (soft delete; the authored pieces are irreplaceable)
- Terminologies `mutable: true, extensible: true` (knowledge grows)
- **`usage: relationship` templates prominent** (v2 Theme 8) — citations, references, "sees also," "supersedes," "contradicts" are templates with properties
- Origin metadata on every document (`authored_by: peter | yac | import`, `source: <ref>`)
- Version history on authored templates; not on imported

**Agent guidance summary:**
- Always preserve origin — don't let authored content lose provenance
- When adding a document, ask: is this authored (owned) or integrated (referenced from elsewhere)?
- Build the graph deliberately — relationships > documents for discoverability
- Cross-references are first-class; use `usage: relationship` templates, not hidden fields

**Similar use case examples:** WIP-as-nucleus-for-YACs, personal knowledge base / second brain, research library (papers + own notes), team wiki with structured metadata, genealogy with sources, internal engineering knowledge base.

---

### 5. `event-journal`

**The pattern:** time-stamped events in a structured workflow, with strong read-your-writes guarantees and rich relationships between events, subjects, and materials. Exemplar: **LIMS** (Laboratory Information Management System). Also: clinical encounters, field research logs, inspection logs, manufacturing batch records, audit trails of structured operations, production incident journals.

(Renamed from `activity-journal` on 2026-04-17 — "activity" is fitness-app-coded; "event" is the neutral term for a time-stamped thing with consequences. The name change also sharpens the boundary with `tracker`: event-journal is about *discrete, reviewable events* in a workflow; tracker is about *continuous, aggregable streams*.)

**Data characteristics:**
- Every entry is an event — time-stamped, attributable, reviewable
- Reference-heavy: an experiment references a sample, a reagent, an instrument, a protocol, a result
- Audit trail is load-bearing — history is a correctness property, not a convenience
- Regulatory pressure is often present (GxP-adjacent, even if not formally regulated): reproducibility matters, provenance matters, undelete matters
- The **relationship graph between owned and external data is uniquely important** — a sample (owned) references a protein (UniProt, external) which references a gene (NCBI, external)
- Master data quality is critical — "which reagent lot?" must be unambiguous

**Required components:** core + auth-gateway + Dex + Caddy + **PostgreSQL** + **reporting-sync**.

**Optional modules:** `files` (essential — spectra, images, sequencer output), `nl-query` (helpful but not primary), `ingest-gateway` (for instrument data streams — case-by-case).

**Consistency contract:** **strong read-your-writes for the user's own workflow**. Writes to the user's own namespace return only when PostgreSQL can find the record. This is the **`await=postgres`** contract. Rationale: the user records a measurement and the next UI step queries "all measurements for this sample series" via PostgreSQL JOINs. Eventual consistency means the user's own data "disappears" between write and sync-catchup, which in a regulated context is a data integrity concern.

**This consistency contract is what distinguishes event-journal from knowledgebase** — same components, different API defaults and UX patterns.

**Namespace model:** typically one namespace per project or per instrument/site/study. Event-journals can be larger in scope than a single user but tightly governed.

**Defaults:**
- `deletion_mode: retain` (soft delete mandatory; audit trails are immutable)
- Terminologies `mutable: false` by default (master data is authoritative) — with explicit escalation for mutable vocabularies
- **`await=postgres` default on writes** — subsequent queries see the write
- **`usage: relationship` templates mandatory** — experiment→sample, experiment→reagent, experiment→instrument, experiment→output, each a typed edge with properties (quantity, concentration, conditions)
- Rich master data scaffolding: LOV templates (`usage: reference`) for reagents, instruments, samples pre-created
- Backup schedule required + post-restore integrity verification
- Version history on everything

**Agent guidance summary:**
- `await=postgres` is the default; omit only with justification
- Every event is a graph of references, not a single document
- Master data is authoritative — "free text instrument name" is a smell, push back to "pick from the instrument LOV"
- Never suggest deletion; if the user asks, suggest voiding with reason instead
- Soft deps: if you depend on PostgreSQL being in sync, assume it is (the archetype guarantees it)
- **`/audit-await` command** should be run regularly to verify the archetype's consistency contract is honored across the codebase

**Similar use case examples:** LIMS (laboratory workflow), clinical encounter records, field research journals (ecology, archaeology), factory batch records, manufacturing inspection logs, pharmacy dispensing logs, quality control workflows, forensic investigation logs.

---

### 6. `tracker`

**The pattern:** continuous data from devices or feeds, ingested near-real-time, read primarily through aggregations and dashboards rather than individual records. Exemplar: **wearable device data** (HR, steps, sleep). Also: smart-home sensors, IoT telemetry, RSS/Atom feed harvesters, web analytics, server log aggregation, vehicle telematics, weather stations, real-time market tick data, network monitoring, agricultural sensor networks.

**Data characteristics:**
- Continuous stream, unbounded — you never "finish" ingesting
- **Per-record value is low; aggregate value is high** — individual readings are rarely reviewed
- Very high write volume, moderate-to-low read volume on individual records
- Read pattern is windowed aggregation (1-minute, 5-minute, 1-hour), not record browsing
- Retention tends toward hot/warm/cold — recent data accessed often, old data archived or summarized
- The capture source is a device or feed, not a human and not a batch import from an external API

**Required components:** core + auth-gateway + Dex + Caddy + **PostgreSQL** + **reporting-sync** + **ingest-gateway** + **NATS** (NATS is already in the stack, but it becomes load-bearing for the write path).

**Optional modules:** `nl-query` (useful for "show me yesterday's spike in CPU load"), `files` (rare — telemetry is usually numeric, not media).

**Consistency contract:** **fire-and-forget eventual**. The opposite of event-journal. Writes go through NATS, return immediately, eventual consistency measured in seconds. `await=postgres` would defeat the archetype's purpose — you can't block on every sensor reading.

**Namespace model:** typically one namespace per tracker project (one namespace for "home sensors," one for "health data," etc.). A tracker namespace often contains a small number of templates (heart-rate, step-count, motion-event) but many, many documents.

**Defaults:**
- `deletion_mode: full` — time-based retention policies are scaffolded ("raw data older than 90 days is summarized and deleted")
- Terminologies `mutable: true, extensible: true` (new devices/sources appear)
- **Version history: disabled** — every reading is its own record; versions aren't meaningful
- **Mapping tables common** — normalize device IDs, sensor names, feed source identifiers
- Templates always include `timestamp` (indexed) and typically `source_id`/`device_id`
- Dashboards scaffolded as the primary UI, not record browsers
- Backup: policy-dependent — full backup of aggregates is cheap; full backup of raw stream is often not worth it

**Agent guidance summary:**
- Think in windows (1m/5m/1h), not records
- Every tracker template has a `timestamp` field, indexed — non-negotiable
- If the user asks to look up "a specific reading from last March," push back: "Tracker isn't optimized for that. Do you want an aggregation over that period instead?"
- Aggregation templates (hourly_heart_rate_summary) are first-class alongside raw reading templates (heart_rate_reading)
- Write path goes through ingest-gateway (NATS) — not direct document-store writes. The app's job is to produce well-shaped documents; the gateway ingests them.
- Agent should never suggest `await=postgres` in a tracker — it's the wrong contract

**Similar use case examples:** wearable health data (HR, steps, sleep), smart-home sensors (temp, humidity, motion, energy), IoT telemetry, RSS/Atom feed harvesters, web analytics, server log aggregation, vehicle telematics, weather stations, real-time market tick data, network monitoring, agricultural sensor networks.

**Note on relationships:** `usage: relationship` is less central to tracker than to event-journal or knowledgebase. A wearable reading's "relationship" to other readings is implicit in timestamp + device_id, not a typed edge. Relationships might appear in aggregation summaries ("this hourly summary covers these 600 readings") but are not the organising principle.

---

### 7. `plan`

**The pattern:** a forward-looking structural specification with instance derivation, consumed by other apps (typically an event-journal) that record execution against it. Exemplar: **a clinical trial plan** — master protocol, study arms, patient visit schedules with activities (consent, vital signs, blood draw, dosing), sample lifecycle (taken → shipped → received → analyzed → reported). Also: construction project plans, event planning (weddings, conferences), academic curricula, aircraft/power plant maintenance schedules, supply chain orchestration, military operations plans, legal case management timelines, athletic training programs, manufacturing routing plans, space mission timelines.

**Data characteristics:**
- Plan templates are first-class, versioned entities with graph structure (arms, visits, activities, samples, analyses, results)
- Instances are derived from plans via parametric fills (patient ID, start date, site, schedule computation with windows)
- Execution state lives in a **separate namespace** (typically an event-journal archetype) that references this one
- The plan app owns instantiation and derivation logic; the event app owns execution recording
- Amendments to master plans are versioned; existing instances may freeze at their original version or migrate, per declared policy
- "Where are we against plan?" is the primary cross-namespace query — combining plan (here) with execution (elsewhere)

**Required components:** core + auth-gateway + Dex + Caddy + **PostgreSQL** + **reporting-sync**.

**Optional modules:** `files` (common — signed consent forms, amendment PDFs, protocol documents), `nl-query` (helpful for "which instances are upcoming?").

**Excluded:** ingest-gateway (plans aren't fire-and-forget), events of any kind (see below).

**Consistency contract:** `await=postgres` on writes — same rationale as event-journal. When the coordinator records an amendment, the next query must reflect it. Plan changes are operationally consequential; eventual consistency would confuse users.

**Namespace model:** typically one namespace per trial, project, or campaign. The plan namespace is a **reference source**: other namespaces link into it but never write to it.

**Defaults:**
- `deletion_mode: retain` (amendments, not overwrites; audit trail is load-bearing)
- Terminologies `mutable: false` (master data authoritative)
- **Version pinning on references** — when another namespace references a plan instance, the reference pins to a specific version of the plan. Amendments don't silently invalidate existing event data.
- **Reference-aware delete protection** — the platform or archetype enforces: "if anything in any namespace references this plan or instance, don't hard-delete; require explicit override."
- **`usage: relationship` templates central** — plan→arm, plan→visit, visit→activity, activity→sample, sample→analysis, analysis→result. Each is a typed edge carrying properties (timing windows, conditions, dependencies).
- **Derivation is declarative, not procedural** — the plan template describes how an instance is filled from parameters (patient start date, arm assignment), not Python code.
- State machine states (draft → approved → active → amended → retired) declared explicitly on plan templates.

**Agent guidance summary:**
- **The plan archetype does not contain events.** Time-stamped execution facts ("visit completed at 14:32", "sample taken by Coordinator X") do not belong here. If the user asks to add such templates, push back: *"This looks like execution data. Plan archetype is for planning. Would you like me to scaffold an event-journal namespace that references this plan?"*
- Plan lifecycle states and instance lifecycle states (draft, active, enrolled, withdrawn, completed) are allowed. These describe the plan's own progression, not execution events.
- Master amendments always create a new version; never mutate in place.
- Instance derivation rules are declarative: parameters map to template fills via declared rules, not imperative logic.
- When modeling the plan graph, every node is an entity-with-relationships, not a nested field. Visits, activities, samples are separate documents linked by `usage: relationship` templates.

**The primary consumer is another app, not a human.** Plan namespaces typically ship with a thin admin UI for planners (protocol writers, PIs) but the heavy lifting — daily operational use — happens in a different app reading the plan.

**Similar use case examples:** clinical trial plans, construction project schedules, wedding/event planning, academic curricula with sessions + assignments, aircraft/power plant maintenance schedules, supply chain orchestration plans, military operations plans, legal case management timelines, athletic training periodization, manufacturing BoM + routing, space mission timelines.

**Note on "events" as a line:** within this archetype, "event" means a time-stamped execution fact ("sample was taken at 14:32"). This is distinct from:
- **Lifecycle transitions** on plan/instance documents (draft → approved) — these are plan state, allowed
- **Amendments** to plan templates — these are plan evolution, allowed
- **Instance status** (enrolled, withdrawn, completed) — subject state, allowed

The line is: *"did something execute in the real world?"* If yes, it belongs in a separate namespace.

---

## Comparison Matrix

| | corkboard | authoring | integration | knowledgebase | event-journal | tracker | plan |
|---|---|---|---|---|---|---|---|
| Data origin | User | Single author | External sources | Mixed | Events + master + external refs | Devices/feeds | **Planners (authored)** |
| Direction | — | — | Backward (imported) | — | Backward (past events) | Forward (stream) | **Forward (what should happen)** |
| Write pattern | User-paced | User-paced | Scheduled batch | Mixed | Discrete events | Continuous stream | User-paced (planning) |
| Per-record value | Medium | High | Medium | High | High (each reviewable) | Low (aggregate matters) | **High** (each instance matters) |
| Per-record volume | Low | Low | Medium | Low-medium | Medium | Very high | Low-medium |
| Deletion | Fine | Destruction | Fine (re-import) | Authored = loss; imported = fine | Never (soft-delete only) | Time-based retention | **Never (amendments, not overwrites)** |
| Analytics | None | None | Primary | Optional | For reporting | Primary (dashboards) | Cross-namespace (vs execution) |
| PostgreSQL | No | No | Yes | Optional | Yes, for correctness | Yes, for aggregation | **Yes, for correctness** |
| Ingest-gateway | No | No | Optional (bulk imports) | Rare | Optional (instruments) | Required | **No** |
| Events allowed | — | — | — | — | **Yes, the point** | Yes, as readings | **No, explicit line** |
| Primary consumer | User | Reader | Analytics apps | Humans + agents | Auditors, operations | Dashboards, ML | **Other apps (event-journal)** |
| Namespaces/project | 1 | 1 | 1 | 1 | 1 (or project-scoped) | 1 per tracker | **1 per plan; other apps link in** |
| Apps/namespace | 1 typical | 1 typical | Many (capture+analytics) | Many contributors | Many workflow views | Capture + dashboards | Usually one admin UI |
| Terminology defaults | mutable+extensible | mutable=false | mutable+extensible | mutable+extensible | mutable=false | mutable+extensible | **mutable=false** |
| Consistency contract | eventual | eventual | eventual (batch) | eventual | **await=postgres** | fire-and-forget | **await=postgres** |
| Version history | No | Yes | No | On authored | Everywhere | No | **On plans + instances** |
| Version pinning (refs) | No | No | No | No | No | No | **Yes (other apps pin to plan version)** |
| Reference-aware delete | No | No | No | No | No | No | **Yes** |
| Mapping tables | No | No | Pre-scaffolded | No | For external refs | Common (normalize sources) | Rare |
| Backup prescribed | No | Yes | No | No | Yes + integrity check | Policy-dependent | **Yes + amendment audit** |
| Relationship templates | Rare | Rare | Common | Core | Core | Rare (aggregations) | **Core (plan graph)** |

---

## Modules (Orthogonal to Archetypes)

Some capabilities are archetype-independent — they can be added to (almost) any archetype without fundamentally changing what the archetype is. The deployer treats these as composable modules.

| Module | Adds | Typical archetypes |
|---|---|---|
| `files` | MinIO + frontend upload/download/thumbnails | authoring (common), event-journal (essential), plan (common — consent forms, amendment PDFs), corkboard/integration/knowledgebase (optional) |
| `nl-query` | Anthropic integration + askBar frontend | recommended for most archetypes; agent decides tool mix based on archetype |
| `ingest-gateway` | NATS-based async bulk ingestion | **required for tracker**; optional for integration (high-volume imports) and event-journal (instrument streams); not used by plan |
| `analytics` | PostgreSQL + reporting-sync | **required for integration, event-journal, tracker, plan**; optional for knowledgebase; not used by corkboard/authoring |
| `backup-schedule` | Scheduled backup with retention | **required for authoring, event-journal, plan**; optional for others |

**Design principle:** modules add capability; archetypes define contracts. `ingest-gateway` as a module adds a write path. `tracker` as an archetype *treats* ingest-gateway as the primary write path. Same component, different role.

---

## Cross-Archetype Add-Ons (Opt-In)

Some disciplines span multiple archetypes — "consume a plan from an event-journal," "regulated audit compliance," "multi-site federation." These are not automatic effects of declaring relationships; they are **explicit opt-in add-ons**, peer to modules.

| Layer | Examples | Opt-in? |
|---|---|---|
| Archetype | corkboard, event-journal, plan, etc. | Yes (one per app) |
| Module | `files`, `nl-query`, `ingest-gateway`, `analytics`, `backup-schedule` | Yes (many per app) |
| **Cross-archetype add-on** | `plan-consumer`, `audit-compliance`, `multi-site` | Yes (explicit) |

**Why opt-in, not automatic.** WIP's core value is that *cross-namespace analysis is trivial.* An event-journal app that just reads plan data via normal cross-namespace queries should get **zero extra ceremony**. The `plan-consumer` add-on exists for users who need discipline — version pinning, amendment handling, regulatory-grade references. Default is light; discipline is available on request.

**Add-ons compose modes, not layers.** `event-journal` and `event-journal + plan-consumer` are *different modes* (per DMET) — each fully specified with its own CLAUDE.md, its own hooks, its own push-backs. The user opts into the add-on; they get the full discipline of the resulting mode. No "mostly event-journal but softer for plan reads." Clean boundaries.

**Agent behavior: propose, don't impose.** During `/wip-new-app` or via `/archetype-check`, the agent notices context signals ("you mentioned GxP," "you're linking to a clinical trial plan") and proposes the add-on:

> "This looks regulated — you're consuming a trial plan. There's a `plan-consumer` add-on that pins references, surfaces amendments, and handles audit-grade plan evolution. Want me to add it? If not, you'll get light cross-namespace reads (which is fine for most work)."

Proposal, not imposition. User says "no thanks" → light path. User says "yes" → add-on engaged.

**Concrete add-ons to design (pending):**

- `plan-consumer` — add-on to event-journal (typically) that reads a plan namespace with full discipline
- `audit-compliance` — add-on to event-journal or plan for GxP-adjacent contexts
- `multi-site` — add-on for federated deployments (e.g., one clinical trial across multiple sites)

Only the first is load-bearing today. The others are placeholders for when a real use case forces them.

---

## Agent Constraints

An archetype is only a contract if something enforces it. Without enforcement, an AI agent encountering a missing feature works around it and moves on (Entry 044, five apps worked around broken PostgreSQL sync for 11 days). The archetype system inverts this: the agent's environment is *shaped* so that the off-archetype path is harder than the on-archetype path.

Peter's framing: *"A user should WANT to use the archetype and the process."* The rails make the right thing fastest. Going off-rail is allowed — it's just no longer free.

### Two Principles

**1. Minimum Effective Guardrail (MEG).**

Every guardrail must justify itself on *acceleration* grounds, not just failure-prevention grounds. If the common case slows down, the guardrail is too heavy — cut it or make it opt-in. Prefer proposing discipline over imposing it. Users who feel constrained exit the rails; users who feel accelerated stay on them.

**Concrete test:** building a WIP app with the rails should be *faster* than without. If the rails take 60 minutes and the bypass takes 30, we've built a tax, not an accelerator. The mandatory core of each archetype should be small (one or two things) and obviously load-bearing — users tolerate small mandatory sets when the payoff is clear; they reject large ones.

**2. Discrete Modes, Explicit Transitions (DMET).**

Rails are strict, not fluffy. If a user wants rails, they get rails; if they don't, they exit (via `/wip-exit-rails`). No middle ground. The worst failure mode is soft rules: rails users get a confusing mess of context-dependent exceptions, and non-rail users still bypass. Strict rails + clean exit is better than fuzzy rails for everyone.

This means:

- **Each mode is fully specified.** Corkboard is a mode. Event-journal-draft is a mode. Event-journal-prod is a mode. Event-journal + plan-consumer is a *different* mode. The user knows exactly what rules apply.
- **Transitions are explicit gates.** `/approve-plan` isn't a "discipline gradient increases" — it's a crossing. On one side, one rulebook. On the other, a different rulebook. No soft transitions.
- **CLAUDE.md describes one mode, strictly.** It doesn't have to handle "mostly X, but softer if Y." Content rotates when the mode rotates.

MEG and DMET compose: MEG governs what goes into a mode (minimum effective); DMET governs how modes relate (discrete, explicit). Together they produce rails that feel light *and* are unambiguous.

### State as Field + Version (Not Separate Machinery)

Document state — draft vs published (knowledgebase), draft vs approved (plan), etc. — is captured using primitives WIP already has:

- **Status is a field** on the document (e.g., `plan_status` from a terminology)
- **Transition = new version** of the document with updated status
- **Soft-delete old versions** so they're not consumed
- **Hooks read the field** to gate behavior differently per state

No separate state-machine infrastructure. Audit trail is automatic (version history shows the transitions). Consumers always read the active version. Reverting is just writing a new version with status=draft.

The distinction between metadata states (knowledgebase) and gating states (plan) isn't in how they're stored — it's in what hooks do when they read them. Knowledgebase states affect consumption; plan states affect what operations the agent is allowed to perform.

Transitions for gating states still need ceremony (e.g., `/approve-plan` requires reason + attestation before writing the new version with `plan_status: approved`). The ceremony is the command, not separate infrastructure.

### The Arsenal

Enforcement mechanisms available, ordered by how hard they are to route around:

| Layer | What it does | Agent can skip? |
|---|---|---|
| Platform enforcement (Pydantic, API 422s, schema) | Rejects ill-formed calls at the server | No |
| Hooks (`PreToolUse`, `SessionStart`, etc.) | Shell commands that block tool calls or halt sessions | No |
| MCP tool availability | Tools the agent literally can't call are not an option | No |
| Permission modes | Auto-allow vs prompt per tool | Requires user approval |
| Sub-agents (Task tool, AUDIT-YAC) | Narrow-mandate specialists with teeth | Only if invoked |
| Slash commands | `/wip-status`, `/audit-await`, `/wip-new-app` | Advisory (unless wired into hooks) |
| CLAUDE.md text | Project instructions, always in context | Yes (strong suggestion, not enforcement) |
| Memory files | User prefs across sessions | Yes |
| Setup scripts / gene pool | What a fresh YAC inherits on clone | Yes (but drift is visible) |
| Reports + catch-up | Backward-looking audit trail | Drift is caught later |

**Key split:** only the top three are truly enforceable. CLAUDE.md and memory are strong suggestions a determined agent can route around. The archetype system uses the enforceable layers for anything load-bearing, and uses the softer layers for explanation and context.

### The Three Enforcement Moments

Archetype discipline fires at three distinct moments, each using different arsenal layers:

**1. Selection-time** (agent-mediated dialogue)
When a new app is created, the archetype is chosen. Experienced users declare it directly in `wip-app.yaml`. New users run `/wip-new-app`, which walks a diagnostic and generates the manifest. This is the moment the user sees the bargain before being invested — "you'll get X for free, you give up Y."

**2. Install-time** (deployer-enforced)
`wip-deploy` refuses (or loudly warns) when a `--target dev` install's preset doesn't match the archetypes of the apps present in the repo. Double-checking here — at the moment the environment is created — is cheaper than catching it later.

**3. Session-start** (hook-enforced)
A `SessionStart` hook runs `/wip-status` logic and halts the session if the dev install's preset disagrees with the app's declared archetype. Backstop for when a YAC clones onto an existing install that was configured for a different archetype.

**4. Build-time** (still open)
Inside the preset, constraints remain: a corkboard app whose install mistakenly has ingest-gateway should still not *use* ingest-gateway. `PreToolUse` hooks on specific API endpoints, combined with archetype-specific CLAUDE.md guidance, are the likely shape — to be detailed per archetype.

### Dev vs Run: The Critical Split

Archetype matching means different things depending on deployment intent:

| | Dev | Run |
|---|---|---|
| Match required | **Equality** (preset == archetype) | Superset OK (preset ⊇ archetype) |
| Why | Agent reaches for whatever's available; dev-time drift becomes prod-time surprise | No agent in the loop; extras are harmless |
| Enforcement | Block at install + at session start | None needed |

A corkboard app runs fine in production against a `standard` or `full` install — the extras don't hurt. But a corkboard app *developed* against `standard` is a time bomb: the agent sees PostgreSQL, reaches for it, and the code works in dev and breaks on deploy. This is the specific failure mode archetype enforcement prevents.

Corollary: there is no "full dev" install for a single-archetype app. A multi-app dev install has a preset equal to the *union* of its apps' archetypes, computed by the deployer — the user doesn't hand-pick "full" out of convenience.

### `/wip-status` — The Canonical Query

The primitive that makes the above observable. Humans run it; agents run it on first WIP-affecting action; hooks call the same underlying logic for enforcement.

```
/wip-status

Install
  Target:       dev
  Preset:       corkboard
  Host:         localhost:8080
  Deployer:     wip-deploy 2.0.3

Archetype capability
  Allowed:      mongo, minio, nl-query
  Forbidden:    postgres, analytics, ingest-gateway

Running services
  ✓ wip-api, mongo, caddy, dex
  ✗ postgres, reporting-sync, analytics  (not in preset — correct)

Apps known here
  - shopping-list  (archetype: corkboard)  ✓ matches preset
  - recipes        (archetype: corkboard)  ✓ matches preset

Status: OK — dev install matches app archetypes.
```

**Where it lives:** the CLI lives in `wip-deploy` (it owns the deployment spec model). Each app's setup script installs a thin `/wip-status` slash command that wraps it. One source of truth, many entry points.

### `/wip-new-app` — The Selection Flow

Archetype selection is itself an agent-mediated constraint. Experienced users skip the flow; new users get walked through it. Six phases:

1. **Detect experience level** — one question; experienced user shortcuts to Phase 4.
2. **Capture the use case in the user's own words** — one sentence saved literally as `purpose:` in `wip-app.yaml`. Future agents read this to sanity-check their work against declared intent. (Without it, later "why am I building this?" has no ground truth.)
3. **Entry question** — "What is the thing you're storing?" with seven options mapping to archetypes.
4. **Disambiguators** — 0–2 follow-ups, rule-based for the common forks (plan vs event-journal's "if you delete execution records, do you still have value?"; tracker vs event-journal's "individual readings or aggregates?"; integration vs knowledgebase's "humans or other apps read this?"). Judgment for edge cases.
5. **Module opt-ins** — files, nl-query, backup-schedule, etc. Defaults per archetype pre-check the reasonable boxes.
6. **The bargain, explicit** — "You get X for free, you give up Y, migration cost if you change your mind: <cost>. Proceed?"

On confirmation: scaffolds `apps/<name>/`, writes `wip-app.yaml`, generates a CLAUDE.md from a template keyed on the archetype, prints the matching `wip-deploy install` command as the next step.

**Where it lives:** in WIP core (since the questions and archetype list are WIP-level, not app-level). The app's scaffolded CLAUDE.md carries the archetype-specific guidance into the build-time agent's context on turn one.

### What the Agent's CLAUDE.md Gets

Per-archetype CLAUDE.md (generated from template) should include at minimum:
- The declared archetype and its contract (one paragraph)
- The "forbidden" list in plain language (what not to reach for)
- The consistency contract and its implications
- Archetype-specific slash commands (`/audit-await` for event-journal, etc.)
- Push-back scripts for the predictable off-archetype requests ("user asked for analytics in a corkboard — propose integration archetype instead")

The per-archetype push-back scripts are the piece still to be authored. They live in the template, not generated dynamically — predictable constraints deserve predictable phrasing.

### Leaving the Rails

The rails are only respected if they have an honest off-ramp. Without one, they become a cage; with one, they become a choice. When the scope has shifted far enough that the archetype no longer fits, the agent should recognize it and offer the user an exit — not as a concession, but as a first-class path.

**What exit is:** leaving *archetype* discipline. Not leaving WIP conventions — the agent still respects bulk-first writes, identity-based dedup, pagination defaults, and the other PoNIFs. It just stops enforcing a specific archetype's shape and push-back scripts.

**Three paths when scope shifts, in order of disruption:**

1. **Module add.** "I need `files` now." Doesn't change archetype. Extend the preset. No restructuring.

2. **Namespace split.** "I want analytics on my shopping data." Often the right answer isn't migrating the corkboard — it's adding a sibling integration namespace that references it. The same pattern plan + event-journal formalized: when scope shifts, **split, not bloat.** The agent should propose the split as the first option, not the last.

3. **Archetype migration or exit.**
   - **Migrate** via `/wip-pick-archetype` — re-run the selection diagnostic against current code, move to a new archetype, accept the migration cost (additive upward, lossy downward, incompatible for some pairs like tracker → anything).
   - **Exit** via `/wip-exit-rails` — set `archetype: none`, disable archetype-specific hooks, swap archetype CLAUDE.md for a generic WIP-aware one, log the decision with reason. Mirror command `/wip-pick-archetype` rejoins the rails later if the project stabilizes.

**The agent's self-awareness requirement** — the most important line of this whole design:

> If you find yourself pushing back on five archetype-off-pattern requests in a row, that's a signal to *offer the exit*, not dig in. Enforcement without self-awareness becomes friction. The archetype is a starting point, not a prison.

**Sample agent speech** (to go in the CLAUDE.md template):

```
I'm currently configured for the `corkboard` archetype. Over the last
few sessions the scope has shifted — [specific evidence].

This may no longer be a corkboard app. Three paths:
  1. Migrate the archetype (/wip-pick-archetype)
  2. Split: keep corkboard + add a sibling integration namespace
  3. Exit the archetype rails (/wip-exit-rails) — generic WIP agent,
     no archetype push-back, core conventions still respected.

Which path?
```

**Where exit sits in the arsenal:** a promoted override. The session-start hook's override is for "work around this today." Exit is "the archetype no longer fits, stop asking." Same mechanic — explicit user decision with a logged reason — but permanent rather than session-scoped. Both are visible in `/catch-up` so drift is never silent.

### Per-Archetype Build-Time Sketches

Five archetypes sketched in detail through the MEG lens. Each sketch identifies the mandatory load-bearing set (small), the push-backs (CLAUDE.md text, proposal not imposition), and the archetype-specific slash commands. Authoring and integration follow the same pattern; they're deferred until scaffolded.

#### Corkboard

**The enforcement reality:** most of corkboard's "forbidden" is already handled at install time (no PostgreSQL container means no PostgreSQL calls — the platform physically prevents it). What's left *inside* the preset is mostly anti-over-engineering.

**Mandatory (truly load-bearing): none.** Corkboard's guardrails are all soft. That's appropriate — it's a loose archetype for personal stuff.

**Agent failure modes (soft push-backs):**
- Over-structuring — creating `usage: relationship` templates when flat docs would do
- Adding `version_history: true` reflexively (default is false for corkboard)
- Freezing terminologies with `mutable: false` (default is mutable + extensible)
- Backup ceremony when none was asked for
- Missing nl-query wiring (the archetype's killer feature — underdelivers without it)
- Multi-user/RBAC scaffolding (corkboard is single-user or small trusted group)

**Push-back scripts (CLAUDE.md template):**
- "Analytics dashboards" → "Corkboard has no PostgreSQL. This sounds like integration. Want me to propose that archetype?"
- "Audit trail" → "Corkboard trades audit for simplicity. If you need audit, consider authoring or event-journal."
- "Multi-tenant permissions" → "Corkboard is single-user or small trusted group. Real multi-tenancy wants a different archetype."
- "Track history of edits" → "Default is no version history. Are you sure? If yes, this is authoring-shaped."

**Archetype-specific slash commands:**
- `/archetype-check` — reports corkboard conventions: any templates with `version_history: true`? any terminologies with `mutable: false`? any backup schedule configured? All unusual for corkboard.

**One candidate mild hook:** `PreToolUse` on template creation that injects a warning into the agent's context (not blocking) when the payload has `version_history: true`. Drift visible in logs; agent free to proceed with reason.

---

#### Event-Journal

**The sharpest archetype for enforceable contracts.** Read-your-writes is the archetype's promise; losing it is a data-integrity failure that breaks users' trust. The mandatory set is small but bright-line.

**Mandatory (load-bearing):**
- `await=postgres` on writes — block + user override with reason documented in code. This is the canonical event-journal contract. Override pattern: inline comment directive `// @wip-override: no-await reason="..."`. Hook on POST /documents checks for the directive; blocks if missing both.
- Hard delete never allowed — hook blocks DELETE endpoints in an event-journal namespace. Push-back: "Void-with-reason is the pattern."
- `version_history: true` on templates — hook rejects creation with explicit `false`.
- Terminology `mutable: false` by default — hook rejects creation with `mutable: true` (unless override with reason).

**Push-back scripts (CLAUDE.md template):**
- "Hard delete this record" → "Event-journal requires soft delete for audit compliance. Void-with-reason is the pattern."
- "Free text instrument/reagent name" → "Master data discipline: use the LOV. Want me to scaffold it?"
- "Skip await on this endpoint" → "Read-your-writes IS the archetype. Omitting it means users write and the next query doesn't see it. Are you certain? If yes, document reason inline."
- "Disable version history on this template" → "Event-journal versions everything. Regulatory review flags missing versions. Sure?"

**Archetype-specific slash commands:**
- `/audit-await` — scans codebase for `POST /documents` calls without `await=postgres` or an inline override directive. **Report only, no auto-fix** (no code change without review). Run before every PR, after write-path changes.
- `/archetype-check` — broader audit: every template has `version_history: true`? every terminology `mutable: false`? master-data LOVs exist for common fields?

**Dev vs prod data posture (cross-archetype principle applied):**
- Dev: data is scaffolding; drop + reseed is fine.
- Prod: data is permanent; schema changes = new template version + migration plan + backup verified + rollback plan. Agent must push back on "let's reseed" when target is prod.

---

#### Tracker

**The archetype where MCP tool availability carries the most weight.** The ingest-gateway is not just recommended — it is *the* write path. Direct document-store writes defeat the archetype. Strongest form of enforcement: don't give the agent the wrong tools.

**Mandatory (load-bearing):**
- Write path is ingest-gateway only — enforced by MCP tool availability. Tracker agents get `wip.ingest_reading`; they do *not* get `wip.create_document` for reading templates.
- `await=postgres` is *forbidden* on tracker writes (inverse of event-journal) — hook blocks; CLAUDE.md makes it bright-line.
- Every reading template has an indexed `timestamp` field — hook checks at template creation.
- `version_history: false` — versions are meaningless for readings; hook rejects if explicitly enabled.
- Retention policy configured at install — deployer warns if missing.

**Push-back scripts (CLAUDE.md template):**
- "Show me the reading from last March at 14:32" → "Tracker isn't optimized for individual records. Do you want an aggregation over that window instead?"
- "Edit this reading" → "Readings are immutable — each is its own record. If a device reported a wrong value, the pattern is a correction aggregation, not editing the raw record."
- "Delete readings from faulty device X" → "Tracker retention is time-based. Invalid readings → retroactive correction pass. Unwanted readings → filter from aggregations."
- "Add version history" → "Readings aren't versioned. Did you mean an aggregation template?"
- "Record-level audit trail" → "That's event-journal. Tracker observations aren't audit events."

**Archetype-specific slash commands:**
- `/archetype-check` — timestamp fields indexed? aggregation templates exist alongside raw templates? retention configured and active?

**MCP tool subsetting (implementation):** short-term, `.claude/settings.json` `permissions.deny` list written by setup script. Long-term, MCP server archetype-aware.

---

#### Plan

**The most nuanced archetype.** Forward-looking, reference-source, two internal modes (draft + prod), consumed by other apps. The mandatory set reflects both the archetype's own contract *and* the lifecycle gating.

**Mandatory (load-bearing):**
- Events forbidden — no template with `completed_at`, `actual_*`, `signed_by`, or similar execution-fact fields. Hook heuristic on template creation + CLAUDE.md push-back. *"This belongs in an event-journal that references this plan."*
- Amendments, not overwrites — once `plan_status: approved`, hook rejects direct template updates. `/amend` creates a new version with `plan_status: draft`, linked to the previous version.
- Hard delete never allowed — hook blocks DELETE in plan namespaces.
- `await=postgres` on writes (same rationale as event-journal).

**State as field + version (per DMET):**
- `plan_status` is a terminology field with LOV: `draft | under_review | approved | active | amended | retired`
- Transitions write a new version; old version soft-deleted
- Hooks read `plan_status` and gate mutations accordingly

**Behavior flips by state:**

| State | Mutability | Delete | Instances | Consumer refs |
|---|---|---|---|---|
| draft | Full CRUD | OK | Test/throwaway | Not allowed |
| under_review | Mutable, tracked | Soft only | Not allowed | Not allowed |
| approved / active / amended | Immutable; `/amend` only | No | Real instances | Pinned |
| retired | Read-only | No | No new | Discouraged |

**Push-back scripts (CLAUDE.md template):**
- "Record visit X was completed at 14:32 for patient Y" → "Plan archetype doesn't hold execution data. Scaffold an event-journal namespace that references this plan."
- "Change this visit window from 14 to 21 days" (on approved plan) → "Plan is approved. `/amend` creates a new version. Your consumers will decide whether to pin or migrate."
- "Delete this old plan" → "Plan never hard-deletes. Retire it with `/retire-plan` if no active instances; amendments are preserved for audit."

**Archetype-specific slash commands:**
- `/plan-state` — reports current status of plan templates (and instances by state). Agent runs before any plan-modifying action.
- `/approve-plan <name>` — transition gate. Requires reason, reviewer attestation, signature. Writes new version with `plan_status: approved`. Notifies downstream consumers.
- `/amend <plan-name> <reason>` — creates a new version in `draft`, linked as amendment of the current version.
- `/retire-plan <name>` — permanent transition; requires no active instances or explicit migration.

**Cross-archetype dimension:** consumers of a plan (typically event-journal apps) may opt into the `plan-consumer` add-on, which imposes version-pinning + amendment-handling discipline. Without the add-on, consumers read the plan as normal cross-namespace data (light path).

---

#### Knowledgebase

**The archetype where graph structure is the whole point.** Isolated documents defeat the archetype; typed relationships make it valuable.

**Mandatory (load-bearing):**
- Origin metadata on every document — `authored_by: peter | yac-X | imported-from-Y`. Template schema requires the field.
- Relationships as first-class `usage: relationship` templates (typed edges: `see_also`, `supersedes`, `contradicts`, `realizes`, `impacts`, `learned_from`). Not hidden `related_to: [id]` arrays.
- Soft-delete on authored content (`deletion_mode: retain`); hard-delete OK on imported (`deletion_mode: full`).

**Sharp guardrail:** any new authored document should declare at least one outgoing relationship OR be explicitly flagged `root: true`. `/archetype-check` reports root-less orphan docs. Not blocking, but a signal — orphan accumulation is the archetype's main degradation mode.

**State via field + version (light pattern):** individual documents may have a `doc_status` field with LOV: `draft | reviewed | published | archived`. Transition = new version. Knowledgebase has no namespace-level state (no "approve the whole KB"); knowledge evolves continuously. Metadata only; no gating hooks flip behavior.

**Push-back scripts (CLAUDE.md template):**
- "Track when I last viewed this" → "That's an event-journal pattern. Knowledgebase holds knowledge, not access logs. Want a separate namespace?"
- "Folder structure for organization" → "Knowledgebase uses tags + relationships, not hierarchy. The graph does what folders try to do, with more flexibility."
- "Delete old notes for cleanup" → "Knowledgebase retains. Archive (`doc_status: archived`) if truly obsolete."
- Flat list accumulating → "Isolated docs don't leverage the archetype. Want me to propose typed relationships from patterns I see?"

**Archetype-specific slash commands:**
- `/archetype-check` — orphan docs? (warn); relationship templates defined? (check); nl-query wired? (check); typed-edge usage across docs? (report).

**WIP-as-its-own-knowledgebase (dogfood):** the templates write themselves — `DESIGN_DECISION`, `ARCHITECTURAL_PATTERN`, `LESSON`, `CASE_RECORD`, `JOURNEY_ENTRY`, `FIRESIDE`, `AGENT_IDENTITY`, `GLOSSARY_ENTRY`, plus relationships `IMPACTS`, `REALIZES`, `LEARNED_FROM`, `DECIDED_BY`, `SUPERSEDES`. This archetypes doc becomes a `DESIGN_DECISION`, linked via `IMPACTS` to the seeds doc and via `REALIZES` to the wip-deploy v2 work. Walking the graph from "why do we have archetypes?" through the reasoning chain is the value demo.

---

#### Authoring, Integration (deferred)

Both follow the same sketch structure (mandatory set, push-backs, slash commands, state-via-field). They're deferred until scaffolded — per "don't finish all seven before shipping any."

### Still Open

- **Authoring and integration sketches** — same pattern as the five above; deferred until first scaffolded use
- **Cross-archetype add-on definitions** — `plan-consumer` is the one load-bearing today; the others (`audit-compliance`, `multi-site`) are placeholders
- **Override mechanism details** — inline comment directive syntax (leaning `// @wip-override: <name> reason="..."`), where drift log lives, `/catch-up` surfacing
- **Install manifest format** — file path (leading candidate: `~/.wip/current-install.json`), JSON schema, whether served by running WIP or read from disk
- **Multi-app repos** — deployer computes preset as union of app archetypes; conflict surfacing
- **MCP tool subsetting** — short-term via `.claude/settings.json` deny-list from setup script; long-term server-aware

---

## Open Questions

1. **How does the archetype travel with the codebase?** Options: CLAUDE.md section, dedicated `wip-archetype.yaml` manifest, compose chunk label. Leading candidate: dedicated manifest + CLAUDE.md summary, both scaffolded by `create-app-project.sh`. The manifest is the source of truth; CLAUDE.md is a summary for agents that read text before structured files.

2. **Can an archetype be changed after deployment?** Some changes are compatible (corkboard → authoring mostly works); others are not (integration → corkboard loses PostgreSQL, would break existing analytics apps). Archetype evolution is a v2.1 concern. Even harder: tracker → anything. Retention policies and dropped version history mean tracker data can't safely migrate to event-journal.

3. **Sub-modes within archetypes?** E.g., `integration.multi-vendor` for the "same template schema, different data vendors" scenario that breaks the single-namespace default. Probably yes, but as composable flags rather than new archetypes.

4. **Frontend feature unlocking.** When a module is added post-install (e.g., `files` added to a corkboard), how does the frontend app learn to expose the feature? Options: feature flags in the app config, the frontend reads module state from the deployment manifest at build time, or the frontend queries WIP at runtime for available capabilities. This matters for all archetypes but is most acute for corkboard/authoring where modules are commonly added later.

5. **How many archetypes is the right number?** We have 7. The seeds doc's original guidance was 3-4 core + optional modules. 7 is above that, but each earned its place:
   - corkboard, authoring: distinguished by deletion semantics and versioning
   - integration: distinguished by multi-source and mapping tables
   - knowledgebase, event-journal: distinguished by consistency contract (`await=postgres`) and role (reference vs workflow)
   - tracker: distinguished by continuous-write pattern and fire-and-forget contract
   - plan: distinguished by forward-looking direction, instance derivation, and "consumed by other apps" role

   If one feels redundant after real use, it collapses into a composition of others. The most suspect pair remains `knowledgebase` and `event-journal` — if read-your-writes becomes a per-write flag rather than an archetype default, they could collapse. `plan` is new enough that it hasn't been stress-tested yet; watch for whether plan + event-journal in two namespaces feels more natural than one combined archetype in real use.

6. **Version pinning in references (platform feature for `plan`).** Today a `reference` field resolves to a document, typically "current version." The plan archetype needs references that can pin to a specific version — so that amendments to a master plan don't silently invalidate event data in another namespace that was written against the previous version. This is a platform capability gap, not an archetype convention. Small scope: a `version` field on reference, honored by the resolver.

7. **Reference-aware destructive operation guards (platform feature for `plan`).** Today a document can be deactivated or hard-deleted regardless of what refers to it. The plan archetype wants "can't delete what's actively referenced" — ideally enforced by the platform via a Registry query ("is anything pointing at this?"). The archetype could enforce this in the admin UI, but platform-level enforcement is stronger. Scope: a pre-delete check that consults reference indices.

8. **The reference source pattern.** Plan is the first archetype whose primary consumers are other namespaces' apps, not humans or analytics. Knowledgebase has family resemblance but its primary consumers are humans/agents reading directly. A shared platform feature — "this namespace is a stable reference source; other namespaces may link here" — might serve both. Open whether to name and formalize this.

9. **Authoring and integration build-time sketches.** Five of seven sketched in detail; authoring + integration follow the same pattern and are deferred until first scaffolded use. Avoid designing the full matrix before shipping any of it (agent capabilities evolve faster than our design cycle — see the 3-month / 3-Opus-majors / 110k→1M context progression).

10. **Cross-archetype add-on design.** `plan-consumer` is the one load-bearing today. `audit-compliance` and `multi-site` are placeholders until a real use forces them. The pattern from the Cross-Archetype Add-Ons section stays skeletal until first instantiation.

---

## Next Steps

1. **Ship the foundation fast** — the primitives that unlock iteration on per-archetype rules in real use:
   - Install-manifest emission from `wip-deploy`
   - `/wip-status` (CLI in wip-deploy + slash wrapper)
   - SessionStart hook + archetype match check
   - `/wip-new-app` 6-phase flow

2. **Start with the WIP-as-its-own-knowledgebase dogfood.** Highest-signal test of the archetype design on a real use case where graph traversal matters. Informs the others.

3. **Per-archetype build-time enforcement**, scaffolded when actually needed — not designed exhaustively up front. Use MEG lens to keep mandatory sets small.

4. When v2 implementation begins (post-Apr 23 presentation), fold this into the deployer's preset system and the `create-app-project.sh` scaffolding.

**Bet:** the architecture (archetypes, modes, add-ons, exit path, install-match, state-as-field+version) will survive agent-capability evolution. Specific guardrail implementations probably won't — hooks that feel load-bearing today may become belt-and-suspenders as agents improve at internalizing CLAUDE.md. Design the first thoroughly, the second lightly.
