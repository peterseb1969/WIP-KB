import { createWipClient } from '@wip/client'

/**
 * The single shared WIP client instance.
 *
 * `main.tsx` hands it to `WipProvider` for the React hooks; `lib/reporting.ts`
 * uses its typed `reporting` service directly, because the summary/discovery
 * path is not hook-shaped. One instance keeps baseUrl and auth in one place
 * rather than having a second, differently-configured client appear the first
 * time a non-component module needs the API.
 *
 * `import.meta.env.BASE_URL` is Vite's mirror of `config.base` (always ends in
 * `/`). Concatenated with `wip` it becomes `/wip` in local dev and
 * `/apps/kb/wip` when the app is served behind the ingress prefix.
 */
export const wipClient = createWipClient({
  baseUrl: `${import.meta.env.BASE_URL}wip`,
})
