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
  await expect(callout.getByTestId('worker-callout-message')).toHaveText('Scanner belum berjalan. Data pasar dan sinyal tidak diperbarui. Minta admin menjalankannya dari System Health.');
  await expect(callout.getByRole('button')).toHaveCount(0);

  // Kontrol persisten yang sama tampil di atas tabel LONG Scanner dan SHORT Scanner, juga tanpa tombol untuk analyst.
  for (const [route, title] of [['screener', 'LONG Scanner'], ['short-scanner', 'SHORT Scanner']]) {
    await page.goto(`/#/${route}`);
    await expect(page.locator('.page h1')).toHaveText(title);
    const control = page.getByTestId('worker-callout');
    await expect(control).toContainText('Scanner belum berjalan.');
    await expect(control.getByRole('button')).toHaveCount(0);
  }

  await page.goto('/#/health');
  await expect(stateOf(page)).toHaveText('Berhenti');
  await expect(card(page).getByText('Hanya admin yang dapat menjalankan atau menghentikan scanner.')).toBeVisible();
  await expect(card(page).getByRole('button')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('E2E-SUP-003 admin menjalankan scanner dari kontrol Overview; tombol tetap tampil dan dapat menghentikan scanner', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, E2E_USERS.admin);
  const callout = page.getByTestId('worker-callout');
  await expect(callout).toContainText('Scanner belum berjalan.');
  await callout.getByRole('button', { name: 'Jalankan scanner' }).click();
  await expect(callout).toContainText('Scanner berjalan.');
  // Tombol tidak hilang: berganti menjadi "Hentikan scanner" (nonaktif selama pemantauan sesaat setelah start).
  await expect(callout.getByRole('button')).toHaveCount(1);
  await expect(callout.getByRole('button', { name: 'Hentikan scanner' })).toBeVisible();

  await page.goto('/#/health');
  await expect(stateOf(page)).toHaveText('Berjalan');
  // Kontrol Overview yang dimuat saat scanner berjalan: "Hentikan scanner" langsung aktif, dengan konfirmasi inline.
  await page.goto('/#/overview');
  await expect(page.locator('.page h1')).toHaveText('Overview');
  const control = page.getByTestId('worker-callout');
  const stop = control.getByRole('button', { name: 'Hentikan scanner' });
  await expect(stop).toBeEnabled();
  await stop.click();
  const confirm = control.getByRole('group', { name: /Hentikan scanner\?/ });
  await expect(confirm.getByRole('button', { name: 'Batal' })).toBeFocused();
  await confirm.getByRole('button', { name: 'Ya, hentikan' }).click();
  await expect(confirm).toBeHidden();
  // Worker tiruan keluar segera setelah SIGTERM; kontrol memantau tiap 2 detik sampai "Berhenti".
  await expect(control).toContainText('Scanner belum berjalan.', { timeout: 10_000 });
  await expect(control.getByRole('button', { name: 'Jalankan scanner' })).toBeEnabled();
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

// ---- Temuan review: worker yang crash sesaat setelah spawn & fokus keyboard callout ----

const RUNNING = { enabled: true, state: 'running', startedAt: Date.UTC(2026, 9, 25, 12), stoppedAt: null, exitCode: null, signal: null };
const CRASHED = { ...RUNNING, state: 'crashed', stoppedAt: Date.UTC(2026, 9, 25, 12, 0, 1), exitCode: 1 };

/** Server "menjalankan" worker yang langsung crash: POST start → running, GET status berikutnya → crashed. */
async function mockCrashAfterSpawn(page) {
  let started = false;
  await page.route('**/api/system/worker/start', async (route) => {
    started = true;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RUNNING) });
  });
  await page.route('**/api/system/worker', async (route) => {
    if (!started) return route.fallback();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CRASHED) });
  });
}

test('E2E-SUP-005 worker crash sesaat setelah dijalankan → kartu System Health menampilkan "Gagal (kode keluar 1)" dalam beberapa detik (tidak tertahan "Berjalan")', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, E2E_USERS.admin);
  await page.goto('/#/health');
  await expect(stateOf(page)).toHaveText('Berhenti');
  await mockCrashAfterSpawn(page);
  const clickedAt = Date.now();
  await card(page).getByRole('button', { name: 'Jalankan scanner' }).click();
  await expect(stateOf(page)).toHaveText('Berjalan');
  // Lebih cepat dari auto-refresh halaman (10 detik): UI terus memantau sesaat setelah start.
  await expect(stateOf(page)).toHaveText('Gagal (kode keluar 1)', { timeout: 6_000 });
  expect(Date.now() - clickedAt).toBeLessThan(8_000);
  await expect(card(page).getByRole('button', { name: 'Jalankan scanner' })).toBeEnabled();
  await expect(card(page).getByRole('button', { name: 'Hentikan scanner' })).toBeDisabled();
  expect(errors).toEqual([]);
});

test('E2E-SUP-006 callout Overview: worker crash sesaat setelah dijalankan → pesan crash & tombol "Jalankan scanner" kembali', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, E2E_USERS.admin);
  const callout = page.getByTestId('worker-callout');
  await expect(callout).toContainText('Scanner belum berjalan.');
  await mockCrashAfterSpawn(page);
  await callout.getByRole('button', { name: 'Jalankan scanner' }).click();
  await expect(callout).toContainText('Scanner berjalan.');
  await expect(callout).toContainText('Gagal (kode keluar 1)', { timeout: 6_000 });
  await expect(callout.getByTestId('worker-callout-message')).toHaveText('Scanner berhenti tak terduga — Gagal (kode keluar 1). Data pasar dan sinyal tidak diperbarui.');
  await expect(callout.getByRole('button', { name: 'Jalankan scanner' })).toBeEnabled();
  expect(errors).toEqual([]);
});

test('E2E-SUP-007 kontrol Overview dengan keyboard: setelah start berhasil tombol tetap ada sebagai "Hentikan scanner" dan fokus tetap di dalam kontrol, tidak hilang ke <body>', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, E2E_USERS.admin);
  const callout = page.getByTestId('worker-callout');
  const button = callout.getByRole('button', { name: 'Jalankan scanner' });
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(callout).toContainText('Scanner berjalan.');
  const stopButtons = await callout.getByRole('button', { name: 'Hentikan scanner' }).count();
  const focused = await page.evaluate(() => ({
    tag: document.activeElement?.tagName,
    text: document.activeElement?.textContent,
    inCallout: Boolean(document.activeElement?.closest('[data-testid="worker-callout"]')),
  }));

  // Scanner dihentikan lebih dulu agar tes berikutnya mulai dari "Berhenti" walau asersi fokus gagal.
  await page.goto('/#/health');
  await expect(stateOf(page)).toHaveText('Berjalan');
  await stopViaUi(page);
  expect(stopButtons).toBe(1);
  // Tombol yang ditekan tetap memegang fokus (aria-disabled selama pemantauan, bukan atribut disabled).
  expect(focused.tag).toBe('BUTTON');
  expect(focused.text).toBe('Hentikan scanner');
  expect(focused.inCallout).toBe(true);
  expect(errors).toEqual([]);
});

// ---- Animasi progres selama perintah scanner diproses ----

/** Seperti mockCrashAfterSpawn, tetapi POST start ditahan sampai `release()` dipanggil. */
async function mockHeldStartThenCrash(page) {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let started = false;
  await page.route('**/api/system/worker/start', async (route) => {
    await held;
    started = true;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RUNNING) });
  });
  await page.route('**/api/system/worker', async (route) => {
    if (!started) return route.fallback();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CRASHED) });
  });
  return () => release();
}

const animationOf = (locator) => locator.evaluate((el) => getComputedStyle(el, '::before').animationName);

test('E2E-SUP-008 System Health: bar progres beranimasi selama start diproses & dipantau, hilang setelah state final', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, E2E_USERS.admin);
  await page.goto('/#/health');
  await expect(stateOf(page)).toHaveText('Berhenti');
  const progress = card(page).getByTestId('worker-control-progress');
  await expect(progress).toBeHidden();
  const release = await mockHeldStartThenCrash(page);
  await card(page).getByRole('button', { name: 'Jalankan scanner' }).click();
  await expect(card(page).getByRole('progressbar', { name: 'Memproses perintah scanner' })).toBeVisible();
  expect(await animationOf(progress)).toBe('lr-indeterminate');
  release();
  await expect(stateOf(page)).toHaveText('Berjalan');
  // Jendela pemantauan sesaat setelah start: bar tetap tampil sampai state final diketahui.
  await expect(progress).toBeVisible();
  await expect(stateOf(page)).toHaveText('Gagal (kode keluar 1)', { timeout: 6_000 });
  await expect(progress).toBeHidden();
  expect(errors).toEqual([]);
});

test('E2E-SUP-009 callout Overview: bar progres tampil selama start diproses, hilang setelah state final', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, E2E_USERS.admin);
  const callout = page.getByTestId('worker-callout');
  await expect(callout).toContainText('Scanner belum berjalan.');
  const progress = callout.getByTestId('worker-callout-progress');
  await expect(progress).toBeHidden();
  const release = await mockHeldStartThenCrash(page);
  await callout.getByRole('button', { name: 'Jalankan scanner' }).click();
  await expect(callout.getByRole('progressbar', { name: 'Memproses perintah scanner' })).toBeVisible();
  expect(await animationOf(progress)).toBe('lr-indeterminate');
  release();
  await expect(callout).toContainText('Scanner berjalan.');
  await expect(progress).toBeVisible();
  await expect(callout).toContainText('Gagal (kode keluar 1)', { timeout: 6_000 });
  await expect(progress).toBeHidden();
  expect(errors).toEqual([]);
});

test('E2E-SUP-010 prefers-reduced-motion: bar progres statis (tanpa animasi)', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signIn(page, E2E_USERS.admin);
  await page.goto('/#/health');
  await expect(stateOf(page)).toHaveText('Berhenti');
  const progress = card(page).getByTestId('worker-control-progress');
  const release = await mockHeldStartThenCrash(page);
  await card(page).getByRole('button', { name: 'Jalankan scanner' }).click();
  await expect(progress).toBeVisible();
  expect(await animationOf(progress)).toBe('none');
  release();
  await expect(stateOf(page)).toHaveText('Gagal (kode keluar 1)', { timeout: 6_000 });
});
