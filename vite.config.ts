import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The KB is served at the root of its own origin (https://kb.<host>/), so it
// keeps Vite's default base `/` and reads no base-path variable: an image built
// for a path prefix asks for assets nothing serves. Client code still prefixes
// every fetch with import.meta.env.BASE_URL, which is `/`.
export default defineConfig({
  plugins: [react()],
  server: {
    // 0.0.0.0 lets Vite accept connections from outside the container
    // (wip-deploy --target dev with --app-source). Harmless on host.
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3012',
      '/wip': 'http://localhost:3012',
      '/server-api': 'http://localhost:3012',
    },
  },
})
