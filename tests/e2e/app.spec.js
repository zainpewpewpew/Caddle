import { expect, test } from '@playwright/test';
import { E2E_USERS } from './fixtures.js';

const ROUTES = ['overview', 'screener', 'symbol', 'signals', 'lab', 'backtest', 'settings', 'health', 'design-system'];

/** Kumpulkan error konsol, error JS, dan pelanggaran CSP selama test. */
function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    const text = msg.text();
    // 401 dari percobaan login yang memang salah adalah perilaku yang diharapkan.
    if (msg.type() === 'error' && !/status of 401/.test(text)) errors.push(`console: ${text}`);
  });
  return errors;
}

async function signIn(page, user = E2E_USERS.admin) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login\.html$/);
  await page.getByLabel('Username').fill(user.username);
  await page.getByLabel('Kata sandi').fill(user.password);
  await page.getByRole('button', { name: 'Masuk' }).click();
  await expect(page).toHaveURL(/\/(#\/overview)?$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
}

test('E2E-AUTH-001 kredensial salah menampilkan pesan generik dan tetap di halaman login', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/login.html');
  await page.getByLabel('Username').fill('mary');
  await page.getByLabel('Kata sandi').fill('definitely-wrong-pass');
  await page.getByRole('button', { name: 'Masuk' }).click();
  await expect(page.getByRole('alert')).toHaveText('Username atau kata sandi salah.');
  await expect(page).toHaveURL(/login\.html$/);
  await expect(page.getByLabel('Kata sandi')).toHaveValue('');
  expect(errors).toEqual([]);
});

test('E2E-AUTH-002 login valid → dashboard; cookie sesi HttpOnly tidak terbaca JavaScript', async ({ page, context }) => {
  const errors = watchErrors(page);
  await signIn(page);
  expect(await page.evaluate(() => document.cookie)).toBe('');
  const cookies = await context.cookies();
  const session = cookies.find((c) => c.name === 'lr_session');
  expect(session.httpOnly).toBe(true);
  expect(session.sameSite).toBe('Strict');
  expect(await page.evaluate(() => Object.keys(window.localStorage).filter((k) => !k.startsWith('lr.nav')))).toEqual([]);
  expect(errors).toEqual([]);
});

test('E2E-NAV-001 seluruh layar dapat dibuka tanpa error konsol atau pelanggaran CSP', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page);
  for (const route of ROUTES) {
    await page.goto(`/#/${route}`);
    await expect(page.locator('.page h1')).toBeVisible();
    await expect(page.locator(`.nav__link[data-path="/${route}"]`)).toHaveAttribute('aria-current', 'page');
  }
  expect(errors).toEqual([]);
});

test('E2E-UI-001 overview menampilkan angka nyata dari database (nol) dan status jujur', async ({ page }) => {
  await signIn(page);
  await expect(page.getByTestId('kpi-monitored').locator('.stat__value')).toHaveText('0');
  await expect(page.getByTestId('kpi-active').locator('.stat__value')).toHaveText('0');
  await expect(page.getByText('Belum diimplementasi').first()).toBeVisible();
});

test('E2E-UI-002 tidak ada horizontal overflow halaman di setiap layar', async ({ page }) => {
  await signIn(page);
  for (const route of ROUTES) {
    await page.goto(`/#/${route}`);
    await expect(page.locator('.page h1')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `overflow di ${route}`).toBeLessThanOrEqual(1);
  }
});

test('E2E-SET-001 admin menyimpan pengaturan; validasi klien menolak input tidak valid', async ({ page }) => {
  await signIn(page);
  await page.goto('/#/settings');
  const manual = page.getByLabel('Simbol manual');
  await manual.fill('BTCUSDT, <script>');
  await page.getByRole('button', { name: 'Simpan pengaturan' }).click();
  await expect(page.locator('[data-error-for="manual"]')).toContainText('Format tidak valid');

  await manual.fill('BTCUSDT ETHUSDT');
  await page.getByLabel('Maks. simbol otomatis').fill('35');
  await page.getByRole('button', { name: 'Simpan pengaturan' }).click();
  await expect(page.getByRole('status')).toContainText('Pengaturan disimpan');
  await page.reload();
  await expect(page.getByLabel('Maks. simbol otomatis')).toHaveValue('35');
  await expect(page.getByLabel('Simbol manual')).toHaveValue('BTCUSDT, ETHUSDT');
});

test('E2E-AZ-001 analyst melihat pengaturan dalam mode baca saja', async ({ page }) => {
  await signIn(page, E2E_USERS.analyst);
  await page.goto('/#/settings');
  await expect(page.getByText('pengaturan hanya dapat dibaca')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Simpan pengaturan' })).toBeDisabled();
});

test('E2E-SEC-001 data yang ditampilkan di-escape (tidak dieksekusi sebagai HTML)', async ({ page }) => {
  await signIn(page);
  await page.goto('/#/settings');
  // User-agent dikontrol klien dan ditampilkan di panel sesi; pastikan dirender sebagai teks.
  const injected = await page.evaluate(async () => {
    const el = document.createElement('div');
    const { h } = await import('/js/lib/dom.js');
    el.append(h('span', null, '<img src=x onerror="window.__xss=1">'));
    return { html: el.innerHTML, executed: window.__xss === 1 };
  });
  expect(injected.executed).toBe(false);
  expect(injected.html).toContain('&lt;img');
});

test('E2E-AUTH-003 logout mengakhiri sesi; kembali ke dashboard diarahkan ke login', async ({ page }) => {
  await signIn(page);
  // Di layar sempit tombol Keluar berada di laci navigasi.
  const opener = page.getByRole('button', { name: 'Buka navigasi' });
  if (await opener.isVisible()) await opener.click();
  await page.getByRole('button', { name: 'Keluar' }).click();
  await expect(page).toHaveURL(/login\.html$/);
  await page.goto('/#/settings');
  // Browser mempertahankan fragmen (#/settings) saat mengikuti redirect 302.
  await expect(page).toHaveURL(/login\.html(#.*)?$/);
});
