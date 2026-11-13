// The flag dialog offers a worker when an active one performs the chosen kind of
// work for the chosen owner, and no choice when none does (the dispatcher picks).
// Read-only: the test opens the dialog and never submits it, so it is safe on
// every rung.
import { test, expect } from '@playwright/test'
import { appConfig, firstDoc } from './helpers'

test('the flag dialog offers a matching worker, and none for an owner without one', async ({ page, request }) => {
  const { namespace } = await appConfig(request)
  const sql = `SELECT data_json->>'agent_value' AS name, data_json->>'title' AS title FROM "${namespace}"."doc_agent_identity"`
    + ` WHERE status = 'active' AND data_json->>'active' = 'true'`
    + ` AND data_json->'performs' ? 'respond' AND data_json->'serves' ? 'BE-YAC' LIMIT 1`
  const res = await request.post('wip/api/reporting-sync/query', { data: { namespace, sql } })
  test.skip(!res.ok(), `reporting query refused: ${res.status()}`)
  const worker = ((await res.json()).rows ?? [])[0] as { name: string; title: string | null } | undefined
  test.skip(!worker, `${namespace} has no active worker that responds for BE-YAC`)
  const doc = await firstDoc(request, namespace, 'CASE_RECORD')
  test.skip(!doc, `${namespace} holds no CASE_RECORD`)

  await page.goto(`doc/${doc!.document_id}`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Flag for YAC' }).click()
  const dialog = page.locator('form').filter({ has: page.getByText('Target YAC') })
  await dialog.getByLabel('Target YAC').selectOption('BE-YAC')
  await dialog.getByLabel('Intent').selectOption('respond')

  const pick = dialog.getByLabel('Worker')
  await expect(pick).toBeVisible()
  await expect(pick.locator('option', { hasText: worker!.title || worker!.name })).toHaveCount(1)
  await expect(pick).toHaveValue('')   // the default leaves the choice to the dispatcher

  await dialog.getByLabel('Target YAC').selectOption('FRanC')
  await expect(dialog.getByLabel('Worker')).toHaveCount(0)

  await dialog.getByRole('button', { name: 'Cancel' }).click()
})
