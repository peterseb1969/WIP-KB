# CHANGELOG — WIP-KB

Human-readable evolution (one entry per logical change, not per commit). Older work
than 2026-06-21 is in git history and DESIGN.md's Phase notes.

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
