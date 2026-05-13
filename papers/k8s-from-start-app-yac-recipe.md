# k8s-from-start — APP-YAC integration recipe

**Audience:** new APP-YACs starting from the `--preset query` scaffold.
**Goal:** ship a WIP app that runs *both* locally (`npm run dev`) and on the k8s install (`wip-deploy install ...`), without doing the retrofit two weeks in.
**Source:** captured 2026-05-13 after WIP-KB was retrofitted for wip-deploy. The retrofit changed 6 source files + 2 new files at once; everything in this paper is what would have been one-line decisions at scaffold time and instead became diff archaeology after the app was already running standalone.

## Why this exists

WIP-KB was built as a standalone Vite + Express app for ~10 days before being onto k8s. The integration was a single afternoon's work for the YAC who did it, but it *touched eight surfaces* — each one of which would have been a one-line scaffold decision at day 1, and instead required understanding the running app well enough to refactor without breakage.

The retrofit pattern is the same every time:

1. Reverse proxy mounts the app at a non-root path (e.g. `/apps/kb/`). The router does **not** strip the prefix (CASE-38 Option 2).
2. The Express server must therefore mount every route under `APP_BASE_PATH`.
3. The Vite-built frontend must emit asset URLs prefixed with the same path.
4. Every fetch URL in the client must be prefixed too.
5. The server has to know it's behind HTTPS termination (`trust proxy`).
6. Auth has to honour both an OIDC session (when the app handles its own login) and gateway-injected headers (when a router-level gateway terminates auth).
7. Production has to serve the built frontend from `dist/` with a SPA fallback (the dev server does this for free; the prod server doesn't).
8. A Dockerfile has to wire all of the above into a build that knows the base path at build time and the env at runtime.

Plus a `.dockerignore` gotcha that will silently degrade prod behaviour if you're not careful.

## The contract with wip-deploy

The deployer hands the app two env vars at run time:

| Env var | Set by | Meaning | Local dev default |
|---|---|---|---|
| `APP_BASE_PATH` | wip-deploy from `app_metadata.route_prefix` | External mount path the ingress routes to this app. Does NOT include trailing slash. E.g. `/apps/kb`. | unset (`/`) |
| `WIP_BASE_URL` | wip-deploy from `from_component` / `from_spec: network.external_base_url` | Upstream WIP API base — same-cluster service URL or remote URL depending on deployment shape. | `https://wip-kb.local` |

Plus the OIDC / session / API-key vars the scaffold already documents.

At build time (Vite stage of the Docker build), the deployer passes:

| Build ARG | Meaning |
|---|---|
| `VITE_BASE_PATH` | Same value as `APP_BASE_PATH`, baked into the static assets. The Vite build emits asset URLs prefixed with this; the server has no opportunity to rewrite them later. |

## The eight surfaces — what to ship from day 1

### 1. `server/index.ts` — Express Router mounted at `APP_BASE_PATH`

Build the routes onto a `Router`, not directly on `app`. Mount the router at `BASE_PATH` once. Only session middleware sits directly on `app` (it must run for callback paths regardless of mount).

```ts
const BASE_PATH = (process.env.APP_BASE_PATH || '').replace(/\/$/, '') || '/'
const app = express()
const router = Router()

app.set('trust proxy', 1)             // required behind HTTPS termination
app.use(cors())
app.use(session({
  secret: ...,
  name: 'kb.sid',                     // app-scoped cookie name
  cookie: {
    path: BASE_PATH.endsWith('/') ? BASE_PATH : `${BASE_PATH}/`,
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
  },
}))

router.get('/auth/callback', ...)
router.use(requireAuth())             // no-op when OIDC_ISSUER unset
router.use('/wip', wipProxy({ ... })) // MUST come before json parser
router.use((req, res, next) => {      // json parser, skip /wip
  if (req.path.startsWith('/wip')) return next()
  express.json()(req, res, next)
})
router.use('/server-api', bootstrapRoutes)
router.get('/api/health', ...)
router.post('/api/ask', ...)
router.get('/api/me', ...)            // see "Gateway auth pattern" below

if (process.env.NODE_ENV === 'production') {
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
  router.use(express.static(dist))
  router.get('{*path}', (_req, res) => res.sendFile(path.join(dist, 'index.html')))
}

app.use(BASE_PATH, router)
```

**Why session is on `app`, not `router`:** OIDC's callback redirect URL is baked into the issuer registration, and depending on your config it may not be prefix-aware. Mounting session on `app` means the session middleware runs regardless of which path the callback lands on. The auth-callback ROUTE stays on the router (so it's `${BASE_PATH}/auth/callback`).

**Why json parser is express-conditional:** `wipProxy` reads the request body as a raw stream. If `express.json()` runs upstream of it, the stream is consumed and the proxy sees an empty body on POSTs. Wrap json parsing in a middleware that skips `/wip`.

### 2. `vite.config.ts` — `base` from env, dev proxy prefixed

```ts
const RESOLVED_BASE = process.env.VITE_BASE_PATH || process.env.APP_BASE_PATH || '/'
const BASE_WITH_SLASH = RESOLVED_BASE.endsWith('/') ? RESOLVED_BASE : `${RESOLVED_BASE}/`
const BASE_PATH = RESOLVED_BASE.replace(/\/$/, '')

export default defineConfig({
  base: BASE_WITH_SLASH,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      [`${BASE_PATH}/api`]: 'http://localhost:3001',
      [`${BASE_PATH}/wip`]: 'http://localhost:3001',
      [`${BASE_PATH}/server-api`]: 'http://localhost:3001',
    },
  },
})
```

**Resolution order matters.** Build (Dockerfile) sets `VITE_BASE_PATH`; runtime dev (wip-deploy `--target dev`) sets `APP_BASE_PATH` but not `VITE_BASE_PATH`. Reading both lets the same config work in both modes.

### 3–6. Every client fetch — use `import.meta.env.BASE_URL`

Vite mirrors `config.base` to `import.meta.env.BASE_URL`, *always with a trailing slash*. Concatenating `'wip'` (no leading slash) onto it gives the right URL in both contexts.

```ts
// main.tsx — WipClient
const wipClient = createWipClient({ baseUrl: `${import.meta.env.BASE_URL}wip` })

// wipBulk.ts — raw fetch helper
const WIP_BASE = `${import.meta.env.BASE_URL}wip`
export async function wipFetchJson<T>(path, init) {
  return fetch(`${WIP_BASE}${path}`, ...)
}

// BootstrapGate.tsx — bootstrap endpoint
const SERVER_API = `${import.meta.env.BASE_URL}server-api`

// Any other inline fetch (DocPage's relationships, AskBar's /api/ask, etc.)
fetch(`${import.meta.env.BASE_URL}wip/...`)
fetch(`${import.meta.env.BASE_URL}api/ask`)
```

**The scaffold's `--preset query` currently bakes `/wip`, `/server-api`, `/api/...` as bare absolute paths.** That's the single biggest source of integration surface area. The scaffold should emit `${import.meta.env.BASE_URL}wip` from the start.

### 7. Gateway-aware `/api/me`

When the app runs behind a wip-router gateway that terminates auth and injects `X-WIP-User` / `X-WIP-Groups` headers, the app should honour those headers — *not* re-run OIDC. Pattern:

```ts
router.get('/api/me', (req, res) => {
  const gwUser = req.headers['x-wip-user'] as string | undefined
  if (gwUser) {
    const groups = (req.headers['x-wip-groups'] as string || '').split(',').filter(Boolean)
    res.json({ email: gwUser, groups, method: 'gateway' })
    return
  }
  if (req.session?.user) {
    res.json(req.session.user)
    return
  }
  res.json({ anonymous: true })
})
```

**Trust boundary:** the gateway is trusted to set these headers only after authenticating. If someone can hit the app's pod directly (bypassing the gateway), they can forge the headers. The k8s ingress + NetworkPolicy must enforce that only the gateway can reach the pod. Auth on the app pod is *delegated*, not *enforced*, in gateway mode.

This is why WIP-KB's auth on local dev is essentially off (`OIDC_ISSUER not set — auth disabled (local dev mode)`): in local dev there's no gateway, and the scaffold's `requireAuth()` middleware is a no-op when `OIDC_ISSUER` is unset. Three modes coexist:

| Mode | OIDC_ISSUER | Gateway headers | Who authenticates |
|---|---|---|---|
| Local dev | unset | not present | nobody — app is open |
| Standalone prod | set | not present | the app, via OIDC |
| Gateway prod | unset | present (`X-WIP-User`) | wip-router; app trusts headers |

### 8. `Dockerfile` + `.dockerignore`

Two-stage build, server runs via `tsx` (no TypeScript compile step for the server).

```dockerfile
# Stage 1: Build
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY libs/ libs/
RUN npm ci --ignore-scripts

ARG VITE_BASE_PATH=/
ENV VITE_BASE_PATH=${VITE_BASE_PATH}
COPY . .
RUN npm run build                              # emits dist/ with VITE_BASE_PATH baked in

# Stage 2: Production server
FROM node:20-alpine AS production
WORKDIR /app
COPY package.json package-lock.json ./
COPY libs/ libs/
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY server/ server/
COPY tsconfig.json ./
COPY --from=build /app/dist dist/

ENV NODE_ENV=production
ENV PORT=3012
EXPOSE 3012

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3012${APP_BASE_PATH:-}/api/health || exit 1

CMD ["npx", "tsx", "server/index.ts"]
```

**`.dockerignore` gotcha — narrow your `*.md` exclusion.**

The natural `.dockerignore` excludes `*.md` (READMEs, papers, docs — none of which belong in the image). That broad pattern matches at any depth, including `server/prompts/assistant.md` which the agent server reads at runtime (`agent.ts` → `readFileSync(prompts/assistant.md)`, wrapped in try/catch). Effect: production silently loses the app-specific assistant prompt; the agent uses the bare `wip://query-assistant-prompt` default and the user can't tell.

Fix: replace `*.md` with explicit excludes (e.g. `/*.md`, `papers/`, `docs/`) or negate the runtime ones with `!server/prompts/*.md`.

## What "local dev" looks like with this scaffolded in

With `BASE_PATH` defaulting to `/` and `import.meta.env.BASE_URL` defaulting to `/`:

- Vite's dev server proxy keys become `''+'/api'`, `''+'/wip'`, `''+'/server-api'` → same as today.
- Express router mounts at `/` → routes are at the same paths as today.
- All client fetches resolve to the same URLs as today.
- Session cookie path is `/` — same as today.
- OIDC stays off — same as today.

Net: zero behaviour change in local dev. The scaffold pays no tax for being k8s-ready.

## What this paper isn't solving

- **Persistence.** APP-KB is read-mostly and stateless; nothing in this paper covers app-side persistent volumes. If your app keeps non-WIP state, you'll need a PVC and that's a separate conversation.
- **Multi-replica.** Today's pattern assumes one pod, in-memory session store. Scaling to N replicas requires either sticky sessions on the ingress or a shared session store (Redis). Out of scope here.
- **Migrations.** wip-deploy's install/upgrade story for app-side schema changes is handled by BootstrapGate's offer-on-empty / use-on-exists discipline. That part is already in the scaffold.

## Scaffold gaps to flag for FRanC

What the `--preset query` scaffold ships today vs what this paper recommends:

| Surface | Scaffold today | Recommended |
|---|---|---|
| `server/index.ts` | Routes on `app`, no BASE_PATH | Router-mounted under `APP_BASE_PATH` |
| `vite.config.ts` | No `base`; raw dev proxy paths | `base: VITE_BASE_PATH || APP_BASE_PATH || '/'`, prefixed dev proxy |
| `src/main.tsx` (WipClient) | `baseUrl: '/wip'` | `baseUrl: ${BASE_URL}wip` |
| `src/lib/wipBulk.ts` | `fetch('/wip' + path)` | `fetch(${BASE_URL}wip + path)` |
| `src/components/BootstrapGate.tsx` | `fetch('/server-api/...')` | `fetch(${BASE_URL}server-api/...)` |
| Inline client fetches | bare paths | `${BASE_URL}...` |
| `/api/me` | OIDC session only | Gateway-header sniff → OIDC → anonymous |
| `Dockerfile` | not in scaffold | provided as starter |
| `.dockerignore` | not in scaffold | provided, with the `*.md` warning called out |

These are mechanical scaffold edits; none of them require an architectural change to WIP. The right move is filing a case for FRanC (or BE-YAC, whichever owns the scaffold today) to fold these defaults into `--preset query` so the next APP-YAC doesn't relearn them.

## Closing — what to do day 1

If you're a new APP-YAC reading this:

1. Run the scaffold (`--preset query`).
2. Before you write a single feature, do the eight changes above. They take 30 minutes.
3. Add `Dockerfile` and `.dockerignore`. Test with `docker build .` once locally.
4. File a `wip-app.yaml` in the wip-deploy repo's `apps/<name>/` so the deployer recognises your app from day 1.
5. Use `wip-deploy install --target dev --app <name> --app-source <name>=<your-repo>` to test the integrated flow at least once early. The next time you do it should be at week 2, not week 6.

You don't need to actually deploy to k8s on day 1 — just have the scaffold respect the contract so when you DO deploy, it's `wip-deploy install` rather than a refactor.
