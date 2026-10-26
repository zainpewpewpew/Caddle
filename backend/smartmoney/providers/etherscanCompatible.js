// Inti adapter riwayat transfer wallet EVM berformat Etherscan ("module=account") — dipakai Etherscan API V2
// (etherscan.js) dan Routescan (routescan.js). Adapter adalah satu-satunya tempat I/O jaringan fitur smart money
// (docs/15 §3). Modul ini TIDAK PERNAH mencatat log; kunci API tidak pernah masuk ke pesan error, diagnostik, atau
// URL yang dikembalikan.
//
// ─── Status verifikasi ──────────────────────────────────────────────────────────────────────────────
// Lingkungan pengembangan (cloud) tidak dapat menjangkau host data mana pun (docs/14 §0: semua diblokir proxy).
// Adapter ini ditulis dari bentuk respons di DOKUMENTASI resmi Etherscan (contoh txlist/tokentx/txlistinternal) dan
// BELUM diuji terhadap respons live. Fixture di tes = "bentuk dari dokumentasi, belum direkam live". Setiap respons
// mengembalikan `diagnostics` (field yang hilang / tidak dikenal, baris yang dilewati, peringatan) agar skrip cek di
// Mac pengguna dapat menunjukkan perbedaan bentuk respons live sebelum data diandalkan.
//
// ─── Permintaan per fetchWalletTransfers (3 panggilan berurutan, lewat throttle + kuota harian) ────────────────
//   action=tokentx         transfer ERC-20 (log Transfer) yang melibatkan alamat
//   action=txlist          transaksi normal: nilai native, pengirim tx (initiator), tx.to, functionName/methodId
//   action=txlistinternal  transfer native internal (mis. ETH dari router saat menjual token ke ETH)
// Parameter: module=account, address, startblock, endblock, page=1, offset=pageSize, sort=asc (+ `chainid` untuk
// Etherscan V2, sudah ada di URL dari urlForChain). Kunci: query `apikey` (keyMode 'query'), header `apikey`
// (keyMode 'header'), atau tanpa kunci (null).
// endblock = 2147483647, BUKAN 99999999 seperti contoh dokumentasi: tinggi blok Arbitrum (> 300 jt) dan Optimism
// (> 130 jt) — kemungkinan juga BSC/Polygon — sudah melewati 99.999.999 sehingga riwayat terbaru akan hilang
// DIAM-DIAM. 2147483647 = bilangan bulat 32-bit terbesar (pasti dapat diurai). Bila provider menolaknya, galatnya
// terlihat (BAD_RESPONSE), tidak diam-diam.
//
// ─── Respons (HTTP 200 berisi { status: '1'|'0', message, result }) ────────────────────────────────────
//   status '1' + result array                          → baris data (message selain "OK" dicatat di warnings)
//   status '0' + /rate limit/                          → RATE_LIMITED (retryAfterMs 1000; batas HARIAN → sampai
//                                                         pergantian hari UTC) + jeda lokal (cooldown) tanpa jaringan
//   status '0' + "invalid/missing api key"            → UNAUTHORIZED
//   status '0' + /not supported|unsupported|upgrade|paid|plan|tier/ (chain di luar paket gratis, endpoint Pro)
//                                                      → NOT_SUPPORTED berisi pesan provider (tersamar, dipotong)
//                                                        agar registri/sinkronisasi dapat beralih provider. Chain
//                                                        itu lalu ditolak lokal selama 1 jam (hemat kuota).
//   status '0' + sisa pesan /api key/                  → UNAUTHORIZED
//   status '0' + /timeout/ ("Query Timeout occured…")  → TIMEOUT
//   status '0' + "No transactions found" / result []   → kosong
//   selain itu                                         → BAD_RESPONSE
// Kegagalan HTTP mengikuti fetchJson (401/403 UNAUTHORIZED, 429 RATE_LIMITED, 5xx UNAVAILABLE); HTTP 404 dianggap
// NOT_SUPPORTED (Routescan memuat chainId di path → 404 = chain tidak dilayani).
//
// ─── Baris → RawTransfer (docs/15 §1) ──────────────────────────────────────────────────────────────
// - tokentx: token { address: contractAddress, symbol: tokenSymbol, name: tokenName, decimals: tokenDecimal };
//   amount = value / 10^decimals lewat konversi string desimal BigInt (bukan Number(value) / 10**d yang membulatkan
//   dua kali). Nilai 0 (umum pada spam "address poisoning") dan baris NFT (tokenID) dilewati.
// - txlist: nilai native (`value` wei, 18 desimal) bila > 0 dan tx tidak gagal (isError '1' / txreceipt_status '0').
// - txlistinternal: nilai native internal bila > 0, tidak gagal, dan bukan delegatecall/staticcall/callcode (jenis
//   panggilan yang tidak memindahkan nilai). `to` kosong (create) → contractAddress.
// - Token native: address 'native', simbol per chain dari QUOTE_ASSETS (ETH di ethereum/base/arbitrum/optimism, BNB
//   di bsc, POL di polygon), decimals 18.
// - txMeta digabung per hash dari baris txlist: initiator = tx.from, toContract = tx.to (null untuk pembuatan
//   kontrak), method = bagian functionName sebelum '(' atau methodId; bila hash tidak ada di txlist (wallet bukan
//   pengirim/penerima tx tingkat atas) initiator & toContract = null dan method diambil dari functionName/methodId
//   baris tokentx bila ada. providerCategory & dex selalu null (Etherscan tidak mengategorikan).
// - usdValue selalu null (provider ini tidak memberi harga historis); valuasi native/wrapped-native dilakukan
//   nativePrices.js#enrichNativeUsd.
// - Tx gagal: semua baris dengan hash tx gagal (dari txlist) dilewati, termasuk tokentx/internal (defensif).
//
// ─── logIndex (kunci dedupe (chain, txHash, logIndex)) ───────────────────────────────────────────────
// - tokentx dengan field `logIndex` numerik (desimal/hex, < 10^15) → dipakai apa adanya. Apakah Etherscan tokentx
//   memuat logIndex BELUM TERVERIFIKASI; bila tidak ada → indeks sintetis, dan `diagnostics.syntheticLogIndex` true.
// - Indeks sintetis bergantung HANYA pada isi transfer, bukan urutan respons atau wallet yang di-query:
//     token    = 1e15 + h48(hash | kontrak | from | to | value | k)
//     internal = 2e15 + h48(hash | from | to | value | k)
//     native tingkat atas (txlist) = 3e15 (satu per tx)
//   h48 = 48 bit pertama SHA-256; k = urutan kemunculan baris identik dalam tx (0, 1, …) sehingga dua transfer
//   identik yang sah tetap dua baris. Penyimpangan dari usulan awal (1_000_000 + ordinal setelah sortir; native = 0):
//   (a) native = 0 bentrok dengan logIndex asli 0 (log pertama di blok) → normalizeTransfers akan membuang salah satu
//   transfer sebagai "duplikat"; (b) ordinal setelah sortir bergantung pada baris lain milik wallet yang di-query,
//   sehingga transfer A→B mendapat indeks berbeda dari query wallet A dan wallet B — bila batch digabung, transfer
//   terhitung dua kali. Rentang 1e15–3e15 < Number.MAX_SAFE_INTEGER dan jauh di atas logIndex asli.
//
// ─── Kursor, paginasi, kelengkapan per tx ─────────────────────────────────────────────────────────
// Kursor = string JSON `{"startBlock": n}` (sama untuk semua provider kompatibel Etherscan). Tanpa kursor mulai dari
// blok 0. Ketiga action di-query dari startBlock yang sama; satu batch hanya memuat blok yang LENGKAP di ketiga
// daftar, supaya kaki-kaki satu tx (token + native + internal) selalu terklasifikasi bersama:
// - Halaman penuh (baris mentah ≥ pageSize) pada action mana pun → batas = blok terakhir halaman tersebut
//   (terkecil di antara action penuh); hanya baris blok < batas yang dikembalikan, nextCursor = { startBlock: batas }
//   (blok batas di-query ulang; duplikat dibuang normalizeTransfers).
// - Satu blok berisi ≥ pageSize baris untuk satu action (tidak bisa maju dengan kursor blok) → blok itu diterima
//   apa adanya, peringatan di diagnostics, kursor maju ke blok berikutnya (mencegah loop tak berujung).
// - Baris lebih baru dari `clock() − settleMs` (default 2 menit) DITAHAN ke panggilan berikutnya: melindungi dari
//   reorg dangkal dan pengindeksan yang belum serentak antar-daftar (mis. internal tx tercatat belakangan) — kalau
//   tidak, kaki swap terpecah ke dua batch dan Activity pertama (INSERT OR IGNORE) tersimpan salah selamanya.
// - nextCursor = null bila tidak ada halaman penuh yang membatasi. `resumeCursor` (tambahan di luar kontrak) =
//   kursor untuk dilanjutkan pada sinkronisasi BERIKUTNYA: blok terakhir yang terlihat (di-query ulang), blok
//   tertahan pertama, atau nextCursor. Sinkronisasi cukup menyimpan resumeCursor setiap batch dan melanjutkan
//   paginasi selama nextCursor ≠ null; tanpa itu setiap sinkronisasi mengulang dari blok 0.
// - `since` (epoch ms) hanya MENYARING baris (blockTime < since dibuang); ia tidak memilih blok awal (tanpa
//   panggilan tambahan getblocknobytime). Kedalaman riwayat tier gratis dibatasi 1.000 baris per permintaan
//   (docs/14: maks rekaman per permintaan turun 10.000 → 1.000 sejak 2026-07-01): sinkronisasi pertama wallet aktif
//   membutuhkan ceil(baris/1000) halaman per action dari blok 0; batasi halaman per run dan lanjutkan via kursor.
// - asOf = clock() bila tertangkap penuh; clock() − settleMs bila ada baris ditahan; saat paginasi = blockTime
//   terbaru yang lengkap (data baru lengkap sampai titik itu, kesegaran tidak dilebih-lebihkan).
//
// ─── Batas laju ─────────────────────────────────────────────────────────────────────────────────
// createThrottle({ ratePerSec }) + createDailyBudget({ limit: dailyBudget }) per instans adapter (batas provider per
// kunci/IP, lintas chain). Kuota diambil tepat sebelum tiap panggilan; `quota()` mengembalikan status kuota +
// `blockedUntil` (jeda setelah provider melaporkan batas laju).

import { createHash } from 'node:crypto';
import { EVM_CHAINS, NATIVE_TOKEN, QUOTE_ASSETS, normalizeAddress, normalizeTxHash } from '../contracts.js';
import { fetchJson, notSupported } from './adapter.js';
import { ProviderError, redactSecrets, toProviderError } from './errors.js';
import { createDailyBudget, createThrottle } from './throttle.js';

/** Chain id EIP-155 untuk parameter `chainid` Etherscan V2 dan path Routescan. */
export const EVM_CHAIN_IDS = Object.freeze({
  ethereum: 1, optimism: 10, bsc: 56, polygon: 137, base: 8453, arbitrum: 42161,
});

/** Action akun yang dipanggil, berurutan (tokentx dulu: kegagalan chain tidak didukung terdeteksi di panggilan 1). */
export const ETHERSCAN_ACTIONS = Object.freeze(['tokentx', 'txlist', 'txlistinternal']);

export const DEFAULT_PAGE_SIZE = 1000;
export const MAX_PAGE_SIZE = 10_000;
export const DEFAULT_END_BLOCK = 2_147_483_647;
export const DEFAULT_SETTLE_MS = 120_000;

/** Basis logIndex sintetis (lihat catatan di atas). logIndex asli harus < SYNTHETIC_LOG_INDEX.token. */
export const SYNTHETIC_LOG_INDEX = Object.freeze({
  token: 1_000_000_000_000_000,
  internal: 2_000_000_000_000_000,
  nativeTx: 3_000_000_000_000_000,
});

const DEFAULT_TIMEOUT_MS = 15_000;
const RATE_LIMIT_RETRY_MS = 1000;
const UNSUPPORTED_CHAIN_TTL_MS = 3_600_000;
const DAY_MS = 86_400_000;
const NATIVE_DECIMALS = 18;
const MAX_DECIMALS = 255;
const MAX_UNKNOWN_FIELDS = 50;
const MAX_WARNINGS = 20;
const PROVIDER_TEXT_MAX = 160;
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const NATIVE_NAMES = Object.freeze({ ETH: 'Ether', BNB: 'BNB', POL: 'POL' });
const NON_VALUE_CALL_TYPES = new Set(['delegatecall', 'staticcall', 'callcode']);

const RATE_LIMIT_RE = /rate[\s-]*limit|max(?:imum)?\s+calls|limit\s+reached/i;
const DAILY_RE = /daily|per\s+day|\/\s*day/i;
const INVALID_KEY_RE = /(?:invalid|missing)(?:\s*\/\s*(?:invalid|missing))?\s*api[\s-]*key/i;
const NOT_SUPPORTED_RE = /\b(?:not\s+supported|unsupported|upgrade|paid|plans?|tiers?)\b/i;
const API_KEY_RE = /api[\s-]*key/i;
const TIMEOUT_RE = /time[\s-]*out|timed\s+out/i;
const NO_RESULTS_RE = /no\s+(?:transactions|records|data)\s+found/i;

/**
 * Field per action. `required` wajib ada agar baris dapat diurai; `used` dipakai bila ada (ketiadaannya mengubah
 * hasil, mis. logIndex → indeks sintetis); `known` terdokumentasi tetapi tidak dipakai. Field hilang dari
 * required/used → diagnostics.missingFields; field di luar ketiganya → diagnostics.unknownFields.
 */
const FIELD_SPEC = Object.freeze({
  tokentx: {
    required: ['blockNumber', 'timeStamp', 'hash', 'from', 'to', 'contractAddress', 'value', 'tokenDecimal'],
    used: ['tokenSymbol', 'tokenName', 'logIndex', 'methodId', 'functionName'],
    known: ['nonce', 'blockHash', 'transactionIndex', 'gas', 'gasPrice', 'gasUsed', 'cumulativeGasUsed', 'input', 'confirmations'],
  },
  txlist: {
    required: ['blockNumber', 'timeStamp', 'hash', 'from', 'to', 'value'],
    used: ['isError', 'txreceipt_status', 'contractAddress', 'methodId', 'functionName'],
    known: ['nonce', 'blockHash', 'transactionIndex', 'gas', 'gasPrice', 'gasUsed', 'cumulativeGasUsed', 'input', 'confirmations'],
  },
  txlistinternal: {
    required: ['blockNumber', 'timeStamp', 'hash', 'from', 'to', 'value'],
    used: ['isError', 'type', 'contractAddress', 'traceId'],
    known: ['input', 'gas', 'gasUsed', 'errCode'],
  },
});

// Karakter kontrol C0/C1 dan kontrol arah teks (dipakai token spam untuk memalsukan simbol/nama).
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** Teks pihak ketiga: buang karakter kontrol, rapikan spasi, potong. */
function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  const out = value.replace(UNSAFE_TEXT_RE, ' ').replace(/\s+/g, ' ').trim();
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

/** Bilangan bulat ≥ 0 aman dari string desimal/hex atau number; null bila tidak valid. */
function toInt(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!/^(?:\d+|0x[0-9a-f]+)$/i.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** Jumlah satuan dasar (wei / satuan token terkecil) → string desimal kanonik, atau null bila tidak valid. */
function toUnits(value) {
  if (typeof value === 'bigint') return value >= 0n ? value.toString() : null;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!/^(?:\d+|0x[0-9a-f]+)$/i.test(s)) return null;
  return BigInt(s).toString();
}

/**
 * Satuan dasar → jumlah token tanpa pembulatan ganda: BigInt menormalkan bilangan bulat, lalu titik desimal
 * disisipkan sebagai teks dan diurai SEKALI oleh Number() (pembulatan terdekat). `Number(value) / 10 ** decimals`
 * membulatkan dua kali (mis. contoh dokumentasi Etherscan 5901522149285533025181 @18 → 5901.5221492855335 alih-alih
 * 5901.522149285533).
 * @param {string|number|bigint} value bilangan bulat ≥ 0 (desimal atau hex 0x…)
 * @param {number} decimals bilangan bulat 0..255
 * @returns {number|null} null bila masukan tidak valid
 */
export function baseUnitsToAmount(value, decimals) {
  const units = toUnits(value);
  if (units === null || !Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) return null;
  if (decimals === 0) return Number(units);
  const padded = units.padStart(decimals + 1, '0');
  const intPart = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, '');
  return Number(fraction === '' ? intPart : `${intPart}.${fraction}`);
}

/** Alamat akun EVM kanonik (huruf kecil) atau null; 'native' bukan alamat akun. */
function evmAddress(chain, value) {
  const a = normalizeAddress(chain, value);
  return a === NATIVE_TOKEN ? null : a;
}

/** Nama metode: bagian functionName sebelum '(' atau methodId 0x + 8 hex; selain itu null. */
function methodName(functionName, methodId) {
  const fn = typeof functionName === 'string' ? functionName.trim() : '';
  if (fn !== '') {
    const name = fn.split('(')[0].trim();
    if (/^[A-Za-z_$][\w$]{0,99}$/.test(name)) return name;
  }
  const id = typeof methodId === 'string' ? methodId.trim().toLowerCase() : '';
  return /^0x[0-9a-f]{8}$/.test(id) ? id : null;
}

function hash48(text) {
  return createHash('sha256').update(text).digest().readUIntBE(0, 6);
}

function nativeTokenOf(chain) {
  const symbol = QUOTE_ASSETS[chain][NATIVE_TOKEN];
  return { address: NATIVE_TOKEN, symbol, name: NATIVE_NAMES[symbol] ?? symbol, decimals: NATIVE_DECIMALS };
}

function encodeCursor(startBlock) {
  return JSON.stringify({ startBlock });
}

/** Kursor → startBlock; null/undefined → 0; bentuk tidak dikenal → null. */
function decodeCursor(cursor) {
  if (cursor === null || cursor === undefined) return 0;
  if (typeof cursor !== 'string' || cursor.length > 200) return null;
  try {
    const parsed = JSON.parse(cursor);
    if (parsed === null || typeof parsed !== 'object') return null;
    return Number.isSafeInteger(parsed.startBlock) && parsed.startBlock >= 0 ? parsed.startBlock : null;
  } catch {
    return null;
  }
}

function msUntilNextUtcDay(now) {
  return (Math.floor(now / DAY_MS) + 1) * DAY_MS - now;
}

function checkedBaseUrl(value, chain) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new TypeError(`urlForChain(${chain}) bukan URL valid`);
  }
  if (url.protocol !== 'https:') throw new TypeError(`urlForChain(${chain}) wajib https`);
  if (url.username !== '' || url.password !== '') throw new TypeError(`urlForChain(${chain}) tidak boleh memuat kredensial`);
  return url.href;
}

/** Baris mentah satu action → catatan antara (null bila field wajib tidak valid). */
function parseRow(action, chain, row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return null;
  const blockNumber = toInt(row.blockNumber);
  const seconds = toInt(row.timeStamp);
  const hash = normalizeTxHash(chain, row.hash);
  const from = evmAddress(chain, row.from);
  const units = toUnits(row.value);
  if (blockNumber === null || seconds === null || hash === null || from === null || units === null) return null;
  const blockTime = seconds * 1000;
  if (!Number.isSafeInteger(blockTime)) return null;
  const base = { blockNumber, blockTime, hash, from, units };

  if (action === 'tokentx') {
    const to = evmAddress(chain, row.to);
    const contract = evmAddress(chain, row.contractAddress);
    const decimals = toInt(row.tokenDecimal);
    if (to === null || contract === null || decimals === null || decimals > MAX_DECIMALS) return null;
    const logIndex = toInt(row.logIndex);
    return {
      ...base, to, contract, decimals,
      symbol: cleanText(row.tokenSymbol, 32) || null,
      name: cleanText(row.tokenName, 80) || null,
      logIndex: logIndex !== null && logIndex < SYNTHETIC_LOG_INDEX.token ? logIndex : null,
      method: methodName(row.functionName, row.methodId),
      nft: row.tokenID !== undefined && row.tokenID !== null && row.tokenID !== '',
    };
  }

  // txlist / txlistinternal: `to` kosong = pembuatan kontrak (penerima nilai = contractAddress).
  const rawTo = row.to;
  const emptyTo = rawTo === '' || rawTo === null || rawTo === undefined;
  const to = emptyTo ? null : evmAddress(chain, rawTo);
  if (!emptyTo && to === null) return null;
  const created = typeof row.contractAddress === 'string' && row.contractAddress !== '' ? evmAddress(chain, row.contractAddress) : null;
  const failed = String(row.isError ?? '0').trim() === '1'
    || (action === 'txlist' && String(row.txreceipt_status ?? '').trim() === '0');
  if (action === 'txlist') return { ...base, to, created, failed, method: methodName(row.functionName, row.methodId) };
  return { ...base, to, created, failed, type: typeof row.type === 'string' ? row.type.trim().toLowerCase() : '' };
}

/** Field hilang / tidak dikenal per action (untuk skrip cek terhadap respons live). */
function inspectFields(responses) {
  const missing = new Set();
  const unknown = new Set();
  for (const action of ETHERSCAN_ACTIONS) {
    const spec = FIELD_SPEC[action];
    const expected = [...spec.required, ...spec.used];
    const known = new Set([...expected, ...spec.known]);
    for (const row of responses[action].rows) {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
      for (const f of expected) {
        if (!Object.hasOwn(row, f)) missing.add(`${action}.${f}`);
      }
      for (const k of Object.keys(row)) {
        if (!known.has(k) && unknown.size < MAX_UNKNOWN_FIELDS) unknown.add(`${action}.${cleanText(k, 48)}`);
      }
    }
  }
  return { missingFields: [...missing].sort(), unknownFields: [...unknown].sort() };
}

/**
 * Buat adapter riwayat transfer wallet untuk API berformat Etherscan (kapabilitas 'walletTransfers'; metode lain
 * melempar NOT_SUPPORTED). Galat konfigurasi saat konstruksi → TypeError/RangeError (galat pemrogram saat start);
 * semua kegagalan saat runtime → ProviderError.
 * @param {{
 *   id: string, displayName: string, requiresKey: boolean, apiKey?: string|null, keyMode?: 'query'|'header'|null,
 *   chains: string[], urlForChain: (chain: string) => string, fetchImpl?: typeof fetch, clock?: () => number,
 *   sleep?: (ms: number) => Promise<void>, ratePerSec: number, dailyBudget: number,
 *   terms: { docsUrl: string|null, attribution: string|null, displayAllowed: boolean, notes: string },
 *   pageSize?: number, settleMs?: number, endBlock?: number, timeoutMs?: number,
 * }} options
 *   - `urlForChain`: URL dasar per chain (boleh memuat query, mis. `chainid`); parameter action ditambahkan di sini.
 *   - `pageSize`: baris per permintaan; JANGAN melebihi batas paket (gratis Etherscan = 1.000) — bila provider
 *     memotong diam-diam di bawah pageSize, paginasi berhenti terlalu dini.
 *   - `settleMs`: baris lebih baru dari clock() − settleMs ditahan ke panggilan berikutnya (0 = nonaktif).
 * @returns {object} adapter (docs/15 §3) + `configured: boolean` + `quota()`
 */
export function createEtherscanCompatibleProvider({
  id, displayName, requiresKey, apiKey = null, keyMode = null, chains, urlForChain,
  fetchImpl = globalThis.fetch, clock = Date.now, sleep, ratePerSec, dailyBudget, terms,
  pageSize = DEFAULT_PAGE_SIZE, settleMs = DEFAULT_SETTLE_MS, endBlock = DEFAULT_END_BLOCK, timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof id !== 'string' || !PROVIDER_ID_RE.test(id)) throw new TypeError('id provider tidak valid');
  if (typeof displayName !== 'string' || displayName.trim() === '') throw new TypeError('displayName wajib diisi');
  if (typeof requiresKey !== 'boolean') throw new TypeError('requiresKey harus boolean');
  if (keyMode !== null && keyMode !== 'query' && keyMode !== 'header') throw new TypeError("keyMode harus 'query', 'header', atau null");
  if (!Array.isArray(chains) || chains.length === 0 || chains.some((c) => !EVM_CHAINS.includes(c))) {
    throw new TypeError('chains harus daftar tidak kosong dari chain EVM yang dikenal');
  }
  if (typeof urlForChain !== 'function') throw new TypeError('urlForChain wajib fungsi');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl wajib fungsi');
  if (typeof clock !== 'function') throw new TypeError('clock wajib fungsi');
  if (terms === null || typeof terms !== 'object') throw new TypeError('terms wajib diisi');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) throw new RangeError(`pageSize harus 1..${MAX_PAGE_SIZE}`);
  if (!Number.isSafeInteger(settleMs) || settleMs < 0) throw new RangeError('settleMs harus bilangan bulat ≥ 0');
  if (!Number.isSafeInteger(endBlock) || endBlock < 1) throw new RangeError('endBlock harus bilangan bulat ≥ 1');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new RangeError('timeoutMs harus bilangan bulat ≥ 1');
  const key = typeof apiKey === 'string' && apiKey.trim() !== '' ? apiKey.trim() : null;
  if (key !== null && keyMode === null) throw new TypeError('apiKey diberikan tanpa keyMode');

  const configured = !requiresKey || key !== null;
  const chainList = Object.freeze([...new Set(chains)]);
  const baseUrls = new Map(chainList.map((c) => [c, checkedBaseUrl(urlForChain(c), c)]));
  const throttle = createThrottle({ ratePerSec, clock, sleep });
  const budget = createDailyBudget({ limit: dailyBudget, provider: id, clock });
  let blockedUntil = 0;
  const unsupportedChains = new Map();

  /** Samarkan kunci API (mentah & ter-encode) dan parameter rahasia dari teks. */
  function scrub(text) {
    let out = String(text);
    if (key !== null) {
      for (const variant of new Set([key, encodeURIComponent(key)])) out = out.split(variant).join('REDACTED');
    }
    return redactSecrets(out);
  }

  // Samarkan SEBELUM memotong: kunci yang terpotong di batas 160 karakter tidak boleh tersisa sebagian.
  const providerText = (text) => cleanText(scrub(String(text)), PROVIDER_TEXT_MAX);

  function fail(code, message, extra = {}) {
    return new ProviderError(code, scrub(message), { provider: id, ...extra });
  }

  function throwIfAborted(signal) {
    if (signal?.aborted) throw fail('TIMEOUT', `${id}: permintaan dibatalkan`);
  }

  function startCooldown(ms) {
    blockedUntil = Math.max(blockedUntil, clock() + ms);
  }

  function markUnsupported(chain, message) {
    unsupportedChains.set(chain, { until: clock() + UNSUPPORTED_CHAIN_TTL_MS, message });
    return fail('NOT_SUPPORTED', message);
  }

  /** Tolak lokal (tanpa jaringan) selama jeda batas laju atau chain yang baru saja dinyatakan tidak didukung. */
  function assertCallable(chain) {
    const now = clock();
    if (blockedUntil > now) {
      throw fail('RATE_LIMITED', `${id}: menunggu jeda batas permintaan provider (${Math.ceil((blockedUntil - now) / 1000)} dtk lagi)`, {
        retryAfterMs: blockedUntil - now,
      });
    }
    const u = unsupportedChains.get(chain);
    if (u && u.until > now) throw fail('NOT_SUPPORTED', u.message);
  }

  /** Amplop { status, message, result } → { rows, warnings } atau ProviderError (lihat tabel di atas). */
  function interpretEnvelope(body, chain, action) {
    const where = `${action} ${chain}`;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw fail('BAD_RESPONSE', `${id}: respons ${where} bukan objek { status, message, result }`);
    }
    const status = body.status === undefined || body.status === null ? '' : String(body.status).trim();
    const message = typeof body.message === 'string' ? body.message : '';
    const resultText = typeof body.result === 'string' ? body.result : '';
    if (status === '1') {
      if (!Array.isArray(body.result)) throw fail('BAD_RESPONSE', `${id}: respons ${where} berstatus 1 tanpa daftar result`);
      const note = message.trim();
      const warnings = note !== '' && !/^ok$/i.test(note) ? [`${action}: pesan provider "${providerText(note)}"`] : [];
      return { rows: body.result, warnings };
    }
    if (status !== '0') throw fail('BAD_RESPONSE', `${id}: status respons ${where} tidak dikenal`);
    const text = `${message} ${resultText}`;
    const quoted = providerText(resultText || message || '(kosong)');
    if (RATE_LIMIT_RE.test(text)) {
      const daily = DAILY_RE.test(text);
      const retryAfterMs = daily ? msUntilNextUtcDay(clock()) : RATE_LIMIT_RETRY_MS;
      startCooldown(retryAfterMs);
      throw fail('RATE_LIMITED', `${id}: batas ${daily ? 'harian' : 'laju'} provider tercapai (${where}): "${quoted}"`, { retryAfterMs });
    }
    if (INVALID_KEY_RE.test(text)) throw fail('UNAUTHORIZED', `${id}: kunci API ditolak provider (${where}): "${quoted}"`);
    if (NOT_SUPPORTED_RE.test(text)) {
      throw markUnsupported(chain, scrub(`${id}: chain ${chain} / endpoint tidak tersedia di paket ini (${action}): "${quoted}"`));
    }
    if (API_KEY_RE.test(text)) throw fail('UNAUTHORIZED', `${id}: masalah kunci API (${where}): "${quoted}"`);
    if (TIMEOUT_RE.test(text)) throw fail('TIMEOUT', `${id}: query provider melewati batas waktu (${where}): "${quoted}"`);
    if (NO_RESULTS_RE.test(text) || (Array.isArray(body.result) && body.result.length === 0)) return { rows: [], warnings: [] };
    throw fail('BAD_RESPONSE', `${id}: provider menolak permintaan (${where}): "${quoted}"`);
  }

  function onTransportError(err, chain) {
    const e = toProviderError(err, id);
    if (e.code === 'RATE_LIMITED') startCooldown(e.retryAfterMs ?? RATE_LIMIT_RETRY_MS);
    if (e.status === 404) {
      return markUnsupported(chain, `${id}: endpoint untuk chain ${chain} tidak ditemukan (HTTP 404) — chain kemungkinan tidak dilayani provider ini`);
    }
    return new ProviderError(e.code, scrub(e.message), { provider: id, retryAfterMs: e.retryAfterMs, status: e.status });
  }

  /** Satu permintaan action (lewat throttle + kuota harian). URL yang dikembalikan TANPA kunci. */
  async function request(chain, action, wallet, startBlock, signal) {
    throwIfAborted(signal);
    assertCallable(chain);
    const url = new URL(baseUrls.get(chain));
    const params = {
      module: 'account', action, address: wallet, startblock: startBlock, endblock: endBlock, page: 1, offset: pageSize, sort: 'asc',
    };
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const publicUrl = url.href;
    if (key !== null && keyMode === 'query') url.searchParams.set('apikey', key);
    const headers = key !== null && keyMode === 'header' ? { apikey: key } : {};
    return throttle.schedule(async () => {
      throwIfAborted(signal);
      assertCallable(chain);
      budget.take();
      let body;
      try {
        body = await fetchJson(fetchImpl, url.href, { headers, timeoutMs, signal, provider: id });
      } catch (err) {
        throw onTransportError(err, chain);
      }
      return { ...interpretEnvelope(body, chain, action), url: publicUrl };
    });
  }

  /** Respons tiga action → { transfers, nextCursor, asOf, resumeCursor, diagnostics }. */
  function buildBatch({ chain, wallet, startBlock, since, responses }) {
    const now = clock();
    const diagnostics = {
      range: { fromBlock: startBlock, toBlockExclusive: null },
      requests: ETHERSCAN_ACTIONS.map((a) => responses[a].url),
      rawCounts: Object.fromEntries(ETHERSCAN_ACTIONS.map((a) => [a, responses[a].rows.length])),
      ...inspectFields(responses),
      syntheticLogIndex: false,
      skipped: { invalidRow: 0, failedTx: 0, zeroValue: 0, nonValueCall: 0, notInvolvingWallet: 0, beforeSince: 0, nft: 0 },
      deferred: 0,
      pagedBy: null,
      warnings: ETHERSCAN_ACTIONS.flatMap((a) => responses[a].warnings),
    };
    const warn = (text) => { if (diagnostics.warnings.length < MAX_WARNINGS) diagnostics.warnings.push(text); };

    const parsed = {};
    for (const action of ETHERSCAN_ACTIONS) {
      parsed[action] = [];
      for (const row of responses[action].rows) {
        const rec = parseRow(action, chain, row);
        if (rec === null) diagnostics.skipped.invalidRow += 1;
        else parsed[action].push(rec);
      }
    }

    // Batas cakupan: blok terakhir halaman penuh (terkecil antar-action penuh).
    let fullCut = Infinity;
    for (const action of ETHERSCAN_ACTIONS) {
      if (responses[action].rows.length < pageSize) continue;
      let last = -1;
      let prev = -1;
      let sorted = true;
      for (const r of parsed[action]) {
        if (r.blockNumber < prev) sorted = false;
        prev = r.blockNumber;
        last = Math.max(last, r.blockNumber);
      }
      if (last < 0) throw fail('BAD_RESPONSE', `${id}: halaman ${action} ${chain} penuh tanpa nomor blok valid — paginasi tidak aman`);
      if (!sorted) warn(`${action}: baris tidak terurut naik per blok — kelengkapan halaman tidak terjamin`);
      if (last < fullCut) {
        fullCut = last;
        diagnostics.pagedBy = action;
      }
    }
    if (fullCut <= startBlock) {
      warn(`Blok ${startBlock}: ${diagnostics.pagedBy} berisi ≥ ${pageSize} baris dalam satu blok — sebagian baris blok ini mungkin tidak terbaca; kursor maju ke blok berikutnya`);
      fullCut = startBlock + 1;
    }

    // Baris yang belum "mengendap" ditahan (reorg dangkal / pengindeksan antar-daftar belum serentak).
    const settleBefore = settleMs > 0 ? now - settleMs : Infinity;
    let firstUnsettled = Infinity;
    for (const action of ETHERSCAN_ACTIONS) {
      for (const r of parsed[action]) {
        if (r.blockTime > settleBefore && r.blockNumber < firstUnsettled) firstUnsettled = r.blockNumber;
      }
    }
    const pagingBinding = fullCut !== Infinity && fullCut <= firstUnsettled;
    const cut = Math.min(fullCut, firstUnsettled);
    diagnostics.range.toBlockExclusive = cut === Infinity ? null : cut;

    const failedHashes = new Set(parsed.txlist.filter((r) => r.failed).map((r) => r.hash));
    const txByHash = new Map();
    for (const r of parsed.txlist) if (!txByHash.has(r.hash)) txByHash.set(r.hash, r);
    const tokenMethodByHash = new Map();
    for (const r of parsed.tokentx) if (r.method !== null && !tokenMethodByHash.has(r.hash)) tokenMethodByHash.set(r.hash, r.method);
    const metaFor = (hash) => {
      const tx = txByHash.get(hash);
      return {
        initiator: tx?.from ?? null,
        toContract: tx?.to ?? null,
        method: tx?.method ?? tokenMethodByHash.get(hash) ?? null,
        providerCategory: null,
        dex: null,
      };
    };

    // Saringan bersama: rentang lengkap, tx gagal, since.
    const accept = (r) => {
      if (r.blockNumber >= cut) { diagnostics.deferred += 1; return false; }
      if (r.failed || failedHashes.has(r.hash)) { diagnostics.skipped.failedTx += 1; return false; }
      if (since !== null && r.blockTime < since) { diagnostics.skipped.beforeSince += 1; return false; }
      return true;
    };
    const involves = (from, to) => {
      if (from === wallet || to === wallet) return true;
      diagnostics.skipped.notInvolvingWallet += 1;
      return false;
    };
    const occurrences = new Map();
    const occurrence = (ident) => {
      const n = occurrences.get(ident) ?? 0;
      occurrences.set(ident, n + 1);
      return n;
    };
    const transfers = [];
    const push = (r, { logIndex, token, amount, from, to }) => {
      transfers.push({
        chain, txHash: r.hash, logIndex, blockNumber: r.blockNumber, blockTime: r.blockTime, from, to, token, amount,
        usdValue: null, priceSource: null, provider: id, isSimulated: false, txMeta: metaFor(r.hash),
      });
    };

    for (const r of parsed.tokentx) {
      if (!accept(r)) continue;
      if (r.nft) { diagnostics.skipped.nft += 1; continue; }
      if (r.units === '0') { diagnostics.skipped.zeroValue += 1; continue; }
      if (!involves(r.from, r.to)) continue;
      const amount = baseUnitsToAmount(r.units, r.decimals);
      if (!(amount > 0) || !Number.isFinite(amount)) { diagnostics.skipped.invalidRow += 1; continue; }
      let logIndex = r.logIndex;
      if (logIndex === null) {
        diagnostics.syntheticLogIndex = true;
        const ident = `t|${r.hash}|${r.contract}|${r.from}|${r.to}|${r.units}`;
        logIndex = SYNTHETIC_LOG_INDEX.token + hash48(`${ident}|${occurrence(ident)}`);
      }
      push(r, {
        logIndex, amount, from: r.from, to: r.to,
        token: { address: r.contract, symbol: r.symbol, name: r.name, decimals: r.decimals },
      });
    }

    const native = nativeTokenOf(chain);
    for (const r of parsed.txlist) {
      if (!accept(r) || r.units === '0') continue;
      const to = r.to ?? r.created;
      if (to === null) { diagnostics.skipped.invalidRow += 1; continue; }
      if (!involves(r.from, to)) continue;
      push(r, { logIndex: SYNTHETIC_LOG_INDEX.nativeTx, token: { ...native }, amount: baseUnitsToAmount(r.units, NATIVE_DECIMALS), from: r.from, to });
    }

    for (const r of parsed.txlistinternal) {
      if (!accept(r)) continue;
      if (NON_VALUE_CALL_TYPES.has(r.type)) { diagnostics.skipped.nonValueCall += 1; continue; }
      if (r.units === '0') continue;
      const to = r.to ?? r.created;
      if (to === null) { diagnostics.skipped.invalidRow += 1; continue; }
      if (!involves(r.from, to)) continue;
      const ident = `i|${r.hash}|${r.from}|${to}|${r.units}`;
      push(r, {
        logIndex: SYNTHETIC_LOG_INDEX.internal + hash48(`${ident}|${occurrence(ident)}`),
        token: { ...native }, amount: baseUnitsToAmount(r.units, NATIVE_DECIMALS), from: r.from, to,
      });
    }

    transfers.sort((a, b) => a.blockTime - b.blockTime
      || (a.txHash < b.txHash ? -1 : a.txHash > b.txHash ? 1 : 0)
      || a.logIndex - b.logIndex);

    let maxSeenBlock = null;
    let maxCompleteTime = null;
    for (const action of ETHERSCAN_ACTIONS) {
      for (const r of parsed[action]) {
        if (r.blockNumber >= cut) continue;
        maxSeenBlock = Math.max(maxSeenBlock ?? r.blockNumber, r.blockNumber);
        maxCompleteTime = Math.max(maxCompleteTime ?? r.blockTime, r.blockTime);
      }
    }
    let resumeBlock;
    if (pagingBinding) resumeBlock = fullCut;
    else if (firstUnsettled !== Infinity) resumeBlock = firstUnsettled;
    else resumeBlock = maxSeenBlock ?? startBlock;
    resumeBlock = Math.max(resumeBlock, startBlock);

    let asOf = now;
    if (pagingBinding) asOf = maxCompleteTime ?? now;
    else if (firstUnsettled !== Infinity) asOf = settleBefore;

    return {
      transfers,
      nextCursor: pagingBinding ? encodeCursor(fullCut) : null,
      asOf,
      resumeCursor: encodeCursor(resumeBlock),
      diagnostics,
    };
  }

  /**
   * Transfer wallet (ERC-20 + native + native internal) sejak kursor. Lihat catatan modul untuk kursor, `since`,
   * penahanan baris terbaru, dan diagnostics.
   * @param {{ chain: string, address: string, since?: number|null, cursor?: string|null, signal?: AbortSignal }} query
   * @returns {Promise<{ transfers: object[], nextCursor: string|null, asOf: number, resumeCursor: string, diagnostics: object }>}
   */
  async function fetchWalletTransfers({ chain, address, since = null, cursor = null, signal } = {}) {
    if (!configured) throw fail('NOT_CONFIGURED', `${id}: kunci API belum dikonfigurasi — provider belum dapat dipakai`);
    if (!chainList.includes(chain)) throw fail('NOT_SUPPORTED', `${id}: chain ${cleanText(String(chain), 32)} tidak didukung adapter ini`);
    const wallet = evmAddress(chain, address);
    if (wallet === null) throw fail('BAD_RESPONSE', `${id}: alamat wallet tidak valid untuk chain ${chain}`);
    if (since !== null && since !== undefined && !Number.isFinite(since)) throw fail('BAD_RESPONSE', `${id}: since harus epoch milidetik`);
    const startBlock = decodeCursor(cursor);
    if (startBlock === null) throw fail('BAD_RESPONSE', `${id}: kursor tidak dikenal`);
    const responses = {};
    for (const action of ETHERSCAN_ACTIONS) {
      responses[action] = await request(chain, action, wallet, startBlock, signal);
    }
    return buildBatch({ chain, wallet, startBlock, since: since ?? null, responses });
  }

  return {
    id,
    displayName,
    requiresKey,
    isSimulated: false,
    /** false bila kunci wajib belum diisi (status "belum dikonfigurasi"); di luar kontrak minimum docs/15 §3. */
    configured,
    chains: chainList,
    capabilities: new Set(['walletTransfers']),
    terms: Object.freeze({ ...terms }),
    fetchWalletTransfers,
    fetchLabels: notSupported(id, 'fetchLabels'),
    fetchPrices: notSupported(id, 'fetchPrices'),
    discoverWallets: notSupported(id, 'discoverWallets'),
    fetchBinanceMapping: notSupported(id, 'fetchBinanceMapping'),
    /** Status kuota harian lokal + `blockedUntil` (epoch ms) bila sedang jeda karena batas laju provider. */
    quota() {
      const now = clock();
      return { ...budget.status(), blockedUntil: blockedUntil > now ? blockedUntil : null };
    },
  };
}
