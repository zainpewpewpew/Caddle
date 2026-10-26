// Pattern #001 — Silent Accumulation (SA), versi 2 (lihat PATTERN_VERSION).
// Struktur bullish awal (higher low terkonfirmasi, EMA7 naik, kenaikan harga kecil) saat volume
// relatif masih senyap (RVOL rendah) dan volatilitas terkendali. Fungsi murni; tidak memanggil
// detektor PVA. Skor bukan probabilitas — lihat conditions.js.
import { percentChange, rvol } from '../indicators/index.js';
import { EMA_SLOW_FLAT_EPSILON, analyzeStructure, describeConditions, mean, runDetector } from './conditions.js';
import { requiredCandles, resolveParams } from './params.js';

// Bobot total 100. Wajib 85 (definisi pola), opsional 15 (kualitas). Dengan minScore 85, semua kondisi wajib
// cukup. v3: EMA25 datar/naik WAJIB — sebelumnya opsional, sehingga SA dapat terdeteksi pada pantulan 20 candle
// di tengah downtrend (EMA25 masih turun), yang di chart tampak "LONG padahal harga sedang turun".
const DEFS = [
  { id: 'rvolLow', label: 'Volume senyap: rata-rata RVOL candle terakhir ≤ ambang', weight: 20, required: true, comparator: 'lte' },
  { id: 'priceRising', label: 'Harga naik dalam jendela struktur (perubahan > 0)', weight: 10, required: true, comparator: 'gt' },
  { id: 'priceGradual', label: 'Kenaikan harga masih kecil (perubahan ≤ ambang)', weight: 10, required: true, comparator: 'lte' },
  { id: 'higherLows', label: 'Higher low terkonfirmasi berurutan ≥ ambang', weight: 20, required: true, comparator: 'gte' },
  { id: 'ema7Rising', label: 'Slope EMA7 positif', weight: 10, required: true, comparator: 'gt' },
  { id: 'atrPercentLow', label: 'Volatilitas terkendali: ATR% ≤ ambang', weight: 5, required: true, comparator: 'lte' },
  { id: 'ema25NotFalling', label: 'EMA25 datar atau naik (slope ≥ −toleransi)', weight: 10, required: true, comparator: 'gte' },
  { id: 'atrNotExpanding', label: 'Volatilitas tidak melonjak: ATR% / median ATR% ≤ ambang', weight: 5, required: false, comparator: 'lte' },
  { id: 'notExtended', label: 'Harga tidak jauh di atas EMA25: (close − EMA25) / ATR ≤ ambang', weight: 5, required: false, comparator: 'lte' },
  { id: 'liquidity', label: 'Likuiditas: rata-rata quote volume per candle ≥ ambang', weight: 5, required: false, comparator: 'gte' },
];

/** Metadata kondisi SA (id, label, bobot, wajib, pembanding) — tanpa kondisi gerbang. */
export const SA_CONDITIONS = describeConditions(DEFS);

const thresholdsOf = (p) => ({
  rvolLow: p.maxAvgRvol,
  priceRising: 0,
  priceGradual: p.maxPriceChange,
  higherLows: p.minHigherLows,
  ema7Rising: 0,
  atrPercentLow: p.maxAtrPercent,
  ema25NotFalling: -EMA_SLOW_FLAT_EPSILON,
  atrNotExpanding: p.maxAtrExpansion,
  notExtended: p.maxExtensionAtr,
  liquidity: p.minAvgQuoteVolume,
});

function measure(candles, p, f) {
  const volumes = candles.map((c) => c.volume);
  // RVOL per candle memakai baseline rvolPeriod candle SEBELUMNYA (indikator rvol).
  const avgRvol = mean(rvol(volumes, p.rvolPeriod).slice(-p.rvolWindow));
  const change = percentChange(f.closes, p.priceLookback)[f.last];
  const structure = analyzeStructure(candles, f, p.priceLookback);
  const liquidity = mean(candles.slice(-p.priceLookback).map((c) => c.quoteVolume));
  return {
    structure,
    liquidity,
    values: {
      rvolLow: avgRvol,
      priceRising: change,
      priceGradual: change,
      higherLows: structure.higherLows,
      ema7Rising: f.ema7Slope,
      atrPercentLow: f.atrPercent,
      ema25NotFalling: f.ema25Slope,
      atrNotExpanding: f.atrExpansion,
      notExtended: f.extensionAtr,
      liquidity,
    },
  };
}

/**
 * Deteksi Silent Accumulation pada candle terakhir.
 * @param {object[]} candles candle tertutup satu simbol & timeframe, urut naik
 * @param {object} [params] override parsial DEFAULT_SA_PARAMS
 * @returns {object} PatternResult (kontrak §6)
 * @throws {PatternParamsError} bila parameter tidak valid
 */
export function detectSilentAccumulation(candles, params) {
  const p = resolveParams('SA', params);
  return runDetector({
    pattern: 'SA',
    candles,
    params: p,
    minCandles: requiredCandles('SA', p),
    defs: DEFS,
    thresholds: thresholdsOf(p),
    measure,
  });
}
