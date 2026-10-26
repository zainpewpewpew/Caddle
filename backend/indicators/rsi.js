// RSI (Relative Strength Index) metode Wilder. Output sepanjang input; null selama warm-up.
//
// Metode: perubahan close d_i = close_i − close_{i−1}; gain_i = max(d_i, 0), loss_i = max(−d_i, 0).
// Seed = rata-rata sederhana `period` gain/loss pertama (indeks 1..period), lalu smoothing Wilder (RMA):
//   avg_i = (avg_{i−1} × (period − 1) + x_i) / period.
// RSI_i = 100 − 100 / (1 + avgGain_i / avgLoss_i). Konvensi pembagian nol (sama dengan TradingView):
// avgLoss = 0 → 100; avgGain = 0 → 0. Nilai pertama sah di indeks `period`; indeks 0..period−1 null.
//
// Anti-lookahead: nilai pada indeks i hanya memakai close ≤ i. Tanpa I/O, tanpa waktu sistem.
import { assertPeriod } from './ema.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * @param {number[]} closes
 * @param {number} [period=14]
 * @returns {(number|null)[]}
 * @throws {RangeError} periode bukan bilangan bulat ≥ 1
 * @throws {TypeError} closes bukan array atau memuat nilai non-hingga
 */
export function rsi(closes, period = 14) {
  assertPeriod(period);
  if (!Array.isArray(closes)) throw new TypeError('closes harus berupa array');
  const out = new Array(closes.length).fill(null);
  closes.forEach((v, i) => { if (!isNum(v)) throw new TypeError(`Nilai tidak valid pada indeks ${i}`); });
  if (closes.length <= period) return out;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i += 1) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d;
    else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = toRsi(avgGain, avgLoss);
  for (let i = period + 1; i < closes.length; i += 1) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }
  return out;
}

function toRsi(avgGain, avgLoss) {
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  return 100 - 100 / (1 + avgGain / avgLoss);
}
