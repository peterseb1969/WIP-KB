import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createWipClient } from '@wip/client'
import { WipProvider } from '@wip/react'
import App from './App'
import './index.css'

const queryClient = new QueryClient()

const wipClient = createWipClient({
  baseUrl: '/wip',
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
