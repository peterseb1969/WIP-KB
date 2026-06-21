# Case Workflow Playbook

Handler reference for the `/wip-case` slash command. The command reads this file
and dispatches on `$ARGUMENTS`.

**Cases live in the KB, not on disk.** There are no `yac-discussions/CASE-*.md`
files to scan, rename, or stage — the KB is the record. Every read and write goes
through the **served KB client** (`case-fetch.py` to read, `kb-write.py` to write),
which talks only to the KB **gateway** (never the document-store backend).

## Subcommands

- `/wip-case file [Peter comment]` — file a new case (bug, question, request, gap)
- `/wip-case list` — list open/responded cases
- `/wip-case read <n>` — read a case in full (body + all responses)
- `/wip-case respond <n>` — append a response (drives open→responded)
- `/wip-case comment <n>` — add a comment (any state; no transition)
- `/wip-case close <n>` — close without implementing (won't-fix / not-an-issue / deferred)
- `/wip-case implement <n>` — apply the proposed patch, then close as implemented

## Prerequisites

A session ID (see YAC Reporting in CLAUDE.md).

## The served KB client (one-time, self-refreshing)

Fetched from the running instance — version-matched, no FR-YAC dependency. Inputs
are the instance URL + your API key (both from `.claude/kb.json`):

```bash
curl -fsSk -H "X-API-Key: $(cat "$(python3 -c 'import json;print(json.load(open(".claude/kb.json"))["kb_api_key_file"])')")" \
  "$(python3 -c 'import json;print(json.load(open(".claude/kb.json"))["kb_app_url"])')/apps/kb/server-api/kb-client/install" | sh
```

That materializes the bundle into `~/.cache/wip-kb-client/`. Run everything through
the runner, which self-refreshes when the instance's bundle digest changes:

```bash
KBC="bash ~/.cache/wip-kb-client/kb-client.sh"
$KBC case-fetch.py …    # reads
$KBC kb-write.py …      # writes
```

If `~/.cache/wip-kb-client/kb-client.sh` is missing, re-run the install one-liner —
that is the whole recovery.

**One write surface.** All writes are `kb-write.py <TYPE> …` → the gateway's single
`POST /write/:type`. The gateway allocates the `case_number` + claims the `CASE-<n>`
synonym, scoped `CASE-<n>#<seq>` for responses, and persists edges. Status-transition
*validity* is enforced here in the playbook (compose only a legal transition); the
gateway is pure persistence.

Legal transitions: `open → {responded, closed, implemented}`,
`responded → {closed, implemented}`; `closed` / `implemented` are terminal.

---

## `/wip-case file`

1. **Time:** `date '+%Y-%m-%d %H:%M'`.
2. **Compose `case.md`** — frontmatter keys are CASE_RECORD fields; the markdown
   after the fence becomes the case body:

   ```markdown
   ---
   title: <short case title>
   authored_by: <your session ID>
   filed_by: <your session ID>
   doc_status: published
   status: open
   type: <bug | question | request | platform-gap>
   severity: <blocks-me | annoying | fyi>
   component: <wip-client | document-store | registry | scaffold | mcp-server | wip-react | wip-proxy | wip-auth | reporting-sync | other>
   app: <your app name, or "backend">
   target_yac: <FRanC | BE-YAC | any>
   ---

   ## Problem
   <what happened, with evidence — errors, behaviour, missing functionality;
   specific enough for a YAC with no knowledge of your app.>

   ## Expected
   <what should have happened.>

   ## Workaround
   <what you're doing meanwhile, or "None" if blocked.>

   ## Peter's Take
   <verbatim, only if Peter gave a comment with /wip-case file; else omit.>
   ```

3. **File it** (the gateway mints `case_number` + the `CASE-<n>` synonym; link any
   related cases as REFERENCES edges):

   ```bash
   $KBC kb-write.py CASE_RECORD case.md --edge REFERENCES:CASE_RECORD:12 --edge REFERENCES:CASE_RECORD:340
   # -> created CASE-<n> (<document_id>)  edges: REFERENCES→12=linked, …
   ```

4. **Confirm:** tell Peter the case number + document_id.

---

## `/wip-case list`

```bash
$KBC case-fetch.py list --status open,responded
# facets: --status (comma list) --filed-by --severity --type --component --app  --format table|json
```

APP-YACs: filter to your app (`--app <name>`) or cases you filed (`--filed-by <id>`).
BE-YACs: list all. If none, say "No cases" and stop.

---

## `/wip-case read <n>`

```bash
$KBC case-fetch.py case <n>
```

Prints the full case body. (Responses are separate CASE_RESPONSE docs; surface them
with `case-fetch.py` once a response view lands — for now the body is the record.)
If not found, tell Peter and stop.

---

## `/wip-case respond <n>`

**Analyse before responding — do not jump to implementation.**
1. Understand the root cause from the source, not the symptom.
2. Don't assume the filer's proposed fix is correct — check it against the platform
   (validation rules, identity scoping, bulk contracts, edge cases). Propose a better
   one if warranted, and say why.
3. If the proposed fix IS right, say so and show the analysis.
   (CASE-50 was implemented blindly and broke; CASE-36 was analysed properly. Be CASE-36.)

Then, two writes — the response doc + the status transition:

```bash
# 1) the response (compose response.md: body markdown; frontmatter sets the fields)
#    response.md frontmatter: case_number: <n> / response_kind: respond / author: <id> / doc_status: published
$KBC kb-write.py CASE_RESPONSE response.md --edge RESPONDS_TO:CASE_RECORD:<n>
# -> created CASE-<n>#<seq>  edges: RESPONDS_TO→<n>=linked

# 2) drive open → responded (only if currently open)
$KBC kb-write.py CASE_RECORD --patch status=responded --match case_number=<n>
```

Confirm the case number + new status to Peter.

---

## `/wip-case comment <n>`

A comment is a CASE_RESPONSE with `response_kind: comment` and **no** status change
(legal in any state, including terminal):

```bash
$KBC kb-write.py CASE_RESPONSE comment.md --edge RESPONDS_TO:CASE_RECORD:<n>
# comment.md frontmatter: case_number: <n> / response_kind: comment / author: <id> / doc_status: published
```

---

## `/wip-case close <n>`

Close without implementing (won't-fix / not-an-issue / deferred / handled manually).
Compose the resolution rationale, then response + transition:

```bash
$KBC kb-write.py CASE_RESPONSE close.md --edge RESPONDS_TO:CASE_RECORD:<n>
#   close.md frontmatter: case_number: <n> / response_kind: close / author: <id> / doc_status: published
$KBC kb-write.py CASE_RECORD --patch status=closed --match case_number=<n>
```

Terminal. Tell Peter it's closed and why.

---

## `/wip-case implement <n>`

The "do the work" command. Read the case (`case-fetch.py case <n>`); if it has no
proposed fix, tell Peter to `/wip-case respond` first and stop.

1. **Verify the proposed fix before touching code** — does the analysis convince you?
   Has the target code changed since the response? Side effects on other callers/tests?
   If anything is wrong, respond with your findings instead of implementing a fix you
   don't trust.
2. **Apply each change**; if quoted "current text" no longer matches, flag and skip it.
3. **Show the diff** (`git diff`) and let Peter review before committing.
4. **Record + close:**

   ```bash
   $KBC kb-write.py CASE_RESPONSE implement.md --edge RESPONDS_TO:CASE_RECORD:<n>
   #   implement.md frontmatter: case_number: <n> / response_kind: implement / author: <id> / doc_status: published
   $KBC kb-write.py CASE_RECORD --patch status=implemented --match case_number=<n>
   ```

Terminal. Tell Peter what was applied and that the case is implemented.
