# KB

## What This App Does

> TODO: Describe what this app does in one paragraph.

## The Golden Rule

> **Never modify WIP. Build on top of it.**

WIP is the backend. This app is a frontend that maps a domain onto WIP's primitives (terminologies, templates, documents) and presents them to users.

## Dev Namespace

Your development namespace is `dev-kb`. Use it for all data modeling during development.

**Why:** Terminologies and templates are hard to delete cleanly once documents reference them. A dev namespace lets you iterate freely — create, modify, delete, start over — without polluting production data.

**Workflow:**
1. Use `dev-kb` for all `/design-model` and `/implement` work
2. Create terminologies, templates, and test documents in this namespace
3. Iterate until the data model is stable
4. When ready for production, create a new namespace (e.g., `kb`) and recreate the finalized model there
5. Clean up the dev namespace with `dev-delete.py`:
   ```bash
   python tools/dev-delete.py --namespace dev-kb --force
   ```

**Important:** MCP tool calls use the privileged admin key, so always pass `namespace=dev-kb` explicitly. Your app's runtime key (scoped to one namespace) gets automatic namespace derivation — no `namespace` parameter needed in app code.

## API Key

The MCP server uses a privileged admin key (from WIP's `.env`). This is fine for data modeling via MCP tools.

**For your app's runtime API calls**, use the namespace-scoped key in `.env`.
No key was auto-provisioned (WIP may not have been running). Create one via the Registry API — see WIP's `docs/api-key-management.md`.

Save the `plaintext_key` from the response to `.env`:
```bash
WIP_API_KEY=<plaintext_key from response>
```

Because this key is scoped to a single namespace (`dev-kb`), WIP derives the namespace automatically when you omit the `namespace` parameter. This means synonym resolution works without passing `namespace` on every API call.

**Key management:** Runtime keys can be listed, updated, and revoked via the Registry API. See WIP's `docs/api-key-management.md` for details.

## Process

Follow the 4-phase development process. Start with:

```
/explore
```

**Core phases** (in order):
1. `/explore` — Read MCP resources, discover existing data model, understand the domain
2. `/design-model` — Map the domain to WIP primitives (user must approve before proceeding)
3. `/implement` — Create terminologies and templates in WIP, verify with test documents
4. `/build-app` — Scaffold and build the React/TypeScript application

**After Phase 4:**
- `/improve` — Iterate (add features, fix bugs, refine UI)
- `/document` — Generate README, ARCHITECTURE, etc.

**Available at any time:**
- `/wip-status` — Check WIP service health and data state
- `/export-model` — Save data model to git as seed files
- `/bootstrap` — Recreate data model from seed files
- `/add-app` — Add a second app that cross-references the first
- `/resume` — Recover context after compaction or at start of a new session
- `/report` — Capture fireside chat or trigger session summary

**Context management:** When context reaches ~70-80%, the human should tell you to run `/resume` or save state (DESIGN.md, memory files) before compaction hits.

## Namespace Bootstrap on Launch

Every WIP-consuming app must follow the **offer-on-empty / use-on-exists** discipline at runtime. Three rules:

1. **Namespace missing on launch** → show the user an explicit bootstrap offer. Do **not** auto-bootstrap silently. The user can either (a) confirm bootstrap or (b) restore from a backup via the WIP console / `wip-deploy` first and reload.
2. **Namespace exists on launch** → use it as-is. **No** schema reconciliation, **no** "templates differ" check, **no** merge logic. Rolling redeploys against an existing namespace must come up clean. A partially-bootstrapped namespace is the user's signal to use the console, not the app's signal to silently re-bootstrap.
3. **On user-initiated bootstrap** → write one **`BOOTSTRAP_RECORD`** audit doc capturing: `bootstrap_id`, `app_version`, `bootstrapped_at`, `commit_sha`, `templates_created`, `edge_types_created`, `terminologies_created`. This is the provenance trail any future YAC reading the namespace can rely on.

**Restore is not an app concern.** The bootstrap UI mentions restore as an alternative the user may prefer; it does not provide UI for it. Restore is console-initiated.

**Starting point — three template files** are copied into `templates/bootstrap/` of every new app project:
- `bootstrap.server.ts.template` — `checkStatus()` and `runBootstrap()` library functions, with the §3.4 deltas (post-rename term-relations API, BOOTSTRAP_RECORD writing) already applied
- `bootstrap.routes.ts.template` — Express `GET /server-api/bootstrap/status` and `POST /server-api/bootstrap/run` (SSE streaming for progress)
- `BootstrapGate.tsx.template` — React component that wraps the app and renders the four states (checking / unreachable / needs-bootstrap / bootstrapping / error / ready)

Read each template's header comment, fill in the TODO markers (namespace, app title), drop a `BOOTSTRAP_RECORD` template into `server/seed/templates/`, and you're done. The seed-file convention (`server/seed/terminologies/<VALUE>.json`, `server/seed/templates/<NN>_<VALUE>.json`) is documented in the server template's header.

## Reference Documentation

Read these before starting:
- `docs/AI-Assisted-Development.md` — 4-phase process, data model design guide, PoNIFs quick reference
- `docs/WIP_PoNIFs.md` — Full guide to WIP's 8 non-intuitive behaviours
- `docs/WIP_DevGuardrails.md` — UI stack, app skeleton, testing conventions
- `docs/ontology-support.md` — Term relations, polyhierarchy, typed relations, traversal queries
- `templates/bootstrap/*.template` — Bootstrap pattern starting points (see "Namespace Bootstrap on Launch" above)

## Key Identity Concepts

- **Identity hash ≠ canonical ID.** Identity hash = uniqueness key for upsert *within a specific template* — same field values under two different templates are two different documents. Canonical ID / synonyms = deterministic identification of exactly one entity across the entire system (Registry-resolved). When calling `createDocumentsBulk`, the identity hash is scoped to the template you pass — never assume it is unique across templates.
- **The Registry is the identity authority.** All identity resolution goes through the Registry. Do not implement app-side identity resolution by hash lookups — use the document_id returned by the API.

## MCP

WIP is accessed exclusively via MCP tools (88 tools, 5 resources). Before starting:
- Read `wip://conventions` — bulk-first API, identity hashing, versioning
- Read `wip://data-model` — terminologies, templates, documents, fields, term-relations
- Read `wip://ponifs` — 8 behaviours that trip up every new developer

`wip://development-guide` provides the full 4-phase workflow reference if needed.
`wip://query-assistant-prompt` provides a complete system prompt for NL query agents (used by --preset query apps).

## Client Libraries

For Phase 4 (app building), use @wip/client, @wip/react, and @wip/proxy:
- `libs/wip-client-README.md` — TypeScript client (6 services, error hierarchy, bulk abstraction)
- `libs/wip-react-README.md` — React hooks (TanStack Query, 30+ hooks)
- `libs/wip-proxy-README.md` — Express middleware for WIP API proxying with auth injection

Install from tarballs in `libs/`:
```bash
npm install ./libs/wip-client-*.tgz ./libs/wip-react-*.tgz ./libs/wip-proxy-*.tgz
```

## Dev Setup Gotchas

**TLS:** WIP uses a self-signed cert on `https://localhost:8443`. Node.js `fetch()` rejects self-signed certs. Add `NODE_TLS_REJECT_UNAUTHORIZED=0` to your `dev:server` script (NOT `start`/production). Production with proper certs needs no workaround.

**@wip/client baseUrl:** In browser apps behind a Vite proxy, use `baseUrl: '/wip'` (resolved to `window.location.origin + '/wip'`). Do NOT use a bare relative path without the client resolving it — `new URL('/wip/...')` throws without a protocol.

**@wip/react providers:** Hooks require BOTH `QueryClientProvider` (from `@tanstack/react-query`) AND `WipProvider` (from `@wip/react`). Missing either causes silent failure — hooks mount but never fetch, no errors.

## WIP Toolkit

`wip-toolkit` is a CLI for backup, export, import, and data migration. Install from the wheel in `libs/`:

```bash
pip install libs/wip_toolkit-*.whl
```

Key commands:
- `wip-toolkit export <namespace> <output.zip>` — Export namespace to archive
- `wip-toolkit import <archive.zip> --mode fresh` — Import with new IDs (cross-namespace)
- `wip-toolkit import <archive.zip> --mode restore` — Restore with original IDs (disaster recovery)

Remote WIP instances:
```bash
wip-toolkit --host pi-poe-8gb.local --proxy export wip /tmp/backup.zip
```

## Dev Delete

`tools/dev-delete.py` hard-deletes entities during iterative development.

```bash
# Dry run (default)
python tools/dev-delete.py --namespace myapp

# Actually delete
python tools/dev-delete.py --namespace myapp --force

# Remote MongoDB
python tools/dev-delete.py --mongo-uri mongodb://remote-host:27017/ --namespace myapp --force
```

Requires `pymongo`. For file/reporting cleanup also install `boto3` and `psycopg2-binary`.

## Session Awareness

You will be replaced. This session — including everything you learn, every correction Peter makes, every insight you gain — ends when your context fills or the task completes. The next agent starts from scratch with no memory of this conversation.

**Consequence:** Anything worth knowing must be encoded into a durable artifact before this session ends. If Peter corrects your approach, consider whether the correction belongs in:
- A `/lesson` entry (quick, structured, for future gene pool review)
- A session report "Dead Ends" section (for the next YAC continuing this work)
- A CLAUDE.md update (if Peter agrees it's universal)

Do not say "got it, won't happen again" unless you have written the lesson down. The next agent will make the same mistake unless you leave a trace.

## Scope Budget

Most tasks should complete within a predictable number of commits. If you find yourself significantly exceeding expectations, something is wrong — a misunderstanding, a rabbit hole, or a task that needs decomposition.

**Commit heuristics:**
- A bug fix: 1-3 commits. If you're past 5, stop and report what's blocking you.
- A feature addition: 3-7 commits. If you're past 10, stop and reassess scope with Peter.
- A refactor: 2-5 commits. If you're past 8, you're probably changing too much at once.

**Context window awareness:** You can check your own context usage:
```bash
cat .claude-context-pct
```
This file is written to your project directory by the status line. Check it periodically — especially before starting a new subtask.
- **Past 50%:** Ensure your session report and dead ends section are written. You are halfway to replacement.
- **Past 75%:** Stop working and write your session summary. Do not push through hoping to finish — the next YAC picks up faster from a clean summary than from a half-finished sprawl.

When stopping for any reason, write a clear status report: what's done, what's left, what's blocking, and what didn't work (dead ends).

## YAC Reporting

You are a YAC (Yet Another Claude). You report your work to the Field Reporter by writing files to a shared directory. This reporting is also useful for the *next* YAC — your session reports are input for future agents resuming your work.

**Getting the current time:** Always use `date '+%Y-%m-%d %H:%M'` for timestamps. Do not guess.

**Off the record:** If Peter says "off the record" or "don't report this," skip reporting for that segment. Resume when told.

### Session Identity

At the start of every session, run `date '+%Y%m%d-%H%M'` and assign yourself a session ID using your app prefix:

| App | Prefix |
|-----|--------|
| Statement Manager | `APP-SM` |
| Receipt Scanner | `APP-RS` |
| D&D Compendium | `APP-DND` |
| ClinTrial Explorer | `APP-CT` |
| New apps | `APP-<SHORT>` (pick a 2-4 letter code, tell the user) |

Format: `<PREFIX>-YYYYMMDD-HHMM`. Example: `APP-CT-20260331-2015`.

### Report Directory

Create your report directory at the start of every session:

```bash
mkdir -p /Users/peter/Development/FR-YAC/reports/<PREFIX>-YYYYMMDD-HHMM/
```

### Resuming — Check Previous Sessions

At session start (and when running `/resume`), check for recent sessions with your prefix:

```bash
ls -d /Users/peter/Development/FR-YAC/reports/<PREFIX>-* 2>/dev/null | tail -1
```

If a previous session exists, read its `session.md` to recover context from the previous agent's work. This is faster and richer than reconstructing from git alone.

If you are continuing work from that session (e.g., after context compaction), add this to your
`session.md` frontmatter:

```
continues: <PREVIOUS-SESSION-ID>
```

### Session Start

Create `session.md` immediately when starting work:

```markdown
---
session: <PREFIX>-YYYYMMDD-HHMM
type: app
app: <app name>
repo: <repo directory name>
started: YYYY-MM-DD HH:MM
phase: <explore | design-model | implement | build-app | improve | other>
tasks:
  - <initial task from user>
---
```

### After Every Commit

Before appending, read `commits.md` first. If the commit hash is already listed, skip it (prevents duplicates after context compaction).

Append to `commits.md` in your report directory:

```markdown
## <short-hash> — <commit message>
**Time:** <run `date '+%H:%M'`>
**Files:** <count> changed, +<added>/-<removed>
**Tests:** <X passed, Y failed — or "not run">
**What:** <1-2 sentences — what changed>
**Why:** <1-2 sentences — what motivated this change>
**PoNIF:** <if you encountered a PoNIF — which one and whether it caused issues. Omit if none.>
**Discovered:** <anything surprising, bugs found, or gaps identified — omit if nothing>
```

If you encountered a PoNIF and handled it correctly, note which one. If you hit a PoNIF and it caused a bug, definitely note it — the Field Reporter tracks these patterns.

### Session Summary

Write the session summary to `session.md` when:
- Peter runs `/report session-end`
- You detect context is running low (~70-80%)
- The session is naturally ending

Update (overwrite) the summary section — don't append multiple summaries.

```markdown
## Session Summary
**Duration:** <start time> – <run `date '+%H:%M'`>
**Commits:** <count>
**Lines:** +<added>/-<removed>
**Phase:** <which phase(s) you worked in>
**What happened:** <3-5 sentences covering the session's arc — not a commit list, but the narrative>
**WIP interactions:** <any platform bugs, missing MCP tools, or upstream issues discovered — omit if none>
**Unfinished:** <what's left, if anything>
**For the next YAC:** <context the next agent needs to pick up where you left off>
```

### Fireside Chats

When Peter initiates a design discussion, architecture debate, or scope conversation, use the `/report` slash command to capture it. These are the high-value narrative moments — not just what was decided, but why, what alternatives were considered, and what Peter said.
