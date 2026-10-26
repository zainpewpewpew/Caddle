// Render view Smart Money dengan DOM tiruan (helpers/fakeDom.js) dan fetch tiruan berbentuk kontrak docs/15 §5.
import { afterEach, describe, expect, it } from 'vitest';
import { DISCLAIMERS } from '../../../backend/smartmoney/contracts.js';
import { setCsrfToken } from '../../../frontend/js/lib/api.js';
import { SCREENER_COLUMNS, withSmartMoneyChips } from '../../../frontend/js/views/screener.js';
import { smartMoneyView } from '../../../frontend/js/views/smartMoneyRadar.js';
import { smartTokenView } from '../../../frontend/js/views/smartToken.js';
import { smartWalletView, smartWalletsView } from '../../../frontend/js/views/smartWallets.js';
import { smartWatchlistView } from '../../../frontend/js/views/smartWatchlist.js';
import { flush, installFakeDom } from './helpers/fakeDom.js';

const NOW = Date.now();
const TOKEN = '0x6982508145454ce325ddbe47a25d4ec3d2311933';
const TOKEN2 = '0x1111111111111111111111111111111111111111';
const W1 = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const W2 = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TX = `0x${'ab'.repeat(32)}`;

const meta = (over = {}) => ({
  simulated: false, dataAsOf: NOW - 60_000, lastSyncAt: NOW - 120_000, isStale: false,
  coverage: { chains: ['ethereum', 'base'], wallets: 12, activities: 340 }, providersConfigured: 2, disclaimers: DISCLAIMERS, ...over,
});

const radarItem = (over = {}) => ({
  tokenKey: `ethereum:${TOKEN}`, chain: 'ethereum', token: { address: TOKEN, symbol: 'PEPE', name: 'Pepe', decimals: 18 },
  buyers: [
    { wallet: W1, score: 81, clusterId: `ethereum:${W1}`, netBuyUsd: 5000, buys: 2, sells: 0, firstBuyAt: NOW - 3e6, lastBuyAt: NOW - 1e6,
      label: { label: 'Fund A', category: 'fund', source: 'arkham' },
      txs: [{ txHash: TX, explorerUrl: `https://etherscan.io/tx/${TX}`, type: 'SWAP_BUY', at: NOW - 1e6, usd: null }] },
    { wallet: W2, score: 66, clusterId: `ethereum:${W1}`, netBuyUsd: null, buys: 1, sells: 0, txs: [] },
  ],
  buyerCount: 2, independentBuyers: 1, sellerCount: 0, grossBuyUsd: 5000, grossSellUsd: null, netFlowUsd: 5000, unknownUsdCount: 1,
  holdingChangePct: 12.5,
  exitSignals: [{ wallet: W2, type: 'CEX_DEPOSIT', at: NOW - 5e5, usd: 100, txHash: TX, explorerUrl: `https://etherscan.io/tx/${TX}` }],
  excluded: { transferIn: 2, cexWithdrawal: 1, bridge: 0, airdrop: 3, lp: 1, mint: 0 },
  firstActivityAt: NOW - 3e6, lastActivityAt: NOW - 5e5, state: 'ACCUMULATING', conviction: 64,
  convictionComponents: { breadth: 0.5, quality: 0.8, flow: 0.4, repeat: 0.3, recency: 0.9, exitPenalty: 0.1, concentrationPenalty: 0.2 },
  reasons: ['2 wallet berkualitas membeli lewat swap'], risks: ['1 wallet memindahkan token ke exchange'],
  binance: { status: 'MATCHED', binanceAsset: 'PEPE', spotSymbol: 'PEPEUSDT', futuresSymbol: '1000PEPEUSDT', multiplier: 1000, source: 'manual', note: '' },
  screener: { signals: [{ timeframe: '15m', state: 'BREAKOUT', classification: 'PVA', tier: 'A', patterns: ['akumulasi volume progresif'] }],
    relevance: 'TINGGI', relevanceReason: 'Keyakinan 64 dan sinyal tier A', note: DISCLAIMERS.spotVsFutures },
  watching: false, isSimulated: false,
  ...over,
});

let dom;
afterEach(() => dom?.uninstall());

const jsonRoute = (table) => (url, init) => {
  const path = url.split('?')[0];
  const handler = table[`${init.method ?? 'GET'} ${path}`] ?? table[path];
  if (!handler) return { status: 404, body: { error: 'NOT_FOUND', message: 'tidak ada' } };
  return typeof handler === 'function' ? handler(url, init) : { status: 200, body: handler };
};

const texts = (el) => el.textContent.replace(/\s+/g, ' ');

describe('Smart Money UI — Radar', () => {
  it('UNIT-SM-UI-060 kartu token: kontrak + chain, keyakinan bukan probabilitas, USD null = —, Binance MATCHED, bukti', async () => {
    dom = installFakeDom({
      hash: '#/smart-money',
      responses: jsonRoute({
        '/api/smart-money/radar': { meta: meta(), window: '24h', computedAt: NOW, items: [radarItem(), radarItem({ tokenKey: `base:${TOKEN2}`, chain: 'base', token: { address: TOKEN2, symbol: 'PEPE' }, binance: { status: 'SYMBOL_ONLY' }, screener: { relevance: 'TIDAK_TERHUBUNG', signals: [] }, state: 'EXITING' })] },
      }),
    });
    const el = await smartMoneyView();
    const t = texts(el);
    expect(el.querySelectorAll('[data-testid="sm-radar-item"]')).toHaveLength(2);
    expect(t).toContain('Skor keyakinan (bukan probabilitas)');
    expect(t).toContain('1 dari 2'); // pembeli independen vs jumlah pembeli
    expect(t).toContain('Ethereum');
    expect(t).toContain('Base');
    expect(t).toContain('0x698250…311933'); // kontrak selalu tampil untuk membedakan simbol sama
    expect(t).toContain('0x111111…111111');
    expect(t).toContain('1000PEPEUSDT');
    expect(t).toContain('Simbol sama, kontrak belum terverifikasi');
    expect(t).toContain('+12,5%');
    expect(t).toContain(DISCLAIMERS.insiderName);
    expect(el.querySelector('[data-testid="sm-simulated"]')).toBeNull();
    const unknown = el.querySelectorAll('.sm-usd--unknown');
    expect(unknown.length).toBeGreaterThan(0);
    expect(unknown[0].getAttribute('title')).toBe('nilai USD tidak diketahui');
    // Buka chart hanya untuk MATCHED.
    const charts = el.querySelectorAll('a[href="#/symbol?s=1000PEPEUSDT&tf=15m&dir=LONG"]');
    expect(charts).toHaveLength(1);

    // Bukti dimuat saat tombol diperluas.
    const toggle = el.querySelectorAll('button[aria-controls]')[0];
    const panelEl = el.querySelector(`#${toggle.getAttribute('aria-controls')}`);
    expect(panelEl.hidden).toBe(true);
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(panelEl.hidden).toBe(false);
    const ev = texts(panelEl);
    expect(ev).toContain('tidak dihitung sebagai pembelian: transfer masuk 2, penarikan exchange 1, bridge 0, airdrop 3, LP 1');
    expect(ev).toContain('Fund A');
    expect(ev).toContain('1 klaster · 2 pembeli');
    expect(ev).toContain('Deposit ke exchange');
    expect(ev).toContain(DISCLAIMERS.conviction);
    expect(ev).toContain(DISCLAIMERS.spotVsFutures);
    const links = panelEl.querySelectorAll('a[target="_blank"]');
    expect(links.length).toBeGreaterThan(0);
    for (const a of links) {
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
      expect(a.getAttribute('href')).toMatch(/^https:\/\//);
    }
  });

  it('UNIT-SM-UI-061 data simulasi → pita DATA SIMULASI; data basi → peringatan', async () => {
    dom = installFakeDom({ responses: jsonRoute({ '/api/smart-money/radar': { meta: meta({ simulated: true, isStale: true }), items: [radarItem({ isSimulated: true })] } }) });
    const el = await smartMoneyView();
    const ribbon = el.querySelector('[data-testid="sm-simulated"]');
    expect(ribbon).not.toBeNull();
    expect(texts(ribbon)).toContain('DATA SIMULASI');
    expect(texts(ribbon)).toContain(DISCLAIMERS.simulated);
    expect(el.querySelector('[data-testid="sm-status"]').getAttribute('data-stale')).toBe('true');
    expect(texts(el)).toContain('BASI');
  });

  it('UNIT-SM-UI-062 tanpa provider & tanpa data → keadaan jujur "belum ada sumber data" dengan tautan ke System Health', async () => {
    dom = installFakeDom({ responses: jsonRoute({ '/api/smart-money/radar': { meta: meta({ providersConfigured: 0, isStale: true, lastSyncAt: null, dataAsOf: null }), items: [] } }) });
    const el = await smartMoneyView();
    expect(texts(el)).toContain('Belum ada sumber data on-chain');
    expect(el.querySelector('a[href="#/health"]')).not.toBeNull();
    expect(el.querySelectorAll('[data-testid="sm-radar-item"]')).toHaveLength(0);
    expect(texts(el)).toContain('belum pernah');
  });

  it('UNIT-SM-UI-063 kegagalan API → error state dengan Coba lagi yang memuat ulang', async () => {
    let calls = 0;
    dom = installFakeDom({
      responses: jsonRoute({
        '/api/smart-money/radar': () => {
          calls += 1;
          return calls === 1 ? { status: 503, body: { error: 'PROVIDER_DOWN', message: 'Sumber data tidak tersedia' } } : { status: 200, body: { meta: meta(), items: [radarItem()] } };
        },
      }),
    });
    const el = await smartMoneyView();
    expect(texts(el)).toContain('Gagal memuat radar smart money');
    expect(texts(el)).toContain('PROVIDER_DOWN');
    const retry = el.querySelector('.sm-error button');
    retry.click();
    await flush();
    expect(calls).toBe(2);
    expect(el.querySelectorAll('[data-testid="sm-radar-item"]')).toHaveLength(1);
  });

  it('UNIT-SM-UI-064 perubahan filter mengirim query yang divalidasi', async () => {
    dom = installFakeDom({ hash: '#/smart-money?window=4h&chain=base', responses: jsonRoute({ '/api/smart-money/radar': { meta: meta(), items: [] } }) });
    const el = await smartMoneyView();
    expect(dom.requests[0].url).toBe('/api/smart-money/radar?window=4h&chain=base&limit=100');
    const form = el.querySelector('form');
    form.elements.state.value = 'ACCUMULATING';
    form.querySelector('[name="linked"]').checked = true;
    form.dispatchEvent({ type: 'change' });
    await flush();
    expect(dom.requests.at(-1).url).toBe('/api/smart-money/radar?window=4h&chain=base&state=ACCUMULATING&linked=true&limit=100');
    expect(texts(el)).toContain('Tidak ada token yang cocok dengan filter');
  });

  it('UNIT-SM-UI-066 panel evaluasi historis: belum ada laporan → keadaan kosong jujur; ada laporan → tabel per horizon', async () => {
    dom = installFakeDom({
      responses: jsonRoute({
        '/api/smart-money/radar': { meta: meta(), items: [radarItem()] },
        '/api/smart-money/evaluation': { meta: meta(), available: false },
      }),
    });
    let el = await smartMoneyView();
    expect(dom.requests.map((r) => r.url)).toEqual(['/api/smart-money/radar?window=24h&limit=100', '/api/smart-money/evaluation']);
    expect(texts(el)).toContain('Belum ada evaluasi historis');
    expect(texts(el)).toContain('npm run smart-money:evaluate');
    expect(el.querySelector('[data-testid="sm-evaluation"]')).toBeNull();
    dom.uninstall();

    const report = {
      kind: 'smart-money-evaluation',
      params: { start: NOW - 30 * 86_400_000, end: NOW - 3 * 86_400_000, stepMs: 21_600_000, windowMs: 86_400_000, minIndependentBuyers: 3, horizonsMs: [14_400_000, 86_400_000] },
      data: { simulated: true },
      summary: { steps: 108, signals: 7, candidates: 9 },
      overall: [
        { horizonMs: 14_400_000, signals: 7, coverage: 1, mean: 0.031, median: 0.02, hitRate: 0.714, hitRateCi: [0.36, 0.92], baselineMean: 0.01, excessMean: 0.021, warnings: ['sampel kecil: n = 7 < 30'] },
        { horizonMs: 86_400_000, signals: 7, coverage: 0.57, mean: -0.05, median: -0.04, hitRate: 0.25, hitRateCi: [0.05, 0.7], baselineMean: null, excessMean: null, warnings: [] },
      ],
      warnings: ['Tidak cukup sampel untuk kesimpulan.'],
    };
    dom = installFakeDom({
      responses: jsonRoute({
        '/api/smart-money/radar': { meta: meta(), items: [radarItem()] },
        '/api/smart-money/evaluation': { meta: meta({ simulated: true }), available: true, computedAt: NOW, params: report.params, report, isSimulated: true },
      }),
    });
    el = await smartMoneyView();
    const panelEl = el.querySelector('[data-testid="sm-evaluation"]');
    const t = texts(panelEl);
    expect(t).toContain('SIMULASI');
    expect(t).toContain('108 titik setiap 6 jam');
    expect(t).toContain('7 sinyal dari 9 kandidat');
    expect(t).toContain('4 jam');
    expect(t).toContain('+3,1%');
    expect(t).toContain('-5%');
    expect(t).toContain('sampel kecil: n = 7 < 30');
    expect(t).toContain('Tidak cukup sampel untuk kesimpulan.');
    expect(t).toContain('BUKAN peluang terkalibrasi');
  });

  it('UNIT-SM-UI-067 strip status menampilkan atribusi sumber data dan catatan pemotongan', async () => {
    dom = installFakeDom({
      responses: jsonRoute({
        '/api/smart-money/radar': { meta: meta({ attributions: ['Data riwayat transaksi: Etherscan API (Powered by Etherscan)'], truncated: true }), items: [radarItem()] },
        '/api/smart-money/evaluation': { meta: meta(), available: false },
      }),
    });
    const el = await smartMoneyView();
    expect(texts(el.querySelector('[data-testid="sm-attributions"]'))).toContain('Powered by Etherscan');
    expect(texts(el.querySelector('[data-testid="sm-status"]'))).toContain('hanya aktivitas terbaru yang dihitung');
    dom.uninstall();
    dom = installFakeDom({ responses: jsonRoute({ '/api/smart-money/radar': { meta: meta(), items: [] }, '/api/smart-money/evaluation': { available: false } }) });
    expect((await smartMoneyView()).querySelector('[data-testid="sm-attributions"]')).toBeNull();
  });

  it('UNIT-SM-UI-065 tombol ikuti token: POST lalu DELETE watchlist dengan CSRF', async () => {
    setCsrfToken('csrf-x');
    dom = installFakeDom({
      responses: jsonRoute({
        '/api/smart-money/radar': { meta: meta(), items: [radarItem()] },
        'POST /api/smart-money/watchlist': () => ({ status: 201, body: {} }),
        'DELETE /api/smart-money/watchlist': () => ({ status: 204 }),
      }),
    });
    const el = await smartMoneyView();
    const btn = el.querySelector('.sm-watch');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    btn.click();
    await flush();
    expect(dom.requests.at(-1)).toMatchObject({ url: '/api/smart-money/watchlist', method: 'POST', body: { kind: 'TOKEN', chain: 'ethereum', address: TOKEN } });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    btn.click();
    await flush();
    expect(dom.requests.at(-1).method).toBe('DELETE');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('Smart Money UI — Wallet', () => {
  const walletRow = (over = {}) => ({
    chain: 'ethereum', address: W1, score: 78, eligible: true, style: 'SWING', clusterId: `ethereum:${W1}`, clusterSize: 3,
    flags: [{ code: 'BOT', severity: 'MEDIUM', reason: 'Median jeda tx 40 dtk', source: 'heuristik' }],
    metrics: { closedTrades: 24, distinctTokens: 7, historyDays: 120, completenessRatio: 0.82 },
    topReason: 'Return per trade konsisten', labels: [{ label: 'Fund A', category: 'fund', source: 'arkham' }], lastActivityAt: NOW, watching: true, ...over,
  });

  it('UNIT-SM-UI-070 Wallet Discovery: penjelasan peringkat, flag dengan alasan, klaster, label bersumber', async () => {
    dom = installFakeDom({ responses: jsonRoute({ '/api/smart-money/wallets': { meta: meta(), items: [walletRow()] } }) });
    const el = await smartWalletsView();
    const t = texts(el);
    expect(t).toContain('Peringkat TIDAK didasarkan pada saldo atau win rate saja');
    expect(t).toContain('terkait 2 wallet');
    expect(t).toContain('82%');
    expect(dom.requests[0].url).toBe('/api/smart-money/wallets?eligible=true&limit=200');
    const flag = el.querySelector('.sm-flags .badge');
    expect(flag.textContent).toBe('BOT');
    expect(flag.getAttribute('title')).toContain('Median jeda tx 40 dtk');
    expect(el.querySelector('.sm-labels .badge').getAttribute('title')).toBe('Fund A (sumber: arkham)');
    expect(el.querySelector(`a[href="#/smart-wallet?c=ethereum&a=${W1}"]`)).not.toBeNull();
  });

  const profile = () => ({
    meta: meta(),
    wallet: { chain: 'ethereum', address: W1, explorerUrl: `https://etherscan.io/address/${W1}`, firstSeenAt: NOW - 9e9, lastActivityAt: NOW, discoveredVia: 'top-trader', discoveryReason: 'PnL tinggi', isSimulated: false },
    labels: [{ label: 'Fund A', category: 'fund', source: 'arkham' }, { label: 'Rumor', category: 'other', source: null }],
    score: { score: 78, eligible: true, style: 'SWING', components: { profitability: 0.6, consistency: 0.7, sampleSize: 0.8, risk: 0.5, diversification: 0.4, history: 1 },
      metrics: { closedTrades: 24, distinctTokens: 7, historyDays: 120, winRate: 0.6, medianReturnPct: 8.2, shrunkMeanReturnPct: 5.1, meanReturnExTopPct: 3, maxDrawdownPct: -12, topTokenPnlShare: 0.4, completenessRatio: 0.82, weeklyPositiveShare: 0.6 },
      reasons: ['Profit tersebar di 7 token'], limitations: ['Riwayat sebelum 2026 tidak terlihat'], computedAt: NOW },
    flags: [{ code: 'INCOMPLETE_PNL', severity: 'MEDIUM', reason: 'Sebagian lot tanpa biaya', evidence: { completenessRatio: 0.4 }, source: 'heuristik' }],
    cluster: { id: `ethereum:${W1}`, members: [W1, W2], reasons: [{ type: 'SAME_FUNDER', a: W1, b: W2, evidence: { txHash: TX, at: NOW } }] },
    pnl: {
      summary: { realizedPnlUsd: 1200, unrealizedPnlUsd: null, totalCostUsd: 9000, airdropRealizedUsd: 300, tradesCount: 40, closedTradesCount: 24, tokensTraded: 7, completenessRatio: 0.82, completeness: 'PARTIAL', notes: ['Harga tidak tersedia untuk 1 token'] },
      positions: [{ tokenKey: `ethereum:${TOKEN}`, token: { address: TOKEN, symbol: 'PEPE' }, qtyHeld: 1000, knownCostQty: 800, costBasisUsd: 400, unknownCostQty: 200, realizedPnlUsd: 0, unrealizedPnlUsd: null, priceUsd: 0.5, priceAt: NOW - 9e7, stalePrice: true, buys: 2, sells: 0, firstBuyAt: NOW - 9e8, lastActivityAt: NOW, completeness: 'PARTIAL', notes: [] }],
    },
    activities: [
      { id: 'a', chain: 'ethereum', txHash: TX, blockTime: NOW - 1e6, wallet: W1, token: { address: TOKEN, symbol: 'PEPE' }, type: 'SWAP_BUY', direction: 'IN', amount: 1000, usdValue: 500, counterparty: W2, counterpartyLabel: null, confidence: 'HIGH', reason: 'Swap: wallet mengirim WETH', provider: 'x', isSimulated: false, explorerUrl: `https://etherscan.io/tx/${TX}` },
      { id: 'b', chain: 'ethereum', txHash: TX, blockTime: NOW - 2e6, wallet: W1, token: { address: TOKEN, symbol: 'PEPE' }, type: 'CEX_WITHDRAWAL', direction: 'IN', amount: 10, usdValue: null, counterparty: W2, counterpartyLabel: { label: 'Binance 14', category: 'cex', source: 'etherscan' }, confidence: 'HIGH', reason: 'Penarikan dari exchange', provider: 'x', isSimulated: false, explorerUrl: null },
    ],
    watching: false,
  });

  it('UNIT-SM-UI-071 Profil wallet: alamat lengkap, salin, keterbatasan data, PnL airdrop terpisah, badge jenis', async () => {
    dom = installFakeDom({ hash: `#/smart-wallet?c=ethereum&a=${W1.toUpperCase().replace('0X', '0x')}`, responses: jsonRoute({ [`/api/smart-money/wallets/ethereum/${W1}`]: profile() }) });
    const el = await smartWalletView();
    const t = texts(el);
    expect(el.querySelector('[data-testid="sm-wallet-address"]').textContent).toBe(W1);
    expect(el.querySelector('button[aria-label="Salin alamat"]')).not.toBeNull();
    expect(t).toContain('Keterbatasan data');
    expect(t).toContain('Riwayat sebelum 2026 tidak terlihat');
    expect(t).toContain('Label "Rumor" tanpa sumber');
    expect(t).toContain('lebih tua dari 24 jam');
    expect(t).toContain('Realisasi dari airdrop');
    expect(t).toContain('Win rate (info saja)');
    expect(t).toContain('Pendana pertama sama');
    expect(t).toContain('completenessRatio: 0.4');
    const kinds = el.querySelectorAll('.sm-type').map((b) => b.getAttribute('data-kind'));
    expect(kinds).toContain('buy');
    expect(kinds).toContain('cex');
    expect(el.querySelector(`a[target="_blank"][href="https://etherscan.io/address/${W1}"]`)).not.toBeNull();
  });

  it('UNIT-SM-UI-073 Profil wallet: drawdown tampil sebagai penurunan (−), bukti tautan pendana bersama', async () => {
    const data = profile();
    data.score.metrics.maxDrawdownPct = 23.4; // besaran ≥ 0 dari walletScore.js
    data.cluster.reasons = [{ type: 'COMMON_FUNDER', a: W1, b: W2, evidence: { funder: TOKEN2, txHash: TX, at: NOW } }];
    dom = installFakeDom({ hash: `#/smart-wallet?c=ethereum&a=${W1}`, responses: jsonRoute({ [`/api/smart-money/wallets/ethereum/${W1}`]: data }) });
    const t = texts(await smartWalletView());
    expect(t).toContain('Drawdown maks.−23,4%');
    expect(t).not.toContain('+23,4%');
    expect(t).toContain('Pendana pertama sama');
    expect(t).toContain('pendana 0x1111…1111');
  });

  it('UNIT-SM-UI-072 Profil wallet: 404 → "tidak dilacak"; parameter tidak valid → tanpa request', async () => {
    dom = installFakeDom({ hash: `#/smart-wallet?c=ethereum&a=${W2}`, responses: () => ({ status: 404, body: { error: 'NOT_FOUND' } }) });
    expect(texts(await smartWalletView())).toContain('Wallet tidak dilacak');
    dom.uninstall();
    dom = installFakeDom({ hash: '#/smart-wallet?c=ethereum&a=PEPE' });
    expect(texts(await smartWalletView())).toContain('Parameter wallet tidak valid');
    expect(dom.requests).toHaveLength(0);
  });
});

describe('Smart Money UI — Token', () => {
  const tokenDetail = (binance) => ({
    meta: meta(), token: { address: TOKEN, symbol: 'PEPE', name: 'Pepe' }, binance,
    radar: radarItem(), activities: profile0Activities(), screener: radarItem().screener, watching: true,
  });
  const profile0Activities = () => [{ id: 'a', chain: 'ethereum', txHash: TX, blockTime: NOW, wallet: W1, token: { address: TOKEN, symbol: 'PEPE' }, type: 'SWAP_SELL', amount: 1, usdValue: 10, confidence: 'MEDIUM', reason: 'Swap jual', explorerUrl: `https://etherscan.io/tx/${TX}` }];

  it('UNIT-SM-UI-080 Buka chart hanya bila MATCHED; SYMBOL_ONLY tidak ditautkan ke sinyal', async () => {
    dom = installFakeDom({ hash: `#/smart-token?c=ethereum&a=${TOKEN}`, responses: jsonRoute({ [`/api/smart-money/tokens/ethereum/${TOKEN}`]: tokenDetail(radarItem().binance) }) });
    let el = await smartTokenView();
    expect(el.querySelector('[data-testid="sm-open-chart"]').getAttribute('href')).toBe('#/symbol?s=1000PEPEUSDT&tf=15m&dir=LONG');
    expect(el.querySelector('[data-testid="sm-token-contract"]').textContent).toBe(TOKEN);
    expect(texts(el)).toContain('Swap jual');
    expect(el.querySelector(`a[href="#/smart-wallet?c=ethereum&a=${W1}"]`)).not.toBeNull();
    dom.uninstall();

    dom = installFakeDom({ hash: `#/smart-token?c=ethereum&a=${TOKEN}`, responses: jsonRoute({ [`/api/smart-money/tokens/ethereum/${TOKEN}`]: tokenDetail({ status: 'SYMBOL_ONLY', futuresSymbol: null }) }) });
    el = await smartTokenView();
    expect(el.querySelector('[data-testid="sm-open-chart"]')).toBeNull();
    expect(texts(el)).toContain('Tidak ditautkan ke sinyal screener');
  });
});

describe('Smart Money UI — Watchlist & Alerts', () => {
  const routes = (extra = {}) => jsonRoute({
    '/api/smart-money/watchlist': { items: [{ kind: 'WALLET', chain: 'ethereum', address: W1, note: null, createdAt: NOW, summary: { score: 78 } }, { kind: 'TOKEN', chain: 'base', address: TOKEN2, note: 'catatan', createdAt: NOW, summary: 'PEPE' }] },
    '/api/smart-money/alerts': { meta: meta({ simulated: true }), unread: 1, items: [{ id: 7, kind: 'LARGE_SELL', severity: 'HIGH', dedupeKey: 'k', chain: 'ethereum', tokenKey: `ethereum:${TOKEN}`, wallet: W1, title: 'Jual besar PEPE', message: 'Wallet menjual $20 rb', evidence: { txHashes: [TX], explorerUrls: [`https://etherscan.io/tx/${TX}`] }, createdAt: NOW, read: false, isSimulated: true }] },
    '/api/smart-money/alert-prefs': { prefs: { kinds: ['NEW_BUY', 'LARGE_SELL'], minUsd: 1000, largeSellUsd: 10000, minWalletScore: 60, minIndependentBuyers: 3, cooldownMs: 21_600_000, watchlistOnly: false }, isDefault: true },
    'POST /api/smart-money/alerts/read': { updated: 1 },
    ...extra,
  });

  it('UNIT-SM-UI-090 menampilkan diikuti, notifikasi (pita simulasi), dan menandai dibaca', async () => {
    dom = installFakeDom({ responses: routes() });
    const el = await smartWatchlistView();
    const t = texts(el);
    expect(t).toContain('Wallet (1)');
    expect(t).toContain('Token (1)');
    expect(t).toContain('skor 78');
    expect(t).toContain('Jual besar PEPE');
    expect(t).toContain('1 belum dibaca');
    expect(el.querySelector('[data-testid="sm-simulated"]')).not.toBeNull();
    expect(el.querySelector('.sm-alert').textContent).toContain('SIMULASI');
    const markAll = el.querySelectorAll('button').find((b) => b.textContent === 'Tandai semua dibaca');
    markAll.click();
    await flush();
    expect(dom.requests.find((r) => r.method === 'POST')).toMatchObject({ url: '/api/smart-money/alerts/read', body: { all: true } });
    const one = el.querySelectorAll('button').find((b) => b.textContent === 'Tandai dibaca');
    one.click();
    await flush();
    expect(dom.requests.filter((r) => r.method === 'POST').at(-1).body).toEqual({ ids: [7] });
  });

  it('UNIT-SM-UI-093 notifikasi wallet/token yang dipantau pengguna diberi badge "dipantau"', async () => {
    const base = { kind: 'NEW_BUY', severity: 'HIGH', chain: 'ethereum', tokenKey: `ethereum:${TOKEN}`, wallet: W1, evidence: {}, createdAt: NOW, read: false, isSimulated: false };
    dom = installFakeDom({
      responses: routes({
        '/api/smart-money/alerts': { meta: meta(), unread: 3, items: [
          { ...base, id: 1, title: 'A', walletWatched: true, watchlisted: true },
          { ...base, id: 2, title: 'B', walletWatched: false, watchlisted: true },
          { ...base, id: 3, title: 'C', walletWatched: false, watchlisted: false },
        ] },
      }),
    });
    const el = await smartWatchlistView();
    const items = el.querySelectorAll('.sm-alert');
    expect(items).toHaveLength(3);
    expect(items[0].querySelector('.sm-alert__watched').textContent).toBe('Wallet dipantau');
    expect(items[1].querySelector('.sm-alert__watched').textContent).toBe('Token dipantau');
    expect(items[2].querySelector('.sm-alert__watched')).toBeNull();
  });

  it('UNIT-SM-UI-091 validasi klien mencegah PUT; nilai valid → PUT {prefs} dengan cooldownMs', async () => {
    dom = installFakeDom({ responses: routes({ 'PUT /api/smart-money/alert-prefs': (_u, init) => ({ status: 200, body: JSON.parse(init.body) }) }) });
    const el = await smartWatchlistView();
    const form = el.querySelector('form.sm-prefs');
    form.querySelector('[name="minWalletScore"]').value = '150';
    form.dispatchEvent({ type: 'submit' });
    await flush();
    expect(dom.requests.some((r) => r.method === 'PUT')).toBe(false);
    const err = form.querySelector('[data-error-for="minWalletScore"]');
    expect(err.hidden).toBe(false);
    expect(err.textContent).toContain('0–100');
    expect(form.querySelector('[name="minWalletScore"]').getAttribute('aria-invalid')).toBe('true');

    form.querySelector('[name="minWalletScore"]').value = '70';
    form.querySelector('[name="cooldownHours"]').value = '2';
    form.dispatchEvent({ type: 'submit' });
    await flush();
    const put = dom.requests.find((r) => r.method === 'PUT');
    expect(put.body).toEqual({ prefs: { kinds: ['NEW_BUY', 'LARGE_SELL'], minUsd: 1000, largeSellUsd: 10000, minWalletScore: 70, minIndependentBuyers: 3, cooldownMs: 7_200_000, watchlistOnly: false } });
  });

  it('UNIT-SM-UI-092 error 400 server: `details` ditampilkan pada field / daftar umum', async () => {
    dom = installFakeDom({ responses: routes({ 'PUT /api/smart-money/alert-prefs': () => ({ status: 400, body: { error: 'INVALID_PREFS', message: 'Preferensi tidak valid', details: ['minUsd terlalu besar', 'aturan lain dilanggar'] } }) }) });
    const el = await smartWatchlistView();
    const form = el.querySelector('form.sm-prefs');
    form.dispatchEvent({ type: 'submit' });
    await flush();
    expect(form.querySelector('[data-error-for="minUsd"]').textContent).toBe('minUsd terlalu besar');
    expect(texts(form)).toContain('aturan lain dilanggar');
  });
});

describe('Smart Money UI — chip LONG Scanner', () => {
  it('UNIT-SM-UI-100 tanpa data smart money kolom tidak berubah; dengan data chip SM ×N di sel Symbol', () => {
    expect(withSmartMoneyChips(SCREENER_COLUMNS, null)).toBe(SCREENER_COLUMNS);
    expect(withSmartMoneyChips(SCREENER_COLUMNS, {})).toBe(SCREENER_COLUMNS);
    dom = installFakeDom();
    const cols = withSmartMoneyChips(SCREENER_COLUMNS, { '1000PEPEUSDT': { tokenKey: `ethereum:${TOKEN}`, independentBuyers: 3, conviction: 64, state: 'ACCUMULATING' } });
    expect(cols.map((c) => c.key)).toEqual(SCREENER_COLUMNS.map((c) => c.key));
    const symbolCol = cols.find((c) => c.key === 'symbol');
    const cell = symbolCol.render({ symbol: '1000PEPEUSDT' });
    expect(cell.querySelector('.mono').textContent).toBe('1000PEPEUSDT');
    const chip = cell.querySelector('.sm-chip');
    expect(chip.textContent).toBe('SM ×3');
    expect(chip.getAttribute('href')).toBe(`#/smart-token?c=ethereum&a=${TOKEN}`);
    expect(chip.getAttribute('title')).toContain('keyakinan 64/100');
    // Simbol tanpa data → render asli (tanpa chip).
    expect(symbolCol.render({ symbol: 'BTCUSDT' }).querySelector('.sm-chip')).toBeNull();
    expect(cell.querySelector('[data-testid="sm-chip-simulated"]')).toBeNull();
  });

  it('UNIT-SM-UI-101 data smart money simulasi → penanda SIMULASI terlihat di samping chip', () => {
    dom = installFakeDom();
    const links = { '1000PEPEUSDT': { tokenKey: `ethereum:${TOKEN}`, independentBuyers: 3, conviction: 64, state: 'ACCUMULATING' } };
    const viaMeta = withSmartMoneyChips(SCREENER_COLUMNS, links, { simulated: true }).find((c) => c.key === 'symbol').render({ symbol: '1000PEPEUSDT' });
    const marker = viaMeta.querySelector('[data-testid="sm-chip-simulated"]');
    expect(marker.textContent).toBe('SIMULASI');
    expect(viaMeta.querySelector('.sm-chip').getAttribute('data-simulated')).toBe('true');
    expect(viaMeta.querySelector('.sm-chip').getAttribute('title')).toContain('DATA SIMULASI');
    const viaItem = withSmartMoneyChips(SCREENER_COLUMNS, { '1000PEPEUSDT': { ...links['1000PEPEUSDT'], isSimulated: true } })
      .find((c) => c.key === 'symbol').render({ symbol: '1000PEPEUSDT' });
    expect(viaItem.querySelector('[data-testid="sm-chip-simulated"]')).not.toBeNull();
  });
});
