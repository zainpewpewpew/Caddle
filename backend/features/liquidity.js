// Fitur likuiditas (kontrak: docs/10-kontrak-akurasi-v3.md §4): range Wyckoff, sapuan likuiditas
// (spring/upthrust), climax volume, dan absorpsi. Fungsi murni, evaluasi pada candle TERAKHIR array;
// hanya data ≤ indeks terakhir yang dipakai dan swing hanya dipakai setelah terkonfirmasi.
//
// Semua ambang di bawah adalah TITIK AWAL yang masuk akal secara metodologi (Wyckoff / likuiditas),
// BUKAN hasil optimasi. Kalibrasi dilakukan kemudian oleh backtest (backend/backtest/*).
import { atr } from '../indicators/atr.js';
import { findSwings } from '../indicators/swings.js';
import { rvol } from '../indicators/volume.js';

/** Ambang titik awal (bukan hasil optimasi). */
export const LIQUIDITY_THRESHOLDS = Object.freeze({
  /** Periode ATR (Wilder). */
  atrPeriod: 14,
  /** Range dianggap "trading range" bila lebarnya ≤ 8 × ATR. */
  maxRangeWidthAtr: 8,
  /** Fraktal swing 2-2 (konfirmasi tertunda 2 candle). */
  swingLeft: 2,
  swingRight: 2,
  /** Climax dicari pada 10 candle terakhir. */
  climaxBars: 10,
  /** Volume climax ≥ 3 × median volume 50 candle sebelumnya. */
  climaxVolumeMult: 3,
  climaxMedianWindow: 50,
  /** Range candle climax ≥ 2 × ATR (ATR candle sebelumnya, agar tidak menggelembung oleh dirinya sendiri). */
  climaxRangeAtr: 2,
  /** Selling climax di 35% bawah range; buying climax di 35% atas range. */
  climaxZone: 0.35,
  /** Absorpsi dihitung pada 10 candle terakhir, RVOL basis 20 candle. */
  absorptionBars: 10,
  rvolPeriod: 20,
});

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function assertOptions(lookback, sweepBars) {
  if (!Number.isInteger(lookback) || lookback < 2) throw new RangeError('lookback harus bilangan bulat ≥ 2');
  if (!Number.isInteger(sweepBars) || sweepBars < 1) throw new RangeError('sweepBars harus bilangan bulat ≥ 1');
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Range harga (max high / min low) pada candle [from, to] inklusif. */
function rangeOf(candles, from, to) {
  let high = -Infinity;
  let low = Infinity;
  for (let i = from; i <= to; i += 1) {
    if (candles[i].high > high) high = candles[i].high;
    if (candles[i].low < low) low = candles[i].low;
  }
  return { high, low };
}

/** Posisi harga dalam range, clamp 0..1; null bila range nol/tidak valid. */
function positionIn(price, low, high) {
  const width = high - low;
  return isNum(width) && width > 0 ? clamp((price - low) / width, 0, 1) : null;
}

/**
 * Sapuan terbaru dalam `sweepBars` candle terakhir. Untuk tiap kandidat candle sapuan j (terbaru dulu),
 * level = swing TERBARU yang sudah terkonfirmasi SEBELUM j (confirmedIndex < j). Sapuan low terjadi bila
 * low[j] < level; reclaimed = close candle terakhir > level. Cermin untuk sapuan high.
 */
function findSweep(candles, swings, sweepBars, side) {
  const last = candles.length - 1;
  const from = Math.max(0, last - sweepBars + 1);
  for (let j = last; j >= from; j -= 1) {
    let swing = null;
    for (const s of swings) {
      if (s.confirmedIndex < j && (swing === null || s.index > swing.index)) swing = s;
    }
    if (swing === null) continue;
    const swept = side === 'LOW' ? candles[j].low < swing.price : candles[j].high > swing.price;
    if (!swept) continue;
    const close = candles[last].close;
    return {
      index: j,
      level: swing.price,
      reclaimed: side === 'LOW' ? close > swing.price : close < swing.price,
      barsAgo: last - j,
    };
  }
  return null;
}

/**
 * Climax volume terbaru pada `climaxBars` candle terakhir: volume ≥ 3× median 50 candle sebelumnya
 * DAN range candle ≥ 2× ATR candle sebelumnya. Posisi close candle diukur dalam range `lookback`
 * candle sebelumnya hingga candle itu sendiri (inklusif, agar ekstrem baru ikut terhitung).
 * SELLING = candle merah di area bawah (< 0.35); BUYING = candle hijau di area atas (> 0.65).
 */
function findClimax(candles, atrValues, lookback) {
  const t = LIQUIDITY_THRESHOLDS;
  const last = candles.length - 1;
  const from = Math.max(t.climaxMedianWindow, last - t.climaxBars + 1);
  for (let j = last; j >= from; j -= 1) {
    const c = candles[j];
    const prevAtr = atrValues[j - 1];
    if (!isNum(prevAtr) || prevAtr <= 0 || !isNum(c.volume)) continue;
    const vols = candles.slice(j - t.climaxMedianWindow, j).map((k) => k.volume);
    if (!vols.every(isNum)) continue;
    const med = median(vols);
    if (!(med > 0)) continue;
    const volumeRatio = c.volume / med;
    if (volumeRatio < t.climaxVolumeMult || c.high - c.low < t.climaxRangeAtr * prevAtr) continue;
    const r = rangeOf(candles, Math.max(0, j - lookback), j);
    const pos = positionIn(c.close, r.low, r.high);
    if (pos === null) continue;
    let type = null;
    if (c.close < c.open && pos < t.climaxZone) type = 'SELLING';
    else if (c.close > c.open && pos > 1 - t.climaxZone) type = 'BUYING';
    if (type) return { type, index: j, volumeRatio, barsAgo: last - j };
  }
  return null;
}

/**
 * Absorpsi (usaha besar, hasil kecil — Wyckoff "effort vs result") pada `absorptionBars` candle terakhir:
 *   effort_i   = clamp((RVOL_i − 1) / 2, 0, 1)          RVOL 1 → 0, RVOL ≥ 3 → 1
 *   smallness_i = clamp(1 − (high_i − low_i) / ATR_{i−1}, 0, 1)   range ≥ 1 ATR → 0
 *   lokasi_i   = 1 − 2 × posisi(close_i dalam range evaluasi)     dekat low → +1, dekat high → −1
 *   absorption = rata-rata(effort_i × smallness_i × lokasi_i)  ∈ [−1, 1]
 * + = penyerapan jual di dekat low (akumulasi); − = penyerapan beli di dekat high (distribusi).
 * null bila ada candle di jendela tanpa RVOL/ATR valid atau range evaluasi tidak tersedia.
 */
function computeAbsorption(candles, atrValues, rangeLow, rangeHigh) {
  const t = LIQUIDITY_THRESHOLDS;
  const n = candles.length;
  if (rangeLow === null || rangeHigh === null || n < t.absorptionBars + 1) return null;
  const volumes = candles.map((c) => c.volume);
  if (!volumes.every(isNum)) return null;
  const rv = rvol(volumes, t.rvolPeriod);
  let sum = 0;
  for (let i = n - t.absorptionBars; i < n; i += 1) {
    const prevAtr = atrValues[i - 1];
    const pos = positionIn(candles[i].close, rangeLow, rangeHigh);
    if (!isNum(rv[i]) || !isNum(prevAtr) || prevAtr <= 0 || pos === null) return null;
    const effort = clamp((rv[i] - 1) / 2, 0, 1);
    const smallness = clamp(1 - (candles[i].high - candles[i].low) / prevAtr, 0, 1);
    sum += effort * smallness * (1 - 2 * pos);
  }
  const v = sum / t.absorptionBars;
  return v === 0 ? 0 : v;
}

/**
 * Analisis likuiditas pada candle terakhir.
 * Range = `lookback` candle sebelum candle terakhir (candle terakhir TIDAK ikut membentuk batas,
 * sehingga breakout/breakdown candle terakhir terlihat sebagai posisi 0 atau 1 dan inRange=false).
 * @param {Array<{open:number, high:number, low:number, close:number, volume:number}>} candles
 * @param {{ lookback?: number, sweepBars?: number }} [opts]
 * @returns {{ rangeHigh: number|null, rangeLow: number|null, rangeWidthAtr: number|null,
 *   position: number|null, inRange: boolean,
 *   sweepLow: null|{index:number, level:number, reclaimed:boolean, barsAgo:number},
 *   sweepHigh: null|{index:number, level:number, reclaimed:boolean, barsAgo:number},
 *   climax: null|{type:'SELLING'|'BUYING', index:number, volumeRatio:number, barsAgo:number},
 *   absorption: number|null }}
 */
export function analyzeLiquidity(candles, { lookback = 48, sweepBars = 5 } = {}) {
  if (!Array.isArray(candles)) throw new TypeError('candles harus berupa array');
  assertOptions(lookback, sweepBars);
  const t = LIQUIDITY_THRESHOLDS;
  const n = candles.length;
  const out = {
    rangeHigh: null, rangeLow: null, rangeWidthAtr: null, position: null, inRange: false,
    sweepLow: null, sweepHigh: null, climax: null, absorption: null,
  };
  if (n === 0) return out;

  const atrValues = atr(candles, t.atrPeriod);
  const last = n - 1;
  const close = candles[last].close;

  if (n >= lookback + 1) {
    const r = rangeOf(candles, last - lookback, last - 1);
    if (isNum(r.high) && isNum(r.low)) {
      out.rangeHigh = r.high;
      out.rangeLow = r.low;
      out.position = positionIn(close, r.low, r.high);
      const a = atrValues[last];
      if (isNum(a) && a > 0) {
        out.rangeWidthAtr = (r.high - r.low) / a;
        out.inRange = out.rangeWidthAtr <= t.maxRangeWidthAtr && close >= r.low && close <= r.high;
      }
    }
  }

  const swings = findSwings(candles, { left: t.swingLeft, right: t.swingRight });
  out.sweepLow = findSweep(candles, swings.lows, sweepBars, 'LOW');
  out.sweepHigh = findSweep(candles, swings.highs, sweepBars, 'HIGH');
  out.climax = findClimax(candles, atrValues, lookback);
  out.absorption = computeAbsorption(candles, atrValues, out.rangeLow, out.rangeHigh);
  return out;
}
