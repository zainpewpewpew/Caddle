// BSV-1h — "Breakout Struktur Bervolume" LONG 1h: formulasi RISET yang sedang diuji luar sampel (docs/23).
// TIDAK dipakai worker atau scanner live; hanya skrip riset (scripts/research-bsv-1h.js) yang memanggilnya.
//
// Aturan DIBEKUKAN v1 (2026-11-15), persis seperti uji eksplorasi yang menghasilkan kandidat ini:
//   - level = swing high fraktal 2-2 TERBARU yang sudah terkonfirmasi SEBELUM candle i (confirmedIndex < i),
//     dengan indeks swing ≥ i − 48 (level berumur ≤ 2 hari);
//   - pemicu dievaluasi saat candle i TERTUTUP: close[i] > level DAN close[i−1] ≤ level DAN RVOL20[i] ≥ 2
//     (volume candle i dibanding rata-rata 20 candle sebelumnya);
//   - pemanasan: i ≥ 25 dan ATR14 (Wilder) candle i > 0; jeda 6 candle antarsinyal per simbol.
// Anti-lookahead: swing hanya dipakai setelah dua candle kanannya tertutup (confirmedIndex < i), dan semua nilai
// berasal dari candle ≤ i. Entri, stop, dan target dihitung di eventStudy.js (open candle i+1).

import { atr, findSwings, rvol } from '../indicators/index.js';

export const BSV_1H_V1 = Object.freeze({
  version: 1,
  swingLeft: 2,
  swingRight: 2,
  levelLookback: 48,
  rvolPeriod: 20,
  minRvol: 2,
  cooldownBars: 6,
  atrPeriod: 14,
  minIndex: 25,
  stopAtr: 1.5,
  targetR: 2,
  maxBars: 48,
});

/**
 * Deteksi sinyal BSV-1h pada deret candle 1h tertutup (terurut naik, tanpa duplikat).
 * @param {Array<{ openTime: number, high: number, low: number, close: number, volume: number }>} candles
 * @param {{ params?: typeof BSV_1H_V1, from?: number, to?: number, minHistory?: number }} [options]
 *   - `from`/`to`: hanya sinyal dengan openTime candle i di [from, to); jeda dihitung sejak sinyal pertama di jendela.
 *   - `minHistory`: indeks minimum candle sinyal (riwayat simbol), selain `params.minIndex`.
 * @returns {Array<{ index: number, openTime: number, level: number, levelIndex: number,
 *   levelConfirmedIndex: number, rvol: number, atr: number }>}
 */
export function detectBsvSignals(candles, { params = BSV_1H_V1, from = -Infinity, to = Infinity, minHistory = 0 } = {}) {
  if (!Array.isArray(candles)) throw new TypeError('candles wajib array');
  if (candles.length < 2) return [];
  const atrs = atr(candles, params.atrPeriod);
  const volumes = candles.map((c) => c.volume);
  const rv = rvol(volumes, params.rvolPeriod);
  const { highs } = findSwings(candles, { left: params.swingLeft, right: params.swingRight });
  const minIndex = Math.max(params.minIndex, minHistory);
  const signals = [];
  let pointer = -1;
  let lastSignal = -Infinity;
  for (let i = 1; i < candles.length; i += 1) {
    while (pointer + 1 < highs.length && highs[pointer + 1].confirmedIndex < i) pointer += 1;
    const t = candles[i].openTime;
    if (t < from || t >= to || i < minIndex) continue;
    const a = atrs[i];
    if (!(a > 0)) continue;
    const level = pointer >= 0 && highs[pointer].index >= i - params.levelLookback ? highs[pointer] : null;
    if (level === null) continue;
    const r = rv[i];
    if (!(candles[i].close > level.price && candles[i - 1].close <= level.price && r !== null && r >= params.minRvol)) continue;
    if (i - lastSignal < params.cooldownBars) continue;
    lastSignal = i;
    signals.push({
      index: i, openTime: t, level: level.price, levelIndex: level.index, levelConfirmedIndex: level.confirmedIndex, rvol: r, atr: a,
    });
  }
  return signals;
}

/**
 * Variasi ketahanan (bukan aturan keputusan): true bila tidak ada close di atas level antara konfirmasi swing dan
 * candle sebelum sinyal — "tembusan pertama" dalam arti sempit.
 */
export function isFirstBreak(candles, signal) {
  for (let k = signal.levelConfirmedIndex + 1; k < signal.index; k += 1) {
    if (candles[k].close > signal.level) return false;
  }
  return true;
}
