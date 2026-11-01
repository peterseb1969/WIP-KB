// Several knowledge bases in one install: the switcher, deep links, and isolation.
// Skipped when the app's key can see only one corpus.
import { test, expect } from '@playwright/test'
import { appConfig, corpora, firstDoc, searchTermsFrom, watchFailures, type KbDoc } from './helpers'

let main: string
let other: string
let otherDoc: KbDoc | null

test.beforeAll(async ({ request }) => {
  main = (await appConfig(request)).namespace
  const all = await corpora(request)
  const rest = all.filter((ns) => ns !== main).sort()
  test.skip(rest.length === 0, `only one corpus (${all.join(', ') || 'none'}) is visible to the app`)
  other = rest[0]
  otherDoc = await firstDoc(request, other, 'CASE_RECORD')
})

test('the switcher lists every corpus and moves to the chosen one', async ({ page, baseURL, request }) => {
  const failures = watchFailures(page, new URL(baseURL!).pathname)
  await page.goto('', { waitUntil: 'networkidle' })
  const switcher = page.getByLabel('Knowledge base')
  await expect(switcher).toBeVisible()
  const options = await switcher.locator('option').allInnerTexts()
  expect(options[0], 'the deployment corpus comes first').toBe(main)
  expect(new Set(options)).toEqual(new Set(await corpora(request)))

  await Promise.all([page.waitForURL(new RegExp(`/ns/${other}/`)), switcher.selectOption(other)])
  await expect(switcher).toHaveValue(other)

  await Promise.all([page.waitForURL((u) => !u.pathname.includes('/ns/')), switcher.selectOption(main)])
  expect(failures.list).toEqual([])
})

test('a deep link into another corpus opens its document', async ({ page, baseURL }) => {
  test.skip(!otherDoc, `${other} holds no CASE_RECORD`)
  const failures = watchFailures(page, new URL(baseURL!).pathname)
  await page.goto(`ns/${other}/doc/${otherDoc!.document_id}`, { waitUntil: 'networkidle' })
  await expect(page.locator('h1').first()).toBeVisible()
  if (otherDoc!.data.title) await expect(page.locator('h1').first()).toContainText(otherDoc!.data.title.slice(0, 40))
  await expect(page.getByLabel('Knowledge base')).toHaveValue(other)
  expect(failures.list).toEqual([])
})

test("a corpus's search finds its own documents and not another's", async ({ page }) => {
  const terms = searchTermsFrom(otherDoc?.data.title ?? '')
  test.skip(!terms, `${other} has no case with a searchable title`)
  const hit = `main a[href$="/doc/${otherDoc!.document_id}"]`

  await page.goto(`ns/${other}/search?q=${encodeURIComponent(terms)}`, { waitUntil: 'networkidle' })
  await expect(page.locator(hit).first()).toBeVisible()

  await page.goto(`search?q=${encodeURIComponent(terms)}`, { waitUntil: 'networkidle' })
  // Wait for the search to settle (results or the empty state) before checking absence.
  await expect(page.locator('main ul li, main :text("No results for")').first()).toBeVisible()
  await expect(page.locator(hit)).toHaveCount(0)
})
