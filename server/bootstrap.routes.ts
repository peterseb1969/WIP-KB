/**
 * Bootstrap routes — wires the bootstrap library to two HTTP endpoints
 * BootstrapGate consumes.
 *
 *   GET  /server-api/bootstrap/status  → { status: BootstrapStatus }
 *   POST /server-api/bootstrap/run     → SSE stream of BootstrapProgress
 *
 * Adapted from templates/bootstrap/bootstrap.routes.ts.template.
 */

import { Router } from 'express'
import { checkStatusDetail, runBootstrap, type BootstrapProgress } from './lib/bootstrap.js'
import { initSSE, sendSSE, endSSE } from './lib/sse.js'

const router = Router()

// The check answers 200 with what it found; a failure of the check itself (the seed
// plans, say) is check_failed with its message, not "WIP is unreachable".
router.get('/bootstrap/status', async (_req, res) => {
  try {
    res.json(await checkStatusDetail())
  } catch (err) {
    res.json({ status: 'check_failed', error: (err as Error).message })
  }
})

router.post('/bootstrap/run', (req, res) => {
  initSSE(res)

  let clientConnected = true
  req.on('close', () => { clientConnected = false })

  runBootstrap((p: BootstrapProgress) => {
    if (clientConnected) sendSSE(res, p.done ? 'complete' : 'progress', p)
  })
    .then(() => {
      if (clientConnected) endSSE(res)
    })
    .catch((err) => {
      if (clientConnected) {
        sendSSE(res, 'error', { message: (err as Error).message })
        endSSE(res)
      }
    })
})

export default router
