// Swing high/low fraktal dengan KONFIRMASI TERTUNDA untuk mencegah lookahead:
// swing di indeks i baru diketahui setelah `right` candle sesudahnya tertutup,
// sehingga `confirmedIndex = i + right`. Pemakai hanya boleh memakai swing
// dengan confirmedIndex <= indeks evaluasi.

/**
 * @param {Array<{high:number, low:number}>} candles
 * @param {{ left?: number, right?: number }} [opts]
 * @returns {{ highs: Array<{index:number, price:number, confirmedIndex:number}>,
 *             lows: Array<{index:number, price:number, confirmedIndex:number}> }}
 */
export function findSwings(candles, { left = 2, right = 2 } = {}) {
  if (!Number.isInteger(left) || left < 1 || !Number.isInteger(right) || right < 1) {
    throw new RangeError('left/right harus bilangan bulat ≥ 1');
  }
  const highs = [];
  const lows = [];
  for (let i = left; i < candles.length - right; i += 1) {
    const { high, low } = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let k = i - left; k <= i + right; k += 1) {
      if (k === i) continue;
      // Kiri ketat, kanan non-ketat: puncak datar dihitung sekali (pada kemunculan pertama).
      if (k < i ? candles[k].high >= high : candles[k].high > high) isHigh = false;
      if (k < i ? candles[k].low <= low : candles[k].low < low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: high, confirmedIndex: i + right });
    if (isLow) lows.push({ index: i, price: low, confirmedIndex: i + right });
  }
  return { highs, lows };
}

/** Swing yang sudah terkonfirmasi pada indeks evaluasi. */
export function confirmedAt(swings, evalIndex) {
  return {
    highs: swings.highs.filter((s) => s.confirmedIndex <= evalIndex),
    lows: swings.lows.filter((s) => s.confirmedIndex <= evalIndex),
  };
}

/** Jumlah higher-low berurutan di akhir daftar swing low. */
export function trailingHigherLows(lows) {
  let count = 0;
  for (let i = lows.length - 1; i > 0; i -= 1) {
    if (lows[i].price > lows[i - 1].price) count += 1;
    else break;
  }
  return count;
}
