// Evaluasi gabungan SA & PVA (LONG) dan SD & PVD (SHORT). Kedua detektor satu arah dijalankan
// independen pada candle yang sama; klasifikasi hanya menggabungkan flag `detected` masing-masing.
import { mirrorCandles } from './mirror.js';
import { detectProgressiveDistributionMirrored } from './progressiveDistribution.js';
import { detectProgressiveVolume } from './progressiveVolume.js';
import { detectSilentAccumulation } from './silentAccumulation.js';
import { detectSilentDistributionMirrored } from './silentDistribution.js';

/** @returns {'SA'|'PVA'|'BOTH'|'NONE'} */
export function classify(saDetected, pvaDetected) {
  if (saDetected && pvaDetected) return 'BOTH';
  if (saDetected) return 'SA';
  if (pvaDetected) return 'PVA';
  return 'NONE';
}

/** Klasifikasi SHORT. @returns {'SD'|'PVD'|'BOTH'|'NONE'} */
export function classifyShort(sdDetected, pvdDetected) {
  if (sdDetected && pvdDetected) return 'BOTH';
  if (sdDetected) return 'SD';
  if (pvdDetected) return 'PVD';
  return 'NONE';
}

/**
 * Pola LONG. Bentuk hasil tidak berubah sejak v2 (tanpa field `direction`; tanpa arah = LONG).
 * @param {object[]} candles candle tertutup satu simbol & timeframe, urut naik
 * @param {{ sa?: object, pva?: object }} [options] override parameter per pola
 * @returns {{ classification: 'SA'|'PVA'|'BOTH'|'NONE', sa: object, pva: object }}
 */
export function evaluatePatterns(candles, options) {
  const { sa: saParams, pva: pvaParams } = options ?? {};
  const sa = detectSilentAccumulation(candles, saParams);
  const pva = detectProgressiveVolume(candles, pvaParams);
  return { classification: classify(sa.detected, pva.detected), sa, pva };
}

/**
 * Pola SHORT (cermin SA/PVA, lihat mirror.js). Candle dicerminkan SEKALI untuk SD & PVD.
 * @param {object[]} candles candle tertutup satu simbol & timeframe, urut naik (harga nyata)
 * @param {{ sd?: object, pvd?: object }} [options] override parameter per pola
 * @returns {{ direction: 'SHORT', classification: 'SD'|'PVD'|'BOTH'|'NONE', sd: object, pvd: object }}
 */
export function evaluateShortPatterns(candles, options) {
  const { sd: sdParams, pvd: pvdParams } = options ?? {};
  const mirrored = mirrorCandles(candles);
  const sd = detectSilentDistributionMirrored(mirrored, sdParams);
  const pvd = detectProgressiveDistributionMirrored(mirrored, pvdParams);
  return { direction: 'SHORT', classification: classifyShort(sd.detected, pvd.detected), sd, pvd };
}

/**
 * Pola untuk satu arah. LONG → evaluatePatterns (options.sa/pva), SHORT → evaluateShortPatterns
 * (options.sd/pvd).
 * @param {'LONG'|'SHORT'} direction
 */
export function evaluatePatternsFor(direction, candles, options) {
  if (direction === 'SHORT') return evaluateShortPatterns(candles, options);
  if (direction !== 'LONG') throw new RangeError(`Arah tidak dikenal: ${String(direction)}`);
  return evaluatePatterns(candles, options);
}
