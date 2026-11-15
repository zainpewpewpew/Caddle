import { expect, test } from '@playwright/test';
import { E2E_USERS } from './fixtures.js';

// Halaman awal publik (pintu depan privat) di "/" untuk pengunjung tanpa sesi.

/** Error konsol, error JS, dan pelanggaran CSP (dilaporkan Chromium sebagai console error). */
function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/status of 401/.test(msg.text())) errors.push(`console: ${msg.text()}`);
  });
  return errors;
}

test('E2E-LP-001 halaman awal: judul, tautan Masuk, latar siap, tanpa scroll horizontal dan tanpa error konsol/CSP', async ({ page }) => {
  const errors = watchErrors(page);
  const thirdParty = [];
  page.on('request', (req) => {
    if (!req.url().startsWith('http://127.0.0.1')) thirdParty.push(req.url());
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: /Baca struktur pasar/ })).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
  await expect(page.getByRole('link', { name: 'Masuk', exact: true })).toHaveAttribute('href', '/login.html');
  await expect(page.locator('#neural-bg')).toHaveClass(/\bis-ready\b/);
  // Batasan produk tertulis di halaman (kejujuran, bukan pemasaran).
  await expect(page.getByText('Skor bukan probabilitas profit yang terkalibrasi.')).toBeVisible();
  // Ilustrasi pipeline diberi label jelas dan benar-benar berjalan.
  await expect(page.getByText('Ilustrasi alur · bukan data langsung')).toBeVisible();
  await expect(page.locator('[data-demo-step][data-state="active"], [data-demo-step][data-state="done"]').first()).toBeAttached();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(thirdParty).toEqual([]);
  expect(errors).toEqual([]);
});

test('E2E-LP-002 deep link /#/settings tanpa sesi → Masuk → login → kembali ke Pengaturan', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/#/settings');
  await page.getByRole('link', { name: 'Masuk', exact: true }).click();
  await expect(page).toHaveURL(/\/login\.html#\/settings$/);
  await page.getByLabel('Username').fill(E2E_USERS.admin.username);
  await page.getByLabel('Kata sandi').fill(E2E_USERS.admin.password);
  await page.getByRole('button', { name: 'Masuk' }).click();
  await expect(page).toHaveURL(/\/#\/settings$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Pengaturan' })).toBeVisible();
  expect(errors).toEqual([]);
});

test.describe('prefers-reduced-motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('E2E-LP-003 reduced motion: ilustrasi pipeline langsung statis di keadaan akhir', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
    await expect(page.locator('[data-demo-step][data-state="pending"]')).toHaveCount(0);
    await expect(page.locator('[data-demo-step][data-state="live"]')).toHaveCount(2);
  });
});
