// The Answer box on a case waiting for the owner: what it sends into the work queue
// after the answer defaults to an implement flag, with "respond again" and
// "nothing" offered. Read-only: the box is never submitted.
import { test, expect } from '@playwright/test'
import { appConfig } from './helpers'

test('the Answer box defaults to flagging implement', async ({ page, request }) => {
  const { namespace } = await appConfig(request)
  // A case waiting for the owner, by the home panel's rule (server/lib/case-thread.ts).
  const ns = `"${namespace}"`
  const sql = `SELECT c.document_id FROM ${ns}."doc_case_record" c JOIN ${ns}."doc_case_response" r`
    + ` ON r.case_number = c.case_number AND r.status = 'active' AND NULLIF(r.data_json->>'questions', '')::int > 0`
    + ` WHERE c.status = 'active' AND c.data_status NOT IN ('implemented', 'closed')`
    + ` AND NOT EXISTS (SELECT 1 FROM ${ns}."doc_case_response" p WHERE p.case_number = c.case_number`
    + ` AND p.status = 'active' AND p.response_seq > r.response_seq AND (p.author = 'WEB-UI' OR p.author LIKE '%@%'`
    + ` OR p.data_json->>'owner_answer' = 'true' OR p.response_kind IN ('implement', 'close'))) LIMIT 1`
  const res = await request.post('wip/api/reporting-sync/query', { data: { namespace, sql } })
  test.skip(!res.ok(), `reporting query refused: ${res.status()}`)
  const item = ((await res.json()).rows ?? [])[0] as { document_id?: string } | undefined
  test.skip(!item?.document_id, `no case in ${namespace} waits for the owner`)

  await page.goto(`doc/${item!.document_id}`, { waitUntil: 'networkidle' })
  // A waiting case opens the box straight away.
  await expect(page.getByText('Answer the questions')).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Implement' })).toBeChecked()
  await expect(page.getByRole('radio', { name: 'Respond again' })).not.toBeChecked()
  await expect(page.getByRole('radio', { name: 'Nothing' })).not.toBeChecked()

  await page.getByRole('radio', { name: 'Nothing' }).check()
  await page.getByPlaceholder('1. …\n2. …').fill('x')
  await expect(page.getByRole('button', { name: 'Post answer' })).toBeEnabled()
  await page.getByRole('radio', { name: 'Implement' }).check()
  await expect(page.getByRole('button', { name: 'Post and flag implement' })).toBeEnabled()
})
