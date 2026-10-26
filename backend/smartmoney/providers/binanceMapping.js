// Adapter pemetaan Binance (kunci API READ-ONLY) untuk Insider / Smart Money Radar. Menghasilkan `mappingRows`
// binanceMatch.js `{ chain, contractAddress, binanceAsset, spotSymbol|null, futuresSymbol|null, multiplier, source,
// verifiedAt }` dari daftar kontrak aset Binance. BACA SAJA: modul ini hanya memanggil empat endpoint GET di bawah —
// tidak ada endpoint order, penarikan, atau transfer. Modul tidak pernah mencatat log.
//
// Alur fetchBinanceMapping():
// 1. checkKeyRestrictions(): GET /sapi/v1/account/apiRestrictions (bertanda tangan) [R docs/14 §5.1]. Kunci dengan
//    izin APA PUN selain membaca DITOLAK (UNAUTHORIZED) dan tidak dipakai lagi selama umur provider; kunci tanpa
//    enableReading juga ditolak. Vonis (lolos/ditolak) di-cache; kegagalan sementara (jaringan/429/5xx) tidak.
//    "Izin selain membaca" = field berawalan `enable` (kecuali enableReading dan izin baca-saja `enable…ReadOnly`,
//    mis. enableFixReadOnly = FIX API read-only) atau berawalan `permits`, bernilai true. Contoh respons resmi
//    (repo binance-connector-rust/js, dibaca 2026-10-26): ipRestrict, createTime, enableReading, enableWithdrawals,
//    enableInternalTransfer, enableMargin, enableFutures, permitsUniversalTransfer, enableVanillaOptions,
//    enableFixApiTrade, enableFixReadOnly, enableSpotAndMarginTrading, enablePortfolioMarginTrading.
// 2. GET /sapi/v1/capital/config/getall (bertanda tangan) [R] → coin + networkList[].{network, contractAddress,
//    denomination}. Saldo akun di respons yang sama DIABAIKAN (tidak disalin, tidak disimpan, tidak dilaporkan).
// 3. GET /fapi/v1/exchangeInfo (publik, USDⓈ-M) [R] → simbol PERPETUAL berstatus TRADING dengan quote USDT.
// 4. GET /api/v3/exchangeInfo (publik, spot) → spotSymbol. Opsional: gagal → spotSymbol null, mapping tetap jalan.
//
// Tanda tangan: HMAC-SHA256 (hex) atas string query PERSIS `timestamp=…&recvWindow=…` dengan API secret, header
// X-MBX-APIKEY [R docs/14 §5.1 request-security]. Hanya kunci HMAC ("System generated") yang didukung. Timestamp
// dibuat tepat sebelum kirim (setelah antrean throttle) agar tidak basi. Rahasia (API key, secret, signature) tidak
// pernah masuk pesan error; header kunci hanya dikirim ke endpoint bertanda tangan; redirect ditolak; host dibatasi
// *.binance.com (https).
//
// Pemetaan (buildBinanceMappingRows, fungsi murni):
// - Kode jaringan Binance → chain lewat tabel EKSPLISIT BINANCE_NETWORK_CHAINS; kode lain TIDAK ditebak — dicatat di
//   diagnostics.unknownNetworks (kode persis harus dibaca dari respons, docs/14 §5.2). Alamat dinormalisasi
//   contracts.normalizeAddress (EVM huruf kecil, Solana apa adanya); tidak valid → diagnostics.invalidContracts.
// - baseAsset perp → koin: nama koin persis dulu (pengali 1; menjaga nama asli seperti 1000SATS), lalu aturan prefix
//   /^(1000000|1000|1M)([A-Z0-9]+)$/ bila sisanya koin di getall (×1.000.000 / ×1000 / ×1.000.000; sumber
//   '+prefix-rule' dan catatan di diagnostics.prefixRule); selain itu tidak dipetakan (diagnostics.unmappedPerps).
//   Perp dengan underlyingType selain 'COIN' (indeks/komoditas) dilewati bila field tersebut ada.
// - TAMBAHAN di luar brief: `networkList[].denomination` (contoh resmi Binance: koin 1MBABYDOGE, kontrak BabyDoge di
//   BSC, denomination 1000000 → 1 unit koin Binance = 1.000.000 token on-chain) ikut dikalikan ke `multiplier`
//   (sumber '+denomination'). Tanpa ini aturan "nama persis → pengali 1" salah untuk koin berdenominasi.
//   `multiplier` = jumlah token on-chain per 1 unit aset dasar kontrak futures (atau per 1 unit koin bila tanpa
//   futures) — sama dengan arti "1 kontrak = N token" di binanceMatch.js.
// - Kontrak sama di dua jaringan yang dipetakan ke chain sama (mis. MATIC & POLYGON) → satu baris; kontrak berbeda
//   untuk koin sama di satu chain → dua baris; kontrak sama untuk dua koin berbeda → dua baris (binanceMatch →
//   AMBIGUOUS; dilaporkan di diagnostics.sharedContracts karena PK sm_binance_map (chain, kontrak) hanya menyimpan
//   satu baris). Lebih dari satu perp untuk satu koin: perp nama persis menang; tanpa nama persis → satu baris per
//   perp (→ AMBIGUOUS) dan dicatat di diagnostics.multiplePerps.
//
// Diagnostik: kontrak mengharuskan fetchBinanceMapping mengembalikan ARRAY. Diagnostik dilampirkan sebagai properti
// NON-enumerable `diagnostics` pada array hasil dan salinannya tersedia lewat `lastDiagnostics()`.

import { createHmac } from 'node:crypto';
import { CHAINS, NATIVE_TOKEN, ZERO_ADDRESS, normalizeAddress } from '../contracts.js';
import { notSupported } from './adapter.js';
import { ProviderError, codeForStatus, parseRetryAfter } from './errors.js';
import { createThrottle } from './throttle.js';

export const BINANCE_MAPPING_PROVIDER_ID = 'binance-mapping';
export const BINANCE_SPOT_BASE_URL = 'https://api.binance.com';
export const BINANCE_FUTURES_BASE_URL = 'https://fapi.binance.com';

/** Kode jaringan Binance (networkList[].network) → chain internal. Kode lain TIDAK ditebak. */
export const BINANCE_NETWORK_CHAINS = Object.freeze({
  ETH: 'ethereum',
  BSC: 'bsc',
  BASE: 'base',
  ARBITRUM: 'arbitrum',
  OPTIMISM: 'optimism',
  MATIC: 'polygon',
  POLYGON: 'polygon',
  SOL: 'solana',
});

/** Prefix pengali kontrak perp (1000PEPE, 1MBABYDOGE, 1000000MOG). Dipakai HANYA bila nama persis bukan koin. */
export const PERP_PREFIX_RE = /^(1000000|1000|1M)([A-Z0-9]+)$/;

export const BINANCE_PATHS = Object.freeze({
  apiRestrictions: '/sapi/v1/account/apiRestrictions',
  allCoins: '/sapi/v1/capital/config/getall',
  futuresExchangeInfo: '/fapi/v1/exchangeInfo',
  spotExchangeInfo: '/api/v3/exchangeInfo',
});

const ID = BINANCE_MAPPING_PROVIDER_ID;
const PREFIX_FACTORS = Object.freeze({ 1000000: 1_000_000, 1000: 1000, '1M': 1_000_000 });
const SOURCE = 'binance-getall';
const REQUEST_TIMEOUT_MS = 20_000;
const RATE_PER_SEC = 2;
// Ban 418 tanpa Retry-After: Binance memulai ban dari 2 menit (sama dengan backend/ingestion/binance/restClient.js).
const DEFAULT_BAN_MS = 120_000;
const MAX_RECV_WINDOW_MS = 60_000;
const MAX_LISTED = 100;
const ASSET_MAX_LENGTH = 32;
const SYMBOL_RE = /^[A-Z0-9]{1,30}$/;
const CREDENTIAL_RE = /^[\x21-\x7e]{8,512}$/;
const HEX64_RE = /[0-9a-fA-F]{64}/g;
const PERMISSION_RE = /^(?:enable|permits)[A-Z0-9]/;
const READ_ONLY_PERMISSION_RE = /^enable[A-Za-z0-9]*ReadOnly$/;
const ALLOWED_HOST_RE = /(^|\.)binance\.com$/;
const REDACTED = '[DISAMARKAN]';

/** Kode error JSON Binance `{ code, msg }` yang dipetakan eksplisit. */
const BINANCE_ERRORS = new Map([
  [-2015, { code: 'UNAUTHORIZED', message: 'kunci API Binance tidak valid, IP tidak diizinkan, atau izin kurang (kode -2015) — periksa kunci, pembatasan IP, dan izin Enable Reading' }],
  [-2014, { code: 'UNAUTHORIZED', message: 'format kunci API Binance tidak valid (kode -2014)' }],
  [-1022, { code: 'UNAUTHORIZED', message: 'tanda tangan permintaan ditolak Binance (kode -1022) — periksa API secret; hanya kunci HMAC yang didukung' }],
  [-1002, { code: 'UNAUTHORIZED', message: 'Binance menolak: tidak berwenang menjalankan permintaan ini (kode -1002)' }],
  [-1021, { code: 'BAD_RESPONSE', message: 'stempel waktu di luar recvWindow Binance (kode -1021) — jam komputer kemungkinan tidak sinkron; aktifkan pengaturan tanggal & waktu otomatis di Mac lalu coba lagi' }],
  [-1003, { code: 'RATE_LIMITED', message: 'terlalu banyak permintaan ke Binance (kode -1003)' }],
]);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isEnabled = (v) => v === true || v === 'true' || v === 1;
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function pushLimited(list, item) {
  if (list.length < MAX_LISTED) list.push(item);
}

function attachDiagnostics(result, diagnostics) {
  Object.defineProperty(result, 'diagnostics', { value: diagnostics, enumerable: false, configurable: true });
  return result;
}

/** Nama aset Binance yang dapat disimpan (1..32 karakter, sesuai CHECK sm_binance_map.binance_asset). */
function assetOf(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s !== '' && s.length <= ASSET_MAX_LENGTH ? s : null;
}

/** networkList[].denomination: tidak ada → 1; bilangan bulat aman ≥ 1; selain itu null (tidak valid). */
function denominationOf(v) {
  if (v === undefined || v === null) return 1;
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

function resolveBinanceBaseUrl(name, value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${name} bukan URL valid`);
  }
  if (url.protocol !== 'https:') throw new TypeError(`${name} wajib https`);
  if (url.username !== '' || url.password !== '' || url.port !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new TypeError(`${name} harus origin tanpa kredensial, port, path, query, atau fragment`);
  }
  if (!ALLOWED_HOST_RE.test(url.hostname)) throw new TypeError(`${name} harus host binance.com`);
  return url.origin;
}

/**
 * Tanda tangan HMAC-SHA256 Binance (hex huruf kecil) atas string query PERSIS seperti dikirim.
 * @param {string} queryString mis. 'timestamp=1767225600000&recvWindow=10000'
 * @param {string} apiSecret
 * @returns {string}
 */
export function signQuery(queryString, apiSecret) {
  return createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

/**
 * Izin kunci selain membaca yang aktif menurut respons /sapi/v1/account/apiRestrictions. `enableReading` dan izin
 * baca-saja `enable…ReadOnly` (mis. enableFixReadOnly) bukan pelanggaran; field `enable…` lain atau `permits…` yang
 * bernilai true adalah izin yang harus dimatikan.
 * @param {object} restrictions
 * @returns {string[]} nama izin terurut (kosong = hanya membaca)
 */
export function findExcessPermissions(restrictions) {
  if (!isObject(restrictions)) return [];
  return Object.keys(restrictions)
    .filter((k) => PERMISSION_RE.test(k) && k !== 'enableReading' && !READ_ONLY_PERMISSION_RE.test(k) && isEnabled(restrictions[k]))
    .sort();
}

/** Perp USDⓈ-M PERPETUAL/TRADING/USDT → daftar per koin `{ symbol, factor, viaPrefix }`. */
function perpIndex(futuresSymbols, coinNames, diagnostics) {
  const byCoin = new Map();
  for (const s of Array.isArray(futuresSymbols) ? futuresSymbols : []) {
    if (!isObject(s) || s.contractType !== 'PERPETUAL' || s.status !== 'TRADING' || s.quoteAsset !== 'USDT') continue;
    if (typeof s.symbol !== 'string' || !SYMBOL_RE.test(s.symbol) || typeof s.baseAsset !== 'string') continue;
    if (typeof s.underlyingType === 'string' && s.underlyingType !== 'COIN') {
      diagnostics.nonCoinPerps += 1;
      continue;
    }
    const baseAsset = s.baseAsset.trim();
    let entry = null;
    if (coinNames.has(baseAsset)) {
      entry = { coin: baseAsset, symbol: s.symbol, factor: 1, viaPrefix: false };
    } else {
      const m = PERP_PREFIX_RE.exec(baseAsset);
      if (m && coinNames.has(m[2])) entry = { coin: m[2], symbol: s.symbol, factor: PREFIX_FACTORS[m[1]], viaPrefix: true };
    }
    if (entry === null) {
      diagnostics.unmappedPerpsCount += 1;
      pushLimited(diagnostics.unmappedPerps, s.symbol);
      continue;
    }
    if (entry.viaPrefix) {
      pushLimited(diagnostics.prefixRule, {
        futuresSymbol: entry.symbol, baseAsset, binanceAsset: entry.coin, factor: entry.factor,
        note: `Aturan prefix: ${baseAsset} = ${entry.factor} × ${entry.coin} (bukan nama koin di getall) — verifikasi dengan `
          + 'membandingkan harga perp dan spot.',
      });
    }
    const list = byCoin.get(entry.coin) ?? [];
    list.push(entry);
    byCoin.set(entry.coin, list);
  }
  return byCoin;
}

/** Perp yang dipakai untuk satu koin: nama persis menang; tanpa nama persis & > 1 perp → semua (AMBIGUOUS). */
function choosePerps(coin, perps, diagnostics) {
  const list = perps.get(coin) ?? [];
  if (list.length <= 1) return list;
  const exact = list.filter((p) => !p.viaPrefix);
  const chosen = exact.length === 1 ? exact : list;
  pushLimited(diagnostics.multiplePerps, {
    binanceAsset: coin,
    futuresSymbols: list.map((p) => p.symbol).sort(),
    chosen: chosen.map((p) => p.symbol).sort(),
  });
  return chosen;
}

/** baseAsset → simbol spot USDT berstatus TRADING. */
function spotIndex(spotSymbols) {
  const map = new Map();
  for (const s of Array.isArray(spotSymbols) ? spotSymbols : []) {
    if (!isObject(s) || s.status !== 'TRADING' || s.quoteAsset !== 'USDT' || typeof s.baseAsset !== 'string') continue;
    if (typeof s.symbol !== 'string' || !SYMBOL_RE.test(s.symbol)) continue;
    if (!map.has(s.baseAsset)) map.set(s.baseAsset, s.symbol);
  }
  return map;
}

/**
 * Bangun mappingRows dari respons getall + exchangeInfo (fungsi murni; waktu dari `verifiedAt`).
 * @param {{ coins: object[], futuresSymbols: object[], spotSymbols?: object[]|null, verifiedAt: number }} input
 *   `spotSymbols` null = exchangeInfo spot tidak tersedia (spotSymbol null di semua baris)
 * @returns {{ rows: Array<{ chain: string, contractAddress: string, binanceAsset: string, spotSymbol: string|null,
 *   futuresSymbol: string|null, multiplier: number, source: string, verifiedAt: number }>, diagnostics: object }}
 */
export function buildBinanceMappingRows({ coins, futuresSymbols, spotSymbols = null, verifiedAt }) {
  if (!Number.isInteger(verifiedAt) || verifiedAt < 0) throw new TypeError('verifiedAt harus epoch milidetik (bilangan bulat ≥ 0)');
  const diagnostics = {
    coins: 0, networksWithContract: 0, rows: 0, duplicateRows: 0,
    unknownNetworks: [], invalidContracts: [], invalidDenominations: [], invalidAssets: [],
    unmappedPerps: [], unmappedPerpsCount: 0, nonCoinPerps: 0, prefixRule: [], denominated: [],
    multiplePerps: [], sharedContracts: [], spotAvailable: Array.isArray(spotSymbols),
  };
  const coinList = (Array.isArray(coins) ? coins : []).filter(isObject);
  const coinNames = new Set();
  for (const c of coinList) {
    const name = assetOf(c.coin);
    if (name === null) pushLimited(diagnostics.invalidAssets, String(c.coin).slice(0, 40));
    else coinNames.add(name);
  }
  diagnostics.coins = coinNames.size;
  const perps = perpIndex(futuresSymbols, coinNames, diagnostics);
  const spot = spotIndex(spotSymbols);
  const chosenPerps = new Map();
  const unknown = new Map();
  const seen = new Set();
  const denominatedSeen = new Set();
  const rows = [];

  for (const c of coinList) {
    const coin = assetOf(c.coin);
    if (coin === null || !Array.isArray(c.networkList)) continue;
    if (!chosenPerps.has(coin)) chosenPerps.set(coin, choosePerps(coin, perps, diagnostics));
    const coinPerps = chosenPerps.get(coin);
    for (const n of c.networkList) {
      if (!isObject(n)) continue;
      const contract = typeof n.contractAddress === 'string' ? n.contractAddress.trim() : '';
      if (contract === '') continue; // koin native / jaringan tanpa kontrak
      diagnostics.networksWithContract += 1;
      const network = typeof n.network === 'string' ? n.network.trim() : '';
      const chain = Object.hasOwn(BINANCE_NETWORK_CHAINS, network) ? BINANCE_NETWORK_CHAINS[network] : null;
      if (chain === null) {
        const u = unknown.get(network) ?? { network: network.slice(0, 40), count: 0, coins: [] };
        u.count += 1;
        if (u.coins.length < 5) u.coins.push(coin);
        unknown.set(network, u);
        continue;
      }
      const address = normalizeAddress(chain, contract);
      if (address === null || address === NATIVE_TOKEN || address === ZERO_ADDRESS) {
        pushLimited(diagnostics.invalidContracts, { coin, network, contractAddress: contract.slice(0, 100) });
        continue;
      }
      const denomination = denominationOf(n.denomination);
      if (denomination === null) {
        pushLimited(diagnostics.invalidDenominations, { coin, network, value: String(n.denomination).slice(0, 40) });
        continue;
      }
      const denominationKey = `${coin}|${chain}|${address}|${denomination}`;
      if (denomination !== 1 && !denominatedSeen.has(denominationKey)) {
        denominatedSeen.add(denominationKey);
        pushLimited(diagnostics.denominated, { binanceAsset: coin, chain, contractAddress: address, denomination });
      }
      for (const perp of coinPerps.length > 0 ? coinPerps : [null]) {
        const row = {
          chain,
          contractAddress: address,
          binanceAsset: coin,
          spotSymbol: spot.get(coin) ?? null,
          futuresSymbol: perp === null ? null : perp.symbol,
          multiplier: (perp === null ? 1 : perp.factor) * denomination,
          source: `${SOURCE}${perp?.viaPrefix ? '+prefix-rule' : ''}${denomination !== 1 ? '+denomination' : ''}`,
          verifiedAt,
        };
        if (!Number.isSafeInteger(row.multiplier)) {
          pushLimited(diagnostics.invalidDenominations, { coin, network, value: `multiplier ${row.multiplier}` });
          continue;
        }
        const key = JSON.stringify([row.chain, row.contractAddress, row.binanceAsset, row.spotSymbol, row.futuresSymbol, row.multiplier]);
        if (seen.has(key)) {
          diagnostics.duplicateRows += 1;
          continue;
        }
        seen.add(key);
        rows.push(row);
      }
    }
  }

  rows.sort((a, b) => compareText(a.chain, b.chain) || compareText(a.contractAddress, b.contractAddress)
    || compareText(a.binanceAsset, b.binanceAsset) || compareText(a.futuresSymbol ?? '', b.futuresSymbol ?? ''));
  const byContract = new Map();
  for (const r of rows) {
    const k = `${r.chain}:${r.contractAddress}`;
    byContract.set(k, [...(byContract.get(k) ?? []), r]);
  }
  for (const list of byContract.values()) {
    if (list.length > 1) {
      pushLimited(diagnostics.sharedContracts, {
        chain: list[0].chain,
        contractAddress: list[0].contractAddress,
        entries: list.map((r) => ({ binanceAsset: r.binanceAsset, futuresSymbol: r.futuresSymbol, multiplier: r.multiplier })),
      });
    }
  }
  diagnostics.unknownNetworks = [...unknown.values()].sort((a, b) => b.count - a.count || compareText(a.network, b.network));
  diagnostics.rows = rows.length;
  return { rows, diagnostics };
}

/**
 * Adapter pemetaan Binance (READ-ONLY). Tanpa kunci valid semua metode melempar NOT_CONFIGURED tanpa memanggil jaringan.
 * @param {{ apiKey?: string, apiSecret?: string, fetchImpl?: typeof fetch, clock?: () => number,
 *   sleep?: (ms: number) => Promise<void>, spotBaseUrl?: string, futuresBaseUrl?: string, recvWindow?: number }} [options]
 *   `clock` sebaiknya jam yang tersinkron dengan server Binance (selisih > recvWindow → kode -1021).
 * @returns {object} adapter sesuai docs/15 §3 + `checkKeyRestrictions()`, `isConfigured()`, `lastDiagnostics()`
 */
export function createBinanceMappingProvider({
  apiKey,
  apiSecret,
  fetchImpl = globalThis.fetch,
  clock = Date.now,
  sleep,
  spotBaseUrl = BINANCE_SPOT_BASE_URL,
  futuresBaseUrl = BINANCE_FUTURES_BASE_URL,
  recvWindow = 10_000,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl wajib fungsi');
  if (typeof clock !== 'function') throw new TypeError('clock wajib fungsi');
  if (!Number.isInteger(recvWindow) || recvWindow < 1 || recvWindow > MAX_RECV_WINDOW_MS) {
    throw new RangeError(`recvWindow harus bilangan bulat 1..${MAX_RECV_WINDOW_MS}`);
  }
  const spotBase = resolveBinanceBaseUrl('spotBaseUrl', spotBaseUrl);
  const futuresBase = resolveBinanceBaseUrl('futuresBaseUrl', futuresBaseUrl);
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  const secret = typeof apiSecret === 'string' ? apiSecret.trim() : '';
  // Format dicek sebelum dipakai di header: nilai dengan spasi/baris baru bisa membuat error fetch memuat kunci.
  const configured = CREDENTIAL_RE.test(key) && CREDENTIAL_RE.test(secret);
  const throttle = createThrottle({ ratePerSec: RATE_PER_SEC, clock, sleep });
  /** Vonis izin kunci: { ok: true, summary } | { ok: false, message, excessPermissions } — berlaku seumur provider. */
  let keyVerdict = null;
  let last = null;

  /** Buang rahasia (kunci, secret, signature, deretan 64 hex) dan karakter kontrol dari teks pesan. */
  function scrub(text, signature) {
    let out = String(text);
    for (const s of [key, secret, signature]) {
      if (typeof s === 'string' && s.length >= 4) out = out.split(s).join(REDACTED);
    }
    return out.replace(HEX64_RE, REDACTED).replace(/\p{Cc}/gu, ' ');
  }

  function fail(code, message, { retryAfterMs = null, status = null, signature = null } = {}) {
    return new ProviderError(code, `${ID}: ${scrub(message, signature)}`, { provider: ID, retryAfterMs, status });
  }

  function requireConfigured() {
    if (!configured) {
      throw fail('NOT_CONFIGURED', 'kunci API Binance read-only (API key + secret HMAC) belum dikonfigurasi atau formatnya tidak valid');
    }
  }

  function thrownError(err, path) {
    const name = err?.name;
    if (name === 'AbortError' || name === 'TimeoutError') return fail('TIMEOUT', `permintaan ${path} dibatalkan atau melewati batas waktu`);
    // Pesan error jaringan bawaan bisa memuat URL bertanda tangan → tidak pernah diteruskan.
    return fail('UNAVAILABLE', `gagal menghubungi Binance (${path})`);
  }

  function bodyError(status, body, path, retryAfterMs, signature) {
    const binanceCode = isObject(body) && Number.isInteger(body.code) ? body.code : null;
    const known = binanceCode === null ? undefined : BINANCE_ERRORS.get(binanceCode);
    if (known) {
      return fail(known.code, `${known.message} (${path}, HTTP ${status})`, {
        status, signature, retryAfterMs: known.code === 'RATE_LIMITED' ? retryAfterMs : null,
      });
    }
    if (status === 403) return fail('UNAVAILABLE', `HTTP 403 untuk ${path}: ditolak firewall (WAF) Binance`, { status });
    // Samarkan DULU baru potong: memotong lebih dulu bisa menyisakan potongan rahasia yang tidak lagi dikenali.
    const msg = isObject(body) && typeof body.msg === 'string' ? ` — Binance: ${scrub(body.msg, signature).slice(0, 120)}` : '';
    const code = status >= 200 && status < 300 ? 'BAD_RESPONSE' : codeForStatus(status);
    return fail(code, `HTTP ${status} untuk ${path}${binanceCode === null ? '' : ` (kode ${binanceCode})`}${msg}`, {
      status, signature, retryAfterMs: code === 'RATE_LIMITED' ? retryAfterMs : null,
    });
  }

  function httpError(res, body, path, signature) {
    const status = res.status;
    const retryAfterMs = parseRetryAfter(res.headers?.get?.('retry-after') ?? null, { now: clock() });
    if (status === 451) {
      return fail('UNAVAILABLE', `HTTP 451 untuk ${path}: Binance menolak permintaan dari lokasi ini (pembatasan geografis) — `
        + 'jalankan dari Mac pengguna di wilayah yang didukung', { status });
    }
    if (status === 418) {
      return fail('RATE_LIMITED', `HTTP 418 untuk ${path}: IP diblokir sementara oleh Binance karena terlalu banyak permintaan`, {
        status, retryAfterMs: retryAfterMs ?? DEFAULT_BAN_MS,
      });
    }
    if (status === 429) return fail('RATE_LIMITED', `HTTP 429 untuk ${path}: batas permintaan Binance tercapai`, { status, retryAfterMs });
    return bodyError(status, body, path, retryAfterMs, signature);
  }

  /** GET lewat throttle. Endpoint bertanda tangan: timestamp + recvWindow + signature, header X-MBX-APIKEY. */
  function call(base, path, { signed, signal }) {
    return throttle.schedule(async () => {
      if (signal?.aborted) throw fail('TIMEOUT', `permintaan ${path} dibatalkan`);
      const headers = { accept: 'application/json' };
      let url = `${base}${path}`;
      let signature = null;
      if (signed) {
        const query = `timestamp=${Math.trunc(clock())}&recvWindow=${recvWindow}`;
        signature = signQuery(query, secret);
        url = `${url}?${query}&signature=${signature}`;
        headers['X-MBX-APIKEY'] = key;
      }
      const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
      if (signal) signals.push(signal);
      let res;
      try {
        res = await fetchImpl(url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.any(signals) });
      } catch (err) {
        throw thrownError(err, path);
      }
      if (res === null || typeof res !== 'object' || typeof res.status !== 'number') throw fail('BAD_RESPONSE', `respons ${path} tidak valid`);
      let text = '';
      try {
        text = await res.text();
      } catch (err) {
        // Body error yang gagal dibaca: status HTTP tetap dipakai di bawah.
        if (res.ok) throw thrownError(err, path);
      }
      let body = null;
      let parsed = false;
      try {
        body = JSON.parse(text);
        parsed = true;
      } catch {
        // bukan JSON — ditangani di bawah
      }
      if (!res.ok) throw httpError(res, parsed ? body : null, path, signature);
      if (!parsed) throw fail('BAD_RESPONSE', `respons ${path} bukan JSON yang valid`);
      if (isObject(body) && Number.isInteger(body.code) && body.code < 0 && typeof body.msg === 'string') {
        throw bodyError(res.status, body, path, null, signature);
      }
      return body;
    });
  }

  /**
   * Pastikan kunci HANYA berizin membaca. Kunci dengan izin lain / tanpa Enable Reading ditolak UNAUTHORIZED dan
   * tidak pernah dipakai lagi (vonis di-cache seumur provider).
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<{ enableReading: true, ipRestrict: boolean, checkedAt: number }>}
   */
  async function checkKeyRestrictions({ signal } = {}) {
    requireConfigured();
    if (keyVerdict?.ok) return { ...keyVerdict.summary };
    if (keyVerdict) throw fail('UNAUTHORIZED', keyVerdict.message);
    const body = await call(spotBase, BINANCE_PATHS.apiRestrictions, { signed: true, signal });
    if (!isObject(body) || typeof body.enableReading !== 'boolean') {
      throw fail('BAD_RESPONSE', 'respons apiRestrictions tidak memuat enableReading — izin kunci tidak dapat dipastikan, kunci tidak dipakai');
    }
    const excess = findExcessPermissions(body);
    if (excess.length === 0 && body.enableReading === true) {
      keyVerdict = { ok: true, summary: { enableReading: true, ipRestrict: body.ipRestrict === true, checkedAt: Math.trunc(clock()) } };
      return { ...keyVerdict.summary };
    }
    if (excess.length > 0) {
      const shown = excess.slice(0, 3).join(', ') + (excess.length > 3 ? ` +${excess.length - 3} lainnya` : '');
      keyVerdict = {
        ok: false, excessPermissions: excess,
        message: `Kunci Binance memiliki izin selain membaca (${shown}) — demi keamanan kunci ini tidak dipakai; `
          + 'buat kunci baru dengan izin Enable Reading saja.',
      };
    } else {
      keyVerdict = {
        ok: false, excessPermissions: [],
        message: 'Kunci Binance tidak memiliki izin Enable Reading — buat kunci baru dengan izin Enable Reading saja.',
      };
    }
    last = { provider: ID, method: 'checkKeyRestrictions', at: Math.trunc(clock()), refused: true, excessPermissions: keyVerdict.excessPermissions };
    throw fail('UNAUTHORIZED', keyVerdict.message);
  }

  /**
   * mappingRows untuk binanceMatch.js. Memeriksa izin kunci lebih dulu (sekali per umur provider).
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<object[]>} baris mapping + properti non-enumerable `diagnostics`
   */
  async function fetchBinanceMapping({ signal } = {}) {
    requireConfigured();
    await checkKeyRestrictions({ signal });
    const coins = await call(spotBase, BINANCE_PATHS.allCoins, { signed: true, signal });
    if (!Array.isArray(coins)) throw fail('BAD_RESPONSE', `respons ${BINANCE_PATHS.allCoins} bukan array koin`);
    const futures = await call(futuresBase, BINANCE_PATHS.futuresExchangeInfo, { signed: false, signal });
    if (!isObject(futures) || !Array.isArray(futures.symbols)) {
      throw fail('BAD_RESPONSE', `respons ${BINANCE_PATHS.futuresExchangeInfo} tidak memuat array symbols`);
    }
    let spotSymbols = null;
    let spotError = null;
    try {
      const spot = await call(spotBase, BINANCE_PATHS.spotExchangeInfo, { signed: false, signal });
      if (isObject(spot) && Array.isArray(spot.symbols)) spotSymbols = spot.symbols;
      else spotError = { code: 'BAD_RESPONSE', message: `${ID}: respons ${BINANCE_PATHS.spotExchangeInfo} tidak memuat array symbols` };
    } catch (err) {
      if (signal?.aborted) throw err;
      spotError = err instanceof ProviderError
        ? { code: err.code, message: err.message }
        : { code: 'UNAVAILABLE', message: `${ID}: exchangeInfo spot gagal` };
    }
    const at = Math.trunc(clock());
    const { rows, diagnostics } = buildBinanceMappingRows({ coins, futuresSymbols: futures.symbols, spotSymbols, verifiedAt: at });
    const notes = [];
    if (spotError) notes.push('exchangeInfo spot gagal — spotSymbol null di semua baris; mapping futures tetap dipakai.');
    if (diagnostics.unknownNetworks.length > 0) notes.push('Kode jaringan Binance di luar tabel tidak dipetakan (tidak ditebak).');
    if (diagnostics.sharedContracts.length > 0) {
      notes.push('Ada kontrak yang terdaftar untuk > 1 entri Binance (AMBIGUOUS di binanceMatch; PK sm_binance_map hanya menyimpan satu).');
    }
    const full = { provider: ID, method: 'fetchBinanceMapping', at, ...diagnostics, spotError, notes };
    last = full;
    return attachDiagnostics(rows, full);
  }

  return {
    id: ID,
    displayName: 'Binance (pemetaan kontrak aset, baca saja)',
    requiresKey: true,
    isSimulated: false,
    chains: CHAINS.filter((c) => Object.values(BINANCE_NETWORK_CHAINS).includes(c)),
    capabilities: new Set(['binanceMapping']),
    terms: {
      docsUrl: 'https://developers.binance.com/docs/wallet/capital',
      attribution: null,
      displayAllowed: true,
      notes: 'Kunci Binance hanya untuk membaca daftar kontrak aset; tidak pernah dipakai untuk order/penarikan. '
        + 'Posisi futures pribadi siapa pun tidak dapat diketahui dari data ini.',
    },

    /** true bila API key & secret tersedia dengan format yang dapat dipakai (belum berarti diterima Binance). */
    isConfigured: () => configured,
    checkKeyRestrictions,
    /** Salinan diagnostik panggilan terakhir (fetchBinanceMapping / penolakan kunci), atau null. */
    lastDiagnostics: () => (last === null ? null : structuredClone(last)),

    fetchWalletTransfers: notSupported(ID, 'fetchWalletTransfers'),
    fetchLabels: notSupported(ID, 'fetchLabels'),
    fetchPrices: notSupported(ID, 'fetchPrices'),
    discoverWallets: notSupported(ID, 'discoverWallets'),
    fetchBinanceMapping,
  };
}
