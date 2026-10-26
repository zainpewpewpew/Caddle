import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  adx, analyzeRegime, bollingerBandwidth, choppiness, efficiencyRatio, REGIMES,
} from '../../../backend/features/regime.js';

const golden = JSON.parse(readFileSync(new URL('../../fixtures/features/regime-golden.json', import.meta.url), 'utf8'));

/** PRNG berbenih (mulberry32) agar deret deterministik. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bangun candle dari fungsi langkah: step(i, rnd) → { drift, vol }. */
function series(n, step, seed = 7, start = 100) {
  const rnd = prng(seed);
  const out = [];
  let close = start;
  for (let i = 0; i < n; i += 1) {
    const { drift, vol } = step(i);
    const open = close;
    close = open + drift + (rnd() - 0.5) * 2 * vol;
    const high = Math.max(open, close) + rnd() * vol;
    const low = Math.min(open, close) - rnd() * vol;
    out.push({ open, high, low, close, volume: 1000 });
  }
  return out;
}

const trendUp = () => series(200, () => ({ drift: 1, vol: 0.3 }));
const trendDown = () => series(200, () => ({ drift: -1, vol: 0.3 }), 11, 400);
const zigzag = () => series(200, (i) => ({ drift: i % 2 === 0 ? 2 : -2, vol: 0.5 }), 3);
const compression = () => series(220, (i) => (i < 190
  ? { drift: i % 2 === 0 ? 2 : -2, vol: 1.5 }
  : { drift: i % 2 === 0 ? 0.05 : -0.05, vol: 0.03 }), 5);

describe('regime — verifikasi terhadap pustaka open source `ta`', () => {
  const { candles, expected, source, params } = golden;
  const first = source.firstValid;

  it('UNIT-REG-001 ADX/+DI/−DI cocok dengan ta.trend.ADXIndicator setelah warm-up', () => {
    const r = adx(candles, params.adxWindow);
    let compared = 0;
    for (let i = 0; i < candles.length; i += 1) {
      if (i >= first.adx) { expect(r.adx[i]).toBeCloseTo(expected.adx[i], 6); compared += 1; }
      if (i >= first.plusDi) {
        expect(r.plusDi[i]).toBeCloseTo(expected.plusDi[i], 6);
        expect(r.minusDi[i]).toBeCloseTo(expected.minusDi[i], 6);
      }
    }
    expect(compared).toBeGreaterThan(100);
    // Warm-up: kita null (ta menulis 0). DI sah mulai indeks period (ta mengosongkan seed-nya).
    expect(r.adx[first.adx - 1]).toBeNull();
    expect(r.plusDi[params.adxWindow - 1]).toBeNull();
    expect(r.plusDi[params.adxWindow]).not.toBeNull();
  });

  it('UNIT-REG-002 bandwidth Bollinger = ta bollinger_wband / 100 (stdev populasi)', () => {
    const bw = bollingerBandwidth(candles.map((c) => c.close), params.bbWindow, params.bbDev);
    for (let i = 0; i < candles.length; i += 1) {
      if (i < first.wband) {
        expect(bw[i]).toBeNull();
        expect(expected.wband[i]).toBeNull();
      } else {
        expect(bw[i] * 100).toBeCloseTo(expected.wband[i], 7);
      }
    }
    expect(source.library).toMatch(/^ta /);
    expect(source.taVersion).toBeTruthy();
  });
});

describe('regime — indikator', () => {
  it('UNIT-REG-003 choppiness sesuai rumus Dreiss & warm-up null', () => {
    const c = [
      { high: 2, low: 1, close: 1.5 },
      { high: 3, low: 1.5, close: 2.5 },
      { high: 3.5, low: 2, close: 3 },
    ];
    const ch = choppiness(c, 3);
    expect(ch.slice(0, 2)).toEqual([null, null]);
    // TR: 1, 1.5, 1.5 → Σ=4; range 3.5−1 = 2.5
    expect(ch[2]).toBeCloseTo((100 * Math.log10(4 / 2.5)) / Math.log10(3), 10);
    expect(choppiness([{ high: 1, low: 1, close: 1 }, { high: 1, low: 1, close: 1 }], 2)).toEqual([null, null]);
  });

  it('UNIT-REG-004 efficiency ratio Kaufman: lurus = 1, bolak-balik ≈ 0, datar = null', () => {
    expect(efficiencyRatio([1, 2, 3, 4, 5], 4)).toEqual([null, null, null, null, 1]);
    const er = efficiencyRatio([1, 2, 1, 2, 1], 4);
    expect(er[4]).toBe(0);
    expect(efficiencyRatio([5, 5, 5], 2)).toEqual([null, null, null]);
    expect(efficiencyRatio([1, 3, 2], 2)[2]).toBeCloseTo(1 / 3, 12);
  });

  it('UNIT-REG-005 bandwidth manual: σ populasi', () => {
    const bw = bollingerBandwidth([1, 2, 3], 3, 2);
    const sd = Math.sqrt(2 / 3);
    expect(bw[2]).toBeCloseTo((4 * sd) / 2, 12);
  });

  it('NEG-REG-001 input tidak valid ditolak', () => {
    expect(() => adx([{ high: 1, low: Number.NaN, close: 1 }])).toThrow(TypeError);
    expect(() => bollingerBandwidth([1, 2], 0)).toThrow(RangeError);
    expect(() => bollingerBandwidth([1, 2], 2, 0)).toThrow(RangeError);
    expect(() => efficiencyRatio('abc')).toThrow(TypeError);
  });

  it('EDGE-REG-001 data kurang → semua null, regime null', () => {
    const c = trendUp().slice(0, 20);
    const r = adx(c, 14);
    expect(r.adx.every((v) => v === null)).toBe(true);
    const a = analyzeRegime(c);
    expect(a.regime).toBeNull();
    expect(a.adx).toBeNull();
    expect(a.bandwidthPercentile).toBeNull();
    expect(a.squeeze).toBe(false);
    expect(analyzeRegime([]).regime).toBeNull();
  });
});

describe('regime — klasifikasi', () => {
  it('POS-REG-001 tren naik kuat → TRENDING_UP, ADX tinggi, ER tinggi', () => {
    const a = analyzeRegime(trendUp());
    expect(a.regime).toBe(REGIMES.TRENDING_UP);
    expect(a.adx).toBeGreaterThan(40);
    expect(a.plusDi).toBeGreaterThan(a.minusDi);
    expect(a.efficiencyRatio).toBeGreaterThan(0.7);
    expect(a.chop).toBeLessThan(38.2);
  });

  it('POS-REG-002 tren turun kuat → TRENDING_DOWN', () => {
    const a = analyzeRegime(trendDown());
    expect(a.regime).toBe(REGIMES.TRENDING_DOWN);
    expect(a.minusDi).toBeGreaterThan(a.plusDi);
    expect(a.adx).toBeGreaterThan(40);
  });

  it('POS-REG-003 deret bolak-balik → CHOPPY/RANGING, ADX rendah', () => {
    const a = analyzeRegime(zigzag());
    expect([REGIMES.CHOPPY, REGIMES.RANGING]).toContain(a.regime);
    expect(a.adx).toBeLessThan(25);
    expect(a.chop).toBeGreaterThan(50);
    expect(a.efficiencyRatio).toBeLessThan(0.3);
  });

  it('POS-REG-004 kompresi volatilitas → squeeze & SQUEEZE', () => {
    const a = analyzeRegime(compression());
    expect(a.bandwidthPercentile).toBeLessThanOrEqual(0.2);
    expect(a.squeeze).toBe(true);
    expect(a.adx).toBeLessThan(20);
    expect(a.regime).toBe(REGIMES.SQUEEZE);
  });

  it('EDGE-REG-002 pasar datar total → DI 0, tanpa NaN', () => {
    const flat = Array.from({ length: 60 }, () => ({ high: 10, low: 10, close: 10 }));
    const r = adx(flat, 14);
    expect(r.adx[59]).toBe(0);
    expect(r.plusDi[59]).toBe(0);
    const a = analyzeRegime(flat);
    expect(a.chop).toBeNull();
    expect(a.regime).toBeNull();
  });
});

describe('regime — anti lookahead', () => {
  it('ANTI-REG-001 nilai pada prefix tidak berubah saat data masa depan ditambah', () => {
    const full = series(260, (i) => ({ drift: i < 130 ? 0.8 : -0.6, vol: 0.7 }), 21);
    const fullAdx = adx(full);
    const fullChop = choppiness(full);
    const closes = full.map((c) => c.close);
    const fullBw = bollingerBandwidth(closes);
    const fullEr = efficiencyRatio(closes);
    for (const cut of [30, 90, 150, 200]) {
      const prefix = full.slice(0, cut);
      const p = adx(prefix);
      const i = cut - 1;
      expect(p.adx[i]).toBe(fullAdx.adx[i]);
      expect(p.plusDi[i]).toBe(fullAdx.plusDi[i]);
      expect(p.minusDi[i]).toBe(fullAdx.minusDi[i]);
      expect(choppiness(prefix)[i]).toBe(fullChop[i]);
      expect(bollingerBandwidth(closes.slice(0, cut))[i]).toBe(fullBw[i]);
      expect(efficiencyRatio(closes.slice(0, cut))[i]).toBe(fullEr[i]);
      // analyzeRegime pada prefix = nilai seri penuh di indeks yang sama.
      const a = analyzeRegime(prefix);
      expect(a.adx).toBe(fullAdx.adx[i]);
      expect(a.chop).toBe(fullChop[i]);
      expect(a.bandwidth).toBe(fullBw[i]);
    }
  });

  it('ANTI-REG-002 mengubah candle setelah indeks evaluasi tidak memengaruhi nilai prefix', () => {
    const base = trendUp();
    const mutated = base.map((c, i) => (i >= 150 ? { ...c, high: c.high * 3, low: c.low / 3, close: c.close * 2 } : c));
    const a = adx(base);
    const b = adx(mutated);
    expect(b.adx.slice(0, 150)).toEqual(a.adx.slice(0, 150));
    expect(choppiness(mutated).slice(0, 150)).toEqual(choppiness(base).slice(0, 150));
  });
});
