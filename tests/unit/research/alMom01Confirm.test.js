import { describe, expect, it } from 'vitest';
import { PAIRS, evaluate, evaluatePair, populationTarget, renderMarkdown, rowsOf, verdict } from '../../../scripts/research-al-mom-01-confirm.js';

// Fixture buatan (bukan hasil simulasi): baris [titik, θ_d, pers lo, hi, basic lo, hi, BC lo, hi].
const scenario = (name, runs, extra = {}) => ({ name, sims: runs.length, failed: 0, delta: 0, thetaInfo: 0, methods: { full7: { invalidReps: 0 } }, runs, ...extra });
const zeroRuns = (n, falsePos) => Array.from({ length: n }, (_, k) => {
  const lo = k < falsePos ? 0.01 : -0.1;
  return [0, 0, lo, lo + 0.2, lo - 0.02, lo + 0.18, lo, lo + 0.2];
});

describe('evaluasi simulasi konfirmasi (docs/29 §21)', () => {
  it('UNIT-MOM01-023 batas atas gabungan = maks(persentil, basic); T2 dari rata-rata antar-konfigurasi oracle', () => {
    const [r] = rowsOf(scenario('x', [[0.2, 0.25, 0.05, 0.24, 0.07, 0.27, 0.06, 0.26]]));
    expect(r.union).toEqual({ lo: 0.05, hi: 0.27 });
    const t2 = populationTarget({ draws: 10, perConfig: [{ oracleAllBase: 0, oracleAllDrift: 0.3 }, { oracleAllBase: 0.02, oracleAllDrift: 0.28 }, { oracleAllBase: -0.01, oracleAllDrift: 0.31 }] });
    expect(t2.value).toBeCloseTo(0.3, 12);
    expect(t2.configs).toBe(3);
    expect(t2.mcSe).toBeCloseTo(0, 12);
  });

  it('UNIT-MOM01-024 K1 superioritas palsu (Wilson) dan K2/K3 "< M" terhadap T4 dan T2', () => {
    const pair = PAIRS.find((p) => p[0] === 'dasar');
    // 4/200 = 2% lo > 0 → batas bawah Wilson < 2,5% → lulus; 20/200 = 10% → gagal.
    const pass = evaluatePair(pair, { zero: scenario('dasar0', zeroRuns(200, 4)) });
    expect(pass.criteria.K1.metric.p).toBeCloseTo(0.02, 12);
    expect(pass.criteria.K1.pass).toBe(true);
    expect(pass.zero.t2).toMatchObject({ value: 0, byConstruction: true });
    const fail = evaluatePair(pair, { zero: scenario('dasar0', zeroRuns(200, 20)) });
    expect(fail.criteria.K1.pass).toBe(false);
    // Efek ≈ margin: titik 0,22 → T4 = 0,22. hi persentil 0,21 (< T4) tetapi basic 0,30 → gabungan 0,30 (≥ T4).
    const runs = Array.from({ length: 100 }, (_, k) => [0.22, 0.25, 0.1, k < 30 ? 0.21 : 0.35, 0.12, k < 3 ? 0.2 : 0.3, 0.1, 0.33]);
    const m = evaluatePair(pair, { margin: scenario('dasar025', runs, { delta: 0.29, thetaInfo: 0.25 }), t2margin: { value: 0.3, mcSe: 0.005 } });
    expect(m.margin.t4.value).toBeCloseTo(0.22, 12);
    expect(m.margin.vsT4.percentile.hiBelow.p).toBeCloseTo(0.3, 12);
    expect(m.margin.vsT4.union.hiBelow.p).toBeCloseTo(0.03, 12);
    expect(m.criteria.K2.pass).toBe(true);
    // T2 0,30: semua batas atas gabungan (0,20 / 0,21… 0,30 / 0,35) — hi < 0,30 pada 3 baris (basic 0,20 & persentil 0,21).
    expect(m.margin.vsT2.union.hiBelow.p).toBeCloseTo(0.03, 12);
    expect(m.criteria.K3.large).toBe(false);
    expect(m.margin.t2Sensitivity).toHaveLength(2);
  });

  it('UNIT-MOM01-025 vonis: realistis gagal → tinjau desain; ekstrem gagal → pembatasan klaim; T2 hilang → belum lengkap', () => {
    const fake = (name, klass, k1, extra = {}) => ({ name, klass, zero: { t2: { value: 0 } }, margin: { t2: { value: 0.3 } }, criteria: { K1: { pass: k1 }, K2: { pass: true }, K4: { pass: true }, K5: { pass: true } }, ...extra });
    expect(verdict([fake('a', 'realistis', true), fake('b', 'ekstrem', true)]).summary).toBe('LULUS');
    expect(verdict([fake('a', 'realistis', true), fake('b', 'ekstrem', false)])).toMatchObject({ summary: 'LULUS DENGAN PEMBATASAN KLAIM', restrictClaims: ['b'] });
    expect(verdict([fake('a', 'realistis', false)])).toMatchObject({ summary: 'TINJAU DESAIN (tidak dibekukan)', designReview: ['a'] });
    expect(verdict([fake('a', 'realistis', true, { margin: { t2: null } })])).toMatchObject({ summary: 'BELUM LENGKAP', missing: ['a'] });
    // evaluate: δ oracle ≠ δ coverage → peringatan, T2 tidak dipakai; laporan markdown terbentuk.
    const res = evaluate({
      coverage: [{ scenarios: [scenario('dasar0', zeroRuns(40, 0)), scenario('dasar025', zeroRuns(40, 0), { delta: 0.29 })] }],
      oracle: [{ scenario: 'dasar025', set: { delta: 0.3 }, draws: 10, perConfig: [{ oracleAllBase: 0, oracleAllDrift: 0.3 }] }],
    });
    expect(res.warnings[0]).toMatch(/δ oracle 0.3 ≠ δ coverage 0.29/);
    expect(res.pairs.find((p) => p.name === 'dasar').margin.t2).toBeNull();
    expect(renderMarkdown({ generatedAt: 'x', ...res })).toContain('BELUM LENGKAP');
  });
});
