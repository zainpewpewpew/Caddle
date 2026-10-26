// Model ML murni JS (regresi logistik L2, gradient boosting dangkal) dan metrik peluang.
import { describe, expect, it } from 'vitest';
import { fitGbdt, predictGbdt } from '../../../backend/ml/gbdt.js';
import { fitLogistic, predictLogistic } from '../../../backend/ml/logistic.js';
import { auc, blockBootstrap, blockBootstrapMean, logLoss, mulberry32 } from '../../../backend/ml/metrics.js';
import { fitPreprocess, standardize } from '../../../backend/ml/preprocess.js';

/** Data berbenih: y ~ Bernoulli(sigmoid(f(x))). */
function dataset(n, seed, f, p = 4) {
  const rand = mulberry32(seed);
  const X = [];
  const y = [];
  for (let i = 0; i < n; i += 1) {
    const x = Array.from({ length: p }, () => rand() * 2 - 1);
    X.push(x);
    y.push(rand() < 1 / (1 + Math.exp(-f(x))) ? 1 : 0);
  }
  return { X, y };
}
const pairs = (predict, { X, y }) => X.map((x, i) => ({ p: predict(x), y: y[i] }));

describe('metrik peluang', () => {
  it('UNIT-ML-MET-001 log-loss, AUC (sempurna, terbalik, seri) dan PRNG deterministik', () => {
    expect(logLoss([{ p: 0.5, y: 1 }, { p: 0.5, y: 0 }])).toBeCloseTo(Math.log(2), 10);
    expect(logLoss([])).toBeNull();
    expect(auc([{ p: 0.9, y: 1 }, { p: 0.1, y: 0 }])).toBe(1);
    expect(auc([{ p: 0.1, y: 1 }, { p: 0.9, y: 0 }])).toBe(0);
    expect(auc([{ p: 0.5, y: 1 }, { p: 0.5, y: 0 }])).toBe(0.5);
    expect(auc([{ p: 0.5, y: 1 }])).toBeNull();
    const a = mulberry32(5);
    const b = mulberry32(5);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('UNIT-ML-MET-002 bootstrap blok per hari: deterministik, interval memuat rata-rata, < 2 blok → null', () => {
    const items = Array.from({ length: 200 }, (_, i) => ({ day: i % 20, diff: (i % 7) - 2 }));
    const r1 = blockBootstrapMean(items, { seed: 3 });
    const r2 = blockBootstrapMean(items, { seed: 3 });
    expect(r1).toEqual(r2);
    expect(r1.blocks).toBe(20);
    expect(r1.lower).toBeLessThanOrEqual(r1.mean);
    expect(r1.upper).toBeGreaterThanOrEqual(r1.mean);
    expect(blockBootstrapMean([{ day: 1, diff: 1 }, { day: 1, diff: 2 }])).toBeNull();
    expect(blockBootstrap(items, () => null)).toBeNull();
  });
});

describe('praproses hanya dari train', () => {
  it('UNIT-ML-PRE-001 NaN diimputasi median train, kolom konstan → 0 (bukan NaN)', () => {
    const prep = fitPreprocess([[1, 5], [3, 5], [NaN, 5]]);
    expect(prep.medians).toEqual([2, 5]);
    const z = standardize(prep, [NaN, 5]);
    expect(z.every(Number.isFinite)).toBe(true);
    expect(z[1]).toBe(0);
    expect(() => fitPreprocess([])).toThrow(RangeError);
  });
});

describe('regresi logistik L2', () => {
  it('UNIT-ML-LOG-001 mempelajari hubungan linear tertanam & menggeneralisasi ke data baru', () => {
    const f = (x) => 2 * x[0] - 1.5 * x[1];
    const train = dataset(2000, 1, f);
    const test = dataset(1000, 2, f);
    const m = fitLogistic(train.X, train.y);
    expect(m.weights[0]).toBeGreaterThan(0.3);
    expect(m.weights[1]).toBeLessThan(-0.3);
    expect(Math.abs(m.weights[2])).toBeLessThan(0.2);
    expect(auc(pairs((x) => predictLogistic(m, x), test))).toBeGreaterThan(0.75);
    expect(fitLogistic(train.X, train.y)).toEqual(m); // deterministik
  });

  it('UNIT-ML-LOG-002 label acak → AUC uji ≈ 0,5; input tidak valid ditolak', () => {
    const train = dataset(1500, 3, () => 0);
    const test = dataset(1500, 4, () => 0);
    const m = fitLogistic(train.X, train.y);
    expect(Math.abs(auc(pairs((x) => predictLogistic(m, x), test)) - 0.5)).toBeLessThan(0.05);
    expect(() => fitLogistic([], [])).toThrow(RangeError);
    expect(() => fitLogistic([[1]], [1, 0])).toThrow(RangeError);
  });
});

describe('gradient boosting dangkal', () => {
  it('UNIT-ML-GBM-001 mempelajari interaksi non-linear (XOR) yang tidak bisa ditangkap logistik', () => {
    const f = (x) => (x[0] * x[1] > 0 ? 2 : -2);
    const train = dataset(3000, 5, f);
    const test = dataset(1500, 6, f);
    const g = fitGbdt(train.X, train.y);
    const l = fitLogistic(train.X, train.y);
    const aucG = auc(pairs((x) => predictGbdt(g, x), test));
    const aucL = auc(pairs((x) => predictLogistic(l, x), test));
    expect(aucG).toBeGreaterThan(0.7);
    expect(aucL).toBeLessThan(0.6);
    expect(fitGbdt(train.X, train.y)).toEqual(g); // deterministik
  });

  it('UNIT-ML-GBM-002 peluang selalu di (0, 1), NaN ditangani, minLeaf mencegah daun kecil', () => {
    const { X, y } = dataset(300, 7, (x) => x[0]);
    X[0][0] = NaN;
    const g = fitGbdt(X, y, { minLeaf: 200 });
    // 300 baris < 2·minLeaf → setiap pohon hanya satu daun (tidak bisa membelah).
    expect(g.trees.every((t) => t.leaf !== undefined)).toBe(true);
    const p = predictGbdt(g, [NaN, 0, 0, 0]);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
    expect(() => fitGbdt(X, y, { depth: 0 })).toThrow(RangeError);
  });
});
