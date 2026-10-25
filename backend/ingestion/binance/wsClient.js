// Klien WebSocket kline Binance USDT-M Futures (combined stream).
// - Maks 200 stream per koneksi → stream dipecah ke beberapa koneksi.
// - Reconnect dengan backoff eksponensial + jitter; backoff di-reset setelah koneksi stabil.
// - Koneksi basi (tanpa pesan ≥ staleMs) atau connect yang menggantung ditutup lalu reconnect.
// - Binance memutus koneksi setiap 24 jam → rotasi terjadwal sebelum batas itu.
// - Pesan rusak dilaporkan lewat onState({ event: 'error' }) dan diabaikan, tidak pernah crash.
// Semua timer lewat setTimer/clearTimer injeksi dan jitter lewat `random` injeksi.

import { randomInt } from 'node:crypto';
import { TIMEFRAMES, expectedCloseTime, isAlignedOpenTime } from '../../market/contracts.js';

export const BINANCE_WS_BASE_URL = 'wss://fstream.binance.com';
export const ALLOWED_WS_HOSTS = Object.freeze(['fstream.binance.com']);
export const MAX_STREAMS_PER_CONNECTION = 200;
export const STREAM_STATES = Object.freeze(['idle', 'connecting', 'open', 'reconnecting', 'stopped']);

const DEFAULT_BACKOFF = Object.freeze({ initialMs: 1000, maxMs: 60_000 });
const DEFAULT_STALE_MS = 90_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_STABLE_MS = 60_000;
// Binance memutus koneksi tepat 24 jam; rotasi 10 menit lebih awal.
const DEFAULT_MAX_CONNECTION_AGE_MS = 24 * 3_600_000 - 10 * 60_000;
const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024;
// Kode close aplikasi (3000–4999) untuk penutupan karena watchdog.
const CLOSE_WATCHDOG = 4000;
const CLOSE_NORMAL = 1000;

const SYMBOL_RE = /^[A-Z0-9]{2,30}$/;
const DECIMAL_RE = /^\d+(\.\d+)?$/;
const NUMERIC_FIELDS = [
  ['open', 'o'], ['high', 'h'], ['low', 'l'], ['close', 'c'], ['volume', 'v'],
  ['quoteVolume', 'q'], ['takerBuyVolume', 'V'], ['takerBuyQuoteVolume', 'Q'],
];
const textDecoder = new TextDecoder();

/** Jitter default berbasis CSPRNG (tanpa Math.random). Mengembalikan [0, 1). */
const defaultRandom = () => randomInt(0, 1_000_000) / 1_000_000;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Nama stream kline Binance: `btcusdt@kline_5m` (simbol lowercase). */
export function streamName({ symbol, timeframe }) {
  return `${symbol.toLowerCase()}@kline_${timeframe}`;
}

function assertStream(s) {
  if (!isObject(s) || typeof s.symbol !== 'string' || !SYMBOL_RE.test(s.symbol)) {
    throw new TypeError(`Simbol stream tidak valid: ${s?.symbol}`);
  }
  if (!TIMEFRAMES.includes(s.timeframe)) throw new TypeError(`Timeframe stream tidak valid: ${s.timeframe}`);
}

function assertBaseUrl(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError('baseUrl WebSocket tidak valid');
  }
  if (url.protocol !== 'wss:') throw new TypeError('baseUrl WebSocket wajib memakai wss');
  if (!ALLOWED_WS_HOSTS.includes(url.hostname) || url.port || url.username || url.password) {
    throw new TypeError(`Host WebSocket di luar allowlist: ${url.hostname}`);
  }
  return url.origin;
}

/**
 * Membangun URL combined stream, dipecah per `maxPerConnection` stream.
 * @param {Array<{ symbol: string, timeframe: string }>} streams
 * @returns {Array<{ url: string, streams: string[] }>}
 */
export function buildStreamUrls(streams, { baseUrl = BINANCE_WS_BASE_URL, maxPerConnection = MAX_STREAMS_PER_CONNECTION } = {}) {
  if (!Number.isInteger(maxPerConnection) || maxPerConnection < 1 || maxPerConnection > MAX_STREAMS_PER_CONNECTION) {
    throw new RangeError(`maxPerConnection harus 1..${MAX_STREAMS_PER_CONNECTION}`);
  }
  const origin = assertBaseUrl(baseUrl);
  streams.forEach(assertStream);
  const names = [...new Set(streams.map(streamName))];
  const out = [];
  for (let i = 0; i < names.length; i += maxPerConnection) {
    const group = names.slice(i, i + maxPerConnection);
    out.push({ url: `${origin}/stream?streams=${group.join('/')}`, streams: group });
  }
  return out;
}

/**
 * Backoff eksponensial dengan "equal jitter": base = min(maxMs, initialMs·2^attempt),
 * hasil di [base/2, base]. Tidak pernah melebihi maxMs.
 * @param {number} attempt percobaan ke-n sejak koneksi stabil terakhir (mulai 0)
 * @param {{ initialMs: number, maxMs: number }} backoff
 * @param {() => number} random nilai [0, 1)
 */
export function computeBackoff(attempt, { initialMs, maxMs }, random) {
  const base = Math.min(maxMs, initialMs * 2 ** Math.min(attempt, 30));
  return Math.round(base / 2 + random() * (base / 2));
}

function toNumber(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? raw : null;
  if (typeof raw === 'string' && DECIMAL_RE.test(raw)) return Number(raw);
  return null;
}

/**
 * Mem-parse satu pesan teks combined stream (`{ stream, data }`) atau event kline mentah.
 * Hanya validasi bentuk; konsistensi OHLC divalidasi lagi di lapisan penyimpanan.
 * @param {string} raw
 * @returns {{ ok: true, stream: string, candle: import('../../market/contracts.js').Candle } | { ok: false, error: string }}
 */
export function parseKlineMessage(raw) {
  const fail = (error) => ({ ok: false, error });
  if (typeof raw !== 'string') return fail('pesan bukan teks');
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return fail('JSON tidak valid');
  }
  if (!isObject(msg)) return fail('pesan bukan objek');
  const event = isObject(msg.data) ? msg.data : msg;
  if (event.e !== 'kline' || !isObject(event.k)) return fail('bukan event kline');

  const k = event.k;
  if (typeof k.s !== 'string' || !SYMBOL_RE.test(k.s)) return fail('simbol tidak valid');
  if (event.s !== undefined && event.s !== k.s) return fail('simbol event tidak konsisten');
  if (!TIMEFRAMES.includes(k.i)) return fail('interval tidak didukung');
  if (!isAlignedOpenTime(k.t, k.i)) return fail('openTime tidak valid');
  if (k.T !== expectedCloseTime(k.t, k.i)) return fail('closeTime tidak konsisten');
  if (typeof k.x !== 'boolean') return fail('flag x tidak valid');
  if (!Number.isSafeInteger(k.n) || k.n < 0) return fail('jumlah trade tidak valid');

  const values = {};
  for (const [field, key] of NUMERIC_FIELDS) {
    const value = toNumber(k[key]);
    if (value === null) return fail(`field ${key} bukan angka valid`);
    values[field] = value;
  }

  const stream = streamName({ symbol: k.s, timeframe: k.i });
  if (msg !== event && msg.stream !== stream) return fail('nama stream tidak cocok dengan isi event');

  return {
    ok: true,
    stream,
    candle: {
      symbol: k.s,
      timeframe: k.i,
      openTime: k.t,
      closeTime: k.T,
      open: values.open,
      high: values.high,
      low: values.low,
      close: values.close,
      volume: values.volume,
      quoteVolume: values.quoteVolume,
      trades: k.n,
      takerBuyVolume: values.takerBuyVolume,
      takerBuyQuoteVolume: values.takerBuyQuoteVolume,
      isClosed: k.x,
      source: 'ws',
    },
  };
}

function decodeData(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return textDecoder.decode(data);
  if (ArrayBuffer.isView(data)) return textDecoder.decode(data);
  return null;
}

const errorMessage = (err) => String(err?.message ?? err).slice(0, 300);

/**
 * Membuat stream kline Binance.
 * @param {{
 *   WebSocketImpl?: any, baseUrl?: string, streams: Array<{ symbol: string, timeframe: string }>,
 *   onCandle: (candle: import('../../market/contracts.js').Candle) => void, onState?: (snapshot: object) => void,
 *   clock?: () => number, setTimer?: Function, clearTimer?: Function, random?: () => number,
 *   backoff?: { initialMs: number, maxMs: number }, staleMs?: number, connectTimeoutMs?: number,
 *   stableMs?: number, maxConnectionAgeMs?: number, maxMessageBytes?: number, maxStreamsPerConnection?: number,
 * }} options
 * @returns {{ start(): void, stop(): void, state(): object }}
 */
export function createKlineStream({
  WebSocketImpl = globalThis.WebSocket,
  baseUrl = BINANCE_WS_BASE_URL,
  streams,
  onCandle,
  onState = () => {},
  clock = Date.now,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
  random = defaultRandom,
  backoff = DEFAULT_BACKOFF,
  staleMs = DEFAULT_STALE_MS,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  stableMs = DEFAULT_STABLE_MS,
  maxConnectionAgeMs = DEFAULT_MAX_CONNECTION_AGE_MS,
  maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
  maxStreamsPerConnection = MAX_STREAMS_PER_CONNECTION,
}) {
  if (typeof WebSocketImpl !== 'function') throw new TypeError('WebSocketImpl wajib berupa constructor');
  if (typeof onCandle !== 'function') throw new TypeError('onCandle wajib berupa fungsi');
  if (!Array.isArray(streams) || streams.length === 0) throw new RangeError('streams tidak boleh kosong');
  if (!(backoff.initialMs > 0) || !(backoff.maxMs >= backoff.initialMs)) throw new RangeError('backoff tidak valid');

  const conns = buildStreamUrls(streams, { baseUrl, maxPerConnection: maxStreamsPerConnection }).map((c, id) => ({
    id,
    url: c.url,
    streams: new Set(c.streams),
    state: 'idle',
    socket: null,
    attempt: 0,
    openedAt: null,
    connectStartedAt: null,
    lastMessageAt: null,
    watchdog: null,
    retryTimer: null,
    rotateTimer: null,
  }));
  const totalStreams = conns.reduce((n, c) => n + c.streams.size, 0);

  let started = false;
  let stopped = false;
  let reconnects = 0;
  let messages = 0;
  let parseErrors = 0;
  let lastMessageAt = null;
  let lastEmitted = null;

  function aggregateState() {
    if (stopped) return 'stopped';
    if (!started) return 'idle';
    if (conns.every((c) => c.state === 'open')) return 'open';
    if (conns.some((c) => c.state === 'reconnecting')) return 'reconnecting';
    return 'connecting';
  }

  function snapshot() {
    return {
      state: aggregateState(),
      reconnects,
      connections: conns.length,
      openConnections: conns.filter((c) => c.state === 'open').length,
      streams: totalStreams,
      messages,
      parseErrors,
      lastMessageAt,
    };
  }

  function emit(extra) {
    try {
      onState({ ...snapshot(), ...extra });
    } catch {
      // onState milik pemanggil; kegagalannya tidak boleh mengganggu stream.
    }
  }

  function emitStateIfChanged() {
    const s = aggregateState();
    if (s === lastEmitted) return;
    lastEmitted = s;
    emit({ event: 'state' });
  }

  const emitError = (conn, kind, message) => emit({ event: 'error', connection: conn?.id ?? null, error: { kind, message } });

  function clearConnTimers(conn) {
    for (const key of ['watchdog', 'retryTimer', 'rotateTimer']) {
      if (conn[key] !== null) {
        clearTimer(conn[key]);
        conn[key] = null;
      }
    }
  }

  function closeSocket(socket, code, reason) {
    try {
      socket.close(code, reason);
    } catch {
      // socket mungkin sudah tertutup; abaikan.
    }
  }

  function armWatchdog(conn) {
    if (conn.watchdog !== null) clearTimer(conn.watchdog);
    const isOpen = conn.state === 'open';
    const deadline = isOpen ? conn.lastMessageAt + staleMs : conn.connectStartedAt + connectTimeoutMs;
    conn.watchdog = setTimer(() => {
      conn.watchdog = null;
      if (stopped || conn.socket === null) return;
      const due = conn.state === 'open' ? conn.lastMessageAt + staleMs : conn.connectStartedAt + connectTimeoutMs;
      if (clock() >= due) {
        drop(conn, conn.state === 'open' ? 'stale' : 'connect-timeout');
      } else {
        armWatchdog(conn);
      }
    }, Math.max(0, deadline - clock()));
  }

  function scheduleReconnect(conn, { immediate = false } = {}) {
    if (stopped) return;
    const delay = immediate ? 0 : computeBackoff(conn.attempt, backoff, random);
    if (!immediate) conn.attempt += 1;
    reconnects += 1;
    conn.state = 'reconnecting';
    conn.retryTimer = setTimer(() => {
      conn.retryTimer = null;
      connect(conn);
    }, delay);
    emitStateIfChanged();
  }

  /** Meninggalkan socket aktif (event berikutnya darinya diabaikan) lalu menjadwalkan reconnect. */
  function drop(conn, reason, code) {
    const socket = conn.socket;
    conn.socket = null;
    clearConnTimers(conn);
    if (socket !== null && reason !== 'close') {
      closeSocket(socket, reason === 'rotate' ? CLOSE_NORMAL : CLOSE_WATCHDOG, reason);
    }
    if (stopped) return;
    if (conn.openedAt !== null && clock() - conn.openedAt >= stableMs) conn.attempt = 0;
    conn.openedAt = null;
    if (reason === 'close') emit({ event: 'disconnect', connection: conn.id, code: code ?? null });
    else if (reason !== 'rotate') emitError(conn, reason, `koneksi ${conn.id}: ${reason}`);
    scheduleReconnect(conn, { immediate: reason === 'rotate' });
  }

  function handleMessage(conn, ev) {
    const now = clock();
    conn.lastMessageAt = now;
    lastMessageAt = now;
    messages += 1;

    const text = decodeData(ev?.data);
    if (text === null) {
      parseErrors += 1;
      emitError(conn, 'parse', 'tipe pesan tidak didukung');
      return;
    }
    if (text.length > maxMessageBytes) {
      parseErrors += 1;
      emitError(conn, 'parse', 'pesan terlalu besar');
      return;
    }
    const parsed = parseKlineMessage(text);
    if (!parsed.ok) {
      parseErrors += 1;
      emitError(conn, 'parse', parsed.error);
      return;
    }
    if (!conn.streams.has(parsed.stream)) {
      emitError(conn, 'unexpected', `stream tidak dilanggan: ${parsed.stream}`);
      return;
    }
    try {
      const result = onCandle(parsed.candle);
      if (result && typeof result.then === 'function') {
        result.then(undefined, (err) => emitError(conn, 'callback', errorMessage(err)));
      }
    } catch (err) {
      emitError(conn, 'callback', errorMessage(err));
    }
  }

  function connect(conn) {
    if (stopped) return;
    let socket;
    try {
      socket = new WebSocketImpl(conn.url);
    } catch (err) {
      emitError(conn, 'socket', errorMessage(err));
      scheduleReconnect(conn);
      return;
    }
    conn.socket = socket;
    conn.connectStartedAt = clock();
    if (conn.state === 'idle') conn.state = 'connecting';
    const current = () => !stopped && conn.socket === socket;

    socket.addEventListener('open', () => {
      if (!current()) return;
      const now = clock();
      conn.state = 'open';
      conn.openedAt = now;
      conn.lastMessageAt = now;
      armWatchdog(conn);
      conn.rotateTimer = setTimer(() => {
        conn.rotateTimer = null;
        if (current()) drop(conn, 'rotate');
      }, maxConnectionAgeMs);
      emitStateIfChanged();
    });
    socket.addEventListener('message', (ev) => {
      if (current()) handleMessage(conn, ev);
    });
    socket.addEventListener('close', (ev) => {
      if (current()) drop(conn, 'close', ev?.code);
    });
    socket.addEventListener('error', () => {
      if (current()) drop(conn, 'error');
    });
    armWatchdog(conn);
    emitStateIfChanged();
  }

  return {
    start() {
      if (stopped) throw new Error('Stream sudah dihentikan; buat instance baru');
      if (started) return;
      started = true;
      for (const conn of conns) connect(conn);
    },

    /** Menutup semua koneksi secara bersih; tidak ada reconnect setelahnya. Idempoten. */
    stop() {
      if (stopped) return;
      stopped = true;
      for (const conn of conns) {
        clearConnTimers(conn);
        const socket = conn.socket;
        conn.socket = null;
        conn.state = 'stopped';
        if (socket !== null) closeSocket(socket, CLOSE_NORMAL, 'stop');
      }
      emitStateIfChanged();
    },

    state: snapshot,
  };
}
