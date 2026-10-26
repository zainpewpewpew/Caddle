import { expect, test } from '@playwright/test';
import { E2E_USERS } from './fixtures.js';
import {
  REVERSAL_NOW, WORKER_RUNNING, candidate, filterCandidates, reversalCandidates, reversalDetail, syntheticCandles,
} from './fixtures.reversal.js';

// LONG Scanner — Reversal Radar (docs/19 §8). Server E2E KOSONG (port 8181); respons /api/reversal/* dimock di
// browser lewat page.route dengan fixture SINTETIS (tests/e2e/fixtures.reversal.js) sehingga tes hermetis dan tidak
// bergantung pada backend reversal. Konfigurasi proyek menjalankan setiap tes di desktop (1440px) dan mobile (390px).

// Satu-satunya pelanggaran CSP yang diterima (sama seperti neural.spec.js E2E-NEU-003; didokumentasikan di
// frontend/js/lib/chart.js): logo atribusi lightweight-charts 5.2.1 memasang <style> inline yang DIBLOKIR CSP
// (gaya penggantinya ada di components.css). Hanya blok dengan hash persis ini yang dikecualikan.
const TV_LOGO_STYLE_HASH = 'sha256-3pRED1tOXas1FXFoPb9TGCjmYe9XQsmO9OV23khV2nY=';
const TV_LOGO_STYLE_CSP = new RegExp(`Applying inline style violates .*${TV_LOGO_STYLE_HASH.replace(/[+/=]/g, '\\$&')}`);

/** Kumpulkan error konsol, error JS, dan pelanggaran CSP; `ignore` = pola pesan yang memang diharapkan. */
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

const isCandidateList = (url) => url.pathname === '/api/reversal/candidates';
const isCandidateDetail = (url) => /^\/api\/reversal\/candidates\/[^/]+$/.test(url.pathname);
const detailIdOf = (url) => url.pathname.split('/').pop();

/**
 * Mock API Reversal Radar: daftar (dengan semantik filter server atas fixture) + detail per id (404 bila tidak ada).
 * Mengembalikan daftar query (URLSearchParams) setiap request daftar, urut waktu.
 */
async function mockReversal(page, { items = reversalCandidates(), detail = (id) => reversalDetail(id, items) } = {}) {
  const requests = [];
  await page.route(isCandidateList, (route) => {
    const params = new URL(route.request().url()).searchParams;
    requests.push(params);
    return route.fulfill({ json: filterCandidates(items, params) });
  });
  await page.route(isCandidateDetail, (route) => {
    const found = detail(detailIdOf(new URL(route.request().url())));
    return found
      ? route.fulfill({ json: found })
      : route.fulfill({ status: 404, json: { error: 'NOT_FOUND', message: 'Tidak ditemukan' } });
  });
  return requests;
}

/** Candle sintetis untuk mini-chart (server kosong tidak punya candle). */
async function mockCandles(page) {
  await page.route((url) => url.pathname === '/api/market/candles', (route) => {
    const params = new URL(route.request().url()).searchParams;
    const symbol = params.get('symbol');
    const timeframe = params.get('timeframe');
    const items = syntheticCandles(symbol, timeframe);
    return route.fulfill({ json: { symbol, timeframe, items, count: items.length } });
  });
}

async function gotoRadar(page) {
  await page.goto('/#/screener');
  await expect(page.getByTestId('reversal-early')).toBeVisible();
  await expect(page.getByTestId('reversal-summary')).not.toHaveText('Memuat kandidat…');
}

const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const filterForm = (page) => page.getByRole('form', { name: 'Filter Reversal Radar' });
const panelRow = (page, testId, symbol) => page.getByTestId(testId).locator('tbody tr', { hasText: symbol });
const waitForList = (page, predicate) => page.waitForRequest((req) => {
  const url = new URL(req.url());
  return isCandidateList(url) && predicate(url.searchParams);
});

test('E2E-RR-001 tiga panel tahap urut tetap dengan jumlah per timeframe; filter default dikirim ke server; panel SA/PVA terlipat; tanpa overflow', async ({ page }) => {
  const errors = watchErrors(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const requests = await mockReversal(page);
  await signIn(page);
  await gotoRadar(page);

  // Judul: nama heading tetap "LONG Scanner" (nav & topbar), "Reversal Radar" tampil sebagai bagian judul.
  await expect(page.getByRole('heading', { level: 1, name: 'LONG Scanner' })).toBeVisible();
  await expect(page.getByTestId('reversal-title')).toHaveText('Reversal Radar');
  // Catatan status validasi data nyata (docs/21 §6.6) selalu tampil di bawah subjudul — transparansi hasil replay.
  await expect(page.getByTestId('reversal-validation')).toContainText('Status validasi');
  await expect(page.getByTestId('reversal-validation')).toContainText('belum ada bukti keunggulan');
  await expect(page.locator('.page__subtitle')).toContainText('bukan probabilitas');

  // Urutan tetap: dua tahap awal di atas, Confirmed Breakout paling bawah.
  expect(await page.locator('.rr-stage').evaluateAll((els) => els.map((el) => el.dataset.stage)))
    .toEqual(['EARLY_FORMATION', 'DEVELOPING_REVERSAL', 'CONFIRMED_BREAKOUT']);
  await expect(page.getByTestId('reversal-early-counts')).toHaveText('5m 1 · 15m 2 · 1H 1');
  await expect(page.getByTestId('reversal-developing-counts')).toHaveText('5m 1 · 15m 1 · 1H 1');
  await expect(page.getByTestId('reversal-confirmed-counts')).toHaveText('5m 1 · 15m 1 · 1H 1');
  await expect(page.getByTestId('reversal-summary')).toContainText('10 kandidat · Early 4 · Developing 3 · Confirmed 3 · 1 provisional');

  // Baris berada di panel tahapnya; kolom sesuai §8.4.
  await expect(panelRow(page, 'reversal-early', 'ALPUSDT')).toBeVisible();
  await expect(panelRow(page, 'reversal-developing', 'DELUSDT')).toBeVisible();
  await expect(panelRow(page, 'reversal-confirmed', 'THEUSDT')).toBeVisible();
  await expect(page.getByTestId('reversal-confirmed').locator('tbody tr', { hasText: 'ALPUSDT' })).toHaveCount(0);
  const headers = await page.getByTestId('reversal-early').locator('thead th').allTextContents();
  expect(headers).toEqual(['Pair', 'TF', 'Jenis setup', 'Status', 'Skor', 'Bukti', 'Harga', 'Sejak deteksi', 'Likuiditas', 'Candle', 'Deteksi pertama', 'Update']);
  const the = panelRow(page, 'reversal-confirmed', 'THEUSDT');
  await expect(the.locator('.rr-pill')).toContainText('Terkonfirmasi');
  await expect(the.locator('.rr-move__badge[data-kind="late"]')).toHaveText('Terlambat');
  await expect(the.locator('.rr-candle')).toHaveText('Tutup');
  await expect(the.locator('.score .num')).toHaveText('87');
  await expect(panelRow(page, 'reversal-early', 'ALPUSDT').locator('[data-liquidity="THIN"]')).toHaveText('Tipis');

  // Filter default dikirim eksplisit ke server (sensitivitas Sedang, extended & provisional ikut, limit 500).
  expect(requests.length).toBeGreaterThan(0);
  const first = requests[0];
  expect(first.get('sensitivity')).toBe('MEDIUM');
  expect(first.get('includeExtended')).toBe('1');
  expect(first.get('includeProvisional')).toBe('1');
  expect(first.get('limit')).toBe('500');
  expect(first.get('timeframe')).toBeNull();
  expect(first.get('stage')).toBeNull();

  // Kontrol scanner persisten & radar header tetap ada.
  await expect(page.getByTestId('worker-callout')).toContainText('Scanner belum berjalan.');
  await expect(page.getByTestId('scan-radar')).toHaveAttribute('data-active', 'false');

  // Panel sekunder SA/PVA: terlipat (server kosong → 0 kandidat lama), isinya tabel LONG lama apa adanya.
  const legacy = page.getByTestId('reversal-legacy');
  await expect(legacy).toBeVisible();
  await expect(legacy.locator('summary')).toContainText('Pola SA/PVA 15m (mesin lama)');
  await expect(legacy.getByTestId('reversal-legacy-count')).toHaveText('0 kandidat');
  expect(await legacy.evaluate((el) => el.open)).toBe(false);
  await expect(legacy.getByTestId('screener-results')).toBeAttached();
  await legacy.locator('summary').click();
  await expect(legacy.getByTestId('scanner-timeframe')).toContainText('15m');
  await expect(legacy.getByTestId('screener-results').getByText('Belum ada kandidat LONG')).toBeVisible();
  await expect(legacy.locator('.panel__actions .badge')).toHaveText('0 hasil');

  expect(await overflow(page)).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

test('E2E-RR-002 filter timeframe/tahap/sensitivitas/likuiditas dikirim ke server sebagai query dan disimpan di localStorage', async ({ page }) => {
  const errors = watchErrors(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockReversal(page);
  await signIn(page);
  await gotoRadar(page);
  const form = filterForm(page);

  const req15 = waitForList(page, (p) => p.get('timeframe') === '15m');
  await form.getByRole('radio', { name: '15m' }).check();
  await req15;
  await expect(page.getByTestId('reversal-early-counts')).toHaveText('5m 0 · 15m 2 · 1H 0');
  await expect(panelRow(page, 'reversal-early', 'ALPUSDT')).toHaveCount(0);

  const reqStage = waitForList(page, (p) => p.get('timeframe') === '15m' && p.get('stage') === 'DEVELOPING_REVERSAL');
  await form.getByLabel('Tahap').selectOption('DEVELOPING_REVERSAL');
  await reqStage;
  await expect(page.getByTestId('reversal-early').getByText('Belum ada kandidat Early Formation pada filter ini')).toBeVisible();
  await expect(panelRow(page, 'reversal-developing', 'EPSUSDT')).toBeVisible();

  // Kembali ke Semua timeframe & tahap, lalu sensitivitas Rendah: hanya skor ≥ 60 dengan ≥ 4 bukti.
  await form.getByLabel('Tahap').selectOption('');
  const reqAll = waitForList(page, (p) => p.get('timeframe') === null && p.get('stage') === null);
  await form.getByRole('radio', { name: 'Semua' }).check();
  await reqAll;
  const reqLow = waitForList(page, (p) => p.get('sensitivity') === 'LOW');
  await form.getByLabel('Sensitivitas').selectOption('LOW');
  await reqLow;
  await expect(page.getByTestId('reversal-early-counts')).toHaveText('5m 0 · 15m 0 · 1H 0');
  await expect(page.getByTestId('reversal-developing-counts')).toHaveText('5m 1 · 15m 1 · 1H 0');
  await expect(page.getByTestId('reversal-confirmed-counts')).toHaveText('5m 0 · 15m 1 · 1H 0');
  await expect(page.getByTestId('reversal-early').getByText('Belum ada kandidat Early Formation pada filter ini')).toBeVisible();

  const reqLiquid = waitForList(page, (p) => p.get('liquidity') === 'LIQUID' && p.get('sensitivity') === 'LOW');
  await form.getByLabel('Likuiditas').selectOption('LIQUID');
  await reqLiquid;

  // Preferensi tersimpan dan dipakai lagi saat halaman dimuat ulang (request pertama sudah membawa filter tersimpan).
  const stored = await page.evaluate(() => JSON.parse(window.localStorage.getItem('lr.reversal.filters')));
  expect(stored).toMatchObject({ timeframe: '', stage: '', liquidity: 'LIQUID', sensitivity: 'LOW', hideExtended: false, showProvisional: true });
  const reloaded = waitForList(page, (p) => p.get('sensitivity') === 'LOW' && p.get('liquidity') === 'LIQUID');
  await page.reload();
  await reloaded;
  await expect(filterForm(page).getByLabel('Sensitivitas')).toHaveValue('LOW');
  await expect(filterForm(page).getByLabel('Likuiditas')).toHaveValue('LIQUID');
  expect(errors).toEqual([]);
});

test('E2E-RR-003 toggle "Sembunyikan yang sudah extended" mengirim includeExtended=0 dan menyembunyikan baris extended', async ({ page }) => {
  const errors = watchErrors(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockReversal(page);
  await signIn(page);
  await gotoRadar(page);
  const eta = panelRow(page, 'reversal-confirmed', 'ETAUSDT');
  await expect(eta.locator('.rr-move__badge[data-kind="extended"]')).toHaveText('Extended');
  await expect(eta.locator('.rr-move__text')).toContainText('+9,40%');
  await expect(eta.locator('.rr-move__text')).toContainText('2,9×ATR');

  const hidden = waitForList(page, (p) => p.get('includeExtended') === '0');
  await filterForm(page).getByRole('switch', { name: 'Sembunyikan yang sudah extended' }).check();
  await hidden;
  await expect(eta).toHaveCount(0);
  await expect(page.getByTestId('reversal-confirmed-counts')).toHaveText('5m 0 · 15m 1 · 1H 1');

  const shown = waitForList(page, (p) => p.get('includeExtended') === '1');
  await filterForm(page).getByRole('switch', { name: 'Sembunyikan yang sudah extended' }).uncheck();
  await shown;
  await expect(eta).toBeVisible();
  expect(errors).toEqual([]);
});

test('E2E-RR-004 klik baris membuka panel detail: mini-chart berlevel, alasan masuk, level, konfirmasi, batal, risiko, skor, riwayat; Esc menutup', async ({ page }) => {
  // Satu-satunya tes yang benar-benar merender grafik (candle dimock) — pengecualian hash CSP logo TradingView berlaku.
  const errors = watchErrors(page, [TV_LOGO_STYLE_CSP]);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockReversal(page);
  await mockCandles(page);
  await signIn(page);
  await gotoRadar(page);

  const row = panelRow(page, 'reversal-developing', 'DELUSDT');
  const detailReq = page.waitForRequest((req) => new URL(req.url()).pathname === '/api/reversal/candidates/4');
  await row.click();
  await detailReq;
  await expect(row).toHaveAttribute('aria-current', 'true');
  const detail = page.getByTestId('reversal-detail');
  await expect(detail).toBeVisible();
  await expect(detail.locator('.panel__title')).toHaveText('DELUSDT · 5m');
  await expect(detail.getByRole('link', { name: 'Buka detail' })).toHaveAttribute('href', '#/symbol?s=DELUSDT&tf=5m&dir=LONG');

  // Bagian detail (docs/19 §8.5) dengan teks dari API, bukan data contoh.
  const body = detail.getByTestId('reversal-detail-body');
  await expect(body.locator('.rr-stage-badge')).toHaveText('Developing Reversal');
  await expect(body.locator('.rr-pill')).toContainText('Berkembang');
  const evidence = body.getByTestId('reversal-evidence');
  await expect(evidence.locator('li')).toHaveCount(10);
  await expect(evidence).toContainText('Higher low terkonfirmasi');
  await expect(evidence).toContainText('detail sintetis');
  await expect(body.getByTestId('reversal-levels')).toContainText('Invalidasi');
  await expect(body.getByTestId('reversal-levels')).toContainText('Level pemicu (trigger)');
  await expect(body.getByTestId('reversal-next')).toContainText('Close di atas level pemicu');
  await expect(body.getByTestId('reversal-cancel')).toContainText('Close candle 5m di bawah level invalidasi');
  await expect(body.getByTestId('reversal-risks')).toContainText('Tidak ada risiko tercatat');
  await expect(body.locator('.rr-bar')).toHaveCount(5);
  await expect(body.locator('.rr-bar[data-group="STRUCTURE"] .rr-bar__value')).toHaveText('20/30');
  await expect(body).toContainText('Total 63/100');
  const history = body.getByTestId('reversal-history');
  await expect(history.locator('li')).toHaveCount(2);
  await expect(history).toContainText('Kandidat dibuka');
  await expect(history).toContainText('Naik tahap · Early Formation → Developing Reversal');
  await expect(body).toContainText('bukan probabilitas');
  await expect(body).not.toContainText(/\b(beli|entry)\b/i);

  // Mini-chart benar-benar dirender dari candle API dengan level invalidasi / bottom / trigger / deteksi pertama.
  await expect(detail.getByTestId('candle-chart').locator('canvas').first()).toBeAttached();
  const summary = detail.getByTestId('candle-chart-summary');
  await expect(summary).toContainText('Invalidasi');
  await expect(summary).toContainText('Bottom');
  await expect(summary).toContainText('Trigger');
  await expect(summary).toContainText('Deteksi pertama');
  expect(await overflow(page)).toBeLessThanOrEqual(1);

  // Kandidat lain (Confirmed, risiko lengkap) menggantikan isi panel; Esc pada baris menutup panel dan fokus tetap di baris.
  const the = panelRow(page, 'reversal-confirmed', 'THEUSDT');
  await the.click();
  await expect(detail.locator('.panel__title')).toHaveText('THEUSDT · 15m');
  await expect(detail.getByTestId('reversal-risks').locator('[data-risk="LATE_ENTRY"]')).toHaveText('Terlambat (jauh dari bottom)');
  await expect(detail.getByTestId('reversal-history').locator('li')).toHaveCount(3);
  await the.focus();
  await page.keyboard.press('Escape');
  await expect(detail).toBeHidden();
  await expect(the).toBeFocused();
  await expect(the).not.toHaveAttribute('aria-current', 'true');
  expect(errors).toEqual([]);
});

test('E2E-RR-005 kandidat provisional-only ditandai (is-provisional + label), detail dari baris tanpa request id; toggle provisional menyembunyikannya', async ({ page }) => {
  const errors = watchErrors(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockReversal(page);
  const detailRequests = [];
  page.on('request', (req) => { if (isCandidateDetail(new URL(req.url()))) detailRequests.push(req.url()); });
  await signIn(page);
  await gotoRadar(page);

  const kap = panelRow(page, 'reversal-early', 'KAPUSDT');
  await expect(kap).toHaveClass(/\bis-provisional\b/);
  await expect(kap.getByTestId('rr-provisional-label')).toHaveText('provisional');
  await expect(kap.locator('.rr-candle')).toHaveText('Berjalan');
  await expect(kap.locator('.score .num')).toHaveText('47');
  await expect(panelRow(page, 'reversal-early', 'ALPUSDT')).not.toHaveClass(/\bis-provisional\b/);
  // Kandidat terbuka yang candle berjalannya sudah di tahap lebih tinggi: tetap di panelnya, dengan petunjuk.
  const eps = panelRow(page, 'reversal-developing', 'EPSUSDT');
  await expect(eps.locator('.rr-pill__hint')).toHaveText('→ Confirmed (berjalan)');
  await expect(eps.locator('.rr-candle')).toHaveText('Berjalan');

  await kap.click();
  const detail = page.getByTestId('reversal-detail');
  await expect(detail).toBeVisible();
  await expect(detail.getByTestId('reversal-history-note')).toContainText('provisional');
  await expect(detail.locator('.callout--warn')).toContainText('belum menjadi kandidat');
  await expect(detail.getByTestId('reversal-risks').locator('[data-risk="PROVISIONAL"]')).toBeVisible();
  expect(detailRequests).toEqual([]);

  const hidden = waitForList(page, (p) => p.get('includeProvisional') === '0');
  await filterForm(page).getByRole('switch', { name: 'Tampilkan candle berjalan (provisional)' }).uncheck();
  await hidden;
  await expect(kap).toHaveCount(0);
  await expect(page.getByTestId('reversal-early-counts')).toHaveText('5m 1 · 15m 1 · 1H 1');
  expect(errors).toEqual([]);
});

test('E2E-RR-006 tanpa kandidat: empty state jujur per panel (tanpa data contoh), panel SA/PVA tetap ada', async ({ page }) => {
  const errors = watchErrors(page);
  await mockReversal(page, { items: [] });
  await signIn(page);
  await gotoRadar(page);
  for (const [testId, title] of [['reversal-early', 'Early Formation'], ['reversal-developing', 'Developing Reversal'], ['reversal-confirmed', 'Confirmed Breakout']]) {
    const panel = page.getByTestId(testId);
    await expect(panel.getByText(`Belum ada kandidat ${title} pada filter ini`)).toBeVisible();
    await expect(panel.locator('tbody tr')).toHaveCount(0);
  }
  await expect(page.getByTestId('reversal-early')).toContainText('Sensitivitas Sedang');
  await expect(page.getByTestId('reversal-summary')).toHaveText('0 kandidat · Early 0 · Developing 0 · Confirmed 0');
  await expect(page.getByTestId('reversal-legacy')).toBeVisible();
  expect(errors).toEqual([]);
});

test('E2E-RR-007 scanner berjalan: penyegaran latar 30 s menyorot baris baru & naik tahap, fokus baris dipertahankan', async ({ page }) => {
  const errors = watchErrors(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install({ time: REVERSAL_NOW });
  await page.route('**/api/system/worker', (route) => route.fulfill({ json: WORKER_RUNNING }));
  await page.route('**/api/system/sync*', async (route) => {
    const response = await route.fetch();
    return route.fulfill({ response, json: { ...(await response.json()), worker: WORKER_RUNNING } });
  });
  const base = reversalCandidates();
  // Muatan kedua: ALPUSDT naik tahap (Developing), NEWUSDT baru masuk (Early 5m).
  const later = base.map((r) => (r.symbol !== 'ALPUSDT' ? r : candidate({
    id: 1, symbol: 'ALPUSDT', timeframe: '5m', stage: 'DEVELOPING_REVERSAL', setupType: 'DOUBLE_BOTTOM', price: 0.0831,
    evidence: ['LL_SHALLOWER', 'LL_STOPPED', 'BOTTOM_HELD', 'RSI_DIVERGENCE', 'ATR_CONTRACTION', 'EMA_CONVERGENCE', 'ROUNDED_BOTTOM', 'HIGHER_LOW', 'VOLUME_DRY_UP'],
    risks: ['LOW_LIQUIDITY'], liquidityClass: 'THIN', movePct: 0.015, moveAtr: 0.7,
  }))).concat([candidate({
    id: 11, symbol: 'NEWUSDT', timeframe: '5m', stage: 'EARLY_FORMATION', setupType: 'COMPRESSION', price: 0.9,
    evidence: ['LL_SHALLOWER', 'LL_STOPPED', 'RSI_DIVERGENCE', 'ATR_CONTRACTION', 'EMA_CONVERGENCE', 'RANGE_CONTRACTION', 'VOLUME_DRY_UP', 'QUIET_RISE'],
    risks: [], movePct: 0.002, moveAtr: 0.1,
  })]);
  let advanced = false;
  let laterCalls = 0;
  await page.route(isCandidateList, (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (advanced) laterCalls += 1;
    return route.fulfill({ json: filterCandidates(advanced ? later : base, params) });
  });
  await signIn(page);
  await gotoRadar(page);
  await expect(page.getByTestId('scan-radar')).toHaveAttribute('data-active', 'true');
  const del = panelRow(page, 'reversal-developing', 'DELUSDT');
  await del.focus();

  advanced = true;
  await page.clock.fastForward(31_000);
  await expect.poll(() => laterCalls).toBeGreaterThan(0);
  const alp = panelRow(page, 'reversal-developing', 'ALPUSDT');
  await expect(alp).toBeVisible();
  await expect(alp).toHaveAttribute('data-flash', 'up');
  await expect(panelRow(page, 'reversal-early', 'NEWUSDT')).toHaveAttribute('data-flash', 'new');
  await expect(panelRow(page, 'reversal-early', 'ALPUSDT')).toHaveCount(0);
  await expect(page.getByTestId('reversal-early-counts')).toHaveText('5m 1 · 15m 2 · 1H 1');
  await expect(page.getByTestId('reversal-developing-counts')).toHaveText('5m 2 · 15m 1 · 1H 1');
  await expect(del).toBeFocused();
  expect(errors).toEqual([]);
});

test('E2E-RR-008 endpoint belum tersedia (404): callout jujur, panel tahap tanpa data palsu, tabel SA/PVA tetap berjalan', async ({ page }) => {
  // 404 dari endpoint yang memang belum ada adalah kondisi yang diuji, bukan error UI.
  const errors = watchErrors(page, [/status of 404/]);
  await page.route(isCandidateList, (route) => route.fulfill({ status: 404, json: { error: 'NOT_FOUND', message: 'Tidak ditemukan' } }));
  await signIn(page);
  await page.goto('/#/screener');
  await expect(page.getByTestId('reversal-status')).toContainText('belum tersedia di server ini');
  for (const testId of ['reversal-early', 'reversal-developing', 'reversal-confirmed']) {
    await expect(page.getByTestId(testId)).toContainText('Kandidat tidak dapat dimuat.');
    await expect(page.getByTestId(testId).locator('tbody tr')).toHaveCount(0);
  }
  await expect(page.getByTestId('reversal-summary')).toHaveText('Kandidat reversal tidak dapat dimuat.');
  await expect(page.getByTestId('reversal-legacy-count')).toHaveText('0 kandidat');
  expect(errors).toEqual([]);
});
