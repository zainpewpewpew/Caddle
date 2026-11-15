// Studi timing sinyal (backend/research/signalTiming.js): kelas breakout, ukuran gerak awal/posisi rentang,
// tanpa lookahead untuk kelompok yang dibandingkan, dan simetri LONG/SHORT.
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../../backend/backtest/eventStudy.js';
import { atr } from '../../../backend/indicators/index.js';
import {
  TIMING_GROUPS, breakoutFlags, classifyTiming, groupOfClass, timingAt,
} from '../../../backend/research/signalTiming.js';

const flat = (n, mid = 100) => Array.from({ length: n }, () => ({ high: mid + 1, low: mid - 1, close: mid }));
const at = (list, i, close, { high = Math.max(close, list[i].high), low = Math.min(close, list[i].low) } = {}) => {
  list[i] = { high, low, close };
  return list;
};
function randomWalk(n, seed) {
  const rnd = mulberry32(seed);
  const out = [];
  let p = 100;
  for (let i = 0; i < n; i += 1) {
    const next = p * (1 + (rnd() - 0.5) * 0.02);
    out.push({ high: Math.max(p, next) * (1 + rnd() * 0.004), low: Math.min(p, next) * (1 - rnd() * 0.004), close: next });
    p = next;
  }
  return out;
}

describe('signalTiming', () => {
  it('UNIT-TMG-001 breakoutFlags: close menembus ekstrem 48 candle sebelumnya, searah arah', () => {
    const c = at(at(flat(80), 60, 102), 70, 97);
    const long = breakoutFlags(c, 'LONG');
    const short = breakoutFlags(c, 'SHORT');
    expect(long[60]).toBe(1);
    expect(short[60]).toBe(0);
    expect(short[70]).toBe(1);
    expect(long[70]).toBe(0);
    // Menyentuh high lama tanpa close di atasnya bukan breakout; indeks < 48 tidak pernah breakout.
    expect(breakoutFlags(at(flat(80), 60, 100, { high: 105 }), 'LONG')[60]).toBe(0);
    expect(Array.from(breakoutFlags(at(flat(80), 10, 150), 'LONG').slice(0, 48)).every((f) => f === 0)).toBe(true);
    expect(() => breakoutFlags(c, 'NAIK')).toThrow(RangeError);
  });

  it('UNIT-TMG-002 classifyTiming: SAAT, SESUDAH (≤ 12 candle), SEBELUM diikuti / tanpa breakout', () => {
    const flags = new Uint8Array(120);
    flags[60] = 1;
    expect(classifyTiming(flags, 60)).toBe('SAAT');
    expect(classifyTiming(flags, 61)).toBe('SESUDAH');
    expect(classifyTiming(flags, 72)).toBe('SESUDAH');
    expect(classifyTiming(flags, 73)).toBe('SEBELUM_TANPA'); // breakout 13 candle lalu: di luar jendela
    expect(classifyTiming(flags, 48)).toBe('SEBELUM_DIIKUTI');
    expect(classifyTiming(flags, 47)).toBe('SEBELUM_TANPA'); // breakout 13 candle lagi: di luar jendela
    expect(classifyTiming(flags, 100)).toBe('SEBELUM_TANPA');
    expect(TIMING_GROUPS.map((g) => g.key)).toEqual(['SEBELUM', 'SAAT', 'SESUDAH']);
    expect(['SEBELUM_DIIKUTI', 'SEBELUM_TANPA', 'SAAT', 'SESUDAH'].map(groupOfClass)).toEqual(['SEBELUM', 'SEBELUM', 'SAAT', 'SESUDAH']);
  });

  it('UNIT-TMG-003 timingAt: gerak awal dalam ATR, posisi rentang, null bila data kurang', () => {
    // Naik 1 per candle: close i = 100 + i, high/low ± 0,5 → TR = 1,5, ATR = 1,5.
    const c = Array.from({ length: 100 }, (_, i) => ({ high: 100 + i + 0.5, low: 100 + i - 0.5, close: 100 + i }));
    const a = atr(c, 14);
    const longFlags = breakoutFlags(c, 'LONG');
    const t = timingAt(c, a, longFlags, 'LONG', 70);
    expect(t.pre).toBeCloseTo(12 / a[70], 12);
    expect(t.pos).toBeCloseTo((170 - (100 + 23 - 0.5)) / ((170 + 0.5) - (100 + 23 - 0.5)), 12);
    expect(t.cls).toBe('SAAT');
    const s = timingAt(c, a, breakoutFlags(c, 'SHORT'), 'SHORT', 70);
    expect(s.pre).toBeCloseTo(-t.pre, 12);
    expect(s.pos).toBeCloseTo(1 - t.pos, 12);
    expect(timingAt(c, a, longFlags, 'LONG', 59)).toBeNull(); // i < 48 + 12
    expect(timingAt(c, a, longFlags, 'LONG', 88)).toBeNull(); // jendela sesudah belum lengkap
    expect(timingAt(c, a.map(() => 0), longFlags, 'LONG', 70)).toBeNull();
  });

  it('UNIT-TMG-004 tanpa lookahead: kelompok SEBELUM/SAAT/SESUDAH hanya bergantung pada candle ≤ i', () => {
    const base = randomWalk(400, 3);
    const flagsBase = breakoutFlags(base, 'LONG');
    let checked = 0;
    for (let i = 60; i < 380; i += 7) {
      const future = base.map((c, k) => (k > i ? { high: c.high * 1.3, low: c.low * 1.3, close: c.close * 1.3 } : c));
      const flagsFuture = breakoutFlags(future, 'LONG');
      expect(groupOfClass(classifyTiming(flagsFuture, i)), `i=${i}`).toBe(groupOfClass(classifyTiming(flagsBase, i)));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(40);
  });

  it('UNIT-TMG-005 simetri: LONG pada deret asli = SHORT pada deret cermin', () => {
    const c = randomWalk(300, 9);
    const mirror = c.map((x) => ({ high: 200 - x.low, low: 200 - x.high, close: 200 - x.close }));
    const fl = breakoutFlags(c, 'LONG');
    const fs = breakoutFlags(mirror, 'SHORT');
    expect(Array.from(fs)).toEqual(Array.from(fl));
    const a = atr(c, 14);
    const am = atr(mirror, 14);
    for (const i of [80, 150, 220]) {
      const l = timingAt(c, a, fl, 'LONG', i);
      const s = timingAt(mirror, am, fs, 'SHORT', i);
      expect(s.cls).toBe(l.cls);
      expect(s.pre).toBeCloseTo(l.pre, 9);
      expect(s.pos).toBeCloseTo(l.pos, 9);
    }
  });
});
