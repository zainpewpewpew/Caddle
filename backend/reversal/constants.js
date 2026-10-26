// Konstanta bersama mesin "Reversal Radar" (deteksi dini potensi reversal bullish, LONG Scanner).
// Kontrak: docs/19-kontrak-reversal-radar.md §2. Mesin ini TERPISAH dari backend/patterns & backend/signals
// (SA/PVA & SD/PVD tetap berjalan apa adanya). Skor di mesin ini adalah skor aturan yang dapat dijelaskan —
// BUKAN probabilitas keberhasilan dan BUKAN perintah transaksi.

/** Versi metodologi; setiap perubahan perilaku deteksi/skor WAJIB menaikkan versi. */
export const REVERSAL_VERSION = 1;

/** Timeframe yang dipantau Reversal Radar — dievaluasi terpisah per timeframe. */
export const REVERSAL_TIMEFRAMES = Object.freeze(['5m', '15m', '1h']);

/** Tahap kandidat (hanya maju; boleh melompat). */
export const STAGES = Object.freeze(['EARLY_FORMATION', 'DEVELOPING_REVERSAL', 'CONFIRMED_BREAKOUT']);
export const STAGE_RANK = Object.freeze({ EARLY_FORMATION: 1, DEVELOPING_REVERSAL: 2, CONFIRMED_BREAKOUT: 3 });

/** Status kandidat: baru, berkembang, terkonfirmasi, batal, kedaluwarsa. */
export const STATUSES = Object.freeze(['NEW', 'DEVELOPING', 'CONFIRMED', 'CANCELLED', 'EXPIRED']);
export const OPEN_STATUSES = Object.freeze(['NEW', 'DEVELOPING', 'CONFIRMED']);
export const TERMINAL_STATUSES = Object.freeze(['CANCELLED', 'EXPIRED']);
export const STATUS_OF_STAGE = Object.freeze({
  EARLY_FORMATION: 'NEW',
  DEVELOPING_REVERSAL: 'DEVELOPING',
  CONFIRMED_BREAKOUT: 'CONFIRMED',
});

/** Jenis setup (label bukti dominan). */
export const SETUP_TYPES = Object.freeze([
  'ROUNDED_BOTTOM', 'DOUBLE_BOTTOM', 'HIGHER_LOW_BASE', 'STAIRCASE', 'SPRING', 'DIVERGENCE_BOTTOM', 'COMPRESSION',
]);

/** Klasifikasi konteks hasil evaluasi. */
export const CLASSIFICATIONS = Object.freeze(['REVERSAL_CANDIDATE', 'CONTINUATION', 'NO_SETUP', 'INSUFFICIENT_DATA', 'DATA_QUALITY']);

export const EVIDENCE_GROUPS = Object.freeze(['EXHAUSTION', 'BASE', 'STRUCTURE', 'VOLUME', 'TRIGGER']);
/** Poin maksimum per grup bukti (jumlah = 100). */
export const EVIDENCE_GROUP_MAX = Object.freeze({ EXHAUSTION: 25, BASE: 25, STRUCTURE: 30, VOLUME: 10, TRIGGER: 10 });

/** Id bukti, urutan tetap (urutan tampil & deterministik). */
export const EVIDENCE_IDS = Object.freeze([
  // EXHAUSTION — tekanan turun melemah
  'LL_SHALLOWER', 'LL_STOPPED', 'BOTTOM_HELD', 'DOWN_MOMENTUM_FADING', 'RSI_DIVERGENCE', 'CVD_DIVERGENCE',
  // BASE — dasar & kompresi
  'ATR_CONTRACTION', 'EMA_CONVERGENCE', 'RANGE_CONTRACTION', 'ROUNDED_BOTTOM', 'RISING_FLOOR',
  // STRUCTURE — perubahan struktur minor
  'HIGHER_LOW', 'SPRING_RECLAIM', 'EMA25_RECLAIM', 'EMA7_TURN_UP', 'CHOCH_BULLISH', 'STAIRCASE',
  // VOLUME — karakter volume
  'VOLUME_DRY_UP', 'QUIET_RISE',
  // TRIGGER — pemicu
  'TRIGGER_BREAK', 'BREAK_VOLUME_SUPPORT', 'BREAK_FOLLOW_THROUGH',
]);

export const EVIDENCE_GROUP_OF = Object.freeze({
  LL_SHALLOWER: 'EXHAUSTION', LL_STOPPED: 'EXHAUSTION', BOTTOM_HELD: 'EXHAUSTION', DOWN_MOMENTUM_FADING: 'EXHAUSTION',
  RSI_DIVERGENCE: 'EXHAUSTION', CVD_DIVERGENCE: 'EXHAUSTION',
  ATR_CONTRACTION: 'BASE', EMA_CONVERGENCE: 'BASE', RANGE_CONTRACTION: 'BASE', ROUNDED_BOTTOM: 'BASE', RISING_FLOOR: 'BASE',
  HIGHER_LOW: 'STRUCTURE', SPRING_RECLAIM: 'STRUCTURE', EMA25_RECLAIM: 'STRUCTURE', EMA7_TURN_UP: 'STRUCTURE',
  CHOCH_BULLISH: 'STRUCTURE', STAIRCASE: 'STRUCTURE',
  VOLUME_DRY_UP: 'VOLUME', QUIET_RISE: 'VOLUME',
  TRIGGER_BREAK: 'TRIGGER', BREAK_VOLUME_SUPPORT: 'TRIGGER', BREAK_FOLLOW_THROUGH: 'TRIGGER',
});

/** Bobot poin tiap bukti (docs/19 §3.1). */
export const EVIDENCE_WEIGHTS = Object.freeze({
  LL_SHALLOWER: 8, LL_STOPPED: 6, BOTTOM_HELD: 7, DOWN_MOMENTUM_FADING: 5, RSI_DIVERGENCE: 8, CVD_DIVERGENCE: 5,
  ATR_CONTRACTION: 6, EMA_CONVERGENCE: 6, RANGE_CONTRACTION: 5, ROUNDED_BOTTOM: 8, RISING_FLOOR: 7,
  HIGHER_LOW: 10, SPRING_RECLAIM: 6, EMA25_RECLAIM: 6, EMA7_TURN_UP: 4, CHOCH_BULLISH: 8, STAIRCASE: 6,
  VOLUME_DRY_UP: 5, QUIET_RISE: 5,
  TRIGGER_BREAK: 4, BREAK_VOLUME_SUPPORT: 3, BREAK_FOLLOW_THROUGH: 3,
});

export const RISKS = Object.freeze([
  'HTF_DOWNTREND', 'HTF_UNKNOWN', 'LOW_LIQUIDITY', 'ILLIQUID', 'EXTENDED', 'LATE_ENTRY', 'VOLATILITY_EXPANDING',
  'NO_VOLUME_SUPPORT', 'NEAR_INVALIDATION', 'DATA_QUALITY', 'PROVISIONAL',
]);

export const LIQUIDITY_CLASSES = Object.freeze(['LIQUID', 'THIN', 'ILLIQUID', 'UNKNOWN']);

/** Sensitivitas = FILTER TAMPILAN (skor & jumlah bukti minimum), bukan parameter mesin. */
export const SENSITIVITIES = Object.freeze(['LOW', 'MEDIUM', 'HIGH']);
export const SENSITIVITY_FILTERS = Object.freeze({
  LOW: Object.freeze({ minScore: 60, minEvidence: 4 }),
  MEDIUM: Object.freeze({ minScore: 45, minEvidence: 3 }),
  HIGH: Object.freeze({ minScore: 0, minEvidence: 0 }),
});

export const CANCEL_REASONS = Object.freeze([
  'CLOSE_BELOW_INVALIDATION', 'BREAKOUT_FAILED', 'NO_PROGRESS', 'EVIDENCE_FADED', 'SYMBOL_DELISTED', 'MONITORING_STOPPED',
]);

export const EVENT_TYPES = Object.freeze(['OPENED', 'STAGE_UP', 'CANCELLED', 'EXPIRED', 'PROVISIONAL_STAGE']);

export const MARKER_KINDS = Object.freeze([
  'BOTTOM', 'LOWER_LOW', 'HIGHER_LOW', 'SPRING', 'CHOCH', 'TRIGGER', 'DIVERGENCE', 'DETECTED', 'STAGE_UP', 'CANCELLED',
]);

/** Jenis kondisi konfirmasi berikutnya. */
export const NEXT_CONFIRMATION_KINDS = Object.freeze(['HIGHER_LOW', 'EMA25_RECLAIM', 'TRIGGER_BREAK', 'HOLD_ABOVE_TRIGGER', 'NONE']);

/** Candle historis yang dimuat per evaluasi (warm-up fitur + konteks swing). */
export const REVERSAL_LOOKBACK = 300;
