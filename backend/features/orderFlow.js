// Fitur order-flow v3 (docs/10-kontrak-akurasi-v3.md bagian 2): CVD dari taker buy Binance, OBV, garis A/D
// Chaikin, CMF, serta ringkasan aliran pada candle TERAKHIR. Semua fungsi murni dan anti-lookahead: nilai
// pada indeks i hanya memakai candle ≤ i. Nilai yang tidak dapat dihitung = null, bukan 0 palsu.
//
// Acuan open source: OBV, A/D (acc_dist_index) dan CMF diverifikasi terhadap pustaka Python `ta` (MIT)
// lewat tests/fixtures/features/orderflow-golden.json (generator: scripts/golden/orderflow_golden.py).
// Beda konvensi yang disengaja: OBV[0] = 0 dan close sama dengan sebelumnya menyumbang 0
// (`ta` memulai dari +volume[0] dan menghitung close sama sebagai +volume).

import { assertPeriod } from '../indicators/ema.js';

/**
 * Ambang analisis. Dipilih konservatif dan didokumentasikan agar dapat dikalibrasi ulang lewat backtest.
 * - DIVERGENCE_MIN_FLOW_SLOPE: |ΔCVD (atau ΔOBV) / Σ volume| minimal pada lookback agar aliran dianggap
 *   naik/turun "signifikan". 0.05 pada CVD ≈ rasio taker buy ≥ 52.5% (atau ≤ 47.5%) sepanjang lookback.
 * - DIVERGENCE_PRICE_TOLERANCE: toleransi relatif saat membandingkan close terakhir dengan ekstrem paruh
 *   pertama lookback (0.2%), supaya low "sama" (double bottom/top) tetap terhitung.
 * - FLOW_BIAS_WEIGHTS: bobot gabungan flowBias; CVD terbesar karena paling langsung mengukur agresi.
 *   Catatan: secara matematis cvdSlope = 2·takerBuyRatio − 1 pada window yang sama, jadi CVD + taker
 *   efektif berbobot 0.55 ketika data taker tersedia; tanpa taker, bobot dinormalisasi ulang ke CMF & OBV.
 */
export const ORDER_FLOW_THRESHOLDS = Object.freeze({
  DIVERGENCE_MIN_FLOW_SLOPE: 0.05,
  DIVERGENCE_PRICE_TOLERANCE: 0.002,
});

export const FLOW_BIAS_WEIGHTS = Object.freeze({
  cvdSlope: 0.4,
  cmf: 0.25,
  obvSlope: 0.2,
  takerImbalance: 0.15,
});

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo = -1, hi = 1) => Math.min(hi, Math.max(lo, v));

/** Volume valid (angka hingga ≥ 0) atau null. */
function volumeOf(c) {
  return c && isNum(c.volume) && c.volume >= 0 ? c.volume : null;
}

/** Delta agresi per candle = takerBuy − (volume − takerBuy) = 2·takerBuy − volume; null bila taker tak valid. */
function cvdDelta(c) {
  const v = volumeOf(c);
  if (v === null || !isNum(c.takerBuyVolume) || c.takerBuyVolume < 0 || c.takerBuyVolume > v) return null;
  return 2 * c.takerBuyVolume - v;
}

/** Money Flow Multiplier Chaikin: ((C−L)−(H−C))/(H−L); 0 bila H=L; null bila OHLC tak valid. */
function moneyFlowMultiplier(c) {
  if (!c || !isNum(c.high) || !isNum(c.low) || !isNum(c.close)) return null;
  const range = c.high - c.low;
  if (range === 0) return 0;
  return ((c.close - c.low) - (c.high - c.close)) / range;
}

/** Money flow volume = MFM · volume; null bila tak valid. */
function moneyFlowVolume(c) {
  const mfm = moneyFlowMultiplier(c);
  const v = volumeOf(c);
  return mfm === null || v === null ? null : mfm * v;
}

/**
 * Akumulasi berjalan dari nol per array; candle dengan langkah null → output null pada indeks itu
 * (akumulasi tidak berubah). Hanya selisih/slope yang bermakna, bukan level absolutnya.
 */
function cumulative(candles, step) {
  const out = new Array(candles.length).fill(null);
  let sum = 0;
  for (let i = 0; i < candles.length; i += 1) {
    const d = step(candles, i);
    if (d === null) continue;
    sum += d;
    out[i] = sum;
  }
  return out;
}

/**
 * Cumulative Volume Delta: Σ (2·takerBuyVolume − volume), mulai dari nol pada awal array.
 * null per indeks bila takerBuyVolume hilang/tidak hingga atau melebihi volume.
 * @param {import('../market/contracts.js').Candle[]} candles
 * @returns {(number|null)[]}
 */
export function cvd(candles) {
  return cumulative(candles, (cs, i) => cvdDelta(cs[i]));
}

/** Langkah OBV: +volume bila close naik, −volume bila turun, 0 bila sama; candle pertama 0. */
function obvStep(candles, i) {
  const c = candles[i];
  const v = volumeOf(c);
  if (v === null || !isNum(c.close)) return null;
  if (i === 0) return 0;
  const prev = candles[i - 1];
  if (!prev || !isNum(prev.close)) return null;
  if (c.close > prev.close) return v;
  if (c.close < prev.close) return -v;
  return 0;
}

/**
 * On-Balance Volume (Granville). OBV[0] = 0; close sama dengan sebelumnya menyumbang 0.
 * @param {import('../market/contracts.js').Candle[]} candles
 * @returns {(number|null)[]}
 */
export function obv(candles) {
  return cumulative(candles, obvStep);
}

/**
 * Garis Accumulation/Distribution Chaikin: Σ MFM · volume.
 * @param {import('../market/contracts.js').Candle[]} candles
 * @returns {(number|null)[]}
 */
export function accumulationDistribution(candles) {
  return cumulative(candles, (cs, i) => moneyFlowVolume(cs[i]));
}

/**
 * Chaikin Money Flow: Σ MFV / Σ volume pada `period` candle terakhir (termasuk i).
 * null selama warm-up, bila ada candle tak valid di jendela, atau Σ volume = 0.
 * @param {import('../market/contracts.js').Candle[]} candles
 * @param {number} [period=20]
 * @returns {(number|null)[]}
 */
export function cmf(candles, period = 20) {
  assertPeriod(period);
  const out = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i += 1) {
    let mfvSum = 0;
    let volSum = 0;
    let ok = true;
    for (let j = i - period + 1; j <= i; j += 1) {
      const mfv = moneyFlowVolume(candles[j]);
      if (mfv === null) { ok = false; break; }
      mfvSum += mfv;
      volSum += candles[j].volume;
    }
    out[i] = ok && volSum > 0 ? mfvSum / volSum : null;
  }
  return out;
}

/** Σ volume candle (from, to]; null bila ada volume tak valid. */
function volumeSum(candles, from, to) {
  let sum = 0;
  for (let j = from + 1; j <= to; j += 1) {
    const v = volumeOf(candles[j]);
    if (v === null) return null;
    sum += v;
  }
  return sum;
}

/** (seri[to] − seri[from]) / volSum, clamp −1..1; null bila salah satu ujung null atau volSum ≤ 0. */
function normalizedDelta(series, from, to, volSum) {
  if (volSum === null || volSum <= 0 || series[from] === null || series[to] === null) return null;
  return clamp((series[to] - series[from]) / volSum);
}

/**
 * Statistik taker pada candle (from, to]: rasio taker buy dan slope CVD.
 * null bila ada taker tak valid, Σ volume ≤ 0, atau semua taker = 0 padahal volume > 0 (data lama tanpa taker).
 * ΔCVD dihitung langsung sebagai Σ delta per candle agar tidak bergantung pada candle sebelum jendela.
 */
function takerStats(candles, from, to) {
  let taker = 0;
  let vol = 0;
  let delta = 0;
  for (let j = from + 1; j <= to; j += 1) {
    const d = cvdDelta(candles[j]);
    if (d === null) return null;
    taker += candles[j].takerBuyVolume;
    vol += candles[j].volume;
    delta += d;
  }
  if (vol <= 0 || taker === 0) return null;
  return { ratio: taker / vol, slope: clamp(delta / vol) };
}

/**
 * Divergensi aliran vs harga pada `lookback` candle terakhir.
 * BULLISH: harga membuat low lebih rendah/sama (close terakhir ≤ min close paruh pertama · (1 + toleransi),
 * atau perubahan harga lookback ≤ 0) tetapi slope CVD (fallback OBV bila CVD null) > ambang.
 * BEARISH: cermin (close terakhir ≥ max close paruh pertama · (1 − toleransi) atau perubahan ≥ 0, slope < −ambang).
 */
function detectDivergence(candles, obvSeries, lookback) {
  const last = candles.length - 1;
  const start = last - lookback;
  if (start < 0) return null;
  const closes = [];
  for (let j = start; j <= last; j += 1) {
    if (!isNum(candles[j]?.close)) return null;
    closes.push(candles[j].close);
  }
  const volSum = volumeSum(candles, start, last);
  const flow = takerStats(candles, start, last)?.slope ?? normalizedDelta(obvSeries, start, last, volSum);
  if (flow === null) return null;

  const { DIVERGENCE_MIN_FLOW_SLOPE: minSlope, DIVERGENCE_PRICE_TOLERANCE: tol } = ORDER_FLOW_THRESHOLDS;
  const firstHalf = closes.slice(0, Math.floor(lookback / 2) + 1);
  const lastClose = closes[closes.length - 1];
  const change = closes[0] > 0 ? lastClose / closes[0] - 1 : null;

  const lowerOrEqualLow = lastClose <= Math.min(...firstHalf) * (1 + tol) || (change !== null && change <= 0);
  const higherOrEqualHigh = lastClose >= Math.max(...firstHalf) * (1 - tol) || (change !== null && change >= 0);
  if (flow > minSlope && lowerOrEqualLow) return 'BULLISH';
  if (flow < -minSlope && higherOrEqualHigh) return 'BEARISH';
  return null;
}

/** Rata-rata berbobot dari komponen non-null, clamp −1..1; null bila semua null. */
function combineFlowBias(components) {
  let sum = 0;
  let weight = 0;
  for (const [key, w] of Object.entries(FLOW_BIAS_WEIGHTS)) {
    const v = components[key];
    if (!isNum(v)) continue;
    sum += w * v;
    weight += w;
  }
  return weight > 0 ? clamp(sum / weight) : null;
}

/**
 * Ringkasan order-flow pada candle TERAKHIR. Jendela = `window` candle terakhir; Δ dihitung terhadap
 * indeks last − window sehingga mencakup tepat candle yang volumenya dijumlahkan.
 * @param {import('../market/contracts.js').Candle[]} candles
 * @param {{ window?: number, divergenceLookback?: number }} [options]
 */
export function analyzeOrderFlow(candles, { window = 20, divergenceLookback = 30 } = {}) {
  assertPeriod(window);
  assertPeriod(divergenceLookback);
  const result = {
    takerBuyRatio: null,
    cvdSlope: null,
    obvSlope: null,
    cmf: null,
    adSlope: null,
    priceChange: null,
    divergence: null,
    flowBias: null,
  };
  const list = Array.isArray(candles) ? candles : [];
  const last = list.length - 1;
  const obvSeries = obv(list);
  result.divergence = detectDivergence(list, obvSeries, divergenceLookback);
  const from = last - window;
  if (from < 0) return result;

  const volSum = volumeSum(list, from, last);
  const taker = takerStats(list, from, last);
  if (taker) {
    result.takerBuyRatio = taker.ratio;
    result.cvdSlope = taker.slope;
  }
  result.obvSlope = normalizedDelta(obvSeries, from, last, volSum);
  result.adSlope = normalizedDelta(accumulationDistribution(list), from, last, volSum);
  result.cmf = cmf(list, window)[last];
  const c0 = list[from].close;
  const c1 = list[last].close;
  result.priceChange = isNum(c0) && isNum(c1) && c0 > 0 ? c1 / c0 - 1 : null;
  result.flowBias = combineFlowBias({
    cvdSlope: result.cvdSlope,
    cmf: result.cmf,
    obvSlope: result.obvSlope,
    takerImbalance: result.takerBuyRatio === null ? null : (result.takerBuyRatio - 0.5) * 2,
  });
  return result;
}
