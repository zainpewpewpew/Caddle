import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  accumulationDistribution, analyzeOrderFlow, cmf, cvd, obv,
} from '../../../backend/features/orderFlow.js';

const golden = JSON.parse(readFileSync(new URL('../../fixtures/features/orderflow-golden.json', import.meta.url), 'utf8'));

/** Kecocokan relatif 1e-9 (absolut untuk nilai di sekitar nol). */
function expectClose(actual, expected) {
  expect(actual.length).toBe(expected.length);
  actual.forEach((a, i) => {
    if (expected[i] === null) { expect(a, `indeks ${i}`).toBeNull(); return; }
    const tol = 1e-9 * Math.max(1, Math.abs(expected[i]));
    expect(Math.abs(a - expected[i]), `indeks ${i}: ${a} vs ${expected[i]}`).toBeLessThanOrEqual(tol);
  });
}

/** Candle sintetis: close mengikuti `closes`, taker = ratio·volume (null = tanpa taker). */
function makeCandles(closes, { volume = 1000, ratio = 0.5, ratioAt } = {}) {
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1];
    const r = ratioAt ? ratioAt(i) : ratio;
    return {
      open,
      high: Math.max(open, close) + 0.5,
      low: Math.min(open, close) - 0.5,
      close,
      volume,
      takerBuyVolume: r === null ? undefined : r * volume,
    };
  });
}

describe('orderFlow — acuan open source (pustaka Python `ta`)', () => {
  const { candles, expected, cmfPeriod } = golden;

  it('UNIT-OF-001 fixture memuat sumber & versi pustaka', () => {
    expect(golden.source).toMatch(/ta/);
    expect(golden.libraries.ta).toMatch(/^\d+\.\d+/);
    expect(candles.length).toBeGreaterThanOrEqual(60);
  });

  it('UNIT-OF-002 OBV cocok dengan ta (konvensi AlphaLens OBV[0]=0 → selisih konstan volume[0])', () => {
    const shifted = expected.obv.map((v) => v - candles[0].volume);
    expectClose(obv(candles), shifted);
  });

  it('UNIT-OF-003 A/D Chaikin cocok dengan ta acc_dist_index (termasuk candle H=L → MFM 0)', () => {
    expectClose(accumulationDistribution(candles), expected.accDist);
  });

  it('UNIT-OF-004 CMF cocok dengan ta chaikin_money_flow (warm-up null)', () => {
    expectClose(cmf(candles, cmfPeriod), expected.cmf);
  });
});

describe('orderFlow — seri dasar', () => {
  it('UNIT-OF-010 CVD = Σ(2·takerBuy − volume) dari nol; taker hilang/tidak hingga/> volume → null', () => {
    const cs = [
      { close: 1, high: 1, low: 1, volume: 10, takerBuyVolume: 7 },
      { close: 1, high: 1, low: 1, volume: 10, takerBuyVolume: 2 },
      { close: 1, high: 1, low: 1, volume: 10 },
      { close: 1, high: 1, low: 1, volume: 10, takerBuyVolume: Number.NaN },
      { close: 1, high: 1, low: 1, volume: 10, takerBuyVolume: 11 },
      { close: 1, high: 1, low: 1, volume: 10, takerBuyVolume: 5 },
    ];
    expect(cvd(cs)).toEqual([4, -2, null, null, null, -2]);
  });

  it('UNIT-OF-011 OBV: naik +v, turun −v, sama 0', () => {
    const cs = [10, 11, 11, 9].map((close, i) => ({ close, volume: (i + 1) * 100 }));
    expect(obv(cs)).toEqual([0, 200, 200, -200]);
  });

  it('EDGE-OF-001 periode CMF tidak valid → RangeError; array kosong aman', () => {
    expect(() => cmf([], 0)).toThrow(RangeError);
    expect(cmf([], 20)).toEqual([]);
    expect(analyzeOrderFlow([]).flowBias).toBeNull();
  });
});

describe('analyzeOrderFlow', () => {
  const flat = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i) * 0.3);

  it('UNIT-OF-020 data tanpa taker → takerBuyRatio & cvdSlope null, flowBias tetap dari CMF/OBV', () => {
    const r = analyzeOrderFlow(makeCandles(flat, { ratio: null }));
    expect(r.takerBuyRatio).toBeNull();
    expect(r.cvdSlope).toBeNull();
    expect(r.cmf).not.toBeNull();
    expect(r.obvSlope).not.toBeNull();
    expect(r.flowBias).not.toBeNull();
  });

  it('UNIT-OF-021 data lama dengan semua taker = 0 → taker/CVD null', () => {
    const r = analyzeOrderFlow(makeCandles(flat, { ratio: 0 }));
    expect(r.takerBuyRatio).toBeNull();
    expect(r.cvdSlope).toBeNull();
  });

  it('UNIT-OF-022 satu candle taker null di window → taker/CVD null', () => {
    const cs = makeCandles(flat, { ratio: 0.6 });
    cs[cs.length - 3].takerBuyVolume = undefined;
    const r = analyzeOrderFlow(cs);
    expect(r.takerBuyRatio).toBeNull();
    expect(r.cvdSlope).toBeNull();
  });

  it('UNIT-OF-023 tekanan beli sintetis → flowBias > 0, rasio & slope konsisten', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + i * 0.4);
    const cs = makeCandles(closes, { ratio: 0.7 }).map((c) => ({ ...c, close: c.high - 0.1 }));
    const r = analyzeOrderFlow(cs);
    expect(r.takerBuyRatio).toBeCloseTo(0.7, 12);
    expect(r.cvdSlope).toBeCloseTo(0.4, 12);
    expect(r.cmf).toBeGreaterThan(0);
    expect(r.obvSlope).toBeGreaterThan(0);
    expect(r.adSlope).toBeGreaterThan(0);
    expect(r.priceChange).toBeGreaterThan(0);
    expect(r.flowBias).toBeGreaterThan(0);
    expect(r.flowBias).toBeLessThanOrEqual(1);
  });

  it('UNIT-OF-024 tekanan jual sintetis → flowBias < 0', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 - i * 0.4);
    const cs = makeCandles(closes, { ratio: 0.3 }).map((c) => ({ ...c, close: c.low + 0.1 }));
    expect(analyzeOrderFlow(cs).flowBias).toBeLessThan(0);
  });

  it('UNIT-OF-025 divergensi BULLISH tertanam: harga turun, agresi beli naik', () => {
    const closes = Array.from({ length: 50 }, (_, i) => 100 - i * 0.2);
    const r = analyzeOrderFlow(makeCandles(closes, { ratio: 0.65 }));
    expect(r.priceChange).toBeLessThan(0);
    expect(r.divergence).toBe('BULLISH');
  });

  it('UNIT-OF-026 divergensi BEARISH tertanam: harga naik, agresi jual dominan', () => {
    const closes = Array.from({ length: 50 }, (_, i) => 100 + i * 0.2);
    const r = analyzeOrderFlow(makeCandles(closes, { ratio: 0.35 }));
    expect(r.divergence).toBe('BEARISH');
  });

  it('UNIT-OF-027 aliran searah harga → tanpa divergensi; tanpa taker → fallback OBV', () => {
    const up = Array.from({ length: 50 }, (_, i) => 100 + i * 0.2);
    expect(analyzeOrderFlow(makeCandles(up, { ratio: 0.65 })).divergence).toBeNull();
    // Tanpa taker: OBV mengikuti harga turun → tidak divergen.
    const down = Array.from({ length: 50 }, (_, i) => 100 - i * 0.2);
    expect(analyzeOrderFlow(makeCandles(down, { ratio: null })).divergence).toBeNull();
    // Tanpa taker, harga datar-turun tetapi volume besar di candle naik → OBV naik → BULLISH.
    const zig = Array.from({ length: 50 }, (_, i) => 100 - i * 0.05 + (i % 2 === 0 ? 0 : 0.3));
    const cs = makeCandles(zig, { ratio: null }).map((c, i) => ({ ...c, volume: i % 2 === 0 ? 500 : 1500 }));
    expect(analyzeOrderFlow(cs).divergence).toBe('BULLISH');
  });

  it('EDGE-OF-002 data kurang dari window+1 → semua null', () => {
    const r = analyzeOrderFlow(makeCandles(flat.slice(0, 20), { ratio: 0.6 }));
    expect(Object.values(r).every((v) => v === null)).toBe(true);
  });

  it('SEC-OF-001 anti-lookahead: hasil pada prefix tidak berubah saat candle masa depan ditambahkan', () => {
    const all = golden.candles;
    for (const n of [25, 35, 45]) {
      const prefix = all.slice(0, n);
      const before = analyzeOrderFlow(prefix, { window: 10, divergenceLookback: 20 });
      // Tambah candle masa depan yang ekstrem, lalu evaluasi kembali pada indeks n−1.
      const extended = [...prefix.map((c) => ({ ...c })), ...all.slice(n).map((c) => ({ ...c, volume: c.volume * 50 }))];
      const again = analyzeOrderFlow(extended.slice(0, n), { window: 10, divergenceLookback: 20 });
      expect(again).toEqual(before);
      // Seri per indeks juga tidak berubah untuk indeks < n.
      expect(cvd(extended).slice(0, n)).toEqual(cvd(prefix));
      expect(obv(extended).slice(0, n)).toEqual(obv(prefix));
      expect(accumulationDistribution(extended).slice(0, n)).toEqual(accumulationDistribution(prefix));
      expect(cmf(extended, 10).slice(0, n)).toEqual(cmf(prefix, 10));
    }
  });
});

describe('order flow — baris lama tanpa taker', () => {
  it('EDGE-OF-TAKER-001 jendela campuran (sebagian takerBuyVolume 0 dari data lama) → taker/CVD null, bukan jual agresif palsu', () => {
    const candles = makeCandles(Array.from({ length: 60 }, (_, i) => 100 + i * 0.1), { ratio: 0.6 });
    for (let i = 0; i < 45; i += 1) candles[i] = { ...candles[i], takerBuyVolume: 0, takerBuyQuoteVolume: 0 };
    const r = analyzeOrderFlow(candles);
    expect(r.takerBuyRatio).toBeNull();
    expect(r.cvdSlope).toBeNull();
    expect(r.divergence).not.toBe('BEARISH');
  });
});
