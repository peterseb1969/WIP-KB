import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Base path for the deployed app (e.g. /apps/kb/) when behind a router
// that doesn't strip the prefix. Used for Vite's public `base` so emitted
// asset URLs (/apps/kb/assets/...) and index.html references resolve
// correctly behind the ingress.
//
// Resolution order:
//   1. VITE_BASE_PATH — explicit, used by prod build (Dockerfile ARG).
//   2. APP_BASE_PATH — the server-side base. Fallback for wip-deploy's
//      dev target, which sets APP_BASE_PATH but not VITE_BASE_PATH.
//   3. '/' — local dev default.
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
