// Helper murni bersama detektor SA & PVA: konstanta metodologi (dikunci per versi pola),
// pemeriksaan kualitas data, fitur turunan indikator, evaluasi kondisi deklaratif, skor,
// earlyScore, harga invalidasi, dan risk flag. Detektor memakai helper ini masing-masing
// dan TIDAK saling memanggil.
//
// PENTING: patternScore & earlyScore adalah skor aturan 0–100 yang dapat dijelaskan per
// kondisi — BUKAN probabilitas keberhasilan dan bukan rekomendasi transaksi.
//
// Anti lookahead: semua nilai dihitung pada candle TERAKHIR array yang diberikan (diasumsikan
// tertutup; candle belum tertutup ditolak) dan swing hanya dipakai bila confirmedIndex ≤ indeks
// terakhir. Indikator (EMA, ATR, RVOL) hanya memakai data sampai indeks tersebut.
import { RISK_FLAGS, TIMEFRAME_MS } from '../market/contracts.js';
import { atr, confirmedAt, ema, findSwings, normalizedSlope, trailingHigherLows } from '../indicators/index.js';

export const PATTERN_VERSION = 1;
export const EMA_FAST = 7;
export const EMA_SLOW = 25;
export const ATR_PERIOD = 14;
/** Jumlah titik regresi untuk slope EMA. */
export const SLOPE_LOOKBACK = 5;
/** Swing fraktal 2-2: swing baru terkonfirmasi 2 candle setelah terbentuk. */
export const SWING_OPTIONS = Object.freeze({ left: 2, right: 2 });
/** Jumlah nilai ATR% terakhir untuk median pembanding lonjakan volatilitas. */
export const VOLATILITY_BASELINE = 50;
/** EMA25 dianggap datar bila slope ≥ −0,02% per candle. */
export const EMA_SLOW_FLAT_EPSILON = 0.0002;
/** Volume nol berurutan sebanyak ini (atau lebih) di jendela evaluasi = masalah kualitas data. */
export const ZERO_VOLUME_STREAK = 3;

/**
 * Formula earlyScore (lihat computeEarlyScore):
 *   earlyScore = 100 × (distanceWeight × skorJarak + ageWeight × skorUsia)
 *   skorJarak  = clamp01(1 − kenaikanAtr / maxRunAtr), kenaikanAtr = (close − anchor) / ATR
 *   skorUsia   = clamp01(1 − usia / maxAgeBars),       usia = candle sejak struktur mulai
 * Harga ≥ 4 ATR di atas dasar struktur → komponen jarak 0; struktur ≥ 60 candle → komponen usia 0.
 * Jarak diberi bobot lebih besar karena menentukan seberapa jauh harga dari level invalidasi.
 */
export const EARLY_SCORE = Object.freeze({ maxRunAtr: 4, maxAgeBars: 60, distanceWeight: 0.6, ageWeight: 0.4 });

/** Kondisi gerbang (bobot 0, wajib) yang selalu berada di awal daftar kondisi. */
export const GATE_CONDITIONS = Object.freeze([
  Object.freeze({ id: 'enoughData', label: 'Jumlah candle tertutup mencukupi warm-up', weight: 0, required: true, comparator: 'gte' }),
  Object.freeze({ id: 'dataQuality', label: 'Kualitas data memadai (tanpa gap waktu, volume nol beruntun, atau candle belum tertutup)', weight: 0, required: true, comparator: 'lte' }),
]);

const COMPARATORS = Object.freeze({
  gt: (v, t) => v > t,
  gte: (v, t) => v >= t,
  lte: (v, t) => v <= t,
});

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/** Rata-rata; null bila kosong atau ada nilai non-hingga/null. */
export function mean(values) {
  if (values.length === 0 || !values.every(isFiniteNumber)) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Median; null bila kosong atau ada nilai non-hingga/null. */
export function median(values) {
  if (values.length === 0 || !values.every(isFiniteNumber)) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const ratio = (a, b) => (isFiniteNumber(a) && isFiniteNumber(b) && b > 0 ? a / b : null);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const round1 = (v) => Math.round(v * 10) / 10;

function isValidCandle(c) {
  if (typeof c !== 'object' || c === null) return false;
  const { open, high, low, close, volume, quoteVolume, openTime, closeTime } = c;
  if (![open, high, low, close].every((v) => isFiniteNumber(v) && v > 0)) return false;
  if (high < low || high < Math.max(open, close) || low > Math.min(open, close)) return false;
  if (!isFiniteNumber(volume) || volume < 0 || !isFiniteNumber(quoteVolume) || quoteVolume < 0) return false;
  return Number.isInteger(openTime) && Number.isInteger(closeTime) && closeTime > openTime;
}

/**
 * Periksa kualitas data. `fatal` = data tidak dapat dihitung (OHLCV tidak valid, candle belum
 * tertutup, urutan/duplikat, campuran simbol/timeframe, timeframe tidak dikenal). `issues` =
 * fatal + gap waktu dan volume nol beruntun di `windowSize` candle terakhir. Setiap masalah →
 * risk flag DATA_QUALITY dan pola tidak terdeteksi.
 * @param {object[]} candles
 * @param {number} windowSize jendela evaluasi (biasanya jumlah candle minimum pola)
 * @returns {{ fatal: string[], issues: string[] }}
 */
export function inspectCandles(candles, windowSize) {
  const fatal = new Set();
  const ref = candles.find(isValidCandle);
  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i];
    if (!isValidCandle(c)) {
      fatal.add('INVALID_CANDLE');
      continue;
    }
    if (c.isClosed !== true) fatal.add('NOT_CLOSED');
    if (c.symbol !== ref.symbol || c.timeframe !== ref.timeframe) fatal.add('MIXED_SERIES');
    const prev = candles[i - 1];
    if (i > 0 && isValidCandle(prev) && c.openTime <= prev.openTime) fatal.add('UNSORTED');
  }
  const interval = ref ? TIMEFRAME_MS[ref.timeframe] : undefined;
  if (ref && interval === undefined) fatal.add('UNKNOWN_TIMEFRAME');

  const issues = new Set(fatal);
  if (fatal.size === 0 && candles.length > 0) {
    const from = Math.max(0, candles.length - windowSize);
    let streak = 0;
    for (let i = from; i < candles.length; i += 1) {
      streak = candles[i].volume === 0 ? streak + 1 : 0;
      if (streak >= ZERO_VOLUME_STREAK) issues.add('ZERO_VOLUME_STREAK');
      if (i > from && candles[i].openTime - candles[i - 1].openTime !== interval) issues.add('TIME_GAP');
    }
  }
  return { fatal: [...fatal], issues: [...issues] };
}

/**
 * Fitur indikator pada candle terakhir. Hanya swing low dengan confirmedIndex ≤ indeks terakhir.
 * @param {object[]} candles candle valid, tertutup, urut naik
 */
export function computeFeatures(candles) {
  const last = candles.length - 1;
  const closes = candles.map((c) => c.close);
  const ema7 = ema(closes, EMA_FAST);
  const ema25 = ema(closes, EMA_SLOW);
  const atrSeries = atr(candles, ATR_PERIOD);
  const atrPct = atrSeries.map((v, i) => (v === null ? null : v / closes[i]));
  const close = closes[last];
  const atrLast = atrSeries[last];
  const ema25Last = ema25[last];
  return {
    last,
    closes,
    close,
    atr: atrLast,
    ema25: ema25Last,
    ema7Slope: normalizedSlope(ema7, SLOPE_LOOKBACK)[last],
    ema25Slope: normalizedSlope(ema25, SLOPE_LOOKBACK)[last],
    atrPercent: atrPct[last],
    atrExpansion: ratio(atrPct[last], median(atrPct.slice(-VOLATILITY_BASELINE))),
    extensionAtr: isFiniteNumber(ema25Last) && atrLast > 0 ? (close - ema25Last) / atrLast : null,
    swingLows: confirmedAt(findSwings(candles, SWING_OPTIONS), last).lows,
  };
}

/**
 * Struktur higher-low dalam `window` candle terakhir.
 * Bila swing low terkonfirmasi terbaru berada di jendela dan close masih di atasnya (struktur
 * belum patah): anchor = swing low itu, higherLows = jumlah higher low berurutan, startIndex =
 * swing low pertama rantai tersebut. Selain itu: anchor = low terendah jendela, higherLows = 0.
 */
export function analyzeStructure(candles, features, window) {
  const { last, close, swingLows } = features;
  const from = Math.max(0, last - window + 1);
  const lastLow = swingLows.at(-1);
  if (lastLow && lastLow.index >= from && close > lastLow.price) {
    const chain = trailingHigherLows(swingLows);
    return {
      higherLows: chain,
      anchorPrice: lastLow.price,
      anchorIndex: lastLow.index,
      startIndex: swingLows[swingLows.length - 1 - chain].index,
      fromSwing: true,
    };
  }
  let idx = from;
  for (let i = from + 1; i <= last; i += 1) if (candles[i].low < candles[idx].low) idx = i;
  return { higherLows: 0, anchorPrice: candles[idx].low, anchorIndex: idx, startIndex: idx, fromSwing: false };
}

/**
 * earlyScore 0–100 (formula di EARLY_SCORE). Hanya bermakna bila ada struktur bullish: minimal
 * satu higher low terkonfirmasi yang masih utuh. Tanpa struktur (mis. downtrend, harga datar)
 * atau ATR nol → 0, agar harga yang jatuh/diam di dekat low tidak tampak "sangat awal".
 */
export function computeEarlyScore(structure, features) {
  const { atr: a, close, last } = features;
  if (!structure.fromSwing || structure.higherLows < 1 || !(a > 0)) return 0;
  const runAtr = Math.max(0, (close - structure.anchorPrice) / a);
  const age = last - structure.startIndex;
  const distance = clamp01(1 - runAtr / EARLY_SCORE.maxRunAtr);
  const youth = clamp01(1 - age / EARLY_SCORE.maxAgeBars);
  return round1(100 * (EARLY_SCORE.distanceWeight * distance + EARLY_SCORE.ageWeight * youth));
}

/**
 * Harga invalidasi = anchor struktur (swing low terkonfirmasi terakhir atau low terendah jendela)
 * dikurangi bufferAtr × ATR. null bila hasilnya tidak di antara 0 dan close (data degenerat).
 */
export function computeInvalidation(structure, features, bufferAtr) {
  const buffer = features.atr > 0 ? bufferAtr * features.atr : 0;
  const level = structure.anchorPrice - buffer;
  return level > 0 && level < features.close ? level : null;
}

/** Risk flag terurut sesuai RISK_FLAGS (deterministik). */
export function orderRiskFlags(flags) {
  return RISK_FLAGS.filter((f) => flags.has(f));
}

/**
 * Bangun daftar kondisi dari definisi deklaratif: { id, label, weight, required, comparator,
 * threshold(params) }. Kondisi lulus hanya bila nilainya angka hingga dan memenuhi pembanding.
 * @param {object[]} defs
 * @param {Record<string, number|null>} values
 * @param {Record<string, number|null>} thresholds
 */
export function buildConditions(defs, values, thresholds) {
  return defs.map((d) => {
    const value = isFiniteNumber(values[d.id]) ? values[d.id] : null;
    const threshold = thresholds[d.id] ?? null;
    const passed = value !== null && threshold !== null && COMPARATORS[d.comparator](value, threshold);
    return { id: d.id, label: d.label, passed, value, threshold, weight: d.weight };
  });
}

/** patternScore = Σ bobot kondisi lulus / Σ bobot × 100 (satu desimal). Total bobot 0 → 0. */
export function computePatternScore(conditions) {
  const total = conditions.reduce((a, c) => a + c.weight, 0);
  if (total <= 0) return 0;
  const passed = conditions.reduce((a, c) => a + (c.passed ? c.weight : 0), 0);
  return round1((passed / total) * 100);
}

/**
 * Rakit PatternResult sesuai kontrak §6. detected = semua kondisi wajib lulus, patternScore ≥
 * minScore, dan data cukup.
 */
export function buildResult({ pattern, defs, conditions, minScore, earlyScore, invalidationPrice, evaluatedAt, riskFlags, insufficientData }) {
  const patternScore = computePatternScore(conditions);
  const byId = new Map(conditions.map((c) => [c.id, c]));
  const requiredOk = defs.every((d) => !d.required || byId.get(d.id)?.passed === true);
  return {
    pattern,
    version: PATTERN_VERSION,
    detected: !insufficientData && requiredOk && patternScore >= minScore,
    patternScore,
    earlyScore,
    conditions,
    invalidationPrice,
    evaluatedAt,
    riskFlags: orderRiskFlags(riskFlags),
    insufficientData,
  };
}

/** closeTime candle terakhir bila valid; selain itu null. */
export function evaluatedAtOf(candles) {
  const lastCandle = candles.at(-1);
  return lastCandle && Number.isInteger(lastCandle.closeTime) ? lastCandle.closeTime : null;
}

/** Metadata kondisi untuk diekspor (tanpa fungsi), beku. */
export function describeConditions(defs) {
  return Object.freeze(defs.map(({ id, label, weight, required, comparator }) => Object.freeze({ id, label, weight, required, comparator })));
}

/**
 * Kerangka umum detektor: validasi input, gerbang data, lalu `measure` khusus pola.
 * `measure(candles, params, features)` → { values, structureWindow, liquidityWindow }.
 * Detektor SA & PVA masing-masing memanggil fungsi ini dengan definisi & pengukurnya sendiri.
 */
export function runDetector({ pattern, candles, params, minCandles, defs, thresholds, measure }) {
  if (!Array.isArray(candles)) throw new TypeError('candles harus berupa array');
  const allDefs = [...GATE_CONDITIONS, ...defs];
  const allThresholds = { enoughData: minCandles, dataQuality: 0, ...thresholds };
  const { fatal, issues } = inspectCandles(candles, minCandles);
  const insufficientData = candles.length < minCandles;
  const gateValues = { enoughData: candles.length, dataQuality: issues.length };
  const flags = new Set(issues.length > 0 ? ['DATA_QUALITY'] : []);
  const base = { pattern, defs: allDefs, minScore: params.minScore, evaluatedAt: evaluatedAtOf(candles), insufficientData };

  if (fatal.length > 0 || insufficientData) {
    return buildResult({
      ...base,
      conditions: buildConditions(allDefs, gateValues, allThresholds),
      earlyScore: 0,
      invalidationPrice: null,
      riskFlags: flags,
    });
  }

  const features = computeFeatures(candles);
  const { values, structure, liquidity } = measure(candles, params, features);
  if (isFiniteNumber(features.atrPercent) && features.atrPercent > params.maxAtrPercent) flags.add('EXCESSIVE_VOLATILITY');
  if (isFiniteNumber(features.atrExpansion) && features.atrExpansion > params.maxAtrExpansion) flags.add('EXCESSIVE_VOLATILITY');
  if (isFiniteNumber(features.extensionAtr) && features.extensionAtr > params.maxExtensionAtr) flags.add('EXTENDED_PRICE');
  if (!isFiniteNumber(liquidity) || liquidity < params.minAvgQuoteVolume) flags.add('POOR_LIQUIDITY');

  return buildResult({
    ...base,
    conditions: buildConditions(allDefs, { ...gateValues, ...values }, allThresholds),
    earlyScore: computeEarlyScore(structure, features),
    invalidationPrice: computeInvalidation(structure, features, params.invalidationBufferAtr),
    riskFlags: flags,
  });
}
