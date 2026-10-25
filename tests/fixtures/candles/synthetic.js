// Generator candle SINTETIS deterministik untuk tes mesin pola.
// Fixture sintetis — bukan data pasar nyata. Bentuk objek mengikuti Candle kanonik
// (backend/market/contracts.js). Tanpa PRNG global (Math.random); derau berasal dari PRNG seeded
// sehingga seed + segmen yang sama selalu menghasilkan candle yang identik.
import { TIMEFRAME_MS } from '../../../backend/market/contracts.js';

export const SYNTHETIC_START = Date.UTC(2026, 0, 1, 0, 0, 0);

/**
 * PRNG mulberry32 — BUKAN untuk keamanan/kriptografi; hanya agar fixture deterministik.
 * @param {number} seed
 * @returns {() => number} angka semu dalam [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @typedef {object} Segment
 * @property {number} bars jumlah candle segmen
 * @property {number} [drift=0] return close per candle (0.001 = +0,1%)
 * @property {number[]} [cycle=[0]] return tambahan per candle yang diulang dari awal segmen
 *   (membentuk swing high/low teratur; fase selalu mulai dari indeks 0 tiap segmen)
 * @property {number} [noise=0.0002] amplitudo derau acak pada return close
 * @property {number} [wick=0.0008] amplitudo maksimum wick relatif di luar body
 * @property {number} [volume=1000] volume base pada awal segmen
 * @property {number} [volumeEnd] volume base pada akhir segmen (interpolasi linear), default = volume
 * @property {number} [volumeNoise=0.1] derau relatif volume
 */

/**
 * Bangun deret candle tertutup berurutan tanpa gap.
 * @param {{ seed?: number, symbol?: string, timeframe?: '5m'|'15m'|'1h', startTime?: number,
 *           startPrice?: number, segments: Segment[] }} spec
 */
export function generateCandles({ seed = 1, symbol = 'SYNUSDT', timeframe = '5m', startTime = SYNTHETIC_START, startPrice = 100, segments }) {
  const rand = mulberry32(seed);
  const jitter = (amp) => amp * (2 * rand() - 1);
  const interval = TIMEFRAME_MS[timeframe];
  const candles = [];
  let price = startPrice;
  for (const seg of segments) {
    const { bars, drift = 0, cycle = [0], noise = 0.0002, wick = 0.0008, volume = 1000, volumeEnd = volume, volumeNoise = 0.1 } = seg;
    for (let j = 0; j < bars; j += 1) {
      const open = price;
      const close = open * (1 + drift + cycle[j % cycle.length] + jitter(noise));
      const high = Math.max(open, close) * (1 + wick * rand());
      const low = Math.min(open, close) * (1 - wick * rand());
      const base = bars > 1 ? volume + ((volumeEnd - volume) * j) / (bars - 1) : volume;
      const vol = Math.max(0, base * (1 + jitter(volumeNoise)));
      const takerShare = 0.45 + 0.1 * rand();
      const openTime = startTime + candles.length * interval;
      candles.push({
        symbol,
        timeframe,
        openTime,
        closeTime: openTime + interval - 1,
        open,
        high,
        low,
        close,
        volume: vol,
        quoteVolume: (vol * (open + close)) / 2,
        trades: Math.round(vol / 10),
        takerBuyVolume: vol * takerShare,
        takerBuyQuoteVolume: vol * takerShare * close,
        isClosed: true,
        source: 'rest',
      });
      price = close;
    }
  }
  return candles;
}

const resolveIndex = (candles, index) => (index < 0 ? candles.length + index : index);

/** Salinan dengan volume (dan turunannya) candle `index` dikalikan `multiplier`. Indeks negatif dari akhir. */
export function withVolumeSpike(candles, index, multiplier) {
  const target = resolveIndex(candles, index);
  return candles.map((c, i) => (i === target
    ? { ...c, volume: c.volume * multiplier, quoteVolume: c.quoteVolume * multiplier, trades: Math.round(c.trades * multiplier), takerBuyVolume: c.takerBuyVolume * multiplier, takerBuyQuoteVolume: c.takerBuyQuoteVolume * multiplier }
    : c));
}

/** Salinan dengan `count` candle mulai `from` bervolume nol (tanpa transaksi). */
export function withZeroVolume(candles, from, count) {
  const start = resolveIndex(candles, from);
  return candles.map((c, i) => (i >= start && i < start + count
    ? { ...c, volume: 0, quoteVolume: 0, trades: 0, takerBuyVolume: 0, takerBuyQuoteVolume: 0 }
    : c));
}

/** Salinan tanpa candle `index` → gap waktu di array. */
export function withoutCandle(candles, index) {
  const target = resolveIndex(candles, index);
  return candles.filter((_, i) => i !== target);
}

/**
 * Salinan dengan semua harga dikali `factor` dan volume base dibagi `factor`, sehingga quote
 * volume tetap (mensimulasikan koin berharga sangat kecil dengan likuiditas USDT yang sama).
 */
export function withPriceScale(candles, factor) {
  return candles.map((c) => ({
    ...c,
    open: c.open * factor,
    high: c.high * factor,
    low: c.low * factor,
    close: c.close * factor,
    volume: c.volume / factor,
    takerBuyVolume: c.takerBuyVolume / factor,
  }));
}

/** Salinan dengan candle terakhir belum tertutup (provisional dari WebSocket). */
export function withProvisionalLast(candles) {
  return candles.map((c, i) => (i === candles.length - 1 ? { ...c, isClosed: false, source: 'ws' } : c));
}
