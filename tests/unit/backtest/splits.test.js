import { describe, expect, it } from 'vitest';
import { holdoutSplit, purgeTrades, walkForwardSplits } from '../../../backend/backtest/splits.js';

describe('pembagian walk-forward', () => {
  it('UNIT-BT-SPL-001 anchored + embargo: indeks dihitung tangan', () => {
    // n=100, minTrain 0,4 → mulai uji 40; sisa 60 dibagi 3 → [40,60), [60,80), [80,100); train berakhir 5 bar sebelum uji.
    const s = walkForwardSplits(100, { folds: 3, minTrainFraction: 0.4, embargoBars: 5 });
    expect(s).toEqual([
      { fold: 0, trainStart: 0, trainEnd: 35, testStart: 40, testEnd: 60 },
      { fold: 1, trainStart: 0, trainEnd: 55, testStart: 60, testEnd: 80 },
      { fold: 2, trainStart: 0, trainEnd: 75, testStart: 80, testEnd: 100 },
    ]);
  });

  it('UNIT-BT-SPL-002 sifat: urut waktu, uji menutup sisa data tanpa tumpang tindih, celah ≥ embargo', () => {
    const n = 1037;
    const embargoBars = 48;
    const s = walkForwardSplits(n, { embargoBars });
    expect(s).toHaveLength(5);
    expect(s[0].testStart).toBe(Math.floor(n * 0.4));
    expect(s.at(-1).testEnd).toBe(n);
    for (let i = 0; i < s.length; i += 1) {
      expect(s[i].testStart - s[i].trainEnd).toBe(embargoBars);
      if (i > 0) {
        expect(s[i].testStart).toBe(s[i - 1].testEnd);
        expect(s[i].trainEnd).toBeGreaterThan(s[i - 1].trainEnd); // ekspansi
      }
    }
  });

  it('UNIT-BT-SPL-003 fold dengan training kosong dilewati; times dipakai sebagai panjang', () => {
    // embargo 45: fold pertama trainEnd = 40 − 45 < 0 → dilewati.
    const s = walkForwardSplits(100, { folds: 3, embargoBars: 45 });
    expect(s.map((x) => x.testStart)).toEqual([60, 80]);
    expect(s[0].fold).toBe(0);
    const times = Array.from({ length: 100 }, (_, i) => 1_000 + i * 60_000);
    expect(walkForwardSplits(times, { folds: 3, embargoBars: 5 })).toEqual(walkForwardSplits(100, { folds: 3, embargoBars: 5 }));
    expect(walkForwardSplits(3, { folds: 5, embargoBars: 0 }).every((x) => x.testEnd > x.testStart)).toBe(true);
  });

  it('UNIT-BT-SPL-004 holdout', () => {
    // n=100, uji 30% → [70,100), embargo 10 → trainEnd 60.
    expect(holdoutSplit(100, { testFraction: 0.3, embargoBars: 10 })).toEqual({ fold: 0, trainStart: 0, trainEnd: 60, testStart: 70, testEnd: 100 });
    expect(holdoutSplit(50, { embargoBars: 48 })).toBeNull();
  });

  it('UNIT-BT-SPL-005 purging & embargo pada trade', () => {
    const split = { trainStart: 0, trainEnd: 35, testStart: 40, testEnd: 60 };
    const trades = [
      { id: 'a', entryIndex: 10, exitIndex: 20, outcome: 'WIN' }, // train
      { id: 'b', entryIndex: 30, exitIndex: 39, outcome: 'LOSS' }, // train (exit sebelum uji)
      { id: 'c', entryIndex: 30, exitIndex: 40, outcome: 'WIN' }, // dibuang: label menyentuh uji
      { id: 'd', entryIndex: 34, exitIndex: 34, outcome: 'OPEN' }, // dibuang: OPEN
      { id: 'e', entryIndex: 37, exitIndex: 38, outcome: 'WIN' }, // celah embargo → tidak dipakai
      { id: 'f', entryIndex: 45, exitIndex: 70, outcome: 'TIMEOUT' }, // uji (exit boleh lewat testEnd)
      { id: 'g', entryIndex: 60, exitIndex: 61, outcome: 'WIN' }, // di luar uji
    ];
    const { train, test, purged } = purgeTrades(trades, split);
    expect(train.map((t) => t.id)).toEqual(['a', 'b']);
    expect(test.map((t) => t.id)).toEqual(['f']);
    expect(purged).toBe(2);
  });

  it('NEG-BT-SPL-001 argumen tidak valid', () => {
    expect(() => walkForwardSplits([3, 2, 1])).toThrow(RangeError);
    expect(() => walkForwardSplits(100, { folds: 0 })).toThrow(RangeError);
    expect(() => walkForwardSplits(100, { minTrainFraction: 1 })).toThrow(RangeError);
    expect(() => walkForwardSplits(100, { embargoBars: -1 })).toThrow(RangeError);
    expect(() => holdoutSplit(100, { testFraction: 0 })).toThrow(RangeError);
    expect(walkForwardSplits(0)).toEqual([]);
  });
});
