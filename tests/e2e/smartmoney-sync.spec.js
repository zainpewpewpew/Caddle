import { expect, test } from '@playwright/test';
import { E2E_PORT, E2E_SEEDED_PORT, E2E_USERS } from './fixtures.js';

// Tombol "Sync sekarang" di Smart Money Radar. Server seeded (8182): provider FIXTURE (DATA SIMULASI) — klik
// menjalankan putaran sinkronisasi ASLI (runSmartMoneySync lewat syncRunner) di proses server; jeda antar-sync 0 khusus
// E2E (tests/e2e/server.js) karena desktop & mobile menekan tombol yang sama berturut-turut. Putaran ulang atas data
// fixture yang sama tidak mengubah isi radar maupun alert (peristiwa skenario berumur berjam-jam → tidak ada alert
// baru), jadi spec lain tidak terpengaruh. Server kosong (8181): SMART_MONEY_PROVIDERS=off → tombol nonaktif.
const SEEDED = `http://127.0.0.1:${E2E_SEEDED_PORT}`;
const EMPTY = `http://127.0.0.1:${E2E_PORT}`;
const SYNC_API = '/api/smart-money/sync';

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`console: ${msg.text()}`); });
  return errors;
}

async function signIn(page, user, base) {
  await page.goto(`${base}/login.html`);
  await page.getByLabel('Username').fill(user.username);
  await page.getByLabel('Kata sandi').fill(user.password);
  await page.getByRole('button', { name: 'Masuk' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
}

/** Buka Radar dan tunggu status sinkronisasi pertama dibaca (data-state bukan lagi 'loading'). */
async function openRadar(page, base) {
  await page.goto(`${base}/#/smart-money`);
  await expect(page.getByRole('heading', { level: 1, name: 'Smart Money Radar' })).toBeVisible();
  await expect(page.getByTestId('sm-sync')).not.toHaveAttribute('data-state', 'loading');
}

const syncButton = (page) => page.getByRole('button', { name: 'Sync sekarang' });
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test('E2E-SM-SYNC-001 admin: Sync sekarang → putaran asli selesai "Berhasil", ringkasan angka, radar dimuat ulang', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, E2E_USERS.admin, SEEDED);
  await openRadar(page, SEEDED);
  await expect(page.getByTestId('sm-radar-item').first()).toBeVisible();
  await expect(page.getByTestId('sm-sync')).toContainText('Otomatis tiap 15 menit saat scanner berjalan');
  const button = syncButton(page);
  await expect(button).toBeEnabled();

  const post = page.waitForResponse((r) => r.url().endsWith(SYNC_API) && r.request().method() === 'POST');
  const reload = page.waitForResponse((r) => r.url().includes('/api/smart-money/radar?'));
  await button.click();
  const posted = await post;
  expect(posted.status()).toBe(202);
  expect(await posted.json()).toMatchObject({ started: true, run: { owner: 'server', trigger: 'manual' } });

  const result = page.getByTestId('sm-sync-result');
  await expect(result).toBeVisible({ timeout: 20_000 });
  await expect(result).toHaveAttribute('data-status', 'OK');
  await expect(result).toContainText('Sinkronisasi selesai');
  await expect(result).toContainText('Berhasil');
  await expect(result).toContainText(/Wallet: \d+ tersinkron dari \d+ dipilih/);
  await expect(result).toContainText(/Transfer: \d+ diambil/);
  // Radar dimuat ulang setelah putaran selesai dan isinya tetap ada.
  expect((await reload).status()).toBe(200);
  await expect(page.getByTestId('sm-radar-item').first()).toBeVisible();
  await expect(page.getByTestId('sm-sync-progress')).toHaveCount(0);

  // Status server: tidak ada putaran berjalan, ringkasan terakhir milik putaran manual ini.
  const status = await page.request.get(`${SEEDED}${SYNC_API}`);
  expect(await status.json()).toMatchObject({ running: false, run: null, canTrigger: true, lastRun: { status: 'OK' } });

  // "Tutup" menyembunyikan hasil dan mengembalikan fokus ke tombol.
  await result.getByRole('button', { name: 'Tutup' }).click();
  await expect(page.getByTestId('sm-sync-result')).toHaveCount(0);
  await expect(button).toBeFocused();
  expect(await overflowX(page)).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

test('E2E-SM-SYNC-002 analyst: tombol nonaktif dengan alasan, klik tidak mengirim permintaan', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, E2E_USERS.analyst, SEEDED);
  await openRadar(page, SEEDED);
  const button = syncButton(page);
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute('title', 'Hanya admin yang dapat menjalankan sinkronisasi');
  await expect(page.getByTestId('sm-sync')).toHaveAttribute('data-state', 'blocked');
  await expect(page.getByTestId('sm-sync')).toContainText('Hanya admin yang dapat menjalankan sinkronisasi');
  let posts = 0;
  page.on('request', (r) => { if (r.url().endsWith(SYNC_API) && r.method() === 'POST') posts += 1; });
  await button.click({ force: true });
  await expect(page.getByTestId('sm-sync-progress')).toHaveCount(0);
  expect(posts).toBe(0);
  // Ringkasan putaran terakhir tetap terlihat (tertutup) untuk semua peran.
  await expect(page.getByTestId('sm-sync-last')).toBeVisible();
  expect(await overflowX(page)).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

test('E2E-SM-SYNC-003 server tanpa provider: tombol nonaktif dan langkah mengisi ETHERSCAN_API_KEY', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, E2E_USERS.admin, EMPTY);
  await openRadar(page, EMPTY);
  const button = syncButton(page);
  await expect(button).toBeDisabled();
  await expect(page.getByTestId('sm-sync')).toHaveAttribute('data-state', 'blocked');
  const help = page.getByTestId('sm-sync-help');
  await expect(help).toBeVisible();
  await expect(help).toContainText('ETHERSCAN_API_KEY');
  await expect(help).toContainText('npm start');
  await expect(page.getByTestId('sm-sync-last')).toHaveCount(0);
  expect(await overflowX(page)).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});
