// The search page's Severity facet groups cases by CASE_SEVERITY term: spellings
// filed before the vocabulary existed ("minor", "high") are aliases and must not
// show up as facet entries of their own, and the entries follow the vocabulary's
// order (worst first), not the alphabet.
import { test, expect } from '@playwright/test'
import { appConfig } from './helpers'

test('the Severity facet lists vocabulary terms, worst first', async ({ page, request }) => {
  const { namespace } = await appConfig(request)
  const voc = await request.get(`wip/api/def-store/terminologies/by-value/CASE_SEVERITY?namespace=${namespace}`)
  test.skip(!voc.ok(), `${namespace} has no CASE_SEVERITY vocabulary yet`)
  const { terminology_id: tid } = await voc.json()
  const terms = await (await request.get(`wip/api/def-store/terminologies/${tid}/terms?namespace=${namespace}&page_size=100`)).json()
  const order: string[] = (terms.items ?? []).map((t: { value: string }) => t.value)
  expect(order.length).toBeGreaterThan(0)

  // A broad query, so the hit set spans many cases and severities.
  await page.goto('search?q=case', { waitUntil: 'networkidle' })
  const toggle = page.getByRole('button', { name: /^Severity/ })
  await expect(toggle).toBeVisible()
  await toggle.click()
  const section = toggle.locator('xpath=..')
  const labels = (await section.locator('label').allInnerTexts())
    .map((t) => t.trim().split(/\s+/)[0])
    .filter(Boolean)
  expect(labels.length).toBeGreaterThan(0)

  for (const l of labels) expect(order, `facet entry "${l}" is a CASE_SEVERITY term`).toContain(l)
  const positions = labels.map((l) => order.indexOf(l))
  expect(positions, 'entries follow the vocabulary order').toEqual([...positions].sort((a, b) => a - b))
})
