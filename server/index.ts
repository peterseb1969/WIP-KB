import 'dotenv/config'  // Must be first — loads .env before any other module reads process.env
import express, { Router } from 'express'
import cors from 'cors'
import session from 'express-session'
import path from 'path'
import { fileURLToPath } from 'url'
import { wipProxy } from '@wip/proxy'
import { initAgent, ask } from './agent.js'
import { initAuth, requireAuth, requireAdmin, handleCallback, handleLogout } from './auth.js'
import bootstrapRoutes from './bootstrap.routes.js'
import configRoutes from './config.routes.js'
import kbClientRoutes from './kb-client.routes.js'
import kbGatewayRoutes from './kb-gateway.routes.js'

const PORT = parseInt(process.env.PORT || '3012')

// APP_BASE_PATH — external path prefix when behind a reverse proxy.
// E.g. /apps/kb when nginx routes https://host/apps/kb/* to this app.
// The reverse proxy does NOT strip the prefix; the app mounts every route
// under APP_BASE_PATH so cookies, OIDC redirects, and asset URLs all match.
const BASE_PATH = (process.env.APP_BASE_PATH || '').replace(/\/$/, '') || '/'

const app = express()
const router = Router()

// Trust reverse proxy — required for secure cookies and req.protocol
// when behind HTTPS termination.
app.set('trust proxy', 1)

app.use(cors())

// Session (required for OIDC auth). Must be on `app` (not `router`) so it
// runs for all paths including the callback before the router mounts.
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-session-secret',
  name: 'kb.sid',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
    path: BASE_PATH.endsWith('/') ? BASE_PATH : `${BASE_PATH}/`,
  },
}))

// Auth routes
router.get('/auth/callback', (req, res) => { handleCallback(req, res) })
router.get('/auth/logout', handleLogout)

// kb-client served-client download + manifest (CASE-437). PUBLIC-READ, mounted
// BEFORE requireAuth() — headless clients fetch with an API key, not a browser
// session, so this must not be session-gated. Non-secret distributable code.
router.use('/server-api/kb-client', kbClientRoutes)

// KB write-gateway (CASE-464 Phase 1): domain case verbs. Mounted BEFORE
// requireAuth() for the same headless reason — but NOT unauthenticated: every
// verb requires X-API-Key and executes its WIP calls with the caller's key
// (un-privileged pass-through; a bad key fails at the platform). Own JSON
// parser — the global express.json() is deliberately after the /wip proxy.
router.use('/server-api/kb', express.json({ limit: '2mb' }), kbGatewayRoutes)

// Auth middleware (no-op when OIDC_ISSUER is not set)
router.use(requireAuth())

// WIP REST proxy: /wip/* → upstream WIP cluster with API key injected.
// MUST come before express.json() — wipProxy forwards request bodies as a
// raw stream; a json parser upstream of it would consume the stream first.
router.use('/wip', wipProxy({
  baseUrl: process.env.WIP_BASE_URL || 'https://wip-kb.local',
  apiKey: process.env.WIP_API_KEY || '',
}))

// JSON body parsing for our own routes (skips /wip, which is already handled).
router.use((req, res, next) => {
  if (req.path.startsWith('/wip')) return next()
  express.json()(req, res, next)
})

// Runtime config (admin-only) — set/rotate the Anthropic key without a redeploy (CASE-508)
router.use('/server-api/config', requireAdmin(), configRoutes)

// Bootstrap (offer-on-empty / use-on-exists for the kb namespace)
router.use('/server-api', bootstrapRoutes)

// Health
router.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'wip-kb' })
})

// Ask endpoint
router.post('/api/ask', async (req, res) => {
  const { question, sessionId } = req.body
  if (!question) {
    res.status(400).json({ error: 'question is required' })
    return
  }
  try {
    const result = await ask(question, sessionId)
    res.json(result)
  } catch (err: any) {
    console.error('Ask error:', err)
    res.status(500).json({ error: err.message || 'Internal error' })
  }
})

// User info — reads identity from gateway headers (X-WIP-User) first,
// falls back to OIDC session, then anonymous.
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

// In production, serve the built frontend from dist/.
if (process.env.NODE_ENV === 'production') {
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const distPath = path.resolve(__dirname, '..', 'dist')
  router.use(express.static(distPath))
  const indexHtml = path.join(distPath, 'index.html')
  router.get('/', (_req, res) => { res.sendFile(indexHtml) })
  router.get('{*path}', (_req, res) => { res.sendFile(indexHtml) })
}

// Mount router at BASE_PATH
app.use(BASE_PATH, router)

async function main() {
  await initAuth()
  await initAgent()
  app.listen(PORT, () => {
    console.log(`wip-kb backend listening on http://localhost:${PORT}`)
    if (BASE_PATH !== '/') {
      console.log(`  base path: ${BASE_PATH}`)
    }
  })
}

main().catch(err => {
  console.error('Failed to start:', err)
  process.exit(1)
})
