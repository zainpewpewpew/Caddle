// Parsing & validasi respons REST Binance USDT-M Futures → bentuk kanonik (contracts.js).
// Fungsi murni: tanpa I/O dan tanpa jam — waktu "sekarang" diberikan lewat argumen.
// Data Binance tidak tepercaya: baris rusak TIDAK diperbaiki atau dibuang diam-diam,
// melainkan seluruh respons ditolak dengan BinanceDataError yang memuat daftar masalah.

import { TIMEFRAMES, expectedCloseTime, isAlignedOpenTime } from '../../market/contracts.js';
import { BinanceDataError, sanitizeText } from './errors.js';

// Desimal ketat seperti yang dikirim Binance ("0.00001234"): tanpa spasi, eksponen, hex,
// atau string kosong — Number('') === 0 dan Number(' 1') === 1 sehingga tidak dipakai langsung.
const DECIMAL_RE = /^\d+(\.\d+)?$/;
const SIGNED_DECIMAL_RE = /^-?\d+(\.\d+)?$/;
const KLINE_ROW_LENGTH = 12;
const MAX_ISSUES = 50;

/**
 * Ubah desimal Binance (string, atau number finite) menjadi number.
 * @param {unknown} value
 * @param {{ signed?: boolean }} [opts] signed=false menolak nilai negatif
 * @returns {number|null} null bila tidak valid
 */
export function parseDecimal(value, { signed = false } = {}) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (!signed && value < 0)) return null;
    return value;
  }
  if (typeof value !== 'string' || !(signed ? SIGNED_DECIMAL_RE : DECIMAL_RE).test(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** String desimal positif (tickSize/stepSize) dipertahankan sebagai string agar presisi tidak hilang. */
function parsePositiveDecimalString(value) {
  if (typeof value !== 'string' || !DECIMAL_RE.test(value)) return null;
  return Number(value) > 0 ? value : null;
}

const isEpochMs = (v) => Number.isSafeInteger(v) && v >= 0;
const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;

/**
 * Spread relatif dalam basis poin: (ask − bid) / mid × 10000.
 * @returns {number|null} null bila kuotasi kosong (≤ 0) atau tersilang (ask < bid)
 */
export function computeSpreadBps(bidPrice, askPrice) {
  if (!Number.isFinite(bidPrice) || !Number.isFinite(askPrice)) return null;
  if (bidPrice <= 0 || askPrice <= 0 || askPrice < bidPrice) return null;
  const mid = (askPrice + bidPrice) / 2;
  return ((askPrice - bidPrice) / mid) * 10_000;
}

/** Pengumpul masalah validasi; respons ditolak bila ada minimal satu masalah. */
function createIssues() {
  const list = [];
  let total = 0;
  return {
    add(index, field, reason, value) {
      total += 1;
      if (list.length >= MAX_ISSUES) return;
      const issue = { index, field, reason };
      if (value !== undefined) issue.value = sanitizeText(typeof value === 'string' ? JSON.stringify(value) : String(value), 64);
      list.push(issue);
    },
    get count() { return total; },
    list,
  };
}

function throwIfIssues(issues, what, path) {
  if (issues.count === 0) return;
  throw new BinanceDataError(`Respons ${what} Binance tidak valid: ${issues.count} masalah`, { path, issues: issues.list });
}

function assertKlineContext({ symbol, timeframe, now } = {}) {
  if (!isNonEmptyString(symbol)) throw new TypeError('Simbol kline wajib diisi');
  if (!TIMEFRAMES.includes(timeframe)) throw new TypeError(`Timeframe tidak dikenal: ${sanitizeText(timeframe, 16)}`);
  if (!Number.isFinite(now)) throw new TypeError('Waktu sekarang (now) wajib angka finite');
}

// Indeks kolom kline sesuai dokumentasi Binance.
const PRICE_FIELDS = [['open', 1], ['high', 2], ['low', 3], ['close', 4]];
const AMOUNT_FIELDS = [['volume', 5], ['quoteVolume', 7], ['takerBuyVolume', 9], ['takerBuyQuoteVolume', 10]];

/** Validasi satu baris; mengembalikan Candle atau null (masalah dicatat ke `issues`). */
function readKlineRow(row, index, { symbol, timeframe, now }, issues) {
  if (!Array.isArray(row) || row.length !== KLINE_ROW_LENGTH) {
    issues.add(index, 'row', `baris kline harus array ${KLINE_ROW_LENGTH} elemen`, Array.isArray(row) ? `length=${row.length}` : typeof row);
    return null;
  }
  const before = issues.count;
  const openTime = row[0];
  const closeTime = row[6];
  if (!isEpochMs(openTime)) issues.add(index, 'openTime', 'harus bilangan bulat epoch ms', openTime);
  else if (!isAlignedOpenTime(openTime, timeframe)) issues.add(index, 'openTime', `tidak sejajar batas interval ${timeframe}`, openTime);
  if (!isEpochMs(closeTime)) issues.add(index, 'closeTime', 'harus bilangan bulat epoch ms', closeTime);
  else if (isEpochMs(openTime) && closeTime !== expectedCloseTime(openTime, timeframe)) {
    issues.add(index, 'closeTime', 'harus openTime + interval − 1', closeTime);
  }

  const values = {};
  for (const [field, i] of PRICE_FIELDS) {
    const n = parseDecimal(row[i]);
    if (n === null) issues.add(index, field, 'bukan desimal valid', row[i]);
    else if (n <= 0) issues.add(index, field, 'harga harus > 0', row[i]);
    else values[field] = n;
  }
  for (const [field, i] of AMOUNT_FIELDS) {
    const n = parseDecimal(row[i]);
    if (n === null) issues.add(index, field, 'bukan desimal ≥ 0 valid', row[i]);
    else values[field] = n;
  }
  const trades = row[8];
  if (!Number.isSafeInteger(trades) || trades < 0) issues.add(index, 'trades', 'harus bilangan bulat ≥ 0', trades);

  const { open, high, low, close, volume, quoteVolume, takerBuyVolume, takerBuyQuoteVolume } = values;
  if ([open, high, low, close].every((v) => v !== undefined)) {
    if (high < low) issues.add(index, 'high', 'high < low', row[2]);
    else if (high < Math.max(open, close)) issues.add(index, 'high', 'high di bawah open/close', row[2]);
    if (low > Math.min(open, close)) issues.add(index, 'low', 'low di atas open/close', row[3]);
  }
  if (volume !== undefined && takerBuyVolume !== undefined && takerBuyVolume > volume) {
    issues.add(index, 'takerBuyVolume', 'taker buy volume > volume', row[9]);
  }
  if (quoteVolume !== undefined && takerBuyQuoteVolume !== undefined && takerBuyQuoteVolume > quoteVolume) {
    issues.add(index, 'takerBuyQuoteVolume', 'taker buy quote volume > quote volume', row[10]);
  }
  if (issues.count !== before) return null;

  return {
    symbol, timeframe, openTime, closeTime,
    open, high, low, close, volume, quoteVolume, trades, takerBuyVolume, takerBuyQuoteVolume,
    isClosed: closeTime < now,
    source: 'rest',
  };
}

/**
 * Parse satu baris kline REST Binance:
 * [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades, takerBuyBase, takerBuyQuote, ignore].
 * @param {unknown} row
 * @param {{ symbol: string, timeframe: '5m'|'15m'|'1h', now: number }} ctx now = jam server (ms)
 * @returns {import('../../market/contracts.js').Candle}
 * @throws {BinanceDataError} bila baris rusak
 */
export function parseKlineRow(row, ctx) {
  assertKlineContext(ctx);
  const issues = createIssues();
  const candle = readKlineRow(row, 0, ctx, issues);
  throwIfIssues(issues, 'kline', '/fapi/v1/klines');
  return candle;
}

/**
 * Parse respons GET /fapi/v1/klines. Seluruh respons ditolak bila ada satu baris rusak
 * atau openTime tidak naik ketat (duplikat/urutan salah). isClosed = closeTime < now.
 * @param {unknown} rows
 * @param {{ symbol: string, timeframe: '5m'|'15m'|'1h', now: number }} ctx
 * @returns {import('../../market/contracts.js').Candle[]}
 * @throws {BinanceDataError}
 */
export function parseKlines(rows, ctx) {
  assertKlineContext(ctx);
  const issues = createIssues();
  if (!Array.isArray(rows)) {
    issues.add(null, null, 'respons klines harus array', typeof rows);
    throwIfIssues(issues, 'kline', '/fapi/v1/klines');
  }
  const candles = [];
  let prevOpenTime = null;
  rows.forEach((row, index) => {
    const candle = readKlineRow(row, index, ctx, issues);
    if (candle === null) return;
    if (prevOpenTime !== null && candle.openTime <= prevOpenTime) {
      issues.add(index, 'openTime', 'openTime tidak naik ketat (duplikat/urutan salah)', candle.openTime);
    }
    prevOpenTime = candle.openTime;
    candles.push(candle);
  });
  throwIfIssues(issues, 'kline', '/fapi/v1/klines');
  return candles;
}

/**
 * Parse GET /fapi/v1/time.
 * @returns {number} serverTime epoch ms
 */
export function parseServerTime(body) {
  if (body !== null && typeof body === 'object' && isEpochMs(body.serverTime)) return body.serverTime;
  throw new BinanceDataError('Respons time Binance tidak valid: 1 masalah', {
    path: '/fapi/v1/time',
    issues: [{ index: null, field: 'serverTime', reason: 'harus bilangan bulat epoch ms' }],
  });
}

function findFilter(filters, type) {
  return Array.isArray(filters) ? filters.find((f) => f !== null && typeof f === 'object' && f.filterType === type) : undefined;
}

/**
 * @typedef {object} SymbolInfo
 * @property {string} symbol
 * @property {string} baseAsset
 * @property {string} quoteAsset
 * @property {string} contractType   'PERPETUAL', 'CURRENT_QUARTER', ...
 * @property {string} status         'TRADING', 'SETTLING', 'BREAK', ...
 * @property {string|null} tickSize  dari filter PRICE_FILTER (string desimal), null bila filter tidak ada
 * @property {string|null} stepSize  dari filter LOT_SIZE (string desimal), null bila filter tidak ada
 * @property {number|null} onboardDate epoch ms
 */

/**
 * Parse GET /fapi/v1/exchangeInfo → SymbolInfo[].
 * Field identitas wajib string; filter yang ada tetapi tickSize/stepSize rusak → error.
 * @returns {SymbolInfo[]}
 * @throws {BinanceDataError}
 */
export function parseExchangeInfo(body) {
  const issues = createIssues();
  const path = '/fapi/v1/exchangeInfo';
  if (body === null || typeof body !== 'object' || !Array.isArray(body.symbols)) {
    issues.add(null, 'symbols', 'respons exchangeInfo harus memuat array symbols');
    throwIfIssues(issues, 'exchangeInfo', path);
  }
  const out = [];
  body.symbols.forEach((s, index) => {
    if (s === null || typeof s !== 'object') {
      issues.add(index, 'symbol', 'entri simbol harus objek', typeof s);
      return;
    }
    const before = issues.count;
    for (const field of ['symbol', 'baseAsset', 'quoteAsset', 'status']) {
      if (!isNonEmptyString(s[field])) issues.add(index, field, 'wajib string tidak kosong', s[field]);
    }
    if (typeof s.contractType !== 'string') issues.add(index, 'contractType', 'wajib string', s.contractType);

    const priceFilter = findFilter(s.filters, 'PRICE_FILTER');
    const lotSize = findFilter(s.filters, 'LOT_SIZE');
    const tickSize = priceFilter ? parsePositiveDecimalString(priceFilter.tickSize) : null;
    const stepSize = lotSize ? parsePositiveDecimalString(lotSize.stepSize) : null;
    if (priceFilter && tickSize === null) issues.add(index, 'tickSize', 'tickSize PRICE_FILTER harus desimal > 0', priceFilter.tickSize);
    if (lotSize && stepSize === null) issues.add(index, 'stepSize', 'stepSize LOT_SIZE harus desimal > 0', lotSize.stepSize);
    if (issues.count !== before) return;

    out.push({
      symbol: s.symbol,
      baseAsset: s.baseAsset,
      quoteAsset: s.quoteAsset,
      contractType: s.contractType,
      status: s.status,
      tickSize,
      stepSize,
      onboardDate: isEpochMs(s.onboardDate) ? s.onboardDate : null,
    });
  });
  throwIfIssues(issues, 'exchangeInfo', path);
  return out;
}

/** Validasi array objek ticker generik: setiap field dibaca oleh `spec` [field, parser, alasan]. */
function parseObjectArray(body, what, path, spec) {
  const issues = createIssues();
  if (!Array.isArray(body)) {
    issues.add(null, null, `respons ${what} harus array`, typeof body);
    throwIfIssues(issues, what, path);
  }
  const out = [];
  body.forEach((item, index) => {
    if (item === null || typeof item !== 'object') {
      issues.add(index, 'symbol', 'entri harus objek', typeof item);
      return;
    }
    const before = issues.count;
    const parsed = {};
    for (const [field, read, reason] of spec) {
      const v = read(item[field]);
      if (v === null) issues.add(index, field, reason, item[field]);
      else parsed[field] = v;
    }
    if (issues.count === before) out.push(parsed);
  });
  throwIfIssues(issues, what, path);
  return out;
}

const readSymbol = (v) => (isNonEmptyString(v) ? v : null);
const readAmount = (v) => parseDecimal(v);
const readSigned = (v) => parseDecimal(v, { signed: true });
const readEpoch = (v) => (isEpochMs(v) ? v : null);

/**
 * @typedef {{ symbol: string, lastPrice: number, priceChangePercent: number, volume: number,
 *   quoteVolume: number, closeTime: number }} Ticker24h
 */

/**
 * Parse GET /fapi/v1/ticker/24hr (semua simbol) → Ticker24h[].
 * @returns {Ticker24h[]}
 * @throws {BinanceDataError}
 */
export function parseTickers24h(body) {
  return parseObjectArray(body, 'ticker/24hr', '/fapi/v1/ticker/24hr', [
    ['symbol', readSymbol, 'wajib string tidak kosong'],
    ['lastPrice', readAmount, 'bukan desimal ≥ 0 valid'],
    ['priceChangePercent', readSigned, 'bukan desimal valid'],
    ['volume', readAmount, 'bukan desimal ≥ 0 valid'],
    ['quoteVolume', readAmount, 'bukan desimal ≥ 0 valid'],
    ['closeTime', readEpoch, 'harus bilangan bulat epoch ms'],
  ]);
}

/**
 * @typedef {{ symbol: string, bidPrice: number, askPrice: number, spreadBps: number|null }} BookTicker
 */

/**
 * Parse GET /fapi/v1/ticker/bookTicker (semua simbol) → BookTicker[] dengan spreadBps.
 * spreadBps null bila tidak ada kuotasi valid (bid/ask 0 atau tersilang).
 * @returns {BookTicker[]}
 * @throws {BinanceDataError}
 */
export function parseBookTickers(body) {
  const rows = parseObjectArray(body, 'ticker/bookTicker', '/fapi/v1/ticker/bookTicker', [
    ['symbol', readSymbol, 'wajib string tidak kosong'],
    ['bidPrice', readAmount, 'bukan desimal ≥ 0 valid'],
    ['askPrice', readAmount, 'bukan desimal ≥ 0 valid'],
  ]);
  return rows.map((r) => ({ ...r, spreadBps: computeSpreadBps(r.bidPrice, r.askPrice) }));
}
