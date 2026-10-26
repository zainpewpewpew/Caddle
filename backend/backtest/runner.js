// Runner backtest walk-forward scanner LONG & SHORT (Milestone 6). Me-replay candle historis candle demi candle
// dengan logika IDENTIK dengan worker live (analyzeDirectionsAt: pola → konteks HTF → skor → konfluensi → state
// machine), lalu memberi label setiap sinyal dengan triple barrier (labeler.js) dan meringkas hasilnya terpisah
// in-sample (train) vs out-of-sample (test).
//
// Varian yang dibandingkan pada candle & sinyal yang sama:
//   v2   "Sebelum": state machine tanpa gerbang tier (perilaku scanner lama; konfluensi tidak memengaruhi state).
//   v3   "Sesudah": state machine dengan gerbang tier default (minEarlyTier 'B') — perilaku scanner baru.
//   tier "v3 per tier": entri v2 dikelompokkan menurut tier konfluensi saat entri, untuk menguji apakah
//        tier benar-benar terurut (A ≥ B ≥ C ≥ D). Bila tidak terurut, bobot konfluensi belum bermakna.
// Entri trade = event pertama sebuah sinyal ke state alert (EARLY_*/MOMENTUM_BUILDING/BREAKOUT/BREAKDOWN),
// harga entri = close candle itu, stop = level invalidasi sinyal saat itu. Satu trade per sinyal.
//
// Pemisahan waktu: trade dengan entri sebelum `testStart` (fraksi `trainFraction` rentang waktu) = train,
// dikurangi embargo (maxBars candle) dan purging (trade train yang keluar setelah testStart dibuang). Kalibrasi
// skor → peluang dilatih HANYA dari train lalu dievaluasi pada test. Tanpa lookahead: setiap evaluasi hanya
// melihat candle dengan closeTime ≤ candle evaluasi (HTF juga), sama seperti analyzeDirectionsAt live.
import { setImmediate as nextMacrotask } from 'node:timers/promises';
import { ANALYSIS_LOOKBACK, analyzeDirectionsAt } from '../analysis/pipeline.js';
import { extractFeatures } from '../features/index.js';
import { DIRECTIONS, HIGHER_TIMEFRAMES, TIMEFRAME_MS } from '../market/contracts.js';
import { evaluateMetaModels } from '../ml/evaluate.js';
import { metaFeatures } from '../ml/metaFeatures.js';
import { logLoss } from '../ml/metrics.js';
import { ALERT_STATES_BY_DIRECTION, transition } from '../signals/index.js';
import { applyCalibration, CALIBRATION_METHODS, fitCalibrationBy, reliabilityReport } from './calibration.js';
import { labelTrade } from './labeler.js';
import { brierScore, summarize } from './metrics.js';
import { aggregateCandles } from './synthetic.js';

const OPEN_STATES = Object.freeze(['QUIET', 'EARLY_BULLISH', 'MOMENTUM_BUILDING', 'BREAKOUT', 'EARLY_BEARISH', 'BREAKDOWN']);
/** Candle minimum sebelum evaluasi pertama (warm-up pola terpanjang 70 + rezim/squeeze 139). */
export const BACKTEST_WARMUP = 150;
/**
 * ml: true = setiap trade membawa vektor fitur meta-labeling (`trade.ml`) dan hasil memuat evaluasi ML (`result.ml`).
 * entry: 'nextOpen' (bawaan, realistis: order baru bisa dikirim setelah candle sinyal tutup → harga = open candle
 *   berikutnya) atau 'close' (perilaku lama: masuk tepat di close candle sinyal).
 * maxCostR: ambang varian "v3 + filter biaya" — sinyal dilewati bila perkiraan biaya pulang-pergi saat entri
 *   (2·(fee+slippage)·entry / risiko) > maxCostR R. 0.15R ≈ stop minimal ±80 bps pada biaya 12 bps. HIPOTESIS awal.
 * calibrationMethod: metode tabel kalibrasi untuk config/calibration.json ('platt' bawaan, atau 'isotonic').
 */
export const RUNNER_DEFAULTS = Object.freeze({
  targetR: 2, maxBars: 48, trainFraction: 0.6, feeBps: 4, slippageBps: 2, ml: false, entry: 'nextOpen', maxCostR: 0.15, calibrationMethod: 'platt',
});
export const ENTRY_MODES = Object.freeze(['nextOpen', 'close']);

/** HTF tersedia pada waktu t: candle dengan closeTime ≤ t (indeks akhir eksklusif dimajukan monoton). */
function htfCursor(list) {
  let end = 0;
  return (t) => {
    while (end < list.length && list[end].closeTime <= t) end += 1;
    return list.slice(Math.max(0, end - ANALYSIS_LOOKBACK), end);
  };
}

/** Timeframe konteks: dari data bila ada, bila tidak diagregasi dari candle dasar (hanya grup lengkap). */
function contextSeries(byTf, timeframe) {
  const out = {};
  for (const htf of HIGHER_TIMEFRAMES[timeframe]) {
    const given = byTf[htf];
    out[htf] = Array.isArray(given) && given.length ? given : aggregateCandles(byTf[timeframe], htf);
  }
  return out;
}

/**
 * Replay satu seri (simbol × timeframe dasar) → trade per varian. Fungsi murni kecuali yield event loop.
 * @returns {Promise<{ trades: { v2: object[], v3: object[] }, evaluations: number }>}
 */
export async function replaySeries({ symbol, timeframe, byTf, params = {}, options = {} }) {
  const o = { ...RUNNER_DEFAULTS, ...options };
  if (!ENTRY_MODES.includes(o.entry)) throw new RangeError(`entry harus salah satu dari: ${ENTRY_MODES.join(', ')}`);
  const base = byTf[timeframe];
  if (!Array.isArray(base) || base.length <= BACKTEST_WARMUP) return { trades: { v2: [], v3: [] }, evaluations: 0, skippedGap: 0 };
  const costRate = (o.feeBps + o.slippageBps) / 10_000;
  const htf = contextSeries(byTf, timeframe);
  const cursors = Object.fromEntries(Object.entries(htf).map(([tf, list]) => [tf, htfCursor(list)]));
  const v2Signals = { ...params.signals, minEarlyTier: null };

  const state = { v2: {}, v3: {} };
  const entered = { v2: {}, v3: {} };
  const trades = { v2: [], v3: [] };
  let evaluations = 0;
  /** Entri open berikutnya yang sudah melewati level invalidasi (gap) → tidak dimasuki, dihitung saja. */
  let skippedGap = 0;

  for (let i = BACKTEST_WARMUP; i < base.length; i += 1) {
    const last = base[i];
    const candlesByTimeframe = { [timeframe]: base.slice(Math.max(0, i + 1 - ANALYSIS_LOOKBACK), i + 1) };
    for (const [tf, at] of Object.entries(cursors)) candlesByTimeframe[tf] = at(last.closeTime);

    const results = analyzeDirectionsAt({
      symbol, timeframe, candlesByTimeframe, prevByDirection: state.v3, params, directions: DIRECTIONS,
    });
    evaluations += 1;
    // Fitur v3 mentah untuk meta-labeling dihitung hanya bila ada entri pada candle ini (dari candle ≤ candle sinyal).
    let rawFeatures;
    const featuresNow = () => (rawFeatures ??= extractFeatures(candlesByTimeframe[timeframe]));
    for (const direction of DIRECTIONS) {
      const r = results[direction];
      // Varian v2: state machine yang sama tanpa gerbang tier, dari pola/view/konteks yang sama persis.
      const r2 = transition(state.v2[direction] ?? null, {
        candle: last, patterns: r.patterns, context: r.context, market: r.market, view: r.view,
      }, v2Signals);
      for (const [variant, step] of [['v3', r], ['v2', r2]]) {
        const { next, event } = step;
        if (event?.fromState === 'NO_PATTERN') entered[variant][direction] = false;
        const alertState = event && ALERT_STATES_BY_DIRECTION[direction].includes(event.toState);
        if (alertState && entered[variant][direction] === false) {
          entered[variant][direction] = true;
          // Entri open berikutnya: candle i+1 dibuka di harga entri, lalu dievaluasi labeler mulai candle i+1 itu sendiri.
          const entryPrice = o.entry === 'close' ? last.close : base[i + 1]?.open;
          const trade = Number.isFinite(entryPrice) ? labelTrade({
            candles: base, entryIndex: i, direction, entryPrice, stopPrice: next.invalidationPrice,
            targetR: o.targetR, maxBars: o.maxBars, feeBps: o.feeBps, slippageBps: o.slippageBps,
          }) : null;
          const wrongSide = Number.isFinite(entryPrice) && (direction === 'LONG' ? entryPrice <= next.invalidationPrice : entryPrice >= next.invalidationPrice);
          if (!trade && o.entry === 'nextOpen' && wrongSide && variant === 'v2') skippedGap += 1;
          if (trade) {
            const c = r.view.confluence ?? null;
            const ml = o.ml ? metaFeatures({
              direction, timeframe, state: event.toState, view: r.view, features: featuresNow(),
              candles: candlesByTimeframe[timeframe], entryPrice: last.close, stopPrice: next.invalidationPrice, entryTime: last.closeTime,
            }) : undefined;
            trades[variant].push({
              ...trade, symbol, timeframe, entryTime: last.closeTime, state: event.toState,
              tier: c?.tier ?? null, score: c?.score ?? null, patternScore: r.view.patternScore, alignment: r.context?.alignment ?? null,
              // Perkiraan biaya pulang-pergi dalam R yang DIKETAHUI saat entri (tanpa harga exit).
              estCostR: (2 * costRate * entryPrice) / trade.risk,
              ...(ml ? { ml } : {}),
            });
          }
        }
        state[variant][direction] = OPEN_STATES.includes(next.state) ? next : null;
      }
    }
    if (i % 200 === 0) await nextMacrotask();
  }
  return { trades, evaluations, skippedGap };
}

const trainTest = (trades, testStart, embargoMs) => ({
  train: trades.filter((t) => t.entryTime < testStart - embargoMs && (t.exitTime ?? Infinity) < testStart),
  test: trades.filter((t) => t.entryTime >= testStart),
});

function splitSummary(trades, testStart, embargoMs) {
  const { train, test } = trainTest(trades, testStart, embargoMs);
  return { train: summarize(train), test: summarize(test) };
}

function groupSplit(trades, keyFn, testStart, embargoMs) {
  const groups = {};
  for (const t of trades) (groups[keyFn(t)] ??= []).push(t);
  return Object.fromEntries(Object.entries(groups).map(([k, list]) => [k, splitSummary(list, testStart, embargoMs)]));
}

function byGroup(trades, testStart, embargoMs) {
  const groups = new Map();
  for (const t of trades) {
    const key = `${t.direction}|${t.timeframe}|${t.tier ?? '-'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, list]) => {
    const [direction, timeframe, tier] = key.split('|');
    return { direction, timeframe, tier: tier === '-' ? null : tier, ...splitSummary(list, testStart, embargoMs) };
  });
}

/** Kualitas satu tabel kalibrasi pada sampel uji: ECE, Brier, log-loss (null bila tabel belum layak, < 100 sampel). */
function tableQuality(table, testSamples) {
  const reliability = reliabilityReport(table, testSamples);
  if (!reliability) return null;
  const pairs = testSamples.map((s) => ({ p: applyCalibration(table, s.score)?.probability, y: s.win }));
  return { ece: reliability.ece, brier: reliability.brier, logLoss: logLoss(pairs), reliability };
}

/**
 * Kalibrasi skor konfluensi → peluang WIN, dilatih dari train dan diuji pada test (sampel { score, win }).
 * Tabel utama memakai `method`; kedua metode (Platt & isotonik) selalu dibandingkan pada data uji yang sama.
 */
function calibrate(trades, testStart, embargoMs, method) {
  const { train, test } = trainTest(trades.filter((t) => t.outcome !== 'OPEN' && t.score !== null), testStart, embargoMs);
  const toSample = (t) => ({ score: t.score, win: t.outcome === 'WIN' ? 1 : 0 });
  const trainSamples = train.map(toSample);
  const testSamples = test.map(toSample);
  const tables = Object.fromEntries(CALIBRATION_METHODS.map((m) => [m, fitCalibrationBy(m, trainSamples)]));
  const quality = Object.fromEntries(CALIBRATION_METHODS.map((m) => [m, tableQuality(tables[m], testSamples)]));
  const main = quality[method];
  // Baseline = selalu memprediksi base rate TRAIN (tanpa melihat hasil test).
  const base = trainSamples.length ? trainSamples.reduce((a, s) => a + s.win, 0) / trainSamples.length : null;
  const basePairs = base === null ? [] : testSamples.map((s) => ({ p: base, y: s.win }));
  return {
    sample: 'test',
    method,
    trainSamples: train.length,
    testSamples: testSamples.length,
    ece: main?.ece ?? null,
    brier: main?.brier ?? null,
    brierBaseline: base === null || testSamples.length === 0 ? null : brierScore(basePairs),
    logLossBaseline: basePairs.length ? logLoss(basePairs) : null,
    methods: Object.fromEntries(CALIBRATION_METHODS.map((m) => [m, quality[m]
      ? { ece: quality[m].ece, brier: quality[m].brier, logLoss: quality[m].logLoss } : null])),
    bins: (main?.reliability?.bins ?? []).map((b) => ({ lower: b.lo, upper: b.hi, n: b.n, predicted: b.predicted, observed: b.observed })),
    table: train.length ? tables[method] : null,
  };
}

function variantResult(label, description, trades, testStart, embargoMs, withCalibration, method = 'platt') {
  const { train, test } = trainTest(trades, testStart, embargoMs);
  return {
    label,
    description,
    trainSummary: summarize(train),
    testSummary: summarize(test),
    byTier: groupSplit(trades.filter((t) => t.tier), (t) => t.tier, testStart, embargoMs),
    byDirection: groupSplit(trades, (t) => t.direction, testStart, embargoMs),
    byGroup: byGroup(trades, testStart, embargoMs),
    calibration: withCalibration ? calibrate(trades, testStart, embargoMs, method) : null,
  };
}

/**
 * Backtest walk-forward. Dipanggil scripts/backtest.js.
 * @param {{ candles: Record<string, Record<string, object[]>>, symbols?: string[], timeframes: string[],
 *   targetR?: number, maxBars?: number, trainFraction?: number, feeBps?: number, slippageBps?: number,
 *   params?: object, onProgress?: (msg: string) => void }} input
 *   params: params analisis (sama dengan worker analysisParams). Tanpa `calibration`, agar peluang tidak bocor dari data uji.
 * @returns {Promise<object>} BacktestResult (lihat report.js)
 */
export async function runBacktest({ candles, symbols, timeframes, onProgress = () => {}, params = {}, ...rest }) {
  const o = { ...RUNNER_DEFAULTS, ...Object.fromEntries(Object.entries(rest).filter(([k, v]) => k in RUNNER_DEFAULTS && v !== undefined)) };
  const list = symbols ?? Object.keys(candles);
  if (!CALIBRATION_METHODS.includes(o.calibrationMethod)) throw new RangeError(`calibrationMethod harus salah satu dari: ${CALIBRATION_METHODS.join(', ')}`);
  if (!(Number.isFinite(o.maxCostR) && o.maxCostR > 0)) throw new RangeError('maxCostR harus angka > 0');
  const all = { v2: [], v3: [] };
  let evaluations = 0;
  let skippedGap = 0;
  let minTime = Infinity;
  let maxTime = -Infinity;
  let embargoMs = 0;
  for (const symbol of list) {
    for (const timeframe of timeframes) {
      const byTf = candles[symbol];
      if (!byTf?.[timeframe]?.length) continue;
      const started = Date.now();
      const res = await replaySeries({ symbol, timeframe, byTf, params: { ...params, calibration: undefined }, options: o });
      evaluations += res.evaluations;
      skippedGap += res.skippedGap;
      all.v2.push(...res.trades.v2);
      all.v3.push(...res.trades.v3);
      const series = byTf[timeframe];
      minTime = Math.min(minTime, series[Math.min(BACKTEST_WARMUP, series.length - 1)].closeTime);
      maxTime = Math.max(maxTime, series.at(-1).closeTime);
      embargoMs = Math.max(embargoMs, o.maxBars * TIMEFRAME_MS[timeframe]);
      onProgress(`${symbol} ${timeframe}: ${res.evaluations} candle dievaluasi, trade v2 ${res.trades.v2.length}, v3 ${res.trades.v3.length} (${Date.now() - started} ms)`);
    }
  }
  const testStart = Number.isFinite(minTime) ? minTime + (maxTime - minTime) * o.trainFraction : 0;
  const m = o.calibrationMethod;
  const v2 = variantResult('Sebelum — pola v2 tanpa gerbang tier', 'Semua sinyal yang masuk state alert (perilaku scanner lama).', all.v2, testStart, embargoMs, true, m);
  const v3 = variantResult('Sesudah — v3 gerbang tier ≥ B', 'Sinyal alert hanya bila tier konfluensi ≥ B (default scanner baru).', all.v3, testStart, embargoMs, true, m);
  // Varian filter biaya: sinyal v3 yang sama, dilewati bila perkiraan biaya saat entri > maxCostR (stop terlalu sempit).
  const v3cTrades = all.v3.filter((t) => t.estCostR <= o.maxCostR);
  const v3c = variantResult(
    `v3 + filter biaya ≤ ${o.maxCostR}R`,
    `Sinyal v3 yang stop-nya cukup lebar: perkiraan biaya pulang-pergi (fee+slippage) saat entri ≤ ${o.maxCostR}R. Belum dipakai live.`,
    v3cTrades, testStart, embargoMs, false,
  );
  return {
    meta: {
      baseline: 'v2', candidate: 'v3', evaluations, trainFraction: o.trainFraction, testStart, folds: null, embargoBars: o.maxBars,
      validation: `holdout berurutan waktu — ${Math.round(o.trainFraction * 100)}% awal = train (in-sample), sisanya = test `
        + `(out-of-sample), embargo ${o.maxBars} candle + purging trade train yang keluar setelah awal test; kalibrasi hanya dilatih dari train`,
      targetR: o.targetR, maxBars: o.maxBars, feeBps: o.feeBps, slippageBps: o.slippageBps,
      breakEvenWinRate: 1 / (1 + o.targetR),
      entry: o.entry, maxCostR: o.maxCostR, calibrationMethod: m, skippedGap,
      notes: [
        o.entry === 'nextOpen'
          ? `Entri di open candle setelah candle sinyal (realistis untuk live); ${skippedGap} sinyal v2 dilewati karena open sudah melewati level invalidasi`
          : 'Entri di close candle sinyal (optimistis: live baru bisa mengirim order setelah candle tutup)',
        `Kalibrasi config memakai metode ${m === 'platt' ? 'Platt (2 parameter, stabil pada sampel kecil)' : 'isotonik'}`,
      ],
    },
    variants: { v2, v3, v3c },
    calibrationTable: calibrationFile(all.v2, testStart, embargoMs, m),
    trades: { v2: all.v2.length, v3: all.v3.length, v3c: v3cTrades.length },
    // Meta-labeling dievaluasi pada entri v2 (semua sinyal alert): model sekunder yang memutuskan mana yang layak.
    ml: o.ml ? evaluateMetaModels(all.v2, { embargoMs }) : null,
  };
}

/**
 * Tabel kalibrasi per arah dari entri v2 (semua tier, sampel lebih banyak) — HANYA data train, sehingga peluang yang
 * kemudian ditampilkan live tidak pernah dilatih dari data uji laporan. Arah tanpa sampel train → tidak ada tabel.
 */
function calibrationFile(trades, testStart, embargoMs, method) {
  const out = {};
  for (const direction of DIRECTIONS) {
    const { train } = trainTest(trades.filter((t) => t.direction === direction && t.outcome !== 'OPEN' && t.score !== null), testStart, embargoMs);
    if (train.length) out[`${direction}:*`] = fitCalibrationBy(method, train.map((t) => ({ score: t.score, win: t.outcome === 'WIN' ? 1 : 0 })));
  }
  return Object.keys(out).length ? { version: 1, tables: out } : null;
}
