// Resolver alignment multi-timeframe. HTF hanya KONTEKS: pola bullish di timeframe dasar
// tidak pernah dibuang karena HTF tidak memiliki pola yang sama — alignment hanya
// memberi label (dan risk flag COUNTERTREND_HTF di lapisan scoring).
//
// Tabel keputusan (diperiksa berurutan dari atas):
//
// | # | Trend HTF (null = tidak tersedia)              | baseTrendOk | Hasil               |
// |---|------------------------------------------------|-------------|---------------------|
// | 1 | ada minimal satu BEARISH                       | apa pun     | COUNTERTREND        |
// | 2 | tidak ada BULLISH (kosong/semua NEUTRAL/null)  | apa pun     | UNCONFIRMED         |
// | 3 | semua BULLISH (tanpa null)                     | true        | ALIGNED             |
// | 4 | semua BULLISH (tanpa null)                     | false       | PARTIALLY_CONFIRMED |
// | 5 | sebagian BULLISH, sisanya NEUTRAL/null         | apa pun     | PARTIALLY_CONFIRMED |
//
// Timeframe 1h tidak memiliki HTF (HIGHER_TIMEFRAMES['1h'] = []) → baris 2 → UNCONFIRMED.
// baseTrendOk = trend timeframe dasar bukan BEARISH (lihat context.js); trend dasar NEUTRAL
// tetap OK karena akumulasi lazimnya terjadi saat harga mendatar.

import { TRENDS } from '../market/contracts.js';

/**
 * @param {{ baseTrendOk: boolean, higherTrends: Array<'BULLISH'|'NEUTRAL'|'BEARISH'|null> }} input
 * @returns {'ALIGNED'|'PARTIALLY_CONFIRMED'|'UNCONFIRMED'|'COUNTERTREND'}
 */
export function resolveAlignment({ baseTrendOk, higherTrends } = {}) {
  if (typeof baseTrendOk !== 'boolean') throw new TypeError('baseTrendOk harus boolean');
  if (!Array.isArray(higherTrends)) throw new TypeError('higherTrends harus array');
  for (const t of higherTrends) {
    if (t !== null && !TRENDS.includes(t)) throw new RangeError(`Trend tidak dikenal: ${t}`);
  }
  if (higherTrends.includes('BEARISH')) return 'COUNTERTREND';
  const bullish = higherTrends.filter((t) => t === 'BULLISH').length;
  if (bullish === 0) return 'UNCONFIRMED';
  if (bullish === higherTrends.length) return baseTrendOk ? 'ALIGNED' : 'PARTIALLY_CONFIRMED';
  return 'PARTIALLY_CONFIRMED';
}
