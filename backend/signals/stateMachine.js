// State machine sinyal (fungsi murni, deterministik — dipakai bersama worker live dan backtest).
// Dua arah: LONG (pola SA/PVA, tabel di bawah) dan SHORT (pola SD/PVD, cermin — lihat bagian
// "Arah SHORT" di akhir komentar ini). Arah diambil dari input.direction / patterns.direction
// (tanpa keduanya = LONG); snapshot membawa field `direction`.
//
// State LONG: NO_PATTERN, QUIET, EARLY_BULLISH, MOMENTUM_BUILDING, BREAKOUT, INVALIDATED, EXPIRED.
//   NO_PATTERN        tidak ada sinyal terbuka (tidak pernah dipersistensi sebagai sinyal)
//   QUIET             pola terdeteksi (classification ≠ NONE), earlyScore < earlyMinScore — pasar masih diam
//   EARLY_BULLISH     pola terdeteksi dengan earlyScore ≥ earlyMinScore
//   MOMENTUM_BUILDING harga bergerak menjauh dari harga deteksi (ATR) atau volume relatif meningkat
//   BREAKOUT          close menembus resistance (swing high terkonfirmasi terakhir) dengan RVOL tinggi
//   INVALIDATED       terminal: close < invalidationPrice
//   EXPIRED           terminal: tidak ada kemajuan (perpindahan state) dalam expiryBars[state] bar,
//                     atau simbol berhenti dipantau (lihat baris terakhir tabel; di luar fungsi ini)
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
// | QUIET/EARLY/MOMENTUM/BREAKOUT| barsInState − 1 ≥ expiryBars[state] (batas expiry terlewati di dalam   | EXPIRED           | NO_PROGRESS³             | tidak |
// |                              | gap data, SEBELUM candle ini) — diperiksa sebelum semua baris di bawah |                   |                          |       |
// | QUIET/EARLY/MOMENTUM/BREAKOUT| close < invalidationPrice                                              | INVALIDATED       | CLOSE_BELOW_INVALIDATION | ya bila dari state alert¹ |
// | QUIET/EARLY/MOMENTUM         | close > max(resistance, firstDetectedPrice) ∧ RVOL ≥ breakoutRvol      | BREAKOUT          | BREAKOUT_CONFIRMED       | ya    |
// | QUIET/EARLY                  | close ≥ firstDetectedPrice + momentumAtrMultiple × ATR                 | MOMENTUM_BUILDING | PRICE_ATR_ADVANCE        | ya    |
// | QUIET/EARLY                  | RVOL ≥ momentumRvol ∧ close > firstDetectedPrice                       | MOMENTUM_BUILDING | RVOL_EXPANSION           | ya    |
// | QUIET                        | classification ≠ NONE ∧ earlyScore ≥ earlyMinScore                     | EARLY_BULLISH     | EARLY_SCORE_THRESHOLD    | ya    |
// | QUIET/EARLY/MOMENTUM/BREAKOUT| barsInState ≥ expiryBars[state]                                        | EXPIRED           | NO_PROGRESS              | tidak |
// | QUIET/EARLY/MOMENTUM/BREAKOUT| selain itu                                                             | (tetap)           | (tanpa event)            | –     |
// | QUIET/EARLY/MOMENTUM/BREAKOUT| simbol delisted / berhenti dipantau scanner² (bukan candle)            | EXPIRED           | SYMBOL_DELISTED / MONITORING_STOPPED | tidak |
//
// ¹ INVALIDATED di-alert hanya bila sinyal sudah pernah di-alert (state sebelumnya EARLY_BULLISH,
//   MOMENTUM_BUILDING, atau BREAKOUT) agar pengguna tahu sinyal yang ia terima gagal.
// ² Bukan bagian transition(): simbol yang tidak lagi dipantau tidak menerima candle, sehingga sinyalnya
//   ditutup oleh signalRepository.closeOpenForSymbol (dipicu scanner → pipeline.closeSymbol). Event-nya
//   memakai candleTime = candle terakhir yang dievaluasi, occurredAt = waktu penutupan, price = close
//   candle tersimpan terakhir (null bila tidak ada); reason di MONITORING_STOP_REASONS (params.js).
// ³ Setelah gap data panjang (outage, celah yang tidak terisi, backtest dengan lubang) sinyal yang sudah
//   jatuh tempo sebelum candle pasca-gap ditutup EXPIRED, bukan dipromosikan/di-alert berdasarkan
//   firstDetectedPrice yang sudah basi. Tanpa gap (selisih 1 bar) barsInState − 1 = barsInState
//   sebelumnya < expiryBars, sehingga baris ini tidak pernah cocok. Setiap event transisi pada candle
//   pasca-gap memuat detail.gapBars (jumlah candle yang hilang).
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
// - barsInState dihitung dari selisih waktu candle (gap data tetap menghitung waktu berjalan); sinyal
//   yang jatuh tempo di dalam gap kedaluwarsa lebih dulu (lihat ³).
// - Setelah terminal, sinyal ditutup; deteksi pada candle berikutnya membuka sinyal BARU
//   (prev terminal diperlakukan seperti null; event fromState 'NO_PATTERN').
//
// Arah SHORT (cermin LONG; parameter, urutan pemeriksaan, expiry, dan aturan gap sama):
//
// | Dari                           | Kondisi                                                        | Ke                    | reason                   |
// |--------------------------------|----------------------------------------------------------------|-----------------------|--------------------------|
// | null / NO_PATTERN / terminal   | terdeteksi tetapi close ≥ invalidationPrice pola               | NO_PATTERN            | (tanpa event)            |
// | idem                           | terdeteksi, earlyScore ≥ earlyMinScore                         | EARLY_BEARISH         | PATTERN_DETECTED_EARLY   |
// | idem                           | terdeteksi, earlyScore < earlyMinScore                         | QUIET                 | PATTERN_DETECTED         |
// | QUIET/EARLY/MOMENTUM/BREAKDOWN | close > invalidationPrice                                      | INVALIDATED           | CLOSE_ABOVE_INVALIDATION |
// | QUIET/EARLY/MOMENTUM           | close < min(support, firstDetectedPrice) ∧ RVOL ≥ breakoutRvol | BREAKDOWN             | BREAKDOWN_CONFIRMED      |
// | QUIET/EARLY                    | close ≤ firstDetectedPrice − momentumAtrMultiple × ATR         | MOMENTUM_BUILDING     | PRICE_ATR_DECLINE        |
// | QUIET/EARLY                    | RVOL ≥ momentumRvol ∧ close < firstDetectedPrice               | MOMENTUM_BUILDING     | RVOL_EXPANSION           |
// | QUIET                          | classification ≠ NONE ∧ earlyScore ≥ earlyMinScore             | EARLY_BEARISH         | EARLY_SCORE_THRESHOLD    |
// Baris EXPIRED (NO_PROGRESS, termasuk jatuh tempo di dalam gap) dan penutupan simbol berhenti dipantau
// sama dengan LONG.
//
// - support = swing low terkonfirmasi terakhir (deriveDirectionalMarketInputs → market.support).
// - Alert untuk EARLY_BEARISH, MOMENTUM_BUILDING, BREAKDOWN; INVALIDATED di-alert bila dari state alert SHORT.
// - invalidationPrice SHORT berada DI ATAS harga dan hanya boleh TURUN (dari pola utama versi sama yang
//   masih terdeteksi dan masih di atas close); peakPrice = harga TERENDAH (min(peak, low)), yaitu
//   ekskursi searah SHORT. Semua harga yang disimpan adalah harga nyata (bukan harga cermin).

import { atr as atrSeries, confirmedAt, findSwings, rvol as rvolSeries } from '../indicators/index.js';
import {
  ALIGNMENTS, PATTERN_KEYS_BY_DIRECTION, RISK_FLAGS, SIGNAL_STATES, TERMINAL_STATES, TIMEFRAME_MS, resolveDirection,
} from '../market/contracts.js';
import { collectRiskFlags, directionOf, relevantResults, selectScores } from '../scoring/index.js';
import {
  ALERT_STATES_BY_DIRECTION, PATTERN_STATES, PATTERN_STATES_BY_DIRECTION, STATE_RANK, resolveMarketParams, resolveSignalParams,
} from './params.js';

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const optionalNumber = (v) => (isFiniteNumber(v) ? v : null);

/** State "awal" per arah (dibuka dengan earlyScore ≥ earlyMinScore). */
const EARLY_STATE = Object.freeze({ LONG: 'EARLY_BULLISH', SHORT: 'EARLY_BEARISH' });

/** Arah input: input.direction (bila ada) wajib sama dengan arah pola; tanpa keduanya = LONG. */
function inputDirection(input) {
  const fromPatterns = directionOf(input.patterns);
  if (input.direction === undefined || input.direction === null) return fromPatterns;
  const direction = resolveDirection(input.direction);
  if (direction !== fromPatterns) throw new RangeError(`input.direction ${direction} tidak sama dengan arah pola ${fromPatterns}`);
  return direction;
}

/** Validasi input transisi; mengembalikan arahnya. */
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
  const direction = inputDirection(input);
  // SHORT melacak harga terendah (peakPrice) sehingga butuh candle.low.
  if (direction === 'SHORT' && !isFiniteNumber(candle.low)) throw new TypeError('candle.low harus angka');
  const alignment = context?.alignment ?? null;
  if (alignment !== null && !ALIGNMENTS.includes(alignment)) throw new RangeError(`Alignment tidak dikenal: ${alignment}`);
  if (market !== undefined && (market === null || typeof market !== 'object')) throw new TypeError('input.market harus objek');
  return direction;
}

/** Validasi snapshot sebelumnya; mengembalikan arahnya (tanpa field `direction` = LONG). */
function assertSnapshot(prev) {
  if (typeof prev !== 'object') throw new TypeError('Snapshot sebelumnya harus objek atau null');
  if (!SIGNAL_STATES.includes(prev.state)) throw new RangeError(`State tidak dikenal: ${prev.state}`);
  if (!isFiniteNumber(prev.lastCandleTime)) throw new TypeError('snapshot.lastCandleTime harus angka');
  const direction = resolveDirection(prev.direction);
  if (PATTERN_STATES.includes(prev.state)) {
    if (!(prev.firstDetectedPrice > 0)) throw new TypeError('snapshot.firstDetectedPrice harus > 0');
    const keys = PATTERN_KEYS_BY_DIRECTION[direction];
    if (!keys.includes(prev.patternKey)) throw new TypeError(`snapshot.patternKey harus ${keys.join(' atau ')}`);
    if (!PATTERN_STATES_BY_DIRECTION[direction].includes(prev.state)) {
      throw new RangeError(`State ${prev.state} tidak berlaku untuk arah ${direction}`);
    }
  }
  return direction;
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

const RESULT_FIELD = Object.freeze({ SA: 'sa', PVA: 'pva', SD: 'sd', PVD: 'pvd' });
const resultOf = (patterns, key) => (Object.hasOwn(RESULT_FIELD, key) ? patterns[RESULT_FIELD[key]] : undefined);

function primaryResult(patterns, direction) {
  let primary = null;
  for (const r of relevantResults(patterns)) if (primary === null || r.patternScore > primary.patternScore) primary = r;
  if (!PATTERN_KEYS_BY_DIRECTION[direction].includes(primary.pattern)) throw new RangeError(`Kunci pola tidak dikenal: ${primary.pattern}`);
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

function idle(prev, input, view, direction) {
  const { candle, context } = input;
  const continuing = prev && prev.state === 'NO_PATTERN';
  return {
    direction,
    state: 'NO_PATTERN', classification: 'NONE', patternKey: null, patternVersion: null,
    firstDetectedAt: null, firstDetectedPrice: null, invalidationPrice: null,
    patternScore: view.patternScore, earlyScore: view.earlyScore, alignment: context?.alignment ?? null, riskFlags: view.riskFlags,
    lastCandleTime: candle.openTime, lastEvaluatedAt: candle.closeTime,
    barsInState: continuing ? prev.barsInState + barsElapsed(prev, candle) : 0,
    peakPrice: null, peakState: 'NO_PATTERN',
  };
}

/** Detail pasar event: LONG { atr, rvol, resistance } (tidak berubah), SHORT { atr, rvol, support }. */
function marketDetail(market, direction) {
  if (direction === 'SHORT') return { atr: optionalNumber(market.atr), rvol: optionalNumber(market.rvol), support: optionalNumber(market.support) };
  return { atr: optionalNumber(market.atr), rvol: optionalNumber(market.rvol), resistance: optionalNumber(market.resistance) };
}

/** Close sudah melewati level invalidasi pola (LONG: di bawah/sama, SHORT: di atas/sama) → tidak membuka sinyal. */
function beyondPatternInvalidation(close, invalidationPrice, direction) {
  if (invalidationPrice === null) return false;
  return direction === 'SHORT' ? close >= invalidationPrice : close <= invalidationPrice;
}

function open(prev, input, p, direction) {
  const { candle, patterns, context } = input;
  const view = currentView(input);
  if (patterns.classification === 'NONE') return { next: idle(prev, input, view, direction), event: null, alert: false };

  const primary = primaryResult(patterns, direction);
  const fallback = relevantResults(patterns).find((r) => r !== primary);
  const invalidationPrice = optionalNumber(primary.invalidationPrice) ?? optionalNumber(fallback?.invalidationPrice) ?? null;
  // Pola yang sudah melewati level invalidasinya sendiri tidak membuka sinyal.
  if (beyondPatternInvalidation(candle.close, invalidationPrice, direction)) {
    return { next: idle(prev, input, view, direction), event: null, alert: false };
  }

  const state = view.earlyScore >= p.earlyMinScore ? EARLY_STATE[direction] : 'QUIET';
  const next = {
    direction,
    state, classification: patterns.classification, patternKey: primary.pattern, patternVersion: primary.version,
    firstDetectedAt: candle.closeTime, firstDetectedPrice: candle.close, invalidationPrice,
    patternScore: view.patternScore, earlyScore: view.earlyScore, alignment: context?.alignment ?? null, riskFlags: view.riskFlags,
    lastCandleTime: candle.openTime, lastEvaluatedAt: candle.closeTime, barsInState: 0,
    peakPrice: candle.close, peakState: state,
  };
  const event = {
    fromState: 'NO_PATTERN', toState: state, candleTime: candle.openTime, occurredAt: candle.closeTime, price: candle.close,
    reason: state === 'QUIET' ? 'PATTERN_DETECTED' : 'PATTERN_DETECTED_EARLY',
    detail: { ...marketDetail(input.market ?? {}, direction), patternKey: primary.pattern, patternVersion: primary.version,
      patternScore: view.patternScore, earlyScore: view.earlyScore, invalidationPrice },
  };
  return { next, event, alert: ALERT_STATES_BY_DIRECTION[direction].includes(state) };
}

/** LONG: level invalidasi (di bawah harga) hanya boleh NAIK dan tetap di bawah close. */
function raisedInvalidation(prev, patterns, close) {
  const r = resultOf(patterns, prev.patternKey);
  if (!r || r.detected !== true || r.version !== prev.patternVersion) return prev.invalidationPrice;
  const candidate = optionalNumber(r.invalidationPrice);
  if (candidate === null || candidate >= close) return prev.invalidationPrice;
  return prev.invalidationPrice === null || candidate > prev.invalidationPrice ? candidate : prev.invalidationPrice;
}

/** SHORT: level invalidasi (di atas harga) hanya boleh TURUN dan tetap di atas close. */
function loweredInvalidation(prev, patterns, close) {
  const r = resultOf(patterns, prev.patternKey);
  if (!r || r.detected !== true || r.version !== prev.patternVersion) return prev.invalidationPrice;
  const candidate = optionalNumber(r.invalidationPrice);
  if (candidate === null || candidate <= close) return prev.invalidationPrice;
  return prev.invalidationPrice === null || candidate < prev.invalidationPrice ? candidate : prev.invalidationPrice;
}

function tightenedInvalidation(prev, patterns, close, direction) {
  return direction === 'SHORT' ? loweredInvalidation(prev, patterns, close) : raisedInvalidation(prev, patterns, close);
}

function nextStateLong(prev, input, view, barsInState, p) {
  const { candle, patterns } = input;
  const market = input.market ?? {};
  const close = candle.close;
  const rank = STATE_RANK[prev.state];
  const atr = optionalNumber(market.atr);
  const rvol = optionalNumber(market.rvol);
  const resistance = optionalNumber(market.resistance);

  // Jatuh tempo sebelum candle ini (di dalam gap): kedaluwarsa dulu, tanpa promosi/alert dari harga basi.
  if (barsInState - 1 >= p.expiryBars[prev.state]) return ['EXPIRED', 'NO_PROGRESS'];
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

/** Cermin nextStateLong untuk SHORT (urutan pemeriksaan identik; lihat tabel "Arah SHORT"). */
function nextStateShort(prev, input, view, barsInState, p) {
  const { candle, patterns } = input;
  const market = input.market ?? {};
  const close = candle.close;
  const rank = STATE_RANK[prev.state];
  const atr = optionalNumber(market.atr);
  const rvol = optionalNumber(market.rvol);
  const support = optionalNumber(market.support);

  if (barsInState - 1 >= p.expiryBars[prev.state]) return ['EXPIRED', 'NO_PROGRESS'];
  if (prev.invalidationPrice !== null && close > prev.invalidationPrice) return ['INVALIDATED', 'CLOSE_ABOVE_INVALIDATION'];
  if (rank < STATE_RANK.BREAKDOWN && support !== null && rvol !== null && rvol >= p.breakoutRvol
    && close < Math.min(support, prev.firstDetectedPrice)) return ['BREAKDOWN', 'BREAKDOWN_CONFIRMED'];
  if (rank < STATE_RANK.MOMENTUM_BUILDING) {
    if (atr !== null && atr > 0 && close <= prev.firstDetectedPrice - p.momentumAtrMultiple * atr) return ['MOMENTUM_BUILDING', 'PRICE_ATR_DECLINE'];
    if (rvol !== null && rvol >= p.momentumRvol && close < prev.firstDetectedPrice) return ['MOMENTUM_BUILDING', 'RVOL_EXPANSION'];
  }
  if (prev.state === 'QUIET' && patterns.classification !== 'NONE' && view.earlyScore >= p.earlyMinScore) {
    return ['EARLY_BEARISH', 'EARLY_SCORE_THRESHOLD'];
  }
  if (barsInState >= p.expiryBars[prev.state]) return ['EXPIRED', 'NO_PROGRESS'];
  return [null, null];
}

function advance(prev, input, p, direction) {
  const { candle, patterns, context } = input;
  const view = currentView(input);
  const elapsed = barsElapsed(prev, candle);
  const barsInState = prev.barsInState + elapsed;
  const updated = {
    ...prev,
    direction,
    classification: mergeClassification(prev.classification, patterns.classification),
    patternScore: view.patternScore, earlyScore: view.earlyScore,
    alignment: context?.alignment ?? null, riskFlags: view.riskFlags,
    lastCandleTime: candle.openTime, lastEvaluatedAt: candle.closeTime,
    barsInState,
    // Ekskursi searah sinyal: LONG harga tertinggi, SHORT harga terendah.
    peakPrice: direction === 'SHORT'
      ? Math.min(prev.peakPrice ?? candle.close, candle.low)
      : Math.max(prev.peakPrice ?? candle.close, candle.high),
  };

  const [toState, reason] = direction === 'SHORT'
    ? nextStateShort(prev, input, view, barsInState, p)
    : nextStateLong(prev, input, view, barsInState, p);
  if (toState === null) {
    return { next: { ...updated, invalidationPrice: tightenedInvalidation(prev, patterns, candle.close, direction) }, event: null, alert: false };
  }

  const terminal = TERMINAL_STATES.includes(toState);
  const next = {
    ...updated,
    state: toState,
    barsInState: 0,
    invalidationPrice: terminal ? prev.invalidationPrice : tightenedInvalidation(prev, patterns, candle.close, direction),
    peakState: !terminal && STATE_RANK[toState] > STATE_RANK[prev.peakState ?? prev.state] ? toState : (prev.peakState ?? prev.state),
  };
  const event = {
    fromState: prev.state, toState, candleTime: candle.openTime, occurredAt: candle.closeTime, price: candle.close, reason,
    detail: { ...marketDetail(input.market ?? {}, direction), invalidationPrice: prev.invalidationPrice, firstDetectedPrice: prev.firstDetectedPrice,
      barsInPrevState: barsInState, patternScore: view.patternScore, earlyScore: view.earlyScore,
      ...(elapsed > 1 ? { gapBars: elapsed - 1 } : {}) },
  };
  const alertStates = ALERT_STATES_BY_DIRECTION[direction];
  const alert = alertStates.includes(toState) || (toState === 'INVALIDATED' && alertStates.includes(prev.state));
  return { next, event, alert };
}

/**
 * Satu langkah state machine untuk satu candle tertutup.
 * @param {object|null} prev SignalSnapshot sebelumnya (null bila belum ada); arahnya wajib sama dengan arah input
 * @param {{ candle: import('../market/contracts.js').Candle,
 *   patterns: { classification: 'SA'|'PVA'|'BOTH'|'NONE', sa: object|null, pva: object|null }
 *     | { direction: 'SHORT', classification: 'SD'|'PVD'|'BOTH'|'NONE', sd: object|null, pvd: object|null },
 *   direction?: 'LONG'|'SHORT',
 *   context?: { alignment: string|null },
 *   market?: { atr?: number|null, rvol?: number|null, resistance?: number|null, support?: number|null },
 *   view?: { patternScore: number, earlyScore: number, riskFlags: string[] } }} input
 *   direction: default arah `patterns` (tanpa keduanya = LONG). SHORT memakai market.support & candle.low.
 * @param {object} [params] override DEFAULT_SIGNAL_PARAMS
 * @returns {{ next: object, event: object|null, alert: boolean }} next.direction = arah sinyal
 */
export function transition(prev, input, params = {}) {
  const p = resolveSignalParams(params);
  const direction = assertInput(input);
  const hasPrev = prev !== null && prev !== undefined;
  if (hasPrev) {
    const prevDirection = assertSnapshot(prev);
    if (prevDirection !== direction) throw new RangeError(`Arah snapshot (${prevDirection}) tidak sama dengan arah input (${direction})`);
  }
  if (hasPrev && input.candle.openTime <= prev.lastCandleTime) return { next: prev, event: null, alert: false };
  if (hasPrev && PATTERN_STATES.includes(prev.state)) return advance(prev, input, p, direction);
  return open(hasPrev ? prev : null, input, p, direction);
}

/** true bila state menutup sinyal. */
export function isTerminal(state) {
  return TERMINAL_STATES.includes(state);
}

/** ATR, RVOL, dan swing terkonfirmasi terakhir pada candle terakhir (dihitung sekali untuk kedua arah). */
function marketFeatures(candles, params) {
  const p = resolveMarketParams(params);
  if (!Array.isArray(candles)) throw new TypeError('candles harus array');
  if (candles.length === 0) return null;
  const last = candles.length - 1;
  const atr = atrSeries(candles, p.atrPeriod)[last];
  const rvol = rvolSeries(candles.map((c) => c.volume), p.rvolPeriod)[last];
  const { highs, lows } = confirmedAt(findSwings(candles, { left: p.swingLeft, right: p.swingRight }), last);
  return {
    atr: atr ?? null,
    rvol: rvol ?? null,
    resistance: highs.length ? highs[highs.length - 1].price : null,
    support: lows.length ? lows[lows.length - 1].price : null,
  };
}

/**
 * Menurunkan input pasar untuk transisi dari candle dasar tertutup (urut naik), dievaluasi
 * di candle terakhir: ATR, RVOL (volume base, baseline candle sebelumnya), dan swing high
 * terkonfirmasi terakhir sebagai resistance (confirmedIndex ≤ indeks evaluasi — tanpa lookahead).
 * Untuk arah LONG; deriveDirectionalMarketInputs memberi kedua arah dari satu perhitungan.
 * @returns {{ atr: number|null, rvol: number|null, resistance: number|null }}
 */
export function deriveMarketInputs(candles, params = {}) {
  const f = marketFeatures(candles, params);
  if (f === null) return { atr: null, rvol: null, resistance: null };
  return { atr: f.atr, rvol: f.rvol, resistance: f.resistance };
}

/**
 * Input pasar kedua arah dari satu perhitungan indikator: LONG { atr, rvol, resistance } (identik dengan
 * deriveMarketInputs) dan SHORT { atr, rvol, support } — support = swing low terkonfirmasi terakhir
 * (confirmedIndex ≤ indeks evaluasi — tanpa lookahead).
 * @returns {{ LONG: { atr: number|null, rvol: number|null, resistance: number|null },
 *   SHORT: { atr: number|null, rvol: number|null, support: number|null } }}
 */
export function deriveDirectionalMarketInputs(candles, params = {}) {
  const f = marketFeatures(candles, params) ?? { atr: null, rvol: null, resistance: null, support: null };
  return {
    LONG: { atr: f.atr, rvol: f.rvol, resistance: f.resistance },
    SHORT: { atr: f.atr, rvol: f.rvol, support: f.support },
  };
}
