import { describe, expect, it } from 'vitest';
import { analyzeAt, assessSeriesQuality, createAnalysisPipeline, patternDefinitions } from '../../../backend/analysis/pipeline.js';
import { openDatabase } from '../../../backend/database/connection.js';
import { migrate } from '../../../backend/database/migrate.js';
import { createRepositories } from '../../../backend/database/repositories/index.js';
import { TIMEFRAME_MS } from '../../../backend/market/contracts.js';
import { createSignalRepository } from '../../../backend/signals/index.js';
import { downtrendCandles, silentAccumulationCandles } from '../../fixtures/candles/scenarios.js';
import { withoutCandle, withProvisionalLast } from '../../fixtures/candles/synthetic.js';

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
    expect(defs.map((d) => [d.key, d.version])).toEqual([['SA', 1], ['PVA', 1]]);
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
    // Kegagalan satu panggilan tidak memblokir antrean seri tersebut.
    expect(await pipeline.onClosedCandles({ symbol: SYMBOL, timeframe: '15m' })).toMatchObject({ skipped: 'NO_DATA' });
  });

  it('NEG-PIPE-005 parameter pola tidak valid ditolak saat pipeline dibuat', async () => {
    const ctx = await setup();
    expect(() => createAnalysisPipeline({ repos: ctx.repos, signals: ctx.signals, params: { sa: { minScore: 500 } } })).toThrow(RangeError);
  });
});
