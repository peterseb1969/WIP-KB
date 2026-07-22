# ARCHITECTURE — WIP-KB

How the code is structured and the reasoning behind the load-bearing decisions.
For the data-model design (templates, edges, identity), see **DESIGN.md**. For the
WIP entity contract, see **WIP_DEPENDENCIES.md**.

## The shape: SPA + thin server, all state in WIP

```
Browser (React SPA)
  │  fetch  ${BASE_URL}{wip,server-api}/*
  ▼
Express server (server/index.ts)
  ├── @wip/proxy            → /wip/*          → WIP REST API (deterministic UI reads/writes)
  ├── kb-gateway.routes.ts  → /server-api/kb/*        (case mint/read, generic POST /write/:type)
  ├── kb-client.routes.ts   → /server-api/kb-client/* (serves the versioned CLI bundle)
  ├── config.routes.ts      → /server-api/config/*    (admin runtime config, e.g. Anthropic key)
  ├── bootstrap.routes.ts   → /server-api/bootstrap/* (status + SSE-streamed run)
  └── agent.ts (askBar)     → /server-api/ask         (NL query → Anthropic + WIP MCP tools)
  ▼
WIP (MongoDB docs · Postgres reporting/FTS · Registry identity · NATS · MinIO)
```

**The app is stateless.** All state lives in WIP. There is no client-side index, no
per-user prefs cache, no local DB, no `localStorage` beyond the auth session. Backup
of the app == backup of the `kb` + `library` namespaces + the container image.
Indexing is the data layer's job (Postgres `tsvector` via reporting-sync).

## Two namespaces (CASE-518)

The app spans two WIP namespaces: the **`kb` corpus** (cases, decisions, lessons,
sessions, memory, …) and **`library`** (the WIP Technical Library — generated-from-code
`LIBRARY_DOC`s). Central config is `src/lib/namespaces.ts` (`CORPUS_NS`, `LIBRARY_NS`,
`NAMESPACES = [corpus, …library]`); it is **two-namespace by default** (defaults
`kb` + `library`) and collapses to single-namespace when `LIBRARY_NS` is unset. The
unified UI **fans out** reads over `NAMESPACES` and merges (Home/Search); each doc
carries its `namespace`, so edge-type filtering keys on `${namespace}:${template}`.
The gateway routes a write to its type's home namespace (a `LIBRARY_DOC` → `library`).
Cross-namespace **relationships** are unsupported; Library→corpus links are plain
**reference fields** (`LIBRARY_DOC.kb_refs`, resolved via `allowed_external_refs → kb`).

## Pages & routes (`src/App.tsx`, `src/pages/`)

| Route | Component | Notes |
|---|---|---|
| `/` | `HomePage` | Fetches all docs across `NAMESPACES` (paged, concurrently — CASE-501), groups by `template_value`, newest group first. `HIDDEN_TYPES` + per-namespace edge-type keys exclude structural/config/relationship types and `CASE_RESPONSE` (CASE-533). |
| `/search` | `SearchPage` | Faceted search, fanned out per namespace → `POST /api/reporting-sync/search?namespace=` (scoped, CASE-541) and merged. Facets (type/status/author/kind/severity/app/**release**) are URL params; counts computed client-side. **Author** buckets are normalized to YAC roles (`docAuthors`, CASE-563); **Release** auto-hides when no `LIBRARY_DOC` is in scope. `CASE_RESPONSE` default-off but selectable (CASE-533). |
| `/doc/:id` | `DocPage` | One document. Renders body (markdown), structured fields (document-reference fields like `kb_refs` resolve to linked titles via `RefValue`), the `RelationshipGraph`, inline `CaseThread` (CASE-506/511), `PrepareButtons`, and `FlagModal` — **flag-for-YAC is corpus-only** (`canFlag = doc.namespace === CORPUS_NS`; cross-namespace `FLAGGED_FROM` unsupported). |
| `/client` | `ClientPage` | Renders the served kb-client manifest + per-file roles — in-app docs for the CLI. |
| `/settings` | `SettingsPage` | Admin-gated runtime config via `/server-api/config/*`. |

`Layout` + `Sidebar` wrap all routes; `AskBar` is mounted app-wide.

## Data flow & state

- **Reads/writes (deterministic):** the UI calls WIP through the Express **proxy**
  (`/wip/*`, `@wip/proxy` injecting the API key) and the **gateway**
  (`/server-api/kb/*`). Client helpers: `src/lib/wipBulk.ts` (`wipFetchJson`,
  bulk envelope) and `@wip/react` hooks (TanStack Query). Every fetch URL is
  prefixed with `import.meta.env.BASE_URL` so it resolves under `/apps/kb/`.
- **Server state** lives in the TanStack Query cache (keyed by namespace + query).
  **View state** (search query, facets, sort, page) lives in **URL params**, so
  searches are shareable/bookmarkable and survive reload. **Local component state**
  is only ephemeral UI (modals open, expanded thread).
- **askBar** posts the question to `/server-api/ask`; `agent.ts` runs an Anthropic
  model with WIP's MCP tools (run_report_query / search / document tools), with
  per-result caps to stay inside the model's context window (the 200k overflow fix).

## Auth (`server/auth.ts`)

Hybrid: under `wip-deploy` the router injects `X-WIP-User`/`X-WIP-Groups` headers
(gateway mode); standalone uses OIDC sessions; when `OIDC_ISSUER` is unset,
`requireAuth` passes through (apps-only / dev). `/api/me` sniffs gateway headers →
OIDC session → anonymous. Admin endpoints (Settings config) gate on `ADMIN_GROUPS`.

## Bootstrap (`BootstrapGate.tsx`, `server/lib/bootstrap.ts`)

Offer-on-empty / use-on-exists, now **two-namespace** (`buildPlans()` →
`seedNamespace()` per plan). On launch the gate checks that **every** configured
namespace (`kb` + `library`) exists. **Any missing →** show an explicit bootstrap
offer (never auto-bootstrap). Each namespace is seeded in filename order
(terminologies → terms → templates → WRITE_POLICY docs); the library is created with
`allowed_external_refs → kb`; one `KB_BOOTSTRAP_RECORD` provenance doc is written to
the corpus (namespace-prefixed value so app-derived namespaces never collide on it in
a merge; namespaces bootstrapped before the prefixing carry the unprefixed
`BOOTSTRAP_RECORD` — a template's value is its identity, so they are never renamed). `runBootstrap` **skips any namespace that already exists** (per-namespace
use-on-exists), so bootstrapping `library` onto an existing `kb` leaves the corpus
untouched. **Consequence:** with no reconcile, a *new* doc-type added to a seed does
not land on an already-bootstrapped namespace via redeploy — it must be created
against that namespace deliberately (how YAC_MEMORY reached canonical in the CHANGELOG).

## The served kb-client (`kb-client/`, `kb-client.routes.ts`)

The app serves its own version-matched CLI bundle at
`/server-api/kb-client/{manifest,download,install}`. `bundle_digest` (auto-computed
over the served files) is the currency signal — fetchers self-refresh when it
changes; `client_version` is informational. The CLI is **gateway-only**: reads via
`case-fetch.py`, writes via `kb-write.py <TYPE>` → the single `POST /write/:type`.
Per-type write behaviour (mint vs natural-upsert) is **data** — `WRITE_POLICY`
documents the gateway reads, not code. `ClientPage` renders this for operators.

## Key decisions (the ones the next session will want to change unless it knows why)

1. **Read-mostly; one UI write.** The only write from the UI is **flag-for-YAC**
   (a `FLAG_RECORD` + one `FLAGGED_FROM` edge). Creating/editing/archiving docs,
   changing status, managing relationships — all happen via YAC CLI tooling, never
   the UI. Resist adding a status/assignment/tag button (spec §11) — surface it as
   an open question instead.
2. **UI → REST, never UI → MCP.** Deterministic UI calls go through the proxy/
   gateway (REST). MCP is for YACs (agent consumption) and the askBar's agent.
   Routing UI → MCP → REST is two hops for zero benefit. If a REST endpoint is
   missing, file a CASE for BE-YAC — don't work around via MCP.
3. **Three fixed "prepare a prompt" buttons** (`PrepareButtons`): read-for-design,
   read-and-validate, read-and-plan. Clipboard helpers — **not writes, no editor,
   no per-doc-type variation**. The strings are a TS const array.
4. **FTS is the data layer's job.** Search hits `reporting-sync` (Postgres
   `tsvector`), not a client index. `full_text_indexed` string fields on a template
   produce `<field>_tsv` columns automatically.
5. **wip-deployable contract** (`papers/wip-deployable-app-contract.md`): base-path
   prefixing, `server.host: 0.0.0.0`, BASE_URL-prefixed fetches, gateway-aware
   `/api/me`, `Dockerfile.dev`. The Dockerfile defaults `VITE_BASE_PATH=/apps/kb`
   so a deploy that forgets the build-arg still produces a loadable SPA (CASE-533's
   sibling fix, `364fbde`).

## Inline documentation

Exported components/hooks carry JSDoc (incl. `namespaces.ts`'s `CORPUS_NS`/`LIBRARY_NS`/
`NAMESPACES`); non-obvious logic (concurrent paging, namespace fan-out, author-role
normalization, frontmatter list parsing, mint high-water-mark, base-path resolution)
carries WHY-comments. Keep that up as you edit.
