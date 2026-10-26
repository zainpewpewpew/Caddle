// Struktur pasar (market structure / SMC): label swing HH/LH/HL/LL, BOS & CHoCH, bias, dan skor struktur.
//
// Anti-lookahead: swing berasal dari fraktal `findSwings` (left/right) dengan konfirmasi tertunda
// (confirmedIndex = index + right). Analisis selalu pada candle TERAKHIR array dan hanya memakai swing
// dengan confirmedIndex ≤ indeks terakhir. Penelusuran BOS/CHoCH berjalan kronologis dan di setiap candle t
// hanya memakai swing yang sudah terkonfirmasi pada t. Akibatnya hasil untuk candles.slice(0, k) hanya
// bergantung pada prefix itu — menambah candle masa depan tidak mengubahnya.
//
// Aturan (lihat juga docs/10-kontrak-akurasi-v3.md §1):
// - Label swing: swing HIGH dibanding swing HIGH sebelumnya → HH (lebih tinggi) atau LH (sama/lebih rendah:
//   gagal membuat puncak baru); swing LOW dibanding swing LOW sebelumnya → LL (lebih rendah) atau HL
//   (sama/lebih tinggi: support bertahan). Swing pertama tiap jenis berlabel null. Label dihitung atas seluruh
//   riwayat swing, lalu hanya `maxSwings` swing terakhir yang dikembalikan.
// - Break: close menembus swing high terkonfirmasi TERBARU (close > level) = break bullish; close menembus
//   swing low terkonfirmasi terbaru (close < level) = break bearish. Satu swing hanya bisa ditembus sekali.
//   Break disebut BOS bila state tren sebelumnya searah atau masih netral (awal), CHOCH bila state sebelumnya
//   berlawanan. Setelah break, state tren = arah break. Bila dalam satu candle kedua level tembus sekaligus
//   (kasus ganjil), level dari swing yang lebih baru yang menentukan; bila sama baru → keduanya ditandai
//   tembus tanpa event (ambigu).
// - Bias:
//     labelDir = BULLISH bila label swing high terakhir HH DAN swing low terakhir HL; BEARISH bila LH DAN LL;
//                selain itu null.
//     eventDir = arah lastEvent (event terbaru tidak pernah "dibatalkan" kecuali oleh event berlawanan, yang
//                lalu menjadi lastEvent itu sendiri).
//     Keduanya null → NEUTRAL; salah satu null → yang lain; searah → arah itu; berlawanan → yang lebih baru
//     menang (event bila index event > confirmedIndex swing termuda dari pasangan label, selain itu label).
// - structureScore (-1..1, + = bullish) = clamp(0.6·P + E):
//     P = (HH + HL − LH − LL) / jumlah swing berlabel dalam jendela `swings` (0 bila tidak ada);
//     E = ±bobot event (BOS 0.4, CHOCH 0.5) × kesegaran, kesegaran = max(0, 1 − barsAgo / 20).
//   null bila tidak ada swing berlabel maupun event (data tidak cukup — bukan 0 palsu).
// Aturan simetris terhadap cermin harga (p → 1/p, high ↔ low): bias & event berbalik, skor berganti tanda.
import { confirmedAt, findSwings } from '../indicators/swings.js';

/** Parameter skor struktur. */
export const STRUCTURE_PARAMS = Object.freeze({
  proportionWeight: 0.6,
  bosWeight: 0.4,
  chochWeight: 0.5,
  freshBars: 20,
});

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function assertInt(name, value, min) {
  if (!Number.isInteger(value) || value < min) throw new RangeError(`${name} harus bilangan bulat ≥ ${min}`);
}

function emptyResult() {
  return {
    bias: 'NEUTRAL',
    swings: [],
    counts: { HH: 0, LH: 0, HL: 0, LL: 0 },
    lastEvent: null,
    lastSwingHigh: null,
    lastSwingLow: null,
    structureScore: null,
  };
}

/** Beri label tiap swing dibanding swing sejenis sebelumnya. */
function labelSwings(list, type) {
  return list.map((s, i) => {
    let label = null;
    if (i > 0) {
      const prev = list[i - 1].price;
      if (type === 'HIGH') label = s.price > prev ? 'HH' : 'LH';
      else label = s.price < prev ? 'LL' : 'HL';
    }
    return { type, label, index: s.index, price: s.price, confirmedIndex: s.confirmedIndex };
  });
}

/** Telusuri candle secara kronologis untuk BOS/CHoCH; hanya swing yang terkonfirmasi pada candle itu. */
function traceEvents(candles, highs, lows) {
  let trend = 'NEUTRAL';
  let lastEvent = null;
  let hi = -1; // indeks swing high terkonfirmasi terbaru dalam `highs`
  let lo = -1;
  let brokenHigh = -1; // indeks (dalam `highs`) swing high yang sudah ditembus terakhir
  let brokenLow = -1;
  for (let t = 0; t < candles.length; t += 1) {
    while (hi + 1 < highs.length && highs[hi + 1].confirmedIndex <= t) hi += 1;
    while (lo + 1 < lows.length && lows[lo + 1].confirmedIndex <= t) lo += 1;
    const { close } = candles[t];
    const upBreak = hi >= 0 && hi !== brokenHigh && close > highs[hi].price;
    const downBreak = lo >= 0 && lo !== brokenLow && close < lows[lo].price;
    if (!upBreak && !downBreak) continue;
    let direction;
    if (upBreak && downBreak) {
      brokenHigh = hi;
      brokenLow = lo;
      if (highs[hi].index === lows[lo].index) continue; // ambigu → tanpa event
      direction = highs[hi].index > lows[lo].index ? 'BULLISH' : 'BEARISH';
    } else {
      direction = upBreak ? 'BULLISH' : 'BEARISH';
      if (upBreak) brokenHigh = hi;
      else brokenLow = lo;
    }
    const opposite = direction === 'BULLISH' ? 'BEARISH' : 'BULLISH';
    const type = trend === opposite ? 'CHOCH' : 'BOS';
    const level = direction === 'BULLISH' ? highs[hi].price : lows[lo].price;
    trend = direction;
    lastEvent = { type, direction, index: t, level };
  }
  return lastEvent;
}

/**
 * Analisis struktur pasar pada candle terakhir.
 * @param {Array<{high:number, low:number, close:number}>} candles urut waktu
 * @param {{ left?: number, right?: number, maxSwings?: number }} [opts]
 * @returns {{ bias: 'BULLISH'|'BEARISH'|'NEUTRAL',
 *   swings: Array<{ type: 'HIGH'|'LOW', label: 'HH'|'LH'|'HL'|'LL'|null, index: number, price: number, confirmedIndex: number }>,
 *   counts: { HH: number, LH: number, HL: number, LL: number },
 *   lastEvent: null | { type: 'BOS'|'CHOCH', direction: 'BULLISH'|'BEARISH', index: number, level: number, barsAgo: number },
 *   lastSwingHigh: number|null, lastSwingLow: number|null, structureScore: number|null }}
 * @throws {TypeError} bila candles bukan array atau candle tidak valid
 * @throws {RangeError} bila opsi bukan bilangan bulat yang sah
 */
export function analyzeMarketStructure(candles, { left = 2, right = 2, maxSwings = 12 } = {}) {
  if (!Array.isArray(candles)) throw new TypeError('candles harus berupa array');
  assertInt('left', left, 1);
  assertInt('right', right, 1);
  assertInt('maxSwings', maxSwings, 1);
  candles.forEach((c, i) => {
    if (typeof c !== 'object' || c === null || !isNum(c.high) || !isNum(c.low) || !isNum(c.close)) {
      throw new TypeError(`Candle tidak valid pada indeks ${i}`);
    }
  });
  const result = emptyResult();
  if (candles.length === 0) return result;
  const last = candles.length - 1;

  const { highs, lows } = confirmedAt(findSwings(candles, { left, right }), last);
  const labeledHighs = labelSwings(highs, 'HIGH');
  const labeledLows = labelSwings(lows, 'LOW');
  const all = [...labeledHighs, ...labeledLows]
    .sort((a, b) => a.index - b.index || (a.type === b.type ? 0 : a.type === 'HIGH' ? -1 : 1));
  // Swing HIGH & LOW pada indeks sama (outside bar) tidak pernah dipisah oleh batas maxSwings: urutan seri keduanya
  // bergantung tipe, sehingga memotong di antaranya membuat hasil LONG ≠ cermin SHORT.
  let start = Math.max(0, all.length - maxSwings);
  while (start > 0 && all[start - 1].index === all[start].index) start -= 1;
  result.swings = all.slice(start);
  for (const s of result.swings) if (s.label) result.counts[s.label] += 1;

  const lastHigh = labeledHighs.at(-1) ?? null;
  const lastLow = labeledLows.at(-1) ?? null;
  result.lastSwingHigh = lastHigh ? lastHigh.price : null;
  result.lastSwingLow = lastLow ? lastLow.price : null;

  const event = traceEvents(candles, highs, lows);
  if (event) result.lastEvent = { ...event, barsAgo: last - event.index };

  // Bias.
  let labelDir = null;
  if (lastHigh?.label === 'HH' && lastLow?.label === 'HL') labelDir = 'BULLISH';
  else if (lastHigh?.label === 'LH' && lastLow?.label === 'LL') labelDir = 'BEARISH';
  const eventDir = result.lastEvent?.direction ?? null;
  if (labelDir && eventDir && labelDir !== eventDir) {
    const labelTime = Math.max(lastHigh.confirmedIndex, lastLow.confirmedIndex);
    result.bias = result.lastEvent.index > labelTime ? eventDir : labelDir;
  } else {
    result.bias = labelDir ?? eventDir ?? 'NEUTRAL';
  }

  // Skor struktur.
  const { HH, HL, LH, LL } = result.counts;
  const labeled = HH + HL + LH + LL;
  if (labeled === 0 && !result.lastEvent) return result;
  const p = labeled > 0 ? (HH + HL - LH - LL) / labeled : 0;
  let e = 0;
  if (result.lastEvent) {
    const w = result.lastEvent.type === 'CHOCH' ? STRUCTURE_PARAMS.chochWeight : STRUCTURE_PARAMS.bosWeight;
    const fresh = Math.max(0, 1 - result.lastEvent.barsAgo / STRUCTURE_PARAMS.freshBars);
    e = (result.lastEvent.direction === 'BULLISH' ? 1 : -1) * w * fresh;
  }
  const score = Math.min(1, Math.max(-1, STRUCTURE_PARAMS.proportionWeight * p + e));
  result.structureScore = score === 0 ? 0 : score; // hindari −0
  return result;
}
