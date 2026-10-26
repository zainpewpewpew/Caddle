// Valuasi USD kaki native / wrapped-native (ETH/WETH, BNB/WBNB, POL/WPOL, SOL/WSOL) dari candle 1 jam Binance.
// Dibutuhkan karena kebanyakan swap ber-quote ETH/WETH dan provider riwayat (Etherscan/Routescan) tidak memberi
// harga historis: tanpa nilai USD sisi quote, classify.js tidak dapat mengisi usdValue SWAP_BUY/SWAP_SELL dan PnL
// menjadi tidak lengkap. Stablecoin tidak perlu modul ini (classify.js menilainya 1 USD/unit).
//
// ─── Sumber harga ───────────────────────────────────────────────────────────────────────────────
// `getKlines` = backend/ingestion/binance/restClient.js#getKlines (data pasar PUBLIK USDⓈ-M futures, tanpa kunci).
// Tanda tangan aslinya `getKlines({ symbol, timeframe: '1h', startTime, endTime, limit })` → Candle[]
// (`{ openTime, closeTime, open, high, low, close, …, isClosed }`, closeTime = openTime + 1 jam − 1 ms). Resolver
// mengirim `timeframe` (nama parameter klien) DAN `interval` (nama parameter API Binance, untuk pembungkus lain).
// Metode klien adalah closure (tanpa `this`), jadi sinkronisasi cukup meneruskannya langsung:
//   const rest = createBinanceRestClient();            // atau klien yang sudah dipakai worker
//   const resolver = createNativePriceResolver({ getKlines: rest.getKlines });
//   const priced = await enrichNativeUsd(normalized.transfers, resolver);
// fapi.binance.com menjawab HTTP 451 (geo-block) dari cloud pengembangan; berjalan di Mac pengguna. Harga perp
// USDⓈ-M dipakai sebagai perkiraan harga spot dan USDT ≈ 1 USD — keduanya perkiraan, ditandai di priceSource.
//
// ─── Tanpa look-ahead ───────────────────────────────────────────────────────────────────────────
// Harga pada waktu t = close candle 1 jam TERAKHIR yang sudah TUTUP sebelum t (closeTime < t, isClosed tidak
// false). Candle yang memuat t TIDAK dipakai: close-nya terjadi setelah t. Akibatnya harga bisa tertinggal ≤ 1 jam
// ("perkiraan per jam"). Bila candle jam sebelumnya tidak ada (jeda data), candle lebih tua dipakai selama umurnya
// ≤ maxStaleMs (default 2 jam); selain itu null.
//
// ─── Simbol & kegagalan ─────────────────────────────────────────────────────────────────────────
// Peta default: ethereum/base/arbitrum/optimism → ETHUSDT, bsc → BNBUSDT, polygon → POLUSDT, solana → SOLUSDT.
// POLUSDT TIDAK diasumsikan ada: Binance menjawab simbol tak dikenal dengan galat -1121 "Invalid symbol" → resolver
// mengembalikan null (tidak pernah menebak) dan menolak simbol itu lokal selama cacheMs; galat tercatat di
// `errors()`. Skrip cek wajib memverifikasi setiap simbol (mis. priceAt('polygon', sekarang) ≠ null). Catatan:
// sebelum migrasi MATIC → POL (Sep 2024) tidak ada candle POLUSDT → transaksi Polygon lama bernilai null.
// Chain tanpa simbol, galat jaringan/geo-block/data rusak → null (galat sementara di-cache 5 menit).
//
// ─── Batch & cache ──────────────────────────────────────────────────────────────────────────────
// Satu permintaan memuat 480 candle (20 hari; limit < 500 → bobot klines Binance 2) yang disejajarkan ke batas
// batch; panggilan serentak untuk batch yang sama berbagi satu permintaan. Batch yang seluruh jamnya sudah lewat
// disimpan `cacheMs` (candle tertutup tidak berubah); batch yang masih berjalan disimpan ≤ 5 menit.

import { NATIVE_TOKEN, QUOTE_ASSETS, isChain, normalizeAddress } from './contracts.js';

const HOUR_MS = 3_600_000;
const BATCH_HOURS = 480;
const BATCH_MS = BATCH_HOURS * HOUR_MS;
const DEFAULT_CACHE_MS = 6 * HOUR_MS;
const DEFAULT_MAX_STALE_MS = 2 * HOUR_MS;
const OPEN_BATCH_TTL_MS = 5 * 60_000;
const FAILURE_TTL_MS = 5 * 60_000;
const BATCH_CLOSED_MARGIN_MS = 60_000;
const MAX_CACHE_ENTRIES = 2000;
const SYMBOL_RE = /^[A-Z0-9]{2,30}$/;
const ERROR_TEXT_MAX = 200;

/** Penanda priceSource untuk nilai hasil enrichNativeUsd. */
export const HOURLY_ESTIMATE_SUFFIX = ' (perkiraan per jam)';

/** Simbol Binance USDⓈ-M untuk koin native per chain (keberadaan POLUSDT diverifikasi skrip cek, bukan diasumsikan). */
export const NATIVE_PRICE_SYMBOLS = Object.freeze({
  ethereum: 'ETHUSDT', base: 'ETHUSDT', arbitrum: 'ETHUSDT', optimism: 'ETHUSDT',
  bsc: 'BNBUSDT', polygon: 'POLUSDT', solana: 'SOLUSDT',
});

/** Alamat wrapped native per chain dari QUOTE_ASSETS (simbol = 'W' + simbol native: WETH, WBNB, WPOL, WSOL). */
const WRAPPED_NATIVE = Object.freeze(Object.fromEntries(Object.entries(QUOTE_ASSETS).map(([chain, assets]) => {
  const wrappedSymbol = `W${assets[NATIVE_TOKEN]}`;
  return [chain, Object.freeze(Object.keys(assets).filter((a) => a !== NATIVE_TOKEN && assets[a] === wrappedSymbol))];
})));

/**
 * true bila token adalah koin native chain atau wrapped native-nya (WETH/WBNB/WPOL/WSOL dari QUOTE_ASSETS).
 * @param {string} chain
 * @param {string} address alamat token (dinormalisasi di sini) atau 'native'
 */
export function isNativeOrWrappedNative(chain, address) {
  // normalizeAddress menerima 'native' untuk chain apa pun → chain wajib dikenal lebih dulu.
  if (!isChain(chain)) return false;
  const a = normalizeAddress(chain, address);
  if (a === null) return false;
  return a === NATIVE_TOKEN || WRAPPED_NATIVE[chain].includes(a);
}

function cleanError(err) {
  const text = String(err?.message ?? err ?? 'galat tidak dikenal').replace(/[\u0000-\u001f\u007f]/g, ' '); // eslint-disable-line no-control-regex
  return text.length > ERROR_TEXT_MAX ? `${text.slice(0, ERROR_TEXT_MAX)}…` : text;
}

/** Galat "simbol tidak dikenal": kode Binance -1121, atau validasi simbol klien REST. */
function isInvalidSymbolError(err) {
  return err?.code === -1121 || /invalid symbol|simbol tidak valid/i.test(String(err?.message ?? ''));
}

/** Candle → bentuk minimal tervalidasi, atau null. */
function normalizeCandle(c) {
  if (c === null || typeof c !== 'object') return null;
  if (!Number.isSafeInteger(c.openTime) || c.openTime < 0) return null;
  if (typeof c.close !== 'number' || !Number.isFinite(c.close) || c.close <= 0) return null;
  const closeTime = Number.isSafeInteger(c.closeTime) ? c.closeTime : c.openTime + HOUR_MS - 1;
  return { openTime: c.openTime, closeTime, close: c.close, isClosed: c.isClosed !== false };
}

/**
 * Resolver harga koin native per jam tanpa look-ahead (lihat catatan modul).
 * @param {{
 *   getKlines: (query: { symbol: string, timeframe: '1h', interval: '1h', startTime: number, endTime: number, limit: number })
 *     => Promise<Array<{ openTime: number, closeTime?: number, close: number, isClosed?: boolean }>>,
 *   symbolsByChain?: Record<string, string>, cacheMs?: number, maxStaleMs?: number, clock?: () => number,
 * }} options
 * @returns {{ priceAt: (chain: string, t: number) => Promise<{ priceUsd: number, at: number, source: string }|null>,
 *   errors: () => Array<{ symbol: string, code: string, message: string, at: number, invalidSymbol: boolean }> }}
 */
export function createNativePriceResolver({
  getKlines, symbolsByChain = NATIVE_PRICE_SYMBOLS, cacheMs = DEFAULT_CACHE_MS, maxStaleMs = DEFAULT_MAX_STALE_MS, clock = Date.now,
} = {}) {
  if (typeof getKlines !== 'function') throw new TypeError('getKlines wajib fungsi');
  if (symbolsByChain === null || typeof symbolsByChain !== 'object') throw new TypeError('symbolsByChain harus objek chain → simbol');
  if (!Number.isSafeInteger(cacheMs) || cacheMs <= 0) throw new RangeError('cacheMs harus bilangan bulat > 0');
  if (!Number.isSafeInteger(maxStaleMs) || maxStaleMs < HOUR_MS) throw new RangeError('maxStaleMs harus bilangan bulat ≥ 1 jam');
  if (typeof clock !== 'function') throw new TypeError('clock wajib fungsi');

  const batches = new Map(); // `${symbol}:${batchStart}` → { promise: Promise<Map<openTime, candle>|null>, expiresAt }
  const invalidUntil = new Map(); // symbol → epoch ms
  const lastErrors = new Map(); // symbol → { code, message, at, invalidSymbol }

  function symbolFor(chain) {
    const s = Object.hasOwn(symbolsByChain, chain) ? symbolsByChain[chain] : null;
    return typeof s === 'string' && SYMBOL_RE.test(s) ? s : null;
  }

  function prune(now) {
    if (batches.size <= MAX_CACHE_ENTRIES) return;
    for (const [k, e] of batches) {
      if (e.expiresAt !== null && e.expiresAt <= now) batches.delete(k);
    }
    for (const k of batches.keys()) {
      if (batches.size <= MAX_CACHE_ENTRIES) break;
      batches.delete(k);
    }
  }

  async function fetchBatch(symbol, batchStart, entry) {
    const fetchedAt = clock();
    const batchEnd = batchStart + BATCH_MS - 1;
    try {
      const candles = await getKlines({
        symbol, timeframe: '1h', interval: '1h', startTime: batchStart, endTime: batchEnd, limit: BATCH_HOURS,
      });
      const byOpen = new Map();
      for (const raw of Array.isArray(candles) ? candles : []) {
        const c = normalizeCandle(raw);
        if (c !== null) byOpen.set(c.openTime, c);
      }
      lastErrors.delete(symbol);
      const closedBatch = batchEnd < fetchedAt - BATCH_CLOSED_MARGIN_MS;
      entry.expiresAt = fetchedAt + (closedBatch ? cacheMs : Math.min(cacheMs, OPEN_BATCH_TTL_MS));
      return byOpen;
    } catch (err) {
      const invalidSymbol = isInvalidSymbolError(err);
      lastErrors.set(symbol, { code: String(err?.code ?? err?.name ?? 'ERROR'), message: cleanError(err), at: fetchedAt, invalidSymbol });
      if (invalidSymbol) invalidUntil.set(symbol, fetchedAt + cacheMs);
      entry.expiresAt = fetchedAt + (invalidSymbol ? cacheMs : Math.min(cacheMs, FAILURE_TTL_MS));
      return null;
    }
  }

  /** Map openTime → candle untuk batch yang memuat `openTime`, atau null bila gagal. Permintaan serentak berbagi. */
  function loadBatch(symbol, openTime) {
    const batchStart = Math.floor(openTime / BATCH_MS) * BATCH_MS;
    const key = `${symbol}:${batchStart}`;
    const now = clock();
    const hit = batches.get(key);
    if (hit && (hit.expiresAt === null || hit.expiresAt > now)) return hit.promise;
    const entry = { promise: null, expiresAt: null };
    entry.promise = fetchBatch(symbol, batchStart, entry);
    batches.delete(key);
    batches.set(key, entry);
    prune(now);
    return entry.promise;
  }

  /**
   * Harga USD koin native `chain` pada waktu `t` (epoch ms) dari close candle 1 jam yang sudah tutup sebelum t.
   * @returns {Promise<{ priceUsd: number, at: number, source: string }|null>} null bila tidak diketahui
   */
  async function priceAt(chain, t) {
    const symbol = symbolFor(chain);
    if (symbol === null || !Number.isSafeInteger(t) || t <= 0) return null;
    if ((invalidUntil.get(symbol) ?? 0) > clock()) return null;
    const hourStart = Math.floor(t / HOUR_MS) * HOUR_MS;
    for (let open = hourStart - HOUR_MS; open >= 0; open -= HOUR_MS) {
      if (t - (open + HOUR_MS - 1) > maxStaleMs) break;
      const byOpen = await loadBatch(symbol, open);
      if (byOpen === null) return null;
      const c = byOpen.get(open);
      if (c && c.closeTime < t && c.isClosed) return { priceUsd: c.close, at: c.closeTime, source: `binance:${symbol}:1h` };
    }
    return null;
  }

  return {
    priceAt,
    /** Galat terakhir per simbol (untuk status/skrip cek), mis. POLUSDT "Invalid symbol". */
    errors: () => [...lastErrors.entries()].map(([symbol, e]) => ({ symbol, ...e })),
  };
}

function needsNativeUsd(t) {
  return t !== null && typeof t === 'object'
    && !(typeof t.usdValue === 'number' && Number.isFinite(t.usdValue) && t.usdValue >= 0)
    && typeof t.amount === 'number' && Number.isFinite(t.amount) && t.amount > 0
    && Number.isSafeInteger(t.blockTime)
    && isNativeOrWrappedNative(t.chain, t.token?.address);
}

/**
 * Isi `usdValue` transfer native / wrapped-native yang nilai USD-nya belum diketahui: amount × harga per jam,
 * `priceSource` = sumber resolver + ' (perkiraan per jam)'. Nilai USD yang sudah ada (dari provider) TIDAK PERNAH
 * ditimpa; token lain tidak disentuh; harga tidak diketahui → tetap null (tidak pernah 0 / tebakan). Masukan tidak
 * diubah: transfer yang diisi adalah objek baru.
 * @param {object[]} transfers RawTransfer (sebelum atau sesudah normalizeTransfers)
 * @param {{ priceAt: (chain: string, t: number) => Promise<{ priceUsd: number, source: string }|null> }|null} resolver
 * @returns {Promise<object[]>} array baru dengan urutan sama
 */
export async function enrichNativeUsd(transfers, resolver) {
  const list = Array.isArray(transfers) ? transfers : [];
  const canPrice = resolver !== null && typeof resolver === 'object' && typeof resolver.priceAt === 'function';
  return Promise.all(list.map(async (t) => {
    if (!canPrice || !needsNativeUsd(t)) return t;
    let price;
    try {
      price = await resolver.priceAt(t.chain, t.blockTime);
    } catch {
      price = null;
    }
    if (!price || typeof price.priceUsd !== 'number' || !Number.isFinite(price.priceUsd) || price.priceUsd <= 0
      || typeof price.source !== 'string' || price.source === '') return t;
    const usdValue = t.amount * price.priceUsd;
    if (!Number.isFinite(usdValue)) return t;
    return { ...t, usdValue, priceSource: `${price.source}${HOURLY_ESTIMATE_SUFFIX}` };
  }));
}
