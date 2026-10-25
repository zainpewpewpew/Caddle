import { describe, expect, it } from 'vitest';
import { TIMEFRAME_MS } from '../../../backend/market/contracts.js';
import { buildTimeframeContext, classifyTrend, closedAsOf, lastClosedCloseTime, resolveAlignment } from '../../../backend/timeframe/index.js';

// Data uji deterministik — sintetis, bukan data pasar nyata.
const M = 60_000;
const DAY = Date.UTC(2026, 0, 5);
const at = (hh, mm, ss = 0, ms = 0) => DAY + hh * 3_600_000 + mm * M + ss * 1000 + ms;

/** Deret candle dengan close mengikuti fungsi f(i), open = close sebelumnya. */
function series(timeframe, n, f, { end }) {
  const ms = TIMEFRAME_MS[timeframe];
  const start = end - n * ms; // openTime candle pertama; candle terakhir berakhir tepat sebelum `end`
  return Array.from({ length: n }, (_, i) => {
    const close = f(i);
    const open = i === 0 ? close : f(i - 1);
    return {
      symbol: 'ETHUSDT', timeframe, openTime: start + i * ms, closeTime: start + (i + 1) * ms - 1,
      open, high: Math.max(open, close) * 1.002, low: Math.min(open, close) * 0.998, close,
      volume: 10, quoteVolume: 10 * close, trades: 5, takerBuyVolume: 5, takerBuyQuoteVolume: 5 * close,
      isClosed: true, source: 'rest',
    };
  });
}
const up = (i) => 100 + 0.3 * i + 0.6 * Math.sin((2 * Math.PI * i) / 6);
const down = (i) => 300 - 0.3 * i + 0.6 * Math.sin((2 * Math.PI * i) / 6);
const flat = (i) => 100 + 0.6 * Math.sin((2 * Math.PI * i) / 6);

describe('resolveAlignment', () => {
  // Tabel keputusan (lihat backend/timeframe/alignment.js).
  it.each([
    [true, ['BULLISH', 'BULLISH'], 'ALIGNED'],
    [true, ['BULLISH', 'NEUTRAL'], 'PARTIALLY_CONFIRMED'],
    [true, ['NEUTRAL', 'BULLISH'], 'PARTIALLY_CONFIRMED'],
    [true, ['BULLISH', null], 'PARTIALLY_CONFIRMED'],
    [true, ['BULLISH', 'BEARISH'], 'COUNTERTREND'],
    [true, ['NEUTRAL', 'BEARISH'], 'COUNTERTREND'],
    [true, ['BEARISH', null], 'COUNTERTREND'],
    [true, ['NEUTRAL', 'NEUTRAL'], 'UNCONFIRMED'],
    [true, [null, null], 'UNCONFIRMED'],
    [true, ['NEUTRAL', null], 'UNCONFIRMED'],
    [true, [], 'UNCONFIRMED'],
    [false, ['BULLISH', 'BULLISH'], 'PARTIALLY_CONFIRMED'],
    [false, ['BULLISH', 'NEUTRAL'], 'PARTIALLY_CONFIRMED'],
    [false, ['NEUTRAL', 'BEARISH'], 'COUNTERTREND'],
    [false, [], 'UNCONFIRMED'],
  ])('UNIT-HTF-001 baseTrendOk=%s, HTF=%j → %s', (baseTrendOk, higherTrends, expected) => {
    expect(resolveAlignment({ baseTrendOk, higherTrends })).toBe(expected);
  });

  it('NEG-HTF-001 input alignment tidak valid ditolak', () => {
    expect(() => resolveAlignment({ baseTrendOk: 'ya', higherTrends: [] })).toThrow(TypeError);
    expect(() => resolveAlignment({ baseTrendOk: true, higherTrends: 'BULLISH' })).toThrow(TypeError);
    expect(() => resolveAlignment({ baseTrendOk: true, higherTrends: ['UP'] })).toThrow(RangeError);
    expect(() => resolveAlignment()).toThrow(TypeError);
  });
});

describe('closedAsOf', () => {
  const cs = series('15m', 4, up, { end: at(10, 15) }); // 09:15, 09:30, 09:45, 10:00
  it('EDGE-HTF-001 batas inklusif closeTime <= t', () => {
    expect(closedAsOf(cs, at(10, 14, 59, 999)).map((c) => c.openTime)).toEqual([at(9, 15), at(9, 30), at(9, 45), at(10, 0)]);
    expect(closedAsOf(cs, at(10, 14, 59, 998)).map((c) => c.openTime)).toEqual([at(9, 15), at(9, 30), at(9, 45)]);
    expect(closedAsOf(cs, at(9, 0))).toEqual([]);
  });

  it('NEG-HTF-002 candle provisional (isClosed false) tidak pernah dipakai walau closeTime <= t', () => {
    const provisional = { ...cs[3], isClosed: false };
    expect(closedAsOf([...cs.slice(0, 3), provisional], at(11, 0))).toHaveLength(3);
    expect(() => closedAsOf(cs, Number.NaN)).toThrow(TypeError);
    expect(() => closedAsOf('x', 0)).toThrow(TypeError);
  });

  it('UNIT-HTF-002 lastClosedCloseTime menghitung candle HTF terakhir yang sudah tertutup pada t', () => {
    expect(lastClosedCloseTime(at(10, 4, 59, 999), '15m')).toBe(at(9, 59, 59, 999));
    expect(lastClosedCloseTime(at(10, 14, 59, 999), '15m')).toBe(at(10, 14, 59, 999));
    expect(lastClosedCloseTime(at(10, 54, 59, 999), '1h')).toBe(at(9, 59, 59, 999));
  });
});

describe('buildTimeframeContext — tanpa lookahead', () => {
  // Candle 5m dasar 10:00–10:04:59.999 → evaluationTime = closeTime-nya.
  const t = at(10, 4, 59, 999);

  /**
   * 15m: 60 candle naik yang berakhir 10:00, LALU candle 10:00–10:14:59.999 (belum tutup pada t)
   * yang crash tajam. Bila candle itu bocor ke konteks, trend 15m tidak lagi BULLISH.
   */
  function dataset() {
    const m15 = series('15m', 60, up, { end: at(10, 0) });
    const lastClose = m15[m15.length - 1].close;
    const crash = { ...m15[m15.length - 1], openTime: at(10, 0), closeTime: at(10, 14, 59, 999), open: lastClose,
      high: lastClose, low: lastClose * 0.7, close: lastClose * 0.72 };
    const h1 = series('1h', 60, up, { end: at(10, 0) });
    const m5 = series('5m', 60, flat, { end: at(10, 5) });
    return { '5m': m5, '15m': [...m15, crash], '1h': h1 };
  }

  it('EDGE-HTF-002 candle 5m tutup 10:04:59.999 memakai 15m 09:45–09:59:59.999, bukan 10:00 yang belum tutup', () => {
    const data = dataset();
    const ctx = buildTimeframeContext({ baseTimeframe: '5m', evaluationTime: t, candlesByTimeframe: data });
    expect(ctx.trends['15m'].asOf).toBe(at(9, 59, 59, 999));
    expect(ctx.trends['15m'].trend).toBe('BULLISH');
    expect(ctx.trends['1h'].asOf).toBe(at(9, 59, 59, 999));
    expect(ctx.alignment).toBe('ALIGNED');
    // Kontrol: bila candle 10:00 (crash) ikut dipakai, trend 15m berubah → tes ini sensitif terhadap lookahead.
    expect(classifyTrend(data['15m']).trend).not.toBe('BULLISH');
  });

  it('EDGE-HTF-003 tepat saat 15m ikut tutup (10:14:59.999) candle 15m 10:00 boleh dipakai', () => {
    const data = dataset();
    const ctx = buildTimeframeContext({ baseTimeframe: '5m', evaluationTime: at(10, 14, 59, 999), candlesByTimeframe: data });
    expect(ctx.trends['15m'].asOf).toBe(at(10, 14, 59, 999));
    expect(ctx.trends['15m'].trend).not.toBe('BULLISH');
  });

  it('EDGE-HTF-004 menambah candle HTF masa depan tidak mengubah konteks', () => {
    const data = dataset();
    const before = buildTimeframeContext({ baseTimeframe: '5m', evaluationTime: t, candlesByTimeframe: data });
    const future15 = series('15m', 40, down, { end: at(20, 0) }).filter((c) => c.openTime > at(10, 0));
    const future1h = series('1h', 40, down, { end: at(23, 0) }).filter((c) => c.openTime >= at(10, 0));
    const future5 = series('5m', 40, down, { end: at(14, 0) }).filter((c) => c.openTime >= at(10, 5));
    const after = buildTimeframeContext({
      baseTimeframe: '5m', evaluationTime: t,
      candlesByTimeframe: { '5m': [...data['5m'], ...future5], '15m': [...data['15m'], ...future15], '1h': [...data['1h'], ...future1h] },
    });
    expect(after).toEqual(before);
  });

  it('POS-HTF-001 sinyal 5m tetap mendapat konteks walau 1h netral → PARTIALLY_CONFIRMED (tidak dibuang)', () => {
    const ctx = buildTimeframeContext({
      baseTimeframe: '5m', evaluationTime: t,
      candlesByTimeframe: { '5m': series('5m', 60, flat, { end: at(10, 5) }), '15m': series('15m', 60, up, { end: at(10, 0) }), '1h': series('1h', 60, flat, { end: at(10, 0) }) },
    });
    expect(ctx.trends['1h'].trend).toBe('NEUTRAL');
    expect(ctx.alignment).toBe('PARTIALLY_CONFIRMED');
  });

  it('UNIT-HTF-003 konflik timeframe: 5m netral/bullish, 15m bearish → COUNTERTREND', () => {
    const ctx = buildTimeframeContext({
      baseTimeframe: '5m', evaluationTime: t,
      candlesByTimeframe: { '5m': series('5m', 60, up, { end: at(10, 5) }), '15m': series('15m', 60, down, { end: at(10, 0) }), '1h': series('1h', 60, up, { end: at(10, 0) }) },
    });
    expect(ctx.trends['5m'].trend).toBe('BULLISH');
    expect(ctx.trends['15m'].trend).toBe('BEARISH');
    expect(ctx.alignment).toBe('COUNTERTREND');
  });

  it('UNIT-HTF-004 1h tidak punya HTF → UNCONFIRMED', () => {
    const ctx = buildTimeframeContext({
      baseTimeframe: '1h', evaluationTime: at(9, 59, 59, 999),
      candlesByTimeframe: { '1h': series('1h', 60, up, { end: at(10, 0) }) },
    });
    expect(ctx.alignment).toBe('UNCONFIRMED');
    expect(Object.keys(ctx.trends)).toEqual(['1h']);
  });

  it('EDGE-HTF-005 HTF tidak tersedia / data kurang → UNCONFIRMED dengan alasan', () => {
    const ctx = buildTimeframeContext({
      baseTimeframe: '15m', evaluationTime: at(9, 59, 59, 999),
      candlesByTimeframe: { '15m': series('15m', 60, up, { end: at(10, 0) }) },
    });
    expect(ctx.trends['1h']).toMatchObject({ trend: null, reasons: ['NO_DATA'], asOf: null, candleCount: 0 });
    expect(ctx.alignment).toBe('UNCONFIRMED');

    const short = buildTimeframeContext({
      baseTimeframe: '15m', evaluationTime: at(9, 59, 59, 999),
      candlesByTimeframe: { '15m': [], '1h': series('1h', 5, up, { end: at(10, 0) }) },
    });
    expect(short.trends['1h']).toMatchObject({ trend: 'NEUTRAL', reasons: ['INSUFFICIENT_DATA'] });
    expect(short.alignment).toBe('UNCONFIRMED');
  });

  it('EDGE-HTF-006 data HTF basi (candle terakhir tertinggal > maxStaleBars) dianggap tidak tersedia', () => {
    const h1 = series('1h', 60, up, { end: at(7, 0) }); // berhenti 06:59:59.999, padahal t = 09:59:59.999
    const ctx = buildTimeframeContext({
      baseTimeframe: '15m', evaluationTime: at(9, 59, 59, 999),
      candlesByTimeframe: { '15m': series('15m', 60, up, { end: at(10, 0) }), '1h': h1 },
    });
    expect(ctx.trends['1h']).toMatchObject({ trend: null, reasons: ['STALE_DATA'], asOf: at(6, 59, 59, 999) });
    expect(ctx.alignment).toBe('UNCONFIRMED');
    // Tertinggal tepat 1 bar (candle HTF yang baru tutup belum masuk) masih diterima.
    const lag1 = buildTimeframeContext({
      baseTimeframe: '15m', evaluationTime: at(9, 59, 59, 999),
      candlesByTimeframe: { '15m': series('15m', 60, up, { end: at(10, 0) }), '1h': series('1h', 60, up, { end: at(9, 0) }) },
    });
    expect(lag1.trends['1h'].trend).toBe('BULLISH');
  });

  it('UNIT-HTF-005 trend dasar BEARISH menurunkan ALIGNED menjadi PARTIALLY_CONFIRMED', () => {
    const ctx = buildTimeframeContext({
      baseTimeframe: '15m', evaluationTime: at(9, 59, 59, 999),
      candlesByTimeframe: { '15m': series('15m', 60, down, { end: at(10, 0) }), '1h': series('1h', 60, up, { end: at(10, 0) }) },
    });
    expect(ctx.trends['15m'].trend).toBe('BEARISH');
    expect(ctx.alignment).toBe('PARTIALLY_CONFIRMED');
  });

  it('NEG-HTF-003 argumen konteks tidak valid ditolak', () => {
    expect(() => buildTimeframeContext({ baseTimeframe: '4h', evaluationTime: t, candlesByTimeframe: {} })).toThrow(RangeError);
    expect(() => buildTimeframeContext({ baseTimeframe: '5m', evaluationTime: 'kemarin', candlesByTimeframe: {} })).toThrow(TypeError);
    expect(() => buildTimeframeContext({ baseTimeframe: '5m', evaluationTime: t, candlesByTimeframe: null })).toThrow(TypeError);
    const wrongTf = series('1h', 3, up, { end: at(10, 0) });
    expect(() => buildTimeframeContext({ baseTimeframe: '5m', evaluationTime: t, candlesByTimeframe: { '15m': wrongTf } })).toThrow(/timeframe/);
  });
});
