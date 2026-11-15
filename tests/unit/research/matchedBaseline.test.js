// Studi "informasi di luar momentum" (backend/research/matchedBaseline.js): gerak lanjutan, binning strata,
// pencocokan, moving-block bootstrap, aturan satu posisi per simbol, dan ukuran sampel.
import { describe, expect, it } from 'vitest';
import {
  DAY_MS, addControl, binOf, breakoutWithin, forwardMove, matchAlerts, movingBlockBootstrapDiff, movingBlockBootstrapMean,
  onePositionPerSymbol, posBin, preBin, quantileCuts, quarterOf, requiredSampleSize, stratumKey,
} from '../../../backend/research/matchedBaseline.js';

describe('matchedBaseline', () => {
  it('UNIT-MTB-001 forwardMove & breakoutWithin: arah, satuan ATR, null bila data kurang', () => {
    const c = [100, 101, 103, 106, 110].map((close) => ({ close }));
    const a = [2, 2, 2, 2, 2];
    expect(forwardMove(c, a, 'LONG', 0, 4)).toBeCloseTo(5, 12);
    expect(forwardMove(c, a, 'SHORT', 0, 4)).toBeCloseTo(-5, 12);
    expect(forwardMove(c, a, 'LONG', 1, 4)).toBeNull();
    expect(forwardMove(c, [0, 0, 0, 0, 0], 'LONG', 0, 2)).toBeNull();
    expect(() => forwardMove(c, a, 'UP', 0, 1)).toThrow(RangeError);
    const flags = new Uint8Array(30);
    flags[20] = 1;
    expect(breakoutWithin(flags, 8)).toBe(1);
    expect(breakoutWithin(flags, 7)).toBe(0); // 20 > 7 + 12
    expect(breakoutWithin(flags, 20)).toBe(0); // candle sinyal sendiri tidak dihitung
  });

  it('UNIT-MTB-002 binning strata: gerak awal 0,5 ATR (ujung digabung), posisi 0,2, kuantil volatilitas, kuartal', () => {
    expect(preBin(0.49)).toBe(0);
    expect(preBin(0.5)).toBe(1);
    expect(preBin(-0.01)).toBe(-1);
    expect(preBin(-9)).toBe(-8);
    expect(preBin(25)).toBe(12);
    expect(posBin(0)).toBe(0);
    expect(posBin(0.79)).toBe(3);
    expect(posBin(0.95)).toBe(4);
    expect(posBin(1)).toBe(4);
    const cuts = quantileCuts([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(cuts).toEqual([4, 7]);
    expect([1, 4, 6.9, 7, 9].map((v) => binOf(v, cuts))).toEqual([0, 1, 1, 2, 2]);
    expect([Date.UTC(2025, 0, 1), Date.UTC(2025, 2, 31, 23), Date.UTC(2025, 3, 1), Date.UTC(2026, 11, 31)].map(quarterOf))
      .toEqual(['2025-Q1', '2025-Q1', '2025-Q2', '2026-Q4']);
    expect(stratumKey({ symbol: 'AUSDT', period: '2025-Q1', pre: 2.2, pos: 0.87, volBin: 1 })).toBe('AUSDT|2025-Q1|4|4|1');
  });

  it('UNIT-MTB-003 matchAlerts: selisih terhadap rata-rata pembanding strata yang sama; tanpa pembanding → tidak cocok', () => {
    const controls = new Map();
    addControl(controls, 'k1', { f: 1, b: 0 });
    addControl(controls, 'k1', { f: 3, b: 1 });
    const { matched, unmatched } = matchAlerts([{ key: 'k1', y: { f: 4, b: 1 } }, { key: 'k2', y: { f: 9, b: 1 } }], controls);
    expect(unmatched).toBe(1);
    expect(matched).toHaveLength(1);
    expect(matched[0]).toMatchObject({ nCtrl: 2, ctrl: { f: 2, b: 0.5 }, diff: { f: 2, b: 0.5 } });
  });

  it('UNIT-MTB-004 moving-block bootstrap: deterministik, konstan → CI sempit, blok panjang melebar pada data berautokorelasi', () => {
    const constant = Array.from({ length: 60 }, (_, d) => ({ t: d * DAY_MS, value: 0.3 }));
    const ci = movingBlockBootstrapMean(constant, { blockDays: 7 });
    expect(ci.mean).toBeCloseTo(0.3, 12);
    expect(ci.lo).toBeCloseTo(0.3, 12);
    expect(ci.hi).toBeCloseTo(0.3, 12);
    // Rezim 20 hari +1 lalu 20 hari −1 (berulang): ketergantungan antar-hari kuat.
    const regimes = [];
    for (let d = 0; d < 400; d += 1) for (let k = 0; k < 3; k += 1) regimes.push({ t: d * DAY_MS + k * 1000, value: Math.floor(d / 20) % 2 ? -1 : 1 });
    const daily = movingBlockBootstrapMean(regimes, { blockDays: 1 });
    const weekly = movingBlockBootstrapMean(regimes, { blockDays: 14 });
    expect(movingBlockBootstrapMean(regimes, { blockDays: 14 })).toEqual(weekly);
    expect(weekly.hi - weekly.lo).toBeGreaterThan(1.5 * (daily.hi - daily.lo));
    expect(weekly.lo).toBeLessThanOrEqual(weekly.mean);
    expect(weekly.hi).toBeGreaterThanOrEqual(weekly.mean);
    expect(movingBlockBootstrapMean([])).toBeNull();
  });

  it('UNIT-MTB-005 satu posisi per simbol: trade yang tumpang tindih pada simbol sama dibuang, simbol lain bebas', () => {
    const trades = [
      { symbol: 'A', t: 0, exitTime: 10 },
      { symbol: 'A', t: 5, exitTime: 20 },
      { symbol: 'B', t: 6, exitTime: 30 },
      { symbol: 'A', t: 10, exitTime: 15 },
      { symbol: 'A', t: 11, exitTime: 40 },
    ];
    expect(onePositionPerSymbol(trades).map((x) => `${x.symbol}${x.t}`)).toEqual(['A0', 'B6', 'A11']);
  });

  it('UNIT-MTB-007 bootstrap selisih: konstan → selisih pasti; hari yang sama disampling untuk kedua kelompok', () => {
    const a = Array.from({ length: 40 }, (_, d) => ({ t: d * DAY_MS, value: 1 }));
    const b = Array.from({ length: 40 }, (_, d) => ({ t: d * DAY_MS + 5, value: 0.4 }));
    const ci = movingBlockBootstrapDiff(a, b, { blockDays: 7 });
    expect(ci.diff).toBeCloseTo(0.6, 12);
    expect(ci.lo).toBeCloseTo(0.6, 12);
    expect(ci.hi).toBeCloseTo(0.6, 12);
    // Kedua kelompok ikut rezim harian yang sama (+x pada hari yang sama) → selisih tetap stabil (CI sempit),
    // sedangkan CI rata-rata masing-masing kelompok lebar.
    const shared = (d) => (Math.floor(d / 15) % 2 ? -2 : 2);
    const ga = Array.from({ length: 300 }, (_, d) => ({ t: d * DAY_MS, value: shared(d) + 0.5 }));
    const gb = Array.from({ length: 300 }, (_, d) => ({ t: d * DAY_MS + 7, value: shared(d) }));
    const diff = movingBlockBootstrapDiff(ga, gb, { blockDays: 7 });
    const single = movingBlockBootstrapMean(ga, { blockDays: 7 });
    expect(diff.hi - diff.lo).toBeLessThan(0.05);
    expect(single.hi - single.lo).toBeGreaterThan(0.5);
    expect(movingBlockBootstrapDiff([], gb)).toBeNull();
  });

  it('UNIT-MTB-006 ukuran sampel: rumus power satu sampel; input tidak valid → null', () => {
    expect(requiredSampleSize({ sd: 1, effect: 0.1 })).toBe(785);
    expect(requiredSampleSize({ sd: 1.3, effect: 0.15, deff: 1.5 })).toBe(Math.ceil(((1.959964 + 0.841621) * 1.3 * Math.sqrt(1.5) / 0.15) ** 2));
    expect(requiredSampleSize({ sd: 1, effect: 0 })).toBeNull();
    expect(requiredSampleSize({ sd: 0, effect: 0.1 })).toBeNull();
  });
});
