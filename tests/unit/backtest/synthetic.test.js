import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MARKUP_BARS,
  REGIME_TYPES,
  aggregateCandles,
  createRng,
  deriveSeed,
  generateSeries,
  generateUniverse,
  mirrorSeries,
  normal,
} from '../../../backend/backtest/synthetic.js';
import { TIMEFRAME_MS, isAlignedOpenTime } from '../../../backend/market/contracts.js';
import { evaluatePatterns, evaluateShortPatterns } from '../../../backend/patterns/index.js';

// Data sintetis — bukan data pasar nyata. Menguji mekanisme generator untuk backtest.

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const std = (xs) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
const logReturns = (candles) => candles.slice(1).map((c, i) => Math.log(c.close / candles[i].close));

const PATTERN_PLAN = [
  { type: 'RANDOM_WALK', bars: 150 },
  { type: 'ACCUMULATION', bars: 80 },
  { type: 'RANDOM_WALK', bars: 50 },
  { type: 'DISTRIBUTION', bars: 80 },
  { type: 'RANDOM_WALK', bars: 30 },
];

function expectContract(candles, timeframe = '15m') {
  const ms = TIMEFRAME_MS[timeframe];
  candles.forEach((c, i) => {
    expect(isAlignedOpenTime(c.openTime, timeframe)).toBe(true);
    expect(c.closeTime).toBe(c.openTime + ms - 1);
    if (i > 0) expect(c.openTime - candles[i - 1].openTime).toBe(ms);
    expect(c.low).toBeGreaterThan(0);
    expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
    expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
    expect(c.volume).toBeGreaterThan(0);
    expect(c.quoteVolume).toBeGreaterThan(0);
    expect(Number.isInteger(c.trades) && c.trades >= 1).toBe(true);
    expect(c.takerBuyVolume).toBeGreaterThanOrEqual(0);
    expect(c.takerBuyVolume).toBeLessThanOrEqual(c.volume);
    expect(c.takerBuyQuoteVolume).toBeLessThanOrEqual(c.quoteVolume);
    expect(c).toMatchObject({ timeframe, isClosed: true, source: 'rest' });
  });
}

describe('PRNG berbenih', () => {
  it('UNIT-BSYN-001 createRng deterministik, di [0,1), berbeda antar-benih; benih string valid', () => {
    const seq = (s) => Array.from({ length: 50 }, createRng(s));
    expect(seq(42)).toEqual(seq(42));
    expect(seq(42)).not.toEqual(seq(43));
    expect(seq('BTCUSDT')).toEqual(seq('BTCUSDT'));
    for (const v of seq(7)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(deriveSeed(1, 0)).toBe(deriveSeed(1, 0));
    expect(deriveSeed(1, 0)).not.toBe(deriveSeed(1, 1));
  });

  it('UNIT-BSYN-002 normal() ≈ N(0,1)', () => {
    const rng = createRng(11);
    const xs = Array.from({ length: 20000 }, () => normal(rng));
    expect(xs.every(Number.isFinite)).toBe(true);
    expect(Math.abs(mean(xs))).toBeLessThan(0.03);
    expect(Math.abs(std(xs) - 1)).toBeLessThan(0.03);
  });
});

describe('generateSeries', () => {
  it('UNIT-BSYN-003 benih sama → output identik; benih beda → berbeda; tanpa Math.random', () => {
    expect(generateSeries({ seed: 9, bars: 500 })).toEqual(generateSeries({ seed: 9, bars: 500 }));
    expect(generateSeries({ seed: 9, bars: 500 })).not.toEqual(generateSeries({ seed: 10, bars: 500 }));
    const src = readFileSync(new URL('../../../backend/backtest/synthetic.js', import.meta.url), 'utf8');
    expect(src).not.toMatch(/Math\.random\s*\(/);
  });

  it('UNIT-BSYN-004 kontrak candle & invarian OHLC/taker di semua rezim dan timeframe', () => {
    for (const seed of [1, 2, 3]) {
      const candles = generateSeries({ seed, bars: 2000 });
      expect(candles).toHaveLength(2000);
      expect(candles[0].openTime).toBe(Date.UTC(2025, 0, 1));
      expect(candles[0].symbol).toBe('SYNUSDT');
      expectContract(candles);
    }
    const all = generateSeries({ seed: 4, regimes: REGIME_TYPES.map((type) => ({ type, bars: 60 })) });
    expectContract(all);
    expectContract(generateSeries({ seed: 5, bars: 300, timeframe: '5m' }), '5m');
    expectContract(generateSeries({ seed: 5, bars: 300, timeframe: '1h', startPrice: 0.0004 }), '1h');
  });

  it('UNIT-BSYN-005 RANDOM_WALK tanpa drift: rata-rata log-return ≈ 0, taker buy ≈ 0,5', () => {
    const candles = generateSeries({ seed: 21, regimes: [{ type: 'RANDOM_WALK', bars: 20000 }] });
    const r = logReturns(candles);
    const se = std(r) / Math.sqrt(r.length);
    expect(Math.abs(mean(r))).toBeLessThan(4 * se);
    const takerRatio = candles.reduce((a, c) => a + c.takerBuyVolume, 0) / candles.reduce((a, c) => a + c.volume, 0);
    expect(Math.abs(takerRatio - 0.5)).toBeLessThan(0.005);
  });

  it('UNIT-BSYN-006 TREND_UP naik, TREND_DOWN turun, RANGE kembali ke pusat', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const { candles, segments } = generateSeries({
        seed, withMeta: true,
        regimes: [{ type: 'TREND_UP', bars: 300 }, { type: 'TREND_DOWN', bars: 300 }, { type: 'RANGE', bars: 400 }],
      });
      const [up, down, range] = segments;
      expect(candles[up.endIndex].close).toBeGreaterThan(candles[up.startIndex].open * 1.1);
      expect(candles[down.endIndex].close).toBeLessThan(candles[down.startIndex].open * 0.9);
      const center = candles[range.startIndex].open;
      const closes = candles.slice(range.startIndex, range.endIndex + 1).map((c) => c.close);
      expect(Math.max(...closes) / center).toBeLessThan(1.06);
      expect(Math.min(...closes) / center).toBeGreaterThan(0.94);
    }
  });

  it('UNIT-BSYN-007 metadata segmen: ACCUMULATION/DISTRIBUTION diikuti markup/markdown otomatis', () => {
    const { candles, segments } = generateSeries({ seed: 3, withMeta: true, regimes: PATTERN_PLAN });
    expect(segments.map((s) => s.type)).toEqual(['RANDOM_WALK', 'ACCUMULATION', 'TREND_UP', 'RANDOM_WALK', 'DISTRIBUTION', 'TREND_DOWN', 'RANDOM_WALK']);
    expect(candles).toHaveLength(150 + 80 + DEFAULT_MARKUP_BARS + 50 + 80 + DEFAULT_MARKUP_BARS + 30);
    segments.forEach((s, k) => {
      if (k > 0) expect(s.startIndex).toBe(segments[k - 1].endIndex + 1);
    });
    expect(segments[2]).toMatchObject({ auto: true, startIndex: 230, endIndex: 230 + DEFAULT_MARKUP_BARS - 1 });
    expect(segments.at(-1).endIndex).toBe(candles.length - 1);
    const noMarkup = generateSeries({ seed: 3, withMeta: true, regimes: [{ type: 'ACCUMULATION', bars: 40, markupBars: 0 }] });
    expect(noMarkup.segments).toHaveLength(1);
  });

  it('UNIT-BSYN-008 ACCUMULATION: volume senyap lalu naik, taker buy > 0,5, higher low, diikuti kenaikan (cermin untuk DISTRIBUTION)', () => {
    for (let seed = 1; seed <= 10; seed += 1) {
      const { candles, segments } = generateSeries({ seed, withMeta: true, regimes: PATTERN_PLAN });
      const acc = segments[1];
      const markup = segments[2];
      const seg = candles.slice(acc.startIndex, acc.endIndex + 1);
      const before = candles.slice(acc.startIndex - 50, acc.startIndex);
      const quiet = seg.slice(0, 30);
      expect(mean(quiet.map((c) => c.volume))).toBeLessThan(0.7 * mean(before.map((c) => c.volume)));
      expect(mean(seg.slice(-10).map((c) => c.volume))).toBeGreaterThan(2 * mean(quiet.map((c) => c.volume)));
      const taker = seg.reduce((a, c) => a + c.takerBuyVolume, 0) / seg.reduce((a, c) => a + c.volume, 0);
      expect(taker).toBeGreaterThan(0.52);
      // Higher low: low terendah paruh kedua di atas low terendah paruh pertama; range sempit.
      const lows = seg.map((c) => c.low);
      expect(Math.min(...lows.slice(40))).toBeGreaterThan(Math.min(...lows.slice(0, 40)));
      expect(Math.max(...seg.map((c) => c.high)) / Math.min(...lows)).toBeLessThan(1.08);
      expect(candles[markup.endIndex].close).toBeGreaterThan(candles[acc.endIndex].close);

      const dist = segments[4];
      const markdown = segments[5];
      const dseg = candles.slice(dist.startIndex, dist.endIndex + 1);
      const dtaker = dseg.reduce((a, c) => a + c.takerBuyVolume, 0) / dseg.reduce((a, c) => a + c.volume, 0);
      expect(dtaker).toBeLessThan(0.48);
      const highs = dseg.map((c) => c.high);
      expect(Math.max(...highs.slice(40))).toBeLessThan(Math.max(...highs.slice(0, 40)));
      expect(candles[markdown.endIndex].close).toBeLessThan(candles[dist.endIndex].close);
    }
  });

  it('UNIT-BSYN-009 plant menyisipkan rezim pada indeks final; mode acak tetap tepat `bars`', () => {
    const { candles, segments } = generateSeries({ seed: 8, bars: 1000, withMeta: true, plant: [{ type: 'ACCUMULATION', at: 400 }, { type: 'DISTRIBUTION', at: 700, bars: 60 }] });
    expect(candles).toHaveLength(1000);
    const acc = segments.find((s) => s.planted && s.type === 'ACCUMULATION');
    const dist = segments.find((s) => s.planted && s.type === 'DISTRIBUTION');
    expect(acc).toMatchObject({ startIndex: 400, endIndex: 479 });
    expect(dist).toMatchObject({ startIndex: 700, endIndex: 759 });
    expect(segments.at(-1).endIndex).toBe(999);
    expectContract(candles);
  });

  it('UNIT-BSYN-010 input tidak valid ditolak', () => {
    expect(() => generateSeries({ regimes: [{ type: 'MOON', bars: 10 }] })).toThrow(RangeError);
    expect(() => generateSeries({ regimes: [{ type: 'RANGE', bars: 0 }] })).toThrow(RangeError);
    expect(() => generateSeries({ timeframe: '4h' })).toThrow(RangeError);
    expect(() => generateSeries({ startTime: Date.UTC(2025, 0, 1, 0, 7) })).toThrow(RangeError);
    expect(() => generateSeries({ mix: { MOON: 1 } })).toThrow(RangeError);
  });

  it('UNIT-BSYN-011 cepat: 2000 bar < 50 ms', () => {
    generateSeries({ seed: 1, bars: 2000 }); // pemanasan JIT
    const t0 = performance.now();
    generateSeries({ seed: 2, bars: 2000 });
    expect(performance.now() - t0).toBeLessThan(50);
  });
});

describe('generateUniverse & mirrorSeries', () => {
  it('UNIT-BSYN-012 seri berbeda per simbol, deterministik, skala harga beragam', () => {
    const u = generateUniverse({ symbols: 5, bars: 300, seed: 3 });
    expect([...u.keys()]).toEqual(['SYN00USDT', 'SYN01USDT', 'SYN02USDT', 'SYN03USDT', 'SYN04USDT']);
    const again = generateUniverse({ symbols: 5, bars: 300, seed: 3 });
    for (const [sym, candles] of u) {
      expect(candles).toHaveLength(300);
      expect(candles.every((c) => c.symbol === sym)).toBe(true);
      expect(again.get(sym)).toEqual(candles);
      expectContract(candles);
    }
    const firstCloses = [...u.values()].map((c) => c[0].close);
    expect(new Set(firstCloses).size).toBe(5);
    const named = generateUniverse({ symbols: ['AAAUSDT', 'BBBUSDT'], bars: 100, seed: 3, mix: ['RANGE'] });
    expect([...named.keys()]).toEqual(['AAAUSDT', 'BBBUSDT']);
  });

  it('UNIT-BSYN-013 mirrorSeries: harga 1/p, high ↔ low, sisi taker ditukar', () => {
    const candles = generateSeries({ seed: 2, bars: 100 });
    const m = mirrorSeries(candles);
    m.forEach((c, i) => {
      const o = candles[i];
      expect(c.close).toBeCloseTo(1 / o.close, 12);
      expect(c.high).toBeCloseTo(1 / o.low, 12);
      expect(c.takerBuyVolume).toBeCloseTo(o.volume - o.takerBuyVolume, 9);
      expect(c.takerBuyVolume).toBeLessThanOrEqual(c.volume);
    });
  });
});

describe('aggregateCandles', () => {
  const T0 = Date.UTC(2025, 0, 1);
  const Q = TIMEFRAME_MS['15m'];
  const mk = (k, o, h, l, c, v, extra = {}) => ({
    symbol: 'X', timeframe: '15m', openTime: T0 + k * Q, closeTime: T0 + (k + 1) * Q - 1, open: o, high: h, low: l, close: c,
    volume: v, quoteVolume: v * 10, trades: v, takerBuyVolume: v / 2, takerBuyQuoteVolume: v * 5, isClosed: true, source: 'rest', ...extra,
  });

  it('UNIT-BSYN-014 contoh kecil: OHLC & jumlah benar, grup tidak lengkap/belum tertutup dibuang', () => {
    const small = [
      mk(0, 10, 12, 9, 11, 1), mk(1, 11, 13, 10, 12, 2), mk(2, 12, 15, 11, 14, 3), mk(3, 14, 14, 8, 9, 4),
      mk(4, 9, 10, 8, 9.5, 5), mk(5, 9.5, 11, 9, 10, 6), // jam ke-2 hanya 2 candle → tidak lengkap
    ];
    expect(aggregateCandles(small, '1h')).toEqual([{
      symbol: 'X', timeframe: '1h', openTime: T0, closeTime: T0 + 3_600_000 - 1, open: 10, high: 15, low: 8, close: 9,
      volume: 10, quoteVolume: 100, trades: 10, takerBuyVolume: 5, takerBuyQuoteVolume: 50, isClosed: true, source: 'rest',
    }]);
    const notClosed = small.slice(0, 4).map((c, i) => (i === 3 ? { ...c, isClosed: false, source: 'ws' } : c));
    expect(aggregateCandles(notClosed, '1h')).toEqual([]);
    const gap = [mk(0, 1, 1, 1, 1, 1), mk(1, 1, 1, 1, 1, 1), mk(3, 1, 1, 1, 1, 1), mk(4, 1, 1, 1, 1, 1)];
    expect(aggregateCandles(gap, '1h')).toEqual([]);
    expect(aggregateCandles([], '1h')).toEqual([]);
    expect(() => aggregateCandles(small, '5m')).toThrow(RangeError);
  });

  it('UNIT-BSYN-015 seri generator 15m → 1h konsisten dengan kontrak', () => {
    const c15 = generateSeries({ seed: 6, bars: 401 });
    const h1 = aggregateCandles(c15, '1h');
    expect(h1).toHaveLength(100); // 2025-01-01 00:00 sejajar jam; candle ke-401 belum lengkap
    expectContract(h1, '1h');
    expect(h1[5].open).toBe(c15[20].open);
    expect(h1[5].close).toBe(c15[23].close);
    expect(h1[5].volume).toBeCloseTo(c15.slice(20, 24).reduce((a, c) => a + c.volume, 0), 9);
  });
});

describe('integrasi ringan dengan detektor pola', () => {
  it('UNIT-BSYN-016 SA atau PVA terdeteksi di segmen ACCUMULATION; SD atau PVD di DISTRIBUTION', () => {
    for (const seed of [1, 2, 3]) {
      const { candles, segments } = generateSeries({ seed, withMeta: true, regimes: PATTERN_PLAN });
      const acc = segments[1];
      const dist = segments[4];
      let longHits = 0;
      for (let i = acc.startIndex; i <= acc.endIndex; i += 1) {
        if (evaluatePatterns(candles.slice(0, i + 1)).classification !== 'NONE') longHits += 1;
      }
      let shortHits = 0;
      for (let i = dist.startIndex; i <= dist.endIndex; i += 1) {
        if (evaluateShortPatterns(candles.slice(0, i + 1)).classification !== 'NONE') shortHits += 1;
      }
      expect(longHits).toBeGreaterThan(0);
      expect(shortHits).toBeGreaterThan(0);
    }
  });
});
