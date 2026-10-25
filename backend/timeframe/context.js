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
   * Toleransi keterlambatan data HTF (dalam bar HTF) SELAMA jendela settle: 1 = candle HTF yang tutup
   * bersamaan dengan candle dasar boleh belum masuk (race ingesti antar-stream). Di luar jendela settle
   * toleransinya maxStaleBars − 1 (default 0): candle HTF yang sudah lama tutup tetapi tidak tersimpan
   * → 'STALE_DATA', bukan trend dari data yang lebih tua.
   */
  maxStaleBars: 1,
  /**
   * Jendela settle (ms) setelah closeTime candle HTF terakhir yang seharusnya sudah tutup. evaluationTime
   * = closeTime candle dasar yang selaras batas timeframe, sehingga nilai apa pun < durasi timeframe dasar
   * berarti "hanya tepat di batas bersama" (selisih 0); bukan batas → selisih ≥ 1 bar dasar.
   */
  settleWindowMs: 60_000,
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

function trendFor(timeframe, candles, t, { maxStaleBars, settleWindowMs, trendParams }) {
  if (candles !== undefined && !Array.isArray(candles)) throw new TypeError(`Candle ${timeframe} harus array`);
  for (const c of candles ?? []) {
    if (c.timeframe !== undefined && c.timeframe !== timeframe) {
      throw new RangeError(`Candle dengan timeframe ${c.timeframe} ditempatkan di ${timeframe}`);
    }
  }
  const closed = closedAsOf(candles ?? [], t);
  if (closed.length === 0) return { trend: null, reasons: ['NO_DATA'], asOf: null, candleCount: 0 };
  const asOf = closed[closed.length - 1].closeTime;
  const expectedClose = lastClosedCloseTime(t, timeframe);
  const lagBars = Math.round((expectedClose - asOf) / TIMEFRAME_MS[timeframe]);
  // Candle yang hilang hanya ditoleransi sesaat setelah ia tutup (race ingesti), bukan kapan saja.
  const settling = t - expectedClose <= settleWindowMs;
  const allowedLag = settling ? maxStaleBars : Math.max(0, maxStaleBars - 1);
  if (lagBars > allowedLag) return { trend: null, reasons: ['STALE_DATA'], asOf, candleCount: closed.length };
  const { trend, reasons, score } = classifyTrend(closed, trendParams);
  // Data kurang dari warm-up: trend tidak diketahui (null), bukan NEUTRAL yang tampak nyata.
  if (reasons.includes('INSUFFICIENT_DATA')) return { trend: null, reasons, asOf, candleCount: closed.length };
  return { trend, reasons, score, asOf, candleCount: closed.length };
}

/**
 * Membangun konteks multi-timeframe. Trend per timeframe null (tidak tersedia) dengan reason
 * 'NO_DATA' (tanpa candle tertutup), 'STALE_DATA' (candle HTF terlambat), atau 'INSUFFICIENT_DATA'
 * (candle kurang dari warm-up trend) — konteks tidak pernah dikarang dari data yang tidak cukup.
 * @param {{ baseTimeframe: '5m'|'15m'|'1h', evaluationTime: number,
 *   candlesByTimeframe: Record<string, import('../market/contracts.js').Candle[]>,
 *   params?: { maxStaleBars?: number, settleWindowMs?: number, trend?: object } }} input
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
  const settleWindowMs = params.settleWindowMs ?? DEFAULT_CONTEXT_PARAMS.settleWindowMs;
  if (!Number.isInteger(settleWindowMs) || settleWindowMs < 0) throw new RangeError('settleWindowMs harus bilangan bulat ≥ 0');
  const opts = { maxStaleBars, settleWindowMs, trendParams: params.trend ?? {} };

  const trends = {};
  trends[baseTimeframe] = trendFor(baseTimeframe, candlesByTimeframe[baseTimeframe], evaluationTime, opts);
  const higher = HIGHER_TIMEFRAMES[baseTimeframe];
  for (const tf of higher) trends[tf] = trendFor(tf, candlesByTimeframe[tf], evaluationTime, opts);

  // Trend dasar tidak tersedia tidak menghukum sinyal: hanya BEARISH yang membuat baseTrendOk false.
  const baseTrendOk = trends[baseTimeframe].trend !== 'BEARISH';
  const alignment = resolveAlignment({ baseTrendOk, higherTrends: higher.map((tf) => trends[tf].trend) });
  return { alignment, trends };
}
