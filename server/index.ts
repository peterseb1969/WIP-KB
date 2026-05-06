import 'dotenv/config'  // Must be first — loads .env before any other module reads process.env
import express from 'express'
import cors from 'cors'
import session from 'express-session'
import { wipProxy } from '@wip/proxy'
import { initAgent, ask } from './agent.js'
import { initAuth, requireAuth, handleCallback, handleLogout } from './auth.js'
import bootstrapRoutes from './bootstrap.routes.js'

const PORT = parseInt(process.env.PORT || '3001')
const app = express()

app.use(cors())

// --- Session (required for OIDC auth) ---
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },
}))

// --- Auth routes ---
app.get('/auth/callback', (req, res) => { handleCallback(req, res) })
app.get('/auth/logout', handleLogout)

// --- Auth middleware (no-op when OIDC_ISSUER is not set) ---
app.use(requireAuth())

// --- WIP REST proxy: /wip/* → upstream WIP cluster with API key injected.
// MUST come before express.json() — wipProxy uses express.raw() to forward
// request bodies unchanged; a json parser upstream of it would consume the
// stream first.
app.use('/wip', wipProxy({
  baseUrl: process.env.WIP_BASE_URL || 'https://wip-kb.local',
  apiKey: process.env.WIP_API_KEY || '',
}))

// --- JSON body parsing for our own server routes ---
app.use(express.json())

// --- Bootstrap (offer-on-empty / use-on-exists for the kb namespace) ---
app.use('/server-api', bootstrapRoutes)

// --- Health ---
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' })
})

// --- Ask endpoint ---
app.post('/api/ask', async (req, res) => {
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

// --- User info (for authenticated apps) ---
app.get('/api/me', (req, res) => {
  if (req.session.user) {
    res.json(req.session.user)
  } else {
    res.json({ anonymous: true })
  }
})

// --- Start ---
async function main() {
  await initAuth()
  await initAgent()
  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`)
  })
}

main().catch(err => {
  console.error('Failed to start:', err)
  process.exit(1)
})
