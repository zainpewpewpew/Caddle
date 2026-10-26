// Pattern #003 — Silent Distribution (SD), versi SHORT_PATTERN_VERSION: cermin bearish Silent
// Accumulation (#001). Struktur bearish awal (lower high terkonfirmasi, EMA7 turun, penurunan harga
// kecil) saat volume relatif masih senyap dan volatilitas terkendali. Dideteksi dengan menjalankan
// detektor SA pada candle cermin (lihat mirror.js) — logika SA tidak diduplikasi. Skor bukan
// probabilitas dan bukan rekomendasi jual/short.
import { describeShortConditions, mirrorCandles, toShortResult } from './mirror.js';
import { resolveParams, toMirrorBaseParams } from './params.js';
import { SA_CONDITIONS, detectSilentAccumulation } from './silentAccumulation.js';

/** Metadata kondisi SD (id, label, bobot, wajib, pembanding) — tanpa kondisi gerbang. */
export const SD_CONDITIONS = describeShortConditions('SD', SA_CONDITIONS);

/**
 * SD atas candle yang SUDAH dicerminkan (mirrorCandles) — dipakai evaluateShortPatterns agar cermin
 * dibuat sekali untuk SD & PVD.
 * @param {object[]} mirrored candle cermin
 * @param {object} [params] override parsial DEFAULT_SD_PARAMS
 */
export function detectSilentDistributionMirrored(mirrored, params) {
  const p = resolveParams('SD', params);
  return toShortResult('SD', detectSilentAccumulation(mirrored, toMirrorBaseParams(p)));
}

/**
 * Deteksi Silent Distribution pada candle terakhir.
 * @param {object[]} candles candle tertutup satu simbol & timeframe, urut naik (harga nyata)
 * @param {object} [params] override parsial DEFAULT_SD_PARAMS
 * @returns {object} PatternResult (kontrak §6): pattern 'SD', invalidationPrice di ATAS harga
 * @throws {PatternParamsError} bila parameter tidak valid
 * @throws {TypeError} bila candles bukan array
 */
export function detectSilentDistribution(candles, params) {
  const p = resolveParams('SD', params);
  return detectSilentDistributionMirrored(mirrorCandles(candles), p);
}
