// The deploy contract's acceptance checks, plus: every page loads clean.
import { test, expect } from '@playwright/test'
import { appConfig, watchFailures } from './helpers'

test('health, app-config and the WIP proxy answer JSON', async ({ request }) => {
  const health = await request.get('api/health')
  expect(health.ok()).toBe(true)
  expect((await health.json()).status).toBe('ok')

  const cfg = await request.get('api/app-config')
  expect(cfg.headers()['content-type']).toContain('application/json')
  expect(await cfg.json()).toHaveProperty('namespace')

  const ns = await request.get('wip/api/registry/namespaces')
  expect(ns.ok()).toBe(true)
  const prefixes = ((await ns.json()) as Array<{ prefix: string }>).map((n) => n.prefix)
  const { namespace } = await appConfig(request)
  expect(prefixes).toContain(namespace)
})

test('an API route the server lacks is a 404 JSON, not the SPA', async ({ request }) => {
  const res = await request.get('api/no-such-route-e2e')
  expect(res.status()).toBe(404)
  expect(res.headers()['content-type']).toContain('application/json')
})

for (const [name, path] of [
  ['home', ''],
  ['search', 'search'],
  ['client', 'client'],
  ['settings', 'settings'],
] as const) {
  test(`the ${name} page loads without failed requests or console errors`, async ({ page, baseURL }) => {
    const failures = watchFailures(page, new URL(baseURL!).pathname)
    await page.goto(path, { waitUntil: 'networkidle' })
    await expect(page.locator('main')).toBeVisible()
    // Let late queries (corpus list, counts) settle before judging.
    await page.waitForTimeout(1000)
    expect(failures.list).toEqual([])
  })
}
