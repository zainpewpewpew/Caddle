import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_METHOD, MIN_CALIBRATION_SAMPLES, applyCalibration, fitCalibration, isUsableCalibration, parseCalibrationFile,
  reliabilityReport,
} from '../../../backend/backtest/calibration.js';
import { wilsonInterval } from '../../../backend/backtest/metrics.js';

/** PRNG berbenih (mulberry32) agar test deterministik. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function synthetic(n, seed, probOf = (s) => s / 100) {
  const rnd = prng(seed);
  return Array.from({ length: n }, () => {
    const score = Math.round(rnd() * 100);
    return { score, win: rnd() < probOf(score) ? 1 : 0 };
  });
}

describe('kalibrasi isotonik', () => {
  it('UNIT-BT-CAL-001 PAV hitungan tangan: pelanggaran monoton digabung', () => {
    // 3 bin kuantil: [10,20] 2/2 menang, [30,40] 0/2, [50,60] 2/2.
    // Posterior Beta(1,1): 3/4, 1/4, 3/4 → bin 1 > bin 2 melanggar → gabung: (2+1)/(4+2) = 0,5. Hasil 0,5 ≤ 0,75.
    const samples = [
      { score: 10, win: 1 }, { score: 20, win: 1 }, { score: 30, win: 0 },
      { score: 40, win: 0 }, { score: 50, win: 1 }, { score: 60, win: true },
    ];
    const t = fitCalibration(samples, { bins: 3, minSamplesPerBin: 1 });
    expect(t.version).toBe(1);
    expect(t.method).toBe(CALIBRATION_METHOD);
    expect(t.totalSamples).toBe(6);
    expect(t.bins).toHaveLength(2);
    expect(t.bins[0]).toMatchObject({ lo: 10, hi: 40, n: 4, wins: 2 });
    expect(t.bins[0].probability).toBeCloseTo(0.5, 12);
    expect(t.bins[1]).toMatchObject({ lo: 50, hi: 60, n: 2, wins: 2 });
    expect(t.bins[1].probability).toBeCloseTo(0.75, 12);
    const [lo, hi] = wilsonInterval(2, 4);
    expect(t.bins[0].lower).toBeCloseTo(lo, 12);
    expect(t.bins[0].upper).toBeCloseTo(hi, 12);
  });

  it('UNIT-BT-CAL-002 skor kembar tidak terbelah ke dua bin', () => {
    const samples = [5, 5, 5, 5, 9, 9].map((score, i) => ({ score, win: i % 2 }));
    const t = fitCalibration(samples, { bins: 3, minSamplesPerBin: 1, prior: { alpha: 0, beta: 0 } });
    // Tanpa prior: skor 5 → 2/4 = 0,5; skor 9 → 1/2 = 0,5 (sama → tidak melanggar, tetap 2 bin).
    expect(t.bins.map((b) => [b.lo, b.hi, b.n])).toEqual([[5, 5, 4], [9, 9, 2]]);
  });

  it('UNIT-BT-CAL-003 bin kecil digabung (n ≥ minSamplesPerBin) dan total sampel terjaga', () => {
    // 100 skor unik, menang selang-seling (tingkat flat) → 10 bin × 10 → digabung 30, 30, 40 (sebelum PAV).
    const samples = Array.from({ length: 100 }, (_, i) => ({ score: i, win: i % 2 }));
    const t = fitCalibration(samples, { bins: 10, minSamplesPerBin: 30 });
    expect(t.bins.every((b) => b.n >= 30)).toBe(true);
    expect(t.bins.reduce((a, b) => a + b.n, 0)).toBe(100);
  });

  it('UNIT-BT-CAL-004 data acak berbenih: hasil monoton naik & mendekati peluang sebenarnya', () => {
    const t = fitCalibration(synthetic(5000, 42), { bins: 10, minSamplesPerBin: 30 });
    expect(t.totalSamples).toBe(5000);
    for (let i = 1; i < t.bins.length; i += 1) {
      expect(t.bins[i].probability).toBeGreaterThanOrEqual(t.bins[i - 1].probability);
      expect(t.bins[i].lo).toBeGreaterThan(t.bins[i - 1].hi);
    }
    // Peluang sebenarnya = skor/100 → peluang bin ≈ titik tengah skor bin (toleransi longgar).
    for (const b of t.bins) expect(Math.abs(b.probability - (b.lo + b.hi) / 200)).toBeLessThan(0.08);
    // Data anti-monoton (peluang turun terhadap skor) → PAV meratakan, tetap tidak turun.
    const inv = fitCalibration(synthetic(2000, 7, (s) => 1 - s / 100), { bins: 10, minSamplesPerBin: 30 });
    for (let i = 1; i < inv.bins.length; i += 1) expect(inv.bins[i].probability).toBeGreaterThanOrEqual(inv.bins[i - 1].probability);
    expect(inv.bins.length).toBeLessThanOrEqual(2);
  });

  it('UNIT-BT-CAL-005 applyCalibration: bin, ujung, dan syarat sampel', () => {
    const t = fitCalibration(synthetic(1000, 3), { bins: 10, minSamplesPerBin: 30 });
    const first = t.bins[0];
    const last = t.bins.at(-1);
    expect(applyCalibration(t, -50)).toEqual({ probability: first.probability, lower: first.lower, upper: first.upper, samples: first.n });
    expect(applyCalibration(t, 500).probability).toBe(last.probability);
    const mid = applyCalibration(t, 50);
    expect(mid.lower).toBeLessThanOrEqual(mid.upper);
    expect(mid.samples).toBeGreaterThanOrEqual(30);

    expect(applyCalibration(null, 50)).toBeNull();
    expect(applyCalibration(fitCalibration([]), 50)).toBeNull();
    expect(applyCalibration(fitCalibration(synthetic(MIN_CALIBRATION_SAMPLES - 1, 1)), 50)).toBeNull();
    expect(applyCalibration(fitCalibration(synthetic(MIN_CALIBRATION_SAMPLES, 1)), 50)).not.toBeNull();
    expect(applyCalibration(t, Number.NaN)).toBeNull();
  });

  it('UNIT-BT-CAL-006 reliabilityReport: ECE & Brier hitungan tangan', () => {
    const table = {
      version: 1, method: CALIBRATION_METHOD, totalSamples: 200,
      bins: [
        { lo: 0, hi: 49, n: 100, wins: 20, probability: 0.2, lower: 0.13, upper: 0.29 },
        { lo: 50, hi: 100, n: 100, wins: 80, probability: 0.8, lower: 0.71, upper: 0.87 },
      ],
    };
    // Titik tengah celah 49|50 = 49,5 → masuk bin bawah; 49,6 → bin atas.
    expect(applyCalibration(table, 49.5).probability).toBe(0.2);
    expect(applyCalibration(table, 49.6).probability).toBe(0.8);
    // Terkalibrasi sempurna: bin bawah 1/5 menang (pred 0,2), bin atas 4/5 (pred 0,8) → ECE 0.
    // Brier: bawah 0,64 + 4·0,04 = 0,8; atas 4·0,04 + 0,64 = 0,8 → 1,6/10 = 0,16.
    const good = [
      ...[1, 0, 0, 0, 0].map((win) => ({ score: 10, win })),
      ...[1, 1, 1, 1, 0].map((win) => ({ score: 90, win })),
    ];
    const r = reliabilityReport(table, good);
    expect(r.n).toBe(10);
    expect(r.ece).toBeCloseTo(0, 12);
    expect(r.brier).toBeCloseTo(0.16, 12);
    expect(r.bins[1]).toMatchObject({ n: 5 });
    expect(r.bins[1].observed).toBeCloseTo(0.8, 12);
    // Bin atas semua menang: |0,8 − 1| = 0,2 berbobot 5/10 → ECE 0,1.
    const off = [...good.slice(0, 5), ...[1, 1, 1, 1, 1].map((win) => ({ score: 90, win }))];
    expect(reliabilityReport(table, off).ece).toBeCloseTo(0.1, 12);
    expect(reliabilityReport(table, []).ece).toBeNull();
    expect(reliabilityReport(null, good)).toBeNull();
  });
});

describe('isUsableCalibration (file kalibrasi dari disk)', () => {
  const good = { version: 1, totalSamples: 120, bins: [
    { lo: 10, hi: 40, n: 60, wins: 15, probability: 0.26, lower: 0.15, upper: 0.37 },
    { lo: 41, hi: 90, n: 60, wins: 27, probability: 0.45, lower: 0.33, upper: 0.57 },
  ] };
  it('NEG-CAL-FILE-001 tabel rusak/di luar rentang ditolak; applyCalibration → null, tidak melempar', () => {
    expect(isUsableCalibration(good)).toBe(true);
    for (const bad of [
      { ...good, bins: [null] },
      { ...good, bins: [{ ...good.bins[0], probability: 1.5 }, good.bins[1]] },
      { ...good, bins: [{ ...good.bins[0], lower: undefined }, good.bins[1]] },
      { ...good, bins: [good.bins[1], good.bins[0]] },
      { ...good, totalSamples: 99 },
    ]) {
      expect(isUsableCalibration(bad)).toBe(false);
      expect(applyCalibration(bad, 50)).toBeNull();
    }
    expect(applyCalibration(good, 80)).toMatchObject({ probability: 0.45, samples: 60 });
  });
});

describe('parseCalibrationFile (CLI → worker)', () => {
  it('UNIT-CAL-FILE-001 round-trip: tabel fitCalibration dalam bentuk file CLI dapat dimuat dan dipakai pipeline', () => {
    const samples = Array.from({ length: 300 }, (_, i) => ({ score: i % 100, win: i % 100 > 60 ? 1 : (i % 3 === 0 ? 1 : 0) }));
    const table = fitCalibration(samples);
    const text = JSON.stringify({ version: 1, tables: { 'LONG:*': table, 'SHORT:15m': table, 'XX:*': table }, generatedAt: 1, meta: {} });
    const parsed = parseCalibrationFile(text);
    expect(Object.keys(parsed.tables)).toEqual(['LONG:*', 'SHORT:15m']);
    expect(applyCalibration(parsed.tables['LONG:*'], 90).probability).toBeGreaterThan(applyCalibration(parsed.tables['LONG:*'], 10).probability);
    expect(() => parseCalibrationFile('{"generatedAt":1,"table":{}}')).toThrow(/bentuk/);
    expect(() => parseCalibrationFile(JSON.stringify({ version: 1, tables: { 'LONG:*': fitCalibration(samples.slice(0, 50)) } }))).toThrow(/valid/);
  });
});
