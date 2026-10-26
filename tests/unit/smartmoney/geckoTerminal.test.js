import { describe, expect, it } from 'vitest';
import { ZERO_ADDRESS } from '../../../backend/smartmoney/contracts.js';
import { rankCandidates } from '../../../backend/smartmoney/discovery.js';
import { ADAPTER_METHODS, validateAdapter } from '../../../backend/smartmoney/providers/adapter.js';
import {
  GECKOTERMINAL_ATTRIBUTION, GECKOTERMINAL_NETWORKS, PRICE_BATCH_SIZE, createGeckoTerminalProvider,
} from '../../../backend/smartmoney/providers/geckoTerminal.js';
import { createProviderRegistry } from '../../../backend/smartmoney/providers/registry.js';
import {
  fakeEvmAddress, fakeSolanaAddress, fakeSolanaSignature, fakeTxHash, gtList, gtPool, gtPrices, gtTrade, jsonResponse,
} from '../../fixtures/smartmoney/liveShapes.js';

// Tanpa jaringan: fetch palsu dengan respons BERBENTUK dokumentasi GeckoTerminal (belum direkam live — lihat
// tests/fixtures/smartmoney/liveShapes.js). Jam & tidur palsu: throttle 6/menit tidak membuat tes lambat.
const NOW = Date.UTC(2026, 9, 26, 12, 0);
const HOUR = 3_600_000;
const NET = 'eth';
const PEPE = '0x6982508145454ce325ddbe47a25d4ec3d2311933';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const upperHex = (a) => `0x${a.slice(2).toUpperCase()}`;

function fakeTime(start = NOW) {
  let now = start;
  return { clock: () => now, sleep: async (ms) => { now += ms; } };
}

/**
 * fetch palsu. `routes`: objek { path setelah /api/v2 → nilai } atau fungsi (path) → nilai; nilai = body JSON, objek
 * Response, atau fungsi (URL) → salah satunya. Rute tidak ada → 404.
 */
function setup(routes, options = {}) {
  const t = fakeTime();
  const calls = [];
  const resolve = typeof routes === 'function' ? routes : (path) => routes[path];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push({ url: u, at: t.clock(), init });
    const route = resolve(u.pathname.replace(/^\/api\/v2/, ''));
    if (route === undefined) return jsonResponse(404, { errors: [{ status: '404', title: 'Not Found' }] });
    const value = typeof route === 'function' ? route(u) : route;
    return value !== null && typeof value === 'object' && typeof value.text === 'function' ? value : jsonResponse(200, value);
  };
  return { gt: createGeckoTerminalProvider({ fetchImpl, clock: t.clock, sleep: t.sleep, ...options }), calls, t };
}

const W = Object.fromEntries(['w1', 'w2', 'w3', 'w4', 'w6', 'w7', 'w8', 'w9', 'x1'].map((k) => [k, fakeEvmAddress(`gt-${k}`)]));
const POOL_A = fakeEvmAddress('gt-pool-a');
const POOL_B = fakeEvmAddress('gt-pool-b');
const POOL_C = fakeEvmAddress('gt-pool-c');
const TX1 = fakeTxHash('gt-tx1');
const buy = (o) => gtTrade({ network: NET, kind: 'buy', fromToken: WETH, toToken: PEPE, ...o });
const sell = (o) => gtTrade({ network: NET, kind: 'sell', fromToken: PEPE, toToken: WETH, ...o });

function pepeRoutes() {
  return {
    [`/networks/${NET}/tokens/${PEPE}/pools`]: gtList([
      gtPool({ network: NET, address: upperHex(POOL_A), base: PEPE, quote: WETH, dex: 'uniswap_v3', name: 'PEPE / WETH 0.3%' }),
      gtPool({ network: NET, address: POOL_B, base: PEPE, quote: WETH, dex: 'uniswap_v2', name: 'PEPE / WETH' }),
      gtPool({ network: NET, address: POOL_C, base: PEPE, quote: WETH, dex: 'sushiswap' }),
    ]),
    [`/networks/${NET}/pools/${POOL_A}/trades`]: gtList([
      buy({ txHash: TX1, from: W.w1, volumeUsd: '5000.25', at: NOW - 1 * HOUR }),
      buy({ txHash: fakeTxHash('gt-tx2'), from: W.w1, volumeUsd: 2500, at: NOW - 2 * HOUR }),
      sell({ txHash: fakeTxHash('gt-tx3'), from: W.w2, volumeUsd: 9000, at: NOW - 1 * HOUR }),
      buy({ txHash: fakeTxHash('gt-tx4'), from: W.w3, volumeUsd: 500, at: NOW - 1 * HOUR }),
      buy({ txHash: fakeTxHash('gt-tx5'), from: W.w4, volumeUsd: 3000, at: NOW - 30 * HOUR }),
      buy({ txHash: fakeTxHash('gt-tx6'), from: '0x123', volumeUsd: 3000, at: NOW - HOUR }),
      buy({ txHash: TX1, from: W.w1, volumeUsd: '5000.25', at: NOW - 1 * HOUR }), // trade ganda (id sama)
      // kind 'buy' tetapi token yang diterima WETH → bertentangan → dibuang
      gtTrade({ network: NET, kind: 'buy', fromToken: PEPE, toToken: WETH, txHash: fakeTxHash('gt-tx8'), from: W.w6, volumeUsd: 4000, at: NOW - HOUR }),
      buy({ txHash: fakeTxHash('gt-tx9'), from: W.w7, volumeUsd: 4000, at: NOW - HOUR, omit: ['volume_in_usd'] }),
      buy({ txHash: fakeTxHash('gt-tx10'), from: W.w8, volumeUsd: 1200, at: NOW - 3 * HOUR, extra: { fancy_new_field: 'x' } }),
      buy({ txHash: fakeTxHash('gt-tx11'), from: ZERO_ADDRESS, volumeUsd: 2000, at: NOW - HOUR }),
      buy({ txHash: fakeTxHash('gt-tx12'), from: upperHex(W.w9), volumeUsd: 4000, at: NOW - 4 * HOUR }),
    ]),
    [`/networks/${NET}/pools/${POOL_B}/trades`]: gtList([
      buy({ txHash: TX1, logIndex: 7, from: W.w1, volumeUsd: 1000, at: NOW - 1 * HOUR }), // rute terpecah: tx sama, pool lain
      buy({ txHash: fakeTxHash('gt-tx13'), from: W.w2, volumeUsd: 'abc', at: NOW - HOUR }),
    ]),
    [`/networks/${NET}/pools/${POOL_C}/trades`]: gtList([buy({ txHash: fakeTxHash('gt-tx14'), from: W.x1, volumeUsd: 99_000, at: NOW - HOUR })]),
  };
}

describe('GeckoTerminal — penemuan kandidat wallet', () => {
  it('UNIT-SM-GTK-001 hanya pembeli ≥ minimum USD di pool teratas; satu kandidat per alamat; alasan Bahasa Indonesia', async () => {
    const { gt, calls } = setup(pepeRoutes());
    const result = await gt.discoverWallets({ chain: 'ethereum', tokens: [{ address: upperHex(PEPE), symbol: 'PEPE' }] });

    expect(result.map((c) => c.address)).toEqual([W.w1, W.w9, W.w8]);
    for (const c of result) {
      expect(c).toEqual({ chain: 'ethereum', address: expect.any(String), source: 'geckoterminal', reason: expect.any(String) });
      expect(c.reason).toContain('Pembeli ≥ $1.000 token PEPE di pool');
      expect(c.reason).toContain('dalam 24 jam terakhir — kandidat, belum dinilai');
      expect(c.reason).toContain('pengirim transaksi (tx_from_address)');
      expect(c.reason).toMatch(/relayer, bot, atau solver aggregator/);
    }
    const w1 = result[0].reason;
    expect(w1).toContain(`${POOL_A} (uniswap_v3), ${POOL_B} (uniswap_v2)`);
    expect(w1).toContain('2 transaksi beli, total ≈ $8.500'); // tx yang sama di dua pool = satu transaksi
    expect(result[1].reason).toContain('1 transaksi beli, total ≈ $4.000');

    // Panggilan: pool token (alamat dinormalisasi), lalu trade 2 pool teratas dengan filter USD di query.
    expect(calls.map((c) => c.url.pathname)).toEqual([
      `/api/v2/networks/${NET}/tokens/${PEPE}/pools`,
      `/api/v2/networks/${NET}/pools/${POOL_A}/trades`,
      `/api/v2/networks/${NET}/pools/${POOL_B}/trades`,
    ]);
    expect(calls[0].url.origin).toBe('https://api.geckoterminal.com');
    for (const c of calls.slice(1)) expect(c.url.searchParams.get('trade_volume_in_usd_greater_than')).toBe('1000');
    expect(calls.every((c) => c.init.method === 'GET' && c.init.headers['x-api-key'] === undefined)).toBe(true);

    const d = result.diagnostics;
    expect(d).toMatchObject({ provider: 'geckoterminal', method: 'discoverWallets', network: 'eth', tokensProcessed: 1, tradesSeen: 14, tradesUsed: 5, candidates: 3 });
    expect(d.dropped).toMatchObject({
      notBuy: 1, sideConflict: 1, belowMinUsd: 1, beforeSince: 1, invalidAddress: 2, duplicate: 1, missingVolume: 2, unknownKind: 0,
    });
    expect(d.pools.map((p) => [p.pool, p.side, p.dex])).toEqual([[POOL_A, 'base', 'uniswap_v3'], [POOL_B, 'base', 'uniswap_v2']]);
  });

  it('UNIT-SM-GTK-002 diagnostik: kunci atribut asing & hilang dicatat; dilampirkan non-enumerable dan lewat lastDiagnostics()', async () => {
    const { gt } = setup(pepeRoutes());
    expect(gt.lastDiagnostics()).toBeNull();
    const result = await gt.discoverWallets({ chain: 'ethereum', tokens: [{ address: PEPE }] });
    expect(result.diagnostics.unknownTradeKeys).toEqual(['fancy_new_field']);
    expect(result.diagnostics.missingTradeKeys).toEqual({ volume_in_usd: 1 });
    // Kontrak: hasil tetap array biasa — diagnostik tidak ikut kunci, JSON, maupun perbandingan.
    expect(Array.isArray(result)).toBe(true);
    expect(Object.keys(result)).toEqual(['0', '1', '2']);
    expect(JSON.parse(JSON.stringify(result))).toEqual([...result]);
    expect(gt.lastDiagnostics()).toEqual(result.diagnostics);
    // Tanpa simbol → alamat token disingkat di alasan.
    expect(result[0].reason).toContain('token 0x6982…1933 di pool');
  });

  it('EDGE-SM-GTK-001 since membatasi trade (data lama/terlambat dibuang); jendela 24 jam tetap berlaku; limit memotong', async () => {
    const { gt } = setup(pepeRoutes());
    const since = NOW - 3.5 * HOUR;
    const result = await gt.discoverWallets({ chain: 'ethereum', since, tokens: [{ address: PEPE }] });
    expect(result.map((c) => c.address)).toEqual([W.w1, W.w8]); // W9 (−4 jam) < since
    expect(result.diagnostics.since).toBe(since);
    expect(result.diagnostics.dropped.beforeSince).toBe(2);

    const { gt: gt2 } = setup(pepeRoutes());
    const old = await gt2.discoverWallets({ chain: 'ethereum', since: NOW - 72 * HOUR, limit: 1, tokens: [{ address: PEPE }] });
    expect(old.diagnostics.since).toBe(NOW - 24 * HOUR); // since lebih tua dari jendela endpoint → dipotong 24 jam
    expect(old.map((c) => c.address)).toEqual([W.w1]);
    expect(old.diagnostics).toMatchObject({ candidates: 3, truncated: true });
  });

  it('UNIT-SM-GTK-003 Solana: alamat base58 apa adanya (huruf besar/kecil dipertahankan); alamat tidak valid dibuang', async () => {
    const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    const WSOL = 'So11111111111111111111111111111111111111112';
    const pool = fakeSolanaAddress('gt-sol-pool');
    const buyer = fakeSolanaAddress('gt-sol-buyer');
    expect(buyer).toMatch(/[A-Z]/);
    expect(buyer).toMatch(/[a-z]/);
    const solBuy = (o) => gtTrade({ network: 'solana', kind: 'buy', fromToken: WSOL, toToken: BONK, volumeUsd: 2500, at: NOW - HOUR, ...o });
    const { gt, calls } = setup({
      [`/networks/solana/tokens/${BONK}/pools`]: gtList([gtPool({ network: 'solana', address: pool, base: BONK, quote: WSOL, dex: 'raydium' })]),
      [`/networks/solana/pools/${pool}/trades`]: gtList([
        solBuy({ txHash: fakeSolanaSignature('gt-s1'), from: buyer }),
        solBuy({ txHash: fakeSolanaSignature('gt-s2'), from: 'Inva1idAddressWith0AndO000000000000000000' }),
        solBuy({ txHash: fakeSolanaSignature('gt-s3'), from: `0x${'ab'.repeat(20)}` }), // alamat EVM di chain Solana
      ]),
    });
    const result = await gt.discoverWallets({ chain: 'solana', tokens: [{ address: BONK, symbol: 'BONK' }] });
    expect(result).toHaveLength(1);
    expect(result[0].address).toBe(buyer);
    expect(result[0].reason).toContain(`${pool} (raydium)`);
    expect(result.diagnostics.dropped.invalidAddress).toBe(2);
    expect(calls[0].url.pathname).toBe(`/api/v2/networks/solana/tokens/${BONK}/pools`);
    expect(calls[1].url.pathname).toBe(`/api/v2/networks/solana/pools/${pool}/trades`);
    // Keluaran langsung dapat dipakai discovery.rankCandidates (alamat tetap apa adanya).
    expect(rankCandidates(result)).toEqual([{ ...result[0], sources: ['geckoterminal'] }]);
  });

  it('UNIT-SM-GTK-004 sisi pool: token = quote → kind sell + to_token_address; sisi tak diketahui hanya dengan konfirmasi alamat; simbol sama token lain bukan pembelian', async () => {
    const T = fakeEvmAddress('gt-quote-token');
    const X = fakeEvmAddress('gt-base-token');
    const FAKE = fakeEvmAddress('gt-fake-same-symbol');
    const Q = fakeEvmAddress('gt-pool-q');
    const U = fakeEvmAddress('gt-pool-u');
    const F = fakeEvmAddress('gt-pool-f');
    const q1 = fakeEvmAddress('gt-q1');
    const u1 = fakeEvmAddress('gt-u1');
    const tr = (o) => gtTrade({ network: NET, at: NOW - HOUR, volumeUsd: 2000, ...o });
    const { gt } = setup({
      [`/networks/${NET}/tokens/${T}/pools`]: gtList([
        gtPool({ network: NET, address: Q, base: X, quote: T, dex: 'uniswap_v3' }),
        gtPool({ network: NET, address: U, base: X, quote: T, relationships: false }),
        gtPool({ network: NET, address: F, base: FAKE, quote: WETH, dex: 'uniswap_v2' }),
      ]),
      [`/networks/${NET}/pools/${Q}/trades`]: gtList([
        tr({ txHash: fakeTxHash('q1'), from: q1, kind: 'sell', fromToken: X, toToken: T, volumeUsd: 5000 }),
        tr({ txHash: fakeTxHash('q2'), from: fakeEvmAddress('gt-q2'), kind: 'sell', omit: ['from_token_address', 'to_token_address'] }),
        tr({ txHash: fakeTxHash('q3'), from: fakeEvmAddress('gt-q3'), kind: 'buy', fromToken: T, toToken: X }),
        tr({ txHash: fakeTxHash('q4'), from: fakeEvmAddress('gt-q4'), kind: 'buy', fromToken: X, toToken: T }),
      ]),
      [`/networks/${NET}/pools/${U}/trades`]: gtList([
        tr({ txHash: fakeTxHash('u1'), from: u1, kind: 'buy', fromToken: X, toToken: T }),
        tr({ txHash: fakeTxHash('u2'), from: fakeEvmAddress('gt-u2'), kind: 'buy', omit: ['to_token_address'] }),
      ]),
      [`/networks/${NET}/pools/${F}/trades`]: gtList([
        tr({ txHash: fakeTxHash('f1'), from: fakeEvmAddress('gt-f1'), kind: 'buy', fromToken: WETH, toToken: FAKE }),
      ]),
    }, { maxPoolsPerToken: 3 });
    const result = await gt.discoverWallets({ chain: 'ethereum', tokens: [{ address: T, symbol: 'PEPE' }] });
    expect(result.map((c) => c.address)).toEqual([q1, u1]);
    expect(result[1].reason).toContain(`${U} (DEX tidak diketahui)`);
    expect(result.diagnostics.pools.map((p) => p.side)).toEqual(['quote', 'unknown', 'unknown']);
    expect(result.diagnostics.dropped).toMatchObject({ sideUnconfirmed: 2, notBuy: 2, sideConflict: 1 });
  });

  it('UNIT-SM-GTK-005 throttle: panggilan berjarak 10 detik (6/menit)', async () => {
    const { gt, calls } = setup(pepeRoutes());
    await gt.discoverWallets({ chain: 'ethereum', tokens: [{ address: PEPE }] });
    expect(calls.map((c) => c.at - NOW)).toEqual([0, 10_000, 20_000]);
  });

  it('NEG-SM-GTK-001 HTTP 429 → RATE_LIMITED dengan retryAfterMs; tidak ada hasil sebagian', async () => {
    const limited = jsonResponse(429, { status: { error_code: 429, error_message: 'Rate limit' } }, { 'retry-after': '30' });
    const { gt } = setup({ [`/networks/${NET}/tokens/${PEPE}/pools`]: limited });
    await expect(gt.discoverWallets({ chain: 'ethereum', tokens: [{ address: PEPE }] }))
      .rejects.toMatchObject({ name: 'ProviderError', code: 'RATE_LIMITED', retryAfterMs: 30_000, provider: 'geckoterminal' });

    const routes = pepeRoutes();
    routes[`/networks/${NET}/pools/${POOL_B}/trades`] = limited;
    const { gt: gt2 } = setup(routes);
    await expect(gt2.discoverWallets({ chain: 'ethereum', tokens: [{ address: PEPE }] })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('EDGE-SM-GTK-002 kegagalan sumber data: 404/bentuk rusak per token dicatat lalu lanjut; 5xx & pembatalan dilempar', async () => {
    const OTHER = fakeEvmAddress('gt-other-token');
    const OTHER_POOL = fakeEvmAddress('gt-other-pool');
    const buyer = fakeEvmAddress('gt-other-buyer');
    const routes = {
      // PEPE: tidak ada rute → 404 (token tidak dikenal GeckoTerminal)
      [`/networks/${NET}/tokens/${OTHER}/pools`]: gtList([
        gtPool({ network: NET, address: OTHER_POOL, base: OTHER, quote: WETH }),
        gtPool({ network: NET, address: POOL_C, base: OTHER, quote: WETH }),
      ]),
      [`/networks/${NET}/pools/${OTHER_POOL}/trades`]: gtList([
        gtTrade({ network: NET, kind: 'buy', fromToken: WETH, toToken: OTHER, txHash: fakeTxHash('o1'), from: buyer, volumeUsd: 1500, at: NOW - HOUR }),
      ]),
      [`/networks/${NET}/pools/${POOL_C}/trades`]: { data: 'bukan-array' },
    };
    const { gt } = setup(routes);
    const result = await gt.discoverWallets({ chain: 'ethereum', tokens: [{ address: PEPE }, { address: OTHER }, { address: OTHER }] });
    expect(result.map((c) => c.address)).toEqual([buyer]);
    expect(result.diagnostics.errors).toEqual([
      { token: PEPE, code: 'BAD_RESPONSE', message: expect.stringContaining('HTTP 404') },
      { token: OTHER, pool: POOL_C, code: 'BAD_RESPONSE', message: expect.stringContaining('array data') },
    ]);
    expect(result.diagnostics.tokensProcessed).toBe(1);

    const { gt: down } = setup({ [`/networks/${NET}/tokens/${PEPE}/pools`]: jsonResponse(503, 'Service Unavailable') });
    await expect(down.discoverWallets({ chain: 'ethereum', tokens: [{ address: PEPE }] })).rejects.toMatchObject({ code: 'UNAVAILABLE' });

    const ac = new AbortController();
    ac.abort();
    const { gt: cancelled, calls } = setup(pepeRoutes());
    await expect(cancelled.discoverWallets({ chain: 'ethereum', tokens: [{ address: PEPE }], signal: ac.signal })).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(calls).toHaveLength(0);
  });

  it('NEG-SM-GTK-002 tanpa token → [] + diagnostik, tanpa panggilan jaringan (tidak memindai trending); token quote/tidak valid dilewati', async () => {
    const { gt, calls } = setup(pepeRoutes());
    const none = await gt.discoverWallets({ chain: 'ethereum', since: NOW - HOUR, limit: 10 });
    expect(none).toEqual([]);
    expect(none.diagnostics.notes[0]).toContain('tidak dipakai untuk memindai pool trending');
    expect(await gt.discoverWallets({ chain: 'ethereum', tokens: [] })).toEqual([]);
    const skipped = await gt.discoverWallets({
      chain: 'ethereum',
      tokens: [{ address: WETH, symbol: 'WETH' }, { address: 'bukan-alamat' }, { chain: 'base', address: PEPE }, null],
    });
    expect(skipped).toEqual([]);
    expect(skipped.diagnostics.invalidTokens.map((t) => t.reason)).toEqual([
      expect.stringContaining('aset quote'), 'alamat token tidak valid', expect.stringContaining('chain base'), 'alamat token tidak valid',
    ]);
    expect(calls).toHaveLength(0);
    await expect(gt.discoverWallets({ chain: 'dogechain', tokens: [{ address: PEPE }] })).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
  });
});

describe('GeckoTerminal — harga token', () => {
  it('UNIT-SM-GTK-006 harga dibatch ≤ 30 alamat per panggilan; alamat dinormalisasi; harga tak terbaca dilewati (tidak jadi 0)', async () => {
    const addrs = Array.from({ length: 65 }, (_, i) => fakeEvmAddress(`gt-price-${i}`));
    const bad = { [addrs[1]]: 'abc', [addrs[2]]: null, [addrs[3]]: '0', [addrs[4]]: '-1', [addrs[5]]: '' };
    const { gt, calls } = setup((path) => {
      if (!path.startsWith('/simple/networks/eth/token_price/')) return undefined;
      const prices = {};
      for (const a of decodeURIComponent(path.split('/').pop()).split(',')) {
        if (a === addrs[64]) continue; // tidak dikenal GeckoTerminal → diabaikan
        prices[a === addrs[0] ? upperHex(a) : a] = Object.hasOwn(bad, a) ? bad[a] : '0.00001234';
      }
      return gtPrices(prices);
    });
    const input = [...addrs.map((a, i) => (i % 2 ? upperHex(a) : a)), addrs[0], 'bukan-alamat'];
    const result = await gt.fetchPrices({ chain: 'ethereum', addresses: input });

    const sizes = calls.map((c) => decodeURIComponent(c.url.pathname.split('/').pop()).split(',').length);
    expect(sizes).toEqual([PRICE_BATCH_SIZE, PRICE_BATCH_SIZE, 5]);
    expect(calls[0].url.pathname).toMatch(/^\/api\/v2\/simple\/networks\/eth\/token_price\/0x[0-9a-f]{40},0x[0-9a-f]{40},/);
    expect(calls.map((c) => c.at - NOW)).toEqual([0, 10_000, 20_000]);
    expect(result).toHaveLength(65 - 1 - 5);
    expect(result[0]).toEqual({ chain: 'ethereum', address: addrs[0], priceUsd: 0.00001234, at: NOW, source: 'geckoterminal' });
    expect(result.every((p) => p.priceUsd > 0 && p.address === p.address.toLowerCase())).toBe(true);
    expect(result.diagnostics).toMatchObject({ requested: 65, batches: 3, prices: 59, invalidAddresses: ['bukan-alamat'], missing: [addrs[64]] });
    expect(result.diagnostics.unparsable).toEqual(addrs.slice(1, 6));
  });

  it('UNIT-SM-GTK-007 harga Solana: kunci mint apa adanya; kosong → tanpa panggilan; respons rusak dicatat; 429 dilempar', async () => {
    const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    const { gt, calls } = setup({ [`/simple/networks/solana/token_price/${BONK}`]: gtPrices({ [BONK]: '0.0000213' }) });
    expect(await gt.fetchPrices({ chain: 'solana', addresses: [BONK] })).toEqual([
      { chain: 'solana', address: BONK, priceUsd: 0.0000213, at: NOW, source: 'geckoterminal' },
    ]);
    expect(await gt.fetchPrices({ chain: 'solana', addresses: [] })).toEqual([]);
    expect(calls).toHaveLength(1);

    const { gt: broken } = setup({ [`/simple/networks/solana/token_price/${BONK}`]: { data: [] } });
    const empty = await broken.fetchPrices({ chain: 'solana', addresses: [BONK] });
    expect(empty).toEqual([]);
    expect(empty.diagnostics.errors[0]).toMatchObject({ batch: 0, code: 'BAD_RESPONSE' });

    const { gt: limited } = setup({ [`/simple/networks/solana/token_price/${BONK}`]: jsonResponse(429, '', { 'retry-after': '60' }) });
    await expect(limited.fetchPrices({ chain: 'solana', addresses: [BONK] })).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 60_000 });
  });
});

describe('GeckoTerminal — kontrak adapter', () => {
  it('UNIT-SM-GTK-008 validateAdapter lolos; keyless, bukan simulasi, atribusi wajib, metode lain NOT_SUPPORTED', async () => {
    const gt = createGeckoTerminalProvider({ fetchImpl: async () => jsonResponse(500, '') });
    expect(validateAdapter(gt)).toEqual([]);
    expect(gt).toMatchObject({ id: 'geckoterminal', requiresKey: false, isSimulated: false });
    expect([...gt.capabilities].sort()).toEqual(['prices', 'walletDiscovery']);
    expect(gt.terms).toMatchObject({ attribution: 'Powered by CoinGecko / GeckoTerminal', displayAllowed: true });
    expect(gt.terms.attribution).toBe(GECKOTERMINAL_ATTRIBUTION);
    expect(gt.terms.notes).toMatch(/tanpa kunci.*bukan untuk produksi atau polling berat/s);
    expect([...gt.chains].sort()).toEqual(['arbitrum', 'base', 'bsc', 'ethereum', 'optimism', 'polygon', 'solana']);
    expect(GECKOTERMINAL_NETWORKS).toMatchObject({ ethereum: 'eth', polygon: 'polygon_pos', bsc: 'bsc', solana: 'solana' });
    for (const m of ['fetchWalletTransfers', 'fetchLabels', 'fetchBinanceMapping']) {
      await expect(gt[m]({})).rejects.toMatchObject({ code: 'NOT_SUPPORTED', provider: 'geckoterminal' });
    }
    expect(ADAPTER_METHODS.every((m) => typeof gt[m] === 'function')).toBe(true);
    const reg = createProviderRegistry({ adapters: [gt], enabledIds: ['geckoterminal'] });
    expect(reg.withCapability('walletDiscovery', 'solana')).toEqual([gt]);
    expect(() => createGeckoTerminalProvider({ baseUrl: 'http://api.geckoterminal.com/api/v2' })).toThrow(TypeError);
    expect(() => createGeckoTerminalProvider({ maxPoolsPerToken: 0 })).toThrow(RangeError);
    expect(() => createGeckoTerminalProvider({ minTradeUsd: -1 })).toThrow(RangeError);
  });
});
