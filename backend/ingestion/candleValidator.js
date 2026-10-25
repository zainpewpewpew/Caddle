// Validasi & normalisasi candle sebelum masuk penyimpanan. Fungsi murni: waktu lewat argumen.
// Hanya candle yang lolos validasi (dan tertutup) yang boleh masuk tabel kanonik `candles`.

import { TIMEFRAMES, TIMEFRAME_MS, expectedCloseTime, isAlignedOpenTime } from '../market/contracts.js';
import { CLOSE_MARGIN_MS } from './backfill.js';

const SYMBOL_PATTERN = /^[A-Z0-9]{1,32}$/;
const SOURCES = Object.freeze(['rest', 'ws']);
const PRICE_FIELDS = Object.freeze(['open', 'high', 'low', 'close']);
const VOLUME_FIELDS = Object.freeze(['volume', 'quoteVolume', 'takerBuyVolume', 'takerBuyQuoteVolume']);
// Toleransi relatif untuk takerBuy ≤ volume: angka desimal Binance yang di-parse ke float64
// dapat berselisih di digit terakhir bila salah satunya hasil penjumlahan.
const TAKER_TOLERANCE = 1e-9;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isPositiveFinite = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
const isNonNegativeFinite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isNonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;
const exceeds = (part, total) => part - total > TAKER_TOLERANCE * Math.max(1, Math.abs(total));

/** Format simbol yang diterima sistem: huruf besar & angka ASCII, 1–32 karakter. */
export function isValidSymbol(symbol) {
  return typeof symbol === 'string' && SYMBOL_PATTERN.test(symbol);
}

function assertTime(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${name} wajib berupa epoch ms`);
}

function assertTimeframe(timeframe) {
  if (!TIMEFRAMES.includes(timeframe)) throw new TypeError(`timeframe tidak didukung: ${String(timeframe)}`);
}

/**
 * Toleransi jam untuk kline WebSocket (ms) = margin penutupan (CLOSE_MARGIN_MS). Untuk `source: 'ws'`,
 * `isClosed` berasal dari bendera bursa (k.x === true), bukan tebakan jam worker; jam worker (jam lokal +
 * offset serverClock) dapat tertinggal dari Binance sebesar galat sinkronisasi (≤ RTT/2) + drift, sementara
 * kline final tiba hanya puluhan ms setelah closeTime. Kline final WS karena itu sah bila
 * `now > closeTime − toleransi`, dan openTime WS baru dianggap "di masa depan" bila `openTime > now + toleransi`.
 * Batasnya sama dengan margin REST: REST hanya menganggap tertutup candle yang tutup > margin sebelum request,
 * WS tidak diveto jam yang selisihnya ≤ margin. Selisih lebih besar → jam dianggap rusak dan candle ditolak.
 * Candle REST tetap ketat (`now > closeTime`) karena isClosed-nya dihitung dari jam worker sendiri.
 */
export const WS_CLOCK_TOLERANCE_MS = CLOSE_MARGIN_MS;

/**
 * Memvalidasi satu candle kanonik. Seluruh pelanggaran dikumpulkan.
 * Candle bertanda `isClosed: true` hanya sah bila `now > closeTime`; openTime tidak boleh di masa depan.
 * Untuk `source: 'ws'` keduanya dinilai dengan toleransi `wsClockToleranceMs` (lihat WS_CLOCK_TOLERANCE_MS).
 * @param {import('../market/contracts.js').Candle} candle
 * @param {{ now: number, wsClockToleranceMs?: number }} options  now = waktu sekarang (epoch ms), mis. waktu
 *   server Binance; wsClockToleranceMs = bilangan bulat 0..60000 (default WS_CLOCK_TOLERANCE_MS)
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateCandle(candle, { now, wsClockToleranceMs = WS_CLOCK_TOLERANCE_MS } = {}) {
  assertTime(now, 'now');
  if (!Number.isInteger(wsClockToleranceMs) || wsClockToleranceMs < 0 || wsClockToleranceMs > 60_000) {
    throw new TypeError('wsClockToleranceMs harus bilangan bulat 0..60000');
  }
  if (!isObject(candle)) return { ok: false, errors: ['candle harus berupa objek'] };
  // Kline WS: bendera tertutup dari bursa; jam worker hanya memveto bila selisihnya melebihi toleransi.
  const tolerance = candle.source === 'ws' ? wsClockToleranceMs : 0;

  const errors = [];
  const { symbol, timeframe, openTime, closeTime } = candle;

  if (!isValidSymbol(symbol)) errors.push('symbol tidak valid (harus [A-Z0-9]{1,32})');

  const timeframeOk = TIMEFRAMES.includes(timeframe);
  if (!timeframeOk) errors.push(`timeframe tidak didukung: ${String(timeframe)}`);

  const openTimeOk = isNonNegativeInteger(openTime);
  if (!openTimeOk) {
    errors.push('openTime harus bilangan bulat ms ≥ 0');
  } else {
    if (timeframeOk && !isAlignedOpenTime(openTime, timeframe)) errors.push('openTime tidak sejajar batas interval');
    if (openTime > now + tolerance) errors.push('openTime di masa depan');
  }
  if (openTimeOk && timeframeOk && closeTime !== expectedCloseTime(openTime, timeframe)) {
    errors.push('closeTime harus openTime + interval - 1');
  }

  const pricesOk = PRICE_FIELDS.every((field) => {
    if (isPositiveFinite(candle[field])) return true;
    errors.push(`${field} harus angka finite > 0`);
    return false;
  });
  if (pricesOk) {
    const { open, high, low, close } = candle;
    if (high < Math.max(open, close, low)) errors.push('high lebih kecil dari open/close/low');
    if (low > Math.min(open, close)) errors.push('low lebih besar dari open/close');
  }

  const volumeOk = Object.fromEntries(VOLUME_FIELDS.map((field) => {
    const ok = isNonNegativeFinite(candle[field]);
    if (!ok) errors.push(`${field} harus angka finite ≥ 0`);
    return [field, ok];
  }));
  if (volumeOk.volume && volumeOk.takerBuyVolume && exceeds(candle.takerBuyVolume, candle.volume)) {
    errors.push('takerBuyVolume melebihi volume');
  }
  if (volumeOk.quoteVolume && volumeOk.takerBuyQuoteVolume && exceeds(candle.takerBuyQuoteVolume, candle.quoteVolume)) {
    errors.push('takerBuyQuoteVolume melebihi quoteVolume');
  }

  if (!isNonNegativeInteger(candle.trades)) errors.push('trades harus bilangan bulat ≥ 0');
  if (!SOURCES.includes(candle.source)) errors.push('source harus rest atau ws');

  if (typeof candle.isClosed !== 'boolean') {
    errors.push('isClosed harus boolean');
  } else if (candle.isClosed && !(typeof closeTime === 'number' && now + tolerance > closeTime)) {
    errors.push('candle ditandai tertutup sebelum closeTime terlewati');
  }

  return { ok: errors.length === 0, errors };
}

const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Mengurutkan batch berdasarkan openTime naik dan membuang duplikat (symbol, timeframe, openTime);
 * bila ada duplikat, versi TERAKHIR dalam batch yang dipakai. Input tidak dimutasi.
 * Urutan untuk openTime yang sama: symbol lalu timeframe (deterministik).
 * @param {import('../market/contracts.js').Candle[]} candles
 * @returns {import('../market/contracts.js').Candle[]}
 */
export function normalizeBatch(candles) {
  if (!Array.isArray(candles)) throw new TypeError('candles harus berupa array');
  const latest = new Map();
  for (const candle of candles) {
    if (!isObject(candle)) throw new TypeError('setiap elemen batch harus berupa objek candle');
    latest.set(`${candle.symbol}\u0000${candle.timeframe}\u0000${candle.openTime}`, candle);
  }
  return [...latest.values()].sort((a, b) => (a.openTime - b.openTime)
    || compareText(a.symbol, b.symbol)
    || compareText(a.timeframe, b.timeframe));
}

/**
 * Membulatkan waktu ke bawah ke batas interval UTC (open time candle yang memuat `time`).
 * @param {number} time epoch ms
 * @param {'5m'|'15m'|'1h'} timeframe
 */
export function floorToInterval(time, timeframe) {
  assertTime(time, 'time');
  assertTimeframe(timeframe);
  const ms = TIMEFRAME_MS[timeframe];
  return Math.floor(time / ms) * ms;
}

/**
 * Menilai kesegaran data candle tertutup.
 * `expectedLastOpenTime` = openTime candle tertutup terbaru yang seharusnya sudah ada pada `now`.
 * `lagMs` = waktu sejak candle tersimpan terakhir tertutup.
 * Data basi bila tertinggal ≥ 1 candle dan candle tertinggal yang PALING LAMA (lastOpenTime + interval) sudah
 * tertutup lebih lama dari `graceMs` — bukan candle terbaru, yang baru saja tutup tepat setelah setiap batas
 * interval sehingga seri yang mati berjam-jam akan tampak segar selama `graceMs` pertama tiap interval.
 * @param {{ lastOpenTime: number|null, timeframe: '5m'|'15m'|'1h', now: number, graceMs?: number }} input
 * @returns {{ expectedLastOpenTime: number, missingCandles: number|null, lagMs: number|null, stale: boolean }}
 */
export function assessFreshness({ lastOpenTime, timeframe, now, graceMs = 0 }) {
  assertTime(now, 'now');
  assertTimeframe(timeframe);
  if (!isNonNegativeFinite(graceMs)) throw new TypeError('graceMs harus angka ≥ 0');
  const ms = TIMEFRAME_MS[timeframe];
  // Candle dengan openTime o tertutup bila now > o + ms - 1, yaitu o ≤ now - ms.
  const expectedLastOpenTime = floorToInterval(now, timeframe) - ms;
  if (lastOpenTime === null || lastOpenTime === undefined) {
    return { expectedLastOpenTime, missingCandles: null, lagMs: null, stale: true };
  }
  assertTime(lastOpenTime, 'lastOpenTime');
  const missingCandles = Math.max(0, Math.floor((expectedLastOpenTime - lastOpenTime) / ms));
  const lagMs = Math.max(0, now - (lastOpenTime + ms));
  // Candle tertinggal paling lama = lastOpenTime + ms, tertutup sejak lastOpenTime + 2·ms.
  const overdueMs = now - (lastOpenTime + 2 * ms);
  return { expectedLastOpenTime, missingCandles, lagMs, stale: missingCandles > 0 && overdueMs > graceMs };
}
