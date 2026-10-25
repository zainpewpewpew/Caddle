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

export const PATTERN_KEYS = Object.freeze(['SA', 'PVA']);
export const CLASSIFICATIONS = Object.freeze(['SA', 'PVA', 'BOTH', 'NONE']);
export const TRENDS = Object.freeze(['BULLISH', 'NEUTRAL', 'BEARISH']);
export const ALIGNMENTS = Object.freeze(['ALIGNED', 'PARTIALLY_CONFIRMED', 'UNCONFIRMED', 'COUNTERTREND']);
export const SIGNAL_STATES = Object.freeze([
  'NO_PATTERN', 'QUIET', 'EARLY_BULLISH', 'MOMENTUM_BUILDING', 'BREAKOUT', 'INVALIDATED', 'EXPIRED',
]);
export const TERMINAL_STATES = Object.freeze(['INVALIDATED', 'EXPIRED']);
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
