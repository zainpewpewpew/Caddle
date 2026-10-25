import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BinanceApiError, BinanceDataError, ERROR_CODES } from '../../../backend/ingestion/binance/errors.js';
import { createBinanceRestClient, resolveBaseUrl } from '../../../backend/ingestion/binance/restClient.js';

// Semua respons berasal dari fake fetch dengan fixture sintetis — bukan data pasar nyata.
// Tidak ada request jaringan sungguhan di tes ini.
const fixture = (name) => JSON.parse(readFileSync(new URL(`../../fixtures/binance/${name}`, import.meta.url), 'utf8'));
const ERRORS = fixture('errors.json');

const T0 = Date.UTC(2026, 0, 1, 0, 0, 10); // 10 detik setelah batas menit
const FIVE_MIN = 5 * 60_000;

/** Response-like minimal: { ok, status, headers: { get() }, json() }. */
function response(status, body, headers = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => h.get(String(name).toLowerCase()) ?? null },
    json: async () => {
      if (body instanceof Error) throw body;
      return body;
    },
  };
}
const fromFixture = (fx) => response(fx.status, fx.body, fx.headers);

/** Fake fetch berantrian: item = Response-like | Error (dilempar) | fungsi (url, init) → Response-like. */
function createFakeFetch(queue) {
  const items = [...queue];
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: new URL(url), init });
    if (items.length === 0) throw new Error('fetch tak terduga (antrian habis)');
    const item = items.shift();
    if (item instanceof Error) throw item;
    return typeof item === 'function' ? item(url, init) : item;
  };
  fetch.calls = calls;
  return fetch;
}

function createTime(start = T0) {
  let now = start;
  const sleeps = [];
  return {
    clock: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
    advance: (ms) => { now += ms; },
    sleeps,
  };
}

const silentLogger = () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() });

function makeClient(queue, options = {}) {
  const fetch = createFakeFetch(queue);
  const time = createTime(options.start);
  const logger = silentLogger();
  const client = createBinanceRestClient({
    fetch, clock: time.clock, sleep: time.sleep, logger, random: () => 0.5, ...options.client,
  });
  return { client, fetch, time, logger };
}

const okKlines = () => fromFixture(fixture('klines-btcusdt-5m.json'));
const hangUntilAbort = (_url, init) => new Promise((_resolve, reject) => {
  init.signal.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
});

describe('klien REST Binance — endpoint & parsing', () => {
  it('UNIT-BNR-001 getServerTime: GET /fapi/v1/time ke host allowlist, tanpa redirect & tanpa kredensial', async () => {
    const { client, fetch } = makeClient([response(200, { serverTime: 1767225610000 })]);
    expect(await client.getServerTime()).toBe(1767225610000);
    const [{ url, init }] = fetch.calls;
    expect(url.href).toBe('https://fapi.binance.com/fapi/v1/time');
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(init.headers).map((k) => k.toLowerCase())).not.toContain('x-mbx-apikey');
  });

  it('UNIT-BNR-002 getKlines: parameter query benar, Candle kanonik, isClosed dari clock', async () => {
    const start = Date.UTC(2026, 0, 1, 0, 0, 0);
    const { client, fetch } = makeClient([okKlines()], { start: start + 2 * FIVE_MIN + 10_000 });
    const candles = await client.getKlines({ symbol: 'BTCUSDT', timeframe: '5m', startTime: start, endTime: start + 3 * FIVE_MIN - 1, limit: 3 });
    const { url } = fetch.calls[0];
    expect(url.origin + url.pathname).toBe('https://fapi.binance.com/fapi/v1/klines');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      symbol: 'BTCUSDT', interval: '5m', startTime: String(start), endTime: String(start + 3 * FIVE_MIN - 1), limit: '3',
    });
    expect(candles.map((c) => c.isClosed)).toEqual([true, true, false]);
    expect(candles.every((c) => c.source === 'rest' && c.symbol === 'BTCUSDT' && c.timeframe === '5m')).toBe(true);
    expect(candles[0]).toMatchObject({ open: 94000.1, quoteVolume: 14325678.12345, trades: 2310 });
  });

  it('UNIT-BNR-003 getKlines default limit 500; startTime/endTime opsional tidak dikirim', async () => {
    const { client, fetch } = makeClient([response(200, [])]);
    expect(await client.getKlines({ symbol: '1000PEPEUSDT', timeframe: '1h' })).toEqual([]);
    expect(Object.fromEntries(fetch.calls[0].url.searchParams)).toEqual({ symbol: '1000PEPEUSDT', interval: '1h', limit: '500' });
  });

  it('UNIT-BNR-004 getExchangeInfo, get24hTickers, getBookTickers → bentuk kontrak', async () => {
    const { client, fetch } = makeClient([
      fromFixture(fixture('exchangeInfo.json')), fromFixture(fixture('ticker24hr.json')), fromFixture(fixture('bookTicker.json')),
    ]);
    const infos = await client.getExchangeInfo();
    expect(infos.find((s) => s.symbol === 'BTCUSDT')).toMatchObject({ tickSize: '0.10', stepSize: '0.001', contractType: 'PERPETUAL' });
    const tickers = await client.get24hTickers();
    expect(tickers.find((t) => t.symbol === 'BTCUSDT').quoteVolume).toBe(15_000_000_000);
    const books = await client.getBookTickers();
    expect(books.find((b) => b.symbol === 'BTCUSDT').spreadBps).toBeCloseTo((0.1 / 94000.05) * 10_000, 9);
    expect(fetch.calls.map((c) => c.url.pathname)).toEqual(['/fapi/v1/exchangeInfo', '/fapi/v1/ticker/24hr', '/fapi/v1/ticker/bookTicker']);
    expect(fetch.calls.every((c) => c.url.search === '')).toBe(true);
  });

  it('EDGE-BNR-001 harga string sangat kecil ("0.00001234") tetap presisi lewat klien', async () => {
    const { client } = makeClient([fromFixture(fixture('klines-tinyusdt-1h.json'))], { start: Date.UTC(2026, 0, 1, 2, 0, 0) });
    const [a] = await client.getKlines({ symbol: 'TINYUSDT', timeframe: '1h', limit: 2 });
    expect(a.close).toBe(0.00001234);
    expect(a.high).toBe(0.0000124);
  });

  it('NEG-BNR-001 baris kline rusak → BinanceDataError, tidak diulang dan tidak dibuang diam-diam', async () => {
    const body = fixture('klines-btcusdt-5m.json').body;
    body[1] = [...body[1]];
    body[1][2] = '1.00'; // high < low
    const { client, fetch, time } = makeClient([response(200, body)]);
    const err = await client.getKlines({ symbol: 'BTCUSDT', timeframe: '5m' }).catch((e) => e);
    expect(err).toBeInstanceOf(BinanceDataError);
    expect(err.issues).toContainEqual(expect.objectContaining({ index: 1, field: 'high' }));
    expect(fetch.calls).toHaveLength(1);
    expect(time.sleeps).toEqual([]);
  });

  it('NEG-BNR-002 parameter klines tidak valid ditolak sebelum request (tanpa fetch)', async () => {
    const { client, fetch } = makeClient([]);
    for (const symbol of ['btcusdt', 'BTC/USDT', 'BTCUSDT&limit=1', '', 'X', 'BTC USDT', '币安人生USDT', 42]) {
      await expect(client.getKlines({ symbol, timeframe: '5m' })).rejects.toThrow(TypeError);
    }
    await expect(client.getKlines({ symbol: 'BTCUSDT', timeframe: '4h' })).rejects.toThrow(TypeError);
    for (const limit of [0, 1501, 1.5, '500']) {
      await expect(client.getKlines({ symbol: 'BTCUSDT', timeframe: '5m', limit })).rejects.toThrow(RangeError);
    }
    await expect(client.getKlines({ symbol: 'BTCUSDT', timeframe: '5m', startTime: -1 })).rejects.toThrow(RangeError);
    await expect(client.getKlines({ symbol: 'BTCUSDT', timeframe: '5m', startTime: 10, endTime: 5 })).rejects.toThrow(RangeError);
    await expect(client.getKlines()).rejects.toThrow(TypeError);
    expect(fetch.calls).toHaveLength(0);
  });

  it('NEG-BNR-003 simbol tidak dikenal Binance (400, -1121) → BinanceApiError tidak diulang', async () => {
    const { client, fetch, time } = makeClient([fromFixture(ERRORS.invalidSymbol)]);
    const err = await client.getKlines({ symbol: 'NOPEUSDT', timeframe: '5m' }).catch((e) => e);
    expect(err).toBeInstanceOf(BinanceApiError);
    expect(err).toMatchObject({ status: 400, code: -1121, retryable: false, retryAfterMs: null, path: '/fapi/v1/klines' });
    expect(err.message).toContain('Invalid symbol.');
    expect(fetch.calls).toHaveLength(1);
    expect(time.sleeps).toEqual([]);
  });

  it('NEG-BNR-004 4xx lain (403 WAF, 451) tidak diulang; pesan eksternal dibersihkan', async () => {
    const { client, fetch } = makeClient([
      response(403, { code: -1, msg: 'blocked\n\u001b[31mfake log line' }),
      response(451, new SyntaxError('bukan JSON')),
    ]);
    const e1 = await client.getServerTime().catch((e) => e);
    expect(e1).toMatchObject({ status: 403, retryable: false });
    expect(e1.message).not.toContain('\n');
    expect(e1.message).not.toContain('\u001b');
    expect(e1.message).toContain('blocked');
    const e2 = await client.getServerTime().catch((e) => e);
    expect(e2).toMatchObject({ status: 451, code: ERROR_CODES.HTTP_ERROR, retryable: false });
    expect(fetch.calls).toHaveLength(2);
  });

  it('NEG-BNR-005 respons 200 bukan JSON / bukan Response-like → BAD_RESPONSE tidak diulang', async () => {
    const { client, fetch } = makeClient([response(200, new SyntaxError('Unexpected token <')), { status: 200 }]);
    await expect(client.getServerTime()).rejects.toMatchObject({ code: ERROR_CODES.BAD_RESPONSE, retryable: false, status: 200 });
    await expect(client.getServerTime()).rejects.toMatchObject({ code: ERROR_CODES.BAD_RESPONSE, retryable: false });
    expect(fetch.calls).toHaveLength(2);
  });
});

describe('klien REST Binance — retry, rate limit, timeout', () => {
  it('UNIT-BNR-005 429 dengan Retry-After (detik) → tunggu sesuai header lalu ulang dan sukses', async () => {
    const { client, fetch, time, logger } = makeClient([fromFixture(ERRORS.rateLimited), response(200, { serverTime: 1 })]);
    expect(await client.getServerTime()).toBe(1);
    expect(time.sleeps).toEqual([50_000]); // fixture: Retry-After 50 detik, 10 detik setelah batas menit
    expect(fetch.calls).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ status: 429, delayMs: 50_000, path: '/fapi/v1/time' }), expect.any(String));
  });

  it('UNIT-BNR-006 429 Retry-After berupa HTTP-date dihormati', async () => {
    const { client, time } = makeClient([
      response(429, { code: -1003, msg: 'Too many requests' }, { 'Retry-After': new Date(T0 + 5_000).toUTCString() }),
      response(200, { serverTime: 1 }),
    ]);
    await client.getServerTime();
    expect(time.sleeps).toEqual([5_000]);
  });

  it('NEG-BNR-006 429 dengan Retry-After panjang → langsung error retryable + retryAfterMs; request lain ditahan tanpa fetch', async () => {
    const { client, fetch, time } = makeClient([
      response(429, { code: -1003, msg: 'Too many requests' }, { 'Retry-After': '120' }),
      response(200, { serverTime: 2 }),
    ]);
    const err = await client.getServerTime().catch((e) => e);
    expect(err).toMatchObject({ status: 429, code: -1003, retryable: true, retryAfterMs: 120_000 });
    const blocked = await client.getExchangeInfo().catch((e) => e);
    expect(blocked).toMatchObject({ code: ERROR_CODES.RATE_LIMIT_BLOCKED, retryable: true, retryAfterMs: 120_000, status: 429 });
    expect(fetch.calls).toHaveLength(1);
    time.advance(120_000);
    expect(await client.getServerTime()).toBe(2);
    expect(time.sleeps).toEqual([]);
  });

  it('NEG-BNR-007 418 (IP diblokir) → error retryable dengan retryAfterMs, tidak diulang otomatis, klien fail-fast sampai ban berakhir', async () => {
    const { client, fetch, time, logger } = makeClient([fromFixture(ERRORS.ipBanned), response(200, { serverTime: 3 })]);
    const err = await client.getServerTime().catch((e) => e);
    expect(err).toBeInstanceOf(BinanceApiError);
    expect(err).toMatchObject({ status: 418, code: -1003, retryable: true, retryAfterMs: 120_000 });
    expect(fetch.calls).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ status: 418, banMs: 120_000 }), expect.any(String));
    await expect(client.get24hTickers()).rejects.toMatchObject({ code: ERROR_CODES.RATE_LIMIT_BLOCKED, status: 418 });
    expect(fetch.calls).toHaveLength(1);
    time.advance(120_000);
    expect(await client.getServerTime()).toBe(3);
    expect(time.sleeps).toEqual([]);
  });

  it('EDGE-BNR-002 418 tanpa Retry-After tetap memblokir (default 2 menit)', async () => {
    const { client, fetch, time } = makeClient([response(418, { code: -1003, msg: 'banned' }), response(200, { serverTime: 4 })]);
    const err = await client.getServerTime().catch((e) => e);
    expect(err).toMatchObject({ status: 418, code: -1003, retryable: true, retryAfterMs: null });
    await expect(client.getServerTime()).rejects.toMatchObject({ code: ERROR_CODES.RATE_LIMIT_BLOCKED, retryAfterMs: 120_000 });
    time.advance(120_000);
    expect(await client.getServerTime()).toBe(4);
    expect(fetch.calls).toHaveLength(2);
  });

  it('EDGE-BNR-005 429 tanpa Retry-After → backoff (semua request ditahan lewat limiter) lalu sukses', async () => {
    const { client, fetch, time } = makeClient([response(429, { code: -1003, msg: 'Too many requests' }), response(200, { serverTime: 10 })]);
    expect(await client.getServerTime()).toBe(10);
    expect(time.sleeps).toEqual([375]);
    expect(fetch.calls).toHaveLength(2);
  });

  it('UNIT-BNR-007 500 lalu sukses → backoff eksponensial dengan jitter deterministik', async () => {
    const { client, fetch, time } = makeClient([response(500, { code: -1000, msg: 'An unknown error occurred' }), response(200, { serverTime: 5 })]);
    expect(await client.getServerTime()).toBe(5);
    expect(time.sleeps).toEqual([375]); // base 500 ms: 250 + 0.5 × 250
    expect(fetch.calls).toHaveLength(2);
  });

  it('UNIT-BNR-008 backoff berlipat per percobaan (5xx berulang) dan jitter mengikuti fungsi random', async () => {
    const { client, time } = makeClient([
      fromFixture(ERRORS.serverError), fromFixture(ERRORS.serverError), fromFixture(ERRORS.serverError), response(200, { serverTime: 6 }),
    ]);
    expect(await client.getServerTime()).toBe(6);
    expect(time.sleeps).toEqual([375, 750, 1500]);

    const low = makeClient([response(502, null), response(200, { serverTime: 7 })], { client: { random: () => 0 } });
    await low.client.getServerTime();
    expect(low.time.sleeps).toEqual([250]);
  });

  it('NEG-BNR-008 maxRetries habis → error 5xx retryable dilempar; jumlah percobaan = maxRetries + 1', async () => {
    const queue = Array.from({ length: 3 }, () => response(503, { code: -1001, msg: 'Internal error' }));
    const { client, fetch, time } = makeClient(queue, { client: { maxRetries: 2 } });
    const err = await client.getServerTime().catch((e) => e);
    expect(err).toMatchObject({ status: 503, code: -1001, retryable: true });
    expect(fetch.calls).toHaveLength(3);
    expect(time.sleeps).toEqual([375, 750]);

    const none = makeClient([response(500, {})], { client: { maxRetries: 0 } });
    await expect(none.client.getServerTime()).rejects.toMatchObject({ status: 500 });
    expect(none.fetch.calls).toHaveLength(1);
    expect(none.time.sleeps).toEqual([]);
  });

  it('NEG-BNR-009 timeout (AbortController) → TIMEOUT retryable, diulang, lalu dilempar', async () => {
    const { client, fetch, time } = makeClient([hangUntilAbort, hangUntilAbort], { client: { timeoutMs: 15, maxRetries: 1 } });
    const err = await client.getServerTime().catch((e) => e);
    expect(err).toBeInstanceOf(BinanceApiError);
    expect(err).toMatchObject({ code: ERROR_CODES.TIMEOUT, status: null, retryable: true });
    expect(fetch.calls).toHaveLength(2);
    expect(fetch.calls.every((c) => c.init.signal.aborted)).toBe(true);
    expect(time.sleeps).toEqual([375]);
  });

  it('EDGE-BNR-003 timeout tetap berlaku bila fetch/body mengabaikan signal; timeout lalu sukses', async () => {
    const stuckBody = { ok: true, status: 200, headers: { get: () => null }, json: () => new Promise(() => {}) };
    const { client, fetch } = makeClient([() => new Promise(() => {}), stuckBody, response(200, { serverTime: 8 })], { client: { timeoutMs: 15, maxRetries: 2 } });
    expect(await client.getServerTime()).toBe(8);
    expect(fetch.calls).toHaveLength(3);
  });

  it('NEG-BNR-010 error jaringan → diulang; bila tetap gagal → NETWORK retryable', async () => {
    const netErr = () => new TypeError('fetch failed');
    const ok = makeClient([netErr(), response(200, { serverTime: 9 })]);
    expect(await ok.client.getServerTime()).toBe(9);
    const bad = makeClient([netErr(), netErr()], { client: { maxRetries: 1 } });
    await expect(bad.client.getServerTime()).rejects.toMatchObject({ code: ERROR_CODES.NETWORK, status: null, retryable: true });
    expect(bad.fetch.calls).toHaveLength(2);
  });

  it('UNIT-BNR-009 pembatasan bobot perkiraan memanggil sleep sebelum melewati maxWeightPerMinute', async () => {
    const empty = () => response(200, []);
    const { client, time } = makeClient([empty(), empty(), response(200, []), response(200, { serverTime: 1 })], { client: { maxWeightPerMinute: 50 } });
    await client.get24hTickers(); // 40
    await client.getBookTickers(); // 45
    await client.getKlines({ symbol: 'BTCUSDT', timeframe: '5m', limit: 1000 }); // 50 — tepat batas
    expect(time.sleeps).toEqual([]);
    expect(client.usedWeight()).toBe(50);
    await client.getServerTime(); // 51 > 50 → tunggu menit berikutnya
    expect(time.sleeps).toEqual([50_000]);
    expect(client.usedWeight()).toBe(1);
  });

  it('UNIT-BNR-010 header X-MBX-USED-WEIGHT-1M dilacak dan menahan request berikutnya', async () => {
    const { client, time } = makeClient([
      response(200, { serverTime: 1 }, { 'X-MBX-USED-WEIGHT-1M': '1795' }),
      response(200, [], { 'x-mbx-used-weight-1m': '40' }),
    ]);
    await client.getServerTime();
    expect(client.usedWeight()).toBe(1795);
    await client.get24hTickers(); // 1795 + 40 > 1800
    expect(time.sleeps).toEqual([50_000]);
    expect(client.usedWeight()).toBe(40);
  });

  it('EDGE-BNR-004 bobot klines mengikuti limit (99 → 1, 100 → 2, 1500 → 10)', async () => {
    const { client } = makeClient([response(200, []), response(200, []), response(200, [])]);
    await client.getKlines({ symbol: 'BTCUSDT', timeframe: '5m', limit: 99 });
    expect(client.usedWeight()).toBe(1);
    await client.getKlines({ symbol: 'BTCUSDT', timeframe: '5m', limit: 100 });
    expect(client.usedWeight()).toBe(3);
    await client.getKlines({ symbol: 'BTCUSDT', timeframe: '5m', limit: 1500 });
    expect(client.usedWeight()).toBe(13);
  });
});

describe('klien REST Binance — sampel waktu server (sinkronisasi jam)', () => {
  it('UNIT-BNR-011 sampleServerTime: 429 Retry-After 4 d → langsung dilempar tanpa retry/tidur; sampel berikutnya menunggu limiter 4 d DULU, stempel sentAt/receivedAt dengan jam pemanggil diambil sesudahnya', async () => {
    const { client, fetch, time, logger } = makeClient([
      response(429, { code: -1003, msg: 'Too many requests' }, { 'Retry-After': '4' }),
      () => {
        time.advance(120); // request yang berhasil memakan 120 ms
        return response(200, { serverTime: 1767225615000 });
      },
    ]);
    const err = await client.sampleServerTime().catch((e) => e);
    expect(err).toMatchObject({ status: 429, retryable: true, retryAfterMs: 4_000 });
    expect(time.sleeps).toEqual([]);
    expect(fetch.calls).toHaveLength(1);
    expect(logger.warn).not.toHaveBeenCalled();

    const local = vi.fn(() => time.clock() - 50_000); // jam lokal pemanggil (berbeda dari jam klien)
    const sample = await client.sampleServerTime({ clock: local });
    expect(time.sleeps).toEqual([4_000]); // antrean limiter (Retry-After) terjadi SEBELUM sentAt
    expect(sample).toEqual({ serverTime: 1767225615000, sentAt: T0 + 4_000 - 50_000, receivedAt: T0 + 4_120 - 50_000 });
    expect(fetch.calls.map((c) => c.url.pathname)).toEqual(['/fapi/v1/time', '/fapi/v1/time']);
  });

  it('NEG-BNR-013 sampleServerTime: 503 / error jaringan → dilempar setelah SATU percobaan (tanpa backoff); serverTime tidak valid → BinanceDataError; clock bukan fungsi ditolak', async () => {
    const { client, fetch, time } = makeClient([
      response(503, { code: -1001, msg: 'Internal error' }),
      new TypeError('fetch failed'),
      response(200, { serverTime: 'x' }),
    ]);
    await expect(client.sampleServerTime()).rejects.toMatchObject({ status: 503, retryable: true });
    await expect(client.sampleServerTime()).rejects.toMatchObject({ code: ERROR_CODES.NETWORK, retryable: true });
    await expect(client.sampleServerTime()).rejects.toBeInstanceOf(BinanceDataError);
    expect(fetch.calls).toHaveLength(3);
    expect(time.sleeps).toEqual([]);
    await expect(client.sampleServerTime({ clock: 5 })).rejects.toThrow(TypeError);
  });
});

describe('klien REST Binance — allowlist host & opsi', () => {
  it('NEG-BNR-011 baseUrl di luar allowlist / tidak aman ditolak saat pembuatan klien', () => {
    const fetch = createFakeFetch([]);
    for (const baseUrl of [
      'https://evil.example.com', 'http://fapi.binance.com', 'https://fapi.binance.com.evil.com', 'https://api.binance.com',
      'https://user:pw@fapi.binance.com', 'https://fapi.binance.com:8443', 'https://fapi.binance.com/proxy',
      'https://fapi.binance.com/?x=1', 'https://fapi.binance.com/#a', 'wss://fstream.binance.com', 'bukan url', '', 42, null,
    ]) {
      expect(() => createBinanceRestClient({ fetch, baseUrl, sleep: async () => {} }), String(baseUrl)).toThrow(TypeError);
    }
    expect(fetch.calls).toHaveLength(0);
  });

  it('POS-BNR-001 allowedHosts eksplisit (khusus tes) mengizinkan host lain; host default & trailing slash diterima', async () => {
    expect(resolveBaseUrl('https://fapi.binance.com/')).toBe('https://fapi.binance.com');
    expect(resolveBaseUrl('https://FAPI.binance.com')).toBe('https://fapi.binance.com');
    expect(() => resolveBaseUrl('https://fapi.binance.com', ['fapi.test.local'])).toThrow(TypeError);
    const { client, fetch } = makeClient([response(200, { serverTime: 1 })], {
      client: { baseUrl: 'https://fapi.test.local', allowedHosts: ['fapi.test.local'] },
    });
    await client.getServerTime();
    expect(fetch.calls[0].url.href).toBe('https://fapi.test.local/fapi/v1/time');
  });

  it('NEG-BNR-012 opsi klien tidak valid ditolak', () => {
    const fetch = createFakeFetch([]);
    const base = { fetch, sleep: async () => {} };
    expect(() => createBinanceRestClient({ ...base, fetch: 'x' })).toThrow(TypeError);
    expect(() => createBinanceRestClient({ ...base, timeoutMs: 0 })).toThrow(RangeError);
    expect(() => createBinanceRestClient({ ...base, maxRetries: -1 })).toThrow(RangeError);
    expect(() => createBinanceRestClient({ ...base, maxRetries: 1.5 })).toThrow(RangeError);
    expect(() => createBinanceRestClient({ ...base, maxWeightPerMinute: 0 })).toThrow(RangeError);
    expect(() => createBinanceRestClient({ ...base, allowedHosts: [] })).toThrow(TypeError);
    expect(() => createBinanceRestClient({ ...base, random: 1 })).toThrow(TypeError);
  });
});
