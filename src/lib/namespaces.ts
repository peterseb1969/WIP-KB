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

/** The KB-corpus namespace (cases, decisions, lessons, sessions, memory, …). */
export let CORPUS_NS = 'kb'

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
  CORPUS_NS = cfg.namespace || 'kb'
  LIBRARY_NS = cfg.library_namespace || 'library'
  NAMESPACES = [CORPUS_NS, ...(LIBRARY_NS ? [LIBRARY_NS] : [])]
}
