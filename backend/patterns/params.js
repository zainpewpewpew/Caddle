// Parameter pola SA (#001) & PVA (#002).
//
// Nilai default adalah titik awal yang masuk akal (angka bulat), BUKAN hasil optimasi terhadap
// data historis. Semua ambang WAJIB divalidasi lewat backtest out-of-sample (Milestone 6)
// sebelum dianggap andal. Jumlah parameter sengaja dibuat sedikit agar risiko overfitting kecil;
// konstanta metodologi (periode EMA/ATR, swing, dsb.) dikunci per versi pola di conditions.js.
//
// Parameter datar (tanpa nesting) dan hanya berisi angka → aman disimpan sebagai JSON di
// kolom pattern_definitions.definition_json lalu divalidasi ulang dengan validateParams().
import { ATR_PERIOD, EMA_SLOW, SLOPE_LOOKBACK, VOLATILITY_BASELINE } from './conditions.js';

const spec = (type, min, max, description) => Object.freeze({ type, min, max, description });

/**
 * Batas atas warm-up requiredCandles(pola, params). Pipeline analisis hanya memuat
 * ANALYSIS_LOOKBACK = 300 candle per seri (backend/analysis/pipeline.js); parameter dengan warm-up
 * lebih panjang membuat pola selamanya insufficientData tanpa error, sehingga ditolak di sini.
 * Nilai ini WAJIB ≤ ANALYSIS_LOOKBACK (dijaga tes).
 */
export const MAX_WARMUP_CANDLES = 300;

/**
 * Rentang yang diizinkan untuk setiap parameter (inklusif). Selain rentang per parameter,
 * validateParams menolak kombinasi dengan requiredCandles > MAX_WARMUP_CANDLES (mis. PVA
 * rvolPeriod + subWindows × subWindowLength > 300).
 */
export const PARAM_SPECS = Object.freeze({
  SA: Object.freeze({
    rvolPeriod: spec('integer', 10, 250, 'Panjang baseline RVOL: jumlah candle sebelumnya'),
    rvolWindow: spec('integer', 1, 50, 'Jumlah candle terakhir yang RVOL-nya dirata-rata'),
    maxAvgRvol: spec('number', 0.1, 2, 'Batas atas rata-rata RVOL (volume senyap)'),
    priceLookback: spec('integer', 5, 200, 'Jendela struktur: perubahan harga & swing low terbaru'),
    maxPriceChange: spec('number', 0.001, 0.5, 'Batas atas kenaikan harga dalam jendela (fraksi)'),
    minHigherLows: spec('integer', 1, 5, 'Minimum higher low terkonfirmasi berurutan'),
    maxAtrPercent: spec('number', 0.001, 0.5, 'Batas atas ATR/close'),
    maxAtrExpansion: spec('number', 1, 10, 'Batas atas ATR% terhadap median ATR% baseline'),
    maxExtensionAtr: spec('number', 0.5, 20, 'Batas atas (close − EMA25) / ATR'),
    minAvgQuoteVolume: spec('number', 0, 1e12, 'Minimum rata-rata quote volume per candle (USDT)'),
    invalidationBufferAtr: spec('number', 0, 5, 'Buffer di bawah swing low (kelipatan ATR)'),
    minScore: spec('number', 0, 100, 'Skor pola minimum agar terdeteksi'),
  }),
  PVA: Object.freeze({
    rvolPeriod: spec('integer', 10, 250, 'Panjang baseline RVOL: jumlah candle sebelumnya'),
    maxPriorRvol: spec('number', 0.1, 3, 'Batas atas rata-rata RVOL sub-jendela pertama (awal sepi)'),
    subWindows: spec('integer', 2, 10, 'Jumlah sub-jendela volume'),
    subWindowLength: spec('integer', 2, 50, 'Panjang tiap sub-jendela (candle)'),
    minVolumeGrowth: spec('number', 1, 20, 'Minimum rasio volume sub-jendela terakhir / pertama'),
    maxSpikeDominance: spec('number', 0.01, 1, 'Batas atas porsi volume satu candle dalam jendela'),
    maxSingleMoveShare: spec('number', 0.1, 1, 'Batas atas porsi kenaikan harga dari satu candle'),
    minHigherLows: spec('integer', 1, 5, 'Minimum higher low terkonfirmasi berurutan'),
    maxAtrPercent: spec('number', 0.001, 0.5, 'Batas atas ATR/close'),
    maxAtrExpansion: spec('number', 1, 10, 'Batas atas ATR% terhadap median ATR% baseline'),
    maxExtensionAtr: spec('number', 0.5, 20, 'Ambang risk flag EXTENDED_PRICE: (close − EMA25) / ATR'),
    minAvgQuoteVolume: spec('number', 0, 1e12, 'Minimum rata-rata quote volume per candle (USDT)'),
    invalidationBufferAtr: spec('number', 0, 5, 'Buffer di bawah swing low (kelipatan ATR)'),
    minScore: spec('number', 0, 100, 'Skor pola minimum agar terdeteksi'),
  }),
});

/** Default SA. Alasan tiap nilai: lihat laporan Milestone 3 / komentar spesifikasi di atas. */
export const DEFAULT_SA_PARAMS = Object.freeze({
  rvolPeriod: 50,
  rvolWindow: 5,
  maxAvgRvol: 0.9,
  priceLookback: 20,
  maxPriceChange: 0.05,
  minHigherLows: 1,
  maxAtrPercent: 0.05,
  maxAtrExpansion: 1.5,
  maxExtensionAtr: 2,
  minAvgQuoteVolume: 10_000,
  invalidationBufferAtr: 0.25,
  minScore: 85,
});

/**
 * Default PVA. Jendela progresif = subWindows × subWindowLength = 20 candle. minVolumeGrowth
 * berlaku untuk volumeGrowth (rata-rata) dan volumeGrowthBroad (median bawah sub-jendela terakhir).
 */
export const DEFAULT_PVA_PARAMS = Object.freeze({
  rvolPeriod: 50,
  maxPriorRvol: 1,
  subWindows: 4,
  subWindowLength: 5,
  minVolumeGrowth: 1.5,
  maxSpikeDominance: 0.2,
  maxSingleMoveShare: 0.5,
  minHigherLows: 1,
  maxAtrPercent: 0.05,
  maxAtrExpansion: 2,
  maxExtensionAtr: 3,
  minAvgQuoteVolume: 10_000,
  invalidationBufferAtr: 0.25,
  minScore: 85,
});

const DEFAULTS = Object.freeze({ SA: DEFAULT_SA_PARAMS, PVA: DEFAULT_PVA_PARAMS });

/** Error konfigurasi parameter pola; `errors` = [{ path, message }]. */
export class PatternParamsError extends RangeError {
  constructor(pattern, errors) {
    super(`Parameter ${pattern} tidak valid: ${errors.map((e) => `${e.path || '/'} ${e.message}`).join('; ')}`);
    this.name = 'PatternParamsError';
    this.errors = errors;
  }
}

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Validasi parameter lengkap satu pola. Tidak melempar; mengembalikan daftar error (kosong = valid).
 * Menolak key tidak dikenal, key yang hilang, tipe salah, dan nilai di luar rentang PARAM_SPECS.
 * @param {unknown} params
 * @param {'SA'|'PVA'} pattern
 * @returns {Array<{ path: string, message: string }>}
 */
export function validateParams(params, pattern) {
  const specs = Object.hasOwn(PARAM_SPECS, pattern) ? PARAM_SPECS[pattern] : null;
  if (!specs) return [{ path: '', message: `Pola tidak dikenal: ${String(pattern)}` }];
  if (!isPlainObject(params)) return [{ path: '', message: 'Parameter harus berupa objek' }];

  const errors = [];
  for (const key of Object.keys(params)) {
    if (!Object.hasOwn(specs, key)) errors.push({ path: `/${key}`, message: 'Parameter tidak dikenal' });
  }
  for (const [key, s] of Object.entries(specs)) {
    const path = `/${key}`;
    if (!Object.hasOwn(params, key)) {
      errors.push({ path, message: 'Parameter wajib diisi' });
      continue;
    }
    const v = params[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      errors.push({ path, message: 'Harus berupa angka hingga' });
    } else if (s.type === 'integer' && !Number.isInteger(v)) {
      errors.push({ path, message: 'Harus bilangan bulat' });
    } else if (v < s.min || v > s.max) {
      errors.push({ path, message: `Harus antara ${s.min} dan ${s.max}` });
    }
  }
  if (errors.length === 0) {
    const warmup = requiredCandles(pattern, params);
    if (warmup > MAX_WARMUP_CANDLES) {
      const formula = pattern === 'SA' ? 'max(rvolPeriod + rvolWindow, priceLookback + 1)' : 'rvolPeriod + subWindows × subWindowLength';
      errors.push({ path: '', message: `Warm-up ${formula} = ${warmup} candle melebihi batas ${MAX_WARMUP_CANDLES} (lookback pipeline analisis)` });
    }
  }
  if (errors.length === 0 && pattern === 'PVA') {
    // Distribusi volume merata memberi dominasi 1/n; ambang ≤ 1/n membuat pola mustahil lulus.
    const floor = 1 / (params.subWindows * params.subWindowLength);
    if (params.maxSpikeDominance <= floor) {
      errors.push({ path: '/maxSpikeDominance', message: `Harus lebih besar dari 1/(subWindows×subWindowLength) = ${floor}` });
    }
  }
  return errors;
}

/**
 * Gabungkan override parsial dengan default lalu validasi. Tanpa override → objek default (beku).
 * @param {'SA'|'PVA'} pattern
 * @param {object|null} [overrides]
 * @throws {PatternParamsError}
 */
export function resolveParams(pattern, overrides) {
  const defaults = DEFAULTS[pattern];
  if (!defaults) throw new PatternParamsError(String(pattern), [{ path: '', message: 'Pola tidak dikenal' }]);
  if (overrides === undefined || overrides === null) return defaults;
  if (!isPlainObject(overrides)) throw new PatternParamsError(pattern, [{ path: '', message: 'Parameter harus berupa objek' }]);
  const merged = { ...defaults, ...overrides };
  const errors = validateParams(merged, pattern);
  if (errors.length > 0) throw new PatternParamsError(pattern, errors);
  return Object.freeze(merged);
}

/**
 * Jumlah candle minimum (warm-up) agar seluruh kondisi dapat dihitung tanpa nilai null.
 * SA: RVOL rata-rata butuh rvolPeriod + rvolWindow; PVA: rvolPeriod + jendela progresif
 * (RVOL sub-jendela pertama). Keduanya juga butuh ATR + baseline volatilitas, EMA25 + slope.
 * EMA99 tidak dipakai, sehingga tidak ikut warm-up. Default: SA 63, PVA 70.
 * @param {'SA'|'PVA'} pattern
 * @param {object} params parameter lengkap (hasil resolveParams)
 */
export function requiredCandles(pattern, params) {
  const common = Math.max(ATR_PERIOD - 1 + VOLATILITY_BASELINE, EMA_SLOW + SLOPE_LOOKBACK - 1);
  if (pattern === 'SA') {
    return Math.max(common, params.rvolPeriod + params.rvolWindow, params.priceLookback + 1);
  }
  const window = params.subWindows * params.subWindowLength;
  return Math.max(common, params.rvolPeriod + window, window + 1);
}
