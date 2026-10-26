// Parameter mesin Reversal Radar (docs/19 §3.1 & §4). Nilai default = hipotesis awal dari literatur (docs/20) yang
// disetel SEKALI pada skenario sintetis set penyetelan (benih 1–20) dan dievaluasi pada benih 21–60 — lihat docs/21
// (minBottomAge 3→5, minEarlyGroups 2, minTriggerAboveBottomAtr 1,5, minBaseBarsForTrigger 8). Belum pernah diuji pada
// data Binance nyata: jalankan scripts/reversal-replay.js dengan data nyata sebelum menganggapnya andal. Konstanta kontrak (id bukti, bobot,
// tahap, dsb.) berada di constants.js dan tidak dapat di-override.
//
// Bentuk: objek datar berisi angka, plus tiga peta kecil per timeframe/tahap (enterConfirmBars,
// expiryBars, minAvgQuoteVolume) → aman disimpan sebagai JSON dan divalidasi ulang.
// resolveReversalParams menolak kunci tak dikenal (TypeError) agar salah ketik konfigurasi tidak diam-diam
// diabaikan, dan nilai di luar rentang (RangeError).
import { REVERSAL_TIMEFRAMES, STAGES } from './constants.js';

const spec = (type, min, max, description) => Object.freeze({ type, min, max, description });

/**
 * Batas atas warm-up `requiredCandles(params)`: pemanggil memuat REVERSAL_LOOKBACK (300) candle; warm-up
 * di atas batas ini membuat evaluasi selamanya INSUFFICIENT_DATA pada awal seri, sehingga ditolak.
 */
export const MAX_REQUIRED_CANDLES = 150;

/** Spesifikasi rentang (inklusif) tiap parameter skalar. */
export const REVERSAL_PARAM_SPECS = Object.freeze({
  // Periode indikator (konstanta metodologi; dapat di-override untuk eksperimen replay).
  emaFast: spec('integer', 2, 50, 'Periode EMA cepat'),
  emaSlow: spec('integer', 5, 100, 'Periode EMA lambat (dasar reclaim & konteks tren)'),
  atrPeriod: spec('integer', 2, 50, 'Periode ATR Wilder'),
  rvolPeriod: spec('integer', 5, 100, 'Baseline RVOL (candle sebelumnya)'),
  rsiPeriod: spec('integer', 2, 50, 'Periode RSI Wilder'),
  slopeLookback: spec('integer', 2, 20, 'Jumlah titik regresi slope EMA'),
  swingLeft: spec('integer', 1, 5, 'Fraktal swing: candle kiri'),
  swingRight: spec('integer', 1, 5, 'Fraktal swing: candle kanan (jeda konfirmasi swing)'),
  volatilityBaseline: spec('integer', 10, 100, 'Jumlah ATR terakhir untuk median pembanding VOLATILITY_EXPANDING'),
  // A. Konteks penurunan awal.
  bottomLookback: spec('integer', 10, 120, 'Jendela pencarian low terendah (dasar)'),
  declineLookback: spec('integer', 10, 150, 'Jendela pencarian close tertinggi sebelum/sampai dasar'),
  minDeclineAtr: spec('number', 0.5, 20, 'Penurunan minimum dari puncak ke dasar (kelipatan ATR dasar)'),
  minDeclinePct: spec('number', 0.005, 0.9, 'Penurunan minimum dari puncak ke dasar (fraksi)'),
  minBottomAge: spec('integer', 1, 30, 'Umur minimum dasar (candle sejak dasar)'),
  minContextBars: spec('integer', 30, 150, 'Candle minimum agar konteks penurunan bermakna (bagian warm-up)'),
  // B. EXHAUSTION.
  llShallowerRatio: spec('number', 0.1, 1, 'LL_SHALLOWER: kedalaman LL terakhir ≤ rasio × kedalaman sebelumnya'),
  llShallowerMaxAtr: spec('number', 0.05, 5, 'LL_SHALLOWER: atau kedalaman LL terakhir ≤ nilai ini (ATR)'),
  llStoppedBars: spec('integer', 1, 60, 'LL_STOPPED: candle minimum tanpa low baru di bawah dasar'),
  bottomHeldDepartAtr: spec('number', 0.1, 10, 'BOTTOM_HELD: close harus sempat menjauh ≥ nilai ini (ATR) sebelum retest'),
  bottomHeldRetestAtr: spec('number', 0.05, 5, 'BOTTOM_HELD: low retest ≤ dasar + nilai ini (ATR)'),
  bottomHeldCloseAtr: spec('number', 0, 5, 'BOTTOM_HELD: close sesudah retest ≥ dasar + nilai ini (ATR)'),
  momentumFadeBars: spec('integer', 3, 30, 'DOWN_MOMENTUM_FADING: panjang jendela candle (dibanding jendela sebelumnya)'),
  momentumFadeRatio: spec('number', 0.1, 1, 'DOWN_MOMENTUM_FADING: rata-rata body merah terbaru ≤ rasio × sebelumnya'),
  momentumFadeRedVolumeShare: spec('number', 0.1, 1, 'DOWN_MOMENTUM_FADING: porsi volume candle merah maksimum'),
  rsiDivergenceMinDiff: spec('number', 0, 50, 'RSI_DIVERGENCE: selisih RSI minimum antara dua swing low (poin)'),
  cvdDivergenceLookback: spec('integer', 5, 100, 'CVD_DIVERGENCE: lookback analyzeOrderFlow'),
  // C. BASE.
  atrContractionLookback: spec('integer', 2, 100, 'ATR_CONTRACTION: ATR dibanding ATR n candle lalu'),
  atrContractionRatio: spec('number', 0.1, 1, 'ATR_CONTRACTION: rasio maksimum'),
  emaConvergenceMaxAtr: spec('number', 0.05, 10, 'EMA_CONVERGENCE: |EMA7 − EMA25| / ATR maksimum'),
  emaConvergenceLookback: spec('integer', 1, 100, 'EMA_CONVERGENCE: harus lebih kecil dari n candle lalu'),
  rangeContractionLookback: spec('integer', 2, 60, 'RANGE_CONTRACTION: panjang jendela (dibanding jendela sebelumnya)'),
  rangeContractionRatio: spec('number', 0.1, 1, 'RANGE_CONTRACTION: rasio maksimum'),
  bowlWindow: spec('integer', 10, 120, 'ROUNDED_BOTTOM: jendela fit kuadrat close'),
  bowlMinR2: spec('number', 0, 1, 'ROUNDED_BOTTOM: R² minimum'),
  bowlVertexMin: spec('number', 0, 1, 'ROUNDED_BOTTOM: posisi vertex minimum (fraksi jendela)'),
  bowlVertexMax: spec('number', 0, 1, 'ROUNDED_BOTTOM: posisi vertex maksimum (fraksi jendela)'),
  bowlRiseAtr: spec('number', 0, 10, 'ROUNDED_BOTTOM: close ≥ nilai kurva di vertex + nilai ini (ATR)'),
  risingFloorLookback: spec('integer', 5, 120, 'RISING_FLOOR: jendela range & swing low'),
  risingFloorMaxRangeAtr: spec('number', 0.5, 20, 'RISING_FLOOR: range jendela maksimum (ATR)'),
  risingFloorMinSwings: spec('integer', 2, 10, 'RISING_FLOOR: swing low minimum untuk regresi'),
  risingFloorMinSlopeAtr: spec('number', 0, 5, 'RISING_FLOOR: slope regresi swing low minimum (ATR/candle)'),
  // D. STRUCTURE.
  springBars: spec('integer', 1, 20, 'SPRING_RECLAIM: candle sapuan paling lama n candle lalu'),
  springMaxRvol: spec('number', 0.1, 10, 'SPRING_RECLAIM: RVOL candle sapuan maksimum'),
  ema25ReclaimLookback: spec('integer', 1, 100, 'EMA25_RECLAIM: ada close ≤ EMA25 dalam n candle sebelumnya'),
  ema7TurnMaxBelowAtr: spec('number', 0, 10, 'EMA7_TURN_UP: EMA7 ≥ EMA25 − nilai ini (ATR)'),
  chochMaxBarsAgo: spec('integer', 0, 100, 'CHOCH_BULLISH: umur maksimum event CHoCH (candle)'),
  staircaseMinSteps: spec('integer', 1, 10, 'STAIRCASE: higher low & higher high berurutan minimum'),
  staircaseMaxStepAtr: spec('number', 0.1, 20, 'STAIRCASE: kenaikan antar swing maksimum (ATR)'),
  // E. VOLUME.
  volumeDryUpRecent: spec('integer', 2, 50, 'VOLUME_DRY_UP: candle terbaru'),
  volumeDryUpBaseline: spec('integer', 5, 150, 'VOLUME_DRY_UP: candle pembanding sebelumnya'),
  volumeDryUpRatio: spec('number', 0.05, 1, 'VOLUME_DRY_UP: rasio maksimum'),
  quietRiseLookback: spec('integer', 2, 60, 'QUIET_RISE: jendela kenaikan & rata-rata RVOL'),
  quietRiseMaxAtr: spec('number', 0.1, 20, 'QUIET_RISE: kenaikan maksimum (ATR)'),
  quietRiseMaxRvol: spec('number', 0.1, 5, 'QUIET_RISE: rata-rata RVOL maksimum'),
  // F. TRIGGER.
  breakRvol: spec('number', 0.5, 10, 'BREAK_VOLUME_SUPPORT: RVOL minimum candle breakout'),
  followThroughAtr: spec('number', 0, 10, 'BREAK_FOLLOW_THROUGH: close ≥ trigger + nilai ini (ATR)'),
  minTriggerAboveBottomAtr: spec('number', 0, 20, 'TRIGGER_BREAK: level pemicu (puncak range sejak dasar) minimal sekian ATR di atas dasar — rally bermakna'),
  minBaseBarsForTrigger: spec('integer', 0, 100, 'TRIGGER_BREAK: umur dasar minimum (candle sejak dasar) agar penembusan dianggap keluar dari base, bukan pantulan V'),
  // Tahap.
  minEarlyEvidence: spec('integer', 1, 10, 'EARLY: bukti EXHAUSTION+BASE+VOLUME minimum'),
  minEarlyGroups: spec('integer', 1, 3, 'EARLY: jumlah grup berbeda di antara EXHAUSTION/BASE/VOLUME minimum (dua bukti segrup saja tidak cukup)'),
  minDevelopingEvidence: spec('integer', 1, 15, 'DEVELOPING: total bukti minimum'),
  minConfirmedEvidence: spec('integer', 0, 15, 'CONFIRMED: bukti non-TRIGGER minimum'),
  // Level & risiko.
  invalidationBufferAtr: spec('number', 0, 5, 'Buffer invalidasi di bawah min(dasar, swing low) (ATR)'),
  failedBreakAtr: spec('number', 0, 5, 'Breakout gagal bila close < trigger − nilai ini (ATR)'),
  lateAtr: spec('number', 0.5, 20, 'LATE_ENTRY: (close − dasar) / ATR minimum'),
  nearInvalidationAtr: spec('number', 0, 5, 'NEAR_INVALIDATION: close − invalidasi ≤ nilai ini (ATR)'),
  volatilityExpandingRatio: spec('number', 1, 10, 'VOLATILITY_EXPANDING: ATR / median ATR baseline minimum'),
  extendedAtr: spec('number', 0.5, 20, 'EXTENDED: moveSinceDetectionAtr minimum'),
  extendedPct: spec('number', 0.005, 1, 'EXTENDED: moveSinceDetectionPct minimum'),
  // Likuiditas.
  minQuoteVolume24h: spec('number', 0, 1e13, 'Ambang LIQUID quoteVolume24h default (bila pemanggil tidak memberi thresholds)'),
  thinLiquidityRatio: spec('number', 0.01, 1, 'THIN bila quoteVolume24h ≥ rasio × ambang LIQUID'),
  maxSpreadBps: spec('number', 0, 10_000, 'LIQUID diturunkan ke THIN bila spread (bps) melebihi nilai ini'),
  avgQuoteVolumeBars: spec('integer', 1, 100, 'Candle untuk rata-rata quote volume (fallback kelas likuiditas)'),
  // State machine.
  weakBarsLimit: spec('integer', 1, 100, 'EXPIRED EVIDENCE_FADED setelah n candle berurutan tanpa tahap'),
  // Konteks HTF.
  htfSlopeThreshold: spec('number', 0, 0.1, 'Zona datar slope EMA25 HTF (fraksi per candle)'),
});

/** Spesifikasi peta per timeframe / per tahap. */
export const REVERSAL_MAP_SPECS = Object.freeze({
  enterConfirmBars: Object.freeze({ keys: REVERSAL_TIMEFRAMES, item: spec('integer', 1, 20, 'Candle tutup berurutan untuk masuk/naik tahap') }),
  expiryBars: Object.freeze({ keys: STAGES, item: spec('integer', 1, 1000, 'Batas candle tanpa kemajuan per tahap') }),
  minAvgQuoteVolume: Object.freeze({ keys: REVERSAL_TIMEFRAMES, item: spec('number', 0, 1e12, 'Rata-rata quote volume per candle minimum (fallback ILLIQUID)') }),
});

export const DEFAULT_REVERSAL_PARAMS = Object.freeze({
  emaFast: 7,
  emaSlow: 25,
  atrPeriod: 14,
  rvolPeriod: 20,
  rsiPeriod: 14,
  slopeLookback: 5,
  swingLeft: 2,
  swingRight: 2,
  volatilityBaseline: 50,

  bottomLookback: 60,
  declineLookback: 120,
  minDeclineAtr: 3,
  minDeclinePct: 0.06,
  minBottomAge: 5,
  minContextBars: 120,

  llShallowerRatio: 0.7,
  llShallowerMaxAtr: 0.5,
  llStoppedBars: 8,
  bottomHeldDepartAtr: 1,
  bottomHeldRetestAtr: 0.5,
  bottomHeldCloseAtr: 0.25,
  momentumFadeBars: 10,
  momentumFadeRatio: 0.7,
  momentumFadeRedVolumeShare: 0.55,
  rsiDivergenceMinDiff: 2,
  cvdDivergenceLookback: 30,

  atrContractionLookback: 20,
  atrContractionRatio: 0.8,
  emaConvergenceMaxAtr: 1,
  emaConvergenceLookback: 10,
  rangeContractionLookback: 20,
  rangeContractionRatio: 0.75,
  bowlWindow: 40,
  bowlMinR2: 0.6,
  bowlVertexMin: 0.15,
  bowlVertexMax: 0.85,
  bowlRiseAtr: 0.3,
  risingFloorLookback: 30,
  risingFloorMaxRangeAtr: 4,
  risingFloorMinSwings: 3,
  risingFloorMinSlopeAtr: 0.05,

  springBars: 3,
  springMaxRvol: 1.5,
  ema25ReclaimLookback: 10,
  ema7TurnMaxBelowAtr: 0.5,
  chochMaxBarsAgo: 10,
  staircaseMinSteps: 2,
  staircaseMaxStepAtr: 2,

  volumeDryUpRecent: 10,
  volumeDryUpBaseline: 30,
  volumeDryUpRatio: 0.7,
  quietRiseLookback: 10,
  quietRiseMaxAtr: 2,
  quietRiseMaxRvol: 1,

  breakRvol: 1.5,
  followThroughAtr: 0.3,
  minTriggerAboveBottomAtr: 1.5,
  minBaseBarsForTrigger: 8,

  minEarlyEvidence: 2,
  minEarlyGroups: 2,
  minDevelopingEvidence: 3,
  minConfirmedEvidence: 2,

  invalidationBufferAtr: 0.25,
  failedBreakAtr: 0.75,
  lateAtr: 4,
  nearInvalidationAtr: 0.5,
  volatilityExpandingRatio: 1.5,
  extendedAtr: 2.5,
  extendedPct: 0.08,

  minQuoteVolume24h: 50_000_000,
  thinLiquidityRatio: 0.25,
  maxSpreadBps: 20,
  avgQuoteVolumeBars: 20,
  minAvgQuoteVolume: Object.freeze({ '5m': 20_000, '15m': 60_000, '1h': 240_000 }),

  enterConfirmBars: Object.freeze({ '5m': 2, '15m': 1, '1h': 1 }),
  expiryBars: Object.freeze({ EARLY_FORMATION: 48, DEVELOPING_REVERSAL: 36, CONFIRMED_BREAKOUT: 24 }),
  weakBarsLimit: 6,

  htfSlopeThreshold: 0.0002,
});

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function checkScalar(path, value, s) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RangeError(`Parameter reversal ${path} harus berupa angka hingga`);
  if (s.type === 'integer' && !Number.isInteger(value)) throw new RangeError(`Parameter reversal ${path} harus bilangan bulat`);
  if (value < s.min || value > s.max) throw new RangeError(`Parameter reversal ${path} harus antara ${s.min} dan ${s.max}`);
}

/**
 * Jumlah candle minimum (warm-up) agar seluruh fitur dapat dihitung pada candle evaluasi: median ATR baseline,
 * EMA lambat + slope, pembanding ATR/range/volume, jendela bowl, lookback divergensi, dan konteks penurunan
 * (minContextBars). Default = 120 (≤ MAX_REQUIRED_CANDLES).
 * @param {object} params parameter lengkap (hasil resolveReversalParams)
 */
export function requiredCandles(params) {
  const p = params;
  return Math.max(
    p.atrPeriod - 1 + p.volatilityBaseline,
    p.emaSlow + p.slopeLookback - 1,
    p.atrPeriod + p.atrContractionLookback,
    p.volumeDryUpRecent + p.volumeDryUpBaseline + 1,
    2 * p.rangeContractionLookback + 1,
    p.bowlWindow + 1,
    p.rvolPeriod + p.quietRiseLookback + 1,
    p.emaSlow + p.emaConvergenceLookback + p.slopeLookback,
    2 * p.momentumFadeBars + 1,
    p.cvdDivergenceLookback + 1,
    p.rsiPeriod + 1,
    p.minContextBars,
  );
}

/**
 * Menggabungkan override parsial dengan default lalu memvalidasi. Kunci tak dikenal (termasuk di dalam
 * peta) → TypeError; nilai di luar rentang / tipe salah → RangeError; warm-up > MAX_REQUIRED_CANDLES →
 * RangeError. `timeframe` opsional: bila diberikan wajib salah satu REVERSAL_TIMEFRAMES (RangeError).
 * Hasil beku (termasuk peta); objek hasil dapat diberikan kembali sebagai `overrides` (idempoten).
 * @param {object} [overrides]
 * @param {'5m'|'15m'|'1h'} [timeframe]
 * @returns {Readonly<typeof DEFAULT_REVERSAL_PARAMS>}
 */
export function resolveReversalParams(overrides = {}, timeframe = undefined) {
  if (overrides === undefined || overrides === null) overrides = {};
  if (!isPlainObject(overrides)) throw new TypeError('Parameter reversal harus objek');
  if (timeframe !== undefined && !REVERSAL_TIMEFRAMES.includes(timeframe)) {
    throw new RangeError(`Timeframe reversal tidak dikenal: ${String(timeframe)}`);
  }
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(DEFAULT_REVERSAL_PARAMS, key)) throw new TypeError(`Parameter reversal tidak dikenal: ${key}`);
  }
  const merged = { ...DEFAULT_REVERSAL_PARAMS, ...overrides };
  for (const [key, s] of Object.entries(REVERSAL_PARAM_SPECS)) checkScalar(`/${key}`, merged[key], s);
  for (const [key, m] of Object.entries(REVERSAL_MAP_SPECS)) {
    const given = overrides[key];
    if (given !== undefined) {
      if (!isPlainObject(given)) throw new TypeError(`Parameter reversal /${key} harus objek`);
      for (const k of Object.keys(given)) {
        if (!m.keys.includes(k)) throw new TypeError(`Parameter reversal /${key}/${k} tidak dikenal`);
      }
    }
    const map = { ...DEFAULT_REVERSAL_PARAMS[key], ...(given ?? {}) };
    for (const k of m.keys) checkScalar(`/${key}/${k}`, map[k], m.item);
    merged[key] = Object.freeze(map);
  }
  if (merged.emaFast >= merged.emaSlow) throw new RangeError('Parameter reversal /emaFast harus lebih kecil dari /emaSlow');
  if (merged.bowlVertexMin >= merged.bowlVertexMax) throw new RangeError('Parameter reversal /bowlVertexMin harus lebih kecil dari /bowlVertexMax');
  if (merged.bottomHeldCloseAtr > merged.bottomHeldDepartAtr) {
    throw new RangeError('Parameter reversal /bottomHeldCloseAtr tidak boleh melebihi /bottomHeldDepartAtr');
  }
  const warmup = requiredCandles(merged);
  if (warmup > MAX_REQUIRED_CANDLES) {
    throw new RangeError(`Parameter reversal: warm-up ${warmup} candle melebihi batas ${MAX_REQUIRED_CANDLES}`);
  }
  return Object.freeze(merged);
}
