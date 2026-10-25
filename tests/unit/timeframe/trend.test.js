import { describe, expect, it } from 'vitest';
import { TIMEFRAME_MS } from '../../../backend/market/contracts.js';
import { DEFAULT_TREND_PARAMS, classifyTrend } from '../../../backend/timeframe/index.js';

// Data uji deterministik (gelombang sinus + drift) — sintetis, bukan data pasar nyata.
const T0 = Date.UTC(2026, 0, 5, 0, 0, 0);

function series(timeframe, closes, start = T0) {
  const ms = TIMEFRAME_MS[timeframe];
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1];
    return {
      symbol: 'BTCUSDT', timeframe, openTime: start + i * ms, closeTime: start + (i + 1) * ms - 1,
      open, high: Math.max(open, close) * 1.002, low: Math.min(open, close) * 0.998, close,
      volume: 100, quoteVolume: 100 * close, trades: 10, takerBuyVolume: 50, takerBuyQuoteVolume: 50 * close,
      isClosed: true, source: 'rest',
    };
  });
}

const wave = (n, drift, { amp = 0.6, period = 6, base = 100 } = {}) =>
  Array.from({ length: n }, (_, i) => base + drift * i + amp * Math.sin((2 * Math.PI * i) / period));

describe('trend classifier', () => {
  it('POS-TRND-001 tren naik bergelombang → BULLISH dengan alasan EMA, slope, dan struktur swing', () => {
    const r = classifyTrend(series('15m', wave(60, 0.3)));
    expect(r.trend).toBe('BULLISH');
    expect(r.reasons).toEqual(expect.arrayContaining(['CLOSE_ABOVE_SLOW_EMA', 'FAST_EMA_ABOVE_SLOW', 'SLOW_EMA_RISING', 'SWING_HH_HL']));
    expect(r.score).toBe(4);
  });

  it('POS-TRND-002 tren turun bergelombang → BEARISH', () => {
    const r = classifyTrend(series('1h', wave(60, -0.3, { base: 200 })));
    expect(r.trend).toBe('BEARISH');
    expect(r.reasons).toEqual(expect.arrayContaining(['CLOSE_BELOW_SLOW_EMA', 'FAST_EMA_BELOW_SLOW', 'SLOW_EMA_FALLING', 'SWING_LH_LL']));
    expect(r.score).toBe(-4);
  });

  it('UNIT-TRND-001 pasar datar → NEUTRAL dengan slope datar', () => {
    const r = classifyTrend(series('15m', wave(60, 0)));
    expect(r.trend).toBe('NEUTRAL');
    expect(r.reasons).toContain('SLOW_EMA_FLAT');
  });

  it('EDGE-TRND-001 data kurang dari warm-up → NEUTRAL dengan INSUFFICIENT_DATA', () => {
    const min = DEFAULT_TREND_PARAMS.slowPeriod + DEFAULT_TREND_PARAMS.slopeLookback - 1;
    expect(classifyTrend(series('15m', wave(min - 1, 0.3)))).toEqual({ trend: 'NEUTRAL', reasons: ['INSUFFICIENT_DATA'], score: 0 });
    expect(classifyTrend([])).toEqual({ trend: 'NEUTRAL', reasons: ['INSUFFICIENT_DATA'], score: 0 });
    // Tepat di batas warm-up sudah dapat diklasifikasikan.
    expect(classifyTrend(series('15m', wave(min, 0.3))).reasons).not.toContain('INSUFFICIENT_DATA');
  });

  it('UNIT-TRND-002 sinyal campuran (harga di atas EMA tetapi struktur & slope turun) → NEUTRAL', () => {
    // Tren turun panjang lalu satu lonjakan tajam: close > EMA25, tetapi slope & swing masih bearish.
    const closes = wave(60, -0.3, { base: 200 });
    closes.push(closes[closes.length - 1] + 12);
    const r = classifyTrend(series('15m', closes));
    expect(r.reasons).toContain('CLOSE_ABOVE_SLOW_EMA');
    expect(r.reasons).toContain('SLOW_EMA_FALLING');
    expect(r.trend).toBe('NEUTRAL');
  });

  it('UNIT-TRND-003 swing yang belum terkonfirmasi tidak dipakai (anti lookahead)', () => {
    const base = series('15m', wave(60, 0.3));
    const r1 = classifyTrend(base);
    // Menambah satu candle saja tidak dapat mengonfirmasi swing baru (butuh `right` candle sesudahnya).
    const extra = series('15m', [base[59].close + 0.1], base[59].openTime + TIMEFRAME_MS['15m']);
    const r2 = classifyTrend([...base, ...extra]);
    expect(r2.reasons.filter((x) => x.startsWith('SWING_'))).toEqual(r1.reasons.filter((x) => x.startsWith('SWING_')));
  });

  it('UNIT-TRND-004 parameter dapat dikonfigurasi (minScore 4 → sinyal 3/4 menjadi NEUTRAL)', () => {
    // Kenaikan linear tanpa gelombang: belum ada swing terkonfirmasi → skor 3 dari 4.
    const linear = series('15m', wave(60, 0.3, { amp: 0 }));
    const normal = classifyTrend(linear);
    expect(normal.reasons).toContain('SWING_INSUFFICIENT');
    expect(normal.score).toBe(3);
    expect(normal.trend).toBe('BULLISH');
    expect(classifyTrend(linear, { minScore: 4 }).trend).toBe('NEUTRAL');
    expect(classifyTrend(series('15m', wave(60, -0.3, { base: 200 })), { minScore: 4 }).trend).toBe('BEARISH');
  });

  it('NEG-TRND-001 input & parameter tidak valid ditolak', () => {
    expect(() => classifyTrend(null)).toThrow(TypeError);
    expect(() => classifyTrend(series('15m', wave(40, 0.3)), { slowPeriod: 0 })).toThrow(RangeError);
    expect(() => classifyTrend(series('15m', wave(40, 0.3)), { fastPeriod: 30, slowPeriod: 25 })).toThrow(RangeError);
    expect(() => classifyTrend(series('15m', wave(40, 0.3)), { tidakDikenal: 1 })).toThrow(TypeError);
    expect(() => classifyTrend(series('15m', wave(40, 0.3)), { minScore: 5 })).toThrow(RangeError);
    expect(() => classifyTrend(series('15m', wave(40, 0.3)), { slopeThreshold: -1 })).toThrow(RangeError);
    const unordered = series('15m', wave(40, 0.3));
    [unordered[3], unordered[4]] = [unordered[4], unordered[3]];
    expect(() => classifyTrend(unordered)).toThrow(/urut/);
  });
});
