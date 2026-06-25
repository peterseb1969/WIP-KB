# KB radical-reload — canonical cutover runbook (DRAFT)

**Status:** DRAFT — Phase 1 (localhost iterate-to-green) is done; this Phase-2
runbook is **not yet executed**. Do not run against canonical without Peter's
go-ahead.

**Context:** CASE-490 (deactivating a populated `CASE_RECORD` template version
stranded 133 docs) and CASE-491 (the validated-migrate primitive — unbuilt).
Rather than in-place template surgery, we **export + re-register** the whole KB
onto the (A) seed templates in a fresh namespace, then repoint the app. This
sidesteps both the CASE-490 freeze class and the dependency on unbuilt backend
primitives.

Tools: `tools/bootstrap-ns.ts` (real `runBootstrap` into a throwaway ns) and
`tools/kb-reload.py` (the loader). Both are **localhost-only** by guardrail.

**Folded in since the draft (all on `origin/main`, localhost-validated):**
- **CASE-422** — `app` is now a `KB_APP` term-ref; the reload canonicalizes app
  values in the same pass (synonyms resolve: `kb`→KB, `Song`→wip-song, …). No
  separate migration.
- **kb-reload.py empty-strip** — empty-string/null values are dropped before
  write (an optional term-ref rejects `""`); empties become absent.
- **Gateway 502→4xx (CASE-490 #1)** — document-store per-item errors now surface
  as branchable 4xx, so a coverage failure during the run reads cleanly.

---

## What the reload does (recap)

1. Bootstrap a fresh namespace with the current (A) `server/seed/` schema.
2. Delete the `CASE_RECORD` `WRITE_POLICY` doc → case auto-numbering OFF.
3. Load entities through the gateway single-write-path:
   - empty-string/null fields dropped (→ absent) so optional term-refs don't
     reject `""`.
   - `app` resolves against `KB_APP` at write (synonyms canonicalize: `kb`→KB,
     `Song`→wip-song); `data.app` keeps the raw input (Preserve-Original), the
     canonical lives in `term_references` (CASE-422).
   - `CASE_RECORD` written **natural** → `case_number` preserved exactly (sparse
     1–492 with gaps); `DOCUMENT`/`FIRESIDE` **minted** (their identity *is* the
     minted number, absent in old data); others natural. `BOOTSTRAP_RECORD` skipped.
   - JOURNEY Day-61 collision resolved by renumbering the later entry to 61.5.
4. Load edges (by target identity — no document_id remap), idempotent.
5. Backfill `CASE-<n>` Registry synonyms.
6. Re-create the `CASE_RECORD` `WRITE_POLICY` doc → auto-numbering back on
   (resumes at `max(case_number)+1 = 493`).
7. Verify per-type counts, edge links, and `GET /cases/<n>` resolution.

Validated on localhost: 393 cases + 729 edges + 393 synonyms, `GET /cases/457`
resolves (the CASE-490 victim); `app` folds `kb`→KB / `Song`→wip-song with zero
non-canonical leak.

> **Iteration hygiene — use a FRESH namespace name each run.** Re-using a
> torn-down namespace name serves a **stale gateway template cache**
> (`Template '…' not found`), because the gateway caches templates per namespace
> *name* and the rebuild mints new template_ids. The cutover uses a new namespace
> anyway; the gateway restart (step 4) clears the cache.

---

## Phase-2 cutover — the one-shot against canonical

> Decisions to confirm before running: (1) target namespace name (recommend a
> NEW namespace, e.g. `kb2`, NOT a destroy-and-rebuild of `kb`, so the old data
> stays as a cold rollback); (2) the app-repoint mechanism (`KB_NAMESPACE` /
> gateway `NS_DEFAULT`); (3) a maintenance window (writes to `kb` must be quiet
> during export→cutover, else late writes are lost — same TOCTOU the freeze-lock
> closes in the in-place design).

### Pre-flight
- [ ] Announce a write freeze on the KB (no `/kb-persist`, no case filing) for the window.
- [ ] Confirm `.claude/kb.json` → `kb_app_url=https://kb.internal`, key file present.
- [ ] Confirm the reload tools are at the intended commit; `git status` clean.
- [ ] Decide target namespace (e.g. `kb2`) and record it.

### 1. Fresh export from canonical
- [ ] Take a brand-new backup of canonical `kb` (the loader reads the export; do
      NOT `start_restore`). Drop the zip in `backup-files/`.
- [ ] Sanity-check counts vs. expectation (cases ≈ 39x, edges, etc.).

### 2. Build + load into a NEW namespace — **on localhost first, against THIS export**
- [ ] Run the full reload into a throwaway localhost ns (a **fresh name** — see
      iteration hygiene above) using the *canonical* export, to confirm this
      specific snapshot loads clean (catches any data that drifted since the last
      localhost run):
      `python3 tools/kb-reload.py --backup backup-files/<new>.zip --namespace kb-canary-<ts> --phase all`
- [ ] Verify: all per-type counts OK (or expected mismatches understood), edges
      linked, `GET /cases/<n>` resolves.
- [ ] **`KB_APP` coverage gate (CASE-422):** zero `CASE_RECORD` errors of the
      form `Value '…' is not valid for terminology` — i.e. every `data.app`
      spelling in *this* export is a `KB_APP` term or synonym. If a NEW spelling
      appears (a new app filed since the last corpus check), **add it to
      `server/seed/terminologies/KB_APP.json`** (canonical term or synonym) and
      re-run the canary before cutover. (Empty `app` is fine — dropped to absent.)
- [ ] Teardown the canary.

### 3. Cutover against canonical
> The loader is localhost-pinned by guardrail. Running against canonical
> requires a deliberate, reviewed change of `BASE_URL`/`KEY_FILE` (and removing
> the `localhost` guard) — treat that diff as part of this runbook, never a
> silent edit. **Do not** proceed past here without Peter present.
- [ ] Point the tools at canonical (reviewed diff or env override TBD) and the
      bootstrap at the new namespace (`KB_BOOTSTRAP_NAMESPACE=kb2`,
      `WIP_BASE_URL=https://kb.internal`, key = kb ops key).
- [ ] Run bootstrap → entities → edges → synonyms → policy → verify into `kb2`.
- [ ] Verify on canonical: counts, edges, a spot-check of `GET /cases/457`,
      `/cases/490`, and a doc with a `REFERENCES` edge.

### 4. Repoint the app + restart
- [ ] Repoint the KB app/gateway to `kb2` (`KB_NAMESPACE` / gateway default).
- [ ] **Restart the gateway** — required so the per-namespace `WRITE_POLICY`
      cache is fresh and case minting activates on `kb2` (resumes at 493).
- [ ] Smoke: load `/apps/kb/`, list cases, open a case, follow an edge, file a
      throwaway test case → confirm it mints `CASE-493`, then delete it.

### 5. Settle
- [ ] Keep old `kb` namespace intact as cold rollback (do not delete for N days).
- [ ] Update `.claude/kb.json` only if the app URL changes (namespace is internal).
- [ ] Record the cutover (a SESSION/JOURNEY note); flag CASE-491 progress as moot
      for KB now that the reload path exists.

### Rollback
- Repoint the app back to `kb` and restart the gateway. `kb2` can be deleted
  later (`delete_namespace`, `deletion_mode: full`). No data lost because the
  cutover never mutated `kb`.

---

## Open items feeding this runbook
- **JOURNEY Day-61** resolved via renumber-to-61.5 (option 2). If the new
  `JOURNEY_ENTRY` identity is later widened (e.g. `day_number,title`), drop the
  override.
- **`KB_APP` coverage** (CASE-422) must cover every `data.app` spelling in the
  canonical export at cutover time. The canary's coverage gate (step 2) is the
  go/no-go; new apps filed since the last corpus check need a `KB_APP` synonym
  first. `data.app` stays raw (Preserve-Original); consumers read the canonical
  from `term_references` (the SearchPage facet already does).
- **`localhost` guardrail removal** for the canonical run — the one deliberate,
  reviewed unsafety in the whole procedure. Keep it explicit.
- **Write-freeze window** length — bounded by export + load time (~minutes for
  ~1.4k docs); confirm acceptable.
- **Fresh namespace name per reload run** — re-use serves a stale gateway
  template cache (see iteration hygiene).
