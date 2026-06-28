/**
 * Central namespace config for the two-namespace KB (CASE-518).
 *
 * Replaces the scattered `const NAMESPACE = 'kb'` literals. The app aggregates
 * over two namespaces: CORPUS_NS (the KB corpus — cases, decisions, lessons,
 * sessions, …) and LIBRARY_NS (the WIP Technical Library — generated-from-code
 * docs). Both are driven by Vite build/env vars so a deployment picks its own
 * namespace names; the dev defaults (lib-dev branch) are kb-libdev + library.
 *
 * The server has its own copy of this contract via WIP_NAMESPACE / a library
 * env (server/*.ts) — these VITE_* vars are the client (bundle) side. Keep the
 * two in sync at deploy time.
 */

/** The KB-corpus namespace (cases, decisions, lessons, sessions, memory, …). */
export const CORPUS_NS: string = import.meta.env.VITE_KB_NAMESPACE || 'kb'

/** The Technical Library namespace. Empty string = library disabled (single-ns). */
export const LIBRARY_NS: string = import.meta.env.VITE_LIBRARY_NAMESPACE || ''

/**
 * Every namespace the unified UI aggregates over, corpus first. When LIBRARY_NS
 * is unset this is just [CORPUS_NS] and the app behaves single-namespace.
 */
export const NAMESPACES: string[] = [CORPUS_NS, ...(LIBRARY_NS ? [LIBRARY_NS] : [])]
