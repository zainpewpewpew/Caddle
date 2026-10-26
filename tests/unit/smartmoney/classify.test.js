import { describe, expect, it } from 'vitest';
import { BUY_TYPES, SELL_TYPES, ZERO_ADDRESS } from '../../../backend/smartmoney/contracts.js';
import { classifyTransaction, classifyWalletTransfers, isStablecoin } from '../../../backend/smartmoney/classify.js';
import { normalizeTransfers } from '../../../backend/smartmoney/normalize.js';

const addr = (c) => `0x${c.repeat(40)}`;
const txh = (c) => `0x${c.repeat(64)}`;
const W = addr('1');
const POOL = addr('2');
const ROUTER = addr('3');
const PEPE = addr('4');
const FAKE_PEPE = addr('5');
const FOO = addr('6');
const CEX = addr('7');
const BRIDGE = addr('8');
const DIST = addr('9');
const LPT = addr('a');
const SPAMMER = addr('b');
const FRIEND = addr('c');
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const TOK = {
  [PEPE]: { symbol: 'PEPE', decimals: 18 }, [FAKE_PEPE]: { symbol: 'PEPE', decimals: 18 }, [FOO]: { symbol: 'FOO', decimals: 9 },
  [WETH]: { symbol: 'WETH', decimals: 18 }, [USDC]: { symbol: 'USDC', decimals: 6 }, [LPT]: { symbol: 'UNI-V2', decimals: 18 },
};

const T0 = 1_767_225_600_000;
let logSeq = 0;
/** Transfer kanonik (lewat normalizeTransfers agar bentuknya sama persis dengan keluaran normalisasi). */
function tr({ tx = txh('d'), from, to, token, amount, usd = null, meta = {}, chain = 'ethereum', time = T0, decimals, symbol, provider = 'prov-a', sim = false, logIndex }) {
  const info = TOK[token] ?? { symbol: symbol ?? 'TKN', decimals: 18 };
  const raw = {
    chain, txHash: tx, logIndex: logIndex ?? logSeq++, blockNumber: 1, blockTime: time, from, to,
    token: { address: token, symbol: symbol ?? info.symbol, name: null, decimals: decimals === undefined ? info.decimals : decimals },
    amount, usdValue: usd, priceSource: usd === null ? null : provider, provider, isSimulated: sim,
    txMeta: { initiator: W, toContract: ROUTER, method: null, providerCategory: null, dex: null, ...meta },
  };
  const { transfers, rejected } = normalizeTransfers([raw]);
  if (rejected.length) throw new Error(rejected[0].reason);
  return transfers[0];
}

function label(address, category, source = 'etherscan-nametag', name = category) {
  return [`ethereum:${address}`, { chain: 'ethereum', address, label: name, category, source, confidence: 0.9, fetchedAt: 0 }];
}
const LABELS = new Map([
  label(CEX, 'cex', 'etherscan-nametag', 'Binance 14'),
  label(BRIDGE, 'bridge', 'etherscan-nametag', 'Arbitrum Bridge'),
  label(DIST, 'airdrop_distributor', 'etherscan-nametag', 'Merkle Distributor'),
  label(LPT, 'lp_token', 'etherscan-nametag', 'Uniswap V2: PEPE-WETH'),
]);

const isBuyOrSell = (a) => BUY_TYPES.includes(a.type) || SELL_TYPES.includes(a.type);

describe('classify — swap', () => {
  it('UNIT-SM-CLS-001 swap beli normal WETH → PEPE: SWAP_BUY, usdValue dari sisi quote, tanpa baris WETH', () => {
    const acts = classifyTransaction([
      tr({ from: W, to: POOL, token: WETH, amount: 0.5, usd: 1500 }),
      tr({ from: POOL, to: W, token: PEPE, amount: 1000 }),
    ], W, { labels: LABELS });
    expect(acts).toHaveLength(1);
    const [a] = acts;
    expect(a).toMatchObject({
      id: `ethereum:${txh('d')}:${W}:${PEPE}`, chain: 'ethereum', type: 'SWAP_BUY', direction: 'IN', amount: 1000,
      usdValue: 1500, counterparty: POOL, confidence: 'MEDIUM', wallet: W, provider: 'prov-a', isSimulated: false,
      explorerUrl: `https://etherscan.io/tx/${txh('d')}`, blockTime: T0,
    });
    expect(a.token).toEqual({ address: PEPE, symbol: 'PEPE', name: null, decimals: 18 });
    expect(a.reason).toMatch(/Swap: wallet mengirim 0.5 WETH dan menerima 1000 PEPE/);
  });

  it('UNIT-SM-CLS-002 swap jual PEPE → USDC (kategori provider swap): SWAP_SELL, stablecoin = 1 USD/unit, HIGH', () => {
    const acts = classifyTransaction([
      tr({ from: W, to: POOL, token: PEPE, amount: 1000, usd: 999, meta: { providerCategory: 'swap' } }),
      tr({ from: POOL, to: W, token: USDC, amount: 600 }),
    ], W, {});
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ type: 'SWAP_SELL', direction: 'OUT', amount: 1000, usdValue: 600, confidence: 'HIGH' });
    expect(acts[0].reason).toMatch(/jual PEPE/);
  });

  it('UNIT-SM-CLS-003 sisi quote native/wrapped tanpa usdValue → pakai usdValue provider token, lalu null (tidak menebak)', () => {
    const withProvider = classifyTransaction([
      tr({ from: W, to: POOL, token: WETH, amount: 0.5 }),
      tr({ from: POOL, to: W, token: PEPE, amount: 1000, usd: 1490 }),
    ], W);
    expect(withProvider[0].usdValue).toBe(1490);
    const none = classifyTransaction([
      tr({ tx: txh('e'), from: W, to: POOL, token: WETH, amount: 0.5 }),
      tr({ tx: txh('e'), from: POOL, to: W, token: PEPE, amount: 1000 }),
    ], W);
    expect(none[0].usdValue).toBeNull();
  });

  it('UNIT-SM-CLS-004 swap token-ke-token: SWAP_SELL token keluar + SWAP_BUY token masuk', () => {
    const acts = classifyTransaction([
      tr({ from: W, to: POOL, token: PEPE, amount: 1000, usd: 100 }),
      tr({ from: POOL, to: W, token: FOO, amount: 5 }),
    ], W);
    expect(acts.map((a) => [a.token.address, a.type, a.usdValue])).toEqual([
      [PEPE, 'SWAP_SELL', 100],
      [FOO, 'SWAP_BUY', null],
    ]);
    expect(acts[1].reason).toMatch(/token-ke-token/);
  });

  it('UNIT-SM-CLS-005 swap quote↔quote USDC → WETH: baris aset quote (tidak masuk radar)', () => {
    const acts = classifyTransaction([
      tr({ from: W, to: POOL, token: USDC, amount: 3000 }),
      tr({ from: POOL, to: W, token: WETH, amount: 1 }),
    ], W);
    expect(acts.map((a) => [a.token.symbol, a.type, a.usdValue])).toEqual([
      ['USDC', 'SWAP_SELL', 3000],
      ['WETH', 'SWAP_BUY', 3000],
    ]);
    expect(acts[0].reason).toMatch(/aset quote/);
  });

  it('UNIT-SM-CLS-006 kategori provider swap dihormati walau hanya satu sisi terlihat (ETH native tidak tercatat) → LOW', () => {
    const acts = classifyTransaction([
      tr({ from: POOL, to: W, token: PEPE, amount: 1000, usd: 300, meta: { providerCategory: 'swap' } }),
    ], W);
    expect(acts[0]).toMatchObject({ type: 'SWAP_BUY', usdValue: 300, confidence: 'LOW' });
    expect(acts[0].reason).toMatch(/hanya satu sisi/);
  });

  it('UNIT-SM-CLS-007 lawan berlabel dex_router bersumber → confidence HIGH', () => {
    const labels = new Map([label(POOL, 'dex_pool', 'dune-labels', 'Uniswap V3: PEPE')]);
    const acts = classifyTransaction([
      tr({ from: W, to: POOL, token: WETH, amount: 1, usd: 3000 }),
      tr({ from: POOL, to: W, token: PEPE, amount: 10 }),
    ], W, { labels });
    expect(acts[0].confidence).toBe('HIGH');
    expect(acts[0].counterpartyLabel).toEqual({ label: 'Uniswap V3: PEPE', category: 'dex_pool', source: 'dune-labels' });
  });

  it('UNIT-SM-CLS-008 token tanpa decimals → confidence LOW', () => {
    const acts = classifyTransaction([
      tr({ from: W, to: POOL, token: WETH, amount: 1, usd: 3000 }),
      tr({ from: POOL, to: W, token: FOO, amount: 10, decimals: null }),
    ], W);
    expect(acts[0]).toMatchObject({ type: 'SWAP_BUY', confidence: 'LOW' });
    expect(acts[0].reason).toMatch(/decimals/);
  });
});

describe('classify — bukan beli/jual', () => {
  it('UNIT-SM-CLS-010 penarikan exchange (label cex) BUKAN pembelian', () => {
    const acts = classifyTransaction([tr({ from: CEX, to: W, token: PEPE, amount: 5000, usd: 800, meta: { initiator: CEX } })], W, { labels: LABELS });
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ type: 'CEX_WITHDRAWAL', direction: 'IN', confidence: 'HIGH', counterparty: CEX });
    expect(acts[0].counterpartyLabel).toEqual({ label: 'Binance 14', category: 'cex', source: 'etherscan-nametag' });
    expect(acts[0].reason).toMatch(/Penarikan dari exchange \(Binance 14\)/);
    expect(isBuyOrSell(acts[0])).toBe(false);
  });

  it('UNIT-SM-CLS-011 deposit ke exchange (cex_deposit) BUKAN penjualan — indikasi keluar', () => {
    const dep = addr('e');
    const labels = new Map([label(dep, 'cex_deposit', 'heuristik-deposit-reuse', 'Deposit Binance')]);
    const acts = classifyTransaction([tr({ from: W, to: dep, token: PEPE, amount: 5000 })], W, { labels });
    expect(acts[0]).toMatchObject({ type: 'CEX_DEPOSIT', direction: 'OUT' });
    expect(acts[0].reason).toMatch(/belum tentu dijual/);
    expect(isBuyOrSell(acts[0])).toBe(false);
  });

  it('UNIT-SM-CLS-012 bridge masuk (label bridge & kategori provider) → BRIDGE_IN', () => {
    const viaLabel = classifyTransaction([tr({ from: BRIDGE, to: W, token: USDC, amount: 100 })], W, { labels: LABELS });
    expect(viaLabel[0]).toMatchObject({ type: 'BRIDGE_IN', confidence: 'HIGH' });
    const viaCategory = classifyTransaction([
      tr({ tx: txh('e'), from: FRIEND, to: W, token: PEPE, amount: 100, meta: { providerCategory: 'bridge' } }),
    ], W);
    expect(viaCategory[0].type).toBe('BRIDGE_IN');
    const out = classifyTransaction([tr({ tx: txh('f'), from: W, to: BRIDGE, token: PEPE, amount: 1 })], W, { labels: LABELS });
    expect(out[0].type).toBe('BRIDGE_OUT');
  });

  it('UNIT-SM-CLS-013 airdrop via label distributor dan via metode claim yang dipanggil wallet', () => {
    const viaLabel = classifyTransaction([tr({ from: DIST, to: W, token: FOO, amount: 50, meta: { initiator: DIST } })], W, { labels: LABELS });
    expect(viaLabel[0]).toMatchObject({ type: 'AIRDROP', confidence: 'HIGH' });
    const viaClaim = classifyTransaction([
      tr({ tx: txh('e'), from: FRIEND, to: W, token: FOO, amount: 50, meta: { method: 'claimTokens' } }),
    ], W);
    expect(viaClaim[0]).toMatchObject({ type: 'AIRDROP', confidence: 'MEDIUM' });
    expect(viaClaim[0].reason).toMatch(/claimTokens/);
    const viaCategory = classifyTransaction([
      tr({ tx: txh('f'), from: FRIEND, to: W, token: FOO, amount: 50, meta: { providerCategory: 'airdrop', initiator: FRIEND } }),
    ], W);
    expect(viaCategory[0].type).toBe('AIRDROP');
  });

  it('UNIT-SM-CLS-014 mint dari alamat nol → MINT; burn ke alamat nol → BURN', () => {
    const mint = classifyTransaction([tr({ from: ZERO_ADDRESS, to: W, token: FOO, amount: 10 })], W);
    expect(mint[0]).toMatchObject({ type: 'MINT', direction: 'IN', counterparty: ZERO_ADDRESS });
    const burn = classifyTransaction([tr({ tx: txh('e'), from: W, to: ZERO_ADDRESS, token: FOO, amount: 10 })], W);
    expect(burn[0]).toMatchObject({ type: 'BURN', direction: 'OUT' });
  });

  it('UNIT-SM-CLS-015 tambah likuiditas (dua token ke pool + LP token di-mint) → LP_ADD, bukan beli/jual', () => {
    const acts = classifyTransaction([
      tr({ from: W, to: POOL, token: WETH, amount: 1, usd: 3000 }),
      tr({ from: W, to: POOL, token: PEPE, amount: 1e6 }),
      tr({ from: ZERO_ADDRESS, to: W, token: LPT, amount: 31.6 }),
    ], W);
    expect(acts.map((a) => [a.token.address, a.type, a.direction])).toEqual([
      [PEPE, 'LP_ADD', 'OUT'],
      [WETH, 'LP_ADD', 'OUT'],
    ]);
    expect(acts.every((a) => !isBuyOrSell(a))).toBe(true);
    expect(acts.some((a) => a.token.address === LPT)).toBe(false);
    expect(acts[0].confidence).toBe('MEDIUM');
    expect(acts[0].reason).toMatch(/Tambah likuiditas/);
    // dengan label lp_token bersumber → HIGH
    const labelled = classifyTransaction([
      tr({ tx: txh('e'), from: W, to: POOL, token: WETH, amount: 1 }),
      tr({ tx: txh('e'), from: POOL, to: W, token: LPT, amount: 31.6 }),
    ], W, { labels: LABELS });
    expect(labelled).toHaveLength(1);
    expect(labelled[0]).toMatchObject({ type: 'LP_ADD', confidence: 'HIGH' });
  });

  it('UNIT-SM-CLS-016 tarik likuiditas (LP token di-burn, terima dua token) → LP_REMOVE, bukan beli', () => {
    const acts = classifyTransaction([
      tr({ from: W, to: LPT, token: LPT, amount: 31.6 }),
      tr({ from: POOL, to: W, token: WETH, amount: 1.1 }),
      tr({ from: POOL, to: W, token: PEPE, amount: 9e5 }),
    ], W, { labels: LABELS });
    expect(acts).toHaveLength(2);
    expect(acts.every((a) => a.type === 'LP_REMOVE' && a.direction === 'IN')).toBe(true);
    expect(acts[0].reason).toMatch(/Tarik likuiditas/);
    // burn ke ZERO_ADDRESS tanpa label → tetap LP_REMOVE (MEDIUM)
    const unlabelled = classifyTransaction([
      tr({ tx: txh('e'), from: W, to: ZERO_ADDRESS, token: FOO, amount: 3 }),
      tr({ tx: txh('e'), from: POOL, to: W, token: PEPE, amount: 10 }),
    ], W);
    expect(unlabelled).toEqual([expect.objectContaining({ type: 'LP_REMOVE', confidence: 'MEDIUM' })]);
  });

  it('UNIT-SM-CLS-017 transfer masuk dari EOA tak berlabel → TRANSFER_IN (bukan pembelian)', () => {
    const acts = classifyTransaction([tr({ from: FRIEND, to: W, token: PEPE, amount: 10, usd: 5, meta: { initiator: FRIEND } })], W, { labels: LABELS });
    expect(acts[0]).toMatchObject({ type: 'TRANSFER_IN', confidence: 'MEDIUM', counterparty: FRIEND, counterpartyLabel: null, usdValue: 5 });
    const out = classifyTransaction([tr({ tx: txh('e'), from: W, to: FRIEND, token: PEPE, amount: 10 })], W);
    expect(out[0]).toMatchObject({ type: 'TRANSFER_OUT', direction: 'OUT' });
  });

  it('UNIT-SM-CLS-018 token spam masuk yang diprakarsai alamat lain (metode airdrop) → TRANSFER_IN', () => {
    const acts = classifyTransaction([
      tr({ from: SPAMMER, to: W, token: FOO, amount: 1e9, meta: { initiator: SPAMMER, toContract: SPAMMER, method: 'airdrop' } }),
    ], W);
    expect(acts[0].type).toBe('TRANSFER_IN');
    expect(acts[0].reason).toMatch(/spam/);
  });

  it('UNIT-SM-CLS-019 label tanpa sumber diabaikan', () => {
    const labels = new Map([[`ethereum:${CEX}`, { chain: 'ethereum', address: CEX, label: 'Exchange?', category: 'cex', source: '' }]]);
    const acts = classifyTransaction([tr({ from: CEX, to: W, token: PEPE, amount: 1 })], W, { labels });
    expect(acts[0].type).toBe('TRANSFER_IN');
    expect(acts[0].counterpartyLabel).toBeNull();
  });
});

describe('classify — masukan kontradiktif & kasus tepi', () => {
  it('UNIT-SM-CLS-020 masukan kontradiktif → UNKNOWN dengan alasan', () => {
    const cexBothWays = classifyTransaction([
      tr({ from: CEX, to: W, token: PEPE, amount: 10 }),
      tr({ from: W, to: FRIEND, token: USDC, amount: 10 }),
    ], W, { labels: LABELS });
    expect(cexBothWays.every((a) => a.type === 'UNKNOWN' && a.confidence === 'LOW')).toBe(true);
    expect(cexBothWays[0].reason).toMatch(/Tidak dapat diklasifikasikan: .*exchange/);
    const airdropBothWays = classifyTransaction([
      tr({ tx: txh('e'), from: POOL, to: W, token: PEPE, amount: 10, meta: { providerCategory: 'airdrop' } }),
      tr({ tx: txh('e'), from: W, to: POOL, token: WETH, amount: 1 }),
    ], W);
    expect(airdropBothWays.map((a) => a.type)).toEqual(['UNKNOWN', 'UNKNOWN']);
    expect(airdropBothWays[0].reason).toMatch(/airdrop/);
    const swapFromCex = classifyTransaction([
      tr({ tx: txh('f'), from: CEX, to: W, token: PEPE, amount: 10, meta: { providerCategory: 'swap' } }),
    ], W, { labels: LABELS });
    expect(swapFromCex[0].type).toBe('UNKNOWN');
    const lpWithoutLpToken = classifyTransaction([
      tr({ tx: txh('9'), from: POOL, to: W, token: PEPE, amount: 10, meta: { providerCategory: 'lp' } }),
      tr({ tx: txh('9'), from: W, to: POOL, token: WETH, amount: 1 }),
    ], W);
    expect(lpWithoutLpToken.every((a) => a.type === 'UNKNOWN')).toBe(true);
    // kategori lp satu sisi → LP_ADD / LP_REMOVE (bukan beli/jual)
    const lpOneSided = classifyTransaction([
      tr({ tx: txh('8'), from: W, to: POOL, token: PEPE, amount: 10, meta: { providerCategory: 'lp' } }),
    ], W);
    expect(lpOneSided[0]).toMatchObject({ type: 'LP_ADD', confidence: 'HIGH' });
  });

  it('UNIT-SM-CLS-021 transfer duplikat dalam satu tx menghasilkan satu activity dengan jumlah benar', () => {
    const buy = tr({ from: POOL, to: W, token: PEPE, amount: 1000, logIndex: 7 });
    const pay = tr({ from: W, to: POOL, token: WETH, amount: 0.5, usd: 1500, logIndex: 6 });
    const acts = classifyTransaction([pay, buy, { ...buy, provider: 'prov-b' }, { ...pay }], W);
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ amount: 1000, usdValue: 1500 });
  });

  it('UNIT-SM-CLS-022 token bersimbol sama di kontrak berbeda tetap dipisah', () => {
    const acts = classifyWalletTransfers([
      tr({ tx: txh('d'), from: W, to: POOL, token: WETH, amount: 1, usd: 3000 }),
      tr({ tx: txh('d'), from: POOL, to: W, token: PEPE, amount: 100 }),
      tr({ tx: txh('e'), time: T0 + 1, from: W, to: POOL, token: WETH, amount: 0.1, usd: 300 }),
      tr({ tx: txh('e'), time: T0 + 1, from: POOL, to: W, token: FAKE_PEPE, amount: 100 }),
    ], W);
    expect(acts).toHaveLength(2);
    expect(acts.map((a) => a.token.symbol)).toEqual(['PEPE', 'PEPE']);
    expect(new Set(acts.map((a) => a.token.address))).toEqual(new Set([PEPE, FAKE_PEPE]));
    expect(acts[0].id).not.toBe(acts[1].id);
  });

  it('UNIT-SM-CLS-023 Solana: alamat peka huruf besar/kecil dipertahankan; SOL/WSOL dianggap quote', () => {
    const SW = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    const SPOOL = '8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj';
    const STX = '4'.repeat(40) + 'K'.repeat(48);
    const transfers = [
      tr({ chain: 'solana', tx: STX, from: SW, to: SPOOL, token: 'native', symbol: 'SOL', decimals: 9, amount: 2, usd: 300, meta: { initiator: SW, toContract: null } }),
      tr({ chain: 'solana', tx: STX, from: SPOOL, to: SW, token: BONK, symbol: 'BONK', decimals: 5, amount: 1e7, meta: { initiator: SW, toContract: null } }),
    ];
    const acts = classifyTransaction(transfers, SW);
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ type: 'SWAP_BUY', wallet: SW, usdValue: 300, id: `solana:${STX}:${SW}:${BONK}` });
    expect(acts[0].explorerUrl).toBe(`https://solscan.io/tx/${STX}`);
    // alamat Solana berbeda huruf = wallet berbeda → tidak ada aktivitas
    expect(classifyTransaction(transfers, SW.toLowerCase())).toEqual([]);
  });

  it('UNIT-SM-CLS-024 wallet EVM huruf besar dinormalisasi; tx tanpa wallet / transfer ke diri sendiri / bersih nol → []', () => {
    const t = [tr({ from: POOL, to: W, token: PEPE, amount: 5 })];
    expect(classifyTransaction(t, `0x${W.slice(2).toUpperCase()}`)[0].wallet).toBe(W);
    expect(classifyTransaction(t, FRIEND)).toEqual([]);
    expect(classifyTransaction([tr({ tx: txh('e'), from: W, to: W, token: PEPE, amount: 5 })], W)).toEqual([]);
    expect(classifyTransaction([
      tr({ tx: txh('f'), from: POOL, to: W, token: PEPE, amount: 5 }),
      tr({ tx: txh('f'), from: W, to: POOL, token: PEPE, amount: 5 }),
    ], W)).toEqual([]);
    expect(classifyTransaction([], W)).toEqual([]);
    expect(classifyTransaction(t, 'bukan-alamat')).toEqual([]);
  });

  it('UNIT-SM-CLS-025 classifyWalletTransfers: urut blockTime (data terlambat), provider & isSimulated dibawa', () => {
    const late = [
      tr({ tx: txh('e'), time: T0 + 60_000, from: FRIEND, to: W, token: FOO, amount: 1, sim: true, provider: 'fixture' }),
      tr({ tx: txh('d'), time: T0, from: W, to: POOL, token: WETH, amount: 1, usd: 3000 }),
      tr({ tx: txh('d'), time: T0, from: POOL, to: W, token: PEPE, amount: 10 }),
    ];
    const acts = classifyWalletTransfers(late, W, { labels: LABELS });
    expect(acts.map((a) => a.type)).toEqual(['SWAP_BUY', 'TRANSFER_IN']);
    expect(acts[1]).toMatchObject({ isSimulated: true, provider: 'fixture' });
    expect(classifyWalletTransfers(late.slice().reverse(), W, { labels: LABELS })).toEqual(acts);
    expect(classifyWalletTransfers(undefined, W)).toEqual([]);
  });

  it('UNIT-SM-CLS-026 explorerUrl mengikuti chain; isStablecoin hanya USDC/USDT/DAI', () => {
    const baseTx = txh('9');
    const acts = classifyTransaction([tr({ chain: 'base', tx: baseTx, from: FRIEND, to: W, token: PEPE, amount: 1 })], W);
    expect(acts[0].explorerUrl).toBe(`https://basescan.org/tx/${baseTx}`);
    expect(isStablecoin('ethereum', USDC)).toBe(true);
    expect(isStablecoin('ethereum', WETH)).toBe(false);
    expect(isStablecoin('ethereum', '0x6b175474e89094c44da98b954eedeac495271d0f')).toBe(true);
    expect(isStablecoin('ethereum', 'native')).toBe(false);
  });

  it('UNIT-SM-CLS-027 klasifikasi deterministik & masukan tidak dimutasi', () => {
    const t = [
      tr({ from: W, to: POOL, token: WETH, amount: 0.5, usd: 1500 }),
      tr({ from: POOL, to: W, token: PEPE, amount: 1000 }),
    ];
    const snapshot = structuredClone(t);
    const a = classifyTransaction(t, W, { labels: LABELS });
    const b = classifyTransaction([...t].reverse(), W, { labels: LABELS });
    expect(b).toEqual(a);
    expect(t).toEqual(snapshot);
  });
});
