import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BinanceDataError } from '../../../backend/ingestion/binance/errors.js';
import {
  computeSpreadBps, parseBookTickers, parseDecimal, parseExchangeInfo, parseKlineRow, parseKlines,
  parseServerTime, parseTickers24h,
} from '../../../backend/ingestion/binance/parse.js';

// Fixture sintetis — bukan data pasar nyata (lihat field _catatan di tiap file).
const fixture = (name) => JSON.parse(readFileSync(new URL(`../../fixtures/binance/${name}`, import.meta.url), 'utf8'));

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0); // 1767225600000, sejajar 5m & 1h
const FIVE_MIN = 5 * 60_000;
const ctx5m = (now = T0 + 3 * FIVE_MIN) => ({ symbol: 'BTCUSDT', timeframe: '5m', now });
const row = (overrides = {}) => {
  const base = [T0, '100.0', '110.0', '95.0', '105.0', '10.5', T0 + FIVE_MIN - 1, '1050.25', 42, '4.2', '420.1', '0'];
  for (const [i, v] of Object.entries(overrides)) base[Number(i)] = v;
  return base;
};

/** Jalankan fn dan kembalikan error yang dilempar (gagal bila tidak melempar). */
function catchError(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('fungsi tidak melempar error');
}

describe('parse kline Binance', () => {
  it('UNIT-BNP-001 baris kline fixture → Candle kanonik (angka string → number, source rest)', () => {
    const { body } = fixture('klines-btcusdt-5m.json');
    const candles = parseKlines(body, ctx5m());
    expect(candles).toHaveLength(3);
    expect(candles[0]).toEqual({
      symbol: 'BTCUSDT', timeframe: '5m', openTime: 1767225600000, closeTime: 1767225899999,
      open: 94000.1, high: 94120, low: 93950.5, close: 94080.2, volume: 152.345, quoteVolume: 14325678.12345,
      trades: 2310, takerBuyVolume: 80.12, takerBuyQuoteVolume: 7534567.89, isClosed: true, source: 'rest',
    });
    for (const c of candles) expect(c.closeTime).toBe(c.openTime + FIVE_MIN - 1);
  });

  it('EDGE-BNP-001 isClosed = closeTime < now: tepat di closeTime masih terbuka, +1 ms tertutup', () => {
    const r = row();
    const closeTime = T0 + FIVE_MIN - 1;
    expect(parseKlineRow(r, ctx5m(closeTime)).isClosed).toBe(false);
    expect(parseKlineRow(r, ctx5m(closeTime + 1)).isClosed).toBe(true);
    expect(parseKlineRow(r, ctx5m(T0)).isClosed).toBe(false);
  });

  it('EDGE-BNP-002 presisi string kecil "0.00001234" dan volume besar dipertahankan; candle volume nol valid', () => {
    const { body } = fixture('klines-tinyusdt-1h.json');
    const [a, b] = parseKlines(body, { symbol: 'TINYUSDT', timeframe: '1h', now: T0 + 2 * 3_600_000 });
    expect(a.close).toBe(0.00001234);
    expect(a.low).toBe(0.00001225);
    expect(a.volume).toBe(987654321098);
    expect(b).toMatchObject({ volume: 0, trades: 0, quoteVolume: 0, open: 0.00001234, isClosed: true });
  });

  it('NEG-BNP-001 panjang array salah / bukan array → BinanceDataError terstruktur', () => {
    const err = catchError(() => parseKlines([row(), row().slice(0, 11), 'x'], ctx5m()));
    expect(err).toBeInstanceOf(BinanceDataError);
    expect(err.retryable).toBe(false);
    expect(err.issues).toEqual([
      expect.objectContaining({ index: 1, field: 'row' }),
      expect.objectContaining({ index: 2, field: 'row' }),
    ]);
    expect(() => parseKlines({ rows: [] }, ctx5m())).toThrow(BinanceDataError);
    expect(() => parseKlineRow([...row(), 'extra'], ctx5m())).toThrow(BinanceDataError);
  });

  it('NEG-BNP-002 angka tidak valid ditolak, tidak diam-diam menjadi 0/NaN', () => {
    for (const bad of ['', ' 1', 'abc', '1e5', 'NaN', 'Infinity', '-1', '0x10', '1.', '.5', null, Number.NaN, Number.POSITIVE_INFINITY]) {
      const err = catchError(() => parseKlineRow(row({ 4: bad }), ctx5m()));
      expect(err).toBeInstanceOf(BinanceDataError);
      expect(err.issues).toContainEqual(expect.objectContaining({ index: 0, field: 'close' }));
    }
    const zeroPrice = catchError(() => parseKlineRow(row({ 1: '0', 3: '0' }), ctx5m()));
    expect(zeroPrice.issues.map((i) => i.field)).toEqual(expect.arrayContaining(['open', 'low']));
  });

  it('NEG-BNP-003 OHLC tidak konsisten (high<low, high<close, low>open) ditolak', () => {
    expect(catchError(() => parseKlineRow(row({ 2: '90.0' }), ctx5m())).issues.map((i) => i.field)).toContain('high');
    expect(catchError(() => parseKlineRow(row({ 2: '104.0' }), ctx5m())).issues.map((i) => i.field)).toContain('high');
    expect(catchError(() => parseKlineRow(row({ 3: '101.0' }), ctx5m())).issues.map((i) => i.field)).toContain('low');
  });

  it('NEG-BNP-004 closeTime ≠ openTime + interval − 1 atau openTime tidak sejajar ditolak', () => {
    const wrongClose = catchError(() => parseKlineRow(row({ 6: T0 + FIVE_MIN }), ctx5m()));
    expect(wrongClose.issues).toContainEqual(expect.objectContaining({ field: 'closeTime' }));
    const misaligned = catchError(() => parseKlineRow(row({ 0: T0 + 1000, 6: T0 + 1000 + FIVE_MIN - 1 }), ctx5m()));
    expect(misaligned.issues).toContainEqual(expect.objectContaining({ field: 'openTime' }));
    const stringTime = catchError(() => parseKlineRow(row({ 0: String(T0) }), ctx5m()));
    expect(stringTime.issues).toContainEqual(expect.objectContaining({ field: 'openTime' }));
  });

  it('NEG-BNP-005 trades bukan bilangan bulat dan taker buy > volume ditolak', () => {
    expect(catchError(() => parseKlineRow(row({ 8: 1.5 }), ctx5m())).issues).toContainEqual(expect.objectContaining({ field: 'trades' }));
    expect(catchError(() => parseKlineRow(row({ 8: '42' }), ctx5m())).issues).toContainEqual(expect.objectContaining({ field: 'trades' }));
    expect(catchError(() => parseKlineRow(row({ 9: '10.6' }), ctx5m())).issues).toContainEqual(expect.objectContaining({ field: 'takerBuyVolume' }));
    expect(catchError(() => parseKlineRow(row({ 10: '1050.26' }), ctx5m())).issues).toContainEqual(expect.objectContaining({ field: 'takerBuyQuoteVolume' }));
  });

  it('NEG-BNP-006 urutan openTime tidak naik / duplikat dalam satu respons ditolak', () => {
    const second = row({ 0: T0 + FIVE_MIN, 6: T0 + 2 * FIVE_MIN - 1 });
    const err = catchError(() => parseKlines([second, row()], ctx5m()));
    expect(err.issues).toContainEqual(expect.objectContaining({ index: 1, field: 'openTime' }));
    expect(() => parseKlines([row(), row()], ctx5m())).toThrow(BinanceDataError);
  });

  it('UNIT-BNP-002 semua masalah dikumpulkan per baris; respons kosong → array kosong', () => {
    const err = catchError(() => parseKlines([row({ 2: '1' }), row({ 0: T0 + FIVE_MIN, 6: T0 + 2 * FIVE_MIN - 1, 5: 'x' })], ctx5m()));
    expect(err.issues.map((i) => i.index)).toEqual(expect.arrayContaining([0, 1]));
    expect(err.message).toMatch(/kline/i);
    expect(parseKlines([], ctx5m())).toEqual([]);
  });

  it('NEG-BNP-007 konteks parse tidak valid (timeframe tak dikenal, now bukan angka, simbol kosong) → TypeError', () => {
    expect(() => parseKlines([], { symbol: 'BTCUSDT', timeframe: '4h', now: T0 })).toThrow(TypeError);
    expect(() => parseKlines([], { symbol: 'BTCUSDT', timeframe: '5m', now: Number.NaN })).toThrow(TypeError);
    expect(() => parseKlines([], { symbol: '', timeframe: '5m', now: T0 })).toThrow(TypeError);
  });
});

describe('parse exchangeInfo / ticker Binance', () => {
  it('UNIT-BNP-003 exchangeInfo → SymbolInfo: tickSize dari PRICE_FILTER, stepSize dari LOT_SIZE (string)', () => {
    const infos = parseExchangeInfo(fixture('exchangeInfo.json').body);
    expect(infos).toHaveLength(11);
    const btc = infos.find((s) => s.symbol === 'BTCUSDT');
    expect(btc).toEqual({
      symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING',
      tickSize: '0.10', stepSize: '0.001', onboardDate: 1569398400000,
    });
    const pepe = infos.find((s) => s.symbol === '1000PEPEUSDT');
    expect(pepe).toMatchObject({ baseAsset: '1000PEPE', tickSize: '0.0000001', stepSize: '1' });
    expect(infos.find((s) => s.symbol === 'TINYUSDT').tickSize).toBe('0.00000001');
  });

  it('EDGE-BNP-003 status delisting (SETTLING/BREAK) dipertahankan; filter hilang → tickSize/stepSize null', () => {
    const body = fixture('exchangeInfo.json').body;
    const infos = parseExchangeInfo(body);
    expect(infos.find((s) => s.symbol === 'OLDUSDT').status).toBe('SETTLING');
    expect(infos.find((s) => s.symbol === 'HALTUSDT').status).toBe('BREAK');
    const bare = parseExchangeInfo({ symbols: [{ symbol: 'NEWUSDT', baseAsset: 'NEW', quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'PENDING_TRADING' }] });
    expect(bare[0]).toMatchObject({ tickSize: null, stepSize: null, onboardDate: null });
  });

  it('NEG-BNP-008 exchangeInfo rusak (tanpa symbols, field wajib hilang, tickSize tidak valid) ditolak', () => {
    expect(() => parseExchangeInfo({})).toThrow(BinanceDataError);
    expect(() => parseExchangeInfo(null)).toThrow(BinanceDataError);
    const err = catchError(() => parseExchangeInfo({ symbols: [
      { symbol: 'AUSDT', baseAsset: 'A', quoteAsset: 'USDT', contractType: 'PERPETUAL' },
      { symbol: 'BUSDT', baseAsset: 'B', quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING',
        filters: [{ filterType: 'PRICE_FILTER', tickSize: '-0.1' }, { filterType: 'LOT_SIZE', stepSize: '0' }] },
    ] }));
    expect(err.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ index: 0, field: 'status' }),
      expect.objectContaining({ index: 1, field: 'tickSize' }),
      expect.objectContaining({ index: 1, field: 'stepSize' }),
    ]));
  });

  it('UNIT-BNP-004 ticker 24 jam → angka; priceChangePercent boleh negatif', () => {
    const tickers = parseTickers24h(fixture('ticker24hr.json').body);
    expect(tickers).toHaveLength(10);
    expect(tickers.find((t) => t.symbol === 'ETHUSDT')).toEqual({
      symbol: 'ETHUSDT', lastPrice: 3300, priceChangePercent: -1.064, volume: 2416615.789, quoteVolume: 8000000000, closeTime: 1767225599999,
    });
    expect(tickers.find((t) => t.symbol === 'TINYUSDT').lastPrice).toBe(0.00001234);
  });

  it('NEG-BNP-009 ticker 24 jam rusak (volume negatif, closeTime string, bukan array) ditolak', () => {
    const good = { symbol: 'XUSDT', lastPrice: '1', priceChangePercent: '0', volume: '1', quoteVolume: '1', closeTime: 1 };
    expect(() => parseTickers24h({ data: [] })).toThrow(BinanceDataError);
    const err = catchError(() => parseTickers24h([good, { ...good, volume: '-1' }, { ...good, closeTime: '1' }, { ...good, symbol: 5 }]));
    expect(err.issues).toEqual([
      expect.objectContaining({ index: 1, field: 'volume' }),
      expect.objectContaining({ index: 2, field: 'closeTime' }),
      expect.objectContaining({ index: 3, field: 'symbol' }),
    ]);
  });

  it('UNIT-BNP-005 book ticker → spreadBps = (ask − bid) / mid × 10000', () => {
    const books = parseBookTickers(fixture('bookTicker.json').body);
    const btc = books.find((b) => b.symbol === 'BTCUSDT');
    expect(btc).toMatchObject({ bidPrice: 94000, askPrice: 94000.1 });
    expect(btc.spreadBps).toBeCloseTo((0.1 / 94000.05) * 10_000, 9);
    expect(books.find((b) => b.symbol === 'TINYUSDT').spreadBps).toBeCloseTo((0.00000001 / 0.000012345) * 10_000, 6);
    expect(books.find((b) => b.symbol === 'WIDEUSDT').spreadBps).toBeCloseTo((0.005 / 1.0025) * 10_000, 6);
    expect(computeSpreadBps(100, 100)).toBe(0);
  });

  it('EDGE-BNP-004 kuotasi kosong (bid/ask 0) atau tersilang → spreadBps null', () => {
    const books = parseBookTickers(fixture('bookTicker.json').body);
    expect(books.find((b) => b.symbol === 'OLDUSDT').spreadBps).toBeNull();
    expect(computeSpreadBps(0, 1)).toBeNull();
    expect(computeSpreadBps(1, 0)).toBeNull();
    expect(computeSpreadBps(101, 100)).toBeNull();
    expect(() => parseBookTickers([{ symbol: 'XUSDT', bidPrice: 'x', askPrice: '1' }])).toThrow(BinanceDataError);
  });

  it('UNIT-BNP-006 parseDecimal & parseServerTime', () => {
    expect(parseDecimal('0.00001234')).toBe(0.00001234);
    expect(parseDecimal('-1.5')).toBeNull();
    expect(parseDecimal('-1.5', { signed: true })).toBe(-1.5);
    expect(parseDecimal(2.5)).toBe(2.5);
    expect(parseDecimal('')).toBeNull();
    expect(parseServerTime({ serverTime: 1767225610000 })).toBe(1767225610000);
    expect(() => parseServerTime({ serverTime: '1767225610000' })).toThrow(BinanceDataError);
    expect(() => parseServerTime({})).toThrow(BinanceDataError);
  });
});
