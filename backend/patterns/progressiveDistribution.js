// Pattern #004 — Progressive Volume Distribution (PVD), versi SHORT_PATTERN_VERSION: cermin bearish
// Progressive Volume Accumulation (#002). Harga turun bertahap disertai volume yang meningkat
// progresif dari kondisi sepi; ditolak bila didominasi lonjakan volume anomali. Dideteksi dengan
// menjalankan detektor PVA pada candle cermin (lihat mirror.js) — logika PVA tidak diduplikasi.
// Skor bukan probabilitas dan bukan rekomendasi jual/short.
import { describeShortConditions, mirrorCandles, toShortResult } from './mirror.js';
import { resolveParams, toMirrorBaseParams } from './params.js';
import { PVA_CONDITIONS, detectProgressiveVolume } from './progressiveVolume.js';

/** Metadata kondisi PVD (id, label, bobot, wajib, pembanding) — tanpa kondisi gerbang. */
export const PVD_CONDITIONS = describeShortConditions('PVD', PVA_CONDITIONS);

/**
 * PVD atas candle yang SUDAH dicerminkan (mirrorCandles) — dipakai evaluateShortPatterns agar cermin
 * dibuat sekali untuk SD & PVD.
 * @param {object[]} mirrored candle cermin
 * @param {object} [params] override parsial DEFAULT_PVD_PARAMS
 */
export function detectProgressiveDistributionMirrored(mirrored, params) {
  const p = resolveParams('PVD', params);
  return toShortResult('PVD', detectProgressiveVolume(mirrored, toMirrorBaseParams(p)));
}

/**
 * Deteksi Progressive Volume Distribution pada candle terakhir.
 * @param {object[]} candles candle tertutup satu simbol & timeframe, urut naik (harga nyata)
 * @param {object} [params] override parsial DEFAULT_PVD_PARAMS
 * @returns {object} PatternResult (kontrak §6): pattern 'PVD', invalidationPrice di ATAS harga
 * @throws {PatternParamsError} bila parameter tidak valid
 * @throws {TypeError} bila candles bukan array
 */
export function detectProgressiveDistribution(candles, params) {
  const p = resolveParams('PVD', params);
  return detectProgressiveDistributionMirrored(mirrorCandles(candles), p);
}
