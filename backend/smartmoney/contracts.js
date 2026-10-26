// Kontrak data bersama modul Insider / Smart Money Radar (backend/smartmoney/*).
// Lihat docs/15-kontrak-smart-money.md untuk antarmuka lengkap. Fitur ini BACA SAJA: tidak pernah meminta seed
// phrase / private key dan tidak pernah mengirim transaksi. "Insider" hanya nama fitur — tidak ada modul yang boleh
// menyimpulkan pemilik wallet memiliki informasi orang dalam.

/** Chain yang dikenali. Alamat EVM dinormalisasi huruf kecil; alamat Solana (base58) peka huruf besar/kecil. */
export const EVM_CHAINS = Object.freeze(['ethereum', 'base', 'arbitrum', 'optimism', 'bsc', 'polygon']);
export const CHAINS = Object.freeze([...EVM_CHAINS, 'solana']);

/** Penjelajah blok resmi per chain untuk tautan verifikasi transaksi/alamat. */
export const EXPLORERS = Object.freeze({
  ethereum: 'https://etherscan.io',
  base: 'https://basescan.org',
  arbitrum: 'https://arbiscan.io',
  optimism: 'https://optimistic.etherscan.io',
  bsc: 'https://bscscan.com',
  polygon: 'https://polygonscan.com',
  solana: 'https://solscan.io',
});

/**
 * Jenis aktivitas hasil klasifikasi (backend/smartmoney/classify.js). HANYA SWAP_BUY yang dihitung sebagai
 * pembelian dan HANYA SWAP_SELL sebagai penjualan. CEX_DEPOSIT = indikasi keluar (belum tentu dijual);
 * TRANSFER_IN / CEX_WITHDRAWAL / BRIDGE_IN / AIRDROP / MINT / LP_REMOVE bukan pembelian.
 */
export const ACTIVITY_TYPES = Object.freeze([
  'SWAP_BUY', 'SWAP_SELL',
  'TRANSFER_IN', 'TRANSFER_OUT',
  'CEX_WITHDRAWAL', 'CEX_DEPOSIT',
  'BRIDGE_IN', 'BRIDGE_OUT',
  'AIRDROP', 'MINT', 'BURN',
  'LP_ADD', 'LP_REMOVE',
  'UNKNOWN',
]);
export const BUY_TYPES = Object.freeze(['SWAP_BUY']);
export const SELL_TYPES = Object.freeze(['SWAP_SELL']);
/** Aktivitas masuk tanpa harga beli yang diketahui (lot berbiaya tidak diketahui di PnL). */
export const UNKNOWN_COST_IN_TYPES = Object.freeze(['TRANSFER_IN', 'CEX_WITHDRAWAL', 'BRIDGE_IN', 'AIRDROP', 'MINT', 'LP_REMOVE']);
/** Aktivitas keluar yang memindahkan token tanpa merealisasikan PnL. */
export const MOVE_OUT_TYPES = Object.freeze(['TRANSFER_OUT', 'CEX_DEPOSIT', 'BRIDGE_OUT', 'LP_ADD', 'BURN']);

export const CLASSIFICATION_CONFIDENCE = Object.freeze(['HIGH', 'MEDIUM', 'LOW']);

/** Kategori label alamat. Label selalu disimpan bersama sumbernya. */
export const LABEL_CATEGORIES = Object.freeze([
  'cex', 'cex_deposit', 'bridge', 'dex_router', 'dex_pool', 'lp_token', 'airdrop_distributor',
  'mev_bot', 'market_maker', 'fund', 'smart_money', 'contract', 'other',
]);

/** Penanda risiko wallet (backend/smartmoney/walletFlags.js). */
export const WALLET_FLAGS = Object.freeze([
  'CEX', 'MARKET_MAKER', 'BOT', 'MEV', 'AIRDROP_FARMER', 'CONTRACT', 'DEX_INFRA', 'LINKED', 'LOW_HISTORY', 'INCOMPLETE_PNL',
]);
export const FLAG_SEVERITIES = Object.freeze(['HIGH', 'MEDIUM', 'LOW']);
/** Penanda yang (pada severity HIGH) mengeluarkan wallet dari peringkat & radar. */
export const EXCLUDING_FLAGS = Object.freeze(['CEX', 'MARKET_MAKER', 'BOT', 'MEV', 'CONTRACT', 'DEX_INFRA']);

export const TRADING_STYLES = Object.freeze(['SCALPER', 'SWING', 'POSITION', 'MIXED', 'UNKNOWN']);
export const PNL_COMPLETENESS = Object.freeze(['COMPLETE', 'PARTIAL', 'UNKNOWN']);

export const RADAR_WINDOWS = Object.freeze({ '1h': 3_600_000, '4h': 4 * 3_600_000, '24h': 24 * 3_600_000, '7d': 7 * 24 * 3_600_000 });
export const RADAR_STATES = Object.freeze(['ACCUMULATING', 'MIXED', 'DISTRIBUTING', 'EXITING']);

export const ALERT_KINDS = Object.freeze(['NEW_BUY', 'REPEAT_ACCUMULATION', 'MULTI_WALLET_BUY', 'LARGE_SELL', 'WALLET_EXIT']);
export const ALERT_SEVERITIES = Object.freeze(['HIGH', 'MEDIUM', 'LOW']);

/** Status pencocokan token on-chain → pasar Binance (backend/smartmoney/binanceMatch.js). */
export const MATCH_STATUSES = Object.freeze(['MATCHED', 'SYMBOL_ONLY', 'AMBIGUOUS', 'NOT_LISTED']);
export const RELEVANCE_LEVELS = Object.freeze(['TINGGI', 'SEDANG', 'RENDAH', 'TIDAK_TERHUBUNG']);

export const PROVIDER_CAPABILITIES = Object.freeze([
  'walletTransfers', 'labels', 'prices', 'walletDiscovery', 'binanceMapping', 'holdings', 'tokenMeta',
]);
export const PROVIDER_ERROR_CODES = Object.freeze([
  'RATE_LIMITED', 'UNAUTHORIZED', 'UNAVAILABLE', 'BAD_RESPONSE', 'TIMEOUT', 'NOT_SUPPORTED', 'NOT_CONFIGURED',
]);

/** Alamat token native per chain (ETH, BNB, POL, SOL) dalam data kanonik. */
export const NATIVE_TOKEN = 'native';
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_TX_RE = /^0x[0-9a-fA-F]{64}$/;
const SOLANA_TX_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

export function isChain(chain) {
  return CHAINS.includes(chain);
}

export function isEvmChain(chain) {
  return EVM_CHAINS.includes(chain);
}

/**
 * Alamat kanonik: EVM → huruf kecil; Solana → apa adanya. NATIVE_TOKEN diterima sebagai alamat token.
 * @returns {string|null} null bila tidak valid untuk chain tersebut
 */
export function normalizeAddress(chain, address) {
  if (typeof address !== 'string') return null;
  const a = address.trim();
  if (a === NATIVE_TOKEN) return NATIVE_TOKEN;
  if (isEvmChain(chain)) return EVM_ADDRESS_RE.test(a) ? a.toLowerCase() : null;
  if (chain === 'solana') return SOLANA_ADDRESS_RE.test(a) ? a : null;
  return null;
}

/** Hash transaksi kanonik (EVM huruf kecil) atau null bila tidak valid. */
export function normalizeTxHash(chain, hash) {
  if (typeof hash !== 'string') return null;
  const h = hash.trim();
  if (isEvmChain(chain)) return EVM_TX_RE.test(h) ? h.toLowerCase() : null;
  if (chain === 'solana') return SOLANA_TX_RE.test(h) ? h : null;
  return null;
}

/** Kunci token unik lintas chain: `chain:alamat`. Simbol TIDAK PERNAH dipakai sebagai identitas token. */
export function tokenKey(chain, address) {
  return `${chain}:${address}`;
}

/** Kunci wallet unik lintas chain: `chain:alamat`. */
export function walletKey(chain, address) {
  return `${chain}:${address}`;
}

export function explorerTxUrl(chain, txHash) {
  const base = EXPLORERS[chain];
  return base ? `${base}/tx/${txHash}` : null;
}

export function explorerAddressUrl(chain, address) {
  const base = EXPLORERS[chain];
  if (!base) return null;
  return chain === 'solana' ? `${base}/account/${address}` : `${base}/address/${address}`;
}

export function explorerTokenUrl(chain, address) {
  const base = EXPLORERS[chain];
  if (!base || address === NATIVE_TOKEN) return null;
  return `${base}/token/${address}`;
}

/**
 * Aset "quote" (native, wrapped native, stablecoin utama, serta ETH bridged yang umum dipakai sebagai alat bayar)
 * per chain. Swap token X ↔ aset quote menentukan arah beli/jual X. Aset quote tidak pernah menjadi target radar
 * akumulasi dan tidak dihitung sebagai posisi PnL. Alamat kontrak resmi (huruf kecil); hanya alamat yang telah
 * diverifikasi yang dicantumkan — lebih baik aset quote terlewat daripada salah alamat.
 * Simbol `USDC.e` = USDC bridged (versi lama sebelum USDC native), `USDbC` = USD Base Coin (USDC bridged di Base).
 */
export const QUOTE_ASSETS = Object.freeze({
  ethereum: Object.freeze({
    [NATIVE_TOKEN]: 'ETH',
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'WETH',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
    '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT',
    '0x6b175474e89094c44da98b954eedeac495271d0f': 'DAI',
  }),
  base: Object.freeze({
    [NATIVE_TOKEN]: 'ETH',
    '0x4200000000000000000000000000000000000006': 'WETH',
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC',
    '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': 'USDbC',
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 'DAI',
  }),
  arbitrum: Object.freeze({
    [NATIVE_TOKEN]: 'ETH',
    '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': 'WETH',
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 'USDC',
    '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': 'USDC.e',
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': 'USDT',
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': 'DAI',
  }),
  optimism: Object.freeze({
    [NATIVE_TOKEN]: 'ETH',
    '0x4200000000000000000000000000000000000006': 'WETH',
    '0x0b2c639c533813f4aa9d7837caf62653d097ff85': 'USDC',
    '0x7f5c764cbc14f9669b88837ca1490cca17c31607': 'USDC.e',
    '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58': 'USDT',
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': 'DAI',
  }),
  bsc: Object.freeze({
    [NATIVE_TOKEN]: 'BNB',
    '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': 'WBNB',
    '0x55d398326f99059ff775485246999027b3197955': 'USDT',
    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 'USDC',
    '0xc5f0f7b66764f6ec8c8dff7ba683102295e16409': 'FDUSD',
    '0xe9e7cea3dedca5984780bafc599bd69add087d56': 'BUSD',
    '0x2170ed0880ac9a755fd29b2688956bd959f933f8': 'ETH', // Binance-Peg Ethereum Token (bukan native BSC)
  }),
  polygon: Object.freeze({
    [NATIVE_TOKEN]: 'POL',
    '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270': 'WPOL',
    '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619': 'WETH', // ETH bridged (PoS) — bukan wrapped native POL
    '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': 'USDC',
    '0x2791bca1f2de4661ed88a30c99a7a9449aa84174': 'USDC.e',
    '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': 'USDT',
    '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063': 'DAI',
  }),
  solana: Object.freeze({
    [NATIVE_TOKEN]: 'SOL',
    So11111111111111111111111111111111111111112: 'WSOL',
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
    Es9vMFrzaCERmJfrF4H7YaQ7Z8u7c8pZx1Lq6Y6ZQ4oQ: 'USDT',
  }),
});

export function isQuoteAsset(chain, address) {
  return Object.prototype.hasOwnProperty.call(QUOTE_ASSETS[chain] ?? {}, address);
}

/** Simbol stablecoin USD di QUOTE_ASSETS. Hanya aset ini yang dinilai 1 USD/unit (classify.js). */
export const STABLECOIN_SYMBOLS = Object.freeze(['USDC', 'USDC.e', 'USDbC', 'USDT', 'DAI', 'FDUSD', 'BUSD']);

/** Stablecoin USD per chain: alamat kontrak → simbol (subset QUOTE_ASSETS, diturunkan dari STABLECOIN_SYMBOLS). */
export const STABLECOINS = Object.freeze(Object.fromEntries(Object.entries(QUOTE_ASSETS).map(([chain, assets]) => [
  chain,
  Object.freeze(Object.fromEntries(Object.entries(assets).filter(([, symbol]) => STABLECOIN_SYMBOLS.includes(symbol)))),
])));

/** true bila token adalah stablecoin USD (1 USD/unit) di chain tersebut. Identitas = alamat kontrak, bukan simbol. */
export function isStablecoinAsset(chain, address) {
  return Object.prototype.hasOwnProperty.call(STABLECOINS[chain] ?? {}, address);
}

/**
 * Alamat wrapped native per chain (simbol 'W' + simbol native di QUOTE_ASSETS: WETH, WBNB, WPOL, WSOL). Deposit/withdraw
 * kontrak ini sering diindeks sebagai mint dari / burn ke ZERO_ADDRESS — itu bungkus/buka koin native, BUKAN LP.
 */
export const WRAPPED_NATIVE = Object.freeze(Object.fromEntries(Object.entries(QUOTE_ASSETS).map(([chain, assets]) => [
  chain,
  Object.freeze(Object.keys(assets).filter((a) => a !== NATIVE_TOKEN && assets[a] === `W${assets[NATIVE_TOKEN]}`)),
])));

/** true bila alamat adalah wrapped native chain tersebut (WETH di ethereum/base/arbitrum/optimism, WBNB, WPOL, WSOL). */
export function isWrappedNative(chain, address) {
  return (WRAPPED_NATIVE[chain] ?? []).includes(address);
}

/**
 * logIndex ≥ batas ini adalah indeks SINTETIS (bukan urutan log on-chain): adapter Etherscan-compatible memakai
 * 1e15–3e15 untuk baris tanpa logIndex, normalize.js memakai COLLISION_LOG_INDEX_BASE (5e15) untuk kunci yang
 * bertabrakan. Indeks sintetis tidak boleh dipakai untuk mengurutkan aktivitas dalam satu blok.
 */
export const SYNTHETIC_LOG_INDEX_MIN = 1e15;

/** Teks penafian standar (Bahasa Indonesia) yang wajib tampil bersama skor & sinyal. */
export const DISCLAIMERS = Object.freeze({
  insiderName: '“Insider” hanya nama fitur. Tidak ada kesimpulan bahwa pemilik wallet memiliki informasi orang dalam.',
  conviction: 'Skor keyakinan adalah ringkasan bukti yang dapat dijelaskan, BUKAN probabilitas profit.',
  spotVsFutures: 'Aktivitas spot on-chain ≠ posisi futures. Posisi pribadi trader di Binance tidak dapat diketahui dari wallet publik.',
  readOnly: 'Fitur baca saja: tidak pernah meminta seed phrase / private key dan tidak mengirim transaksi.',
  simulated: 'DATA SIMULASI — bukan data live. Hash transaksi & alamat fiktif.',
});
