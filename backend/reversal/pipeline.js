// Pipeline Reversal Radar per candle tertutup (docs/19-kontrak-reversal-radar.md §6): candle → evaluateReversal →
// transitionReversal → repositori reversal (kandidat, event, kursor), plus evaluasi PROVISIONAL candle berjalan.
// Meniru createAnalysisPipeline (backend/analysis/pipeline.js): evaluasi per seri diserialkan, replay dari kursor
// persisten (candle yang belum dievaluasi, maks `maxReplay`), likuiditas hanya untuk candle terbaru, alert hanya untuk
// candle terbaru, dan giliran event loop tiap `yieldEvery` candle (anggaran bersama antar seri).
//
// Anti-lookahead: konteks HTF yang diberikan ke detektor hanya candle dengan closeTime ≤ closeTime candle dasar yang
// dievaluasi (dipotong per titik replay). Provisional tidak pernah membuka/menutup kandidat atau memajukan kursor.
//
// Mesin (evaluateReversal / transitionReversal / resolveReversalParams) diterima lewat dependensi `evaluate` /
// `transition` / `resolveParams` (default: backend/reversal/index.js) agar tes dapat menyuntikkan fungsi palsu.
// Skor kandidat adalah skor aturan yang dapat dijelaskan, BUKAN probabilitas; tidak ada perintah transaksi.
import { setImmediate as nextMacrotask } from 'node:timers/promises';
import { HIGHER_TIMEFRAMES, TIMEFRAMES, TIMEFRAME_MS } from '../market/contracts.js';
import { REVERSAL_LOOKBACK, REVERSAL_TIMEFRAMES } from './constants.js';
import { evaluateReversal, resolveReversalParams, transitionReversal } from './index.js';

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/** Daftar timeframe reversal tervalidasi (subset REVERSAL_TIMEFRAMES, urut TIMEFRAMES, tanpa duplikat; boleh kosong). */
function resolveTimeframes(list) {
  if (!Array.isArray(list)) throw new TypeError('timeframes harus array timeframe');
  for (const tf of list) if (!REVERSAL_TIMEFRAMES.includes(tf)) throw new RangeError(`Timeframe tidak didukung Reversal Radar: ${String(tf)}`);
  return Object.freeze(TIMEFRAMES.filter((tf) => list.includes(tf)));
}

/**
 * @param {{ repos: { candles: any }, reversal: any,
 *   getLiquidity?: (symbol: string) => { quoteVolume24h: number|null, spreadBps: number|null,
 *     thresholds?: { minQuoteVolume24h: number, maxSpreadBps: number } } | null | undefined,
 *   logger?: any, params?: object, lookback?: number, maxReplay?: number, timeframes?: string[],
 *   onAlert?: (alert: { symbol: string, timeframe: string, candidateId: number|null, stage: string|null, status: string,
 *     events: object[], snapshot: object, evaluation: object }) => void,
 *   yieldEvery?: number, yieldToEventLoop?: () => Promise<void>, provisionalMinIntervalMs?: number, clock?: () => number,
 *   evaluate?: Function, transition?: Function, resolveParams?: Function }} deps
 *   repos.candles: sumber candle tertutup (getLatest). reversal: repositori §5 (backend/reversal/repository.js).
 *   getLiquidity: ukuran likuiditas 24 jam dari discovery terakhir (+ ambang pengaturan) — menggambarkan pasar SAAT INI,
 *   jadi hanya dipakai untuk candle terbaru batch; candle historis hasil replay dievaluasi tanpa likuiditas (UNKNOWN →
 *   fallback rata-rata quote volume per candle di detektor) agar tidak ada lookahead.
 *   params: override parsial DEFAULT_REVERSAL_PARAMS; di-resolve sekali per timeframe lewat `resolveParams(params, tf)`
 *   dan hasilnya diberikan ke `evaluate` (params) maupun `transition` (params).
 *   provisionalMinIntervalMs: jeda minimum antar evaluasi provisional per seri (jam `clock`).
 * @returns {{ onClosedCandles(series: { symbol: string, timeframe: string }): Promise<object>,
 *   onProvisionalCandle(candle: object): Promise<object>, closeSymbol(input: object): Promise<{ closed: object[] }>,
 *   timeframes: readonly string[] }}
 */
export function createReversalPipeline({
  repos, reversal, getLiquidity = () => undefined, logger, params = {}, lookback = REVERSAL_LOOKBACK, maxReplay = 288,
  timeframes = REVERSAL_TIMEFRAMES, onAlert, yieldEvery = 25, yieldToEventLoop = () => nextMacrotask(),
  provisionalMinIntervalMs = 15_000, clock = Date.now,
  evaluate = evaluateReversal, transition = transitionReversal, resolveParams = resolveReversalParams,
} = {}) {
  if (!repos?.candles || !reversal) throw new TypeError('repos.candles dan reversal wajib ada');
  for (const m of ['getOpen', 'save', 'markEvaluated', 'lastEvaluatedCandleTime', 'setProvisional', 'clearProvisional', 'closeOpenForSymbol']) {
    if (typeof reversal[m] !== 'function') throw new TypeError(`reversal.${m} wajib berupa fungsi`);
  }
  if (!Number.isInteger(lookback) || lookback < 100 || lookback > 1500) throw new RangeError('lookback harus 100..1500');
  if (!Number.isInteger(maxReplay) || maxReplay < 1 || maxReplay > 5000) throw new RangeError('maxReplay harus 1..5000');
  if (!Number.isInteger(yieldEvery) || yieldEvery < 1 || yieldEvery > 5000) throw new RangeError('yieldEvery harus 1..5000');
  if (!Number.isInteger(provisionalMinIntervalMs) || provisionalMinIntervalMs < 0 || provisionalMinIntervalMs > 3_600_000) {
    throw new RangeError('provisionalMinIntervalMs harus 0..3600000');
  }
  if (typeof evaluate !== 'function' || typeof transition !== 'function' || typeof resolveParams !== 'function') {
    throw new TypeError('evaluate, transition, dan resolveParams wajib berupa fungsi');
  }
  if (params === null || typeof params !== 'object' || Array.isArray(params)) throw new TypeError('params harus objek');
  if (typeof clock !== 'function') throw new TypeError('clock wajib berupa fungsi');
  const activeTimeframes = resolveTimeframes(timeframes);

  const queues = new Map();
  // openTime candle terakhir yang dievaluasi per seri (cache kursor persisten) — candle yang sama tidak dievaluasi dua kali.
  const lastEvaluated = new Map();
  // Snapshot status NONE per seri (histeresis masuk tahap: pendingStage/pendingBars sebelum kandidat dibuka) — hanya di
  // memori: repositori tidak menyimpan snapshot tanpa kandidat. Hilang saat restart → kandidat butuh `enterConfirmBars`
  // candle lagi (keterlambatan paling banyak 1 candle 5m), tidak pernah membuka kandidat palsu.
  const pendingNone = new Map();
  // Waktu (clock) evaluasi provisional terakhir per seri (throttle).
  const provisionalAt = new Map();
  // Parameter ter-resolve per timeframe (sekali).
  const paramsByTimeframe = new Map();
  // Anggaran giliran event loop bersama seluruh pipeline (lihat createAnalysisPipeline).
  let sliceUsed = 0;
  let sliceTurn = null;
  let activeEvaluations = 0;

  const seriesKey = (symbol, timeframe) => `${symbol}:${timeframe}`;

  function paramsFor(timeframe) {
    if (!paramsByTimeframe.has(timeframe)) paramsByTimeframe.set(timeframe, resolveParams(params, timeframe));
    return paramsByTimeframe.get(timeframe);
  }

  async function takeEvaluationSlot() {
    while (sliceUsed >= yieldEvery) {
      if (sliceTurn === null) {
        const turn = Promise.resolve(yieldToEventLoop()).catch(() => {}).then(() => {
          if (sliceTurn === turn) {
            sliceUsed = 0;
            sliceTurn = null;
          }
        });
        sliceTurn = turn;
      }
      await sliceTurn;
    }
    sliceUsed += 1;
  }

  /** Candle HTF tanpa lookahead: hanya closeTime ≤ `evaluationTime`, paling banyak `lookback` candle terakhir. */
  function higherAsOf(higherAll, evaluationTime) {
    const out = {};
    for (const [tf, list] of Object.entries(higherAll)) {
      const cut = list.filter((c) => c.closeTime <= evaluationTime);
      out[tf] = cut.length > lookback ? cut.slice(-lookback) : cut;
    }
    return out;
  }

  async function loadHigher(symbol, timeframe, span) {
    const higher = {};
    for (const tf of HIGHER_TIMEFRAMES[timeframe]) {
      higher[tf] = await repos.candles.getLatest({
        symbol, timeframe: tf, limit: Math.min(10_000, lookback + Math.ceil(span / TIMEFRAME_MS[tf]) + 2),
      });
    }
    return higher;
  }

  async function evaluateSeries({ symbol, timeframe }) {
    if (!TIMEFRAMES.includes(timeframe)) throw new RangeError(`Timeframe tidak didukung: ${String(timeframe)}`);
    if (typeof symbol !== 'string' || symbol.length === 0) throw new TypeError('symbol wajib string');
    if (!activeTimeframes.includes(timeframe)) return { symbol, timeframe, skipped: 'NOT_SCANNED' };
    const key = seriesKey(symbol, timeframe);
    const base = await repos.candles.getLatest({ symbol, timeframe, limit: lookback + maxReplay });
    if (!base.length) return { symbol, timeframe, skipped: 'NO_DATA' };
    const last = base[base.length - 1];

    if (!lastEvaluated.has(key)) lastEvaluated.set(key, await reversal.lastEvaluatedCandleTime({ symbol, timeframe }));
    const seen = lastEvaluated.get(key);
    if (seen !== null && last.openTime <= seen) return { symbol, timeframe, skipped: 'ALREADY_EVALUATED' };
    // Evaluasi pertama seri tanpa kursor = candle terakhir saja (bootstrap = histori); selain itu semua candle > kursor.
    const fresh = seen === null ? [base.length - 1] : base.map((c, i) => (c.openTime > seen ? i : -1)).filter((i) => i >= 0);
    const pending = fresh.slice(-maxReplay);
    const dropped = fresh.length - pending.length;
    if (dropped > 0) logger?.warn?.({ symbol, timeframe, dropped, maxReplay }, 'replay reversal dipotong: candle lama tidak dievaluasi');

    const higherAll = await loadHigher(symbol, timeframe, (pending.length + 1) * TIMEFRAME_MS[timeframe]);
    const liquidity = getLiquidity(symbol) ?? undefined;
    const runParams = paramsFor(timeframe);
    const latest = pending[pending.length - 1];
    let result = null;
    const errors = [];
    for (const index of pending) {
      // Repositori better-sqlite3 resolve sinkron: tanpa jeda eksplisit replay panjang menahan timer & I/O.
      await takeEvaluationSlot();
      const candle = base[index];
      const window = base.slice(Math.max(0, index + 1 - lookback), index + 1);
      const historical = index !== latest;
      const prev = (await reversal.getOpen({ symbol, timeframe })) ?? pendingNone.get(key) ?? null;
      let step;
      try {
        const evaluation = evaluate({
          candles: window, timeframe, higher: higherAsOf(higherAll, candle.closeTime),
          liquidity: historical ? undefined : liquidity, provisional: false, params: runParams,
        });
        const { next, events = [], alert = false } = transition(prev, { candle, evaluation, timeframe }, runParams);
        step = { evaluation, next, events, alert };
      } catch (err) {
        // Mesin (evaluate/transition) gagal untuk candle ini — deterministik (bug/data), mengulanginya tidak berguna:
        // dicatat, candle DILEWATI seperti gap data (kursor maju) agar seri & worker tidak macet; error repositori di
        // bawah tetap dilempar (bersifat sementara → dicoba lagi pada candle berikutnya). Pemanggil (worker/assemble.js)
        // melaporkan `errors` ke scanner sebagai error ingesti 'analysis'.
        const message = err?.message ?? String(err);
        errors.push({ openTime: candle.openTime, message });
        logger?.error?.({ symbol, timeframe, openTime: candle.openTime, err: message }, 'evaluasi reversal gagal: candle dilewati');
        await reversal.markEvaluated({ symbol, timeframe, openTime: candle.openTime, now: candle.closeTime });
        lastEvaluated.set(key, candle.openTime);
        continue;
      }
      const { evaluation, next, events, alert } = step;
      let saved = null;
      if (events.length > 0 || (prev !== null && next !== prev)) {
        // save() memajukan kursor dalam transaksi yang sama dengan kandidat + event; snapshot NONE = no-op.
        saved = await reversal.save({ symbol, timeframe, snapshot: next, events, evidence: evaluation.evidence });
      }
      if (saved?.saved !== true) await reversal.markEvaluated({ symbol, timeframe, openTime: candle.openTime, now: candle.closeTime });
      if (next && next.status === 'NONE') pendingNone.set(key, next);
      else pendingNone.delete(key);
      lastEvaluated.set(key, candle.openTime);
      result = { candle, evaluation, next, events, alert, candidateId: saved?.id ?? (prev?.id ?? null) };
    }

    // Candle sudah tutup → evaluasi provisional candle ini (dan yang lebih lama) tidak relevan lagi.
    await reversal.clearProvisional({ symbol, timeframe, upToOpenTime: last.openTime });

    // Alert hanya dari hasil candle terbaru; transisi historis hasil replay disimpan tanpa alert.
    if (result?.alert) {
      logger?.info?.({ symbol, timeframe, stage: result.next.stage, status: result.next.status, events: result.events.map((e) => e.type) },
        'alert kandidat reversal');
      onAlert?.({
        symbol, timeframe, candidateId: result.candidateId, stage: result.next.stage ?? null, status: result.next.status,
        events: result.events, snapshot: result.next, evaluation: result.evaluation,
      });
    }
    // Semua candle batch gagal → tanpa hasil evaluasi (status null), hanya `errors`.
    if (result === null) {
      return { symbol, timeframe, evaluated: 0, evaluationTime: null, candidateId: null, stage: null, status: null, classification: null, events: [], alert: false, errors };
    }
    return {
      symbol, timeframe, evaluated: pending.length - errors.length, evaluationTime: result.candle.closeTime, candidateId: result.candidateId,
      stage: result.next.stage ?? null, status: result.next.status, classification: result.evaluation.classification ?? null,
      events: result.events, alert: result.alert, errors,
    };
  }

  async function evaluateGuarded(series) {
    activeEvaluations += 1;
    try {
      return await evaluateSeries(series);
    } finally {
      activeEvaluations -= 1;
      if (activeEvaluations === 0) {
        sliceUsed = 0;
        sliceTurn = null;
      }
    }
  }

  async function evaluateProvisional(candle) {
    const { symbol, timeframe } = candle;
    const key = seriesKey(symbol, timeframe);
    // Candle tertutup di bawah candle berjalan: lookback − 1 candle (candle berjalan = candle terakhir evaluasi).
    const closed = (await repos.candles.getLatest({ symbol, timeframe, limit: lookback - 1 })).filter((c) => c.openTime < candle.openTime);
    if (closed.length === 0) return { symbol, timeframe, skipped: 'NO_DATA' };
    const seen = lastEvaluated.get(key);
    if (seen !== undefined && seen !== null && candle.openTime <= seen) return { symbol, timeframe, skipped: 'CANDLE_CLOSED' };
    const higherAll = await loadHigher(symbol, timeframe, 2 * TIMEFRAME_MS[timeframe]);
    const evaluation = evaluate({
      candles: [...closed, candle], timeframe, higher: higherAsOf(higherAll, candle.closeTime),
      liquidity: getLiquidity(symbol) ?? undefined, provisional: true, params: paramsFor(timeframe),
    });
    const stored = await reversal.setProvisional({ symbol, timeframe, evaluation, price: isFiniteNumber(candle.close) ? candle.close : null, now: clock() });
    return { symbol, timeframe, provisional: true, stage: evaluation.stage ?? null, ...stored };
  }

  /** Menjalankan `task` setelah semua tugas antrean `keys` selesai; tugas berikutnya di antrean itu menunggu `task`. */
  function serialize(keys, task) {
    const prior = Promise.all(keys.map((k) => (queues.get(k) ?? Promise.resolve()).catch(() => {})));
    const run = prior.then(task);
    for (const key of keys) {
      queues.set(key, run);
      run.finally(() => { if (queues.get(key) === run) queues.delete(key); }).catch(() => {});
    }
    return run;
  }

  return {
    /**
     * Handler candle tertutup (dipanggil worker/assemble.js bersama pipeline SA/PVA). Mengevaluasi semua candle seri
     * yang belum dievaluasi (replay dari kursor), menyimpan kandidat/event, memajukan kursor, membersihkan provisional.
     * Hasil: `{ symbol, timeframe, evaluated, evaluationTime, candidateId, stage, status, classification, events, alert,
     * errors: [{ openTime, message }] }` (candle yang gagal di mesin dilewati & dicatat di `errors`), atau
     * `{ symbol, timeframe, skipped }` (NOT_SCANNED / NO_DATA / ALREADY_EVALUATED). Error repositori dilempar.
     * @param {{ symbol: string, timeframe: string, candles?: object[], reason?: string }} series
     */
    onClosedCandles(series) {
      return serialize([seriesKey(series?.symbol, series?.timeframe)], () => evaluateGuarded(series));
    },

    /**
     * Candle BERJALAN (isClosed false) dari WebSocket: di-throttle per seri (`provisionalMinIntervalMs`), dievaluasi dengan
     * `provisional: true`, hasilnya disimpan lewat reversal.setProvisional. Tidak pernah menyentuh kursor/kandidat.
     * Error dicatat (logger.warn) dan TIDAK dilempar; hasil `{ error }` dikembalikan.
     * @param {object} candle Candle kanonik dengan isClosed false
     */
    onProvisionalCandle(candle) {
      if (candle === null || typeof candle !== 'object' || typeof candle.symbol !== 'string' || !TIMEFRAMES.includes(candle.timeframe)) {
        return Promise.resolve({ skipped: 'INVALID_CANDLE' });
      }
      const { symbol, timeframe } = candle;
      if (candle.isClosed !== false || !Number.isSafeInteger(candle.openTime)) return Promise.resolve({ symbol, timeframe, skipped: 'INVALID_CANDLE' });
      if (!activeTimeframes.includes(timeframe)) return Promise.resolve({ symbol, timeframe, skipped: 'NOT_SCANNED' });
      const key = seriesKey(symbol, timeframe);
      const now = clock();
      const last = provisionalAt.get(key);
      if (last !== undefined && now - last < provisionalMinIntervalMs) return Promise.resolve({ symbol, timeframe, skipped: 'THROTTLED' });
      provisionalAt.set(key, now);
      // Diserialkan dengan evaluasi candle tertutup seri yang sama agar provisional selalu menyusul, bukan mendahului.
      return serialize([key], () => evaluateProvisional(candle)).catch((err) => {
        logger?.warn?.({ symbol, timeframe, err: err?.message ?? String(err) }, 'evaluasi provisional reversal gagal');
        return { symbol, timeframe, provisional: true, error: err?.message ?? String(err) };
      });
    },

    /**
     * Simbol/seri berhenti dipantau: kandidat terbukanya ditutup EXPIRED dengan `reason` (reversal.closeOpenForSymbol),
     * diserialkan dengan evaluasi yang masih berjalan. Tanpa alert. `timeframes` null → semua timeframe reversal.
     * @param {{ symbol: string, timeframes?: string[]|null, reason: string, at: number }} input
     */
    closeSymbol({ symbol, timeframes: list = null, reason, at } = {}) {
      const target = list ?? activeTimeframes;
      return serialize(target.map((tf) => seriesKey(symbol, tf)), async () => {
        const result = await reversal.closeOpenForSymbol({ symbol, timeframes: target, reason, at });
        for (const tf of target) pendingNone.delete(seriesKey(symbol, tf));
        if (result.closed.length > 0) {
          logger?.info?.({ symbol, reason, closed: result.closed.map((c) => `${c.timeframe}:${c.fromStage}`) }, 'kandidat reversal ditutup: seri berhenti dipantau');
        }
        return result;
      });
    },

    /** Timeframe yang dievaluasi pipeline ini. */
    timeframes: activeTimeframes,
  };
}
