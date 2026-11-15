import { expect, test } from '@playwright/test';
import { E2E_USERS } from './fixtures.js';

// Strip status scanner di app shell (frontend/js/views/statusStrip.js): status NYATA dari GET /api/system/sync —
// di sini payload sync & supervisor ditiru (page.route) agar keadaan live / crash / berhenti dapat diuji tanpa Binance.
// Semua angka di bawah adalah DATA UJI SINTETIS.

// 2026-11-15 12:04:20 UTC = 19:04:20 WIB.
const NOW = Date.UTC(2026, 10, 15, 12, 4, 20);
const RUNNING = { enabled: true, state: 'running', startedAt: NOW - 10 * 60_000, stoppedAt: null, exitCode: null, signal: null, via: 'autostart', autoRestart: true, restartAt: null };
const SCAN = {
  seq: 57, at: NOW - 15_000, finishedAt: NOW - 14_990, durationMs: 10, symbols: 40, series: 120, fresh: 120, stale: 0, repaired: 0,
  priced: 118, lastPriceAt: NOW - 2_000, open: { long: 4, short: 2, radar: 38 }, intervalMs: 60_000, nextAt: NOW + 45_000,
};
const ACTIVITY = [
  { id: 1, at: NOW - 9 * 60_000, kind: 'start' },
  { id: 2, at: NOW - 9 * 60_000 + 1_000, kind: 'discovery', cycle: 'initial', symbols: 40, failed: false },
  { id: 3, at: NOW - 8 * 60_000, kind: 'bootstrap', series: 120, candles: 60_000, failed: 0 },
  { id: 4, at: NOW - 4 * 60_000 - 18_000, kind: 'candles', timeframe: '15m', closeTime: Date.UTC(2026, 10, 15, 11, 59, 59, 999), count: 40 },
  { id: 5, at: NOW - 4 * 60_000 - 17_000, kind: 'signal', symbol: 'ETHUSDT', timeframe: '15m', direction: 'SHORT', state: 'EARLY_BEARISH', tier: 'B' },
  { id: 6, at: NOW - 15_000, kind: 'scan', seq: 57, series: 120, fresh: 120, stale: 0, repaired: 0, priced: 118, durationMs: 10, open: { long: 4, short: 2, radar: 38 } },
];

// Tanpa serverTime: mock tidak mengikuti jam palsu halaman (page.clock), jadi strip memakai jam halaman apa adanya
// (koreksi selisih jam server−klien = 0).
function syncPayload({ worker = RUNNING, scanner = {}, binance = { status: 'ok', ws: 'open' } } = {}) {
  return {
    worker,
    binance,
    recentErrors: [],
    scanner: {
      status: 'ok', phase: 'running', heartbeatAt: NOW - 5_000, symbols: 40, streams: 120, staleStreams: 0, errors: 0,
      scan: SCAN, scanIntervalMs: 60_000, nextScanAt: NOW + 45_000, activity: ACTIVITY,
      sync: { step: 'live', cycle: 'initial', streamsTotal: 120, streamsDone: 120, streamsFailed: 0, candlesStored: 60_000, lastCandleAt: NOW - 260_000, lastAnalysisAt: NOW - 255_000, progress: null },
      ...scanner,
    },
  };
}

async function signIn(page) {
  await page.goto('/login.html');
  await page.getByLabel('Username').fill(E2E_USERS.analyst.username);
  await page.getByLabel('Kata sandi').fill(E2E_USERS.analyst.password);
  await page.getByRole('button', { name: 'Masuk' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
}

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`console: ${msg.text()}`); });
  return errors;
}

async function mockScanner(page, payload) {
  const state = { payload };
  await page.route('**/api/system/sync*', (route) => route.fulfill({ json: state.payload }));
  await page.route('**/api/system/worker', (route) => route.fulfill({ json: state.payload.worker }));
  return state;
}

test('E2E-STRIP-001 scanner live: strip di semua halaman menampilkan scan terakhir & berikutnya, cakupan, harga masuk, candle berikutnya; panel Aktivitas terbaru di atas', async ({ page, isMobile }) => {
  const errors = watchErrors(page);
  await page.clock.install({ time: NOW });
  await mockScanner(page, syncPayload());
  await signIn(page);
  const strip = page.getByTestId('status-strip');
  await expect(strip).toBeVisible();
  await expect(strip.getByTestId('status-strip-label')).toHaveText('Live');
  await expect(strip.getByTestId('status-strip-scan')).toHaveText(/^Scan #57 19:04:05 · berikutnya 0:4\d$/);
  await expect(strip.getByTestId('status-strip-price')).toHaveText('Harga live 118/120 seri');
  await expect(strip.getByTestId('status-strip-candle')).toHaveText(/^Candle 15m tutup 19:15 · 1h tutup 20:00 \(10:\d\d\)$/);
  if (isMobile) await expect(strip.getByTestId('status-strip-coverage')).toBeHidden();
  else await expect(strip.getByTestId('status-strip-coverage')).toHaveText('40 koin · 120/120 seri mutakhir');

  // Hitung mundur berjalan tanpa request baru.
  await page.clock.fastForward(10_000);
  await expect(strip.getByTestId('status-strip-scan')).toHaveText(/berikutnya 0:3\d$/);

  const toggle = strip.getByTestId('activity-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(strip.getByTestId('activity-count')).toHaveText('7');
  await toggle.click();
  const panel = page.getByTestId('activity-panel');
  await expect(panel).toBeVisible();
  const items = panel.getByTestId('activity-list').locator('li');
  await expect(items).toHaveCount(7);
  await expect(items.first()).toContainText('19:04:05');
  await expect(items.first()).toContainText('Scan #57: 120/120 seri mutakhir · harga live 118 seri · sinyal terbuka LONG 4 · SHORT 2 · radar 38');
  await expect(items.nth(1)).toContainText('Sinyal SHORT ETHUSDT 15m → Early bearish (tier B)');
  await expect(items.nth(2)).toContainText('Candle 15m 19:00 tutup · 40 koin dianalisis');
  await expect(items.last()).toContainText('Scanner dijalankan otomatis saat server start (npm start)');
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(toggle).toBeFocused();

  // Strip tetap ada di halaman lain; tabel scanner mengabarkan jam muat ulang (tiap 1 menit).
  await page.goto('/#/short-scanner');
  await expect(strip.getByTestId('status-strip-label')).toHaveText('Live');
  if (!isMobile) await expect(strip.getByTestId('status-strip-page')).toHaveText(/^Tabel diperbarui 19:04:\d\d · berikutnya 1:00$/);
  // Tidak ada scroll horizontal (ponsel 390 px).
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('E2E-STRIP-002 crash dengan start ulang otomatis terjadwal → strip merah dengan hitung mundur; sinkron histori → progres seri', async ({ page }) => {
  const errors = watchErrors(page);
  await page.clock.install({ time: NOW });
  const crashed = { ...RUNNING, state: 'crashed', exitCode: 1, stoppedAt: NOW - 2_000, restartAt: NOW + 18_000 };
  const state = await mockScanner(page, syncPayload({ worker: crashed, scanner: { status: 'stale', heartbeatAt: NOW - 120_000 } }));
  await signIn(page);
  const strip = page.getByTestId('status-strip');
  await expect(strip.getByTestId('status-strip-label')).toHaveText('Scanner berhenti tak terduga');
  await expect(strip.getByTestId('status-strip-detail')).toHaveText(/^Gagal \(kode keluar 1\) — dijalankan ulang otomatis 19:04:38 \(dalam 0:1\d\)$/);
  await expect(strip).toHaveAttribute('data-tone', 'error');

  // Child baru (auto-restart) sudah menulis heartbeat run-nya sendiri (heartbeat setelah startedAt).
  state.payload = syncPayload({
    worker: { ...RUNNING, via: 'auto-restart', startedAt: NOW - 1_000 },
    scanner: {
      heartbeatAt: NOW, scan: null, nextScanAt: null,
      sync: { step: 'bootstrap', cycle: 'initial', streamsTotal: 120, streamsDone: 45, streamsFailed: 0, progress: 0.375 },
    },
  });
  await page.clock.fastForward(12_000);
  await expect(strip.getByTestId('status-strip-label')).toHaveText('Sinkron data');
  await expect(strip.getByTestId('status-strip-detail')).toHaveText('Mengunduh histori candle 45/120 seri (37%)');
  await expect(strip.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '37');
  expect(errors).toEqual([]);
});

test('E2E-STRIP-003 scanner berhenti → strip netral menjelaskan data tidak diperbarui', async ({ page }) => {
  const errors = watchErrors(page);
  const stopped = { ...RUNNING, state: 'stopped', startedAt: null, stoppedAt: NOW - 60_000, exitCode: 0, via: 'manual', autoRestart: false };
  await mockScanner(page, syncPayload({ worker: stopped, scanner: { status: 'stopped', scan: null, activity: [], sync: null } }));
  await signIn(page);
  const strip = page.getByTestId('status-strip');
  await expect(strip.getByTestId('status-strip-label')).toHaveText('Scanner berhenti');
  await expect(strip.getByTestId('status-strip-detail')).toContainText('Data & harga tidak diperbarui');
  await expect(strip).toHaveAttribute('data-tone', 'idle');
  expect(errors).toEqual([]);
});
