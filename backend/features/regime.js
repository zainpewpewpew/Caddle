// Fitur rezim pasar v3 (kontrak: docs/10-kontrak-akurasi-v3.md bagian 3).
// Fungsi murni: input array → output array sepanjang input, null selama warm-up / bila tak terhitung.
// Nilai pada indeks i hanya memakai data indeks ≤ i (anti lookahead).
//
// Ambang klasifikasi adalah KONVENSI UMUM literatur, bukan hasil optimasi pada data:
//   - ADX ≥ 25 = tren, ADX < 20 = tanpa tren (J. Welles Wilder, "New Concepts in Technical Trading
//     Systems", 1978; praktik umum ADX 20/25).
//   - Choppiness ≥ 61.8 = choppy (E.W. Dreiss; batas Fibonacci 61.8 / 38.2).
//   - Squeeze = bandwidth Bollinger berada di 20% terbawah riwayatnya (gagasan "The Squeeze",
//     John Bollinger, "Bollinger on Bollinger Bands", 2001).
// Implementasi ADX & bandwidth diverifikasi terhadap pustaka open source `ta` (bukosabino/ta) lewat
// fixture tests/fixtures/features/regime-golden.json (generator: scripts/golden/regime_golden.py).

import { assertPeriod } from '../indicators/ema.js';
import { trueRange } from '../indicators/atr.js';

/** Ambang klasifikasi rezim (konvensi Wilder/Dreiss/Bollinger, bukan hasil optimasi). */
export const REGIME_THRESHOLDS = Object.freeze({
  adxTrend: 25,
  adxWeak: 20,
  chopChoppy: 61.8,
  squeezePercentile: 0.2,
});

export const REGIMES = Object.freeze({
  TRENDING_UP: 'TRENDING_UP',
  TRENDING_DOWN: 'TRENDING_DOWN',
  RANGING: 'RANGING',
  CHOPPY: 'CHOPPY',
  SQUEEZE: 'SQUEEZE',
});

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function assertArray(values, name) {
  if (!Array.isArray(values)) throw new TypeError(`${name} harus berupa array`);
}

function assertCandles(candles) {
  assertArray(candles, 'candles');
  candles.forEach((c, i) => {
    if (!c || !isNum(c.high) || !isNum(c.low) || !isNum(c.close)) {
      throw new TypeError(`Candle tidak valid pada indeks ${i}`);
    }
  });
}

function assertCloses(closes) {
  assertArray(closes, 'closes');
  closes.forEach((v, i) => { if (!isNum(v)) throw new TypeError(`Nilai tidak valid pada indeks ${i}`); });
}

/**
 * Smoothing Wilder (RMA) atas `values[start..]`: seed = rata-rata `period` nilai pertama mulai `start`
 * (nilai seed berada di indeks start+period-1), lalu prev = (prev·(period−1) + x) / period.
 */
function wilderRma(values, period, start) {
  const out = new Array(values.length).fill(null);
  const seedEnd = start + period - 1;
  if (seedEnd >= values.length) return out;
  let sum = 0;
  for (let i = start; i <= seedEnd; i += 1) sum += values[i];
  let prev = sum / period;
  out[seedEnd] = prev;
  for (let i = seedEnd + 1; i < values.length; i += 1) {
    prev = (prev * (period - 1) + values[i]) / period;
    out[i] = prev;
  }
  return out;
}

/**
 * ADX / +DI / −DI metode Wilder.
 * TR, +DM, −DM dihitung mulai indeks 1 (butuh candle sebelumnya); di-smoothing RMA dengan seed rata-rata
 * indeks 1..period → +DI/−DI pertama sah di indeks `period`. DX = 100·|+DI − −DI| / (+DI + −DI);
 * ADX = RMA(DX) dengan seed rata-rata DX indeks period..2·period−1 → ADX pertama di indeks 2·period−1.
 * Konvensi seed ini identik dengan `ta.trend.ADXIndicator` (Wilder: seed jumlah, rasio sama).
 * Bila TR ter-smoothing = 0 (harga datar total) maka DI = 0, dan bila +DI + −DI = 0 maka DX = 0.
 * @returns {{ adx: (number|null)[], plusDi: (number|null)[], minusDi: (number|null)[] }}
 */
export function adx(candles, period = 14) {
  assertPeriod(period);
  assertCandles(candles);
  const n = candles.length;
  const empty = () => new Array(n).fill(null);
  const result = { adx: empty(), plusDi: empty(), minusDi: empty() };
  if (n <= period) return result;

  const tr = trueRange(candles);
  const plusDm = new Array(n).fill(0);
  const minusDm = new Array(n).fill(0);
  for (let i = 1; i < n; i += 1) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
  }
  const trS = wilderRma(tr, period, 1);
  const plusS = wilderRma(plusDm, period, 1);
  const minusS = wilderRma(minusDm, period, 1);

  const dx = new Array(n).fill(null);
  for (let i = period; i < n; i += 1) {
    const pdi = trS[i] > 0 ? (100 * plusS[i]) / trS[i] : 0;
    const mdi = trS[i] > 0 ? (100 * minusS[i]) / trS[i] : 0;
    result.plusDi[i] = pdi;
    result.minusDi[i] = mdi;
    const sum = pdi + mdi;
    dx[i] = sum > 0 ? (100 * Math.abs(pdi - mdi)) / sum : 0;
  }
  const adxSeries = wilderRma(dx.map((v) => v ?? 0), period, period);
  for (let i = 2 * period - 1; i < n; i += 1) result.adx[i] = adxSeries[i];
  return result;
}

/**
 * Choppiness Index (E.W. Dreiss): 100·log10(Σ ATR(1) n / (max high n − min low n)) / log10(n).
 * ATR(1) = true range (candle pertama = high − low, konvensi TradingView). Sah mulai indeks n−1.
 * Rentang high-low = 0 → null. Nilai berkisar ±0..100; tinggi = choppy, rendah = trending.
 * @returns {(number|null)[]}
 */
export function choppiness(candles, period = 14) {
  assertPeriod(period);
  assertCandles(candles);
  const out = new Array(candles.length).fill(null);
  if (period < 2) return out; // log10(1) = 0 → tak terdefinisi
  const tr = trueRange(candles);
  const denomLog = Math.log10(period);
  for (let i = period - 1; i < candles.length; i += 1) {
    let sumTr = 0;
    let hi = -Infinity;
    let lo = Infinity;
    for (let k = i - period + 1; k <= i; k += 1) {
      sumTr += tr[k];
      if (candles[k].high > hi) hi = candles[k].high;
      if (candles[k].low < lo) lo = candles[k].low;
    }
    const range = hi - lo;
    if (range > 0 && sumTr > 0) out[i] = (100 * Math.log10(sumTr / range)) / denomLog;
  }
  return out;
}

/**
 * Lebar Bollinger relatif: (upper − lower) / middle = 2·mult·σ / SMA, σ = stdev POPULASI (ddof 0,
 * konvensi TradingView & `ta`). Catatan: `ta` bollinger_wband = nilai ini × 100.
 * Middle ≤ 0 → null. Sah mulai indeks period−1.
 * @returns {(number|null)[]}
 */
export function bollingerBandwidth(closes, period = 20, mult = 2) {
  assertPeriod(period);
  assertCloses(closes);
  if (!isNum(mult) || mult <= 0) throw new RangeError('mult harus angka positif');
  const out = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i += 1) {
    let sum = 0;
    for (let k = i - period + 1; k <= i; k += 1) sum += closes[k];
    const mean = sum / period;
    if (mean <= 0) continue;
    let sq = 0;
    for (let k = i - period + 1; k <= i; k += 1) sq += (closes[k] - mean) ** 2;
    const sd = Math.sqrt(sq / period);
    out[i] = (2 * mult * sd) / mean;
  }
  return out;
}

/**
 * Efficiency Ratio Kaufman: |close − close[n]| / Σ|Δclose| atas n langkah terakhir (0..1).
 * 1 = bergerak lurus, ≈0 = bolak-balik. Sah mulai indeks n; total pergerakan 0 → null.
 * @returns {(number|null)[]}
 */
export function efficiencyRatio(closes, period = 10) {
  assertPeriod(period);
  assertCloses(closes);
  const out = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i += 1) {
    let path = 0;
    for (let k = i - period + 1; k <= i; k += 1) path += Math.abs(closes[k] - closes[k - 1]);
    if (path > 0) out[i] = Math.abs(closes[i] - closes[i - period]) / path;
  }
  return out;
}

/**
 * Peringkat persentil nilai terakhir `series` di antara `lookback` nilai terakhir (termasuk dirinya):
 * (jumlah nilai lain yang lebih kecil + ½·jumlah nilai lain yang sama) / (jumlah − 1) → 0..1.
 * 0 = terendah dalam jendela, 1 = tertinggi. null bila jendela belum penuh nilai sah.
 */
function lastPercentile(series, lookback) {
  const last = series.length - 1;
  if (last < 0 || lookback < 2 || last - lookback + 1 < 0) return null;
  const cur = series[last];
  if (!isNum(cur)) return null;
  let below = 0;
  let equal = 0;
  for (let k = last - lookback + 1; k < last; k += 1) {
    const v = series[k];
    if (!isNum(v)) return null;
    if (v < cur) below += 1;
    else if (v === cur) equal += 1;
  }
  return (below + equal / 2) / (lookback - 1);
}

/**
 * Analisis rezim pada candle TERAKHIR.
 * Urutan prioritas klasifikasi (yang pertama terpenuhi menang):
 *   1. SQUEEZE        — squeeze (bandwidthPercentile ≤ 0.2) DAN ADX < 20 (volatilitas terkompresi tanpa tren)
 *   2. TRENDING_UP    — ADX ≥ 25 dan +DI > −DI
 *      TRENDING_DOWN  — ADX ≥ 25 dan −DI > +DI
 *   3. CHOPPY         — Choppiness ≥ 61.8
 *   4. RANGING        — selain itu
 * regime = null bila ADX/+DI/−DI/Choppiness belum terhitung (data kurang). Bila persentil bandwidth belum
 * tersedia (butuh period BB − 1 + percentileLookback candle), squeeze = false dan SQUEEZE tidak dapat terpilih.
 * @param {object[]} candles
 * @param {{ percentileLookback?: number, adxPeriod?: number, chopPeriod?: number, bbPeriod?: number,
 *   bbMult?: number, erPeriod?: number }} [options]
 */
export function analyzeRegime(candles, {
  percentileLookback = 120,
  adxPeriod = 14,
  chopPeriod = 14,
  bbPeriod = 20,
  bbMult = 2,
  erPeriod = 10,
} = {}) {
  assertCandles(candles);
  assertPeriod(percentileLookback);
  const closes = candles.map((c) => c.close);
  const last = candles.length - 1;
  const at = (series) => (last >= 0 && isNum(series[last]) ? series[last] : null);

  const dmi = adx(candles, adxPeriod);
  const chopSeries = choppiness(candles, chopPeriod);
  const bwSeries = bollingerBandwidth(closes, bbPeriod, bbMult);
  const erSeries = efficiencyRatio(closes, erPeriod);

  const adxValue = at(dmi.adx);
  const plusDi = at(dmi.plusDi);
  const minusDi = at(dmi.minusDi);
  const chop = at(chopSeries);
  const bandwidth = at(bwSeries);
  const bandwidthPercentile = lastPercentile(bwSeries, percentileLookback);
  const squeeze = bandwidthPercentile !== null && bandwidthPercentile <= REGIME_THRESHOLDS.squeezePercentile;

  let regime = null;
  if (adxValue !== null && plusDi !== null && minusDi !== null && chop !== null) {
    if (squeeze && adxValue < REGIME_THRESHOLDS.adxWeak) regime = REGIMES.SQUEEZE;
    else if (adxValue >= REGIME_THRESHOLDS.adxTrend && plusDi > minusDi) regime = REGIMES.TRENDING_UP;
    else if (adxValue >= REGIME_THRESHOLDS.adxTrend && minusDi > plusDi) regime = REGIMES.TRENDING_DOWN;
    else if (chop >= REGIME_THRESHOLDS.chopChoppy) regime = REGIMES.CHOPPY;
    else regime = REGIMES.RANGING;
  }

  return {
    adx: adxValue,
    plusDi,
    minusDi,
    chop,
    bandwidth,
    bandwidthPercentile,
    squeeze,
    efficiencyRatio: at(erSeries),
    // Arah gerak jendela ER (efficiency ratio tidak bertanda): 1 naik, −1 turun, 0 datar, null bila data kurang.
    efficiencyDirection: last >= erPeriod ? Math.sign(closes[last] - closes[last - erPeriod]) : null,
    regime,
  };
}
