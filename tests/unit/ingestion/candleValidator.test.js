import { describe, expect, it } from 'vitest';
import {
  assessFreshness, floorToInterval, normalizeBatch, validateCandle,
} from '../../../backend/ingestion/candleValidator.js';
import { TIMEFRAMES, TIMEFRAME_MS } from '../../../backend/market/contracts.js';

// Fixture sintetis — bukan data pasar nyata. Format mengikuti Candle kanonik (contracts.js).
const T0 = Date.UTC(2026, 0, 1); // tengah malam UTC: sejajar batas 5m/15m/1h
const NOW = T0 + 10 * TIMEFRAME_MS['1h'];

function candle(overrides = {}) {
  const timeframe = overrides.timeframe ?? '5m';
  const openTime = overrides.openTime ?? T0;
  return {
    symbol: 'BTCUSDT', timeframe, openTime, closeTime: openTime + TIMEFRAME_MS[timeframe] - 1,
    open: 100, high: 105, low: 99, close: 104, volume: 12.5, quoteVolume: 1290.5, trades: 42,
    takerBuyVolume: 6.25, takerBuyQuoteVolume: 645.25, isClosed: true, source: 'rest',
    ...overrides,
  };
}

const check = (c, now = NOW) => validateCandle(c, { now });

describe('validasi candle', () => {
  it('UNIT-CVL-001 candle tertutup yang valid diterima', () => {
    expect(check(candle())).toEqual({ ok: true, errors: [] });
  });

  it('UNIT-CVL-002 volume nol (tanpa transaksi) tetap valid', () => {
    const c = candle({ open: 5, high: 5, low: 5, close: 5, volume: 0, quoteVolume: 0, trades: 0, takerBuyVolume: 0, takerBuyQuoteVolume: 0 });
    expect(check(c)).toEqual({ ok: true, errors: [] });
  });

  it('UNIT-CVL-003 presisi kecil (0.00001234) valid', () => {
    const c = candle({ open: 0.00001234, high: 0.00001299, low: 0.00001201, close: 0.00001250, volume: 98_765_432.1, quoteVolume: 1234.56789 });
    expect(check(c).ok).toBe(true);
  });

  it('UNIT-CVL-004 candle provisional (belum tertutup, interval sedang berjalan) valid', () => {
    const c = candle({ isClosed: false, source: 'ws' });
    expect(check(c, T0 + 60_000)).toEqual({ ok: true, errors: [] });
  });

  it.each(TIMEFRAMES)('UNIT-CVL-005 timeframe %s: closeTime = openTime + interval - 1', (timeframe) => {
    const c = candle({ timeframe, openTime: T0 + TIMEFRAME_MS[timeframe] });
    expect(c.closeTime).toBe(T0 + 2 * TIMEFRAME_MS[timeframe] - 1);
    expect(check(c).ok).toBe(true);
  });

  it('NEG-CVL-001 high < low ditolak', () => {
    const r = check(candle({ high: 98, low: 99 }));
    expect(r.ok).toBe(false);
    expect(r.errors.join('|')).toMatch(/high lebih kecil/);
  });

  it.each([
    ['high < open', { open: 106 }, /high lebih kecil/],
    ['high < close', { close: 106 }, /high lebih kecil/],
    ['low > open', { open: 98.5 }, /low lebih besar/],
    ['low > close', { close: 98.5 }, /low lebih besar/],
  ])('NEG-CVL-002 OHLC tidak konsisten ditolak: %s', (_label, overrides, pattern) => {
    const r = check(candle(overrides));
    expect(r.ok).toBe(false);
    expect(r.errors.join('|')).toMatch(pattern);
  });

  it.each([
    ['open NaN', { open: Number.NaN }],
    ['high Infinity', { high: Number.POSITIVE_INFINITY }],
    ['low nol', { low: 0 }],
    ['close negatif', { close: -1 }],
    ['open string', { open: '100' }],
    ['close hilang', { close: undefined }],
  ])('NEG-CVL-003 harga tidak valid ditolak: %s', (_label, overrides) => {
    const r = check(candle(overrides));
    expect(r.ok).toBe(false);
    expect(r.errors.join('|')).toMatch(/harus angka finite > 0/);
  });

  it.each([
    ['tidak sejajar 5m', { openTime: T0 + 1000 }],
    ['sejajar 5m tetapi bukan 1h', { timeframe: '1h', openTime: T0 + TIMEFRAME_MS['5m'] }],
  ])('NEG-CVL-004 open time tidak sejajar batas interval: %s', (_label, overrides) => {
    const r = check(candle(overrides));
    expect(r.ok).toBe(false);
    expect(r.errors.join('|')).toMatch(/tidak sejajar/);
  });

  it.each([
    ['openTime pecahan', { openTime: T0 + 0.5 }],
    ['openTime negatif', { openTime: -TIMEFRAME_MS['5m'] }],
    ['openTime string', { openTime: String(T0), closeTime: T0 + TIMEFRAME_MS['5m'] - 1 }],
  ])('NEG-CVL-005 openTime bukan bilangan bulat ms ≥ 0: %s', (_label, overrides) => {
    expect(check(candle(overrides)).errors.join('|')).toMatch(/openTime harus bilangan bulat/);
  });

  it.each([
    ['tanpa -1', { closeTime: T0 + TIMEFRAME_MS['5m'] }],
    ['interval timeframe lain', { closeTime: T0 + TIMEFRAME_MS['15m'] - 1 }],
    ['detik, bukan ms', { closeTime: Math.floor((T0 + TIMEFRAME_MS['5m'] - 1) / 1000) }],
  ])('NEG-CVL-006 closeTime salah ditolak: %s', (_label, overrides) => {
    const r = check(candle(overrides));
    expect(r.ok).toBe(false);
    expect(r.errors.join('|')).toMatch(/closeTime harus openTime \+ interval - 1/);
  });

  it.each(['1m', '4h', '1H', '', undefined])('NEG-CVL-007 timeframe tidak didukung ditolak: %s', (timeframe) => {
    const r = check({ ...candle(), timeframe });
    expect(r.ok).toBe(false);
    expect(r.errors.join('|')).toMatch(/timeframe tidak didukung/);
  });

  it.each(['btcusdt', 'BTC-USDT', 'BTCUSDT_250627', '', ' BTCUSDT', "BTC'; DROP TABLE candles;--", 'A'.repeat(33), 123, null])(
    'NEG-CVL-008 format simbol salah ditolak: %s', (symbol) => {
      const r = check(candle({ symbol }));
      expect(r.ok).toBe(false);
      expect(r.errors.join('|')).toMatch(/symbol tidak valid/);
    },
  );

  it.each([
    ['volume negatif', { volume: -0.1 }, /volume harus angka finite ≥ 0/],
    ['quoteVolume NaN', { quoteVolume: Number.NaN }, /quoteVolume harus angka finite ≥ 0/],
    ['takerBuyVolume negatif', { takerBuyVolume: -1 }, /takerBuyVolume harus angka finite ≥ 0/],
    ['takerBuyVolume > volume', { takerBuyVolume: 12.6 }, /takerBuyVolume melebihi volume/],
    ['takerBuyQuoteVolume > quoteVolume', { takerBuyQuoteVolume: 1300 }, /takerBuyQuoteVolume melebihi quoteVolume/],
    ['takerBuyQuoteVolume hilang', { takerBuyQuoteVolume: undefined }, /takerBuyQuoteVolume harus angka finite ≥ 0/],
  ])('NEG-CVL-009 volume tidak valid ditolak: %s', (_label, overrides, pattern) => {
    const r = check(candle(overrides));
    expect(r.ok).toBe(false);
    expect(r.errors.join('|')).toMatch(pattern);
  });

  it.each([1.5, -1, Number.NaN, '42'])('NEG-CVL-010 jumlah trade tidak valid ditolak: %s', (trades) => {
    expect(check(candle({ trades })).errors.join('|')).toMatch(/trades harus bilangan bulat ≥ 0/);
  });

  it('NEG-CVL-011 candle "tertutup" dari masa depan ditolak (now ≤ closeTime)', () => {
    const c = candle();
    const atClose = check(c, c.closeTime);
    expect(atClose.ok).toBe(false);
    expect(atClose.errors.join('|')).toMatch(/ditandai tertutup sebelum closeTime/);
    expect(check(c, T0 + 1).ok).toBe(false);
  });

  it('NEG-CVL-012 openTime di masa depan ditolak (juga untuk provisional)', () => {
    const c = candle({ openTime: NOW + TIMEFRAME_MS['5m'], isClosed: false });
    const r = check(c);
    expect(r.ok).toBe(false);
    expect(r.errors.join('|')).toMatch(/openTime di masa depan/);
  });

  it.each([null, undefined, 'candle', 42, []])('NEG-CVL-013 input bukan objek ditolak: %s', (input) => {
    expect(validateCandle(input, { now: NOW })).toEqual({ ok: false, errors: ['candle harus berupa objek'] });
  });

  it.each([
    ['isClosed string', { isClosed: 'true' }, /isClosed harus boolean/],
    ['isClosed hilang', { isClosed: undefined }, /isClosed harus boolean/],
    ['source tidak dikenal', { source: 'csv' }, /source harus rest atau ws/],
  ])('NEG-CVL-014 flag & sumber tidak valid ditolak: %s', (_label, overrides, pattern) => {
    expect(check(candle(overrides)).errors.join('|')).toMatch(pattern);
  });

  it.each([undefined, Number.NaN, '1767225600000'])('NEG-CVL-015 now tidak valid → TypeError: %s', (now) => {
    expect(() => validateCandle(candle(), { now })).toThrow(TypeError);
  });

  it('NEG-CVL-016 validateCandle tanpa opsi → TypeError', () => {
    expect(() => validateCandle(candle())).toThrow(TypeError);
  });

  it('EDGE-CVL-001 batas tertutup: now = closeTime + 1 diterima', () => {
    const c = candle();
    expect(check(c, c.closeTime + 1).ok).toBe(true);
  });

  it('EDGE-CVL-002 toleransi floating kecil pada taker buy ≤ volume', () => {
    expect(check(candle({ volume: 0.3, takerBuyVolume: 0.1 + 0.2 })).ok).toBe(true); // 0.30000000000000004
    expect(check(candle({ volume: 0, takerBuyVolume: 1e-6 })).ok).toBe(false);
  });

  it('EDGE-CVL-003 seluruh pelanggaran dikumpulkan, bukan hanya yang pertama', () => {
    const r = check(candle({ symbol: 'bad', high: 1, volume: -1, trades: 0.5 }));
    expect(r.errors.length).toBeGreaterThanOrEqual(4);
  });

  it('EDGE-CVL-004 candle datar (O=H=L=C) valid', () => {
    expect(check(candle({ open: 7, high: 7, low: 7, close: 7 })).ok).toBe(true);
  });

  it('EDGE-CVL-005 openTime 0 (epoch) sejajar & valid', () => {
    expect(check(candle({ openTime: 0 })).ok).toBe(true);
  });
});

describe('normalisasi batch', () => {
  const step = TIMEFRAME_MS['5m'];

  it('UNIT-CVL-006 batch acak diurutkan openTime naik', () => {
    const batch = [3, 0, 2, 1].map((i) => candle({ openTime: T0 + i * step }));
    expect(normalizeBatch(batch).map((c) => c.openTime)).toEqual([0, 1, 2, 3].map((i) => T0 + i * step));
  });

  it('UNIT-CVL-007 duplikat (symbol, timeframe, openTime) dibuang — versi terakhir menang', () => {
    const batch = [
      candle({ openTime: T0, close: 101 }),
      candle({ openTime: T0 + step }),
      candle({ openTime: T0, close: 103, source: 'ws' }),
    ];
    const out = normalizeBatch(batch);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ openTime: T0, close: 103, source: 'ws' });
  });

  it('UNIT-CVL-008 tidak memutasi input; batch kosong → []', () => {
    const batch = [candle({ openTime: T0 + step }), candle({ openTime: T0 })];
    const copy = structuredClone(batch);
    normalizeBatch(batch);
    expect(batch).toEqual(copy);
    expect(normalizeBatch([])).toEqual([]);
  });

  it('EDGE-CVL-006 openTime sama tetapi simbol/timeframe berbeda tidak dianggap duplikat; urutan deterministik', () => {
    const batch = [
      candle({ symbol: 'ETHUSDT' }),
      candle({ timeframe: '15m' }),
      candle({ symbol: 'BTCUSDT' }),
    ];
    const out = normalizeBatch(batch);
    expect(out.map((c) => `${c.symbol}:${c.timeframe}`)).toEqual(['BTCUSDT:15m', 'BTCUSDT:5m', 'ETHUSDT:5m']);
  });

  it.each([null, 'x', { length: 1 }])('NEG-CVL-017 input bukan array → TypeError: %s', (input) => {
    expect(() => normalizeBatch(input)).toThrow(TypeError);
  });

  it('NEG-CVL-018 elemen bukan objek → TypeError', () => {
    expect(() => normalizeBatch([candle(), null])).toThrow(TypeError);
  });
});

describe('waktu & kesegaran data', () => {
  const step = TIMEFRAME_MS['5m'];

  it('UNIT-CVL-009 floorToInterval membulatkan ke batas interval UTC', () => {
    expect(floorToInterval(T0 + step + 1234, '5m')).toBe(T0 + step);
    expect(floorToInterval(T0 + step, '5m')).toBe(T0 + step);
    expect(floorToInterval(T0 + 59 * 60_000, '1h')).toBe(T0);
    expect(() => floorToInterval(T0, '4h')).toThrow(TypeError);
    expect(() => floorToInterval(Number.NaN, '5m')).toThrow(TypeError);
  });

  it('UNIT-CVL-010 data segar: candle tertutup terakhir sudah tersimpan', () => {
    // now di tengah candle ke-3 → candle tertutup terakhir = openTime T0 + 1 step.
    const now = T0 + 2 * step + 30_000;
    expect(assessFreshness({ lastOpenTime: T0 + step, timeframe: '5m', now })).toEqual({
      expectedLastOpenTime: T0 + step, missingCandles: 0, lagMs: 30_000, stale: false,
    });
  });

  it('UNIT-CVL-011 data basi: tertinggal beberapa candle melewati masa tenggang', () => {
    const now = T0 + 5 * step + 10_000;
    const r = assessFreshness({ lastOpenTime: T0 + step, timeframe: '5m', now, graceMs: 5_000 });
    expect(r).toMatchObject({ expectedLastOpenTime: T0 + 4 * step, missingCandles: 3, stale: true });
    expect(r.lagMs).toBe(now - (T0 + 2 * step));
  });

  it('EDGE-CVL-007 candle baru saja tertutup masih dalam masa tenggang → belum basi', () => {
    const now = T0 + 2 * step + 2_000;
    const r = assessFreshness({ lastOpenTime: T0, timeframe: '5m', now, graceMs: 5_000 });
    expect(r).toMatchObject({ missingCandles: 1, stale: false });
  });

  it('EDGE-CVL-008 belum ada data → basi, lag tidak diketahui', () => {
    expect(assessFreshness({ lastOpenTime: null, timeframe: '1h', now: NOW })).toEqual({
      expectedLastOpenTime: NOW - TIMEFRAME_MS['1h'], missingCandles: null, lagMs: null, stale: true,
    });
  });

  it('NEG-CVL-019 argumen kesegaran tidak valid → TypeError', () => {
    expect(() => assessFreshness({ lastOpenTime: T0, timeframe: '2h', now: NOW })).toThrow(TypeError);
    expect(() => assessFreshness({ lastOpenTime: T0, timeframe: '5m', now: undefined })).toThrow(TypeError);
    expect(() => assessFreshness({ lastOpenTime: T0, timeframe: '5m', now: NOW, graceMs: -1 })).toThrow(TypeError);
  });
});
