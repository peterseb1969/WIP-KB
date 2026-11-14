# CHANGELOG — WIP-KB

Human-readable evolution (one entry per logical change, not per commit). Older work
than 2026-06-21 is in git history and DESIGN.md's Phase notes.

## 2026-11-14 — "Ready to implement" filter

- **Added (UI):** a "ready to implement" stat beside open / responded on the home
  page and the case list. It links to the case list filtered to cases with an
  outstanding implement flag (`flag=implement`, removable as a filter chip).
- **Fixed (UI):** an implement flag stops counting once its case is implemented
  or closed, even if nothing ever picked it up. On canonical, five finished cases
  (512, 1101, 1284, 1293, 1298) still had such flags, so their one-click implement
  button was greyed out and they would have counted as ready to implement.
- **Tests:** e2e caselist.spec.ts (the filter lists only flagged, unfinished cases).

## 2026-11-14 — Implement means every item; questions carry a recommendation (CASE-1316)

- **Changed (playbook):** an implementation does every item in scope. The only
  item left undone is one that needs the owner's answer, and then the case is not
  implemented: the implementer posts a `respond` with `## Questions` and parks the
  implement claim. "Left open" or "deferred" by the implementer is not allowed.
- **Changed (playbook):** each question to the owner has context, at least two
  options with consequences, and a recommendation.

## 2026-11-14 — One-click implement flag

- **Added (UI):** "Flag: implement → BE-YAC" beside the respond button on a case
  page, and "Implement" on each case-list row. On the list it is live only on a
  responded case; a case page can flag any case. It replaces the "Flagged:
  implement" chip: while an implement flag is pending, the button itself is greyed
  out, and on a case page it reads "Flagged: implement". It is also greyed while
  an implement claim holds the case.
- **Tests:** e2e caselist.spec.ts (the button on every row, greyed on an open case
  and on a case with a pending implement flag).

## 2026-11-13 — An answered case goes to implementation (CASE-1315)

- **Changed (UI):** the Answer box asks what happens next: implement (the
  default), respond again, or nothing. Before, it always raised the respond flag,
  so every answered case came back as another respond task.
- **Added (UI):** a pending implement flag shows as "Flagged: implement" beside the
  flag button on the case page and the case list. `fetchOutstandingFlags` clears
  an implement flag at a later implement or close.
- **Fixed (UI):** the confirmation after answering a waiting case no longer
  disappears when the case stops waiting.
- **Tests:** e2e answerbox.spec.ts (the default), flagdialog.spec.ts (the worker choice).

## 2026-11-13 — A flag says kind, owner and worker (CASE-1291)

- **Added (data model):** `FLAG_RECORD` gains `kind`, the kind of work as a `CLAIM_KIND`
  term (the same value as `flag_type`, which as an identity string cannot change type),
  and an optional `worker`, a reference to an `AGENT_IDENTITY`. `AGENT_IDENTITY` becomes
  the worker record: `performs` (CLAIM_KIND), `serves` (owners), `active`, `runs`.
  `tools/migrate-agent-model.py` brings an existing namespace along (dry run by
  default, `APPLY=1`, idempotent).
- **Changed (vocabularies):** every session role is an owner. `KB_TARGET_YAC` gains
  APP-AA, APP-COO, APP-DND, APP-PBSCT, APP-SONG and APP-VAL; BUG-YAC and DOC-YAC are
  deprecated. Adding a session role in the vocabulary settings adds the owner too.
- **Added (gateway, client):** `GET /flags` returns `kind` and `worker` and filters
  on both; `kbc case-fetch.py flags --kind/--worker`.
- **Added (UI):** the flag dialog offers a worker when one performs the kind for the
  owner; the server guard sets `kind` on every flag the browser creates.

## 2026-11-13 — An owner's answer counts wherever it is written (CASE-1313)

- **Added (data model):** `CASE_RESPONSE` gains an optional boolean `owner_answer`:
  the response records the project owner's answer, written down by a session.
  `tools/add-response-owner-answer.py` adds it; nothing is backfilled.
- **Changed (waiting rule):** questions stop waiting at a later response by a person,
  one marked `owner_answer`, or an `implement` or `close` (`server/lib/case-thread.ts`
  `answersOwner`, shared by the gateway and the UI).
- **Added (client 5.7.0):** `kb-write.py --owner-answer`, refused where the namespace's
  template lacks the field. The client runner is installed executable.

## 2026-11-13 — Questions for the owner: find them, answer them (CASE-1290)

- **Added (data model):** `CASE_RESPONSE` gains an optional `questions` integer: how
  many questions the response's `## Questions` section puts to the owner. Seeded;
  `tools/add-response-questions.py` adds it to an existing namespace (one version
  event, merged into `cross_version_view`) and backfills the responses that already
  have the section, re-posting only those, pinned to the new version, data unchanged
  (dry run by default, `APPLY=1`, idempotent).
- **Added (client 5.6.0):** `kb-write.py` counts the questions (top-level list items;
  a prose paragraph is one) where the namespace's template has the field.
  `case-fetch.py list --questions`; the Thread column says "N questions for the owner".
- **Added (gateway):** `GET /cases` gives `awaiting_owner` and `open_questions` per
  case and filters with `questions=1`. Waiting means the latest response with questions
  has no later response by a person (an email author or WEB-UI) and the case is not
  implemented or closed; the rule is `server/lib/case-thread.ts`, shared with the UI.
- **Added (UI):** a "Waiting for you" panel on the home page, a "N questions" chip in
  the case list, and an Answer box on the case page: a comment under the signed-in
  user, then (by default) the case's respond flag raised again for its target.
- **Changed (playbook):** `## Questions` is for the project owner only; how the owner
  sees and answers them. CLAUDE.md's write-discipline section now lists every UI write
  the guards admit.

## 2026-11-13 — Everything in progress, in one view (CASE-1285)

- **Added (gateway):** `GET /server-api/kb/claims` lists every claim holding a case
  across the KB (parked first, then by soonest lease end) with its case's title and
  status, and separately the claims whose lease ran out without a release.
  `GET /cases` gains `claimed=held|none`.
- **Added (client 5.5.0):** `case-fetch.py claims` (`--kind`, `--holder`,
  `--state active|parked|lapsed`, `--format json`); `list --claimed` / `--unclaimed`.
- **Added (UI):** an "In progress" panel on the home page, hidden when nothing is
  claimed.
- **Changed:** the "holds" rule as SQL (`sqlHolds`, `sqlLapsed`) lives in
  `server/lib/claims.ts` beside `holds`, shared by the gateway and the UI. The Client
  page's endpoint table also catches up with CASE-1281 (`unanswered=`) and CASE-1041
  (who may create a knowledge base).

## 2026-11-13 — Case lists show the thread: reopened or never answered (CASE-1281)

- **Added (gateway):** `GET /server-api/kb/cases` gives each case its thread when
  reporting can read it: `responses` (counts by kind), `reopened`, `reanswered`,
  `unanswered`. `unanswered=1` lists only open cases never answered that are not
  reopens. One reporting query per page; reporting keeps only a case's latest
  version, so "reopened" is read from an implement or close response in the thread.
  For an open case with no answer, which could be a reopen from before threaded
  responses, the case's earlier versions are read instead. The rule lives in
  `server/lib/case-thread.ts`, shared with the UI.
- **Added (client 5.4.0):** `case-fetch.py list` has a Thread column
  (`R1 I1 C3 · reopened`), the same fields in `--format json`, and `--unanswered`.
- **Added (UI):** the case list shows the counts and a `reopened` / `unanswered`
  chip beside the claim chips.

## 2026-11-13 — A new knowledge base needs no platform-admin key (CASE-1041)

- **Changed (gateway):** `POST /server-api/kb/namespaces` seeds with the app's own
  key instead of the caller's. WIP lets that key create only a namespace the operator
  reserved for the KB app, so a corpus the app cannot see can no longer be created
  (the `kb-work` state on the sandbox on 2026-11-01). Run before the reservation, the
  request is refused with 409 `not_reserved`, naming the operator step for a deployed
  and for an attached KB, and nothing is created.
- **Changed (who may):** the caller must hold admin on the main corpus (`kb`); a key
  with write only, such as the one agents use to file cases, gets 403. Peter's
  decision on the case's open question. No platform-admin key is needed any more.
- **Docs:** `kb-namespace.py` help (client 5.3.1), the playbook's knowledge-base
  steps, ARCHITECTURE.md, CLAUDE.md.
- **Fixed (client 5.3.2):** `kb-namespace.py` exited 2 (transport failure) on every
  gateway refusal, because it looked for "HTTP 4" in a message that carries only the
  gateway's text. A refusal (403, 409) now exits 1, as its help says. Found on prod.

## 2026-11-12 — A response names the files it touches, as data (CASE-1261)

- **Added (playbook):** the respond section prescribes one body for every response,
  attended or unattended: a bottom line, `## Files in scope` (one bullet per path,
  marked `change` or `read`), `## Analysis`, `## Verified vs not`; about 600 words,
  1,000 at most. Respond and implement now start with a claim and end with its release.
  The responder takes the whole view (is the scope right, does the fix fit the repo's
  conventions, does it apply beyond the request) and raises anything bigger than the
  case asked for as a question, not a recommendation: a `## Scope` section (as filed /
  widened / narrowed / different fix, with evidence), an optional `## Questions`, and
  the recommendation *question for the project owner*. The implementer stays in scope
  and stops when a finding challenges its instructions (Peter, via FRanC on CASE-1261#2).
- **Added (data model):** `CASE_RESPONSE` gains two optional `array<string>` fields,
  `files_change` and `files_read`. Seeded for new namespaces;
  `tools/add-response-files.py` adds them to an existing one in one version event and
  extends `reporting.cross_version_view` so the entity view `doc_case_response` has
  both columns (dry run by default, `APPLY=1`, idempotent). Existing responses are
  untouched. A scheduler finds two cases changing one file with a query on
  `files_change`.
- **Added (client 5.3.0):** `kb-write.py` copies a response's `## Files in scope`
  section into the two fields, and warns (never refuses) when a respond lacks the
  section or has a bullet it cannot read. It sends the fields only where the
  namespace's template has them, so the image and the migration can reach an instance
  in either order. Values set explicitly win.
- **Added (gateway):** `GET /server-api/kb/types` lists each type's field names
  (`fields`).

## 2026-11-12 — An implement response citing an all-digit commit hash is checked

- **Fixed:** `kb-write.py` took a token as a commit hash only if it held both digits
  and a-f letters, so a short hash made only of digits (e.g. `21137700`, about 2% of
  8-character hashes) was ignored: the response warned that it "cites no commit hash",
  and the hash was not checked against the remote. A digits-only or letters-only token
  now counts when it resolves to a commit in the repo; numbers and words that are not
  commits stay ignored. Client 5.2.2. Reported by a YAC posting an implement response.

## 2026-11-11 — Claims: who is working on a case (CASE-1259)

- **Added (data model):** vocabularies `CLAIM_KIND` (respond, implement, fix, review)
  and `CLAIM_STATE` (active, parked, released); template `CASE_CLAIM`, identity
  `[case_number, claim_kind, holder]` (one document per holder's claim, its versions
  the claim's history); template `CLAIM_RULE`, identity `[claim_kind]` (max_holders,
  excludes, lease_minutes per kind; defaults 1 / none / 60 without a document). A new
  kind is a term plus an optional rule document. Seeded for new namespaces;
  `tools/add-case-claims.py` adds them to an existing one (dry run by default,
  `APPLY=1`, idempotent; only additions).
- **Added (gateway):** `POST /server-api/kb/claims/:n/:kind` with
  `{action: acquire|renew|park|release, holder, note?}`. An acquire is written, then
  judged against every claim holding the case (read from the document store, not
  reporting), and refused with 409 naming the holder when the kind's rule does not
  allow it; the refused claim is recorded as released. Claim changes on one case run
  one at a time. `GET /cases/:n` and `GET /cases` carry each case's claims.
- **Added (client 5.2.0):** `kbc kb-write.py CLAIM acquire|renew|park|release <case>
  <kind> [--note …] [--holder ID]`; the case read shows `> **claimed:** …` first, and
  the list has a Claimed column. The served playbook explains when to claim.
- **Added (UI):** a claim chip on case rows and the doc page; the quick flag is not
  offered while a respond claim holds the case.
- **Checked:** on the sandbox: lifecycle (acquire, refused second holder, renew,
  park holds, release frees), a rule excluding respond from implement in both
  directions, a five-way acquire race three times (exactly one winner, recorded
  refusals naming it), the client verbs and display, and the UI chip and disabled
  flag. Unit tests for the rule decisions (7).

## 2026-11-09 — A flag counts until it is answered; the list flags open cases only

- **Fixed:** the quick flag greyed out only while a flag waited for dispatch, about
  30 seconds. After that it was live again, and each click re-armed the flag, which
  was dispatched again and could produce another response (on canonical, CASE-1229 and
  CASE-1230 each received two). A respond flag now counts as **outstanding** until a
  response on the case is created after it: pending dispatch, or dispatched and
  unanswered. While it is outstanding the button is disabled, in the list and on the
  doc page, and its tooltip says which of the two it is.
- **Changed:** the case list offers a live Flag only on an **open** case. Responded,
  closed and implemented cases show it disabled, with the reason. Clicking down a list
  filtered to "open or responded" therefore queues only unanswered cases. To ask for
  another response on an answered case, flag it on its page.
- **Fixed:** a click left the button live again after 2.5 s, before reporting had
  the new flag. It now stays disabled.
- **Checked:** on the sandbox, the full cycle on one case: flag from the list (greyed,
  and still greyed after reloads), marked dispatched (doc page: "awaiting response"),
  a response added (the button is live again). e2e: a responded case's row button is
  disabled.

## 2026-11-09 — Canonical is prod.internal; the KB is https://kb.prod.internal/

- **Changed:** canonical moved with the apps-at-root cut-over, from `kb.internal`
  (install `kb`) to `prod.internal` (install `prod`). The client's fallback URL is
  `https://kb.prod.internal` (client 5.1.1: `install.sh`, `kb-client.sh`,
  `kb_client_core.py`); CLAUDE.md's Backend Target names the new canonical and says
  the old install is still up, pre-cut and not a target.
- **Fixed:** the canonical-write guard (`.claude/hooks/block-canonical-writes.sh`)
  matched only `kb.internal`, so it stopped guarding the moment canonical moved. It
  now guards `prod.internal` and `kb.internal` and any subdomain of either
  (`prod-test.internal` stays free), and its `-d` write indicator counts only inside a
  curl command (`tr -d` no longer trips it).
- **Every clone:** set `kb_app_url` to `https://kb.prod.internal` and `kb_api_key_file`
  to the `prod` install's client key in `.claude/kb.json`, then re-run the install
  one-liner (a cached 4.x client builds `/apps/kb` URLs and cannot refetch itself).

## 2026-11-09 — A case can be named as the KB prints it: CASE-1179

- **Fixed:** `kbc case-fetch.py case CASE-1179` failed with "case identifier must be
  an integer"; agents type the handle the KB prints. Client 5.1.0 accepts `1179`,
  `CASE-1179` (any case) and `#1179` everywhere a case number is wanted, and
  `case CASE-1179#3` reads response 3. In writes, `case_number:` frontmatter,
  `--match case_number=…` and an edge's `CASE_RECORD` target key reach the gateway as
  the integer.
- **Fixed (gateway):** an edge target key or a patch match spelled `CASE-1179` for an
  integer identity field is matched as the number. Before, the equality filter on the
  string found nothing: the edge stayed silently unlinked, or the patch answered 404.
  This also covers clients older than 5.1.0.
- **Checked:** on the sandbox: `case CASE-970` and `case CASE-970#1` read the case and
  its response, a bad handle names the accepted forms, and a raw gateway patch matching
  `case_number: "CASE-970"` found the case.

## 2026-11-08 — Flag cases from the list; see which await a response; jump to top

- **Added:** every case row in the list (Search, cases filter) has a one-click
  **Flag** button beside it: the same respond → BE-YAC flag as the doc page's quick
  flag, so a case can be flagged for review without opening it. It is the same single
  UI write (a FLAG_RECORD plus its FLAGGED_FROM edge).
- **Added:** a case that already has a **pending** respond flag (written, not yet
  dispatched: `doc_status` still `published`) shows its flag button greyed out and
  disabled ("Flagged" in the list, "Flagged: response pending" on the doc page). One
  reporting query per result page decides it; a flag named by the case's handle
  (`CASE-<n>`) instead of its document ID counts too. Once the flag is dispatched the
  button is live again, and a click re-arms the flag.
- **Added:** the identity strip that stays at the top of a scrolled document has a
  **Top** button that scrolls back to the start of the page.
- **Checked:** on the sandbox, a click on a row's Flag wrote a pending flag on a case,
  and the list and the doc page then showed it greyed out (e2e `caselist.spec.ts`,
  and the strip's jump in `doc.spec.ts`).

## 2026-11-08 — The KB is served at the root of its own origin (CASE-1103 / CASE-1115)

- **Changed (breaking, hard cutover):** the platform no longer serves apps under
  `/apps/<label>`. The KB is at `https://kb.<WIP host>/` on every install, with no path
  prefix and no redirect for old links. The image builds with Vite's default base `/`,
  the server mounts every route at `/`, and nothing reads `APP_BASE_PATH` or
  `VITE_BASE_PATH`. An install still on pre-cut images cannot serve this image.
- **Changed:** `kbc` 5.0.0 builds `<kb_app_url>/server-api/…`; `KB_APP_BASE_PATH` is
  gone. A cached 4.x client cannot refetch itself through the old path: re-run the
  install one-liner (`<kb_app_url>/server-api/kb-client/install`). A failed fetch now
  says why: a login redirect or a 404 means the URL is not the KB's API at that
  origin's root. The fallback URL is canonical's KB origin, `https://kb.kb.internal`.
- **Fixed:** a Registry outage is no longer reported as "absent". The platform now
  answers it with 503 (not 404 or an empty list): the gateway passes 503 through, and
  only a 404 means "not found" / "unknown type" / "no profile". A search names the
  namespaces whose search failed (`unavailable_namespaces`) instead of returning silent
  zero hits, and fails outright when every namespace failed. A bootstrap whose
  namespace listing fails stops rather than seeding every namespace.
- **Checked:** on the sandbox, which already runs the post-cut platform: e2e 12 passed
  (3 corpus tests skipped), `kbc` and the install one-liner at the root, and the outage
  paths with the Registry stopped.

## 2026-10-31 — The KB starts even when the platform's MCP server is not ready (CASE-1001)

- **Fixed:** after a redeploy the KB's server could exit for good. It connected the
  askBar's MCP client before listening, with no retry, and the MCP server answers 503 while
  it cannot reach the Registry; one such answer reached `process.exit(1)`, and the
  container stayed up (Vite) with no server behind it.
- **Changed:**
  - The server listens first; the askBar's MCP connection comes up in the background and
    retries transient failures (503, refused connections, timeouts) with growing delays
    (1 s → 30 s, indefinitely). A rejected key (401/403) stops and is logged.
  - The MCP client is published only after it has connected and listed its tools, so
    "agent ready" is never reported for a dead connection.
  - While it connects, `/api/ask` answers 503 with the reason; `/api/health` is unchanged
    and stays independent of the platform (deployable-app contract).
- **Checked:** on the sandbox with the Registry stopped: the server came up, the health
  check answered 200, the askBar 503; after the Registry started, the agent connected on
  its fourth attempt and the askBar answered again.
- **Tests:** `server/lib/agent-retry.test.ts` (`npm run test:gateway`).

## 2026-10-30 — The doc view keeps the document's identity in sight

- **Added:** on a long document, once its header scrolls away, a strip fixed to the top of
  the window names it: the handle (`CASE-957`, `CASE-957#2` for a response, or the
  document's type), the title, and the document ID with a copy button. It hides again
  when the header is back in view. Reading aid only; it changes nothing.
- **Checked:** in Chrome against the sandbox, on CASE-957 and on a response of it: absent at
  the top of the page, present at the bottom with the right handle.

## 2026-10-30 — A patch that matches nothing is reported, not passed off as success

- **Fixed:** a patch whose match names no document (`kb-write.py CASE_RECORD --patch
  status=… --match case_number=<missing>`) printed `? ()` and exited **0**. The gateway
  answered 404, and the client read every 404 as "route absent". A write's 404 that
  carries the gateway's reason now prints `rejected — … not found` and exits 1. Reads
  are unchanged (a missing case is still "not found"), and so is the server's own
  route-absent answer. Client 4.10.0.
- **Tests:** `kb-client/test_write_404.py` (in `npm test`), against a local stand-in
  gateway.

## 2026-10-29 — A patch changes exactly the one document its match names (CASE-972)

- **Fixed:** a patch write (`kb-write.py <TYPE> --patch … --match k=v`) could change the
  wrong document. The client sent only the last `--match`, the gateway read only the
  match's first key, and it patched the first hit without checking how many matched.
  Correcting one case response by `--match case_number=959 --match response_seq=3`
  replaced the text of another case's response.
- **Changed:**
  - `--match` repeats, and every pair is sent.
  - The gateway filters on every match key (AND) and refuses a match that several
    documents satisfy with **409** `ambiguous_match`; no hit is still 404.
  - `document_id` must stand alone (422 otherwise).
  - Several active versions of one document count as one match.
- **Tests:** `kb-client/test_patch_match.py` (in `npm test`), and
  `server/lib/patch-match.test.ts` (`npm run test:gateway`, plain `node --test`; not in
  CI, whose runner may lack a Node that runs TypeScript directly).







## 2026-10-20 — Tooling archives: zip or gzip only (client 4.6.1)

- **Changed:** PROJECT's `tooling` field allows only `application/zip` and
  `application/gzip` (template v2 via `tools/narrow-tooling-types.py`; seed updated).
  It listed `application/x-tar` and `application/x-gzip` too, which WIP's default
  upload allowlist refuses, so a plain `.tar` passed the KB's check and failed at
  upload. `kb-write.py PROJECT --tooling` now refuses a `.tar` up front and says to
  gzip it. v1 stays active for existing profiles; none holds a `.tar`.

## 2026-10-19 — UI writes name the signed-in user; KB_TOPIC editable in Settings

- **Changed:** case close/reopen responses and flag-for-YAC records written from the UI
  are attributed to the signed-in user's email, set server-side by the guards from the
  gateway's `X-WIP-User` (or the OIDC session), whatever the browser sent. An install
  without login still records `WEB-UI`. The Author facet lists email authors.
- **Added:** Settings → Vocabulary edits KB_TOPIC. A new topic may name a parent and the
  relation to it (`part_of` or `is_a`), stored as a WIP term relation; the list shows
  the taxonomy as a tree. Adding an existing topic that has no parent, with a parent,
  links it (the repair for an add whose link failed); cycles are refused. Seed drift
  now compares each topic's parent link and gives the `ontology.relationships` entry
  for a topic missing from the seed. Still add-only: no moving or retiring.

## 2026-10-19 — Attach a project's tooling archive from the client (CASE-889; client 4.6.0)

- **Added:** `kbc kb-write.py PROJECT --tooling PATH` attaches or replaces a project's
  tooling archive, either alone (`--match app=<project>`, or kb.json's `project`) or
  in the same command that writes the profile. It posts the archive raw to the new
  gateway route `POST /projects/:app/tooling`, which checks it against the PROJECT
  template's file config, uploads it to WIP with the caller's key and links it to the
  profile. The archive it replaces stays in WIP, unreferenced (the `retain` default).
  If linking fails, the new upload is soft-deleted and both ids are reported.
- A project without a profile is refused (write the profile first). A plain `.tar` is
  refused by WIP's default upload allowlist even though the template lists
  `application/x-tar`; gzip it. The browser bridge stays closed to the route
  (`kb-ui-guard` already refuses it); the UI only downloads.
- The manual two-step route (WIP file API, then `--patch tooling=`) is gone from the
  Client page and the playbook.

## 2026-10-19 — Memory retirement that is safe for parallel clones (CASE-906; client 4.5.0)

- **Changed:** a directory mirror (`kb-write.py YAC_MEMORY <dir>`, what session end
  runs) retires again by default, but only the memories **this folder** mirrored last
  time and no longer has. Each folder keeps that list in `.kb-mirrored.json` (per
  instance, namespace and owner; the mirror reads only `*.md`). A role mirrored from
  several clones (BE-YAC runs four) can no longer retire another clone's memories; a
  key deleted in one clone but kept in another flips once and the other's next mirror
  revives it. A folder's first run only records; a run with a transport failure
  neither retires nor records; a folder whose last file was deleted still retires it.
- `--retire` stays as the explicit whole-owner cleanup for legacy stale memories (and
  refuses an empty folder); `--no-retire` skips retirement and leaves the record.
## 2026-10-19 — Memory retirement is off by default (CASE-906; client 4.4.1)

- **Fixed:** the session-end memory mirror retired every record of the owner whose
  file was missing from the folder it was given. BE-YAC runs as four parallel clones,
  each with its own memory folder, so each BE-YAC session end retired the other
  clones' live memories (40 wrongly retired on canonical by 2026-10-19), and the next
  close from another clone revived its own. Retirement now runs only with `--retire`,
  for an owner whose folder is its only one. A safe automatic retirement (per-folder
  record of what it mirrored) is the follow-up.
## 2026-10-19 — Mirrors no longer strip a document's project tag

- **Fixed:** session and memory mirrors (natural upserts) replace a record's data, so
  an `app` tag the source file does not carry was dropped by the next mirror from a
  repo without `project` in kb.json. The 2026-10-14 backfill had tagged records whose
  files carry no such field, and within four days 87 `YAC_MEMORY` records on canonical
  had lost it (all of APP-AA, APP-KB and APP-RC's, 47 of BE-YAC's), as had sessions
  closed since, so project briefs went thin (KB's newest session read 4 August).
  The gateway now carries curated fields the writer omits (`topics`, `repo_id`, and
  now `app`) on the natural-upsert path too, looking the stored document up by its
  identity fields; an explicit value still wins. `YAC_MEMORY.doc_status` is not
  carried, so a returning memory file still revives its record.
- **Repair:** re-run `tools/backfill-app.py` after this is deployed (before it, the
  next mirror strips the tags again). Localhost: 61 memories + 8 sessions re-tagged.
## 2026-10-19 — Project brief: real ordering, no retired memories (CASE-906; client 4.4.0)

- **Fixed:** every brief section was ordered by `updated_at`, which a migration
  re-stamps wholesale (the `app` backfill gave ~450 documents the same timestamp), so
  "Recent sessions" showed May sessions dated 2026-10-14 and could miss the active one.
  Sessions are now ordered by `started_at`, everything else by `created_at`. The CLI
  and the project page show that date.
- **Added:** `YAC_MEMORY.doc_status` (optional `KB_DOC_STATUS` term;
  `tools/add-memory-doc-status.py` adds it to a live namespace). The memory mirror
  (`kb-write.py YAC_MEMORY <dir>`) marks the owner's records whose file is gone from
  the directory as `deprecated`, by re-submitting each record's data with the field (an
  upsert by `(owner, mem_key)` onto the latest template version; a PATCH would be
  validated against the older version the record is pinned to, which lacks the field). A single
  file never retires anything, a file that cannot be parsed still counts as present,
  and `--no-retire` skips retirement for an incomplete directory. A file that comes
  back revives its record. The brief leaves deprecated memories out; nothing is
  deleted.
## 2026-10-19 — Missing API routes answer 404 JSON in production (CASE-888)

- **Fixed:** in production, a request for an API route the server does not have
  (`/api`, `/auth`, `/wip`, `/server-api`, `/mcp`, any method) fell through to the SPA
  fallback and got `index.html` with 200. It now gets `404 {"error":"not_found"}`, so a
  client newer than the server it calls sees a missing route as missing. Page routes
  (`/doc/…`, `/project/…`, even `/apiary`) still get the SPA. The client's content-type
  check stays for servers not yet updated.
## 2026-10-15 — Client page and playbook catch up with projects and knowledge bases

- **Changed:** the Client page gains a **Projects** section (what a project is, the brief
  and its `/project/<project>` page, automatic tagging from `kb.json` `project`, project
  search and filters, creating a profile, adding the `KB_APP` term) and a **Knowledge
  bases** section (`kb-namespace.py create`, `kb.json` `namespace`, `--namespace`, the
  `/ns/<name>/` address). Quick start shows the brief. Auth & config lists all four
  `kb.json` keys and their environment overrides.
- **Changed:** the case playbook documents `search --namespace` / `--project` and has a
  "Projects and knowledge bases" section.
- Stated plainly: the client cannot upload a tooling archive yet; the page says how to
  attach one by hand.
## 2026-10-14 — Response links on the case page (CASE-829)

- **Fixed:** a relationship whose source is a case *response* (e.g. CASE-827#3
  REFERENCES a fireside) was stored but shown nowhere: the case page only asked for the
  case's own relationships. The thread now lists each response's links under its text,
  with a count on the collapsed header. One reporting query covers the whole thread.
  Today's data has 122 such links, all REFERENCES and all outgoing; links pointing at
  a response would show too (prefixed ←), but none exist.
- **Fixed:** the neighbourhood graph's "more neighbours" marker counted every edge
  three times (per-version table, `__entities` relation and entity view), so a
  neighbour linked only to the page still showed the marker.

## 2026-10-14 — Gateway no longer rewrites term identity values

- **Removed:** `canonicalTermIdentity()`, which rewrote a term-valued identity field
  (e.g. `PROJECT.app`) to the term's canonical value before every write. WIP now builds
  identity from the term a value resolves to (CASE-847), so aliases cannot fork a
  document without it, and every write saves one def-store lookup per such field.
- **Changed as a result:** `data.app` stores the spelling the writer sent, as WIP
  intends (the resolved term is stored beside it). Facets, project filters and the
  brief all read the resolved term, so they are unaffected.
- Verified on localhost: three PROJECT writes as `ct`, `ClinTrial Explorer` and
  `CLINTRIAL` updated one document (version 3).

## 2026-10-14 — Seed vocabularies brought up to date

- **Changed:** `KB_APP` seed gains `web` and `KB_TARGET_YAC` gains `WEB-YAC`, both
  already live on canonical, so new domains and fresh bootstraps get them.
- **Changed:** dropped nine `KB_APP` aliases that only re-case the term's value or
  another alias (`kb`, `reactconsole`, `RC-Console`, `clintrial`, `authorassist`,
  `song`, `dnd`, `validator`). WIP discards such aliases on write; they resolve the
  same without them.
- Verified: a fresh localhost domain seeded from these files matches them exactly.

## 2026-10-14 — The browser's gateway bridge allows only the UI's own writes

- **Changed:** `/server-api/kb-ui` (the browser's route into the KB gateway, carrying
  the install's `wip-admins` key) now admits reads and exactly the writes the UI makes:
  relationships of the picker's three types, `WEB-UI` close/comment responses linked to
  their own case, a case status set to open or closed, and topics. Anything else,
  including creating a knowledge base, answers 405 (`server/kb-ui-guard.ts`).
- **Fixed:** UI writes went to the default knowledge base whatever domain was being
  viewed. Under `/ns/<other>/`, Close case patched the default domain's case with the
  same number, and Add relationship failed. Every bridge write now names the viewed
  domain.
- **Fixed:** the relationship picker hid a failed Add behind the target preview; the
  error now shows.

## 2026-10-14 — The browser's WIP proxy is read-only apart from flags

- **Changed:** `/wip` forwards with the install's API key, which is a `wip-admins` key,
  so any signed-in browser session could do anything an administrator can (delete a
  namespace, mint an API key). `server/wip-proxy-guard.ts` now lets through only
  GET/HEAD/OPTIONS, the four POST endpoints that are queries (document query,
  reporting search and query, registry lookup), and document creates whose every item
  is a `FLAG_RECORD` or `FLAGGED_FROM` document. Anything else answers 405 (403 for a
  disallowed document create) without reaching WIP.
- The proxy (`@wip/proxy` 0.5) streams request bodies, so the guard reads a body only
  for a document create, and forwards an allowed one to WIP itself.
- Not changed: the `/server-api/kb-ui` gateway bridge still exposes every gateway
  verb to a signed-in session.

## 2026-10-14 — Vocabulary on the Settings page (CASE-828)

- **Added:** an admin-only Vocabulary section on Settings: add a term to `KB_APP` or
  `SESSION_ROLE`, or an alias to one of their terms, in the knowledge base being
  viewed. Add-only; renaming and retiring stay in the WIP Console. `KB_TOPIC` is not
  included (a topic needs a parent and a relation).
- **Added:** `server/vocab.routes.ts` (`/server-api/vocab`, behind `requireAdmin()`).
  The alias merge happens on the server, because WIP's term update replaces the whole
  alias list. A spelling that already resolves to the term is a no-op; one that
  resolves to a different term is refused.
- **Added:** seed drift: each vocabulary lists how its live terms differ from
  `server/seed/terminologies/<T>.json` (missing from the seed, with the entry to paste;
  in the seed but not live; label / description / sort order / aliases differing).
  Aliases are compared by what they resolve to, since WIP drops case-only variants
  that older seed entries still list.

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
