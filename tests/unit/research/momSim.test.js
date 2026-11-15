// Simulasi daya AL-MOM-01 100 koin (docs/27 §7): daya uji batas atas, jendela bergeser, subset simbol, model bagian
// bersama, kelompok jarak alert, serialisasi agregat, dan analisis ujung ke ujung pada agregat sintetis.
import { describe, expect, it } from 'vitest';
import { addControl } from '../../../backend/research/matchedBaseline.js';
import { distanceBin } from '../../../scripts/research-mom-power.js';
import {
  Z_ONE, Z_TWO, analyzeMomSim, deserializeAcc, fitCommonComponent, monthsForUpperBound, normalCdf, renderMomSimMarkdown,
  rollingWindows, sampleSymbols, serializeAcc, upperBoundPower,
} from '../../../scripts/research-mom-sim.js';

describe('simulasi daya AL-MOM-01', () => {
  it('UNIT-MOM-004 Φ, daya uji batas atas satu/dua sisi, dan bulan untuk daya 80%', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(Z_TWO)).toBeCloseTo(0.975, 6);
    expect(normalCdf(-Z_ONE)).toBeCloseTo(0.05, 6);
    // Margin 0,25, efek 0,09, SE 0,0583: Φ(0,16/0,0583 − 1,96) ≈ 0,783 (dua sisi), lebih besar bila satu sisi.
    const two = upperBoundPower({ margin: 0.25, effect: 0.09, se: 0.0583, z: Z_TWO });
    expect(two).toBeCloseTo(0.783, 2);
    expect(upperBoundPower({ margin: 0.25, effect: 0.09, se: 0.0583, z: Z_ONE })).toBeGreaterThan(two);
    expect(upperBoundPower({ margin: 0.25, effect: 0.09, se: 0, z: Z_TWO })).toBeNull();
    // Konsisten: SE pada bulan hasil monthsForUpperBound memberi daya 80%.
    const months = monthsForUpperBound({ margin: 0.25, effect: 0.09, se0: 0.06, months0: 24, z: Z_TWO });
    expect(upperBoundPower({ margin: 0.25, effect: 0.09, se: 0.06 * Math.sqrt(24 / months), z: Z_TWO })).toBeCloseTo(0.8, 3);
    expect(monthsForUpperBound({ margin: 0.1, effect: 0.12, se0: 0.06, months0: 24, z: Z_TWO })).toBeNull();
  });

  it('UNIT-MOM-005 jendela bergeser per kuartal, subset simbol deterministik, model SE² = a + b/k, kelompok jarak', () => {
    const w12 = rollingWindows({ from: Date.UTC(2024, 0, 1), to: Date.UTC(2026, 9, 1), months: 12 });
    expect(w12).toHaveLength(8);
    expect(w12[0].label).toBe('2024-01 → 2024-12');
    expect(w12.at(-1).label).toBe('2025-10 → 2026-09');
    expect(rollingWindows({ from: Date.UTC(2024, 0, 1), to: Date.UTC(2026, 9, 1), months: 24 })).toHaveLength(4);
    const syms = Array.from({ length: 30 }, (_, i) => `S${String(i).padStart(2, '0')}USDT`);
    const a = sampleSymbols(syms, 10, 5);
    expect(a).toHaveLength(10);
    expect(new Set(a).size).toBe(10);
    expect(sampleSymbols(syms, 10, 5)).toEqual(a);
    expect(sampleSymbols(syms, 10, 6)).not.toEqual(a);
    const pts = [10, 25, 50, 100].map((k) => ({ k, se: Math.sqrt(0.001 + 0.05 / k) }));
    const fit = fitCommonComponent(pts);
    expect(fit.a).toBeCloseTo(0.001, 10);
    expect(fit.b).toBeCloseTo(0.05, 10);
    expect([null, 49, 48, 13, 12, 1].map(distanceBin)).toEqual(['jauh', 'jauh', 'd48', 'd48', 'd12', 'd12']);
  });

  it('UNIT-MOM-006 analisis ujung ke ujung pada agregat sintetis + serialisasi agregat', () => {
    // 12 simbol × 33 bulan; tiap hari satu alert per simbol dengan selisih +0,1 ATR / +0,04R terhadap pembanding.
    const from = Date.UTC(2024, 0, 1);
    const to = Date.UTC(2026, 9, 1);
    const acc = { controls: { tanpa: new Map(), lampau: new Map(), tanpaJarak: new Map() }, alerts: [], alertTrades: [], symbolMonths: new Set() };
    let s = 1;
    const rnd = () => {
      s = (s * 16807) % 2147483647;
      return s / 2147483647;
    };
    for (let k = 0; k < 12; k += 1) {
      const symbol = `S${k}USDT`;
      for (let t = from; t < to; t += 86_400_000) {
        acc.symbolMonths.add(`${symbol}|${new Date(t).toISOString().slice(0, 7)}`);
        const key = `${symbol}|${new Date(t).toISOString().slice(0, 7)}`;
        const sincePrev = rnd() < 0.8 ? 1 + Math.floor(rnd() * 48) : null;
        const keyJarak = `${key}|${distanceBin(sincePrev)}`;
        for (let c = 0; c < 3; c += 1) {
          const y = { fwd12: rnd() - 0.5, rAtr: (rnd() - 0.5) / 2 };
          addControl(acc.controls.tanpa, key, y);
          addControl(acc.controls.lampau, key, y);
          addControl(acc.controls.tanpaJarak, keyJarak, y);
        }
        acc.alerts.push({ key, keyJarak, y: { fwd12: rnd() - 0.4, rAtr: (rnd() - 0.42) / 2 }, t: t + 3_600_000, symbol, sincePrev, atrPct: 0.01 });
      }
    }
    const r = analyzeMomSim({ acc, from, to, baseSymbols: ['S0USDT', 'S1USDT', 'S2USDT'] });
    expect(r.symbols).toBe(12);
    expect(r.rates.lama.symbols).toBe(3);
    expect(r.full.matchRate).toBe(1);
    expect(r.windows[12]).toHaveLength(8);
    expect(r.windows[24]).toHaveLength(4);
    expect(r.seSummary[24].A.median).toBeLessThan(r.seSummary[12].A.median);
    expect(r.subsets.map((x) => x.k)).toEqual([10, 12]);
    expect(r.distance.bins.reduce((a, b) => a + b.alertShare, 0)).toBeCloseTo(1, 10);
    // Biaya pulang-pergi 14 bps pada ATR 1% = 0,14 ATR = 0,0933R.
    expect(r.cost.atr.p50).toBeCloseTo(0.14, 10);
    expect(r.cost.r.p50).toBeCloseTo(0.14 / 1.5, 10);
    expect(r.power.filter((p) => !p.kind)).toHaveLength(8);
    expect(renderMomSimMarkdown({ ...r, generatedAt: 'x', from: '2024-01-01', to: '2026-10-01' })).toContain('## Daya uji batas atas');
    const back = deserializeAcc(serializeAcc(acc));
    expect(back.controls.tanpaJarak.size).toBe(acc.controls.tanpaJarak.size);
    expect([...back.symbolMonths]).toEqual([...acc.symbolMonths]);
    expect(back.alerts[5]).toEqual(acc.alerts[5]);
  });
});
