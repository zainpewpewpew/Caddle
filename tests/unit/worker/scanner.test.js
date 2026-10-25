import { describe, expect, it, vi } from 'vitest';
import { createBinanceRestClient } from '../../../backend/ingestion/binance/restClient.js';
import { createKlineStream } from '../../../backend/ingestion/binance/wsClient.js';
import { TIMEFRAME_MS } from '../../../backend/market/contracts.js';
import { createServerClock } from '../../../backend/ingestion/serverClock.js';
import { discoverSymbols } from '../../../backend/ingestion/symbolDiscovery.js';
import { DEFAULT_SCANNER_SETTINGS } from '../../../backend/settings/scannerSettings.js';
import { createScanner } from '../../../worker/scanner.js';

const M5 = TIMEFRAME_MS['5m'];
const H1 = TIMEFRAME_MS['1h'];
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
// Waktu awal: 7 detik setelah candle T0+12·5m dibuka → candle tertutup terakhir = T0+11·5m.
const START = T0 + 12 * M5 + 7_000;
const LAST_CLOSED = T0 + 11 * M5;

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** Penjadwal timer palsu + jam deterministik; callback async diselesaikan lewat flush(). */
function createFakeTimers(start = START) {
  let now = start;
  let seq = 0;
  const pending = new Map();
  const clock = () => now;
  const setTimer = (fn, ms) => {
    seq += 1;
    pending.set(seq, { at: now + Math.max(0, ms), ms, fn });
    return seq;
  };
  const clearTimer = (id) => { pending.delete(id); };
  const advance = async (ms) => {
    const target = now + ms;
    for (let guard = 0; ; guard += 1) {
      if (guard > 100_000) throw new Error('loop timer tak berujung');
      let nextId = null;
      for (const [id, t] of pending) {
        if (t.at <= target && (nextId === null || t.at < pending.get(nextId).at)) nextId = id;
      }
      if (nextId === null) break;
      const t = pending.get(nextId);
      pending.delete(nextId);
      now = Math.max(now, t.at); // jam tidak pernah mundur (setNow dapat melompat maju)
      t.fn();
      await flush();
    }
    now = target;
    await flush();
  };
  const setNow = (t) => { now = t; };
  return { clock, setTimer, clearTimer, advance, setNow, pending };
}

// Fixture sintetis — bukan data pasar nyata. Bentuk mengikuti kontrak SymbolInfo/Candle
// (docs/07-kontrak-modul.md §1–2) yang diturunkan dari dokumentasi Binance USDT-M Futures.
const symbolInfo = (symbol, status = 'TRADING') => ({
  symbol,
  baseAsset: symbol.replace(/USDT$/, ''),
  quoteAsset: 'USDT',
  contractType: 'PERPETUAL',
  status,
  tickSize: '0.10',
  stepSize: '0.001',
  onboardDate: Date.UTC(2020, 0, 1),
});

function candle(symbol, timeframe, openTime, { source = 'rest', isClosed = true, close } = {}) {
  const base = 100 + ((openTime / TIMEFRAME_MS[timeframe]) % 7);
  return {
    symbol, timeframe, openTime, closeTime: openTime + TIMEFRAME_MS[timeframe] - 1,
    open: base, high: base + 1, low: base - 1, close: close ?? base + 0.5,
    volume: 10, quoteVolume: 1000, trades: 5, takerBuyVolume: 5, takerBuyQuoteVolume: 500,
    isClosed, source,
  };
}

/** REST palsu sesuai kontrak §2. `log` dipakai bersama untuk memeriksa urutan panggilan. */
function createFakeRest({ clock, symbols, log }) {
  const rest = {
    exchange: symbols.map((s) => symbolInfo(s)),
    failDiscovery: false,
    failKlines: new Set(),
    klinesGate: null,
    calls: [],
    async getExchangeInfo() {
      rest.calls.push('exchangeInfo');
      if (rest.failDiscovery) throw Object.assign(new Error('HTTP 503'), { status: 503, retryable: true });
      return rest.exchange;
    },
    async get24hTickers() {
      rest.calls.push('ticker24h');
      return rest.exchange.map((s) => ({ symbol: s.symbol, lastPrice: 100, priceChangePercent: 1, volume: 1e6, quoteVolume: 1e9, closeTime: clock() }));
    },
    async getBookTickers() {
      rest.calls.push('bookTicker');
      return rest.exchange.map((s) => ({ symbol: s.symbol, bidPrice: 100, askPrice: 100.01, spreadBps: 1 }));
    },
    async getKlines(req) {
      rest.calls.push({ klines: req });
      log.push(['klines', `${req.symbol}:${req.timeframe}:${req.startTime}`]);
      if (rest.klinesGate) await rest.klinesGate(req);
      if (rest.failKlines.has(req.symbol)) throw Object.assign(new Error('HTTP 500 dari Binance'), { status: 500, retryable: true });
      const ms = TIMEFRAME_MS[req.timeframe];
      const out = [];
      for (let t = req.startTime; t <= req.endTime && out.length < (req.limit ?? 500); t += ms) {
        const c = candle(req.symbol, req.timeframe, t);
        c.isClosed = c.closeTime < clock();
        out.push(c);
      }
      return out;
    },
    klineCalls: () => rest.calls.filter((c) => c.klines).map((c) => c.klines),
  };
  return rest;
}

/** Repositori palsu sesuai kontrak §3 (penyimpanan di memori). */
function createFakeRepos({ log, monitoredInDb = [] }) {
  const store = new Map();
  const provisional = new Map();
  const k = (symbol, timeframe) => `${symbol}:${timeframe}`;
  const series = (symbol, timeframe) => {
    if (!store.has(k(symbol, timeframe))) store.set(k(symbol, timeframe), new Map());
    return store.get(k(symbol, timeframe));
  };
  const repos = {
    rejectIf: null,
    store,
    provisional,
    candles: {
      upsertClosed: vi.fn(async (list) => {
        log.push(['upsertClosed', list.map((c) => `${c.symbol}:${c.timeframe}:${c.openTime}`)]);
        let inserted = 0;
        let updated = 0;
        const rejected = [];
        for (const c of list) {
          if (!c.isClosed) throw new Error('candle provisional masuk tabel kanonik');
          if (repos.rejectIf?.(c)) {
            rejected.push({ candle: c, errors: ['high lebih kecil dari low'] });
            continue;
          }
          const s = series(c.symbol, c.timeframe);
          if (s.has(c.openTime)) updated += 1; else inserted += 1;
          s.set(c.openTime, c);
        }
        return { inserted, updated, rejected };
      }),
      getLastOpenTime: vi.fn(async ({ symbol, timeframe }) => {
        const s = series(symbol, timeframe);
        return s.size ? Math.max(...s.keys()) : null;
      }),
      findGaps: vi.fn(async ({ symbol, timeframe, from, to }) => {
        const s = series(symbol, timeframe);
        const ms = TIMEFRAME_MS[timeframe];
        const gaps = [];
        for (let t = from; t <= to; t += ms) {
          if (s.has(t)) continue;
          const last = gaps.at(-1);
          if (last && last.to === t - ms) last.to = t; else gaps.push({ from: t, to: t });
        }
        return gaps;
      }),
      upsertProvisional: vi.fn(async (c) => {
        log.push(['upsertProvisional', `${c.symbol}:${c.timeframe}:${c.openTime}`]);
        provisional.set(k(c.symbol, c.timeframe), c);
      }),
      getProvisional: vi.fn(async ({ symbol, timeframe }) => provisional.get(k(symbol, timeframe)) ?? null),
      getRange: vi.fn(async () => []),
      getLatest: vi.fn(async () => []),
    },
    symbols: {
      upsertFromExchange: vi.fn(async () => {}),
      setMonitored: vi.fn(async () => {}),
      listMonitored: vi.fn(async () => [...monitoredInDb]),
      markDelisted: vi.fn(async () => {}),
      getId: vi.fn(async () => 1),
    },
    ingestion: {
      recordRun: vi.fn(async () => {}),
      recordError: vi.fn(async () => {}),
      heartbeat: vi.fn(async () => {}),
      getStatus: vi.fn(async () => null),
    },
    seed(symbol, timeframe, openTimes) {
      const s = series(symbol, timeframe);
      for (const t of openTimes) s.set(t, candle(symbol, timeframe, t));
    },
  };
  return repos;
}

/** Pengganti discoverSymbols (kontrak §2): pilih PERPETUAL+USDT+TRADING. */
const fakeDiscover = vi.fn(({ symbols, settings }) => ({
  selected: symbols
    .filter((s) => s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT')
    .slice(0, settings.symbols.maxAuto)
    .map((s) => ({ symbol: s.symbol, quoteVolume24h: 1e9, spreadBps: 1 })),
  rejected: [],
}));

/** Stream factory palsu: mencatat stream yang dibuat dan memungkinkan push event. */
function createFakeStreams() {
  const created = [];
  const factory = (opts) => {
    const s = {
      opts,
      started: false,
      stopped: false,
      reconnects: 0,
      wsState: 'open',
      start() {
        this.started = true;
        opts.onState({ event: 'state', state: 'open', reconnects: 0 });
      },
      stop() { this.stopped = true; },
      state() { return { state: this.stopped ? 'stopped' : this.wsState, reconnects: this.reconnects }; },
      push(c) { opts.onCandle(c); },
      keys: () => opts.streams.map((x) => `${x.symbol}:${x.timeframe}`),
    };
    created.push(s);
    return s;
  };
  return { factory, created, current: () => created.at(-1) };
}

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function setup({
  symbols = ['BTCUSDT', 'ETHUSDT'],
  timeframes = ['5m'],
  bootstrapCandles = 5,
  restBackfillIntervalSec = 300,
  monitoredInDb = [],
  options = {},
  streamFactory,
  onClosedCandles,
  liquidity = DEFAULT_SCANNER_SETTINGS.liquidity,
  serverClock,
  onMonitoringStopped,
  logger = silentLogger,
  localClock,
  listOpenSeries,
  wrapGetSettings,
  discover = fakeDiscover,
  start = START,
  closureClock,
} = {}) {
  const log = [];
  const timers = createFakeTimers(start);
  const rest = createFakeRest({ clock: timers.clock, symbols, log });
  const repos = createFakeRepos({ log, monitoredInDb });
  const streams = createFakeStreams();
  const analysed = [];
  const settings = {
    ...DEFAULT_SCANNER_SETTINGS,
    timeframes,
    liquidity,
    refresh: { bootstrapCandles, restBackfillIntervalSec },
  };
  const scanner = createScanner({
    rest,
    streamFactory: streamFactory ?? streams.factory,
    repos,
    getSettings: wrapGetSettings ? wrapGetSettings(async () => settings) : async () => settings,
    onClosedCandles: onClosedCandles ?? (async (e) => {
      analysed.push(e);
      log.push(['analysis', e.candles.map((c) => c.openTime)]);
    }),
    clock: timers.clock,
    logger,
    discoverSymbols: discover,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    options,
    serverClock,
    onMonitoringStopped,
    ...(localClock ? { localClock: localClock(timers) } : {}),
    ...(listOpenSeries ? { listOpenSeries } : {}),
    ...(closureClock ? { closureClock } : {}),
  });
  return { scanner, rest, repos, streams, timers, analysed, log, settings };
}

const ot = (list) => list.map((c) => c.openTime);
// Request klines untuk satu timeframe (timeframe terpilih 5m juga menarik 15m/1h sebagai konteks HTF).
const klinesOf = (rest, timeframe = '5m') => rest.klineCalls().filter((r) => r.timeframe === timeframe);
const recordedErrors = (repos) => repos.ingestion.recordError.mock.calls.map(([e]) => e);

describe('bootstrap', () => {
  it('POS-SCN-001 start: discovery → simpan simbol → bootstrap REST → upsert → stream dibuka', async () => {
    const { scanner, rest, repos, streams, analysed, timers } = setup({ timeframes: ['5m', '1h'] });
    await scanner.start();

    expect(rest.calls.slice(0, 3).sort()).toEqual(['bookTicker', 'exchangeInfo', 'ticker24h']);
    expect(fakeDiscover).toHaveBeenLastCalledWith(expect.objectContaining({ symbols: rest.exchange, settings: expect.any(Object) }));
    expect(repos.symbols.upsertFromExchange).toHaveBeenCalledWith(rest.exchange, START);
    expect(repos.symbols.setMonitored).toHaveBeenCalledWith(['BTCUSDT', 'ETHUSDT'], START);

    // 15m tidak dipilih, tetapi HTF konteks 5m → ikut diingesti (seri konteks saja).
    const klines = rest.klineCalls();
    expect(klines).toHaveLength(6);
    expect(klines).toContainEqual({ symbol: 'BTCUSDT', timeframe: '5m', startTime: LAST_CLOSED - 4 * M5, endTime: LAST_CLOSED + M5 - 1, limit: 5 });
    const lastClosedH1 = Math.floor(START / H1) * H1 - H1;
    expect(klines).toContainEqual({ symbol: 'ETHUSDT', timeframe: '1h', startTime: lastClosedH1 - 4 * H1, endTime: lastClosedH1 + H1 - 1, limit: 5 });
    const M15 = TIMEFRAME_MS['15m'];
    const lastClosedM15 = Math.floor(START / M15) * M15 - M15;
    expect(klines).toContainEqual({ symbol: 'BTCUSDT', timeframe: '15m', startTime: lastClosedM15 - 4 * M15, endTime: lastClosedM15 + M15 - 1, limit: 5 });

    // hanya candle tertutup, urut naik, satu batch per stream
    for (const [list] of repos.candles.upsertClosed.mock.calls) {
      expect(list.every((c) => c.isClosed)).toBe(true);
      expect(ot(list)).toEqual([...ot(list)].sort((a, b) => a - b));
    }
    expect([...repos.store.get('BTCUSDT:5m').keys()].sort()).toEqual([0, 1, 2, 3, 4].map((i) => LAST_CLOSED - (4 - i) * M5));

    expect(streams.created).toHaveLength(1);
    expect(streams.current().started).toBe(true);
    expect(streams.current().keys().sort()).toEqual(['BTCUSDT:15m', 'BTCUSDT:1h', 'BTCUSDT:5m', 'ETHUSDT:15m', 'ETHUSDT:1h', 'ETHUSDT:5m']);
    // bootstrap awal = histori murni → tidak memicu analisis
    expect(analysed).toHaveLength(0);

    expect(repos.ingestion.recordRun).toHaveBeenCalledTimes(1);
    expect(repos.ingestion.recordRun.mock.calls[0][0]).toEqual({ startedAt: START, finishedAt: START, symbols: 2, candles: 30, errors: 0 });
    expect(scanner.status()).toMatchObject({
      state: 'running', symbols: 2, streams: 6, errors: 0, queue: 0, scanDurationMs: 0,
      candleLagMs: START - (LAST_CLOSED + M5 - 1), lastIngestionAt: START, reconnects: 0,
    });
    await scanner.stop();
    expect(timers.pending.size).toBe(0);
  });

  it('UNIT-SCN-001 data tersimpan dipakai: hanya candle setelah lastOpenTime yang diambil', async () => {
    const { scanner, rest, repos } = setup({ symbols: ['BTCUSDT'], bootstrapCandles: 5 });
    repos.seed('BTCUSDT', '5m', [0, 1, 2, 3].map((i) => LAST_CLOSED - (6 - i) * M5));
    await scanner.start();
    expect(klinesOf(rest)).toEqual([
      { symbol: 'BTCUSDT', timeframe: '5m', startTime: LAST_CLOSED - 2 * M5, endTime: LAST_CLOSED + M5 - 1, limit: 3 },
    ]);
    await scanner.stop();
  });

  it('UNIT-SCN-002 gap historis dalam jendela bootstrap ditutup lewat findGaps', async () => {
    const { scanner, rest, repos } = setup({ symbols: ['BTCUSDT'], bootstrapCandles: 6 });
    // tersimpan: LAST_CLOSED-5..LAST_CLOSED kecuali -3 dan -2 (lubang)
    repos.seed('BTCUSDT', '5m', [5, 4, 1, 0].map((i) => LAST_CLOSED - i * M5));
    await scanner.start();
    expect(repos.candles.findGaps).toHaveBeenCalledWith({ symbol: 'BTCUSDT', timeframe: '5m', from: LAST_CLOSED - 5 * M5, to: LAST_CLOSED });
    expect(klinesOf(rest)).toEqual([
      { symbol: 'BTCUSDT', timeframe: '5m', startTime: LAST_CLOSED - 3 * M5, endTime: LAST_CLOSED - M5 - 1, limit: 2 },
    ]);
    expect(repos.store.get('BTCUSDT:5m').size).toBe(6);
    await scanner.stop();
  });

  it('UNIT-SCN-003 paralelisme REST bootstrap dibatasi (default 3)', async () => {
    const symbols = ['AAAUSDT', 'BBBUSDT', 'CCCUSDT', 'DDDUSDT', 'EEEUSDT'];
    const { scanner, rest, repos } = setup({ symbols, timeframes: ['5m', '15m'] });
    let active = 0;
    let peak = 0;
    const waiters = [];
    rest.klinesGate = () => new Promise((resolve) => {
      active += 1;
      peak = Math.max(peak, active);
      waiters.push(() => { active -= 1; resolve(); });
    });
    const started = scanner.start();
    await flush();
    expect(active).toBe(3);
    expect(scanner.status().queue).toBe(15); // 5 simbol × (5m, 15m, + 1h konteks HTF)
    while (waiters.length) {
      waiters.shift()();
      await flush();
    }
    await started;
    expect(peak).toBe(3);
    expect(repos.candles.upsertClosed).toHaveBeenCalledTimes(15);
    expect(scanner.status().queue).toBe(0);
    await scanner.stop();
  });

  it('NEG-SCN-001 error REST saat bootstrap dicatat; scanner tetap berjalan dan mencoba ulang', async () => {
    const { scanner, rest, repos, timers, streams } = setup({ symbols: ['BTCUSDT', 'ETHUSDT'] });
    rest.failKlines.add('ETHUSDT');
    await scanner.start();
    const errs = recordedErrors(repos);
    // ETHUSDT 5m + konteks 15m/1h gagal: satu baris per seri (pesan memuat simbol & timeframe).
    expect(errs.map((e) => e.message.slice(0, 12))).toEqual(['ETHUSDT 5m: ', 'ETHUSDT 15m:', 'ETHUSDT 1h: ']);
    expect(errs[0]).toMatchObject({ at: START, source: 'bootstrap' });
    expect(errs[0].message).toMatch(/ETHUSDT 5m: HTTP 500/);
    expect(repos.store.get('BTCUSDT:5m').size).toBe(5);
    expect(scanner.status()).toMatchObject({ state: 'running', errors: 3, streams: 6 });
    expect(streams.current().keys()).toContain('ETHUSDT:5m');
    expect(repos.ingestion.recordRun.mock.calls[0][0]).toMatchObject({ errors: 3, candles: 15 });

    // heartbeat tetap jalan
    const beats = repos.ingestion.heartbeat.mock.calls.length;
    await timers.advance(30_000);
    expect(repos.ingestion.heartbeat.mock.calls.length).toBe(beats + 1);

    // REST pulih → sweep berkala mem-bootstrap ulang stream yang gagal
    rest.failKlines.clear();
    await timers.advance(300_000);
    expect(repos.store.get('ETHUSDT:5m')?.size).toBeGreaterThanOrEqual(5);
    await scanner.stop();
  });

  it('NEG-SCN-008 error yang sama di beberapa simbol (bootstrap HTTP 500) → satu baris ingestion_errors per simbol, bukan hanya yang pertama; simbol yang sama dalam 60 d tetap di-throttle', async () => {
    const { scanner, rest, repos, timers } = setup({ symbols: ['BBBUSDT', 'CCCUSDT', 'DDDUSDT'], timeframes: ['1h'], restBackfillIntervalSec: 30 });
    for (const sym of ['BBBUSDT', 'CCCUSDT', 'DDDUSDT']) rest.failKlines.add(sym);
    await scanner.start();
    expect(recordedErrors(repos)).toEqual(['BBBUSDT', 'CCCUSDT', 'DDDUSDT'].map((sym) => ({
      at: START, source: 'bootstrap', message: `${sym} 1h: HTTP 500 dari Binance`,
    })));
    expect(scanner.status().errors).toBe(3);
    await timers.advance(30_000); // sweep: gagal lagi (sumber 'backfill') → satu baris per simbol
    expect(scanner.status().errors).toBe(6);
    expect(recordedErrors(repos).slice(3).map((e) => [e.source, e.message.slice(0, 7)])).toEqual([
      ['backfill', 'BBBUSDT'], ['backfill', 'CCCUSDT'], ['backfill', 'DDDUSDT'],
    ]);
    await timers.advance(30_000); // sweep berikutnya: pesan per simbol yang sama dalam 60 d → di-throttle
    expect(scanner.status().errors).toBe(9);
    expect(recordedErrors(repos)).toHaveLength(6);
    await scanner.stop();
  });

  it('NEG-SCN-002 discovery gagal saat start → pakai simbol terpantau di DB, coba ulang dengan jeda', async () => {
    const { scanner, rest, repos, streams, timers } = setup({ symbols: ['BTCUSDT', 'ETHUSDT'], monitoredInDb: ['BTCUSDT'] });
    rest.failDiscovery = true;
    await scanner.start();
    expect(recordedErrors(repos)[0]).toMatchObject({ source: 'discovery' });
    expect(repos.symbols.setMonitored).not.toHaveBeenCalled();
    expect(streams.current().keys()).toEqual(['BTCUSDT:5m', 'BTCUSDT:15m', 'BTCUSDT:1h']);
    expect(scanner.status()).toMatchObject({ state: 'running', symbols: 1 });

    rest.failDiscovery = false;
    await timers.advance(60_000);
    expect(repos.symbols.setMonitored).toHaveBeenLastCalledWith(['BTCUSDT', 'ETHUSDT'], START + 60_000);
    expect(streams.current().keys().sort()).toEqual(['BTCUSDT:15m', 'BTCUSDT:1h', 'BTCUSDT:5m', 'ETHUSDT:15m', 'ETHUSDT:1h', 'ETHUSDT:5m']);
    await scanner.stop();
  });

  it('NEG-SCN-007 pemuatan pengaturan pertama gagal (SQLITE_BUSY) → error "settings" dicatat, start tidak crash (heartbeat pasca-start tetap ditulis); siklus berikutnya berhasil → sweep berkala terjadwal dan menambal stream yang diam', async () => {
    let failures = 1;
    const { scanner, repos, streams, timers, analysed } = setup({
      symbols: ['BTCUSDT'],
      wrapGetSettings: (get) => async () => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('SQLITE_BUSY: database is locked');
        }
        return get();
      },
    });
    await scanner.start();
    expect(recordedErrors(repos)).toEqual([{ at: START, source: 'settings', message: 'SQLITE_BUSY: database is locked' }]);
    expect(repos.ingestion.heartbeat).toHaveBeenCalledTimes(2); // sebelum & sesudah siklus start
    expect(scanner.status()).toMatchObject({ state: 'degraded', streams: 0, errors: 1 });

    await timers.advance(60_000); // percobaan ulang siklus → pengaturan termuat, stream dibuka
    expect(streams.current().keys()).toEqual(['BTCUSDT:5m', 'BTCUSDT:15m', 'BTCUSDT:1h']);
    expect(analysed).toEqual([]);
    await timers.advance(25 * 60_000); // tanpa event WS: hanya sweep berkala yang dapat mengisi candle
    expect(analysed.filter((a) => a.timeframe === '5m').at(-1)).toMatchObject({ reason: 'sweep' });
    expect(scanner.status()).toMatchObject({ state: 'running', staleStreams: 0, errors: 1 });
    expect(recordedErrors(repos)).toHaveLength(1);
    await scanner.stop();
    expect(timers.pending.size).toBe(0);
  });

  it('EDGE-SCN-001 discovery gagal dan DB kosong → degraded tanpa stream, tidak crash', async () => {
    const { scanner, rest, streams } = setup();
    rest.failDiscovery = true;
    await scanner.start();
    expect(streams.created).toHaveLength(0);
    expect(scanner.status()).toMatchObject({ state: 'degraded', symbols: 0, streams: 0 });
    await scanner.stop();
  });
});

describe('event WebSocket', () => {
  async function running(opts) {
    const ctx = setup({ symbols: ['BTCUSDT'], ...opts });
    await ctx.scanner.start();
    ctx.repos.candles.upsertClosed.mockClear();
    ctx.log.length = 0;
    return ctx;
  }

  it('POS-SCN-002 candle tertutup berurutan → upsertClosed lalu onClosedCandles', async () => {
    const { scanner, streams, repos, analysed, timers, log } = await running();
    timers.setNow(LAST_CLOSED + 2 * M5 + 500);
    streams.current().push(candle('BTCUSDT', '5m', LAST_CLOSED + M5, { source: 'ws' }));
    await flush();
    expect(repos.candles.upsertClosed).toHaveBeenCalledTimes(1);
    expect(log.map((e) => e[0])).toEqual(['upsertClosed', 'analysis']);
    expect(analysed).toEqual([{ symbol: 'BTCUSDT', timeframe: '5m', candles: [expect.objectContaining({ openTime: LAST_CLOSED + M5, source: 'ws' })], reason: 'live' }]);
    expect(scanner.status().candleLagMs).toBe(501);
    await scanner.stop();
  });

  it('UNIT-SCN-004 candle provisional → upsertProvisional (di-throttle), tanpa analisis', async () => {
    const { scanner, streams, repos, analysed, timers } = await running();
    const open = LAST_CLOSED + M5;
    streams.current().push(candle('BTCUSDT', '5m', open, { source: 'ws', isClosed: false, close: 101 }));
    await timers.advance(200);
    streams.current().push(candle('BTCUSDT', '5m', open, { source: 'ws', isClosed: false, close: 102 })); // < 1 detik → dilewati
    await timers.advance(1_000);
    streams.current().push(candle('BTCUSDT', '5m', open, { source: 'ws', isClosed: false, close: 103 }));
    await flush();
    expect(repos.candles.upsertProvisional.mock.calls.map(([c]) => c.close)).toEqual([101, 103]);
    expect(repos.candles.upsertClosed).not.toHaveBeenCalled();
    // provisional untuk candle yang sudah tertutup diabaikan
    streams.current().push(candle('BTCUSDT', '5m', LAST_CLOSED, { source: 'ws', isClosed: false }));
    await flush();
    expect(repos.candles.upsertProvisional).toHaveBeenCalledTimes(2);
    expect(analysed).toHaveLength(0);
    await scanner.stop();
  });

  it('UNIT-SCN-005 duplikat WS tidak memicu analisis ganda', async () => {
    const { scanner, streams, repos, analysed } = await running();
    const c = candle('BTCUSDT', '5m', LAST_CLOSED + M5, { source: 'ws' });
    streams.current().push(c);
    streams.current().push({ ...c });
    await flush();
    expect(repos.candles.upsertClosed).toHaveBeenCalledTimes(2);
    expect(analysed).toHaveLength(1);
    expect(scanner.status()).toMatchObject({ duplicates: 1, gaps: 0 });
    await scanner.stop();
  });

  it('EDGE-SCN-002 event out-of-order (openTime lebih lama) tetap di-upsert tanpa analisis', async () => {
    const { scanner, streams, repos, analysed } = await running();
    streams.current().push(candle('BTCUSDT', '5m', LAST_CLOSED + M5, { source: 'ws' }));
    streams.current().push(candle('BTCUSDT', '5m', LAST_CLOSED - 2 * M5, { source: 'ws', close: 999 }));
    await flush();
    expect(repos.candles.upsertClosed).toHaveBeenCalledTimes(2);
    expect(repos.store.get('BTCUSDT:5m').get(LAST_CLOSED - 2 * M5).close).toBe(999);
    expect(analysed.map((a) => ot(a.candles))).toEqual([[LAST_CLOSED + M5]]);
    await scanner.stop();
  });

  it('UNIT-SCN-006 lompatan openTime (gap setelah reconnect) → backfill REST dulu, analisis berurutan', async () => {
    const { scanner, streams, rest, analysed, timers, log } = await running();
    timers.setNow(LAST_CLOSED + 4 * M5 + 900);
    streams.current().push(candle('BTCUSDT', '5m', LAST_CLOSED + 3 * M5, { source: 'ws' }));
    await flush();
    // Candle WS pemicu (+3) baru tutup 0,9 detik lalu (< margin penutupan) → REST hanya +1..+2; +3 dari salinan WS.
    expect(rest.klineCalls().at(-1)).toEqual({ symbol: 'BTCUSDT', timeframe: '5m', startTime: LAST_CLOSED + M5, endTime: LAST_CLOSED + 3 * M5 - 1, limit: 2 });
    const kinds = log.map((e) => e[0]);
    expect(kinds.indexOf('klines')).toBeLessThan(kinds.indexOf('analysis'));
    expect(analysed).toHaveLength(1);
    expect(analysed[0].reason).toBe('gap');
    expect(ot(analysed[0].candles)).toEqual([LAST_CLOSED + M5, LAST_CLOSED + 2 * M5, LAST_CLOSED + 3 * M5]);
    await scanner.stop();
  });

  it('NEG-SCN-003 backfill gap gagal → candle WS tetap disimpan, analisis ditunda lalu dipulihkan berurutan', async () => {
    const { scanner, streams, rest, repos, analysed, timers } = await running();
    rest.failKlines.add('BTCUSDT');
    timers.setNow(LAST_CLOSED + 3 * M5 + 100);
    streams.current().push(candle('BTCUSDT', '5m', LAST_CLOSED + 2 * M5, { source: 'ws' }));
    await flush();
    expect(recordedErrors(repos).at(-1)).toMatchObject({ source: 'backfill' });
    expect(repos.store.get('BTCUSDT:5m').has(LAST_CLOSED + 2 * M5)).toBe(true);
    expect(analysed).toHaveLength(0);

    rest.failKlines.clear();
    timers.setNow(LAST_CLOSED + 4 * M5 + 100);
    streams.current().push(candle('BTCUSDT', '5m', LAST_CLOSED + 3 * M5, { source: 'ws' }));
    await flush();
    expect(analysed.map((a) => ot(a.candles))).toEqual([[LAST_CLOSED + M5, LAST_CLOSED + 2 * M5, LAST_CLOSED + 3 * M5]]);
    await scanner.stop();
  });

  it('NEG-SCN-004 candle yang ditolak validasi tidak diteruskan ke analisis', async () => {
    const { scanner, streams, repos, analysed, timers } = await running();
    repos.rejectIf = (c) => c.openTime === LAST_CLOSED + M5;
    timers.setNow(LAST_CLOSED + 3 * M5 + 100);
    streams.current().push(candle('BTCUSDT', '5m', LAST_CLOSED + 2 * M5, { source: 'ws' }));
    await flush();
    expect(recordedErrors(repos).at(-1)).toMatchObject({ source: 'validation' });
    expect(ot(analysed[0].candles)).toEqual([LAST_CLOSED + 2 * M5]);
    await scanner.stop();
  });

  it('NEG-SCN-005 onClosedCandles yang melempar error dicatat; candle berikutnya tetap diproses', async () => {
    let calls = 0;
    const { scanner, streams, repos } = await running({ onClosedCandles: async () => { calls += 1; throw new Error('analisis gagal'); } });
    streams.current().push(candle('BTCUSDT', '5m', LAST_CLOSED + M5, { source: 'ws' }));
    streams.current().push(candle('BTCUSDT', '5m', LAST_CLOSED + 2 * M5, { source: 'ws' }));
    await flush();
    expect(calls).toBe(2);
    expect(recordedErrors(repos)[0]).toMatchObject({ source: 'analysis' });
    expect(scanner.status().errors).toBe(2);
    expect(repos.ingestion.recordError).toHaveBeenCalledTimes(1); // pesan sama di-throttle
    await scanner.stop();
  });

  it('UNIT-SCN-007 event error WS dicatat (throttle) dan state degraded saat stream tidak open', async () => {
    const { scanner, streams, repos } = await running();
    const s = streams.current();
    s.opts.onState({ event: 'error', error: { kind: 'parse', message: 'JSON tidak valid' } });
    s.opts.onState({ event: 'error', error: { kind: 'parse', message: 'JSON tidak valid' } });
    await flush();
    expect(recordedErrors(repos)).toEqual([expect.objectContaining({ source: 'ws', message: 'parse: JSON tidak valid' })]);
    expect(scanner.status().errors).toBe(2);
    s.wsState = 'reconnecting';
    s.reconnects = 3;
    expect(scanner.status()).toMatchObject({ state: 'degraded', reconnects: 3 });
    await scanner.stop();
  });

  it('UNIT-SCN-008 sweep berkala: stream tertinggal tanpa event WS di-backfill via REST', async () => {
    const { scanner, analysed, timers } = await running();
    expect(scanner.status().staleStreams).toBe(0);
    await timers.advance(25 * 60_000); // 25 menit tanpa event WS
    expect(analysed.at(-1).reason).toBe('sweep');
    const lastClosedNow = Math.floor(timers.clock() / M5) * M5 - M5;
    expect(ot(analysed.flatMap((a) => a.candles)).at(-1)).toBeLessThanOrEqual(lastClosedNow);
    expect(scanner.status().staleStreams).toBe(0);
    await scanner.stop();
  });

  it('UNIT-SCN-009 reconnect stream (reconnecting → open) memicu backfill tertinggal segera', async () => {
    const { scanner, streams, analysed, timers, rest } = await running();
    const s = streams.current();
    s.opts.onState({ event: 'state', state: 'reconnecting' });
    timers.setNow(LAST_CLOSED + 3 * M5 + 10_000); // dua candle tertutup terlewat
    s.opts.onState({ event: 'state', state: 'open' });
    await flush();
    expect(rest.klineCalls().at(-1)).toMatchObject({ startTime: LAST_CLOSED + M5, limit: 2 });
    expect(analysed).toEqual([expect.objectContaining({ reason: 'reconnect' })]);
    expect(ot(analysed[0].candles)).toEqual([LAST_CLOSED + M5, LAST_CLOSED + 2 * M5]);
    // event WS yang datang terlambat untuk candle yang sama tidak dianalisis ulang
    s.push(candle('BTCUSDT', '5m', LAST_CLOSED + 2 * M5, { source: 'ws' }));
    await flush();
    expect(analysed).toHaveLength(1);
    await scanner.stop();
  });

  it('UNIT-SCN-024 socket putus 1 d sebelum close dan terbuka lagi 1,5 d sesudahnya (kline final terlewat) → candle itu diambil REST begitu margin penutupan berlalu (≈ 2 d setelah open), tidak menunggu candle berikutnya/sweep berkala; tanpa duplikat', async () => {
    const { scanner, streams, analysed, timers, rest } = await running();
    const s = streams.current();
    const closeAt = LAST_CLOSED + 2 * M5; // candle LAST_CLOSED+1 tutup di sini
    timers.setNow(closeAt - 1_000);
    s.opts.onState({ event: 'state', state: 'reconnecting' });
    timers.setNow(closeAt + 1_500);
    s.opts.onState({ event: 'state', state: 'open' });
    await flush();
    expect(analysed).toEqual([]); // baru 1,5 d sejak close (< margin 2 d): belum boleh diambil REST
    await timers.advance(2_000);
    expect(analysed.map((a) => [a.reason, ot(a.candles)])).toEqual([['reconnect', [LAST_CLOSED + M5]]]);
    expect(klinesOf(rest).at(-1)).toMatchObject({ startTime: LAST_CLOSED + M5, limit: 1 });
    await timers.advance(60_000);
    expect(analysed).toHaveLength(1);
    await scanner.stop();
    expect(timers.pending.size).toBe(0);
  });

  it('UNIT-SCN-025 outage 2 candle, socket terbuka lagi 1 d setelah close #13, latensi REST 3 d (> margin 2 d) → sweep ulang setelah margin tetap mengantre stream yang sinkronisasi pertamanya masih berjalan: #13 dianalisis "reconnect" ≈ 7 d setelah open, bukan di sweep berkala 5 menit kemudian; tanpa duplikat', async () => {
    const { scanner, streams, analysed, timers, rest } = await running();
    const s = streams.current();
    s.opts.onState({ event: 'state', state: 'reconnecting' });
    const boundary = T0 + 14 * M5; // candle #13 (openTime T0+13·5m) tutup di boundary − 1
    timers.setNow(boundary + 1_000);
    rest.klinesGate = () => new Promise((resolve) => timers.setTimer(resolve, 3_000));
    s.opts.onState({ event: 'state', state: 'open' });
    await flush();
    await timers.advance(10_000);
    const fiveMin = () => analysed.filter((a) => a.timeframe === '5m').map((a) => [a.reason, a.candles.map((c) => (c.openTime - T0) / M5)]);
    // Sinkronisasi pertama (direncanakan saat open: #13 belum lewat margin) membawa #12; antrean kedua membawa #13.
    expect(fiveMin()).toEqual([['reconnect', [12]], ['reconnect', [13]]]);
    rest.klinesGate = null;
    await timers.advance(300_000);
    expect(fiveMin().filter(([, list]) => list.includes(13))).toHaveLength(1);
    await scanner.stop();
  });

  it('UNIT-SCN-026 start 1 d setelah batas 5m (bootstrap tidak boleh mengambil candle yang baru tutup), socket terbuka sebelum kline final berikutnya → satu sweep catch-up ≈ 2 d setelah open mengambil candle itu via REST sebagai histori (tanpa analisis, seperti bootstrap); stream mutakhir tidak menyentuh REST', async () => {
    const boundary = T0 + 13 * M5; // candle #12 tutup di boundary − 1
    const { scanner, repos, rest, analysed, timers } = setup({ symbols: ['BTCUSDT'], start: boundary + 1_000 });
    await scanner.start();
    expect(repos.store.get('BTCUSDT:5m').has(T0 + 12 * M5)).toBe(false); // < margin: dikecualikan bootstrap
    const before = rest.klineCalls().length;
    await timers.advance(2_500);
    expect(repos.store.get('BTCUSDT:5m').has(T0 + 12 * M5)).toBe(true);
    // Hanya 5m yang tertinggal: 15m dan 1h (tutup di T0+60m−1) sudah mutakhir → hanya satu request.
    expect(rest.klineCalls().slice(before)).toEqual([expect.objectContaining({ timeframe: '5m', startTime: T0 + 12 * M5, limit: 1 })]);
    expect(analysed).toEqual([]);
    await scanner.stop();
    expect(timers.pending.size).toBe(0);
  });
});

describe('margin penutupan candle REST (jam worker sedikit di depan Binance)', () => {
  /**
   * Klien REST ASLI di atas fetch palsu yang memodelkan Binance (SINTETIS, tanpa jaringan): jam server =
   * jam worker − aheadMs; candle yang masih berjalan menurut server dikirim parsial (volume 3, bukan 10).
   */
  function binanceKlines(clock, aheadMs, closureClock = clock) {
    const calls = [];
    const fetch = async (href) => {
      const url = new URL(href);
      const q = Object.fromEntries(url.searchParams);
      calls.push(q);
      const ms = TIMEFRAME_MS[q.interval];
      const serverNow = clock() - aheadMs;
      const rows = [];
      for (let t = Number(q.startTime); t <= Number(q.endTime) && t <= serverNow; t += ms) {
        const closed = t + ms - 1 < serverNow;
        rows.push([t, '100', '101', '99', '100.5', closed ? '10' : '3', t + ms - 1, '1000', 5, '1', '100', '0']);
      }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => rows };
    };
    return { calls, client: createBinanceRestClient({ fetch, clock, closureClock, sleep: async () => {}, random: () => 0.5 }) };
  }

  it('UNIT-SCN-020 jam worker 300 ms di depan Binance, reconnect 100 ms setelah batas 5m dengan stream tertinggal → REST tidak meminta candle yang baru tutup, snapshot parsialnya tidak pernah tersimpan/dianalisis sebagai tertutup; candle itu masuk lewat kline final WS', async () => {
    const ctx = setup({ symbols: ['BTCUSDT'] });
    const { scanner, streams, repos, analysed, timers, rest } = ctx;
    await scanner.start();
    const binance = binanceKlines(timers.clock, 300);
    rest.getKlines = (q) => binance.client.getKlines(q);
    const s = streams.current();
    s.opts.onState({ event: 'state', state: 'reconnecting' });
    const boundary = LAST_CLOSED + 3 * M5; // candle +2 tutup di sini (menurut jam worker)
    timers.setNow(boundary + 100); // menurut Binance: boundary − 200 ms → candle +2 masih berjalan
    s.opts.onState({ event: 'state', state: 'open' });
    await flush();

    expect(binance.calls).toEqual([{
      symbol: 'BTCUSDT', interval: '5m', startTime: String(LAST_CLOSED + M5), endTime: String(LAST_CLOSED + 2 * M5 - 1), limit: '1',
    }]);
    const stored = repos.store.get('BTCUSDT:5m');
    expect(stored.has(LAST_CLOSED + 2 * M5)).toBe(false);
    expect(analysed).toEqual([expect.objectContaining({ reason: 'reconnect' })]);
    expect(analysed.flatMap((a) => a.candles).map((c) => [c.openTime, c.volume])).toEqual([[LAST_CLOSED + M5, 10]]);

    // Kline final WS candle +2 (bendera x bursa) → disimpan & dianalisis sebagai 'live', lengkap.
    timers.setNow(boundary + 400);
    s.push({ ...candle('BTCUSDT', '5m', LAST_CLOSED + 2 * M5, { source: 'ws' }), volume: 10 });
    await flush();
    expect(analysed.map((a) => [a.reason, ot(a.candles)])).toEqual([['reconnect', [LAST_CLOSED + M5]], ['live', [LAST_CLOSED + 2 * M5]]]);
    expect(stored.get(LAST_CLOSED + 2 * M5)).toMatchObject({ volume: 10, source: 'ws' });
    await scanner.stop();
  });

  it('UNIT-SCN-021 rencana REST (bootstrap, gap, sweep) berakhir di candle tertutup terakhir pada (clock − closeMarginMs); options.closeMarginMs 0 → tanpa margin; nilai tidak valid ditolak', async () => {
    const ctx = setup({ symbols: ['BTCUSDT'], options: { closeMarginMs: 0 } });
    ctx.timers.setNow(LAST_CLOSED + M5 + 500); // candle LAST_CLOSED tutup 0,5 d lalu
    await ctx.scanner.start();
    expect(klinesOf(ctx.rest).map((r) => r.endTime)).toEqual([LAST_CLOSED + M5 - 1]);
    await ctx.scanner.stop();

    const def = setup({ symbols: ['BTCUSDT'] });
    def.timers.setNow(LAST_CLOSED + M5 + 500);
    await def.scanner.start();
    expect(klinesOf(def.rest).map((r) => r.endTime)).toEqual([LAST_CLOSED - 1]);
    await def.scanner.stop();

    const base = { rest: def.rest, repos: def.repos, streamFactory: def.streams.factory, getSettings: async () => ({}), discoverSymbols: fakeDiscover };
    for (const closeMarginMs of [-1, 0.5, 60_001, '2000']) {
      expect(() => createScanner({ ...base, options: { closeMarginMs } })).toThrow(RangeError);
    }
  });

  it('UNIT-SCN-027 jam host 11 menit DI DEPAN Binance (serverClock asli → OFFSET_OUT_OF_RANGE, offset tidak diterapkan): state degraded, dan bootstrap + sweep berkala memakai closureClock = serverClock.closureNow → candle yang masih berjalan menurut server (volume 3) tidak pernah tersimpan atau dianalisis sebagai tertutup', async () => {
    const AHEAD = 11 * 60_000;
    let hostClock = null;
    const serverClock = createServerClock({ clock: () => hostClock(), getServerTime: async () => hostClock() - AHEAD });
    const ctx = setup({ symbols: ['BTCUSDT'], serverClock, closureClock: serverClock.closureNow });
    hostClock = ctx.timers.clock;
    const binance = binanceKlines(ctx.timers.clock, AHEAD, serverClock.closureNow);
    ctx.rest.getKlines = (q) => binance.client.getKlines(q);
    const stored = () => [...ctx.repos.store.get('BTCUSDT:5m').values()].sort((a, b) => a.openTime - b.openTime);
    const index = (c) => (c.openTime - T0) / TIMEFRAME_MS[c.timeframe];

    await ctx.scanner.start();
    expect(ctx.scanner.status()).toMatchObject({ state: 'degraded', clockFault: 'OFFSET_OUT_OF_RANGE', clockOffsetMs: 0 });
    // Waktu server = START − 11 menit = T0 + 9·5m + 247 d → candle tertutup terakhir #8; #9 masih berjalan.
    expect(stored().map(index)).toEqual([4, 5, 6, 7, 8]);
    expect(stored().every((c) => c.volume === 10)).toBe(true);

    await ctx.timers.advance(300_000); // sweep berkala: server di T0 + 10·5m + 247 d → hanya #9 yang kini final
    expect(stored().map(index)).toEqual([4, 5, 6, 7, 8, 9]);
    expect(stored().every((c) => c.volume === 10)).toBe(true);
    const analysed5m = ctx.analysed.filter((a) => a.timeframe === '5m');
    expect(analysed5m.map((a) => [a.reason, a.candles.map(index)])).toEqual([['sweep', [9]]]);
    expect(ctx.analysed.flatMap((a) => a.candles).every((c) => c.volume === 10)).toBe(true);
    await ctx.scanner.stop();
  });
});

describe('rediscovery & delisting', () => {
  it('POS-SCN-003 rediscovery tiap jam: simbol baru di-bootstrap, simbol delisted dihentikan', async () => {
    const { scanner, rest, repos, streams, timers } = setup({ symbols: ['BTCUSDT', 'ETHUSDT'] });
    await scanner.start();
    const first = streams.current();
    rest.exchange = [symbolInfo('BTCUSDT'), symbolInfo('ETHUSDT', 'SETTLING'), symbolInfo('SOLUSDT')];
    await timers.advance(3_600_000 - 1);
    const before = rest.klineCalls().length;
    await timers.advance(1);
    const at = START + 3_600_000;
    expect(repos.symbols.markDelisted).toHaveBeenCalledWith(['ETHUSDT'], at);
    expect(repos.symbols.setMonitored).toHaveBeenLastCalledWith(['BTCUSDT', 'SOLUSDT'], at);
    const second = streams.current();
    expect(second).not.toBe(first);
    expect(first.stopped).toBe(true);
    expect(second.keys().sort()).toEqual(['BTCUSDT:15m', 'BTCUSDT:1h', 'BTCUSDT:5m', 'SOLUSDT:15m', 'SOLUSDT:1h', 'SOLUSDT:5m']);
    const after = rest.klineCalls().slice(before);
    expect(after.filter((r) => r.symbol === 'SOLUSDT').map((r) => r.timeframe)).toEqual(['5m', '15m', '1h']);
    expect(after.some((r) => r.symbol === 'ETHUSDT')).toBe(false);
    expect(repos.ingestion.recordRun).toHaveBeenCalledTimes(2);
    expect(scanner.status()).toMatchObject({ symbols: 2, streams: 6 });

    // event terlambat untuk simbol delisted diabaikan
    repos.candles.upsertClosed.mockClear();
    first.opts.onCandle(candle('ETHUSDT', '5m', LAST_CLOSED + M5, { source: 'ws' }));
    await flush();
    expect(repos.candles.upsertClosed).not.toHaveBeenCalled();
    await scanner.stop();
  });

  it('EDGE-SCN-003 simbol hilang dari exchangeInfo juga dianggap delisted; simbol keluar karena likuiditas tidak', async () => {
    const { scanner, rest, repos, streams, timers } = setup({ symbols: ['BTCUSDT', 'ETHUSDT', 'XRPUSDT'] });
    await scanner.start();
    rest.exchange = [symbolInfo('BTCUSDT'), { ...symbolInfo('XRPUSDT'), contractType: 'CURRENT_QUARTER' }];
    await timers.advance(3_600_000);
    expect(repos.symbols.markDelisted).toHaveBeenCalledWith(['ETHUSDT'], START + 3_600_000);
    expect(streams.current().keys()).toEqual(['BTCUSDT:5m', 'BTCUSDT:15m', 'BTCUSDT:1h']);
    await scanner.stop();
  });

  it('EDGE-SCN-005 stream pengganti (rediscovery) memicu catch-up candle yang terlewat saat open', async () => {
    const { scanner, rest, streams, timers, analysed } = setup({ symbols: ['BTCUSDT'], restBackfillIntervalSec: 3600 });
    await scanner.start();
    rest.exchange = [symbolInfo('BTCUSDT'), symbolInfo('SOLUSDT')];
    await timers.advance(3_600_000);
    expect(streams.created).toHaveLength(2);
    const btc = analysed.filter((a) => a.symbol === 'BTCUSDT');
    expect(btc.map((a) => a.reason)).toEqual(['reconnect']);
    expect(ot(btc[0].candles)[0]).toBe(LAST_CLOSED + M5);
    // SOLUSDT baru = bootstrap murni → tidak dianalisis
    expect(analysed.some((a) => a.symbol === 'SOLUSDT')).toBe(false);
    await scanner.stop();
  });

  it('UNIT-SCN-012 liquidityOf → ukuran discovery + ambang settings.liquidity yang dipakai discovery itu; perubahan pengaturan berlaku pada rediscovery berikutnya', async () => {
    const { scanner, timers, settings } = setup({ symbols: ['BTCUSDT'], liquidity: { minQuoteVolume24h: 2_000_000, maxSpreadBps: 40 } });
    await scanner.start();
    expect(scanner.liquidityOf('BTCUSDT')).toEqual({ quoteVolume24h: 1e9, spreadBps: 1, thresholds: { minQuoteVolume24h: 2_000_000, maxSpreadBps: 40 } });
    expect(scanner.liquidityOf('ETHUSDT')).toBeNull();
    settings.liquidity = { minQuoteVolume24h: 7_000_000, maxSpreadBps: 3 };
    expect(scanner.liquidityOf('BTCUSDT').thresholds).toEqual({ minQuoteVolume24h: 2_000_000, maxSpreadBps: 40 });
    await timers.advance(3_600_000);
    expect(scanner.liquidityOf('BTCUSDT').thresholds).toEqual({ minQuoteVolume24h: 7_000_000, maxSpreadBps: 3 });
    // Ambang tidak valid (mis. discoverSymbols palsu tidak memvalidasi) → null, pipeline memakai default.
    settings.liquidity = { minQuoteVolume24h: -1, maxSpreadBps: 3 };
    await timers.advance(3_600_000);
    expect(scanner.liquidityOf('BTCUSDT')).toEqual({ quoteVolume24h: 1e9, spreadBps: 1, thresholds: null });
    await scanner.stop();
  });

  it('UNIT-SCN-014 onMonitoringStopped: delisted → SYMBOL_DELISTED, keluar seleksi → MONITORING_STOPPED (timeframes null), dipanggil setelah stream lama dihentikan', async () => {
    const stops = [];
    let ctx = null;
    ctx = setup({
      symbols: ['BTCUSDT', 'ETHUSDT', 'XRPUSDT'],
      onMonitoringStopped: async (e) => { stops.push({ ...e, firstStreamStopped: ctx.streams.created[0].stopped }); },
    });
    const { scanner, rest, timers } = ctx;
    await scanner.start();
    expect(stops).toEqual([]);
    rest.exchange = [symbolInfo('BTCUSDT'), symbolInfo('ETHUSDT', 'SETTLING'), { ...symbolInfo('XRPUSDT'), contractType: 'CURRENT_QUARTER' }];
    await timers.advance(3_600_000);
    const at = START + 3_600_000;
    expect(stops).toEqual([
      { symbol: 'ETHUSDT', timeframes: null, reason: 'SYMBOL_DELISTED', at, firstStreamStopped: true },
      { symbol: 'XRPUSDT', timeframes: null, reason: 'MONITORING_STOPPED', at, firstStreamStopped: true },
    ]);
    // Rediscovery berikutnya tanpa perubahan → tidak dilaporkan ulang.
    await timers.advance(3_600_000);
    expect(stops).toHaveLength(2);
    await scanner.stop();
  });

  it('UNIT-SCN-015 timeframe dilepas dari pengaturan → MONITORING_STOPPED hanya untuk timeframe itu; simbol terpantau di DB yang hilang dari exchangeInfo saat start → SYMBOL_DELISTED; discovery gagal → tidak ada pelepasan; error callback dicatat; callback bukan fungsi ditolak', async () => {
    const stops = [];
    const ctx = setup({
      symbols: ['BTCUSDT'], timeframes: ['5m', '1h'], monitoredInDb: ['BTCUSDT', 'OLDUSDT'],
      onMonitoringStopped: async (e) => {
        stops.push(e);
        if (e.symbol === 'BTCUSDT') throw new Error('DB terkunci');
      },
    });
    const { scanner, rest, repos, timers, settings } = ctx;
    await scanner.start();
    expect(stops).toEqual([{ symbol: 'OLDUSDT', timeframes: null, reason: 'SYMBOL_DELISTED', at: START }]);

    settings.timeframes = ['5m'];
    await timers.advance(3_600_000);
    expect(stops.at(-1)).toEqual({ symbol: 'BTCUSDT', timeframes: ['1h'], reason: 'MONITORING_STOPPED', at: START + 3_600_000 });
    expect(recordedErrors(repos)).toEqual([{ at: START + 3_600_000, source: 'monitoring', message: 'DB terkunci' }]);
    // 1h tidak lagi dianalisis (sinyalnya ditutup), tetapi tetap diingesti sebagai konteks HTF 5m.
    expect(scanner.status()).toMatchObject({ state: 'running', streams: 3 });

    rest.failDiscovery = true;
    await timers.advance(3_600_000);
    expect(stops).toHaveLength(2);
    await scanner.stop();
    const base = { rest, repos, streamFactory: ctx.streams.factory, getSettings: async () => ({}), discoverSymbols: fakeDiscover };
    expect(() => createScanner({ ...base, onMonitoringStopped: 'tutup' })).toThrow(TypeError);
  });

  it('UNIT-SCN-023 HTF konteks selalu diingesti: pengaturan 5m saja → stream & bootstrap 5m+15m+1h, candle 15m/1h tersimpan tetapi hanya 5m yang dianalisis; ganti ke 15m → 5m dilepas (MONITORING_STOPPED [5m]), 15m mulai dianalisis; kembali ke 5m → 15m turun jadi konteks (MONITORING_STOPPED [15m], stream tetap)', async () => {
    const stops = [];
    const { scanner, rest, repos, streams, timers, analysed, settings } = setup({
      symbols: ['BTCUSDT'], timeframes: ['5m'], onMonitoringStopped: async (e) => { stops.push(e); },
    });
    await scanner.start();
    expect(streams.current().keys()).toEqual(['BTCUSDT:5m', 'BTCUSDT:15m', 'BTCUSDT:1h']);
    expect(rest.klineCalls().map((r) => r.timeframe)).toEqual(['5m', '15m', '1h']);

    const M15 = TIMEFRAME_MS['15m'];
    const last15 = Math.max(...repos.store.get('BTCUSDT:15m').keys());
    timers.setNow(last15 + 2 * M15 + 500);
    streams.current().push(candle('BTCUSDT', '15m', last15 + M15, { source: 'ws' }));
    streams.current().push(candle('BTCUSDT', '5m', LAST_CLOSED + M5, { source: 'ws' }));
    await flush();
    expect(repos.store.get('BTCUSDT:15m').get(last15 + M15)).toMatchObject({ source: 'ws' });
    expect(analysed.map((a) => [a.timeframe, a.reason])).toEqual([['5m', 'live']]);
    await timers.advance(30 * 60_000); // sweep REST juga mengisi 15m/1h, tetap tanpa analisis HTF
    expect(new Set(analysed.map((a) => a.timeframe))).toEqual(new Set(['5m']));
    expect(stops).toEqual([]);

    settings.timeframes = ['15m'];
    await timers.advance(START + 3_600_000 - timers.clock()); // rediscovery
    expect(stops).toEqual([{ symbol: 'BTCUSDT', timeframes: ['5m'], reason: 'MONITORING_STOPPED', at: START + 3_600_000 }]);
    expect(streams.current().keys()).toEqual(['BTCUSDT:15m', 'BTCUSDT:1h']);
    analysed.length = 0;
    await timers.advance(45 * 60_000); // sweep berikutnya
    expect(analysed.length).toBeGreaterThan(0);
    expect(new Set(analysed.map((a) => a.timeframe))).toEqual(new Set(['15m']));

    settings.timeframes = ['5m'];
    await timers.advance(START + 7_200_000 - timers.clock());
    expect(stops.at(-1)).toEqual({ symbol: 'BTCUSDT', timeframes: ['15m'], reason: 'MONITORING_STOPPED', at: START + 7_200_000 });
    expect(streams.current().keys()).toEqual(['BTCUSDT:15m', 'BTCUSDT:1h', 'BTCUSDT:5m']);
    analysed.length = 0;
    await timers.advance(45 * 60_000);
    expect(analysed.length).toBeGreaterThan(0);
    expect(new Set(analysed.map((a) => a.timeframe))).toEqual(new Set(['5m']));
    expect(stops).toHaveLength(2);
    await scanner.stop();
  });

  it('UNIT-SCN-018 listOpenSeries (level-triggered): seri bersinyal terbuka yang tidak dipantau dilaporkan tiap discovery berhasil — timeframe di luar pengaturan → MONITORING_STOPPED [tf], TRADING tak terpilih → MONITORING_STOPPED, hilang dari exchangeInfo → SYMBOL_DELISTED; callback gagal dicoba lagi siklus berikutnya; discovery gagal → tidak ada pelepasan', async () => {
    // Sinyal terbuka palsu (SINTETIS): 'SIMBOL:timeframe'; penutupan yang berhasil menghapusnya.
    const open = new Set(['BTCUSDT:1h', 'BTCUSDT:5m', 'ETHUSDT:5m', 'IDLEUSDT:5m', 'OLDUSDT:15m']);
    const stops = [];
    let failures = 1;
    const ctx = setup({
      symbols: ['BTCUSDT', 'ETHUSDT'],
      listOpenSeries: async () => [...open].sort().map((k) => ({ symbol: k.split(':')[0], timeframe: k.split(':')[1] })),
      onMonitoringStopped: async (e) => {
        stops.push(e);
        if (failures > 0) {
          failures -= 1;
          throw new Error('database is locked');
        }
        for (const k of [...open]) {
          const [symbol, tf] = k.split(':');
          if (symbol === e.symbol && (e.timeframes === null || e.timeframes.includes(tf))) open.delete(k);
        }
      },
    });
    const { scanner, rest, repos, timers } = ctx;
    rest.exchange = [...rest.exchange, { ...symbolInfo('IDLEUSDT'), contractType: 'CURRENT_QUARTER' }];
    await scanner.start();
    expect(stops).toEqual([
      { symbol: 'BTCUSDT', timeframes: ['1h'], reason: 'MONITORING_STOPPED', at: START },
      { symbol: 'IDLEUSDT', timeframes: null, reason: 'MONITORING_STOPPED', at: START },
      { symbol: 'OLDUSDT', timeframes: null, reason: 'SYMBOL_DELISTED', at: START },
    ]);
    expect(recordedErrors(repos)).toEqual([{ at: START, source: 'monitoring', message: 'database is locked' }]);
    expect([...open].sort()).toEqual(['BTCUSDT:1h', 'BTCUSDT:5m', 'ETHUSDT:5m']);

    // Discovery gagal → fallback tanpa pelepasan, walau masih ada seri terbuka yang tidak dipantau.
    rest.failDiscovery = true;
    await timers.advance(3_600_000);
    expect(stops).toHaveLength(3);

    rest.failDiscovery = false;
    await timers.advance(60_000); // percobaan ulang discovery berhasil → penutupan yang gagal dicoba lagi
    expect(stops.slice(3)).toEqual([{ symbol: 'BTCUSDT', timeframes: ['1h'], reason: 'MONITORING_STOPPED', at: START + 3_660_000 }]);
    expect([...open].sort()).toEqual(['BTCUSDT:5m', 'ETHUSDT:5m']);
    await timers.advance(3_600_000);
    expect(stops).toHaveLength(4);
    await scanner.stop();

    const base = { rest, repos, streamFactory: ctx.streams.factory, getSettings: async () => ({}), discoverSymbols: fakeDiscover };
    expect(() => createScanner({ ...base, listOpenSeries: [] })).toThrow(TypeError);
  });

  it('UNIT-SCN-019 stop() saat setMonitored rediscovery (simbol delisted) → tidak ada pelepasan di siklus itu; scanner berikutnya di atas DB yang sama menutupnya saat start lewat listOpenSeries; listOpenSeries gagal → error "monitoring"', async () => {
    const open = [{ symbol: 'ETHUSDT', timeframe: '5m' }];
    const stops = [];
    const ctx = setup({ symbols: ['BTCUSDT', 'ETHUSDT'], listOpenSeries: async () => open, onMonitoringStopped: async (e) => { stops.push(e); } });
    const { scanner, rest, repos, timers } = ctx;
    await scanner.start();
    expect(stops).toEqual([]);

    rest.exchange = [symbolInfo('BTCUSDT'), symbolInfo('ETHUSDT', 'SETTLING')];
    let release;
    repos.symbols.setMonitored.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    await timers.advance(3_600_000);
    expect(release).toBeTypeOf('function');
    const stopping = scanner.stop();
    release();
    await stopping;
    expect(stops).toEqual([]);

    // Restart: DB sudah tidak memantau ETHUSDT (setMonitored terlanjur commit), sinyalnya masih terbuka.
    const restartAt = timers.clock();
    const second = createScanner({
      rest, repos, streamFactory: ctx.streams.factory, getSettings: async () => ctx.settings, discoverSymbols: fakeDiscover,
      clock: timers.clock, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
      listOpenSeries: async () => open, onMonitoringStopped: async (e) => { stops.push(e); },
    });
    await second.start();
    expect(stops).toEqual([{ symbol: 'ETHUSDT', timeframes: null, reason: 'SYMBOL_DELISTED', at: restartAt }]);
    await second.stop();

    const third = createScanner({
      rest, repos, streamFactory: ctx.streams.factory, getSettings: async () => ctx.settings, discoverSymbols: fakeDiscover,
      clock: timers.clock, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
      listOpenSeries: async () => { throw new Error('SQLITE_IOERR'); },
    });
    repos.ingestion.recordError.mockClear();
    await third.start();
    expect(recordedErrors(repos)).toEqual([{ at: timers.clock(), source: 'monitoring', message: 'SQLITE_IOERR' }]);
    expect(third.status()).toMatchObject({ state: 'running', symbols: 1 });
    await third.stop();
  });

  it('UNIT-SCN-016 simbol exchangeInfo yang ditolak repositori dicatat sekali per discovery: delivery saja → debug, bentuk lain → info; bukan error ingesti', async () => {
    const entries = [];
    const at = (level) => (fields, msg) => entries.push({ level, fields, msg });
    const logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
    const { scanner, repos, timers } = setup({ symbols: ['BTCUSDT'], logger });
    repos.symbols.upsertFromExchange
      .mockResolvedValueOnce({ inserted: 1, updated: 0, rejectedCount: 1, rejected: [{ symbol: 'BTCUSDT_270326', errors: ['symbol tidak valid (harus [A-Z0-9]{1,32})'] }] })
      .mockResolvedValueOnce({ inserted: 0, updated: 1, rejectedCount: 3, rejected: [{ symbol: 'BTCUSDT_270326', errors: ['a'] }, { symbol: null, errors: ['b'] }] })
      .mockResolvedValueOnce({ inserted: 0, updated: 1, rejectedCount: 0, rejected: [] });
    const skipped = () => entries.filter((e) => e.msg === 'simbol exchangeInfo tidak disimpan (format simbol tidak didukung)');
    await scanner.start();
    expect(skipped()).toEqual([{ level: 'debug', msg: expect.any(String), fields: {
      count: 1, symbols: ['BTCUSDT_270326'], reasons: ['symbol tidak valid (harus [A-Z0-9]{1,32})'],
    } }]);
    await timers.advance(3_600_000);
    expect(skipped()[1]).toEqual({ level: 'info', msg: expect.any(String), fields: { count: 3, symbols: ['BTCUSDT_270326', null], reasons: ['a', 'b'] } });
    await timers.advance(3_600_000);
    expect(skipped()).toHaveLength(2);
    expect(recordedErrors(repos)).toEqual([]);
    expect(entries.filter((e) => e.level === 'warn' || e.level === 'error')).toEqual([]);
    await scanner.stop();
  });

  it('NEG-SCN-009 discovery memilih 0 simbol padahal 2 simbol dipantau → anomali: set pantauan, stream, likuiditas dipertahankan, tidak ada markDelisted/setMonitored/pelepasan/rekonsiliasi; error "discovery" + peringatan; percobaan ulang normal → pulih tanpa error baru', async () => {
    const stops = [];
    const warns = [];
    const logger = { ...silentLogger, warn: (fields, msg) => warns.push(msg) };
    const { scanner, repos, streams, timers } = setup({
      logger,
      onMonitoringStopped: async (e) => { stops.push(e); },
      listOpenSeries: async () => [{ symbol: 'BTCUSDT', timeframe: '5m' }, { symbol: 'ETHUSDT', timeframe: '5m' }],
    });
    await scanner.start();
    const first = streams.current();
    expect(repos.symbols.setMonitored).toHaveBeenCalledTimes(1);

    fakeDiscover.mockImplementationOnce(() => ({ selected: [], rejected: [] }));
    await timers.advance(3_600_000);
    expect(streams.current()).toBe(first);
    expect(first.stopped).toBe(false);
    expect(scanner.status()).toMatchObject({ symbols: 2, streams: 6, state: 'running' });
    expect(scanner.liquidityOf('BTCUSDT')).not.toBeNull();
    expect(repos.symbols.setMonitored).toHaveBeenCalledTimes(1);
    expect(repos.symbols.markDelisted).not.toHaveBeenCalled();
    expect(stops).toEqual([]);
    expect(recordedErrors(repos)).toEqual([{
      at: START + 3_600_000, source: 'discovery',
      message: 'discovery anomali: 0 simbol terpilih (mode auto) padahal 2 simbol sedang dipantau; set pantauan & stream dipertahankan, tidak ada sinyal yang ditutup',
    }]);
    expect(warns).toContain('discovery memilih 0 simbol padahal set pantauan tidak kosong; set pantauan dipertahankan');

    await timers.advance(60_000); // percobaan ulang (jeda discoveryRetryMs) dengan discovery normal
    expect(repos.symbols.setMonitored).toHaveBeenCalledTimes(2);
    expect(streams.current()).toBe(first);
    expect(stops).toEqual([]);
    expect(recordedErrors(repos)).toHaveLength(1);
    await scanner.stop();
  });

  it('EDGE-SCN-008 siklus pertama: discovery 0 simbol dan DB memantau BTCUSDT → anomali, stream dari daftar DB tanpa pelepasan; DB kosong → 0 simbol bukan anomali (tanpa error)', async () => {
    const stops = [];
    const ctx = setup({ symbols: ['BTCUSDT'], monitoredInDb: ['BTCUSDT'], onMonitoringStopped: async (e) => { stops.push(e); } });
    fakeDiscover.mockImplementationOnce(() => ({ selected: [], rejected: [] }));
    await ctx.scanner.start();
    expect(ctx.streams.current().keys()).toEqual(['BTCUSDT:5m', 'BTCUSDT:15m', 'BTCUSDT:1h']);
    expect(ctx.repos.symbols.setMonitored).not.toHaveBeenCalled();
    expect(stops).toEqual([]);
    expect(recordedErrors(ctx.repos)).toEqual([expect.objectContaining({ source: 'discovery', message: expect.stringContaining('padahal 1 simbol sedang dipantau') })]);
    await ctx.scanner.stop();

    const empty = setup({ symbols: ['BTCUSDT'] });
    fakeDiscover.mockImplementationOnce(() => ({ selected: [], rejected: [] }));
    await empty.scanner.start();
    expect(recordedErrors(empty.repos)).toEqual([]);
    expect(empty.repos.symbols.setMonitored).toHaveBeenCalledWith([], START);
    expect(empty.scanner.status()).toMatchObject({ symbols: 0, streams: 0 });
    await empty.scanner.stop();
  });

  it('EDGE-SCN-009 satu-satunya simbol terpantau (AAAUSDT) menjadi SETTLING → 0 simbol terpilih dijelaskan exchangeInfo, bukan anomali: markDelisted + SYMBOL_DELISTED, stream dilepas, setMonitored([]), tanpa error "discovery"', async () => {
    const stops = [];
    const { scanner, repos, rest, streams, timers } = setup({ symbols: ['AAAUSDT'], onMonitoringStopped: async (e) => { stops.push(e); } });
    await scanner.start();
    const first = streams.current();
    expect(first.keys()).toEqual(['AAAUSDT:5m', 'AAAUSDT:15m', 'AAAUSDT:1h']);

    rest.exchange = [{ ...rest.exchange[0], status: 'SETTLING' }];
    await timers.advance(3_600_000);
    expect(repos.symbols.markDelisted).toHaveBeenCalledWith(['AAAUSDT'], START + 3_600_000);
    expect(repos.symbols.setMonitored).toHaveBeenLastCalledWith([], START + 3_600_000);
    expect(stops).toEqual([{ symbol: 'AAAUSDT', timeframes: null, reason: 'SYMBOL_DELISTED', at: START + 3_600_000 }]);
    expect(first.stopped).toBe(true);
    expect(scanner.status()).toMatchObject({ symbols: 0, streams: 0 });
    expect(recordedErrors(repos)).toEqual([]);

    await timers.advance(3_600_000); // rediscovery berikutnya: set kosong + 0 simbol → normal, tanpa laporan ulang
    expect(stops).toHaveLength(1);
    expect(recordedErrors(repos)).toEqual([]);
    await scanner.stop();
  });

  it('POS-SCN-005 pengaturan sah yang memilih 0 simbol (discoverSymbols asli) diterapkan, bukan anomali: (a) filter auto maxSpreadBps 0 → WIDE_SPREAD; (b) mode manual [XYZUSDT] yang tidak terdaftar → simbol lama MONITORING_STOPPED, stream dilepas, perubahan timeframe ikut diterapkan, tanpa error', async () => {
    const run = async (change) => {
      const stops = [];
      const ctx = setup({ discover: discoverSymbols, onMonitoringStopped: async (e) => { stops.push(e); } });
      await ctx.scanner.start();
      const first = ctx.streams.current();
      expect(ctx.scanner.status()).toMatchObject({ symbols: 2, streams: 6 });
      change(ctx.settings);
      await ctx.timers.advance(3_600_000);
      return { ...ctx, first, stops };
    };
    const released = (at) => [
      { symbol: 'BTCUSDT', timeframes: null, reason: 'MONITORING_STOPPED', at },
      { symbol: 'ETHUSDT', timeframes: null, reason: 'MONITORING_STOPPED', at },
    ];

    const a = await run((settings) => { settings.liquidity = { ...settings.liquidity, maxSpreadBps: 0 }; });
    expect(a.stops).toEqual(released(START + 3_600_000));
    expect(a.repos.symbols.markDelisted).not.toHaveBeenCalled();
    expect(a.repos.symbols.setMonitored).toHaveBeenLastCalledWith([], START + 3_600_000);
    expect(a.first.stopped).toBe(true);
    expect(a.scanner.status()).toMatchObject({ symbols: 0, streams: 0 });
    expect(recordedErrors(a.repos)).toEqual([]);
    await a.scanner.stop();

    const b = await run((settings) => {
      settings.symbols = { ...settings.symbols, mode: 'manual', manual: ['XYZUSDT'] };
      settings.timeframes = ['15m'];
    });
    expect(b.stops).toEqual(released(START + 3_600_000));
    expect(b.repos.symbols.setMonitored).toHaveBeenLastCalledWith([], START + 3_600_000);
    expect(b.scanner.status()).toMatchObject({ symbols: 0, streams: 0 });
    expect(recordedErrors(b.repos)).toEqual([]);
    // Pengaturan baru dipakai siklus berikutnya: simbol manual yang kemudian terdaftar dipantau dengan timeframe 15m (+ HTF 1h).
    b.rest.exchange = [...b.rest.exchange, { ...b.rest.exchange[0], symbol: 'XYZUSDT', baseAsset: 'XYZ' }];
    await b.timers.advance(3_600_000);
    expect(b.streams.current().keys()).toEqual(['XYZUSDT:15m', 'XYZUSDT:1h']);
    await b.scanner.stop();
  });

  it('NEG-SCN-010 mode auto: ticker 24 jam kosong (anomali) bersamaan dengan ETHUSDT menjadi SETTLING → error "discovery", BTCUSDT & stream-nya dipertahankan, tetapi ETHUSDT tetap dilepas: markDelisted + SYMBOL_DELISTED, setMonitored([BTCUSDT]); tanpa rekonsiliasi atas hasil anomali', async () => {
    const stops = [];
    // Seri bersinyal terbuka (repositori sinyal palsu): sinyal yatim OLDUSDT tertutup setelah dilaporkan.
    const open = new Set(['BTCUSDT', 'OLDUSDT']);
    const { scanner, repos, rest, streams, timers } = setup({
      discover: discoverSymbols,
      onMonitoringStopped: async (e) => { stops.push(e); open.delete(e.symbol); },
      listOpenSeries: async () => [...open].map((symbol) => ({ symbol, timeframe: '5m' })),
    });
    await scanner.start();
    expect(stops).toEqual([{ symbol: 'OLDUSDT', timeframes: null, reason: 'SYMBOL_DELISTED', at: START }]);
    stops.length = 0;
    open.add('ZZZUSDT'); // sinyal yatim baru: hanya boleh ditutup oleh rekonsiliasi discovery yang berhasil

    const tickers = rest.get24hTickers;
    rest.get24hTickers = async () => [];
    rest.exchange = [rest.exchange[0], { ...rest.exchange[1], status: 'SETTLING' }];
    await timers.advance(3_600_000);
    const at = START + 3_600_000;
    expect(recordedErrors(repos)).toEqual([{
      at, source: 'discovery',
      message: 'discovery anomali: 0 simbol terpilih (mode auto) padahal 2 simbol sedang dipantau; 1 simbol dipertahankan, hanya 1 simbol delisted yang dilepas',
    }]);
    expect(repos.symbols.markDelisted).toHaveBeenCalledWith(['ETHUSDT'], at);
    expect(repos.symbols.setMonitored).toHaveBeenLastCalledWith(['BTCUSDT'], at);
    expect(stops).toEqual([{ symbol: 'ETHUSDT', timeframes: null, reason: 'SYMBOL_DELISTED', at }]);
    expect(streams.current().keys()).toEqual(['BTCUSDT:5m', 'BTCUSDT:15m', 'BTCUSDT:1h']);
    expect(scanner.status()).toMatchObject({ symbols: 1, streams: 3 });
    expect(scanner.liquidityOf('BTCUSDT')).not.toBeNull();

    rest.get24hTickers = tickers;
    await timers.advance(60_000); // percobaan ulang normal → rekonsiliasi berjalan lagi
    expect(repos.symbols.setMonitored).toHaveBeenLastCalledWith(['BTCUSDT'], at + 60_000);
    expect(stops.slice(1)).toEqual([{ symbol: 'ZZZUSDT', timeframes: null, reason: 'SYMBOL_DELISTED', at: at + 60_000 }]);
    expect(recordedErrors(repos)).toHaveLength(1);
    await scanner.stop();
  });

  it('EDGE-SCN-004 rediscovery tanpa perubahan tidak membuat ulang stream', async () => {
    const { scanner, streams, timers, repos } = setup();
    await scanner.start();
    await timers.advance(3_600_000);
    expect(streams.created).toHaveLength(1);
    expect(repos.symbols.markDelisted).not.toHaveBeenCalled();
    await scanner.stop();
  });
});

describe('heartbeat, status, stop', () => {
  it('UNIT-SCN-010 heartbeat tiap 30 detik membawa state dan metrik', async () => {
    const { scanner, repos, timers } = setup();
    await scanner.start();
    repos.ingestion.heartbeat.mockClear();
    await timers.advance(90_000);
    const beats = repos.ingestion.heartbeat.mock.calls.map(([b]) => b);
    expect(beats.map((b) => b.at)).toEqual([START + 30_000, START + 60_000, START + 90_000]);
    expect(beats.every((b) => b.state.state === 'running')).toBe(true);
    expect(beats[0].state).toMatchObject({ symbols: 2, streams: 6, errors: 0 });
    await scanner.stop();
  });

  it('UNIT-SCN-011 stop() membersihkan semua timer, menghentikan stream, heartbeat akhir "stopped"', async () => {
    const { scanner, repos, streams, timers } = setup();
    await scanner.start();
    expect(timers.pending.size).toBeGreaterThan(0);
    await scanner.stop();
    expect(timers.pending.size).toBe(0);
    expect(streams.current().stopped).toBe(true);
    expect(repos.ingestion.heartbeat.mock.calls.at(-1)[0]).toMatchObject({ state: { state: 'stopped' } });
    expect(scanner.status().state).toBe('stopped');
    const n = repos.ingestion.heartbeat.mock.calls.length;
    await timers.advance(10 * 3_600_000);
    expect(repos.ingestion.heartbeat.mock.calls.length).toBe(n);
    await scanner.stop(); // idempoten
  });

  it('EDGE-SCN-006 stop() saat bootstrap berjalan menunggu tugas aktif dan tidak memulai REST baru', async () => {
    const symbols = ['AAAUSDT', 'BBBUSDT', 'CCCUSDT', 'DDDUSDT', 'EEEUSDT'];
    const ctx = setup({ symbols });
    const { scanner, rest, timers } = ctx;
    const waiters = [];
    rest.klinesGate = () => new Promise((resolve) => waiters.push(resolve));
    const started = scanner.start();
    await flush();
    expect(waiters).toHaveLength(3);
    const { repos } = ctx;
    const stopping = scanner.stop();
    await flush();
    expect(scanner.status().state).toBe('stopping');
    // selama drain tidak ada timer (heartbeat/rediscovery/sweep) yang masih berjalan
    const beats = repos.ingestion.heartbeat.mock.calls.length;
    await timers.advance(2 * 3_600_000);
    expect(repos.ingestion.heartbeat.mock.calls.length).toBe(beats);
    expect(timers.pending.size).toBe(0);
    waiters.splice(0).forEach((r) => r());
    await stopping;
    await started;
    expect(rest.klineCalls()).toHaveLength(3);
    expect(scanner.status().state).toBe('stopped');
    expect(timers.pending.size).toBe(0);
  });

  it('UNIT-SCN-013 serverClock: sync di awal setiap siklus (start & rediscovery) sebelum discovery; gagal → error ingesti "clock", scanner tetap jalan; offset di status/heartbeat', async () => {
    const order = [];
    const results = [{ ok: true, offsetMs: 250 }, { ok: false, offsetMs: 250, message: 'sinkronisasi jam server gagal: HTTP 503' }];
    let offset = 0;
    const serverClock = {
      sync: vi.fn(async () => {
        order.push('sync');
        const r = results.shift();
        offset = r.offsetMs;
        return r;
      }),
      offsetMs: () => offset,
    };
    const { scanner, rest, repos, timers } = setup({ serverClock });
    const getExchangeInfo = rest.getExchangeInfo;
    rest.getExchangeInfo = async () => { order.push('exchangeInfo'); return getExchangeInfo(); };
    await scanner.start();
    expect(order).toEqual(['sync', 'exchangeInfo']);
    expect(scanner.status()).toMatchObject({ state: 'running', clockOffsetMs: 250, errors: 0 });
    expect(repos.ingestion.heartbeat.mock.calls.at(-1)[0].state.clockOffsetMs).toBe(250);

    await timers.advance(3_600_000);
    expect(order).toEqual(['sync', 'exchangeInfo', 'sync', 'exchangeInfo']);
    expect(recordedErrors(repos)).toEqual([{ at: START + 3_600_000, source: 'clock', message: 'sinkronisasi jam server gagal: HTTP 503' }]);
    expect(scanner.status()).toMatchObject({ state: 'running', clockOffsetMs: 250, errors: 1, symbols: 2 });
    // sync yang melempar (kontrak dilanggar) juga hanya dicatat
    serverClock.sync.mockImplementationOnce(async () => { throw new Error('rusak'); });
    await timers.advance(3_600_000);
    expect(recordedErrors(repos).at(-1)).toMatchObject({ source: 'clock', message: 'rusak' });
    expect(scanner.status().state).toBe('running');
    await scanner.stop();
  });

  it('UNIT-SCN-022 serverClock OFFSET_OUT_OF_RANGE → state "degraded" + clockFault di status/heartbeat, error ingesti "clock", peringatan log; kegagalan sync lain tidak mengubah state; sync berhasil berikutnya → "running"', async () => {
    const results = [
      { ok: false, reason: 'OFFSET_OUT_OF_RANGE', offsetMs: 0, measuredOffsetMs: 900_000, message: 'selisih jam lokal vs server 900000 ms melebihi batas' },
      { ok: false, reason: 'REQUEST_FAILED', offsetMs: 0, message: 'sinkronisasi jam server gagal: HTTP 503' },
      { ok: true, offsetMs: 40 },
      { ok: false, reason: 'REQUEST_FAILED', offsetMs: 40, message: 'sinkronisasi jam server gagal: HTTP 503' },
    ];
    const serverClock = { sync: vi.fn(async () => results.shift()), offsetMs: () => 0 };
    const warns = [];
    const logger = { ...silentLogger, warn: (fields, msg) => warns.push(msg) };
    const { scanner, repos, timers } = setup({ serverClock, logger });
    await scanner.start();
    expect(scanner.status()).toMatchObject({ state: 'degraded', clockFault: 'OFFSET_OUT_OF_RANGE', ws: 'open', streams: 6 });
    expect(repos.ingestion.heartbeat.mock.calls.at(-1)[0].state).toMatchObject({ state: 'degraded', clockFault: 'OFFSET_OUT_OF_RANGE' });
    expect(recordedErrors(repos)).toEqual([{ at: START, source: 'clock', message: 'selisih jam lokal vs server 900000 ms melebihi batas' }]);
    expect(warns).toContain('jam host menyimpang dari waktu server Binance melebihi batas; worker degraded (periksa NTP host)');

    await timers.advance(3_600_000); // REQUEST_FAILED: belum ada sync berhasil → tetap degraded
    expect(scanner.status()).toMatchObject({ state: 'degraded', clockFault: 'OFFSET_OUT_OF_RANGE' });
    await timers.advance(3_600_000); // sync berhasil
    expect(scanner.status()).toMatchObject({ state: 'running', clockFault: null });
    await timers.advance(3_600_000); // REQUEST_FAILED biasa → offset terakhir sah, tetap running
    expect(scanner.status()).toMatchObject({ state: 'running', clockFault: null });
    await scanner.stop();
  });

  it('EDGE-SCN-007 tanpa serverClock → clockOffsetMs null; serverClock tanpa sync()/offsetMs() ditolak', async () => {
    const { scanner, rest, repos, streams } = setup();
    await scanner.start();
    expect(scanner.status().clockOffsetMs).toBeNull();
    await scanner.stop();
    const base = { rest, repos, streamFactory: streams.factory, getSettings: async () => ({}), discoverSymbols: fakeDiscover };
    expect(() => createScanner({ ...base, serverClock: { sync: async () => ({ ok: true }) } })).toThrow(TypeError);
  });

  it('UNIT-SCN-017 localClock (jam host 2 menit di depan clock/waktu server) → heartbeat at, recordRun, recordError, lastIngestionAt memakai localClock; rencana bootstrap, candleLagMs, dan stempel simbol memakai clock', async () => {
    const AHEAD = 120_000;
    const { scanner, repos, rest, timers } = setup({ symbols: ['BTCUSDT'], localClock: (t) => () => t.clock() + AHEAD });
    rest.failKlines.add('BTCUSDT');
    await scanner.start();
    expect(repos.ingestion.heartbeat.mock.calls.map(([b]) => b.at)).toEqual([START + AHEAD, START + AHEAD]);
    expect(repos.ingestion.recordRun).toHaveBeenCalledWith(expect.objectContaining({ startedAt: START + AHEAD, finishedAt: START + AHEAD }));
    // Bootstrap 5m + konteks 15m/1h gagal: satu baris per seri.
    expect(recordedErrors(repos)).toEqual(['5m', '15m', '1h'].map((tf) => expect.objectContaining({
      at: START + AHEAD, source: 'bootstrap', message: expect.stringContaining(`BTCUSDT ${tf}: `),
    })));
    // Waktu pasar tetap jam server: bootstrap berakhir di candle tertutup terakhir menurut clock (bukan +2 menit).
    expect(klinesOf(rest).map((r) => r.endTime)).toEqual([LAST_CLOSED + M5 - 1]);
    expect(repos.symbols.setMonitored).toHaveBeenCalledWith(['BTCUSDT'], START);

    rest.failKlines.clear();
    await timers.advance(300_000); // sweep REST mengisi candle
    expect(scanner.status()).toMatchObject({ lastIngestionAt: START + 300_000 + AHEAD, candleLagMs: 7_001 });
    await scanner.stop();
    expect(repos.ingestion.heartbeat.mock.calls.at(-1)[0].at).toBe(START + 300_000 + AHEAD);
    expect(() => createScanner({
      rest, repos, streamFactory: () => ({}), getSettings: async () => ({}), discoverSymbols: fakeDiscover, localClock: 5,
    })).toThrow(TypeError);
  });

  it('NEG-SCN-006 dependensi wajib tidak lengkap ditolak', () => {
    const { rest, repos, streams } = setup();
    const base = { rest, repos, streamFactory: streams.factory, getSettings: async () => ({}), discoverSymbols: fakeDiscover };
    expect(() => createScanner({ ...base, rest: {} })).toThrow(TypeError);
    expect(() => createScanner({ ...base, repos: { candles: repos.candles } })).toThrow(TypeError);
    expect(() => createScanner({ ...base, discoverSymbols: undefined })).toThrow(TypeError);
    expect(() => createScanner({ ...base, streamFactory: null })).toThrow(TypeError);
  });
});

describe('integrasi dengan klien WebSocket nyata (WebSocket palsu)', () => {
  // WebSocket palsu dengan API addEventListener seperti WebSocket global Node 22.
  function createFakeWebSocket() {
    const instances = [];
    class FakeWebSocket {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        this.closeCalls = [];
        instances.push(this);
      }
      addEventListener(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(fn);
      }
      removeEventListener() {}
      fire(type, props = {}) { for (const fn of this.listeners.get(type) ?? []) fn({ type, ...props }); }
      close(code, reason) { this.closeCalls.push({ code, reason }); }
    }
    return { FakeWebSocket, instances };
  }

  // Fixture sintetis — bukan data pasar nyata (format event kline Binance USDT-M Futures).
  const klineMessage = (openTime, x) => JSON.stringify({
    stream: 'btcusdt@kline_5m',
    data: {
      e: 'kline', E: openTime + M5, s: 'BTCUSDT',
      k: { t: openTime, T: openTime + M5 - 1, s: 'BTCUSDT', i: '5m', f: 1, L: 2, o: '100', c: '100.5', h: '101', l: '99', v: '10', n: 5, x, q: '1000', V: '5', Q: '500', B: '0' },
    },
  });

  it('POS-SCN-004 close → reconnect → candle terlewat di-backfill sebelum analisis, tanpa duplikat', async () => {
    const ws = createFakeWebSocket();
    // Factory dipanggil saat start(), setelah ctx terinisialisasi.
    const ctx = setup({
      symbols: ['BTCUSDT'],
      streamFactory: (opts) => createKlineStream({
        ...opts,
        WebSocketImpl: ws.FakeWebSocket,
        clock: () => ctx.timers.clock(),
        setTimer: (fn, ms) => ctx.timers.setTimer(fn, ms),
        clearTimer: (id) => ctx.timers.clearTimer(id),
        random: () => 1,
        connectTimeoutMs: 3_600_000,
      }),
    });
    const { scanner, analysed, timers, log, rest } = ctx;
    await scanner.start();
    const s1 = ws.instances[0];
    // 5m terpilih + konteks HTF 15m/1h dalam satu combined stream.
    expect(s1.url).toBe('wss://fstream.binance.com/market/stream?streams=btcusdt@kline_5m/btcusdt@kline_15m/btcusdt@kline_1h');
    s1.fire('open');
    await flush();

    timers.setNow(LAST_CLOSED + 2 * M5 + 300);
    s1.fire('message', { data: klineMessage(LAST_CLOSED + M5, true) });
    await flush();
    expect(analysed.map((a) => a.reason)).toEqual(['live']);

    s1.fire('close', { code: 1006 });
    await timers.advance(1_000);
    expect(ws.instances).toHaveLength(2);
    const s2 = ws.instances[1];
    timers.setNow(LAST_CLOSED + 4 * M5 + 2_000); // dua candle tertutup saat terputus
    log.length = 0;
    s2.fire('open');
    s2.fire('message', { data: klineMessage(LAST_CLOSED + 3 * M5, true) }); // event terlambat/duplikat
    s2.fire('message', { data: klineMessage(LAST_CLOSED + 4 * M5, false) });
    await flush();

    const kinds = log.map((e) => e[0]);
    expect(kinds.indexOf('klines')).toBeLessThan(kinds.indexOf('analysis'));
    // (Candle konteks 15m yang tutup 2 d sebelum open juga disusul REST — tidak dianalisis.)
    expect(klinesOf(rest).at(-1)).toMatchObject({ startTime: LAST_CLOSED + 2 * M5, limit: 2 });
    expect(klinesOf(rest, '15m').at(-1)).toMatchObject({ startTime: LAST_CLOSED + M5, limit: 1 }); // candle 15m T0+60 menit
    const all = analysed.flatMap((a) => ot(a.candles));
    expect(all).toEqual([LAST_CLOSED + M5, LAST_CLOSED + 2 * M5, LAST_CLOSED + 3 * M5]);
    expect(scanner.status()).toMatchObject({ reconnects: 1, state: 'running' });
    expect(ctx.repos.provisional.get('BTCUSDT:5m').openTime).toBe(LAST_CLOSED + 4 * M5);

    await scanner.stop();
    expect(s2.closeCalls).toEqual([{ code: 1000, reason: 'stop' }]);
    expect(timers.pending.size).toBe(0);
  });
});
