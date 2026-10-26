// Skenario DATA SIMULASI untuk Insider / Smart Money Radar. Semua alamat & hash transaksi FIKTIF: dibangkitkan
// deterministik dari sha256 label (format valid, bukan alamat on-chain nyata) — kecuali alamat kontrak aset
// quote resmi (QUOTE_ASSETS) yang dibutuhkan klasifikasi swap. Semua baris `provider: 'fixture'`,
// `isSimulated: true`. Tidak ada keacakan non-deterministik: hasil hanya bergantung pada `now`.
//
// Pemodelan swap: dua transfer dalam tx yang sama (wallet → pool: aset quote; pool → wallet: token) dengan
// pool berlabel `dex_pool`. Jual = kebalikannya. Harga token mengikuti jalur harga deterministik `priceAt`,
// sehingga untung/rugi trade konsisten dengan riwayat harga (dipakai juga untuk evaluasi tanpa look-ahead).
//
// Peran wallet (lihat `expectations`): 6 trader berkualitas (Q1..Q6), wallet beruntung satu trade, wallet saldo
// besar dengan trading biasa-biasa, BOT, market maker, hot wallet CEX, airdrop farmer, dua wallet tertaut,
// penyedia likuiditas, wallet PnL tidak lengkap, dan dua wallet Solana.

import { createHash } from 'node:crypto';
import { NATIVE_TOKEN, ZERO_ADDRESS, tokenKey } from '../../../backend/smartmoney/contracts.js';

export const SCENARIO_PROVIDER = 'fixture';
export const SCENARIO_LABEL_SOURCE = 'fixture-label';
export const SCENARIO_PRICE_SOURCE = 'fixture-price';
export const SCENARIO_MAP_SOURCE = 'fixture-map';
export const DEFAULT_SCENARIO_NOW = Date.UTC(2026, 9, 1, 12, 0);

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const HISTORY_DAYS = 120;

// ---------------------------------------------------------------- identitas fiktif deterministik
const digest = (label, algo = 'sha256') => createHash(algo).update(`alphalens-fixture:${label}`).digest();
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
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
/** Alamat fiktif: EVM = 0x + 40 hex dari sha256(label); Solana = base58(sha256(label)). */
export function fakeAddress(chain, label) {
  return chain === 'solana' ? base58(digest(`addr:${label}`)) : `0x${digest(`addr:${label}`).toString('hex').slice(0, 40)}`;
}
/** Hash tx fiktif: EVM = 0x + 64 hex; Solana = base58(sha512(label)) (64..90 karakter). */
export function fakeTxHash(chain, label) {
  return chain === 'solana' ? base58(digest(`tx:${label}`, 'sha512')) : `0x${digest(`tx:${label}`).toString('hex')}`;
}

/** PRNG deterministik (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seedOf = (label) => digest(`seed:${label}`).readUInt32BE(0);
const round = (x, dp = 6) => Math.round(x * 10 ** dp) / 10 ** dp;
const usd = (x) => Math.round(x * 100) / 100;

// ---------------------------------------------------------------- token
const QUOTES = {
  ethereum: {
    ETH: { address: NATIVE_TOKEN, symbol: 'ETH', name: 'Ether', decimals: 18 },
    WETH: { address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 },
    USDC: { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
  },
  base: {
    ETH: { address: NATIVE_TOKEN, symbol: 'ETH', name: 'Ether', decimals: 18 },
    WETH: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 },
    USDC: { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
  },
  solana: {
    SOL: { address: NATIVE_TOKEN, symbol: 'SOL', name: 'Solana', decimals: 9 },
    USDC: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
  },
};

// [chain, kunci, simbol, nama, decimals, harga dasar USD]. Kunci ≠ simbol: PEPE_A & PEPE_B bersimbol sama "PEPE".
const TOKEN_DEFS = [
  ['ethereum', 'TKA', 'TKA', 'Token Alfa (simulasi)', 18, 0.42],
  ['ethereum', 'TKB', 'TKB', 'Token Bravo (simulasi)', 18, 1.8],
  ['ethereum', 'TKC', 'TKC', 'Token Charlie (simulasi)', 18, 0.075],
  ['ethereum', 'TKD', 'TKD', 'Token Delta (simulasi)', 18, 12.5],
  ['ethereum', 'TKE', 'TKE', 'Token Echo (simulasi)', 18, 0.9],
  ['ethereum', 'TKF', 'TKF', 'Token Foxtrot (simulasi)', 9, 3.3],
  ['ethereum', 'TKG', 'TKG', 'Token Golf (simulasi)', 18, 0.22],
  ['ethereum', 'PEPE_A', 'PEPE', 'Pepe (simulasi, kontrak A)', 18, 0.0000105],
  ['ethereum', 'PEPE_B', 'PEPE', null, 18, 0.0000021],
  ['ethereum', 'LUCK', 'LUCK', 'Lucky Moon (simulasi)', 18, 0.001],
  ['ethereum', 'AIR', 'AIR', 'Airdrop Satu (simulasi)', 18, 0.5],
  ['ethereum', 'AIR2', 'AIRX', 'Airdrop Dua (simulasi)', 18, 0.12],
  ['ethereum', 'DROP', 'DROP', 'Drop Token (simulasi)', null, 0.3],
  ['ethereum', 'LPT', 'FLP-TKB', 'Fixture LP TKB/USDC', 18, 60],
  ['base', 'BSA', 'BSA', 'Base Alfa (simulasi)', 18, 0.031],
  ['base', 'BSB', 'BSB', 'Base Bravo (simulasi)', 18, 2.4],
  ['base', 'BSC', 'BSC', 'Base Charlie (simulasi)', 18, 0.66],
  ['base', 'BSD', 'BSD', 'Base Delta (simulasi)', 18, 7.1],
  ['base', 'SYN', 'SYN', 'Synthetic Radar Token (simulasi)', 18, 0.85],
  ['solana', 'SLA', 'SLA', 'Sol Alfa (simulasi)', 6, 0.014],
  ['solana', 'SLB', 'SLB', 'Sol Bravo (simulasi)', 9, 1.25],
];

/**
 * Bangun skenario lengkap.
 * @param {{ now?: number }} [options]
 */
export function buildScenario({ now = DEFAULT_SCENARIO_NOW } = {}) {
  const start = now - HISTORY_DAYS * DAY;
  const daysAgo = (d) => Math.round(now - d * DAY);

  // ---- token & jalur harga
  const tokens = {};
  const priceModels = new Map();
  for (const [chain, key, symbol, name, decimals, base] of TOKEN_DEFS) {
    const address = fakeAddress(chain, `token:${chain}:${key}`);
    tokens[key] = { chain, address, symbol, name, decimals };
    const r = rng(seedOf(`price:${key}`));
    priceModels.set(tokenKey(chain, address), {
      base, drift: (r() - 0.45) * 0.004, a1: 0.12 + r() * 0.08, p1: 4 + r() * 5, f1: r() * 6.28, a2: 0.05 + r() * 0.05, p2: 13 + r() * 9, f2: r() * 6.28,
    });
  }
  // LUCK: pompa ~11x dalam 30 hari (satu trade beruntung).
  const luckKey = tokenKey('ethereum', tokens.LUCK.address);
  const ethPrice = (t) => 3000 * (1 + 0.05 * Math.sin((t - start) / DAY / 9));
  const solPrice = (t) => 150 * (1 + 0.06 * Math.sin((t - start) / DAY / 7));

  /** Harga USD deterministik token pada waktu t (null bila tidak dikenal). Tanpa look-ahead: hanya fungsi t. */
  function priceAt(chain, address, t) {
    const q = Object.values(QUOTES[chain] ?? {}).find((x) => x.address === address);
    if (q) return q.symbol === 'USDC' ? 1 : q.symbol === 'SOL' ? solPrice(t) : ethPrice(t);
    const key = tokenKey(chain, address);
    if (key === luckKey) {
      const a = now - 35 * DAY;
      const b = now - 5 * DAY;
      return 0.001 * (t <= a ? 1 : t >= b ? 11 : 1 + (10 * (t - a)) / (b - a));
    }
    const m = priceModels.get(key);
    if (!m) return null;
    const d = (t - start) / DAY;
    return m.base * Math.exp(m.drift * d + m.a1 * Math.sin((2 * Math.PI * d) / m.p1 + m.f1) + m.a2 * Math.sin((2 * Math.PI * d) / m.p2 + m.f2));
  }
  const priceOf = (token, t) => priceAt(token.chain, token.address, t);

  // ---- alamat infrastruktur & label
  const labels = [];
  const addLabel = (chain, address, label, category, confidence = 0.95) => {
    labels.push({ chain, address, label, category, source: SCENARIO_LABEL_SOURCE, confidence, fetchedAt: now - DAY });
    return address;
  };
  const infra = {
    ethereum: {
      cexHot: addLabel('ethereum', fakeAddress('ethereum', 'cex-hot-1'), 'Fixture Exchange Hot Wallet 1', 'cex', 1),
      cexDeposit: addLabel('ethereum', fakeAddress('ethereum', 'cex-deposit-q4'), 'Fixture Exchange Deposit', 'cex_deposit', 0.85),
      bridge: addLabel('ethereum', fakeAddress('ethereum', 'bridge-1'), 'Fixture Bridge', 'bridge', 0.95),
      router: addLabel('ethereum', fakeAddress('ethereum', 'router-1'), 'Fixture DEX Router', 'dex_router', 0.99),
      airdropAir: addLabel('ethereum', fakeAddress('ethereum', 'airdrop-air'), 'Fixture AIR Distributor', 'airdrop_distributor', 0.9),
      airdropDrop: fakeAddress('ethereum', 'airdrop-drop'), // sengaja TANPA label: dideteksi dari metode claim*
    },
    base: {
      cexHot: addLabel('base', fakeAddress('base', 'cex-hot-base'), 'Fixture Exchange Hot Wallet Base', 'cex', 1),
      router: addLabel('base', fakeAddress('base', 'router-base'), 'Fixture DEX Router Base', 'dex_router', 0.99),
    },
    solana: {
      cexHot: addLabel('solana', fakeAddress('solana', 'cex-hot-sol'), 'Fixture Exchange Hot Wallet Solana', 'cex', 1),
      router: addLabel('solana', fakeAddress('solana', 'router-sol'), 'Fixture DEX Aggregator Solana', 'dex_router', 0.99),
    },
  };
  addLabel('ethereum', tokens.LPT.address, 'Fixture LP TKB/USDC', 'lp_token', 0.95);
  const pools = new Map();
  const poolOf = (token) => {
    const key = tokenKey(token.chain, token.address);
    if (!pools.has(key)) {
      pools.set(key, addLabel(token.chain, fakeAddress(token.chain, `pool:${key}`), `Fixture Pool ${token.symbol}`, 'dex_pool', 0.98));
    }
    return pools.get(key);
  };

  // ---- pembangun transfer
  const rawTransfers = [];
  let txCounter = 0;
  const blockNumber = (chain, t) => (chain === 'ethereum' ? 20_000_000 + Math.floor((t - start) / 12_000)
    : chain === 'base' ? 15_000_000 + Math.floor((t - start) / 2_000) : null);
  function addTx(chain, label, t, legs, meta = {}) {
    txCounter += 1;
    const txHash = fakeTxHash(chain, `${label}#${txCounter}`);
    const out = legs.map((leg, logIndex) => ({
      chain, txHash, logIndex, blockNumber: blockNumber(chain, t), blockTime: t,
      from: leg.from, to: leg.to,
      token: { address: leg.token.address, symbol: leg.token.symbol, name: leg.token.name, decimals: leg.token.decimals },
      amount: round(leg.amount), usdValue: leg.usdValue === null ? null : usd(leg.usdValue),
      priceSource: leg.usdValue === null ? null : SCENARIO_PRICE_SOURCE,
      provider: SCENARIO_PROVIDER, isSimulated: true,
      txMeta: {
        initiator: meta.initiator ?? leg.from, toContract: meta.toContract ?? null, method: meta.method ?? null,
        providerCategory: meta.category ?? null, dex: meta.dex ?? null,
      },
    }));
    rawTransfers.push(...out);
    return { txHash, transfers: out };
  }
  const quoteOf = (chain, name) => QUOTES[chain][name];

  /**
   * Swap wallet ↔ pool. side BUY: wallet kirim quote, terima token; SELL: kebalikannya.
   * `usdAmount` atau `qty` (jumlah token). `category: null` = tanpa kategori provider (heuristik struktur tx).
   */
  function swap({ wallet, token, side, t, usdAmount, qty, quote = 'USDC', category = 'swap', knownUsd = true, label = 'swap' }) {
    const chain = token.chain;
    const q = quoteOf(chain, quote);
    const p = priceOf(token, t);
    const amount = qty ?? usdAmount / p;
    const value = amount * p;
    const quoteAmount = value / priceAt(chain, q.address, t);
    const pool = poolOf(token);
    const v = knownUsd ? value : null;
    const legs = side === 'BUY'
      ? [{ from: wallet, to: pool, token: q, amount: quoteAmount, usdValue: v }, { from: pool, to: wallet, token, amount, usdValue: v }]
      : [{ from: wallet, to: pool, token, amount, usdValue: v }, { from: pool, to: wallet, token: q, amount: quoteAmount, usdValue: v }];
    const meta = { initiator: wallet, toContract: infra[chain].router, method: 'swapExactTokensForTokens', category, dex: 'fixture-dex' };
    return { ...addTx(chain, `${label}:${wallet}:${token.symbol}:${side}`, t, legs, meta), qty: round(amount), usd: usd(value) };
  }
  function transfer({ chain, from, to, token, amount, t, category = null, method = null, label = 'transfer', initiator }) {
    const p = priceAt(chain, token.address, t);
    return addTx(chain, `${label}:${from}:${to}`, t, [{ from, to, token, amount, usdValue: p === null ? null : amount * p }],
      { category, method, initiator: initiator ?? from });
  }
  const fund = (chain, from, to, t, amount = 2) => transfer({ chain, from, to, token: chain === 'solana' ? QUOTES.solana.SOL : QUOTES[chain].ETH, amount, t, label: 'fund' });

  /**
   * Round trip terkendali jalur harga: setiap trade memilih lama pegang dari kandidat; trade "menang" mengambil
   * return terbaik, "kalah" yang terburuk — hasilnya untung/rugi realistis (tidak semua menang).
   */
  function roundTrips({ wallet, chainTokens, count, fromDay, toDay, wins, size, quote = 'USDC', category = 'swap', seed, holds = [0.5, 1, 2, 3, 5, 8] }) {
    const r = rng(seedOf(seed));
    const trades = [];
    for (let i = 0; i < count; i += 1) {
      const token = chainTokens[i % chainTokens.length];
      const tBuy = Math.round(daysAgo(fromDay - (i * (fromDay - toDay)) / count) + r() * 6 * HOUR);
      const fit = holds.map((h) => tBuy + Math.round(h * DAY)).filter((t) => t < now - 1.5 * DAY);
      const options = fit.length > 0 ? fit : [tBuy + Math.round(holds[0] * DAY)];
      const ret = (t) => priceOf(token, t) / priceOf(token, tBuy) - 1;
      const sorted = [...options].sort((a, b) => ret(a) - ret(b));
      const tSell = wins[i % wins.length] ? sorted[sorted.length - 1] : sorted[0];
      const buy = swap({ wallet, token, side: 'BUY', t: tBuy, usdAmount: size[0] + r() * (size[1] - size[0]), quote, category, label: `rt${i}` });
      const sell = swap({ wallet, token, side: 'SELL', t: tSell, qty: buy.qty, quote, category, label: `rt${i}` });
      trades.push({ token: token.symbol, buyTx: buy.txHash, sellTx: sell.txHash, costUsd: buy.usd, proceedsUsd: sell.usd });
    }
    return trades;
  }

  // ---- wallet peran
  const W = {};
  const wallet = (chain, role) => { W[role] = fakeAddress(chain, `wallet:${role}`); return W[role]; };
  const E = infra.ethereum;
  const T = tokens;

  // 6 trader berkualitas: ≥ 12 round trip, ≥ 60 hari, ≥ 4 token, sebagian kalah.
  const qualitySpecs = [
    { role: 'Q1', chain: 'ethereum', toks: [T.TKB, T.TKC, T.PEPE_A, T.TKD, T.TKE], count: 14, fromDay: 98, wins: [1, 1, 0, 1, 1, 0, 1], size: [3000, 9000], quote: 'USDC' },
    { role: 'Q2', chain: 'ethereum', toks: [T.TKB, T.TKD, T.TKF, T.PEPE_A], count: 13, fromDay: 92, wins: [1, 1, 0, 1, 1, 1, 0, 1], size: [4000, 12000], quote: 'WETH' },
    { role: 'Q3', chain: 'ethereum', toks: [T.TKC, T.TKE, T.TKF, T.TKD], count: 13, fromDay: 88, wins: [1, 1, 0, 1, 0, 1, 1, 1], size: [2000, 6000], quote: 'USDC', category: null },
    { role: 'Q4', chain: 'ethereum', toks: [T.TKB, T.TKD, T.TKE, T.TKF], count: 12, fromDay: 85, wins: [1, 0, 1, 1, 1, 0], size: [5000, 15000], quote: 'USDC' },
    { role: 'Q5', chain: 'base', toks: [T.BSA, T.BSB, T.BSC, T.SYN], count: 14, fromDay: 95, wins: [1, 1, 0, 1, 0, 1, 1], size: [1500, 5000], quote: 'USDC' },
    { role: 'Q6', chain: 'base', toks: [T.BSB, T.BSC, T.BSD, T.SYN], count: 13, fromDay: 90, wins: [1, 0, 1, 1, 0, 1], size: [2500, 8000], quote: 'WETH' },
  ];
  const roundTripLog = {};
  for (const s of qualitySpecs) {
    const a = wallet(s.chain, s.role);
    fund(s.chain, infra[s.chain].cexHot, a, daysAgo(s.fromDay + 3), 3); // pendana pertama = CEX → BUKAN tautan
    roundTripLog[s.role] = roundTrips({
      wallet: a, chainTokens: s.toks, count: s.count, fromDay: s.fromDay, toDay: 3, wins: s.wins, size: s.size,
      quote: s.quote, category: s.category === undefined ? 'swap' : s.category, seed: `rt:${s.role}`,
    });
  }

  // Dua wallet tertaut: pendana pertama non-CEX yang sama + transfer langsung L1 → L2.
  const funder = fakeAddress('ethereum', 'wallet:FUNDER');
  wallet('ethereum', 'L1');
  wallet('ethereum', 'L2');
  const fundL1 = fund('ethereum', funder, W.L1, daysAgo(80), 5);
  const fundL2 = fund('ethereum', funder, W.L2, daysAgo(79.9), 5);
  const directLink = transfer({ chain: 'ethereum', from: W.L1, to: W.L2, token: QUOTES.ethereum.USDC, amount: 5000, t: daysAgo(60), label: 'link' });
  for (const role of ['L1', 'L2']) {
    roundTrips({ wallet: W[role], chainTokens: [T.TKB, T.TKC, T.TKD, T.TKE], count: 12, fromDay: 75, toDay: 4, wins: [1, 1, 0, 1, 0], size: [1500, 4000], seed: `rt:${role}` });
  }

  // Wallet beruntung: satu trade ~11x.
  wallet('ethereum', 'LUCKY');
  fund('ethereum', E.cexHot, W.LUCKY, daysAgo(40), 1);
  const luckyBuy = swap({ wallet: W.LUCKY, token: T.LUCK, side: 'BUY', t: daysAgo(35), usdAmount: 2000, label: 'lucky' });
  const luckySell = swap({ wallet: W.LUCKY, token: T.LUCK, side: 'SELL', t: daysAgo(6), qty: luckyBuy.qty, label: 'lucky' });

  // Wallet saldo besar, trading biasa-biasa (sebagian besar kalah); dua trade tanpa nilai USD dari provider.
  wallet('ethereum', 'WHALE');
  fund('ethereum', E.cexHot, W.WHALE, daysAgo(105), 10);
  transfer({ chain: 'ethereum', from: E.cexHot, to: W.WHALE, token: QUOTES.ethereum.USDC, amount: 2_500_000, t: daysAgo(104), label: 'whale-cex' });
  transfer({ chain: 'ethereum', from: fakeAddress('ethereum', 'whale-source'), to: W.WHALE, token: QUOTES.ethereum.WETH, amount: 800, t: daysAgo(103), label: 'whale-in' });
  roundTrips({ wallet: W.WHALE, chainTokens: [T.TKB, T.TKD, T.PEPE_B, T.TKE], count: 12, fromDay: 100, toDay: 5, wins: [1, 0, 0, 1, 0, 0], size: [50_000, 200_000], seed: 'rt:WHALE' });
  const whaleUnknown = swap({ wallet: W.WHALE, token: T.TKG, side: 'BUY', t: daysAgo(20), usdAmount: 80_000, quote: 'WETH', knownUsd: false, label: 'whale-unknown' });
  swap({ wallet: W.WHALE, token: T.TKG, side: 'SELL', t: daysAgo(12), qty: whaleUnknown.qty, quote: 'WETH', knownUsd: false, label: 'whale-unknown' });

  // BOT (base): 320 swap BSA dengan jeda 15–45 detik.
  wallet('base', 'BOT');
  fund('base', infra.base.cexHot, W.BOT, daysAgo(4), 1);
  const botR = rng(seedOf('bot'));
  let tBot = daysAgo(3);
  const botTxs = [];
  for (let i = 0; i < 320; i += 1) {
    tBot += Math.round((15 + botR() * 30) * 1000);
    botTxs.push(swap({ wallet: W.BOT, token: T.BSA, side: i % 2 === 0 ? 'BUY' : 'SELL', t: tBot, usdAmount: 50 + botR() * 250, label: `bot${i}` }).txHash);
  }

  // Market maker: dua arah pada 6 token, jumlah beli = jual (net ≈ 0), frekuensi tinggi 30 hari.
  wallet('ethereum', 'MM');
  fund('ethereum', E.cexHot, W.MM, daysAgo(33), 20);
  const mmTokens = [T.TKB, T.TKC, T.TKD, T.TKE, T.TKF, T.TKG];
  const mmR = rng(seedOf('mm'));
  for (const [k, token] of mmTokens.entries()) {
    for (let i = 0; i < 11; i += 1) {
      const t = daysAgo(30 - i * 2.6 - k * 0.1) + Math.round(mmR() * HOUR);
      const b = swap({ wallet: W.MM, token, side: 'BUY', t, usdAmount: 20_000 + mmR() * 5000, label: `mm${k}:${i}` });
      swap({ wallet: W.MM, token, side: 'SELL', t: t + Math.round((20 + mmR() * 60) * MIN), qty: b.qty, label: `mm${k}:${i}` });
    }
  }

  // Hot wallet CEX: penarikan ke pengguna (termasuk TKA ke Q4 — BUKAN pembelian).
  const cexWithdrawalTka = transfer({ chain: 'ethereum', from: E.cexHot, to: W.Q4, token: T.TKA, amount: 50_000, t: now - 8 * HOUR, label: 'cex-withdraw-tka' });
  const bridgeInTka = transfer({ chain: 'ethereum', from: E.bridge, to: W.Q4, token: T.TKA, amount: 30_000, t: now - 5 * HOUR, category: 'bridge', method: 'finalizeBridge', initiator: E.bridge, label: 'bridge-in-tka' });

  // Airdrop farmer: klaim lalu jual.
  wallet('ethereum', 'FARMER');
  fund('ethereum', E.cexHot, W.FARMER, daysAgo(70), 0.5);
  const claimAir = transfer({ chain: 'ethereum', from: E.airdropAir, to: W.FARMER, token: T.AIR, amount: 10_000, t: daysAgo(50), category: 'airdrop', method: 'claim', initiator: W.FARMER, label: 'claim-air' });
  const claimDrop = transfer({ chain: 'ethereum', from: E.airdropDrop, to: W.FARMER, token: T.DROP, amount: 5000, t: daysAgo(40), method: 'claimAirdrop', initiator: W.FARMER, label: 'claim-drop' });
  const mintAir2 = transfer({ chain: 'ethereum', from: ZERO_ADDRESS, to: W.FARMER, token: T.AIR2, amount: 40_000, t: daysAgo(45), category: 'mint', method: 'mint', initiator: W.FARMER, label: 'mint-air2' });
  swap({ wallet: W.FARMER, token: T.AIR, side: 'SELL', t: daysAgo(48), qty: 6000, label: 'farm-sell' });
  swap({ wallet: W.FARMER, token: T.AIR, side: 'SELL', t: daysAgo(30), qty: 4000, label: 'farm-sell' });
  swap({ wallet: W.FARMER, token: T.DROP, side: 'SELL', t: daysAgo(38), qty: 5000, label: 'farm-sell' });
  swap({ wallet: W.FARMER, token: T.AIR2, side: 'SELL', t: daysAgo(20), qty: 40_000, label: 'farm-sell' });
  roundTrips({ wallet: W.FARMER, chainTokens: [T.TKB], count: 1, fromDay: 25, toDay: 10, wins: [1], size: [200, 300], seed: 'rt:FARMER' });

  // Penyedia likuiditas: beli TKB, LP add (terima LP token hasil mint), LP remove (burn LP, terima token).
  wallet('ethereum', 'LPW');
  fund('ethereum', E.cexHot, W.LPW, daysAgo(40), 1);
  const lpBuy = swap({ wallet: W.LPW, token: T.TKB, side: 'BUY', t: daysAgo(35), usdAmount: 30_000, label: 'lp-buy' });
  const tbPool = poolOf(T.TKB);
  const tAdd = daysAgo(30);
  const lpAddUsd = lpBuy.qty * priceOf(T.TKB, tAdd);
  const lpAdd = addTx('ethereum', 'lp-add', tAdd, [
    { from: W.LPW, to: tbPool, token: T.TKB, amount: lpBuy.qty, usdValue: lpAddUsd },
    { from: W.LPW, to: tbPool, token: QUOTES.ethereum.USDC, amount: lpAddUsd, usdValue: lpAddUsd },
    { from: ZERO_ADDRESS, to: W.LPW, token: T.LPT, amount: 500, usdValue: null },
  ], { initiator: W.LPW, toContract: E.router, method: 'addLiquidity', category: 'lp', dex: 'fixture-dex' });
  const tRemove = daysAgo(10);
  const lpRemove = addTx('ethereum', 'lp-remove', tRemove, [
    { from: W.LPW, to: ZERO_ADDRESS, token: T.LPT, amount: 500, usdValue: null },
    { from: tbPool, to: W.LPW, token: T.TKB, amount: lpBuy.qty * 0.97, usdValue: lpBuy.qty * 0.97 * priceOf(T.TKB, tRemove) },
    { from: tbPool, to: W.LPW, token: QUOTES.ethereum.USDC, amount: lpAddUsd * 1.03, usdValue: lpAddUsd * 1.03 },
  ], { initiator: W.LPW, toContract: E.router, method: 'removeLiquidity', category: 'lp', dex: 'fixture-dex' });

  // PnL tidak lengkap: TKE masuk lewat transfer biasa (biaya tidak diketahui) lalu dijual.
  wallet('ethereum', 'INC');
  fund('ethereum', E.cexHot, W.INC, daysAgo(45), 0.5);
  const incSource = fakeAddress('ethereum', 'inc-source');
  transfer({ chain: 'ethereum', from: incSource, to: W.INC, token: T.TKE, amount: 30_000, t: daysAgo(40), label: 'inc-in' });
  transfer({ chain: 'ethereum', from: incSource, to: W.INC, token: T.TKE, amount: 20_000, t: daysAgo(25), label: 'inc-in' });
  swap({ wallet: W.INC, token: T.TKE, side: 'SELL', t: daysAgo(35), qty: 25_000, label: 'inc-sell' });
  swap({ wallet: W.INC, token: T.TKE, side: 'SELL', t: daysAgo(15), qty: 25_000, label: 'inc-sell' });

  // Solana: S1 trader kecil (riwayat pendek), S2 membeli SLA di 24 jam terakhir + menerima SLB lewat transfer.
  wallet('solana', 'S1');
  wallet('solana', 'S2');
  fund('solana', infra.solana.cexHot, W.S1, daysAgo(45), 5);
  fund('solana', fakeAddress('solana', 'funder-s2'), W.S2, daysAgo(20), 3);
  roundTrips({ wallet: W.S1, chainTokens: [T.SLA, T.SLB], count: 6, fromDay: 40, toDay: 5, wins: [1, 0, 1], size: [500, 2000], seed: 'rt:S1' });
  const s2Buy = swap({ wallet: W.S2, token: T.SLA, side: 'BUY', t: now - 9 * HOUR, usdAmount: 3000, label: 's2-buy' });
  transfer({ chain: 'solana', from: fakeAddress('solana', 'friend-s2'), to: W.S2, token: T.SLB, amount: 800, t: now - 30 * HOUR, label: 's2-in' });

  // ---- 24 jam terakhir: akumulasi TKA (ethereum) oleh 3 wallet berkualitas independen + 2 wallet tertaut.
  const tkaBuys = [
    swap({ wallet: W.Q1, token: T.TKA, side: 'BUY', t: now - 20 * HOUR, usdAmount: 12_000, label: 'tka' }),
    swap({ wallet: W.Q1, token: T.TKA, side: 'BUY', t: now - 9 * HOUR, usdAmount: 8000, label: 'tka' }),
    swap({ wallet: W.Q1, token: T.TKA, side: 'BUY', t: now - 2 * HOUR, usdAmount: 6000, label: 'tka' }),
    swap({ wallet: W.Q2, token: T.TKA, side: 'BUY', t: now - 14 * HOUR, usdAmount: 9000, quote: 'WETH', label: 'tka' }),
    swap({ wallet: W.Q3, token: T.TKA, side: 'BUY', t: now - 4 * HOUR, usdAmount: 15_000, category: null, label: 'tka' }),
    swap({ wallet: W.L1, token: T.TKA, side: 'BUY', t: now - 11 * HOUR, usdAmount: 6000, label: 'tka' }),
    swap({ wallet: W.L2, token: T.TKA, side: 'BUY', t: now - 10 * HOUR, usdAmount: 5500, label: 'tka' }),
  ];
  // PEPE kontrak A (terpetakan ke 1000PEPEUSDT) dibeli Q2; PEPE kontrak B (tidak terpetakan) dibeli Q3.
  const pepeABuy = swap({ wallet: W.Q2, token: T.PEPE_A, side: 'BUY', t: now - 12 * HOUR, usdAmount: 7000, quote: 'WETH', label: 'pepe-a' });
  const pepeBBuy = swap({ wallet: W.Q3, token: T.PEPE_B, side: 'BUY', t: now - 16 * HOUR, usdAmount: 5000, category: null, label: 'pepe-b' });
  // SYN (base) — terpetakan ke futures SYNUSDT (simbol sinyal LONG yang di-seed tests/helpers/signalSeed.js).
  const synBuys = [
    swap({ wallet: W.Q5, token: T.SYN, side: 'BUY', t: now - 18 * HOUR, usdAmount: 4000, label: 'syn' }),
    swap({ wallet: W.Q5, token: T.SYN, side: 'BUY', t: now - 3 * HOUR, usdAmount: 3000, label: 'syn' }),
    swap({ wallet: W.Q6, token: T.SYN, side: 'BUY', t: now - 7 * HOUR, usdAmount: 6000, quote: 'WETH', label: 'syn' }),
  ];
  // Indikasi keluar: Q4 mengakumulasi TKC lalu memindahkan SELURUHNYA ke alamat deposit exchange (belum tentu dijual).
  const tkcBuys = [6, 4, 2].map((d) => swap({ wallet: W.Q4, token: T.TKC, side: 'BUY', t: daysAgo(d), usdAmount: 7000, label: 'tkc-acc' }));
  const tkcQty = round(tkcBuys.reduce((s, b) => s + b.qty, 0));
  const cexExit = transfer({ chain: 'ethereum', from: W.Q4, to: E.cexDeposit, token: T.TKC, amount: tkcQty, t: now - 3 * HOUR, label: 'cex-exit' });
  // Penjualan besar: Q3 mengakumulasi TKG lalu menjual seluruhnya lewat swap di 24 jam terakhir.
  const tkgBuy = swap({ wallet: W.Q3, token: T.TKG, side: 'BUY', t: daysAgo(5), usdAmount: 24_000, label: 'tkg' });
  const tkgSell = swap({ wallet: W.Q3, token: T.TKG, side: 'SELL', t: now - 7 * HOUR, qty: tkgBuy.qty, label: 'tkg' });

  // Data terlambat: Q5 membeli BSB 12 hari lalu (tx ini baru muncul di batch berikutnya) dan menjual 9 hari lalu.
  const lateBuy = swap({ wallet: W.Q5, token: T.BSB, side: 'BUY', t: daysAgo(12), usdAmount: 3500, label: 'late' });
  const lateSell = swap({ wallet: W.Q5, token: T.BSB, side: 'SELL', t: daysAgo(9), qty: lateBuy.qty, label: 'late' });

  // Duplikat: transfer yang sama (chain, txHash, logIndex) terkirim ulang.
  const duplicateSources = [...tkaBuys[0].transfers, ...rawTransfers.filter((t) => t.txHash === botTxs[10]).slice(0, 1)];
  const duplicates = duplicateSources.map((t) => structuredClone(t));
  rawTransfers.push(...duplicates);

  // ---- harga saat ini (TKE sengaja basi > 24 jam)
  const prices = [];
  for (const token of Object.values(tokens)) {
    const at = token === T.TKE ? now - 2 * DAY : now - 5 * MIN;
    prices.push({ chain: token.chain, address: token.address, priceUsd: priceOf(token, at), at, source: SCENARIO_PRICE_SOURCE });
  }
  for (const [chain, qs] of Object.entries(QUOTES)) {
    for (const q of Object.values(qs)) prices.push({ chain, address: q.address, priceUsd: priceAt(chain, q.address, now - 5 * MIN), at: now - 5 * MIN, source: SCENARIO_PRICE_SOURCE });
  }

  // ---- mapping Binance: identitas = chain + kontrak. PEPE_B bersimbol sama TIDAK dipetakan.
  const binanceMap = [
    { chain: 'ethereum', contractAddress: T.PEPE_A.address, binanceAsset: 'PEPE', spotSymbol: 'PEPEUSDT', futuresSymbol: '1000PEPEUSDT', multiplier: 1000, source: SCENARIO_MAP_SOURCE, verifiedAt: now - 7 * DAY },
    { chain: 'base', contractAddress: T.SYN.address, binanceAsset: 'SYN', spotSymbol: null, futuresSymbol: 'SYNUSDT', multiplier: 1, source: SCENARIO_MAP_SOURCE, verifiedAt: now - 7 * DAY },
    { chain: 'ethereum', contractAddress: T.TKA.address, binanceAsset: 'TKA', spotSymbol: null, futuresSymbol: 'TKAUSDT', multiplier: 1, source: SCENARIO_MAP_SOURCE, verifiedAt: now - 7 * DAY },
  ];

  // ---- kandidat penemuan wallet (termasuk yang harus dibuang discovery: CEX, pool, duplikat)
  const candidate = (chain, address, reason, source = SCENARIO_PROVIDER) => ({ chain, address, source, reason });
  const candidates = [
    ...['Q1', 'Q2', 'Q3', 'Q4', 'L1', 'L2', 'LUCKY', 'WHALE', 'MM', 'FARMER', 'LPW', 'INC'].map((r) => candidate('ethereum', W[r], `Trader aktif token ethereum (simulasi, peran ${r})`)),
    ...['Q5', 'Q6', 'BOT'].map((r) => candidate('base', W[r], `Trader aktif token base (simulasi, peran ${r})`)),
    ...['S1', 'S2'].map((r) => candidate('solana', W[r], `Trader aktif token solana (simulasi, peran ${r})`)),
    candidate('ethereum', W.Q1, 'Pemegang teratas TKB (simulasi)', 'fixture-topholders'),
    candidate('ethereum', E.cexHot, 'Alamat volume tinggi (simulasi) — hot wallet exchange'),
    candidate('ethereum', poolOf(T.TKA), 'Alamat volume tinggi (simulasi) — pool DEX'),
  ];

  const keyOfTransfer = (t) => `${t.chain}:${t.txHash}:${t.logIndex}`;
  const expectations = {
    now,
    historyDays: HISTORY_DAYS,
    duplicateCount: duplicates.length,
    duplicateKeys: duplicates.map(keyOfTransfer),
    lateTransferKeys: [...lateBuy.transfers].map(keyOfTransfer),
    late: { chain: 'base', wallet: W.Q5, token: T.BSB.address, buyTx: lateBuy.txHash, sellTx: lateSell.txHash },
    qualityWallets: qualitySpecs.map((s) => ({ chain: s.chain, address: W[s.role], role: s.role, tokens: s.toks.length, trades: roundTripLog[s.role] })),
    tka: {
      chain: 'ethereum', address: T.TKA.address, windowMs: DAY,
      qualityBuyers: [W.Q1, W.Q2, W.Q3], linkedBuyers: [W.L1, W.L2], expectedIndependentClusters: 4,
      repeatBuyer: W.Q1, buyTxs: tkaBuys.map((b) => b.txHash),
      nonBuyInflows: [
        { wallet: W.Q4, type: 'CEX_WITHDRAWAL', txHash: cexWithdrawalTka.txHash },
        { wallet: W.Q4, type: 'BRIDGE_IN', txHash: bridgeInTka.txHash },
      ],
    },
    linked: { chain: 'ethereum', a: W.L1, b: W.L2, funder, fundTxs: [fundL1.txHash, fundL2.txHash], directTransferTx: directLink.txHash },
    pepe: {
      chain: 'ethereum', symbol: 'PEPE', mapped: T.PEPE_A.address, unmapped: T.PEPE_B.address, futuresSymbol: '1000PEPEUSDT',
      multiplier: 1000, mappedBuyTx: pepeABuy.txHash, unmappedBuyTx: pepeBBuy.txHash,
    },
    screenerLink: { chain: 'base', address: T.SYN.address, futuresSymbol: 'SYNUSDT', buyers: [W.Q5, W.Q6], buyTxs: synBuys.map((b) => b.txHash) },
    cexExit: { chain: 'ethereum', wallet: W.Q4, token: T.TKC.address, depositAddress: E.cexDeposit, txHash: cexExit.txHash, qty: tkcQty },
    largeSell: { chain: 'ethereum', wallet: W.Q3, token: T.TKG.address, txHash: tkgSell.txHash, usd: tkgSell.usd },
    lp: { chain: 'ethereum', wallet: W.LPW, lpToken: T.LPT.address, addTx: lpAdd.txHash, removeTx: lpRemove.txHash },
    incompletePnl: { chain: 'ethereum', wallet: W.INC, token: T.TKE.address },
    bot: { chain: 'base', wallet: W.BOT, swaps: botTxs.length },
    marketMaker: { chain: 'ethereum', wallet: W.MM, tokens: mmTokens.map((t) => t.address) },
    lucky: { chain: 'ethereum', wallet: W.LUCKY, buyTx: luckyBuy.txHash, sellTx: luckySell.txHash, returnPct: (luckySell.usd / luckyBuy.usd - 1) * 100 },
    whale: { chain: 'ethereum', wallet: W.WHALE, unknownUsdBuyTx: whaleUnknown.txHash },
    farmer: { chain: 'ethereum', wallet: W.FARMER, claimTxs: [claimAir.txHash, claimDrop.txHash], mintTx: mintAir2.txHash },
    cexHotWallet: { chain: 'ethereum', address: E.cexHot },
    solana: { buyer: W.S2, token: T.SLA.address, buyTx: s2Buy.txHash, trader: W.S1 },
    stalePrice: { chain: 'ethereum', address: T.TKE.address },
    excludedCandidates: [E.cexHot, poolOf(T.TKA)],
    duplicateCandidate: W.Q1,
    unsourcedLabel: { chain: 'ethereum', address: fakeAddress('ethereum', 'unsourced'), label: 'Tanpa sumber', category: 'fund', source: '', confidence: 0.5, fetchedAt: now },
  };

  return {
    now, rawTransfers, labels, prices, binanceMap, candidates, expectations,
    wallets: { ...W, FUNDER: funder }, tokens, infra,
    priceAt,
  };
}
