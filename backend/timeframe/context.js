// Konteks timeframe lebih tinggi (HTF) untuk satu titik evaluasi, TANPA LOOKAHEAD.
//
// evaluationTime = closeTime candle dasar yang sedang dievaluasi. Untuk setiap timeframe
// (dasar & HTF) hanya candle dengan closeTime <= evaluationTime yang dipakai. Contoh:
// candle 5m 10:00–10:04:59.999 → evaluationTime 10:04:59.999 → candle 15m 10:00–10:14:59.999
// BELUM tutup sehingga tidak dipakai; konteks 15m memakai 09:45–09:59:59.999.

import { HIGHER_TIMEFRAMES, TIMEFRAMES, TIMEFRAME_MS } from '../market/contracts.js';
import { resolveAlignment } from './alignment.js';
import { classifyTrend } from './trend.js';

export const DEFAULT_CONTEXT_PARAMS = Object.freeze({
  /**
   * Toleransi keterlambatan data HTF (dalam bar HTF). 1 = candle HTF yang tutup bersamaan
   * dengan candle dasar boleh belum masuk (race ingesti); lebih dari itu → 'STALE_DATA'.
   */
  maxStaleBars: 1,
});

/**
 * Candle yang sudah tertutup pada waktu t: closeTime <= t. Candle provisional
 * (isClosed === false) tidak pernah dikembalikan. Urutan input dipertahankan.
 * @param {import('../market/contracts.js').Candle[]} candles
 * @param {number} t epoch ms UTC
 */
export function closedAsOf(candles, t) {
  if (!Array.isArray(candles)) throw new TypeError('candles harus array');
  if (typeof t !== 'number' || !Number.isFinite(t)) throw new TypeError('Waktu evaluasi harus angka epoch ms');
  return candles.filter((c) => c.isClosed !== false && c.closeTime <= t);
}

/** closeTime candle `timeframe` terakhir yang seharusnya sudah tertutup pada waktu t. */
export function lastClosedCloseTime(t, timeframe) {
  const ms = TIMEFRAME_MS[timeframe];
  return Math.floor((t + 1) / ms) * ms - 1;
}

function trendFor(timeframe, candles, t, { maxStaleBars, trendParams }) {
  if (candles !== undefined && !Array.isArray(candles)) throw new TypeError(`Candle ${timeframe} harus array`);
  for (const c of candles ?? []) {
    if (c.timeframe !== undefined && c.timeframe !== timeframe) {
      throw new RangeError(`Candle dengan timeframe ${c.timeframe} ditempatkan di ${timeframe}`);
    }
  }
  const closed = closedAsOf(candles ?? [], t);
  if (closed.length === 0) return { trend: null, reasons: ['NO_DATA'], asOf: null, candleCount: 0 };
  const asOf = closed[closed.length - 1].closeTime;
  const lagBars = Math.round((lastClosedCloseTime(t, timeframe) - asOf) / TIMEFRAME_MS[timeframe]);
  if (lagBars > maxStaleBars) return { trend: null, reasons: ['STALE_DATA'], asOf, candleCount: closed.length };
  const { trend, reasons, score } = classifyTrend(closed, trendParams);
  return { trend, reasons, score, asOf, candleCount: closed.length };
}

/**
 * Membangun konteks multi-timeframe.
 * @param {{ baseTimeframe: '5m'|'15m'|'1h', evaluationTime: number,
 *   candlesByTimeframe: Record<string, import('../market/contracts.js').Candle[]>,
 *   params?: { maxStaleBars?: number, trend?: object } }} input
 * @returns {{ alignment: string, trends: Record<string, { trend: string|null, reasons: string[],
 *   score?: number, asOf: number|null, candleCount: number }> }}
 *   `trends` memuat timeframe dasar (kunci pertama) lalu setiap HTF.
 */
export function buildTimeframeContext({ baseTimeframe, evaluationTime, candlesByTimeframe, params = {} } = {}) {
  if (!TIMEFRAMES.includes(baseTimeframe)) throw new RangeError(`Timeframe dasar tidak didukung: ${baseTimeframe}`);
  if (typeof evaluationTime !== 'number' || !Number.isInteger(evaluationTime)) {
    throw new TypeError('evaluationTime harus bilangan bulat epoch ms');
  }
  if (candlesByTimeframe === null || typeof candlesByTimeframe !== 'object') {
    throw new TypeError('candlesByTimeframe harus objek');
  }
  const maxStaleBars = params.maxStaleBars ?? DEFAULT_CONTEXT_PARAMS.maxStaleBars;
  if (!Number.isInteger(maxStaleBars) || maxStaleBars < 0) throw new RangeError('maxStaleBars harus bilangan bulat ≥ 0');
  const opts = { maxStaleBars, trendParams: params.trend ?? {} };

  const trends = {};
  trends[baseTimeframe] = trendFor(baseTimeframe, candlesByTimeframe[baseTimeframe], evaluationTime, opts);
  const higher = HIGHER_TIMEFRAMES[baseTimeframe];
  for (const tf of higher) trends[tf] = trendFor(tf, candlesByTimeframe[tf], evaluationTime, opts);

  // Trend dasar tidak tersedia tidak menghukum sinyal: hanya BEARISH yang membuat baseTrendOk false.
  const baseTrendOk = trends[baseTimeframe].trend !== 'BEARISH';
  const alignment = resolveAlignment({ baseTrendOk, higherTrends: higher.map((tf) => trends[tf].trend) });
  return { alignment, trends };
}
