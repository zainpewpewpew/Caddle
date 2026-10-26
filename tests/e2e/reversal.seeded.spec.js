import { expect, test } from '@playwright/test';
import { E2E_SEEDED_PORT, E2E_USERS } from './fixtures.js';

// LONG Scanner — Reversal Radar pada server SEEDED (port 8182): kandidat SINTETIS ditulis lewat repositori ASLI
// (tests/helpers/reversalSeed.js) dan dibaca lewat API asli /api/reversal/* (backend/api/reversalRoutes.js) — membuktikan
// UI membaca backend (filter sensitivitas di server, detail & riwayat dari /api/reversal/candidates/:id), bukan mock
// page.route seperti reversal.spec.js. Tidak ada data contoh di frontend.
test.use({ baseURL: `http://127.0.0.1:${E2E_SEEDED_PORT}` });

// Satu-satunya pelanggaran CSP yang diterima (sama seperti reversal.spec.js E2E-RR-004 & neural.spec.js E2E-NEU-003):
// logo atribusi lightweight-charts memasang <style> inline yang diblokir CSP (didokumentasikan di frontend/js/lib/chart.js).
const TV_LOGO_STYLE_HASH = 'sha256-3pRED1tOXas1FXFoPb9TGCjmYe9XQsmO9OV23khV2nY=';
const TV_LOGO_STYLE_CSP = new RegExp(`Applying inline style violates .*${TV_LOGO_STYLE_HASH.replace(/[+/=]/g, '\\$&')}`);

function watchErrors(page, ignore = []) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (!ignore.some((re) => re.test(text))) errors.push(`console: ${text}`);
  });
  return errors;
}

async function signIn(page) {
  await page.goto('/login.html');
  await page.getByLabel('Username').fill(E2E_USERS.analyst.username);
  await page.getByLabel('Kata sandi').fill(E2E_USERS.analyst.password);
  await page.getByRole('button', { name: 'Masuk' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
}

const panelRow = (page, testId, symbol) => page.getByTestId(testId).locator('tbody tr', { hasText: symbol });

test('E2E-RR-009 server seeded: kandidat dari API asli per tahap, sensitivitas disaring server, detail & riwayat dari endpoint id, tabel SA/PVA tetap', async ({ page }) => {
  const errors = watchErrors(page, [TV_LOGO_STYLE_CSP]);
  await signIn(page);
  await page.goto('/#/screener');
  await expect(page.getByTestId('reversal-early')).toBeVisible();
  await expect(page.getByTestId('reversal-summary')).not.toHaveText('Memuat kandidat…');

  // Sensitivitas default Sedang (skor ≥ 45 & ≥ 3 bukti, disaring di server): AAA 5m Early (54), BBB 15m Developing (70),
  // CCC 1h Confirmed (88, extended) tampil; FFF 15m Early (23, ILLIQUID) tidak; DDD (CANCELLED) tidak pernah di daftar aktif.
  await expect(panelRow(page, 'reversal-early', 'AAAUSDT')).toBeVisible();
  await expect(panelRow(page, 'reversal-developing', 'BBBUSDT')).toBeVisible();
  await expect(panelRow(page, 'reversal-confirmed', 'CCCUSDT')).toBeVisible();
  await expect(page.locator('.rr-stages tbody tr', { hasText: 'FFFUSDT' })).toHaveCount(0);
  await expect(page.locator('.rr-stages tbody tr', { hasText: 'DDDUSDT' })).toHaveCount(0);
  await expect(page.getByTestId('reversal-early-counts')).toContainText('5m');
  await expect(page.getByTestId('reversal-confirmed-counts')).toContainText('1H 1');

  // Sensitivitas Tinggi → permintaan baru ke server, FFF ikut tampil (bukan disaring di klien).
  await page.getByLabel('Sensitivitas').selectOption('HIGH');
  await expect(panelRow(page, 'reversal-early', 'FFFUSDT')).toBeVisible();
  await expect(panelRow(page, 'reversal-early', 'AAAUSDT')).toBeVisible();

  // Detail BBB dari GET /api/reversal/candidates/:id: bukti lengkap berlabel, level, konfirmasi, batal, riwayat
  // OPENED → STAGE_UP (kronologis) persis seperti yang dipersistensi repositori.
  await panelRow(page, 'reversal-developing', 'BBBUSDT').click();
  const detail = page.getByTestId('reversal-detail');
  await expect(detail).toBeVisible();
  await expect(detail.getByTestId('reversal-detail-panel')).toContainText('BBBUSDT');
  await expect(detail.getByTestId('reversal-evidence').locator('li')).toHaveCount(11);
  await expect(detail.getByTestId('reversal-evidence')).toContainText('Higher low terkonfirmasi');
  await expect(detail.getByTestId('reversal-levels')).toBeVisible();
  await expect(detail.getByTestId('reversal-next')).not.toHaveText('');
  await expect(detail.getByTestId('reversal-cancel')).not.toHaveText('');
  const history = detail.getByTestId('reversal-history');
  await expect(history.locator('li')).toHaveCount(2);
  await expect(history.locator('li').first()).toHaveAttribute('data-type', 'OPENED');
  await expect(history.locator('li').last()).toHaveAttribute('data-type', 'STAGE_UP');

  // Panel sekunder SA/PVA 15m (mesin lama) tetap memuat sinyal seeded dari pipeline SA/PVA asli.
  await expect(page.getByTestId('screener-results').getByRole('cell', { name: 'SYNUSDT' })).toBeVisible();
  expect(errors).toEqual([]);
});
