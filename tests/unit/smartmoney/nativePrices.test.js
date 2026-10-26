import { describe, expect, it } from 'vitest';
import { NATIVE_TOKEN } from '../../../backend/smartmoney/contracts.js';
import {
  HOURLY_ESTIMATE_SUFFIX, NATIVE_PRICE_SYMBOLS, createNativePriceResolver, enrichNativeUsd, isNativeOrWrappedNative,
} from '../../../backend/smartmoney/nativePrices.js';
import { createBinanceRestClient } from '../../../backend/ingestion/binance/restClient.js';

// Tanpa jaringan: getKlines palsu berbentuk keluaran restClient.getKlines (Candle kanonik), atau klien REST asli
// dengan fetch palsu berbentuk respons /fapi/v1/klines.
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
const BATCH_MS = 480 * HOUR;
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WPOL = '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270';
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const POLYGON_WETH = '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619'; // ETH bridged di Polygon — bukan wrapped native POL
const PEPE = `0x${'4'.repeat(40)}`;

/** Harga unik per jam agar terlihat candle mana yang dipakai. */
const priceOfHour = (open) => 3000 + (open - Date.UTC(2026, 9, 1)) / HOUR;

function clockAt(start = NOW) {
  let now = start;
  return { clock: () => now, advance: (ms) => { now += ms; } };
}

function candle(symbol, open, close, now) {
  const closeTime = open + HOUR - 1;
  return {
    symbol, timeframe: '1h', openTime: open, closeTime, open: close, high: close, low: close, close,
    volume: 1, quoteVolume: close, trades: 1, takerBuyVolume: 0, takerBuyQuoteVolume: 0, isClosed: closeTime < now, source: 'rest',
  };
}

/** getKlines palsu: candle per jam di [startTime, endTime] yang sudah dibuka sebelum `now`. */
function fakeKlines({ time = clockAt(), close = priceOfHour, skip = new Set(), fail = null } = {}) {
  const calls = [];
  async function getKlines(q) {
    calls.push(q);
    if (fail) throw fail(q);
    const out = [];
    for (let open = q.startTime; open <= q.endTime && open < time.clock(); open += HOUR) {
      if (!skip.has(open)) out.push(candle(q.symbol, open, close(open, q.symbol), time.clock()));
    }
    return out.slice(0, q.limit);
  }
  return { getKlines, calls };
}

describe('nativePrices — resolver harga per jam', () => {
  it('UNIT-SM-NPX-001 harga = close candle 1 jam terakhir yang tutup SEBELUM t; query getKlines kompatibel restClient', async () => {
    const k = fakeKlines();
    const r = createNativePriceResolver({ getKlines: k.getKlines });
    const t = Date.UTC(2026, 9, 20, 10, 15);
    const prevOpen = Date.UTC(2026, 9, 20, 9);
    expect(await r.priceAt('ethereum', t)).toEqual({ priceUsd: priceOfHour(prevOpen), at: prevOpen + HOUR - 1, source: 'binance:ETHUSDT:1h' });
    // Tepat di batas jam: candle 09:00 (tutup 09:59:59.999) tetap yang terakhir tutup sebelum t.
    expect((await r.priceAt('ethereum', Date.UTC(2026, 9, 20, 10))).at).toBe(prevOpen + HOUR - 1);
    const [q] = k.calls;
    expect(q).toEqual({ symbol: 'ETHUSDT', timeframe: '1h', interval: '1h', startTime: q.startTime, endTime: q.startTime + BATCH_MS - 1, limit: 480 });
    expect(q.startTime % BATCH_MS).toBe(0);
    expect(q.startTime <= prevOpen && prevOpen <= q.endTime).toBe(true);
    for (const [chain, symbol] of [['base', 'ETHUSDT'], ['arbitrum', 'ETHUSDT'], ['optimism', 'ETHUSDT'], ['bsc', 'BNBUSDT'], ['polygon', 'POLUSDT'], ['solana', 'SOLUSDT']]) {
      expect((await r.priceAt(chain, t)).source).toBe(`binance:${symbol}:1h`);
    }
    expect(NATIVE_PRICE_SYMBOLS).toEqual({
      ethereum: 'ETHUSDT', base: 'ETHUSDT', arbitrum: 'ETHUSDT', optimism: 'ETHUSDT', bsc: 'BNBUSDT', polygon: 'POLUSDT', solana: 'SOLUSDT',
    });
  });

  it('UNIT-SM-NPX-002 tanpa look-ahead: at < t untuk setiap t; mengubah candle yang tutup ≥ t tidak mengubah harga di t', async () => {
    const base = Date.UTC(2026, 9, 20, 6);
    const ts = Array.from({ length: 40 }, (_, i) => base + i * 7 * 60_000 + (i % 3) * 999);
    const honest = createNativePriceResolver({ getKlines: fakeKlines().getKlines });
    for (const t of ts) {
      const p = await honest.priceAt('ethereum', t);
      expect(p.at).toBeLessThan(t);
      expect(p.priceUsd).toBe(priceOfHour(Math.floor(t / HOUR) * HOUR - HOUR));
      // Data "masa depan" relatif t (candle yang memuat t dan sesudahnya) dirusak → hasil identik.
      const leaky = createNativePriceResolver({
        getKlines: fakeKlines({ close: (open) => (open + HOUR - 1 >= t ? 1_000_000 : priceOfHour(open)) }).getKlines,
      });
      expect(await leaky.priceAt('ethereum', t)).toEqual(p);
    }
  });

  it('UNIT-SM-NPX-003 cache per batch: jam lain di batch sama & panggilan serentak berbagi satu permintaan; kedaluwarsa sesuai cacheMs', async () => {
    const time = clockAt();
    const k = fakeKlines({ time });
    const r = createNativePriceResolver({ getKlines: k.getKlines, clock: time.clock, cacheMs: 6 * HOUR });
    const t = Date.UTC(2026, 7, 20, 10, 30); // batch lama 15 Agu – 3 Sep (seluruh jamnya sudah lewat)
    await Promise.all([0, 1, 2, 3, 4].map((i) => r.priceAt('ethereum', t + i * HOUR)));
    expect(k.calls).toHaveLength(1);
    await r.priceAt('base', t + 30 * HOUR); // simbol & batch sama
    expect(k.calls).toHaveLength(1);
    time.advance(6 * HOUR - 1);
    await r.priceAt('ethereum', t);
    expect(k.calls).toHaveLength(1);
    time.advance(1);
    await r.priceAt('ethereum', t);
    expect(k.calls).toHaveLength(2);
    // Batch yang masih berjalan (memuat "sekarang") hanya di-cache 5 menit: jam baru ikut terambil.
    const recent = NOW + 6 * HOUR - 20 * 60_000;
    await r.priceAt('ethereum', recent);
    expect(k.calls).toHaveLength(3);
    time.advance(2 * HOUR);
    const later = time.clock() - 60_000;
    expect((await r.priceAt('ethereum', later)).at).toBe(Math.floor(later / HOUR) * HOUR - 1);
    expect(k.calls).toHaveLength(4);
  });

  it('NEG-SM-NPX-001 chain tanpa simbol → null tanpa permintaan; "Invalid symbol" (POLUSDT) → null + ditolak lokal + errors()', async () => {
    const time = clockAt();
    const invalid = Object.assign(new Error('Binance /fapi/v1/klines gagal: HTTP 400 — Invalid symbol.'), { code: -1121, status: 400 });
    const k = fakeKlines({ time, fail: () => invalid });
    const getKlines = async (q) => (q.symbol === 'POLUSDT' ? k.getKlines(q) : fakeKlines({ time }).getKlines(q));
    const r = createNativePriceResolver({ getKlines, clock: time.clock });
    expect(await r.priceAt('dogechain', NOW - HOUR)).toBeNull();
    expect(await r.priceAt('ethereum', Number.NaN)).toBeNull();
    expect(k.calls).toHaveLength(0);
    expect(await r.priceAt('polygon', NOW - HOUR)).toBeNull();
    expect(await r.priceAt('polygon', NOW - 60 * 24 * HOUR)).toBeNull(); // batch lain: tetap tanpa permintaan baru
    expect(k.calls).toHaveLength(1);
    expect(r.errors()).toEqual([{ symbol: 'POLUSDT', code: '-1121', message: invalid.message, at: NOW, invalidSymbol: true }]);
    expect(await r.priceAt('ethereum', NOW - HOUR)).not.toBeNull();
    const custom = createNativePriceResolver({ getKlines: k.getKlines, symbolsByChain: { ethereum: 'ETHUSDT', polygon: 'pol-usdt' } });
    expect(await custom.priceAt('polygon', NOW - HOUR)).toBeNull();
    expect(await custom.priceAt('bsc', NOW - HOUR)).toBeNull();
    expect(k.calls).toHaveLength(1);
  });

  it('NEG-SM-NPX-002 kegagalan sementara (geo-block 451 / timeout) → null, di-cache 5 menit, lalu dicoba lagi', async () => {
    const time = clockAt();
    let down = true;
    const calls = [];
    const r = createNativePriceResolver({
      clock: time.clock,
      getKlines: async (q) => {
        calls.push(q);
        if (down) throw Object.assign(new Error('Binance /fapi/v1/klines gagal: HTTP 451'), { status: 451, code: 'HTTP_ERROR' });
        return fakeKlines({ time }).getKlines(q);
      },
    });
    const t = NOW - 3 * HOUR;
    expect(await r.priceAt('ethereum', t)).toBeNull();
    expect(await r.priceAt('ethereum', t)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(r.errors()[0]).toMatchObject({ symbol: 'ETHUSDT', code: 'HTTP_ERROR', invalidSymbol: false });
    down = false;
    time.advance(5 * 60_000);
    expect((await r.priceAt('ethereum', t)).source).toBe('binance:ETHUSDT:1h');
    expect(calls).toHaveLength(2);
    expect(r.errors()).toEqual([]);
  });

  it('EDGE-SM-NPX-001 jeda data: candle sebelumnya hilang/belum tutup → candle lebih tua ≤ maxStaleMs; lebih tua → null', async () => {
    const t = Date.UTC(2026, 9, 20, 10, 15);
    const h9 = Date.UTC(2026, 9, 20, 9);
    const h8 = Date.UTC(2026, 9, 20, 8);
    const gap = createNativePriceResolver({ getKlines: fakeKlines({ skip: new Set([h9]) }).getKlines });
    expect(await gap.priceAt('ethereum', t)).toMatchObject({ priceUsd: priceOfHour(h8), at: h8 + HOUR - 1 });
    const strict = createNativePriceResolver({ getKlines: fakeKlines({ skip: new Set([h9]) }).getKlines, maxStaleMs: HOUR + 15 * 60_000 });
    expect(await strict.priceAt('ethereum', t)).toBeNull();
    const hole = createNativePriceResolver({ getKlines: fakeKlines({ skip: new Set([h9, h8]) }).getKlines });
    expect(await hole.priceAt('ethereum', t)).toBeNull();
    const unclosed = createNativePriceResolver({
      getKlines: async (q) => (await fakeKlines().getKlines(q)).map((c) => (c.openTime === h9 ? { ...c, isClosed: false } : c)),
    });
    expect((await unclosed.priceAt('ethereum', t)).at).toBe(h8 + HOUR - 1);
    expect(() => createNativePriceResolver({})).toThrow(TypeError);
    expect(() => createNativePriceResolver({ getKlines: async () => [], maxStaleMs: 1000 })).toThrow(RangeError);
  });

  it('UNIT-SM-NPX-004 restClient.getKlines asli dapat diteruskan langsung; Binance -1121 "Invalid symbol" → null', async () => {
    const requests = [];
    const fetch = async (href) => {
      const u = new URL(href);
      requests.push(u);
      if (u.searchParams.get('symbol') === 'POLUSDT') {
        return new Response(JSON.stringify({ code: -1121, msg: 'Invalid symbol.' }), { status: 400 });
      }
      const rows = [];
      for (let open = Number(u.searchParams.get('startTime')); open <= Number(u.searchParams.get('endTime')) && open < NOW; open += HOUR) {
        const p = priceOfHour(open).toFixed(2);
        rows.push([open, p, p, p, p, '10.0', open + HOUR - 1, '30000.0', 5, '4.0', '12000.0', '0']);
      }
      return new Response(JSON.stringify(rows.slice(0, Number(u.searchParams.get('limit')))), { status: 200 });
    };
    const rest = createBinanceRestClient({ fetch, clock: () => NOW, sleep: async () => {}, random: () => 0.5 });
    const r = createNativePriceResolver({ getKlines: rest.getKlines, clock: () => NOW });
    const t = Date.UTC(2026, 9, 20, 10, 15);
    expect(await r.priceAt('ethereum', t)).toEqual({ priceUsd: priceOfHour(Date.UTC(2026, 9, 20, 9)), at: Date.UTC(2026, 9, 20, 9) + HOUR - 1, source: 'binance:ETHUSDT:1h' });
    expect(requests[0].pathname).toBe('/fapi/v1/klines');
    expect(Object.fromEntries(requests[0].searchParams)).toMatchObject({ symbol: 'ETHUSDT', interval: '1h', limit: '480' });
    expect(await r.priceAt('polygon', t)).toBeNull();
    expect(r.errors()).toEqual([expect.objectContaining({ symbol: 'POLUSDT', code: '-1121', invalidSymbol: true })]);
  });
});

describe('nativePrices — enrichNativeUsd', () => {
  const t = Date.UTC(2026, 9, 20, 10, 15);
  const price9 = priceOfHour(Date.UTC(2026, 9, 20, 9));
  const tr = (chain, address, amount, usdValue = null, extra = {}) => ({
    chain, txHash: `0x${'a'.repeat(64)}`, logIndex: 1, blockNumber: 1, blockTime: t, from: PEPE, to: PEPE,
    token: { address, symbol: 'X', name: null, decimals: 18 }, amount, usdValue, priceSource: usdValue === null ? null : 'provider-x',
    provider: 'etherscan', isSimulated: false, txMeta: {}, ...extra,
  });

  it('UNIT-SM-NPX-005 mengisi native & wrapped-native yang null; token lain & nilai provider tidak disentuh; masukan tidak berubah', async () => {
    const r = createNativePriceResolver({ getKlines: fakeKlines().getKlines });
    const input = [
      tr('ethereum', NATIVE_TOKEN, 0.5),
      tr('ethereum', WETH, 2),
      tr('ethereum', PEPE, 1000),
      tr('ethereum', USDC, 50),
      tr('ethereum', NATIVE_TOKEN, 1, 1234),
      tr('ethereum', NATIVE_TOKEN, 1, 0),
      tr('ethereum', NATIVE_TOKEN, 3, Number.NaN),
      tr('polygon', POLYGON_WETH, 1),
      tr('polygon', WPOL, 10),
      tr('bsc', WBNB, 4),
    ];
    const snapshot = structuredClone(input);
    const out = await enrichNativeUsd(input, r);
    expect(input).toEqual(snapshot);
    expect(out).not.toBe(input);
    expect(out).toHaveLength(input.length);
    expect(out[0]).toMatchObject({ usdValue: 0.5 * price9, priceSource: `binance:ETHUSDT:1h${HOURLY_ESTIMATE_SUFFIX}` });
    expect(out[0].priceSource).toBe('binance:ETHUSDT:1h (perkiraan per jam)');
    expect(out[1].usdValue).toBe(2 * price9);
    for (const i of [2, 3, 4, 5, 7]) expect(out[i]).toBe(input[i]);
    expect(out[4].usdValue).toBe(1234);
    expect(out[5].usdValue).toBe(0);
    expect(out[6].usdValue).toBe(3 * price9);
    expect(out[8]).toMatchObject({ usdValue: 10 * price9, priceSource: 'binance:POLUSDT:1h (perkiraan per jam)' });
    expect(out[9].priceSource).toBe('binance:BNBUSDT:1h (perkiraan per jam)');
  });

  it('NEG-SM-NPX-003 harga tidak diketahui / resolver gagal / tanpa resolver → usdValue tetap null (tidak pernah 0)', async () => {
    const input = [tr('ethereum', NATIVE_TOKEN, 0.5), tr('base', '0x4200000000000000000000000000000000000006', 1)];
    for (const resolver of [
      null,
      { priceAt: async () => null },
      { priceAt: async () => { throw new Error('jaringan'); } },
      { priceAt: async () => ({ priceUsd: 0, at: 1, source: 'x' }) },
      { priceAt: async () => ({ priceUsd: 3000, at: 1, source: '' }) },
      createNativePriceResolver({ getKlines: async () => { throw new Error('HTTP 451'); } }),
    ]) {
      const out = await enrichNativeUsd(input, resolver);
      expect(out.map((x) => x.usdValue)).toEqual([null, null]);
      expect(out[0]).toBe(input[0]);
    }
    expect(await enrichNativeUsd(null, null)).toEqual([]);
  });

  it('UNIT-SM-NPX-006 isNativeOrWrappedNative: native & W* dari QUOTE_ASSETS per chain, alamat dinormalisasi', () => {
    expect(isNativeOrWrappedNative('ethereum', NATIVE_TOKEN)).toBe(true);
    expect(isNativeOrWrappedNative('ethereum', WETH.toUpperCase().replace('0X', '0x'))).toBe(true);
    expect(isNativeOrWrappedNative('ethereum', USDC)).toBe(false);
    expect(isNativeOrWrappedNative('arbitrum', '0x82af49447d8a07e3bd95bd0d56f35241523fbab1')).toBe(true);
    expect(isNativeOrWrappedNative('polygon', WPOL)).toBe(true);
    expect(isNativeOrWrappedNative('polygon', POLYGON_WETH)).toBe(false);
    expect(isNativeOrWrappedNative('solana', 'So11111111111111111111111111111111111111112')).toBe(true);
    expect(isNativeOrWrappedNative('ethereum', WPOL)).toBe(false);
    expect(isNativeOrWrappedNative('dogechain', NATIVE_TOKEN)).toBe(false);
    expect(isNativeOrWrappedNative('ethereum', 'bukan')).toBe(false);
  });
});
