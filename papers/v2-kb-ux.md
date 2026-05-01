# v2 KB UX — Implementation Kick-Off

**Status:** Implementation kick-off design, 2026-04-18. Outcome of the UX detour after the Day 35 / Day 36 archetype-constraints sessions. v1 scope is deliberately narrow and ship-focused.

**Relationship to other docs:**
- `papers/v2-archetypes.md` — the `knowledgebase` archetype this dogfood realizes. WIP's own knowledge is the first real knowledgebase.
- `papers/v2-process-seeds.md` — process seeds this system operationalizes (case handling, lesson capture).
- `reports/BE-YAC-20260409-1636/fireside-v2-design-seeds.md` — Theme 11 introduced archetypes; this paper realizes one concrete archetype application.

---

## The User Insight

Two user classes, different needs:

- **Agents (YACs)** — consult the KB on session start to inherit team context; write observations (lessons, firesides, cases) back into it.
- **Peter** — reads + searches + curates + flags. **Never writes concrete articles or cases himself today** — always prompts a YAC to do it.

This shapes v1 scope sharply: the UI optimizes for what Peter *doesn't* have today (unified search + navigation across fragmented project spaces), not for authoring (which happens via YAC conversations that already work).

Peter's typical queries, in observed frequency:
- "What is the status of code / design / features for X?"
- "Remind me — do we already have a decision on Y? If so, what was it?"
- "How does X relate to Y? How do they get along?"
- "Which YAC did I discuss this with?" (sometimes unclear across BE-YAC / APP-RC / FRanC / BUG-YAC / etc.)
- "Show me all lessons — are there patterns warranting a slash command, archetype, or new feature?"

---

## v1 Scope

| In v1 | Deferred |
|---|---|
| NL askBar (single-turn query) | Semantic embeddings / RAG |
| Full-text search + faceted filters | Graph view (pretty, expensive, low ROI) |
| Topic page (auto-aggregated by concept) | Direct UI authoring |
| Document view + relationship sidebar | Template picker, relationship picker in UI |
| Connections view (path between two docs) | Draft workflow UI (status-as-field handles it) |
| Lessons browser (meta-view for pattern-spotting) | External URL ingestion UI |
| Git stats browser | Multi-user permissions beyond WIP's baseline |
| Flag-for-YAC modal | Notifications, polling, ops queue |
| YAC launch via `/kb` | Rich discussion threads |

The write path in v1 is entirely YAC-mediated (`/kb-persist <type>` command family). No editor, no template picker, no relationship picker in the UI. Those earn their way into v2 if use reveals the need.

---

## The Two NL Surfaces

A critical clarification that shapes how the system feels:

| | **askBar** (nl-query module) | **YAC via `/kb` slash** |
|---|---|---|
| Scope | KB namespace only | KB + repo + CLAUDE.md + session history |
| Context window | Short-lived, per-query | Persists for weeks (1M window) |
| Reasoning depth | Retrieve + compose an answer | Synthesize across sources, pattern-spot, cross-reference |
| Stateful? | No — each query is independent | Yes — multi-turn, remembers the conversation |
| Best for | Quick lookups, status checks, "what's in the KB about X?" | Complex analysis, flagging patterns, drafting new docs, connecting KB to ongoing work |
| Cost | Low | Higher |

**The pattern:** askBar is the entry point and the quick-answer layer. When a query exceeds its capabilities (complex synthesis, cross-project reasoning, multi-hop relationship traversal with interpretation), the answer should offer escalation:

> "This question touches work in both the backend repo and the archetype decisions. Want to continue this in a YAC session with full context?" → launches `/kb`

The askBar result might be "I found these docs [list], and decision X seems relevant [summary]." The YAC session takes over for "how does this relate to what BE-YAC was working on last week, and should we revisit the CASE-42 lesson in light of it?"

Neither is the "primary" interface. They're complementary. Most queries resolve at askBar; the ones that matter escalate to a YAC.

---

## Surfaces (v1)

| Surface | Purpose | Primary interaction |
|---|---|---|
| **askBar (top, persistent)** | NL query against the KB | Type; read answer with doc links |
| **Search results + facets** | type, YAC, date, status filters | Click facet; click result |
| **Topic page** | Aggregated by concept — current state of X | Scroll; click into source docs |
| **Document view + relationship sidebar** | Read a doc; navigate 1-hop | Click relationship to traverse |
| **Connections view** | Path between two selected docs | "How does X relate to Y?" → walks shortest path with relationship types |
| **Lessons browser** | All LESSONs, filterable, tag-cloud at top | Pattern-spotting across the lessons corpus |
| **Git stats browser** | GIT_STATS_SNAPSHOT listing + per-day drill | Browse numbers alongside narrative |
| **Flag-for-YAC modal** | Creates CASE_RECORD with `FLAGGED_FROM` | Pick YAC, type reason, confirm |

**Facet dimensions in search:**
- Type (CASE, DESIGN_DECISION, LESSON, FIRESIDE, JOURNEY_ENTRY, GIT_STATS_SNAPSHOT)
- Author / participating YAC (peter, BE-YAC, APP-RC, FRanC, BUG-YAC, mixed)
- Date range
- Status (via the `doc_status` field — draft, reviewed, published, deprecated, archived)

---

## Doc Types (v1)

| Template | `usage` | Holds |
|---|---|---|
| `CASE_RECORD` | entity | Cross-agent cases — migrated wholesale from `yac-discussions/` |
| `DESIGN_DECISION` | entity | Design choices like the archetypes doc itself |
| `LESSON` | entity | Entries from `lessons.md` + ongoing captures |
| `FIRESIDE` | entity | Design chat transcripts |
| `JOURNEY_ENTRY` | entity | Day journals from `dayJournals/` |
| `GIT_STATS_SNAPSHOT` | entity | Per-day or per-event stats; seeded from `git-stats-overlay.csv` |
| `AGENT_IDENTITY` | reference | YAC personas (FRanC, BE-YAC, APP-RC, BUG-YAC, etc.) |

All `entity` templates include:
- `authored_by` — `peter | yac-<session-id> | imported`
- `doc_status` — `draft | reviewed | published | deprecated | archived`
- `created_at`, `updated_at`
- `root: bool` — declares intent to be unlinked (for KB discipline — orphans are otherwise flagged)

---

## Relationships (v1)

Typed edges, implemented as `usage: relationship` templates with properties:

| Edge | Meaning | Typical source → target |
|---|---|---|
| `IMPACTS` | Source affects target | Decision → Decision |
| `REALIZES` | Source implements target | Code / feature → Decision |
| `LEARNED_FROM` | Source derived from target | Lesson → Case |
| `DECIDED_BY` | Source came out of target | Decision → Fireside |
| `SUPERSEDES` | Source replaces target | Decision → Decision |
| `FLAGGED_FROM` | Source was raised from target | Case → (any doc) |
| `AGENT_PARTICIPATED` | Agent involved in source | Fireside → AgentIdentity |
| `FROM_DAY` | Source produced on that day | GitStatsSnapshot → JourneyEntry |
| `REFERENCES` | General cross-link | Any → any |
| `RELATES_TO` | Loose association for "how does X relate to Y?" | Any → any |

Most edges are directional and traversable both ways (UI shows incoming + outgoing on each doc).

---

## Write Path — YAC-Mediated

v1 writing happens through YACs, never directly in the UI. Three patterns, ranked by reliability:

**1. `/kb-persist <type>` (primary)**

Explicit slash command at end of discussion. YAC generates the doc from conversation history, proposes relationships to link into the graph, asks for confirmation. User-initiated, predictable, auditable.

```
Peter: /kb-persist fireside
YAC:   I'll persist this discussion as a FIRESIDE doc titled 
       "v2 KB UX design kick-off". Proposed relationships:
         - IMPACTS → DESIGN_DECISION "v2-archetypes" 
         - AGENT_PARTICIPATED → FRanC
         - FROM_DAY → JOURNEY_ENTRY 2026-04-18
       Also detected 2 DESIGN_DECISIONs worth splitting out:
         - "KB write path is YAC-mediated in v1"
         - "askBar and YAC are distinct NL surfaces"
       Persist all? [y / edit / no]
```

**2. Session-close offer (backstop)**

YAC at natural session end: "this discussion covered X and Y; want me to persist?" Useful when Peter forgets to trigger `/kb-persist`. Slight risk of YAC misjudging what was worth persisting — acceptable if the prompt requires confirmation.

**3. Inline mid-session capture (parked)**

Too intrusive for flow. Not in v1.

**YAC discipline for KB writes:**
- Every new doc must declare at least one outgoing relationship OR flag `root: true`. Orphan accumulation is the archetype's main degradation mode.
- `authored_by` is set to the YAC's session ID automatically.
- Default `doc_status: draft`. Peter reviews and transitions via another command (`/kb-publish <id>`).

---

## Flag-for-YAC

The distinctive v1 feature. Documents become prompts for cross-agent work.

**Mechanics:**
1. Peter reads a doc (say, a journal entry mentioning something unresolved).
2. Clicks the flag icon in the doc view.
3. Modal: pick YAC (BE-YAC, APP-RC, BUG-YAC, FRanC, "any"), type the reason / question.
4. System creates a `CASE_RECORD` with `FLAGGED_FROM` relationship pointing to the flagged doc.
5. Peter prompts the target YAC manually: "Read CASE <id>" — same pattern as today's case flow.

No queue, no polling, no notifications. v1 is intentionally minimal. Matches Peter's current working style.

**Why this matters:** the KB stops being a passive archive. A document is a prompt waiting to happen. The pattern flips the KB from "what we know" to "what we know, and what warrants follow-up." This is the shift from record to actor.

---

## Migration Pilot Order

| Order | Type | Path | Rationale |
|---|---|---|---|
| 1 | Cases (`yac-discussions/CASE-*.md`) | **Wholesale** — move to WIP entirely; case logic becomes KB-native | Concrete use case, tests templates + relationships on real data |
| 2 | Lessons (`lessons.md`) | One-shot migration, small and self-contained | Validates the lessons browser view |
| 3 | Git stats | Seed from `git-stats-overlay.csv`, then `/stats` writes new snapshots | Fast payoff for Peter's stats browsing |
| 4 | Firesides | As referenced (most are linked from journals already) | Gradual, low-risk |
| 5 | Day journals | All new journals to WIP; old ones stay readable via git | Gradual |
| 6 | Design docs / papers | As touched; big docs like `v2-archetypes.md` become DESIGN_DECISIONs | Opportunistic |

**Old content stays readable via git.** The migration isn't a cutover — it's a new front that accumulates. The markdown files become the historical archive; WIP becomes the living KB.

---

## Open Questions

1. **askBar persona.** Is askBar a simple librarian ("here are 5 docs matching") or a light synthesizer ("decision X was made; here's the 2-sentence rationale")? My lean: light synthesizer — a librarian is just search with NL input.

2. **Session-close offer trigger.** What signals "this was document-worthy"? Length of session? Presence of design-decision language? User-declared? Probably: YAC asks only when explicitly instructed by a trigger phrase ("wrap it up", "done for now") — no clever inference.

3. **Topic page generation.** Aggregation key: tags? keywords in title? hand-curated topic LOV? Probably start with keyword match on title + tags; iterate if quality is poor.

4. **Git stats granularity.** Per-day? Per-commit-cluster? Per-release? My lean: per-day default, with optional per-event snapshots for notable moments (release cuts, first stable, major refactors).

5. **Lessons pattern-spotting UI.** Tag cloud vs cluster view vs simple list with filters. Probably all three eventually; start with the simple list + tag filter and see what Peter reaches for.

6. **Cross-reference between v1 surfaces.** Does the connections view share filters with search? Does clicking a YAC in the faceted filter also filter the lessons browser? Consistency is cheap to design, expensive to retrofit.

---

## What's Next

**Before implementation:**
- Decide whether to make this a `DESIGN_DECISION` in its own right (v2-kb-ux) once the KB exists — the KB eats itself.
- Align with `wip-deploy` v2 on which modules are required (`files` likely; `analytics` for reporting-sync to support the Git stats browser; `nl-query` essential for askBar).
- Decide the MCP tool surface for YAC KB access (`kb.search`, `kb.traverse`, `kb.write`, `kb.flag`).

**Implementation path:**
1. Scaffold the KB namespace in WIP with the v1 templates + relationships.
2. Migrate cases first (tests templates on real data).
3. Build askBar via existing `nl-query` module.
4. Build document view + relationship sidebar.
5. Add search + facets.
6. Add flag-for-YAC.
7. Add topic page + connections view + lessons browser + git stats browser.
8. Add `/kb-persist` command family for YACs.

Each step is dogfooded — Peter uses the partial system as it comes up; feedback shapes the next step.

---

## The Bet

v1 is a narrow surface: read + search + relate + flag, NL entry via askBar, escalation to YAC, write via YAC slash commands. That surface solves Peter's main pain (fragmented search across project spaces) and introduces the distinctive move (flag-for-YAC turns docs into prompts).

What it doesn't do — UI authoring, graph views, notifications, ops queues, cross-project federation — is *deliberately* deferred. MEG applies to UX too: every surface must justify itself on acceleration grounds. Ship narrow, iterate on real use.

The implementation kicks off when the archetype system is in place enough to support it. That's the unblock.
