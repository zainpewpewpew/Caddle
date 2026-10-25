import { describe, expect, it } from 'vitest';
import { REPLAY_LIQUIDITY_DETAIL, analyzeAt, assessSeriesQuality, createAnalysisPipeline, patternDefinitions } from '../../../backend/analysis/pipeline.js';
import { openDatabase } from '../../../backend/database/connection.js';
import { migrate } from '../../../backend/database/migrate.js';
import { createRepositories } from '../../../backend/database/repositories/index.js';
import { TIMEFRAME_MS } from '../../../backend/market/contracts.js';
import { PatternParamsError } from '../../../backend/patterns/index.js';
import { createSignalRepository } from '../../../backend/signals/index.js';
import { downtrendCandles, silentAccumulationCandles, zigzag } from '../../fixtures/candles/scenarios.js';
import { generateCandles, withoutCandle, withProvisionalLast } from '../../fixtures/candles/synthetic.js';

// Pipeline lengkap dengan detektor SA/PVA asli, konteks HTF, skor, state machine, dan SQLite.
// Semua candle SINTETIS (tests/fixtures/candles) — bukan data pasar nyata.
const SYMBOL = 'SYNUSDT';
const NOW = Date.UTC(2027, 0, 1);

/** Agregasi candle 5m menjadi timeframe lebih tinggi; hanya kelompok lengkap (candle HTF tertutup). */
function aggregate(candles, timeframe) {
  const ms = TIMEFRAME_MS[timeframe];
  const per = ms / TIMEFRAME_MS['5m'];
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

function byTimeframe(m5) {
  return { '5m': m5, '15m': aggregate(m5, '15m'), '1h': aggregate(m5, '1h') };
}

async function setup(db = openDatabase(':memory:')) {
  migrate(db);
  const repos = createRepositories(db, { clock: () => NOW });
  await repos.symbols.upsertFromExchange([{
    symbol: SYMBOL, baseAsset: 'SYN', quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING',
    tickSize: '0.0001', stepSize: '1', onboardDate: 0,
  }], NOW);
  const signals = createSignalRepository(db, { clock: () => NOW });
  return { db, repos, signals };
}

/** Memasukkan candle (5m + HTF yang tertutup pada saat yang sama) lalu memicu pipeline, seperti worker. */
async function feed({ repos, pipeline }, all, upto) {
  const m5 = all.slice(0, upto);
  const last = m5.at(-1);
  const htf = byTimeframe(m5);
  const closing = ['1h', '15m'].flatMap((tf) => htf[tf].filter((c) => c.closeTime === last.closeTime));
  await repos.candles.upsertClosed([...closing, last], { now: NOW });
  return pipeline.onClosedCandles({ symbol: SYMBOL, timeframe: '5m' });
}

const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

/**
 * Skenario SA SINTETIS (sama dengan silentAccumulationCandles(1)) disambung `tail` candle sideways: sinyal
 * pertama terbuka di candle 62 lalu EXPIRED di 88, sinyal QUIET kedua terbuka di 89, sesudahnya tanpa event.
 */
function saThenSideways(tail) {
  const sideways = (bars, volume) => ({ bars, cycle: zigzag(3, 0.002, 3, 0.002), volume, volumeNoise: 0.15 });
  const gradualUp = (bars, volume) => ({ bars, cycle: zigzag(5, 0.0015, 3, 0.0015), wick: 0.002, volume, volumeNoise: 0.1 });
  return generateCandles({ seed: 1, segments: [sideways(48, 1000), gradualUp(28, 450), sideways(tail, 1000)] });
}

/** Memasukkan hanya candle 5m (tanpa HTF) satu per satu dan memicu pipeline per candle. */
async function feedBase({ repos, pipeline }, candles) {
  for (const c of candles) {
    await repos.candles.upsertClosed([c], { now: NOW });
    await pipeline.onClosedCandles({ symbol: SYMBOL, timeframe: '5m' });
  }
}

describe('analyzeAt (murni)', () => {
  it('UNIT-PIPE-001 skenario SA sintetis membuka EARLY_BULLISH dengan alert, skor & penjelasan', () => {
    const all = silentAccumulationCandles(1);
    let prev = null;
    const events = [];
    for (let k = 20; k <= all.length; k += 1) {
      const r = analyzeAt({ symbol: SYMBOL, timeframe: '5m', candlesByTimeframe: byTimeframe(all.slice(0, k)), prev });
      if (r.event) events.push({ k, ...r.event, alert: r.alert, view: r.view });
      prev = r.next;
    }
    expect(events.length).toBeGreaterThan(0);
    const [opened] = events;
    expect(opened.fromState).toBe('NO_PATTERN');
    expect(opened.toState).toBe('EARLY_BULLISH');
    expect(opened.alert).toBe(true);
    expect(opened.view.patternScore).toBeGreaterThanOrEqual(85);
    expect(opened.view.explanation.length).toBeGreaterThan(0);
  });

  it('UNIT-PIPE-002 tanpa lookahead: candle HTF & dasar masa depan tidak mengubah hasil pada waktu t', () => {
    const all = silentAccumulationCandles(2);
    const k = 66;
    const t = all[k - 1].closeTime;
    const past = analyzeAt({ symbol: SYMBOL, timeframe: '5m', candlesByTimeframe: byTimeframe(all.slice(0, k)), prev: null });
    const full = byTimeframe(all);
    // Dasar dipotong di k (pemanggil menentukan titik evaluasi); HTF menyertakan candle masa depan.
    const withFuture = analyzeAt({ symbol: SYMBOL, timeframe: '5m',
      candlesByTimeframe: { '5m': all.slice(0, k), '15m': full['15m'], '1h': full['1h'] }, prev: null });
    expect(withFuture.evaluationTime).toBe(t);
    expect(withFuture.context).toEqual(past.context);
    expect(withFuture.view).toEqual(past.view);
    expect(withFuture.next).toEqual(past.next);
  });

  it('UNIT-PIPE-007 HTF dengan candle kurang dari warm-up (15m: 22, 1h: 5) → trend null INSUFFICIENT_DATA; penjelasan menyebut "tidak tersedia", bukan NEUTRAL', () => {
    const all = silentAccumulationCandles(2);
    const r = analyzeAt({ symbol: SYMBOL, timeframe: '5m', candlesByTimeframe: byTimeframe(all.slice(0, 66)), prev: null });
    expect(r.context.trends['15m']).toMatchObject({ trend: null, reasons: ['INSUFFICIENT_DATA'], candleCount: 22 });
    expect(r.context.trends['1h']).toMatchObject({ trend: null, reasons: ['INSUFFICIENT_DATA'], candleCount: 5 });
    const alignment = r.view.explanation.find((e) => e.factor === 'CONTEXT:ALIGNMENT').detail;
    expect(alignment).toContain('15m tidak tersedia');
    expect(alignment).toContain('1h tidak tersedia');
    expect(alignment).not.toMatch(/(15m|1h) NEUTRAL/);
  });

  it('UNIT-PIPE-003 kualitas seri: celah, candle belum tertutup, campuran seri terdeteksi', () => {
    const all = silentAccumulationCandles(1);
    expect(assessSeriesQuality(all, '5m')).toEqual({ ok: true, issues: [] });
    expect(assessSeriesQuality(withoutCandle(all, 10), '5m').issues).toEqual(['GAP:1']);
    expect(assessSeriesQuality(withProvisionalLast(all), '5m').issues).toContain('UNCLOSED_CANDLE');
    expect(assessSeriesQuality([...all.slice(0, 5), { ...all[5], symbol: 'OTHERUSDT' }], '5m').issues).toContain('MIXED_SERIES');
  });

  it('NEG-PIPE-001 seri dengan celah → risk flag DATA_QUALITY dan tidak membuka sinyal', () => {
    const all = withoutCandle(silentAccumulationCandles(1), 40);
    let prev = null;
    for (let k = 20; k <= all.length; k += 1) {
      const r = analyzeAt({ symbol: SYMBOL, timeframe: '5m', candlesByTimeframe: { '5m': all.slice(0, k) }, prev });
      if (k > 41) expect(r.view.riskFlags).toContain('DATA_QUALITY');
      prev = r.next;
    }
    // Celah masih berada dalam jendela pola (63 candle) di akhir skenario → deteksi diblokir.
    expect(prev.state).toBe('NO_PATTERN');
  });

  it('NEG-PIPE-002 downtrend sintetis tidak pernah menghasilkan sinyal', () => {
    const all = downtrendCandles(1);
    let prev = null;
    for (let k = 20; k <= all.length; k += 1) {
      const r = analyzeAt({ symbol: SYMBOL, timeframe: '5m', candlesByTimeframe: byTimeframe(all.slice(0, k)), prev });
      expect(r.event).toBeNull();
      prev = r.next;
    }
  });

  it('NEG-PIPE-003 timeframe tidak didukung ditolak; seri kosong → null', () => {
    expect(() => analyzeAt({ symbol: SYMBOL, timeframe: '4h', candlesByTimeframe: {}, prev: null })).toThrow(RangeError);
    expect(analyzeAt({ symbol: SYMBOL, timeframe: '5m', candlesByTimeframe: { '5m': [] }, prev: null })).toBeNull();
  });

  it('UNIT-PIPE-004 definisi pola berversi memuat parameter efektif & kondisi', () => {
    const defs = patternDefinitions();
    expect(defs.map((d) => [d.key, d.version])).toEqual([['SA', 2], ['PVA', 2]]);
    expect(defs[0].definition.params.minScore).toBe(85);
    expect(defs[0].definition.requiredCandles).toBe(63);
    expect(defs[1].definition.conditions.some((c) => c.id === 'noSpikeDominance')).toBe(true);
  });
});

describe('createAnalysisPipeline (SQLite)', () => {
  it('POS-PIPE-001 replay candle demi candle: sinyal SA tersimpan dengan event, penjelasan, dan definisi pola', async () => {
    const ctx = await setup();
    const alerts = [];
    const pipeline = createAnalysisPipeline({ repos: ctx.repos, signals: ctx.signals, onAlert: (a) => alerts.push(a) });
    const all = silentAccumulationCandles(1);
    for (let k = 1; k <= all.length; k += 1) await feed({ ...ctx, pipeline }, all, k);

    expect(count(ctx.db, 'pattern_definitions')).toBe(2);
    const history = await ctx.signals.history({ symbol: SYMBOL, limit: 10 });
    expect(history).toHaveLength(1);
    const [signal] = history;
    expect(signal.classification).toMatch(/SA|BOTH/);
    expect(signal.events[0]).toMatchObject({ fromState: 'NO_PATTERN', toState: 'EARLY_BULLISH' });
    expect(signal.events.length).toBeGreaterThanOrEqual(1);
    expect(signal.explanation.length).toBeGreaterThan(0);
    expect(alerts.length).toBe(signal.events.filter((e) => e.toState !== 'QUIET' && e.toState !== 'EXPIRED').length);
    expect(alerts[0]).toMatchObject({ symbol: SYMBOL, timeframe: '5m', state: 'EARLY_BULLISH' });
  });

  it('EDGE-PIPE-001 candle yang sama dipicu ulang → dilewati, tanpa event ganda', async () => {
    const ctx = await setup();
    const pipeline = createAnalysisPipeline({ repos: ctx.repos, signals: ctx.signals });
    const all = silentAccumulationCandles(1);
    for (let k = 1; k <= all.length; k += 1) await feed({ ...ctx, pipeline }, all, k);
    const events = count(ctx.db, 'signal_events');
    const again = await pipeline.onClosedCandles({ symbol: SYMBOL, timeframe: '5m' });
    expect(again.skipped).toBe('ALREADY_EVALUATED');
    expect(count(ctx.db, 'signal_events')).toBe(events);
  });

  it('EDGE-PIPE-002 pemicu bersamaan untuk seri yang sama diserialkan → tepat satu sinyal terbuka', async () => {
    const ctx = await setup();
    const pipeline = createAnalysisPipeline({ repos: ctx.repos, signals: ctx.signals });
    const all = silentAccumulationCandles(1);
    const detectAt = 63;
    for (let k = 1; k < detectAt; k += 1) await feed({ ...ctx, pipeline }, all, k);
    await ctx.repos.candles.upsertClosed([all[detectAt - 1]], { now: NOW });
    const results = await Promise.all(Array.from({ length: 5 }, () => pipeline.onClosedCandles({ symbol: SYMBOL, timeframe: '5m' })));
    expect(results.filter((r) => r.event).length).toBe(1);
    expect(results.filter((r) => r.skipped === 'ALREADY_EVALUATED').length).toBe(4);
    expect(count(ctx.db, 'signals')).toBe(1);
  });

  it('EDGE-PIPE-003 setelah restart, candle terakhir yang sudah menghasilkan event tidak dievaluasi ulang', async () => {
    const ctx = await setup();
    const first = createAnalysisPipeline({ repos: ctx.repos, signals: ctx.signals });
    const all = silentAccumulationCandles(1);
    for (let k = 1; k <= 63; k += 1) await feed({ ...ctx, pipeline: first }, all, k);
    expect(count(ctx.db, 'signal_events')).toBe(1);
    const restarted = createAnalysisPipeline({ repos: ctx.repos, signals: ctx.signals });
    const r = await restarted.onClosedCandles({ symbol: SYMBOL, timeframe: '5m' });
    expect(r.skipped).toBe('ALREADY_EVALUATED');
    // Candle berikutnya tetap diproses melanjutkan sinyal yang sama.
    await feed({ ...ctx, pipeline: restarted }, all, 64);
    expect(count(ctx.db, 'signals')).toBe(1);
  });

  it('EDGE-PIPE-007 restart setelah candle tanpa event: candle yang sudah dievaluasi tidak di-replay (kursor analisis persisten), hanya candle baru', async () => {
    const ctx = await setup();
    const all = saThenSideways(60);
    await feedBase({ ...ctx, pipeline: createAnalysisPipeline({ repos: ctx.repos, signals: ctx.signals }) }, all.slice(0, -1));
    const lastEvent = await ctx.signals.lastEventCandleTime({ symbol: SYMBOL, timeframe: '5m' });
    // Guard fixture: event terakhir (candle 89) jauh sebelum candle terakhir yang dievaluasi (134).
    expect(lastEvent).toBe(all[89].openTime);
    expect(await ctx.signals.lastEvaluatedCandleTime({ symbol: SYMBOL, timeframe: '5m' })).toBe(all.at(-2).openTime);
    const events = count(ctx.db, 'signal_events');

    // Restart tanpa candle baru → tidak ada yang dievaluasi ulang.
    const restarted = createAnalysisPipeline({ repos: ctx.repos, signals: ctx.signals });
    expect(await restarted.onClosedCandles({ symbol: SYMBOL, timeframe: '5m' })).toMatchObject({ skipped: 'ALREADY_EVALUATED' });
    // Satu candle baru → tepat satu evaluasi (bukan 135 − 89 = 46 candle sejak event terakhir).
    await ctx.repos.candles.upsertClosed([all.at(-1)], { now: NOW });
    const r = await createAnalysisPipeline({ repos: ctx.repos, signals: ctx.signals }).onClosedCandles({ symbol: SYMBOL, timeframe: '5m' });
    expect(r.evaluated).toBe(1);
    expect(count(ctx.db, 'signal_events')).toBe(events);
    expect(await ctx.signals.lastEvaluatedCandleTime({ symbol: SYMBOL, timeframe: '5m' })).toBe(all.at(-1).openTime);
  });

  it('EDGE-PIPE-008 replay panjang memberi giliran ke event loop tiap yieldEvery (25) candle → timer/heartbeat tidak tertahan sampai replay selesai', async () => {
    const ctx = await setup();
    const all = saThenSideways(60);
    // getOpen dipanggil tepat sekali per candle yang dievaluasi.
    let evaluatedCandles = 0;
    const signals = { ...ctx.signals, getOpen: async (a) => { evaluatedCandles += 1; return ctx.signals.getOpen(a); } };
    const pipeline = createAnalysisPipeline({ repos: ctx.repos, signals });
    await feedBase({ ...ctx, pipeline }, all.slice(0, 1));
    await ctx.repos.candles.upsertClosed(all.slice(1, 81), { now: NOW });
    evaluatedCandles = 0;
    const ticks = [];
    setImmediate(() => ticks.push(evaluatedCandles));
    const r = await pipeline.onClosedCandles({ symbol: SYMBOL, timeframe: '5m' });
    expect(r.evaluated).toBe(80);
    expect(evaluatedCandles).toBe(80);
    // Callback setImmediate yang dijadwalkan sebelum replay berjalan setelah 25 candle, bukan setelah 80.
    expect(ticks).toEqual([25]);
    expect(() => createAnalysisPipeline({ repos: ctx.repos, signals: ctx.signals, yieldEvery: 0 })).toThrow(RangeError);
  });

  it('EDGE-PIPE-009 empat seri me-replay 80 candle bersamaan (yieldEvery 25) → tiap giliran event loop paling banyak 25 candle TOTAL (anggaran bersama), bukan 4 × 25', async () => {
    const ctx = await setup();
    // Simbol SINTETIS tambahan; seri sama persis (saThenSideways) dengan symbol berbeda.
    const symbols = [SYMBOL, 'SYNBUSDT', 'SYNCUSDT', 'SYNDUSDT'];
    await ctx.repos.symbols.upsertFromExchange(symbols.slice(1).map((symbol) => ({
      symbol, baseAsset: symbol.replace('USDT', ''), quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING',
      tickSize: '0.0001', stepSize: '1', onboardDate: 0,
    })), NOW);
    let evaluatedCandles = 0;
    const signals = { ...ctx.signals, getOpen: async (a) => { evaluatedCandles += 1; return ctx.signals.getOpen(a); } };
    const pipeline = createAnalysisPipeline({ repos: ctx.repos, signals });
    const series = symbols.map((symbol) => saThenSideways(60).map((c) => ({ ...c, symbol })));
    // Candle pertama tiap seri = bootstrap (kursor), lalu 80 candle baru tersimpan sekaligus (gap di-backfill).
    for (const candles of series) {
      await ctx.repos.candles.upsertClosed(candles.slice(0, 1), { now: NOW });
      await pipeline.onClosedCandles({ symbol: candles[0].symbol, timeframe: '5m' });
      await ctx.repos.candles.upsertClosed(candles.slice(1, 81), { now: NOW });
    }
    evaluatedCandles = 0;
    // Probe: callback setImmediate berantai mencatat jumlah candle yang sudah dievaluasi tiap giliran.
    const ticks = [];
    let done = false;
    const probe = () => { ticks.push(evaluatedCandles); if (!done) setImmediate(probe); };
    setImmediate(probe);
    const results = await Promise.all(symbols.map((symbol) => pipeline.onClosedCandles({ symbol, timeframe: '5m' })));
    done = true;
    expect(results.map((r) => r.evaluated)).toEqual([80, 80, 80, 80]);
    expect(evaluatedCandles).toBe(320);
    // 320 candle / 25 per giliran → probe berjalan sedikitnya 12 kali selama replay (tidak tertahan sampai selesai).
    expect(ticks.length).toBeGreaterThanOrEqual(12);
    const perTurn = ticks.map((t, i) => t - (i === 0 ? 0 : ticks[i - 1]));
    expect(Math.max(...perTurn, 320 - ticks.at(-1))).toBeLessThanOrEqual(25);
    // Hasil tetap identik dengan replay satu seri: state akhir sama untuk keempat simbol.
    expect(new Set(results.map((r) => r.state)).size).toBe(1);
  });

  it('POS-PIPE-002 close di bawah invalidation menutup sinyal (INVALIDATED) dan tidak membuka ulang di candle yang sama', async () => {
    const ctx = await setup();
    const pipeline = createAnalysisPipeline({ repos: ctx.repos, signals: ctx.signals });
    const all = silentAccumulationCandles(1);
    for (let k = 1; k <= 64; k += 1) await feed({ ...ctx, pipeline }, all, k);
    const open = await ctx.signals.getOpen({ symbol: SYMBOL, timeframe: '5m' });
    expect(open).not.toBeNull();
    const last = all[63];
    const crashClose = open.invalidationPrice * 0.98;
    const crash = { ...last, openTime: last.openTime + 300_000, closeTime: last.closeTime + 300_000,
      open: last.close, high: last.close, low: crashClose * 0.999, close: crashClose };
    const r = await feed({ ...ctx, pipeline }, [...all.slice(0, 64), crash], 65);
    expect(r.event).toMatchObject({ toState: 'INVALIDATED', reason: 'CLOSE_BELOW_INVALIDATION' });
    expect(await ctx.signals.getOpen({ symbol: SYMBOL, timeframe: '5m' })).toBeNull();
    const [closed] = await ctx.signals.history({ symbol: SYMBOL, limit: 1 });
    expect(closed.closedAt).not.toBeNull();
    expect(closed.finalOutcome).toMatch(/^INVALIDATED:/);
    expect((await pipeline.onClosedCandles({ symbol: SYMBOL, timeframe: '5m' })).skipped).toBe('ALREADY_EVALUATED');
    expect(count(ctx.db, 'signals')).toBe(1);
  });

  it('NEG-PIPE-004 tanpa candle → NO_DATA; dependensi wajib & lookback divalidasi', async () => {
    const ctx = await setup();
    const pipeline = createAnalysisPipeline({ repos: ctx.repos, signals: ctx.signals });
    expect(await pipeline.onClosedCandles({ symbol: SYMBOL, timeframe: '15m' })).toMatchObject({ skipped: 'NO_DATA' });
    await expect(pipeline.onClosedCandles({ symbol: SYMBOL, timeframe: '1d' })).rejects.toThrow(RangeError);
    expect(() => createAnalysisPipeline({ repos: {}, signals: ctx.signals })).toThrow(TypeError);
    expect(() => createAnalysisPipeline({ repos: ctx.repos, signals: ctx.signals, lookback: 10 })).toThrow(RangeError);
    // Panggilan berikutnya setelah panggilan yang gagal tetap berjalan.
    expect(await pipeline.onClosedCandles({ symbol: SYMBOL, timeframe: '15m' })).toMatchObject({ skipped: 'NO_DATA' });

    // Kegagalan satu evaluasi tidak memblokir antrean seri YANG SAMA: dua panggilan SYNUSDT:15m diantrekan
    // bersamaan, yang pertama gagal (DB sementara gagal sekali), yang kedua — sudah menunggu di belakangnya — tetap selesai.
    let failures = 0;
    const flaky = { ...ctx.repos, candles: { ...ctx.repos.candles, getLatest: async (a) => {
      if (failures === 0) { failures += 1; throw new Error('db sementara gagal'); }
      return ctx.repos.candles.getLatest(a);
    } } };
    const queued = createAnalysisPipeline({ repos: flaky, signals: ctx.signals });
    const first = queued.onClosedCandles({ symbol: SYMBOL, timeframe: '15m' });
    const second = queued.onClosedCandles({ symbol: SYMBOL, timeframe: '15m' });
    const [a, b] = await Promise.allSettled([first, second]);
    expect(a).toMatchObject({ status: 'rejected', reason: { message: 'db sementara gagal' } });
    expect(b).toMatchObject({ status: 'fulfilled', value: { skipped: 'NO_DATA' } });
    expect(failures).toBe(1);
  });

  it('NEG-PIPE-005 parameter pola tidak valid ditolak saat pipeline dibuat', async () => {
    const ctx = await setup();
    expect(() => createAnalysisPipeline({ repos: ctx.repos, signals: ctx.signals, params: { sa: { minScore: 500 } } })).toThrow(RangeError);
  });

  it('NEG-PIPE-007 warm-up parameter pola melebihi lookback pipeline ditolak saat pipeline dibuat, bukan diam-diam insufficientData', async () => {
    const ctx = await setup();
    // SA: rvolPeriod 200 + rvolWindow 5 = 205 candle > lookback 150 (masih ≤ batas global 300).
    expect(() => createAnalysisPipeline({ repos: ctx.repos, signals: ctx.signals, lookback: 150, params: { sa: { rvolPeriod: 200 } } }))
      .toThrow(PatternParamsError);
    expect(() => createAnalysisPipeline({ repos: ctx.repos, signals: ctx.signals, lookback: 300, params: { sa: { rvolPeriod: 200 } } }))
      .not.toThrow();
    expect(() => patternDefinitions({ pva: { rvolPeriod: 200 } }, { maxWarmup: 200 })).toThrow(PatternParamsError);
  });

  it('EDGE-PIPE-005 backfill beberapa candle sekaligus di-replay berurutan: event identik dengan pemrosesan per candle', async () => {
    const all = silentAccumulationCandles(1);
    const sequential = await setup();
    const p1 = createAnalysisPipeline({ repos: sequential.repos, signals: sequential.signals });
    for (let k = 1; k <= all.length; k += 1) await feed({ ...sequential, pipeline: p1 }, all, k);

    const batched = await setup();
    const alerts = [];
    const p2 = createAnalysisPipeline({ repos: batched.repos, signals: batched.signals, onAlert: (a) => alerts.push(a) });
    for (let k = 1; k <= 55; k += 1) await feed({ ...batched, pipeline: p2 }, all, k);
    // Candle 56..76 tiba sekaligus (mis. hasil backfill gap setelah reconnect).
    await batched.repos.candles.upsertClosed(all.slice(55), { now: NOW });
    const r = await p2.onClosedCandles({ symbol: SYMBOL, timeframe: '5m', candles: all.slice(55), reason: 'gap' });
    expect(r.evaluated).toBe(all.length - 55);

    const strip = (h) => h.map((sig) => sig.events.map((e) => [e.candleTime, e.fromState, e.toState]));
    expect(strip(await batched.signals.history({ symbol: SYMBOL }))).toEqual(strip(await sequential.signals.history({ symbol: SYMBOL })));
    // Transisi historis dalam replay tidak memicu alert; hanya candle terbaru yang boleh.
    expect(alerts.length).toBeLessThanOrEqual(1);
  });

  it('EDGE-PIPE-006 replay dibatasi maxReplay dan pemotongan dicatat (tidak diam-diam)', async () => {
    const ctx = await setup();
    const warnings = [];
    const pipeline = createAnalysisPipeline({ repos: ctx.repos, signals: ctx.signals, maxReplay: 5, logger: { warn: (f, m) => warnings.push({ f, m }), info: () => {} } });
    const all = silentAccumulationCandles(1);
    await feed({ ...ctx, pipeline }, all, 1);
    await ctx.repos.candles.upsertClosed(all.slice(1, 30), { now: NOW });
    const r = await pipeline.onClosedCandles({ symbol: SYMBOL, timeframe: '5m' });
    expect(r.evaluated).toBe(5);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].f).toMatchObject({ dropped: 24, maxReplay: 5 });
  });

  it('UNIT-PIPE-005 candle 5m di batas jam menunggu sekali bila candle 1h yang tutup bersamaan belum tersimpan', async () => {
    const ctx = await setup();
    const sleeps = [];
    const pipeline = createAnalysisPipeline({ repos: ctx.repos, signals: ctx.signals, settleMs: 1500, sleep: async (ms) => { sleeps.push(ms); } });
    const all = silentAccumulationCandles(1);
    // Candle ke-12 (indeks 11) tutup tepat di 01:00 UTC → candle 1h 00:00 juga tutup saat itu.
    await ctx.repos.candles.upsertClosed(all.slice(0, 12), { now: NOW });
    await pipeline.onClosedCandles({ symbol: SYMBOL, timeframe: '5m' });
    expect(sleeps).toEqual([1500]);
    // Bila candle 15m & 1h yang tutup bersamaan sudah ada, tidak menunggu.
    await ctx.repos.candles.upsertClosed([...aggregate(all.slice(0, 24), '15m'), ...aggregate(all.slice(0, 24), '1h'), ...all.slice(12, 24)], { now: NOW });
    await pipeline.onClosedCandles({ symbol: SYMBOL, timeframe: '5m' });
    expect(sleeps).toEqual([1500]);
    // Candle yang tidak di batas 15m/1h tidak pernah menunggu.
    await ctx.repos.candles.upsertClosed([all[24]], { now: NOW });
    await pipeline.onClosedCandles({ symbol: SYMBOL, timeframe: '5m' });
    expect(sleeps).toEqual([1500]);
  });

  it('POS-PIPE-003 likuiditas dari discovery diteruskan ke skor → risk flag likuiditas/spread', () => {
    const all = silentAccumulationCandles(1);
    const r = analyzeAt({ symbol: SYMBOL, timeframe: '5m', candlesByTimeframe: byTimeframe(all.slice(0, 63)), prev: null,
      liquidity: { quoteVolume24h: 1_000, spreadBps: 80 } });
    expect(r.view.riskFlags).toEqual(expect.arrayContaining(['POOR_LIQUIDITY', 'WIDE_SPREAD']));
  });

  it('NEG-PIPE-006 replay batch backfill dengan likuiditas buruk saat ini → candle historis tanpa POOR_LIQUIDITY/WIDE_SPREAD dan penjelasan "tidak tersedia (replay)"; hanya candle terbaru memakai likuiditas', async () => {
    const ctx = await setup();
    const saves = [];
    const signals = { ...ctx.signals, save: async (a) => { saves.push(a); return ctx.signals.save(a); } };
    const pipeline = createAnalysisPipeline({ repos: ctx.repos, signals, getLiquidity: () => ({ quoteVolume24h: 1_000, spreadBps: 80 }) });
    const all = silentAccumulationCandles(1);
    for (let k = 1; k <= 55; k += 1) await feed({ ...ctx, pipeline }, all, k);
    // Candle 56..76 tiba sekaligus (backfill): deteksi di candle 62 berada di dalam replay.
    const htf = byTimeframe(all);
    await ctx.repos.candles.upsertClosed([...all.slice(55), ...htf['15m'], ...htf['1h']], { now: NOW });
    const r = await pipeline.onClosedCandles({ symbol: SYMBOL, timeframe: '5m', reason: 'gap' });
    expect(r.evaluated).toBe(all.length - 55);

    const liquidityLine = (s) => s.explanation.find((e) => e.factor === 'CONTEXT:LIQUIDITY').detail;
    const historical = saves.filter((s) => s.snapshot.lastCandleTime < all.at(-1).openTime);
    expect(historical.length).toBeGreaterThan(0);
    expect(historical[0].event).toMatchObject({ fromState: 'NO_PATTERN' });
    for (const s of historical) {
      expect(s.snapshot.riskFlags).not.toContain('POOR_LIQUIDITY');
      expect(s.snapshot.riskFlags).not.toContain('WIDE_SPREAD');
      expect(liquidityLine(s)).toBe(REPLAY_LIQUIDITY_DETAIL);
      expect(s.explanation.some((e) => e.factor === 'RISK:POOR_LIQUIDITY')).toBe(false);
    }
    // Candle terbaru batch memakai ukuran likuiditas saat ini (dengan batas default).
    const latest = saves.at(-1);
    expect(latest.snapshot.lastCandleTime).toBe(all.at(-1).openTime);
    expect(latest.snapshot.riskFlags).toEqual(expect.arrayContaining(['POOR_LIQUIDITY', 'WIDE_SPREAD']));
    expect(liquidityLine(latest)).toMatch(/^Quote volume 24 jam 1000 /);
  });

  it('POS-PIPE-005 closeSymbol (SYMBOL_DELISTED) → sinyal terbuka EXPIRED tanpa alert, diserialkan setelah evaluasi yang sedang berjalan; candle berikutnya membuka sinyal BARU', async () => {
    const ctx = await setup();
    const alerts = [];
    const logs = [];
    const logger = { info: (fields, msg) => logs.push({ fields, msg }), warn() {} };
    const pipeline = createAnalysisPipeline({ repos: ctx.repos, signals: ctx.signals, logger, onAlert: (a) => alerts.push(a) });
    const all = silentAccumulationCandles(1);
    for (let k = 1; k <= 64; k += 1) await feed({ ...ctx, pipeline }, all, k);
    const open = await ctx.signals.getOpen({ symbol: SYMBOL, timeframe: '5m' });
    expect(open).not.toBeNull();
    const alertsBefore = alerts.length;

    // Evaluasi candle 65 dan penutupan dipicu bersamaan: penutupan menunggu evaluasi selesai.
    await ctx.repos.candles.upsertClosed([all[64]], { now: NOW });
    const evaluating = pipeline.onClosedCandles({ symbol: SYMBOL, timeframe: '5m' });
    const closing = pipeline.closeSymbol({ symbol: SYMBOL, reason: 'SYMBOL_DELISTED', at: NOW });
    const [evaluated, result] = await Promise.all([evaluating, closing]);
    expect(evaluated.evaluated).toBe(1);
    expect(result.closed).toEqual([{ id: open.id, timeframe: '5m', fromState: expect.any(String), price: all[64].close }]);
    expect(await ctx.signals.getOpen({ symbol: SYMBOL, timeframe: '5m' })).toBeNull();
    expect(alerts.length).toBe(alertsBefore);
    expect(logs.at(-1)).toMatchObject({ msg: 'sinyal ditutup: simbol berhenti dipantau', fields: { symbol: SYMBOL, reason: 'SYMBOL_DELISTED' } });

    const [closed] = await ctx.signals.history({ symbol: SYMBOL, limit: 10 });
    expect(closed).toMatchObject({ state: 'EXPIRED', closedAt: NOW, finalOutcome: expect.stringMatching(/^EXPIRED:/) });
    expect(closed.events.at(-1)).toMatchObject({ toState: 'EXPIRED', occurredAt: NOW, candleTime: all[64].openTime, detail: { reason: 'SYMBOL_DELISTED' } });

    // Dipantau lagi: candle 66 tanpa pola (NONE) tidak membuka apa pun; candle 67 dengan pola SA lagi
    // membuka sinyal BARU (event pembuka dari NO_PATTERN).
    await feed({ ...ctx, pipeline }, all, 66);
    expect(await ctx.signals.history({ symbol: SYMBOL, limit: 10 })).toHaveLength(1);
    await feed({ ...ctx, pipeline }, all, 67);
    const history = await ctx.signals.history({ symbol: SYMBOL, limit: 10 });
    expect(history).toHaveLength(2);
    expect(history[0].id).not.toBe(open.id);
    expect(history[0]).toMatchObject({ state: expect.not.stringMatching(/EXPIRED|INVALIDATED/), closedAt: null });
    expect(history[0].events[0]).toMatchObject({ fromState: 'NO_PATTERN', candleTime: all[66].openTime });
    expect(await pipeline.closeSymbol({ symbol: SYMBOL, timeframes: ['1h'], reason: 'MONITORING_STOPPED', at: NOW })).toEqual({ closed: [] });
  });

  it('UNIT-PIPE-006 analyzeAt params.view (ambang pengguna 2 jt / 50 bps) → quote volume 2,5 jt & spread 40 bps tidak ditandai; penjelasan memuat batas yang dipakai', () => {
    const all = silentAccumulationCandles(1);
    const input = { symbol: SYMBOL, timeframe: '5m', candlesByTimeframe: byTimeframe(all.slice(0, 63)), prev: null,
      liquidity: { quoteVolume24h: 2_500_000, spreadBps: 40 } };
    // Default (50 jt / 10 bps) → kedua flag; ambang pengguna yang longgar → tanpa flag likuiditas.
    expect(analyzeAt(input).view.riskFlags).toEqual(expect.arrayContaining(['POOR_LIQUIDITY', 'WIDE_SPREAD']));
    const loose = analyzeAt({ ...input, params: { view: { minQuoteVolume24h: 2_000_000, maxSpreadBps: 50 } } });
    expect(loose.view.riskFlags).not.toContain('POOR_LIQUIDITY');
    expect(loose.view.riskFlags).not.toContain('WIDE_SPREAD');
    expect(loose.view.explanation.find((e) => e.factor === 'CONTEXT:LIQUIDITY').detail)
      .toBe('Quote volume 24 jam 2500000 (batas 2000000), spread 40 bps (batas 50)');
    // Ambang lebih ketat dari default → flag dengan batas pengguna di penjelasan.
    const strict = analyzeAt({ ...input, liquidity: { quoteVolume24h: 60_000_000, spreadBps: 8 }, params: { view: { minQuoteVolume24h: 80_000_000, maxSpreadBps: 5 } } });
    expect(strict.view.explanation.find((e) => e.factor === 'RISK:POOR_LIQUIDITY').detail).toBe('Quote volume 24 jam 60000000 < batas 80000000');
    expect(strict.view.explanation.find((e) => e.factor === 'RISK:WIDE_SPREAD').detail).toBe('Spread 8 bps > batas 5 bps');
    expect(() => analyzeAt({ ...input, params: { view: { maxSpreadBps: -1 } } })).toThrow(RangeError);
  });

  it('POS-PIPE-004 getLiquidity menyertakan thresholds (pengaturan pengguna) → sinyal tersimpan & alert memakai batas tersebut, bukan default', async () => {
    const all = silentAccumulationCandles(1);
    const liquidity = { quoteVolume24h: 2_500_000, spreadBps: 40 };
    const run = async (thresholds) => {
      const ctx = await setup();
      const alerts = [];
      const pipeline = createAnalysisPipeline({
        repos: ctx.repos, signals: ctx.signals, onAlert: (a) => alerts.push(a),
        getLiquidity: () => (thresholds ? { ...liquidity, thresholds } : liquidity),
      });
      for (let k = 1; k <= 64; k += 1) await feed({ ...ctx, pipeline }, all, k);
      const [signal] = await ctx.signals.history({ symbol: SYMBOL, limit: 10 });
      return { signal, alerts };
    };
    const byDefault = await run(null);
    expect(byDefault.signal.riskFlags).toEqual(expect.arrayContaining(['POOR_LIQUIDITY', 'WIDE_SPREAD']));

    const user = await run({ minQuoteVolume24h: 5_000_000, maxSpreadBps: 50 });
    expect(user.signal.riskFlags).toContain('POOR_LIQUIDITY');
    expect(user.signal.riskFlags).not.toContain('WIDE_SPREAD');
    expect(user.signal.explanation).toEqual(expect.arrayContaining([
      { factor: 'RISK:POOR_LIQUIDITY', contribution: 0, detail: 'Quote volume 24 jam 2500000 < batas 5000000' },
      { factor: 'CONTEXT:LIQUIDITY', contribution: 0, detail: 'Quote volume 24 jam 2500000 (batas 5000000), spread 40 bps (batas 50)' },
    ]));
    expect(user.alerts[0].view.riskFlags).not.toContain('WIDE_SPREAD');
  });
});
