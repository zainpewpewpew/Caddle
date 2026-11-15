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

test('E2E-SIG-001 screener menampilkan sinyal dari API; filter server bekerja', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page);
  await page.goto('/#/screener');
  const results = page.getByTestId('screener-results');
  await expect(results.getByRole('cell', { name: 'SYNUSDT' })).toBeVisible();
  await expect(page.locator('.panel__actions .badge')).toHaveText('1 hasil');

  // Timeframe tetap (bukan filter): LONG Scanner 1h tanpa konteks HTF.
  await expect(page.getByTestId('scanner-timeframe')).toContainText('1h');
  await expect(page.getByTestId('scanner-timeframe')).toContainText('Tanpa konteks HTF');
  await expect(results.getByRole('cell', { name: '1h', exact: true })).toBeVisible();
  await page.getByLabel('Alignment').selectOption('COUNTERTREND');
  await expect(results.getByText('Tidak ada kandidat yang cocok')).toBeVisible();
  expect(errors).toEqual([]);
});

test('E2E-SIG-004 filter alignment screener dikirim ke server bersama limit=500, bukan disaring di klien', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page);
  const initial = page.waitForRequest((req) => req.url().includes('/api/signals/active'));
  await page.goto('/#/screener');
  expect(new URL((await initial).url()).searchParams.get('limit')).toBe('500');
  const results = page.getByTestId('screener-results');
  await expect(results.getByRole('cell', { name: 'SYNUSDT' })).toBeVisible();

  // Sinyal seed (pipeline asli atas candle SINTETIS) ber-alignment UNCONFIRMED.
  const filtered = page.waitForRequest((req) => {
    const params = new URL(req.url()).searchParams;
    return req.url().includes('/api/signals/active') && params.get('alignment') === 'UNCONFIRMED' && params.get('limit') === '500';
  });
  await page.getByLabel('Alignment').selectOption('UNCONFIRMED');
  await filtered;
  await expect(results.getByRole('cell', { name: 'SYNUSDT' })).toBeVisible();
  await expect(page.locator('.panel__actions .badge')).toHaveText('1 hasil');

  const other = page.waitForRequest((req) => new URL(req.url()).searchParams.get('alignment') === 'ALIGNED');
  await page.getByLabel('Alignment').selectOption('ALIGNED');
  await other;
  await expect(results.getByText('Tidak ada kandidat yang cocok')).toBeVisible();
  await expect(page.locator('.panel__actions .badge')).toHaveText('0 hasil');
  expect(errors).toEqual([]);
});

// Respons API diganti baris SINTETIS (bukan data pasar) hanya untuk memicu kondisi batas limit.
function syntheticActive(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1, symbol: `SYN${String(i).padStart(3, '0')}USDT`, timeframe: '5m', classification: 'SA', state: 'QUIET',
    patternKey: 'SA', patternVersion: 1, firstDetectedAt: Date.UTC(2027, 0, 1), firstDetectedPrice: 1, invalidationPrice: null,
    patternScore: 60, earlyScore: 50, alignment: null, riskFlags: [], explanation: [], peakPrice: null, peakState: 'QUIET',
    barsInState: 0, finalOutcome: null, updatedAt: Date.UTC(2027, 0, 1), closedAt: null, lastPrice: null, lastCandleAt: null,
  }));
}

test('E2E-SIG-005 respons tepat 500 baris (= limit, tanpa total dari API) → "≥ 500 hasil" & "mungkin terpotong", tidak mengklaim ada sisa', async ({ page }) => {
  const errors = watchErrors(page);
  const items = syntheticActive(500);
  await page.route('**/api/signals/active?*', (route) => route.fulfill({ json: { items, count: items.length } }));
  await signIn(page);
  await page.goto('/#/screener');
  const results = page.getByTestId('screener-results');
  await expect(page.getByRole('heading', { level: 1, name: 'LONG Scanner' })).toBeVisible();
  await expect(page.locator('.panel__actions .badge')).toHaveText('≥ 500 hasil');
  await expect(results.getByText('Batas 500 kandidat tercapai')).toBeVisible();
  await expect(results.getByText('mungkin terpotong')).toBeVisible();
  // count API = panjang halaman: klien tidak tahu apakah ada baris ke-501, jadi tidak boleh menyatakan "500+"/"sisanya".
  await expect(page.locator('.panel__actions .badge')).not.toHaveText(/500\+/);
  await expect(results.getByText(/sisanya/)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('E2E-SIG-006 batas: respons 499 baris (< limit 500) → "499 hasil" tanpa callout batas tercapai', async ({ page }) => {
  const errors = watchErrors(page);
  const items = syntheticActive(499);
  await page.route('**/api/signals/active?*', (route) => route.fulfill({ json: { items, count: items.length } }));
  await signIn(page);
  await page.goto('/#/screener');
  // Tunggu halaman screener terpasang: Overview (masih tampil sesaat setelah goto) juga punya badge di .panel__actions.
  await expect(page.getByRole('heading', { level: 1, name: 'LONG Scanner' })).toBeVisible();
  await expect(page.locator('.panel__actions .badge')).toHaveText('499 hasil');
  await expect(page.getByTestId('screener-results').getByRole('cell', { name: 'SYN498USDT' })).toBeVisible();
  await expect(page.getByTestId('screener-results').getByText('Batas 500 kandidat tercapai')).toHaveCount(0);
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


// Kolom "Update" scanner: baris SINTETIS (bukan data pasar) dengan updatedAt terkendali, jam browser palsu.
const UPDATE_NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
function updateRow(symbol, timeframe, updatedAt, earlyScore) {
  return {
    id: earlyScore, symbol, timeframe, classification: 'SA', state: 'QUIET', patternKey: 'SA', patternVersion: 1,
    firstDetectedAt: UPDATE_NOW - 6 * 3_600_000, firstDetectedPrice: 1, invalidationPrice: null, patternScore: 60, earlyScore,
    alignment: null, riskFlags: [], explanation: [], peakPrice: null, peakState: 'QUIET', barsInState: 0, finalOutcome: null,
    updatedAt, closedAt: null, lastPrice: null, lastCandleAt: null,
  };
}
const WORKER_RUNNING = { enabled: true, state: 'running', startedAt: UPDATE_NOW - 3_600_000, stoppedAt: null, exitCode: null, signal: null };

test('E2E-SIG-007 kolom Update: "Terbaru · jam candle" selama evaluasi terakhir = candle terakhir yang tutup (candle 1h 36 menit lalu tetap terbaru); lalu teks relatif berdetak walau scanner berhenti; sinyal 1h yang 4 jam tidak dievaluasi ditandai "Basi"', async ({ page }) => {
  const errors = watchErrors(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install({ time: UPDATE_NOW });
  // Kasus laporan pengguna: candle 1h yang tutup 36 menit lalu = candle 1h TERAKHIR → "Terbaru", bukan "36 menit lalu".
  const items = [
    updateRow('FRSHUSDT', '5m', UPDATE_NOW - 30_000, 90),
    updateRow('HOURUSDT', '1h', UPDATE_NOW - 36 * 60_000 - 1, 85),
    updateRow('OLDXUSDT', '1h', UPDATE_NOW - 4 * 3_600_000, 80),
  ];
  await page.route('**/api/signals/active?*', (route) => route.fulfill({ json: { items, count: items.length } }));
  await signIn(page);
  await page.goto('/#/screener');
  const results = page.getByTestId('screener-results');
  const fresh = results.locator('tbody tr', { hasText: 'FRSHUSDT' }).getByTestId('updated-at');
  const hour = results.locator('tbody tr', { hasText: 'HOURUSDT' }).getByTestId('updated-at');
  const stale = results.locator('tbody tr', { hasText: 'OLDXUSDT' }).getByTestId('updated-at');
  // UPDATE_NOW = 12:00 UTC = 19:00 WIB.
  await expect(fresh.locator('.updated-at__text')).toHaveText('Terbaru · 18:59');
  await expect(fresh).toHaveAttribute('data-fresh', 'true');
  await expect(fresh).not.toHaveAttribute('data-stale', 'true');
  await expect(fresh.getByText('Basi')).toBeHidden();
  await expect(hour.locator('.updated-at__text')).toHaveText('Terbaru · 18:24');
  await expect(hour).toHaveAttribute('title', /Terbaru: sudah dievaluasi pada candle 1h terakhir yang tutup 18:24 WIB \(36 menit lalu\)\. Candle 1h berikutnya tutup 19:24 WIB/);
  await expect(stale).toHaveAttribute('data-stale', 'true');
  await expect(stale).not.toHaveAttribute('data-fresh', 'true');
  await expect(stale.locator('.updated-at__text')).toHaveText('4 jam lalu');
  await expect(stale.getByText('Basi')).toBeVisible();
  await expect(stale).toHaveAttribute('title', /Basi: evaluasi terakhir pada candle 1h/);

  // Server E2E tidak menjalankan worker → tidak ada penyegaran data; ticker tetap menghitung ulang umur.
  await page.clock.fastForward(60_000);
  await expect(fresh.locator('.updated-at__text')).toHaveText('Terbaru · 18:59');
  // 5m: lewat 1 candle + 2 menit tanpa evaluasi baru → bukan "Terbaru" lagi (teks relatif), belum basi.
  await page.clock.fastForward(7 * 60_000);
  await expect(fresh.locator('.updated-at__text')).toHaveText('8 menit lalu');
  await expect(fresh).not.toHaveAttribute('data-fresh', 'true');
  await expect(fresh).not.toHaveAttribute('data-stale', 'true');
  // 5m: lewat 12 menit (2 candle + 2 menit) tanpa evaluasi baru → basi.
  await page.clock.fastForward(5 * 60_000);
  await expect(fresh).toHaveAttribute('data-stale', 'true');
  await expect(fresh.getByText('Basi')).toBeVisible();
  expect(errors).toEqual([]);
});

test('E2E-SIG-008 scanner berjalan + baris kandidat sedang fokus → penyegaran latar tetap jalan (Update maju) dan fokus kembali ke baris yang sama', async ({ page }) => {
  const errors = watchErrors(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install({ time: UPDATE_NOW });
  await page.route('**/api/system/worker', (route) => route.fulfill({ json: WORKER_RUNNING }));
  await page.route('**/api/system/sync*', async (route) => {
    const response = await route.fetch();
    return route.fulfill({ response, json: { ...(await response.json()), worker: WORKER_RUNNING } });
  });
  let advanced = false;
  let laterCalls = 0;
  await page.route('**/api/signals/active?*', (route) => {
    if (advanced) laterCalls += 1;
    // Setelah jam dimajukan = worker sudah mengevaluasi candle yang baru tutup.
    const at = advanced ? UPDATE_NOW + 85_000 : UPDATE_NOW - 4 * 60_000;
    const items = [updateRow('FRSHUSDT', '5m', at, 90), updateRow('SECNUSDT', '5m', at, 80)];
    return route.fulfill({ json: { items, count: items.length } });
  });
  await signIn(page);
  await page.goto('/#/screener');
  const results = page.getByTestId('screener-results');
  const row = () => results.locator('tbody tr', { hasText: 'SECNUSDT' });
  const text = () => row().getByTestId('updated-at').locator('.updated-at__text');
  // Evaluasi 4 menit lalu pada candle 5m = candle terakhir yang tutup → terbaru (jam WIB candle).
  await expect(text()).toHaveText('Terbaru · 18:56');
  await row().focus();

  advanced = true;
  await page.clock.fastForward(31_000);
  await expect.poll(() => laterCalls).toBeGreaterThan(0);
  await page.clock.fastForward(60_000);
  await expect(text()).toHaveText('Terbaru · 19:01');
  await expect(row()).toBeFocused();
  expect(errors).toEqual([]);
});

test('E2E-SIG-009 tombol "Jalankan scanner": begitu worker berjalan, tabel dimuat ulang cepat (tiap 5 dtk selama 2 menit), bukan menunggu 30 dtk', async ({ page }) => {
  const errors = watchErrors(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install({ time: UPDATE_NOW });
  let running = false;
  const WORKER_STOPPED = { enabled: true, state: 'stopped', startedAt: null, stoppedAt: UPDATE_NOW - 3_600_000, exitCode: 0, signal: null };
  await page.route('**/api/system/worker', (route) => route.fulfill({ json: running ? WORKER_RUNNING : WORKER_STOPPED }));
  await page.route('**/api/system/worker/start', (route) => {
    running = true;
    return route.fulfill({ status: 202, json: WORKER_RUNNING });
  });
  await page.route('**/api/system/sync*', async (route) => {
    const response = await route.fetch();
    return route.fulfill({ response, json: { ...(await response.json()), worker: running ? WORKER_RUNNING : WORKER_STOPPED } });
  });
  let calls = 0;
  await page.route('**/api/signals/active?*', (route) => {
    calls += 1;
    // SHORT 15m: sebelum start terakhir dievaluasi 40 menit lalu (> 2 candle + 2 menit → Basi); sesudah start = candle terbaru.
    const updatedAt = running ? UPDATE_NOW : UPDATE_NOW - 40 * 60_000;
    const items = [{ ...updateRow('FRSHUSDT', '15m', updatedAt, 90), direction: 'SHORT', classification: 'SD', patternKey: 'SD' }];
    return route.fulfill({ json: { items, count: items.length } });
  });
  // Hanya admin yang dapat menjalankan scanner.
  await page.goto('/login.html');
  await page.getByLabel('Username').fill(E2E_USERS.admin.username);
  await page.getByLabel('Kata sandi').fill(E2E_USERS.admin.password);
  await page.getByRole('button', { name: 'Masuk' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  await page.goto('/#/short-scanner');
  const cell = page.getByTestId('short-screener-results').locator('tbody tr', { hasText: 'FRSHUSDT' }).getByTestId('updated-at');
  await expect(cell).toHaveAttribute('data-stale', 'true');

  await page.getByRole('button', { name: /Jalankan scanner/ }).first().click();
  await expect(page.getByTestId('scan-radar')).toHaveAttribute('data-active', 'true');
  const before = calls;
  // Jauh di bawah REFRESH_MS (30 dtk): muatan ulang cepat sudah membawa evaluasi baru.
  await page.clock.fastForward(6_000);
  await expect.poll(() => calls).toBeGreaterThan(before);
  await expect(cell.locator('.updated-at__text')).toHaveText('Terbaru · 19:00');
  await expect(cell).not.toHaveAttribute('data-stale', 'true');
  expect(errors).toEqual([]);
});
