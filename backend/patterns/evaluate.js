// Evaluasi gabungan SA & PVA. Kedua detektor dijalankan independen pada candle yang sama;
// klasifikasi hanya menggabungkan flag `detected` masing-masing.
import { detectProgressiveVolume } from './progressiveVolume.js';
import { detectSilentAccumulation } from './silentAccumulation.js';

/** @returns {'SA'|'PVA'|'BOTH'|'NONE'} */
export function classify(saDetected, pvaDetected) {
  if (saDetected && pvaDetected) return 'BOTH';
  if (saDetected) return 'SA';
  if (pvaDetected) return 'PVA';
  return 'NONE';
}

/**
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
