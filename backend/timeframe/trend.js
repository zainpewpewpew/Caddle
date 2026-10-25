// Trend classifier timeframe — independen dari detektor pola (SA/PVA).
// Fungsi murni: hanya membaca candle yang diberikan (pemanggil wajib menyaring dengan
// closedAsOf agar tidak ada lookahead). Tanpa I/O, tanpa waktu sistem.
//
// Empat komponen bersuara +1 (bullish), -1 (bearish), atau 0 (netral):
//   1. close terakhir vs EMA lambat (default EMA25)
//   2. EMA cepat (EMA7) vs EMA lambat
//   3. slope EMA lambat ternormalisasi (fraksi per candle) vs ±slopeThreshold
//   4. struktur swing TERKONFIRMASI: 2 swing high & 2 swing low terakhir
//      HH+HL → +1, LH+LL → -1, lainnya 0
// Skor = jumlah komponen (-4..4).
//   BULLISH : skor ≥ minScore DAN close > EMA lambat
//   BEARISH : skor ≤ -minScore DAN close < EMA lambat
//   NEUTRAL : selain itu, atau data kurang dari warm-up (reason 'INSUFFICIENT_DATA')

import { confirmedAt, ema, findSwings, normalizedSlope } from '../indicators/index.js';

export const DEFAULT_TREND_PARAMS = Object.freeze({
  fastPeriod: 7,
  slowPeriod: 25,
  slopeLookback: 5,
  /** Ambang slope EMA lambat ternormalisasi (0.0002 = 0,02% per candle). */
  slopeThreshold: 0.0002,
  swingLeft: 2,
  swingRight: 2,
  /** Jumlah komponen searah minimum (1..4). */
  minScore: 3,
});

const INTEGER_PARAMS = ['fastPeriod', 'slowPeriod', 'slopeLookback', 'swingLeft', 'swingRight', 'minScore'];

/** Menggabungkan & memvalidasi parameter trend. */
export function resolveTrendParams(overrides = {}) {
  if (overrides === null || typeof overrides !== 'object') throw new TypeError('Parameter trend harus objek');
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(DEFAULT_TREND_PARAMS, key)) throw new TypeError(`Parameter trend tidak dikenal: ${key}`);
  }
  const p = { ...DEFAULT_TREND_PARAMS, ...overrides };
  for (const key of INTEGER_PARAMS) {
    if (!Number.isInteger(p[key]) || p[key] < 1) throw new RangeError(`${key} harus bilangan bulat ≥ 1`);
  }
  if (p.slopeLookback < 2) throw new RangeError('slopeLookback harus ≥ 2');
  if (p.fastPeriod >= p.slowPeriod) throw new RangeError('fastPeriod harus lebih kecil dari slowPeriod');
  if (p.minScore > 4) throw new RangeError('minScore maksimum 4');
  if (typeof p.slopeThreshold !== 'number' || !Number.isFinite(p.slopeThreshold) || p.slopeThreshold < 0) {
    throw new RangeError('slopeThreshold harus angka ≥ 0');
  }
  return Object.freeze(p);
}

/** Jumlah candle minimum agar seluruh komponen EMA dapat dihitung. */
export function trendWarmup(params = DEFAULT_TREND_PARAMS) {
  return params.slowPeriod + params.slopeLookback - 1;
}

function assertCandles(candles) {
  if (!Array.isArray(candles)) throw new TypeError('candles harus array');
  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i];
    if (!c || !Number.isFinite(c.close) || !Number.isFinite(c.high) || !Number.isFinite(c.low)) {
      throw new TypeError(`Candle tidak valid pada indeks ${i}`);
    }
    if (i > 0 && !(c.openTime > candles[i - 1].openTime)) throw new RangeError('Candle harus urut naik berdasarkan openTime');
  }
}

function swingStructure(candles, p) {
  const evalIndex = candles.length - 1;
  const { highs, lows } = confirmedAt(findSwings(candles, { left: p.swingLeft, right: p.swingRight }), evalIndex);
  if (highs.length < 2 || lows.length < 2) return { vote: 0, reason: 'SWING_INSUFFICIENT' };
  const [h1, h2] = highs.slice(-2);
  const [l1, l2] = lows.slice(-2);
  if (h2.price > h1.price && l2.price > l1.price) return { vote: 1, reason: 'SWING_HH_HL' };
  if (h2.price < h1.price && l2.price < l1.price) return { vote: -1, reason: 'SWING_LH_LL' };
  return { vote: 0, reason: 'SWING_MIXED' };
}

/**
 * Mengklasifikasikan tren dari candle tertutup (satu simbol & timeframe, urut naik).
 * @param {import('../market/contracts.js').Candle[]} candles
 * @param {Partial<typeof DEFAULT_TREND_PARAMS>} [params]
 * @returns {{ trend: 'BULLISH'|'NEUTRAL'|'BEARISH', reasons: string[], score: number }}
 */
export function classifyTrend(candles, params = {}) {
  const p = resolveTrendParams(params);
  assertCandles(candles);
  if (candles.length < trendWarmup(p)) return { trend: 'NEUTRAL', reasons: ['INSUFFICIENT_DATA'], score: 0 };

  const closes = candles.map((c) => c.close);
  const last = closes.length - 1;
  const fast = ema(closes, p.fastPeriod)[last];
  const slowSeries = ema(closes, p.slowPeriod);
  const slow = slowSeries[last];
  const slope = normalizedSlope(slowSeries, p.slopeLookback)[last];
  const close = closes[last];

  const reasons = [];
  let score = 0;

  if (close > slow) { score += 1; reasons.push('CLOSE_ABOVE_SLOW_EMA'); }
  else if (close < slow) { score -= 1; reasons.push('CLOSE_BELOW_SLOW_EMA'); }
  else reasons.push('CLOSE_AT_SLOW_EMA');

  if (fast > slow) { score += 1; reasons.push('FAST_EMA_ABOVE_SLOW'); }
  else if (fast < slow) { score -= 1; reasons.push('FAST_EMA_BELOW_SLOW'); }
  else reasons.push('FAST_EMA_AT_SLOW');

  if (slope > p.slopeThreshold) { score += 1; reasons.push('SLOW_EMA_RISING'); }
  else if (slope < -p.slopeThreshold) { score -= 1; reasons.push('SLOW_EMA_FALLING'); }
  else reasons.push('SLOW_EMA_FLAT');

  const swing = swingStructure(candles, p);
  score += swing.vote;
  reasons.push(swing.reason);

  let trend = 'NEUTRAL';
  if (score >= p.minScore && close > slow) trend = 'BULLISH';
  else if (score <= -p.minScore && close < slow) trend = 'BEARISH';
  return { trend, reasons, score };
}
