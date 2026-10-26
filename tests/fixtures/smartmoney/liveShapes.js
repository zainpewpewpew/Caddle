// Bentuk respons GeckoTerminal & Binance untuk tes adapter provider smart money.
// BENTUK DARI DOKUMENTASI, BELUM DIREKAM LIVE — lingkungan cloud tidak dapat menjangkau API ini (docs/14 §0).
// Sumber bentuk:
// - GeckoTerminal: tabel field trade resmi (github.com/coingecko/skills references/onchain-ohlcv-trades.md), contoh
//   GET /networks (references/onchain-networks.md), dan klien open source untuk relationships.{base_token,
//   quote_token,dex}.data.id (`{net}_{alamat}`) serta data.attributes.token_prices.
// - Binance: contoh respons di repo resmi binance-connector-rust / binance-connector-js (apiRestrictions; getall
//   dengan networkList[].denomination) dan field exchangeInfo yang sudah dipakai backend/ingestion/binance/parse.js.
// Alamat & hash FIKTIF (dibangkitkan deterministik dari sha256 label), kecuali kontrak publik yang disebut di tes
// (PEPE di Ethereum, BabyDoge di BSC dari contoh dok resmi Binance, mint BONK/WSOL/USDC di Solana).

import { createHash } from 'node:crypto';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const digest = (label) => createHash('sha256').update(`alphalens-live-shape:${label}`).digest();

function base58(bytes) {
  let n = BigInt(`0x${bytes.toString('hex')}`);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** Alamat EVM fiktif (huruf kecil). */
export const fakeEvmAddress = (label) => `0x${digest(label).toString('hex').slice(0, 40)}`;
/** Hash transaksi EVM fiktif. */
export const fakeTxHash = (label) => `0x${digest(label).toString('hex')}`;
/** Alamat/mint Solana fiktif (base58, huruf besar/kecil campuran). */
export const fakeSolanaAddress = (label) => base58(digest(label));
/** Signature transaksi Solana fiktif (base58, 64 byte). */
export const fakeSolanaSignature = (label) => base58(Buffer.concat([digest(label), digest(`${label}:2`)]));

/** Objek mirip Response fetch (yang dibaca adapter: ok, status, headers.get, text()). */
export function jsonResponse(status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), text: async () => text };
}

// ------------------------------------------------------------------------------------------ GeckoTerminal

/** Satu pool dari GET /networks/{net}/tokens/{alamat}/pools. */
export function gtPool({ network, address, base, quote, dex = 'uniswap_v3', name = 'TOKEN / WETH', relationships = true }) {
  const pool = {
    id: `${network}_${address}`,
    type: 'pool',
    attributes: {
      address, name, base_token_price_usd: '0.0000123', quote_token_price_usd: '3500.12', reserve_in_usd: '1500000.5',
      pool_created_at: '2025-01-01T00:00:00Z', volume_usd: { h24: '2500000.1' },
    },
  };
  if (relationships) {
    pool.relationships = {
      base_token: { data: { id: `${network}_${base}`, type: 'token' } },
      quote_token: { data: { id: `${network}_${quote}`, type: 'token' } },
      dex: { data: { id: dex, type: 'dex' } },
    };
  }
  return pool;
}

/**
 * Satu trade dari GET /networks/{net}/pools/{pool}/trades (14 atribut tabel field resmi). `omit` menghapus atribut,
 * `extra` menambah/menimpa atribut.
 */
export function gtTrade({
  network, txHash, logIndex = 0, from, kind, volumeUsd, at, fromToken, toToken, blockNumber = 21_000_000, extra = {}, omit = [],
}) {
  const attributes = {
    block_number: blockNumber,
    tx_hash: txHash,
    tx_from_address: from,
    from_token_amount: '1.5',
    to_token_amount: '123456.7',
    price_from_in_currency_token: '1.0',
    price_to_in_currency_token: '0.0000001',
    price_from_in_usd: '3500.12',
    price_to_in_usd: '0.0000123',
    block_timestamp: new Date(at).toISOString().replace('.000Z', 'Z'),
    kind,
    volume_in_usd: String(volumeUsd),
    from_token_address: fromToken,
    to_token_address: toToken,
    ...extra,
  };
  for (const key of omit) delete attributes[key];
  return { id: `${network}_${blockNumber}_${txHash}_${logIndex}_${Math.floor(at / 1000)}`, type: 'trade', attributes };
}

/** Badan respons daftar JSON:API `{ data: [...] }`. */
export const gtList = (data) => ({ data });

/** Badan respons GET /simple/networks/{net}/token_price/{alamat,…}. */
export function gtPrices(tokenPrices) {
  return { data: { id: '5a5ec4e1-0000-4000-8000-000000000001', type: 'simple_token_price', attributes: { token_prices: tokenPrices } } };
}

// ------------------------------------------------------------------------------------------ Binance

/** Respons GET /sapi/v1/account/apiRestrictions — default = kunci baca-saja (bentuk contoh resmi). */
export function binanceRestrictions(overrides = {}) {
  return {
    ipRestrict: false,
    createTime: 1_767_225_600_000,
    enableReading: true,
    enableWithdrawals: false,
    enableInternalTransfer: false,
    enableMargin: false,
    enableFutures: false,
    permitsUniversalTransfer: false,
    enableVanillaOptions: false,
    enableFixApiTrade: false,
    enableFixReadOnly: true,
    enableSpotAndMarginTrading: false,
    enablePortfolioMarginTrading: false,
    ...overrides,
  };
}

/** Satu entri networkList[] getall (bentuk contoh resmi). */
export function binanceNetwork(network, contractAddress, extra = {}) {
  return {
    network, withdrawIntegerMultiple: '0.01', isDefault: false, depositEnable: true, withdrawEnable: true,
    depositDesc: '', withdrawDesc: '', specialTips: '', specialWithdrawTips: '', name: `${network} (uji)`,
    resetAddressStatus: false, addressRegex: '^(0x)[0-9A-Fa-f]{40}$', memoRegex: '', withdrawFee: '10',
    withdrawMin: '20', withdrawMax: '9999999999', withdrawInternalMin: '0.01', depositDust: '0.01', minConfirm: 5,
    unLockConfirm: 0, sameAddress: false, withdrawTag: false, estimatedArrivalTime: 1, busy: false,
    contractAddressUrl: 'https://etherscan.io/token/', contractAddress, ...extra,
  };
}

/** Satu koin getall (saldo ikut ada di respons asli — adapter wajib mengabaikannya). */
export function binanceCoin(coin, networks, extra = {}) {
  return {
    coin, depositAllEnable: true, withdrawAllEnable: true, name: coin, free: '34941.1', locked: '0', freeze: '0',
    withdrawing: '0', ipoing: '0', ipoable: '0', storage: '0', isLegalMoney: false, trading: true,
    networkList: networks.map((n) => ({ coin, ...n })), ...extra,
  };
}

/** Satu simbol GET /fapi/v1/exchangeInfo. */
export function futuresSymbol(symbol, baseAsset, overrides = {}) {
  return {
    symbol, pair: symbol, contractType: 'PERPETUAL', status: 'TRADING', baseAsset, quoteAsset: 'USDT',
    marginAsset: 'USDT', underlyingType: 'COIN', underlyingSubType: [], ...overrides,
  };
}

/** Satu simbol GET /api/v3/exchangeInfo. */
export function spotSymbol(symbol, baseAsset, overrides = {}) {
  return { symbol, status: 'TRADING', baseAsset, quoteAsset: 'USDT', ...overrides };
}
