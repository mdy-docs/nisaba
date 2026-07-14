import { defineConfig } from 'vitest/config';

// Config for test/*.browser.test.js (multi-tab OPFS coordinator tests --
// see db-coordinator.js): these need a real browser (Worker,
// BroadcastChannel, navigator.locks, OPFS), unlike the rest of the suite
// (vitest.config.js, plain Node). Run via `npm run test:browser`.
export default defineConfig({
  test: {
    globals: true,
    testTimeout: 120000,
    include: ['test/*.browser.test.js'],
    browser: {
      enabled: true,
      headless: true,
      screenshotOnFailure: false,
      provider: 'playwright',
      instances: [{ browser: 'chromium' }]
    }
  }
});
