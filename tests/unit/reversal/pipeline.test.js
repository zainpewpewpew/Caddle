import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../../backend/database/connection.js';
import { migrate } from '../../../backend/database/migrate.js';
import { createRepositories } from '../../../backend/database/repositories/index.js';
import { TIMEFRAME_MS } from '../../../backend/market/contracts.js';
import { STAGE_RANK, STATUS_OF_STAGE } from '../../../backend/reversal/constants.js';
import { createReversalPipeline } from '../../../backend/reversal/pipeline.js';
import { generateCandles } from '../../fixtures/candles/synthetic.js';
import { buildReversalEvaluation, buildReversalSnapshot } from '../../helpers/reversalSeed.js';

// Pipeline Reversal Radar (docs/19 §6) dengan repositori SQLite ASLI dan mesin deteksi PALSU yang diskrip
// (evaluate/transition/resolveParams disuntikkan): yang diuji di sini adalah mekanika pipeline — replay dari kursor,
// pemotongan HTF tanpa lookahead, likuiditas & alert hanya candle terbaru, histeresis NONE di memori, provisional
// (throttle, tidak menyentuh kursor/kandidat, error tidak dilempar), serialisasi per seri, dan penutupan seri.
// Semua candle SINTETIS (tests/fixtures/candles) — bukan data pasar nyata. Mesin asli diuji di tests/unit/reversal lain.
const SYMBOL = 'SYNUSDT';
const NOW = Date.UTC(2027, 0, 1);
const T0 = Date.UTC(2026, 3, 1);
const M5 = TIMEFRAME_MS['5m'];
const LOOKBACK = 100;
const MAX_REPLAY = 10;
const ATR = 1.2;
const LIQ = Object.freeze({ quoteVolume24h: 500_000_000, spreadBps: 2, thresholds: { minQuoteVolume24h: 20_000_000, maxSpreadBps: 20 } });
const at = (i) => T0 + i * M5;
const SERIES = Object.freeze({ symbol: SYMBOL, timeframe: '5m' });

// 160 candle 5m (≈ 13 jam) mendatar; HTF 15m/1h diagregasi dari candle yang sama.
const ALL = generateCandles({ seed: 7, symbol: SYMBOL, timeframe: '5m', startTime: T0, startPrice: 100, segments: [{ bars: 160 }] });

/** Agregasi candle 5m menjadi timeframe lebih tinggi; hanya kelompok lengkap (candle HTF tertutup). */
function aggregate(candles, timeframe) {
  const ms = TIMEFRAME_MS[timeframe];
  const per = ms / M5;
  const groups = new Map();
  for (const c of candles) {
    const openTime = Math.floor(c.openTime / ms) * ms;
    if (!groups.has(openTime)) groups.set(openTime, []);
    groups.get(openTime).push(c);
  }
  return [...groups.entries()].filter(([, g]) => g.length === per).map(([openTime, g]) => ({
    symbol: g[0].symbol, timeframe, openTime, closeTime: openTime + ms - 1,
    open: g[0].open, high: Math.max(...g.map((c) => c.high)), low: Math.min(...g.map((c) => c.low)), close: g.at(-1).close,
    volume: g.reduce((s, c) => s + c.volume, 0), quoteVolume: g.reduce((s, c) => s + c.quoteVolume, 0),
    trades: g.reduce((s, c) => s + c.trades, 0), takerBuyVolume: g.reduce((s, c) => s + c.takerBuyVolume, 0),
    takerBuyQuoteVolume: g.reduce((s, c) => s + c.takerBuyQuoteVolume, 0), isClosed: true, source: 'rest',
  }));
}

/** Jumlah & closeTime terakhir candle HTF yang SUDAH tutup pada closeTime candle 5m ke-i (tanpa lookahead). */
const htfClosedBy = (i, timeframe) => {
  const per = TIMEFRAME_MS[timeframe] / M5;
  const count = Math.floor((i + 1) / per);
  return { count, maxClose: count === 0 ? null : T0 + count * TIMEFRAME_MS[timeframe] - 1 };
};

/** Menyimpan candle 5m [0, upto) + semua candle HTF lengkap dari [0, htfUpto) (htfUpto > upto = HTF "masa depan"). */
async function feed(repos, upto, { htfUpto = upto } = {}) {
  const m5 = ALL.slice(0, upto);
  const htf = ['15m', '1h'].flatMap((tf) => aggregate(ALL.slice(0, htfUpto), tf));
  const result = await repos.candles.upsertClosed([...htf, ...m5], { now: NOW });
  if (result.rejected.length > 0) throw new Error(`candle ditolak: ${result.rejected[0].errors.join(', ')}`);
  return m5.at(-1);
}

const running = (i, extra = {}) => ({ ...ALL[i], isClosed: false, source: 'ws', ...extra });
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const provisionalRows = (db) => db.prepare('SELECT candle_open_time AS openTime, stage, score FROM reversal_provisional ORDER BY candle_open_time').all();

const EARLY_IDS = ['LL_SHALLOWER', 'ATR_CONTRACTION', 'VOLUME_DRY_UP'];
const IDS_OF = Object.freeze({
  EARLY_FORMATION: EARLY_IDS,
  DEVELOPING_REVERSAL: [...EARLY_IDS, 'HIGHER_LOW', 'EMA25_RECLAIM'],
  CONFIRMED_BREAKOUT: [...EARLY_IDS, 'HIGHER_LOW', 'EMA25_RECLAIM', 'TRIGGER_BREAK'],
});

/** Snapshot status NONE (belum ada kandidat; hanya histeresis pendingStage/pendingBars) — tidak pernah disimpan repositori. */
const noneSnapshot = (timeframe, candle, { pendingStage = null, pendingBars = 0 } = {}) => ({
  version: 1, timeframe, stage: null, status: 'NONE', lastCandleTime: candle.openTime, lastEvaluatedAt: candle.closeTime,
  pendingStage, pendingBars, weakBars: 0,
});

/**
 * Mesin PALSU yang diskrip: `stageAt({ candle, provisional })` → tahap hasil evaluasi (null = tanpa setup);
 * `failWhen(entry)` → evaluate melempar. transition meniru aturan §4 secukupnya: OPENED setelah `enterConfirmBars`
 * candle berurutan bertahap (histeresis di snapshot NONE), STAGE_UP bila tahap evaluasi lebih tinggi (alert),
 * CANCELLED bila close < invalidation (alert hanya dari tahap ≥ DEVELOPING), selain itu snapshot baru tanpa event.
 */
function createEngine({ stageAt = () => null, failWhen = () => false } = {}) {
  const calls = { evaluate: [], transition: [], resolveParams: [] };
  return {
    calls,
    evaluate(input) {
      const last = input.candles.at(-1);
      const provisional = input.provisional === true;
      const entry = {
        openTime: last.openTime, provisional, count: input.candles.length, first: input.candles[0].openTime,
        allClosed: input.candles.every((c) => c.isClosed === true), liquidity: input.liquidity ?? null, params: input.params,
        higher: Object.fromEntries(Object.entries(input.higher).map(([tf, list]) => [tf, { count: list.length, maxClose: list.length ? list.at(-1).closeTime : null }])),
      };
      calls.evaluate.push(entry);
      if (failWhen(entry)) throw new Error('mesin palsu gagal (disengaja)');
      const stage = stageAt({ candle: last, provisional }) ?? null;
      return buildReversalEvaluation({
        timeframe: input.timeframe, stage, candleOpenTime: last.openTime, evaluatedAt: last.closeTime, price: last.close, atr: ATR,
        provisional, evidenceIds: stage === null ? [] : IDS_OF[stage],
      });
    },
    transition(prev, { candle, evaluation, timeframe }, params) {
      calls.transition.push({ openTime: candle.openTime, prevStatus: prev?.status ?? null, prevId: prev?.id ?? null, params });
      const base = prev ?? noneSnapshot(timeframe, candle);
      const stage = evaluation.stage;
      const ids = evaluation.evidence.map((e) => e.id);
      const event = (type, from, to, extra = {}) => ({
        type, fromStage: from.stage, toStage: to.stage, fromStatus: from.status, toStatus: to.status,
        candleTime: candle.openTime, occurredAt: candle.closeTime, price: candle.close, provisional: false,
        reason: 'STAGE_EVIDENCE', detail: { score: to.score }, ...extra,
      });
      const step = { lastCandleTime: candle.openTime, lastEvaluatedAt: candle.closeTime };
      if (base.status === 'NONE') {
        if (stage === null) return { next: { ...base, ...step, pendingStage: null, pendingBars: 0 }, events: [], alert: false };
        const pendingBars = base.pendingStage === stage ? base.pendingBars + 1 : 1;
        if (pendingBars < params.enterConfirmBars) return { next: { ...base, ...step, pendingStage: stage, pendingBars }, events: [], alert: false };
        const next = buildReversalSnapshot({
          timeframe, stage, price: candle.close, atr: ATR, lastCandleTime: candle.openTime, evidence: ids,
          score: evaluation.score.total, scoreComponents: evaluation.score.components, liquidityClass: evaluation.context.liquidityClass,
        });
        return { next, events: [event('OPENED', { stage: null, status: 'NONE' }, next)], alert: true };
      }
      const bars = { ...step, barsInStage: base.barsInStage + 1, barsSinceDetection: base.barsSinceDetection + 1 };
      if (candle.close < base.levels.invalidation) {
        const next = { ...base, ...bars, status: 'CANCELLED', closeReason: 'CLOSE_BELOW_INVALIDATION' };
        const ev = event('CANCELLED', base, next, { reason: 'CLOSE_BELOW_INVALIDATION', detail: { invalidation: base.levels.invalidation } });
        return { next, events: [ev], alert: STAGE_RANK[base.stage] >= STAGE_RANK.DEVELOPING_REVERSAL };
      }
      if (stage !== null && STAGE_RANK[stage] > STAGE_RANK[base.stage]) {
        const next = {
          ...base, ...bars, barsInStage: 0, stage, status: STATUS_OF_STAGE[stage], stageEnteredAt: candle.closeTime, peakStage: stage,
          score: evaluation.score.total, scoreComponents: evaluation.score.components, evidence: ids, evidenceCount: ids.length,
        };
        return { next, events: [event('STAGE_UP', base, next)], alert: true };
      }
      return { next: { ...base, ...bars }, events: [], alert: false };
    },
    resolveParams(overrides, timeframe) {
      calls.resolveParams.push({ overrides, timeframe });
      return Object.freeze({ enterConfirmBars: 1, ...overrides, timeframe });
    },
  };
}

async function setup({ script, params = {}, pipeline: options = {} } = {}) {
  const db = openDatabase(':memory:');
  migrate(db);
  const repos = createRepositories(db, { clock: () => NOW });
  await repos.symbols.upsertFromExchange([{
    symbol: SYMBOL, baseAsset: 'SYN', quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING',
    tickSize: '0.0001', stepSize: '1', onboardDate: 0,
  }], NOW);
  const engine = createEngine(script);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const alerts = [];
  let now = NOW;
  const clock = () => now;
  clock.advance = (ms) => { now += ms; };
  const deps = {
    repos, reversal: repos.reversal, logger, lookback: LOOKBACK, maxReplay: MAX_REPLAY, getLiquidity: () => LIQ,
    onAlert: (a) => alerts.push(a), clock, provisionalMinIntervalMs: 15_000, params,
    evaluate: engine.evaluate, transition: engine.transition, resolveParams: engine.resolveParams, ...options,
  };
  const pipeline = createReversalPipeline(deps);
  return { db, repos, engine, logger, alerts, clock, pipeline, deps };
}

const evaluations = (engine, { provisional = false } = {}) => engine.calls.evaluate.filter((e) => e.provisional === provisional);

describe('pipeline Reversal Radar — candle tertutup (replay dari kursor, HTF tanpa lookahead)', () => {
  it('UNIT-RRPL-001 evaluasi pertama seri tanpa kursor = candle terakhir saja: jendela lookback, HTF dipotong closeTime ≤ candle (HTF masa depan tidak ikut), likuiditas & params ter-resolve diberikan; kursor maju; panggilan ulang = ALREADY_EVALUATED', async () => {
    const { repos, engine, pipeline, logger } = await setup({ params: { enterConfirmBars: 1, extra: 'x' } });
    // Candle HTF dari 160 candle 5m (sebagian tutup SETELAH candle #100) sudah tersimpan — pipeline harus memotongnya.
    const last = await feed(repos, 101, { htfUpto: 160 });
    expect((await repos.candles.getLatest({ symbol: SYMBOL, timeframe: '15m', limit: 100 })).length).toBe(53);

    const result = await pipeline.onClosedCandles(SERIES);
    expect(result).toEqual({
      symbol: SYMBOL, timeframe: '5m', evaluated: 1, evaluationTime: last.closeTime, candidateId: null, stage: null, status: 'NONE',
      classification: 'NO_SETUP', events: [], alert: false, errors: [],
    });
    expect(engine.calls.evaluate).toEqual([{
      openTime: at(100), provisional: false, count: LOOKBACK, first: at(1), allClosed: true, liquidity: LIQ,
      params: { enterConfirmBars: 1, extra: 'x', timeframe: '5m' },
      higher: { '15m': htfClosedBy(100, '15m'), '1h': htfClosedBy(100, '1h') },
    }]);
    expect(engine.calls.evaluate[0].higher['15m']).toEqual({ count: 33, maxClose: at(99) - 1 });
    // Params di-resolve sekali per timeframe dan objek yang sama diberikan ke transition.
    expect(engine.calls.resolveParams).toEqual([{ overrides: { enterConfirmBars: 1, extra: 'x' }, timeframe: '5m' }]);
    expect(engine.calls.transition).toEqual([{ openTime: at(100), prevStatus: null, prevId: null, params: engine.calls.evaluate[0].params }]);
    expect(await repos.reversal.lastEvaluatedCandleTime(SERIES)).toBe(at(100));
    expect(await repos.reversal.getOpen(SERIES)).toBeNull();

    expect(await pipeline.onClosedCandles(SERIES)).toEqual({ symbol: SYMBOL, timeframe: '5m', skipped: 'ALREADY_EVALUATED' });
    expect(engine.calls.evaluate).toHaveLength(1);
    expect(engine.calls.resolveParams).toHaveLength(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('UNIT-RRPL-002 replay dari kursor: semua candle belum dievaluasi berurutan dengan jendela & HTF per titik replay, likuiditas hanya candle terbaru; lebih dari maxReplay → yang lama dilewati dengan peringatan', async () => {
    const { repos, engine, pipeline, logger } = await setup();
    await feed(repos, 101, { htfUpto: 160 });
    await pipeline.onClosedCandles(SERIES);
    engine.calls.evaluate.length = 0;

    await feed(repos, 106, { htfUpto: 160 });
    const result = await pipeline.onClosedCandles(SERIES);
    expect(result).toMatchObject({ evaluated: 5, evaluationTime: at(106) - 1, status: 'NONE' });
    expect(engine.calls.evaluate.map((e) => [e.openTime, e.count, e.first, e.liquidity, e.higher['15m'], e.higher['1h']])).toEqual(
      [101, 102, 103, 104, 105].map((i) => [at(i), LOOKBACK, at(i - 99), i === 105 ? LIQ : null, htfClosedBy(i, '15m'), htfClosedBy(i, '1h')]),
    );
    expect(await repos.reversal.lastEvaluatedCandleTime(SERIES)).toBe(at(105));
    expect(logger.warn).not.toHaveBeenCalled();

    // 15 candle baru dengan maxReplay 10 → hanya 10 terakhir (111..120) dievaluasi; 5 candle lama dilewati & dicatat.
    engine.calls.evaluate.length = 0;
    await feed(repos, 121, { htfUpto: 160 });
    expect(await pipeline.onClosedCandles(SERIES)).toMatchObject({ evaluated: 10, evaluationTime: at(121) - 1 });
    expect(engine.calls.evaluate.map((e) => e.openTime)).toEqual([111, 112, 113, 114, 115, 116, 117, 118, 119, 120].map(at));
    expect(engine.calls.evaluate[0]).toMatchObject({ count: LOOKBACK, first: at(12) });
    expect(logger.warn).toHaveBeenCalledWith({ symbol: SYMBOL, timeframe: '5m', dropped: 5, maxReplay: MAX_REPLAY }, 'replay reversal dipotong: candle lama tidak dievaluasi');
    expect(await repos.reversal.lastEvaluatedCandleTime(SERIES)).toBe(at(120));
  });

  it('UNIT-RRPL-003 siklus kandidat lewat pipeline: OPENED pada candle historis replay disimpan TANPA alert; STAGE_UP pada candle terbaru → alert (payload lengkap); CANCELLED (close < invalidasi) dari DEVELOPING → alert; kandidat berikutnya = baris baru', async () => {
    const stageOf = { [at(103)]: 'EARLY_FORMATION', [at(106)]: 'DEVELOPING_REVERSAL', [at(108)]: 'EARLY_FORMATION' };
    const { db, repos, engine, pipeline, alerts, logger } = await setup({ script: { stageAt: ({ candle, provisional }) => (provisional ? null : stageOf[candle.openTime] ?? null) } });
    await feed(repos, 101);
    await pipeline.onClosedCandles(SERIES);

    // Replay 101..105: kandidat dibuka pada candle 103 (historis) — tersimpan, kursor maju, tanpa alert.
    await feed(repos, 106);
    const replay = await pipeline.onClosedCandles(SERIES);
    expect(replay).toMatchObject({ evaluated: 5, candidateId: 1, stage: 'EARLY_FORMATION', status: 'NEW', classification: 'NO_SETUP', events: [], alert: false });
    expect(alerts).toEqual([]);
    const open = await repos.reversal.getOpen(SERIES);
    expect(open).toMatchObject({ id: 1, stage: 'EARLY_FORMATION', status: 'NEW', firstDetectedAt: at(104) - 1, lastCandleTime: at(105), barsInStage: 2, evidence: EARLY_IDS });
    expect(open.evidenceDetails).toBeUndefined();
    // transition menerima snapshot tersimpan (dengan id) sebagai prev untuk candle berikutnya.
    expect(engine.calls.transition.slice(-3).map((t) => [t.openTime, t.prevStatus, t.prevId])).toEqual([[at(103), 'NONE', null], [at(104), 'NEW', 1], [at(105), 'NEW', 1]]);
    expect(await repos.reversal.lastEvaluatedCandleTime(SERIES)).toBe(at(105));
    const [row] = await repos.reversal.history({ symbol: SYMBOL });
    expect(row.events.map((e) => [e.type, e.candleTime, e.occurredAt, e.provisional])).toEqual([['OPENED', at(103), at(104) - 1, false]]);
    // Bukti lengkap (label) dari evaluation.evidence ikut tersimpan untuk tampilan.
    expect(row.evidence.map((e) => [e.id, e.label])).toEqual([['LL_SHALLOWER', 'Lower low makin dangkal'], ['ATR_CONTRACTION', 'Volatilitas mengerut'], ['VOLUME_DRY_UP', 'Volume mengering']]);

    // Candle 106 (terbaru) → STAGE_UP → alert sekali dengan payload lengkap.
    await feed(repos, 107);
    const up = await pipeline.onClosedCandles(SERIES);
    expect(up).toMatchObject({ evaluated: 1, candidateId: 1, stage: 'DEVELOPING_REVERSAL', status: 'DEVELOPING', alert: true });
    expect(up.events.map((e) => e.type)).toEqual(['STAGE_UP']);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ symbol: SYMBOL, timeframe: '5m', candidateId: 1, stage: 'DEVELOPING_REVERSAL', status: 'DEVELOPING' });
    expect(alerts[0].events.map((e) => e.type)).toEqual(['STAGE_UP']);
    expect(alerts[0].snapshot).toMatchObject({ stage: 'DEVELOPING_REVERSAL', status: 'DEVELOPING', lastCandleTime: at(106) });
    expect(alerts[0].evaluation).toMatchObject({ stage: 'DEVELOPING_REVERSAL', provisional: false, candleOpenTime: at(106) });
    expect(logger.info).toHaveBeenCalledWith({ symbol: SYMBOL, timeframe: '5m', stage: 'DEVELOPING_REVERSAL', status: 'DEVELOPING', events: ['STAGE_UP'] }, 'alert kandidat reversal');
    expect(await repos.reversal.getOpen(SERIES)).toMatchObject({ id: 1, stage: 'DEVELOPING_REVERSAL', status: 'DEVELOPING', barsInStage: 0, evidence: IDS_OF.DEVELOPING_REVERSAL });

    // Candle 107 ditutup jauh di bawah invalidasi → CANCELLED dari DEVELOPING → alert; kandidat tertutup.
    const invalidation = (await repos.reversal.getOpen(SERIES)).levels.invalidation;
    const crash = { ...ALL[107], high: Math.max(ALL[107].open, 100) + 0.5, low: invalidation - 6, close: invalidation - 5 };
    await repos.candles.upsertClosed([crash], { now: NOW });
    const cancel = await pipeline.onClosedCandles(SERIES);
    expect(cancel).toMatchObject({ evaluated: 1, candidateId: 1, stage: 'DEVELOPING_REVERSAL', status: 'CANCELLED', alert: true });
    expect(alerts).toHaveLength(2);
    expect(alerts[1].events.map((e) => [e.type, e.toStatus])).toEqual([['CANCELLED', 'CANCELLED']]);
    expect(await repos.reversal.getOpen(SERIES)).toBeNull();
    expect((await repos.reversal.history({ symbol: SYMBOL }))[0]).toMatchObject({ id: 1, status: 'CANCELLED', closeReason: 'CLOSE_BELOW_INVALIDATION', closedAt: at(108) - 1 });

    // Candle 108 → kandidat BARU (baris ke-2); kandidat lama tetap di riwayat.
    await feed(repos, 109);
    const reopened = await pipeline.onClosedCandles(SERIES);
    expect(reopened).toMatchObject({ candidateId: 2, stage: 'EARLY_FORMATION', status: 'NEW', alert: true });
    expect(count(db, 'reversal_candidates')).toBe(2);
    expect((await repos.reversal.history({ symbol: SYMBOL })).map((r) => [r.id, r.status])).toEqual([[2, 'NEW'], [1, 'CANCELLED']]);
    expect(alerts).toHaveLength(3);
  });

  it('UNIT-RRPL-004 histeresis masuk tahap (enterConfirmBars 2) hidup di memori: candle pertama bertahap hanya memajukan kursor (tanpa kandidat), candle kedua membuka; instance baru (restart) mulai menghitung dari awal — tidak pernah membuka kandidat palsu', async () => {
    const script = { stageAt: ({ candle, provisional }) => (!provisional && candle.openTime >= at(100) ? 'EARLY_FORMATION' : null) };
    const { db, repos, engine, pipeline, alerts, deps } = await setup({ script, params: { enterConfirmBars: 2 } });
    await feed(repos, 101);
    expect(await pipeline.onClosedCandles(SERIES)).toMatchObject({ evaluated: 1, candidateId: null, status: 'NONE', events: [], alert: false });
    expect(count(db, 'reversal_candidates')).toBe(0);
    expect(await repos.reversal.lastEvaluatedCandleTime(SERIES)).toBe(at(100));

    await feed(repos, 102);
    expect(await pipeline.onClosedCandles(SERIES)).toMatchObject({ evaluated: 1, candidateId: 1, stage: 'EARLY_FORMATION', status: 'NEW', alert: true });
    expect(engine.calls.transition.at(-1)).toMatchObject({ openTime: at(101), prevStatus: 'NONE', prevId: null });
    expect(alerts).toHaveLength(1);
    expect((await repos.reversal.getOpen(SERIES)).firstDetectedAt).toBe(at(102) - 1);

    // Restart: instance baru tanpa snapshot NONE di memori. Setelah kandidat ditutup, butuh 2 candle lagi untuk membuka.
    await pipeline.closeSymbol({ symbol: SYMBOL, reason: 'MONITORING_STOPPED', at: NOW });
    const fresh = createReversalPipeline(deps);
    await feed(repos, 103);
    expect(await fresh.onClosedCandles(SERIES)).toMatchObject({ evaluated: 1, candidateId: null, status: 'NONE' });
    await feed(repos, 104);
    expect(await fresh.onClosedCandles(SERIES)).toMatchObject({ evaluated: 1, candidateId: 2, status: 'NEW', alert: true });
    expect(count(db, 'reversal_candidates')).toBe(2);
  });

  it('UNIT-RRPL-010 mesin gagal pada satu candle replay → candle itu dilewati (dicatat logger.error + hasil.errors, kursor maju) dan replay berlanjut; error REPOSITORI tetap dilempar dan candle dievaluasi ulang pada panggilan berikutnya', async () => {
    const script = { failWhen: (e) => !e.provisional && e.openTime === at(105) };
    const { repos, engine, pipeline, logger, deps } = await setup({ script });
    await feed(repos, 101);
    await pipeline.onClosedCandles(SERIES);
    await feed(repos, 108);
    const result = await pipeline.onClosedCandles(SERIES);
    expect(result).toMatchObject({ evaluated: 6, evaluationTime: at(108) - 1, status: 'NONE', errors: [{ openTime: at(105), message: 'mesin palsu gagal (disengaja)' }] });
    expect(logger.error).toHaveBeenCalledWith({ symbol: SYMBOL, timeframe: '5m', openTime: at(105), err: 'mesin palsu gagal (disengaja)' }, 'evaluasi reversal gagal: candle dilewati');
    expect(evaluations(engine).map((e) => e.openTime)).toEqual([100, 101, 102, 103, 104, 105, 106, 107].map(at));
    expect(await repos.reversal.lastEvaluatedCandleTime(SERIES)).toBe(at(107));
    expect(await pipeline.onClosedCandles(SERIES)).toEqual({ symbol: SYMBOL, timeframe: '5m', skipped: 'ALREADY_EVALUATED' });

    // Semua candle batch gagal → hasil tanpa evaluasi (status null) tetapi kursor tetap maju.
    const allFail = createReversalPipeline({ ...deps, evaluate: () => { throw new Error('rusak'); } });
    await feed(repos, 110);
    expect(await allFail.onClosedCandles(SERIES)).toEqual({
      symbol: SYMBOL, timeframe: '5m', evaluated: 0, evaluationTime: null, candidateId: null, stage: null, status: null, classification: null,
      events: [], alert: false, errors: [{ openTime: at(108), message: 'rusak' }, { openTime: at(109), message: 'rusak' }],
    });
    expect(await repos.reversal.lastEvaluatedCandleTime(SERIES)).toBe(at(109));

    // Error repositori (mis. SQLITE_BUSY) bukan error mesin: dilempar, kursor tidak maju, candle dicoba lagi.
    let busy = true;
    const flaky = { ...repos.reversal, markEvaluated: async (args) => { if (busy) throw new Error('SQLITE_BUSY: database is locked'); return repos.reversal.markEvaluated(args); } };
    const retrying = createReversalPipeline({ ...deps, reversal: flaky });
    await feed(repos, 111);
    await expect(retrying.onClosedCandles(SERIES)).rejects.toThrow('SQLITE_BUSY');
    expect(await repos.reversal.lastEvaluatedCandleTime(SERIES)).toBe(at(109));
    busy = false;
    expect(await retrying.onClosedCandles(SERIES)).toMatchObject({ evaluated: 1, evaluationTime: at(111) - 1, errors: [] });
    expect(await repos.reversal.lastEvaluatedCandleTime(SERIES)).toBe(at(110));
  });
});

describe('pipeline Reversal Radar — provisional (candle berjalan)', () => {
  it('UNIT-RRPL-005 onProvisionalCandle: lookback−1 candle tertutup + candle berjalan dievaluasi provisional: true → baris reversal_provisional (provisional-only di listActive, RUNNING); kursor & kandidat tidak tersentuh; throttle per seri; candle yang sudah tutup → CANDLE_CLOSED; input tidak valid dilewati', async () => {
    const script = { stageAt: ({ provisional }) => (provisional ? 'EARLY_FORMATION' : null) };
    const { db, repos, engine, pipeline, clock, logger } = await setup({ script });
    await feed(repos, 101, { htfUpto: 160 });
    await pipeline.onClosedCandles(SERIES);
    engine.calls.evaluate.length = 0;

    const live = running(101);
    expect(await pipeline.onProvisionalCandle(live)).toEqual({
      symbol: SYMBOL, timeframe: '5m', provisional: true, stage: 'EARLY_FORMATION', stored: true, eventRecorded: false, previousStage: null, candidateId: null,
    });
    expect(engine.calls.evaluate).toEqual([{
      openTime: at(101), provisional: true, count: LOOKBACK, first: at(2), allClosed: false, liquidity: LIQ,
      params: { enterConfirmBars: 1, timeframe: '5m' }, higher: { '15m': htfClosedBy(101, '15m'), '1h': htfClosedBy(101, '1h') },
    }]);
    expect(engine.calls.transition.map((t) => t.openTime)).toEqual([at(100)]); // provisional tidak lewat transition
    expect(provisionalRows(db)).toEqual([{ openTime: at(101), stage: 'EARLY_FORMATION', score: 19 }]);
    expect(count(db, 'reversal_candidates')).toBe(0);
    expect(await repos.reversal.lastEvaluatedCandleTime(SERIES)).toBe(at(100));
    const [view] = await repos.reversal.listActive();
    expect(view).toMatchObject({ id: null, symbol: SYMBOL, timeframe: '5m', stage: 'EARLY_FORMATION', status: 'NEW', provisionalOnly: true, candleStatus: 'RUNNING', score: 19 });
    expect(view.provisional).toMatchObject({ stage: 'EARLY_FORMATION', candleOpenTime: at(101), evaluatedAt: NOW });

    // Throttle: dalam provisionalMinIntervalMs seri yang sama dilewati tanpa evaluasi; setelah jeda dievaluasi lagi.
    expect(await pipeline.onProvisionalCandle(running(101, { close: live.close + 0.5 }))).toEqual({ symbol: SYMBOL, timeframe: '5m', skipped: 'THROTTLED' });
    expect(engine.calls.evaluate).toHaveLength(1);
    clock.advance(14_999);
    expect(await pipeline.onProvisionalCandle(live)).toMatchObject({ skipped: 'THROTTLED' });
    clock.advance(1);
    expect(await pipeline.onProvisionalCandle(live)).toMatchObject({ stored: true });
    expect(engine.calls.evaluate).toHaveLength(2);
    expect(provisionalRows(db)).toEqual([{ openTime: at(101), stage: 'EARLY_FORMATION', score: 19 }]);

    // Candle berjalan yang openTime-nya ≤ kursor (sudah dievaluasi tertutup) → dilewati tanpa evaluasi.
    clock.advance(15_000);
    expect(await pipeline.onProvisionalCandle(running(100))).toEqual({ symbol: SYMBOL, timeframe: '5m', skipped: 'CANDLE_CLOSED' });
    expect(engine.calls.evaluate).toHaveLength(2);

    // Input tidak valid / di luar timeframe pipeline: dilewati, tidak dilempar, tidak dievaluasi.
    expect(await pipeline.onProvisionalCandle(null)).toEqual({ skipped: 'INVALID_CANDLE' });
    expect(await pipeline.onProvisionalCandle({ ...live, isClosed: true })).toEqual({ symbol: SYMBOL, timeframe: '5m', skipped: 'INVALID_CANDLE' });
    expect(await pipeline.onProvisionalCandle({ ...live, openTime: 1.5 })).toEqual({ symbol: SYMBOL, timeframe: '5m', skipped: 'INVALID_CANDLE' });
    expect(await pipeline.onProvisionalCandle({ ...live, timeframe: '4h' })).toEqual({ skipped: 'INVALID_CANDLE' });
    const only5m = createReversalPipeline({ repos, reversal: repos.reversal, timeframes: ['5m'], evaluate: engine.evaluate, transition: engine.transition, resolveParams: engine.resolveParams });
    expect(await only5m.onProvisionalCandle({ ...live, timeframe: '15m' })).toEqual({ symbol: SYMBOL, timeframe: '15m', skipped: 'NOT_SCANNED' });
    expect(engine.calls.evaluate).toHaveLength(2);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('UNIT-RRPL-006 provisional dengan kandidat terbuka: tahap provisional lebih tinggi → event PROVISIONAL_STAGE (ditandai) & kolom provisional di listActive; kandidat/kursor tidak berubah; error evaluasi dicatat (warn) dan dikembalikan sebagai { error }, tidak dilempar', async () => {
    let failProvisional = false;
    const script = {
      stageAt: ({ candle, provisional }) => (provisional ? 'DEVELOPING_REVERSAL' : candle.openTime === at(100) ? 'EARLY_FORMATION' : null),
      failWhen: (e) => e.provisional && failProvisional,
    };
    const { repos, engine, pipeline, clock, logger } = await setup({ script });
    await feed(repos, 101);
    expect(await pipeline.onClosedCandles(SERIES)).toMatchObject({ candidateId: 1, stage: 'EARLY_FORMATION' });

    expect(await pipeline.onProvisionalCandle(running(101))).toEqual({
      symbol: SYMBOL, timeframe: '5m', provisional: true, stage: 'DEVELOPING_REVERSAL', stored: true, eventRecorded: true, previousStage: 'EARLY_FORMATION', candidateId: 1,
    });
    const [view] = await repos.reversal.listActive();
    expect(view).toMatchObject({ id: 1, stage: 'EARLY_FORMATION', status: 'NEW', provisionalOnly: false, candleStatus: 'RUNNING' });
    expect(view.provisional).toMatchObject({ stage: 'DEVELOPING_REVERSAL', candleOpenTime: at(101), evidenceCount: 5 });
    const [row] = await repos.reversal.history({ symbol: SYMBOL });
    expect(row.events.map((e) => [e.type, e.provisional, e.fromStage, e.toStage, e.candleTime])).toEqual([
      ['OPENED', false, null, 'EARLY_FORMATION', at(100)],
      ['PROVISIONAL_STAGE', true, 'EARLY_FORMATION', 'DEVELOPING_REVERSAL', at(101)],
    ]);
    expect(await repos.reversal.getOpen(SERIES)).toMatchObject({ id: 1, stage: 'EARLY_FORMATION', lastCandleTime: at(100) });
    expect(await repos.reversal.lastEvaluatedCandleTime(SERIES)).toBe(at(100));

    // Evaluasi provisional gagal: tidak dilempar ke pemanggil (scanner), dicatat sebagai peringatan.
    failProvisional = true;
    clock.advance(15_000);
    expect(await pipeline.onProvisionalCandle(running(101))).toEqual({ symbol: SYMBOL, timeframe: '5m', provisional: true, error: 'mesin palsu gagal (disengaja)' });
    expect(logger.warn).toHaveBeenCalledWith({ symbol: SYMBOL, timeframe: '5m', err: 'mesin palsu gagal (disengaja)' }, 'evaluasi provisional reversal gagal');
    expect(engine.calls.evaluate.filter((e) => e.provisional)).toHaveLength(2);
    // Baris provisional sebelumnya tetap (tidak dihapus oleh evaluasi yang gagal).
    expect((await repos.reversal.listActive())[0].provisional.stage).toBe('DEVELOPING_REVERSAL');
  });

  it('UNIT-RRPL-007 candle tutup membersihkan provisional candle itu (dan yang lebih lama) — evaluasi provisional candle BERIKUTNYA yang sudah masuk sebelum evaluasi tutup tidak ikut hilang (antrean seri: provisional dulu, lalu tutup)', async () => {
    const script = { stageAt: ({ provisional }) => (provisional ? 'EARLY_FORMATION' : null) };
    const { db, repos, engine, pipeline, clock } = await setup({ script });
    await feed(repos, 101);
    await pipeline.onClosedCandles(SERIES);
    await pipeline.onProvisionalCandle(running(101));
    expect(provisionalRows(db).map((r) => r.openTime)).toEqual([at(101)]);

    // Candle 101 tutup → evaluasi tutup menghapus baris provisional 101.
    await feed(repos, 102);
    await pipeline.onClosedCandles(SERIES);
    expect(provisionalRows(db)).toEqual([]);

    // Candle 102 tutup dan kline berjalan 103 tiba sebelum evaluasi tutup 102 dijalankan: keduanya diserialkan
    // (provisional 103 dulu), lalu clearProvisional(upToOpenTime 102) membiarkan baris 103.
    await feed(repos, 103);
    clock.advance(15_000);
    const order = [];
    const p1 = pipeline.onProvisionalCandle(running(103)).then((r) => order.push(['provisional', r.stored]));
    const p2 = pipeline.onClosedCandles(SERIES).then((r) => order.push(['closed', r.evaluated]));
    await Promise.all([p1, p2]);
    expect(order).toEqual([['provisional', true], ['closed', 1]]);
    expect(engine.calls.evaluate.slice(-2).map((e) => [e.openTime, e.provisional])).toEqual([[at(103), true], [at(102), false]]);
    expect(provisionalRows(db).map((r) => r.openTime)).toEqual([at(103)]);
    expect(await repos.reversal.lastEvaluatedCandleTime(SERIES)).toBe(at(102));
  });
});

describe('pipeline Reversal Radar — penutupan seri, serialisasi, validasi', () => {
  it('UNIT-RRPL-008 closeSymbol: kandidat terbuka seri yang berhenti dipantau → EXPIRED (reason) tanpa alert, provisional dibersihkan; timeframes tertentu saja; evaluasi berikutnya membuka kandidat baru', async () => {
    const script = { stageAt: ({ candle, provisional }) => (provisional ? 'EARLY_FORMATION' : candle.openTime >= at(100) ? 'EARLY_FORMATION' : null) };
    const { db, repos, pipeline, alerts, logger } = await setup({ script });
    await feed(repos, 101);
    await pipeline.onClosedCandles(SERIES);
    await pipeline.onProvisionalCandle(running(101));
    expect(count(db, 'reversal_provisional')).toBe(1);

    // Hanya timeframe lain → tidak ada yang ditutup.
    expect(await pipeline.closeSymbol({ symbol: SYMBOL, timeframes: ['15m', '1h'], reason: 'MONITORING_STOPPED', at: NOW })).toEqual({ closed: [] });
    expect(await repos.reversal.getOpen(SERIES)).toMatchObject({ id: 1 });

    const closed = await pipeline.closeSymbol({ symbol: SYMBOL, reason: 'SYMBOL_DELISTED', at: NOW + 1_000 });
    expect(closed).toEqual({ closed: [{ id: 1, timeframe: '5m', fromStage: 'EARLY_FORMATION', fromStatus: 'NEW', price: ALL[100].close }] });
    expect(logger.info).toHaveBeenCalledWith({ symbol: SYMBOL, reason: 'SYMBOL_DELISTED', closed: ['5m:EARLY_FORMATION'] }, 'kandidat reversal ditutup: seri berhenti dipantau');
    expect(await repos.reversal.getOpen(SERIES)).toBeNull();
    expect(count(db, 'reversal_provisional')).toBe(0);
    const [row] = await repos.reversal.history({ symbol: SYMBOL });
    expect(row).toMatchObject({ id: 1, status: 'EXPIRED', closeReason: 'SYMBOL_DELISTED', closedAt: NOW + 1_000 });
    expect(row.events.map((e) => e.type)).toEqual(['OPENED', 'EXPIRED']);
    expect(alerts).toHaveLength(1); // hanya alert OPENED; penutupan paksa tidak di-alert

    await feed(repos, 102);
    expect(await pipeline.onClosedCandles(SERIES)).toMatchObject({ candidateId: 2, stage: 'EARLY_FORMATION', alert: true });
    expect(await repos.reversal.closeOpenForSymbol({ symbol: 'ZZZUSDT', reason: 'MONITORING_STOPPED', at: NOW })).toEqual({ closed: [] });
  });

  it('UNIT-RRPL-009 serialisasi per seri (evaluasi bersamaan tidak ganda), giliran event loop tiap yieldEvery candle, NOT_SCANNED / NO_DATA, dan timeframe pipeline', async () => {
    const yieldToEventLoop = vi.fn(async () => {});
    const { repos, engine, pipeline } = await setup({ pipeline: { yieldEvery: 2, yieldToEventLoop, timeframes: ['5m', '1h'] } });
    expect(pipeline.timeframes).toEqual(['5m', '1h']);
    expect(Object.isFrozen(pipeline.timeframes)).toBe(true);
    expect(await pipeline.onClosedCandles(SERIES)).toEqual({ symbol: SYMBOL, timeframe: '5m', skipped: 'NO_DATA' });
    expect(await pipeline.onClosedCandles({ symbol: SYMBOL, timeframe: '15m' })).toEqual({ symbol: SYMBOL, timeframe: '15m', skipped: 'NOT_SCANNED' });
    expect(await repos.reversal.lastEvaluatedCandleTime(SERIES)).toBeNull();

    await feed(repos, 101);
    const [a, b] = await Promise.all([pipeline.onClosedCandles(SERIES), pipeline.onClosedCandles(SERIES)]);
    expect(a).toMatchObject({ evaluated: 1 });
    expect(b).toEqual({ symbol: SYMBOL, timeframe: '5m', skipped: 'ALREADY_EVALUATED' });
    expect(engine.calls.evaluate).toHaveLength(1);
    expect(yieldToEventLoop).not.toHaveBeenCalled();

    // Replay 5 candle dengan yieldEvery 2 → giliran event loop sebelum evaluasi ke-3 dan ke-5.
    await feed(repos, 106);
    expect(await pipeline.onClosedCandles(SERIES)).toMatchObject({ evaluated: 5 });
    expect(yieldToEventLoop).toHaveBeenCalledTimes(2);

    await expect(pipeline.onClosedCandles({ symbol: SYMBOL, timeframe: '4h' })).rejects.toThrow(RangeError);
    await expect(pipeline.onClosedCandles({ symbol: '', timeframe: '5m' })).rejects.toThrow(TypeError);
  });

  it('NEG-RRPL-001 dependensi & opsi tidak valid ditolak saat dibuat', async () => {
    const { repos, engine, deps } = await setup();
    const base = { ...deps };
    expect(() => createReversalPipeline({ ...base, repos: {} })).toThrow(TypeError);
    expect(() => createReversalPipeline({ ...base, reversal: null })).toThrow(TypeError);
    expect(() => createReversalPipeline({ ...base, reversal: { ...repos.reversal, setProvisional: undefined } })).toThrow(/setProvisional/);
    expect(() => createReversalPipeline({ ...base, lookback: 99 })).toThrow(RangeError);
    expect(() => createReversalPipeline({ ...base, lookback: 1501 })).toThrow(RangeError);
    expect(() => createReversalPipeline({ ...base, maxReplay: 0 })).toThrow(RangeError);
    expect(() => createReversalPipeline({ ...base, yieldEvery: 0 })).toThrow(RangeError);
    expect(() => createReversalPipeline({ ...base, provisionalMinIntervalMs: -1 })).toThrow(RangeError);
    expect(() => createReversalPipeline({ ...base, provisionalMinIntervalMs: 3_600_001 })).toThrow(RangeError);
    expect(() => createReversalPipeline({ ...base, evaluate: 'x' })).toThrow(TypeError);
    expect(() => createReversalPipeline({ ...base, transition: null })).toThrow(TypeError);
    expect(() => createReversalPipeline({ ...base, resolveParams: 1 })).toThrow(TypeError);
    expect(() => createReversalPipeline({ ...base, params: [] })).toThrow(TypeError);
    expect(() => createReversalPipeline({ ...base, params: null })).toThrow(TypeError);
    expect(() => createReversalPipeline({ ...base, clock: 'now' })).toThrow(TypeError);
    expect(() => createReversalPipeline({ ...base, timeframes: '5m' })).toThrow(TypeError);
    expect(() => createReversalPipeline({ ...base, timeframes: ['5m', '4h'] })).toThrow(RangeError);
    expect(() => createReversalPipeline({ ...base, timeframes: ['1h', '5m'] }).timeframes).not.toThrow();
    expect(createReversalPipeline({ ...base, timeframes: ['1h', '5m', '5m'] }).timeframes).toEqual(['5m', '1h']);
    expect(engine.calls.evaluate).toEqual([]);
  });
});
