import { describe, expect, it } from 'vitest';
import {
  BINANCE_WS_BASE_URL,
  KLINE_WS_ROUTE,
  MAX_STREAMS_PER_CONNECTION,
  buildStreamUrls,
  computeBackoff,
  createKlineStream,
  parseKlineMessage,
  streamName,
} from '../../../backend/ingestion/binance/wsClient.js';
import { TIMEFRAME_MS } from '../../../backend/market/contracts.js';

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
const M5 = TIMEFRAME_MS['5m'];

// Fixture sintetis — bukan data pasar nyata. Bentuk mengikuti dokumentasi resmi Binance
// USDT-M Futures "Kline/Candlestick Streams" yang dibungkus format combined stream.
function klineEvent({ symbol = 'BTCUSDT', interval = '5m', openTime = T0, closed = false, close = '100.5', k = {} } = {}) {
  return {
    stream: `${symbol.toLowerCase()}@kline_${interval}`,
    data: {
      e: 'kline',
      E: openTime + 1_000,
      s: symbol,
      k: {
        t: openTime,
        T: openTime + TIMEFRAME_MS[interval] - 1,
        s: symbol,
        i: interval,
        f: 100,
        L: 200,
        o: '100.0',
        c: close,
        h: '101.0',
        l: '99.5',
        v: '12.5',
        n: 42,
        x: closed,
        q: '1256.25',
        V: '6.0',
        Q: '603.0',
        B: '0',
        ...k,
      },
    },
  };
}

/** Penjadwal timer palsu + jam deterministik (tanpa sleep nyata). */
function createFakeTimers(start = T0) {
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
  /** Memajukan waktu dan menjalankan timer yang jatuh tempo secara berurutan. */
  const advance = (ms) => {
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
      now = t.at;
      t.fn();
    }
    now = target;
  };
  return { clock, setTimer, clearTimer, advance, pending, delays: () => [...pending.values()].map((t) => t.ms) };
}

/** WebSocket palsu dengan API addEventListener seperti WebSocket global Node 22. */
function createFakeWebSocket({ throwOnConstruct = () => false } = {}) {
  const instances = [];
  class FakeWebSocket {
    constructor(url) {
      if (throwOnConstruct(url)) throw new Error('gagal membuat socket');
      this.url = url;
      this.listeners = new Map();
      this.closeCalls = [];
      instances.push(this);
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    removeEventListener(type, fn) {
      this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
    }
    fire(type, props = {}) {
      for (const fn of this.listeners.get(type) ?? []) fn({ type, ...props });
    }
    serverOpen() { this.fire('open'); }
    serverMessage(payload) { this.fire('message', { data: typeof payload === 'string' ? payload : JSON.stringify(payload) }); }
    serverClose(code = 1006) { this.fire('close', { code, reason: '' }); }
    serverError(props) { this.fire('error', props); }
    close(code, reason) { this.closeCalls.push({ code, reason }); }
  }
  return { FakeWebSocket, instances };
}

function setup({ streams = [{ symbol: 'BTCUSDT', timeframe: '5m' }], random = () => 1, ...opts } = {}) {
  const timers = createFakeTimers();
  const ws = createFakeWebSocket(opts.wsOptions);
  const candles = [];
  const states = [];
  const stream = createKlineStream({
    WebSocketImpl: ws.FakeWebSocket,
    streams,
    onCandle: opts.onCandle ?? ((c) => candles.push(c)),
    onState: (s) => states.push(s),
    clock: timers.clock,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    random,
    ...opts.client,
  });
  return { stream, timers, ws, candles, states, last: () => ws.instances.at(-1) };
}

const errorsOf = (states) => states.filter((s) => s.event === 'error');

describe('URL & nama stream', () => {
  it('UNIT-WSC-001 combined stream memakai simbol lowercase', () => {
    expect(streamName({ symbol: 'BTCUSDT', timeframe: '5m' })).toBe('btcusdt@kline_5m');
    const urls = buildStreamUrls([{ symbol: 'BTCUSDT', timeframe: '5m' }, { symbol: 'ETHUSDT', timeframe: '1h' }]);
    expect(urls).toEqual([{
      url: 'wss://fstream.binance.com/market/stream?streams=btcusdt@kline_5m/ethusdt@kline_1h',
      streams: ['btcusdt@kline_5m', 'ethusdt@kline_1h'],
    }]);
  });

  it('UNIT-WSC-002 lebih dari 200 stream dipecah ke beberapa koneksi', () => {
    const make = (n) => Array.from({ length: n }, (_, i) => ({ symbol: `S${String(i).padStart(3, '0')}USDT`, timeframe: '5m' }));
    expect(MAX_STREAMS_PER_CONNECTION).toBe(200);
    expect(buildStreamUrls(make(200))).toHaveLength(1);
    expect(buildStreamUrls(make(401)).map((c) => c.streams.length)).toEqual([200, 200, 1]);

    const { stream, ws } = setup({ streams: make(201) });
    stream.start();
    expect(ws.instances).toHaveLength(2);
    expect(ws.instances[0].url.split('/stream?streams=')[1].split('/')).toHaveLength(200);
    expect(ws.instances[1].url).toBe('wss://fstream.binance.com/market/stream?streams=s200usdt@kline_5m');
    expect(stream.state()).toMatchObject({ state: 'connecting', connections: 2, streams: 201 });
  });

  it('UNIT-WSC-014 kline memakai rute kategori /market (URL lama tanpa rute tidak mengirim kline sejak 2026-04-23)', () => {
    expect(KLINE_WS_ROUTE).toBe('/market');
    expect(BINANCE_WS_BASE_URL).toBe('wss://fstream.binance.com/market');
    const [{ url }] = buildStreamUrls([{ symbol: 'BTCUSDT', timeframe: '5m' }]);
    expect(new URL(url)).toMatchObject({ protocol: 'wss:', hostname: 'fstream.binance.com', pathname: '/market/stream', search: '?streams=btcusdt@kline_5m' });
    // Garis miring penutup pada baseUrl eksplisit dinormalisasi, tanpa path ganda.
    expect(buildStreamUrls([{ symbol: 'BTCUSDT', timeframe: '5m' }], { baseUrl: 'wss://fstream.binance.com/market/' })[0].url)
      .toBe('wss://fstream.binance.com/market/stream?streams=btcusdt@kline_5m');
  });

  it('NEG-WSC-005 baseUrl tanpa rute /market (URL lama, /public, /private, path lain, query, fragment) ditolak', () => {
    const streams = [{ symbol: 'BTCUSDT', timeframe: '5m' }];
    for (const baseUrl of [
      'wss://fstream.binance.com', 'wss://fstream.binance.com/', 'wss://fstream.binance.com/ws', 'wss://fstream.binance.com/stream',
      'wss://fstream.binance.com/public', 'wss://fstream.binance.com/private', 'wss://fstream.binance.com/market/stream',
      'wss://fstream.binance.com/marketx', 'wss://fstream.binance.com/market?streams=x', 'wss://fstream.binance.com/market#a',
    ]) {
      expect(() => buildStreamUrls(streams, { baseUrl }), baseUrl).toThrow(/\/market/);
    }
  });

  it('EDGE-WSC-001 stream duplikat dibuang sebelum dipecah', () => {
    const urls = buildStreamUrls([{ symbol: 'BTCUSDT', timeframe: '5m' }, { symbol: 'BTCUSDT', timeframe: '5m' }]);
    expect(urls[0].streams).toEqual(['btcusdt@kline_5m']);
  });

  it('NEG-WSC-001 host di luar allowlist, skema non-wss, atau stream tidak valid ditolak', () => {
    const { FakeWebSocket } = createFakeWebSocket();
    const base = { WebSocketImpl: FakeWebSocket, onCandle: () => {}, streams: [{ symbol: 'BTCUSDT', timeframe: '5m' }] };
    expect(() => createKlineStream({ ...base, baseUrl: 'wss://evil.example.com' })).toThrow(/allowlist/);
    expect(() => createKlineStream({ ...base, baseUrl: 'ws://fstream.binance.com' })).toThrow(/wss/);
    expect(() => createKlineStream({ ...base, streams: [] })).toThrow(RangeError);
    expect(() => createKlineStream({ ...base, streams: [{ symbol: 'btc/usdt', timeframe: '5m' }] })).toThrow(TypeError);
    expect(() => createKlineStream({ ...base, streams: [{ symbol: 'BTCUSDT', timeframe: '4h' }] })).toThrow(TypeError);
    expect(() => createKlineStream({ ...base, onCandle: undefined })).toThrow(TypeError);
    expect(() => createKlineStream({ ...base, WebSocketImpl: null })).toThrow(TypeError);
  });
});

describe('parse event kline', () => {
  it('UNIT-WSC-003 x=true → candle tertutup; x=false → provisional; source ws', () => {
    const closed = parseKlineMessage(JSON.stringify(klineEvent({ closed: true })));
    expect(closed).toMatchObject({ ok: true });
    expect(closed.candle).toEqual({
      symbol: 'BTCUSDT', timeframe: '5m', openTime: T0, closeTime: T0 + M5 - 1,
      open: 100, high: 101, low: 99.5, close: 100.5, volume: 12.5, quoteVolume: 1256.25, trades: 42,
      takerBuyVolume: 6, takerBuyQuoteVolume: 603, isClosed: true, source: 'ws',
    });
    const provisional = parseKlineMessage(JSON.stringify(klineEvent({ closed: false })));
    expect(provisional.candle.isClosed).toBe(false);
    // Event tanpa pembungkus combined stream juga diterima.
    expect(parseKlineMessage(JSON.stringify(klineEvent().data)).ok).toBe(true);
  });

  it('NEG-WSC-002 bentuk pesan rusak ditolak dengan alasan', () => {
    const bad = [
      'bukan json',
      JSON.stringify(null),
      JSON.stringify({ result: null, id: 1 }),
      JSON.stringify({ ...klineEvent(), data: { ...klineEvent().data, e: 'aggTrade' } }),
      JSON.stringify(klineEvent({ k: { i: '4h' } })),
      JSON.stringify(klineEvent({ k: { T: T0 + M5 } })),
      JSON.stringify(klineEvent({ openTime: T0 + 1 })),
      JSON.stringify(klineEvent({ k: { o: 'abc' } })),
      JSON.stringify(klineEvent({ k: { c: '-1' } })),
      JSON.stringify(klineEvent({ k: { v: '' } })),
      JSON.stringify(klineEvent({ k: { n: 1.5 } })),
      JSON.stringify(klineEvent({ k: { x: 'true' } })),
      JSON.stringify(klineEvent({ k: { s: 'btcusdt' } })),
      JSON.stringify({ ...klineEvent(), stream: 'ethusdt@kline_5m' }),
      JSON.stringify({ ...klineEvent(), data: { ...klineEvent().data, s: 'ETHUSDT' } }),
      42,
    ];
    for (const raw of bad) {
      const r = parseKlineMessage(raw);
      expect(r.ok, String(raw)).toBe(false);
      expect(typeof r.error).toBe('string');
    }
  });

  it('EDGE-WSC-002 harga numerik (bukan string) yang valid tetap diterima', () => {
    const r = parseKlineMessage(JSON.stringify(klineEvent({ k: { o: 100, h: 101 } })));
    expect(r.ok).toBe(true);
    expect(r.candle.open).toBe(100);
  });
});

describe('siklus koneksi', () => {
  it('UNIT-WSC-004 pesan diteruskan ke onCandle; state idle→connecting→open', () => {
    const { stream, last, candles, states } = setup();
    expect(stream.state().state).toBe('idle');
    stream.start();
    expect(stream.state().state).toBe('connecting');
    last().serverOpen();
    last().serverMessage(klineEvent({ closed: false }));
    last().serverMessage(klineEvent({ closed: true }));
    expect(candles.map((c) => c.isClosed)).toEqual([false, true]);
    expect(stream.state()).toMatchObject({ state: 'open', reconnects: 0, messages: 2, openConnections: 1 });
    expect(states.filter((s) => s.event === 'state').map((s) => s.state)).toEqual(['connecting', 'open']);
  });

  it('NEG-WSC-003 pesan rusak dicatat lewat onState dan diabaikan tanpa memutus koneksi', () => {
    const { stream, last, candles, states, ws } = setup();
    stream.start();
    last().serverOpen();
    last().serverMessage('{"stream":');
    last().serverMessage(JSON.stringify(klineEvent({ k: { o: 'NaN' } })));
    last().fire('message', { data: new Uint8Array([1, 2, 3]).buffer });
    last().serverMessage(klineEvent({ closed: true }));
    expect(candles).toHaveLength(1);
    expect(errorsOf(states).map((e) => e.error.kind)).toEqual(['parse', 'parse', 'parse']);
    expect(stream.state()).toMatchObject({ state: 'open', parseErrors: 3, reconnects: 0 });
    expect(ws.instances).toHaveLength(1);
  });

  it('EDGE-WSC-003 pesan raksasa ditolak sebelum JSON.parse', () => {
    const { stream, last, candles, states } = setup({ client: { maxMessageBytes: 1024 } });
    stream.start();
    last().serverOpen();
    last().serverMessage(`{"pad":"${'x'.repeat(2048)}"}`);
    expect(candles).toHaveLength(0);
    expect(errorsOf(states)[0].error.message).toMatch(/terlalu besar/);
  });

  it('EDGE-WSC-004 event untuk stream yang tidak dilanggan diabaikan', () => {
    const { stream, last, candles, states } = setup();
    stream.start();
    last().serverOpen();
    last().serverMessage(klineEvent({ symbol: 'ETHUSDT' }));
    expect(candles).toHaveLength(0);
    expect(errorsOf(states)[0].error.kind).toBe('unexpected');
  });

  it('EDGE-WSC-005 onCandle yang melempar error tidak menghentikan stream', () => {
    let n = 0;
    const { stream, last, states } = setup({ onCandle: () => { n += 1; throw new Error('boom'); } });
    stream.start();
    last().serverOpen();
    last().serverMessage(klineEvent());
    last().serverMessage(klineEvent());
    expect(n).toBe(2);
    expect(errorsOf(states).map((e) => e.error.kind)).toEqual(['callback', 'callback']);
    expect(stream.state().state).toBe('open');
  });
});

describe('reconnect & backoff', () => {
  it('UNIT-WSC-005 reconnect setelah close', () => {
    const { stream, last, timers, ws, candles, states } = setup({ random: () => 0.5 });
    stream.start();
    last().serverOpen();
    last().serverClose(1006);
    expect(stream.state().state).toBe('reconnecting');
    expect(timers.delays()).toEqual([750]); // backoff awal 1000ms, equal jitter 0.5
    expect(states.some((s) => s.event === 'disconnect' && s.code === 1006)).toBe(true);
    timers.advance(750);
    expect(ws.instances).toHaveLength(2);
    last().serverOpen();
    last().serverMessage(klineEvent({ closed: true }));
    expect(candles).toHaveLength(1);
    expect(stream.state()).toMatchObject({ state: 'open', reconnects: 1 });
  });

  it('UNIT-WSC-006 backoff tumbuh eksponensial dan dibatasi maxMs', () => {
    const { stream, last, timers } = setup({ client: { backoff: { initialMs: 1000, maxMs: 10_000 } } });
    stream.start();
    const delays = [];
    for (let i = 0; i < 7; i += 1) {
      last().serverClose(1006); // gagal sebelum open
      delays.push(...timers.delays());
      timers.advance(timers.delays()[0]);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 10_000, 10_000, 10_000]);
    expect(stream.state().reconnects).toBe(7);
  });

  it('UNIT-WSC-007 computeBackoff: jitter dalam [base/2, base] dan tidak melewati maxMs', () => {
    const cfg = { initialMs: 1000, maxMs: 60_000 };
    expect(computeBackoff(0, cfg, () => 0)).toBe(500);
    expect(computeBackoff(0, cfg, () => 1)).toBe(1000);
    expect(computeBackoff(3, cfg, () => 0.5)).toBe(6000);
    expect(computeBackoff(50, cfg, () => 1)).toBe(60_000);
    expect(computeBackoff(10_000, cfg, () => 0)).toBe(30_000);
  });

  it('UNIT-WSC-008 backoff di-reset setelah koneksi stabil, tidak di-reset bila singkat', () => {
    const { stream, last, timers } = setup({ client: { stableMs: 60_000 } });
    stream.start();
    last().serverClose();
    timers.advance(1000);
    last().serverClose();
    expect(timers.delays()).toEqual([2000]);
    timers.advance(2000);
    // terbuka singkat (< stableMs) → backoff tetap tumbuh
    last().serverOpen();
    timers.advance(10_000);
    last().serverMessage(klineEvent());
    last().serverClose();
    expect(timers.delays()).toEqual([4000]);
    timers.advance(4000);
    // terbuka stabil ≥ 60 detik → reset ke initialMs
    last().serverOpen();
    for (let i = 0; i < 3; i += 1) {
      timers.advance(30_000);
      last().serverMessage(klineEvent());
    }
    last().serverClose();
    expect(timers.delays()).toEqual([1000]);
  });

  it('UNIT-WSC-009 koneksi basi (tanpa pesan ≥ staleMs) ditutup lalu reconnect', () => {
    const { stream, last, timers, ws, states, candles } = setup({ client: { staleMs: 90_000 } });
    stream.start();
    const first = last();
    first.serverOpen();
    // pesan rutin tiap 30 detik → tidak dianggap basi
    for (let i = 0; i < 10; i += 1) {
      timers.advance(30_000);
      first.serverMessage(klineEvent());
    }
    expect(ws.instances).toHaveLength(1);
    timers.advance(89_999);
    expect(first.closeCalls).toHaveLength(0);
    timers.advance(1);
    expect(first.closeCalls).toEqual([{ code: 4000, reason: 'stale' }]);
    expect(errorsOf(states).at(-1).error.kind).toBe('stale');
    timers.advance(1000);
    expect(ws.instances).toHaveLength(2);
    // event terlambat dari socket lama diabaikan: tidak ada candle baru dan penghitung pesan tidak berubah
    const delivered = candles.length;
    const messages = stream.state().messages;
    first.serverMessage(klineEvent({ closed: true }));
    first.serverClose(1006);
    expect(candles).toHaveLength(delivered);
    expect(stream.state().messages).toBe(messages);
    expect(ws.instances).toHaveLength(2);
    expect(stream.state().reconnects).toBe(1);
  });

  it('UNIT-WSC-010 batas waktu connect: tidak pernah open → reconnect', () => {
    const { stream, timers, ws } = setup({ client: { connectTimeoutMs: 15_000 } });
    stream.start();
    timers.advance(15_000);
    expect(ws.instances[0].closeCalls[0]).toEqual({ code: 4000, reason: 'connect-timeout' });
    timers.advance(1000);
    expect(ws.instances).toHaveLength(2);
  });

  it('UNIT-WSC-011 reconnect terjadwal sebelum batas 24 jam Binance, tanpa menambah backoff', () => {
    const { stream, last, timers, ws } = setup({ client: { staleMs: 48 * 3_600_000, maxConnectionAgeMs: 23 * 3_600_000 } });
    stream.start();
    last().serverOpen();
    timers.advance(23 * 3_600_000 - 1);
    expect(ws.instances).toHaveLength(1);
    timers.advance(1);
    expect(ws.instances[0].closeCalls).toEqual([{ code: 1000, reason: 'rotate' }]);
    timers.advance(0);
    expect(ws.instances).toHaveLength(2);
    last().serverOpen();
    expect(stream.state()).toMatchObject({ state: 'open', reconnects: 1 });
  });

  it('NEG-WSC-004 event error dan constructor yang melempar memicu reconnect', () => {
    let fail = true;
    const { stream, timers, ws, states, last } = setup({ wsOptions: { throwOnConstruct: () => fail } });
    stream.start();
    expect(ws.instances).toHaveLength(0);
    expect(errorsOf(states)[0].error.kind).toBe('socket');
    expect(stream.state().state).toBe('reconnecting');
    fail = false;
    timers.advance(1000);
    expect(ws.instances).toHaveLength(1);
    last().serverOpen();
    last().serverError({ message: 'Received network error or non-101 status code.' });
    expect(errorsOf(states).at(-1).error).toEqual({ kind: 'error', message: 'koneksi 0: error (Received network error or non-101 status code.)' });
    expect(stream.state().state).toBe('reconnecting');
    timers.advance(2000);
    expect(ws.instances).toHaveLength(2);
  });

  it('UNIT-WSC-012 hanya koneksi yang putus yang reconnect; state agregat mengikuti', () => {
    const streams = Array.from({ length: 250 }, (_, i) => ({ symbol: `S${String(i).padStart(3, '0')}USDT`, timeframe: '15m' }));
    const { stream, timers, ws } = setup({ streams });
    stream.start();
    ws.instances.forEach((s) => s.serverOpen());
    expect(stream.state()).toMatchObject({ state: 'open', openConnections: 2 });
    ws.instances[1].serverClose();
    expect(stream.state()).toMatchObject({ state: 'reconnecting', openConnections: 1 });
    timers.advance(1000);
    expect(ws.instances).toHaveLength(3);
    expect(ws.instances[2].url).toBe(ws.instances[1].url);
    ws.instances[2].serverOpen();
    expect(stream.state().state).toBe('open');
  });
});

describe('stop', () => {
  it('UNIT-WSC-013 stop() menutup bersih tanpa reconnect dan tanpa timer tersisa', () => {
    const { stream, last, timers, ws, states } = setup();
    stream.start();
    last().serverOpen();
    stream.stop();
    expect(ws.instances[0].closeCalls).toEqual([{ code: 1000, reason: 'stop' }]);
    expect(timers.pending.size).toBe(0);
    ws.instances[0].serverClose(1000);
    timers.advance(10 * 60_000);
    expect(ws.instances).toHaveLength(1);
    expect(stream.state().state).toBe('stopped');
    expect(states.filter((s) => s.event === 'state').at(-1).state).toBe('stopped');
    stream.stop(); // idempoten
    expect(() => stream.start()).toThrow(/dihentikan/);
  });

  it('EDGE-WSC-006 stop() saat menunggu reconnect membatalkan timer', () => {
    const { stream, last, timers, ws } = setup();
    stream.start();
    last().serverClose();
    expect(timers.pending.size).toBe(1);
    stream.stop();
    expect(timers.pending.size).toBe(0);
    timers.advance(120_000);
    expect(ws.instances).toHaveLength(1);
  });
});
