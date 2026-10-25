// Tes integrasi end-to-end worker Long Radar.
//
// Modul ASLI dirakit oleh worker/assemble.js (perakitan yang sama dengan worker/index.js): SQLite (:memory:) + migrasi + repositori, klien REST
// Binance, klien WebSocket kline, discovery simbol, scanner, dan pipeline analisis (pola → konteks
// HTF → skor → state machine → repositori sinyal). Yang dipalsukan HANYA jaringan:
// - `fetch` palsu melayani bentuk JSON REST Binance USDT-M Futures (/fapi/v1/time, exchangeInfo,
//   ticker/24hr, ticker/bookTicker, klines — baris kline berupa array urutan Binance, desimal string);
// - WebSocket palsu (API addEventListener seperti WebSocket global Node 22) meneruskan pesan
//   combined stream `{ stream, data: { e: 'kline', k } }` hanya ke koneksi yang melanggan stream itu.
// Jam & timer deterministik diinjeksi ke semua modul. Tujuannya menangkap ketidakcocokan kontrak
// antarmodul yang tidak terlihat oleh tes unit ber-mock (contoh: metrik heartbeat yang dulu dibuang
// diam-diam karena repositori hanya menyimpan field `state`).
//
// SEMUA data pasar di sini SINTETIS (tests/fixtures/candles/scenarios.js) — bukan data pasar nyata.
// Acuan hasil sinyal adalah replay murni `analyzeAt` atas candle sintetis yang sama ("live = replay").

import { afterEach, describe, expect, it } from 'vitest';
import { ANALYSIS_LOOKBACK, analyzeAt } from '../../backend/analysis/pipeline.js';
import { openDatabase } from '../../backend/database/connection.js';
import { migrate } from '../../backend/database/migrate.js';
import { createKlineStream } from '../../backend/ingestion/binance/wsClient.js';
import { HIGHER_TIMEFRAMES, TIMEFRAME_MS } from '../../backend/market/contracts.js';
import { DEFAULT_SCANNER_SETTINGS, SCANNER_SETTINGS_KEY, normalizeScannerSettings } from '../../backend/settings/scannerSettings.js';
import { HEARTBEAT_STALE_MS, summarizeWorker } from '../../backend/system/workerStatus.js';
import { assembleWorker } from '../../worker/assemble.js';
import { downtrendCandles, silentAccumulationCandles, zigzag } from '../fixtures/candles/scenarios.js';
import { SYNTHETIC_START, generateCandles, withPriceScale } from '../fixtures/candles/synthetic.js';

const M5 = TIMEFRAME_MS['5m'];
const M15 = TIMEFRAME_MS['15m'];
const H1 = TIMEFRAME_MS['1h'];
const T0 = SYNTHETIC_START;
// Saat worker start, 48 candle 5m (4 jam) sudah tertutup; candle 48..75 datang lewat WebSocket.
const BOOT = 48;
const LAST = 75;
const START = T0 + BOOT * M5 + 7_000;
const END = T0 + (LAST + 1) * M5 + 1_000;
// Kline final (x:true) tiba 0,5 detik setelah candle tutup; kline berjalan (x:false) dikirim tiap 30 detik
// (Binance terus mengirim pembaruan, sehingga koneksi tidak pernah dianggap basi oleh watchdog).
const CLOSE_DELAY_MS = 500;
const TICK_MS = 30_000;
const TICK_OFFSET_MS = 10_000;
const SA = 'SYNUSDT';
const DOWN = 'DWNUSDT';
const OPEN_STATES = Object.freeze(['QUIET', 'EARLY_BULLISH', 'MOMENTUM_BUILDING', 'BREAKOUT']);

const at5m = (i) => T0 + i * M5;
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, k) => from + k);
const seriesKey = (symbol, timeframe) => `${symbol}:${timeframe}`;
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** Penjadwal timer palsu + jam deterministik (pola sama dengan tes unit scanner). */
function createFakeTimers(start) {
  let now = start;
  let seq = 0;
  const pending = new Map();
  const clock = () => now;
  const setTimer = (fn, ms) => {
    seq += 1;
    pending.set(seq, { at: now + Math.max(0, ms), fn });
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
      now = Math.max(now, t.at);
      t.fn();
      await flush();
    }
    now = target;
    await flush();
  };
  // Memajukan jam tanpa menjalankan timer (dipakai `sleep` klien REST); timer yang jatuh tempo berjalan di advance berikutnya.
  const jump = (ms) => { now += ms; };
  return { clock, setTimer, clearTimer, advance, jump, pending };
}

// ---------- pasar sintetis ----------

/** Agregasi candle 5m ke timeframe lebih tinggi; hanya kelompok lengkap (candle HTF tertutup). */
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

/**
 * Histori 5m SINTETIS sebelum T0 (`bars` candle, harga turun pelan berpola zig-zag) yang berakhir tepat di
 * harga awal skenario (100), agar timeframe 15m/1h punya cukup candle untuk klasifikasi trend.
 */
function preHistory(symbol, bars) {
  const raw = generateCandles({
    seed: 7, symbol, startTime: T0 - bars * M5,
    segments: [{ bars, drift: -0.0003, cycle: zigzag(4, 0.002, 3, 0.002), volume: 1000, volumeNoise: 0.15 }],
  });
  return withPriceScale(raw, 100 / raw.at(-1).close)
    .map((c) => ({ ...c, quoteVolume: (c.volume * (c.open + c.close)) / 2, takerBuyQuoteVolume: c.takerBuyVolume * c.close }));
}

/**
 * Dataset SINTETIS: SYNUSDT = akumulasi senyap (SA), DWNUSDT = downtrend (tanpa sinyal); 5m + agregasi 15m/1h.
 * `preBars` > 0 menambahkan histori sebelum T0 untuk SYNUSDT (konteks HTF dengan trend nyata).
 */
function buildMarket({ preBars = 0 } = {}) {
  const sa = silentAccumulationCandles(1).map((c) => ({ ...c, symbol: SA }));
  const base = { [SA]: preBars > 0 ? [...preHistory(SA, preBars), ...sa] : sa, [DOWN]: downtrendCandles(1).slice(0, LAST + 1) };
  const market = new Map();
  for (const [symbol, list] of Object.entries(base)) {
    const m5 = list.map((c) => ({ ...c, symbol }));
    market.set(seriesKey(symbol, '5m'), m5);
    market.set(seriesKey(symbol, '15m'), aggregate(m5, '15m'));
    market.set(seriesKey(symbol, '1h'), aggregate(m5, '1h'));
  }
  return market;
}
const MARKET = buildMarket();
// 600 candle 5m (50 jam) histori: bootstrap 5m menerima 500 candle penuh, 1h punya > 29 candle (warm-up trend).
const PRE_BARS = 600;
const LONG_MARKET = buildMarket({ preBars: PRE_BARS });

/** Candle sintetis yang diharapkan tersimpan: potongan [dari, sampai, source] (indeks array dataset). */
function expectedSeries(symbol, timeframe, segments, market = MARKET) {
  const list = market.get(seriesKey(symbol, timeframe));
  return segments.flatMap(([from, to, source]) => list.slice(from, to + 1).map((c) => ({ ...c, source })));
}

const storedSeries = (repos, symbol, timeframe) => repos.candles.getRange({ symbol, timeframe, from: 0, to: Number.MAX_SAFE_INTEGER });

/** Angka → desimal string gaya Binance; menolak angka yang tidak terkirim persis (eksponen/presisi). */
function dec(n) {
  const s = String(n);
  if (!/^\d+(\.\d+)?$/.test(s) || Number(s) !== n) throw new Error(`angka sintetis ${s} tidak dapat dikirim sebagai desimal Binance`);
  return s;
}

/** Versi berjalan (belum tertutup) dari candle sintetis pada waktu `now`. */
function partialCandle(c, now) {
  const f = (now - c.openTime) / TIMEFRAME_MS[c.timeframe];
  const close = c.open + (c.close - c.open) * f;
  return {
    ...c, close, high: Math.max(c.open, close), low: Math.min(c.open, close),
    volume: c.volume * f, quoteVolume: c.quoteVolume * f, trades: Math.floor(c.trades * f),
    takerBuyVolume: c.takerBuyVolume * f, takerBuyQuoteVolume: c.takerBuyQuoteVolume * f,
    isClosed: false, source: 'ws',
  };
}

/** Baris GET /fapi/v1/klines: [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades, takerBuyBase, takerBuyQuote, ignore]. */
const klineRow = (c) => [
  c.openTime, dec(c.open), dec(c.high), dec(c.low), dec(c.close), dec(c.volume), c.closeTime,
  dec(c.quoteVolume), c.trades, dec(c.takerBuyVolume), dec(c.takerBuyQuoteVolume), '0',
];

/** Pesan combined stream kline Binance USDT-M Futures. */
const klineEvent = (c, x, eventTime) => ({
  stream: `${c.symbol.toLowerCase()}@kline_${c.timeframe}`,
  data: {
    e: 'kline', E: eventTime, s: c.symbol,
    k: {
      t: c.openTime, T: c.closeTime, s: c.symbol, i: c.timeframe, f: 1000, L: 1000 + c.trades, o: dec(c.open), c: dec(c.close),
      h: dec(c.high), l: dec(c.low), v: dec(c.volume), n: c.trades, x, q: dec(c.quoteVolume), V: dec(c.takerBuyVolume),
      Q: dec(c.takerBuyQuoteVolume), B: '0',
    },
  },
});

const spreadOf = (bid, ask) => ((Number(ask) - Number(bid)) / ((Number(ask) + Number(bid)) / 2)) * 10_000;
const klineParams = (symbol, interval, startTime, limit) => ({
  symbol, interval, startTime: String(startTime), endTime: String(startTime + limit * TIMEFRAME_MS[interval] - 1), limit: String(limit),
});

// ---------- jaringan palsu ----------

/** Server REST Binance palsu (fixture sintetis; bentuk mengikuti dokumentasi resmi USDT-M Futures). */
function createFakeBinance({ clock, market = MARKET }) {
  const onboard = market.get(seriesKey(SA, '5m'))[0].openTime;
  const listing = new Map([
    [SA, { contractType: 'PERPETUAL', status: 'TRADING', onboardDate: onboard, quoteVolume: '900000000.00', bid: '99.9900', ask: '100.0000' }],
    [DOWN, { contractType: 'PERPETUAL', status: 'TRADING', onboardDate: T0, quoteVolume: '650000000.00', bid: '99.9800', ask: '99.9900' }],
    // Lolos kontrak tetapi volume rendah → ditolak discovery (LOW_VOLUME), tetap tercatat di tabel symbols.
    ['THINUSDT', { contractType: 'PERPETUAL', status: 'TRADING', onboardDate: T0, quoteVolume: '1200000.00', bid: '2.0099', ask: '2.0100' }],
    // Kontrak delivery → ditolak discovery (NOT_PERPETUAL).
    ['SYNUSDT_270326', { contractType: 'CURRENT_QUARTER', status: 'TRADING', onboardDate: T0, quoteVolume: '300000000.00', bid: '100.1000', ask: '100.2000' }],
  ]);
  const calls = [];
  const faults = { klines503: 0 }; // jumlah request klines berikutnya yang dijawab HTTP 503
  let weightMinute = null;
  let weightUsed = 0;

  function reply(status, body, weight) {
    const minute = Math.floor(clock() / 60_000);
    if (minute !== weightMinute) {
      weightMinute = minute;
      weightUsed = 0;
    }
    weightUsed += weight;
    return new Response(JSON.stringify(body), {
      status, headers: { 'content-type': 'application/json', 'x-mbx-used-weight-1m': String(weightUsed) },
    });
  }

  function lastPrice(symbol) {
    const last = market.get(seriesKey(symbol, '5m'))?.filter((c) => c.closeTime < clock()).at(-1);
    return last ? dec(last.close) : '2.0100';
  }

  function klines(params) {
    const list = market.get(seriesKey(params.symbol, params.interval));
    if (!listing.has(params.symbol) || !list) return reply(400, { code: -1121, msg: 'Invalid symbol.' }, 1);
    if (faults.klines503 > 0) {
      faults.klines503 -= 1;
      return reply(503, { code: -1001, msg: 'Internal error; unable to process your request. Please try again.' }, 1);
    }
    const limit = params.limit === undefined ? 500 : Number(params.limit);
    const startTime = params.startTime === undefined ? null : Number(params.startTime);
    const endTime = params.endTime === undefined ? null : Number(params.endTime);
    const now = clock();
    let rows = list.filter((c) => c.openTime <= now
      && (startTime === null || c.openTime >= startTime) && (endTime === null || c.openTime <= endTime));
    rows = startTime === null ? rows.slice(-limit) : rows.slice(0, limit);
    const weight = limit < 100 ? 1 : limit < 500 ? 2 : limit <= 1000 ? 5 : 10;
    // Candle yang masih berjalan dikirim parsial, seperti Binance.
    return reply(200, rows.map((c) => klineRow(c.closeTime < now ? c : partialCandle(c, now))), weight);
  }

  async function fetch(href, init = {}) {
    const url = new URL(href);
    if (url.origin !== 'https://fapi.binance.com' || init.method !== 'GET' || init.redirect !== 'error') {
      throw new TypeError(`request di luar kontrak: ${init.method} ${url.origin}`);
    }
    const params = Object.fromEntries(url.searchParams);
    calls.push({ at: clock(), path: url.pathname, params });
    const entries = [...listing];
    switch (url.pathname) {
      case '/fapi/v1/time':
        return reply(200, { serverTime: clock() }, 1);
      case '/fapi/v1/exchangeInfo':
        return reply(200, {
          timezone: 'UTC', serverTime: clock(), futuresType: 'U_MARGINED',
          rateLimits: [{ rateLimitType: 'REQUEST_WEIGHT', interval: 'MINUTE', intervalNum: 1, limit: 2400 }],
          exchangeFilters: [],
          symbols: entries.map(([symbol, s]) => ({
            symbol, pair: symbol.replace(/_\d{6}$/, ''), contractType: s.contractType, deliveryDate: 4133404800000,
            onboardDate: s.onboardDate, status: s.status, baseAsset: symbol.replace(/USDT(_\d{6})?$/, ''), quoteAsset: 'USDT',
            marginAsset: 'USDT', pricePrecision: 4, quantityPrecision: 1,
            filters: [
              { filterType: 'PRICE_FILTER', minPrice: '0.0001', maxPrice: '100000', tickSize: '0.0001' },
              { filterType: 'LOT_SIZE', minQty: '0.1', maxQty: '1000000', stepSize: '0.1' },
            ],
          })),
        }, 1);
      case '/fapi/v1/ticker/24hr':
        return reply(200, entries.map(([symbol, s], i) => ({
          symbol, priceChange: '0.1000', priceChangePercent: '0.100', weightedAvgPrice: lastPrice(symbol), lastPrice: lastPrice(symbol),
          lastQty: '1.0', openPrice: lastPrice(symbol), highPrice: lastPrice(symbol), lowPrice: lastPrice(symbol), volume: '1000000.0',
          quoteVolume: s.quoteVolume, openTime: clock() - 86_400_000, closeTime: clock() - 1, firstId: i * 10, lastId: i * 10 + 9, count: 10,
        })), 40);
      case '/fapi/v1/ticker/bookTicker':
        return reply(200, entries.map(([symbol, s], i) => ({
          symbol, bidPrice: s.bid, bidQty: '100.0', askPrice: s.ask, askQty: '100.0', time: clock(), lastUpdateId: 7_000_000_000 + i,
        })), 5);
      case '/fapi/v1/klines':
        return klines(params);
      default:
        return reply(404, { code: -1, msg: 'Not found' }, 1);
    }
  }

  return {
    fetch,
    listing,
    calls,
    faults,
    klineCalls: () => calls.filter((c) => c.path === '/fapi/v1/klines').map((c) => c.params),
  };
}

/** WebSocket palsu (API addEventListener seperti WebSocket global Node 22) + sisi "server". */
function createFakeWebSocketHub() {
  const sockets = [];
  const server = { refuse: false }; // true → handshake ditolak (simulasi jaringan/server tidak tersedia)
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.listeners = new Map();
      this.closedWith = null;
      this.streams = new URL(url).searchParams.get('streams').split('/');
      sockets.push(this);
      // Handshake selesai (atau gagal) secara asinkron.
      queueMicrotask(() => {
        if (this.readyState !== 0) return;
        if (server.refuse) {
          this.readyState = 3;
          this.dispatch('error', { type: 'error', message: 'connect ECONNREFUSED' });
          this.dispatch('close', { type: 'close', code: 1006 });
          return;
        }
        this.readyState = 1;
        this.dispatch('open', { type: 'open' });
      });
    }

    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }

    removeEventListener(type, fn) {
      this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
    }

    close(code, reason) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.closedWith = { code, reason };
    }

    dispatch(type, ev) {
      for (const fn of this.listeners.get(type) ?? []) fn(ev);
    }

    /** Sisi server: kirim satu frame teks ke socket ini (tanpa memeriksa langganan). */
    send(payload) {
      this.dispatch('message', { type: 'message', data: JSON.stringify(payload) });
    }
  }
  return {
    FakeWebSocket,
    sockets,
    server,
    /** Server memutus semua koneksi terbuka (mis. 1006 abnormal closure). */
    disconnectAll(code = 1006) {
      for (const s of sockets) {
        if (s.readyState !== 1) continue;
        s.readyState = 3;
        s.dispatch('close', { type: 'close', code });
      }
    },
    /** Seperti server Binance: hanya koneksi terbuka yang melanggan stream tersebut yang menerima. */
    broadcast(payload) {
      let delivered = 0;
      for (const s of sockets) {
        if (s.readyState === 1 && s.streams.includes(payload.stream)) {
          s.send(payload);
          delivered += 1;
        }
      }
      return delivered;
    },
  };
}

/**
 * Penggerak pasar: memajukan jam palsu dan mengirim pesan kline seperti Binance — kline berjalan
 * (x:false) tiap 30 detik untuk setiap stream, dan kline final (x:true) setelah candle tutup.
 * Pada waktu yang sama, candle HTF dikirim lebih dulu daripada 5m (pipeline memakai settleMs 0).
 * `skip(candle)` menahan pesan (simulasi pesan hilang); `delayOf(candle)` mengatur jeda kline final.
 */
function createMarketDriver({ timers, hub, from, market = MARKET, skip = () => false, delayOf = () => CLOSE_DELAY_MS }) {
  const closes = [];
  for (const list of market.values()) {
    for (const c of list) if (c.closeTime + 1 > from) closes.push({ at: c.closeTime + 1 + delayOf(c), candle: c });
  }
  closes.sort((a, b) => a.at - b.at
    || TIMEFRAME_MS[b.candle.timeframe] - TIMEFRAME_MS[a.candle.timeframe]
    || (a.candle.symbol < b.candle.symbol ? -1 : 1));
  let next = 0;
  const nextTickAfter = (t) => Math.floor((t - TICK_OFFSET_MS) / TICK_MS) * TICK_MS + TICK_MS + TICK_OFFSET_MS;
  const deliver = (candle, x, now) => {
    if (!skip(candle)) hub.broadcast(klineEvent(candle, x, now));
  };

  return {
    async runUntil(target) {
      for (;;) {
        const now = timers.clock();
        // Pesan yang jatuh tempo saat tidak ada penerima (mis. worker mati) hilang.
        while (next < closes.length && closes[next].at <= now) next += 1;
        const closeAt = next < closes.length ? closes[next].at : Infinity;
        const tickAt = nextTickAfter(now);
        const step = Math.min(closeAt, tickAt);
        if (step > target) break;
        await timers.advance(step - now);
        if (step === closeAt) {
          while (next < closes.length && closes[next].at === step) deliver(closes[next++].candle, true, step);
        } else {
          for (const list of market.values()) {
            const c = list.find((k) => k.openTime <= step && step <= k.closeTime);
            if (c) deliver(partialCandle(c, step), false, step);
          }
        }
        await flush();
      }
      await timers.advance(target - timers.clock());
    },
  };
}

// ---------- perakitan worker (worker/assemble.js, dipakai juga oleh worker/index.js) ----------

const cleanups = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()();
});

function createLogger() {
  const entries = [];
  const at = (level) => (fields, msg) => { entries.push({ level, fields, msg }); };
  return { logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }, entries };
}
const problems = (entries) => entries.filter((e) => e.level === 'warn' || e.level === 'error').map((e) => e.msg);

// Default: tidak ada rate limit / retry yang diharapkan; tidur berarti ada yang salah.
const unexpectedSleep = async (ms) => { throw new Error(`klien REST menunggu ${ms} ms (tidak diharapkan)`); };

async function createWorker({ timers, db, binance, settings, settleMs = 0, restSleep = unexpectedSleep, scannerOptions = {} }) {
  const { logger, entries: logs } = createLogger();
  const hub = createFakeWebSocketHub();
  const alerts = [];
  const analysed = [];
  const saves = [];
  const settles = [];
  const stopped = [];
  // Perakitan PRODUKSI (worker/assemble.js, sama dengan worker/index.js): jam server (offset terukur dari
  // /fapi/v1/time) dipakai repositori, klien REST, dan scanner. Yang diinjeksi hanya I/O: jam lokal palsu,
  // timer palsu, fetch & WebSocket palsu, jitter deterministik.
  const { repos, rest, pipeline, scanner, serverClock } = assembleWorker({
    db,
    logger,
    clock: timers.clock,
    fetch: binance.fetch,
    restSleep,
    restRandom: () => 0.5,
    streamFactory: (opts) => createKlineStream({
      ...opts,
      WebSocketImpl: hub.FakeWebSocket,
      clock: timers.clock,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      random: () => 0.5,
    }),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    scannerOptions,
    settleMs,
    pipelineSleep: (ms) => new Promise((resolve) => {
      settles.push({ at: timers.clock(), ms });
      timers.setTimer(resolve, ms);
    }),
    onAlert: (alert) => alerts.push(alert),
    onAnalysed: ({ result, ...series }) => analysed.push({ ...series, result }),
    onMonitoringStopped: (e) => stopped.push(e),
  });
  // Repositori sinyal asli; save() hanya diamati agar snapshot per candle dapat dibandingkan dengan replay.
  const save = repos.signals.save;
  repos.signals.save = async (args) => {
    saves.push(args);
    return save.call(repos.signals, args);
  };
  if (settings && !(await repos.settings.get(SCANNER_SETTINGS_KEY))) {
    const saved = await repos.settings.save(SCANNER_SETTINGS_KEY, normalizeScannerSettings(settings), {
      expectedVersion: 0, userId: null, now: timers.clock(),
    });
    if (!saved) throw new Error('gagal menyimpan pengaturan scanner');
  }
  await pipeline.ensureDefinitions();
  cleanups.push(() => scanner.stop());
  return { repos, rest, hub, scanner, pipeline, alerts, analysed, saves, settles, logs, serverClock, stopped };
}

/** `serverSkewMs`: jam server Binance palsu berada sekian ms di depan jam lokal worker (negatif = di belakang). */
async function setup({ settings, configure, skip, delayOf, market = MARKET, settleMs, restSleep, serverSkewMs = 0, scannerOptions } = {}) {
  const timers = createFakeTimers(START);
  const db = openDatabase(':memory:');
  cleanups.push(() => db.close());
  migrate(db);
  const binance = createFakeBinance({ clock: () => timers.clock() + serverSkewMs, market });
  configure?.(binance);
  const worker = await createWorker({
    timers, db, binance, settings, settleMs, restSleep: restSleep?.(timers), scannerOptions,
  });
  const driver = createMarketDriver({ timers, hub: worker.hub, from: START, market, skip, delayOf });
  return { timers, db, binance, driver, ...worker };
}

const withSettings = ({ symbols, refresh, liquidity } = {}) => ({
  ...DEFAULT_SCANNER_SETTINGS,
  symbols: { ...DEFAULT_SCANNER_SETTINGS.symbols, ...symbols },
  refresh: { ...DEFAULT_SCANNER_SETTINGS.refresh, ...refresh },
  liquidity: { ...DEFAULT_SCANNER_SETTINGS.liquidity, ...liquidity },
});
// Ambang likuiditas default yang ikut dikirim scanner bersama ukuran likuiditas (liquidityOf).
const DEFAULT_THRESHOLDS = DEFAULT_SCANNER_SETTINGS.liquidity;

// ---------- acuan "live = replay" ----------

const LIQ_SA = { quoteVolume24h: 900_000_000, spreadBps: spreadOf('99.9900', '100.0000') };

/**
 * Replay murni `analyzeAt` candle demi candle atas data sintetis yang sama dengan yang dilayani jaringan
 * palsu. `prev` = sinyal terbuka (seperti signals.getOpen); langkah "disimpan" mengikuti aturan pipeline.
 */
function referenceReplay(symbol, liquidity, { market = MARKET, timeframe = '5m', from = BOOT, to = LAST, params } = {}) {
  const ms = TIMEFRAME_MS[timeframe];
  const all = market.get(seriesKey(symbol, '5m'));
  const steps = [];
  let open = null;
  // `i` = candle `timeframe` ke-i sejak T0; hanya candle yang sudah tertutup pada closeTime-nya yang terlihat.
  for (let i = from; i <= to; i += 1) {
    const m5 = all.filter((c) => c.closeTime <= T0 + (i + 1) * ms - 1);
    const base = timeframe === '5m' ? m5 : aggregate(m5, timeframe);
    const candlesByTimeframe = { [timeframe]: base.slice(-ANALYSIS_LOOKBACK) };
    for (const tf of HIGHER_TIMEFRAMES[timeframe]) candlesByTimeframe[tf] = aggregate(m5, tf);
    const r = analyzeAt({ symbol, timeframe, prev: open, liquidity, candlesByTimeframe, params });
    steps.push({ index: i, saved: Boolean(r.event || open), ...r });
    open = OPEN_STATES.includes(r.next.state) ? r.next : null;
  }
  return steps;
}

/** Riwayat sinyal yang diharapkan dari replay (bentuk signals.history tanpa id). */
function expectedHistory(symbol, steps, timeframe = '5m') {
  const signals = [];
  for (const s of steps) {
    if (s.event?.fromState === 'NO_PATTERN') signals.push({ events: [], last: null });
    const current = signals.at(-1);
    if (current && s.saved) {
      current.last = s;
      if (s.event) current.events.push(s.event);
    }
  }
  return signals.reverse().map(({ events, last }) => {
    const n = last.next;
    const terminal = !OPEN_STATES.includes(n.state);
    return {
      symbol, timeframe, classification: n.classification, state: n.state, patternKey: n.patternKey,
      patternVersion: n.patternVersion, firstDetectedAt: n.firstDetectedAt, firstDetectedPrice: n.firstDetectedPrice,
      invalidationPrice: n.invalidationPrice, patternScore: n.patternScore, earlyScore: n.earlyScore, alignment: n.alignment,
      riskFlags: n.riskFlags, explanation: last.view.explanation, peakPrice: n.peakPrice, peakState: n.peakState,
      barsInState: n.barsInState, finalOutcome: terminal ? `${n.state}:${n.peakState}` : null,
      updatedAt: n.lastEvaluatedAt, closedAt: terminal ? last.event.occurredAt : null,
      events: events.map((e) => ({
        occurredAt: e.occurredAt, candleTime: e.candleTime, fromState: e.fromState, toState: e.toState, price: e.price,
        detail: { reason: e.reason, ...e.detail },
      })),
    };
  });
}

function withoutIds(history) {
  return history.map((signal) => {
    const copy = { ...signal, events: signal.events.map((e) => { const ev = { ...e }; delete ev.id; return ev; }) };
    delete copy.id;
    return copy;
  });
}

const alertView = (a) => ({ symbol: a.symbol, timeframe: a.timeframe, state: a.state, candleTime: a.event.candleTime, view: a.view });
const referenceAlerts = (symbol, steps, timeframe = '5m') => steps.filter((s) => s.alert)
  .map((s) => ({ index: s.index, symbol, timeframe, state: s.next.state, candleTime: s.event.candleTime, view: s.view }));
const dropIndex = (a) => {
  const copy = { ...a };
  delete copy.index;
  return copy;
};

/** Snapshot per candle yang disimpan pipeline (diamati di signals.save) vs langkah replay yang disimpan. */
const savedView = (args) => ({
  candleTime: args.snapshot.lastCandleTime, state: args.snapshot.state, alignment: args.snapshot.alignment,
  riskFlags: args.snapshot.riskFlags, explanation: args.explanation,
});
const referenceSaves = (steps) => steps.filter((s) => s.saved).map((s) => ({
  candleTime: s.next.lastCandleTime, state: s.next.state, alignment: s.next.alignment, riskFlags: s.next.riskFlags,
  explanation: s.view.explanation,
}));
const savesOf = (saves, symbol, timeframe = '5m') => saves.filter((s) => s.symbol === symbol && s.timeframe === timeframe).map(savedView);
// Kline final 15m/1h tiba 1 detik SETELAH kline 5m pada batas yang sama (urutan antar-stream tidak dijamin Binance).
const htfLate = (c) => (c.timeframe === '5m' ? CLOSE_DELAY_MS : CLOSE_DELAY_MS + 1_000);

/** Guard fixture: skenario SA sintetis harus membuka tepat satu sinyal EARLY_BULLISH lalu berkembang. */
function assertReferenceShape(history) {
  expect(history).toHaveLength(1);
  expect(history[0].events[0]).toMatchObject({ fromState: 'NO_PATTERN', toState: 'EARLY_BULLISH' });
  expect(history[0].events.length).toBeGreaterThanOrEqual(2);
  expect(history[0].explanation.length).toBeGreaterThan(0);
}

describe('worker end-to-end — modul asli, hanya jaringan yang palsu (data SINTETIS)', () => {
  it('INT-WRK-001 start: discovery REST → tabel symbols → bootstrap candle tertutup per simbol×timeframe → heartbeat berisi metrik & recordRun di SQLite', async () => {
    const { scanner, repos, binance, hub, db, rest, analysed, logs } = await setup();
    await scanner.start();

    // Sinkronisasi jam server lalu discovery: empat endpoint publik masing-masing sekali (waktu server lebih dulu);
    // bootstrap tepat satu request per simbol×timeframe.
    expect(binance.calls[0].path).toBe('/fapi/v1/time');
    expect(binance.calls.filter((c) => c.path !== '/fapi/v1/klines').map((c) => c.path).sort())
      .toEqual(['/fapi/v1/exchangeInfo', '/fapi/v1/ticker/24hr', '/fapi/v1/ticker/bookTicker', '/fapi/v1/time']);
    const lastClosed = { '5m': at5m(BOOT - 1), '15m': T0 + 15 * M15, '1h': T0 + 3 * H1 };
    const expectedBootstrap = [SA, DOWN].flatMap((symbol) => ['5m', '15m', '1h']
      .map((tf) => klineParams(symbol, tf, lastClosed[tf] - 499 * TIMEFRAME_MS[tf], 500)));
    expect(binance.klineCalls()).toHaveLength(6);
    expect(binance.klineCalls()).toEqual(expect.arrayContaining(expectedBootstrap));

    // Tabel symbols (repositori asli): yang lolos discovery dipantau; THINUSDT tercatat tetapi tidak dipantau;
    // kontrak delivery (nama ber-sufiks _YYMMDD) ditolak format simbol repositori dan tidak disimpan.
    expect(db.prepare(`SELECT symbol, status, contract_type, tick_size, step_size, is_monitored, monitored_since, delisted_at
      FROM symbols ORDER BY symbol`).all()).toEqual([
      { symbol: DOWN, status: 'TRADING', contract_type: 'PERPETUAL', tick_size: '0.0001', step_size: '0.1', is_monitored: 1, monitored_since: START, delisted_at: null },
      { symbol: SA, status: 'TRADING', contract_type: 'PERPETUAL', tick_size: '0.0001', step_size: '0.1', is_monitored: 1, monitored_since: START, delisted_at: null },
      { symbol: 'THINUSDT', status: 'TRADING', contract_type: 'PERPETUAL', tick_size: '0.0001', step_size: '0.1', is_monitored: 0, monitored_since: null, delisted_at: null },
    ]);
    expect(await repos.symbols.listMonitored()).toEqual([DOWN, SA]);
    // …dan tidak diam-diam: dicatat sekali (debug — kontrak delivery memang diharapkan), bukan error ingesti.
    expect(logs.filter((e) => e.msg === 'simbol exchangeInfo tidak disimpan (format simbol tidak didukung)')).toEqual([{
      level: 'debug', msg: expect.any(String),
      fields: { count: 1, symbols: ['SYNUSDT_270326'], reasons: ['symbol tidak valid (harus [A-Z0-9]{1,32})'] },
    }]);

    // Candle tertutup dari REST tersimpan persis (desimal string → float → SQLite), urut, tanpa candle berjalan.
    for (const symbol of [SA, DOWN]) {
      expect(await storedSeries(repos, symbol, '5m')).toEqual(expectedSeries(symbol, '5m', [[0, BOOT - 1, 'rest']]));
      expect(await storedSeries(repos, symbol, '15m')).toEqual(expectedSeries(symbol, '15m', [[0, 15, 'rest']]));
      expect(await storedSeries(repos, symbol, '1h')).toEqual(expectedSeries(symbol, '1h', [[0, 3, 'rest']]));
    }
    expect(count(db, 'provisional_candles')).toBe(0);

    // onboardDate dari exchangeInfo membatasi jendela perbaikan gap → tidak ada request kosong sebelum listing.
    expect(binance.klineCalls()).toHaveLength(6);

    const status = await repos.ingestion.getStatus();
    expect(status.lastRun).toEqual({ id: 1, startedAt: START, finishedAt: START, durationMs: 0, symbols: 2, candles: 136, errors: 0 });
    expect(status.recentErrors).toEqual([]);
    // Heartbeat menyimpan snapshot status() lengkap, bukan hanya field state.
    expect(status.heartbeat).toEqual({
      at: START,
      state: {
        state: 'running', lastIngestionAt: START, candleLagMs: 7_001, reconnects: 0, errors: 0, scanDurationMs: 0, queue: 0,
        symbols: 2, streams: 6, staleStreams: 0, ws: 'open', gaps: 0, duplicates: 0, clockOffsetMs: 0, clockFault: null,
      },
    });

    // Satu koneksi combined stream ke host allowlist, melanggan 2 simbol × 3 timeframe.
    expect(hub.sockets).toHaveLength(1);
    expect(hub.sockets[0].url.startsWith('wss://fstream.binance.com/stream?streams=')).toBe(true);
    expect([...hub.sockets[0].streams].sort()).toEqual([
      'dwnusdt@kline_15m', 'dwnusdt@kline_1h', 'dwnusdt@kline_5m', 'synusdt@kline_15m', 'synusdt@kline_1h', 'synusdt@kline_5m',
    ]);

    // Likuiditas hasil parse ticker/bookTicker → discovery → scanner (dipakai pipeline untuk risk flag).
    expect(scanner.liquidityOf(SA)).toEqual({
      quoteVolume24h: 900_000_000, spreadBps: expect.closeTo(LIQ_SA.spreadBps, 9), thresholds: DEFAULT_THRESHOLDS,
    });
    expect(scanner.liquidityOf('THINUSDT')).toBeNull();

    // Bootstrap = histori murni: tidak dianalisis; definisi pola sudah terdaftar.
    expect(analysed).toEqual([]);
    expect(count(db, 'signals')).toBe(0);
    expect(count(db, 'pattern_definitions')).toBe(2);
    expect(await rest.getServerTime()).toBe(START);
    expect(problems(logs)).toEqual([]);
  });

  it('INT-WRK-002 kline WS tertutup satu per satu → candle "ws" di SQLite → sinyal SA identik dengan replay murni; kline berjalan hanya ke tabel provisional', async () => {
    const { scanner, repos, binance, driver, db, analysed, alerts, logs } = await setup();
    await scanner.start();

    // Di tengah candle 5m ke-50: kline berjalan (x:false) hanya tersimpan sebagai provisional.
    await driver.runUntil(at5m(50) + 150_000);
    const running = MARKET.get(seriesKey(SA, '5m'))[50];
    expect(await repos.candles.getProvisional({ symbol: SA, timeframe: '5m' })).toEqual(partialCandle(running, at5m(50) + 130_000));
    expect((await repos.candles.getProvisional({ symbol: SA, timeframe: '15m' })).openTime).toBe(T0 + 16 * M15);
    expect((await repos.candles.getProvisional({ symbol: SA, timeframe: '1h' })).openTime).toBe(T0 + 4 * H1);
    expect(await repos.candles.getLastOpenTime({ symbol: SA, timeframe: '5m' })).toBe(at5m(49));
    expect(await repos.candles.getRange({ symbol: SA, timeframe: '5m', from: at5m(50), to: at5m(50) })).toEqual([]);

    // Kline final candle 50 → tabel kanonik (source ws); baris provisional-nya dibersihkan.
    await driver.runUntil(at5m(51) + 1_000);
    expect(await repos.candles.getProvisional({ symbol: SA, timeframe: '5m' })).toBeNull();
    expect(await repos.candles.getRange({ symbol: SA, timeframe: '5m', from: at5m(50), to: at5m(50) })).toEqual([{ ...running, source: 'ws' }]);

    await driver.runUntil(END);

    for (const symbol of [SA, DOWN]) {
      expect(await storedSeries(repos, symbol, '5m')).toEqual(expectedSeries(symbol, '5m', [[0, BOOT - 1, 'rest'], [BOOT, LAST, 'ws']]));
      expect(await storedSeries(repos, symbol, '15m')).toEqual(expectedSeries(symbol, '15m', [[0, 15, 'rest'], [16, 24, 'ws']]));
      expect(await storedSeries(repos, symbol, '1h')).toEqual(expectedSeries(symbol, '1h', [[0, 3, 'rest'], [4, 5, 'ws']]));
    }
    // Ratusan kline berjalan tidak pernah bocor ke tabel kanonik (nilai di atas = nilai final persis) dan
    // semua baris provisional sudah digantikan candle tertutup.
    expect(count(db, 'provisional_candles')).toBe(0);
    expect(binance.klineCalls()).toHaveLength(6); // WS lengkap → tidak ada backfill REST

    // Setiap candle 5m live dianalisis tepat sekali, berurutan.
    const live = analysed.filter((a) => a.symbol === SA && a.timeframe === '5m');
    expect(live.map((a) => [a.reason, a.candles.map((c) => c.openTime), a.result.evaluated]))
      .toEqual(range(BOOT, LAST).map((i) => ['live', [at5m(i)], 1]));

    // Sinyal tersimpan (event, snapshot, penjelasan, risk flag) sama persis dengan replay murni.
    const reference = referenceReplay(SA, LIQ_SA);
    const expected = expectedHistory(SA, reference);
    assertReferenceShape(expected);
    const history = await repos.signals.history({ symbol: SA, limit: 10 });
    expect(withoutIds(history)).toEqual(expected);
    const [signal] = history;
    expect(signal.riskFlags).toEqual([]); // likuiditas baik → tanpa flag
    expect(signal.explanation).toEqual(expect.arrayContaining([
      expect.objectContaining({ factor: 'PATTERN:SELECTION' }),
      expect.objectContaining({ factor: 'CONTEXT:LIQUIDITY', detail: expect.stringContaining('Quote volume 24 jam 900000000') }),
    ]));
    expect(await repos.signals.history({ symbol: DOWN, limit: 10 })).toEqual([]);
    expect(count(db, 'signals')).toBe(1); // tidak ada sinyal di 15m/1h (data kurang dari warm-up)

    // Alert: satu per transisi alert, pada candle yang sama dengan replay.
    expect(alerts.map(alertView)).toEqual(referenceAlerts(SA, reference).map(dropIndex));
    expect(alerts.map((a) => a.state)[0]).toBe('EARLY_BULLISH');

    expect(scanner.status()).toMatchObject({ state: 'running', gaps: 0, duplicates: 0, errors: 0, queue: 0, staleStreams: 0 });
    expect((await repos.ingestion.getStatus()).recentErrors).toEqual([]);
    expect(count(db, 'ingestion_runs')).toBe(3); // start + rediscovery tiap jam
    expect(problems(logs)).toEqual([]);
  });

  it('INT-WRK-003 lompatan openTime di WS → backfill REST sebelum analisis; pipeline me-replay candle backfill berurutan tanpa sinyal ganda', async () => {
    // Sweep REST berkala dibuat jarang agar gap ditutup oleh deteksi lompatan WS, bukan oleh sweep.
    const lost = (c) => c.timeframe === '5m' && c.openTime >= at5m(60) && c.openTime <= at5m(63);
    const { scanner, repos, binance, driver, db, analysed, alerts, logs } = await setup({
      settings: withSettings({ refresh: { restBackfillIntervalSec: 3600 } }),
      skip: lost,
    });
    await scanner.start();
    await driver.runUntil(END);

    // Tepat satu backfill per simbol: hanya 60..63 yang hilang. Candle WS pemicu (64) baru tutup 0,5 detik
    // sebelumnya (< margin penutupan) sehingga TIDAK diminta lewat REST — salinan final WS-nya yang dipakai.
    const backfill = binance.klineCalls().slice(6);
    expect(backfill).toHaveLength(2);
    expect(backfill).toEqual(expect.arrayContaining([klineParams(SA, '5m', at5m(60), 4), klineParams(DOWN, '5m', at5m(60), 4)]));

    // Analisis menerima candle backfill sekaligus dan berurutan, sebelum candle live berikutnya.
    const series = analysed.filter((a) => a.symbol === SA && a.timeframe === '5m');
    expect(series.map((a) => [a.reason, a.candles.map((c) => c.openTime)])).toEqual([
      ...range(BOOT, 59).map((i) => ['live', [at5m(i)]]),
      ['gap', range(60, 64).map(at5m)],
      ...range(65, LAST).map((i) => ['live', [at5m(i)]]),
    ]);
    expect(series.find((a) => a.reason === 'gap').result.evaluated).toBe(5);

    for (const symbol of [SA, DOWN]) {
      expect(await storedSeries(repos, symbol, '5m')).toEqual(expectedSeries(symbol, '5m', [
        [0, BOOT - 1, 'rest'], [BOOT, 59, 'ws'], [60, 63, 'rest'], [64, LAST, 'ws'],
      ]));
      expect(await repos.candles.findGaps({ symbol, timeframe: '5m', from: T0, to: at5m(LAST) })).toEqual([]);
    }

    // Sinyal identik dengan replay: deteksi di candle 62 (di dalam batch backfill) tersimpan sekali.
    const reference = referenceReplay(SA, LIQ_SA);
    const expected = expectedHistory(SA, reference);
    assertReferenceShape(expected);
    const history = await repos.signals.history({ symbol: SA, limit: 10 });
    expect(withoutIds(history)).toEqual(expected);
    const times = history[0].events.map((e) => e.candleTime);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(times).size).toBe(times.length);
    expect(times[0]).toBeGreaterThanOrEqual(at5m(60));
    expect(times[0]).toBeLessThan(at5m(64));
    expect(count(db, 'signals')).toBe(1);
    expect(count(db, 'signal_events')).toBe(expected[0].events.length);

    // Transisi historis di dalam replay disimpan tanpa alert; hanya candle terbaru per batch yang boleh alert.
    expect(alerts.map(alertView)).toEqual(referenceAlerts(SA, reference).filter((a) => a.index < 60 || a.index > 63).map(dropIndex));
    expect(alerts.map((a) => a.state)).not.toContain('EARLY_BULLISH');

    expect(scanner.status()).toMatchObject({ gaps: 2, duplicates: 0, errors: 0, queue: 0 });
    expect(problems(logs)).toEqual([]);
  });

  it('INT-WRK-004 stop(): tanpa timer tersisa, socket ditutup 1000, heartbeat akhir "stopped" di SQLite, tidak ada aktivitas sesudahnya', async () => {
    const { scanner, repos, binance, driver, hub, timers } = await setup();
    await scanner.start();
    await driver.runUntil(at5m(52) + 45_000);
    expect(timers.pending.size).toBeGreaterThan(0);
    const socket = hub.sockets[0];

    await scanner.stop();
    const stoppedAt = timers.clock();
    expect(timers.pending.size).toBe(0);
    expect(socket.closedWith).toEqual({ code: 1000, reason: 'stop' });
    expect(scanner.status().state).toBe('stopped');
    const { heartbeat } = await repos.ingestion.getStatus();
    expect(heartbeat).toEqual({ at: stoppedAt, state: expect.objectContaining({ state: 'stopped', ws: null, queue: 0, symbols: 2, streams: 6 }) });

    // Server tetap berjalan dua jam: tidak ada penerima, frame terlambat di socket lama diabaikan,
    // tidak ada heartbeat/rediscovery/sweep/reconnect lagi.
    const fetches = binance.calls.length;
    const lastStored = await repos.candles.getLastOpenTime({ symbol: SA, timeframe: '5m' });
    await driver.runUntil(at5m(52) + 2 * H1);
    socket.send(klineEvent(MARKET.get(seriesKey(SA, '5m'))[60], true, timers.clock()));
    await flush();
    expect(binance.calls).toHaveLength(fetches);
    expect(await repos.candles.getLastOpenTime({ symbol: SA, timeframe: '5m' })).toBe(lastStored);
    expect((await repos.ingestion.getStatus()).heartbeat.at).toBe(stoppedAt);
    expect(hub.sockets).toHaveLength(1);
    expect(timers.pending.size).toBe(0);
  });

  it('INT-WRK-005 likuiditas discovery (mode manual) mengalir ke pipeline → risk flag POOR_LIQUIDITY & WIDE_SPREAD di sinyal tersimpan', async () => {
    const { scanner, repos, driver, db, alerts, logs } = await setup({
      settings: withSettings({ symbols: { mode: 'manual', manual: [SA] } }),
      configure: (binance) => Object.assign(binance.listing.get(SA), { quoteVolume: '2500000.00', bid: '99.8000', ask: '100.2000' }),
    });
    await scanner.start();
    const liquidity = { quoteVolume24h: 2_500_000, spreadBps: spreadOf('99.8000', '100.2000') };
    expect(scanner.liquidityOf(SA)).toEqual({
      quoteVolume24h: 2_500_000, spreadBps: expect.closeTo(liquidity.spreadBps, 9), thresholds: DEFAULT_THRESHOLDS,
    });
    expect(await repos.symbols.listMonitored()).toEqual([SA]);
    expect(scanner.status()).toMatchObject({ symbols: 1, streams: 3 });

    await driver.runUntil(END);

    const reference = referenceReplay(SA, liquidity);
    const expected = expectedHistory(SA, reference);
    assertReferenceShape(expected);
    const history = await repos.signals.history({ symbol: SA, limit: 10 });
    expect(withoutIds(history)).toEqual(expected);
    const [signal] = history;
    expect(signal.riskFlags).toEqual(['POOR_LIQUIDITY', 'WIDE_SPREAD']);
    expect(signal.explanation).toEqual(expect.arrayContaining([
      expect.objectContaining({ factor: 'RISK:POOR_LIQUIDITY', detail: 'Quote volume 24 jam 2500000 < batas 50000000' }),
      expect.objectContaining({ factor: 'RISK:WIDE_SPREAD', detail: 'Spread 40 bps > batas 10 bps' }),
    ]));
    expect(alerts.map(alertView)).toEqual(referenceAlerts(SA, reference).map(dropIndex));
    expect(alerts.every((a) => a.view.riskFlags.includes('WIDE_SPREAD'))).toBe(true);
    expect(db.prepare('SELECT is_monitored FROM symbols WHERE symbol = ?').get(DOWN)).toEqual({ is_monitored: 0 });
    expect((await repos.ingestion.getStatus()).recentErrors).toEqual([]);
    expect(problems(logs)).toEqual([]);
  });

  it('INT-WRK-013 ambang likuiditas pengguna (mode manual, min 5 jt / maks 50 bps) → risk flag & penjelasan memakai batas pengguna: POOR_LIQUIDITY tetap, WIDE_SPREAD hilang', async () => {
    const user = { minQuoteVolume24h: 5_000_000, maxSpreadBps: 50 };
    const { scanner, repos, driver, alerts, logs } = await setup({
      settings: withSettings({ symbols: { mode: 'manual', manual: [SA] }, liquidity: user }),
      configure: (binance) => Object.assign(binance.listing.get(SA), { quoteVolume: '2500000.00', bid: '99.8000', ask: '100.2000' }),
    });
    await scanner.start();
    const liquidity = { quoteVolume24h: 2_500_000, spreadBps: spreadOf('99.8000', '100.2000') };
    expect(scanner.liquidityOf(SA)).toEqual({ quoteVolume24h: 2_500_000, spreadBps: expect.closeTo(liquidity.spreadBps, 9), thresholds: user });

    await driver.runUntil(END);

    // Acuan replay dengan ambang yang sama (params.view) — dan berbeda dari acuan ambang default.
    const reference = referenceReplay(SA, liquidity, { params: { view: user } });
    const expected = expectedHistory(SA, reference);
    assertReferenceShape(expected);
    expect(expectedHistory(SA, referenceReplay(SA, liquidity))[0].riskFlags).toEqual(['POOR_LIQUIDITY', 'WIDE_SPREAD']);
    const history = await repos.signals.history({ symbol: SA, limit: 10 });
    expect(withoutIds(history)).toEqual(expected);
    const [signal] = history;
    expect(signal.riskFlags).toEqual(['POOR_LIQUIDITY']);
    expect(signal.explanation).toEqual(expect.arrayContaining([
      expect.objectContaining({ factor: 'RISK:POOR_LIQUIDITY', detail: 'Quote volume 24 jam 2500000 < batas 5000000' }),
      expect.objectContaining({ factor: 'CONTEXT:LIQUIDITY', detail: 'Quote volume 24 jam 2500000 (batas 5000000), spread 40 bps (batas 50)' }),
    ]));
    expect(signal.explanation.some((e) => e.factor === 'RISK:WIDE_SPREAD')).toBe(false);
    expect(alerts.map(alertView)).toEqual(referenceAlerts(SA, reference).map(dropIndex));
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.every((a) => a.view.riskFlags.includes('POOR_LIQUIDITY') && !a.view.riskFlags.includes('WIDE_SPREAD'))).toBe(true);
    expect(problems(logs)).toEqual([]);
  });

  it('INT-WRK-006 delisting (SETTLING) saat rediscovery → repositori simbol menandai delisted, stream diganti, pesan terlambat diabaikan; listing ulang menyambung histori tanpa gap', async () => {
    const { scanner, repos, binance, driver, hub, db, logs, stopped } = await setup();
    const symbolRow = (symbol) => db.prepare('SELECT status, is_monitored, monitored_since, delisted_at FROM symbols WHERE symbol = ?').get(symbol);
    await scanner.start();
    await driver.runUntil(START + H1 - 1_000);

    binance.listing.get(DOWN).status = 'SETTLING';
    await driver.runUntil(START + H1 + 1_000);
    expect(symbolRow(DOWN)).toEqual({ status: 'SETTLING', is_monitored: 0, monitored_since: null, delisted_at: START + H1 });
    // Pelepasan pantauan dilaporkan sekali (penutupan sinyal terbuka: lihat INT-WRK-016; DWNUSDT tanpa sinyal).
    expect(stopped).toEqual([{ symbol: DOWN, timeframes: null, reason: 'SYMBOL_DELISTED', at: START + H1 }]);
    expect(symbolRow(SA)).toMatchObject({ is_monitored: 1, monitored_since: START, delisted_at: null });
    expect(await repos.symbols.listMonitored()).toEqual([SA]);
    expect(hub.sockets).toHaveLength(2);
    expect(hub.sockets[0].closedWith).toEqual({ code: 1000, reason: 'stop' });
    expect([...hub.sockets[1].streams].sort()).toEqual(['synusdt@kline_15m', 'synusdt@kline_1h', 'synusdt@kline_5m']);
    expect(scanner.status()).toMatchObject({ symbols: 1, streams: 3, state: 'running' });

    // Kline final DWNUSDT yang datang terlambat di socket lama diabaikan; di socket baru stream itu
    // tidak dilanggan → dicatat sebagai error ws, tetap tidak disimpan. Histori candle dipertahankan.
    await driver.runUntil(at5m(61) + 1_000);
    const late = klineEvent(MARKET.get(seriesKey(DOWN, '5m'))[60], true, at5m(61) + 1_000);
    hub.sockets[0].send(late);
    hub.sockets[1].send(late);
    await flush();
    expect(await repos.candles.getLastOpenTime({ symbol: DOWN, timeframe: '5m' })).toBe(at5m(59));
    expect((await repos.ingestion.getStatus()).recentErrors).toEqual([
      expect.objectContaining({ source: 'ws', message: 'unexpected: stream tidak dilanggan: dwnusdt@kline_5m' }),
    ]);

    // Listing ulang: delisted_at dibersihkan, dipantau lagi, bootstrap menyambung dari candle tersimpan terakhir.
    await driver.runUntil(START + 2 * H1 - 1_000);
    expect(await storedSeries(repos, DOWN, '5m')).toHaveLength(60);
    binance.listing.get(DOWN).status = 'TRADING';
    const mark = binance.klineCalls().length;
    await driver.runUntil(START + 2 * H1 + 1_000);
    expect(symbolRow(DOWN)).toEqual({ status: 'TRADING', is_monitored: 1, monitored_since: START + 2 * H1, delisted_at: null });
    expect(await repos.symbols.listMonitored()).toEqual([DOWN, SA]);
    expect(binance.klineCalls().slice(mark)).toEqual([
      klineParams(DOWN, '5m', at5m(60), 12),
      klineParams(DOWN, '15m', T0 + 20 * M15, 4),
      klineParams(DOWN, '1h', T0 + 5 * H1, 1),
    ]);
    expect(hub.sockets).toHaveLength(3);
    expect(hub.sockets[2].streams).toHaveLength(6);

    await driver.runUntil(END);
    expect(await storedSeries(repos, DOWN, '5m')).toEqual(expectedSeries(DOWN, '5m', [
      [0, BOOT - 1, 'rest'], [BOOT, 59, 'ws'], [60, 71, 'rest'], [72, LAST, 'ws'],
    ]));
    expect(await repos.candles.findGaps({ symbol: DOWN, timeframe: '5m', from: T0, to: at5m(LAST) })).toEqual([]);
    expect(db.prepare('SELECT symbols, candles FROM ingestion_runs ORDER BY id').all())
      .toEqual([{ symbols: 2, candles: 136 }, { symbols: 1, candles: 0 }, { symbols: 2, candles: 17 }]);

    // Sinyal simbol lain tidak terganggu oleh pergantian stream.
    expect(withoutIds(await repos.signals.history({ symbol: SA, limit: 10 }))).toEqual(expectedHistory(SA, referenceReplay(SA, LIQ_SA)));
    expect(await repos.signals.history({ symbol: DOWN, limit: 10 })).toEqual([]);
    expect(stopped).toHaveLength(1); // listing ulang tidak melaporkan pelepasan
    expect(problems(logs)).toEqual(['simbol delisted, stream dihentikan', 'galat scanner']);
  });

  it('INT-WRK-016 delisting simbol dengan sinyal terbuka (SA, EARLY_BULLISH) → sinyal EXPIRED reason SYMBOL_DELISTED tanpa alert & hilang dari screener; listing ulang → replay membuka sinyal BARU, identik dengan replay murni sejak candle 64', async () => {
    const REDISCOVERY = 20 * 60_000; // rediscovery tiap 4 candle 5m: siklus di candle 52, 56, 60, 64, 68, 72, 76
    const { scanner, repos, binance, driver, db, alerts, stopped, logs } = await setup({ scannerOptions: { rediscoveryMs: REDISCOVERY } });
    await scanner.start();
    const delistAt = START + 4 * REDISCOVERY; // = candle 64 + 7 dtk; candle 63 sudah tertutup & dianalisis
    await driver.runUntil(delistAt - 1_000);
    const [opened] = await repos.signals.history({ symbol: SA, limit: 10 });
    expect(opened).toMatchObject({ state: 'EARLY_BULLISH', closedAt: null });
    expect((await repos.signals.listActive()).map((s) => s.symbol)).toEqual([SA]);
    const alertsBefore = alerts.length;

    binance.listing.get(SA).status = 'SETTLING';
    await driver.runUntil(delistAt + 1_000);
    expect(stopped).toEqual([{ symbol: SA, timeframes: null, reason: 'SYMBOL_DELISTED', at: delistAt }]);
    expect(await repos.signals.listActive()).toEqual([]);
    expect(await repos.signals.getOpen({ symbol: SA, timeframe: '5m' })).toBeNull();
    expect(alerts.length).toBe(alertsBefore); // penutupan karena delisting tidak di-alert

    // Sinyal pertama = replay murni candle 48..63, lalu ditutup dengan event SYMBOL_DELISTED.
    const first = expectedHistory(SA, referenceReplay(SA, LIQ_SA, { to: 63 }));
    expect(first).toHaveLength(1);
    const last63 = MARKET.get(seriesKey(SA, '5m'))[63];
    const [closed] = withoutIds(await repos.signals.history({ symbol: SA, limit: 10 }));
    expect(closed).toEqual({
      ...first[0], state: 'EXPIRED', finalOutcome: 'EXPIRED:EARLY_BULLISH', updatedAt: delistAt, closedAt: delistAt,
      events: [...first[0].events, {
        occurredAt: delistAt, candleTime: at5m(63), fromState: 'EARLY_BULLISH', toState: 'EXPIRED', price: last63.close,
        detail: {
          reason: 'SYMBOL_DELISTED', barsInPrevState: first[0].barsInState, firstDetectedPrice: first[0].firstDetectedPrice,
          invalidationPrice: first[0].invalidationPrice, priceCandleTime: at5m(63),
        },
      }],
    });

    // Listing ulang: bootstrap 64..67 (histori, tanpa analisis); candle live 68 me-replay 64..68 dengan prev
    // null → sinyal BARU terbuka di candle 66 (pola SA terdeteksi lagi), bukan melanjutkan sinyal lama.
    const relistAt = START + 5 * REDISCOVERY;
    await driver.runUntil(relistAt - 1_000);
    binance.listing.get(SA).status = 'TRADING';
    await driver.runUntil(END);
    expect(await storedSeries(repos, SA, '5m')).toEqual(expectedSeries(SA, '5m', [
      [0, BOOT - 1, 'rest'], [BOOT, 63, 'ws'], [64, 67, 'rest'], [68, LAST, 'ws'],
    ]));
    const second = referenceReplay(SA, LIQ_SA, { from: 64, to: LAST });
    const expectedSecond = expectedHistory(SA, second);
    expect(expectedSecond).toHaveLength(1);
    expect(expectedSecond[0].events[0]).toMatchObject({ fromState: 'NO_PATTERN', candleTime: at5m(66) });
    const history = withoutIds(await repos.signals.history({ symbol: SA, limit: 10 }));
    expect(history).toEqual([...expectedSecond, closed]);
    expect(count(db, 'signals')).toBe(2);
    expect((await repos.signals.listActive()).map((s) => s.firstDetectedAt)).toEqual([at5m(67) - 1]);
    // Alert sinyal baru hanya untuk candle terbaru per batch (candle 64..67 di-replay tanpa alert).
    expect(alerts.slice(alertsBefore).map(alertView)).toEqual(referenceAlerts(SA, second).filter((a) => a.index >= 68).map(dropIndex));
    expect(stopped).toHaveLength(1);
    expect((await repos.ingestion.getStatus()).recentErrors).toEqual([]);
    expect(problems(logs)).toEqual(['simbol delisted, stream dihentikan']);
  });

  it('INT-WRK-026 rediscovery menerima exchangeInfo tanpa simbol (respons anomali) saat SA punya sinyal terbuka → 0 simbol terpilih dianggap anomali: tidak ada delisting/penutupan sinyal, stream tetap, error "discovery"; percobaan ulang normal → hasil akhir = replay murni seolah tidak terjadi apa-apa', async () => {
    const REDISCOVERY = 20 * 60_000;
    let emptyInfo = false;
    const { scanner, repos, driver, alerts, stopped, logs, hub } = await setup({
      scannerOptions: { rediscoveryMs: REDISCOVERY },
      configure: (b) => {
        const fetch = b.fetch;
        b.fetch = async (href, init) => {
          const res = await fetch(href, init);
          if (!emptyInfo || new URL(href).pathname !== '/fapi/v1/exchangeInfo') return res;
          return new Response(JSON.stringify({ ...(await res.json()), symbols: [] }), { status: 200 });
        };
      },
    });
    await scanner.start();
    const anomalyAt = START + 4 * REDISCOVERY; // candle 64 + 7 dtk; sinyal SA sudah terbuka
    await driver.runUntil(anomalyAt - 1_000);
    expect((await repos.signals.listActive()).map((s) => s.symbol)).toEqual([SA]);
    const sockets = hub.sockets.length;

    emptyInfo = true;
    await driver.runUntil(anomalyAt + 1_000);
    emptyInfo = false;
    expect(stopped).toEqual([]);
    expect((await repos.signals.listActive()).map((s) => s.symbol)).toEqual([SA]);
    expect((await repos.symbols.listMonitored()).sort()).toEqual([DOWN, SA]);
    expect(hub.sockets).toHaveLength(sockets); // stream tidak diganti
    expect(scanner.status()).toMatchObject({ symbols: 2, streams: 6, state: 'running' });
    expect((await repos.ingestion.getStatus()).recentErrors).toEqual([expect.objectContaining({
      at: anomalyAt, source: 'discovery', message: expect.stringContaining('discovery anomali: 0 simbol terpilih (mode auto) padahal 2 simbol'),
    })]);

    await driver.runUntil(END); // percobaan ulang discovery 60 dtk kemudian berhasil
    const reference = referenceReplay(SA, LIQ_SA);
    expect(withoutIds(await repos.signals.history({ symbol: SA, limit: 10 }))).toEqual(expectedHistory(SA, reference));
    expect(alerts.map(alertView)).toEqual(referenceAlerts(SA, reference).map(dropIndex));
    expect(stopped).toEqual([]);
    expect((await repos.ingestion.getStatus()).recentErrors).toHaveLength(1);
    expect(problems(logs)).toEqual(['discovery memilih 0 simbol padahal set pantauan tidak kosong; set pantauan dipertahankan', 'galat scanner']);
  });

  it('INT-WRK-027 mode manual [SYNUSDT] dengan sinyal SA terbuka, simbol menjadi SETTLING → 0 simbol terpilih dijelaskan exchangeInfo (bukan anomali): simbol delisted, stream dilepas, sinyal EXPIRED reason SYMBOL_DELISTED tersimpan; tanpa error "discovery"', async () => {
    const REDISCOVERY = 20 * 60_000;
    const { scanner, repos, binance, driver, hub, stopped, logs } = await setup({
      settings: withSettings({ symbols: { mode: 'manual', manual: [SA] } }),
      scannerOptions: { rediscoveryMs: REDISCOVERY },
    });
    await scanner.start();
    const delistAt = START + 4 * REDISCOVERY;
    await driver.runUntil(delistAt - 1_000);
    expect((await repos.signals.listActive()).map((s) => s.symbol)).toEqual([SA]);
    expect(scanner.status()).toMatchObject({ symbols: 1, streams: 3 });

    binance.listing.get(SA).status = 'SETTLING';
    await driver.runUntil(delistAt + 1_000);
    expect(stopped).toEqual([{ symbol: SA, timeframes: null, reason: 'SYMBOL_DELISTED', at: delistAt }]);
    expect(await repos.signals.listActive()).toEqual([]);
    const [closed] = await repos.signals.history({ symbol: SA, limit: 10 });
    expect(closed).toMatchObject({ state: 'EXPIRED', closedAt: delistAt });
    expect(closed.events.at(-1)).toMatchObject({ toState: 'EXPIRED', occurredAt: delistAt, detail: expect.objectContaining({ reason: 'SYMBOL_DELISTED' }) });
    expect(await repos.symbols.listMonitored()).toEqual([]);
    expect(scanner.status()).toMatchObject({ symbols: 0, streams: 0 });
    expect(hub.sockets.every((s) => s.readyState === 3)).toBe(true);

    await driver.runUntil(END);
    expect(stopped).toHaveLength(1);
    expect((await repos.ingestion.getStatus()).recentErrors).toEqual([]);
    expect(problems(logs)).toEqual(['simbol delisted, stream dihentikan']);
  });

  it('INT-WRK-021 penutupan sinyal simbol delisted gagal sekali (SQLITE_BUSY) → error "monitoring" tercatat, sinyal masih terbuka; rediscovery berikutnya mencoba lagi (level-triggered) → EXPIRED reason SYMBOL_DELISTED', async () => {
    const REDISCOVERY = 20 * 60_000;
    const { scanner, repos, binance, driver, stopped, alerts } = await setup({ scannerOptions: { rediscoveryMs: REDISCOVERY } });
    await scanner.start();
    const delistAt = START + 4 * REDISCOVERY;
    await driver.runUntil(delistAt - 1_000);
    expect((await repos.signals.listActive()).map((s) => [s.symbol, s.timeframe, s.state])).toEqual([[SA, '5m', 'EARLY_BULLISH']]);
    const alertsBefore = alerts.length;

    const close = repos.signals.closeOpenForSymbol;
    let busy = 1;
    repos.signals.closeOpenForSymbol = async (args) => {
      if (busy > 0) {
        busy -= 1;
        throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      }
      return close.call(repos.signals, args);
    };
    binance.listing.get(SA).status = 'SETTLING';
    await driver.runUntil(delistAt + 1_000);
    expect(stopped).toEqual([{ symbol: SA, timeframes: null, reason: 'SYMBOL_DELISTED', at: delistAt }]);
    expect((await repos.signals.listActive()).map((s) => s.symbol)).toEqual([SA]);
    expect((await repos.ingestion.getStatus()).recentErrors).toEqual([
      expect.objectContaining({ at: delistAt, source: 'monitoring', message: 'database is locked' }),
    ]);

    await driver.runUntil(delistAt + REDISCOVERY + 1_000);
    expect(stopped).toEqual([
      { symbol: SA, timeframes: null, reason: 'SYMBOL_DELISTED', at: delistAt },
      { symbol: SA, timeframes: null, reason: 'SYMBOL_DELISTED', at: delistAt + REDISCOVERY },
    ]);
    expect(await repos.signals.listActive()).toEqual([]);
    const [closed] = await repos.signals.history({ symbol: SA, limit: 10 });
    expect(closed).toMatchObject({ state: 'EXPIRED', finalOutcome: 'EXPIRED:EARLY_BULLISH', closedAt: delistAt + REDISCOVERY });
    expect(closed.events.at(-1)).toMatchObject({ toState: 'EXPIRED', candleTime: at5m(63), detail: { reason: 'SYMBOL_DELISTED' } });
    expect(alerts.length).toBe(alertsBefore);

    // Sudah tertutup → rediscovery berikutnya tidak melaporkan lagi.
    await driver.runUntil(delistAt + 2 * REDISCOVERY + 1_000);
    expect(stopped).toHaveLength(2);
  });

  it('INT-WRK-022 restart di atas database dengan sinyal yatim (simbol is_monitored=0 — DB lama / stop() di tengah siklus) yang kini SETTLING → start pertama menutupnya EXPIRED SYMBOL_DELISTED; simbol lain tidak tersentuh', async () => {
    const ctx = await setup();
    const { timers, db, binance } = ctx;
    await ctx.scanner.start();
    await ctx.driver.runUntil(at5m(65) + 1_000);
    expect((await ctx.repos.signals.listActive()).map((s) => [s.symbol, s.state])).toEqual([[SA, 'EARLY_BULLISH']]);
    await ctx.scanner.stop();
    // Status pantauan sudah dilepas di DB tanpa sinyal ditutup (mis. DB sebelum perbaikan ini).
    db.prepare('UPDATE symbols SET is_monitored = 0 WHERE symbol = ?').run(SA);
    binance.listing.get(SA).status = 'SETTLING';

    const restartAt = at5m(69) + 7_000;
    await timers.advance(restartAt - timers.clock());
    const b = await createWorker({ timers, db, binance });
    await b.scanner.start();
    expect(b.stopped).toEqual([{ symbol: SA, timeframes: null, reason: 'SYMBOL_DELISTED', at: restartAt }]);
    expect(await b.repos.signals.listActive()).toEqual([]);
    const [closed] = await b.repos.signals.history({ symbol: SA, limit: 10 });
    expect(closed).toMatchObject({ state: 'EXPIRED', closedAt: restartAt });
    expect(closed.events.at(-1).detail.reason).toBe('SYMBOL_DELISTED');
    expect(b.scanner.status()).toMatchObject({ symbols: 1, streams: 3 });
    expect((await b.repos.ingestion.getStatus()).recentErrors).toEqual([]);
  });

  it('INT-WRK-007 restart worker di atas database yang sama: bootstrap hanya mengambil candle setelah lastOpenTime, sinyal terbuka dilanjutkan tanpa sinyal/event ganda', async () => {
    const ctx = await setup();
    const { timers, db, binance } = ctx;
    await ctx.scanner.start();
    await ctx.driver.runUntil(at5m(65) + 1_000); // candle 64 sudah tertutup & dianalisis
    const [opened] = await ctx.repos.signals.history({ symbol: SA, limit: 10 });
    expect(opened.events).toHaveLength(1);
    await ctx.scanner.stop();

    // Worker mati 20 menit: candle 65..68 tertutup tanpa penerima.
    const restartAt = at5m(69) + 7_000;
    await timers.advance(restartAt - timers.clock());
    const b = await createWorker({ timers, db, binance });
    const driverB = createMarketDriver({ timers, hub: b.hub, from: restartAt });
    const mark = binance.klineCalls().length;
    await b.scanner.start();

    const restarted = binance.klineCalls().slice(mark);
    expect(restarted).toHaveLength(4);
    expect(restarted).toEqual(expect.arrayContaining([
      klineParams(SA, '5m', at5m(65), 4), klineParams(DOWN, '5m', at5m(65), 4),
      klineParams(SA, '15m', T0 + 21 * M15, 2), klineParams(DOWN, '15m', T0 + 21 * M15, 2),
    ]));
    expect(b.analysed).toEqual([]);
    // Run ke-3: start + rediscovery worker pertama, lalu start worker kedua.
    expect((await b.repos.ingestion.getStatus()).lastRun).toMatchObject({ id: 3, startedAt: restartAt, symbols: 2, candles: 12, errors: 0 });

    await driverB.runUntil(END);
    // Candle live pertama setelah restart me-replay dari event terakhir (62) — 63/64 sudah dievaluasi → no-op.
    const first = b.analysed.find((a) => a.symbol === SA && a.timeframe === '5m');
    expect(first).toMatchObject({ reason: 'live', candles: [expect.objectContaining({ openTime: at5m(69) })] });
    expect(first.result.evaluated).toBe(69 - 62);

    expect(await storedSeries(b.repos, SA, '5m')).toEqual(expectedSeries(SA, '5m', [
      [0, BOOT - 1, 'rest'], [BOOT, 64, 'ws'], [65, 68, 'rest'], [69, LAST, 'ws'],
    ]));
    const reference = referenceReplay(SA, LIQ_SA);
    const expected = expectedHistory(SA, reference);
    assertReferenceShape(expected);
    expect(withoutIds(await b.repos.signals.history({ symbol: SA, limit: 10 }))).toEqual(expected);
    expect(count(db, 'signals')).toBe(1);
    expect(count(db, 'signal_events')).toBe(expected[0].events.length);

    // Alert hanya untuk candle terbaru: transisi yang terjadi selama worker mati di-replay dan disimpan tanpa alert.
    const refAlerts = referenceAlerts(SA, reference);
    expect(ctx.alerts.map(alertView)).toEqual(refAlerts.filter((a) => a.index <= 64).map(dropIndex));
    expect(b.alerts.map(alertView)).toEqual(refAlerts.filter((a) => a.index >= 69).map(dropIndex));
    expect((await b.repos.ingestion.getStatus()).heartbeat.state).toMatchObject({ state: 'running', symbols: 2, streams: 6 });
    expect(problems(b.logs)).toEqual([]);
  });

  it('INT-WRK-008 kline final tiba 200 ms sebelum closeTime menurut jam worker (jam tertinggal ≤ toleransi WS 2 d) → bendera x bursa dipercaya: langsung disimpan & dianalisis "live", tanpa error validasi dan tanpa backfill gap', async () => {
    const skewed = (c) => c.symbol === SA && c.timeframe === '5m' && c.openTime === at5m(61);
    const { scanner, repos, binance, driver, analysed, alerts, logs } = await setup({
      delayOf: (c) => (skewed(c) ? -200 : CLOSE_DELAY_MS),
    });
    await scanner.start();
    await driver.runUntil(END);

    expect((await repos.ingestion.getStatus()).recentErrors).toEqual([]);
    expect(binance.klineCalls()).toHaveLength(6); // hanya bootstrap
    const series = analysed.filter((a) => a.symbol === SA && a.timeframe === '5m');
    expect(series.map((a) => [a.reason, a.candles.map((c) => c.openTime)])).toEqual(range(BOOT, LAST).map((i) => ['live', [at5m(i)]]));
    expect(await storedSeries(repos, SA, '5m')).toEqual(expectedSeries(SA, '5m', [[0, BOOT - 1, 'rest'], [BOOT, LAST, 'ws']]));

    const reference = referenceReplay(SA, LIQ_SA);
    expect(withoutIds(await repos.signals.history({ symbol: SA, limit: 10 }))).toEqual(expectedHistory(SA, reference));
    expect(alerts.map(alertView)).toEqual(referenceAlerts(SA, reference).map(dropIndex));
    expect(scanner.status()).toMatchObject({ gaps: 0, errors: 0 });
    expect(problems(logs)).toEqual([]);
  });

  it('INT-WRK-023 kline final tiba 2,5 d sebelum closeTime menurut jam worker (melebihi toleransi WS 2 d — jam rusak) → ditolak validasi, dicatat, lalu dipulihkan backfill gap tanpa mengubah sinyal', async () => {
    const skewed = (c) => c.symbol === SA && c.timeframe === '5m' && c.openTime === at5m(61);
    const { scanner, repos, binance, driver, analysed, alerts, logs } = await setup({
      delayOf: (c) => (skewed(c) ? -2_500 : CLOSE_DELAY_MS),
    });
    await scanner.start();
    await driver.runUntil(END);

    expect((await repos.ingestion.getStatus()).recentErrors).toEqual([{
      id: expect.any(Number), at: at5m(62) - 2_500, source: 'validation',
      message: `${SA} 5m: 1 candle ditolak: candle ditandai tertutup sebelum closeTime terlewati`,
    }]);
    // Kline final #62 memicu gap: REST mengambil #61 saja (#62 baru tutup 0,5 d < margin → salinan WS).
    expect(binance.klineCalls().slice(6)).toEqual([klineParams(SA, '5m', at5m(61), 1)]);
    const series = analysed.filter((a) => a.symbol === SA && a.timeframe === '5m');
    expect(series.map((a) => [a.reason, a.candles.map((c) => c.openTime)])).toEqual([
      ...range(BOOT, 60).map((i) => ['live', [at5m(i)]]),
      ['gap', [at5m(61), at5m(62)]],
      ...range(63, LAST).map((i) => ['live', [at5m(i)]]),
    ]);
    expect(await storedSeries(repos, SA, '5m')).toEqual(expectedSeries(SA, '5m', [
      [0, BOOT - 1, 'rest'], [BOOT, 60, 'ws'], [61, 61, 'rest'], [62, LAST, 'ws'],
    ]));

    const reference = referenceReplay(SA, LIQ_SA);
    expect(withoutIds(await repos.signals.history({ symbol: SA, limit: 10 }))).toEqual(expectedHistory(SA, reference));
    // Candle deteksi (62) adalah candle terbaru di batch → alert tetap terkirim.
    expect(alerts.map(alertView)).toEqual(referenceAlerts(SA, reference).map(dropIndex));
    expect(scanner.status()).toMatchObject({ gaps: 1, errors: 1 });
    expect(problems(logs)).toEqual(['galat scanner']);
  });

  it('INT-WRK-014 jam server 1 detik di depan jam lokal: sync /fapi/v1/time → offset +1000; kline final yang tiba 500 ms sebelum closeTime menurut jam lokal langsung diterima (tanpa error validasi & tanpa backfill gap)', async () => {
    const SKEW = 1_000;
    // Binance mengirim kline final 0,5 detik setelah candle tutup menurut jam SERVER = 0,5 detik sebelum jam lokal.
    const { scanner, repos, binance, driver, analysed, alerts, logs, serverClock } = await setup({
      serverSkewMs: SKEW, delayOf: () => CLOSE_DELAY_MS - SKEW,
    });
    await scanner.start();
    expect(serverClock.offsetMs()).toBe(SKEW);
    expect(scanner.status()).toMatchObject({ clockOffsetMs: SKEW, errors: 0 });
    // Stempel run = jam lokal host (dibandingkan API dengan jamnya sendiri), bukan waktu server.
    expect((await repos.ingestion.getStatus()).lastRun).toMatchObject({ startedAt: START, errors: 0 });

    await driver.runUntil(END);

    expect((await repos.ingestion.getStatus()).recentErrors).toEqual([]);
    expect(binance.klineCalls()).toHaveLength(6); // hanya bootstrap: tidak ada backfill gap
    // /fapi/v1/time dipanggil di start dan tiap rediscovery (2 jam → 2 kali), selalu sebelum exchangeInfo.
    const paths = binance.calls.map((c) => c.path).filter((p) => p === '/fapi/v1/time' || p === '/fapi/v1/exchangeInfo');
    expect(paths).toEqual(['/fapi/v1/time', '/fapi/v1/exchangeInfo', '/fapi/v1/time', '/fapi/v1/exchangeInfo', '/fapi/v1/time', '/fapi/v1/exchangeInfo']);
    const series = analysed.filter((a) => a.symbol === SA && a.timeframe === '5m');
    expect(series.map((a) => [a.reason, a.candles.map((c) => c.openTime)])).toEqual(range(BOOT, LAST).map((i) => ['live', [at5m(i)]]));
    for (const symbol of [SA, DOWN]) {
      expect(await storedSeries(repos, symbol, '5m')).toEqual(expectedSeries(symbol, '5m', [[0, BOOT - 1, 'rest'], [BOOT, LAST, 'ws']]));
      expect(await storedSeries(repos, symbol, '1h')).toEqual(expectedSeries(symbol, '1h', [[0, 3, 'rest'], [4, 5, 'ws']]));
    }

    const reference = referenceReplay(SA, LIQ_SA);
    expect(withoutIds(await repos.signals.history({ symbol: SA, limit: 10 }))).toEqual(expectedHistory(SA, reference));
    expect(alerts.map(alertView)).toEqual(referenceAlerts(SA, reference).map(dropIndex));
    expect(scanner.status()).toMatchObject({ gaps: 0, errors: 0, clockOffsetMs: SKEW, state: 'running' });
    expect((await repos.ingestion.getStatus()).heartbeat.state.clockOffsetMs).toBe(SKEW);
    expect(problems(logs)).toEqual([]);
  });

  it('INT-WRK-015 /fapi/v1/time gagal (HTTP 400) saat start → worker tetap bootstrap dengan offset 0, error ingesti "clock" tercatat; rediscovery berikutnya menyinkronkan ulang', async () => {
    let failTime = true;
    const { scanner, repos, binance, driver, serverClock, logs } = await setup({
      serverSkewMs: 300,
      configure: (b) => {
        const fetch = b.fetch;
        b.fetch = async (href, init) => (failTime && new URL(href).pathname === '/fapi/v1/time'
          ? new Response(JSON.stringify({ code: -1100, msg: 'Illegal characters found in a parameter.' }), { status: 400 })
          : fetch(href, init));
      },
    });
    await scanner.start();
    expect(serverClock.offsetMs()).toBe(0);
    expect(scanner.status()).toMatchObject({ state: 'running', symbols: 2, streams: 6, clockOffsetMs: 0, errors: 1 });
    expect((await repos.ingestion.getStatus()).recentErrors).toEqual([expect.objectContaining({
      source: 'clock', message: 'sinkronisasi jam server gagal: Binance /fapi/v1/time gagal: HTTP 400 — Illegal characters found in a parameter.',
    })]);
    expect(binance.klineCalls()).toHaveLength(6);

    failTime = false;
    await driver.runUntil(START + H1 + 1_000);
    expect(serverClock.offsetMs()).toBe(300);
    expect(scanner.status().clockOffsetMs).toBe(300);
    expect(problems(logs)).toEqual(['sinkronisasi jam server gagal, offset terakhir dipakai', 'galat scanner']);
  });

  it('INT-WRK-024 /fapi/v1/time melaporkan jam 11 menit di depan (melebihi batas ±10 menit, OFFSET_OUT_OF_RANGE) → offset tidak diterapkan, worker tetap ingest tetapi heartbeat "degraded" + clockFault, error ingesti "clock" tercatat; sync normal berikutnya → "running" lagi', async () => {
    let lie = 11 * 60_000;
    const { scanner, repos, driver, serverClock, logs } = await setup({
      configure: (b) => {
        const fetch = b.fetch;
        b.fetch = async (href, init) => {
          if (new URL(href).pathname !== '/fapi/v1/time') return fetch(href, init);
          const res = await fetch(href, init);
          const body = await res.json();
          return new Response(JSON.stringify({ serverTime: body.serverTime + lie }), { status: 200 });
        };
      },
    });
    await scanner.start();
    expect(serverClock.offsetMs()).toBe(0);
    expect(scanner.status()).toMatchObject({ state: 'degraded', clockFault: 'OFFSET_OUT_OF_RANGE', ws: 'open', symbols: 2, streams: 6 });
    const status = await repos.ingestion.getStatus();
    expect(status.heartbeat.state).toMatchObject({ state: 'degraded', clockFault: 'OFFSET_OUT_OF_RANGE' });
    expect(status.recentErrors).toEqual([expect.objectContaining({
      source: 'clock', message: expect.stringContaining('melebihi batas ±600000 ms'),
    })]);
    expect(problems(logs)).toContain('jam host menyimpang dari waktu server Binance melebihi batas; worker degraded (periksa NTP host)');

    lie = 0;
    await driver.runUntil(START + H1 + 1_000);
    expect(scanner.status()).toMatchObject({ state: 'running', clockFault: null });
    expect((await repos.ingestion.getStatus()).heartbeat.state).toMatchObject({ state: 'running', clockFault: null });
  });

  it('INT-WRK-028 jam host 11 menit DI DEPAN Binance (/fapi/v1/time → OFFSET_OUT_OF_RANGE, offset tidak diterapkan) → degraded, tetapi isClosed REST & rencana bootstrap/sweep memakai serverClock.closureNow: tidak ada candle berjalan yang tersimpan sebagai tertutup atau dianalisis; sweep berkala hanya menambah candle yang final menurut server', async () => {
    const SKEW = -11 * 60_000;
    const { scanner, repos, serverClock, timers, analysed } = await setup({ serverSkewMs: SKEW });
    await scanner.start();
    expect(serverClock.offsetMs()).toBe(0);
    expect(scanner.status()).toMatchObject({ state: 'degraded', clockFault: 'OFFSET_OUT_OF_RANGE' });
    // Waktu server = START − 11 menit = candle 45 + 247 d → candle tertutup terakhir 44 (jam host: 47).
    const serverNow = () => timers.clock() + SKEW;
    const assertOnlyFinal = async (last5m) => {
      for (const symbol of [SA, DOWN]) {
        for (const timeframe of ['5m', '15m', '1h']) {
          const stored = await storedSeries(repos, symbol, timeframe);
          expect(stored).toEqual(expectedSeries(symbol, timeframe, [[0, stored.length - 1, 'rest']]));
          expect(stored.at(-1).closeTime).toBeLessThan(serverNow());
          if (timeframe === '5m') expect(stored.at(-1).openTime).toBe(at5m(last5m));
        }
      }
    };
    await assertOnlyFinal(44);

    await timers.advance(10 * 60_000); // dua sweep berkala (tanpa pesan WS): candle 45 lalu 46 menjadi final menurut server
    await assertOnlyFinal(46);
    const final = (c) => MARKET.get(seriesKey(c.symbol, c.timeframe)).find((m) => m.openTime === c.openTime);
    const seen = analysed.flatMap((a) => a.candles);
    expect(seen.map((c) => `${c.symbol}:${(c.openTime - T0) / M5}`).sort()).toEqual([`${DOWN}:45`, `${DOWN}:46`, `${SA}:45`, `${SA}:46`]);
    for (const c of seen) expect(c).toEqual({ ...final(c), source: 'rest' });
  });

  it('INT-WRK-018 /fapi/v1/time dijawab 429 (Retry-After 4 d) saat start lalu 503 saat rediscovery → sampel jam satu percobaan tanpa retry/antrean limiter di dalam round-trip: offset tetap 0 (bukan +2000 / +187), tanpa error ingesti', async () => {
    const faults = ['429', null, '503'];
    let phase = 0;
    const { scanner, repos, binance, driver, serverClock, logs } = await setup({
      restSleep: (timers) => async (ms) => { timers.jump(ms); },
      configure: (b) => {
        const fetch = b.fetch;
        b.fetch = async (href, init) => {
          if (new URL(href).pathname !== '/fapi/v1/time') return fetch(href, init);
          const fault = faults[phase];
          phase += 1;
          if (fault === '429') {
            return new Response(JSON.stringify({ code: -1003, msg: 'Too many requests' }), { status: 429, headers: { 'retry-after': '4' } });
          }
          if (fault === '503') return new Response(JSON.stringify({ code: -1001, msg: 'Internal error' }), { status: 503 });
          return fetch(href, init);
        };
      },
    });
    await scanner.start();
    // Jam host = jam server (selisih nyata 0): jeda Retry-After 4 d terjadi SEBELUM request yang berhasil.
    expect(serverClock.offsetMs()).toBe(0);
    expect(serverClock.lastSync()).toMatchObject({ ok: true, offsetMs: 0, roundTripMs: 0 });

    // Start bergeser 4 d (Retry-After) → rediscovery pertama pada START + 4 d + 1 jam.
    await driver.runUntil(START + H1 + 10_000);
    expect(phase).toBe(4); // 429 → sukses (start), 503 → sukses (rediscovery)
    expect(serverClock.offsetMs()).toBe(0);
    expect(serverClock.lastSync()).toMatchObject({ ok: true, offsetMs: 0, roundTripMs: 0 });
    expect(binance.calls.filter((c) => c.path === '/fapi/v1/time')).toHaveLength(2); // dua percobaan yang dijawab sukses
    expect((await repos.ingestion.getStatus()).recentErrors).toEqual([]);
    expect(problems(logs)).toEqual([]);
  });

  it('INT-WRK-019 jam host 2 menit di DEPAN server (offset −120000): heartbeat, run, error, dan lastIngestionAt distempel jam LOKAL → summarizeWorker dengan jam lokal API melaporkan scanner "ok" (umur 0), bukan "stale"; candleLagMs tetap memakai jam server', async () => {
    const SKEW = -120_000;
    const { scanner, repos, serverClock, timers, driver } = await setup({ serverSkewMs: SKEW });
    await scanner.start();
    expect(serverClock.offsetMs()).toBe(SKEW);
    const status = await repos.ingestion.getStatus();
    expect(status.heartbeat.at).toBe(START);
    expect(status.heartbeat.state).toMatchObject({ lastIngestionAt: START, clockOffsetMs: SKEW });
    expect(status.lastRun).toMatchObject({ startedAt: START, finishedAt: START });
    // Lag candle = waktu server − closeTime candle terakhir (candle 5m #46 tutup T0 + 47×5m − 1).
    expect(status.heartbeat.state.candleLagMs).toBe(serverClock.now() - (at5m(BOOT - 1) - 1));

    // /api/system/status memanggil summarizeWorker(status, Date.now()) di proses API = jam lokal host.
    const worker = summarizeWorker(status, timers.clock() + 1_000);
    expect(worker.scanner).toMatchObject({ status: 'ok', heartbeatAt: START, heartbeatAgeMs: 1_000 });
    expect(worker.scanner.candleLagMs).not.toBeNull();
    expect(worker.binance).toEqual({ status: 'ok', ws: 'open' });

    await driver.runUntil(START + 5 * 60_000);
    const later = await repos.ingestion.getStatus();
    expect(summarizeWorker(later, timers.clock()).scanner).toMatchObject({ status: 'ok' });
    expect(later.heartbeat.at).toBe(timers.clock() - (timers.clock() - START) % 30_000);
    // Error ingesti juga distempel jam lokal (driver palsu mengirim kline final menurut jam lokal, sehingga
    // menurut server kline itu tiba 2 menit terlalu awal dan ditolak validasi — yang diuji di sini stempelnya).
    expect(later.recentErrors.find((e) => e.source === 'validation')).toMatchObject({ at: at5m(BOOT + 1) + CLOSE_DELAY_MS });
  });

  it('INT-WRK-020 jam host 5 menit di BELAKANG server (offset +300000): heartbeat distempel jam lokal → worker yang berhenti menulis heartbeat terdeteksi "stale" setelah 90 detik, bukan 90 detik + offset', async () => {
    const SKEW = 300_000;
    const { scanner, repos, serverClock, timers } = await setup({ serverSkewMs: SKEW });
    await scanner.start();
    expect(serverClock.offsetMs()).toBe(SKEW);
    const status = await repos.ingestion.getStatus();
    expect(status.heartbeat.at).toBe(START);
    expect(summarizeWorker(status, timers.clock() + HEARTBEAT_STALE_MS).scanner.status).toBe('ok');
    // Worker mati setelah heartbeat terakhir: 4 menit kemudian (jam lokal API) harus "stale".
    expect(summarizeWorker(status, timers.clock() + 240_000).scanner).toMatchObject({ status: 'stale', heartbeatAgeMs: 240_000, candleLagMs: null });
  });

  it('INT-WRK-017 perakitan produksi (worker/assemble.js), jam server 4 m 56 d di DEPAN jam lokal → candle 5m #48 yang sudah tertutup menurut server (belum menurut jam lokal) ikut di-bootstrap: isClosed REST & validasi repositori memakai serverClock.now; candle #49 yang masih berjalan ditolak repositori', async () => {
    // Jam server 3 d setelah candle #48 tutup (> margin penutupan 2 d, sehingga REST boleh mengambilnya).
    const SKEW = M5 - 4_000;
    const { scanner, repos, binance, serverClock, logs } = await setup({ serverSkewMs: SKEW });
    await scanner.start();
    expect(serverClock.offsetMs()).toBe(SKEW);
    // Jam lokal START = T0 + 48×5m + 7 d (candle #48 belum tertutup); jam server = T0 + 49×5m + 3 d (sudah).
    expect(serverClock.now()).toBe(at5m(BOOT + 1) + 3_000);
    for (const symbol of [SA, DOWN]) {
      expect(await storedSeries(repos, symbol, '5m')).toEqual(expectedSeries(symbol, '5m', [[0, BOOT, 'rest']]));
    }
    expect((await repos.ingestion.getStatus()).recentErrors).toEqual([]);
    expect(binance.klineCalls()).toHaveLength(6);

    // Repositori candle produksi memvalidasi "tertutup" dengan jam server: candle #49 ditolak.
    const running = { ...MARKET.get(seriesKey(SA, '5m'))[BOOT + 1], isClosed: true, source: 'ws' };
    const result = await repos.candles.upsertClosed([running]);
    expect(result.rejected).toEqual([{ candle: running, errors: ['candle ditandai tertutup sebelum closeTime terlewati'] }]);
    expect(problems(logs)).toEqual([]);
  });

  it('INT-WRK-009 histori panjang: bootstrap 500 candle penuh, konteks HTF bertrend nyata; candle 15m/1h yang tiba SETELAH candle 5m ditunggu (settleMs seperti worker/index.js) → snapshot per candle = replay murni', async () => {
    const { scanner, repos, binance, driver, saves, settles, alerts, logs } = await setup({
      market: LONG_MARKET, settleMs: 3_000, delayOf: htfLate,
    });
    await scanner.start();

    // Bootstrap limit 500: 5m terisi penuh; 15m/1h sebanyak histori yang tersedia sejak onboardDate.
    expect(await storedSeries(repos, SA, '5m'))
      .toEqual(expectedSeries(SA, '5m', [[PRE_BARS + BOOT - 500, PRE_BARS + BOOT - 1, 'rest']], LONG_MARKET));
    expect(await storedSeries(repos, SA, '15m')).toEqual(expectedSeries(SA, '15m', [[0, PRE_BARS / 3 + 15, 'rest']], LONG_MARKET));
    expect(await storedSeries(repos, SA, '1h')).toEqual(expectedSeries(SA, '1h', [[0, PRE_BARS / 12 + 3, 'rest']], LONG_MARKET));
    expect(binance.klineCalls()).toHaveLength(6);

    await driver.runUntil(END);

    const reference = referenceReplay(SA, LIQ_SA, { market: LONG_MARKET });
    const expected = expectedHistory(SA, reference);
    assertReferenceShape(expected);
    // Guard: konteks HTF benar-benar berubah selama sinyal hidup (bukan selalu UNCONFIRMED).
    expect(new Set(referenceSaves(reference).map((s) => s.alignment)).size).toBeGreaterThan(1);
    // Dengan histori cukup, seri 15m (konteks 1h) juga dianalisis dan membuka sinyalnya sendiri.
    const reference15 = referenceReplay(SA, LIQ_SA, { market: LONG_MARKET, timeframe: '15m', from: 16, to: 24 });
    const expected15 = expectedHistory(SA, reference15, '15m');
    expect(expected15.length).toBeGreaterThan(0);

    const history = withoutIds(await repos.signals.history({ symbol: SA, limit: 10 }));
    expect(history.filter((s) => s.timeframe === '5m')).toEqual(expected);
    expect(history.filter((s) => s.timeframe === '15m')).toEqual(expected15);
    expect(history.filter((s) => s.timeframe === '1h')).toEqual([]); // 1h masih di bawah warm-up pola
    expect(savesOf(saves, SA)).toEqual(referenceSaves(reference));
    expect(savesOf(saves, SA, '15m')).toEqual(referenceSaves(reference15));
    expect(alerts.filter((a) => a.timeframe === '5m').map(alertView)).toEqual(referenceAlerts(SA, reference).map(dropIndex));
    expect(alerts.filter((a) => a.timeframe === '15m').map(alertView)).toEqual(referenceAlerts(SA, reference15, '15m').map(dropIndex));
    // Menunggu tepat sekali per batas 15m per simbol (9 batas × 2 simbol), tidak pernah di candle lain.
    expect(settles).toHaveLength(18);
    expect(settles.every(({ at, ms }) => ms === 3_000 && (at - CLOSE_DELAY_MS) % M15 === 0)).toBe(true);
    expect(problems(logs)).toEqual([]);
  });

  it('INT-WRK-025 pengaturan hanya 5m (15m/1h tidak dipilih) → 15m/1h tetap diingesti sebagai konteks HTF: snapshot 5m (alignment, risk flag, penjelasan) = replay murni dengan konteks HTF; 15m/1h tidak pernah dianalisis', async () => {
    const { scanner, repos, binance, driver, saves, settles, analysed, logs } = await setup({
      market: LONG_MARKET, settleMs: 3_000, delayOf: htfLate, settings: { ...withSettings(), timeframes: ['5m'] },
    });
    await scanner.start();
    expect(scanner.status()).toMatchObject({ symbols: 2, streams: 6 });
    expect(binance.klineCalls().map((p) => p.interval).sort()).toEqual(['15m', '15m', '1h', '1h', '5m', '5m']);
    await driver.runUntil(END);

    expect(await storedSeries(repos, SA, '1h')).toEqual(expectedSeries(SA, '1h', [[0, PRE_BARS / 12 + 3, 'rest'], [PRE_BARS / 12 + 4, PRE_BARS / 12 + 5, 'ws']], LONG_MARKET));
    const reference = referenceReplay(SA, LIQ_SA, { market: LONG_MARKET });
    expect(new Set(referenceSaves(reference).map((s) => s.alignment)).size).toBeGreaterThan(1);
    expect(savesOf(saves, SA)).toEqual(referenceSaves(reference));
    expect(withoutIds(await repos.signals.history({ symbol: SA, limit: 10 }))).toEqual(expectedHistory(SA, reference));
    expect(new Set(analysed.map((a) => a.timeframe))).toEqual(new Set(['5m']));
    expect(saves.filter((s) => s.timeframe !== '5m')).toEqual([]);
    // HTF tersimpan tepat waktu → settle hanya sekali per batas 15m per simbol, sama seperti semua timeframe dipilih.
    expect(settles).toHaveLength(18);
    expect(problems(logs)).toEqual([]);
  });

  it('INT-WRK-010 kontrol: tanpa settleMs, candle HTF yang tiba belakangan membuat snapshot 5m di batas jam berbeda dari replay (race yang ditutup settleMs)', async () => {
    const { scanner, driver, saves, settles } = await setup({ market: LONG_MARKET, settleMs: 0, delayOf: htfLate });
    await scanner.start();
    await driver.runUntil(END);

    const reference = referenceSaves(referenceReplay(SA, LIQ_SA, { market: LONG_MARKET }));
    const live = savesOf(saves, SA);
    expect(live.map((s) => s.candleTime)).toEqual(reference.map((s) => s.candleTime));
    const differing = live.filter((s, i) => JSON.stringify(s) !== JSON.stringify(reference[i])).map((s) => (s.candleTime - T0) / M5);
    // Trend 1h berbalik tepat pada candle 1h yang tutup bersama candle 5m ke-71; tanpa menunggu, candle itu
    // dievaluasi dengan konteks 1h satu bar lebih lama. Semua perbedaan jatuh di batas 15m/1h.
    expect(differing).toContain(71);
    expect(differing.every((i) => (i + 1) % 3 === 0)).toBe(true);
    expect(settles).toEqual([]);
  });

  it('INT-WRK-011 WS putus ~20 menit (handshake ditolak) → heartbeat degraded, reconnect dengan backoff, sweep REST mengisi candle terlewat; sinyal tetap = replay', async () => {
    const { scanner, repos, driver, hub, analysed, alerts, logs } = await setup();
    await scanner.start();
    await driver.runUntil(at5m(60) + 20_000); // candle 59 sudah diterima lewat WS

    hub.server.refuse = true;
    hub.disconnectAll(1006);
    await driver.runUntil(at5m(62) + 30_000);
    const during = (await repos.ingestion.getStatus()).heartbeat;
    expect(during.state).toMatchObject({ state: 'degraded', ws: 'reconnecting' });
    expect(during.state.reconnects).toBeGreaterThan(1);

    await driver.runUntil(at5m(64) + 30_000);
    hub.server.refuse = false;
    await driver.runUntil(END);

    // Selama terputus, sweep berkala (bukan WS) mengambil candle yang sudah tertutup lewat REST.
    const series = analysed.filter((a) => a.symbol === SA && a.timeframe === '5m');
    const viaRest = series.filter((a) => a.reason !== 'live');
    expect(viaRest.length).toBeGreaterThan(0);
    expect(viaRest.every((a) => a.reason === 'sweep')).toBe(true);
    expect(series.flatMap((a) => a.candles.map((c) => c.openTime))).toEqual(range(BOOT, LAST).map(at5m));
    expect(await repos.candles.findGaps({ symbol: SA, timeframe: '5m', from: T0, to: at5m(LAST) })).toEqual([]);
    expect(await storedSeries(repos, SA, '5m')).toEqual(expect.arrayContaining(expectedSeries(SA, '5m', [[60, 63, 'rest']])));

    const reference = referenceReplay(SA, LIQ_SA);
    expect(withoutIds(await repos.signals.history({ symbol: SA, limit: 10 }))).toEqual(expectedHistory(SA, reference));
    const latest = new Set(series.map((a) => a.candles.at(-1).openTime));
    expect(alerts.map(alertView)).toEqual(referenceAlerts(SA, reference).filter((a) => latest.has(a.candleTime)).map(dropIndex));

    // Koneksi pulih: satu socket terbuka, heartbeat kembali running; error handshake tercatat (di-throttle).
    expect(hub.sockets.filter((s) => s.readyState === 1)).toHaveLength(1);
    expect(scanner.status()).toMatchObject({ state: 'running', ws: 'open', staleStreams: 0 });
    expect((await repos.ingestion.getStatus()).heartbeat.state).toMatchObject({ state: 'running', ws: 'open' });
    const { recentErrors } = await repos.ingestion.getStatus();
    expect(recentErrors.length).toBeGreaterThan(0);
    expect(recentErrors.every((e) => e.source === 'ws' && e.message === 'error: koneksi 0: error (connect ECONNREFUSED)')).toBe(true);
    expect(problems(logs)).toContain('koneksi WebSocket terputus');
  });

  it('INT-WRK-012 Binance HTTP 503 saat backfill gap → klien REST mengulang dengan backoff lalu menyerah, error tercatat; gap berikutnya menutup semuanya berurutan', async () => {
    const { scanner, repos, binance, driver, analysed, alerts, logs } = await setup({
      // Sweep REST berkala dibuat jarang agar gap ditutup oleh deteksi lompatan WS, bukan oleh sweep
      // (sweep bawaan 300 dtk jatuh tepat 7 dtk setelah batas 5m dan akan mengambil alih backfill).
      settings: withSettings({ refresh: { restBackfillIntervalSec: 3600 } }),
      skip: (c) => c.symbol === SA && c.timeframe === '5m' && c.openTime === at5m(60),
      // Backoff klien REST memajukan jam palsu (tanpa jaringan sungguhan).
      restSleep: (timers) => async (ms) => { timers.jump(ms); },
    });
    await scanner.start();
    await driver.runUntil(at5m(61) + 60_000);
    binance.faults.klines503 = 4; // percobaan awal + 3 retry
    await driver.runUntil(at5m(62) + 10_000);

    const fails = binance.calls.filter((c) => c.path === '/fapi/v1/klines').slice(6);
    // Candle WS pemicu (61) baru tutup 0,5 detik sebelumnya (< margin penutupan) → REST hanya meminta 60.
    expect(fails.map((c) => c.params)).toEqual(Array.from({ length: 4 }, () => klineParams(SA, '5m', at5m(60), 1)));
    // Jeda antar percobaan = backoff eksponensial dengan jitter tetap (random 0,5): 375, 750, 1500 ms.
    expect(fails.slice(1).map((c, i) => c.at - fails[i].at)).toEqual([375, 750, 1_500]);
    expect((await repos.ingestion.getStatus()).recentErrors).toEqual([expect.objectContaining({
      source: 'backfill',
      message: `${SA} 5m: Binance /fapi/v1/klines gagal: HTTP 503 — Internal error; unable to process your request. Please try again.`,
    })]);
    // Candle WS pemicu tetap tersimpan, tetapi belum dianalisis (high-water mark tidak maju).
    expect((await repos.candles.getRange({ symbol: SA, timeframe: '5m', from: at5m(61), to: at5m(61) }))[0]).toMatchObject({ source: 'ws' });
    expect(analysed.filter((a) => a.symbol === SA && a.timeframe === '5m').at(-1).candles.at(-1).openTime).toBe(at5m(59));

    await driver.runUntil(END);
    const series = analysed.filter((a) => a.symbol === SA && a.timeframe === '5m');
    expect(series.map((a) => [a.reason, a.candles.map((c) => c.openTime)])).toEqual([
      ...range(BOOT, 59).map((i) => ['live', [at5m(i)]]),
      ['gap', [at5m(60), at5m(61), at5m(62)]],
      ...range(63, LAST).map((i) => ['live', [at5m(i)]]),
    ]);
    // Candle 61 sudah tersimpan dari WS saat backfill pertama gagal; salinan REST-nya identik sehingga
    // repositori tidak menulis ulang (source tetap 'ws'). 60 baru masuk lewat REST; 62 = candle WS pemicu
    // yang baru tutup (< margin penutupan, tidak diminta lewat REST).
    expect(await storedSeries(repos, SA, '5m')).toEqual(expectedSeries(SA, '5m', [
      [0, BOOT - 1, 'rest'], [BOOT, 59, 'ws'], [60, 60, 'rest'], [61, LAST, 'ws'],
    ]));
    const reference = referenceReplay(SA, LIQ_SA);
    expect(withoutIds(await repos.signals.history({ symbol: SA, limit: 10 }))).toEqual(expectedHistory(SA, reference));
    expect(alerts.map(alertView)).toEqual(referenceAlerts(SA, reference).map(dropIndex));
    expect(scanner.status()).toMatchObject({ gaps: 2, errors: 1, state: 'running' });
    expect(problems(logs)).toEqual([...Array.from({ length: 3 }, () => 'Request Binance gagal, diulang'), 'galat scanner']);
  });
});
