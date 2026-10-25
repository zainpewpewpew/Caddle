// State machine sinyal (fungsi murni, deterministik — dipakai bersama worker live dan backtest).
//
// State: NO_PATTERN, QUIET, EARLY_BULLISH, MOMENTUM_BUILDING, BREAKOUT, INVALIDATED, EXPIRED.
//   NO_PATTERN        tidak ada sinyal terbuka (tidak pernah dipersistensi sebagai sinyal)
//   QUIET             pola terdeteksi (classification ≠ NONE), earlyScore < earlyMinScore — pasar masih diam
//   EARLY_BULLISH     pola terdeteksi dengan earlyScore ≥ earlyMinScore
//   MOMENTUM_BUILDING harga bergerak menjauh dari harga deteksi (ATR) atau volume relatif meningkat
//   BREAKOUT          close menembus resistance (swing high terkonfirmasi terakhir) dengan RVOL tinggi
//   INVALIDATED       terminal: close < invalidationPrice
//   EXPIRED           terminal: tidak ada kemajuan (perpindahan state) dalam expiryBars[state] bar
//
// Tabel transisi — hanya untuk candle BARU (candle.openTime > prev.lastCandleTime);
// candle duplikat/lama → { next: prev, event: null, alert: false } (idempoten).
// Kondisi diperiksa berurutan; candle pertama yang cocok menentukan SATU transisi per candle.
//
// | Dari                         | Kondisi                                                                | Ke                | reason                   | alert |
// |------------------------------|------------------------------------------------------------------------|-------------------|--------------------------|-------|
// | null / NO_PATTERN / terminal | classification = NONE                                                  | NO_PATTERN        | (tanpa event)            | –     |
// | idem                         | terdeteksi tetapi close ≤ invalidationPrice pola                       | NO_PATTERN        | (tanpa event)            | –     |
// | idem                         | terdeteksi, earlyScore ≥ earlyMinScore                                 | EARLY_BULLISH     | PATTERN_DETECTED_EARLY   | ya    |
// | idem                         | terdeteksi, earlyScore < earlyMinScore                                 | QUIET             | PATTERN_DETECTED         | tidak |
// | QUIET/EARLY/MOMENTUM/BREAKOUT| close < invalidationPrice                                              | INVALIDATED       | CLOSE_BELOW_INVALIDATION | ya bila dari state alert¹ |
// | QUIET/EARLY/MOMENTUM         | close > max(resistance, firstDetectedPrice) ∧ RVOL ≥ breakoutRvol      | BREAKOUT          | BREAKOUT_CONFIRMED       | ya    |
// | QUIET/EARLY                  | close ≥ firstDetectedPrice + momentumAtrMultiple × ATR                 | MOMENTUM_BUILDING | PRICE_ATR_ADVANCE        | ya    |
// | QUIET/EARLY                  | RVOL ≥ momentumRvol ∧ close > firstDetectedPrice                       | MOMENTUM_BUILDING | RVOL_EXPANSION           | ya    |
// | QUIET                        | classification ≠ NONE ∧ earlyScore ≥ earlyMinScore                     | EARLY_BULLISH     | EARLY_SCORE_THRESHOLD    | ya    |
// | QUIET/EARLY/MOMENTUM/BREAKOUT| barsInState ≥ expiryBars[state]                                        | EXPIRED           | NO_PROGRESS              | tidak |
// | QUIET/EARLY/MOMENTUM/BREAKOUT| selain itu                                                             | (tetap)           | (tanpa event)            | –     |
//
// ¹ INVALIDATED di-alert hanya bila sinyal sudah pernah di-alert (state sebelumnya EARLY_BULLISH,
//   MOMENTUM_BUILDING, atau BREAKOUT) agar pengguna tahu sinyal yang ia terima gagal.
//
// Aturan tambahan:
// - Transisi maju boleh melompat (mis. QUIET → BREAKOUT); tidak ada downgrade, sehingga alert
//   untuk state yang sama tidak pernah berulang dalam satu sinyal.
// - HTF hanya konteks: alignment (termasuk COUNTERTREND) tidak memblokir transisi; COUNTERTREND
//   menambah risk flag COUNTERTREND_HTF.
// - Saat deteksi pertama dicatat firstDetectedAt (closeTime candle), firstDetectedPrice (close),
//   patternKey/patternVersion (pola utama = patternScore tertinggi; seri → SA), invalidationPrice
//   (dari pola utama) dan peakPrice (= close). Setelahnya patternKey/version tetap (sinyal lama
//   selalu mereferensikan versinya); invalidationPrice hanya boleh NAIK — dari pola utama versi
//   yang sama, yang masih terdeteksi, dan masih di bawah close; peakPrice = max(peak, high).
// - classification sinyal = gabungan pola yang pernah terdeteksi selama sinyal hidup (SA + PVA → BOTH).
// - barsInState dihitung dari selisih waktu candle (gap data tetap menghitung waktu berjalan).
// - Setelah terminal, sinyal ditutup; deteksi pada candle berikutnya membuka sinyal BARU
//   (prev terminal diperlakukan seperti null; event fromState 'NO_PATTERN').

import { atr as atrSeries, confirmedAt, findSwings, rvol as rvolSeries } from '../indicators/index.js';
import { ALIGNMENTS, RISK_FLAGS, SIGNAL_STATES, TERMINAL_STATES, TIMEFRAME_MS } from '../market/contracts.js';
import { collectRiskFlags, relevantResults, selectScores } from '../scoring/index.js';
import { ALERT_STATES, PATTERN_STATES, STATE_RANK, resolveMarketParams, resolveSignalParams } from './params.js';

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const optionalNumber = (v) => (isFiniteNumber(v) ? v : null);

function assertInput(input) {
  if (input === null || typeof input !== 'object') throw new TypeError('input transisi harus objek');
  const { candle, context, market } = input;
  if (!candle || typeof candle !== 'object') throw new TypeError('input.candle wajib ada');
  for (const key of ['openTime', 'closeTime', 'close', 'high']) {
    if (!isFiniteNumber(candle[key])) throw new TypeError(`candle.${key} harus angka`);
  }
  if (!(candle.close > 0)) throw new RangeError('candle.close harus > 0');
  if (candle.isClosed !== true) throw new RangeError('Hanya candle tertutup yang boleh dipakai sinyal');
  relevantResults(input.patterns); // validasi klasifikasi & hasil pola
  const alignment = context?.alignment ?? null;
  if (alignment !== null && !ALIGNMENTS.includes(alignment)) throw new RangeError(`Alignment tidak dikenal: ${alignment}`);
  if (market !== undefined && (market === null || typeof market !== 'object')) throw new TypeError('input.market harus objek');
}

function assertSnapshot(prev) {
  if (typeof prev !== 'object') throw new TypeError('Snapshot sebelumnya harus objek atau null');
  if (!SIGNAL_STATES.includes(prev.state)) throw new RangeError(`State tidak dikenal: ${prev.state}`);
  if (!isFiniteNumber(prev.lastCandleTime)) throw new TypeError('snapshot.lastCandleTime harus angka');
  if (PATTERN_STATES.includes(prev.state)) {
    if (!(prev.firstDetectedPrice > 0)) throw new TypeError('snapshot.firstDetectedPrice harus > 0');
    if (!['SA', 'PVA'].includes(prev.patternKey)) throw new TypeError('snapshot.patternKey harus SA atau PVA');
  }
}

/** Skor & risk flag saat ini: dari signal view bila diberikan, bila tidak diturunkan dari pola + konteks. */
function currentView(input) {
  const { view } = input;
  if (view !== undefined && view !== null) {
    for (const key of ['patternScore', 'earlyScore']) {
      if (!isFiniteNumber(view[key]) || view[key] < 0 || view[key] > 100) throw new RangeError(`view.${key} harus 0..100`);
    }
    if (!Array.isArray(view.riskFlags) || view.riskFlags.some((f) => !RISK_FLAGS.includes(f))) {
      throw new RangeError('view.riskFlags harus subset RISK_FLAGS');
    }
    return { patternScore: view.patternScore, earlyScore: view.earlyScore, riskFlags: [...view.riskFlags] };
  }
  const s = selectScores(input.patterns);
  const { flags } = collectRiskFlags({ patterns: input.patterns, timeframe: input.candle.timeframe, context: input.context });
  return { patternScore: s.patternScore, earlyScore: s.earlyScore, riskFlags: flags };
}

const resultOf = (patterns, key) => (key === 'SA' ? patterns.sa : patterns.pva);

function primaryResult(patterns) {
  let primary = null;
  for (const r of relevantResults(patterns)) if (primary === null || r.patternScore > primary.patternScore) primary = r;
  if (!['SA', 'PVA'].includes(primary.pattern)) throw new RangeError(`Kunci pola tidak dikenal: ${primary.pattern}`);
  if (!Number.isInteger(primary.version) || primary.version < 1) throw new RangeError('versi pola harus bilangan bulat ≥ 1');
  return primary;
}

function mergeClassification(prev, current) {
  if (current === 'NONE' || current === prev) return prev;
  return 'BOTH';
}

function barsElapsed(prev, candle) {
  const ms = TIMEFRAME_MS[candle.timeframe];
  if (!ms) return 1;
  return Math.max(1, Math.round((candle.openTime - prev.lastCandleTime) / ms));
}

function idle(prev, input, view) {
  const { candle, context } = input;
  const continuing = prev && prev.state === 'NO_PATTERN';
  return {
    state: 'NO_PATTERN', classification: 'NONE', patternKey: null, patternVersion: null,
    firstDetectedAt: null, firstDetectedPrice: null, invalidationPrice: null,
    patternScore: view.patternScore, earlyScore: view.earlyScore, alignment: context?.alignment ?? null, riskFlags: view.riskFlags,
    lastCandleTime: candle.openTime, lastEvaluatedAt: candle.closeTime,
    barsInState: continuing ? prev.barsInState + barsElapsed(prev, candle) : 0,
    peakPrice: null, peakState: 'NO_PATTERN',
  };
}

function marketDetail(market) {
  return { atr: optionalNumber(market.atr), rvol: optionalNumber(market.rvol), resistance: optionalNumber(market.resistance) };
}

function open(prev, input, p) {
  const { candle, patterns, context } = input;
  const view = currentView(input);
  if (patterns.classification === 'NONE') return { next: idle(prev, input, view), event: null, alert: false };

  const primary = primaryResult(patterns);
  const fallback = relevantResults(patterns).find((r) => r !== primary);
  const invalidationPrice = optionalNumber(primary.invalidationPrice) ?? optionalNumber(fallback?.invalidationPrice) ?? null;
  // Pola yang sudah di bawah level invalidasinya sendiri tidak membuka sinyal.
  if (invalidationPrice !== null && candle.close <= invalidationPrice) return { next: idle(prev, input, view), event: null, alert: false };

  const state = view.earlyScore >= p.earlyMinScore ? 'EARLY_BULLISH' : 'QUIET';
  const next = {
    state, classification: patterns.classification, patternKey: primary.pattern, patternVersion: primary.version,
    firstDetectedAt: candle.closeTime, firstDetectedPrice: candle.close, invalidationPrice,
    patternScore: view.patternScore, earlyScore: view.earlyScore, alignment: context?.alignment ?? null, riskFlags: view.riskFlags,
    lastCandleTime: candle.openTime, lastEvaluatedAt: candle.closeTime, barsInState: 0,
    peakPrice: candle.close, peakState: state,
  };
  const event = {
    fromState: 'NO_PATTERN', toState: state, candleTime: candle.openTime, occurredAt: candle.closeTime, price: candle.close,
    reason: state === 'EARLY_BULLISH' ? 'PATTERN_DETECTED_EARLY' : 'PATTERN_DETECTED',
    detail: { ...marketDetail(input.market ?? {}), patternKey: primary.pattern, patternVersion: primary.version,
      patternScore: view.patternScore, earlyScore: view.earlyScore, invalidationPrice },
  };
  return { next, event, alert: ALERT_STATES.includes(state) };
}

function raisedInvalidation(prev, patterns, close) {
  const r = resultOf(patterns, prev.patternKey);
  if (!r || r.detected !== true || r.version !== prev.patternVersion) return prev.invalidationPrice;
  const candidate = optionalNumber(r.invalidationPrice);
  if (candidate === null || candidate >= close) return prev.invalidationPrice;
  return prev.invalidationPrice === null || candidate > prev.invalidationPrice ? candidate : prev.invalidationPrice;
}

function nextState(prev, input, view, barsInState, p) {
  const { candle, patterns } = input;
  const market = input.market ?? {};
  const close = candle.close;
  const rank = STATE_RANK[prev.state];
  const atr = optionalNumber(market.atr);
  const rvol = optionalNumber(market.rvol);
  const resistance = optionalNumber(market.resistance);

  if (prev.invalidationPrice !== null && close < prev.invalidationPrice) return ['INVALIDATED', 'CLOSE_BELOW_INVALIDATION'];
  if (rank < STATE_RANK.BREAKOUT && resistance !== null && rvol !== null && rvol >= p.breakoutRvol
    && close > Math.max(resistance, prev.firstDetectedPrice)) return ['BREAKOUT', 'BREAKOUT_CONFIRMED'];
  if (rank < STATE_RANK.MOMENTUM_BUILDING) {
    if (atr !== null && atr > 0 && close >= prev.firstDetectedPrice + p.momentumAtrMultiple * atr) return ['MOMENTUM_BUILDING', 'PRICE_ATR_ADVANCE'];
    if (rvol !== null && rvol >= p.momentumRvol && close > prev.firstDetectedPrice) return ['MOMENTUM_BUILDING', 'RVOL_EXPANSION'];
  }
  if (prev.state === 'QUIET' && patterns.classification !== 'NONE' && view.earlyScore >= p.earlyMinScore) {
    return ['EARLY_BULLISH', 'EARLY_SCORE_THRESHOLD'];
  }
  if (barsInState >= p.expiryBars[prev.state]) return ['EXPIRED', 'NO_PROGRESS'];
  return [null, null];
}

function advance(prev, input, p) {
  const { candle, patterns, context } = input;
  const view = currentView(input);
  const barsInState = prev.barsInState + barsElapsed(prev, candle);
  const updated = {
    ...prev,
    classification: mergeClassification(prev.classification, patterns.classification),
    patternScore: view.patternScore, earlyScore: view.earlyScore,
    alignment: context?.alignment ?? null, riskFlags: view.riskFlags,
    lastCandleTime: candle.openTime, lastEvaluatedAt: candle.closeTime,
    barsInState,
    peakPrice: Math.max(prev.peakPrice ?? candle.close, candle.high),
  };

  const [toState, reason] = nextState(prev, input, view, barsInState, p);
  if (toState === null) {
    return { next: { ...updated, invalidationPrice: raisedInvalidation(prev, patterns, candle.close) }, event: null, alert: false };
  }

  const terminal = TERMINAL_STATES.includes(toState);
  const next = {
    ...updated,
    state: toState,
    barsInState: 0,
    invalidationPrice: terminal ? prev.invalidationPrice : raisedInvalidation(prev, patterns, candle.close),
    peakState: !terminal && STATE_RANK[toState] > STATE_RANK[prev.peakState ?? prev.state] ? toState : (prev.peakState ?? prev.state),
  };
  const event = {
    fromState: prev.state, toState, candleTime: candle.openTime, occurredAt: candle.closeTime, price: candle.close, reason,
    detail: { ...marketDetail(input.market ?? {}), invalidationPrice: prev.invalidationPrice, firstDetectedPrice: prev.firstDetectedPrice,
      barsInPrevState: barsInState, patternScore: view.patternScore, earlyScore: view.earlyScore },
  };
  const alert = ALERT_STATES.includes(toState) || (toState === 'INVALIDATED' && ALERT_STATES.includes(prev.state));
  return { next, event, alert };
}

/**
 * Satu langkah state machine untuk satu candle tertutup.
 * @param {object|null} prev SignalSnapshot sebelumnya (null bila belum ada)
 * @param {{ candle: import('../market/contracts.js').Candle,
 *   patterns: { classification: 'SA'|'PVA'|'BOTH'|'NONE', sa: object|null, pva: object|null },
 *   context?: { alignment: string|null },
 *   market?: { atr?: number|null, rvol?: number|null, resistance?: number|null },
 *   view?: { patternScore: number, earlyScore: number, riskFlags: string[] } }} input
 * @param {object} [params] override DEFAULT_SIGNAL_PARAMS
 * @returns {{ next: object, event: object|null, alert: boolean }}
 */
export function transition(prev, input, params = {}) {
  const p = resolveSignalParams(params);
  assertInput(input);
  if (prev !== null && prev !== undefined) assertSnapshot(prev);
  const hasPrev = prev !== null && prev !== undefined;
  if (hasPrev && input.candle.openTime <= prev.lastCandleTime) return { next: prev, event: null, alert: false };
  if (hasPrev && PATTERN_STATES.includes(prev.state)) return advance(prev, input, p);
  return open(hasPrev ? prev : null, input, p);
}

/** true bila state menutup sinyal. */
export function isTerminal(state) {
  return TERMINAL_STATES.includes(state);
}

/**
 * Menurunkan input pasar untuk transisi dari candle dasar tertutup (urut naik), dievaluasi
 * di candle terakhir: ATR, RVOL (volume base, baseline candle sebelumnya), dan swing high
 * terkonfirmasi terakhir sebagai resistance (confirmedIndex ≤ indeks evaluasi — tanpa lookahead).
 * @returns {{ atr: number|null, rvol: number|null, resistance: number|null }}
 */
export function deriveMarketInputs(candles, params = {}) {
  const p = resolveMarketParams(params);
  if (!Array.isArray(candles)) throw new TypeError('candles harus array');
  if (candles.length === 0) return { atr: null, rvol: null, resistance: null };
  const last = candles.length - 1;
  const atr = atrSeries(candles, p.atrPeriod)[last];
  const rvol = rvolSeries(candles.map((c) => c.volume), p.rvolPeriod)[last];
  const { highs } = confirmedAt(findSwings(candles, { left: p.swingLeft, right: p.swingRight }), last);
  return { atr: atr ?? null, rvol: rvol ?? null, resistance: highs.length ? highs[highs.length - 1].price : null };
}
