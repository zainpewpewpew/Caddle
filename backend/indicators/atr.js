import { assertPeriod } from './ema.js';

/** True range per candle. Candle pertama memakai high - low. */
export function trueRange(candles) {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
}

/**
 * Average True Range metode Wilder (RMA). Nilai pertama di indeks period-1 = rata-rata TR.
 * @returns {(number|null)[]}
 */
export function atr(candles, period = 14) {
  assertPeriod(period);
  const tr = trueRange(candles);
  const out = new Array(candles.length).fill(null);
  if (candles.length < period) return out;
  let prev = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < tr.length; i += 1) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** ATR sebagai fraksi harga close (volatilitas ternormalisasi). */
export function atrPercent(candles, period = 14) {
  const a = atr(candles, period);
  return a.map((v, i) => (v === null || candles[i].close <= 0 ? null : v / candles[i].close));
}
