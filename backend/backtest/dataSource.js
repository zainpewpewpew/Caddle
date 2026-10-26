// Sumber data backtest: Binance REST (dengan cache disk per simbol × timeframe × bulan), file CSV kline
// Binance (termasuk ekspor data.binance.vision), dan daftar simbol teratas lewat discovery yang sudah ada.
// Modul ini sengaja ber-I/O (disk & klien REST yang disuntikkan); logika analisis tetap murni di modul lain.
// Tidak ada HTTP baru: semua request lewat createBinanceRestClient (allowlist host, rate limit, retry).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { TIMEFRAMES, TIMEFRAME_MS } from '../market/contracts.js';
import { MAX_KLINES_LIMIT } from '../ingestion/binance/restClient.js';
import { parseKlines } from '../ingestion/binance/parse.js';
import { discoverSymbols } from '../ingestion/symbolDiscovery.js';

export const DEFAULT_CACHE_DIR = 'data/backtest-cache';
/** Versi format file cache; naikkan bila bentuk baris berubah (cache lama otomatis diabaikan). */
export const CACHE_FORMAT_VERSION = 1;
/** Batas pengaman jumlah halaman per bulan (1h ≈ 1 halaman, 5m ≈ 6 halaman). */
const MAX_PAGES_PER_MONTH = 64;
// Simbol aman untuk nama path (tanpa '/', '.', dsb.) — sama ketat dengan validasi klien REST.
const SYMBOL_RE = /^[A-Z0-9]{2,30}$/;
// Kolom baris cache ringkas (urutan tetap).
const CACHE_FIELDS = Object.freeze([
  'openTime', 'open', 'high', 'low', 'close', 'volume', 'quoteVolume', 'trades', 'takerBuyVolume', 'takerBuyQuoteVolume',
]);
// Stempel waktu ≥ 1e15 berarti mikrodetik (file spot data.binance.vision sejak 2025).
const MICROSECOND_THRESHOLD = 1e15;

/** @typedef {import('../market/contracts.js').Candle} Candle */

function assertSymbol(symbol) {
  if (typeof symbol !== 'string' || !SYMBOL_RE.test(symbol)) throw new TypeError(`Simbol tidak valid: ${String(symbol).slice(0, 40)}`);
}

function assertTimeframe(timeframe) {
  if (!TIMEFRAMES.includes(timeframe)) throw new TypeError(`Timeframe tidak didukung: ${String(timeframe).slice(0, 16)} (pilihan: ${TIMEFRAMES.join(', ')})`);
}

/**
 * Ubah tanggal (epoch ms, Date, atau string ISO 'YYYY-MM-DD[...]', ditafsirkan UTC) menjadi epoch ms.
 * @param {number|string|Date} value
 * @param {string} name nama argumen untuk pesan error
 * @returns {number}
 */
export function toEpochMs(value, name = 'waktu') {
  let ms = null;
  if (typeof value === 'number') ms = value;
  else if (value instanceof Date) ms = value.getTime();
  else if (typeof value === 'string' && value.trim() !== '') {
    const s = value.trim();
    ms = /^\d+$/.test(s) ? Number(s) : Date.parse(/^\d{4}-\d{2}(-\d{2})?$/.test(s) ? `${s.length === 7 ? `${s}-01` : s}T00:00:00Z` : s);
  }
  if (!Number.isSafeInteger(ms) || ms < 0) throw new RangeError(`${name} tidak valid: ${String(value).slice(0, 40)}`);
  return ms;
}

/**
 * Bulan UTC (awal inklusif, akhir eksklusif) yang beririsan dengan [from, to).
 * @returns {Array<{ key: string, start: number, end: number }>} key 'YYYY-MM'
 */
export function monthsInRange(from, to) {
  const out = [];
  if (!(to > from)) return out;
  const d = new Date(from);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  for (;;) {
    const start = Date.UTC(y, m, 1);
    if (start >= to) break;
    const end = Date.UTC(y, m + 1, 1);
    out.push({ key: `${y}-${String(m + 1).padStart(2, '0')}`, start, end });
    m += 1;
    if (m === 12) { m = 0; y += 1; }
  }
  return out;
}

/** Path file cache untuk satu (simbol, timeframe, bulan). */
export function cacheFilePath(cacheDir, symbol, timeframe, monthKey) {
  assertSymbol(symbol);
  assertTimeframe(timeframe);
  if (!/^\d{4}-\d{2}$/.test(monthKey)) throw new TypeError('Kunci bulan tidak valid');
  return join(cacheDir, symbol, timeframe, `${monthKey}.json`);
}

function toCacheRow(c) {
  return CACHE_FIELDS.map((f) => c[f]);
}

function fromCacheRow(row, symbol, timeframe, now) {
  if (!Array.isArray(row) || row.length !== CACHE_FIELDS.length || !row.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const c = Object.fromEntries(CACHE_FIELDS.map((f, i) => [f, row[i]]));
  if (!Number.isSafeInteger(c.openTime) || c.openTime % TIMEFRAME_MS[timeframe] !== 0) return null;
  const closeTime = c.openTime + TIMEFRAME_MS[timeframe] - 1;
  return { symbol, timeframe, ...c, closeTime, isClosed: closeTime < now, source: 'rest' };
}

/** Baca satu file cache bulan; null bila tidak ada, rusak, atau versi format berbeda. */
async function readMonthCache(file, { symbol, timeframe, now }) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || parsed.version !== CACHE_FORMAT_VERSION || parsed.symbol !== symbol || parsed.timeframe !== timeframe || !Array.isArray(parsed.rows)) return null;
  const candles = [];
  for (const row of parsed.rows) {
    const c = fromCacheRow(row, symbol, timeframe, now);
    if (c === null) return null;
    if (candles.length && c.openTime <= candles[candles.length - 1].openTime) return null;
    candles.push(c);
  }
  return candles;
}

/** Tulis atomik (file sementara lalu rename) agar proses yang terputus tidak meninggalkan cache setengah jadi. */
async function writeMonthCache(file, { symbol, timeframe, monthKey, candles }) {
  await mkdir(join(file, '..'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const body = JSON.stringify({ version: CACHE_FORMAT_VERSION, symbol, timeframe, month: monthKey, fields: CACHE_FIELDS, rows: candles.map(toCacheRow) });
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, file);
}

/**
 * Ambil semua candle bulan [start, end) lewat klien REST, paginasi ≤ 1500 per request.
 * @returns {Promise<{ candles: Candle[], requests: number }>}
 */
async function fetchMonth(client, { symbol, timeframe, start, end }) {
  const ms = TIMEFRAME_MS[timeframe];
  const candles = [];
  let cursor = start;
  let requests = 0;
  while (cursor < end) {
    if (requests >= MAX_PAGES_PER_MONTH) throw new Error(`Paginasi ${symbol} ${timeframe} melebihi ${MAX_PAGES_PER_MONTH} halaman`);
    const batch = await client.getKlines({ symbol, timeframe, startTime: cursor, endTime: end - 1, limit: MAX_KLINES_LIMIT });
    requests += 1;
    if (!Array.isArray(batch) || batch.length === 0) break;
    let last = cursor - ms;
    for (const c of batch) {
      if (c.openTime >= cursor && c.openTime < end && (candles.length === 0 || c.openTime > candles[candles.length - 1].openTime)) candles.push(c);
      last = Math.max(last, c.openTime);
    }
    const next = last + ms;
    if (next <= cursor || batch.length < MAX_KLINES_LIMIT) break;
    cursor = next;
  }
  return { candles, requests };
}

/**
 * Muat candle historis dari Binance USDT-M Futures dengan cache disk per (simbol, timeframe, bulan UTC).
 * Bulan yang SELURUHNYA sudah lewat (semua candle tertutup) disimpan sebagai JSON di `cacheDir` dan tidak
 * pernah diambil ulang; bulan berjalan selalu diambil segar dan tidak di-cache. isClosed dihitung ulang
 * terhadap `now` (closeTime < now); secara bawaan hanya candle tertutup yang dikembalikan.
 * @param {{
 *   symbol: string, timeframe: '5m'|'15m'|'1h', from: number|string|Date, to: number|string|Date,
 *   client?: { getKlines(q: object): Promise<Candle[]> }, cacheDir?: string|null, now?: number,
 *   closedOnly?: boolean, onProgress?: (e: { symbol: string, timeframe: string, month: string, cached: boolean, candles: number }) => void,
 * }} options
 *   - `client`: klien REST (createBinanceRestClient). Wajib bila ada bulan yang belum ter-cache.
 *   - `cacheDir`: null mematikan cache.
 *   - rentang memakai openTime: from ≤ openTime < to.
 * @returns {Promise<{ candles: Candle[], stats: { months: number, cachedMonths: number, fetchedMonths: number, requests: number, gaps: Array<{ from: number, to: number, missing: number }> } }>}
 */
export async function loadFromBinance({
  symbol, timeframe, from, to, client, cacheDir = DEFAULT_CACHE_DIR, now = Date.now(), closedOnly = true, onProgress,
} = {}) {
  assertSymbol(symbol);
  assertTimeframe(timeframe);
  const fromMs = toEpochMs(from, 'from');
  const toMs = toEpochMs(to, 'to');
  if (fromMs >= toMs) throw new RangeError('from harus sebelum to');
  const ms = TIMEFRAME_MS[timeframe];
  const stats = { months: 0, cachedMonths: 0, fetchedMonths: 0, requests: 0, gaps: [] };
  const all = [];

  for (const month of monthsInRange(fromMs, toMs)) {
    stats.months += 1;
    const file = cacheDir ? cacheFilePath(cacheDir, symbol, timeframe, month.key) : null;
    // Bulan lengkap = candle terakhirnya sudah tertutup pada `now`.
    const complete = month.end - 1 < now;
    let candles = file && complete ? await readMonthCache(file, { symbol, timeframe, now }) : null;
    const cached = candles !== null;
    if (cached) {
      stats.cachedMonths += 1;
    } else {
      if (!client || typeof client.getKlines !== 'function') {
        throw new Error(`Data ${symbol} ${timeframe} ${month.key} belum ada di cache dan klien Binance tidak diberikan`);
      }
      const fetched = await fetchMonth(client, { symbol, timeframe, start: month.start, end: month.end });
      stats.requests += fetched.requests;
      stats.fetchedMonths += 1;
      candles = fetched.candles.map((c) => ({ ...c, isClosed: c.closeTime < now }));
      if (file && complete && candles.length > 0 && candles.every((c) => c.isClosed)) {
        await writeMonthCache(file, { symbol, timeframe, monthKey: month.key, candles });
      }
    }
    onProgress?.({ symbol, timeframe, month: month.key, cached, candles: candles.length });
    for (const c of candles) {
      if (c.openTime < fromMs || c.openTime >= toMs) continue;
      if (closedOnly && !c.isClosed) continue;
      all.push(c);
    }
  }
  stats.gaps = findGaps(all, ms);
  return { candles: all, stats };
}

/**
 * Celah pada deret candle (openTime tidak bersambung). Data Binance memang bisa bolong saat maintenance;
 * runner sebaiknya tidak mengevaluasi sinyal yang jendelanya melintasi celah besar.
 * @param {Candle[]} candles terurut naik
 * @param {number} intervalMs
 * @returns {Array<{ from: number, to: number, missing: number }>} from/to = openTime sebelum & sesudah celah
 */
export function findGaps(candles, intervalMs) {
  const gaps = [];
  for (let i = 1; i < candles.length; i += 1) {
    const diff = candles[i].openTime - candles[i - 1].openTime;
    if (diff > intervalMs) gaps.push({ from: candles[i - 1].openTime, to: candles[i].openTime, missing: diff / intervalMs - 1 });
  }
  return gaps;
}

/**
 * Tebak simbol & timeframe dari nama file data.binance.vision, mis. 'BTCUSDT-1h-2024-01.csv'.
 * @param {string} path
 * @returns {{ symbol: string, timeframe: string } | null}
 */
export function inferCsvMeta(path) {
  const m = /^([A-Z0-9]{2,30})-(\d+[mhdwM])-\d{4}-\d{2}(?:-\d{2})?\.csv$/.exec(basename(String(path)));
  if (!m || !TIMEFRAMES.includes(m[2])) return null;
  return { symbol: m[1], timeframe: m[2] };
}

function normalizeEpoch(text) {
  const n = Number(text);
  if (!Number.isFinite(n)) return NaN;
  return n >= MICROSECOND_THRESHOLD ? Math.floor(n / 1000) : n;
}

/**
 * Parse teks CSV kline Binance (dengan atau tanpa header) menjadi Candle[] lewat parser REST yang sama
 * (validasi OHLC, closeTime = openTime + interval − 1, taker ≤ volume). Baris kosong diabaikan; baris
 * duplikat (openTime sama) dibuang; hasil diurutkan naik. Stempel mikrodetik diubah ke milidetik.
 * Kolom: open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore
 * @param {string} text
 * @param {{ symbol: string, timeframe: '5m'|'15m'|'1h', now?: number }} ctx
 * @returns {Candle[]}
 */
export function parseKlineCsv(text, { symbol, timeframe, now = Date.now() } = {}) {
  assertSymbol(symbol);
  assertTimeframe(timeframe);
  const rows = [];
  const lines = String(text).split(/\r?\n/);
  lines.forEach((raw, lineIndex) => {
    const line = raw.trim();
    if (line === '') return;
    const cols = line.split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
    // Header (baris pertama non-numerik) dilewati; baris non-numerik lain = rusak.
    if (!/^\d/.test(cols[0])) {
      if (rows.length === 0 && /open/i.test(cols[0])) return;
      throw new TypeError(`CSV baris ${lineIndex + 1}: open_time bukan angka`);
    }
    if (cols.length < 11) throw new TypeError(`CSV baris ${lineIndex + 1}: kolom kurang (${cols.length} < 11)`);
    rows.push([
      normalizeEpoch(cols[0]), cols[1], cols[2], cols[3], cols[4], cols[5],
      normalizeEpoch(cols[6]), cols[7], Number(cols[8]), cols[9], cols[10], cols[11] ?? '0',
    ]);
  });
  rows.sort((a, b) => a[0] - b[0]);
  const unique = rows.filter((r, i) => i === 0 || r[0] !== rows[i - 1][0]);
  return parseKlines(unique, { symbol, timeframe, now });
}

/**
 * Muat candle dari file CSV kline Binance (format REST/data.binance.vision, header opsional).
 * symbol/timeframe boleh dihilangkan bila nama file berpola data.binance.vision ('BTCUSDT-1h-2024-01.csv').
 * @param {string} path
 * @param {{ symbol?: string, timeframe?: '5m'|'15m'|'1h', now?: number, closedOnly?: boolean }} [options]
 * @returns {Promise<Candle[]>}
 */
export async function loadFromCsv(path, { symbol, timeframe, now = Date.now(), closedOnly = true } = {}) {
  const inferred = inferCsvMeta(path);
  const sym = symbol ?? inferred?.symbol;
  const tf = timeframe ?? inferred?.timeframe;
  if (!sym || !tf) throw new TypeError(`Simbol/timeframe CSV tidak diketahui untuk ${basename(String(path))}; berikan { symbol, timeframe }`);
  const candles = parseKlineCsv(await readFile(path, 'utf8'), { symbol: sym, timeframe: tf, now });
  return closedOnly ? candles.filter((c) => c.isClosed) : candles;
}

/**
 * Simbol USDT-M perpetual teratas menurut quote volume 24 jam, memakai discoverSymbols (mode auto)
 * yang sama dengan scanner live: kontrak PERPETUAL + USDT + TRADING, filter likuiditas & spread.
 * @param {{ client: { getExchangeInfo(): Promise<any[]>, get24hTickers(): Promise<any[]>, getBookTickers(): Promise<any[]> },
 *           limit?: number, minQuoteVolume24h?: number, maxSpreadBps?: number }} options
 * @returns {Promise<string[]>} simbol urut quote volume menurun
 */
export async function listTopSymbols({ client, limit = 30, minQuoteVolume24h = 0, maxSpreadBps = 1000 } = {}) {
  if (!client) throw new TypeError('client wajib diberikan');
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit harus bilangan bulat ≥ 1');
  const [symbols, tickers, bookTickers] = await Promise.all([client.getExchangeInfo(), client.get24hTickers(), client.getBookTickers()]);
  const { selected } = discoverSymbols({
    symbols, tickers, bookTickers,
    settings: { symbols: { mode: 'auto', maxAuto: limit, manual: [] }, liquidity: { minQuoteVolume24h, maxSpreadBps } },
  });
  return selected.map((s) => s.symbol);
}
