// State machine kandidat Reversal Radar — `transitionReversal(prev, { candle, evaluation, timeframe }, params)`
// → { next, events, alert } (docs/19 §4). Fungsi murni & deterministik: dipakai pipeline live dan replay.
//
// Tahap: EARLY_FORMATION → DEVELOPING_REVERSAL → CONFIRMED_BREAKOUT (hanya maju, boleh melompat; tidak ada
// downgrade). Status mengikuti tahap (NEW/DEVELOPING/CONFIRMED); CANCELLED & EXPIRED terminal — kandidat
// berikutnya adalah baris baru (snapshot terminal diperlakukan seperti null pada candle berikutnya).
//
// Urutan pemeriksaan per candle BARU (candle.openTime > prev.lastCandleTime; candle lama/duplikat → next = prev,
// tanpa event — idempoten):
// 1. Tanpa kandidat terbuka (prev null / status NONE / terminal): evaluation.stage ≠ null dan close > invalidasi →
//    pendingBars bertambah (candle berurutan dengan tahap apa pun; gap data mengulang hitungan). Saat pendingBars ≥
//    enterConfirmBars[timeframe] (5m 2, 15m 1, 1h 1) kandidat DIBUKA pada tahap evaluasi saat itu: event OPENED
//    (reason STAGE_EVIDENCE), alert. Snapshot tanpa kandidat = { stage: null, status: 'NONE', pending… }.
// 2. Kandidat terbuka — kedaluwarsa di dalam gap data (barsInStage − 1 ≥ expiryBars[stage]) → EXPIRED NO_PROGRESS
//    lebih dulu (tanpa promosi dari konteks basi; sama seperti signals/stateMachine).
// 3. close < snapshot.levels.invalidation → CANCELLED (reason CLOSE_BELOW_INVALIDATION; untuk CONFIRMED
//    BREAKOUT_FAILED bila close < trigger − failedBreakAtr × ATR). Wick tidak membatalkan. Alert bila tahap
//    sebelumnya ≥ DEVELOPING.
// 4. STAGE_RANK[evaluation.stage] > STAGE_RANK[stage] selama enterConfirmBars candle berurutan → STAGE_UP ke tahap
//    evaluasi terakhir, barsInStage = 0, alert. Saat masuk CONFIRMED level pemicu DIBEKUKAN (= level yang ditembus)
//    dan invalidasi dinaikkan ke trigger − failedBreakAtr × ATR bila lebih tinggi.
// 5. barsInStage ≥ expiryBars[stage] → EXPIRED NO_PROGRESS; weakBars (candle berurutan dengan evaluation.stage ===
//    null — mencakup evaluasi yang bukan kandidat/DATA_QUALITY) ≥ weakBarsLimit → EXPIRED EVIDENCE_FADED. Tanpa alert.
// 6. Selain itu snapshot diperbarui tanpa event: skor, bukti, level (invalidasi hanya boleh NAIK — dari
//    measures.invalidationBase evaluasi, yaitu invalidasi tanpa lantai breakout, agar tidak ikut mengejar high baru
//    setelah breakout; trigger boleh berubah kecuali sudah CONFIRMED), peakPrice = max(peak, high),
//    moveSinceDetection*, extended (+ risiko EXTENDED), NEAR_INVALIDATION dihitung ulang terhadap invalidasi
//    snapshot, LATE_ENTRY dibawa dari evaluasi saat kandidat dibuka (tidak dihitung ulang dari evaluasi berikutnya).
// 7. barsElapsed dari selisih openTime (gap data tetap menghitung waktu berjalan); event pada candle pasca-gap
//    memuat detail.gapBars.
//
// Alert hanya OPENED, STAGE_UP, dan CANCELLED dari tahap ≥ DEVELOPING — tidak pernah dua kali untuk tahap yang sama.
import { TIMEFRAME_MS } from '../market/contracts.js';
import {
  CLASSIFICATIONS, OPEN_STATUSES, REVERSAL_TIMEFRAMES, REVERSAL_VERSION, RISKS, STAGES, STAGE_RANK, STATUSES, STATUS_OF_STAGE,
  TERMINAL_STATUSES,
} from './constants.js';
import { cancelConditionOf, nextConfirmationOf } from './detector.js';
import { resolveReversalParams } from './params.js';
import { fmtAtr, fmtPrice } from './format.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const orNull = (v) => (isNum(v) ? v : null);
const LEVEL_KEYS = Object.freeze(['bottom', 'lastSwingLow', 'higherLow', 'trigger', 'ema25', 'ema7', 'atr', 'invalidation']);

function assertInput(input) {
  if (input === null || typeof input !== 'object') throw new TypeError('input transisi harus objek');
  const { candle, evaluation, timeframe } = input;
  if (!REVERSAL_TIMEFRAMES.includes(timeframe)) throw new RangeError(`Timeframe reversal tidak dikenal: ${String(timeframe)}`);
  if (candle === null || typeof candle !== 'object') throw new TypeError('input.candle wajib ada');
  for (const key of ['openTime', 'closeTime', 'close', 'high']) {
    if (!isNum(candle[key])) throw new TypeError(`candle.${key} harus angka`);
  }
  if (!(candle.close > 0)) throw new RangeError('candle.close harus > 0');
  if (candle.isClosed !== true) throw new RangeError('Hanya candle tertutup yang boleh masuk state machine reversal');
  if (candle.timeframe !== undefined && candle.timeframe !== timeframe) throw new RangeError(`candle.timeframe ${candle.timeframe} ≠ ${timeframe}`);
  if (evaluation === null || typeof evaluation !== 'object') throw new TypeError('input.evaluation wajib ada');
  if (evaluation.version !== REVERSAL_VERSION) throw new RangeError(`evaluation.version harus ${REVERSAL_VERSION}`);
  if (evaluation.provisional !== false) throw new RangeError('evaluation provisional tidak boleh masuk state machine');
  if (evaluation.timeframe !== timeframe) throw new RangeError('evaluation.timeframe tidak sama dengan timeframe input');
  if (evaluation.candleOpenTime !== candle.openTime) throw new RangeError('evaluation.candleOpenTime tidak sama dengan candle.openTime');
  if (evaluation.stage !== null && !STAGES.includes(evaluation.stage)) throw new RangeError(`evaluation.stage tidak dikenal: ${evaluation.stage}`);
  if (!CLASSIFICATIONS.includes(evaluation.classification)) throw new RangeError(`evaluation.classification tidak dikenal: ${evaluation.classification}`);
  if (evaluation.levels === null || typeof evaluation.levels !== 'object') throw new TypeError('evaluation.levels harus objek');
  if (evaluation.score === null || typeof evaluation.score !== 'object' || !isNum(evaluation.score.total)
    || evaluation.score.total < 0 || evaluation.score.total > 100 || !Array.isArray(evaluation.score.components)) {
    throw new RangeError('evaluation.score harus { total 0..100, components[] }');
  }
  if (!Array.isArray(evaluation.evidence)) throw new TypeError('evaluation.evidence harus array');
  if (!Array.isArray(evaluation.risks) || evaluation.risks.some((r) => !RISKS.includes(r))) throw new RangeError('evaluation.risks harus subset RISKS');
}

function assertSnapshot(prev) {
  if (typeof prev !== 'object') throw new TypeError('Snapshot sebelumnya harus objek atau null');
  if (prev.status !== 'NONE' && !STATUSES.includes(prev.status)) throw new RangeError(`Status snapshot tidak dikenal: ${prev.status}`);
  if (!isNum(prev.lastCandleTime)) throw new TypeError('snapshot.lastCandleTime harus angka');
  if (OPEN_STATUSES.includes(prev.status)) {
    if (!STAGES.includes(prev.stage)) throw new RangeError(`Tahap snapshot tidak dikenal: ${prev.stage}`);
    if (!(prev.firstDetectedPrice > 0)) throw new TypeError('snapshot.firstDetectedPrice harus > 0');
    if (!Number.isInteger(prev.barsInStage) || prev.barsInStage < 0) throw new TypeError('snapshot.barsInStage harus bilangan bulat ≥ 0');
    if (prev.levels === null || typeof prev.levels !== 'object') throw new TypeError('snapshot.levels harus objek');
  }
  if (prev.pendingStage !== null && prev.pendingStage !== undefined && !STAGES.includes(prev.pendingStage)) {
    throw new RangeError(`pendingStage tidak dikenal: ${prev.pendingStage}`);
  }
}

function barsElapsed(prev, candle, timeframe) {
  return Math.max(1, Math.round((candle.openTime - prev.lastCandleTime) / TIMEFRAME_MS[timeframe]));
}

const evidenceIds = (evaluation) => evaluation.evidence.map((c) => (typeof c === 'string' ? c : c.id));

function levelsOf(source) {
  const out = {};
  for (const k of LEVEL_KEYS) out[k] = orNull(source?.[k]);
  return out;
}

/** Ringkasan evaluasi yang disalin ke snapshot. */
function summary(evaluation) {
  return {
    classification: evaluation.classification,
    setupType: evaluation.setupType ?? null,
    setupTypes: [...(evaluation.setupTypes ?? [])],
    score: evaluation.score.total,
    scoreComponents: evaluation.score.components.map((c) => ({ ...c })),
    evidence: evidenceIds(evaluation),
    evidenceCount: evaluation.evidenceCount ?? evaluation.evidence.length,
    levels: levelsOf(evaluation.levels),
    nextConfirmation: { ...evaluation.nextConfirmation },
    cancelCondition: { ...evaluation.cancelCondition },
    risks: RISKS.filter((r) => evaluation.risks.includes(r)),
    liquidityClass: evaluation.context?.liquidityClass ?? 'UNKNOWN',
    markers: (evaluation.markers ?? []).map((m) => ({ ...m })),
  };
}

function noneSnapshot(input, pending) {
  const { candle, evaluation, timeframe } = input;
  return {
    version: REVERSAL_VERSION,
    timeframe,
    stage: null,
    status: 'NONE',
    ...summary(evaluation),
    firstDetectedAt: null,
    firstDetectedPrice: null,
    firstDetectedAtr: null,
    firstStage: null,
    stageEnteredAt: null,
    barsInStage: 0,
    barsSinceDetection: 0,
    lastCandleTime: candle.openTime,
    lastEvaluatedAt: candle.closeTime,
    peakPrice: null,
    peakStage: null,
    moveSinceDetectionPct: null,
    moveSinceDetectionAtr: null,
    extended: false,
    pendingStage: pending.pendingStage,
    pendingBars: pending.pendingBars,
    weakBars: 0,
    closeReason: null,
  };
}

function event(type, { from, to, candle, reason, detail }) {
  return {
    type,
    fromStage: from.stage ?? null,
    toStage: to.stage ?? null,
    fromStatus: from.status ?? 'NONE',
    toStatus: to.status,
    candleTime: candle.openTime,
    occurredAt: candle.closeTime,
    price: candle.close,
    reason,
    provisional: false,
    detail,
  };
}

function baseDetail(snapshot, text, extra = {}) {
  return { score: snapshot.score, evidence: [...snapshot.evidence], levels: { ...snapshot.levels }, reason: text, ...extra };
}

/** Risiko snapshot: dari evaluasi, LATE_ENTRY dibawa dari pembukaan, EXTENDED & NEAR_INVALIDATION dihitung ulang. */
function snapshotRisks(evaluation, { lateEntry, extended, nearInvalidation }) {
  const set = new Set(evaluation.risks.filter((r) => r !== 'LATE_ENTRY' && r !== 'EXTENDED' && r !== 'NEAR_INVALIDATION'));
  if (lateEntry) set.add('LATE_ENTRY');
  if (extended) set.add('EXTENDED');
  if (nearInvalidation) set.add('NEAR_INVALIDATION');
  return RISKS.filter((r) => set.has(r));
}

/** Tanpa kandidat terbuka: hitung histeresis masuk, buka bila cukup. */
function openCandidate(prev, input, p) {
  const { candle, evaluation, timeframe } = input;
  const continuing = prev !== null && prev.status === 'NONE';
  const elapsed = continuing ? barsElapsed(prev, candle, timeframe) : 1;
  const stage = evaluation.stage;
  const inv = orNull(evaluation.levels.invalidation);
  const reset = { pendingStage: null, pendingBars: 0 };
  if (stage === null || (inv !== null && candle.close <= inv)) {
    return { next: noneSnapshot(input, reset), events: [], alert: false };
  }
  const pendingBars = continuing && prev.pendingStage !== null && prev.pendingStage !== undefined && elapsed === 1 ? prev.pendingBars + 1 : 1;
  const need = p.enterConfirmBars[timeframe];
  if (pendingBars < need) return { next: noneSnapshot(input, { pendingStage: stage, pendingBars }), events: [], alert: false };

  const atr = orNull(evaluation.levels.atr);
  const lateEntry = evaluation.risks.includes('LATE_ENTRY');
  const nearInvalidation = inv !== null && atr !== null && candle.close - inv <= p.nearInvalidationAtr * atr;
  const sum = summary(evaluation);
  const next = {
    version: REVERSAL_VERSION,
    timeframe,
    stage,
    status: STATUS_OF_STAGE[stage],
    ...sum,
    risks: snapshotRisks(evaluation, { lateEntry, extended: false, nearInvalidation }),
    firstDetectedAt: candle.closeTime,
    firstDetectedPrice: candle.close,
    firstDetectedAtr: atr,
    firstStage: stage,
    stageEnteredAt: candle.closeTime,
    barsInStage: 0,
    barsSinceDetection: 0,
    lastCandleTime: candle.openTime,
    lastEvaluatedAt: candle.closeTime,
    peakPrice: candle.close,
    peakStage: stage,
    moveSinceDetectionPct: 0,
    moveSinceDetectionAtr: atr !== null ? 0 : null,
    extended: false,
    pendingStage: null,
    pendingBars: 0,
    weakBars: 0,
    closeReason: null,
  };
  const text = `Bukti tahap ${stage} terpenuhi ${pendingBars} candle tutup berurutan (skor ${next.score}, ${next.evidenceCount} bukti)`;
  const ev = event('OPENED', {
    from: { stage: null, status: 'NONE' }, to: next, candle, reason: 'STAGE_EVIDENCE',
    detail: baseDetail(next, text, { setupType: next.setupType, pendingBars, ...(elapsed > 1 ? { gapBars: elapsed - 1 } : {}) }),
  });
  return { next, events: [ev], alert: true };
}

/** Level snapshot setelah candle baru: invalidasi hanya naik, trigger beku setelah CONFIRMED. */
function mergeLevels(prev, evaluation, close) {
  const e = evaluation.levels;
  const computed = isNum(e.atr) || isNum(e.bottom);
  const out = { ...prev.levels };
  if (computed) {
    for (const k of ['bottom', 'lastSwingLow', 'higherLow', 'ema25', 'ema7', 'atr']) out[k] = orNull(e[k]);
    if (prev.stage !== 'CONFIRMED_BREAKOUT') out.trigger = orNull(e.trigger);
  }
  const base = isNum(evaluation.measures?.invalidationBase)
    ? evaluation.measures.invalidationBase
    : (evaluation.stage === 'CONFIRMED_BREAKOUT' ? null : orNull(e.invalidation));
  if (base !== null && base < close && (out.invalidation === null || base > out.invalidation)) out.invalidation = base;
  return out;
}

function advance(prev, input, p) {
  const { candle, evaluation, timeframe } = input;
  const close = candle.close;
  const elapsed = barsElapsed(prev, candle, timeframe);
  const barsInStage = prev.barsInStage + elapsed;
  const barsSinceDetection = prev.barsSinceDetection + elapsed;
  const levels = mergeLevels(prev, evaluation, close);
  const atrNow = levels.atr;
  const moveSinceDetectionPct = close / prev.firstDetectedPrice - 1;
  const moveSinceDetectionAtr = prev.firstDetectedAtr > 0 ? (close - prev.firstDetectedPrice) / prev.firstDetectedAtr : null;
  const extended = (moveSinceDetectionAtr !== null && moveSinceDetectionAtr >= p.extendedAtr) || moveSinceDetectionPct >= p.extendedPct;
  const weakBars = evaluation.stage === null ? prev.weakBars + 1 : 0;
  const gap = elapsed > 1 ? { gapBars: elapsed - 1 } : {};
  const ids = new Set(evidenceIds(evaluation));
  const sum = summary(evaluation);
  const breakoutFloor = prev.stage === 'CONFIRMED_BREAKOUT' && levels.trigger !== null && atrNow !== null
    && levels.invalidation !== null && Math.abs(levels.invalidation - (levels.trigger - p.failedBreakAtr * atrNow)) < 1e-12;
  const nearInvalidation = levels.invalidation !== null && atrNow !== null && close - levels.invalidation <= p.nearInvalidationAtr * atrNow;
  const updated = {
    ...prev,
    ...sum,
    setupType: evaluation.setupType ?? prev.setupType,
    setupTypes: (evaluation.setupTypes ?? []).length > 0 ? [...evaluation.setupTypes] : [...prev.setupTypes],
    levels,
    nextConfirmation: nextConfirmationOf(prev.stage, levels, ids, close, p),
    cancelCondition: cancelConditionOf(levels.invalidation, { breakoutFloor, p }),
    risks: snapshotRisks(evaluation, { lateEntry: prev.risks.includes('LATE_ENTRY'), extended, nearInvalidation }),
    lastCandleTime: candle.openTime,
    lastEvaluatedAt: candle.closeTime,
    barsInStage,
    barsSinceDetection,
    peakPrice: Math.max(prev.peakPrice ?? close, candle.high),
    moveSinceDetectionPct,
    moveSinceDetectionAtr,
    extended,
    pendingStage: null,
    pendingBars: 0,
    weakBars,
  };
  const expiry = p.expiryBars[prev.stage];
  const terminal = (status, closeReason, text, extra = {}) => {
    const next = { ...updated, status, closeReason, cancelCondition: prev.cancelCondition, levels: prev.levels, nextConfirmation: prev.nextConfirmation };
    const ev = event(status, { from: prev, to: next, candle, reason: closeReason, detail: baseDetail(prev, text, { barsInPrevStage: barsInStage, firstDetectedPrice: prev.firstDetectedPrice, moveSinceDetectionAtr, ...extra, ...gap }) });
    return { next, events: [ev], alert: status === 'CANCELLED' && STAGE_RANK[prev.stage] >= STAGE_RANK.DEVELOPING_REVERSAL };
  };

  // 2. Jatuh tempo di dalam gap data: kedaluwarsa dulu, tanpa promosi dari konteks basi.
  if (barsInStage - 1 >= expiry) {
    return terminal('EXPIRED', 'NO_PROGRESS', `Tidak ada kemajuan selama ${barsInStage - 1} candle (batas ${expiry}) — jatuh tempo di dalam gap data`);
  }
  // 3. Batal: close di bawah invalidasi snapshot (wick tidak membatalkan).
  const inv = prev.levels.invalidation;
  if (inv !== null && close < inv) {
    const failedLevel = prev.stage === 'CONFIRMED_BREAKOUT' && prev.levels.trigger !== null && atrNow !== null ? prev.levels.trigger - p.failedBreakAtr * atrNow : null;
    const failed = failedLevel !== null && close < failedLevel;
    const text = failed
      ? `Breakout gagal: close ${fmtPrice(close)} di bawah ${fmtPrice(failedLevel)} (${fmtAtr(p.failedBreakAtr)} di bawah level pemicu ${fmtPrice(prev.levels.trigger)})`
      : `Close ${fmtPrice(close)} di bawah level invalidasi ${fmtPrice(inv)}`;
    return terminal('CANCELLED', failed ? 'BREAKOUT_FAILED' : 'CLOSE_BELOW_INVALIDATION', text, { invalidation: inv });
  }
  // 4. Naik tahap dengan histeresis.
  const higher = evaluation.stage !== null && STAGE_RANK[evaluation.stage] > STAGE_RANK[prev.stage];
  if (higher) {
    const continuing = prev.pendingStage !== null && prev.pendingStage !== undefined && STAGE_RANK[prev.pendingStage] > STAGE_RANK[prev.stage] && elapsed === 1;
    const pendingBars = continuing ? prev.pendingBars + 1 : 1;
    const need = p.enterConfirmBars[timeframe];
    if (pendingBars >= need) {
      const toStage = evaluation.stage;
      const next = { ...updated, stage: toStage, status: STATUS_OF_STAGE[toStage], stageEnteredAt: candle.closeTime, barsInStage: 0, peakStage: toStage };
      let floor = false;
      if (toStage === 'CONFIRMED_BREAKOUT') {
        // Bekukan level pemicu yang ditembus; lantai breakout gagal menaikkan invalidasi bila lebih tinggi.
        const trigger = orNull(evaluation.levels.trigger) ?? levels.trigger;
        const nl = { ...levels, trigger };
        if (trigger !== null && atrNow !== null) {
          const f = trigger - p.failedBreakAtr * atrNow;
          if (f > 0 && f < close && (nl.invalidation === null || f > nl.invalidation)) {
            nl.invalidation = f;
            floor = true;
          }
        }
        next.levels = nl;
        next.cancelCondition = cancelConditionOf(nl.invalidation, { breakoutFloor: floor, p });
        next.risks = snapshotRisks(evaluation, {
          lateEntry: prev.risks.includes('LATE_ENTRY'),
          extended,
          nearInvalidation: nl.invalidation !== null && atrNow !== null && close - nl.invalidation <= p.nearInvalidationAtr * atrNow,
        });
      }
      next.nextConfirmation = nextConfirmationOf(toStage, next.levels, ids, close, p);
      const text = `Bukti tahap ${toStage} terpenuhi ${pendingBars} candle tutup berurutan (skor ${next.score}, ${next.evidenceCount} bukti)`;
      const ev = event('STAGE_UP', { from: prev, to: next, candle, reason: 'STAGE_EVIDENCE', detail: baseDetail(next, text, { barsInPrevStage: barsInStage, pendingBars, ...gap }) });
      return { next, events: [ev], alert: true };
    }
    updated.pendingStage = evaluation.stage;
    updated.pendingBars = pendingBars;
  }
  // 5. Kedaluwarsa.
  if (barsInStage >= expiry) {
    return terminal('EXPIRED', 'NO_PROGRESS', `Tidak ada kemajuan tahap selama ${barsInStage} candle (batas ${expiry})`);
  }
  if (weakBars >= p.weakBarsLimit) {
    return terminal('EXPIRED', 'EVIDENCE_FADED', `Bukti melemah: ${weakBars} candle berurutan tanpa tahap (batas ${p.weakBarsLimit})`);
  }
  // 6. Pembaruan tanpa event.
  return { next: updated, events: [], alert: false };
}

/**
 * Satu langkah state machine Reversal Radar untuk satu candle tertutup.
 * @param {object|null} prev ReversalSnapshot sebelumnya (null bila belum ada)
 * @param {{ candle: object, evaluation: object, timeframe: '5m'|'15m'|'1h' }} input evaluation = hasil
 *   evaluateReversal (provisional=false) pada candle yang sama
 * @param {object} [params] override DEFAULT_REVERSAL_PARAMS
 * @returns {{ next: object, events: object[], alert: boolean }}
 */
export function transitionReversal(prev, input, params = {}) {
  assertInput(input);
  const p = resolveReversalParams(params ?? {}, input.timeframe);
  const hasPrev = prev !== null && prev !== undefined;
  if (hasPrev) {
    assertSnapshot(prev);
    if (prev.timeframe !== undefined && prev.timeframe !== input.timeframe) throw new RangeError('Timeframe snapshot tidak sama dengan timeframe input');
    if (input.candle.openTime <= prev.lastCandleTime) return { next: prev, events: [], alert: false };
  }
  if (hasPrev && OPEN_STATUSES.includes(prev.status)) return advance(prev, input, p);
  // prev null, NONE, atau terminal (kandidat berikutnya = baris baru; pending terminal tidak dibawa).
  return openCandidate(hasPrev && prev.status === 'NONE' ? prev : null, input, p);
}

/** true bila status menutup kandidat. */
export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(status);
}
