import { expect, type APIRequestContext, type Page } from '@playwright/test'

export interface KbDoc {
  document_id: string
  data: { title?: string; case_number?: number; [k: string]: unknown }
}

/** The deployment's corpus and library namespaces, as the app itself reads them. */
export async function appConfig(request: APIRequestContext): Promise<{ namespace: string; library: string }> {
  const res = await request.get('api/app-config')
  expect(res.ok(), 'GET api/app-config').toBe(true)
  const cfg = await res.json()
  return { namespace: cfg.namespace || 'kb', library: cfg.library_namespace || 'library' }
}

/**
 * Every corpus the app's key can see, found the way the corpus switcher finds them:
 * a namespace holding the WRITE_POLICY template is a KB corpus.
 */
export async function corpora(request: APIRequestContext): Promise<string[]> {
  const res = await request.get('wip/api/registry/namespaces')
  expect(res.ok(), 'namespace list through the WIP proxy').toBe(true)
  const all = (await res.json()) as Array<{ prefix: string }>
  const found: string[] = []
  for (const { prefix } of all) {
    const r = await request.get(
      `wip/api/template-store/templates?namespace=${encodeURIComponent(prefix)}&value=WRITE_POLICY&latest_only=true&page_size=1`,
    )
    if (!r.ok()) continue
    const { items = [] } = await r.json()
    if (items.some((t: { value?: string }) => t.value === 'WRITE_POLICY')) found.push(prefix)
  }
  return found
}

/** One active document of a template in a namespace, or null when the namespace holds none. */
export async function firstDoc(request: APIRequestContext, ns: string, template: string): Promise<KbDoc | null> {
  const res = await request.post(`wip/api/document-store/documents/query?namespace=${encodeURIComponent(ns)}`, {
    data: { template_id: template, filters: [], page: 1, page_size: 1 },
  })
  expect(res.ok(), `query ${template} in ${ns}`).toBe(true)
  const { items = [] } = await res.json()
  return items[0] ?? null
}

/**
 * Collects what a healthy page should never produce: failed requests to the app
 * (4xx/5xx under the app's base path) and console errors. Call `.clear()` after
 * anything expected to fail, and assert `.list` is empty at the end.
 */
export function watchFailures(page: Page, basePath: string) {
  const list: string[] = []
  page.on('response', (r) => {
    if (r.status() >= 400 && new URL(r.url()).pathname.startsWith(basePath)) {
      list.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`)
    }
  })
  page.on('console', (m) => {
    if (m.type() === 'error') list.push(`console: ${m.text().slice(0, 200)}`)
  })
  page.on('pageerror', (e) => list.push(`page error: ${e.message.slice(0, 200)}`))
  return { list, clear: () => { list.length = 0 } }
}

/**
 * Search words from a title: long enough to be selective, free of query syntax.
 * URLs, paths and code spans are dropped first: full-text search indexes
 * `https://rc.<host>/` as one URL token, not as the word "https", so a word taken
 * from inside one can never match.
 */
export function searchTermsFrom(title: string): string {
  return title
    .replace(/`[^`]*`/g, ' ')
    .replace(/\S*(?:\/|:\/\/|<|>)\S*/g, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 5)
    .slice(0, 3)
    .join(' ')
}
