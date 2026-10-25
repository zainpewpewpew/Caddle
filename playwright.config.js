import { defineConfig } from '@playwright/test';

const PORT = 8181;
const SEEDED_PORT = 8182;

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.js',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'reports/e2e-results.json' }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: [
    {
      command: 'node tests/e2e/server.js',
      url: `http://127.0.0.1:${PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      // Database terpisah berisi sinyal dari candle sintetis — agar tes "database kosong" tetap jujur.
      command: 'node tests/e2e/server.js',
      env: { E2E_SERVER_PORT: String(SEEDED_PORT), E2E_SEED_SIGNALS: '1' },
      url: `http://127.0.0.1:${SEEDED_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
