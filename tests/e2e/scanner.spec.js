import { expect, test } from '@playwright/test';
import { E2E_USERS } from './fixtures.js';

// Tombol scanner di website. Server E2E menjalankan worker TIRUAN (tests/fixtures/worker-stub.js) sebagai
// child process nyata — tanpa koneksi Binance. Setiap tes mengembalikan scanner ke state "Berhenti".

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`console: ${msg.text()}`); });
  return errors;
}

async function signIn(page, user) {
  await page.goto('/login.html');
  await page.getByLabel('Username').fill(user.username);
  await page.getByLabel('Kata sandi').fill(user.password);
  await page.getByRole('button', { name: 'Masuk' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
}

const card = (page) => page.locator('#worker-control');
const stateOf = (page) => page.getByTestId('worker-control-state');

async function stopViaUi(page) {
  await card(page).getByRole('button', { name: 'Hentikan scanner' }).click();
  await card(page).getByRole('group', { name: /Hentikan scanner\?/ }).getByRole('button', { name: 'Ya, hentikan' }).click();
  // Worker tiruan keluar segera setelah SIGTERM; UI memantau tiap 2 detik.
  await expect(stateOf(page)).toHaveText('Berhenti', { timeout: 10_000 });
}

test('E2E-SUP-001 admin menjalankan scanner dari System Health, membatalkan lalu mengonfirmasi penghentian', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, E2E_USERS.admin);
  await page.goto('/#/health');
  const start = card(page).getByRole('button', { name: 'Jalankan scanner' });
  const stop = card(page).getByRole('button', { name: 'Hentikan scanner' });
  await expect(card(page).getByRole('heading', { name: 'Kontrol scanner' })).toBeVisible();
  await expect(stateOf(page)).toHaveAttribute('aria-live', 'polite');
  await expect(stateOf(page)).toHaveText('Berhenti');
  await expect(stop).toBeDisabled();

  await start.click();
  await expect(stateOf(page)).toHaveText('Berjalan');
  await expect(start).toBeDisabled();
  await expect(stop).toBeEnabled();

  // Batal: konfirmasi tertutup, scanner tetap berjalan, fokus kembali ke tombol.
  await stop.click();
  const confirm = card(page).getByRole('group', { name: /Hentikan scanner\?/ });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole('button', { name: 'Batal' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  await expect(stop).toBeFocused();
  await expect(stateOf(page)).toHaveText('Berjalan');

  // Polling selama "Menghentikan…" ditandai sebagai latar (tidak memperpanjang idle timeout sesi).
  const polls = [];
  page.on('request', (req) => {
    if (req.method() === 'GET' && new URL(req.url()).pathname === '/api/system/worker') polls.push(req);
  });
  await stopViaUi(page);
  await expect(start).toBeEnabled();
  await expect(stop).toBeDisabled();
  expect(polls.length).toBeGreaterThan(0);
  for (const req of polls) expect((await req.allHeaders())['x-lr-background']).toBe('1');
  expect(errors).toEqual([]);
});

test('E2E-SUP-002 analyst melihat state scanner tanpa tombol kontrol (System Health & Overview)', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, E2E_USERS.analyst);
  const callout = page.getByTestId('worker-callout');
  await expect(callout).toContainText('Scanner belum berjalan.');
  await expect(callout).toContainText('Minta admin');
  await expect(callout.getByRole('button')).toHaveCount(0);

  await page.goto('/#/health');
  await expect(stateOf(page)).toHaveText('Berhenti');
  await expect(card(page).getByText('Hanya admin yang dapat menjalankan atau menghentikan scanner.')).toBeVisible();
  await expect(card(page).getByRole('button')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('E2E-SUP-003 admin menjalankan scanner dari callout Overview', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, E2E_USERS.admin);
  const callout = page.getByTestId('worker-callout');
  await expect(callout).toContainText('Scanner belum berjalan.');
  await callout.getByRole('button', { name: 'Jalankan scanner' }).click();
  await expect(callout).toContainText('Scanner berjalan.');
  await expect(callout.getByRole('button')).toHaveCount(0);

  await page.goto('/#/health');
  await expect(stateOf(page)).toHaveText('Berjalan');
  await stopViaUi(page);
  await page.goto('/#/overview');
  await expect(page.getByTestId('worker-callout')).toContainText('Scanner belum berjalan.');
  expect(errors).toEqual([]);
});

test('E2E-SUP-004 tombol nonaktif selama request; penolakan server (worker di luar website) tampil sebagai alert', async ({ page }) => {
  await signIn(page, E2E_USERS.admin);
  await page.goto('/#/health');
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route('**/api/system/worker/start', async (route) => {
    await held;
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'WORKER_EXTERNAL', message: 'Worker lain sudah berjalan di luar website (mis. npm run worker di terminal). Hentikan dari terminal tersebut.' }),
    });
  });
  const start = card(page).getByRole('button', { name: 'Jalankan scanner' });
  await start.click();
  await expect(start).toBeDisabled();
  await expect(card(page).locator('.worker-control')).toHaveAttribute('aria-busy', 'true');
  release();
  await expect(card(page).getByRole('alert')).toHaveText(/Worker lain sudah berjalan di luar website/);
  // State nyata dibaca ulang dari server (tetap berhenti), tombol aktif kembali.
  await expect(stateOf(page)).toHaveText('Berhenti');
  await expect(start).toBeEnabled();
});
