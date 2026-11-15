import { describe, expect, it } from 'vitest';
import { BSV_1H_V1, detectBsvSignals, isFirstBreak } from '../../../backend/research/bsv1h.js';

// Candle 1h SINTETIS — bukan data pasar nyata. Deret datar (high/low ±0,5, volume 100) tidak membentuk swing,
// sehingga setiap swing & breakout di tes ini disusun eksplisit.
const H = 3_600_000;
const T0 = Date.UTC(2025, 0, 1);
const LEVEL = 103;

function flat(n) {
  return Array.from({ length: n }, (_, k) => ({ openTime: T0 + k * H, open: 100, high: 100.5, low: 99.5, close: 100, volume: 100 }));
}
const set = (c, k, patch) => { c[k] = { ...c[k], ...patch }; };
/** Swing high di indeks s (high = LEVEL, terkonfirmasi di s + 2). */
const swingAt = (c, s, high = LEVEL) => set(c, s, { high });
/** Candle breakout di indeks i: close di atas level dengan volume tertentu. */
const breakoutAt = (c, i, { close = 104, volume = 300 } = {}) => set(c, i, { close, high: close + 0.5, volume });

function basic(n = 60) {
  const c = flat(n);
  swingAt(c, 30);
  breakoutAt(c, 36);
  return c;
}

describe('detectBsvSignals (aturan dibekukan v1)', () => {
  it('UNIT-BSV-001 close pertama di atas swing high terkonfirmasi dengan RVOL ≥ 2 → satu sinyal', () => {
    expect(detectBsvSignals(basic())).toEqual([
      expect.objectContaining({ index: 36, openTime: T0 + 36 * H, level: LEVEL, levelIndex: 30, levelConfirmedIndex: 32, rvol: 3 }),
    ]);
    expect(BSV_1H_V1).toMatchObject({ minRvol: 2, levelLookback: 48, cooldownBars: 6, stopAtr: 1.5, targetR: 2, maxBars: 48 });
    expect(Object.isFrozen(BSV_1H_V1)).toBe(true);
  });

  it('UNIT-BSV-002 RVOL < 2 atau close sebelumnya sudah di atas level → tidak ada sinyal', () => {
    const lowVol = flat(60);
    swingAt(lowVol, 30);
    breakoutAt(lowVol, 36, { volume: 150 });
    expect(detectBsvSignals(lowVol)).toEqual([]);

    const already = basic();
    set(already, 35, { close: 103.5, high: 103.6 });
    expect(detectBsvSignals(already).map((s) => s.index)).not.toContain(36);
  });

  it('UNIT-BSV-003 level berumur > 48 candle diabaikan', () => {
    const c = flat(90);
    swingAt(c, 30);
    breakoutAt(c, 79);
    expect(detectBsvSignals(c)).toEqual([]);
    const fresh = flat(90);
    swingAt(fresh, 31);
    breakoutAt(fresh, 79);
    expect(detectBsvSignals(fresh).map((s) => s.index)).toEqual([79]);
  });

  it('UNIT-BSV-004 jeda 6 candle dihitung dari sinyal terakhir yang terbit', () => {
    const c = flat(70);
    swingAt(c, 30);
    breakoutAt(c, 36); // sinyal 1; candle 36 menjadi swing high baru (104,5) terkonfirmasi di 38
    breakoutAt(c, 39, { close: 105 }); // pemicu 3 candle kemudian → ditahan jeda
    breakoutAt(c, 42, { close: 106 }); // 6 candle sesudah sinyal 1 → terbit
    expect(detectBsvSignals(c).map((s) => [s.index, s.level])).toEqual([[36, LEVEL], [42, 105.5]]);
  });

  it('UNIT-BSV-005 tanpa lookahead: sinyal di i identik bila hanya candle ≤ i yang tersedia', () => {
    const c = flat(70);
    swingAt(c, 30);
    breakoutAt(c, 36);
    breakoutAt(c, 39, { close: 105 });
    breakoutAt(c, 42, { close: 106 });
    set(c, 50, { high: 120 }); // candle masa depan yang ekstrem tidak boleh mengubah sinyal sebelumnya
    const full = detectBsvSignals(c);
    expect(full.length).toBeGreaterThan(0);
    for (const sg of full) {
      const prefix = detectBsvSignals(c.slice(0, sg.index + 1));
      expect(prefix.at(-1)).toEqual(sg);
    }
  });

  it('UNIT-BSV-006 jendela from/to dan riwayat minimum dihormati', () => {
    const c = basic();
    expect(detectBsvSignals(c, { from: T0 + 37 * H })).toEqual([]);
    expect(detectBsvSignals(c, { to: T0 + 36 * H })).toEqual([]);
    expect(detectBsvSignals(c, { minHistory: 40 })).toEqual([]);
    expect(detectBsvSignals(c, { from: T0 + 36 * H, to: T0 + 37 * H }).map((s) => s.index)).toEqual([36]);
    expect(detectBsvSignals(flat(1))).toEqual([]);
    expect(() => detectBsvSignals(null)).toThrow(TypeError);
  });

  it('UNIT-BSV-007 isFirstBreak: false bila ada close di atas level setelah swing terkonfirmasi', () => {
    const c = basic();
    expect(isFirstBreak(c, detectBsvSignals(c)[0])).toBe(true);
    const retest = basic();
    set(retest, 33, { close: 103.2, high: 103.2 });
    set(retest, 34, { high: 103.25 });
    const [sg] = detectBsvSignals(retest);
    expect(sg).toMatchObject({ index: 36, level: LEVEL });
    expect(isFirstBreak(retest, sg)).toBe(false);
  });
});
