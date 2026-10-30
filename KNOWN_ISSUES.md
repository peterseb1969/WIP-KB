# KNOWN_ISSUES — WIP-KB

What's incomplete, deferred, or intentionally simple — so the next session doesn't
re-investigate solved problems, "fix" intentional choices, or miss real gaps.

## Open / deferred

### Tooling uploads are held in memory
**Status:** known · **Severity:** low
`POST /projects/:app/tooling` reads the whole archive (up to 100 MB) into memory and
copies it once more for the multipart upload to WIP. The KB container has no memory
limit today (a 95 MB upload left the pod at about 110 MiB). A limit below about
300 MiB would be at risk. Streaming the upload through would remove this.

### `authored_by` is free-form at write time
**Status:** deferred · **Severity:** low
Writers put free-form/composite text into `authored_by` (`"BE-YAC / Peter"`,
`"Peter, APP-KB"`, quotes, day annotations), so the Author facet needs display-side
normalization (`docAuthors`, CASE-563). The display fix keeps the facet clean, but the
root cause — write-time discipline so `authored_by` carries a clean session role — is a
separate, larger item, not yet filed.

### askBar tool-choice is non-deterministic
**Status:** mitigated · **Severity:** low
The NL-query agent occasionally picks a full-document tool over compact
`run_report_query`/`search`, which once blew the model's 200k context. Mitigated by
system-prompt steering + a hard per-result cap + a graceful length-error retry
(`6c232ec`). Same prompt can still vary; the cap is the backstop.

### Open UX questions for FRanC (spec §15)
**Status:** deferred · **Severity:** low/design
Empty-state UX, doc deep-link format (`/doc/<id>` vs slug), askBar citation
rendering, FLAG_RECORD/CASE_RECORD structured fields beyond the minimum (JIRA-creep
risk), `doc_status` semantics for FLAG_RECORD, schema-drift detection (deferred v2).
Surface via FRanC; don't decide unilaterally.

### DESIGN.md is partly stale
**Status:** known · **Severity:** low
DESIGN.md's verification section is dated 2026-05-05 against `dev-kb` and predates
later doc types (CASE_RESPONSE, SESSION, YAC_MEMORY) and edges (RESPONDS_TO,
CONTINUES_FROM). Treat it as design rationale, not a current inventory — WIP_DEPENDENCIES.md
is the current list.

### Bundle not code-split
**Status:** wont-fix (for now) · **Severity:** cosmetic
`vite build` warns the main chunk >500 kB. No `manualChunks`/dynamic-import split
yet; acceptable for an internal app.

## Resolved (kept so nobody re-investigates)

### Doc view: the document's identity scrolled away on long pages
**Status:** resolved 2026-10-30 · Requested by Peter.
A strip fixed to the top of the viewport (`src/components/DocIdentityStrip.tsx`) appears
once the doc header has scrolled out of view and shows the handle (`CASE-<n>`,
`CASE-<n>#<seq>` for a response, else the template), the title and the document ID with a
copy button. A reading aid only: nothing in it changes the document (spec §11).

- **`app` backfill on dev-test**: run 2026-10-19; a later dry run the same day finds nothing
  left to tag (the remaining untagged documents have no app-YAC author, as on every
  instance).
- **`kb_refs` array references not existence-validated** (CASE-550, implemented): WIP
  now checks each array-of-reference item like a single reference.
- **Corpus namespace dual-sourced** (CASE-551, implemented): the client reads its
  namespace from `GET /api/app-config` at boot (`src/lib/namespaces.ts`); no
  `VITE_KB_NAMESPACE` bake.
- **YAC_MEMORY deletes don't propagate** (CASE-507/906): a directory mirror retires what
  that folder mirrored before and has dropped; `--retire` is the whole-owner cleanup.
- **Gene-pool `/wip-report` memory step not pushed** (CASE-524): the step is on
  World-in-a-Pie `develop` in both scaffold masters.
- **`--refresh` deletes `docs/playbooks/case-workflow.md`** (CASE-522, implemented).
- **Plain `.tar` tooling archives** (CASE-889): PROJECT.tooling now allows only
  `application/zip` and `application/gzip`, the types WIP's default upload allowlist
  stores (template v2, `tools/narrow-tooling-types.py`); the client refuses a plain
  `.tar` with "gzip it first".
- **UI writes attributed to `WEB-UI`**: since 2026-10-19 the server stamps the signed-in
  user's email (`server/ui-author.ts`) on case responses and flags written from the UI;
  `WEB-UI` remains only for an install without login. Older UI writes keep `WEB-UI` or
  `user`.

## Intentionally simple (do NOT "fix")

- **Read-mostly UI; a fixed set of writes.** The browser can write only what the guards
  admit: flag-for-YAC (`server/wip-proxy-guard.ts`), case close/reopen, topics and the
  relationship picker's three edge types (`server/kb-ui-guard.ts`), and admin-only
  vocabulary curation (`server/vocab.routes.ts`). No document editor, no
  assignment buttons. A new UI write needs a guard entry and Peter's call (spec §11).
- **Three fixed prepare-prompt buttons.** Clipboard helpers from a const array; no
  per-doc-type variation. Adding a 4th intent = edit the list.
- **Stateless client.** No local index/DB/prefs cache. Search/indexing is
  reporting-sync's job; don't add a client-side index.
- **No schema reconciliation on launch.** Use-on-exists is deliberate (rolling
  redeploys come up clean). New doc-types reach an existing namespace by deliberate
  creation, not by redeploy.
