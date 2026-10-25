// Perencanaan backfill REST (fungsi murni). Menghasilkan potongan request klines
// Binance ({ startTime, endTime, limit }) yang mencakup candle TERTUTUP saja.
// Semua waktu epoch ms UTC; `now` selalu diberikan pemanggil (tanpa Date.now()).

import { TIMEFRAME_MS } from '../market/contracts.js';

/** Batas `limit` endpoint /fapi/v1/klines Binance USDT-M Futures. */
export const MAX_KLINES_PER_REQUEST = 1500;

/**
 * Margin keamanan penutupan candle (ms). Jam worker = jam lokal + offset terukur (serverClock) dengan
 * galat ≤ RTT/2 (≤ 500 ms) ditambah drift antarsinkronisasi; Binance juga dapat memfinalkan kline
 * sedikit setelah closeTime. Karena itu kline REST dianggap tertutup hanya bila
 * closeTime < (waktu server saat request DIMULAI − margin), dan rencana backfill/gap/sweep berakhir di candle
 * tertutup terakhir pada (waktu server − margin) — snapshot candle yang masih berjalan tidak pernah tersimpan
 * sebagai tertutup; candle terbaru diserahkan ke WS (kline final x=true) atau sweep berikutnya.
 */
export const CLOSE_MARGIN_MS = 2_000;

function intervalMs(timeframe) {
  const ms = TIMEFRAME_MS[timeframe];
  if (ms === undefined) throw new RangeError(`Timeframe tidak dikenal: ${timeframe}`);
  return ms;
}

function assertTime(name, value) {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} harus bilangan bulat epoch ms`);
}

function assertAligned(name, value, ms) {
  assertTime(name, value);
  if (value % ms !== 0) throw new RangeError(`${name} tidak sejajar dengan batas interval`);
}

function resolveChunkSize(chunkSize) {
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_KLINES_PER_REQUEST) {
    throw new RangeError(`chunkSize harus 1..${MAX_KLINES_PER_REQUEST}`);
  }
  return chunkSize;
}

/** Memecah rentang openTime [start, end] (inklusif, sejajar) menjadi request ≤ chunkSize candle. */
function chunkRange(start, end, ms, chunkSize, out) {
  for (let s = start; s <= end; s += chunkSize * ms) {
    const limit = Math.min(chunkSize, (end - s) / ms + 1);
    out.push({ startTime: s, endTime: s + limit * ms - 1, limit });
  }
  return out;
}

/**
 * openTime candle tertutup terakhir pada waktu `now`.
 * Candle dianggap tertutup bila now > closeTime (= openTime + interval - 1).
 * @param {number} now
 * @param {'5m'|'15m'|'1h'} timeframe
 */
export function lastClosedOpenTime(now, timeframe) {
  const ms = intervalMs(timeframe);
  assertTime('now', now);
  return Math.floor(now / ms) * ms - ms;
}

/**
 * Merencanakan backfill dari candle tersimpan terakhir sampai candle tertutup terakhir sebelum `now`.
 * - `lastOpenTime` null → bootstrap `maxCandles` candle tertutup terakhir.
 * - `lastOpenTime` ada → semua candle setelahnya; bila `maxCandles` diberikan, gap yang lebih
 *   panjang dipotong ke candle paling baru (sisa lama dapat ditutup lewat `planGapFill`).
 * Hasil terurut naik; [] bila sudah up-to-date.
 * @param {{ lastOpenTime: number|null, now: number, timeframe: '5m'|'15m'|'1h', maxCandles?: number, chunkSize?: number }} args
 * @returns {Array<{ startTime: number, endTime: number, limit: number }>}
 */
export function planBackfill({ lastOpenTime, now, timeframe, maxCandles, chunkSize = MAX_KLINES_PER_REQUEST }) {
  const ms = intervalMs(timeframe);
  assertTime('now', now);
  const size = resolveChunkSize(chunkSize);
  const bootstrap = lastOpenTime === null || lastOpenTime === undefined;
  if (bootstrap || maxCandles !== undefined) {
    if (!Number.isInteger(maxCandles) || maxCandles < 1) throw new RangeError('maxCandles harus bilangan bulat ≥ 1');
  }
  if (!bootstrap) assertAligned('lastOpenTime', lastOpenTime, ms);

  const end = lastClosedOpenTime(now, timeframe);
  let start = bootstrap ? end - (maxCandles - 1) * ms : lastOpenTime + ms;
  if (maxCandles !== undefined) start = Math.max(start, end - (maxCandles - 1) * ms);
  if (start > end) return [];
  return chunkRange(start, end, ms, size, []);
}

/**
 * Merencanakan request untuk menutup gap hasil `candles.findGaps` ({ from, to } = openTime
 * candle yang hilang, inklusif). Gap diurutkan; gap yang berdekatan digabung bila jumlah candle
 * yang sudah ada di antaranya ≤ `mergeWithin` dan masih muat dalam satu request (hemat bobot API).
 * Bila `now` diberikan, bagian gap yang belum tertutup dibuang.
 * @param {{ gaps: Array<{ from: number, to: number }>, timeframe: '5m'|'15m'|'1h', now?: number,
 *   mergeWithin?: number, chunkSize?: number }} args
 * @returns {Array<{ startTime: number, endTime: number, limit: number }>}
 */
export function planGapFill({ gaps, timeframe, now, mergeWithin = 0, chunkSize = MAX_KLINES_PER_REQUEST }) {
  const ms = intervalMs(timeframe);
  const size = resolveChunkSize(chunkSize);
  if (!Array.isArray(gaps)) throw new TypeError('gaps harus array');
  if (!Number.isInteger(mergeWithin) || mergeWithin < 0) throw new RangeError('mergeWithin harus bilangan bulat ≥ 0');
  const limitEnd = now === undefined ? Infinity : lastClosedOpenTime(now, timeframe);

  const ranges = gaps.map((gap) => {
    assertAligned('gap.from', gap?.from, ms);
    assertAligned('gap.to', gap?.to, ms);
    if (gap.to < gap.from) throw new RangeError('gap.to lebih kecil dari gap.from');
    return { from: gap.from, to: Math.min(gap.to, limitEnd) };
  })
    .filter((r) => r.from <= r.to)
    .sort((a, b) => a.from - b.from);

  const merged = [];
  for (const r of ranges) {
    const prev = merged.at(-1);
    const between = prev ? (r.from - prev.to) / ms - 1 : Infinity;
    if (prev && between <= mergeWithin && (Math.max(prev.to, r.to) - prev.from) / ms + 1 <= size) {
      prev.to = Math.max(prev.to, r.to);
    } else {
      merged.push({ ...r });
    }
  }

  const out = [];
  for (const r of merged) chunkRange(r.from, r.to, ms, size, out);
  return out;
}
