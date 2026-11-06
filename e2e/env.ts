import os from 'node:os'
import path from 'node:path'

/** The app under test, with a trailing slash: every path in the tests is relative to it. */
export const BASE_URL = (() => {
  const u = process.env.KB_E2E_URL || 'https://kb.wip.localhost:8443/apps/kb/'
  return u.endsWith('/') ? u : `${u}/`
})()

/** The Dex user the tests log in as, and the file holding its password. */
export const LOGIN = process.env.KB_E2E_LOGIN || 'e2e@wip.local'
export const PASSWORD_FILE =
  process.env.KB_E2E_PASSWORD_FILE ||
  path.join(os.homedir(), '.wip-deploy', 'default', 'secrets', 'dex-password-e2e')

/** Where the logged-in session is kept between the login step and the tests (gitignored). */
export const STORAGE_STATE = path.join(import.meta.dirname, '.auth', 'session.json')
