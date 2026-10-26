import { expect, test } from '@playwright/test';
import { buildScenario } from '../fixtures/smartmoney/scenario.js';
import { E2E_SEEDED_PORT, E2E_USERS } from './fixtures.js';

// Peta Benang (Smart Money Radar → "Daftar | Peta Benang"): graf wallet → token dari respons radar yang SAMA dengan
// daftar kartu. Server seeded (8182) berisi DATA SIMULASI: provider fixture atas tests/fixtures/smartmoney/scenario.js
// yang disinkronkan saat server start (tests/e2e/server.js). Alamat & hash skenario fiktif dan deterministik.
// Identitas node: token = tokenKey (chain:kontrak), wallet = chain:alamat; benang = "<wallet>><token>".
const SEEDED = `http://127.0.0.1:${E2E_SEEDED_PORT}`;
const { wallets: W, tokens: T, expectations: X } = buildScenario();

test.use({ baseURL: SEEDED });

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`console: ${msg.text()}`); });
  return errors;
}

// Desktop & mobile berbagi satu server: tiap project memakai pengguna sendiri (pola tests/e2e/smartmoney.spec.js).
const userFor = (testInfo) => (testInfo.project.name === 'mobile' ? E2E_USERS.admin : E2E_USERS.analyst);
const onMobile = (testInfo) => testInfo.project.name === 'mobile';

async function signIn(page, user) {
  await page.goto(`${SEEDED}/login.html`);
  await page.getByLabel('Username').fill(user.username);
  await page.getByLabel('Kata sandi').fill(user.password);
  await page.getByRole('button', { name: 'Masuk' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
}

const panelTitled = (page, title) => page.locator('.panel').filter({ has: page.getByRole('heading', { level: 2, name: title, exact: true }) });
const radarPanel = (page) => panelTitled(page, 'Token yang diakumulasi');
const radarCard = (page, address) => page.getByTestId('sm-radar-item').filter({ has: page.locator(`a.sm-card__sym[href*="${address}"]`) });
const countOf = async (badge) => Number((await badge.textContent()).match(/\d+/)[0]);
const viewRadio = (page, name) => page.getByRole('radiogroup', { name: 'Tampilan hasil radar' }).getByRole('radio', { name, exact: true });
const threads = (page) => page.getByTestId('sm-threads');
const mapSvg = (page) => threads(page).locator('svg.sm-thr__svg');
const evidencePanel = (page) => page.getByTestId('sm-threads-evidence');
const walletNode = (page, address, chain = 'ethereum') => threads(page).locator(`a[data-thr="wallet"][data-id="${chain}:${address}"]`);
const tokenNode = (page, token) => threads(page).locator(`a[data-thr="token"][data-id="${token.chain}:${token.address}"]`);
const strandOf = (page, address, token) => threads(page).locator(`g[data-thr="strand"][data-id="${token.chain}:${address}>${token.chain}:${token.address}"]`);
const IS_ON = /(^|\s)is-on(\s|$)/;
const IS_SELECTED = /(^|\s)is-selected(\s|$)/;
const TKA_BUYERS = [...X.tka.qualityBuyers, ...X.tka.linkedBuyers];

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

/** Masuk lalu buka radar langsung dalam tampilan Peta Benang (tautan ?view=benang). */
async function openThreads(page, testInfo) {
  await signIn(page, userFor(testInfo));
  await page.goto('/#/smart-money?view=benang');
  await expect(mapSvg(page)).toBeVisible();
  // Kursor sisa klik "Masuk" bisa kebetulan berada di atas node; sorotan hover mendahului fokus.
  await page.mouse.move(1, 1);
}

/**
 * Klik (desktop) atau ketuk (mobile) benang pada titik di garisnya yang tidak tertutup benang lain — benang bisa
 * bersilangan, jadi titik tengah kotak pembatas belum tentu milik benang ini.
 */
async function pickStrand(page, strand, testInfo) {
  await strand.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const point = await strand.locator('.sm-thr-strand__line').evaluate((path) => {
    const own = path.closest('[data-thr="strand"]');
    const ctm = path.getScreenCTM();
    const length = path.getTotalLength();
    for (const f of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.12, 0.88]) {
      const p = path.getPointAtLength(length * f);
      const x = ctm.a * p.x + ctm.c * p.y + ctm.e;
      const y = ctm.b * p.x + ctm.d * p.y + ctm.f;
      if (document.elementFromPoint(x, y)?.closest('[data-thr="strand"]') === own) return { x, y };
    }
    return null;
  });
  expect(point, 'titik benang yang tidak tertutup benang lain').not.toBeNull();
  if (onMobile(testInfo)) await page.touchscreen.tap(point.x, point.y);
  else await page.mouse.click(point.x, point.y);
}

test('E2E-SM-THREADS-001 pengalih "Daftar | Peta Benang": Daftar bawaan; peta dari respons yang sama tanpa request baru; tertaut lewat hash', async ({ page }, testInfo) => {
  const errors = watchErrors(page);
  await signIn(page, userFor(testInfo));
  await page.goto('/#/smart-money');
  await expect(radarPanel(page).locator('.sm-host')).toHaveAttribute('aria-busy', 'false');

  // Bawaan: Daftar — kartu radar & kait yang sudah ada tetap utuh; peta belum dibangun.
  await expect(viewRadio(page, 'Daftar')).toBeChecked();
  await expect(radarCard(page, T.TKA.address).getByRole('button', { name: 'Bukti' })).toBeVisible();
  await expect(threads(page)).toHaveCount(0);
  const tokens = await countOf(radarPanel(page).locator('.panel__actions .badge'));
  expect(tokens).toBeGreaterThan(0);

  const radarRequests = [];
  page.on('request', (req) => { if (req.url().includes('/api/smart-money/radar')) radarRequests.push(req.url()); });
  await viewRadio(page, 'Peta Benang').check();
  await expect(mapSvg(page)).toBeVisible();
  await expect(radarPanel(page).getByRole('list', { name: 'Token yang diakumulasi' })).toBeHidden();
  await expect(page.getByTestId('sm-threads-count')).toContainText(`Menampilkan ${tokens} dari ${tokens} token`);
  await expect(page).toHaveURL(/#\/smart-money\?view=benang$/);
  expect(radarRequests).toEqual([]);

  // Tertaut: memuat ulang dengan ?view=benang langsung membuka peta.
  await page.reload();
  await expect(mapSvg(page)).toBeVisible();
  await expect(viewRadio(page, 'Peta Benang')).toBeChecked();

  // Filter jendela tetap bekerja di mode peta: respons baru → peta dibangun ulang (atau keadaan kosong jujur).
  await switchWindow(page, '1 jam', '1h');
  await expect(radarPanel(page).getByText('Belum ada akumulasi pada jendela ini')).toBeVisible();
  await expect(threads(page)).toHaveCount(0);
  await switchWindow(page, '24 jam', '24h');
  await expect(mapSvg(page)).toBeVisible();
  await expect(viewRadio(page, 'Peta Benang')).toBeChecked();

  // Kembali ke Daftar: kartu tampil lagi, hash bersih, tetap tanpa request baru.
  radarRequests.length = 0;
  await viewRadio(page, 'Daftar').check();
  await expect(radarCard(page, T.TKA.address)).toBeVisible();
  await expect(threads(page)).toBeHidden();
  await expect(page).toHaveURL(/#\/smart-money$/);
  expect(radarRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test('E2E-SM-THREADS-002 node wallet & token dari skenario; benang beli & indikasi keluar; wallet tertaut = satu klaster', async ({ page }, testInfo) => {
  const errors = watchErrors(page);
  await openThreads(page, testInfo);
  const tokens = await countOf(radarPanel(page).locator('.panel__actions .badge'));
  await expect(threads(page).locator('a[data-thr="token"]')).toHaveCount(tokens);
  await expect(page.getByTestId('sm-threads-count')).toHaveText(new RegExp(`^Menampilkan ${tokens} dari ${tokens} token · (\\d+) dari \\1 wallet · \\d+ benang$`));

  for (const token of [T.TKA, T.SYN, T.PEPE_A, T.PEPE_B, T.TKC, T.TKG]) {
    await expect(tokenNode(page, token)).toHaveAttribute('href', `#/smart-token?c=${token.chain}&a=${token.address}`);
  }
  // Akumulasi TKA: 3 wallet berkualitas + 2 wallet tertaut, masing-masing satu benang beli; SYN di Base.
  for (const wallet of TKA_BUYERS) {
    await expect(walletNode(page, wallet)).toHaveAttribute('href', `#/smart-wallet?c=ethereum&a=${wallet}`);
    await expect(strandOf(page, wallet, T.TKA)).toHaveAttribute('data-kind', 'BUY');
  }
  for (const wallet of X.screenerLink.buyers) {
    await expect(walletNode(page, wallet, 'base')).toHaveAttribute('href', `#/smart-wallet?c=base&a=${wallet}`);
    await expect(strandOf(page, wallet, T.SYN)).toHaveAttribute('data-kind', 'BUY');
  }
  await expect(threads(page).locator('.sm-thr-strand__flow').first()).toBeAttached();

  // Indikasi keluar: Q4 memindahkan TKC ke exchange (BUKAN "jual"); Q3 menjual TKG lewat swap.
  const cex = strandOf(page, X.cexExit.wallet, T.TKC);
  await expect(cex).toHaveAttribute('data-kind', 'EXIT');
  await expect(cex).toHaveAttribute('data-tone', 'cex');
  await expect(cex).toHaveAttribute('aria-label', /dipindah ke exchange, belum tentu dijual/);
  await expect(cex).not.toHaveAttribute('aria-label', /dijual via swap/);
  const sale = strandOf(page, X.largeSell.wallet, T.TKG);
  await expect(sale).toHaveAttribute('data-kind', 'EXIT');
  await expect(sale).toHaveAttribute('data-tone', 'sell');
  await expect(sale).toHaveAttribute('aria-label', /dijual via swap/);

  // Dua wallet tertaut berbagi tag klaster dan dihitung satu pembeli independen.
  for (const wallet of X.tka.linkedBuyers) await expect(walletNode(page, wallet).locator('.sm-thr-tag')).toHaveText('K1');
  await expect(page.getByTestId('sm-threads-clusters')).toContainText('2 wallet terkait di Ethereum — dihitung 1 pembeli independen');

  // Ringkasan teks (pembaca layar) memuat hal yang sama.
  const summary = page.getByTestId('sm-threads-summary');
  await expect(summary).toContainText(`TKA (Ethereum, kontrak`);
  await expect(summary).toContainText(`${TKA_BUYERS.length} wallet membeli lewat swap`);
  await expect(summary).toContainText('1 wallet dengan indikasi keluar saja');
  await expect(summary).toContainText('Klaster K1: 2 wallet terkait di Ethereum — dihitung sebagai 1 pembeli independen.');
  expect(errors).toEqual([]);
});

test('E2E-SM-THREADS-003 sorot: arahkan/fokus menyorot benang & pasangannya, sisanya diredupkan; navigasi keyboard', async ({ page }, testInfo) => {
  const errors = watchErrors(page);
  await openThreads(page, testInfo);
  const svg = mapSvg(page);
  const q1 = walletNode(page, X.tka.repeatBuyer);
  const q1Tka = strandOf(page, X.tka.repeatBuyer, T.TKA);
  const synStrand = strandOf(page, X.screenerLink.buyers[0], T.SYN);
  const opacity = (locator) => locator.evaluate((el) => Number(getComputedStyle(el).opacity));
  await expect(svg).not.toHaveAttribute('data-focus');

  if (!onMobile(testInfo)) {
    await q1.hover();
    await expect(svg).toHaveAttribute('data-focus', 'wallet');
    await expect(q1).toHaveAttribute('class', IS_ON);
    await expect(q1Tka).toHaveAttribute('class', IS_ON);
    await expect(tokenNode(page, T.TKA)).toHaveAttribute('class', IS_ON);
    await expect(synStrand).not.toHaveAttribute('class', IS_ON);
    await expect(tokenNode(page, T.SYN)).not.toHaveAttribute('class', IS_ON);
    await expect.poll(() => opacity(synStrand)).toBeLessThan(0.5);
    await expect.poll(() => opacity(q1Tka)).toBeGreaterThan(0.9);
    await page.mouse.move(1, 1);
    await expect(svg).not.toHaveAttribute('data-focus');
    await expect.poll(() => opacity(synStrand)).toBeGreaterThan(0.9);
  }

  // Keyboard: Tab dari pengalih langsung ke node wallet (satu tab stop per kolom; <svg> bukan tab stop kosong).
  await viewRadio(page, 'Peta Benang').focus();
  await page.keyboard.press('Tab');
  await expect(threads(page).locator('a[data-thr="wallet"]').first()).toBeFocused();
  await q1.focus();
  await expect(svg).toHaveAttribute('data-focus', 'wallet');
  await expect(q1Tka).toHaveAttribute('class', IS_ON);
  await expect(synStrand).not.toHaveAttribute('class', IS_ON);
  // Panah kanan: wallet → benangnya (dipilih, panel bukti terisi) → token.
  await page.keyboard.press('ArrowRight');
  await expect(q1Tka).toBeFocused();
  await expect(q1Tka).toHaveAttribute('class', IS_SELECTED);
  await expect(evidencePanel(page)).toContainText('Beli via swap');
  await page.keyboard.press('ArrowRight');
  await expect(tokenNode(page, T.TKA)).toBeFocused();
  await expect(svg).toHaveAttribute('data-focus', 'token');
  for (const wallet of TKA_BUYERS) await expect(strandOf(page, wallet, T.TKA)).toHaveAttribute('class', IS_ON);
  await expect(synStrand).not.toHaveAttribute('class', IS_ON);
  // Esc menghapus pilihan; panel kembali ke petunjuk.
  await page.keyboard.press('Escape');
  await expect(q1Tka).not.toHaveAttribute('class', IS_SELECTED);
  await expect(evidencePanel(page)).toContainText('Pilih benang');
  expect(errors).toEqual([]);
});

test('E2E-SM-THREADS-004 klik/ketuk benang mengisi panel bukti (aria-live) dengan tautan tx https; deposit ke exchange tidak disebut jual', async ({ page }, testInfo) => {
  const errors = watchErrors(page);
  await openThreads(page, testInfo);
  const evidence = evidencePanel(page);
  await expect(evidence).toHaveAttribute('aria-live', 'polite');
  await expect(evidence).toContainText('Pilih benang');

  // Q1 membeli TKA tiga kali di jendela 24 jam: tiga tx beli pertama skenario.
  const q1Tka = strandOf(page, X.tka.repeatBuyer, T.TKA);
  await pickStrand(page, q1Tka, testInfo);
  await expect(q1Tka).toHaveAttribute('class', IS_SELECTED);
  await expect(evidence).toContainText('Beli via swap');
  await expect(evidence.getByRole('link', { name: `Profil wallet ${X.tka.repeatBuyer}` })).toBeVisible();
  await expect(evidence.locator('.sm-thr-ev__facts')).toContainText('3 / 0');
  await expect(evidence.locator('.sm-txs li')).toHaveCount(3);
  for (const tx of X.tka.buyTxs.slice(0, 3)) {
    await expect(evidence.getByRole('link', { name: `Buka transaksi ${tx} di explorer (tab baru)` })).toBeVisible();
  }
  await expectSafeExternalLinks(evidence);

  // Deposit ke exchange = indikasi keluar, belum tentu dijual — tidak pernah disebut penjualan.
  await pickStrand(page, strandOf(page, X.cexExit.wallet, T.TKC), testInfo);
  await expect(evidence).toContainText('Indikasi keluar: dipindah ke exchange, belum tentu dijual');
  await expect(evidence).toContainText('Deposit ke exchange');
  await expect(evidence).not.toContainText('dijual via swap');
  await expect(evidence).not.toContainText('Swap jual');
  await expect(evidence.getByRole('link', { name: `Buka transaksi ${X.cexExit.txHash} di explorer (tab baru)` })).toBeVisible();
  await expectSafeExternalLinks(evidence);

  // Penjualan lewat swap memang disebut dijual.
  await pickStrand(page, strandOf(page, X.largeSell.wallet, T.TKG), testInfo);
  await expect(evidence).toContainText('Indikasi keluar: dijual via swap');
  await expect(evidence.getByRole('link', { name: `Buka transaksi ${X.largeSell.txHash} di explorer (tab baru)` })).toBeVisible();
  await expectSafeExternalLinks(evidence);
  expect(errors).toEqual([]);
});

test('E2E-SM-THREADS-005 node wallet membuka profil wallet; kembali memulihkan peta; Enter pada node token membuka detail token', async ({ page }, testInfo) => {
  const errors = watchErrors(page);
  await openThreads(page, testInfo);
  await walletNode(page, X.tka.repeatBuyer).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Profil Wallet' })).toBeVisible();
  await expect(page.getByTestId('sm-wallet-address')).toHaveText(X.tka.repeatBuyer);
  await expect(page).toHaveURL(new RegExp(`#/smart-wallet\\?c=ethereum&a=${X.tka.repeatBuyer}$`));

  await page.goBack();
  await expect(mapSvg(page)).toBeVisible();
  await expect(viewRadio(page, 'Peta Benang')).toBeChecked();

  await tokenNode(page, T.PEPE_A).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Detail Token' })).toBeVisible();
  await expect(page.getByTestId('sm-token-contract')).toHaveText(T.PEPE_A.address);
  expect(errors).toEqual([]);
});

test('E2E-SM-THREADS-006 penanda SIMULASI: lencana peta, tanda air, tiap token & benang, dan panel bukti', async ({ page }, testInfo) => {
  const errors = watchErrors(page);
  await openThreads(page, testInfo);
  await expect(page.getByTestId('sm-simulated')).toContainText('DATA SIMULASI');
  await expect(threads(page).locator('.sm-thr__head').getByText('SIMULASI', { exact: true })).toBeVisible();
  await expect(mapSvg(page)).toHaveAttribute('data-sim', 'true');
  await expect(mapSvg(page).locator('desc')).toContainText('DATA SIMULASI — bukan data live');
  await expect(mapSvg(page).locator('.sm-thr__watermark')).toHaveText('DATA SIMULASI');

  // Skenario seluruhnya simulasi: setiap token menampilkan SIMULASI, setiap benang bertanda data-sim.
  const tokenCount = await threads(page).locator('a[data-thr="token"]').count();
  await expect(mapSvg(page).locator('.sm-thr-token__sim')).toHaveCount(tokenCount);
  await expect(mapSvg(page).locator('.sm-thr-token__sim').first()).toBeVisible();
  expect(await threads(page).locator('g[data-thr="strand"][data-sim="true"]').count()).toBeGreaterThan(0);
  await expect(threads(page).locator('g[data-thr="strand"]:not([data-sim="true"])')).toHaveCount(0);
  await expect(tokenNode(page, T.TKA)).toHaveAttribute('aria-label', /data simulasi/);
  await expect(strandOf(page, X.tka.repeatBuyer, T.TKA)).toHaveAttribute('aria-label', /data simulasi/);

  await pickStrand(page, strandOf(page, X.tka.repeatBuyer, T.TKA), testInfo);
  await expect(evidencePanel(page).locator('.sm-thr-ev__head').getByText('SIMULASI', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('E2E-SM-THREADS-007 simbol sama ≠ token sama: dua PEPE berbeda kontrak tampil sebagai dua node', async ({ page }, testInfo) => {
  const errors = watchErrors(page);
  await openThreads(page, testInfo);
  const pepeA = tokenNode(page, T.PEPE_A);
  const pepeB = tokenNode(page, T.PEPE_B);
  await expect(pepeA).toHaveCount(1);
  await expect(pepeB).toHaveCount(1);
  // Simbol bersama diberi akhiran kontrak agar keduanya dapat dibedakan.
  await expect(pepeA.locator('.sm-thr-token__sym')).toHaveText(`PEPE·${T.PEPE_A.address.slice(-4)}`);
  await expect(pepeB.locator('.sm-thr-token__sym')).toHaveText(`PEPE·${T.PEPE_B.address.slice(-4)}`);
  await expect(pepeA.locator('.sm-thr-token__match')).toHaveAttribute('data-status', 'MATCHED');
  await expect(pepeB.locator('.sm-thr-token__match')).toHaveAttribute('data-status', 'SYMBOL_ONLY');
  await expect(pepeA).toHaveAttribute('aria-label', new RegExp(`Binance: ${X.pepe.futuresSymbol}`));
  await expect(pepeB).toHaveAttribute('aria-label', /Binance: Simbol sama/);
  await expect(pepeA).toHaveAttribute('aria-label', new RegExp(`kontrak ${T.PEPE_A.address.slice(0, 6)}…${T.PEPE_A.address.slice(-4)}`));
  await expect(pepeB).toHaveAttribute('aria-label', new RegExp(`kontrak ${T.PEPE_B.address.slice(0, 6)}…${T.PEPE_B.address.slice(-4)}`));

  // Pembeli berbeda: benang ke kontrak A tidak bercampur dengan kontrak B.
  await expect(strandOf(page, W.Q2, T.PEPE_A)).toHaveCount(1);
  await expect(strandOf(page, W.Q3, T.PEPE_B)).toHaveCount(1);
  await expect(strandOf(page, W.Q2, T.PEPE_B)).toHaveCount(0);
  await expect(strandOf(page, W.Q3, T.PEPE_A)).toHaveCount(0);
  await pepeA.focus();
  await expect(strandOf(page, W.Q2, T.PEPE_A)).toHaveAttribute('class', IS_ON);
  await expect(strandOf(page, W.Q3, T.PEPE_B)).not.toHaveAttribute('class', IS_ON);
  expect(errors).toEqual([]);
});

test('E2E-SM-THREADS-008 tata letak: tanpa scroll horizontal halaman (ponsel 390 px: mode ringkas), juga setelah panel bukti terisi', async ({ page }, testInfo) => {
  const errors = watchErrors(page);
  await openThreads(page, testInfo);
  const { width } = page.viewportSize();
  await expect(mapSvg(page)).toHaveAttribute('data-compact', onMobile(testInfo) ? 'true' : 'false');
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);
  const box = await mapSvg(page).boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);

  // Panel bukti berisi hash tx & catatan panjang tetap tidak melebarkan halaman.
  await pickStrand(page, strandOf(page, X.cexExit.wallet, T.TKC), testInfo);
  await expect(evidencePanel(page)).toContainText('belum tentu dijual');
  await pickStrand(page, strandOf(page, X.tka.repeatBuyer, T.TKA), testInfo);
  await expect(evidencePanel(page).locator('.sm-txs li')).toHaveCount(3);
  expect(await overflow()).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

test.describe('prefers-reduced-motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('E2E-SM-THREADS-009 animasi aliran benang mati saat prefers-reduced-motion', async ({ page }, testInfo) => {
    const errors = watchErrors(page);
    await openThreads(page, testInfo);
    const flow = mapSvg(page).locator('.sm-thr-strand__flow').first();
    await expect(flow).toBeAttached();
    expect(await flow.evaluate((el) => getComputedStyle(el).display)).toBe('none');
    expect(await flow.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
    expect(errors).toEqual([]);
  });
});
