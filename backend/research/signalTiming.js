// Studi timing sinyal (riset saja; tidak dipakai worker/scanner live). Mengukur KAPAN alert pertama sebuah sinyal
// muncul relatif terhadap breakout harga — sebelum, tepat saat, atau sesudah — dan seberapa jauh harga sudah bergerak.
// Definisi dikunci sebelum hasil dilihat (docs/24 §1):
//   - breakout candle j: close[j] menembus ekstrem `donchian` candle SEBELUMNYA (LONG: > high tertinggi; SHORT: < low
//     terendah). Butuh j ≥ donchian.
//   - SAAT: candle sinyal i sendiri breakout. SESUDAH: bukan SAAT, ada breakout di [i − look, i − 1].
//     SEBELUM: tidak ada breakout di [i − look, i]; dipecah DIIKUTI (ada breakout di [i + 1, i + look]) / TANPA.
//     SEBELUM/SAAT/SESUDAH hanya memakai candle ≤ i; pemecahan DIIKUTI/TANPA memakai candle sesudah i (deskriptif saja).
//   - gerak awal = arah × (close[i] − close[i − look]) / ATR[i] (positif = harga sudah bergerak searah sinyal).
//   - posisi rentang = letak close[i] di rentang high–low `donchian` candle terakhir (termasuk i); 1 = ujung searah sinyal.

export const TIMING_DEFAULTS = Object.freeze({ donchian: 48, look: 12, atrPeriod: 14 });
export const TIMING_CLASSES = Object.freeze(['SEBELUM_DIIKUTI', 'SEBELUM_TANPA', 'SAAT', 'SESUDAH']);
/** Kelompok yang DIKETAHUI saat alert (hanya candle ≤ candle sinyal): hanya kelompok ini yang boleh dibandingkan hasilnya. */
export const TIMING_GROUPS = Object.freeze([
  Object.freeze({ key: 'SEBELUM', classes: Object.freeze(['SEBELUM_DIIKUTI', 'SEBELUM_TANPA']) }),
  Object.freeze({ key: 'SAAT', classes: Object.freeze(['SAAT']) }),
  Object.freeze({ key: 'SESUDAH', classes: Object.freeze(['SESUDAH']) }),
]);

function signOf(direction) {
  if (direction === 'LONG') return 1;
  if (direction === 'SHORT') return -1;
  throw new RangeError("direction harus 'LONG' atau 'SHORT'");
}

/**
 * flags[j] = 1 bila close candle j menembus ekstrem `donchian` candle sebelumnya searah `direction`, selain itu 0.
 * @param {{ high: number, low: number, close: number }[]} candles terurut naik
 * @returns {Uint8Array}
 */
export function breakoutFlags(candles, direction, donchian = TIMING_DEFAULTS.donchian) {
  const sign = signOf(direction);
  const out = new Uint8Array(candles.length);
  for (let j = donchian; j < candles.length; j += 1) {
    let ext = sign === 1 ? -Infinity : Infinity;
    for (let k = j - donchian; k < j; k += 1) ext = sign === 1 ? Math.max(ext, candles[k].high) : Math.min(ext, candles[k].low);
    out[j] = (sign === 1 ? candles[j].close > ext : candles[j].close < ext) ? 1 : 0;
  }
  return out;
}

/** Kelas timing candle i dari `breakoutFlags` (indeks di luar deret dianggap tanpa breakout). */
export function classifyTiming(flags, i, look = TIMING_DEFAULTS.look) {
  if (flags[i]) return 'SAAT';
  for (let j = i - look; j < i; j += 1) if (flags[j]) return 'SESUDAH';
  for (let j = i + 1; j <= i + look; j += 1) if (flags[j]) return 'SEBELUM_DIIKUTI';
  return 'SEBELUM_TANPA';
}

/** Kunci kelompok (SEBELUM/SAAT/SESUDAH) dari kelas timing. */
export function groupOfClass(cls) {
  return TIMING_GROUPS.find((g) => g.classes.includes(cls))?.key ?? null;
}

/**
 * Ukuran timing pada candle i. null bila data tidak cukup: i < donchian + look, jendela sesudah i belum lengkap
 * (i + look ≥ panjang deret), atau ATR[i] tidak positif.
 * @param {{ high: number, low: number, close: number }[]} candles
 * @param {(number|null)[]} atrValues ATR per candle (mis. atr(candles, 14))
 * @param {Uint8Array} flags breakoutFlags(candles, direction, donchian)
 * @returns {{ pre: number, pos: number, cls: string } | null}
 */
export function timingAt(candles, atrValues, flags, direction, i, { donchian = TIMING_DEFAULTS.donchian, look = TIMING_DEFAULTS.look } = {}) {
  const sign = signOf(direction);
  const a = atrValues[i];
  if (!(a > 0) || i < donchian + look || i + look >= candles.length) return null;
  const pre = (sign * (candles[i].close - candles[i - look].close)) / a;
  let hi = -Infinity;
  let lo = Infinity;
  for (let k = i - donchian + 1; k <= i; k += 1) {
    hi = Math.max(hi, candles[k].high);
    lo = Math.min(lo, candles[k].low);
  }
  const pos = hi > lo ? (sign === 1 ? (candles[i].close - lo) / (hi - lo) : (hi - candles[i].close) / (hi - lo)) : 0.5;
  return { pre, pos, cls: classifyTiming(flags, i, look) };
}
