# KB v1 Data Model — DESIGN.md

**Status:** Session 1 draft, 2026-05-01. APP-KB-YAC's proposal for Peter's review.
**Authority:** `papers/v2-kb-app-requirements.md` (the spec) wins on conflict with anything else, including this doc.
**Persistence:** Nothing in this doc has been written to `dev-kb` yet. Once Peter approves, APP-KB-YAC creates it via MCP in `dev-kb`, iterates, then BootstrapGate replays it into `kb` at runtime on user-confirmed bootstrap.

---

## 0. How to Read This

This is the v1 draft of:
- 3 terminologies (KB-local LOVs)
- 9 templates (7 entity + 1 reference + 1 audit-structured)
- 10 edge types (relationship templates)
- The `BOOTSTRAP_RECORD` provenance shape
- A proposed AGENT_IDENTITY seed list

Per CLAUDE.md "bias minimal — start with title/body/origin, add fields when use reveals the need." JIRA-creep risk explicitly avoided.

Choice points where I made a judgment call you might want to overrule are marked **[CALL]** inline. Open questions for FRanC are collected in §9.

---

## 1. Conventions in This Doc

| Concept | Convention |
|---|---|
| Field requiredness | `mandatory: true` (per WIP API; not "required") |
| Term reference field | `reference_type: term`, `terminology_ref: <terminology_value>` |
| Doc reference field | `reference_type: document`, `template_ref: <template_value>` (or omitted = any template) |
| Edge templates | `usage: relationship`, `versioned: false` (PoNIF #8), mandatory `source_ref` + `target_ref` |
| Reference templates | `usage: reference` (LOV) |
| Entity templates | `usage: entity` (default — full lifecycle, versioned: true by default) |
| FTS flag | `full_text_indexed: true` requires `sync_enabled: true` (422 otherwise per FTS fireside) |
| Common audit fields | `created_at`, `updated_at`, `version` are platform-managed — not declared in templates |

All template values are SCREAMING_SNAKE_CASE. All field names are `lower_snake_case`. All terminology values are SCREAMING_SNAKE_CASE.

---

## 2. Identity-Field Philosophy

Per `wip://ponifs` #3 and CLAUDE.md: identity hash answers **"is this the same real-world thing?"** — never timestamps, run IDs, or per-execution data. Identity hash is **scoped per template**, so the same value under two different templates is two different documents (per CLAUDE.md identity-vs-canonical-ID note).

Identity choices below balance two failure modes:
- **Too few identity fields** → unrelated entities collide into one document on update.
- **Too many** → corrections create duplicate documents instead of new versions.
- **Zero (append-only)** → every submission is a new doc. Right when there is no natural "same real-world thing" key.

---

## 3. Terminologies (2)

> **Resolved 2026-05-05:** Q17 dropped `KB_AGENT_KIND` from v1. AGENT_IDENTITY launches with `agent_value` + `title` + `description` only. The 3-value LOV (human/yac/system) didn't unlock anything in v1; add later if filtering needs reveal.

All KB-local; live in the `kb` namespace. Per archetype default: `mutable: true, extensible: true` (knowledge grows).

### 3.1 `KB_DOC_STATUS`

Document lifecycle states. Used by every entity template's `doc_status` field.

| value | label |
|---|---|
| `draft` | Draft |
| `reviewed` | Reviewed |
| `published` | Published |
| `deprecated` | Deprecated |
| `archived` | Archived |

(Verbatim from kb-ux paper §"Doc Types (v1)".)

**[CALL]** v1 reuses `KB_DOC_STATUS` for FLAG_RECORD too. Spec §15.6 leaves this open. If FLAG_RECORD wants a flag-specific lifecycle (`open / acknowledged / resolved / dismissed`), define `KB_FLAG_STATUS` separately. Defer pending Peter's input.

### 3.2 `KB_TARGET_YAC`

Dropdown values for "Flag for YAC" modal target. Mutable+extensible per archetype default.

| value | label |
|---|---|
| `USER1` | Peter |
| `BE-YAC` | BE-YAC |
| `APP-RC` | APP-RC |
| `APP-CT` | APP-CT |
| `APP-KB` | APP-KB-YAC |
| `BUG-YAC` | BUG-YAC |
| `FRanC` | FRanC |
| `any` | Any (no specific target) |

**Resolved 2026-05-05 (Q15):** the human owner is `USER1` (not `peter`) so the LOV is multi-user-future-proof. Display label stays "Peter" — UI shows readable name, data layer is multi-user-ready. Future deploys assign their own USER1 (single-tenant per WIP-KB instance) or use USER1/USER2/... when multi-user mechanics ship in v1.5+.

---

## 4. Common Entity-Template Fields

All seven `usage: entity` templates declare these unless explicitly noted otherwise. Field-by-field rationale below.

| Field | Type | Mandatory | FTS | Versioned | Notes |
|---|---|---|---|---|---|
| `title` | string | yes | `true` (weight A) | yes | Doc title; the prepared-prompt buttons inject this verbatim |
| `body` | string | yes (except structured-only types) | `true` (weight B) | yes | Markdown body; rendered in the doc view |
| `authored_by` | string | yes | no | yes | Free string per kb-ux §"Doc Types (v1)": `peter \| yac-<session-id> \| imported` |
| `doc_status` | term ref → `KB_DOC_STATUS` | yes (default `draft`) | no | yes | Visible read-only in UI; transitions via YAC slash commands |
| `tags` | array<string> | no | no | yes | Used by lessons browser tag cloud + topic-page aggregation |
| `root` | boolean | no (default `false`) | no | yes | True = intentional orphan; suppresses orphan marker in UI |

**Why no separate `origin` term ref:** the archetype's "origin metadata" guidance (peter/yac/import) is already captured by `authored_by` strings prefixed with `yac-` or set to `imported`. Adding a parallel `origin` term ref would duplicate state. **[CALL]** to flag.

**Why `tags` on every entity template, not just LESSON:** the topic page aggregates by "keyword + tag match" across types (kb-ux Open Q3 + spec §7.3). Universal tags is the smaller-blast-radius default; we can drop it from templates that don't end up using it.

**Why `authored_by` is a string, not a reference to AGENT_IDENTITY:** v1 keeps it simple. The `AGENT_PARTICIPATED` relationship surfaces typed-agent linkage when richer queries are needed. Spec §5 calls `authored_by` a common WIP field, not a reference. **[CALL]** if Peter wants to upgrade this to a typed reference, easy switch.

**Why no `source` field per archetype default ("source: <ref>"):** the KB starts empty, no migration in v1 (spec §4 "Parked"). When import becomes real (v2 migration tooling), add `source` then. Doesn't affect what's persisted v1.

**Platform-managed fields not declared:** `created_at`, `updated_at`, `version` — provided by WIP automatically.

---

## 5. Templates (9)

Each section: `usage`, identity_fields, custom fields, FTS flags, rationale.

### 5.1 `CASE_RECORD` — entity

Cross-agent cases filed by YACs. v1 ships KB-native (no migration of `yac-discussions/CASE-*.md`, per spec §4).

| Aspect | Value |
|---|---|
| `usage` | `entity` |
| `versioned` | `true` (default) |
| `identity_fields` | **zero** (append-only) |
| Custom fields | `source_yac` (string, optional, FTS off) — which YAC filed it |
|  | `target_yac` (term ref → `KB_TARGET_YAC`, optional) — who should look |
| Common fields | title, body, authored_by, doc_status, tags, root |
| FTS | title (A), body (B) |

**Identity rationale:** filing the same case twice is unusual; when it happens, two records is more honest than silent merge. Each `/case file` invocation = one new doc.

**Resolved 2026-05-05 (Q5):** KB-CASE_RECORD is a knowledge artifact (write-once breadcrumb), not a live work tracker. The `yac-discussions/` filesystem stays the live medium for in-flight cases with their status changes and rename cycles. KB-CASE_RECORD captures "this case existed and what it was about"; CASE evolution (responses, comments, status flips) is not modeled here in v1.

**Spec §15.5 note (resolved):** Held at `source_yac` + `target_yac`. `severity`, `assignee`, `priority`, `status_machine` rejected per Q5. Same JIRA-creep argument as Q4.

### 5.2 `DESIGN_DECISION` — entity

Architectural decisions (the archetypes paper itself, the FTS fireside, etc.).

| Aspect | Value |
|---|---|
| `usage` | `entity` |
| `versioned` | `true` |
| `identity_fields` | `[title]` |
| Custom fields | (none beyond common) |
| Common fields | title, body, authored_by, doc_status, tags, root |
| FTS | title (A), body (B) |

**Identity rationale:** decisions have unique titles by convention ("v2-archetypes", "v2 KB UX kick-off"). Re-filing under the same title = update.

### 5.3 `LESSON` — entity

`lessons.md` entries + ongoing captures via `/lesson` slash command.

| Aspect | Value |
|---|---|
| `usage` | `entity` |
| `versioned` | `true` |
| `identity_fields` | `[title]` |
| Custom fields | (none beyond common) |
| Common fields | title, body, authored_by, doc_status, tags, root |
| FTS | title (A), body (B) |

**Identity rationale:** lessons get refined ("Lesson: don't bypass the API"). Same title = update.

### 5.4 `FIRESIDE` — entity

Design-chat transcripts. The current paper (`fts-architecture-fireside.md`) becomes one of these.

| Aspect | Value |
|---|---|
| `usage` | `entity` |
| `versioned` | `true` |
| `identity_fields` | `[title]` |
| Custom fields | `topic` (string, optional, FTS A) — short concept marker for topic-page aggregation |
|  | `chat_date` (date, optional) — when the chat happened (separate from `created_at` which is when it was persisted) |
| Common fields | title, body, authored_by, doc_status, tags, root |
| FTS | title (A), topic (A), body (B) |

**Identity rationale:** firesides have unique titles; resaving an edited transcript = update.

### 5.5 `JOURNEY_ENTRY` — entity

Day journals. Persisted by FRanC via `/kb-persist journey`.

| Aspect | Value |
|---|---|
| `usage` | `entity` |
| `versioned` | `true` |
| `identity_fields` | `[journey_date]` |
| Custom fields | `journey_date` (date, mandatory) — the day it covers |
| Common fields | title, body, authored_by, doc_status, tags, root |
| FTS | title (A), body (B) |

**Identity rationale:** one journal per day. Day collisions on resave = update. (`title` would be wrong: titles iterate as the day's narrative develops.)

### 5.6 `GIT_STATS_SNAPSHOT` — entity, structured-only (no body)

Per spec §5: "structured-only" rendering. Per kb-ux Open Q4: per-day default.

| Aspect | Value |
|---|---|
| `usage` | `entity` |
| `versioned` | `true` |
| `identity_fields` | `[snapshot_date, repo]` |
| Custom fields | `snapshot_date` (date, mandatory) |
|  | `repo` (string, mandatory) — e.g., `World-in-a-Pie`, `WIP-KB` |
|  | `commits` (integer) |
|  | `lines_added` (integer) |
|  | `lines_removed` (integer) |
|  | `files_changed` (integer) |
|  | `contributors` (integer, optional) |
| Common fields | title, authored_by, doc_status, tags, root — **no body** |
| FTS | title (A) only |

**Identity rationale:** one snapshot per (day, repo). Re-running `/stats` for the same day overwrites.

**Why no body:** "structured-only" per spec §5. Title still useful (e.g., "WIP-KB stats 2026-05-01").

### 5.7 `AGENT_IDENTITY` — reference

YAC personas (FRanC, BE-YAC, APP-RC, etc.). `usage: reference` = LOV record (spec §5).

| Aspect | Value |
|---|---|
| `usage` | `reference` |
| `versioned` | `true` |
| `identity_fields` | `[agent_value]` |
| Custom fields | `agent_value` (string, mandatory) — canonical name, e.g., `BE-YAC` |
|  | `description` (string, optional, FTS B) — what this agent does |
| Common fields | title (= agent display name), authored_by, doc_status, tags, root — **no body** |
| FTS | title (A), description (B) |

**Resolved 2026-05-05 (Q17):** `kind` field dropped. AGENT_IDENTITY launches with `agent_value` + `title` (display name) + `description`. The `human` vs `yac` distinction is implicit in the name pattern (`USER1`, `USER2` look unmistakably different from `BE-YAC`, `FRanC`, `APP-KB`).

**Identity rationale:** one record per canonical agent name. `agent_value: "BE-YAC"` is the dedup key.

**Bootstrap-seeded (per spec §5 "Bootstrap-seeded for known YACs"):**

| agent_value | title (display) | description |
|---|---|---|
| `USER1` | Peter | The human owner — reader, flagger, decider |
| `FRanC` | FRanC | Field Reporter — captures sessions, synthesizes, owns design papers |
| `BE-YAC` | BE-YAC | Backend YAC — owns WIP platform |
| `APP-RC` | APP-RC | React Console YAC |
| `APP-CT` | APP-CT | Clinical Trials app YAC |
| `APP-KB` | APP-KB-YAC | KB app YAC (this app's authoring agent) |
| `BUG-YAC` | BUG-YAC | Bug-hunting YAC |
| `DOC-YAC` | DOC-YAC | Documentation auditor YAC |

**Resolved 2026-05-05 (Q15):** the human owner's `agent_value` is `USER1` (not `peter`). Display title stays "Peter" — UI shows readable name, data layer is multi-user-ready. Future deploys assign their own `USER1` per WIP-KB instance. Bootstrap seeds these eight as initial AGENT_IDENTITY records. New YACs add themselves on first `/kb-persist`.

### 5.8 `FLAG_RECORD` — entity

The single UI write surface. Created on flag-for-YAC modal confirm (spec §9.1).

| Aspect | Value |
|---|---|
| `usage` | `entity` |
| `versioned` | `true` |
| `identity_fields` | **zero** (append-only — every flag is its own event) |
| Custom fields | `target_yac` (term ref → `KB_TARGET_YAC`, mandatory) |
| Common fields | title, body, authored_by, doc_status (defaults to `published` — see below), tags, root |
| FTS | title (A), body (B) |

**Identity rationale:** zero identity. Re-flagging the same source doc to the same YAC = a new flag (not "update the previous"). Matches "every flag is a fresh dispatch event" semantics in spec §9.

**Required validations** (per spec §9.1, enforced in UI before submit):
- `body` not empty
- `target_yac` ∈ `KB_TARGET_YAC` active values
- Source doc exists at write time
- One `FLAGGED_FROM` relationship written atomically with the FLAG_RECORD (mandatory; NOT optional)

**Title generation:** UI auto-derives title as `Flag for <target_yac>: <first 60 chars of body>` if user didn't type one. Stored as a real string field; user can override in the modal.

**Resolved 2026-05-05 (Q14):** auto-derive with override. Friction reduction matters for the "flag and move on" pattern; required title would slow every flag and produce throw-away titles when users hurry.

**Resolved 2026-05-05 (Q4):** held at minimum (`target_yac` + `body` + `title`). No `priority`, no `acknowledged_at`. JIRA-creep risk.

**Resolved 2026-05-05 (Q6):** `doc_status` defaults to **`published`** (not `draft` from common-field default). Flags are dispatched events, not drafts. Inheriting `draft` was misleading — same pattern as BOOTSTRAP_RECORD overrides to `published` in §5.9. Reuses `KB_DOC_STATUS`; no new terminology in v1. If flag-handling-via-`/kb` patterns reveal their own lifecycle in v2, define `KB_FLAG_STATUS` (`open | acknowledged | resolved | dismissed`) then.

### 5.9 `BOOTSTRAP_RECORD` — entity, structured-only

Audit doc per spec §3.4. Written once on user-initiated bootstrap; never on the use-existing path.

| Aspect | Value |
|---|---|
| `usage` | `entity` |
| `versioned` | `true` (history is informational; rarely a second version) |
| `identity_fields` | `[bootstrap_id]` |
| Custom fields | `bootstrap_id` (string, mandatory) — UUID7 generated by APP-KB at bootstrap time |
|  | `app_version` (string, mandatory) — from `package.json` |
|  | `commit_sha` (string, mandatory) — git HEAD at runtime |
|  | `bootstrapped_at` (datetime, mandatory) |
|  | `templates_created` (array<string>, mandatory) — template values |
|  | `edge_types_created` (array<string>, mandatory) — edge template values |
|  | `terminologies_created` (array<string>, mandatory) — terminology values |
|  | `agent_identities_seeded` (array<string>, optional) — `agent_value` of each |
| Common fields | title, authored_by (= `app:APP-KB`), doc_status, tags, root (default `true`) — **no body** |
| FTS | title (A) only |

**Identity rationale:** `bootstrap_id` is unique per bootstrap. Multiple BOOTSTRAP_RECORDs per namespace are possible only if a future tool re-bootstraps (not v1 behavior).

**`root: true` by default** — bootstrap audit docs are intentional graph entry points. No outgoing edges expected.

---

## 6. Edge Types (10)

All `usage: relationship`, `versioned: false` (PoNIF #8), with mandatory `source_ref` + `target_ref` (per relationships-glossary §5.1). Identity = `[source_ref, target_ref]` so duplicate-write of the same edge = overwrite-in-place (PoNIF #8 semantics).

**Wildcard convention in this doc:** `*` in source/target_templates means "all 9 KB entity templates". I enumerate them explicitly when defining the edge — the platform requires concrete lists.

| Edge | source_templates | target_templates | Properties (v1) |
|---|---|---|---|
| `IMPACTS` | `DESIGN_DECISION` | `DESIGN_DECISION` | (none) |
| `REALIZES` | `CASE_RECORD`, `DESIGN_DECISION`, `JOURNEY_ENTRY` | `DESIGN_DECISION` | (none) |
| `LEARNED_FROM` | `LESSON` | `CASE_RECORD` | (none) |
| `DECIDED_BY` | `DESIGN_DECISION` | `FIRESIDE` | (none) |
| `SUPERSEDES` | `DESIGN_DECISION` | `DESIGN_DECISION` | (none) |
| `FLAGGED_FROM` | `FLAG_RECORD` | `*` (all 9) | (none) |
| `AGENT_PARTICIPATED` | `FIRESIDE`, `CASE_RECORD`, `DESIGN_DECISION`, `JOURNEY_ENTRY` | `AGENT_IDENTITY` | (none) |
| `FROM_DAY` | `GIT_STATS_SNAPSHOT` | `JOURNEY_ENTRY` | (none) |
| `REFERENCES` | `*` (all 9) | `*` (all 9) | (none) |
| `RELATES_TO` | `*` (all 9) | `*` (all 9) | (none) |

**[CALL] on REALIZES source:** kb-ux says "Code/feature → Decision". The KB has no "code/feature" doc type (code lives outside). I narrow to `[CASE_RECORD, DESIGN_DECISION, JOURNEY_ENTRY]` — docs that can describe implementation. Open in §9.

**[CALL] on AGENT_PARTICIPATED source:** kb-ux says only FIRESIDE → AGENT_IDENTITY. I broaden to `[FIRESIDE, CASE_RECORD, DESIGN_DECISION, JOURNEY_ENTRY]` — agents participate in more than just firesides. Open in §9.

**[CALL] on FLAGGED_FROM source:** spec §9 mandates source = `FLAG_RECORD`. kb-ux paper says `Case → (any doc)` — that's a kb-ux/spec conflict (kb-ux line 234 vs spec §9.1). Spec wins per §0. Surfaced in §9 to ensure FRanC corrects the kb-ux paper.

**Edge properties deferred:** kb-ux line 224 mentions "edge properties (date, context, etc.) can ride on any of them." None added in v1. JIRA-creep risk. Add per use case.

**Why `versioned: false` on every edge:** PoNIF #8. The fact that "doc A IMPACTS doc B" is what matters; the history of when that edge was first written rarely is. If a YAC needs to revoke an edge, the relationship doc archive (soft delete) handles it.

---

## 7. BOOTSTRAP_RECORD — Provenance Shape (Per Spec §3.4)

The shape of the audit doc written on user-initiated bootstrap. Already defined as a template in §5.9; this section enumerates what BootstrapGate writes into it.

```json
{
  "bootstrap_id": "<UUID7 generated at bootstrap time>",
  "title": "KB bootstrap <YYYY-MM-DD HH:MM>",
  "app_version": "<from package.json, e.g., '0.1.0'>",
  "commit_sha": "<git HEAD short hash, e.g., 'c3abd2a'>",
  "bootstrapped_at": "<ISO 8601 datetime>",
  "templates_created": [
    "CASE_RECORD", "DESIGN_DECISION", "LESSON", "FIRESIDE",
    "JOURNEY_ENTRY", "GIT_STATS_SNAPSHOT", "AGENT_IDENTITY",
    "FLAG_RECORD", "BOOTSTRAP_RECORD"
  ],
  "edge_types_created": [
    "IMPACTS", "REALIZES", "LEARNED_FROM", "DECIDED_BY", "SUPERSEDES",
    "FLAGGED_FROM", "AGENT_PARTICIPATED", "FROM_DAY", "REFERENCES",
    "RELATES_TO"
  ],
  "terminologies_created": [
    "KB_DOC_STATUS", "KB_TARGET_YAC"
  ],
  "agent_identities_seeded": [
    "USER1", "FRanC", "BE-YAC", "APP-RC", "APP-CT",
    "APP-KB", "BUG-YAC", "DOC-YAC"
  ],
  "authored_by": "app:APP-KB",
  "doc_status": "published",
  "root": true
}
```

**Why values not template_ids in `templates_created`:** the value is human-readable + stable across versions. Future YACs reading this doc can lookup the template via `value` without first resolving template_ids that may have rotated.

---

## 8. Candidate v2 Types (Not in v1)

Per spec §0 ("spec wins on conflict") and KICKOFF discipline note: the archetypes paper line 725 lists `ARCHITECTURAL_PATTERN` and `GLOSSARY_ENTRY` as part of the dogfood. Spec §5 does **not** include them in v1. I do not add them to v1.

Surfaced here as candidates for v2 promotion if use reveals the need:

- **`ARCHITECTURAL_PATTERN`** — repeating shapes (e.g., "offer-on-empty bootstrap", "BootstrapGate", "edge type as template"). Currently captured in DESIGN_DECISIONs and FIRESIDEs. Promote when patterns are referenced often enough that flat decisions feel undisciplined.
- **`GLOSSARY_ENTRY`** — controlled vocabulary for cross-doc terms (e.g., the relationships-glossary's "edge", "node", "PoNIF"). Currently free-text in body. Promote when search reveals "what does this term mean across the KB" is a real query.

---

## 9. Open Questions for FRanC (Spec §15 + new)

**All 17 resolved 2026-05-05** in conversation between Peter and FRanC. Resolutions inline below.

**Spec §15:**

1. **Empty-state UX.** v1 launches with zero docs (other than the `BOOTSTRAP_RECORD`). What does day-1 KB show — "ask a YAC to write the first doc" prompt? A skeleton of doc-type cards? Walkthrough? UX call.
   **Resolved:** v1 empty state = single message "a YAC needs to write a doc before the UI is activated". No cards, no walkthrough, no facets — the UI is not activated until docs exist. v1.5 adds a documentation link.

2. **Doc deep-link format.** `/apps/kb/doc/<wip-id>` vs `/apps/kb/<type>/<slug>`?
   **Resolved:** `/apps/kb/doc/<wip-id>`. Stable, opaque IDs; no slug-uniqueness design needed.

3. **Citation rendering in askBar answers.** Inline footnote vs side panel.
   **Resolved:** side panel. KB queries routinely cite 5+ docs; side panel scales where inline gets noisy. WIP-KB is not a mobile app, not even in v2.

4. **FLAG_RECORD structured fields beyond minimum.**
   **Resolved:** minimum (`target_yac` + `body` + `title`). No `priority`, no `acknowledged_at`. JIRA-creep avoided.

5. **CASE_RECORD structured fields.**
   **Resolved:** minimum (`source_yac` + `target_yac`). KB-CASE_RECORD is a knowledge artifact, not a live tracker — `yac-discussions/` filesystem stays the live medium for in-flight cases. See §5.1.

6. **doc_status semantics for FLAG_RECORD.**
   **Resolved:** Option A — keep `KB_DOC_STATUS` but FLAG_RECORD's `doc_status` defaults to `published` (not the inherited `draft`). Mirrors BOOTSTRAP_RECORD's pattern in §5.9. Flags are dispatched events, not drafts. No new terminology in v1; if flag-handling-via-`/kb` patterns reveal their own lifecycle in v2, define `KB_FLAG_STATUS` then. See §5.8.

7. **Schema-drift detection (deferred).**
   **Resolved:** confirmed deferred to v2 per spec. Nothing to do in v1.

**New questions surfaced during this session:**

8. **kb-ux paper has FLAG_RECORD/CASE_RECORD inconsistency.**
   **Resolved:** kb-ux paper updated to match spec — `FLAG_RECORD` (not CASE_RECORD) is what the flag modal creates. Three lines fixed (paper lines 82, 96, 178). Plus the kb-ux Doc Types table gained a FLAG_RECORD row (was missing entirely) and the CASE_RECORD row dropped its "migrated wholesale from yac-discussions/" claim (contradicted spec §4 — v1 is KB-native, no migration).

9. **kb-ux relationships table line 234 had FLAGGED_FROM = "Case → (any doc)".**
   **Resolved:** changed to `FLAG_RECORD → (any doc)` (paper line 124).

10. **REALIZES source.** kb-ux said "Code/feature → Decision".
    **Resolved:** confirm APP-KB's narrowing — REALIZES source = `[CASE_RECORD, DESIGN_DECISION, JOURNEY_ENTRY]`. KB has no "code/feature" doc type; APP-KB's pick covers docs that can describe implementation work.

11. **AGENT_PARTICIPATED source breadth.**
    **Resolved:** confirm APP-KB's broadening — AGENT_PARTICIPATED source = `[FIRESIDE, CASE_RECORD, DESIGN_DECISION, JOURNEY_ENTRY]`. Agents participate in more than firesides.

12. **`tags` on every entity template.**
    **Resolved:** universal. Topic page aggregates by "keyword + tag match" across types — universal is the smaller-blast-radius default.

13. **`authored_by` as string vs reference to AGENT_IDENTITY.**
    **Resolved:** string for v1. AGENT_PARTICIPATED edge handles typed linkage when needed. **Concern noted:** strings + grepping create matching ambiguity; the bet is YACs follow playbooks so values stay disciplined. Future-watch item if string drift surfaces.

14. **FLAG_RECORD title generation.**
    **Resolved:** auto-derive with override. Friction reduction matters for the "flag and move on" pattern; required title would slow every flag and produce throw-away titles when users hurry.

15. **Bootstrap-seeded AGENT_IDENTITY records.**
    **Resolved:** human owner is `USER1` (not `peter`). `USER1` everywhere — AGENT_IDENTITY `agent_value`, `KB_TARGET_YAC` value, and `authored_by` string when referring to the human. Display title stays "Peter" — UI shows readable name, data layer is multi-user-ready. Future deploys assign their own `USER1` per WIP-KB instance. Bootstrap seeds 8 records (`USER1`, FRanC, BE-YAC, APP-RC, APP-CT, APP-KB, BUG-YAC, DOC-YAC).

16. **FROM_DAY scope.**
    **Resolved:** keep narrow. FROM_DAY only `GIT_STATS_SNAPSHOT → JOURNEY_ENTRY`. `created_at` provides temporal context for any doc; broadening creates edge explosion. `RELATES_TO` covers explicit cross-doc linkage when needed.

17. **KB_AGENT_KIND terminology.**
    **Resolved:** drop. The 3-value LOV (human/yac/system) didn't unlock anything in v1; the human/YAC distinction is implicit in the name pattern (`USER1` vs `BE-YAC` vs `FRanC`). AGENT_IDENTITY launches with `agent_value` + `title` + `description`. Add `kind` later if filtering needs reveal. v1 terminology count drops from 3 to 2.

*(Q16 from this session's draft — about the missing "APP-KB-Specific Overlays" appendix in CLAUDE.md — was resolved by FRanC in commit `930fb8d` while this draft was being written. Removed.)*

---

## 10. Persistence Plan (After Approval)

When Peter signs off:

1. Create the 2 terminologies in `dev-kb` via `mcp__wip-kb__create_terminology` + `create_terms` (`KB_DOC_STATUS`, `KB_TARGET_YAC` — `KB_AGENT_KIND` dropped per Q17).
2. Create the 9 templates in `dev-kb` via `create_templates_bulk` (use draft mode per `wip://development-guide` if circular references — likely none here).
3. Create the 10 edge types in `dev-kb` via `create_edge_type` (PoNIF #7 — this tool surfaces the `usage: relationship` distinction at the API ingress).
4. Smoke-test: create one document of each type; create one of each edge type; verify FTS via `/api/reporting-sync/search`; verify orphan query returns expected.
5. Iterate on issues found; loop back to Peter on any field-shape changes.
6. **Only after** `dev-kb` is clean → translate the same definitions into `server/seed/templates/` for BootstrapGate to replay into `kb` at runtime.

`kb` namespace is **never** created from the dev workflow — it materialises only when the user confirms BootstrapGate's offer at app launch (CLAUDE.md namespace discipline).

---

*Discipline summary in one paragraph (post-Q1–Q17 resolution 2026-05-05): nine doc-type templates (seven entity + AGENT_IDENTITY reference + BOOTSTRAP_RECORD audit), two KB-local terminologies (`KB_DOC_STATUS`, `KB_TARGET_YAC` — `KB_AGENT_KIND` dropped per Q17), ten relationship templates with `versioned: false` and `[source_ref, target_ref]` identity. Common entity fields: title (FTS-A), body (FTS-B), authored_by (string per Q13, with the noted string-drift caveat), doc_status (term ref to `KB_DOC_STATUS`, default `draft`), tags (array<string>, universal per Q12), root (bool). Identity-field choices bias to `[title]` for narrative docs, `[date,...]` for time-keyed docs (JOURNEY_ENTRY, GIT_STATS_SNAPSHOT), zero (append-only) for FLAG_RECORD and CASE_RECORD. FLAG_RECORD's `doc_status` defaults to `published` per Q6 (override of the common-field default); BOOTSTRAP_RECORD ships with `doc_status: published` per §5.9. FTS bias: title (A) + body (B) on every entity that has them; structured-only types (GIT_STATS_SNAPSHOT, BOOTSTRAP_RECORD) carry only title FTS. AGENT_IDENTITY ships with eight bootstrap-seeded records — the human owner is `USER1` (display title "Peter") per Q15; the seven YACs are FRanC, BE-YAC, APP-RC, APP-CT, APP-KB, BUG-YAC, DOC-YAC. Doc deep-link format is `/apps/kb/doc/<wip-id>` (Q2). askBar citations render in a side panel (Q3). FLAG_RECORD title auto-derives with override (Q14). REALIZES source = `[CASE_RECORD, DESIGN_DECISION, JOURNEY_ENTRY]` (Q10); AGENT_PARTICIPATED source = `[FIRESIDE, CASE_RECORD, DESIGN_DECISION, JOURNEY_ENTRY]` (Q11); FROM_DAY stays narrow at `GIT_STATS_SNAPSHOT → JOURNEY_ENTRY` (Q16). Empty-state UX = single message "a YAC needs to write a doc before the UI is activated" (Q1). ARCHITECTURAL_PATTERN and GLOSSARY_ENTRY surfaced as v2 candidates per spec/archetype divergence (spec wins). Persistence happens only after Peter approves; first stop is `dev-kb`, then BootstrapGate seed files, then `kb` at runtime.*
