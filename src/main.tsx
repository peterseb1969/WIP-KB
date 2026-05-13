import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createWipClient } from '@wip/client'
import { WipProvider } from '@wip/react'
import App from './App'
import './index.css'

const queryClient = new QueryClient()

// `import.meta.env.BASE_URL` is Vite's mirror of `config.base` (always
// ends in `/`). Concatenated with `wip` it becomes `/wip` in local dev
// and `/apps/kb/wip` when the app is served behind the ingress prefix.
const wipClient = createWipClient({
  baseUrl: `${import.meta.env.BASE_URL}wip`,
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <WipProvider client={wipClient}>
        <App />
      </WipProvider>
    </QueryClientProvider>
  </React.StrictMode>,
)
