# CHANGELOG — WIP-KB

Human-readable evolution (one entry per logical change, not per commit). Older work
than 2026-06-21 is in git history and DESIGN.md's Phase notes.

## 2026-10-14 — Project page

- **Added:** `/project/:app` — a project's profile (title, scope, repositories), its
  tooling archive as a download, and the documents tagged with it, grouped as in the
  brief, each linking to its document page. Read-only; same gateway read as
  `kbc brief`. Respects the knowledge-domain URL prefix.
- **Added:** links to it from each Project facet entry on Search (arrow icon) and from a
  `PROJECT` document's page.
- **Changed:** the Search facet "App" is now "Project". A `CASE_RESPONSE` counts as its
  case's project, so filtering by project keeps a case's thread instead of dropping it.

## 2026-10-14 — `kbc case-fetch.py brief` (client 4.3.0)

- **Added:** `brief [<app>] [--namespace NS] [--tooling DIR] [--format text|json]` — the
  project brief as text for a session start. `<app>` defaults to kb.json `project`.
  `--tooling DIR` saves the tooling archive into DIR exactly as stored (never unpacked;
  the server's filename is reduced to its last path component); a project without an
  archive is reported on stderr, not treated as a failure, so a session-start hook can
  always pass the flag.
- **Added:** `gw_get_bytes()` in `kb_client_core.py` — file downloads through the
  gateway, with the same local→remote failover as JSON reads.

## 2026-10-14 — Project brief and tooling download (gateway)

- **Added:** `GET /projects/:app/brief` — a project's context in one read: the `PROJECT`
  profile (scope, repo ids, tooling archive name/size), a where-things-live note, and
  the project's open cases, newest decisions / lessons / firesides, recent sessions,
  memories and mirrored documents (with the commit each was synced from). Handles and
  titles, not bodies. `:app` is any alias of the KB_APP term. Caller's key, document
  store reads only.
- **Added:** `GET /projects/:app/tooling` — streams the project's tooling archive as
  stored; never unpacked or run.
- Verified on localhost after WIP's typed-names term model (CASE-872 era) landed: term
  resolution, aliases in responses, the brief, the download and a fresh seed bootstrap
  all work. Note for vocabulary writes (CASE-828): an alias update still replaces the
  list, and an alias equal to the term's own value or a duplicate alias is now rejected
  (`invalid_names`).
- Not yet: the `kbc case-fetch.py brief` verb and the UI project page.

## 2026-10-14 — Backfill `app` onto existing documents

- **Added:** `tools/backfill-app.py` + `tools/backfill-app-mapping.json`. Infers a
  document's project from fields it already has (SESSION role, YAC_MEMORY owner,
  DOCUMENT repo_id; LESSON / DESIGN_DECISION / FIRESIDE only when their app-YAC authors
  name exactly one app) and re-submits its complete data plus `app` on the latest
  template version: an update of the same document, so only tagged documents get a new
  version (a migrate would bump whole version cohorts). The dry run (default) validates
  every planned write and checks its identity hash equals the current one, so an apply
  can only update, never fork. Localhost: 446 documents tagged, document count
  unchanged, each new version differs from the previous in `app` only.

## 2026-10-12 — Gateway search works for namespace-scoped keys

- **Fixed:** WIP now reserves raw reporting SQL to admin and service keys (CASE-851).
  The gateway's `/search` enriched hits (titles, project membership) with raw SQL
  under the caller's key, so for any namespace-scoped key every namespace failed and
  search returned **nothing, without an error**. Titles and the `app` term now come
  from the document store with the caller's key, one query per matched type; the
  gateway runs no raw SQL at all. Verified on localhost with a `kb`-scoped key: hits
  with titles from `kb`, none from namespaces it has no grant on, `--project` works.

## 2026-10-02 — Find and tag a project's documents

- **Added:** `/read/:type` filters on a term field match the resolved term, not the
  stored spelling: `app=ClinTrial`, `clintrial`, `ct` and `clintrial-explorer` all
  find the same 22 cases on localhost (spelling-only matching found 11). A value
  naming no term keeps the old spelling match.
- **Added:** gateway `/search?app=` and `kbc case-fetch.py search --project <app>` —
  only documents tagged with that project (compared on `app_term_id`).
- **Added:** optional `project` key in `.claude/kb.json` (`KB_PROJECT`): every write
  sends it, and the gateway sets `app` when the type has the field and the document
  names none. An explicit `app` wins.
- **Fixed (migration script):** the reporting view must declare `app_term_id` as well
  as `app`, or project filtering cannot see the resolved term on the new versions.
  A reporting-only change is not a new template version, so already-migrated
  templates get the declaration updated in place plus a batch sync to rebuild views.

## 2026-10-02 — Projects inside a domain: `PROJECT` and the `app` field

- **Added (data model, approved):** `PROJECT` template — one profile per project,
  identity = its `KB_APP` term; title, scope (`body`), `repo_ids`, and an optional
  `tooling` archive (zip/tar/gzip file, ≤100 MB) a user downloads and unpacks.
- **Added:** optional `app` (`KB_APP` term) on `DESIGN_DECISION`, `LESSON`,
  `FIRESIDE`, `SESSION`, `YAC_MEMORY` and `DOCUMENT` (`CASE_RECORD` already had it).
  Applied to existing instances by `tools/add-project-and-app-field.py` (idempotent,
  exact-diff checked, merges the reporting view columns, leaves old versions active);
  the seed files carry the same fields. Existing documents stay on their old version
  and cannot take `app` until migrated — a separate backfill step.
- **Fixed (gateway):** a term in an identity field is written as the term's canonical
  value. WIP hashes identity from the submitted spelling, so `ClinTrial`, `clintrial`
  and `ct` — one term — created three `PROJECT` profiles. Platform question filed as
  CASE-847.

## 2026-10-02 — Choose the knowledge domain per request

- **Added:** the UI shows any knowledge domain (KB namespace) via a URL prefix,
  `/apps/kb/ns/<namespace>/…`; plain URLs keep showing the configured corpus. A
  sidebar **Knowledge base** switcher lists the domains it finds (namespaces carrying
  the KB's `WRITE_POLICY` template) and appears only when there is more than one.
  Links stay inside the chosen domain; switching is a full page load.
- **Added:** `kbc case-fetch.py search --namespace <ns>`, and an optional `namespace`
  key in `.claude/kb.json` that sets the CLI's domain (env `KB_NAMESPACE` still wins).
- **Fixed:** gateway `/search` ignored `?namespace=` and always searched the configured
  corpus, so a client pointed at another domain silently searched the default one.
- **Fixed:** namespaces containing a hyphen were silently dropped from search (gateway)
  and refused as "invalid namespace" (UI reporting reads): both guards allowed only
  `[a-z0-9_]`. They now allow a lowercase slug with hyphens, and still never a quote.

## 2026-10-02 — Create a new knowledge domain from the CLI

- **Added:** `kbc kb-namespace.py create <ns> [--description …]` and gateway
  `POST /namespaces`: creates a namespace seeded with the full corpus model
  (vocabularies, templates, edge types, write policies) plus a bootstrap record — the
  same seeding BootstrapGate does, now reusable for any namespace name. Option two of
  DECISION-1 (a project that wants its own walled-off domain). Runs with the caller's
  key; an existing namespace answers 409 and is never re-seeded; the library namespace
  is not touched. The WIP helpers and seeding functions take an optional key so the
  gateway path never runs with the server's own key.
- **Retry after a failure:** an existing but completely empty namespace (what a refused
  or interrupted attempt leaves behind — the namespace is created first) is seeded
  rather than refused, and a failed attempt's error says whether it left a namespace
  behind, or that the refused key cannot see it. A partly seeded namespace still
  answers 409. Found while testing: CASE-844 (registry admin checks never run) lets a
  namespace-scoped key create the namespace before def-store refuses it.

## 2026-07-03 — `/types` discovers Library types for any caller

- **Fixed:** `kb-write.py --list` (`GET /types`) omitted `LIBRARY_DOC`/`library` for a
  namespace-scoped caller. `/types` enumerated templates with the *caller's* key, so a
  `kb`-scoped key (which can't LIST the `library` namespace) silently dropped its types.
  Now `/types` enumerates with the gateway's own key (`WIP_API_KEY`, cross-namespace —
  the same key the proxy browses `library` with); `callerKey` stays the auth gate.
  Verified on localhost with a real `kb`-scoped key: it 404s on `library` directly, yet
  `/types` returns all 15 types incl `LIBRARY_DOC`. (CASE-573)

## 2026-07-03 — Sidebar quick "jump to case"

- **Added:** a case-number quick-jump box in the sidebar under **Start** (`CaseJump`).
  Digits-only input; after a 700ms pause it previews `CASE-<n> · <title>` (full title
  in a hover tooltip, ~100 chars), and **Enter** jumps straight to the case's DocPage.
  A global **`c`** shortcut focuses it from anywhere (`c544⏎` jumps) — guarded so it
  never steals keystrokes in an input/textarea/askBar or clobbers Ctrl/⌘-C. Resolves
  through the `/wip` proxy (Registry `CASE-<n>` synonym → doc-id + title); read-only.

## 2026-07-02 — Author facet cleanup + frontmatter list parsing

- **Fixed:** the `/search` **Author facet** listed ~79 entries. `rootAuthor` stripped
  only a 4-digit `-HHMM` session suffix, not the 6-digit `-HHMMSS` IDs minted by
  `/wip-setup`+`/wip-wake`, and ignored quoted / composite / mixed-case values.
  Replaced with a multi-value `docAuthors` (`SearchPage.tsx`) that splits composites,
  strips quotes / parentheticals / the `-YYYYMMDD[-HHMM(SS)]` suffix / `app:` prefix,
  canonicalises casing (`FRANC`→`FRanC`), and keeps only role-shaped tokens. A doc now
  buckets under **each** of its authors. Display-only — no `authored_by` data rewritten.
  Facet collapses 77 → 12 clean roles. (CASE-563, `d498fa1`)
- **Fixed:** `kb-write.py`'s `parse_frontmatter` silently dropped **multi-line YAML
  lists** (a bare `key:` + `- item` lines) — only single-line `[a, b]` worked — which
  nulled array fields like `LIBRARY_DOC.source_scope`/`tags` while the write reported
  success. Extended the flat parser with a pending-list state machine (zero new deps);
  added an offline regression test (`kb-client/test_parse_frontmatter.py`). (CASE-565,
  `4c2e693`)

## 2026-06-29 — Two-namespace Technical Library (CASE-518)

- **Added:** a second namespace, **`library`** (the WIP Technical Library —
  generated-from-code docs), alongside the `kb` corpus. New `LIBRARY_DOC` template
  (identity `[slug, release]` — `release` keeps v1/v2 libraries parallel; provenance
  fields excluded from identity), `SEE_ALSO` edge, and `LIBRARY_RELEASE` /
  `LIBRARY_CATEGORY` / `LIBRARY_STATUS` terminologies. Seed in `server/seed-library/`.
- **Changed:** the app is now **two-namespace by default** (activated by the merge, no
  deploy-env change — `2295dbe`). Central config `src/lib/namespaces.ts`
  (`CORPUS_NS`/`LIBRARY_NS`/`NAMESPACES`); Home/Search/Doc pages span both namespaces;
  a **Release** search facet; the bootstrap seeds both namespaces and skips any that
  already exist (per-namespace use-on-exists); the gateway routes `LIBRARY_DOC` writes
  to `library`; the askBar is namespace-aware.
- **Added:** `kb_refs` — Library→KB links as cross-namespace **reference fields**
  (cross-namespace *relationships* are unsupported → CASE-538); resolved/rendered in
  `DocPage`. Flag-for-YAC stays corpus-only.
- **Fixed (platform, via BE-YAC):** reporting-sync `/search` now honours `?namespace=`
  so per-namespace search scopes correctly (CASE-541); multi-namespace backup+restore
  (CASE-542, the cut-over enabler).
- **Known issues (open):** `kb_refs` array-references aren't existence-validated —
  soft links (CASE-550); corpus namespace is dual-sourced (`WIP_NAMESPACE` vs
  `VITE_KB_NAMESPACE`) and must agree (CASE-551). Neither blocks; both tracked.

## 2026-06-28 — Documentation baseline + search clutter trim

- **Added:** the standard documentation set (README, ARCHITECTURE, WIP_DEPENDENCIES,
  IMPORT_FORMATS, KNOWN_ISSUES, CHANGELOG) — first full `/wip-document` pass.
- **Changed:** `CASE_RESPONSE` docs hidden from the start page and excluded from
  search results by default (still selectable via the type facet). (CASE-533,
  `06badee`)

## 2026-06-27 — YAC_MEMORY (CASE-507) + prod SPA fix

- **Added:** `YAC_MEMORY` doc-type + `KB_MEMORY_TYPE` terminology — captures each
  YAC's local memory files into the KB (cross-agent visible, FTS-searchable,
  edge-linkable). Seed + loader (`kb-write.py YAC_MEMORY <dir>`, natural-upsert by
  `(owner, mem_key)`) + session-end fold-in. Landed additively on canonical kb;
  capture + FTS verified (72 docs). (`74f2ebe`, `ea15c27`, `ede23a9`)
- **Added:** REFERENCES widened to allow `YAC_MEMORY` endpoints via the new
  `add_edge_type_endpoints` primitive. (CASE-507/515)
- **Fixed:** production SPA failed to load (root-relative `/assets/*` → text/html
  MIME error) — the Dockerfile now defaults `VITE_BASE_PATH=/apps/kb` so the image
  is correct even if the deploy omits the build-arg. (`364fbde`)
- **Changed:** `--refresh` to @wip/client 0.27 / react 0.16; PoNIF #7 doc reframed
  (endpoints append-only). (`7442c76`)
- **Known issues:** YAC_MEMORY deletes don't propagate (v2 reconcile deferred);
  reporting-sync search scope was *suspected* broken but proven fine (CASE-530
  retracted — was a verification-script bug).

## 2026-06-26 — Case-thread, runtime config, mint correctness

- **Added:** inline case-response thread + response dots on the relationship graph
  (`DocPage`/`CaseThread`); gateway `GET /cases/:n?view=both|case|responses`
  (CASE-506/511, `d9ec7ca`, `c65968b`). Runtime Anthropic key via the Settings UI
  (override → file → env, validate-before-accept) (CASE-508, `69c7abd`). `kbc`
  shim for the served client (CASE-510, `1c5cf03`).
- **Fixed:** mint high-water mark now spans soft-deleted docs (no number reuse /
  v2-clobber) (CASE-504, `14ad90d`). SESSION mirror accepts a `session.md` file
  path, not just a dir (CASE-503, `f85085f`). askBar 200k context overflow capped
  (`6c232ec`). Config docs hidden from the start page (`8cec675`).

## 2026-06-25 — Performance + app-as-term

- **Changed:** the doc-list sweep parallelized (concurrent paging) on Home/Search
  (CASE-501, `0856dba`). `app` modelled as a `KB_APP` term-ref; facets read the
  resolved term (CASE-422, `327f7d6`).

## 2026-06-21–22 — (A) write design + reload harness

- **Changed:** unified write surface — one `POST /write/:type`; per-type behaviour
  is `WRITE_POLICY` data, not code; case-workflow playbook rewritten (CASE-482).
- **Added:** KB radical-reload migration harness (CASE-490/491). Gateway maps
  document-store error codes to 4xx instead of blanket 502.
