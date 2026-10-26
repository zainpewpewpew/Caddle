// Adapter GeckoTerminal (API publik TANPA kunci, https://api.geckoterminal.com/api/v2) untuk Insider / Smart Money
// Radar: penemuan KANDIDAT wallet dari trade DEX pada pool token yang diminati (mis. token yang MATCHED di Binance)
// dan harga USD token. Baca saja; adapter tidak pernah mencatat log.
//
// Verifikasi bentuk data — lingkungan cloud tidak dapat menjangkau API ini (docs/14 §0), jadi semua bentuk di bawah
// berasal dari dokumentasi/klien, BELUM direkam live. Jalankan skrip cek di Mac pengguna sebelum dipakai.
// - GET /networks/{net}/pools/{pool}/trades?trade_volume_in_usd_greater_than=N — 300 trade terakhir dalam 24 jam
//   [R docs/14 §2.2]. Atribut terverifikasi: tx_from_address, kind (buy|sell), volume_in_usd, block_timestamp
//   [R/GH docs/14 §2.3]. Tabel field resmi CoinGecko di github.com/coingecko/skills
//   (references/onchain-ohlcv-trades.md, dibaca 2026-10-26) juga memuat from_token_address / to_token_address
//   ("token sent" / "token received") dan menyebut perspektif buy/sell default = token BASE pool (`token=base`).
//   Semua atribut selain empat yang terverifikasi dibaca defensif; kunci asing dicatat di diagnostik.
// - GET /networks/{net}/tokens/{alamat}/pools — "top pools for a token" [GH: klien dineshpinto/geckoterminal-api;
//   TIDAK tercantum di docs/14]. relationships.base_token / quote_token / dex .data.id berformat `{net}_{alamat}`
//   [GH: beberapa klien open source].
// - GET /simple/networks/{net}/token_price/{alamat,…} — maks 30 alamat per panggilan [GH: MAX_ADDRESSES = 30 di
//   klien yang sama; salinan Swagger GeckoTerminal "up to 30 addresses"]; jawaban data.attributes.token_prices
//   `{ alamat: "harga" }` [GH: beberapa klien open source]. TIDAK tercantum di docs/14.
//
// Aturan penemuan (discoverWallets):
// - Hanya untuk `tokens` yang diberikan pemanggil. Tanpa token → [] + diagnostik (TIDAK memindai pool trending).
//   Token quote (WETH/USDC/…, contracts.QUOTE_ASSETS) dilewati: pembelinya hanyalah penjual token lain.
// - Per token: `maxPoolsPerToken` pool teratas → trade dengan filter USD di query + filter lokal defensif
//   (volume_in_usd tidak terbaca → trade dibuang, bukan dianggap lolos).
// - Pembelian TOKEN KITA (kontrak menyebut kind === 'buy'; di sini ditafsirkan relatif terhadap token kita):
//   token = base pool → kind 'buy'; token = quote pool → kind 'sell' DAN wajib dikonfirmasi to_token_address = token;
//   sisi tidak diketahui → hanya bila to_token_address = token. Bila to_token_address ada dan bertentangan dengan
//   kind → trade dibuang (konflik dicatat). Untuk pool tempat token = base, hasilnya identik dengan kind === 'buy'.
// - Waktu trade ≥ max(since, sekarang − 24 jam) agar teks "dalam 24 jam terakhir" selalu benar. Pemanggil sebaiknya
//   memberi `since` dengan margin untuk trade yang terlambat diindeks; duplikat aman (satu kandidat per alamat,
//   discovery.rankCandidates juga menggabungkan alamat).
// - Alamat dinormalisasi contracts.normalizeAddress (EVM huruf kecil, Solana apa adanya); alamat tidak valid / nol
//   dibuang; trade ganda (id sama) dihitung sekali; satu kandidat per alamat, diurutkan total USD beli (turun).
// - tx_from_address adalah PENGIRIM transaksi (EOA): bisa relayer, bot, solver aggregator (CoW/1inch Fusion/
//   UniswapX), atau bundler smart account — dicatat di `reason`. Kandidat BELUM dinilai; kualitas wallet tetap
//   ditentukan dari riwayat swap (classify → pnl → walletScore).
//
// Diagnostik: kontrak mengharuskan discoverWallets/fetchPrices mengembalikan ARRAY. Diagnostik dilampirkan sebagai
// properti NON-enumerable `diagnostics` pada array hasil (tidak ikut JSON/perbandingan) dan salinannya tersedia lewat
// `lastDiagnostics()` (panggilan terakhir metode mana pun; null sebelum ada panggilan).

import { NATIVE_TOKEN, ZERO_ADDRESS, isQuoteAsset, normalizeAddress } from '../contracts.js';
import { fetchJson, notSupported } from './adapter.js';
import { ProviderError, toProviderError } from './errors.js';
import { createThrottle } from './throttle.js';

export const GECKOTERMINAL_PROVIDER_ID = 'geckoterminal';
export const GECKOTERMINAL_BASE_URL = 'https://api.geckoterminal.com/api/v2';
/** Atribusi WAJIB di UI (docs/14 §2.2: ToS API CoinGecko "Powered by CoinGecko"). */
export const GECKOTERMINAL_ATTRIBUTION = 'Powered by CoinGecko / GeckoTerminal';

/**
 * chain internal → id jaringan GeckoTerminal. `eth`, `bsc`, `polygon_pos` tampil di contoh resmi GET /networks
 * (github.com/coingecko/skills references/onchain-networks.md); `base`, `arbitrum`, `optimism`, `solana` dari
 * pengetahuan umum. SEMUA wajib diverifikasi skrip cek lewat GET /networks (atribut `id`) sebelum dipakai live.
 */
export const GECKOTERMINAL_NETWORKS = Object.freeze({
  ethereum: 'eth',
  base: 'base',
  arbitrum: 'arbitrum',
  optimism: 'optimism',
  bsc: 'bsc',
  polygon: 'polygon_pos',
  solana: 'solana',
});

/** Maksimum alamat per panggilan harga (dok GeckoTerminal: "up to 30 addresses"). */
export const PRICE_BATCH_SIZE = 30;
/** Jendela trade endpoint keyless: 24 jam terakhir. */
export const TRADE_WINDOW_MS = 24 * 3_600_000;
/** Atribut trade yang terverifikasi (docs/14) — ketiadaannya dicatat di diagnostik. */
export const VERIFIED_TRADE_KEYS = Object.freeze(['tx_from_address', 'kind', 'volume_in_usd', 'block_timestamp']);

const ID = GECKOTERMINAL_PROVIDER_ID;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const MAX_LISTED = 50;
/** Atribut trade dari tabel field resmi (dibaca defensif). Kunci lain dicatat sebagai `unknownTradeKeys`. */
const KNOWN_TRADE_KEYS = new Set([
  ...VERIFIED_TRADE_KEYS, 'block_number', 'tx_hash', 'from_token_amount', 'to_token_amount',
  'price_from_in_currency_token', 'price_to_in_currency_token', 'price_from_in_usd', 'price_to_in_usd',
  'from_token_address', 'to_token_address', 'pool_address', 'pool_dex',
]);
const SENDER_NOTE = 'Catatan: alamat ini adalah pengirim transaksi (tx_from_address) — bisa relayer, bot, atau solver '
  + 'aggregator, bukan selalu pemilik dana.';
const usdFormat = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });

const fmtUsd = (v) => `$${usdFormat.format(v)}`;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const shortAddress = (a) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function pushLimited(list, item) {
  if (list.length < MAX_LISTED) list.push(item);
}

function resolveBaseUrl(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError('baseUrl GeckoTerminal bukan URL valid');
  }
  if (url.protocol !== 'https:') throw new TypeError('baseUrl GeckoTerminal wajib https');
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new TypeError('baseUrl GeckoTerminal tidak boleh memuat kredensial, query, atau fragment');
  }
  return url.href.replace(/\/+$/, '');
}

function networkOf(chain) {
  const network = Object.hasOwn(GECKOTERMINAL_NETWORKS, chain) ? GECKOTERMINAL_NETWORKS[chain] : null;
  if (network === null) {
    throw new ProviderError('NOT_SUPPORTED', `${ID}: chain ${String(chain).slice(0, 32)} tidak didukung`, { provider: ID });
  }
  return network;
}

/** Angka desimal dari string/number provider; null bila kosong atau tidak valid. */
function decimalOf(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || v.trim() === '') return null;
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : null;
}

/** Waktu blok (ISO 8601 menurut dok) → epoch ms; null bila tidak valid. */
function timeOf(v) {
  if (typeof v !== 'string' || v.trim() === '') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Alamat dari id relasi GeckoTerminal `{net}_{alamat}`; null bila format lain / tidak valid. */
function addressFromId(chain, network, id) {
  const prefix = `${network}_`;
  if (typeof id !== 'string' || !id.startsWith(prefix)) return null;
  return normalizeAddress(chain, id.slice(prefix.length));
}

/** Sisi token di pool: 'base' | 'quote' | 'unknown' (dari relationships.{base,quote}_token.data.id). */
function sideOf(chain, network, token, relationships) {
  if (!isObject(relationships)) return 'unknown';
  if (addressFromId(chain, network, relationships.base_token?.data?.id) === token) return 'base';
  if (addressFromId(chain, network, relationships.quote_token?.data?.id) === token) return 'quote';
  return 'unknown';
}

/**
 * Apakah trade adalah pembelian TOKEN KITA. Perspektif `kind` = token base pool (default dok `token=base`).
 * @param {'buy'|'sell'} kind
 * @param {'base'|'quote'|'unknown'} side
 * @param {boolean|null} received to_token_address === token (null bila field tidak ada / tidak valid)
 * @returns {'BUY'|'NOT_BUY'|'CONFLICT'|'UNCONFIRMED'}
 */
function buyVerdict(kind, side, received) {
  if (side === 'unknown') {
    if (received === null) return 'UNCONFIRMED';
    return received ? 'BUY' : 'NOT_BUY';
  }
  const byKind = side === 'base' ? kind === 'buy' : kind === 'sell';
  if (received === null) {
    // Sisi quote tanpa konfirmasi alamat: tafsiran perspektif belum terverifikasi live → tidak dipakai.
    if (side === 'quote' && byKind) return 'UNCONFIRMED';
    return byKind ? 'BUY' : 'NOT_BUY';
  }
  if (received !== byKind) return 'CONFLICT';
  return byKind ? 'BUY' : 'NOT_BUY';
}

function symbolOf(v) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[^\p{L}\p{N}._$-]/gu, '').slice(0, 20);
  return s === '' ? null : s;
}

function attachDiagnostics(result, diagnostics) {
  Object.defineProperty(result, 'diagnostics', { value: diagnostics, enumerable: false, configurable: true });
  return result;
}

function tradesOf(body) {
  if (!isObject(body) || !Array.isArray(body.data)) {
    throw new ProviderError('BAD_RESPONSE', `${ID}: respons trade pool tidak memuat array data`, { provider: ID });
  }
  return body.data;
}

/**
 * Adapter GeckoTerminal (keyless). Semua panggilan HTTP lewat satu antrean throttle (default 6/menit; batas resmi
 * keyless ±10/menit dari pool IP bersama, error ikut terhitung — tidak ada retry otomatis).
 * @param {{ fetchImpl?: typeof fetch, clock?: () => number, sleep?: (ms: number) => Promise<void>, perMinute?: number,
 *   minTradeUsd?: number, maxPoolsPerToken?: number, baseUrl?: string }} [options]
 * @returns {object} adapter sesuai docs/15 §3 + `lastDiagnostics()`
 */
export function createGeckoTerminalProvider({
  fetchImpl = globalThis.fetch,
  clock = Date.now,
  sleep,
  perMinute = 6,
  minTradeUsd = 1000,
  maxPoolsPerToken = 2,
  baseUrl = GECKOTERMINAL_BASE_URL,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl wajib fungsi');
  if (typeof clock !== 'function') throw new TypeError('clock wajib fungsi');
  if (typeof minTradeUsd !== 'number' || !Number.isFinite(minTradeUsd) || minTradeUsd < 0) {
    throw new RangeError('minTradeUsd harus angka ≥ 0');
  }
  if (!Number.isInteger(maxPoolsPerToken) || maxPoolsPerToken < 1 || maxPoolsPerToken > 10) {
    throw new RangeError('maxPoolsPerToken harus bilangan bulat 1..10');
  }
  const base = resolveBaseUrl(baseUrl);
  const throttle = createThrottle({ perMinute, clock, sleep });
  let last = null;

  function get(path, signal) {
    return throttle.schedule(async () => {
      if (signal?.aborted) throw new ProviderError('TIMEOUT', `${ID}: permintaan dibatalkan`, { provider: ID });
      return fetchJson(fetchImpl, `${base}${path}`, { provider: ID, signal });
    });
  }

  function finish(result, diagnostics) {
    last = diagnostics;
    return attachDiagnostics(result, diagnostics);
  }

  /** Kegagalan satu token/pool/batch: BAD_RESPONSE (mis. 404 token tak dikenal) dicatat lalu lanjut; lainnya dilempar. */
  function recordOrThrow(err, diagnostics, where) {
    const e = toProviderError(err, ID);
    if (e.code !== 'BAD_RESPONSE') throw e;
    pushLimited(diagnostics.errors, { ...where, code: e.code, message: e.message });
  }

  function tokensOf(chain, tokens, diagnostics) {
    const out = [];
    const seen = new Set();
    for (const t of Array.isArray(tokens) ? tokens : []) {
      const raw = isObject(t) ? t.address : t;
      const shown = String(raw).slice(0, 64);
      if (isObject(t) && t.chain !== undefined && t.chain !== chain) {
        pushLimited(diagnostics.invalidTokens, { address: shown, reason: `chain ${String(t.chain).slice(0, 32)} ≠ ${chain}` });
        continue;
      }
      const address = typeof raw === 'string' ? normalizeAddress(chain, raw) : null;
      if (address === null || address === NATIVE_TOKEN || address === ZERO_ADDRESS) {
        pushLimited(diagnostics.invalidTokens, { address: shown, reason: 'alamat token tidak valid' });
        continue;
      }
      if (isQuoteAsset(chain, address)) {
        pushLimited(diagnostics.invalidTokens, { address, reason: 'aset quote — pembelinya hanyalah penjual token lain' });
        continue;
      }
      if (seen.has(address)) continue;
      seen.add(address);
      out.push({ address, symbol: symbolOf(isObject(t) ? t.symbol : null) });
    }
    return out;
  }

  function poolsOf(body, chain, network, token, diagnostics) {
    if (!isObject(body) || !Array.isArray(body.data)) {
      throw new ProviderError('BAD_RESPONSE', `${ID}: respons pool token tidak memuat array data`, { provider: ID });
    }
    const pools = [];
    const seen = new Set();
    for (const item of body.data) {
      const attrs = isObject(item) && isObject(item.attributes) ? item.attributes : {};
      const address = (typeof attrs.address === 'string' ? normalizeAddress(chain, attrs.address) : null)
        ?? addressFromId(chain, network, isObject(item) ? item.id : null);
      if (address === null || address === NATIVE_TOKEN) {
        pushLimited(diagnostics.poolsSkipped, { token, reason: 'alamat pool tidak valid / tidak ada' });
        continue;
      }
      if (seen.has(address)) continue;
      seen.add(address);
      const relationships = isObject(item) && isObject(item.relationships) ? item.relationships : null;
      const dexId = relationships?.dex?.data?.id;
      pools.push({
        address,
        side: sideOf(chain, network, token, relationships),
        dex: typeof dexId === 'string' && dexId.trim() !== '' ? dexId.trim().slice(0, 64) : null,
      });
    }
    return pools;
  }

  function reasonOf(buyer) {
    const tokens = [...buyer.tokens.entries()].map(([address, symbol]) => symbol ?? shortAddress(address));
    const tokenText = tokens.slice(0, 2).join(', ') + (tokens.length > 2 ? ` +${tokens.length - 2} token lain` : '');
    const pools = [...buyer.pools.entries()].map(([address, dex]) => `${address} (${dex ?? 'DEX tidak diketahui'})`);
    const poolText = pools.slice(0, 2).join(', ') + (pools.length > 2 ? ` +${pools.length - 2} pool lain` : '');
    return `Pembeli ≥ ${fmtUsd(minTradeUsd)} token ${tokenText} di pool ${poolText} dalam 24 jam terakhir — kandidat, `
      + `belum dinilai. ${buyer.txs.size} transaksi beli, total ≈ ${fmtUsd(buyer.totalUsd)}. ${SENDER_NOTE}`;
  }

  /**
   * Kandidat wallet dari pembeli besar di pool teratas token yang diminati.
   * @param {{ chain: string, since?: number|null, limit?: number, tokens?: Array<{ address: string, symbol?: string,
   *   chain?: string }>, signal?: AbortSignal }} params
   * @returns {Promise<Array<{ chain: string, address: string, source: string, reason: string }>>} + `.diagnostics`
   */
  async function discoverWallets({ chain, since = null, limit = DEFAULT_LIMIT, tokens, signal } = {}) {
    const network = networkOf(chain);
    const now = clock();
    const windowStart = now - TRADE_WINDOW_MS;
    const sinceMs = typeof since === 'number' && Number.isFinite(since) ? Math.max(since, windowStart) : windowStart;
    const max = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT;
    const diagnostics = {
      provider: ID, method: 'discoverWallets', chain, network, at: now, since: sinceMs, minTradeUsd,
      tokensRequested: Array.isArray(tokens) ? tokens.length : 0, tokensProcessed: 0, invalidTokens: [],
      pools: [], poolsSkipped: [], tradesSeen: 0, tradesUsed: 0,
      dropped: {
        notBuy: 0, sideConflict: 0, sideUnconfirmed: 0, unknownKind: 0, belowMinUsd: 0, missingVolume: 0,
        missingTime: 0, beforeSince: 0, invalidAddress: 0, duplicate: 0, malformed: 0,
      },
      unknownTradeKeys: [], missingTradeKeys: {}, errors: [], candidates: 0, truncated: false, notes: [],
    };
    const list = tokensOf(chain, tokens, diagnostics);
    if (list.length === 0) {
      diagnostics.notes.push(diagnostics.tokensRequested > 0
        ? 'Tidak ada token valid untuk dipindai — tidak ada penemuan.'
        : 'Tanpa daftar token (mis. token yang MATCHED di Binance) tidak ada penemuan; GeckoTerminal tidak dipakai '
          + 'untuk memindai pool trending.');
      return finish([], diagnostics);
    }

    const unknownKeys = new Set();
    const seenTrades = new Set();
    const buyers = new Map();
    for (const token of list) {
      let pools;
      try {
        const body = await get(`/networks/${network}/tokens/${encodeURIComponent(token.address)}/pools`, signal);
        pools = poolsOf(body, chain, network, token.address, diagnostics);
      } catch (err) {
        recordOrThrow(err, diagnostics, { token: token.address });
        continue;
      }
      diagnostics.tokensProcessed += 1;
      for (const pool of pools.slice(0, maxPoolsPerToken)) {
        let trades;
        try {
          trades = tradesOf(await get(`/networks/${network}/pools/${encodeURIComponent(pool.address)}/trades`
            + `?trade_volume_in_usd_greater_than=${minTradeUsd}`, signal));
        } catch (err) {
          recordOrThrow(err, diagnostics, { token: token.address, pool: pool.address });
          continue;
        }
        const poolInfo = { token: token.address, pool: pool.address, dex: pool.dex, side: pool.side, trades: trades.length, used: 0 };
        pushLimited(diagnostics.pools, poolInfo);
        for (const item of trades) {
          diagnostics.tradesSeen += 1;
          const attrs = isObject(item) && isObject(item.attributes) ? item.attributes : null;
          if (attrs === null) {
            diagnostics.dropped.malformed += 1;
            continue;
          }
          for (const key of Object.keys(attrs)) if (!KNOWN_TRADE_KEYS.has(key)) unknownKeys.add(key);
          for (const key of VERIFIED_TRADE_KEYS) {
            if (attrs[key] === undefined || attrs[key] === null) diagnostics.missingTradeKeys[key] = (diagnostics.missingTradeKeys[key] ?? 0) + 1;
          }
          const kind = typeof attrs.kind === 'string' ? attrs.kind.trim().toLowerCase() : null;
          if (kind !== 'buy' && kind !== 'sell') {
            diagnostics.dropped.unknownKind += 1;
            continue;
          }
          const to = typeof attrs.to_token_address === 'string' ? normalizeAddress(chain, attrs.to_token_address) : null;
          const verdict = buyVerdict(kind, pool.side, to === null ? null : to === token.address);
          if (verdict !== 'BUY') {
            if (verdict === 'NOT_BUY') diagnostics.dropped.notBuy += 1;
            else if (verdict === 'CONFLICT') diagnostics.dropped.sideConflict += 1;
            else diagnostics.dropped.sideUnconfirmed += 1;
            continue;
          }
          const usd = decimalOf(attrs.volume_in_usd);
          if (usd === null || usd < 0) {
            diagnostics.dropped.missingVolume += 1;
            continue;
          }
          if (usd < minTradeUsd) {
            diagnostics.dropped.belowMinUsd += 1;
            continue;
          }
          const at = timeOf(attrs.block_timestamp);
          if (at === null) {
            diagnostics.dropped.missingTime += 1;
            continue;
          }
          if (at < sinceMs) {
            diagnostics.dropped.beforeSince += 1;
            continue;
          }
          const wallet = typeof attrs.tx_from_address === 'string' ? normalizeAddress(chain, attrs.tx_from_address) : null;
          if (wallet === null || wallet === NATIVE_TOKEN || wallet === ZERO_ADDRESS) {
            diagnostics.dropped.invalidAddress += 1;
            continue;
          }
          const txHash = typeof attrs.tx_hash === 'string' && attrs.tx_hash.trim() !== '' ? attrs.tx_hash.trim() : null;
          const tradeKey = typeof item.id === 'string' && item.id !== '' ? item.id : `${pool.address}:${txHash}:${at}:${usd}`;
          if (seenTrades.has(tradeKey)) {
            diagnostics.dropped.duplicate += 1;
            continue;
          }
          seenTrades.add(tradeKey);
          diagnostics.tradesUsed += 1;
          poolInfo.used += 1;
          let buyer = buyers.get(wallet);
          if (!buyer) {
            buyer = { address: wallet, totalUsd: 0, lastAt: at, txs: new Set(), pools: new Map(), tokens: new Map() };
            buyers.set(wallet, buyer);
          }
          buyer.totalUsd += usd;
          buyer.lastAt = Math.max(buyer.lastAt, at);
          buyer.txs.add(txHash ?? tradeKey);
          if (!buyer.pools.has(pool.address)) buyer.pools.set(pool.address, pool.dex);
          if (!buyer.tokens.has(token.address)) buyer.tokens.set(token.address, token.symbol);
        }
      }
    }

    const ranked = [...buyers.values()]
      .sort((a, b) => b.totalUsd - a.totalUsd || b.lastAt - a.lastAt || compareText(a.address, b.address));
    diagnostics.candidates = ranked.length;
    diagnostics.truncated = ranked.length > max;
    diagnostics.unknownTradeKeys = [...unknownKeys].sort().slice(0, MAX_LISTED);
    const result = ranked.slice(0, max).map((b) => ({ chain, address: b.address, source: ID, reason: reasonOf(b) }));
    return finish(result, diagnostics);
  }

  /**
   * Harga USD terkini per alamat token (batch ≤ 30 alamat per panggilan). Harga kosong / tidak terbaca / ≤ 0 dilewati
   * (dicatat di diagnostik) — tidak pernah diganti 0.
   * @param {{ chain: string, addresses?: string[], signal?: AbortSignal }} params
   * @returns {Promise<Array<{ chain: string, address: string, priceUsd: number, at: number, source: string }>>}
   */
  async function fetchPrices({ chain, addresses, signal } = {}) {
    const network = networkOf(chain);
    const diagnostics = {
      provider: ID, method: 'fetchPrices', chain, network, at: clock(), requested: 0, batches: 0, prices: 0,
      invalidAddresses: [], missing: [], unparsable: [], unknownKeys: [], errors: [],
    };
    const wanted = [];
    const seen = new Set();
    for (const a of Array.isArray(addresses) ? addresses : []) {
      const address = typeof a === 'string' ? normalizeAddress(chain, a) : null;
      if (address === null || address === NATIVE_TOKEN) {
        pushLimited(diagnostics.invalidAddresses, String(a).slice(0, 64));
        continue;
      }
      if (!seen.has(address)) {
        seen.add(address);
        wanted.push(address);
      }
    }
    diagnostics.requested = wanted.length;
    const out = [];
    for (let i = 0; i < wanted.length; i += PRICE_BATCH_SIZE) {
      const batch = wanted.slice(i, i + PRICE_BATCH_SIZE);
      let prices;
      try {
        const body = await get(`/simple/networks/${network}/token_price/${batch.map(encodeURIComponent).join(',')}`, signal);
        prices = isObject(body) && isObject(body.data) && isObject(body.data.attributes) ? body.data.attributes.token_prices : null;
        if (!isObject(prices)) {
          throw new ProviderError('BAD_RESPONSE', `${ID}: respons harga tidak memuat data.attributes.token_prices`, { provider: ID });
        }
      } catch (err) {
        recordOrThrow(err, diagnostics, { batch: i / PRICE_BATCH_SIZE });
        continue;
      }
      diagnostics.batches += 1;
      const at = clock();
      const byAddress = new Map();
      for (const [key, value] of Object.entries(prices)) {
        const address = normalizeAddress(chain, key);
        if (address === null) pushLimited(diagnostics.unknownKeys, key.slice(0, 64));
        else byAddress.set(address, value);
      }
      for (const address of batch) {
        if (!byAddress.has(address)) {
          pushLimited(diagnostics.missing, address);
          continue;
        }
        const priceUsd = decimalOf(byAddress.get(address));
        if (priceUsd === null || priceUsd <= 0) {
          pushLimited(diagnostics.unparsable, address);
          continue;
        }
        out.push({ chain, address, priceUsd, at, source: ID });
      }
    }
    diagnostics.prices = out.length;
    return finish(out, diagnostics);
  }

  return {
    id: ID,
    displayName: 'GeckoTerminal (CoinGecko)',
    requiresKey: false,
    isSimulated: false,
    chains: Object.keys(GECKOTERMINAL_NETWORKS),
    capabilities: new Set(['walletDiscovery', 'prices']),
    terms: {
      docsUrl: 'https://docs.coingecko.com/docs/keyless-public-api',
      attribution: GECKOTERMINAL_ATTRIBUTION,
      displayAllowed: true,
      notes: 'API publik GeckoTerminal tanpa kunci: ±10 panggilan/menit dari pool IP bersama (adapter memakai '
        + `${perMinute}/menit), error 4xx/5xx ikut terhitung; bukan untuk produksi atau polling berat. Trade hanya 300 `
        + 'terakhir dalam 24 jam per pool; tx_from_address = pengirim transaksi (bisa relayer/bot/aggregator). '
        + `Wajib menampilkan atribusi "${GECKOTERMINAL_ATTRIBUTION}".`,
    },

    /** Salinan diagnostik panggilan terakhir (discoverWallets / fetchPrices), atau null. */
    lastDiagnostics: () => (last === null ? null : structuredClone(last)),

    fetchWalletTransfers: notSupported(ID, 'fetchWalletTransfers'),
    fetchLabels: notSupported(ID, 'fetchLabels'),
    fetchBinanceMapping: notSupported(ID, 'fetchBinanceMapping'),
    fetchPrices,
    discoverWallets,
  };
}
