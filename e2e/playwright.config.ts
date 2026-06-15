import { defineConfig } from '@playwright/test'

// Minimal Playwright `_electron` E2E for the GlanceTerm sidebar.
// Drives the real renderer via synthetic ~/.glanceterm/hooks/<tab-id>.log files
// and asserts the row [data-tab-id][data-status]. See README.md for the
// installed-app plugin-shadow caveat that makes it self-skip on a dev machine
// that has GlanceTerm.app installed.
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  globalSetup: './global-setup.ts',
  reporter: [['list']],
})
