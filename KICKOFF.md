# APP-KB-YAC — Session 1 Kickoff

**Read this in full before doing anything else.** Then read `CLAUDE.md` end-to-end — it's APP-KB-specific throughout, no generic gene-pool body to skip.

You are APP-KB-YAC, building the **WIP-hosted Knowledge Base** — the first dogfood of the `knowledgebase` archetype. This is not a generic app spawn; FRanC has staged extra context for you.

---

## What's Already Done For You

| Item | State |
|---|---|
| `wip-kb` k8s instance on Pi cluster | **Live.** 13/13 pods Running. Reachable from this Mac at `https://wip-kb.local`. |
| Document-relationships API (Phases 0–7 + 9) | Shipped. Edge types are first-class templates (PoNIF #7), `versioned: false` (PoNIF #8). |
| Full-text search architecture | **Decided.** Per-field `full_text_indexed`, Postgres tsvector via reporting-sync, single endpoint `/api/reporting-sync/search?mode=auto\|fts\|substring`. Read `papers/fts-architecture-fireside.md`. |
| MCP server `wip-kb` | Wired in `.mcp.json` via `WIP_API_KEY_FILE`. Tools surface as `mcp__wip-kb__*`. |
| `dev-kb` namespace on `wip-kb` | Created by FRanC. **Do all your iteration work here**, not in `kb`. |
| Runtime API key scoped to `dev-kb` | In `.env` as `WIP_API_KEY`. |
| Design package | `papers/` — five docs, copied from FRanC. |
| RC Console FTS surface | Surface 1 (template-editor FTS toggle) implemented; surfaces 2/3 are nice-to-have, not blocking. |

**No hard blockers remain.** The soft "wait for DOC-YAC's audit" consideration is also resolved (audit phase complete; PR0–5 merged on Day 46).

---

## Session 1 Goal

**Produce a draft of the v1 KB data model** — the 9 templates and 10 relationship-type definitions per spec §5 and §6 — and present it to Peter for review **before** persisting anything to `dev-kb`.

The session is *design and validation*, not yet implementation. You'll bootstrap to `dev-kb` once Peter signs off on the draft.

---

## Read Order (Strict)

Don't shortcut this. Each layer informs the next.

1. **`CLAUDE.md`** in this repo — APP-KB-specific from top to bottom. Pay particular attention to "Backend Target — wip-kb", "Namespace Discipline", "Architectural Rule", and "Write Discipline".
2. **`papers/v2-kb-app-requirements.md`** — the v1 spec. **Wins on conflict** with anything else.
3. **`papers/v2-kb-ux.md`** — UX rationale, doc types, edge taxonomy. Older; defer to the spec on overlaps.
4. **`papers/v2-archetypes.md` §4 (`knowledgebase`)** — archetype defaults to inherit.
5. **`papers/relationships-glossary.md`** — relation vs relationship vocabulary, graph-theory primer. Required before touching edge types.
6. **`papers/fts-architecture-fireside.md`** — FTS endpoint shape and which fields to flag.
7. **MCP resources via the `wip-kb` server:**
   - `wip://development-guide`
   - `wip://data-model`
   - `wip://conventions`
   - `wip://ponifs`
8. **The scaffold itself** — `src/`, `server/`, `templates/bootstrap/*.template`, `package.json`. Understand what `--preset query` gave you.

Then run `mcp__wip-kb__list_namespaces` to confirm connectivity. You should see `wip`, `testfts`, and `dev-kb`. The `kb` namespace should **not** exist yet — it's created by the app's BootstrapGate at runtime.

---

## What You Produce in Session 1

Three deliverables, in this order:

1. **A `DESIGN.md` at the repo root** with:
   - The 9 template definitions (template name, `usage`, fields, which fields get `full_text_indexed`, which fields are `versioned`, identity-hash field choices)
   - The 10 relationship-type definitions (edge name, source/target template constraints, `versioned: false` per PoNIF #8, properties if any)
   - The terminology dependencies (any LOVs needed by the templates)
   - The `BOOTSTRAP_RECORD` shape per spec §3.4
2. **A list of open questions for Peter via FRanC** — the spec's §15 list plus anything new you discover. Don't decide unilaterally.
3. **No persistence to `wip-kb` yet.** Templates and edge types only get created in `dev-kb` after Peter approves the draft.

---

## Discipline Notes

- **Spec wins on conflict.** If the kb-ux paper or the archetype paper says X and the spec says Y, follow the spec.
- **You own the structured-field shapes**, not FRanC. The spec specifies *types*, not fields. Bias minimal — start with title/body/origin, add fields when use reveals the need (spec §5 explicitly calls out the JIRA-creep risk).
- **Identity-hash field choices.** Picking the wrong identity fields = wrong dedup behaviour on upsert. Re-read `wip://ponifs` and `relationships-glossary.md` §"Property graph vs RDF" before you decide. When in doubt, escalate.
- **The architectural rule is load-bearing.** UI → REST. askBar → nl-query. YACs → MCP. Internalise this before you start any code in Phase 4.
- **The architecture paper line 725 lists `ARCHITECTURAL_PATTERN` and `GLOSSARY_ENTRY` as part of the dogfood.** The spec §5 does not include them in v1. The spec wins. Do not add them to v1; surface them as "candidate v2 types" in your DESIGN.md if you think they're warranted.

---

## When Stuck

- **Conflict between docs:** spec wins. Note the conflict for FRanC.
- **Decision the spec doesn't answer:** see §15. Surface to Peter via FRanC.
- **Tooling gap or REST endpoint missing:** file a CASE for BE-YAC. Do not work around via MCP from the UI.
- **Anything surprising about wip-kb's state:** it's running 1.3-kb images on the Pi cluster; this is the first dogfood install. If something doesn't behave like the spec assumes, FRanC wants to know.

---

## End-of-Session Reporting

You write session reports to FRanC at `/Users/peter/Development/FR-YAC/reports/APP-KB-<YYYYMMDD-HHMM>/`. The standard YAC reporting flow applies (see CLAUDE.md § "YAC Reporting"). FRanC reads these on `/catch-up` and synthesises into the day journal.

Welcome aboard.
