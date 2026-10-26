// Kontrak data bersama antarmodul (ingestion, indicators, patterns, timeframe, signals).
// Lihat docs/07-kontrak-modul.md untuk antarmuka lengkap. Ubah file ini hanya bila
// semua modul yang bergantung ikut diperbarui.

export const TIMEFRAMES = Object.freeze(['5m', '15m', '1h']);

export const TIMEFRAME_MS = Object.freeze({
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
});

/** Timeframe lebih tinggi yang menjadi konteks untuk tiap timeframe dasar. */
export const HIGHER_TIMEFRAMES = Object.freeze({
  '5m': Object.freeze(['15m', '1h']),
  '15m': Object.freeze(['1h']),
  '1h': Object.freeze([]),
});

/**
 * Arah sinyal. LONG = struktur bullish (SA/PVA), SHORT = struktur bearish (SD/PVD, cermin SA/PVA).
 * Keduanya kandidat RISET, bukan perintah transaksi. Data/argumen tanpa arah (lama) = 'LONG'.
 */
export const DIRECTIONS = Object.freeze(['LONG', 'SHORT']);
export const DEFAULT_DIRECTION = 'LONG';

/**
 * Timeframe yang dipindai per arah (keputusan pengguna 2026-10-26): LONG Scanner hanya 15m (konteks HTF 1h),
 * SHORT Scanner hanya 1h (tanpa HTF di sistem). Worker live hanya mengevaluasi arah pada timeframe-nya, API
 * daftar sinyal per arah hanya mengembalikan timeframe ini, dan UI menampilkan timeframe tetap.
 */
export const DIRECTION_TIMEFRAMES = Object.freeze({
  LONG: Object.freeze(['15m']),
  SHORT: Object.freeze(['1h']),
});

/** Timeframe yang dianalisis untuk daftar arah (gabungan DIRECTION_TIMEFRAMES, urut TIMEFRAMES). */
export function scannedTimeframes(directions = DIRECTIONS) {
  return TIMEFRAMES.filter((tf) => directions.some((d) => DIRECTION_TIMEFRAMES[d]?.includes(tf)));
}

/** Kunci pola LONG (nama lama dipertahankan untuk kompatibilitas). */
export const PATTERN_KEYS = Object.freeze(['SA', 'PVA']);
/** Kunci pola SHORT: Silent Distribution (#003) & Progressive Volume Distribution (#004). */
export const SHORT_PATTERN_KEYS = Object.freeze(['SD', 'PVD']);
export const PATTERN_KEYS_BY_DIRECTION = Object.freeze({ LONG: PATTERN_KEYS, SHORT: SHORT_PATTERN_KEYS });
/** Klasifikasi LONG (nama lama dipertahankan untuk kompatibilitas). */
export const CLASSIFICATIONS = Object.freeze(['SA', 'PVA', 'BOTH', 'NONE']);
export const SHORT_CLASSIFICATIONS = Object.freeze(['SD', 'PVD', 'BOTH', 'NONE']);
export const CLASSIFICATIONS_BY_DIRECTION = Object.freeze({ LONG: CLASSIFICATIONS, SHORT: SHORT_CLASSIFICATIONS });
export const TRENDS = Object.freeze(['BULLISH', 'NEUTRAL', 'BEARISH']);
export const ALIGNMENTS = Object.freeze(['ALIGNED', 'PARTIALLY_CONFIRMED', 'UNCONFIRMED', 'COUNTERTREND']);
/** Semua state sinyal. EARLY_BEARISH & BREAKDOWN hanya untuk SHORT; EARLY_BULLISH & BREAKOUT hanya untuk LONG. */
export const SIGNAL_STATES = Object.freeze([
  'NO_PATTERN', 'QUIET', 'EARLY_BULLISH', 'MOMENTUM_BUILDING', 'BREAKOUT', 'INVALIDATED', 'EXPIRED',
  'EARLY_BEARISH', 'BREAKDOWN',
]);
export const TERMINAL_STATES = Object.freeze(['INVALIDATED', 'EXPIRED']);
/**
 * Tier keyakinan skor konfluensi v3 (backend/scoring/confluence.js): A tertinggi … D terendah. Tier adalah
 * aturan yang dapat dijelaskan, BUKAN probabilitas; peluang historis hanya dari kalibrasi backtest.
 */
export const CONFIDENCE_TIERS = Object.freeze(['A', 'B', 'C', 'D']);
/** Peringkat tier (A = 4 … D = 1); tier tidak dikenal/null = 0. */
export function tierRank(tier) {
  const i = CONFIDENCE_TIERS.indexOf(tier);
  return i < 0 ? 0 : CONFIDENCE_TIERS.length - i;
}
export const RISK_FLAGS = Object.freeze([
  'POOR_LIQUIDITY', 'WIDE_SPREAD', 'EXCESSIVE_VOLATILITY', 'COUNTERTREND_HTF', 'EXTENDED_PRICE', 'DATA_QUALITY',
]);

/**
 * Candle kanonik di memori. Semua waktu epoch ms UTC.
 * closeTime = openTime + TIMEFRAME_MS[timeframe] - 1 (konvensi Binance).
 * @typedef {object} Candle
 * @property {string} symbol            contoh 'BTCUSDT'
 * @property {'5m'|'15m'|'1h'} timeframe
 * @property {number} openTime
 * @property {number} closeTime
 * @property {number} open
 * @property {number} high
 * @property {number} low
 * @property {number} close
 * @property {number} volume            volume base asset
 * @property {number} quoteVolume       volume quote (USDT)
 * @property {number} trades
 * @property {number} takerBuyVolume
 * @property {number} takerBuyQuoteVolume
 * @property {boolean} isClosed         hanya candle tertutup yang boleh dipakai untuk sinyal terkonfirmasi
 * @property {'rest'|'ws'} source
 */

/**
 * Arah yang divalidasi; undefined/null = DEFAULT_DIRECTION ('LONG').
 * @throws {RangeError} bila nilai bukan 'LONG'/'SHORT'
 */
export function resolveDirection(direction) {
  if (direction === undefined || direction === null) return DEFAULT_DIRECTION;
  if (!DIRECTIONS.includes(direction)) throw new RangeError(`Arah tidak dikenal: ${String(direction)}`);
  return direction;
}

/** Open time yang sejajar dengan batas interval UTC. */
export function isAlignedOpenTime(openTime, timeframe) {
  const ms = TIMEFRAME_MS[timeframe];
  return Number.isInteger(openTime) && ms !== undefined && openTime % ms === 0;
}

export function expectedCloseTime(openTime, timeframe) {
  return openTime + TIMEFRAME_MS[timeframe] - 1;
}

/** Candle dianggap tertutup bila waktu sekarang sudah melewati closeTime-nya. */
export function isClosedAt(candle, now) {
  return now > candle.closeTime;
}
