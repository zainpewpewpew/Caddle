import { expect, test } from '@playwright/test';
import { E2E_SEEDED_PORT, E2E_USERS } from './fixtures.js';

// Server kedua berisi sinyal dari pipeline ASLI (detektor SA/PVA, state machine, SQLite) atas candle
// SINTETIS. Membuktikan screener & riwayat membaca API, bukan data contoh di frontend.
test.use({ baseURL: `http://127.0.0.1:${E2E_SEEDED_PORT}` });

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`console: ${msg.text()}`); });
  return errors;
}

async function signIn(page) {
  await page.goto('/login.html');
  await page.getByLabel('Username').fill(E2E_USERS.analyst.username);
  await page.getByLabel('Kata sandi').fill(E2E_USERS.analyst.password);
  await page.getByRole('button', { name: 'Masuk' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
}

test('E2E-SIG-001 screener menampilkan sinyal dari API; filter server & klien bekerja', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page);
  await page.goto('/#/screener');
  const results = page.getByTestId('screener-results');
  await expect(results.getByRole('cell', { name: 'SYNUSDT' })).toBeVisible();
  await expect(page.locator('.panel__actions .badge')).toHaveText('1 hasil');

  await page.getByLabel('Timeframe').selectOption('1h');
  await expect(results.getByText('Tidak ada kandidat yang cocok')).toBeVisible();
  await expect(page.locator('.panel__actions .badge')).toHaveText('0 hasil');

  await page.getByLabel('Timeframe').selectOption('5m');
  await expect(results.getByRole('cell', { name: 'SYNUSDT' })).toBeVisible();
  await page.getByLabel('Alignment').selectOption('COUNTERTREND');
  await expect(results.getByText('Tidak ada kandidat yang cocok')).toBeVisible();
  expect(errors).toEqual([]);
});

test('E2E-SIG-002 Signal History menampilkan sinyal dengan tahap & harga deteksi', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page);
  await page.goto('/#/signals');
  const row = page.locator('tbody tr').filter({ hasText: 'SYNUSDT' });
  await expect(row).toHaveCount(1);
  await expect(row.locator('.stage')).toBeVisible();
  expect(errors).toEqual([]);
});

test('E2E-SIG-003 System Health menampilkan heartbeat worker & error ingesti dari database', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page);
  await page.goto('/#/health');
  await expect(page.getByTestId('health-scanner')).toHaveText('Berhenti');
  await expect(page.getByRole('cell', { name: 'contoh error uji E2E (sintetis)' })).toBeVisible();
  await expect(page.getByTestId('kpi-scan').locator('.stat__value')).toHaveText('0 dtk');
  expect(errors).toEqual([]);
});

