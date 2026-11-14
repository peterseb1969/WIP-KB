// The Flags line on a doc page: each live flag offers a two-step withdraw. Read-only:
// the test opens the confirmation and answers "No", so nothing is written.
import { test, expect } from '@playwright/test'
import { appConfig } from './helpers'

test('a live flag offers a withdraw that asks first', async ({ page, request }) => {
  const { namespace } = await appConfig(request)
  const ns = `"${namespace}"`
  const sql = `SELECT c.document_id, f.document_id AS flag_id FROM ${ns}."doc_flag_record" f`
    + ` JOIN ${ns}."doc_case_record" c ON c.status = 'active' AND f.flagged_document IN (c.document_id, 'CASE-' || c.case_number)`
    + ` WHERE f.status = 'active' AND f.doc_status IN ('published', 'dispatched') ORDER BY f.updated_at DESC LIMIT 1`
  const res = await request.post('wip/api/reporting-sync/query', { data: { namespace, sql } })
  test.skip(!res.ok(), `reporting query refused: ${res.status()}`)
  const row = ((await res.json()).rows ?? [])[0] as { document_id: string; flag_id: string } | undefined
  test.skip(!row, `no case in ${namespace} has a live flag`)

  await page.goto(`doc/${row!.document_id}`, { waitUntil: 'networkidle' })
  const link = page.locator(`a[href$="/doc/${row!.flag_id}"]`)
  await expect(link).toBeVisible()
  const chip = link.locator('..')
  await expect(chip.getByRole('button', { name: 'Yes' })).toHaveCount(0)
  await chip.getByRole('button', { name: 'withdraw' }).click()
  await expect(chip.getByText('Withdraw?')).toBeVisible()
  await chip.getByRole('button', { name: 'No' }).click()
  await expect(chip.getByRole('button', { name: 'withdraw' })).toBeVisible()
  await expect(link).not.toContainText('withdrawn')
})
