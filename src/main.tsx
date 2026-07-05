import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createWipClient } from '@wip/client'
import { WipProvider } from '@wip/react'
import App from './App'
import { loadAppConfig } from './lib/namespaces'
import './index.css'

const queryClient = new QueryClient()

// `import.meta.env.BASE_URL` is Vite's mirror of `config.base` (always
// ends in `/`). Concatenated with `wip` it becomes `/wip` in local dev
// and `/apps/kb/wip` when the app is served behind the ingress prefix.
const wipClient = createWipClient({
  baseUrl: `${import.meta.env.BASE_URL}wip`,
})

const rootEl = document.getElementById('root')!

// Fetch per-deployment config (namespaces) from the server BEFORE first render
// (CASE-551), so every component reads the deployed namespace values rather than
// a baked default. Fail-loud: if the server is unreachable we render an explicit
// error, never a silently-misconfigured app.
loadAppConfig()
  .then(() => {
    ReactDOM.createRoot(rootEl).render(
      <React.StrictMode>
        <QueryClientProvider client={queryClient}>
          <WipProvider client={wipClient}>
            <App />
          </WipProvider>
        </QueryClientProvider>
      </React.StrictMode>,
    )
  })
  .catch((err: unknown) => {
    rootEl.innerHTML =
      `<div style="max-width:32rem;margin:15vh auto;font-family:system-ui;color:#b91c1c;` +
      `text-align:center"><h1 style="font-size:1.1rem">Knowledgebase failed to start</h1>` +
      `<p style="color:#6b7280;font-size:.875rem">Could not load app config from the ` +
      `server: ${String(err instanceof Error ? err.message : err)}. Check the server is ` +
      `running and reachable, then reload.</p></div>`
  })
