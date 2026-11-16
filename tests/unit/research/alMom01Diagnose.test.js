// Diagnostik metodologi AL-MOM-01 (docs/29 §14–§19): probe bootstrap, struktur strata, korelasi, gabungan oracle, dan
// konsistensi dekomposisi y = y0 + Δ dengan simulasi coverage.
import { describe, expect, it } from 'vitest';

const R = await import('../../../scripts/research-al-mom-01.js');
const C = await import('../../../scripts/research-al-mom-01-coverage.js');
const X = await import('../../../scripts/research-al-mom-01-diagnose.js');

function tinyIndex({ alerts, cells, D }) {
  const store = R.createStore({ withOutcomes: true });
  for (const c of cells) {
    const t = store.strata.jarak.get(c.code) ?? new Float64Array(10);
    t[0] += c.n;
    t[1] += c.a;
    t[2] += c.b;
    store.strata.jarak.set(c.code, t);
    Object.entries({ code: c.code, day: c.day, n: c.n, a: c.a, b: c.b }).forEach(([k, v]) => store.cells.jarak[k].push(v));
  }
  store.alerts.push(...alerts);
  return { store, index: R.buildLevelIndex({ store, level: 'jarak', alerts, dayFrom: 0, D }) };
}

describe('Diagnostik AL-MOM-01', () => {
  it('UNIT-MOM01-018 probe bootstrap: coupled = runBootstrap runner (benih sama); decoupled memutus pasangan; shiftStats', () => {
    const D = 70;
    const alerts = Array.from({ length: 70 }, (_, d) => ({ day: d, y: { A: Math.sin(d), B: 0 }, code: { jarak: 1 + (d % 3) }, extreme: false }));
    // Pembanding sehari dengan alert berkorelasi dengan alert (pasangan kuat).
    const cells = Array.from({ length: 70 }, (_, d) => ({ code: 1 + (d % 3), day: d, n: 2, a: 2 * Math.sin(d) * 0.8, b: 0 }));
    const { index } = tinyIndex({ alerts, cells, D });
    const group = R.buildGroup({ name: 'main', index, alerts, dayFrom: 0 });
    const b = R.runBootstrap({ D, blockDays: 7, reps: 300, seed: 11, indexes: { jarak: index }, groups: [group] });
    const runner = R.ratioSeries(b.groups[0].full.a, b.groups[0].full.w);
    const coupled = X.probeBootstrap({ index, group, D, blockDays: 7, reps: 300, seed: 11, coupled: true });
    for (let k = 0; k < 300; k += 1) expect(coupled[k]).toBeCloseTo(runner[k], 12);
    const dec = X.probeBootstrap({ index, group, D, blockDays: 7, reps: 300, seed: 11, coupled: false });
    const sd = (a) => X.shiftStats(a, 0).se;
    // Tanpa penggandaan alert–pembanding di blok sama, kovarians hilang → SE lebih besar.
    expect(sd(dec)).toBeGreaterThan(1.5 * sd(coupled));
    const s = X.shiftStats(Float64Array.from([1, 2, 3, 4, NaN]), 2);
    expect(s).toMatchObject({ mean: 2.5, median: 3, meanShift: 0.5, medShift: 1, invalid: 1 });
    expect(s.se).toBeCloseTo(Math.sqrt(5 / 3), 12);
  });

  it('UNIT-MOM01-019 struktur strata: jumlah, hari, porsi posisi, kontribusi pembanding berjumlah m; titik = rata-rata (y − m)', () => {
    const rec = X.newRecords();
    const push = (i, day, code, alert, y, d = 0) => X.pushRecord(rec, { i, day, code: { jarak: code }, isAlert: alert, isTanpa: !alert }, y, d);
    // Strata 7: alert di i=100 (hari 4); pembanding i=95 (sebelum, hari 4), 105 (sesudah, hari 4), 300 (jauh, hari 12).
    push(95, 4, 7, false, 1.0, 0.1);
    push(100, 4, 7, true, 2.0, 0.5);
    push(105, 4, 7, false, 0.5, 0.2);
    push(300, 12, 7, false, -0.3, 0);
    // Strata 9: alert tanpa pembanding (tak cocok).
    push(400, 16, 9, true, 1.0);
    const acc = X.createAccumulator({ from: 0, to: 30 * 86_400_000 });
    X.addStrataStructure(acc, rec, 0);
    const [a, u] = acc.alerts;
    expect(u.matched).toBe(false);
    expect(a).toMatchObject({ matched: true, N: 3, days: 2, nPre: 1, nPost: 1, nFar: 1 });
    expect(a.shareDay).toBeCloseTo(2 / 3, 12);
    expect(a.shareNear).toBeCloseTo(2 / 3, 12);
    expect(a.cPre + a.cPost + a.cFar).toBeCloseTo(a.m, 12);
    expect(a.m).toBeCloseTo((1.0 + 0.5 - 0.3) / 3, 12);
    expect(a.mD).toBeCloseTo(0.3 / 3, 12);
    const sum = X.summarizeAccumulator(acc, 30);
    expect(sum.alerts).toMatchObject({ total: 2, matched: 1, matchedShare: 0.5 });
    expect(sum.estimator.point).toBeCloseTo(2.0 - a.m, 12);
    expect(sum.estimator.meanPreControl).toBeCloseTo(1.0, 12);
    expect(sum.strata.alertsPerStratum).toBe(1);
  });

  it('UNIT-MOM01-020 korelasi: pearson, korelasi antarsimbol dari jumlah terstandar, ACF return bergantian = −1', () => {
    expect(X.pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 12);
    expect(X.pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 12);
    expect(X.pearson([1, NaN, 3, 4, 5], [1, 9, 3, 4, 5])).toBeCloseTo(1, 12);
    // Dua simbol identik (z sama) → ρ̄ = 1; dua simbol berlawanan → −1.
    const z = [1, -1, 1, -1];
    const S = Float64Array.from(z, (x) => 2 * x);
    const Q = Float64Array.from(z, (x) => 2 * x * x);
    expect(X.crossCorrelation(S, Q, Float64Array.from(z, () => 2))).toBeCloseTo(1, 12);
    expect(X.crossCorrelation(new Float64Array(4), Q, Float64Array.from(z, () => 2))).toBeCloseTo(-1, 12);
    // Harga bergantian naik-turun → autokorelasi lag-1 return per jam = −1.
    const H = 3_600_000;
    const candles = Array.from({ length: 2000 }, (_, t) => ({ openTime: t * H, close: t % 2 ? 101 : 100 }));
    const acc = X.createAccumulator({ from: 0, to: 2000 * H });
    const st = X.addReturnStats(acc, candles, new Float64Array(2000).fill(1), 0);
    expect(st.acf1).toBeCloseTo(-1, 6);
  });

  it('UNIT-MOM01-021 oracle: rata-rata strata leave-one-out dari draw lain; plug-in memakai sel sendiri', () => {
    // Dua draw, satu strata (kode 5). Draw 0: alert y0=1, Δ=0,5; sel sendiri n=2, Σy0=0,4, ΣΔ=0,2. Draw 1: n=3, Σy0=0,9, ΣΔ=0.
    // Draw 1 juga punya alert di kode 7 yang tak cocok di draw sendiri (n sendiri 0): hanya ikut "oracle semua", dengan
    // pembanding sel 7 dari draw 2.
    const d0 = { codes: Float64Array.from([5]), vals: Float64Array.from([2, 0.4, 0.2]), alerts: Float64Array.from([5, 1, 0.5, 2, 0.4, 0.2]) };
    const d1 = { codes: Float64Array.from([5]), vals: Float64Array.from([3, 0.9, 0]), alerts: Float64Array.from([7, -1, 0, 0, 0, 0]) };
    const d2 = { codes: Float64Array.from([7]), vals: Float64Array.from([4, 0.8, 0.4]), alerts: new Float64Array(0) };
    const [r0, r1] = X.oracleCombine([d0, d1, d2]);
    expect(r0.plugBase).toBeCloseTo(1 - 0.4 / 2, 12);
    expect(r0.oracleBase).toBeCloseTo(1 - 0.9 / 3, 12);
    expect(r0.plugDrift).toBeCloseTo(0.5 - 0.1, 12);
    expect(r0.oracleDrift).toBeCloseTo(0.5, 12);
    expect(r0.oracleAllBase).toBeCloseTo(r0.oracleBase, 12);
    expect(r1).toMatchObject({ n: 0, nAll: 1, nTotal: 1, plugBase: null });
    expect(r1.oracleAllBase).toBeCloseTo(-1 - 0.8 / 4, 12);
    expect(r1.oracleAllDrift).toBeCloseTo(0 - 0.4 / 4, 12);
  });

  it('UNIT-MOM01-022 dekomposisi sama dengan simulasi coverage (benih sama); historis menolak --to > 2026-11-16', async () => {
    const sc = { ...C.SCENARIOS.dasar025, symbols: 6, days: 200, delta: 0.3 };
    const d = X.diagnoseSimulation(sc, 4242, 199, { blocks: [7] });
    const c = C.analyzeSimulation(sc, 4242, 199, { blocks: [7] });
    expect(d.n).toBe(c.matched);
    expect(d.point.full).toBeCloseTo(c.pointA, 12);
    expect(d.point.drift).toBeCloseTo(c.thetaD, 12);
    expect(d.point.base + d.point.drift).toBeCloseTo(d.point.full, 12);
    expect(d.boot[7].probeCoupledMatches).toBe(true);
    expect(d.boot[7].ci.percentile.lo).toBeCloseTo(c.ci.percentile.lo, 12);
    expect(d.character.alerts.total).toBe(c.alerts);
    await expect(X.historical({ from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 10, 17), cacheDir: '/nonexistent', replayCache: '/nonexistent/x.json' }))
      .rejects.toThrow(/2026-11-16/);
  });
});
