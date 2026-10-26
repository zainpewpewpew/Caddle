// Resolver alignment multi-timeframe. HTF hanya KONTEKS: pola di timeframe dasar tidak pernah
// dibuang karena HTF tidak memiliki pola yang sama — alignment hanya memberi label (dan risk flag
// COUNTERTREND_HTF di lapisan scoring).
//
// Tabel keputusan untuk arah LONG (diperiksa berurutan dari atas):
//
// | # | Trend HTF (null = tidak tersedia)              | baseTrendOk | Hasil               |
// |---|------------------------------------------------|-------------|---------------------|
// | 1 | ada minimal satu BEARISH                       | apa pun     | COUNTERTREND        |
// | 2 | tidak ada BULLISH (kosong/semua NEUTRAL/null)  | apa pun     | UNCONFIRMED         |
// | 3 | semua BULLISH (tanpa null)                     | true        | ALIGNED             |
// | 4 | semua BULLISH (tanpa null)                     | false       | PARTIALLY_CONFIRMED |
// | 5 | sebagian BULLISH, sisanya NEUTRAL/null         | apa pun     | PARTIALLY_CONFIRMED |
//
// Arah SHORT memakai tabel yang sama dengan BULLISH ↔ BEARISH ditukar: ALIGNED = semua HTF BEARISH,
// COUNTERTREND = ada HTF BULLISH. baseTrendOk untuk SHORT = trend dasar bukan BULLISH (context.js).
//
// Timeframe 1h tidak memiliki HTF (HIGHER_TIMEFRAMES['1h'] = []) → baris 2 → UNCONFIRMED.
// baseTrendOk (LONG) = trend timeframe dasar bukan BEARISH (lihat context.js); trend dasar NEUTRAL
// tetap OK karena akumulasi/distribusi lazimnya terjadi saat harga mendatar.

import { TRENDS, resolveDirection } from '../market/contracts.js';

const OPPOSITE = Object.freeze({ BULLISH: 'BEARISH', BEARISH: 'BULLISH', NEUTRAL: 'NEUTRAL' });

/**
 * Trend dilihat dari sudut arah: LONG apa adanya, SHORT BULLISH ↔ BEARISH (null/NEUTRAL tetap).
 * @param {'BULLISH'|'NEUTRAL'|'BEARISH'|null} trend
 * @param {'LONG'|'SHORT'} [direction]
 */
export function orientTrend(trend, direction = 'LONG') {
  if (direction !== 'SHORT' || trend === null || trend === undefined) return trend;
  return OPPOSITE[trend] ?? trend;
}

/**
 * @param {{ baseTrendOk: boolean, higherTrends: Array<'BULLISH'|'NEUTRAL'|'BEARISH'|null>, direction?: 'LONG'|'SHORT' }} input
 *   direction (default LONG): SHORT menukar BULLISH ↔ BEARISH sebelum tabel di atas diterapkan.
 * @returns {'ALIGNED'|'PARTIALLY_CONFIRMED'|'UNCONFIRMED'|'COUNTERTREND'}
 */
export function resolveAlignment({ baseTrendOk, higherTrends, direction } = {}) {
  if (typeof baseTrendOk !== 'boolean') throw new TypeError('baseTrendOk harus boolean');
  if (!Array.isArray(higherTrends)) throw new TypeError('higherTrends harus array');
  for (const t of higherTrends) {
    if (t !== null && !TRENDS.includes(t)) throw new RangeError(`Trend tidak dikenal: ${t}`);
  }
  const dir = resolveDirection(direction);
  const trends = dir === 'LONG' ? higherTrends : higherTrends.map((t) => orientTrend(t, dir));
  if (trends.includes('BEARISH')) return 'COUNTERTREND';
  const bullish = trends.filter((t) => t === 'BULLISH').length;
  if (bullish === 0) return 'UNCONFIRMED';
  if (bullish === trends.length) return baseTrendOk ? 'ALIGNED' : 'PARTIALLY_CONFIRMED';
  return 'PARTIALLY_CONFIRMED';
}
