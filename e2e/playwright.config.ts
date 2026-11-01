// Browser tests for the KB app, run against an installed instance (default: the
// localhost sandbox). They only read: no document, flag or setting is written, so
// pointing them at any rung of the ladder is safe. See e2e/README.md.
import { defineConfig } from '@playwright/test'
import { BASE_URL, STORAGE_STATE } from './env'

export default defineConfig({
  testDir: '.',
  // Each test logs in from the saved session; the instance is shared, so keep
  // the load modest.
  workers: 2,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: '../test-results/e2e',
  use: {
    baseURL: BASE_URL,
    // The instances use self-signed certificates.
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 800 },
    // A desktop Chrome is the default because it needs no download; set
    // KB_E2E_CHANNEL=chromium after `npx playwright install chromium` elsewhere.
    channel: process.env.KB_E2E_CHANNEL || 'chrome',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'login', testMatch: /auth\.setup\.ts/ },
    {
      name: 'app',
      testMatch: /.*\.spec\.ts/,
      dependencies: ['login'],
      use: { storageState: STORAGE_STATE },
    },
  ],
})
