// Validasi & normalisasi candle sebelum masuk penyimpanan. Fungsi murni: waktu lewat argumen.
// Hanya candle yang lolos validasi (dan tertutup) yang boleh masuk tabel kanonik `candles`.

import { TIMEFRAMES, TIMEFRAME_MS, expectedCloseTime, isAlignedOpenTime } from '../market/contracts.js';

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

function assertTime(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${name} wajib berupa epoch ms`);
}

function assertTimeframe(timeframe) {
  if (!TIMEFRAMES.includes(timeframe)) throw new TypeError(`timeframe tidak didukung: ${String(timeframe)}`);
}

/**
 * Memvalidasi satu candle kanonik. Seluruh pelanggaran dikumpulkan.
 * Candle bertanda `isClosed: true` hanya sah bila `now > closeTime`; openTime tidak boleh di masa depan.
 * @param {import('../market/contracts.js').Candle} candle
 * @param {{ now: number }} options  waktu sekarang (epoch ms), mis. waktu server Binance
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateCandle(candle, { now } = {}) {
  assertTime(now, 'now');
  if (!isObject(candle)) return { ok: false, errors: ['candle harus berupa objek'] };

  const errors = [];
  const { symbol, timeframe, openTime, closeTime } = candle;

  if (typeof symbol !== 'string' || !SYMBOL_PATTERN.test(symbol)) errors.push('symbol tidak valid (harus [A-Z0-9]{1,32})');

  const timeframeOk = TIMEFRAMES.includes(timeframe);
  if (!timeframeOk) errors.push(`timeframe tidak didukung: ${String(timeframe)}`);

  const openTimeOk = isNonNegativeInteger(openTime);
  if (!openTimeOk) {
    errors.push('openTime harus bilangan bulat ms ≥ 0');
  } else {
    if (timeframeOk && !isAlignedOpenTime(openTime, timeframe)) errors.push('openTime tidak sejajar batas interval');
    if (openTime > now) errors.push('openTime di masa depan');
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
  } else if (candle.isClosed && !(typeof closeTime === 'number' && now > closeTime)) {
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
 * Data basi bila tertinggal ≥ 1 candle dan candle yang tertinggal sudah tertutup lebih lama dari `graceMs`.
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
  const overdueMs = now - (expectedLastOpenTime + ms);
  return { expectedLastOpenTime, missingCandles, lagMs, stale: missingCandles > 0 && overdueMs > graceMs };
}
