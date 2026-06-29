# WIP-KB — the WIP-hosted Knowledge Base

APP-KB is the consumer-facing UI for the constellation's Knowledge Base, the first
dogfood of the `knowledgebase` archetype. WIP is the backend; this app is a
read-mostly frontend for **browsing, searching, traversing, and flagging** the KB
documents that YACs (the constellation's coding agents) and Peter accrue —
cases, design decisions, lessons, firesides, journey entries, sessions, agent
memory, and more.

Two user classes:
- **Peter** — reads, searches, navigates relationships, and flags docs for YAC
  follow-up. Never authors docs from the UI.
- **YACs** — read on session start (via MCP / the served kb-client) to inherit
  team context; write back through CLI tooling (`kb-write.py`, slash commands),
  **not** through this UI.

The distinctive v1 feature is **flag-for-YAC**: any doc can be turned into a prompt
for cross-agent work (a `FLAG_RECORD` linked to the source doc). The KB is an
actor, not a passive archive.

## What you see

| Route | Page | Shows |
|---|---|---|
| `/` | **HomePage** | Start page — docs grouped by type, newest first, with per-group search/sort. Structural/config types and `CASE_RESPONSE` are hidden. |
| `/search` | **SearchPage** | Faceted full-text + substring search across the corpus (type / status / author / kind / severity / app facets). |
| `/doc/:id` | **DocPage** | A single document: rendered body, structured fields, relationship graph, inline case-response thread, flag-for-YAC, and three "prepare a prompt" clipboard buttons. |
| `/client` | **ClientPage** | In-app documentation of the served kb-client (the CLI YACs install to read/write the KB). |
| `/settings` | **SettingsPage** | Admin-gated runtime config (e.g. the Anthropic API key for the askBar). |

An **askBar** (natural-language query, agent-mediated) sits above the app and
answers questions over the KB via an Anthropic model + WIP's MCP tools.

## How to run it

```bash
npm install
npm run dev          # client (Vite, :5173) + server (Express) concurrently
```

- **Standalone dev:** `npm run dev` serves the SPA at `http://localhost:5173` and
  the Express API/proxy alongside it. `dev:server` sets
  `NODE_TLS_REJECT_UNAUTHORIZED=0` because the WIP backend uses a self-signed cert.
- **Under `wip-deploy`:** the app runs at `https://<host>:<port>/apps/kb/` (prod
  build via the Dockerfile, or hot-reloaded dev via `--app-source`). See
  `papers/wip-deployable-app-contract.md`.
- **Production build:** `npm run build` → `dist/`; `npm start` runs the Express
  server which serves `dist/` statically with an SPA fallback. The Dockerfile
  bakes `VITE_BASE_PATH=/apps/kb` so asset paths resolve under the mount.

## Environment variables

| Var | Purpose |
|---|---|
| `WIP_BASE_URL` | WIP API base (the proxy target). From `wip-deploy`'s router component. |
| `WIP_API_KEY` | API key the proxy injects on WIP calls. From the `api-key` secret. |
| `WIP_NAMESPACE` | KB-corpus namespace, server side (default `kb`). Gateway + bootstrap target. |
| `VITE_KB_NAMESPACE` / `VITE_LIBRARY_NAMESPACE` | Client (bundle) namespaces (CASE-518): the KB corpus (default `kb`) and the Technical Library (default `library`). **Two-namespace by default** — overrides only; keep `VITE_KB_NAMESPACE` == `WIP_NAMESPACE` (review #1). |
| `KB_LIBRARY_NAMESPACE` | Server-side Library namespace (CASE-518), default `library`. Drives BootstrapGate (seeds it from `server/seed-library/`, `allowed_external_refs` → the corpus) + gateway routing + askBar. Match it to `VITE_LIBRARY_NAMESPACE`. |
| `PORT` | Express port (prod: `3012`). |
| `APP_BASE_PATH` | Mount path (`/apps/kb`). Drives the router base + cookie path. |
| `NODE_ENV` | `production` enables static `dist/` serving + SPA fallback. |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | OIDC login. When `OIDC_ISSUER` is unset, auth passes through (apps-only / dev mode). |
| `ALLOWED_GROUPS` / `ADMIN_GROUPS` | Authz groups; admin gates the Settings config endpoints. |
| `SESSION_SECRET` / `SESSION_TTL_MINUTES` | Express session. |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_API_KEY_FILE` | askBar model key. Resolvable at runtime via Settings (override → file → env), CASE-508. |
| `CLAUDE_MODEL` / `MAX_TURNS` | askBar agent model + turn cap. |
| `MCP_URL` / `MCP_TRANSPORT` / `MCP_MODULE` / `MCP_PYTHON` / `MCP_CWD` | askBar's MCP client wiring (http to `wip-router:8080/mcp`, or stdio in dev). |
| `GIT_COMMIT_SHA` / `APP_VERSION` | Baked build stamp (footer); `commit_sha` on the BOOTSTRAP_RECORD. |
| `KB_BOOTSTRAP_NAMESPACE` | Override the bootstrap target namespace (tests). |

The build also takes `VITE_BASE_PATH`, `VITE_BUILD_STAMP`, `VITE_BUILD_SHA` as
Docker build args (baked into the static bundle).

## WIP prerequisites

The app **bootstraps its own namespace** on first launch (offer-on-empty, see
`BootstrapGate`). The data model lives in `server/seed/` — 8 terminologies, 14
entity/config templates, 12 edge types. See **WIP_DEPENDENCIES.md** for the full
inventory and **DESIGN.md** for the data-model rationale. Never bootstrap the `kb`
namespace from a dev workflow — that's BootstrapGate's job at runtime.

## Tech stack

React 18 + TypeScript + Vite (SPA); Express + tsx (server/proxy/gateway);
`@wip/client` + `@wip/react` (TanStack Query hooks) + `@wip/proxy` for WIP access;
`@anthropic-ai/sdk` + `@modelcontextprotocol/sdk` for the askBar; `react-markdown`
+ `remark-gfm` for body rendering; `lucide-react` icons. See
`docs/technology-stack.md` for the constellation-wide stack rationale.
