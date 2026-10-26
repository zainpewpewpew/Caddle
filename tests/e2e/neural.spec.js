import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { E2E_PORT, E2E_SEEDED_PORT, E2E_USERS } from './fixtures.js';

// UI "Neural Aurora": latar jaringan saraf animasi (dekoratif, aria-hidden), toggle animasi di topbar,
// Konstelasi Sinyal di Overview (hanya dari API nyata) dan radar scanner (hanya saat worker benar-benar berjalan).
// Screenshot disimpan ke reports/ untuk tinjauan visual — BUKAN asersi piksel.

const ROUTES = ['overview', 'screener', 'short-scanner', 'signals', 'symbol', 'health', 'settings', 'lab', 'backtest', 'design-system'];
const SERVER = `http://127.0.0.1:${E2E_PORT}`;
const SEEDED = `http://127.0.0.1:${E2E_SEEDED_PORT}`;
const SHOT_DIR = 'reports/screenshots/neural';
// Hash CSP blok <style> logo atribusi lightweight-charts 5.2.1 (a#tv-attr-logo).
const TV_LOGO_STYLE_HASH = 'sha256-3pRED1tOXas1FXFoPb9TGCjmYe9XQsmO9OV23khV2nY=';

/** Error konsol, error JS, dan pelanggaran CSP (dilaporkan Chromium sebagai console error). */
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

async function signIn(page, { base = SERVER, user = E2E_USERS.admin } = {}) {
  await page.goto(`${base}/login.html`);
  await page.getByLabel('Username').fill(user.username);
  await page.getByLabel('Kata sandi').fill(user.password);
  await page.getByRole('button', { name: 'Masuk' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
}

async function gotoRoute(page, base, route) {
  await page.goto(`${base}/#/${route}`);
  await expect(page.locator('.page h1')).toBeVisible();
  await expect(page.locator(`.nav__link[data-path="/${route}"]`)).toHaveAttribute('aria-current', 'page');
}

async function shot(page, testInfo, name) {
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: `${SHOT_DIR}/${testInfo.project.name}-${name}.png`, fullPage: false });
}

const canvasBg = (page) => page.locator('#neural-bg');
const motionToggle = (page) => page.locator('#motion-toggle');

async function expectNeuralCanvas(page) {
  const canvas = canvasBg(page);
  await expect(canvas).toHaveCount(1);
  await expect(canvas).toHaveAttribute('aria-hidden', 'true');
  await expect(canvas).toHaveClass(/\bis-ready\b/);
  // Latar tidak boleh menangkap klik/tap: interaksi kursor didengar dari window.
  expect(await canvas.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
  // Anak pertama <body> (di belakang aplikasi).
  expect(await canvas.evaluate((el) => el.parentElement === document.body && document.body.firstElementChild === el)).toBe(true);
}

test('E2E-NEU-001 halaman login: canvas #neural-bg ada, aria-hidden, siap (is-ready), tanpa error konsol', async ({ page }, testInfo) => {
  const errors = watchErrors(page);
  await page.goto(`${SERVER}/login.html`);
  await expect(page.getByRole('button', { name: 'Masuk' })).toBeVisible();
  await expectNeuralCanvas(page);
  await shot(page, testInfo, 'login');
  expect(errors).toEqual([]);
});

test('E2E-NEU-002 aplikasi: canvas latar siap & tanpa error konsol/CSP di seluruh halaman utama', async ({ page }, testInfo) => {
  const errors = watchErrors(page);
  await signIn(page);
  await expectNeuralCanvas(page);
  for (const route of ROUTES) {
    await gotoRoute(page, SERVER, route);
    // Canvas tetap satu (tidak digandakan per navigasi) dan tetap siap.
    await expect(canvasBg(page)).toHaveCount(1);
    await expect(canvasBg(page)).toHaveClass(/\bis-ready\b/);
    await shot(page, testInfo, `app-${route}`);
  }
  expect(errors).toEqual([]);
});

test('E2E-NEU-003 data seeded: halaman utama (termasuk grafik Symbol) tanpa error konsol/CSP', async ({ page }, testInfo) => {
  const errors = watchErrors(page);
  await signIn(page, { base: SEEDED });
  for (const route of ROUTES) await gotoRoute(page, SEEDED, route);
  // Symbol Intelligence dengan simbol nyata dari database seeded → grafik lightweight-charts benar-benar dipasang.
  await page.goto(`${SEEDED}/#/symbol?s=SYNUSDT&tf=5m&dir=LONG`);
  await expect(page.locator('.page h1')).toBeVisible();
  await expect(page.getByText('SYNUSDT').first()).toBeVisible();
  // Grafik benar-benar dirender (lightweight-charts menyisipkan kanvas) — tempat peringatan CSP inline style bisa muncul.
  await expect(page.getByTestId('candle-chart').locator('canvas').first()).toBeAttached();
  await shot(page, testInfo, 'seeded-symbol');
  // Satu-satunya pengecualian, sudah ada di main dan didokumentasikan di frontend/js/lib/chart.js: logo atribusi
  // TradingView memasang <style> inline yang DIBLOKIR CSP (gaya penggantinya ada di components.css). Hanya blok
  // dengan hash persis ini yang dikecualikan — pelanggaran CSP lain tetap menggagalkan tes.
  const known = (e) => e.includes("Applying inline style violates") && e.includes(TV_LOGO_STYLE_HASH);
  expect(errors.filter((e) => !known(e))).toEqual([]);
});

test('E2E-NEU-004 toggle "Animasi latar" mengubah html[data-motion] & aria-pressed, dan bertahan setelah reload', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page);
  const html = page.locator('html');
  const toggle = motionToggle(page);
  await expect(toggle).toBeVisible();
  await expect(html).toHaveAttribute('data-motion', 'on');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');

  await toggle.click();
  await expect(html).toHaveAttribute('data-motion', 'off');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => window.localStorage.getItem('lr.motion'))).toBe('off');

  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  await expect(html).toHaveAttribute('data-motion', 'off');
  await expect(motionToggle(page)).toHaveAttribute('aria-pressed', 'false');
  // Saat dimatikan, latar tetap tergambar statis (siap), bukan hilang.
  await expect(canvasBg(page)).toHaveClass(/\bis-ready\b/);

  await motionToggle(page).click();
  await expect(html).toHaveAttribute('data-motion', 'on');
  await expect(motionToggle(page)).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  await expect(html).toHaveAttribute('data-motion', 'on');
  expect(errors).toEqual([]);
});

test.describe('prefers-reduced-motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('E2E-NEU-005 reducedMotion "reduce" → html[data-motion="reduced"] di login & aplikasi, canvas tetap siap (frame statis)', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto(`${SERVER}/login.html`);
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
    await expect(canvasBg(page)).toHaveClass(/\bis-ready\b/);
    await signIn(page);
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
    await expect(motionToggle(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(canvasBg(page)).toHaveClass(/\bis-ready\b/);
    expect(errors).toEqual([]);
  });
});

test('E2E-NEU-006 Konstelasi Sinyal: database kosong → empty state jujur tanpa node & tanpa tabel sinyal', async ({ page }, testInfo) => {
  const errors = watchErrors(page);
  await signIn(page);
  const constellation = page.getByTestId('constellation');
  await expect(constellation).toHaveCount(1);
  await expect(constellation.getByText('Belum ada sinyal aktif — jalankan scanner')).toBeVisible();
  await expect(constellation.locator('.constellation__canvas')).toBeHidden();
  await expect(constellation.locator('.sr-only table')).toHaveCount(0);
  await expect(constellation.locator('.sr-only a')).toHaveCount(0);
  await shot(page, testInfo, 'constellation-empty');
  expect(errors).toEqual([]);
});

test('E2E-NEU-007 Konstelasi Sinyal: server seeded → canvas tampil dan tabel sr-only memuat simbol yang sama dengan /api/signals/active', async ({ page }, testInfo) => {
  const errors = watchErrors(page);
  await signIn(page, { base: SEEDED });
  const constellation = page.getByTestId('constellation');
  await expect(constellation.locator('.constellation__canvas')).toBeVisible();
  await expect(constellation.locator('.constellation__empty')).toBeHidden();
  const rows = constellation.locator('.sr-only table tbody tr');
  await expect(rows.first()).toBeAttached();

  // Sumber kebenaran: API yang sama yang dipakai Overview (LONG default + SHORT), dengan cookie sesi halaman.
  const fromApi = new Set();
  for (const query of ['limit=500', 'direction=SHORT&limit=500']) {
    const res = await page.request.get(`${SEEDED}/api/signals/active?${query}`);
    expect(res.ok()).toBe(true);
    for (const item of (await res.json()).items) fromApi.add(item.symbol);
  }
  expect(fromApi.size).toBeGreaterThan(0);
  const fromUi = new Set(await constellation.locator('.sr-only table tbody tr td:first-child').allTextContents());
  expect([...fromUi].sort()).toEqual([...fromApi].sort());
  expect(await rows.count()).toBeGreaterThan(0);
  await shot(page, testInfo, 'constellation-seeded');
  expect(errors).toEqual([]);
});

test('E2E-NEU-008 radar scanner: data-active "false" saat berhenti, "true" setelah Jalankan scanner (worker tiruan), "false" setelah dihentikan', async ({ page }, testInfo) => {
  const errors = watchErrors(page);
  await signIn(page);
  await gotoRoute(page, SERVER, 'screener');
  const radar = page.getByTestId('scan-radar');
  const control = page.getByTestId('worker-callout');
  await expect(control).toContainText('Scanner belum berjalan.');
  await expect(radar).toHaveAttribute('data-active', 'false');
  await expect(control).toHaveAttribute('data-active', 'false');

  await control.getByRole('button', { name: 'Jalankan scanner' }).click();
  try {
    await expect(control).toContainText('Scanner berjalan.');
    await expect(radar).toHaveAttribute('data-active', 'true');
    await expect(control).toHaveAttribute('data-active', 'true');
    await shot(page, testInfo, 'scanner-running');
  } finally {
    // Selalu kembalikan scanner ke "Berhenti" agar tes berikutnya mulai dari state yang sama.
    await control.getByRole('button', { name: 'Hentikan scanner' }).click();
    await control.getByRole('group', { name: /Hentikan scanner\?/ }).getByRole('button', { name: 'Ya, hentikan' }).click();
    await expect(control).toContainText('Scanner belum berjalan.', { timeout: 10_000 });
  }
  await expect(radar).toHaveAttribute('data-active', 'false');
  await expect(control).toHaveAttribute('data-active', 'false');
  expect(errors).toEqual([]);
});

test('E2E-NEU-009 lebar 390px: tidak ada overflow horizontal di halaman utama (kosong & seeded)', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const base of [SERVER, SEEDED]) {
    await signIn(page, { base });
    for (const route of ROUTES) {
      await gotoRoute(page, base, route);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `overflow di ${base} #/${route}`).toBeLessThanOrEqual(1);
      if (base === SEEDED) await shot(page, testInfo, `390-${route}`);
    }
  }
});
