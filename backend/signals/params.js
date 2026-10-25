// Parameter state machine sinyal (konfigurabel, divalidasi). Satuan bar = candle timeframe dasar.

/** State "pola" yang berarti sinyal sedang terbuka (non-terminal, bukan NO_PATTERN). */
export const PATTERN_STATES = Object.freeze(['QUIET', 'EARLY_BULLISH', 'MOMENTUM_BUILDING', 'BREAKOUT']);

/** State yang memicu alert saat dimasuki (selaras dengan ALERT_STAGES pengaturan scanner). */
export const ALERT_STATES = Object.freeze(['EARLY_BULLISH', 'MOMENTUM_BUILDING', 'BREAKOUT']);

/**
 * Reason event EXPIRED di luar candle: simbol berhenti dipantau scanner sehingga sinyal terbuka tidak akan
 * pernah menerima candle baru (dan tidak akan kedaluwarsa lewat NO_PROGRESS). Ditutup oleh
 * signalRepository.closeOpenForSymbol, tanpa alert.
 * - SYMBOL_DELISTED: simbol hilang dari exchangeInfo atau status bukan TRADING;
 * - MONITORING_STOPPED: simbol/timeframe keluar dari set pantauan (rediscovery, pengaturan).
 */
export const MONITORING_STOP_REASONS = Object.freeze(['SYMBOL_DELISTED', 'MONITORING_STOPPED']);

/** Peringkat kemajuan; transisi maju hanya ke peringkat lebih tinggi (tidak ada downgrade). */
export const STATE_RANK = Object.freeze({ NO_PATTERN: 0, QUIET: 1, EARLY_BULLISH: 2, MOMENTUM_BUILDING: 3, BREAKOUT: 4 });

export const DEFAULT_SIGNAL_PARAMS = Object.freeze({
  /** earlyScore minimum agar pola terdeteksi langsung/naik menjadi EARLY_BULLISH (di bawahnya QUIET). */
  earlyMinScore: 60,
  /** MOMENTUM_BUILDING bila close ≥ firstDetectedPrice + k × ATR. */
  momentumAtrMultiple: 1,
  /** …atau RVOL ≥ ambang ini dengan close > firstDetectedPrice. */
  momentumRvol: 1.5,
  /** BREAKOUT bila close > max(resistance, firstDetectedPrice) dengan RVOL ≥ ambang ini. */
  breakoutRvol: 2,
  /** Batas bar tanpa kemajuan (tanpa perpindahan state) per state sebelum EXPIRED. */
  expiryBars: Object.freeze({ QUIET: 48, EARLY_BULLISH: 36, MOMENTUM_BUILDING: 24, BREAKOUT: 12 }),
});

/** Parameter turunan indikator untuk deriveMarketInputs (ATR, RVOL, swing high terkonfirmasi). */
export const DEFAULT_MARKET_PARAMS = Object.freeze({ atrPeriod: 14, rvolPeriod: 20, swingLeft: 2, swingRight: 2 });

const isPositive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * Menggabungkan override dengan default dan memvalidasi. Kunci tak dikenal ditolak
 * agar salah ketik konfigurasi tidak diam-diam diabaikan.
 * @param {object} [overrides]
 * @returns {Readonly<typeof DEFAULT_SIGNAL_PARAMS>}
 */
export function resolveSignalParams(overrides = {}) {
  if (overrides === null || typeof overrides !== 'object') throw new TypeError('Parameter sinyal harus objek');
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(DEFAULT_SIGNAL_PARAMS, key)) throw new TypeError(`Parameter sinyal tidak dikenal: ${key}`);
  }
  const expiryOverrides = overrides.expiryBars ?? {};
  if (expiryOverrides === null || typeof expiryOverrides !== 'object') throw new TypeError('expiryBars harus objek');
  for (const key of Object.keys(expiryOverrides)) {
    if (!PATTERN_STATES.includes(key)) throw new TypeError(`expiryBars untuk state tidak dikenal: ${key}`);
  }
  const p = { ...DEFAULT_SIGNAL_PARAMS, ...overrides, expiryBars: { ...DEFAULT_SIGNAL_PARAMS.expiryBars, ...expiryOverrides } };

  if (typeof p.earlyMinScore !== 'number' || !(p.earlyMinScore >= 0 && p.earlyMinScore <= 100)) {
    throw new RangeError('earlyMinScore harus 0..100');
  }
  for (const key of ['momentumAtrMultiple', 'momentumRvol', 'breakoutRvol']) {
    if (!isPositive(p[key])) throw new RangeError(`${key} harus angka > 0`);
  }
  for (const state of PATTERN_STATES) {
    if (!Number.isInteger(p.expiryBars[state]) || p.expiryBars[state] < 1) {
      throw new RangeError(`expiryBars.${state} harus bilangan bulat ≥ 1`);
    }
  }
  return Object.freeze({ ...p, expiryBars: Object.freeze(p.expiryBars) });
}

/** Validasi parameter turunan indikator. */
export function resolveMarketParams(overrides = {}) {
  if (overrides === null || typeof overrides !== 'object') throw new TypeError('Parameter pasar harus objek');
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(DEFAULT_MARKET_PARAMS, key)) throw new TypeError(`Parameter pasar tidak dikenal: ${key}`);
  }
  const p = { ...DEFAULT_MARKET_PARAMS, ...overrides };
  for (const [key, v] of Object.entries(p)) {
    if (!Number.isInteger(v) || v < 1) throw new RangeError(`${key} harus bilangan bulat ≥ 1`);
  }
  return Object.freeze(p);
}
