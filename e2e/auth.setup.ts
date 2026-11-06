// Logs in once through the gateway's Dex login and saves the session for the tests.
import fs from 'node:fs'
import { test as setup, expect } from '@playwright/test'
import { LOGIN, PASSWORD_FILE, STORAGE_STATE } from './env'

setup('log in', async ({ page, baseURL }) => {
  if (!fs.existsSync(PASSWORD_FILE)) {
    throw new Error(
      `No password file for ${LOGIN} at ${PASSWORD_FILE}. Ask the install's owner for a dedicated `
        + 'Dex user (`wip-deploy user add e2e …`) or set KB_E2E_PASSWORD_FILE.',
    )
  }
  const password = fs.readFileSync(PASSWORD_FILE, 'utf8').trim()
  await page.goto(baseURL!)
  // Dex may first ask which connector to use, then shows the login form.
  for (let step = 0; step < 3; step++) {
    await page.waitForLoadState('networkidle')
    if (page.url().startsWith(baseURL!)) break
    const login = page.locator('input[name="login"]')
    // Dex shows the form again with an error when the user or password is wrong —
    // typically an install (re)created without the e2e user.
    if (step > 0 && (await login.count()) && (await page.getByText(/Invalid .*password/i).count())) {
      throw new Error(
        `Dex refused ${LOGIN} with the password in ${PASSWORD_FILE}. The install probably has no `
          + 'such user (yet): `wip-deploy user add e2e --email e2e@wip.local --group wip-editors --name <install>`.',
      )
    }
    if (await login.count()) {
      await login.fill(LOGIN)
      await page.fill('input[name="password"]', password)
      await page.click('button[type="submit"]')
      continue
    }
    const connector = page.locator('a:has-text("Log in with Email"), a.dex-btn').first()
    if (!(await connector.count())) break
    await connector.click()
  }
  await page.waitForURL((u) => u.href.startsWith(baseURL!), { timeout: 15_000 })
  const me = await page.request.get('api/me')
  expect(me.ok(), 'the session reaches the app').toBe(true)
  expect((await me.json()).email).toBe(LOGIN)
  await page.context().storageState({ path: STORAGE_STATE })
})
