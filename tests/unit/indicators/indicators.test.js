import { describe, expect, it } from 'vitest';
import { atr, atrPercent, confirmedAt, ema, findSwings, normalizedSlope, percentChange, rvol, sma, spikeDominance, trailingHigherLows, trueRange } from '../../../backend/indicators/index.js';

const candle = (high, low, close = (high + low) / 2) => ({ high, low, close, open: close });

describe('indikator', () => {
  it('UNIT-IND-001 SMA & EMA: warm-up null, seed SMA, rekursi alpha=2/(n+1)', () => {
    const v = [1, 2, 3, 4, 5, 6];
    expect(sma(v, 3)).toEqual([null, null, 2, 3, 4, 5]);
    const e = ema(v, 3);
    expect(e.slice(0, 2)).toEqual([null, null]);
    expect(e[2]).toBe(2);
    expect(e[3]).toBeCloseTo(3, 12);
    expect(e[5]).toBeCloseTo(5, 12);
    const e2 = ema([10, 10, 10, 20], 3);
    expect(e2[3]).toBeCloseTo(15, 12);
  });

  it('EDGE-IND-001 data lebih pendek dari periode → seluruhnya null', () => {
    expect(ema([1, 2], 7)).toEqual([null, null]);
    expect(atr([candle(2, 1)], 14)).toEqual([null]);
  });

  it('NEG-IND-001 periode & nilai tidak valid ditolak', () => {
    expect(() => ema([1, 2, 3], 0)).toThrow(RangeError);
    expect(() => ema([1, Number.NaN, 3], 2)).toThrow(TypeError);
    expect(() => sma([1, 2, 3], 1.5)).toThrow(RangeError);
  });

  it('UNIT-IND-002 true range memakai close sebelumnya untuk gap', () => {
    const tr = trueRange([candle(10, 9, 9.5), candle(12, 11, 11.5)]);
    expect(tr).toEqual([1, 2.5]);
  });

  it('UNIT-IND-003 ATR Wilder', () => {
    const cs = [candle(2, 1, 1.5), candle(2, 1, 1.5), candle(2, 1, 1.5), candle(4, 1, 2)];
    const a = atr(cs, 3);
    expect(a.slice(0, 2)).toEqual([null, null]);
    expect(a[2]).toBe(1);
    expect(a[3]).toBeCloseTo((1 * 2 + 3) / 3, 12);
    expect(atrPercent(cs, 3)[3]).toBeCloseTo(a[3] / 2, 12);
  });

  it('UNIT-IND-004 RVOL memakai baseline candle sebelumnya (tanpa candle saat ini)', () => {
    expect(rvol([10, 10, 10, 30], 3)).toEqual([null, null, null, 3]);
  });

  it('EDGE-IND-002 RVOL dengan baseline volume nol → null, bukan Infinity', () => {
    expect(rvol([0, 0, 0, 5], 3)[3]).toBeNull();
  });

  it('EDGE-IND-003 dominasi lonjakan tunggal', () => {
    expect(spikeDominance([1, 1, 1, 97], 4)).toBeCloseTo(0.97, 12);
    expect(spikeDominance([5, 5, 5, 5], 4)).toBe(0.25);
    expect(spikeDominance([0, 0, 0, 0], 4)).toBeNull();
  });

  it('UNIT-IND-005 swing terkonfirmasi dengan jeda `right` (anti lookahead)', () => {
    const lows = [5, 4, 3, 4, 5, 4, 3.5, 4, 5];
    const cs = lows.map((l) => candle(l + 1, l));
    const s = findSwings(cs, { left: 2, right: 2 });
    expect(s.lows.map((x) => x.index)).toEqual([2, 6]);
    expect(s.lows[0].confirmedIndex).toBe(4);
    expect(confirmedAt(s, 5).lows.map((x) => x.index)).toEqual([2]);
    expect(confirmedAt(s, 3).lows).toEqual([]);
    expect(trailingHigherLows(s.lows)).toBe(1);
  });

  it('EDGE-IND-004 harga datar tidak menghasilkan swing ganda', () => {
    const cs = Array.from({ length: 9 }, () => candle(10, 9));
    const s = findSwings(cs);
    expect(s.highs.length).toBeLessThanOrEqual(1);
    expect(s.lows.length).toBeLessThanOrEqual(1);
  });

  it('UNIT-IND-006 slope ternormalisasi', () => {
    const s = normalizedSlope([100, 101, 102, 103, 104], 5);
    expect(s.slice(0, 4)).toEqual([null, null, null, null]);
    expect(s[4]).toBeCloseTo(1 / 102, 12);
    expect(normalizedSlope([5, 5, 5], 3)[2]).toBe(0);
    expect(normalizedSlope([null, 1, 2], 2)).toEqual([null, null, 1 / 1.5]);
    expect(percentChange([100, 110, 121], 1)).toEqual([null, 0.1, 0.1]);
  });

  it('EDGE-IND-005 presisi floating point stabil pada harga sangat kecil', () => {
    const v = Array.from({ length: 50 }, (_, i) => 0.00001234 + i * 1e-9);
    const e = ema(v, 7);
    expect(e[49]).toBeGreaterThan(0.00001234);
    expect(e[49]).toBeLessThan(v[49]);
  });
});
