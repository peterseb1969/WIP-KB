# KNOWN_ISSUES — WIP-KB

What's incomplete, deferred, or intentionally simple — so the next session doesn't
re-investigate solved problems, "fix" intentional choices, or miss real gaps.

## Open / deferred

### YAC_MEMORY deletes don't propagate (v1 limitation)
**Status:** deferred · **Severity:** low
The session-end fold-in upserts each `memory/*.md`, so adds/edits flow to kb. A
*pruned* memory (deleted locally) lingers `active` in kb. The fix is a session-end
reconcile pass (archive kb `YAC_MEMORY` docs for an owner whose `mem_key` is absent
locally) — a deliberate v2, not a blocker. (CASE-507.)

### Gene-pool `/wip-report` master not yet pushed
**Status:** deferred (cross-repo coordination) · **Severity:** low
The session-end YAC_MEMORY fold-in is in APP-KB's local `.claude/commands/wip-report.md`
(gitignored, so app-local) and in FRanC's `/wake`. The shared scaffold master was
committed by FRanC but not pushed (`World-in-a-Pie 3a46a2a2`, develop) pending
BE-YAC/Peter coordination + `setup-backend-agent.sh --refresh`. Until then app-YACs
use local copies. (CASE-524.)

### `create-app-project.sh --refresh` deletes a load-bearing served file
**Status:** known (BE-YAC) · **Severity:** medium
Every `--refresh` deletes `docs/playbooks/case-workflow.md`, which is served by
`kb-client.routes.ts:37` as the kb-client playbook. **You must
`git checkout -- docs/playbooks/case-workflow.md` before committing a refresh** and
not commit the `D` line. Filed CASE-522 (also covers a stale `mcp__wip-kb__`
allowlist the refresh re-adds).

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

## Intentionally simple (do NOT "fix")

- **Read-mostly UI; one write.** Only flag-for-YAC writes. No editor, no
  status/assignment/tag buttons — by design (spec §11). If tempted, surface as an
  open question.
- **Three fixed prepare-prompt buttons.** Clipboard helpers from a const array; no
  per-doc-type variation. Adding a 4th intent = edit the list.
- **Stateless client.** No local index/DB/prefs cache. Search/indexing is
  reporting-sync's job; don't add a client-side index.
- **No schema reconciliation on launch.** Use-on-exists is deliberate (rolling
  redeploys come up clean). New doc-types reach an existing namespace by deliberate
  creation, not by redeploy.
