import { describe, expect, it } from 'vitest';
import { rsi as rsiFromIndex } from '../../../backend/indicators/index.js';
import { rsi } from '../../../backend/indicators/rsi.js';

describe('RSI Wilder', () => {
  it('UNIT-RR-RSI-001 nilai cocok dengan perhitungan manual (periode 3, seed rata-rata sederhana, lalu RMA)', () => {
    // Δ: +1, −0,5, +1,5, −0,5, +1,5
    const closes = [10, 11, 10.5, 12, 11.5, 13];
    const r = rsi(closes, 3);
    expect(r).toHaveLength(closes.length);
    expect(r.slice(0, 3)).toEqual([null, null, null]);
    // seed: avgGain = (1 + 0 + 1,5)/3, avgLoss = (0 + 0,5 + 0)/3 → RS 5 → 100 − 100/6
    expect(r[3]).toBeCloseTo(100 - 100 / 6, 10);
    // i=4 (Δ −0,5): avgGain = (0,8333·2)/3 = 0,5556; avgLoss = (0,1667·2 + 0,5)/3 = 0,2778 → RS 2
    expect(r[4]).toBeCloseTo(100 - 100 / 3, 10);
    // i=5 (Δ +1,5): avgGain = (0,5556·2 + 1,5)/3 = 0,8704; avgLoss = (0,2778·2)/3 = 0,1852 → RS 4,7
    expect(r[5]).toBeCloseTo(100 - 100 / 5.7, 10);
  });

  it('UNIT-RR-RSI-002 hanya naik → 100, hanya turun → 0, datar → 100 (konvensi TradingView), nilai 0..100', () => {
    expect(rsi([1, 2, 3, 4, 5, 6], 3).slice(3)).toEqual([100, 100, 100]);
    expect(rsi([6, 5, 4, 3, 2, 1], 3).slice(3)).toEqual([0, 0, 0]);
    expect(rsi([5, 5, 5, 5, 5], 3).slice(3)).toEqual([100, 100]);
    const mixed = rsi([3, 4, 2, 5, 1, 6, 2, 7, 3, 8, 4, 9, 5, 10, 6, 11], 14);
    expect(mixed[14]).toBeGreaterThan(0);
    expect(mixed[14]).toBeLessThan(100);
  });

  it('EDGE-RR-RSI-001 data ≤ periode → seluruhnya null; periode default 14', () => {
    expect(rsi([1, 2, 3], 3)).toEqual([null, null, null]);
    expect(rsi([], 3)).toEqual([]);
    const r = rsi(Array.from({ length: 16 }, (_, i) => 100 + Math.sin(i)));
    expect(r.slice(0, 14).every((v) => v === null)).toBe(true);
    expect(typeof r[14]).toBe('number');
  });

  it('NEG-RR-RSI-001 periode & nilai tidak valid ditolak (gaya ema.js)', () => {
    expect(() => rsi([1, 2, 3], 0)).toThrow(RangeError);
    expect(() => rsi([1, 2, 3], 1.5)).toThrow(RangeError);
    expect(() => rsi([1, Number.NaN, 3], 2)).toThrow(TypeError);
    expect(() => rsi([1, '2', 3], 2)).toThrow(TypeError);
    expect(() => rsi('abc', 2)).toThrow(TypeError);
  });

  it('UNIT-RR-RSI-003 diekspor dari backend/indicators/index.js dan kausal (prefiks tidak berubah)', () => {
    expect(rsiFromIndex).toBe(rsi);
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5 + (i % 7) * 0.3);
    const full = rsi(closes, 14);
    for (const k of [20, 33, 47]) expect(rsi(closes.slice(0, k + 1), 14)).toEqual(full.slice(0, k + 1));
  });
});
