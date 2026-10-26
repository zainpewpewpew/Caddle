// Mesin "Reversal Radar" PALSU & deterministik untuk menguji harness replay (backend/reversal/replay.js), laporan,
// dan CLI TANPA mesin asli (agent A). Bentuk keluaran mengikuti docs/19 §3 (ReversalEvaluation) dan §4
// (ReversalSnapshot/ReversalEvent) secukupnya untuk harness. Heuristiknya sengaja sederhana dan BUKAN acuan aturan
// detektor asli; yang diuji adalah mekanisme replay (urutan, histeresis, pelabelan, anti-look-ahead), bukan akurasi.
import { atr as atrSeries, ema } from '../../backend/indicators/index.js';
import { TIMEFRAME_MS } from '../../backend/market/contracts.js';
import { EVIDENCE_GROUP_OF, EVIDENCE_WEIGHTS, OPEN_STATUSES, STAGE_RANK, STATUS_OF_STAGE } from '../../backend/reversal/constants.js';
import { SYNTHETIC_START } from '../fixtures/candles/synthetic.js';

export const FAKE_PARAMS = Object.freeze({
  requiredCandles: 150,
  enterConfirmBars: Object.freeze({ '5m': 2, '15m': 1, '1h': 1 }),
  expiryBars: Object.freeze({ EARLY_FORMATION: 48, DEVELOPING_REVERSAL: 36, CONFIRMED_BREAKOUT: 24 }),
  weakBarsLimit: 6,
  bottomLookback: 60,
  declineLookback: 120,
  minDeclineAtr: 3,
  minDeclinePct: 0.06,
  minBottomAge: 3,
  invalidationBufferAtr: 0.25,
  lateAtr: 4,
  breakRvol: 1.5,
  minAvgQuoteVolume: Object.freeze({ '5m': 20_000, '15m': 60_000, '1h': 240_000 }),
});

export function fakeResolveParams(overrides = {}, timeframe = '15m') {
  return Object.freeze({ ...FAKE_PARAMS, ...overrides, timeframe });
}

export function fakeRequiredCandles(params = FAKE_PARAMS) {
  return params.requiredCandles ?? FAKE_PARAMS.requiredCandles;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

const EMPTY_LEVELS = Object.freeze({ bottom: null, lastSwingLow: null, higherLow: null, trigger: null, ema25: null, ema7: null, atr: null, invalidation: null });

function baseEvaluation({ last, timeframe, provisional, classification, extra = {} }) {
  return {
    version: 1,
    timeframe,
    provisional,
    candleOpenTime: last.openTime,
    evaluatedAt: last.closeTime,
    classification,
    stage: null,
    setupType: null,
    setupTypes: [],
    context: {
      priorDecline: { ok: false, declinePct: null, declineAtr: null, highIndex: null, bottomIndex: null, bottomPrice: null, barsSinceBottom: null, ema25Falling: null },
      htf: { timeframe: null, trend: null, detail: 'tidak dinilai (mesin palsu)' },
      liquidityClass: 'UNKNOWN',
    },
    checks: [],
    evidence: [],
    evidenceCount: 0,
    score: { total: 0, components: [] },
    levels: { ...EMPTY_LEVELS },
    nextConfirmation: { kind: 'NONE', text: '', level: null },
    cancelCondition: { text: '', level: null },
    risks: [],
    markers: [],
    measures: {},
    ...extra,
  };
}

/** Masalah kualitas data pada jendela: candle rusak, gap waktu, atau ≥ 3 candle volume nol beruntun. */
export function fakeDataQuality(candles, timeframe) {
  const ms = TIMEFRAME_MS[timeframe];
  let streak = 0;
  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i];
    if (!(c.high >= Math.max(c.open, c.close)) || !(c.low <= Math.min(c.open, c.close)) || !(c.low > 0)) return 'INVALID_CANDLE';
    if (i > 0 && c.openTime - candles[i - 1].openTime !== ms) return 'TIME_GAP';
    streak = c.volume === 0 ? streak + 1 : 0;
    if (streak >= 3) return 'ZERO_VOLUME_STREAK';
  }
  return null;
}

/**
 * Evaluasi heuristik murni dari jendela candle (fungsi dari input saja — tanpa keadaan lintas panggilan).
 * Bukti yang dinilai: LL_STOPPED, ATR_CONTRACTION, VOLUME_DRY_UP, HIGHER_LOW, EMA25_RECLAIM, TRIGGER_BREAK,
 * BREAK_VOLUME_SUPPORT. Tahap mengikuti aturan docs/19 §3.1 ("Tahap pada evaluasi") atas bukti tersebut.
 */
export function fakeEvaluate({ candles, timeframe, higher = {}, provisional = false, params = {}, liquidity } = {}) {
  if (!Array.isArray(candles) || candles.length === 0) throw new TypeError('candles wajib ada');
  const p = fakeResolveParams(params, timeframe);
  const L = candles.length - 1;
  const last = candles[L];
  if (!provisional && last.isClosed !== true) throw new RangeError('Candle terakhir harus tertutup bila provisional=false');
  if (candles.length < p.requiredCandles) return baseEvaluation({ last, timeframe, provisional, classification: 'INSUFFICIENT_DATA' });
  const issue = fakeDataQuality(candles.slice(-p.requiredCandles), timeframe);
  if (issue) return baseEvaluation({ last, timeframe, provisional, classification: 'DATA_QUALITY', extra: { risks: ['DATA_QUALITY'], measures: { issue } } });

  const closes = candles.map((c) => c.close);
  const atr = atrSeries(candles, 14);
  const ema25 = ema(closes, 25);
  const from = Math.max(0, L - p.bottomLookback + 1);
  let bottomIndex = from;
  for (let i = from; i <= L; i += 1) if (candles[i].low < candles[bottomIndex].low) bottomIndex = i;
  const bottomLow = candles[bottomIndex].low;
  const topFrom = Math.max(0, bottomIndex - p.declineLookback);
  let highIndex = topFrom;
  for (let i = topFrom; i <= bottomIndex; i += 1) if (closes[i] > closes[highIndex]) highIndex = i;
  const atrBottom = atr[bottomIndex] ?? atr[L];
  const declineAtr = atrBottom > 0 ? (closes[highIndex] - bottomLow) / atrBottom : null;
  const declinePct = closes[highIndex] > 0 ? (closes[highIndex] - bottomLow) / closes[highIndex] : null;
  const barsSinceBottom = L - bottomIndex;
  const brokenBottom = closes.slice(bottomIndex + 1).some((c) => c < bottomLow);
  const ok = (declineAtr >= p.minDeclineAtr || declinePct >= p.minDeclinePct) && barsSinceBottom >= p.minBottomAge && !brokenBottom;
  const ema25Rising = ema25[L] !== null && ema25[L - 5] !== null && ema25[L] >= ema25[L - 5];
  const atrNow = atr[L];
  const priorDecline = { ok, declinePct, declineAtr, highIndex, bottomIndex, bottomPrice: bottomLow, barsSinceBottom, ema25Falling: ema25Rising === null ? null : !ema25Rising };

  const avgQuote = mean(candles.slice(-50).map((c) => c.quoteVolume));
  let liquidityClass = 'UNKNOWN';
  const minQv = liquidity?.thresholds?.minQuoteVolume24h ?? 50_000_000;
  if (Number.isFinite(liquidity?.quoteVolume24h)) liquidityClass = liquidity.quoteVolume24h >= minQv ? 'LIQUID' : liquidity.quoteVolume24h >= 0.25 * minQv ? 'THIN' : 'ILLIQUID';
  else if (avgQuote !== null && avgQuote < p.minAvgQuoteVolume[timeframe]) liquidityClass = 'ILLIQUID';

  const htfKeys = Object.keys(higher ?? {});
  const htfList = htfKeys.length ? higher[htfKeys.at(-1)] : [];
  let htfTrend = null;
  if (Array.isArray(htfList) && htfList.length >= 30) {
    const h = ema(htfList.map((c) => c.close), 25);
    const hl = htfList.length - 1;
    htfTrend = h[hl] < h[hl - 3] && htfList[hl].close < h[hl] ? 'BEARISH' : h[hl] > h[hl - 3] && htfList[hl].close > h[hl] ? 'BULLISH' : 'NEUTRAL';
  }
  const context = { priorDecline, htf: { timeframe: htfKeys.at(-1) ?? null, trend: htfTrend, detail: htfTrend ? `tren HTF ${htfTrend}` : 'HTF tidak cukup' }, liquidityClass };

  if (!ok) {
    const classification = !brokenBottom && ema25Rising && last.close > ema25[L] && !(declineAtr >= p.minDeclineAtr) ? 'CONTINUATION' : 'NO_SETUP';
    return baseEvaluation({ last, timeframe, provisional, classification, extra: { context, levels: { ...EMPTY_LEVELS, bottom: bottomLow, atr: atrNow, ema25: ema25[L] } } });
  }

  const evidence = [];
  const add = (id, value, threshold, detail) => evidence.push({ id, group: EVIDENCE_GROUP_OF[id], label: id, detail, passed: true, value, threshold, weight: EVIDENCE_WEIGHTS[id], index: null, time: null, price: null });
  if (barsSinceBottom >= 8 && last.close > bottomLow) add('LL_STOPPED', barsSinceBottom, 8, 'tidak ada low baru di bawah dasar');
  if (atr[L - 20] > 0 && atrNow / atr[L - 20] <= 0.8) add('ATR_CONTRACTION', atrNow / atr[L - 20], 0.8, 'ATR mengecil');
  const vol10 = mean(candles.slice(-10).map((c) => c.volume));
  const vol30 = mean(candles.slice(-40, -10).map((c) => c.volume));
  if (liquidityClass !== 'ILLIQUID' && vol30 > 0 && vol10 <= 0.7 * vol30) add('VOLUME_DRY_UP', vol10 / vol30, 0.7, 'volume mengering');
  if (barsSinceBottom >= 20) {
    const lowsNow = Math.min(...candles.slice(-10).map((c) => c.low));
    const lowsPrev = Math.min(...candles.slice(-20, -10).map((c) => c.low));
    if (lowsNow > lowsPrev && lowsPrev >= bottomLow) add('HIGHER_LOW', lowsNow, lowsPrev, 'higher low');
  }
  if (ema25[L] !== null && last.close > ema25[L] && closes.slice(-11, -1).some((c, k) => c <= ema25[L - 10 + k])) add('EMA25_RECLAIM', last.close, ema25[L], 'merebut EMA25');
  const trigger = bottomIndex < L ? Math.max(...candles.slice(bottomIndex, L).map((c) => c.high)) : null;
  const rvol = (() => {
    const prev = candles.slice(Math.max(0, L - 20), L).map((c) => c.volume);
    const m = mean(prev);
    return m > 0 ? last.volume / m : null;
  })();
  if (trigger !== null && last.close > trigger) {
    add('TRIGGER_BREAK', last.close, trigger, 'close di atas pemicu');
    if (rvol !== null && rvol >= p.breakRvol) add('BREAK_VOLUME_SUPPORT', rvol, p.breakRvol, 'RVOL mendukung');
  }
  const ids = evidence.map((e) => e.id);
  const groupCount = (groups) => evidence.filter((e) => groups.includes(e.group)).length;
  const nonTrigger = evidence.filter((e) => e.group !== 'TRIGGER').length;
  const early = groupCount(['EXHAUSTION', 'BASE', 'VOLUME']) >= 2 && groupCount(['EXHAUSTION', 'BASE']) >= 1;
  const developing = early && groupCount(['STRUCTURE']) >= 1 && evidence.length >= 3;
  const confirmed = ids.includes('TRIGGER_BREAK') && ids.includes('BREAK_VOLUME_SUPPORT') && nonTrigger >= 2;
  const stage = confirmed ? 'CONFIRMED_BREAKOUT' : developing ? 'DEVELOPING_REVERSAL' : early ? 'EARLY_FORMATION' : null;
  const total = Math.min(100, evidence.reduce((a, e) => a + e.weight, 0));
  const groups = ['EXHAUSTION', 'BASE', 'STRUCTURE', 'VOLUME', 'TRIGGER'];
  const components = groups.map((g) => ({ id: g, label: g, points: evidence.filter((e) => e.group === g).reduce((a, e) => a + e.weight, 0), max: 25 }));
  let invalidation = atrNow > 0 ? bottomLow - p.invalidationBufferAtr * atrNow : null;
  if (!(invalidation > 0) || !(invalidation < last.close)) invalidation = null;
  const risks = [];
  if (htfTrend === 'BEARISH') risks.push('HTF_DOWNTREND');
  if (htfTrend === null) risks.push('HTF_UNKNOWN');
  if (liquidityClass === 'ILLIQUID') risks.push('ILLIQUID');
  if (atrNow > 0 && (last.close - bottomLow) / atrNow >= p.lateAtr) risks.push('LATE_ENTRY');
  if (provisional) risks.push('PROVISIONAL');
  const setupTypes = [...(ids.includes('HIGHER_LOW') ? ['HIGHER_LOW_BASE'] : []), ...(ids.includes('ATR_CONTRACTION') ? ['COMPRESSION'] : [])];
  return baseEvaluation({
    last, timeframe, provisional, classification: 'REVERSAL_CANDIDATE',
    extra: {
      stage, setupType: setupTypes[0] ?? null, setupTypes, context,
      checks: evidence, evidence, evidenceCount: evidence.length, score: { total, components },
      levels: { ...EMPTY_LEVELS, bottom: bottomLow, trigger, ema25: ema25[L], atr: atrNow, invalidation },
      nextConfirmation: { kind: stage === 'CONFIRMED_BREAKOUT' ? 'HOLD_ABOVE_TRIGGER' : stage ? 'TRIGGER_BREAK' : 'NONE', text: '', level: trigger },
      cancelCondition: { text: 'close di bawah level invalidasi', level: invalidation },
      risks, measures: { declineAtr, barsSinceBottom, rvol },
    },
  });
}

function makeEvent({ type, candle, fromStage, toStage, fromStatus, toStatus, reason, detail = {} }) {
  return { type, fromStage, toStage, fromStatus, toStatus, candleTime: candle.openTime, occurredAt: candle.closeTime, price: candle.close, reason: reason ?? null, provisional: false, detail };
}

/**
 * State machine palsu dengan histeresis docs/19 §4: masuk/naik tahap butuh enterConfirmBars candle berurutan,
 * keluar hanya CANCELLED (close < invalidasi) atau EXPIRED (tanpa kemajuan / bukti melemah). Tidak ada downgrade.
 * Snapshot dengan status 'NONE' membawa pendingStage/pendingBars, sehingga harus diteruskan sebagai `prev`.
 */
export function fakeTransition(prev, { candle, evaluation, timeframe }, params = {}) {
  const p = fakeResolveParams(params, timeframe);
  const confirm = p.enterConfirmBars[timeframe] ?? 1;
  if (prev && Number.isFinite(prev.lastCandleTime) && candle.openTime <= prev.lastCandleTime) return { next: prev, events: [], alert: false };
  const stamp = { version: 1, timeframe, lastCandleTime: candle.openTime, lastEvaluatedAt: candle.closeTime };
  const isOpen = Boolean(prev && OPEN_STATUSES.includes(prev.status));
  const ids = evaluation.evidence.map((e) => e.id);

  if (!isOpen) {
    const stage = evaluation.classification === 'REVERSAL_CANDIDATE' ? evaluation.stage : null;
    const inv = evaluation.levels?.invalidation ?? null;
    if (!stage || (inv !== null && candle.close <= inv)) {
      return { next: { ...stamp, stage: null, status: 'NONE', pendingStage: null, pendingBars: 0, closeReason: null }, events: [], alert: false };
    }
    const pendingBars = (prev?.pendingStage === stage ? prev.pendingBars : 0) + 1;
    if (pendingBars < confirm) {
      return { next: { ...stamp, stage: null, status: 'NONE', pendingStage: stage, pendingBars, closeReason: null }, events: [], alert: false };
    }
    const status = STATUS_OF_STAGE[stage];
    const next = {
      ...stamp, stage, status, setupType: evaluation.setupType, setupTypes: [...evaluation.setupTypes], classification: evaluation.classification,
      firstDetectedAt: candle.closeTime, firstDetectedPrice: candle.close, firstDetectedAtr: evaluation.levels.atr, firstStage: stage,
      stageEnteredAt: candle.closeTime, barsInStage: 0, barsSinceDetection: 0,
      score: evaluation.score.total, scoreComponents: evaluation.score.components, evidence: ids, evidenceCount: evaluation.evidenceCount,
      levels: { ...evaluation.levels }, nextConfirmation: evaluation.nextConfirmation, cancelCondition: evaluation.cancelCondition,
      risks: [...evaluation.risks], liquidityClass: evaluation.context.liquidityClass, markers: [],
      peakPrice: candle.close, peakStage: stage, moveSinceDetectionPct: 0, moveSinceDetectionAtr: 0, extended: false,
      pendingStage: null, pendingBars: 0, weakBars: 0, closeReason: null,
    };
    return { next, events: [makeEvent({ type: 'OPENED', candle, fromStage: null, toStage: stage, fromStatus: 'NONE', toStatus: status, reason: 'STAGE_EVIDENCE' })], alert: true };
  }

  const barsInStage = prev.barsInStage + 1;
  const barsSinceDetection = prev.barsSinceDetection + 1;
  const close = candle.close;
  const inv = prev.levels.invalidation;
  const terminal = (status, reason, type) => {
    const next = { ...prev, ...stamp, status, closeReason: reason, barsInStage, barsSinceDetection, pendingStage: null, pendingBars: 0 };
    return { next, events: [makeEvent({ type, candle, fromStage: prev.stage, toStage: prev.stage, fromStatus: prev.status, toStatus: status, reason })], alert: type === 'CANCELLED' && STAGE_RANK[prev.stage] >= 2 };
  };
  if (inv !== null && close < inv) {
    return terminal('CANCELLED', prev.stage === 'CONFIRMED_BREAKOUT' && prev.levels.trigger !== null && close < prev.levels.trigger - 0.75 * (prev.levels.atr ?? 0) ? 'BREAKOUT_FAILED' : 'CLOSE_BELOW_INVALIDATION', 'CANCELLED');
  }
  const evStage = evaluation.classification === 'REVERSAL_CANDIDATE' ? evaluation.stage : null;
  let pendingStage = null;
  let pendingBars = 0;
  if (evStage && STAGE_RANK[evStage] > STAGE_RANK[prev.stage]) {
    pendingStage = evStage;
    pendingBars = (prev.pendingStage === evStage ? prev.pendingBars : 0) + 1;
    if (pendingBars >= confirm) {
      const status = STATUS_OF_STAGE[evStage];
      const next = {
        ...prev, ...stamp, stage: evStage, status, stageEnteredAt: candle.closeTime, barsInStage: 0, barsSinceDetection,
        score: evaluation.score.total, evidence: ids, evidenceCount: evaluation.evidenceCount,
        levels: { ...evaluation.levels, invalidation: Math.max(inv ?? -Infinity, evaluation.levels.invalidation ?? -Infinity) === -Infinity ? null : Math.max(inv ?? -Infinity, evaluation.levels.invalidation ?? -Infinity) },
        peakPrice: Math.max(prev.peakPrice, candle.high), peakStage: evStage, pendingStage: null, pendingBars: 0, weakBars: 0,
      };
      return { next, events: [makeEvent({ type: 'STAGE_UP', candle, fromStage: prev.stage, toStage: evStage, fromStatus: prev.status, toStatus: status, reason: 'STAGE_EVIDENCE' })], alert: true };
    }
  }
  if (barsInStage >= p.expiryBars[prev.stage]) return terminal('EXPIRED', 'NO_PROGRESS', 'EXPIRED');
  const weakBars = evStage === null && evaluation.classification !== 'REVERSAL_CANDIDATE' ? (prev.weakBars ?? 0) + 1 : 0;
  if (weakBars >= p.weakBarsLimit) return terminal('EXPIRED', 'EVIDENCE_FADED', 'EXPIRED');
  const atr = prev.firstDetectedAtr;
  const moveAtr = atr > 0 ? (close - prev.firstDetectedPrice) / atr : 0;
  const movePct = (close - prev.firstDetectedPrice) / prev.firstDetectedPrice;
  const extended = moveAtr >= 2.5 || movePct >= 0.08;
  const risks = [...new Set([...evaluation.risks.filter((r) => r !== 'EXTENDED'), ...(extended ? ['EXTENDED'] : [])])];
  const newInv = evaluation.levels?.invalidation;
  const next = {
    ...prev, ...stamp, barsInStage, barsSinceDetection, score: evaluation.score.total, evidence: ids, evidenceCount: evaluation.evidenceCount,
    levels: { ...prev.levels, trigger: evaluation.levels?.trigger ?? prev.levels.trigger, invalidation: newInv !== null && newInv !== undefined && newInv > (inv ?? -Infinity) && newInv < close ? newInv : inv },
    peakPrice: Math.max(prev.peakPrice, candle.high), moveSinceDetectionAtr: moveAtr, moveSinceDetectionPct: movePct, extended, risks,
    pendingStage, pendingBars, weakBars,
  };
  return { next, events: [], alert: false };
}

/** Mesin palsu lengkap (dependensi untuk replayReversalSeries). */
export const fakeEngine = Object.freeze({
  evaluate: fakeEvaluate, transition: fakeTransition, resolveParams: fakeResolveParams, requiredCandles: fakeRequiredCandles,
});

/**
 * Mesin TERSKRIP untuk kasus buatan tangan: `stages[index]` = tahap evaluasi pada candle ke-index (indeks dari
 * startTime & timeframe), `levelsAt(index, candle)` = level (atr, invalidation, trigger, bottom). Transisi memakai
 * fakeTransition dengan enterConfirmBars 1 (deteksi = candle tempat tahap pertama muncul).
 */
export function createScriptedEngine({
  stages = {}, levelsAt = () => ({}), evidenceAt = null, startTime = SYNTHETIC_START, timeframe = '15m', score = 50,
  evidence = ['LL_STOPPED', 'ATR_CONTRACTION', 'HIGHER_LOW'], risks = [], classification = 'REVERSAL_CANDIDATE',
} = {}) {
  const ms = TIMEFRAME_MS[timeframe];
  const indexOf = (candle) => Math.round((candle.openTime - startTime) / ms);
  const evaluate = ({ candles, provisional = false }) => {
    const last = candles.at(-1);
    const index = indexOf(last);
    const stage = stages[index] ?? null;
    const lv = { atr: 1, invalidation: null, trigger: null, bottom: null, ...levelsAt(index, last) };
    const ev = baseEvaluation({
      last, timeframe, provisional, classification: stage ? classification : 'NO_SETUP',
      extra: { stage, levels: { ...EMPTY_LEVELS, ...lv }, score: { total: stage ? score : 0, components: [] }, risks: stage ? [...risks] : [], measures: { index } },
    });
    // evidenceAt(index) → id bukti pada candle itu (berlaku juga tanpa tahap, mis. TRIGGER_BREAK saat kandidat terbuka).
    const ids = typeof evidenceAt === 'function' ? evidenceAt(index) ?? [] : stage ? evidence : [];
    ev.evidence = ids.map((id) => ({ id, group: EVIDENCE_GROUP_OF[id], label: id, detail: '', passed: true, value: null, threshold: null, weight: EVIDENCE_WEIGHTS[id], index: null, time: null, price: null }));
    ev.evidenceCount = ev.evidence.length;
    ev.checks = ev.evidence;
    return ev;
  };
  const transition = (prev, input, params = {}) => fakeTransition(prev, input, { ...params, enterConfirmBars: { '5m': 1, '15m': 1, '1h': 1 } });
  return { evaluate, transition, resolveParams: fakeResolveParams, requiredCandles: () => 1 };
}

/**
 * Candle buatan tangan dari baris OHLC (opsional volume), berurutan tanpa gap sejak startTime.
 * @param {Array<{ o: number, h: number, l: number, c: number, v?: number }>} rows
 */
export function candlesFromRows(rows, { symbol = 'HANDUSDT', timeframe = '15m', startTime = SYNTHETIC_START } = {}) {
  const ms = TIMEFRAME_MS[timeframe];
  return rows.map((r, i) => {
    const openTime = startTime + i * ms;
    const v = r.v ?? 1000;
    const mid = (r.o + r.c) / 2;
    return {
      symbol, timeframe, openTime, closeTime: openTime + ms - 1, open: r.o, high: r.h, low: r.l, close: r.c,
      volume: v, quoteVolume: v * mid, trades: 10, takerBuyVolume: v / 2, takerBuyQuoteVolume: (v / 2) * mid, isClosed: true, source: 'rest',
    };
  });
}
