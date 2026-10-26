import { expect, test } from '@playwright/test';
import { buildScenario } from '../fixtures/smartmoney/scenario.js';
import { E2E_PORT, E2E_SEEDED_PORT, E2E_USERS } from './fixtures.js';

// Insider / Smart Money Radar. Server seeded (8182) berisi DATA SIMULASI: provider fixture atas
// tests/fixtures/smartmoney/scenario.js yang disinkronkan lewat runSmartMoneySync ASLI saat server start
// (tests/e2e/server.js). Server kosong (8181) memakai SMART_MONEY_PROVIDERS=off: tanpa provider dan tanpa data.
// Alamat & hash skenario fiktif dan deterministik (sha256 label) — tidak bergantung pada waktu start server.
const SEEDED = `http://127.0.0.1:${E2E_SEEDED_PORT}`;
const EMPTY = `http://127.0.0.1:${E2E_PORT}`;
const { wallets: W, tokens: T, expectations: X } = buildScenario();

test.use({ baseURL: SEEDED });

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`console: ${msg.text()}`); });
  return errors;
}

// Watchlist & status baca bersifat per pengguna, sedangkan desktop & mobile berbagi satu server:
// tiap project memakai pengguna sendiri agar keduanya mulai dari state yang sama.
const userFor = (testInfo) => (testInfo.project.name === 'mobile' ? E2E_USERS.admin : E2E_USERS.analyst);

async function signIn(page, user, base = SEEDED) {
  await page.goto(`${base}/login.html`);
  await page.getByLabel('Username').fill(user.username);
  await page.getByLabel('Kata sandi').fill(user.password);
  await page.getByRole('button', { name: 'Masuk' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
}

const panelTitled = (page, title) => page.locator('.panel').filter({ has: page.getByRole('heading', { level: 2, name: title, exact: true }) });
const radarPanel = (page) => panelTitled(page, 'Token yang diakumulasi');
const radarItems = (page) => page.getByTestId('sm-radar-item');
const radarCard = (page, address) => radarItems(page).filter({ has: page.locator(`a.sm-card__sym[href*="${address}"]`) });
const countOf = async (badge) => Number((await badge.textContent()).match(/\d+/)[0]);

/** Semua tautan tab baru di dalam `scope` memakai https dan rel noopener noreferrer. */
async function expectSafeExternalLinks(scope) {
  const links = await scope.locator('a[target="_blank"]').all();
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) {
    expect(await link.getAttribute('href')).toMatch(/^https:\/\//);
    const rel = (await link.getAttribute('rel')) ?? '';
    expect(rel.split(/\s+/)).toEqual(expect.arrayContaining(['noopener', 'noreferrer']));
  }
}

/** Ganti jendela radar lewat UI; tunggu respons API jendela itu dan render selesai. */
async function switchWindow(page, label, value) {
  const response = page.waitForResponse((r) => r.url().includes('/api/smart-money/radar?')
    && new URL(r.url()).searchParams.get('window') === value);
  await page.getByRole('radiogroup', { name: 'Jendela waktu radar' }).getByRole('radio', { name: label, exact: true }).check();
  expect((await response).status()).toBe(200);
  await expect(radarPanel(page).locator('.sm-host')).toHaveAttribute('aria-busy', 'false');
}

test('E2E-SM-001 radar: pita DATA SIMULASI, penafian skor keyakinan, token dari API; jendela 1h/4h/24h/7d', async ({ page }, testInfo) => {
  const errors = watchErrors(page);
  await signIn(page, userFor(testInfo));
  await page.goto('/#/smart-money');
  await expect(page.getByRole('heading', { level: 1, name: 'Smart Money Radar' })).toBeVisible();
  await expect(page.getByTestId('sm-simulated')).toContainText('DATA SIMULASI');
  await expect(radarPanel(page).locator('.panel__footer')).toContainText('BUKAN probabilitas profit');
  await expect(page.getByTestId('sm-insider-note')).toContainText('hanya nama fitur');

  // Jendela default 24 jam: akumulasi TKA (4 klaster independen) dan SYN dari skenario.
  const tka = radarCard(page, T.TKA.address);
  await expect(tka).toBeVisible();
  await expect(radarCard(page, T.SYN.address)).toBeVisible();
  await expect(tka.getByText('Skor keyakinan (bukan probabilitas)')).toBeVisible();
  await expect(tka.locator('.sm-facts')).toContainText(`${X.tka.expectedIndependentClusters} dari 5`);
  await expect(tka.getByText('SIMULASI', { exact: true })).toBeVisible();
  const count = radarPanel(page).locator('.panel__actions .badge');
  await expect(count).toHaveText(/^\d+ token$/);
  const in24h = await countOf(count);

  // 1 jam: skenario tidak punya pembelian → keadaan kosong jujur (tanpa data contoh).
  await switchWindow(page, '1 jam', '1h');
  await expect(radarItems(page)).toHaveCount(0);
  await expect(count).toHaveText('0 token');
  await expect(radarPanel(page).getByText('Belum ada akumulasi pada jendela ini')).toBeVisible();

  // 4 jam: beli TKA 2 jam lalu masuk; beli PEPE 12–16 jam lalu belum.
  await switchWindow(page, '4 jam', '4h');
  await expect(tka).toBeVisible();
  await expect(radarCard(page, T.PEPE_A.address)).toHaveCount(0);

  // 7 hari: cakupan paling lebar (≥ 24 jam).
  await switchWindow(page, '7 hari', '7d');
  await expect(radarCard(page, T.PEPE_B.address)).toBeVisible();
  expect(await countOf(count)).toBeGreaterThanOrEqual(in24h);

  await switchWindow(page, '24 jam', '24h');
  await expect(count).toHaveText(`${in24h} token`);
  expect(errors).toEqual([]);
});

test('E2E-SM-002 bukti radar: pembeli & tautan explorer aman; PEPE tampil sebagai dua token berbeda kontrak', async ({ page }, testInfo) => {
  const errors = watchErrors(page);
  await signIn(page, userFor(testInfo));
  await page.goto('/#/smart-money');
  const tka = radarCard(page, T.TKA.address);
  const toggle = tka.getByRole('button', { name: 'Bukti' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const evidence = tka.locator('.sm-card__evidence');
  await expect(evidence).toBeVisible();
  // Pembeli berkualitas dengan tautan profil; dua wallet tertaut tampil sebagai satu klaster.
  for (const wallet of [...X.tka.qualityBuyers, ...X.tka.linkedBuyers]) {
    await expect(evidence.getByRole('link', { name: `Profil wallet ${wallet}` })).toBeVisible();
  }
  await expect(evidence.getByText('1 klaster · 2 pembeli').first()).toBeVisible();
  await expect(evidence.getByRole('link', { name: `Buka transaksi ${X.tka.buyTxs[0]} di explorer (tab baru)` })).toBeVisible();
  await expect(evidence.getByRole('complementary', { name: 'Penafian' })).toContainText('BUKAN probabilitas profit');
  await expectSafeExternalLinks(tka);

  // Simbol sama ≠ token sama: dua kartu PEPE dengan kontrak berbeda; hanya kontrak terverifikasi yang punya chart.
  const pepeCards = radarItems(page).filter({ has: page.locator('a.sm-card__sym', { hasText: /^PEPE$/ }) });
  await expect(pepeCards).toHaveCount(2);
  const pepeA = radarCard(page, T.PEPE_A.address);
  const pepeB = radarCard(page, T.PEPE_B.address);
  await expect(pepeA.getByRole('link', { name: `Kontrak PEPE ${T.PEPE_A.address} di explorer (tab baru)` })).toBeVisible();
  await expect(pepeB.getByRole('link', { name: `Kontrak PEPE ${T.PEPE_B.address} di explorer (tab baru)` })).toBeVisible();
  await expect(pepeA.locator('.sm-match')).toHaveAttribute('data-status', 'MATCHED');
  await expect(pepeA.getByRole('link', { name: 'Buka chart' })).toHaveAttribute('href', /^#\/symbol\?s=1000PEPEUSDT&/);
  await expect(pepeB.locator('.sm-match')).toHaveAttribute('data-status', 'SYMBOL_ONLY');
  await expect(pepeB.locator('a[href^="#/symbol?"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('E2E-SM-003 Wallet Discovery: filter eligible & ber-flag mengubah hasil; profil wallet tertaut lengkap', async ({ page }, testInfo) => {
  const errors = watchErrors(page);
  await signIn(page, userFor(testInfo));
  await page.goto('/#/smart-wallets');
  await expect(page.getByRole('heading', { level: 1, name: 'Wallet Discovery' })).toBeVisible();
  await expect(page.getByTestId('sm-simulated')).toContainText('DATA SIMULASI');
  const walletsPanel = panelTitled(page, 'Wallet');
  const count = walletsPanel.locator('.panel__actions .badge');
  const flagChip = (label) => walletsPanel.locator('.sm-flags .badge').filter({ hasText: new RegExp(`^${label}$`) });
  const ready = () => expect(walletsPanel.locator('.sm-host')).toHaveAttribute('aria-busy', 'false');
  const reload = async (action, check) => {
    const response = page.waitForResponse((r) => r.url().includes('/api/smart-money/wallets?') && check(new URL(r.url()).searchParams));
    await action();
    expect((await response).status()).toBe(200);
    await ready();
  };

  // Default: hanya wallet eligible, tanpa wallet ber-flag pengecuali (BOT).
  await expect(walletsPanel.getByRole('link', { name: `Profil wallet ${W.L1}` })).toBeVisible();
  const eligibleOnly = await countOf(count);
  expect(eligibleOnly).toBeGreaterThan(0);
  await expect(flagChip('BOT')).toHaveCount(0);
  await expect(flagChip('Riwayat pendek')).toHaveCount(0);

  await reload(() => walletsPanel.getByRole('switch', { name: 'Hanya eligible' }).uncheck(), (q) => !q.has('eligible'));
  const all = await countOf(count);
  expect(all).toBeGreaterThan(eligibleOnly);
  await expect(flagChip('Riwayat pendek').first()).toBeVisible();
  await expect(flagChip('BOT')).toHaveCount(0);

  await reload(() => walletsPanel.getByRole('switch', { name: 'Tampilkan wallet ber-flag' }).check(), (q) => q.get('includeFlagged') === 'true');
  expect(await countOf(count)).toBeGreaterThan(all);
  await expect(flagChip('BOT').first()).toBeVisible();

  // Profil wallet tertaut (L1): alasan skor, keterbatasan data, flag, dan klaster dengan L2.
  await walletsPanel.getByRole('link', { name: `Profil wallet ${W.L1}` }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Profil Wallet' })).toBeVisible();
  await expect(page.getByTestId('sm-wallet-address')).toHaveText(W.L1);
  const score = panelTitled(page, 'Skor wallet');
  await expect(score.getByRole('heading', { name: 'Alasan' })).toBeVisible();
  await expect(score.locator('.sm-list li').first()).toContainText('trade tertutup');
  const limits = page.getByRole('region', { name: 'Keterbatasan data' });
  await expect(limits).toBeVisible();
  await expect(limits).toContainText('Kelengkapan PnL');
  await expect(limits).toContainText('Penanda LINKED');
  const flags = panelTitled(page, 'Penanda (flag)');
  await expect(flags.getByText('Terkait', { exact: true })).toBeVisible();
  await expect(flags).toContainText('Tertaut dengan 1 wallet lain');
  const cluster = panelTitled(page, 'Wallet terkait (1)');
  await expect(cluster).toContainText('SATU pembeli independen');
  await expect(cluster.getByRole('link', { name: `Profil wallet ${W.L2}` }).first()).toBeVisible();
  await expect(cluster.getByRole('link', { name: `Buka transaksi ${X.linked.directTransferTx} di explorer (tab baru)` })).toBeVisible();
  await expectSafeExternalLinks(page.locator('.page'));
  expect(errors).toEqual([]);
});

test('E2E-SM-004 detail token: kecocokan Binance; tautan #/symbol hanya untuk kontrak MATCHED', async ({ page }, testInfo) => {
  const errors = watchErrors(page);
  await signIn(page, userFor(testInfo));
  await page.goto(`/#/smart-token?c=ethereum&a=${T.PEPE_A.address}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Detail Token' })).toBeVisible();
  await expect(page.getByTestId('sm-token-contract')).toHaveText(T.PEPE_A.address);
  await expect(page.getByTestId('sm-simulated')).toContainText('DATA SIMULASI');
  const binance = panelTitled(page, 'Binance & screener');
  await expect(binance.locator('.sm-match')).toHaveAttribute('data-status', 'MATCHED');
  await expect(binance.locator('.sm-match')).toHaveText(X.pepe.futuresSymbol);
  await expect(binance).toContainText('1 kontrak = 1000 token');
  await expect(page.getByTestId('sm-open-chart')).toHaveAttribute('href', `#/symbol?s=${X.pepe.futuresSymbol}&tf=15m&dir=LONG`);
  await expect(page.locator('a[href^="#/symbol?"]')).toHaveCount(1);

  // Kontrak B bersimbol sama tetapi tidak terverifikasi → peringatan, tanpa tautan chart/sinyal.
  await page.goto(`/#/smart-token?c=ethereum&a=${T.PEPE_B.address}`);
  await expect(page.getByTestId('sm-token-contract')).toHaveText(T.PEPE_B.address);
  await expect(binance.locator('.sm-match')).toHaveAttribute('data-status', 'SYMBOL_ONLY');
  await expect(binance.locator('.sm-match')).toHaveText('⚠ Simbol sama, kontrak belum terverifikasi');
  await expect(binance).toContainText('Tidak ditautkan ke sinyal screener');
  await expect(page.locator('a[href^="#/symbol?"]')).toHaveCount(0);
  await expectSafeExternalLinks(page.locator('.page'));
  expect(errors).toEqual([]);
});

test('E2E-SM-005 watchlist: ikuti token & wallet, lalu berhenti mengikuti dari halaman watchlist', async ({ page }, testInfo) => {
  const errors = watchErrors(page);
  await signIn(page, userFor(testInfo));
  const token = X.screenerLink;
  await page.goto(`/#/smart-token?c=${token.chain}&a=${token.address}`);
  await expect(page.getByTestId('sm-token-contract')).toHaveText(token.address);
  await page.getByRole('button', { name: 'Ikuti token' }).click();
  await expect(page.getByText('Token diikuti.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Diikuti' })).toHaveAttribute('aria-pressed', 'true');

  await page.goto(`/#/smart-wallet?c=ethereum&a=${W.Q1}`);
  await expect(page.getByTestId('sm-wallet-address')).toHaveText(W.Q1);
  await page.getByRole('button', { name: 'Ikuti wallet' }).click();
  await expect(page.getByText('Wallet diikuti.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Diikuti' })).toHaveAttribute('aria-pressed', 'true');

  await page.goto('/#/smart-watchlist');
  await expect(page.getByRole('heading', { level: 1, name: 'Watchlist & Alerts' })).toBeVisible();
  const followed = panelTitled(page, 'Diikuti');
  await expect(followed.getByRole('heading', { name: 'Wallet (1)' })).toBeVisible();
  await expect(followed.getByRole('heading', { name: 'Token (1)' })).toBeVisible();
  await expect(followed.locator(`a[title="${W.Q1}"]`)).toHaveAttribute('href', `#/smart-wallet?c=ethereum&a=${W.Q1}`);
  await expect(followed.locator(`a[title="${token.address}"]`)).toHaveAttribute('href', `#/smart-token?c=${token.chain}&a=${token.address}`);

  await followed.getByRole('button', { name: `Berhenti mengikuti wallet ${W.Q1}` }).click();
  await expect(followed.getByRole('heading', { name: 'Wallet (0)' })).toBeVisible();
  await expect(followed.getByText('Belum ada wallet diikuti')).toBeVisible();
  await followed.getByRole('button', { name: `Berhenti mengikuti token ${token.address}` }).click();
  await expect(followed.getByRole('heading', { name: 'Token (0)' })).toBeVisible();
  await expect(followed.getByText('Belum ada token diikuti')).toBeVisible();

  // Tersimpan di server: detail token kembali menawarkan "Ikuti token".
  await page.goto(`/#/smart-token?c=${token.chain}&a=${token.address}`);
  await expect(page.getByRole('button', { name: 'Ikuti token' })).toHaveAttribute('aria-pressed', 'false');
  expect(errors).toEqual([]);
});

test('E2E-SM-006 notifikasi: daftar, tandai dibaca; preferensi tidak valid ditolak dengan pesan per field', async ({ page }, testInfo) => {
  const errors = watchErrors(page);
  await signIn(page, userFor(testInfo));
  await page.goto('/#/smart-watchlist');
  const alerts = panelTitled(page, 'Notifikasi');
  const unread = alerts.locator('.panel__actions .badge');
  const items = alerts.locator('li.sm-alert');
  // Preferensi default (skor wallet ≥ 60): dari skenario hanya "beli serentak" TKA (4 klaster independen) yang lolos.
  await expect(unread).toHaveText(/^[1-9]\d* belum dibaca$/);
  const n = await countOf(unread);
  await expect(items).toHaveCount(n);
  const multi = items.filter({ hasText: 'Beli serentak' });
  await expect(multi).toContainText('TKA');
  await expect(multi.getByText('SIMULASI', { exact: true })).toBeVisible();
  await expectSafeExternalLinks(multi);

  await items.first().getByRole('button', { name: /^Tandai dibaca/ }).click();
  await expect(page.getByText('1 notifikasi ditandai dibaca.')).toBeVisible();
  await expect(unread).toHaveText(`${n - 1} belum dibaca`);
  if (n > 1) await alerts.getByRole('button', { name: 'Tandai semua dibaca' }).click();
  await expect(unread).toHaveText('0 belum dibaca');
  await expect(alerts.getByText('Tidak ada notifikasi belum dibaca')).toBeVisible();
  await expect(alerts.getByRole('button', { name: 'Tandai semua dibaca' })).toBeDisabled();
  await alerts.getByRole('switch', { name: 'Hanya belum dibaca' }).uncheck();
  await expect(alerts.locator('li.sm-alert[data-read="true"]')).toHaveCount(n);
  await expect(alerts.locator('li.sm-alert[data-read="false"]')).toHaveCount(0);

  // Nilai di luar batas: pesan di field itu, fokus ke field, dan tidak ada PUT ke server.
  const puts = [];
  page.on('request', (req) => { if (req.method() === 'PUT' && req.url().includes('/api/smart-money/alert-prefs')) puts.push(req.url()); });
  const prefs = page.getByRole('form', { name: 'Preferensi notifikasi' });
  const minScore = prefs.getByLabel('Skor wallet minimum');
  await minScore.fill('150');
  await prefs.getByRole('button', { name: 'Simpan preferensi' }).click();
  await expect(prefs.locator('[data-error-for="minWalletScore"]')).toHaveText('Angka 0–100');
  await expect(minScore).toHaveAttribute('aria-invalid', 'true');
  await expect(minScore).toBeFocused();
  expect(puts).toEqual([]);
  expect(errors).toEqual([]);
});

test('E2E-SM-007 LONG Scanner menampilkan chip "SM ×N" untuk SYNUSDT; SHORT Scanner tidak', async ({ page }, testInfo) => {
  const errors = watchErrors(page);
  await signIn(page, userFor(testInfo));
  await page.goto('/#/screener');
  const results = page.getByTestId('screener-results');
  const chip = results.locator('.sm-chip');
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveText(`SM ×${X.screenerLink.buyers.length}`);
  await expect(results.locator('tr', { has: page.locator('.sm-chip') })).toContainText(X.screenerLink.futuresSymbol);
  await expect(chip).toHaveAttribute('title', /^DATA SIMULASI — bukan data live\./);
  await expect(results.getByTestId('sm-chip-simulated')).toHaveText('SIMULASI');
  await expect(chip).toHaveAttribute('href', `#/smart-token?c=${X.screenerLink.chain}&a=${X.screenerLink.address}`);

  // SHORT tidak pernah meminta ringkasan smart money dan tidak menampilkan chip.
  const smRequests = [];
  page.on('request', (req) => { if (req.url().includes('/api/smart-money/')) smRequests.push(req.url()); });
  const shortLoaded = page.waitForResponse((r) => r.url().includes('/api/signals/active?') && new URL(r.url()).searchParams.get('direction') === 'SHORT');
  await page.goto('/#/short-scanner');
  await expect(page.locator('.page h1')).toHaveText('SHORT Scanner');
  await shortLoaded;
  await expect(page.getByTestId('short-screener-results').getByText('Belum ada kandidat SHORT')).toBeVisible();
  await expect(page.locator('.sm-chip')).toHaveCount(0);
  expect(smRequests).toEqual([]);

  // Chip LONG membuka detail token on-chain yang terpetakan ke simbol itu.
  await page.goto('/#/screener');
  await page.getByTestId('screener-results').locator('.sm-chip').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Detail Token' })).toBeVisible();
  await expect(page.getByTestId('sm-token-contract')).toHaveText(X.screenerLink.address);
  expect(errors).toEqual([]);
});

test('E2E-SM-008 server tanpa provider: keadaan jujur "belum ada sumber data", tanpa pita simulasi', async ({ page }, testInfo) => {
  const errors = watchErrors(page);
  await signIn(page, userFor(testInfo), EMPTY);
  await page.goto(`${EMPTY}/#/smart-money`);
  await expect(page.getByRole('heading', { level: 1, name: 'Smart Money Radar' })).toBeVisible();
  await expect(radarPanel(page).getByText('Belum ada sumber data on-chain')).toBeVisible();
  await expect(page.getByTestId('sm-status')).toContainText('0 terkonfigurasi');
  await expect(radarItems(page)).toHaveCount(0);
  await expect(page.getByTestId('sm-simulated')).toHaveCount(0);

  await page.goto(`${EMPTY}/#/smart-wallets`);
  await expect(page.getByRole('heading', { level: 1, name: 'Wallet Discovery' })).toBeVisible();
  await expect(page.getByText('Belum ada sumber data on-chain')).toBeVisible();
  await expect(page.getByTestId('sm-simulated')).toHaveCount(0);
  expect(errors).toEqual([]);
});
