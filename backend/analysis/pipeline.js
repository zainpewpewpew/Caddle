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
 *   params?: { sa?: object, pva?: object, signals?: object } }} input
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
  const view = buildSignalView({ symbol, timeframe, patterns, context, liquidity, dataQuality: quality });
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
 * @param {{ repos: { candles: any }, signals: any, getLiquidity?: (symbol: string) => object|undefined,
 *   logger?: any, params?: object, lookback?: number,
 *   onAlert?: (alert: { symbol: string, timeframe: string, state: string, event: object, view: object }) => void }} deps
 */
export function createAnalysisPipeline({
  repos, signals, getLiquidity = () => undefined, logger, params = {}, lookback = ANALYSIS_LOOKBACK, onAlert,
}) {
  if (!repos?.candles || !signals) throw new TypeError('repos.candles dan signals wajib ada');
  if (!Number.isInteger(lookback) || lookback < 100 || lookback > 1500) throw new RangeError('lookback harus 100..1500');
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

  async function evaluate({ symbol, timeframe }) {
    if (!TIMEFRAMES.includes(timeframe)) throw new RangeError(`Timeframe tidak didukung: ${timeframe}`);
    await ensureDefinitions();
    const candlesByTimeframe = {};
    for (const tf of [timeframe, ...HIGHER_TIMEFRAMES[timeframe]]) {
      candlesByTimeframe[tf] = await repos.candles.getLatest({ symbol, timeframe: tf, limit: lookback });
    }
    const base = candlesByTimeframe[timeframe];
    if (!base.length) return { symbol, timeframe, skipped: 'NO_DATA' };
    const last = base[base.length - 1];
    const key = `${symbol}:${timeframe}`;
    if (!lastEvaluated.has(key)) lastEvaluated.set(key, await signals.lastEventCandleTime({ symbol, timeframe }));
    const seen = lastEvaluated.get(key);
    if (seen !== null && last.openTime <= seen) return { symbol, timeframe, skipped: 'ALREADY_EVALUATED' };

    const prev = await signals.getOpen({ symbol, timeframe });
    const result = analyzeAt({ symbol, timeframe, candlesByTimeframe, prev, liquidity: getLiquidity(symbol), params });
    if (result.event || (prev && result.next !== prev)) {
      await signals.save({ symbol, timeframe, snapshot: result.next, event: result.event, explanation: result.view.explanation });
    }
    lastEvaluated.set(key, last.openTime);
    if (result.alert) {
      logger?.info?.({ symbol, timeframe, state: result.next.state, reason: result.event?.reason }, 'alert sinyal');
      onAlert?.({ symbol, timeframe, state: result.next.state, event: result.event, view: result.view });
    }
    return {
      symbol, timeframe, evaluationTime: result.evaluationTime, state: result.next.state,
      classification: result.patterns.classification, event: result.event, alert: result.alert,
    };
  }

  return {
    /** @param {{ symbol: string, timeframe: string }} series */
    onClosedCandles(series) {
      const key = `${series?.symbol}:${series?.timeframe}`;
      const run = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(() => evaluate(series));
      queues.set(key, run);
      run.finally(() => { if (queues.get(key) === run) queues.delete(key); }).catch(() => {});
      return run;
    },
    ensureDefinitions,
  };
}
