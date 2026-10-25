// Klien REST publik Binance USDT-M Futures (tanpa API key — hanya data pasar publik).
// Keamanan: host dibatasi allowlist (default hanya fapi.binance.com), https wajib, redirect
// ditolak, dan URL TIDAK PERNAH berasal dari input pengguna — path endpoint adalah konstanta
// di modul ini dan parameter query divalidasi ketat. Semua dependensi I/O diinjeksi.

import { TIMEFRAMES } from '../../market/contracts.js';
import { CLOSE_MARGIN_MS } from '../backfill.js';
import { BinanceApiError, ERROR_CODES, sanitizeText } from './errors.js';
import { parseBookTickers, parseExchangeInfo, parseKlines, parseServerTime, parseTickers24h } from './parse.js';
import { ENDPOINT_WEIGHTS, USED_WEIGHT_HEADER, createWeightLimiter, klinesWeight, parseUsedWeightHeader } from './rateLimiter.js';

export const DEFAULT_BASE_URL = 'https://fapi.binance.com';
export const DEFAULT_ALLOWED_HOSTS = Object.freeze(['fapi.binance.com']);
export const MAX_KLINES_LIMIT = 1500;
export const DEFAULT_KLINES_LIMIT = 500;

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;
// Jeda terpanjang yang boleh ditunggu di dalam satu panggilan. Retry-After lebih lama
// (mis. ban 418 berjam-jam) dikembalikan ke pemanggil sebagai error retryable.
const MAX_INLINE_WAIT_MS = 60_000;
// Ban 418 tanpa Retry-After: Binance memulai ban dari 2 menit.
const DEFAULT_BAN_MS = 120_000;
// Simbol Binance: huruf besar & angka, opsional sufiks kontrak delivery "_YYMMDD".
const SYMBOL_RE = /^[A-Z0-9]{2,30}(_\d{6})?$/;

const PATHS = Object.freeze({
  time: '/fapi/v1/time',
  exchangeInfo: '/fapi/v1/exchangeInfo',
  klines: '/fapi/v1/klines',
  ticker24h: '/fapi/v1/ticker/24hr',
  bookTicker: '/fapi/v1/ticker/bookTicker',
});

const NOOP_LOGGER = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });
const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const isEpochMs = (v) => Number.isSafeInteger(v) && v >= 0;

/**
 * Validasi baseUrl terhadap allowlist host. Hanya origin https tanpa kredensial, port
 * non-default, path, query, atau fragment yang diterima.
 * @param {string} baseUrl
 * @param {readonly string[]} [allowedHosts]
 * @returns {string} origin ternormalisasi, mis. 'https://fapi.binance.com'
 * @throws {TypeError}
 */
export function resolveBaseUrl(baseUrl, allowedHosts = DEFAULT_ALLOWED_HOSTS) {
  if (!Array.isArray(allowedHosts) || allowedHosts.length === 0 || !allowedHosts.every((h) => typeof h === 'string' && h.length > 0)) {
    throw new TypeError('allowedHosts harus array host tidak kosong');
  }
  if (typeof baseUrl !== 'string') throw new TypeError('baseUrl wajib string');
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError('baseUrl bukan URL valid');
  }
  if (url.protocol !== 'https:') throw new TypeError('baseUrl wajib https');
  if (url.username !== '' || url.password !== '') throw new TypeError('baseUrl tidak boleh memuat kredensial');
  if (url.port !== '') throw new TypeError('baseUrl tidak boleh memakai port non-default');
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') throw new TypeError('baseUrl tidak boleh memuat path, query, atau fragment');
  const allowed = allowedHosts.map((h) => h.toLowerCase());
  if (!allowed.includes(url.hostname)) throw new TypeError(`Host ${sanitizeText(url.hostname, 64)} tidak ada di allowlist`);
  return url.origin;
}

/** Retry-After: detik (bilangan bulat) atau HTTP-date → ms; null bila tidak ada/tidak valid. */
function parseRetryAfter(value, now) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const v = value.trim();
  if (/^\d{1,9}$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

const isResponseLike = (res) => res !== null && typeof res === 'object' && typeof res.status === 'number'
  && typeof res.json === 'function' && res.headers !== null && typeof res.headers?.get === 'function';

function validateKlinesQuery({ symbol, timeframe, startTime, endTime, limit = DEFAULT_KLINES_LIMIT } = {}) {
  if (typeof symbol !== 'string' || !SYMBOL_RE.test(symbol)) throw new TypeError('Simbol tidak valid');
  if (!TIMEFRAMES.includes(timeframe)) throw new TypeError('Timeframe tidak didukung');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_KLINES_LIMIT) throw new RangeError(`limit harus bilangan bulat 1..${MAX_KLINES_LIMIT}`);
  if (startTime !== undefined && !isEpochMs(startTime)) throw new RangeError('startTime harus epoch ms bilangan bulat ≥ 0');
  if (endTime !== undefined && !isEpochMs(endTime)) throw new RangeError('endTime harus epoch ms bilangan bulat ≥ 0');
  if (startTime !== undefined && endTime !== undefined && startTime > endTime) throw new RangeError('startTime tidak boleh melewati endTime');
  return { symbol, timeframe, startTime, endTime, limit };
}

/**
 * Buat klien REST Binance USDT-M Futures.
 * @param {{
 *   fetch?: typeof globalThis.fetch, baseUrl?: string, clock?: () => number,
 *   sleep?: (ms: number) => Promise<void>, logger?: { warn?: Function },
 *   maxWeightPerMinute?: number, timeoutMs?: number, maxRetries?: number,
 *   allowedHosts?: readonly string[], random?: () => number, closeMarginMs?: number,
 * }} [options]
 *   - `clock`: jam (sebaiknya tersinkron dengan waktu server) untuk isClosed & jendela bobot.
 *   - `closeMarginMs`: margin keamanan penutupan kline (default CLOSE_MARGIN_MS, 0..60000) — lihat getKlines.
 *   - `allowedHosts`: hanya untuk tes; produksi memakai default ['fapi.binance.com'].
 *   - `random`: sumber jitter backoff (default Math.random); injeksi agar tes deterministik.
 */
export function createBinanceRestClient({
  fetch: fetchImpl = globalThis.fetch,
  baseUrl = DEFAULT_BASE_URL,
  clock = Date.now,
  sleep = defaultSleep,
  logger = NOOP_LOGGER,
  maxWeightPerMinute = 1800,
  timeoutMs = 10_000,
  maxRetries = 3,
  allowedHosts = DEFAULT_ALLOWED_HOSTS,
  // Math.random HANYA untuk jitter backoff (menyebar waktu retry), bukan untuk keamanan.
  random = Math.random,
  closeMarginMs = CLOSE_MARGIN_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch wajib fungsi');
  if (typeof clock !== 'function' || typeof sleep !== 'function' || typeof random !== 'function') {
    throw new TypeError('clock, sleep, dan random wajib fungsi');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new RangeError('timeoutMs harus bilangan bulat ≥ 1');
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) throw new RangeError('maxRetries harus bilangan bulat 0..10');
  if (!Number.isInteger(closeMarginMs) || closeMarginMs < 0 || closeMarginMs > 60_000) {
    throw new RangeError('closeMarginMs harus bilangan bulat 0..60000');
  }
  const origin = resolveBaseUrl(baseUrl, allowedHosts);
  const limiter = createWeightLimiter({ maxWeightPerMinute, clock, sleep });
  const log = (fields, message) => { if (typeof logger?.warn === 'function') logger.warn(fields, message); };

  function buildUrl(path, params) {
    const url = new URL(path, origin);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url;
  }

  /** Backoff eksponensial dengan "equal jitter": delay/2 + random × delay/2. */
  function backoffMs(attempt) {
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
    const r = random();
    const jitter = Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : 0.5;
    return Math.round(delay / 2 + (jitter * delay) / 2);
  }

  /** Jeda sebelum percobaan ulang, atau null bila error tidak boleh diulang di sini. */
  function retryDelay(err, attempt) {
    if (!(err instanceof BinanceApiError) || !err.retryable || attempt >= maxRetries) return null;
    // 418 = IP sudah diblokir; klien yang sedang ditahan tidak mengulang sendiri.
    if (err.status === 418 || err.code === ERROR_CODES.RATE_LIMIT_BLOCKED) return null;
    const delay = err.retryAfterMs ?? backoffMs(attempt);
    return delay <= MAX_INLINE_WAIT_MS ? delay : null;
  }

  async function httpError(res, path, guard) {
    let body = null;
    try {
      body = await guard(res.json());
    } catch (err) {
      if (err instanceof BinanceApiError) throw err; // timeout saat membaca body
    }
    const status = res.status;
    const binanceCode = Number.isInteger(body?.code) ? body.code : null;
    const msg = typeof body?.msg === 'string' ? sanitizeText(body.msg) : null;
    const rateLimited = status === 429 || status === 418;
    const retryAfterMs = rateLimited ? parseRetryAfter(res.headers.get('retry-after'), clock()) : null;
    if (status === 429 && retryAfterMs !== null) limiter.blockUntil(clock() + retryAfterMs, 429);
    if (status === 418) {
      const banMs = retryAfterMs ?? DEFAULT_BAN_MS;
      limiter.blockUntil(clock() + banMs, 418);
      log({ path, status, banMs }, 'IP diblokir Binance (418); semua request ditahan');
    }

    let fallbackCode = ERROR_CODES.HTTP_ERROR;
    if (status === 429) fallbackCode = ERROR_CODES.RATE_LIMITED;
    if (status === 418) fallbackCode = ERROR_CODES.IP_BANNED;
    return new BinanceApiError(`Binance ${path} gagal: HTTP ${status}${msg ? ` — ${msg}` : ''}`, {
      status,
      code: binanceCode ?? fallbackCode,
      retryable: rateLimited || status >= 500,
      retryAfterMs,
      path,
    });
  }

  /** Satu percobaan HTTP; timeout mencakup koneksi hingga body selesai dibaca. */
  async function fetchJsonOnce(url, path, ticket) {
    const controller = new AbortController();
    const timeoutError = () => new BinanceApiError(`Binance ${path} timeout setelah ${timeoutMs} ms`, {
      code: ERROR_CODES.TIMEOUT, retryable: true, path,
    });
    let timer;
    const timedOut = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(timeoutError());
      }, timeoutMs);
    });
    // Race juga melindungi dari fetch/body yang mengabaikan AbortSignal.
    const guard = (promise) => Promise.race([promise, timedOut]);
    try {
      let res;
      try {
        res = await guard(fetchImpl(url.href, {
          method: 'GET',
          headers: { accept: 'application/json' },
          redirect: 'error',
          signal: controller.signal,
        }));
      } catch (err) {
        if (err instanceof BinanceApiError) throw err;
        if (controller.signal.aborted) throw timeoutError();
        throw new BinanceApiError(`Binance ${path} gagal: kesalahan jaringan`, { code: ERROR_CODES.NETWORK, retryable: true, path, cause: err });
      }
      if (!isResponseLike(res)) {
        throw new BinanceApiError(`Binance ${path} gagal: respons tidak valid`, { code: ERROR_CODES.BAD_RESPONSE, path });
      }
      limiter.record(parseUsedWeightHeader(res.headers.get(USED_WEIGHT_HEADER)), ticket);
      if (!res.ok) throw await httpError(res, path, guard);
      try {
        return await guard(res.json());
      } catch (err) {
        if (err instanceof BinanceApiError) throw err;
        if (controller.signal.aborted) throw timeoutError();
        if (err instanceof SyntaxError) {
          throw new BinanceApiError(`Binance ${path} gagal: body bukan JSON`, { status: res.status, code: ERROR_CODES.BAD_RESPONSE, path, cause: err });
        }
        throw new BinanceApiError(`Binance ${path} gagal: body terputus`, { status: res.status, code: ERROR_CODES.NETWORK, retryable: true, path, cause: err });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET dengan pembatas bobot + retry (429 → Retry-After; 5xx/timeout/jaringan → backoff). */
  async function request(path, params, weight) {
    const url = buildUrl(path, params);
    for (let attempt = 0; ; attempt += 1) {
      try {
        const ticket = await limiter.acquire(weight, { maxBlockWaitMs: MAX_INLINE_WAIT_MS });
        return await fetchJsonOnce(url, path, ticket);
      } catch (err) {
        const delayMs = retryDelay(err, attempt);
        if (delayMs === null) throw err;
        log({ path, attempt: attempt + 1, status: err.status, code: err.code, delayMs }, 'Request Binance gagal, diulang');
        // 429: tahan SEMUA request lewat limiter (acquire berikutnya menunggu); lainnya: tidur lokal.
        if (err.status === 429) limiter.blockUntil(clock() + delayMs, 429);
        else await sleep(delayMs);
      }
    }
  }

  return {
    /** @returns {Promise<number>} waktu server Binance (epoch ms) */
    async getServerTime() {
      return parseServerTime(await request(PATHS.time, {}, ENDPOINT_WEIGHTS.time));
    },

    /**
     * Satu sampel waktu server untuk sinkronisasi jam (backend/ingestion/serverClock.js): SATU percobaan,
     * tanpa retry/backoff. `sentAt`/`receivedAt` diambil dengan `clock` pemanggil SETELAH antrean pembatas
     * bobot (acquire), tepat sebelum fetch dan tepat setelah body terbaca — jeda limiter, Retry-After, dan
     * backoff tidak pernah masuk round-trip. Error (termasuk 429/5xx) langsung dilempar; 429 dengan
     * Retry-After dan 418 tetap menahan limiter seperti request lain.
     * @param {{ clock?: () => number }} [options] jam untuk stempel (default jam klien)
     * @returns {Promise<{ serverTime: number, sentAt: number, receivedAt: number }>}
     */
    async sampleServerTime({ clock: sampleClock = clock } = {}) {
      if (typeof sampleClock !== 'function') throw new TypeError('clock wajib fungsi');
      const ticket = await limiter.acquire(ENDPOINT_WEIGHTS.time, { maxBlockWaitMs: MAX_INLINE_WAIT_MS });
      const sentAt = sampleClock();
      const body = await fetchJsonOnce(buildUrl(PATHS.time, {}), PATHS.time, ticket);
      const receivedAt = sampleClock();
      return { serverTime: parseServerTime(body), sentAt, receivedAt };
    },

    /** @returns {Promise<import('./parse.js').SymbolInfo[]>} */
    async getExchangeInfo() {
      return parseExchangeInfo(await request(PATHS.exchangeInfo, {}, ENDPOINT_WEIGHTS.exchangeInfo));
    },

    /**
     * Ambil kline; source 'rest'. isClosed = closeTime < (clock() saat request DIMULAI − closeMarginMs):
     * snapshot Binance diambil setelah request dikirim, jadi hanya candle yang sudah tertutup sebelum itu
     * (dengan margin untuk galat jam & finalisasi bursa) yang pasti final. Jam dibaca SEBELUM antrean
     * limiter/retry — membaca jam setelah respons akan menandai snapshot candle berjalan sebagai tertutup.
     * @param {{ symbol: string, timeframe: '5m'|'15m'|'1h', startTime?: number, endTime?: number, limit?: number }} query
     * @returns {Promise<import('../../market/contracts.js').Candle[]>}
     */
    async getKlines(query) {
      const q = validateKlinesQuery(query);
      const closedBefore = clock() - closeMarginMs;
      const body = await request(PATHS.klines, {
        symbol: q.symbol, interval: q.timeframe, startTime: q.startTime, endTime: q.endTime, limit: q.limit,
      }, klinesWeight(q.limit));
      return parseKlines(body, { symbol: q.symbol, timeframe: q.timeframe, now: closedBefore });
    },

    /** @returns {Promise<import('./parse.js').Ticker24h[]>} semua simbol */
    async get24hTickers() {
      return parseTickers24h(await request(PATHS.ticker24h, {}, ENDPOINT_WEIGHTS.ticker24hAll));
    },

    /** @returns {Promise<import('./parse.js').BookTicker[]>} semua simbol, dengan spreadBps */
    async getBookTickers() {
      return parseBookTickers(await request(PATHS.bookTicker, {}, ENDPOINT_WEIGHTS.bookTickerAll));
    },

    /** Bobot terpakai di jendela menit berjalan (perkiraan lokal ∨ header Binance). */
    usedWeight() {
      return limiter.usedWeight();
    },
  };
}
