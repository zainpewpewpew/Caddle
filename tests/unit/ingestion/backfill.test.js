import { describe, expect, it } from 'vitest';
import { MAX_KLINES_PER_REQUEST, lastClosedOpenTime, planBackfill, planGapFill } from '../../../backend/ingestion/backfill.js';
import { TIMEFRAME_MS } from '../../../backend/market/contracts.js';

const M5 = TIMEFRAME_MS['5m'];
const H1 = TIMEFRAME_MS['1h'];
// Batas interval 5m/15m/1h: 2026-01-01T00:00:00Z.
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

/** Jumlah candle yang dicakup seluruh potongan, plus cek kontinuitas antarpotongan. */
function coverage(plan, ms) {
  let total = 0;
  for (let i = 0; i < plan.length; i += 1) {
    const p = plan[i];
    expect(p.limit).toBeGreaterThan(0);
    expect(p.limit).toBeLessThanOrEqual(MAX_KLINES_PER_REQUEST);
    expect(p.startTime % ms).toBe(0);
    expect(p.endTime).toBe(p.startTime + p.limit * ms - 1);
    if (i > 0) expect(p.startTime).toBe(plan[i - 1].endTime + 1);
    total += p.limit;
  }
  return total;
}

describe('lastClosedOpenTime', () => {
  it('UNIT-BKF-001 tepat di batas interval → candle sebelumnya adalah yang terakhir tertutup', () => {
    expect(lastClosedOpenTime(T0, '5m')).toBe(T0 - M5);
    expect(lastClosedOpenTime(T0 + 1, '5m')).toBe(T0 - M5);
    expect(lastClosedOpenTime(T0 - 1, '5m')).toBe(T0 - 2 * M5);
  });
});

describe('planBackfill', () => {
  it('UNIT-BKF-002 tanpa lastOpenTime → bootstrap maxCandles terakhir yang tertutup', () => {
    const now = T0 + 2 * M5 + 17_000; // candle T0+2*M5 masih berjalan
    const plan = planBackfill({ lastOpenTime: null, now, timeframe: '5m', maxCandles: 500 });
    expect(plan).toHaveLength(1);
    expect(plan[0]).toEqual({ startTime: T0 + 2 * M5 - 500 * M5, endTime: T0 + 2 * M5 - 1, limit: 500 });
  });

  it('UNIT-BKF-003 setelah lastOpenTime sampai candle tertutup terakhir', () => {
    const plan = planBackfill({ lastOpenTime: T0, now: T0 + 4 * M5 + 5, timeframe: '5m', maxCandles: 500 });
    expect(plan).toEqual([{ startTime: T0 + M5, endTime: T0 + 4 * M5 - 1, limit: 3 }]);
  });

  it('EDGE-BKF-001 sudah up-to-date → []', () => {
    // candle terakhir tersimpan = candle tertutup terakhir
    expect(planBackfill({ lastOpenTime: T0, now: T0 + M5 + 1, timeframe: '5m', maxCandles: 500 })).toEqual([]);
    // lastOpenTime menunjuk candle yang masih berjalan (mis. jam sistem tertinggal) → tetap []
    expect(planBackfill({ lastOpenTime: T0 + M5, now: T0 + M5 + 1, timeframe: '5m', maxCandles: 500 })).toEqual([]);
  });

  it('UNIT-BKF-004 rentang besar dipecah ≤1500 candle per request, berurutan tanpa celah', () => {
    const lastOpenTime = T0;
    const now = T0 + 4000 * M5 + 30_000;
    const plan = planBackfill({ lastOpenTime, now, timeframe: '5m' });
    expect(plan.map((p) => p.limit)).toEqual([1500, 1500, 999]);
    expect(plan[0].startTime).toBe(T0 + M5);
    expect(plan.at(-1).endTime).toBe(T0 + 4000 * M5 - 1);
    expect(coverage(plan, M5)).toBe(3999);
  });

  it('EDGE-BKF-002 bootstrap tepat 1500 → satu request; 1501 → dua request', () => {
    const now = T0 + 10_000 * H1 + 1;
    expect(planBackfill({ lastOpenTime: null, now, timeframe: '1h', maxCandles: 1500 })).toHaveLength(1);
    const two = planBackfill({ lastOpenTime: null, now, timeframe: '1h', maxCandles: 1501 });
    expect(two.map((p) => p.limit)).toEqual([1500, 1]);
    expect(coverage(two, H1)).toBe(1501);
  });

  it('EDGE-BKF-003 maxCandles membatasi gap sangat panjang → ambil candle paling baru', () => {
    const now = T0 + 10_000 * M5 + 1;
    const plan = planBackfill({ lastOpenTime: T0, now, timeframe: '5m', maxCandles: 600 });
    expect(coverage(plan, M5)).toBe(600);
    expect(plan.at(-1).endTime).toBe(T0 + 10_000 * M5 - 1);
  });

  it('UNIT-BKF-005 chunkSize kustom dihormati namun tidak boleh melebihi 1500', () => {
    const plan = planBackfill({ lastOpenTime: T0, now: T0 + 11 * M5, timeframe: '5m', chunkSize: 4 });
    expect(plan.map((p) => p.limit)).toEqual([4, 4, 2]);
    expect(() => planBackfill({ lastOpenTime: T0, now: T0 + 11 * M5, timeframe: '5m', chunkSize: 1501 })).toThrow(RangeError);
  });

  it('NEG-BKF-001 argumen tidak valid ditolak', () => {
    expect(() => planBackfill({ lastOpenTime: null, now: T0, timeframe: '4h', maxCandles: 10 })).toThrow(RangeError);
    expect(() => planBackfill({ lastOpenTime: null, now: Number.NaN, timeframe: '5m', maxCandles: 10 })).toThrow(TypeError);
    expect(() => planBackfill({ lastOpenTime: null, now: T0, timeframe: '5m' })).toThrow(RangeError);
    expect(() => planBackfill({ lastOpenTime: null, now: T0, timeframe: '5m', maxCandles: 0 })).toThrow(RangeError);
    expect(() => planBackfill({ lastOpenTime: T0 + 7, now: T0 + M5 * 3, timeframe: '5m', maxCandles: 10 })).toThrow(RangeError);
    expect(() => planBackfill({ lastOpenTime: '1', now: T0, timeframe: '5m', maxCandles: 10 })).toThrow(TypeError);
  });
});

describe('planGapFill', () => {
  it('UNIT-BKF-006 gap dari findGaps (openTime inklusif) menjadi request ≤1500', () => {
    const gaps = [
      { from: T0 + 2 * M5, to: T0 + 4 * M5 },
      { from: T0 + 100 * M5, to: T0 + 100 * M5 },
    ];
    const plan = planGapFill({ gaps, timeframe: '5m' });
    expect(plan).toEqual([
      { startTime: T0 + 2 * M5, endTime: T0 + 5 * M5 - 1, limit: 3 },
      { startTime: T0 + 100 * M5, endTime: T0 + 101 * M5 - 1, limit: 1 },
    ]);
  });

  it('UNIT-BKF-007 gap berdekatan digabung bila muat dalam satu request', () => {
    const gaps = [
      { from: T0 + 10 * M5, to: T0 + 10 * M5 },
      { from: T0 + 2 * M5, to: T0 + 3 * M5 }, // tidak berurutan → diurutkan
      { from: T0 + 12 * M5, to: T0 + 12 * M5 },
    ];
    const plan = planGapFill({ gaps, timeframe: '5m', mergeWithin: 20 });
    expect(plan).toEqual([{ startTime: T0 + 2 * M5, endTime: T0 + 13 * M5 - 1, limit: 11 }]);
  });

  it('EDGE-BKF-004 gap panjang dipecah; gap melewati candle tertutup terakhir dipotong', () => {
    const plan = planGapFill({ gaps: [{ from: T0, to: T0 + 3199 * H1 }], timeframe: '1h' });
    expect(plan.map((p) => p.limit)).toEqual([1500, 1500, 200]);
    expect(coverage(plan, H1)).toBe(3200);

    const clipped = planGapFill({ gaps: [{ from: T0, to: T0 + 10 * H1 }], timeframe: '1h', now: T0 + 5 * H1 + 1 });
    expect(clipped).toEqual([{ startTime: T0, endTime: T0 + 5 * H1 - 1, limit: 5 }]);
    expect(planGapFill({ gaps: [{ from: T0 + 9 * H1, to: T0 + 10 * H1 }], timeframe: '1h', now: T0 + 5 * H1 })).toEqual([]);
    expect(planGapFill({ gaps: [], timeframe: '1h' })).toEqual([]);
  });

  it('NEG-BKF-002 gap rusak ditolak', () => {
    expect(() => planGapFill({ gaps: [{ from: T0 + M5, to: T0 }], timeframe: '5m' })).toThrow(RangeError);
    expect(() => planGapFill({ gaps: [{ from: T0 + 1, to: T0 + M5 }], timeframe: '5m' })).toThrow(RangeError);
    expect(() => planGapFill({ gaps: 'x', timeframe: '5m' })).toThrow(TypeError);
  });
});
