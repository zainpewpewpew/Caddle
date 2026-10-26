// Audit timing data live: ingesti kline (REST/WS), penutupan candle, backfill, kursor/replay analisis, konteks HTF,
// penanda "Basi", dan bentuk respons API sinyal/pasar. Tujuannya mencari apa pun yang membuat sinyal tampak "ngaco"
// bila dibandingkan dengan grafik Binance. Semua candle SINTETIS (tests/fixtures) — bukan data pasar nyata; Binance
// live tidak dipakai.
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createAnalysisPipeline } from '../../../backend/analysis/pipeline.js';
import { signalRoutes } from '../../../backend/api/signalRoutes.js';
import { marketRoutes } from '../../../backend/api/marketRoutes.js';
import { openDatabase } from '../../../backend/database/connection.js';
import { migrate } from '../../../backend/database/migrate.js';
import { createRepositories } from '../../../backend/database/repositories/index.js';
import { CLOSE_MARGIN_MS, lastClosedOpenTime, planBackfill, planGapFill } from '../../../backend/ingestion/backfill.js';
import { parseKlines } from '../../../backend/ingestion/binance/parse.js';
import { parseKlineMessage } from '../../../backend/ingestion/binance/wsClient.js';
import { validateCandle } from '../../../backend/ingestion/candleValidator.js';
import { TIMEFRAME_MS } from '../../../backend/market/contracts.js';
import { createSignalRepository } from '../../../backend/signals/index.js';
import { buildTimeframeContext, closedAsOf } from '../../../backend/timeframe/context.js';
import { trendWarmup } from '../../../backend/timeframe/trend.js';
import { signalFreshness } from '../../../frontend/js/views/signalFormat.js';
import { silentAccumulationCandles, zigzag } from '../../fixtures/candles/scenarios.js';
import { generateCandles } from '../../fixtures/candles/synthetic.js';

const SYMBOL = 'SYNUSDT';
const NOW = Date.UTC(2027, 0, 1);
const M15 = TIMEFRAME_MS['15m'];
const H1 = TIMEFRAME_MS['1h'];
// Gerbang tier dimatikan agar mekanika state machine (event) dapat diamati pada skenario SA sintetis lama.
const MECHANICS = Object.freeze({ signals: { minEarlyTier: null } });

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../fixtures/binance/${name}`, import.meta.url), 'utf8'));

/** Agregasi candle ke timeframe lebih tinggi; hanya kelompok lengkap (candle HTF yang sudah tertutup). */
function aggregate(candles, timeframe) {
  const ms = TIMEFRAME_MS[timeframe];
  const per = ms / TIMEFRAME_MS[candles[0].timeframe];
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

async function setup() {
  const db = openDatabase(':memory:');
  migrate(db);
  const repos = createRepositories(db, { clock: () => NOW });
  await repos.symbols.upsertFromExchange([{
    symbol: SYMBOL, baseAsset: 'SYN', quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING',
    tickSize: '0.0001', stepSize: '1', onboardDate: 0,
  }], NOW);
  const signals = createSignalRepository(db, { clock: () => NOW });
  return { db, repos, signals };
}

/** Seri 15m naik bertahap (zigzag dengan drift) — cukup panjang agar trend 1h punya warm-up. */
function uptrend15m(bars) {
  return generateCandles({ seed: 7, timeframe: '15m', segments: [{ bars, drift: 0.0008, cycle: zigzag(4, 0.003, 3, 0.002), volume: 1000 }] });
}

/** Membungkus repos.candles.getLatest untuk mencatat seri HTF yang benar-benar dipakai pipeline. */
function recordHtf(repos, timeframe) {
  const seen = [];
  const candles = {
    ...repos.candles,
    getLatest: async (args) => {
      const rows = await repos.candles.getLatest(args);
      if (args.timeframe === timeframe) seen.push(rows);
      return rows;
    },
  };
  return { repos: { ...repos, candles }, seen };
}

describe('ingesti kline: pemetaan field & bendera tertutup', () => {
  it('AUD-LT-001 REST: indeks kolom Binance [o,h,l,c,v,T,q,n,V,Q] dipetakan benar; string desimal → number', () => {
    const { body } = fixture('klines-btcusdt-5m.json');
    const [c] = parseKlines(body, { symbol: 'BTCUSDT', timeframe: '5m', now: body.at(-1)[6] + 10 * 60_000 });
    const row = body[0];
    expect(c).toMatchObject({
      openTime: row[0], open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]),
      volume: Number(row[5]), closeTime: row[6], quoteVolume: Number(row[7]), trades: row[8],
      takerBuyVolume: Number(row[9]), takerBuyQuoteVolume: Number(row[10]), isClosed: true, source: 'rest',
    });
    // Taker buy BUKAN quote volume: base vs quote tidak tertukar.
    expect(c.takerBuyVolume).toBeLessThanOrEqual(c.volume);
    expect(c.takerBuyQuoteVolume).toBeLessThanOrEqual(c.quoteVolume);
  });

  it('AUD-LT-002 REST: candle yang closeTime-nya belum lewat (snapshot candle berjalan) → isClosed false dan ditolak penyimpanan kanonik', () => {
    const { body } = fixture('klines-btcusdt-5m.json');
    const last = body.at(-1);
    // Request dimulai tepat di closeTime candle terakhir (closedBefore = now) → candle itu masih berjalan.
    const parsed = parseKlines(body, { symbol: 'BTCUSDT', timeframe: '5m', now: last[6] });
    expect(parsed.at(-1).isClosed).toBe(false);
    expect(parsed.slice(0, -1).every((c) => c.isClosed)).toBe(true);
  });

  it('AUD-LT-003 WS: x=false → provisional; x=true → tertutup; q/V/Q dipetakan ke quote/takerBuy base/takerBuy quote', () => {
    const k = { t: 1767225600000, T: 1767225899999, s: 'BTCUSDT', i: '5m', o: '94000.1', c: '94080.2', h: '94120', l: '93950.5',
      v: '152.345', n: 2310, x: false, q: '14325678.12345', V: '80.12', Q: '7534567.89' };
    const msg = (x) => JSON.stringify({ stream: 'btcusdt@kline_5m', data: { e: 'kline', E: 1, s: 'BTCUSDT', k: { ...k, x } } });
    const open = parseKlineMessage(msg(false));
    const closed = parseKlineMessage(msg(true));
    expect(open.candle.isClosed).toBe(false);
    expect(closed.candle).toMatchObject({ isClosed: true, open: 94000.1, close: 94080.2, high: 94120, low: 93950.5, volume: 152.345,
      quoteVolume: 14325678.12345, takerBuyVolume: 80.12, takerBuyQuoteVolume: 7534567.89, openTime: k.t, closeTime: k.T });
    // Kline final WS yang tiba sedikit "sebelum" closeTime menurut jam worker (galat ≤ margin) tetap sah.
    expect(validateCandle(closed.candle, { now: k.T - 500 }).ok).toBe(true);
    // Kline bertanda tertutup jauh sebelum closeTime (jam rusak) ditolak.
    expect(validateCandle(closed.candle, { now: k.T - CLOSE_MARGIN_MS - 1 }).ok).toBe(false);
  });

  it('AUD-LT-004 backfill/gap: rencana REST berhenti di candle tertutup terakhir (tanpa candle berjalan)', () => {
    const now = Date.UTC(2026, 9, 26, 10, 7, 30); // 10:07:30 UTC → candle 15m 10:00 masih berjalan
    expect(lastClosedOpenTime(now, '15m')).toBe(Date.UTC(2026, 9, 26, 9, 45));
    const plan = planBackfill({ lastOpenTime: Date.UTC(2026, 9, 26, 8, 0), now, timeframe: '15m' });
    expect(plan.at(-1).endTime).toBe(Date.UTC(2026, 9, 26, 10, 0) - 1);
    const gap = planGapFill({ gaps: [{ from: Date.UTC(2026, 9, 26, 9, 30), to: Date.UTC(2026, 9, 26, 10, 0) }], timeframe: '15m', now });
    expect(gap).toEqual([{ startTime: Date.UTC(2026, 9, 26, 9, 30), endTime: Date.UTC(2026, 9, 26, 10, 0) - 1, limit: 2 }]);
  });
});

describe('kursor & replay pipeline', () => {
  it('AUD-LT-010 setiap candle dievaluasi tepat sekali dan berurutan: bootstrap, live, replay backfill, pemicu ganda', async () => {
    const ctx = await setup();
    const evaluated = [];
    const signals = {
      ...ctx.signals,
      markEvaluated: async (a) => { evaluated.push(a.openTime); return ctx.signals.markEvaluated(a); },
      save: async (a) => { evaluated.push(a.snapshot.lastCandleTime); return ctx.signals.save(a); },
    };
    const pipeline = createAnalysisPipeline({ repos: ctx.repos, signals, params: MECHANICS });
    const all = silentAccumulationCandles(1);
    const run = async (upto) => {
      await ctx.repos.candles.upsertClosed(all.slice(0, upto), { now: NOW });
      return pipeline.onClosedCandles({ symbol: SYMBOL, timeframe: '5m' });
    };
    await run(40); // bootstrap: hanya candle terakhir
    expect(evaluated).toEqual([all[39].openTime]);
    for (let k = 41; k <= 50; k += 1) await run(k); // live satu per satu
    expect((await run(50)).skipped).toBe('ALREADY_EVALUATED'); // pemicu ganda
    await run(all.length); // backfill sekaligus → replay
    const expected = all.slice(39).map((c) => c.openTime);
    expect(evaluated).toEqual(expected);
  });

  it('AUD-LT-011 event: candleTime = openTime, occurredAt = closeTime, price = close candle yang sama', async () => {
    const ctx = await setup();
    const pipeline = createAnalysisPipeline({ repos: ctx.repos, signals: ctx.signals, params: MECHANICS });
    const all = silentAccumulationCandles(1);
    await ctx.repos.candles.upsertClosed(all.slice(0, 1), { now: NOW });
    await pipeline.onClosedCandles({ symbol: SYMBOL, timeframe: '5m' });
    await ctx.repos.candles.upsertClosed(all, { now: NOW });
    await pipeline.onClosedCandles({ symbol: SYMBOL, timeframe: '5m' });
    const byOpen = new Map(all.map((c) => [c.openTime, c]));
    const history = await ctx.signals.history({ symbol: SYMBOL, limit: 10 });
    expect(history.length).toBeGreaterThan(0);
    for (const s of history) {
      const first = byOpen.get(s.firstDetectedAt + 1 - TIMEFRAME_MS['5m']);
      expect(first.close).toBe(s.firstDetectedPrice);
      for (const e of s.events) {
        const c = byOpen.get(e.candleTime);
        expect(e.occurredAt).toBe(c.closeTime);
        if (e.price !== null) expect(e.price).toBe(c.close);
      }
    }
  });
});

describe('konteks HTF saat replay (tanpa lookahead, tanpa HTF yang tertinggal)', () => {
  it('AUD-LT-020 replay: seri HTF yang dimuat cukup panjang untuk titik replay terlama dan tidak pernah memakai candle HTF yang tutup sesudahnya', async () => {
    const ctx = await setup();
    const m15 = uptrend15m(320);
    const { repos, seen } = recordHtf(ctx.repos, '1h');
    const pipeline = createAnalysisPipeline({ repos, signals: ctx.signals });
    await ctx.repos.candles.upsertClosed([...m15.slice(0, 200), ...aggregate(m15.slice(0, 200), '1h')], { now: NOW });
    await pipeline.onClosedCandles({ symbol: SYMBOL, timeframe: '15m' });
    // Backfill lengkap (15m + 1h) 120 candle sekaligus → replay 120 titik.
    await ctx.repos.candles.upsertClosed([...m15, ...aggregate(m15, '1h')], { now: NOW });
    const r = await pipeline.onClosedCandles({ symbol: SYMBOL, timeframe: '15m', reason: 'gap' });
    expect(r.evaluated).toBe(120);
    const htf = seen.at(-1);
    for (const c of m15.slice(200)) {
      const closed = closedAsOf(htf, c.closeTime);
      expect(closed.length).toBeGreaterThanOrEqual(trendWarmup());
      expect(closed.at(-1).closeTime).toBeLessThanOrEqual(c.closeTime);
      // Candle 1h terakhir yang dipakai = candle 1h tertutup terbaru pada closeTime candle 15m (bukan lebih tua).
      expect(closed.at(-1).openTime).toBe(Math.floor((c.closeTime + 1) / H1) * H1 - H1);
    }
  });

  it('AUD-LT-021 BUG replay setelah backfill: candle 1h dari stream paralel belum tersimpan → pipeline menunggu (settle) alih-alih menilai HTF STALE_DATA', async () => {
    const ctx = await setup();
    const m15 = uptrend15m(214);
    const { repos, seen } = recordHtf(ctx.repos, '1h');
    const sleeps = [];
    // Stream 1h selesai backfill selama jeda settle (antrean per stream berjalan paralel di scanner).
    const sleep = async (ms) => {
      sleeps.push(ms);
      await ctx.repos.candles.upsertClosed(aggregate(m15, '1h'), { now: NOW });
    };
    const pipeline = createAnalysisPipeline({ repos, signals: ctx.signals, settleMs: 3000, sleep });
    await ctx.repos.candles.upsertClosed([...m15.slice(0, 200), ...aggregate(m15.slice(0, 200), '1h')], { now: NOW });
    await pipeline.onClosedCandles({ symbol: SYMBOL, timeframe: '15m' });
    expect(sleeps).toEqual([]);
    // Reconnect: stream 15m mem-backfill 14 candle lebih dulu; candle 15m terakhir BUKAN batas jam.
    await ctx.repos.candles.upsertClosed(m15.slice(200), { now: NOW });
    expect((m15.at(-1).closeTime + 1) % H1).not.toBe(0);
    await pipeline.onClosedCandles({ symbol: SYMBOL, timeframe: '15m', reason: 'gap' });
    expect(sleeps).toEqual([3000]);
    const htf = seen.at(-1);
    for (let i = 200; i < m15.length; i += 1) {
      const c = m15[i];
      const context = buildTimeframeContext({ baseTimeframe: '15m', evaluationTime: c.closeTime,
        candlesByTimeframe: { '15m': m15.slice(0, i + 1), '1h': htf } });
      expect(context.trends['1h'].reasons).not.toContain('STALE_DATA');
    }
  });

  it('AUD-LT-022 live: candle 15m bukan batas jam dengan 1h mutakhir → tidak menunggu', async () => {
    const ctx = await setup();
    const m15 = uptrend15m(202);
    const sleeps = [];
    const pipeline = createAnalysisPipeline({ repos: ctx.repos, signals: ctx.signals, settleMs: 3000, sleep: async (ms) => { sleeps.push(ms); } });
    await ctx.repos.candles.upsertClosed([...m15, ...aggregate(m15, '1h')], { now: NOW });
    expect((m15.at(-1).closeTime + 1) % H1).not.toBe(0);
    await pipeline.onClosedCandles({ symbol: SYMBOL, timeframe: '15m' });
    expect(sleeps).toEqual([]);
  });
});

describe('API & UI', () => {
  async function app(deps) {
    const fastify = Fastify();
    await fastify.register(signalRoutes, deps);
    await fastify.register(marketRoutes, deps);
    return fastify;
  }

  it('AUD-LT-030 /api/signals/active: tanpa direction = LONG; lastPrice dari timeframe sinyal sendiri (close candle tertutup terakhir)', async () => {
    const ctx = await setup();
    const m15 = uptrend15m(8);
    const h1 = aggregate(m15, '1h');
    await ctx.repos.candles.upsertClosed([...m15, ...h1], { now: NOW });
    const calls = [];
    const signals = { listActive: async (f) => { calls.push(f); return [{ symbol: SYMBOL, timeframe: '1h', direction: f.direction }]; } };
    // Mekanika routing tanpa pembatasan timeframe per arah (DIRECTION_TIMEFRAMES diuji POS-SIG-TF-*).
    const server = await app({ signals, candles: ctx.repos.candles, directionTimeframes: null });
    const res = await server.inject({ url: '/api/signals/active?timeframe=1h' });
    expect(calls[0]).toMatchObject({ direction: 'LONG', timeframe: '1h' });
    expect(res.json().items[0]).toMatchObject({ lastPrice: h1.at(-1).close, lastCandleAt: h1.at(-1).closeTime });
    await server.inject({ url: '/api/signals/active?direction=SHORT' });
    expect(calls[1]).toMatchObject({ direction: 'SHORT', timeframe: null });
    // Grafik: hanya candle tertutup, openTime UTC naik (label candle Binance = openTime).
    const chart = (await server.inject({ url: `/api/market/candles?symbol=${SYMBOL}&timeframe=15m` })).json();
    expect(chart.items.map((c) => c.openTime)).toEqual(m15.map((c) => c.openTime));
    await server.close();
  });

  it('AUD-LT-031 Basi: > 2 candle + 2 menit sejak closeTime candle terakhir yang dievaluasi', () => {
    const at = Date.UTC(2026, 9, 26, 10, 0) - 1;
    expect(signalFreshness({ updatedAt: at, timeframe: '1h' }, at + 2 * H1 + 120_000).stale).toBe(false);
    expect(signalFreshness({ updatedAt: at, timeframe: '1h' }, at + 2 * H1 + 120_001).stale).toBe(true);
    expect(signalFreshness({ updatedAt: at, timeframe: '15m' }, at + 2 * M15 + 120_001).stale).toBe(true);
    // Normal: candle berikutnya baru saja dievaluasi (umur < 1 candle + jeda) → tidak basi.
    expect(signalFreshness({ updatedAt: at, timeframe: '15m' }, at + M15 + 5_000).stale).toBe(false);
  });
});
