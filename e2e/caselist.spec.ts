// The case list offers a one-click respond flag on every case row. It is live only
// on an open case with no outstanding respond flag: a case already flagged, or
// already responded, shows it greyed out. Read-only: the tests never click a flag
// button, so they are safe on every rung.
import { test, expect } from '@playwright/test'
import { appConfig } from './helpers'

test('every case row in the list has a quick flag button', async ({ page }) => {
  await page.goto('search?t=CASE_RECORD', { waitUntil: 'networkidle' })
  const rows = page.locator('main ul > li').filter({ has: page.locator('a[href*="/doc/"]') })
  const n = await rows.count()
  test.skip(n === 0, 'no cases listed')
  for (let i = 0; i < Math.min(n, 10); i++) {
    const btn = rows.nth(i).getByRole('button', { name: /^Flag(ged)?$/ })
    await expect(btn, `row ${i} has a quick flag button`).toBeVisible()
    // The button sits beside the row's link, never inside it.
    await expect(rows.nth(i).locator('a button')).toHaveCount(0)
  }
})

test('a responded case cannot be flagged from the list', async ({ page }) => {
  await page.goto('search?t=CASE_RECORD', { waitUntil: 'networkidle' })
  const rows = page.locator('main ul > li').filter({
    has: page.locator('span', { hasText: /^responded$/ }),
  })
  test.skip((await rows.count()) === 0, 'no responded case on the first page')
  const btn = rows.first().getByRole('button', { name: /^Flag(ged)?$/ })
  await expect(btn).toBeDisabled()
  await expect(btn).toHaveAttribute('title', /responded|Flagged/)
})

test('a case with a pending respond flag shows its flag button greyed out', async ({ page, request }) => {
  const { namespace } = await appConfig(request)
  const sql = `SELECT c.document_id, c.case_number FROM "${namespace}"."doc_flag_record" f`
    + ` JOIN "${namespace}"."doc_case_record" c ON f.flagged_document IN (c.document_id, 'CASE-' || c.case_number)`
    + ` WHERE f.status = 'active' AND c.status = 'active' AND f.flag_type = 'respond' AND f.doc_status = 'published' LIMIT 1`
  const res = await request.post('wip/api/reporting-sync/query', { data: { namespace, sql } })
  test.skip(!res.ok(), `reporting query refused: ${res.status()}`)
  const row = ((await res.json()).rows ?? [])[0] as { document_id: string; case_number: number } | undefined
  test.skip(!row, `no case in ${namespace} has a pending respond flag`)

  await page.goto(`search?t=CASE_RECORD&q=CASE-${row!.case_number}`, { waitUntil: 'networkidle' })
  const li = page.locator('main ul > li').filter({ has: page.locator(`a[href$="/doc/${row!.document_id}"]`) })
  await expect(li).toHaveCount(1)
  const btn = li.getByRole('button', { name: 'Flagged' })
  await expect(btn).toBeVisible()
  await expect(btn).toBeDisabled()

  await page.goto(`doc/${row!.document_id}`, { waitUntil: 'networkidle' })
  const docBtn = page.getByRole('button', { name: 'Flagged: awaiting response' })
  await expect(docBtn).toBeVisible()
  await expect(docBtn).toBeDisabled()
})

test('every case row has a one-click implement flag, live only on a responded case', async ({ page }) => {
  await page.goto('search?t=CASE_RECORD', { waitUntil: 'networkidle' })
  const rows = page.locator('main ul > li').filter({ has: page.locator('a[href*="/doc/"]') })
  const n = await rows.count()
  test.skip(n === 0, 'no cases listed')
  for (let i = 0; i < Math.min(n, 10); i++) {
    await expect(rows.nth(i).getByRole('button', { name: 'Implement', exact: true }), `row ${i}`).toBeVisible()
  }
  const open = rows.filter({ has: page.locator('span', { hasText: /^open$/ }) })
  if (await open.count()) {
    const btn = open.first().getByRole('button', { name: 'Implement', exact: true })
    await expect(btn).toBeDisabled()
    await expect(btn).toHaveAttribute('title', /Not responded yet|Flagged/)
  }
})

test('a case with a pending implement flag shows its implement button greyed out', async ({ page, request }) => {
  const { namespace } = await appConfig(request)
  const ns = `"${namespace}"`
  // A published (not yet picked up) implement flag on a case no implement or close
  // response has answered since: outstanding by fetchOutstandingFlags' rule.
  const sql = `SELECT c.document_id, c.case_number FROM ${ns}."doc_flag_record" f`
    + ` JOIN ${ns}."doc_case_record" c ON f.flagged_document IN (c.document_id, 'CASE-' || c.case_number)`
    + ` WHERE f.status = 'active' AND c.status = 'active' AND f.flag_type = 'implement' AND f.doc_status = 'published'`
    + ` AND NOT EXISTS (SELECT 1 FROM ${ns}."doc_case_response" r WHERE r.case_number = c.case_number`
    + ` AND r.status = 'active' AND r.response_kind IN ('implement', 'close') AND r.created_at > f.created_at) LIMIT 1`
  const res = await request.post('wip/api/reporting-sync/query', { data: { namespace, sql } })
  test.skip(!res.ok(), `reporting query refused: ${res.status()}`)
  const row = ((await res.json()).rows ?? [])[0] as { document_id: string; case_number: number } | undefined
  test.skip(!row, `no case in ${namespace} has a pending implement flag`)

  await page.goto(`search?t=CASE_RECORD&q=CASE-${row!.case_number}`, { waitUntil: 'networkidle' })
  const li = page.locator('main ul > li').filter({ has: page.locator(`a[href$="/doc/${row!.document_id}"]`) })
  await expect(li).toHaveCount(1)
  const btn = li.getByRole('button', { name: 'Implement', exact: true })
  await expect(btn).toBeDisabled()
  await expect(btn).toHaveAttribute('title', /Flagged for implementation/)

  await page.goto(`doc/${row!.document_id}`, { waitUntil: 'networkidle' })
  const docBtn = page.getByRole('button', { name: 'Flagged: implement' })
  await expect(docBtn).toBeVisible()
  await expect(docBtn).toBeDisabled()
})
