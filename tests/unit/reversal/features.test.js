import { describe, expect, it } from 'vitest';
import {
  atrContractionRatio, findBottomIndex, findBottomRetest, findSpring, htfTrend, intactHigherLow, linearSlope, liquidityClassOf,
  lowerHighSinceBottom, lowerLowChain, quadraticFit, quietRise, rangeContraction, risingFloor, roundedBottomFit, rsiDivergenceAtBottom,
  staircaseSinceBottom, triggerLevelAt, volumeDryUp,
} from '../../../backend/reversal/features.js';
import { resolveReversalParams } from '../../../backend/reversal/params.js';

// Data uji deterministik — sintetis, bukan data pasar nyata.
const P = resolveReversalParams({}, '5m');
const T0 = Date.UTC(2026, 0, 5);
const MS = 5 * 60_000;
/** Candle sederhana dari low/high/close (open = close). */
const candle = (i, { low, high, close = (low + high) / 2, volume = 100 }) => ({
  openTime: T0 + i * MS, closeTime: T0 + (i + 1) * MS - 1, open: close, high, low, close, volume, quoteVolume: volume * close, isClosed: true,
});
const fromLows = (lows) => lows.map((l, i) => candle(i, { low: l, high: l + 1, close: l + 0.5 }));
const swing = (index, price, right = 2) => ({ index, price, confirmedIndex: index + right });

describe('fitur Reversal Radar', () => {
  it('UNIT-RR-FT-001 quadraticFit: parabola eksak y = 2(x−5)² + 3 → a, b, c, R² = 1, vertex (5, 3)', () => {
    const values = Array.from({ length: 11 }, (_, x) => 2 * (x - 5) ** 2 + 3);
    const fit = quadraticFit(values);
    expect(fit.a).toBeCloseTo(2, 9);
    expect(fit.b).toBeCloseTo(-20, 9);
    expect(fit.c).toBeCloseTo(53, 9);
    expect(fit.r2).toBeCloseTo(1, 12);
    expect(fit.vertexIndex).toBeCloseTo(5, 9);
    expect(fit.vertexValue).toBeCloseTo(3, 9);
    // Garis lurus: a ≈ 0, R² = 1. Derau menurunkan R². Kurang dari 3 titik → null.
    const line = quadraticFit([1, 3, 5, 7, 9]);
    expect(Math.abs(line.a)).toBeLessThan(1e-12);
    expect(line.r2).toBeCloseTo(1, 12);
    expect(quadraticFit([5, 1, 6, 2, 7, 3]).r2).toBeLessThan(0.6);
    expect(quadraticFit([1, 2])).toBeNull();
    expect(quadraticFit([1, Number.NaN, 3, 4])).toBeNull();
  });

  it('UNIT-RR-FT-002 linearSlope, findBottomIndex (seri → kemunculan pertama)', () => {
    expect(linearSlope([{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 5 }])).toBeCloseTo(2, 12);
    expect(linearSlope([{ x: 1, y: 1 }])).toBeNull();
    expect(linearSlope([{ x: 1, y: 1 }, { x: 1, y: 5 }])).toBeNull();
    const cs = fromLows([5, 4, 3, 4, 3, 5, 6, 7]);
    expect(findBottomIndex(cs, 7, 8)).toBe(2);
    expect(findBottomIndex(cs, 7, 3)).toBe(5);
  });

  it('UNIT-RR-FT-003 lowerLowChain: rantai LL berakhir di dasar, kedalaman dalam ATR evaluasi', () => {
    const lows = [swing(3, 120), swing(9, 110), swing(15, 100), swing(21, 96)];
    const r = lowerLowChain(lows, 21, 2);
    expect(r.chain.map((s) => s.index)).toEqual([3, 9, 15, 21]);
    expect(r.depthPrev).toBeCloseTo(5, 12);
    expect(r.depthLast).toBeCloseTo(2, 12);
    // Dasar bukan swing terkonfirmasi → rantai kosong; rantai < 3 → kedalaman null.
    expect(lowerLowChain(lows, 22, 2)).toEqual({ chain: [], depthLast: null, depthPrev: null });
    expect(lowerLowChain([swing(3, 90), swing(9, 110), swing(15, 100)], 15, 2).depthLast).toBeNull();
    expect(lowerLowChain(lows, 21, 0).depthLast).toBeNull();
  });

  it('UNIT-RR-FT-004 findBottomRetest: butuh menjauh ≥ departAtr dulu, lalu low kembali ≤ dasar + retestAtr', () => {
    // dasar 100 (indeks 2); ATR 2 → menjauh ≥ 102, retest ≤ 101.
    const cs = [
      candle(0, { low: 103, high: 105 }), candle(1, { low: 101, high: 104 }), candle(2, { low: 100, high: 102, close: 100.5 }),
      candle(3, { low: 100.4, high: 101.5, close: 101 }), candle(4, { low: 101, high: 103, close: 102.5 }), candle(5, { low: 102, high: 104, close: 103 }),
      candle(6, { low: 100.8, high: 103, close: 102 }), candle(7, { low: 101.5, high: 103, close: 102.5 }),
    ];
    expect(findBottomRetest(cs, 2, 7, 2, P)).toEqual({ retestIndex: 6, departIndex: 4, retestLow: 100.8 });
    // Candle tepat sesudah dasar (indeks 3) bukan retest karena belum menjauh.
    expect(findBottomRetest(cs, 2, 3, 2, P)).toEqual({ retestIndex: null, departIndex: null, retestLow: null });
    expect(findBottomRetest(cs, 2, 5, 2, P)).toEqual({ retestIndex: null, departIndex: 4, retestLow: null });
    expect(findBottomRetest(cs, 2, 7, 0, P).retestIndex).toBeNull();
  });

  it('UNIT-RR-FT-005 triggerLevelAt: swing high terkonfirmasi sejak dasar dinaikkan ke high sesudahnya sampai candle sebelum evaluasi; fallback high tertinggi sejak dasar', () => {
    const cs = fromLows([10, 9, 8, 9, 10, 9, 8.5, 9, 9.5, 9.2]).map((c, i) => ({ ...c, high: [11, 10, 9, 10, 12, 10, 9.5, 10, 13, 10][i] }));
    const highs = [swing(4, 12)]; // terkonfirmasi di indeks 6
    expect(triggerLevelAt(cs, highs, 2, 9)).toEqual({ level: 13, swing: highs[0] }); // dinaikkan ke high 13 di indeks 8
    expect(triggerLevelAt(cs, highs, 2, 7)).toEqual({ level: 12, swing: highs[0] }); // high 13 (indeks 8) belum ada
    expect(triggerLevelAt(cs, highs, 2, 5)).toEqual({ level: 12, swing: null }); // swing belum terkonfirmasi → fallback high tertinggi [2..4]
    expect(triggerLevelAt(cs, [], 2, 3)).toEqual({ level: 9, swing: null });
    expect(triggerLevelAt(cs, [], 9, 9)).toBeNull();
    // Swing high SEBELUM dasar tidak dipakai.
    expect(triggerLevelAt(cs, [swing(0, 11)], 2, 5)).toEqual({ level: 12, swing: null });
  });

  it('UNIT-RR-FT-006 intactHigherLow: HL vs swing low sebelumnya sejak dasar, utuh (tidak ditembus, close di atas)', () => {
    const lows = [swing(2, 100), swing(8, 104), swing(14, 103), swing(20, 106)];
    let cs = fromLows(Array.from({ length: 24 }, (_, i) => (i === 2 ? 100 : i === 14 ? 103 : 107)));
    const hl = intactHigherLow(cs, lows, 2, 23);
    expect(hl.swing.index).toBe(20);
    expect(hl.chain).toBe(1); // 106 > 103, tetapi 103 < 104 memutus rantai
    // HL terbaru ditembus oleh low sesudahnya → HL utuh sebelumnya (104 → tidak, karena 103 < 104; jadi null)
    cs = cs.map((c, i) => (i === 22 ? { ...c, low: 105 } : c));
    expect(intactHigherLow(cs, lows, 2, 23)).toBeNull();
    // Close di bawah HL terbaru (106) → HL itu tidak utuh; HL lebih awal yang masih utuh (104) dipakai. Tanpa swing sesudah dasar → null.
    const cs2 = fromLows(Array.from({ length: 24 }, (_, i) => (i === 2 ? 100 : 107))).map((c, i) => (i === 23 ? { ...c, close: 105 } : c));
    expect(intactHigherLow(cs2, lows, 2, 23).swing.index).toBe(8);
    expect(intactHigherLow(cs2.map((c, i) => (i === 23 ? { ...c, close: 103 } : c)), lows, 2, 23)).toBeNull();
    expect(intactHigherLow(cs2, [swing(2, 100)], 2, 23)).toBeNull();
    // Rantai dua HL.
    expect(intactHigherLow(fromLows(Array.from({ length: 24 }, (_, i) => (i === 2 ? 100 : 110))), [swing(2, 100), swing(8, 104), swing(14, 106)], 2, 23).chain).toBe(2);
  });

  it('UNIT-RR-FT-007 findSpring kausal: level = swing low terkonfirmasi SEBELUM candle sapuan, reclaimed = close evaluasi di atasnya', () => {
    const lows = [swing(4, 100)]; // terkonfirmasi di 6
    const cs = fromLows([103, 102, 101, 100.5, 100, 100.5, 101, 102, 99.5, 101.5]);
    const rvol = cs.map(() => 1.2);
    const sp = findSpring(cs, lows, rvol, 9, 3);
    expect(sp).toMatchObject({ index: 8, level: 100, swingIndex: 4, reclaimed: true, rvol: 1.2 });
    // Sapuan di luar jendela → null; sapuan sebelum swing terkonfirmasi (confirmedIndex ≥ j) → bukan spring.
    expect(findSpring(cs, lows, rvol, 9, 0)).toBeNull();
    const early = fromLows([103, 102, 101, 100.5, 100, 99.5, 101, 102, 103, 104]);
    expect(findSpring(early, lows, rvol, 6, 3)).toBeNull();
    // Belum di-reclaim.
    const notReclaimed = cs.map((c, i) => (i === 9 ? { ...c, close: 99.8 } : c));
    expect(findSpring(notReclaimed, lows, rvol, 9, 3).reclaimed).toBe(false);
  });

  it('UNIT-RR-FT-008 lowerHighSinceBottom, staircaseSinceBottom, rsiDivergenceAtBottom', () => {
    const highs = [swing(0, 130), swing(6, 120), swing(12, 110), swing(18, 105), swing(24, 108), swing(30, 112)];
    expect(lowerHighSinceBottom(highs, 15, 106)).toMatchObject({ swing: highs[3], broken: true });
    expect(lowerHighSinceBottom(highs, 15, 104).broken).toBe(false);
    expect(lowerHighSinceBottom(highs, 27, 120)).toBeNull(); // sejak dasar hanya ada HH
    const lows = [swing(15, 100), swing(21, 102), swing(27, 104), swing(33, 105)];
    const st = staircaseSinceBottom(highs, lows, 15, 2);
    expect(st).toMatchObject({ higherLows: 3, higherHighs: 2, maxStepAtr: 2 });
    expect(staircaseSinceBottom(highs, lows, 15, 0).maxStepAtr).toBeNull();
    const rsi = Array.from({ length: 40 }, () => 50);
    rsi[9] = 28;
    rsi[15] = 33;
    expect(rsiDivergenceAtBottom([swing(3, 110), swing(9, 104), swing(15, 100)], rsi, 15)).toMatchObject({ priceLowerLow: true, rsiDiff: 5 });
    expect(rsiDivergenceAtBottom([swing(9, 104), swing(15, 100)], rsi, 16).bottom).toBeNull();
  });

  it('UNIT-RR-FT-009 rasio ATR/range/volume, quiet rise, rising floor', () => {
    const atr = [null, 2, 2, 2, 1.5];
    expect(atrContractionRatio(atr, 4, 3)).toBeCloseTo(0.75, 12);
    expect(atrContractionRatio(atr, 4, 4)).toBeNull();
    const cs = fromLows([10, 12, 8, 11, 10, 10.5, 9.5, 10.2]);
    const rc = rangeContraction(cs, 7, 4);
    expect(rc.previous).toBeCloseTo(5, 12); // low 8..high 13
    expect(rc.recent).toBeCloseTo(2, 12); // low 9,5..high 11,5
    expect(rc.ratio).toBeCloseTo(0.4, 12);
    expect(volumeDryUp([100, 100, 100, 100, 50, 50], 5, 2, 4)).toEqual({ recent: 50, baseline: 100, ratio: 0.5 });
    expect(volumeDryUp([100, 50], 1, 1, 4).ratio).toBeNull();
    const series = { closes: [100, 100.5, 101, 101.2, 101.5], rvol: [null, 0.8, 0.9, 1.0, 0.7] };
    expect(quietRise(series, 4, 3, 1)).toEqual({ rise: 1, riseAtr: 1, avgRvol: (0.9 + 1.0 + 0.7) / 3 });
    expect(quietRise({ ...series, rvol: [null, 0.8, null, 1.0, 0.7] }, 4, 3, 1).avgRvol).toBeNull();
    expect(quietRise(series, 3, 4, 1).riseAtr).toBeNull();
    const floorLows = [swing(2, 100), swing(8, 100.5), swing(14, 101.2)];
    const rf = risingFloor(fromLows(Array.from({ length: 20 }, () => 101)), floorLows, 19, 20, 1);
    expect(rf.swingCount).toBe(3);
    expect(rf.slopeAtr).toBeCloseTo(0.1, 9);
    expect(rf.rangeAtr).toBeCloseTo(1, 9);
  });

  it('UNIT-RR-FT-010 roundedBottomFit mengembalikan posisi vertex relatif & indeks absolut', () => {
    const closes = Array.from({ length: 50 }, (_, i) => (i < 10 ? 100 : 90 + 0.05 * (i - 30) ** 2));
    const fit = roundedBottomFit(closes, 49, 40);
    expect(fit.a).toBeGreaterThan(0);
    expect(fit.vertexPos).toBeCloseTo(20 / 39, 6); // vertex indeks 30 pada jendela 10..49
    expect(fit.vertexIndex).toBe(30);
    expect(fit.r2).toBeCloseTo(1, 6);
    expect(roundedBottomFit(closes, 20, 40)).toBeNull();
  });

  it('UNIT-RR-FT-011 htfTrend: EMA25 naik & close di atasnya → BULLISH; turun & di bawah → BEARISH; data kurang → null', () => {
    const up = Array.from({ length: 40 }, (_, i) => candle(i, { low: 100 + i, high: 101 + i }));
    const down = Array.from({ length: 40 }, (_, i) => candle(i, { low: 140 - i, high: 141 - i }));
    expect(htfTrend(up, P).trend).toBe('BULLISH');
    expect(htfTrend(down, P).trend).toBe('BEARISH');
    expect(htfTrend(up.slice(0, 20), P)).toBeNull();
    const flat = Array.from({ length: 40 }, (_, i) => candle(i, { low: 100, high: 101 }));
    expect(htfTrend(flat, P).trend).toBe('NEUTRAL');
  });

  it('UNIT-RR-FT-012 liquidityClassOf: ambang 24 jam, fallback rata-rata quote volume, spread menurunkan LIQUID', () => {
    expect(liquidityClassOf({ quoteVolume24h: 60_000_000 }, null, '5m', P)).toBe('LIQUID');
    expect(liquidityClassOf({ quoteVolume24h: 20_000_000 }, null, '5m', P)).toBe('THIN');
    expect(liquidityClassOf({ quoteVolume24h: 5_000_000 }, null, '5m', P)).toBe('ILLIQUID');
    expect(liquidityClassOf({ quoteVolume24h: 2_000_000, thresholds: { minQuoteVolume24h: 1_000_000 } }, null, '5m', P)).toBe('LIQUID');
    expect(liquidityClassOf(undefined, 100_000, '5m', P)).toBe('UNKNOWN');
    expect(liquidityClassOf(null, 10_000, '5m', P)).toBe('ILLIQUID');
    expect(liquidityClassOf({ quoteVolume24h: null }, 100_000, '1h', P)).toBe('ILLIQUID');
    expect(liquidityClassOf({ quoteVolume24h: 60_000_000, spreadBps: 50 }, null, '5m', P)).toBe('THIN');
  });
});
