/**
 * Central namespace config for the two-namespace KB (CASE-518).
 *
 * Runtime-sourced, not build-time baked (CASE-551). The client fetches the
 * deployed namespace names from the server's `GET /api/app-config` at boot
 * (`loadAppConfig()`, awaited in `main.tsx` before first render) rather than
 * inlining `VITE_*` vars. That kills the dual-source drift footgun: the server's
 * `WIP_NAMESPACE` / `KB_LIBRARY_NAMESPACE` are now the ONLY source of truth, and
 * the client can't disagree with them.
 *
 * These are `let` exports (live bindings): the safe defaults below hold until
 * `loadAppConfig()` rebinds them, and every consumer reads them at render/call
 * time — so by the time any component runs (post-await), they carry the deployed
 * values. The one thing that would freeze the default is capturing the value into
 * a module-level `const` at import time; don't do that (see FlagModal /
 * BootstrapGate, which read them at use-time for exactly this reason).
 */

/**
 * The knowledge domain chosen in the URL, if any.
 *
 * A namespace is a knowledge domain (DECISION-1), and the app can show any of
 * them. The choice lives in the URL path — `<base>ns/<namespace>/…` — and the
 * router's basename includes that prefix, so every in-app link stays inside the
 * chosen domain without each link having to carry it, and a deep link is
 * shareable. No prefix = the deployment's configured corpus, so existing URLs keep
 * working. Parsed synchronously at import: the router needs it before first render.
 */
const BASE = import.meta.env.BASE_URL
const NS_IN_PATH = (() => {
  const rest = window.location.pathname.startsWith(`${BASE}ns/`)
    ? window.location.pathname.slice(`${BASE}ns/`.length)
    : ''
  const seg = decodeURIComponent(rest.split('/')[0] || '')
  return /^[a-z][a-z0-9-]*$/.test(seg) ? seg : ''
})()

/** Router basename: the app's base path, plus the `ns/<namespace>` prefix when one is chosen. */
export const ROUTER_BASENAME =
  (BASE.replace(/\/$/, '') + (NS_IN_PATH ? `/ns/${NS_IN_PATH}` : '')) || '/'

/** The deployment's configured corpus namespace — the domain shown when the URL names none. */
export let DEFAULT_CORPUS_NS = 'kb'

/** The KB-corpus namespace being shown (cases, decisions, lessons, sessions, memory, …). */
export let CORPUS_NS = NS_IN_PATH || 'kb'

/** The Technical Library namespace (generated-from-code docs, CASE-518). */
export let LIBRARY_NS = 'library'

/**
 * Every namespace the unified UI aggregates over, corpus first. Two-namespace by
 * default; collapses to [CORPUS_NS] if the library namespace is ever empty.
 */
export let NAMESPACES: string[] = [CORPUS_NS, LIBRARY_NS]

interface AppConfig {
  namespace?: string
  library_namespace?: string
}

/**
 * Fetch per-deployment config from the server and rebind the namespace exports.
 * Awaited once in `main.tsx` before first render. Fail-loud: a non-OK response
 * throws so the boot renders an explicit error rather than silently defaulting
 * (silent defaulting is the exact footgun CASE-551 removes).
 */
export async function loadAppConfig(): Promise<void> {
  const res = await fetch(`${import.meta.env.BASE_URL}api/app-config`)
  if (!res.ok) {
    throw new Error(`app-config fetch failed: ${res.status} ${res.statusText}`)
  }
  const cfg = (await res.json()) as AppConfig
  DEFAULT_CORPUS_NS = cfg.namespace || 'kb'
  CORPUS_NS = NS_IN_PATH || DEFAULT_CORPUS_NS
  LIBRARY_NS = cfg.library_namespace || 'library'
  NAMESPACES = [CORPUS_NS, ...(LIBRARY_NS ? [LIBRARY_NS] : [])]
}

/** The app's root URL for a knowledge domain: the plain base for the default one. */
export function corpusHref(ns: string): string {
  return ns === DEFAULT_CORPUS_NS ? BASE : `${BASE}ns/${encodeURIComponent(ns)}/`
}

/**
 * Every namespace that holds a KB corpus, found from the data rather than from a
 * config list, so a domain created with `kbc kb-namespace.py` shows up on its own.
 *
 * The marker is the WRITE_POLICY template: bootstrap seeds it into every corpus and
 * never into the library, and its value is not namespace-prefixed (the bootstrap
 * record's is, and older corpora carry the unprefixed one), so one check covers
 * corpora of every age. Read through the WIP proxy, like all deterministic UI reads.
 */
export async function listCorpora(): Promise<string[]> {
  const res = await fetch(`${BASE}wip/api/registry/namespaces`)
  if (!res.ok) throw new Error(`namespace list failed: ${res.status}`)
  const all = (await res.json()) as Array<{ prefix: string }>
  const hits = await Promise.all(
    all.map(async ({ prefix }) => {
      const r = await fetch(
        `${BASE}wip/api/template-store/templates/by-value/WRITE_POLICY?namespace=${encodeURIComponent(prefix)}`,
      )
      return r.ok ? prefix : null
    }),
  )
  const found = hits.filter((p): p is string => p !== null)
  // The domain being shown stays listed even if the check missed it, so the
  // switcher can always name where you are.
  return [...new Set([DEFAULT_CORPUS_NS, CORPUS_NS, ...found])].sort((a, b) =>
    a === DEFAULT_CORPUS_NS ? -1 : b === DEFAULT_CORPUS_NS ? 1 : a.localeCompare(b),
  )
}
