// Diagnostik overlap & bootstrap AL-MOM-01 (docs/27 §9): indeks sel pembanding, SMD, bootstrap yang mengulang prosedur
// vs bootstrap alert saja, fallback pencocokan, dan serialisasi agregat.
import { describe, expect, it } from 'vitest';
import { addControl, DAY_MS } from '../../../backend/research/matchedBaseline.js';
import { addCell, cappedDistance, distanceBin } from '../../../scripts/research-mom-power.js';
import {
  analyzeOverlap, buildCellIndex, covariateBalance, deserializeOverlapAcc, parseStratum, procedureBootstrap,
  renderOverlapMarkdown, serializeOverlapAcc, strataTotals, subsetIndex, windowedPower,
} from '../../../scripts/research-mom-overlap.js';

const cov = (pre = 1, pos = 0.5, atr = 0.01, dist = 49) => ({ pre, pos, atr, dist });

describe('diagnostik overlap AL-MOM-01', () => {
  it('UNIT-MOM-007 kunci strata, sel pembanding, total strata, jarak terpotong, dan SMD', () => {
    expect(parseStratum('BTCUSDT|2026-Q4|4|3|1|d12')).toEqual({
      symbol: 'BTCUSDT', period: '2026-Q4', preBin: 4, posBin: 3, volBin: 1, dist: 'd12', base: 'BTCUSDT|2026-Q4|4|3|1',
    });
    expect([null, 60, 49, 48, 3].map(cappedDistance)).toEqual([49, 49, 49, 48, 3]);
    const cells = new Map();
    addCell(cells, 'S|Q|1|1|0|d12#100', { fwd12: 1, rAtr: 0.5 }, cov(2, 0.4, 0.02, 5));
    addCell(cells, 'S|Q|1|1|0|d12#100', { fwd12: 3, rAtr: -0.5 }, cov(4, 0.6, 0.02, 7));
    addCell(cells, 'S|Q|1|1|0|jauh#101', { fwd12: -1, rAtr: 0 }, cov(0, 0.2, 0.01, 49));
    expect(cells.get('S|Q|1|1|0|d12#100')).toEqual([2, 4, 0, 6, 1, 0.04, 12]);
    const idx = buildCellIndex(cells);
    expect(idx.size).toBe(2);
    expect(idx.strata.size).toBe(2);
    expect(idx.baseKeys.size).toBe(1);
    const jarak = strataTotals(idx, 'jarak');
    const dasar = strataTotals(idx, 'dasar');
    expect([...jarak.N]).toEqual([2, 1]);
    expect([...dasar.N]).toEqual([3]);
    expect(dasar.S[0][0]).toBe(3); // ΣA = 1 + 3 − 1
    // SMD: alert pre 3 dan 5 (rata-rata 4, SD √2) vs rata-rata pembanding strata (2 + 4)/2 = 3 → (4 − 3)/√2.
    const bal = covariateBalance({
      alerts: [{ s: 0, cov: cov(3, 0.5, 0.02, 6) }, { s: 0, cov: cov(5, 0.5, 0.02, 6) }], totals: jarak,
    });
    expect(bal.pre.smd).toBeCloseTo((4 - 3) / Math.SQRT2, 10);
    expect(bal.pre.control).toBe(3);
  });

  it('UNIT-MOM-008 bootstrap prosedur: sama dengan alert saja bila pembanding konstan; berbeda bila pembanding berubah', () => {
    const d0 = 20_000;
    const build = (ctrlValue) => {
      const cells = new Map();
      for (let d = 0; d < 120; d += 1) {
        for (let k = 0; k < 3; k += 1) addCell(cells, `S|Q|0|0|0|jauh#${d0 + d}`, { fwd12: ctrlValue(d, k), rAtr: 0 }, cov());
      }
      return buildCellIndex(cells);
    };
    const alerts = Array.from({ length: 120 }, (_, d) => ({ s: 0, day: d0 + d, y: { fwd12: (d % 7) / 10, rAtr: (d % 5) / 10 } }));
    const flat = procedureBootstrap({ alerts, idx: build(() => 0.2), level: 'jarak', reps: 300 });
    expect(flat.full.A.lo).toBeCloseTo(flat.alertsOnly.A.lo, 12);
    expect(flat.full.A.hi).toBeCloseTo(flat.alertsOnly.A.hi, 12);
    expect(flat.full.A.mean).toBeCloseTo(alerts.reduce((s, a) => s + a.y.fwd12, 0) / alerts.length - 0.2, 12);
    expect(flat.matchedShareMin).toBe(1);
    // Tanpa alert yang terbuang, versi "himpunan sama" identik dengan versi alert saja.
    expect(flat.sameSet.A.lo).toBeCloseTo(flat.alertsOnly.A.lo, 12);
    expect(flat.sameSet.A.hi).toBeCloseTo(flat.alertsOnly.A.hi, 12);
    // Pembanding yang berubah antarhari: rata-rata strata ikut berubah per replikasi → CI prosedur berbeda.
    const moving = procedureBootstrap({ alerts, idx: build((d, k) => Math.sin(d / 9) + k / 10), level: 'jarak', reps: 300 });
    expect(moving.full.A.se).not.toBeCloseTo(moving.alertsOnly.A.se, 6);
    expect(moving.full.A.reps).toBe(300);
  });

  it('UNIT-MOM-009 analisis ujung ke ujung: fallback, alert tak cocok, SMD, bootstrap, serialisasi, markdown', () => {
    const acc = { controls: { tanpa: new Map(), tanpaJarak: new Map() }, alerts: [], cells: new Map() };
    let seed = 7;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const t0 = Date.UTC(2025, 0, 1);
    for (let s = 0; s < 6; s += 1) {
      const symbol = `S${s}USDT`;
      for (let d = 0; d < 200; d += 1) {
        const dayIdx = Math.floor((t0 + d * DAY_MS) / DAY_MS);
        const base = `${symbol}|2025-Q1|${d % 3}|2|1`;
        // Pembanding hanya di bin jarak 'jauh' dan 'd48' → alert di bin 'd12' tidak cocok pada strata + jarak.
        for (const dist of ['jauh', 'd48']) {
          const y = { fwd12: rnd() - 0.5, rAtr: (rnd() - 0.5) / 2 };
          const c = cov(rnd() * 3, rnd(), 0.01, dist === 'jauh' ? 49 : 30);
          addControl(acc.controls.tanpa, base, y);
          addControl(acc.controls.tanpaJarak, `${base}|${dist}`, y);
          addCell(acc.cells, `${base}|${dist}#${dayIdx}`, y, c);
        }
        const sincePrev = d % 4 === 0 ? 5 : d % 4 === 1 ? 30 : null;
        acc.alerts.push({
          key: base, keyJarak: `${base}|${distanceBin(sincePrev)}`, y: { fwd12: rnd() - 0.4, rAtr: (rnd() - 0.45) / 2 },
          t: t0 + d * DAY_MS + 3_600_000, symbol, sincePrev, atrPct: 0.01, pre: rnd() * 3, pos: rnd(),
        });
      }
    }
    const back = deserializeOverlapAcc(serializeOverlapAcc(acc));
    expect(back.cells.size).toBe(acc.cells.size);
    const r = analyzeOverlap({ acc: back, reps: 200 });
    expect(r.levels.dasar.share).toBe(1);
    expect(r.levels.jarak.share).toBeCloseTo(0.75, 10); // seperempat alert di bin d12 tanpa pembanding
    expect(r.levels.fallback).toMatchObject({ share: 1, fromBase: 300 });
    expect(r.unmatchedProfile.unmatched.distance).toEqual({ d12: 1 });
    expect(r.levels.jarak.bootstrap.matchedShareMean).toBe(1);
    expect(Object.keys(r.levels.jarak.balance)).toEqual(['pre', 'pos', 'atr', 'dist']);
    const md = renderOverlapMarkdown({ ...r, generatedAt: 'uji', from: '2025-01-01', to: '2025-07-20' });
    expect(md).toContain('## Bootstrap yang mengulang prosedur');
    expect(md).toContain('Jarak dari alert sebelumnya');
    // Data 200 hari tidak memuat jendela 12/24 bulan → analisis per jendela kosong (null), bukan angka palsu.
    expect(analyzeOverlap({ acc: back, reps: 100, from: t0, to: t0 + 200 * DAY_MS }).windowed).toBeNull();
  });

  it('UNIT-MOM-010 SE per jendela: sub-indeks hari, jendela bergeser, daya & efek terkecil terdeteksi', () => {
    const from = Date.UTC(2024, 0, 1);
    const to = Date.UTC(2026, 9, 1);
    const cells = new Map();
    const alerts = [];
    let seed = 3;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const strata = new Map();
    for (let t = from; t < to; t += DAY_MS) {
      const q = `${new Date(t).getUTCFullYear()}-Q${Math.floor(new Date(t).getUTCMonth() / 3) + 1}`;
      const key = `S|${q}|0|0|0|jauh`;
      const d = Math.floor(t / DAY_MS);
      for (let k = 0; k < 2; k += 1) addCell(cells, `${key}#${d}`, { fwd12: rnd() - 0.5, rAtr: (rnd() - 0.5) / 2 }, cov());
      if (!strata.has(key)) strata.set(key, true);
      alerts.push({ key, day: d, y: { fwd12: rnd() - 0.45, rAtr: (rnd() - 0.48) / 2 } });
    }
    const idx = buildCellIndex(cells);
    const sub = subsetIndex(idx, Math.floor(Date.UTC(2025, 0, 1) / DAY_MS), Math.floor(Date.UTC(2026, 0, 1) / DAY_MS));
    expect(sub.size).toBe(365); // satu sel per hari (dua candle pembanding digabung dalam sel yang sama)
    expect([...sub.n].every((n) => n === 2)).toBe(true);
    expect(sub.strata).toBe(idx.strata);
    const totals = strataTotals(idx, 'jarak');
    const bAlerts = alerts.map((a) => ({ s: idx.strata.get(a.key), day: a.day, y: a.y }));
    const w = windowedPower({ alerts: bAlerts, idx, totals, from, to, reps: 100, effect: { A: 0, B: 0 } });
    expect(w.windows[12]).toHaveLength(8);
    expect(w.windows[24]).toHaveLength(4);
    expect(w.summary[24].A.full).toBeLessThan(w.summary[12].A.full);
    expect(w.power).toHaveLength(8);
    for (const p of w.power) {
      expect(p.m24).toBeGreaterThanOrEqual(p.m12);
      expect(p.m24).toBeLessThanOrEqual(1);
    }
    expect(w.mde.A[24]).toBeCloseTo((1.959964 + 0.841621) * w.summary[24].A.full, 10);
  });
});
