// Harness replay historis "Reversal Radar" (docs/19 §9): satu seri (simbol × timeframe) di-replay candle demi candle
// dengan logika IDENTIK dengan live — evaluateReversal pada jendela candle tertutup ≤ t, konteks HTF hanya candle
// dengan closeTime ≤ t (htfCursor, seperti backend/backtest/runner.js), lalu transitionReversal dengan histeresis
// yang sama — dan setiap kandidat yang dibuka diberi label hasil triple barrier menurut definisi keberhasilan
// docs/19 §10 (ditetapkan SEBELUM evaluasi; jangan "disetel" setelah melihat hasil):
//   SUCCESS  harga mencapai close deteksi + targetAtr × ATR deteksi sebelum close < invalidasi, dalam horizonBars;
//   FAIL     penghalang bawah (levels.invalidation saat deteksi) tersentuh lebih dulu — urutan intrabar tidak
//            diketahui, sehingga TP & SL di candle yang sama = FAIL, gap melewati stop = keluar di open (labeler.js);
//   TIMEOUT  tidak ada penghalang tersentuh sampai horizonBars; OPEN = data habis sebelum itu.
// Pembanding mesin lama: analyzeAt (pola SA/PVA, state machine lama) di-replay pada jendela & HTF yang sama;
// "sinyal lama" = sinyal pertama yang dibuka (QUIET/EARLY_BULLISH), "alert lama" = state alert pertama.
//
// Mesin (evaluate/transition/resolveParams) DISUNTIKKAN — default dari ./index.js — sehingga tes memakai mesin
// palsu deterministik dan integrator cukup menjalankan harness ini dengan mesin asli. Modul ini tidak ber-I/O dan
// tidak memakai Date.now() (kecuali pengukur durasi di replayReversalUniverse); satu-satunya efek samping adalah
// giliran event loop tiap `yieldEvery` evaluasi agar proses panjang tidak memblokir.
import { setImmediate as nextMacrotask } from 'node:timers/promises';
import { analyzeAt } from '../analysis/pipeline.js';
import { labelTrade } from '../backtest/labeler.js';
import { aggregateCandles, createRng } from '../backtest/synthetic.js';
import { atr } from '../indicators/index.js';
import { HIGHER_TIMEFRAMES } from '../market/contracts.js';
import { ALERT_STATES, LONG_PATTERN_STATES } from '../signals/params.js';
import { OPEN_STATUSES, REVERSAL_LOOKBACK, REVERSAL_TIMEFRAMES, STAGE_RANK, TERMINAL_STATUSES } from './constants.js';
import * as engine from './index.js';

/**
 * Nilai bawaan harness. horizonBars 48 untuk semua timeframe (docs/19 §9); targetAtr 2 (§10); warmupBars 150
 * (= batas atas requiredCandles mesin); lookback 300 (= REVERSAL_LOOKBACK yang dimuat pipeline live).
 * oldMode: 'full' = analyzeAt dengan parameter default live (konfluensi v3 + gerbang tier; ≈ 4× lebih lambat);
 * 'fast' = `confluence: false` (pola SA/PVA & sinyal pertama identik, indeks alert pertama = definisi v2 tanpa gerbang tier).
 */
export const REPLAY_DEFAULTS = Object.freeze({
  horizonBars: 48, targetAtr: 2, warmupBars: 150, lookback: REVERSAL_LOOKBACK, yieldEvery: 200, oldScanner: true, oldMode: 'full',
});
export const OLD_SCANNER_MODES = Object.freeze(['full', 'fast']);
export const REPLAY_OUTCOMES = Object.freeze(['SUCCESS', 'FAIL', 'TIMEOUT', 'OPEN']);
/**
 * Basis pembanding tanpa keterampilan (basis empiris): `samples` indeks acak per kandidat berlabel pada seri yang sama,
 * dilabeli dengan aturan triple barrier yang sama; ATR di indeks acak = ATR Wilder `atrPeriod` (= atrPeriod bawaan mesin).
 */
export const BASELINE_DEFAULTS = Object.freeze({ samples: 3, atrPeriod: 14 });
/** Alasan kandidat tidak dapat dilabeli (dikecualikan dari rasio hasil, tetap dihitung sebagai kandidat). */
export const LABEL_ERRORS = Object.freeze(['NO_ENTRY_PRICE', 'NO_ATR', 'NO_INVALIDATION', 'LABEL_FAILED']);

const OUTCOME_OF_LABEL = Object.freeze({ WIN: 'SUCCESS', LOSS: 'FAIL', TIMEOUT: 'TIMEOUT', OPEN: 'OPEN' });
const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const finite = (v) => (isFiniteNumber(v) ? v : null);
const integer = (v) => (Number.isInteger(v) ? v : null);

/** Kesalahan uji stabilitas prefiks (ada look-ahead atau fungsi evaluasi tidak murni). */
export class LookaheadError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'LookaheadError';
    this.details = details;
  }
}

/** HTF tersedia pada waktu t: candle dengan closeTime ≤ t (indeks akhir eksklusif dimajukan monoton; t harus naik). */
export function htfCursor(list, lookback = REVERSAL_LOOKBACK) {
  let end = 0;
  return (t) => {
    while (end < list.length && list[end].closeTime <= t) end += 1;
    return list.slice(Math.max(0, end - lookback), end);
  };
}

/** Timeframe konteks: dari `higher` bila ada (hanya candle tertutup), bila tidak diagregasi dari candle dasar. */
export function contextSeries(timeframe, candles, higher = {}) {
  const out = {};
  for (const htf of HIGHER_TIMEFRAMES[timeframe]) {
    const given = higher?.[htf];
    out[htf] = Array.isArray(given) && given.length ? given.filter((c) => c.isClosed === true) : aggregateCandles(candles, htf);
  }
  return out;
}

function assertCandles(candles) {
  if (!Array.isArray(candles) || candles.length === 0) throw new TypeError('candles harus array candle yang tidak kosong');
  for (let i = 1; i < candles.length; i += 1) {
    if (!(candles[i].openTime > candles[i - 1].openTime)) throw new RangeError(`candles harus urut naik tanpa duplikat (indeks ${i})`);
  }
}

function assertTimeframe(timeframe) {
  if (!REVERSAL_TIMEFRAMES.includes(timeframe)) throw new RangeError(`Timeframe tidak didukung Reversal Radar: ${String(timeframe)} (pilihan: ${REVERSAL_TIMEFRAMES.join(', ')})`);
}

function assertPositiveInt(name, v, max = 100_000) {
  if (!Number.isInteger(v) || v < 1 || v > max) throw new RangeError(`${name} harus bilangan bulat 1..${max}`);
}

/**
 * Dependensi mesin. Bagian yang tidak disuntikkan diambil dari modul mesin (./index.js). Bila `evaluate` disuntikkan
 * (mesin palsu/terskrip di tes), `resolveParams` dan `requiredCandles` TIDAK diambil dari mesin asli — parameter mesin
 * palsu tidak boleh dicampur dengan validasi/warm-up mesin asli: resolveParams → identitas, warm-up → hanya warmupBars.
 * Akses ekspor mesin dilakukan di sini (bukan sebagai nilai bawaan parameter) agar modul tetap dapat diimpor saat
 * ekspor mesin belum ada.
 */
function engineDeps({ evaluate, transition, resolveParams, requiredCandles }) {
  const pick = (name, given, fallback) => {
    if (given === undefined) return fallback;
    if (typeof given !== 'function') throw new TypeError(`${name} harus fungsi`);
    return given;
  };
  const injected = evaluate !== undefined;
  if (requiredCandles !== undefined && requiredCandles !== null && typeof requiredCandles !== 'function' && !isFiniteNumber(requiredCandles)) {
    throw new TypeError('requiredCandles harus fungsi atau angka');
  }
  return {
    evaluate: pick('evaluate', evaluate, engine.evaluateReversal),
    transition: pick('transition', transition, engine.transitionReversal),
    resolveParams: pick('resolveParams', resolveParams, injected ? null : engine.resolveReversalParams),
    requiredCandles: requiredCandles === undefined ? (injected ? null : engine.requiredCandles) : requiredCandles,
  };
}

/** Warm-up efektif = max(warmupBars, requiredCandles(params)) — requiredCandles fungsi/angka bila ada. */
function resolveWarmup({ warmupBars, requiredCandles, resolved }) {
  let required = typeof requiredCandles === 'number' ? requiredCandles : null;
  if (typeof requiredCandles === 'function') {
    try {
      const v = requiredCandles(resolved);
      if (isFiniteNumber(v)) required = v;
    } catch {
      required = null; // requiredCandles tidak valid untuk parameter ini → pakai warmupBars
    }
  }
  return Math.max(warmupBars, required ?? 0);
}

function resolveEngineParams(resolveParams, params, timeframe) {
  if (typeof resolveParams !== 'function') return params;
  try {
    return resolveParams(params, timeframe) ?? params;
  } catch (err) {
    throw new TypeError(`resolveParams gagal: ${err?.message ?? err}`, { cause: err });
  }
}

/** Id bukti dari evaluasi (array objek { id } atau array string). */
function evidenceIds(evaluation) {
  const list = Array.isArray(evaluation?.evidence) ? evaluation.evidence : [];
  return list.map((e) => (typeof e === 'string' ? e : e?.id)).filter((id) => typeof id === 'string');
}

function oldParamsFor(mode, overrides) {
  if (!OLD_SCANNER_MODES.includes(mode)) throw new RangeError(`oldMode harus salah satu dari: ${OLD_SCANNER_MODES.join(', ')}`);
  return mode === 'fast' ? { ...overrides, confluence: false } : { ...overrides };
}

/** Rekam kandidat baru saat event OPENED (atau snapshot terbuka tanpa event — anomali). */
function openCandidate({ index, candle, evaluation, next, event, ordinal, symbol, timeframe }) {
  const levels = next?.levels ?? evaluation?.levels ?? {};
  const risks = Array.isArray(next?.risks) ? [...next.risks] : Array.isArray(evaluation?.risks) ? [...evaluation.risks] : [];
  const firstStage = event?.toStage ?? next?.stage ?? evaluation?.stage ?? null;
  const setupTypes = Array.isArray(next?.setupTypes) ? [...next.setupTypes] : Array.isArray(evaluation?.setupTypes) ? [...evaluation.setupTypes] : [];
  return {
    id: ordinal,
    symbol,
    timeframe,
    firstDetectedIndex: index,
    firstDetectedTime: finite(next?.firstDetectedAt) ?? candle.closeTime,
    firstDetectedPrice: finite(next?.firstDetectedPrice) ?? candle.close,
    firstDetectedAtr: finite(next?.firstDetectedAtr) ?? finite(levels.atr) ?? finite(evaluation?.levels?.atr),
    firstStage,
    firstStatus: event?.toStatus ?? next?.status ?? null,
    firstScore: finite(evaluation?.score?.total) ?? finite(next?.score) ?? null,
    firstEvidenceCount: integer(evaluation?.evidenceCount) ?? integer(next?.evidenceCount) ?? evidenceIds(evaluation).length,
    firstEvidence: evidenceIds(evaluation),
    setupType: next?.setupType ?? evaluation?.setupType ?? null,
    setupTypes,
    classification: evaluation?.classification ?? next?.classification ?? null,
    liquidityClass: next?.liquidityClass ?? evaluation?.context?.liquidityClass ?? null,
    htfTrend: evaluation?.context?.htf?.trend ?? null,
    bottom: finite(levels.bottom),
    invalidation: finite(levels.invalidation),
    trigger: finite(levels.trigger),
    risks,
    lateEntry: risks.includes('LATE_ENTRY'),
    extendedAtDetection: risks.includes('LATE_ENTRY') || risks.includes('EXTENDED') || next?.extended === true,
    stages: [{ stage: firstStage, index, time: candle.closeTime }],
    lastStage: firstStage,
    status: event?.toStatus ?? next?.status ?? null,
    closeReason: null,
    closeIndex: null,
    closeTime: null,
    barsOpen: null,
    // Diisi setelah replay (pelabelan & lead).
    outcome: null,
    labelError: null,
    targetPrice: null,
    stopPrice: null,
    exitIndex: null,
    exitPrice: null,
    exitTime: null,
    barsHeld: null,
    gap: false,
    mfeAtr: null,
    maeAtr: null,
    mfePct: null,
    maePct: null,
    barsToTrigger: null,
    barsToConfirmed: firstStage === 'CONFIRMED_BREAKOUT' ? 0 : null,
    leadVsBreakout: null,
    leadVsOld: null,
    leadVsOldAlert: null,
    // Lead per peristiwa (sinyal lama terdekat ±horizon) & basis pembanding tanpa keterampilan — lihat nearestOldLead/shuffledBaseline.
    leadVsOldNearest: null,
    stopDistanceAtr: null,
    baselineRandomWalk: null,
    baselineShuffled: null,
  };
}

function closeCandidate(c, { index, candle, next, event }) {
  c.status = event?.toStatus ?? next?.status ?? c.status;
  c.closeReason = next?.closeReason ?? event?.reason ?? null;
  c.closeIndex = index;
  c.closeTime = candle.closeTime;
  c.barsOpen = index - c.firstDetectedIndex;
}

function stageUp(c, { index, candle, next, event }) {
  const stage = event?.toStage ?? next?.stage ?? null;
  c.stages.push({ stage, index, time: candle.closeTime });
  c.lastStage = stage;
  c.status = event?.toStatus ?? next?.status ?? c.status;
  if (stage === 'CONFIRMED_BREAKOUT' && c.barsToConfirmed === null) c.barsToConfirmed = index - c.firstDetectedIndex;
}

/**
 * Label hasil triple barrier (docs/19 §10) untuk satu kandidat: entri = close deteksi pertama, target = entri +
 * targetAtr × ATR deteksi, stop = levels.invalidation saat deteksi, batas waktu horizonBars. Memakai labelTrade
 * (aturan gap & urutan intrabar konservatif) dengan targetR = targetAtr·ATR / risiko dan tanpa biaya.
 * MFE/MAE dikonversi ke kelipatan ATR dan fraksi harga entri.
 * @returns {object} field hasil (outcome null + labelError bila tidak dapat dilabeli)
 */
export function labelCandidate(candles, candidate, { horizonBars = REPLAY_DEFAULTS.horizonBars, targetAtr = REPLAY_DEFAULTS.targetAtr } = {}) {
  const base = {
    outcome: null, labelError: null, targetPrice: null, stopPrice: null, exitIndex: null, exitPrice: null, exitTime: null,
    barsHeld: null, gap: false, mfeAtr: null, maeAtr: null, mfePct: null, maePct: null,
  };
  const entry = candidate.firstDetectedPrice;
  const atr = candidate.firstDetectedAtr;
  const stop = candidate.invalidation;
  if (!(entry > 0)) return { ...base, labelError: 'NO_ENTRY_PRICE' };
  if (!(atr > 0)) return { ...base, labelError: 'NO_ATR' };
  if (!(stop > 0) || !(stop < entry)) return { ...base, labelError: 'NO_INVALIDATION' };
  const risk = entry - stop;
  const t = labelTrade({
    candles, entryIndex: candidate.firstDetectedIndex, direction: 'LONG', entryPrice: entry, stopPrice: stop,
    targetR: (targetAtr * atr) / risk, maxBars: horizonBars, feeBps: 0, slippageBps: 0,
  });
  if (!t) return { ...base, labelError: 'LABEL_FAILED' };
  const toAtr = (r) => (r * risk) / atr;
  const toPct = (r) => (r * risk) / entry;
  return {
    outcome: OUTCOME_OF_LABEL[t.outcome] ?? null,
    labelError: null,
    targetPrice: t.targetPrice,
    stopPrice: stop,
    exitIndex: t.exitIndex,
    exitPrice: t.exitPrice,
    exitTime: t.exitTime,
    barsHeld: t.barsHeld,
    gap: t.gap,
    mfeAtr: toAtr(t.mfeR),
    maeAtr: toAtr(t.maeR),
    mfePct: toPct(t.mfeR),
    maePct: toPct(t.maeR),
  };
}

/**
 * Lead deteksi terhadap breakout struktural: jumlah candle dari deteksi pertama sampai close pertama di atas level
 * pemicu (resistance berjalan) saat deteksi, dalam horizonBars; 0 bila close deteksi sudah di atasnya; null bila
 * tidak ada level pemicu atau tidak pernah ditembus dalam horizon.
 */
export function breakoutLead(candles, candidate, horizonBars = REPLAY_DEFAULTS.horizonBars) {
  const trigger = candidate.trigger;
  if (!(trigger > 0)) return null;
  const start = candidate.firstDetectedIndex;
  if (candles[start]?.close > trigger) return 0;
  const last = Math.min(candles.length - 1, start + horizonBars);
  for (let i = start + 1; i <= last; i += 1) if (candles[i].close > trigger) return i - start;
  return null;
}

/**
 * Lead per peristiwa: indeks mulai sinyal lama (QUIET/EARLY_BULLISH) TERDEKAT dari deteksi dalam jendela ±horizonBars,
 * dikurangi indeks deteksi (positif = Reversal Radar lebih awal); bila dua sinyal sama dekat, dipilih yang sesudah
 * deteksi. null bila tidak ada sinyal lama dalam jendela. Berbeda dengan leadVsOld (sinyal lama PERTAMA seri) yang
 * hanya bermakna pada seri satu-peristiwa (sintetis); pada data nyata multi-peristiwa pakai ukuran ini.
 */
export function nearestOldLead(signalIndexes, index, horizonBars = REPLAY_DEFAULTS.horizonBars) {
  if (!Array.isArray(signalIndexes) || !Number.isInteger(index)) return null;
  let best = null;
  for (const s of signalIndexes) {
    if (!Number.isInteger(s) || Math.abs(s - index) > horizonBars) continue;
    const lead = s - index;
    if (best === null || Math.abs(lead) < Math.abs(best) || (Math.abs(lead) === Math.abs(best) && lead > best)) best = lead;
  }
  return best;
}

/**
 * Basis empiris tanpa keterampilan untuk satu kandidat berlabel: `samples` indeks acak berbeda (PRNG berbenih `seed`,
 * deterministik) dalam [from, to] — from = warm-up, to = n − 1 − horizonBars agar label tidak OPEN — masing-masing
 * dilabeli dengan aturan triple barrier yang SAMA (labelCandidate): entri = close indeks itu, target = targetAtr ×
 * ATR(idx), stop = entri − stopDistanceAtr × ATR(idx) (jarak stop kandidat dalam ATR deteksi), ATR(idx) dari `atrSeries`
 * (Wilder; hanya memakai candle ≤ idx). Sampel tanpa ATR/stop valid tetap dicatat (outcome null) tetapi tidak dihitung.
 * @returns {{ k: number, n: number, indexes: number[], outcomes: Array<string|null> }} k = SUCCESS, n = berlabel
 */
export function shuffledBaseline(candles, {
  stopDistanceAtr, atrSeries, from, to, seed, samples = BASELINE_DEFAULTS.samples,
  horizonBars = REPLAY_DEFAULTS.horizonBars, targetAtr = REPLAY_DEFAULTS.targetAtr,
} = {}) {
  const out = { k: 0, n: 0, indexes: [], outcomes: [] };
  if (!(stopDistanceAtr > 0) || !Array.isArray(candles) || !Array.isArray(atrSeries) || !Number.isInteger(from) || !Number.isInteger(to)) return out;
  for (const idx of sampleIndexes(from, to, samples, seed)) {
    const atrAt = atrSeries[idx];
    const entry = candles[idx]?.close;
    const stop = atrAt > 0 && entry > 0 ? entry - stopDistanceAtr * atrAt : null;
    const label = stop > 0
      ? labelCandidate(candles, { firstDetectedIndex: idx, firstDetectedPrice: entry, firstDetectedAtr: atrAt, invalidation: stop }, { horizonBars, targetAtr })
      : null;
    const outcome = label?.outcome ?? null;
    out.indexes.push(idx);
    out.outcomes.push(outcome);
    if (outcome === 'SUCCESS' || outcome === 'FAIL' || outcome === 'TIMEOUT') {
      out.n += 1;
      if (outcome === 'SUCCESS') out.k += 1;
    }
  }
  return out;
}

/**
 * Replay satu seri. Semua candle `candles` dianggap tertutup (isClosed true), urut naik; `higher` = HTF nyata bila
 * ada (dipotong closeTime ≤ t per candle), bila tidak diagregasi dari candle dasar. Mesin: `evaluate`/`transition`/
 * `resolveParams`/`requiredCandles` disuntikkan; yang tidak diberikan diambil dari ./index.js (lihat engineDeps).
 *
 * @param {{
 *   symbol: string, timeframe: '5m'|'15m'|'1h', candles: object[], higher?: Record<string, object[]>, params?: object,
 *   liquidity?: object, horizonBars?: number, targetAtr?: number, warmupBars?: number, lookback?: number,
 *   requiredCandles?: Function|number, evaluate?: Function, transition?: Function, resolveParams?: Function,
 *   oldScanner?: boolean, oldMode?: 'full'|'fast', oldParams?: object, oldAnalyze?: Function,
 *   yieldEvery?: number, yieldToEventLoop?: () => Promise<void>,
 *   onEvaluation?: (index: number, evaluation: object, step: { next: object, events: object[] }) => void,
 * }} input
 * @returns {Promise<{
 *   symbol: string, timeframe: string, bars: number, warmup: number, horizonBars: number, targetAtr: number, evaluations: number,
 *   candidates: object[], old: object, baseline: { samples: number, atrPeriod: number }, provisionalFree: true, counts: object,
 *   classifications: Record<string, number>, evaluationStages: Record<string, number>, evidenceCounts: Record<string, number>,
 *   anomalies: Record<string, number>, params: object,
 * }>} kandidat juga membawa leadVsOldNearest, stopDistanceAtr, baselineRandomWalk, baselineShuffled (lihat openCandidate)
 */
export async function replayReversalSeries({
  symbol, timeframe, candles, higher = {}, params = {}, liquidity,
  horizonBars = REPLAY_DEFAULTS.horizonBars, targetAtr = REPLAY_DEFAULTS.targetAtr,
  warmupBars = REPLAY_DEFAULTS.warmupBars, lookback = REPLAY_DEFAULTS.lookback, requiredCandles: requiredCandlesIn,
  evaluate: evaluateIn, transition: transitionIn, resolveParams: resolveParamsIn,
  oldScanner = REPLAY_DEFAULTS.oldScanner, oldMode = REPLAY_DEFAULTS.oldMode, oldParams = {}, oldAnalyze = analyzeAt,
  yieldEvery = REPLAY_DEFAULTS.yieldEvery, yieldToEventLoop = () => nextMacrotask(), onEvaluation,
} = {}) {
  assertTimeframe(timeframe);
  assertCandles(candles);
  assertPositiveInt('horizonBars', horizonBars, 5000);
  assertPositiveInt('warmupBars', warmupBars, 5000);
  assertPositiveInt('lookback', lookback, 5000);
  assertPositiveInt('yieldEvery', yieldEvery, 100_000);
  if (!(targetAtr > 0)) throw new RangeError('targetAtr harus > 0');
  const { evaluate, transition, resolveParams, requiredCandles } = engineDeps({ evaluate: evaluateIn, transition: transitionIn, resolveParams: resolveParamsIn, requiredCandles: requiredCandlesIn });
  if (typeof evaluate !== 'function' || typeof transition !== 'function') throw new TypeError('evaluate dan transition harus fungsi');
  if (typeof symbol !== 'string' || symbol === '') throw new TypeError('symbol harus string');
  const resolved = resolveEngineParams(resolveParams, params, timeframe);
  const warmup = resolveWarmup({ warmupBars, requiredCandles, resolved });
  const oldEnabled = oldScanner === true;
  const oldParamsResolved = oldEnabled ? oldParamsFor(oldMode, oldParams) : null;
  if (oldEnabled && typeof oldAnalyze !== 'function') throw new TypeError('oldAnalyze harus fungsi');

  const htf = contextSeries(timeframe, candles, higher);
  const cursors = Object.entries(htf).map(([tf, list]) => [tf, htfCursor(list, lookback)]);

  const candidates = [];
  const classifications = {};
  const evaluationStages = {};
  const evidenceCounts = {}; // jumlah evaluasi yang meloloskan tiap id bukti (untuk tabel frekuensi bukti per skenario)
  const anomalies = { openWithoutEvent: 0, terminalWithoutEvent: 0, openedWhileOpen: 0, stageUpWithoutCandidate: 0, closeWithoutCandidate: 0 };
  const old = {
    enabled: oldEnabled, mode: oldEnabled ? oldMode : null, evaluations: 0, signals: 0, alerts: 0,
    firstSignalIndex: null, firstSignalTime: null, firstSignalState: null,
    firstAlertIndex: null, firstAlertTime: null, firstAlertState: null,
    signalIndexes: [], // indeks mulai SEMUA sinyal lama (untuk lead per peristiwa pada seri multi-peristiwa)
  };
  let snapshot = null;
  let current = null;
  let oldPrev = null;
  let evaluations = 0;

  for (let i = warmup; i < candles.length; i += 1) {
    const last = candles[i];
    const window = candles.slice(Math.max(0, i + 1 - lookback), i + 1);
    const higherAt = {};
    for (const [tf, at] of cursors) higherAt[tf] = at(last.closeTime);

    const evaluation = evaluate({
      candles: window, timeframe, higher: higherAt, provisional: false, params, ...(liquidity === undefined ? {} : { liquidity }),
    });
    evaluations += 1;
    const cls = evaluation?.classification ?? 'UNKNOWN';
    classifications[cls] = (classifications[cls] ?? 0) + 1;
    const stageKey = evaluation?.stage ?? 'none';
    evaluationStages[stageKey] = (evaluationStages[stageKey] ?? 0) + 1;
    for (const id of evidenceIds(evaluation)) evidenceCounts[id] = (evidenceCounts[id] ?? 0) + 1;

    const step = transition(snapshot, { candle: last, evaluation, timeframe }, params);
    if (!step || typeof step !== 'object' || !step.next || typeof step.next !== 'object') {
      throw new TypeError(`transition harus mengembalikan { next, events } (indeks ${i})`);
    }
    const next = step.next;
    const events = Array.isArray(step.events) ? step.events : [];
    if (onEvaluation) onEvaluation(i, evaluation, { next, events });

    for (const event of events) {
      const ctx = { index: i, candle: last, evaluation, next, event };
      switch (event?.type) {
        case 'OPENED':
          if (current) {
            // Anomali kontrak: kandidat baru dibuka saat yang lama belum ditutup — tutup yang lama agar tidak hilang.
            anomalies.openedWhileOpen += 1;
            closeCandidate(current, { ...ctx, event: { toStatus: current.status, reason: 'REPLACED_BY_NEW_CANDIDATE' }, next: null });
          }
          current = openCandidate({ ...ctx, ordinal: candidates.length + 1, symbol, timeframe });
          candidates.push(current);
          break;
        case 'STAGE_UP':
          if (current) stageUp(current, ctx);
          else anomalies.stageUpWithoutCandidate += 1;
          break;
        case 'CANCELLED':
        case 'EXPIRED':
          if (current) {
            closeCandidate(current, ctx);
            current = null;
          } else {
            anomalies.closeWithoutCandidate += 1;
          }
          break;
        default:
          break; // PROVISIONAL_STAGE tidak pernah muncul di replay (tanpa candle berjalan); tipe lain diabaikan
      }
    }
    // Konsistensi snapshot ↔ event (anomali dicatat, data tidak hilang).
    if (!current && OPEN_STATUSES.includes(next.status)) {
      anomalies.openWithoutEvent += 1;
      current = openCandidate({ index: i, candle: last, evaluation, next, event: null, ordinal: candidates.length + 1, symbol, timeframe });
      candidates.push(current);
    } else if (current && TERMINAL_STATUSES.includes(next.status)) {
      anomalies.terminalWithoutEvent += 1;
      closeCandidate(current, { index: i, candle: last, next, event: null });
      current = null;
    }
    if (current) {
      if ((STAGE_RANK[next.stage] ?? 0) > (STAGE_RANK[current.lastStage] ?? 0) && !current.stages.some((s) => s.stage === next.stage)) {
        // Tahap naik tanpa event STAGE_UP (anomali ringan) — tetap dicatat agar urutan tahap lengkap.
        stageUp(current, { index: i, candle: last, next, event: null });
      }
      if (current.barsToTrigger === null && evidenceIds(evaluation).includes('TRIGGER_BREAK')) current.barsToTrigger = i - current.firstDetectedIndex;
    }
    snapshot = next;

    if (oldEnabled) {
      const r = oldAnalyze({
        symbol, timeframe, candlesByTimeframe: { [timeframe]: window, ...higherAt }, prev: oldPrev, params: oldParamsResolved, direction: 'LONG',
      });
      old.evaluations += 1;
      const ev = r?.event ?? null;
      if (ev && ev.fromState === 'NO_PATTERN' && LONG_PATTERN_STATES.includes(ev.toState)) {
        old.signals += 1;
        old.signalIndexes.push(i);
        if (old.firstSignalIndex === null) Object.assign(old, { firstSignalIndex: i, firstSignalTime: last.closeTime, firstSignalState: ev.toState });
      }
      if (ev && ALERT_STATES.includes(ev.toState)) {
        old.alerts += 1;
        if (old.firstAlertIndex === null) Object.assign(old, { firstAlertIndex: i, firstAlertTime: last.closeTime, firstAlertState: ev.toState });
      }
      oldPrev = r && LONG_PATTERN_STATES.includes(r.next?.state) ? r.next : null;
    }

    if ((i - warmup) % yieldEvery === yieldEvery - 1) await yieldToEventLoop();
  }

  // ATR Wilder untuk basis empiris dihitung sekali per seri (malas: hanya bila ada kandidat berlabel).
  let atrCache = null;
  const atrSeries = () => (atrCache ??= atr(candles, BASELINE_DEFAULTS.atrPeriod));
  const baselineTo = candles.length - 1 - horizonBars;
  for (const c of candidates) {
    if (c.closeIndex === null) c.barsOpen = candles.length - 1 - c.firstDetectedIndex;
    Object.assign(c, labelCandidate(candles, c, { horizonBars, targetAtr }));
    c.leadVsBreakout = breakoutLead(candles, c, horizonBars);
    c.leadVsOld = old.firstSignalIndex === null ? null : old.firstSignalIndex - c.firstDetectedIndex;
    c.leadVsOldAlert = old.firstAlertIndex === null ? null : old.firstAlertIndex - c.firstDetectedIndex;
    c.leadVsOldNearest = oldEnabled ? nearestOldLead(old.signalIndexes, c.firstDetectedIndex, horizonBars) : null;
    // Jarak stop (ATR deteksi) = level yang benar-benar dipakai pelabelan (stopPrice); basis hanya untuk kandidat berlabel.
    if (c.outcome !== null && c.stopPrice > 0) c.stopDistanceAtr = (c.firstDetectedPrice - c.stopPrice) / c.firstDetectedAtr;
    if ((c.outcome === 'SUCCESS' || c.outcome === 'FAIL' || c.outcome === 'TIMEOUT') && c.stopDistanceAtr > 0) {
      c.baselineRandomWalk = c.stopDistanceAtr / (targetAtr + c.stopDistanceAtr);
      c.baselineShuffled = shuffledBaseline(candles, {
        stopDistanceAtr: c.stopDistanceAtr, atrSeries: atrSeries(), from: warmup, to: baselineTo, seed: `${symbol}|${timeframe}|basis|${c.id}`, horizonBars, targetAtr,
      });
    }
  }
  const counts = {
    opened: candidates.length,
    cancelled: candidates.filter((c) => c.status === 'CANCELLED').length,
    expired: candidates.filter((c) => c.status === 'EXPIRED').length,
    open: candidates.filter((c) => c.closeIndex === null).length,
    confirmed: candidates.filter((c) => c.stages.some((s) => s.stage === 'CONFIRMED_BREAKOUT')).length,
  };
  return {
    symbol, timeframe, bars: candles.length, warmup, horizonBars, targetAtr, evaluations, candidates, old,
    baseline: { samples: BASELINE_DEFAULTS.samples, atrPeriod: BASELINE_DEFAULTS.atrPeriod },
    provisionalFree: true, counts, classifications, evaluationStages, evidenceCounts, anomalies, params: resolved,
  };
}

/**
 * Replay banyak seri: `candles` = { [symbol]: { [timeframe]: Candle[] } } (termasuk HTF bila ada).
 * `describe(symbol, timeframe)` menambah metadata (mis. { scenario, seed }) ke hasil tiap seri.
 * @returns {Promise<{ series: object[], evaluations: number, elapsedMs: number }>}
 */
export async function replayReversalUniverse({ candles, timeframes = REVERSAL_TIMEFRAMES, describe = () => ({}), onProgress = () => {}, ...options } = {}) {
  if (!candles || typeof candles !== 'object') throw new TypeError('candles harus objek { [symbol]: { [timeframe]: Candle[] } }');
  const series = [];
  let evaluations = 0;
  const started = Date.now();
  for (const [symbol, byTf] of Object.entries(candles)) {
    for (const timeframe of timeframes) {
      const base = byTf?.[timeframe];
      if (!Array.isArray(base) || base.length === 0) continue;
      const higher = {};
      for (const htf of HIGHER_TIMEFRAMES[timeframe] ?? []) if (Array.isArray(byTf[htf])) higher[htf] = byTf[htf];
      const t0 = Date.now();
      const res = await replayReversalSeries({ ...options, symbol, timeframe, candles: base, higher });
      Object.assign(res, describe(symbol, timeframe) ?? {});
      evaluations += res.evaluations;
      series.push(res);
      onProgress({ symbol, timeframe, evaluations: res.evaluations, candidates: res.candidates.length, elapsedMs: Date.now() - t0 });
    }
  }
  return { series, evaluations, elapsedMs: Date.now() - started };
}

/** Bentuk kanonik untuk perbandingan: kunci terurut, fungsi/undefined → null, ±Infinity/NaN → string. */
function canonical(value) {
  const norm = (v) => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])]));
    if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
    if (typeof v === 'function' || v === undefined) return null;
    return v;
  };
  return JSON.stringify(norm(value));
}

/** Jalur perbedaan pertama antara dua nilai (untuk pesan kesalahan), null bila sama. */
export function firstDifference(a, b, path = '$') {
  if (a === b) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return { path: `${path}.length`, replay: a.length, prefix: b.length };
    for (let i = 0; i < a.length; i += 1) {
      const d = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) {
      const d = firstDifference(a[k], b[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return { path, replay: a, prefix: b };
}

/** Proyeksi kandidat sampai indeks k: hanya fakta yang sudah dapat diketahui pada candle k. */
function projectCandidates(candidates, k) {
  return candidates.filter((c) => c.firstDetectedIndex <= k).map((c) => ({
    firstDetectedIndex: c.firstDetectedIndex,
    firstStage: c.firstStage,
    firstScore: c.firstScore,
    firstEvidenceCount: c.firstEvidenceCount,
    invalidation: c.invalidation,
    stages: c.stages.filter((s) => s.index <= k),
    closeIndex: c.closeIndex !== null && c.closeIndex <= k ? c.closeIndex : null,
    closeReason: c.closeIndex !== null && c.closeIndex <= k ? c.closeReason : null,
  }));
}

/** Pilih `count` indeks berbeda di [from, to] secara deterministik (PRNG berbenih), urut naik. */
function sampleIndexes(from, to, count, seed) {
  const span = to - from + 1;
  if (span <= 0) return [];
  if (count >= span) return Array.from({ length: span }, (_, i) => from + i);
  const rng = createRng(seed);
  const picked = new Set();
  while (picked.size < count) picked.add(from + Math.floor(rng() * span));
  return [...picked].sort((a, b) => a - b);
}

/**
 * Uji stabilitas prefiks / anti-look-ahead (docs/19 §3.2): hasil replay pada candle k harus identik dengan evaluasi
 * pada prefiks `candles.slice(0, k+1)` yang dibangun ulang dari nol — HTF ikut dipotong/diagregasi hanya dari prefiks
 * — SETELAH replay penuh dijalankan (sehingga fungsi evaluasi yang menyimpan keadaan lintas panggilan atau harness
 * yang membocorkan HTF masa depan ketahuan). Untuk `prefixReplays` indeks terbesar, replay pada prefiks juga
 * dibandingkan: kandidat/tahap/penutupan sampai k tidak boleh berubah saat candle masa depan ditambahkan.
 * @returns {Promise<{ ok: true, samples: number[], prefixReplayIndexes: number[], evaluations: number }>}
 * @throws {LookaheadError} dengan `details` { index, path, replay, prefix }
 */
export async function assertNoLookahead({
  candles, timeframe, higher = {}, params = {}, liquidity, symbol = candles?.[0]?.symbol ?? 'REPLAY',
  evaluate: evaluateIn, transition: transitionIn, resolveParams: resolveParamsIn, requiredCandles: requiredCandlesIn,
  samples = 5, seed = 1, prefixReplays = 1, warmupBars = REPLAY_DEFAULTS.warmupBars, lookback = REPLAY_DEFAULTS.lookback,
  horizonBars = REPLAY_DEFAULTS.horizonBars,
} = {}) {
  assertTimeframe(timeframe);
  assertCandles(candles);
  if (!Number.isInteger(samples) || samples < 1) throw new RangeError('samples harus bilangan bulat ≥ 1');
  if (!Number.isInteger(prefixReplays) || prefixReplays < 0) throw new RangeError('prefixReplays harus bilangan bulat ≥ 0');
  const { evaluate, transition, resolveParams, requiredCandles } = engineDeps({ evaluate: evaluateIn, transition: transitionIn, resolveParams: resolveParamsIn, requiredCandles: requiredCandlesIn });
  if (typeof evaluate !== 'function' || typeof transition !== 'function') throw new TypeError('evaluate dan transition harus fungsi');
  const resolved = resolveEngineParams(resolveParams, params, timeframe);
  const warmup = resolveWarmup({ warmupBars, requiredCandles, resolved });
  const indexes = sampleIndexes(warmup, candles.length - 1, samples, seed);
  if (indexes.length === 0) throw new RangeError(`Seri terlalu pendek untuk uji prefiks (butuh > ${warmup} candle)`);
  const wanted = new Set(indexes);
  const captured = new Map();
  const common = { timeframe, params, liquidity, symbol, evaluate, transition, resolveParams, requiredCandles, warmupBars, lookback, horizonBars, oldScanner: false };

  // 1) Replay penuh lebih dulu (mengisi cache/keadaan apa pun yang mungkin disimpan mesin).
  const full = await replayReversalSeries({ ...common, candles, higher, onEvaluation: (i, ev) => { if (wanted.has(i)) captured.set(i, canonical(ev)); } });

  // 2) Evaluasi ulang pada prefiks yang dibangun dari nol.
  const truncatedHigher = (prefix) => {
    const t = prefix.at(-1).closeTime;
    const out = {};
    for (const htf of HIGHER_TIMEFRAMES[timeframe]) {
      const given = higher?.[htf];
      out[htf] = Array.isArray(given) && given.length ? given.filter((c) => c.isClosed === true && c.closeTime <= t) : aggregateCandles(prefix, htf);
    }
    return out;
  };
  for (const k of indexes) {
    const prefix = candles.slice(0, k + 1);
    const htf = truncatedHigher(prefix);
    const higherAt = Object.fromEntries(Object.entries(htf).map(([tf, list]) => [tf, list.slice(Math.max(0, list.length - lookback))]));
    const ev = evaluate({
      candles: prefix.slice(Math.max(0, prefix.length - lookback)), timeframe, higher: higherAt, provisional: false, params,
      ...(liquidity === undefined ? {} : { liquidity }),
    });
    const a = captured.get(k);
    const b = canonical(ev);
    if (a !== b) {
      const diff = firstDifference(JSON.parse(a), JSON.parse(b));
      throw new LookaheadError(
        `Look-ahead/ketidakstabilan prefiks pada ${symbol} ${timeframe} candle #${k}: hasil replay ≠ evaluasi prefiks di ${diff?.path ?? '?'} `
        + `(replay: ${JSON.stringify(diff?.replay)}, prefiks: ${JSON.stringify(diff?.prefix)})`,
        { index: k, path: diff?.path ?? null, replay: diff?.replay, prefix: diff?.prefix },
      );
    }
  }

  // 3) Replay pada prefiks: kandidat sampai k harus identik.
  const prefixReplayIndexes = indexes.slice(-prefixReplays);
  for (const k of prefixReplayIndexes) {
    const prefix = candles.slice(0, k + 1);
    const part = await replayReversalSeries({ ...common, candles: prefix, higher: truncatedHigher(prefix) });
    const a = projectCandidates(full.candidates, k);
    const b = projectCandidates(part.candidates, k);
    const diff = firstDifference(JSON.parse(canonical(a)), JSON.parse(canonical(b)));
    if (diff) {
      throw new LookaheadError(
        `Kandidat berubah saat candle masa depan ditambahkan (${symbol} ${timeframe}, prefiks sampai #${k}) di ${diff.path} `
        + `(replay penuh: ${JSON.stringify(diff.replay)}, prefiks: ${JSON.stringify(diff.prefix)})`,
        { index: k, path: diff.path, replay: diff.replay, prefix: diff.prefix },
      );
    }
  }
  return { ok: true, samples: indexes, prefixReplayIndexes, evaluations: full.evaluations };
}
