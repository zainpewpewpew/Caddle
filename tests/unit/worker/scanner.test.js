import { describe, expect, it, vi } from 'vitest';
import { createKlineStream } from '../../../backend/ingestion/binance/wsClient.js';
import { TIMEFRAME_MS } from '../../../backend/market/contracts.js';
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
} = {}) {
  const log = [];
  const timers = createFakeTimers();
  const rest = createFakeRest({ clock: timers.clock, symbols, log });
  const repos = createFakeRepos({ log, monitoredInDb });
  const streams = createFakeStreams();
  const analysed = [];
  const settings = {
    ...DEFAULT_SCANNER_SETTINGS,
    timeframes,
    refresh: { bootstrapCandles, restBackfillIntervalSec },
  };
  const scanner = createScanner({
    rest,
    streamFactory: streamFactory ?? streams.factory,
    repos,
    getSettings: async () => settings,
    onClosedCandles: onClosedCandles ?? (async (e) => {
      analysed.push(e);
      log.push(['analysis', e.candles.map((c) => c.openTime)]);
    }),
    clock: timers.clock,
    logger: silentLogger,
    discoverSymbols: fakeDiscover,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    options,
  });
  return { scanner, rest, repos, streams, timers, analysed, log, settings };
}

const ot = (list) => list.map((c) => c.openTime);
const recordedErrors = (repos) => repos.ingestion.recordError.mock.calls.map(([e]) => e);

describe('bootstrap', () => {
  it('POS-SCN-001 start: discovery → simpan simbol → bootstrap REST → upsert → stream dibuka', async () => {
    const { scanner, rest, repos, streams, analysed, timers } = setup({ timeframes: ['5m', '1h'] });
    await scanner.start();

    expect(rest.calls.slice(0, 3).sort()).toEqual(['bookTicker', 'exchangeInfo', 'ticker24h']);
    expect(fakeDiscover).toHaveBeenLastCalledWith(expect.objectContaining({ symbols: rest.exchange, settings: expect.any(Object) }));
    expect(repos.symbols.upsertFromExchange).toHaveBeenCalledWith(rest.exchange, START);
    expect(repos.symbols.setMonitored).toHaveBeenCalledWith(['BTCUSDT', 'ETHUSDT'], START);

    const klines = rest.klineCalls();
    expect(klines).toHaveLength(4);
    expect(klines).toContainEqual({ symbol: 'BTCUSDT', timeframe: '5m', startTime: LAST_CLOSED - 4 * M5, endTime: LAST_CLOSED + M5 - 1, limit: 5 });
    const lastClosedH1 = Math.floor(START / H1) * H1 - H1;
    expect(klines).toContainEqual({ symbol: 'ETHUSDT', timeframe: '1h', startTime: lastClosedH1 - 4 * H1, endTime: lastClosedH1 + H1 - 1, limit: 5 });

    // hanya candle tertutup, urut naik, satu batch per stream
    for (const [list] of repos.candles.upsertClosed.mock.calls) {
      expect(list.every((c) => c.isClosed)).toBe(true);
      expect(ot(list)).toEqual([...ot(list)].sort((a, b) => a - b));
    }
    expect([...repos.store.get('BTCUSDT:5m').keys()].sort()).toEqual([0, 1, 2, 3, 4].map((i) => LAST_CLOSED - (4 - i) * M5));

    expect(streams.created).toHaveLength(1);
    expect(streams.current().started).toBe(true);
    expect(streams.current().keys().sort()).toEqual(['BTCUSDT:1h', 'BTCUSDT:5m', 'ETHUSDT:1h', 'ETHUSDT:5m']);
    // bootstrap awal = histori murni → tidak memicu analisis
    expect(analysed).toHaveLength(0);

    expect(repos.ingestion.recordRun).toHaveBeenCalledTimes(1);
    expect(repos.ingestion.recordRun.mock.calls[0][0]).toEqual({ startedAt: START, finishedAt: START, symbols: 2, candles: 20, errors: 0 });
    expect(scanner.status()).toMatchObject({
      state: 'running', symbols: 2, streams: 4, errors: 0, queue: 0, scanDurationMs: 0,
      candleLagMs: START - (LAST_CLOSED + M5 - 1), lastIngestionAt: START, reconnects: 0,
    });
    await scanner.stop();
    expect(timers.pending.size).toBe(0);
  });

  it('UNIT-SCN-001 data tersimpan dipakai: hanya candle setelah lastOpenTime yang diambil', async () => {
    const { scanner, rest, repos } = setup({ symbols: ['BTCUSDT'], bootstrapCandles: 5 });
    repos.seed('BTCUSDT', '5m', [0, 1, 2, 3].map((i) => LAST_CLOSED - (6 - i) * M5));
    await scanner.start();
    expect(rest.klineCalls()).toEqual([
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
    expect(rest.klineCalls()).toEqual([
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
    expect(scanner.status().queue).toBe(10);
    while (waiters.length) {
      waiters.shift()();
      await flush();
    }
    await started;
    expect(peak).toBe(3);
    expect(repos.candles.upsertClosed).toHaveBeenCalledTimes(10);
    expect(scanner.status().queue).toBe(0);
    await scanner.stop();
  });

  it('NEG-SCN-001 error REST saat bootstrap dicatat; scanner tetap berjalan dan mencoba ulang', async () => {
    const { scanner, rest, repos, timers, streams } = setup({ symbols: ['BTCUSDT', 'ETHUSDT'] });
    rest.failKlines.add('ETHUSDT');
    await scanner.start();
    const errs = recordedErrors(repos);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ at: START, source: 'bootstrap' });
    expect(errs[0].message).toMatch(/ETHUSDT 5m: HTTP 500/);
    expect(repos.store.get('BTCUSDT:5m').size).toBe(5);
    expect(scanner.status()).toMatchObject({ state: 'running', errors: 1, streams: 2 });
    expect(streams.current().keys()).toContain('ETHUSDT:5m');
    expect(repos.ingestion.recordRun.mock.calls[0][0]).toMatchObject({ errors: 1, candles: 5 });

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

  it('NEG-SCN-002 discovery gagal saat start → pakai simbol terpantau di DB, coba ulang dengan jeda', async () => {
    const { scanner, rest, repos, streams, timers } = setup({ symbols: ['BTCUSDT', 'ETHUSDT'], monitoredInDb: ['BTCUSDT'] });
    rest.failDiscovery = true;
    await scanner.start();
    expect(recordedErrors(repos)[0]).toMatchObject({ source: 'discovery' });
    expect(repos.symbols.setMonitored).not.toHaveBeenCalled();
    expect(streams.current().keys()).toEqual(['BTCUSDT:5m']);
    expect(scanner.status()).toMatchObject({ state: 'running', symbols: 1 });

    rest.failDiscovery = false;
    await timers.advance(60_000);
    expect(repos.symbols.setMonitored).toHaveBeenLastCalledWith(['BTCUSDT', 'ETHUSDT'], START + 60_000);
    expect(streams.current().keys().sort()).toEqual(['BTCUSDT:5m', 'ETHUSDT:5m']);
    await scanner.stop();
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
    expect(rest.klineCalls().at(-1)).toEqual({ symbol: 'BTCUSDT', timeframe: '5m', startTime: LAST_CLOSED + M5, endTime: LAST_CLOSED + 4 * M5 - 1, limit: 3 });
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
    expect(second.keys().sort()).toEqual(['BTCUSDT:5m', 'SOLUSDT:5m']);
    const after = rest.klineCalls().slice(before);
    expect(after.filter((r) => r.symbol === 'SOLUSDT')).toHaveLength(1);
    expect(after.some((r) => r.symbol === 'ETHUSDT')).toBe(false);
    expect(repos.ingestion.recordRun).toHaveBeenCalledTimes(2);
    expect(scanner.status()).toMatchObject({ symbols: 2, streams: 2 });

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
    expect(streams.current().keys()).toEqual(['BTCUSDT:5m']);
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
    expect(beats[0].state).toMatchObject({ symbols: 2, streams: 2, errors: 0 });
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
    expect(s1.url).toBe('wss://fstream.binance.com/stream?streams=btcusdt@kline_5m');
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
    expect(rest.klineCalls().at(-1)).toMatchObject({ startTime: LAST_CLOSED + 2 * M5, limit: 2 });
    const all = analysed.flatMap((a) => ot(a.candles));
    expect(all).toEqual([LAST_CLOSED + M5, LAST_CLOSED + 2 * M5, LAST_CLOSED + 3 * M5]);
    expect(scanner.status()).toMatchObject({ reconnects: 1, state: 'running' });
    expect(ctx.repos.provisional.get('BTCUSDT:5m').openTime).toBe(LAST_CLOSED + 4 * M5);

    await scanner.stop();
    expect(s2.closeCalls).toEqual([{ code: 1000, reason: 'stop' }]);
    expect(timers.pending.size).toBe(0);
  });
});
