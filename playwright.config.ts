import { defineConfig } from '@playwright/test'

/**
 * Playwright is here for ONE job: proving Chromium and WebKit lay the statement
 * page out identically. See tests/parity/pagination.parity.spec.ts.
 *
 * NO `projects` AND NO `webServer`, on purpose. The spec launches both engines
 * itself because the comparison needs both results in one place, and the
 * harness inlines its own fonts so there is nothing to serve and no session to
 * hold. Everything else in this repository is tested with `node --test`.
 */
export default defineConfig({
  testDir: './tests/parity',
  testMatch: /.*\.parity\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  timeout: 180_000,
})
