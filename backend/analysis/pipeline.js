// Pipeline analisis per candle tertutup: pola (SA/PVA) → konteks timeframe → skor → state machine → persistensi.
// Worker live memanggil `createAnalysisPipeline(...).onClosedCandles`; replay/backtest (M6) memanggil
// `analyzeAt` yang sama dengan sumber candle historis, sehingga live dan backtest memakai logika identik.
// Skor adalah skor aturan yang dapat dijelaskan, bukan probabilitas.
import { HIGHER_TIMEFRAMES, TIMEFRAME_MS, TIMEFRAMES } from '../market/contracts.js';
import {
  PATTERN_VERSION, PVA_CONDITIONS, SA_CONDITIONS, evaluatePatterns, requiredCandles, resolveParams,
} from '../patterns/index.js';
import { buildSignalView } from '../scoring/index.js';
import { deriveMarketInputs, transition } from '../signals/index.js';
import { buildTimeframeContext } from '../timeframe/index.js';

// Candle historis yang dimuat per timeframe: warm-up pola (SA 63, PVA 70), trend (29) dan swing
// resistance, dengan cadangan agar ATR/EMA stabil.
export const ANALYSIS_LOOKBACK = 300;

const PATTERN_NAMES = Object.freeze({ SA: 'Silent Accumulation', PVA: 'Progressive Volume Accumulation' });

/**
 * Kualitas seri dasar yang dimuat: celah (openTime tidak bersambung), candle belum tertutup, campuran seri.
 * Pola juga memeriksa jendelanya sendiri; ini menangkap masalah di luar jendela pola (mis. konteks swing).
 * @returns {{ ok: boolean, issues: string[] }}
 */
export function assessSeriesQuality(candles, timeframe) {
  const issues = [];
  const ms = TIMEFRAME_MS[timeframe];
  let gaps = 0;
  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i];
    if (c.isClosed !== true) issues.push('UNCLOSED_CANDLE');
    if (c.timeframe !== timeframe || c.symbol !== candles[0].symbol) issues.push('MIXED_SERIES');
    if (i > 0 && c.openTime - candles[i - 1].openTime !== ms) gaps += 1;
  }
  if (gaps > 0) issues.push(`GAP:${gaps}`);
  const unique = [...new Set(issues)];
  return { ok: unique.length === 0, issues: unique };
}

/**
 * Evaluasi murni pada satu titik waktu (closeTime candle dasar terakhir). Tidak menyentuh database.
 * Hanya candle dengan closeTime ≤ waktu evaluasi yang dipakai, termasuk timeframe lebih tinggi.
 * @param {{ symbol: string, timeframe: string,
 *   candlesByTimeframe: Record<string, import('../market/contracts.js').Candle[]>,
 *   prev: object|null, liquidity?: { quoteVolume24h?: number, spreadBps?: number },
 *   dataQuality?: { ok: boolean, issues?: string[] },
 *   params?: { sa?: object, pva?: object, signals?: object, view?: { minQuoteVolume24h?: number, maxSpreadBps?: number } } }} input
 *   `params.view`: ambang risk flag likuiditas/spread (default DEFAULT_VIEW_PARAMS). Worker live mengisinya
 *   dengan ambang pengaturan scanner yang dipakai discovery; backtest dapat memberikan ambangnya sendiri.
 * @returns {null | { evaluationTime: number, patterns: object, context: object, view: object,
 *   market: object, next: object, event: object|null, alert: boolean }}
 */
export function analyzeAt({ symbol, timeframe, candlesByTimeframe, prev, liquidity, dataQuality, params = {} }) {
  if (!TIMEFRAMES.includes(timeframe)) throw new RangeError(`Timeframe tidak didukung: ${timeframe}`);
  const base = candlesByTimeframe?.[timeframe] ?? [];
  if (!base.length) return null;
  const last = base[base.length - 1];
  const evaluationTime = last.closeTime;

  const quality = dataQuality ?? assessSeriesQuality(base, timeframe);
  const patterns = evaluatePatterns(base, { sa: params.sa, pva: params.pva });
  const context = buildTimeframeContext({ baseTimeframe: timeframe, evaluationTime, candlesByTimeframe });
  const view = buildSignalView({ symbol, timeframe, patterns, context, liquidity, dataQuality: quality, params: params.view });
  const market = deriveMarketInputs(base);
  const result = transition(prev ?? null, { candle: last, patterns, context, market, view }, params.signals);
  return { evaluationTime, patterns, context, view, market, ...result };
}

/** Definisi pola berversi yang dipersistensi (pattern_definitions) — parameter efektif + metadata kondisi. */
export function patternDefinitions(params = {}) {
  return [
    { key: 'SA', conditions: SA_CONDITIONS, params: resolveParams('SA', params.sa) },
    { key: 'PVA', conditions: PVA_CONDITIONS, params: resolveParams('PVA', params.pva) },
  ].map(({ key, conditions, params: p }) => ({
    key,
    version: PATTERN_VERSION,
    name: PATTERN_NAMES[key],
    definition: { params: { ...p }, conditions: conditions.map((c) => ({ ...c })), requiredCandles: requiredCandles(key, p) },
  }));
}

/**
 * Handler `onClosedCandles` untuk scanner. Evaluasi per (simbol, timeframe) diserialkan agar
 * candle WebSocket dan backfill yang datang bersamaan tidak membuka dua sinyal.
 *
 * Setiap candle dasar BARU dievaluasi berurutan (replay) — mis. setelah backfill gap beberapa candle
 * sekaligus — sehingga transisi state terjadi pada candle yang benar, sama seperti backtest.
 * Alert hanya untuk candle terbaru; transisi historis hasil replay disimpan tanpa alert.
 * Evaluasi pertama sebuah seri tanpa riwayat event hanya memakai candle terakhir (bootstrap = histori).
 *
 * @param {{ repos: { candles: any }, signals: any,
 *   getLiquidity?: (symbol: string) => { quoteVolume24h: number|null, spreadBps: number|null,
 *     thresholds?: { minQuoteVolume24h: number, maxSpreadBps: number } } | null | undefined,
 *   logger?: any, params?: object, lookback?: number, maxReplay?: number, settleMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   onAlert?: (alert: { symbol: string, timeframe: string, state: string, event: object, view: object }) => void }} deps
 *   settleMs: bila candle timeframe lebih tinggi yang tutup bersamaan belum tersimpan, tunggu sekali
 *   selama ini agar konteks live sama dengan replay (stream per timeframe diproses paralel).
 *   getLiquidity: ukuran likuiditas dari discovery terakhir; `thresholds` (ambang pengaturan yang dipakai
 *   discovery yang sama) menggantikan `params.view` agar risk flag & penjelasan memakai batas pengguna.
 */
export function createAnalysisPipeline({
  repos, signals, getLiquidity = () => undefined, logger, params = {}, lookback = ANALYSIS_LOOKBACK,
  maxReplay = 288, settleMs = 0, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), onAlert,
}) {
  if (!repos?.candles || !signals) throw new TypeError('repos.candles dan signals wajib ada');
  if (!Number.isInteger(lookback) || lookback < 100 || lookback > 1500) throw new RangeError('lookback harus 100..1500');
  if (!Number.isInteger(maxReplay) || maxReplay < 1 || maxReplay > 5000) throw new RangeError('maxReplay harus 1..5000');
  if (!Number.isInteger(settleMs) || settleMs < 0 || settleMs > 30_000) throw new RangeError('settleMs harus 0..30000');
  const definitions = patternDefinitions(params);
  let definitionsReady = null;
  const queues = new Map();
  // openTime candle dasar terakhir yang dievaluasi per seri (diisi dari event tersimpan saat pertama kali,
  // sehingga tetap berlaku setelah restart) — mencegah candle yang sama dievaluasi dua kali, termasuk
  // membuka sinyal baru pada candle yang baru saja menutup sinyal sebelumnya.
  const lastEvaluated = new Map();

  function ensureDefinitions() {
    definitionsReady ??= (async () => {
      for (const d of definitions) await signals.ensurePatternDefinition(d);
    })().catch((err) => {
      definitionsReady = null;
      throw err;
    });
    return definitionsReady;
  }

  /** Tunggu sekali bila candle HTF yang seharusnya tutup bersamaan dengan candle dasar belum tersimpan. */
  async function settleHigherTimeframes(symbol, timeframe, evaluationTime) {
    if (settleMs === 0) return;
    for (const tf of HIGHER_TIMEFRAMES[timeframe]) {
      const htfMs = TIMEFRAME_MS[tf];
      if ((evaluationTime + 1) % htfMs !== 0) continue;
      const lastOpen = await repos.candles.getLastOpenTime({ symbol, timeframe: tf });
      if (lastOpen === null || lastOpen < evaluationTime + 1 - htfMs) {
        await sleep(settleMs);
        return;
      }
    }
  }

  /** Pisahkan ukuran likuiditas dari ambang yang menyertainya; ambang → params.view untuk analyzeAt. */
  function liquidityInputs(info) {
    if (info === null || info === undefined) return { liquidity: undefined, params };
    const { thresholds, ...liquidity } = info;
    if (thresholds === null || thresholds === undefined) return { liquidity, params };
    return { liquidity, params: { ...params, view: { ...params.view, ...thresholds } } };
  }

  async function evaluate({ symbol, timeframe }) {
    if (!TIMEFRAMES.includes(timeframe)) throw new RangeError(`Timeframe tidak didukung: ${timeframe}`);
    await ensureDefinitions();
    const key = `${symbol}:${timeframe}`;
    const base = await repos.candles.getLatest({ symbol, timeframe, limit: lookback + maxReplay });
    if (!base.length) return { symbol, timeframe, skipped: 'NO_DATA' };
    const last = base[base.length - 1];
    if (!lastEvaluated.has(key)) lastEvaluated.set(key, await signals.lastEventCandleTime({ symbol, timeframe }));
    const seen = lastEvaluated.get(key);
    if (seen !== null && last.openTime <= seen) return { symbol, timeframe, skipped: 'ALREADY_EVALUATED' };

    const fresh = seen === null ? [base.length - 1] : base.map((c, i) => (c.openTime > seen ? i : -1)).filter((i) => i >= 0);
    const pending = fresh.slice(-maxReplay);
    if (pending.length < fresh.length) {
      logger?.warn?.({ symbol, timeframe, dropped: fresh.length - pending.length, maxReplay }, 'replay dipotong: candle lama tidak dievaluasi');
    }

    await settleHigherTimeframes(symbol, timeframe, last.closeTime);
    const higher = {};
    const span = (pending.length + 1) * TIMEFRAME_MS[timeframe];
    for (const tf of HIGHER_TIMEFRAMES[timeframe]) {
      higher[tf] = await repos.candles.getLatest({ symbol, timeframe: tf, limit: Math.min(10_000, lookback + Math.ceil(span / TIMEFRAME_MS[tf]) + 2) });
    }

    const { liquidity, params: runParams } = liquidityInputs(getLiquidity(symbol));
    let result = null;
    for (const index of pending) {
      const candle = base[index];
      const window = base.slice(Math.max(0, index + 1 - lookback), index + 1);
      const prev = await signals.getOpen({ symbol, timeframe });
      result = analyzeAt({ symbol, timeframe, candlesByTimeframe: { [timeframe]: window, ...higher }, prev, liquidity, params: runParams });
      if (result.event || (prev && result.next !== prev)) {
        await signals.save({ symbol, timeframe, snapshot: result.next, event: result.event, explanation: result.view.explanation });
      }
      lastEvaluated.set(key, candle.openTime);
    }

    if (result.alert) {
      logger?.info?.({ symbol, timeframe, state: result.next.state, reason: result.event?.reason }, 'alert sinyal');
      onAlert?.({ symbol, timeframe, state: result.next.state, event: result.event, view: result.view });
    }
    return {
      symbol, timeframe, evaluationTime: result.evaluationTime, state: result.next.state, evaluated: pending.length,
      classification: result.patterns.classification, event: result.event, alert: result.alert,
    };
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
    /** @param {{ symbol: string, timeframe: string, candles?: object[], reason?: string }} series */
    onClosedCandles(series) {
      return serialize([`${series?.symbol}:${series?.timeframe}`], () => evaluate(series));
    },
    /**
     * Simbol berhenti dipantau (delisted / keluar dari set pantauan): tutup sinyal terbukanya menjadi EXPIRED
     * dengan `reason` (signals.closeOpenForSymbol), diserialkan dengan evaluasi yang masih berjalan untuk
     * seri yang sama. Tanpa alert. `timeframes` null → semua timeframe.
     * @param {{ symbol: string, timeframes?: string[]|null, reason: string, at: number }} input
     * @returns {Promise<{ closed: Array<{ id: number, timeframe: string, fromState: string, price: number|null }> }>}
     */
    closeSymbol({ symbol, timeframes = null, reason, at } = {}) {
      if (typeof signals.closeOpenForSymbol !== 'function') return Promise.reject(new TypeError('signals.closeOpenForSymbol wajib ada'));
      const list = timeframes ?? TIMEFRAMES;
      return serialize(list.map((tf) => `${symbol}:${tf}`), async () => {
        const result = await signals.closeOpenForSymbol({ symbol, timeframes: list, reason, at });
        if (result.closed.length > 0) {
          logger?.info?.({ symbol, reason, closed: result.closed.map((c) => `${c.timeframe}:${c.fromState}`) }, 'sinyal ditutup: simbol berhenti dipantau');
        }
        return result;
      });
    },
    ensureDefinitions,
  };
}
