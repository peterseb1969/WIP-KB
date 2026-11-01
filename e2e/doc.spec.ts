// A document opens by its ID, stays identifiable while scrolling, and is findable.
import { test, expect } from '@playwright/test'
import { appConfig, firstDoc, searchTermsFrom, watchFailures, type KbDoc } from './helpers'

let doc: KbDoc

test.beforeAll(async ({ request }) => {
  const { namespace } = await appConfig(request)
  const found = await firstDoc(request, namespace, 'CASE_RECORD')
  test.skip(!found, `the ${namespace} corpus holds no CASE_RECORD to open`)
  doc = found!
})

test('a case opens by its document ID', async ({ page, baseURL }) => {
  const failures = watchFailures(page, new URL(baseURL!).pathname)
  await page.goto(`doc/${doc.document_id}`, { waitUntil: 'networkidle' })
  const h1 = page.locator('h1').first()
  await expect(h1).toBeVisible()
  if (doc.data.title) await expect(h1).toContainText(doc.data.title.slice(0, 40))
  expect(failures.list).toEqual([])
})

test('the identity strip stays on screen when the document is scrolled', async ({ page }) => {
  await page.goto(`doc/${doc.document_id}`, { waitUntil: 'networkidle' })
  await expect(page.locator('h1').first()).toBeVisible()
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  const strip = page.getByRole('region', { name: 'Current document' })
  await expect(strip).toBeVisible()
  if (doc.data.case_number != null) await expect(strip).toContainText(String(doc.data.case_number))
})

test('a search for words of its title lists the case', async ({ page }) => {
  const terms = searchTermsFrom(doc.data.title ?? '')
  test.skip(!terms, 'the case title has no searchable words')
  await page.goto(`search?q=${encodeURIComponent(terms)}`, { waitUntil: 'networkidle' })
  await expect(page.locator(`main a[href$="/doc/${doc.document_id}"]`).first()).toBeVisible()
})

test('a search with no hits says so', async ({ page }) => {
  const nonsense = 'qzxv-e2e-nohit-7193'
  await page.goto(`search?q=${nonsense}`, { waitUntil: 'networkidle' })
  await expect(page.getByText(`No results for "${nonsense}"`)).toBeVisible()
})
