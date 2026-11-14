// The start page's status panels, driven by intercepting the app's own status call
// (/server-api/bootstrap/status) in the browser: nothing reaches WIP's key handling
// and nothing is written, so it runs on every rung.
import { test, expect, type Page } from '@playwright/test'

const STATUS = '**/server-api/bootstrap/status'

async function answerStatus(page: Page, bodies: Array<object | number>) {
  let i = 0
  await page.route(STATUS, async (route) => {
    const b = bodies[Math.min(i++, bodies.length - 1)]
    if (typeof b === 'number') return route.fulfill({ status: b, body: 'boom' })
    if ('passthrough' in b) return route.continue()
    return route.fulfill({ json: b })
  })
}

test('a refused key names the key, re-checks on its own, and recovers', async ({ page }) => {
  test.setTimeout(45_000)
  // Refused for the first 3 s, whatever the number of calls (a dev build checks twice
  // on mount), then the real answer: only an automatic re-check can see it.
  let first = 0
  await page.route(STATUS, async (route) => {
    first ||= Date.now()
    if (Date.now() - first < 3_000) {
      return route.fulfill({ json: { status: 'wip_key_refused', http_status: 401,
        error: 'WIP GET /api/registry/namespaces: 401 Unauthorized' } })
    }
    return route.continue()
  })
  const t0 = Date.now()
  await page.goto('')
  await expect(page.getByText("WIP refused the app's API key")).toBeVisible()
  await expect(page.getByText('app-wip-kb')).toBeVisible()
  await expect(page.getByText(/HTTP 401/)).toBeVisible()
  await expect(page.getByText(/Checking again in \d+ s/)).toBeVisible()
  // The first re-check comes after about 5 s and gets the real answer: the app renders.
  await expect(page.getByText("WIP refused the app's API key")).toBeHidden({ timeout: 15_000 })
  await expect(page.getByRole('link', { name: /ready to implement|open/ }).first()).toBeVisible({ timeout: 15_000 })
  // No click happened, so the recovery was the scheduled re-check (about 5 s in).
  expect(Date.now() - t0).toBeGreaterThan(4_000)
})

test('an error status from WIP is not "unreachable"', async ({ page }) => {
  await answerStatus(page, [{ status: 'wip_error', http_status: 503, error: 'WIP GET /api/registry/namespaces: 503' }])
  await page.goto('')
  await expect(page.getByText('WIP answered with an error (HTTP 503)')).toBeVisible()
  await expect(page.getByText('WIP is unreachable')).toHaveCount(0)
})

test("the KB server's own failure is not blamed on WIP", async ({ page }) => {
  await answerStatus(page, [500])
  await page.goto('')
  await expect(page.getByText('The KB server did not answer')).toBeVisible()
  await expect(page.getByText(/HTTP 500/)).toBeVisible()
  await expect(page.getByText('WIP is unreachable')).toHaveCount(0)
})
