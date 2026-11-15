import { describe, expect, it } from 'vitest';
import {
  DAY_MS, dayClusterBootstrapMean, longFundingR, longTripleBarrier, mulberry32, pairedDayBootstrapDiff, summarizeEvents,
  wilsonInterval,
} from '../../../backend/backtest/eventStudy.js';

// Candle SINTETIS — bukan data pasar nyata.
const H = 3_600_000;
const T0 = Date.UTC(2025, 0, 1);
const candle = (k, { open = 100, high = 100.5, low = 99.5, close = 100 } = {}) => ({ openTime: T0 + k * H, open, high, low, close });
const flat = (n) => Array.from({ length: n }, (_, k) => candle(k));

describe('PRNG & interval', () => {
  it('UNIT-EVS-001 mulberry32 deterministik per benih, di [0, 1), dan berbeda antarbenih', () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    const c = mulberry32(8);
    const xs = Array.from({ length: 1000 }, () => a());
    expect(xs).toEqual(Array.from({ length: 1000 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(new Set(xs).size).toBeGreaterThan(990);
    expect(c()).not.toBe(xs[0]);
  });

  it('UNIT-EVS-002 interval Wilson sesuai rumus; n = 0 → null', () => {
    const [lo, hi] = wilsonInterval(41, 100);
    expect(lo).toBeCloseTo(0.3187, 3);
    expect(hi).toBeCloseTo(0.5080, 3);
    expect(wilsonInterval(0, 0)).toEqual([null, null]);
  });
});

describe('longTripleBarrier', () => {
  it('UNIT-EVS-003 entri di open candle berikutnya; target tersentuh → +targetR; biaya dalam R', () => {
    const c = flat(10);
    c[1] = candle(1, { open: 101 });
    c[3] = candle(3, { high: 105.1 });
    const r = longTripleBarrier(c, 0, { stopDistance: 2, targetR: 2, maxBars: 5, costRoundTrip: 0.001 });
    expect(r).toMatchObject({ outcome: 'TARGET', grossR: 2, entryIndex: 1, exitIndex: 3, entryPrice: 101, entryTime: T0 + H });
    expect(r.costR).toBeCloseTo((0.001 * 101) / 2, 10);
    expect(r.netR).toBeCloseTo(2 - r.costR, 10);
    expect(r.fundingR).toBe(0);
  });

  it('UNIT-EVS-004 stop & target pada candle yang sama → STOP (konservatif); stop di candle entri ikut dihitung', () => {
    const c = flat(10);
    c[2] = candle(2, { high: 110, low: 90 });
    expect(longTripleBarrier(c, 0, { stopDistance: 2, maxBars: 5 })).toMatchObject({ outcome: 'STOP', grossR: -1, exitIndex: 2 });
    const d = flat(10);
    d[1] = candle(1, { low: 97.9 });
    expect(longTripleBarrier(d, 0, { stopDistance: 2, maxBars: 5 })).toMatchObject({ outcome: 'STOP', exitIndex: 1 });
  });

  it('UNIT-EVS-005 tanpa sentuhan → TIME dengan R = (close[i+maxBars] − entri) / jarak stop; data kurang/jarak ≤ 0 → null', () => {
    const c = flat(10);
    c[5] = candle(5, { close: 101 });
    expect(longTripleBarrier(c, 0, { stopDistance: 2, maxBars: 5 })).toMatchObject({ outcome: 'TIME', grossR: 0.5, exitIndex: 5 });
    expect(longTripleBarrier(c, 5, { stopDistance: 2, maxBars: 5 })).toBeNull();
    expect(longTripleBarrier(c, 0, { stopDistance: 0, maxBars: 5 })).toBeNull();
  });

  it('UNIT-EVS-006 funding: dihitung dari jam entri sampai candle keluar, memakai harga open saat itu; sesudah keluar tidak', () => {
    const c = flat(20);
    c[9] = candle(9, { open: 102 });
    const funding = {
      times: [T0 - 8 * H, T0 + H, T0 + 9 * H + 3, T0 + 12 * H],
      rates: [0.5, 0.001, -0.0004, 0.9],
    };
    // Entri candle 1 (T0+1h), keluar TIME di candle 10: funding T0+1h (+0,001 × 100) dan T0+9h (−0,0004 × 102).
    const fr = longFundingR(c, 1, 10, 2, funding, H);
    expect(fr).toBeCloseTo((0.001 * 100 - 0.0004 * 102) / 2, 10);
    const r = longTripleBarrier(c, 0, { stopDistance: 2, maxBars: 10, funding, intervalMs: H });
    expect(r.outcome).toBe('TIME');
    expect(r.fundingR).toBeCloseTo(fr, 10);
    expect(r.netR).toBeCloseTo(r.grossR - r.costR - fr, 10);
  });
});

describe('bootstrap berklaster per hari', () => {
  const daysOf = (values) => values.map((v, k) => ({ t: T0 + k * DAY_MS, netR: v }));

  it('UNIT-EVS-007 deterministik per benih; nilai seragam → CI menyempit ke rata-ratanya; < 5 hari → null', () => {
    const ev = daysOf([0.1, -0.2, 0.3, 0.05, -0.1, 0.2, 0.4, -0.3, 0.15, 0]);
    const a = dayClusterBootstrapMean(ev, { seed: 3, reps: 500 });
    expect(dayClusterBootstrapMean(ev, { seed: 3, reps: 500 })).toEqual(a);
    expect(a.lo).toBeLessThanOrEqual(a.mean);
    expect(a.hi).toBeGreaterThanOrEqual(a.mean);
    expect(a.days).toBe(10);
    const same = dayClusterBootstrapMean(daysOf([0.2, 0.2, 0.2, 0.2, 0.2, 0.2]), { reps: 200 });
    expect(same.lo).toBeCloseTo(0.2, 12);
    expect(same.hi).toBeCloseTo(0.2, 12);
    expect(dayClusterBootstrapMean(daysOf([1, 2, 3, 4]))).toBeNull();
  });

  it('UNIT-EVS-008 sinyal pada hari yang sama bergerak bersama (satu klaster), bukan pengamatan independen', () => {
    // 6 hari; tiap hari 50 sinyal identik → CI berklaster sama lebarnya dengan 6 pengamatan, bukan 300.
    const ev = [];
    [0.5, -0.5, 0.4, -0.4, 0.3, -0.3].forEach((v, d) => { for (let k = 0; k < 50; k += 1) ev.push({ t: T0 + d * DAY_MS + k, netR: v }); });
    const ci = dayClusterBootstrapMean(ev, { reps: 2000, seed: 5 });
    expect(ci.hi - ci.lo).toBeGreaterThan(0.3);
  });

  it('UNIT-EVS-009 selisih berpasangan: A = B + 0,5 di setiap hari → selisih & CI tepat 0,5', () => {
    const B = daysOf([0.1, -0.2, 0.3, 0.05, -0.1, 0.2, 0.4]);
    const A = B.map((e) => ({ ...e, netR: e.netR + 0.5 }));
    const d = pairedDayBootstrapDiff(A, B, { reps: 300 });
    expect(d.diff).toBeCloseTo(0.5, 12);
    expect(d.lo).toBeCloseTo(0.5, 12);
    expect(d.hi).toBeCloseTo(0.5, 12);
    expect(pairedDayBootstrapDiff([], B)).toBeNull();
  });
});

describe('summarizeEvents', () => {
  it('UNIT-EVS-010 menghitung win rate (Wilson), proporsi stop/waktu, dan rata-rata komponen R', () => {
    const ev = [
      { outcome: 'TARGET', grossR: 2, costR: 0.1, fundingR: 0.02, netR: 1.88 },
      { outcome: 'STOP', grossR: -1, costR: 0.1, fundingR: 0, netR: -1.1 },
      { outcome: 'TIME', grossR: 0.3, costR: 0.1, fundingR: -0.01, netR: 0.21 },
      { outcome: 'STOP', grossR: -1, costR: 0.1, fundingR: 0.01, netR: -1.11 },
    ];
    const s = summarizeEvents(ev);
    expect(s).toMatchObject({ n: 4, winRate: 0.25, stopRate: 0.5, timeRate: 0.25 });
    expect(s.meanNetR).toBeCloseTo((1.88 - 1.1 + 0.21 - 1.11) / 4, 12);
    expect(s.meanFundingR).toBeCloseTo((0.02 + 0 - 0.01 + 0.01) / 4, 12);
    expect(s.winCI[0]).toBeLessThan(0.25);
    expect(summarizeEvents([])).toEqual({ n: 0 });
  });
});
