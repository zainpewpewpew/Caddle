import { describe, expect, it } from 'vitest';
import { analyzeMarketStructure, STRUCTURE_PARAMS } from '../../../backend/features/marketStructure.js';
import { mirrorCandles } from '../../../backend/patterns/mirror.js';

/** Candle dari deret close (open = close sebelumnya, sumbu ±0.2). */
function fromCloses(closes) {
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1];
    return { open, close, high: Math.max(open, close) + 0.2, low: Math.min(open, close) - 0.2, volume: 1 };
  });
}

/** Zigzag linear antar titik pivot, `step` bar per kaki. */
function zigzag(pivots, step = 4) {
  const out = [pivots[0]];
  for (let p = 1; p < pivots.length; p += 1) {
    for (let s = 1; s <= step; s += 1) out.push(pivots[p - 1] + ((pivots[p] - pivots[p - 1]) * s) / step);
  }
  return fromCloses(out);
}

/** PRNG berbenih (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomWalk(n, seed) {
  const r = rng(seed);
  const closes = [100];
  for (let i = 1; i < n; i += 1) closes.push(Math.max(1, closes[i - 1] * (1 + (r() - 0.5) * 0.04)));
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1];
    return { open, close, high: Math.max(open, close) * (1 + r() * 0.01), low: Math.min(open, close) * (1 - r() * 0.01) };
  });
}

const UP = [100, 110, 105, 115, 110, 120, 115, 125, 120, 130, 126];
const DOWN = UP.map((p) => 230 - p);

describe('analyzeMarketStructure', () => {
  it('UNIT-MS-001 uptrend tangga → HH/HL, BULLISH, BOS bullish, skor positif', () => {
    const r = analyzeMarketStructure(zigzag(UP));
    expect(r.bias).toBe('BULLISH');
    expect(r.counts.LH).toBe(0);
    expect(r.counts.LL).toBe(0);
    expect(r.counts.HH).toBeGreaterThanOrEqual(3);
    expect(r.counts.HL).toBeGreaterThanOrEqual(3);
    expect(r.lastEvent).toMatchObject({ type: 'BOS', direction: 'BULLISH' });
    expect(r.lastEvent.barsAgo).toBe(zigzag(UP).length - 1 - r.lastEvent.index);
    expect(r.lastSwingHigh).toBeCloseTo(130.2, 9);
    expect(r.lastSwingLow).toBeCloseTo(119.8, 9);
    expect(r.structureScore).toBeGreaterThan(0.5);
    expect(r.structureScore).toBeLessThanOrEqual(1);
    // Swing urut waktu, swing pertama tiap jenis berlabel null.
    const idx = r.swings.map((s) => s.index);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(r.swings.find((s) => s.type === 'HIGH').label).toBeNull();
    expect(r.swings.find((s) => s.type === 'LOW').label).toBeNull();
    for (const s of r.swings) expect(s.confirmedIndex).toBe(s.index + 2);
  });

  it('UNIT-MS-002 downtrend cermin → LH/LL, BEARISH, BOS bearish, skor negatif', () => {
    const r = analyzeMarketStructure(zigzag(DOWN));
    expect(r.bias).toBe('BEARISH');
    expect(r.counts.HH).toBe(0);
    expect(r.counts.HL).toBe(0);
    expect(r.lastEvent).toMatchObject({ type: 'BOS', direction: 'BEARISH' });
    expect(r.structureScore).toBeLessThan(-0.5);
  });

  it('UNIT-MS-003 uptrend patah → CHOCH bearish, bias BEARISH', () => {
    // Setelah HL 120 (swing low terakhir), harga jatuh menembus 120 → perubahan karakter.
    const r = analyzeMarketStructure(zigzag([...UP.slice(0, -1), 108, 112]));
    expect(r.lastEvent).toMatchObject({ type: 'CHOCH', direction: 'BEARISH' });
    expect(r.lastEvent.level).toBeCloseTo(119.8, 9);
    expect(r.bias).toBe('BEARISH');
    // Struktur sebelumnya mayoritas bullish tetapi CHoCH segar menyeret skor turun dibanding uptrend murni.
    expect(r.structureScore).toBeLessThan(analyzeMarketStructure(zigzag(UP)).structureScore);
  });

  it('UNIT-MS-004 satu swing hanya ditembus sekali', () => {
    // Harga naik menembus swing high lalu bertahan di atasnya: hanya satu event.
    const c = zigzag([100, 110, 105, 115, 116, 117, 118], 4);
    const r = analyzeMarketStructure(c);
    expect(r.lastEvent.type).toBe('BOS');
    const prefixEvents = new Set();
    for (let k = 1; k <= c.length; k += 1) {
      const e = analyzeMarketStructure(c.slice(0, k)).lastEvent;
      if (e) prefixEvents.add(`${e.index}:${e.level}`);
    }
    expect(prefixEvents.size).toBe(1);
  });

  it('EDGE-MS-001 data kosong/pendek → NEUTRAL, field null, swings []', () => {
    for (const c of [[], fromCloses([1, 2, 3]), fromCloses([1, 2, 3, 4, 5])]) {
      const r = analyzeMarketStructure(c);
      expect(r).toEqual({
        bias: 'NEUTRAL', swings: [], counts: { HH: 0, LH: 0, HL: 0, LL: 0 },
        lastEvent: null, lastSwingHigh: null, lastSwingLow: null, structureScore: null,
      });
    }
  });

  it('EDGE-MS-002 validasi input', () => {
    expect(() => analyzeMarketStructure(null)).toThrow(TypeError);
    expect(() => analyzeMarketStructure([{ high: 1, low: Number.NaN, close: 1 }])).toThrow(TypeError);
    expect(() => analyzeMarketStructure([null])).toThrow(TypeError);
    expect(() => analyzeMarketStructure([], { left: 0 })).toThrow(RangeError);
    expect(() => analyzeMarketStructure([], { right: 1.5 })).toThrow(RangeError);
    expect(() => analyzeMarketStructure([], { maxSwings: 0 })).toThrow(RangeError);
  });

  it('UNIT-MS-005 maxSwings membatasi swing terakhir; counts dalam jendela', () => {
    const r = analyzeMarketStructure(zigzag(UP), { maxSwings: 3 });
    expect(r.swings).toHaveLength(3);
    expect(r.swings.every((s) => s.label !== null)).toBe(true); // label dari riwayat penuh
    expect(r.counts.HH + r.counts.HL + r.counts.LH + r.counts.LL).toBe(3);
  });

  it('ANTI-LOOKAHEAD-MS-001 hasil prefix tidak berubah oleh candle masa depan', () => {
    for (const seed of [1, 7, 42]) {
      const c = randomWalk(220, seed);
      for (let k = 1; k <= 200; k += 3) {
        const prefix = c.slice(0, k);
        const base = analyzeMarketStructure(prefix);
        // Tambah candle masa depan (asli maupun ekstrem) lalu potong lagi → identik.
        const extended = [...prefix, ...c.slice(k, k + 20), { open: 1, close: 1e6, high: 1e6, low: 0.5 }];
        expect(analyzeMarketStructure(extended.slice(0, k))).toEqual(base);
        expect(analyzeMarketStructure(c.slice(0, k))).toEqual(base);
        // Semua yang dilaporkan sudah terjadi & terkonfirmasi pada indeks terakhir prefix.
        for (const s of base.swings) expect(s.confirmedIndex).toBeLessThanOrEqual(k - 1);
        if (base.lastEvent) expect(base.lastEvent.index).toBeLessThanOrEqual(k - 1);
        if (base.structureScore !== null) {
          expect(base.structureScore).toBeGreaterThanOrEqual(-1);
          expect(base.structureScore).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('ANTI-LOOKAHEAD-MS-002 swing yang belum terkonfirmasi tidak dipakai', () => {
    const c = zigzag(UP);
    const peakIdx = 36; // puncak 125 (pivot ke-8 × 4 bar)
    const before = analyzeMarketStructure(c.slice(0, peakIdx + 2)); // baru 1 candle setelah puncak
    expect(before.swings.some((s) => s.index === peakIdx)).toBe(false);
    const after = analyzeMarketStructure(c.slice(0, peakIdx + 3)); // right = 2 terpenuhi
    expect(after.swings.some((s) => s.index === peakIdx && s.label === 'HH')).toBe(true);
  });

  it('SYM-MS-001 candle cermin → bias kebalikan, skor berlawanan tanda, label tercermin', () => {
    const flip = { BULLISH: 'BEARISH', BEARISH: 'BULLISH', NEUTRAL: 'NEUTRAL' };
    const labelFlip = { HH: 'LL', LL: 'HH', HL: 'LH', LH: 'HL', null: null };
    const cases = [zigzag(UP), zigzag(DOWN), zigzag([...UP.slice(0, -1), 108, 112]), randomWalk(300, 3), randomWalk(300, 11)];
    for (const c of cases) {
      const r = analyzeMarketStructure(c);
      const m = analyzeMarketStructure(mirrorCandles(c));
      expect(m.bias).toBe(flip[r.bias]);
      if (r.structureScore === null) expect(m.structureScore).toBeNull();
      else expect(m.structureScore).toBeCloseTo(-r.structureScore, 12);
      expect(m.counts).toEqual({ HH: r.counts.LL, LL: r.counts.HH, HL: r.counts.LH, LH: r.counts.HL });
      expect(m.swings.map((s) => [s.index, labelFlip[s.label]]).sort())
        .toEqual(r.swings.map((s) => [s.index, s.label]).sort());
      if (r.lastEvent) {
        expect(m.lastEvent).toMatchObject({ type: r.lastEvent.type, direction: flip[r.lastEvent.direction], index: r.lastEvent.index });
        expect(m.lastEvent.level).toBeCloseTo(1 / r.lastEvent.level, 12);
      } else expect(m.lastEvent).toBeNull();
    }
  });

  it('UNIT-MS-006 parameter skor terdokumentasi & beku', () => {
    expect(Object.isFrozen(STRUCTURE_PARAMS)).toBe(true);
  });
});
