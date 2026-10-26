import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cacheFilePath, findGaps, inferCsvMeta, listTopSymbols, loadFromBinance, loadFromCsv, monthsInRange, parseKlineCsv, toEpochMs,
} from '../../../backend/backtest/dataSource.js';
import { createBinanceRestClient } from '../../../backend/ingestion/binance/restClient.js';
import { parseBookTickers, parseExchangeInfo, parseTickers24h } from '../../../backend/ingestion/binance/parse.js';

// Semua data berasal dari fake client / fixture sintetis — tanpa jaringan.
const fixture = (name) => JSON.parse(readFileSync(new URL(`../../fixtures/binance/${name}`, import.meta.url), 'utf8'));
const HOUR = 3_600_000;
const NOW = Date.UTC(2024, 3, 15, 12, 0, 0); // pertengahan April 2024

/** Fake klien: candle 1h deterministik untuk setiap openTime yang diminta; mencatat setiap panggilan. */
function fakeClient({ now = NOW, missing = new Set() } = {}) {
  const calls = [];
  return {
    calls,
    async getKlines({ symbol, timeframe, startTime, endTime, limit }) {
      calls.push({ symbol, timeframe, startTime, endTime, limit });
      const out = [];
      for (let t = startTime; t <= endTime && out.length < limit; t += HOUR) {
        if (t + HOUR - 1 >= now + HOUR) break; // bursa belum punya candle masa depan
        if (missing.has(t)) continue;
        const p = 100 + ((t / HOUR) % 50);
        out.push({
          symbol, timeframe, openTime: t, closeTime: t + HOUR - 1, open: p, high: p + 2, low: p - 2, close: p + 1,
          volume: 10, quoteVolume: 1000, trades: 5, takerBuyVolume: 6, takerBuyQuoteVolume: 600,
          isClosed: t + HOUR - 1 < now, source: 'rest',
        });
      }
      return out;
    },
  };
}

let dir;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'bt-ds-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('utilitas waktu', () => {
  it('UNIT-BTDS-001 toEpochMs menerima tanggal ISO, YYYY-MM, angka; menolak sampah', () => {
    expect(toEpochMs('2024-01-01')).toBe(Date.UTC(2024, 0, 1));
    expect(toEpochMs('2024-02')).toBe(Date.UTC(2024, 1, 1));
    expect(toEpochMs(1704067200000)).toBe(1704067200000);
    expect(toEpochMs('1704067200000')).toBe(1704067200000);
    expect(() => toEpochMs('besok')).toThrow(RangeError);
    expect(() => toEpochMs(-1)).toThrow(RangeError);
  });

  it('UNIT-BTDS-002 monthsInRange membagi rentang per bulan UTC, termasuk lintas tahun', () => {
    const m = monthsInRange(Date.UTC(2023, 11, 20), Date.UTC(2024, 1, 2));
    expect(m.map((x) => x.key)).toEqual(['2023-12', '2024-01', '2024-02']);
    expect(m[1]).toEqual({ key: '2024-01', start: Date.UTC(2024, 0, 1), end: Date.UTC(2024, 1, 1) });
    expect(monthsInRange(5, 5)).toEqual([]);
  });

  it('UNIT-BTDS-003 cacheFilePath menolak simbol berbahaya (path traversal)', () => {
    expect(cacheFilePath('c', 'BTCUSDT', '1h', '2024-01')).toBe(join('c', 'BTCUSDT', '1h', '2024-01.json'));
    expect(() => cacheFilePath('c', '../etc', '1h', '2024-01')).toThrow(TypeError);
    expect(() => cacheFilePath('c', 'BTCUSDT', '4h', '2024-01')).toThrow(TypeError);
  });
});

describe('loadFromBinance', () => {
  it('UNIT-BTDS-010 paginasi ≤1500 per request, rentang [from, to) dan hanya candle tertutup', async () => {
    const client = fakeClient();
    const { candles, stats } = await loadFromBinance({
      symbol: 'BTCUSDT', timeframe: '1h', from: '2024-01-01', to: '2024-04-01', client, cacheDir: dir, now: NOW,
    });
    expect(candles.length).toBe((Date.UTC(2024, 3, 1) - Date.UTC(2024, 0, 1)) / HOUR);
    expect(candles[0].openTime).toBe(Date.UTC(2024, 0, 1));
    expect(candles.at(-1).openTime).toBe(Date.UTC(2024, 3, 1) - HOUR);
    expect(client.calls.every((c) => c.limit === 1500)).toBe(true);
    expect(stats).toMatchObject({ months: 3, cachedMonths: 0, fetchedMonths: 3, requests: 3, gaps: [] });
    for (let i = 1; i < candles.length; i += 1) expect(candles[i].openTime - candles[i - 1].openTime).toBe(HOUR);
  });

  it('UNIT-BTDS-011 bulan lengkap di-cache; pemanggilan kedua tanpa klien memakai cache', async () => {
    const client = fakeClient();
    const args = { symbol: 'ETHUSDT', timeframe: '1h', from: '2024-02-10', to: '2024-03-05', cacheDir: dir, now: NOW };
    const first = await loadFromBinance({ ...args, client });
    const file = cacheFilePath(dir, 'ETHUSDT', '1h', '2024-02');
    const stored = JSON.parse(await readFile(file, 'utf8'));
    expect(stored.rows.length).toBe(29 * 24); // 2024 kabisat
    const second = await loadFromBinance(args); // tanpa client
    expect(second.stats).toMatchObject({ cachedMonths: 2, fetchedMonths: 0, requests: 0 });
    expect(second.candles).toEqual(first.candles);
  });

  it('UNIT-BTDS-012 bulan berjalan tidak di-cache dan candle belum tertutup dibuang', async () => {
    const client = fakeClient();
    const { candles } = await loadFromBinance({ symbol: 'BTCUSDT', timeframe: '1h', from: '2024-04-01', to: '2024-05-01', client, cacheDir: dir, now: NOW });
    await expect(readFile(cacheFilePath(dir, 'BTCUSDT', '1h', '2024-04'), 'utf8')).rejects.toThrow();
    expect(candles.every((c) => c.closeTime < NOW)).toBe(true);
    expect(candles.at(-1).openTime).toBe(NOW - HOUR); // NOW tepat di batas jam
    const all = await loadFromBinance({ symbol: 'BTCUSDT', timeframe: '1h', from: '2024-04-01', to: '2024-05-01', client, cacheDir: null, now: NOW, closedOnly: false });
    expect(all.candles.some((c) => !c.isClosed)).toBe(true);
  });

  it('UNIT-BTDS-013 cache rusak diabaikan lalu diambil ulang; celah data dilaporkan', async () => {
    const file = cacheFilePath(dir, 'BTCUSDT', '1h', '2024-01');
    await mkdir(join(dir, 'BTCUSDT', '1h'), { recursive: true });
    await writeFile(file, '{"version":1,"rows":[[1,2', 'utf8');
    const gapStart = Date.UTC(2024, 0, 10);
    const client = fakeClient({ missing: new Set([gapStart, gapStart + HOUR]) });
    const { stats } = await loadFromBinance({ symbol: 'BTCUSDT', timeframe: '1h', from: '2024-01-01', to: '2024-02-01', client, cacheDir: dir, now: NOW });
    expect(stats.fetchedMonths).toBe(1);
    expect(stats.gaps).toEqual([{ from: gapStart - HOUR, to: gapStart + 2 * HOUR, missing: 2 }]);
  });

  it('UNIT-BTDS-014 tanpa klien dan tanpa cache → error jelas; argumen tidak valid ditolak', async () => {
    await expect(loadFromBinance({ symbol: 'BTCUSDT', timeframe: '1h', from: '2024-01-01', to: '2024-02-01', cacheDir: dir, now: NOW }))
      .rejects.toThrow(/klien Binance tidak diberikan/);
    await expect(loadFromBinance({ symbol: 'btc', timeframe: '1h', from: '2024-01-01', to: '2024-02-01' })).rejects.toThrow(TypeError);
    await expect(loadFromBinance({ symbol: 'BTCUSDT', timeframe: '1h', from: '2024-02-01', to: '2024-01-01' })).rejects.toThrow(RangeError);
  });

  it('UNIT-BTDS-015 bekerja dengan klien REST asli (fake fetch, fixture) — parse & validasi yang sama', async () => {
    const fx = fixture('klines-btcusdt-5m.json');
    const urls = [];
    const fetch = async (url) => {
      urls.push(new URL(url));
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => fx.body };
    };
    const t0 = fx.body[0][0];
    const client = createBinanceRestClient({ fetch, clock: () => t0 + 3_600_000, sleep: async () => {} });
    const { candles } = await loadFromBinance({ symbol: 'BTCUSDT', timeframe: '5m', from: t0, to: t0 + 15 * 60_000, client, cacheDir: null, now: t0 + 3_600_000 });
    expect(candles.map((c) => c.close)).toEqual([94080.2, 94150.7, 94100]);
    expect(candles[0]).toMatchObject({ takerBuyVolume: 80.12, isClosed: true, source: 'rest' });
    expect(urls[0].pathname).toBe('/fapi/v1/klines');
    expect(urls[0].searchParams.get('limit')).toBe('1500');
  });

  it('UNIT-BTDS-016 findGaps', () => {
    expect(findGaps([{ openTime: 0 }, { openTime: 1 }, { openTime: 4 }], 1)).toEqual([{ from: 1, to: 4, missing: 2 }]);
  });
});

describe('CSV kline', () => {
  const t0 = Date.UTC(2024, 0, 1);
  const row = (t, close = '101', closeT = t + HOUR - 1) => `${t},100,102,99,${close},10,${closeT},1000,5,6,600,0`;

  it('UNIT-BTDS-020 dengan header (data.binance.vision) dan tanpa header menghasilkan candle identik', () => {
    const body = [row(t0), row(t0 + HOUR, '100.5')].join('\n');
    const header = 'open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore';
    const a = parseKlineCsv(`${header}\r\n${body}\r\n`, { symbol: 'BTCUSDT', timeframe: '1h', now: NOW });
    const b = parseKlineCsv(body, { symbol: 'BTCUSDT', timeframe: '1h', now: NOW });
    expect(a).toEqual(b);
    expect(a[1]).toMatchObject({ openTime: t0 + HOUR, close: 100.5, takerBuyQuoteVolume: 600, isClosed: true, symbol: 'BTCUSDT' });
  });

  it('UNIT-BTDS-021 stempel mikrodetik dikonversi; urutan acak & duplikat dirapikan', () => {
    const micro = `${t0 * 1000},100,102,99,101,10,${(t0 + HOUR - 1) * 1000 + 999},1000,5,6,600,0`;
    const out = parseKlineCsv([row(t0 + HOUR), micro, row(t0 + HOUR)].join('\n'), { symbol: 'BTCUSDT', timeframe: '1h', now: NOW });
    expect(out.map((c) => c.openTime)).toEqual([t0, t0 + HOUR]);
    expect(out[0].closeTime).toBe(t0 + HOUR - 1);
  });

  it('UNIT-BTDS-022 baris rusak ditolak (OHLC tidak konsisten / kolom kurang)', () => {
    expect(() => parseKlineCsv(`${t0},100,98,99,101,10,${t0 + HOUR - 1},1000,5,6,600,0`, { symbol: 'BTCUSDT', timeframe: '1h', now: NOW })).toThrow();
    expect(() => parseKlineCsv(`${t0},100,102`, { symbol: 'BTCUSDT', timeframe: '1h', now: NOW })).toThrow(/kolom kurang/);
  });

  it('UNIT-BTDS-023 loadFromCsv menebak simbol/timeframe dari nama file data.binance.vision', async () => {
    const file = join(dir, 'SOLUSDT-1h-2024-01.csv');
    await writeFile(file, [row(t0), row(t0 + HOUR)].join('\n'), 'utf8');
    expect(inferCsvMeta(file)).toEqual({ symbol: 'SOLUSDT', timeframe: '1h' });
    const candles = await loadFromCsv(file, { now: NOW });
    expect(candles).toHaveLength(2);
    expect(candles[0].symbol).toBe('SOLUSDT');
    await writeFile(join(dir, 'x.csv'), row(t0), 'utf8');
    await expect(loadFromCsv(join(dir, 'x.csv'))).rejects.toThrow(/tidak diketahui/);
  });
});

describe('listTopSymbols', () => {
  it('UNIT-BTDS-030 memakai discoverSymbols: hanya USDT perpetual TRADING, urut quote volume', async () => {
    const client = {
      getExchangeInfo: async () => parseExchangeInfo(fixture('exchangeInfo.json').body),
      get24hTickers: async () => parseTickers24h(fixture('ticker24hr.json').body),
      getBookTickers: async () => parseBookTickers(fixture('bookTicker.json').body),
    };
    const top = await listTopSymbols({ client, limit: 2 });
    expect(top).toEqual(['BTCUSDT', 'ETHUSDT']);
    const filtered = await listTopSymbols({ client, limit: 30, minQuoteVolume24h: 50_000_000, maxSpreadBps: 10 });
    expect(filtered).toEqual(['BTCUSDT', 'ETHUSDT', '1000PEPEUSDT', 'TINYUSDT']);
  });
});
