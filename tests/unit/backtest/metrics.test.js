import { describe, expect, it } from 'vitest';
import { baseRate, brierScore, groupBy, summarize, wilsonInterval } from '../../../backend/backtest/metrics.js';

const trade = (outcome, rMultiple, exitIndex, extra = {}) => ({ outcome, rMultiple, exitIndex, mfeR: 1, maeR: -0.5, barsHeld: 2, ...extra });

describe('metrik backtest', () => {
  it('UNIT-BT-MET-001 interval Wilson nilai diketahui', () => {
    // k=8, n=10, z=1,96: z²/n = 0,38416; pusat = (0,8 + 0,19208)/1,38416 = 0,71674;
    // setengah = 1,96/1,38416 · √(0,016 + 0,009604) = 0,22658 → [0,4902; 0,9433].
    const [lo, hi] = wilsonInterval(8, 10);
    expect(lo).toBeCloseTo(0.4902, 4);
    expect(hi).toBeCloseTo(0.9433, 4);
    // k=0, n=10: pusat = setengah = 0,13877 → [0; 0,2775].
    const [lo0, hi0] = wilsonInterval(0, 10);
    expect(lo0).toBeCloseTo(0, 10);
    expect(hi0).toBeCloseTo(0.2775, 4);
    expect(wilsonInterval(0, 0)).toEqual([0, 1]);
    expect(() => wilsonInterval(11, 10)).toThrow(RangeError);
  });

  it('UNIT-BT-MET-002 summarize: angka dihitung tangan, OPEN diabaikan', () => {
    // Urutan exit: 2 (WIN), −1 (LOSS), −1 (LOSS), 0,5 (TIMEOUT), 2 (WIN). Array sengaja diacak.
    const trades = [
      trade('TIMEOUT', 0.5, 40, { barsHeld: 4 }),
      trade('WIN', 2, 10, { barsHeld: 1, mfeR: 2, maeR: -0.2 }),
      trade('LOSS', -1, 30, { barsHeld: 3 }),
      trade('OPEN', 5, 99),
      trade('WIN', 2, 50, { barsHeld: 10 }),
      trade('LOSS', -1, 20, { barsHeld: 2 }),
    ];
    const s = summarize(trades);
    expect(s.n).toBe(5);
    expect([s.wins, s.losses, s.timeouts]).toEqual([2, 2, 1]);
    expect(s.winRate).toBeCloseTo(0.4, 12);
    expect(s.hitRate).toBeCloseTo(0.6, 12);
    // Rata-rata = 2,5/5 = 0,5; deviasi ±1,5 (×4) dan 0 → var = 9/4 → sd 1,5; setengah CI = 1,96·1,5/√5 = 1,31484.
    expect(s.expectancyR).toBeCloseTo(0.5, 12);
    expect(s.expectancyCi[0]).toBeCloseTo(0.5 - 1.31484, 4);
    expect(s.expectancyCi[1]).toBeCloseTo(0.5 + 1.31484, 4);
    // PF = 4,5 / 2 = 2,25.
    expect(s.profitFactor).toBeCloseTo(2.25, 12);
    // Ekuitas: 2, 1, 0, 0,5, 2,5 → puncak 2, lembah 0 → DD 2.
    expect(s.maxDrawdownR).toBeCloseTo(2, 12);
    // barsHeld [4,1,3,10,2] → median 3.
    expect(s.medianBarsHeld).toBe(3);
    // MFE (1+2+1+1+1)/5 = 1,2; MAE (−0,5·4 −0,2)/5 = −0,44.
    expect(s.avgMfeR).toBeCloseTo(1.2, 12);
    expect(s.avgMaeR).toBeCloseTo(-0.44, 12);
    const [lo, hi] = wilsonInterval(2, 5);
    expect(s.winRateCi).toEqual([lo, hi]);
  });

  it('UNIT-BT-MET-003 summarize: urutan ekuitas memakai exitTime bila ada', () => {
    // Menurut exitTime: −1, −1, 2 → DD = 2 (ekuitas 0 → −1 → −2).
    const trades = [trade('WIN', 2, 1, { exitTime: 300 }), trade('LOSS', -1, 2, { exitTime: 100 }), trade('LOSS', -1, 3, { exitTime: 200 })];
    expect(summarize(trades).maxDrawdownR).toBeCloseTo(2, 12);
  });

  it('EDGE-BT-MET-001 kosong, tanpa rugi, satu trade', () => {
    const empty = summarize([trade('OPEN', 1, 1)]);
    expect(empty.n).toBe(0);
    expect(empty.winRate).toBeNull();
    expect(empty.winRateCi).toEqual([0, 1]);
    expect(empty.expectancyR).toBeNull();
    const onlyWins = summarize([trade('WIN', 2, 1)]);
    expect(onlyWins.profitFactor).toBeNull();
    expect(onlyWins.expectancyCi).toBeNull(); // n < 2
    expect(onlyWins.maxDrawdownR).toBe(0);
    expect(summarize(null).n).toBe(0);
  });

  it('UNIT-BT-MET-004 brierScore, baseRate, groupBy', () => {
    // (0,8−1)² = 0,04; (0,3−0)² = 0,09 → rata-rata 0,065.
    expect(brierScore([{ p: 0.8, y: 1 }, { p: 0.3, y: 0 }])).toBeCloseTo(0.065, 12);
    expect(brierScore([])).toBeNull();
    const trades = [
      trade('WIN', 2, 1, { direction: 'LONG' }),
      trade('LOSS', -1, 2, { direction: 'LONG' }),
      trade('LOSS', -1, 3, { direction: 'SHORT' }),
      trade('OPEN', 0, 4, { direction: 'SHORT' }),
    ];
    expect(baseRate(trades)).toBeCloseTo(1 / 3, 12);
    expect(baseRate([])).toBeNull();
    const g = groupBy(trades, (t) => t.direction);
    expect(g).toBeInstanceOf(Map);
    expect(g.get('LONG').n).toBe(2);
    expect(g.get('LONG').winRate).toBeCloseTo(0.5, 12);
    expect(g.get('SHORT').n).toBe(1);
  });
});
