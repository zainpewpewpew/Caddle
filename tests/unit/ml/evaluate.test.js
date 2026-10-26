// Evaluasi meta-labeling walk-forward: aturan adopsi, purging, kontrol label acak.
import { describe, expect, it } from 'vitest';
import { ML_ADOPTION_RULES, evaluateMetaModels } from '../../../backend/ml/evaluate.js';
import { META_FEATURE_NAMES } from '../../../backend/ml/metaFeatures.js';
import { mulberry32 } from '../../../backend/ml/metrics.js';
import { mlSection } from '../../../backend/backtest/report.js';
import { parseBacktestArgs } from '../../../scripts/lib/backtestArgs.js';

const HOUR = 3_600_000;
const P = META_FEATURE_NAMES.length;

/**
 * Trade sintetis berurutan waktu (±12 per hari). edge(x) = peluang trade untung; R untung +2 / rugi −1.
 * Skor konfluensi acak (tidak informatif) sehingga kalibrasi isotonik ≈ base rate.
 */
function trades(n, seed, edge) {
  const rand = mulberry32(seed);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const ml = Array.from({ length: P }, () => rand());
    const win = rand() < edge(ml);
    const entryTime = Date.UTC(2024, 0, 1) + i * 2 * HOUR;
    out.push({
      outcome: win ? 'WIN' : 'LOSS', rMultiple: win ? 2 : -1, entryTime, exitTime: entryTime + 6 * HOUR, score: rand() * 100, ml,
    });
  }
  return out;
}

describe('evaluateMetaModels', () => {
  it('UNIT-ML-EVAL-001 fitur tanpa informasi → TIDAK diadopsi, kontrol acak tanpa skill', () => {
    const r = evaluateMetaModels(trades(2500, 1, () => 0.3), { resamples: 300 });
    expect(r.samples).toBe(2500);
    expect(r.folds).toHaveLength(5);
    expect(r.verdict.adopted).toBe(false);
    expect(r.verdict.leakageSuspected).toBe(false);
    expect(r.models.logistic.skill).toBeLessThan(0.01);
    expect(r.controls.logisticShuffled.skill).toBeLessThan(ML_ADOPTION_RULES.maxControlSkill);
    expect(r.verdict.reasons.join(' ')).toMatch(/expectancy/);
  }, 60_000);

  it('UNIT-ML-EVAL-002 edge tertanam pada fitur → diadopsi; seleksi menaikkan expectancy secara signifikan', () => {
    const r = evaluateMetaModels(trades(2500, 2, (x) => (x[19] < 0.3 ? 0.65 : 0.25)), { resamples: 300 });
    expect(r.verdict.adopted).toBe(true);
    expect(['logistic', 'gbdt']).toContain(r.verdict.model);
    expect(r.models[r.verdict.model].logLoss).toBeLessThan(r.models.isotonic.logLoss);
    expect(r.economics[r.verdict.model].lift.lower).toBeGreaterThan(0);
    expect(r.selection[r.verdict.model].expectancyR).toBeGreaterThan(r.selection.all.expectancyR);
    expect(r.coefficients[0].name).toBe(META_FEATURE_NAMES[19]);
    const md = mlSection(r, { source: 'csv' }).join('\n');
    expect(md).toContain('LOLOS aturan adopsi');
    expect(md).toContain('Bukti ekonomi');
    expect(md).not.toContain('Data sintetis');
  }, 60_000);

  it('UNIT-ML-EVAL-003 purging & embargo: train fold hanya trade yang SUDAH keluar sebelum awal uji', () => {
    const list = trades(1500, 3, () => 0.4).map((t, i) => (i % 3 === 0 ? { ...t, exitTime: t.entryTime + 200 * HOUR } : t));
    const embargoMs = 24 * HOUR;
    const r = evaluateMetaModels(list, { embargoMs, resamples: 100 });
    for (const f of r.folds) {
      const expected = list.filter((t) => t.entryTime < f.testStart - embargoMs && t.exitTime < f.testStart).length;
      expect(f.train).toBe(expected);
    }
  }, 60_000);

  it('NEG-ML-EVAL-001 data kurang, trade OPEN/tanpa fitur dibuang, tidak pernah adopsi', () => {
    const few = evaluateMetaModels(trades(100, 4, () => 0.9));
    expect(few.verdict.adopted).toBe(false);
    expect(few.verdict.reasons[0]).toMatch(/terlalu sedikit/);
    const mixed = [...trades(50, 5, () => 0.5), { outcome: 'OPEN', rMultiple: 0, entryTime: 1, exitTime: 2, ml: new Array(P).fill(0) },
      { outcome: 'WIN', rMultiple: 2, entryTime: 1, exitTime: 2, ml: [1, 2] }];
    expect(evaluateMetaModels(mixed).samples).toBe(50);
    expect(evaluateMetaModels(null).verdict.adopted).toBe(false);
  });

  it('UNIT-ML-CLI-001 opsi --ml pada CLI backtest; laporan tanpa hasil ML tidak memuat bagian ML', () => {
    expect(parseBacktestArgs(['--synthetic', '--ml']).ml).toBe(true);
    expect(parseBacktestArgs(['--synthetic']).ml).toBe(false);
    expect(mlSection(null)).toEqual([]);
  });
});
