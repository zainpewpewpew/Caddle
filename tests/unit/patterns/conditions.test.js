import { describe, expect, it } from 'vitest';
import {
  ZERO_VOLUME_STREAK,
  analyzeStructure,
  buildConditions,
  computeEarlyScore,
  computeFeatures,
  computeInvalidation,
  computePatternScore,
  inspectCandles,
  mean,
  median,
  orderRiskFlags,
} from '../../../backend/patterns/conditions.js';
import { silentAccumulationCandles } from '../../fixtures/candles/scenarios.js';
import { withProvisionalLast, withZeroVolume, withoutCandle } from '../../fixtures/candles/synthetic.js';

// Candle minimal dari daftar low (fixture sintetis — bukan data pasar nyata).
const fromLows = (lows) => lows.map((low, i) => ({
  symbol: 'SYNUSDT', timeframe: '5m', openTime: i * 300_000, closeTime: i * 300_000 + 299_999,
  open: low + 0.5, high: low + 1, low, close: low + 0.5, volume: 100, quoteVolume: 1000, isClosed: true,
}));

describe('helper kondisi pola', () => {
  it('UNIT-PCND-001 mean & median menolak nilai null/non-hingga', () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(mean([])).toBeNull();
    expect(mean([1, null])).toBeNull();
    expect(median([1, Number.NaN])).toBeNull();
  });

  it('UNIT-PCND-002 kondisi deklaratif: pembanding gt/gte/lte, nilai null selalu gagal', () => {
    const defs = [
      { id: 'a', label: 'A', weight: 10, comparator: 'gt' },
      { id: 'b', label: 'B', weight: 20, comparator: 'gte' },
      { id: 'c', label: 'C', weight: 30, comparator: 'lte' },
      { id: 'd', label: 'D', weight: 40, comparator: 'lte' },
    ];
    const conds = buildConditions(defs, { a: 0, b: 1, c: 0.9, d: null }, { a: 0, b: 1, c: 0.9, d: 1 });
    expect(conds.map((c) => c.passed)).toEqual([false, true, true, false]);
    expect(conds[3]).toEqual({ id: 'd', label: 'D', passed: false, value: null, threshold: 1, weight: 40 });
    expect(buildConditions(defs, { a: Number.NaN }, { a: 0 })[0].value).toBeNull();
  });

  it('UNIT-PCND-003 patternScore = Σ bobot lulus / Σ bobot × 100; total bobot 0 → 0', () => {
    const c = (passed, weight) => ({ passed, weight });
    expect(computePatternScore([c(true, 20), c(false, 30), c(true, 50)])).toBe(70);
    expect(computePatternScore([c(true, 1), c(false, 2)])).toBe(33.3);
    expect(computePatternScore([c(true, 0)])).toBe(0);
    expect(computePatternScore([])).toBe(0);
  });

  it('UNIT-PCND-004 earlyScore mengikuti formula 100 × (0,6 × jarak + 0,4 × usia)', () => {
    const structure = { fromSwing: true, higherLows: 1, anchorPrice: 100, startIndex: 70 };
    // kenaikan 2 ATR → jarak 0,5; usia 15 candle → 0,75 → 100 × (0,30 + 0,30) = 60
    expect(computeEarlyScore(structure, { atr: 1, close: 102, last: 85 })).toBe(60);
    expect(computeEarlyScore({ ...structure, startIndex: 85 }, { atr: 1, close: 100, last: 85 })).toBe(100);
    expect(computeEarlyScore(structure, { atr: 1, close: 110, last: 200 })).toBe(0);
    // harga di bawah anchor tidak memberi skor jarak > 1
    expect(computeEarlyScore({ ...structure, startIndex: 85 }, { atr: 1, close: 99, last: 85 })).toBe(100);
  });

  it('EDGE-PCND-001 earlyScore 0 tanpa struktur bullish atau ATR nol', () => {
    const structure = { fromSwing: true, higherLows: 1, anchorPrice: 100, startIndex: 80 };
    expect(computeEarlyScore({ ...structure, fromSwing: false }, { atr: 1, close: 101, last: 85 })).toBe(0);
    expect(computeEarlyScore({ ...structure, higherLows: 0 }, { atr: 1, close: 101, last: 85 })).toBe(0);
    expect(computeEarlyScore(structure, { atr: 0, close: 101, last: 85 })).toBe(0);
    expect(computeEarlyScore(structure, { atr: null, close: 101, last: 85 })).toBe(0);
  });

  it('UNIT-PCND-005 harga invalidasi = anchor − buffer × ATR; null bila tidak di antara 0 dan close', () => {
    const structure = { anchorPrice: 100 };
    expect(computeInvalidation(structure, { atr: 2, close: 103 }, 0.25)).toBe(99.5);
    expect(computeInvalidation(structure, { atr: 0, close: 103 }, 0.25)).toBe(100);
    expect(computeInvalidation(structure, { atr: 2, close: 99 }, 0.25)).toBeNull();
    expect(computeInvalidation({ anchorPrice: 0.1 }, { atr: 1, close: 5 }, 0.25)).toBeNull();
  });

  it('POS-PCND-001 struktur higher-low: swing baru dipakai hanya setelah terkonfirmasi (anti lookahead)', () => {
    // swing low di indeks 2 (8) dan 6 (8,5); konfirmasi masing-masing di indeks 4 dan 8.
    const candles = fromLows([10, 9, 8, 9, 10, 9.5, 8.5, 9.5, 10.5, 11]);
    const before = analyzeStructure(candles.slice(0, 8), computeFeatures(candles.slice(0, 8)), 20);
    expect(before).toMatchObject({ fromSwing: true, anchorIndex: 2, anchorPrice: 8, higherLows: 0 });
    const after = analyzeStructure(candles.slice(0, 9), computeFeatures(candles.slice(0, 9)), 20);
    expect(after).toMatchObject({ fromSwing: true, anchorIndex: 6, anchorPrice: 8.5, higherLows: 1, startIndex: 2 });
  });

  it('EDGE-PCND-002 struktur patah (close di bawah swing low) atau swing di luar jendela → anchor = low terendah jendela', () => {
    const broken = fromLows([10, 9, 8, 9, 10, 9.5, 8.5, 9.5, 10.5, 7]);
    const s = analyzeStructure(broken, computeFeatures(broken), 20);
    expect(s).toMatchObject({ fromSwing: false, higherLows: 0, anchorIndex: 9, anchorPrice: 7 });
    const old = fromLows([10, 9, 8, 9, 10, 10.5, 11, 11.5, 12, 12.5]);
    expect(analyzeStructure(old, computeFeatures(old), 5)).toMatchObject({ fromSwing: false, anchorIndex: 5 });
  });

  it('UNIT-PCND-006 inspeksi data valid tidak menghasilkan masalah', () => {
    expect(inspectCandles(silentAccumulationCandles(1), 63)).toEqual({ fatal: [], issues: [] });
    expect(inspectCandles([], 63)).toEqual({ fatal: [], issues: [] });
  });

  it('NEG-PCND-001 candle tidak valid, belum tertutup, tidak urut, campuran seri → fatal', () => {
    const base = silentAccumulationCandles(1);
    const replace = (i, patch) => base.map((c, j) => (j === i ? { ...c, ...patch } : c));
    expect(inspectCandles(withProvisionalLast(base), 63).fatal).toEqual(['NOT_CLOSED']);
    expect(inspectCandles(replace(5, { close: Number.NaN }), 63).fatal).toEqual(['INVALID_CANDLE']);
    expect(inspectCandles(replace(5, { high: 1, low: 2 }), 63).fatal).toEqual(['INVALID_CANDLE']);
    expect(inspectCandles(replace(5, { volume: -1 }), 63).fatal).toEqual(['INVALID_CANDLE']);
    expect(inspectCandles(base.map((c, j) => (j === 5 ? null : c)), 63).fatal).toEqual(['INVALID_CANDLE']);
    expect(inspectCandles(replace(5, { openTime: base[4].openTime }), 63).fatal).toContain('UNSORTED');
    expect(inspectCandles(replace(5, { symbol: 'LAINUSDT' }), 63).fatal).toEqual(['MIXED_SERIES']);
    expect(inspectCandles(base.map((c) => ({ ...c, timeframe: '2m' })), 63).fatal).toEqual(['UNKNOWN_TIMEFRAME']);
  });

  it('NEG-PCND-002 gap waktu & volume nol beruntun di jendela evaluasi → issue (bukan fatal)', () => {
    const base = silentAccumulationCandles(1);
    expect(inspectCandles(withoutCandle(base, -10), 63)).toEqual({ fatal: [], issues: ['TIME_GAP'] });
    expect(inspectCandles(withZeroVolume(base, -10, ZERO_VOLUME_STREAK), 63).issues).toEqual(['ZERO_VOLUME_STREAK']);
  });

  it('EDGE-PCND-003 volume nol < ambang beruntun dan gap di luar jendela evaluasi tidak dianggap masalah', () => {
    const base = silentAccumulationCandles(1);
    expect(inspectCandles(withZeroVolume(base, -10, ZERO_VOLUME_STREAK - 1), 63).issues).toEqual([]);
    expect(inspectCandles(withoutCandle(base, 3), 63).issues).toEqual([]);
  });

  it('UNIT-PCND-007 risk flag terurut sesuai RISK_FLAGS', () => {
    expect(orderRiskFlags(new Set(['DATA_QUALITY', 'POOR_LIQUIDITY', 'EXTENDED_PRICE']))).toEqual(['POOR_LIQUIDITY', 'EXTENDED_PRICE', 'DATA_QUALITY']);
  });
});
