import { describe, expect, it } from 'vitest';
import { ZERO_ADDRESS } from '../../../backend/smartmoney/contracts.js';
import { COLLISION_LOG_INDEX_BASE, groupByTransaction, normalizeTransfers } from '../../../backend/smartmoney/normalize.js';

const hex = (c, n) => c.repeat(n);
const TX1 = `0x${hex('a', 64)}`;
const TX2 = `0x${hex('b', 64)}`;
const WALLET = `0x${hex('1', 40)}`;
const POOL = `0x${hex('2', 40)}`;
const PEPE = `0x${hex('3', 40)}`;
const SOL_WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const SOL_TOKEN = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const SOL_TX = '5'.repeat(30) + 'h'.repeat(58);
const upperHex = (s) => `0x${s.slice(2).toUpperCase()}`;

function raw(over = {}) {
  return {
    chain: 'ethereum', txHash: TX1, logIndex: 0, blockNumber: 100, blockTime: 1_000,
    from: POOL, to: WALLET,
    token: { address: PEPE, symbol: 'PEPE', name: 'Pepe', decimals: 18 },
    amount: 1000, usdValue: 50, priceSource: 'prov-a', provider: 'prov-a', isSimulated: false,
    txMeta: { initiator: WALLET, toContract: POOL, method: 'swap', providerCategory: 'swap', dex: 'uniswap-v3' },
    ...over,
  };
}

describe('normalize.normalizeTransfers', () => {
  it('UNIT-SM-NRM-001 alamat & hash EVM dinormalisasi huruf kecil', () => {
    const { transfers, rejected } = normalizeTransfers([raw({
      txHash: upperHex(TX1), from: upperHex(POOL),
      token: { address: `0x${hex('A', 40)}`, symbol: 'X', name: null, decimals: 18 },
      txMeta: { initiator: `0x${hex('B', 40)}`, providerCategory: 'SWAP' },
    })]);
    expect(rejected).toEqual([]);
    const [t] = transfers;
    expect(t.txHash).toBe(TX1);
    expect(t.from).toBe(POOL);
    expect(t.token.address).toBe(`0x${hex('a', 40)}`);
    expect(t.txMeta).toEqual({ initiator: `0x${hex('b', 40)}`, toContract: null, method: null, providerCategory: 'swap', dex: null });
  });

  it('UNIT-SM-NRM-002 alamat & hash Solana dipertahankan apa adanya (peka huruf besar/kecil)', () => {
    const { transfers, rejected } = normalizeTransfers([raw({
      chain: 'solana', txHash: SOL_TX, from: SOL_TOKEN, to: SOL_WALLET,
      token: { address: SOL_TOKEN, symbol: 'BONK', name: null, decimals: 5 }, txMeta: null,
    })]);
    expect(rejected).toEqual([]);
    expect(transfers[0].to).toBe(SOL_WALLET);
    expect(transfers[0].token.address).toBe(SOL_TOKEN);
    expect(transfers[0].txHash).toBe(SOL_TX);
  });

  it('UNIT-SM-NRM-003 ZERO_ADDRESS diterima untuk mint/burn, token native diterima', () => {
    const { transfers, rejected } = normalizeTransfers([
      raw({ from: ZERO_ADDRESS }),
      raw({ logIndex: 1, token: { address: 'native', symbol: 'ETH', name: 'Ether', decimals: 18 } }),
    ]);
    expect(rejected).toEqual([]);
    expect(transfers[0].from).toBe(ZERO_ADDRESS);
    expect(transfers[1].token.address).toBe('native');
  });

  it('UNIT-SM-NRM-004 masukan tidak valid ditolak dengan alasan berbahasa Indonesia', () => {
    const bad = [
      raw({ chain: 'dogechain' }),
      raw({ txHash: '0x1234' }),
      raw({ from: 'bukan-alamat' }),
      raw({ to: 'native' }),
      raw({ token: { address: '0xzz', symbol: 'X' } }),
      raw({ amount: 0 }),
      raw({ amount: -5 }),
      raw({ amount: Number.NaN }),
      raw({ logIndex: -1 }),
      raw({ logIndex: 1.5 }),
      raw({ blockTime: 'kemarin' }),
      raw({ provider: '' }),
      raw({ token: null }),
      raw({ chain: 'solana' }), // hash EVM pada chain Solana
      null,
    ];
    const { transfers, rejected } = normalizeTransfers(bad);
    expect(transfers).toEqual([]);
    expect(rejected).toHaveLength(bad.length);
    expect(rejected[0].reason).toMatch(/Chain tidak dikenal/);
    expect(rejected[1].reason).toMatch(/Hash transaksi tidak valid/);
    expect(rejected[2].reason).toMatch(/pengirim/);
    expect(rejected[3].reason).toMatch(/penerima/);
    expect(rejected[4].reason).toMatch(/kontrak token/);
    expect(rejected[5].reason).toMatch(/harus angka > 0/);
    expect(rejected[8].reason).toMatch(/logIndex/);
    expect(rejected[10].reason).toMatch(/blockTime/);
    expect(rejected[11].reason).toMatch(/Provider/);
    expect(rejected[13].reason).toMatch(/solana/);
    expect(rejected[0].input).toBe(bad[0]);
  });

  it('UNIT-SM-NRM-005 duplikat (chain, txHash, logIndex) dari provider sama & berbeda dibuang', () => {
    const { transfers, duplicates } = normalizeTransfers([
      raw(),
      raw({ provider: 'prov-a' }),
      raw({ provider: 'prov-b', txHash: upperHex(TX1) }),
      raw({ logIndex: 1 }),
    ]);
    expect(transfers).toHaveLength(2);
    expect(duplicates).toBe(2);
    expect(transfers[0].provider).toBe('prov-a');
  });

  it('UNIT-SM-NRM-006 duplikat melengkapi usdValue yang null pada baris pertama', () => {
    const { transfers } = normalizeTransfers([
      raw({ usdValue: null, priceSource: null, txMeta: { method: null } }),
      raw({ provider: 'prov-b', usdValue: 77, priceSource: 'prov-b', txMeta: { method: 'swapExactETHForTokens' } }),
      raw({ provider: 'prov-c', usdValue: 99, priceSource: 'prov-c' }),
    ]);
    expect(transfers).toHaveLength(1);
    expect(transfers[0].provider).toBe('prov-a');
    expect(transfers[0].usdValue).toBe(77);
    expect(transfers[0].priceSource).toBe('prov-b');
    expect(transfers[0].txMeta.method).toBe('swapExactETHForTokens');
  });

  it('UNIT-SM-NRM-007 usdValue rusak menjadi null (tidak diganti 0, tidak menolak transfer)', () => {
    const { transfers } = normalizeTransfers([
      raw({ usdValue: Number.NaN }), raw({ logIndex: 1, usdValue: -3 }), raw({ logIndex: 2, usdValue: undefined }),
    ]);
    expect(transfers.map((t) => t.usdValue)).toEqual([null, null, null]);
    expect(transfers[0].priceSource).toBeNull();
  });

  it('UNIT-SM-NRM-008 data terlambat: urutan keluaran blockTime → txHash → logIndex, sama untuk masukan acak', () => {
    const items = [
      raw({ txHash: TX2, logIndex: 0, blockTime: 2_000 }),
      raw({ txHash: TX2, logIndex: 3, blockTime: 1_000 }),
      raw({ txHash: TX1, logIndex: 5, blockTime: 1_000 }),
      raw({ txHash: TX1, logIndex: 2, blockTime: 1_000 }),
    ];
    const a = normalizeTransfers(items).transfers;
    const b = normalizeTransfers([...items].reverse()).transfers;
    expect(a.map((t) => `${t.blockTime}:${t.txHash.slice(2, 3)}:${t.logIndex}`)).toEqual(['1000:a:2', '1000:a:5', '1000:b:3', '2000:b:0']);
    expect(b).toEqual(a);
  });

  it('UNIT-SM-NRM-009 kegagalan sumber data (masukan bukan array) → hasil kosong, tanpa exception', () => {
    expect(normalizeTransfers(undefined)).toEqual({ transfers: [], rejected: [], duplicates: 0, collisions: 0 });
    expect(normalizeTransfers(null)).toEqual({ transfers: [], rejected: [], duplicates: 0, collisions: 0 });
  });

  it('UNIT-SM-NRM-010 providerCategory tak dikenal → null; isSimulated hanya true bila eksplisit', () => {
    const { transfers } = normalizeTransfers([
      raw({ txMeta: { providerCategory: 'magic' }, isSimulated: 'ya' }),
      raw({ logIndex: 1, isSimulated: true }),
    ]);
    expect(transfers[0].txMeta.providerCategory).toBeNull();
    expect(transfers[0].isSimulated).toBe(false);
    expect(transfers[1].isSimulated).toBe(true);
  });

  it('UNIT-SM-NRM-013 kunci sama tetapi isi berbeda (logIndex sintetis bentrok) → keduanya dipertahankan, logIndex baru', () => {
    const ETH = { address: 'native', symbol: 'ETH', name: 'Ether', decimals: 18 };
    const erc20 = raw({ provider: 'prov-a', usdValue: null, priceSource: null }); // log ERC-20 #0: PEPE masuk
    const nativeLeg = raw({ provider: 'prov-b', from: WALLET, to: POOL, token: ETH, amount: 1, usdValue: 3000 }); // kaki ETH, logIndex sintetis 0
    const { transfers, duplicates, collisions } = normalizeTransfers([erc20, nativeLeg]);
    expect(duplicates).toBe(0);
    expect(collisions).toBe(1);
    expect(transfers).toHaveLength(2);
    expect(transfers[0]).toMatchObject({ logIndex: 0, provider: 'prov-a', usdValue: null, token: { address: PEPE } });
    expect(transfers[1]).toMatchObject({ logIndex: COLLISION_LOG_INDEX_BASE, provider: 'prov-b', usdValue: 3000, token: { address: 'native' } });
    // USD kaki ETH tidak dicangkokkan ke transfer PEPE
    expect(transfers[0].usdValue).toBeNull();
    // tabrakan kedua pada kunci yang sama → indeks berikutnya, tetap unik & aman sebagai bilangan bulat
    const third = raw({ provider: 'prov-c', from: WALLET, to: POOL, token: ETH, amount: 2 });
    const again = normalizeTransfers([erc20, nativeLeg, third]);
    expect(again.collisions).toBe(2);
    expect(again.transfers.map((t) => t.logIndex)).toEqual([0, COLLISION_LOG_INDEX_BASE, COLLISION_LOG_INDEX_BASE + 1]);
    expect(again.transfers.every((t) => Number.isSafeInteger(t.logIndex))).toBe(true);
    // pengiriman ulang baris yang sama dari provider B tetap duplikat biasa
    expect(normalizeTransfers([erc20, nativeLeg, { ...nativeLeg }])).toMatchObject({ duplicates: 1, collisions: 1 });
  });

  it('UNIT-SM-NRM-014 isi sama dengan logIndex berbeda dari provider berbeda (penomoran Solana) → duplikat, tidak digandakan', () => {
    const SOL_POOL = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
    const USDC = { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', name: null, decimals: 6 };
    const BONK = { address: SOL_TOKEN, symbol: 'BONK', name: null, decimals: 5 };
    const sol = (over) => raw({ chain: 'solana', txHash: SOL_TX, txMeta: null, ...over });
    const fromA = [
      sol({ provider: 'prov-a', logIndex: 0, from: SOL_WALLET, to: SOL_POOL, token: USDC, amount: 1000, usdValue: 1000 }),
      sol({ provider: 'prov-a', logIndex: 1, from: SOL_POOL, to: SOL_WALLET, token: BONK, amount: 5e7, usdValue: null }),
    ];
    const fromB = [
      sol({ provider: 'prov-b', logIndex: 2, from: SOL_WALLET, to: SOL_POOL, token: USDC, amount: 1000, usdValue: 1000 }),
      sol({ provider: 'prov-b', logIndex: 3, from: SOL_POOL, to: SOL_WALLET, token: BONK, amount: 5e7 * (1 + 1e-12), usdValue: 990 }),
    ];
    const { transfers, duplicates, collisions } = normalizeTransfers([...fromA, ...fromB]);
    expect(duplicates).toBe(2);
    expect(collisions).toBe(0);
    expect(transfers.map((t) => [t.provider, t.logIndex])).toEqual([['prov-a', 0], ['prov-a', 1]]);
    expect(transfers[1].usdValue).toBe(990); // dilengkapi dari duplikat
    // penomoran bergeser (B: 1 = USDC, 2 = BONK) → tabrakan kunci yang sebenarnya duplikat isi
    const shifted = normalizeTransfers([...fromA, { ...fromB[0], logIndex: 1 }, { ...fromB[1], logIndex: 2 }]);
    expect(shifted).toMatchObject({ duplicates: 2, collisions: 0 });
    expect(shifted.transfers).toHaveLength(2);
  });

  it('UNIT-SM-NRM-015 transfer kembar sah dari provider yang sama tetap dua; provider lain dicocokkan satu-lawan-satu', () => {
    const twinA = [raw({ provider: 'prov-a', logIndex: 4 }), raw({ provider: 'prov-a', logIndex: 5 })];
    expect(normalizeTransfers(twinA)).toMatchObject({ duplicates: 0, collisions: 0 });
    expect(normalizeTransfers(twinA).transfers).toHaveLength(2);
    // provider B melaporkan kedua kembar dengan penomoran lain → keduanya duplikat (bukan hanya yang pertama)
    const twinB = [raw({ provider: 'prov-b', logIndex: 8 }), raw({ provider: 'prov-b', logIndex: 9 })];
    const both = normalizeTransfers([...twinA, ...twinB]);
    expect(both).toMatchObject({ duplicates: 2, collisions: 0 });
    expect(both.transfers.map((t) => t.logIndex)).toEqual([4, 5]);
    // provider C hanya melihat satu → tetap dua transfer, tidak tiga
    expect(normalizeTransfers([...twinA, raw({ provider: 'prov-c', logIndex: 0 })]).transfers).toHaveLength(2);
    // jumlah berbeda (bukan pembulatan) → bukan duplikat isi
    expect(normalizeTransfers([twinA[0], raw({ provider: 'prov-b', logIndex: 7, amount: 1001 })]).transfers).toHaveLength(2);
  });

  it('UNIT-SM-NRM-011 masukan tidak dimutasi', () => {
    const input = raw({ from: upperHex(POOL) });
    const copy = structuredClone(input);
    normalizeTransfers([input, raw({ usdValue: 1 })]);
    expect(input).toEqual(copy);
  });
});

describe('normalize.groupByTransaction', () => {
  it('UNIT-SM-NRM-012 dikelompokkan per chain:txHash', () => {
    const { transfers } = normalizeTransfers([
      raw({ logIndex: 0 }), raw({ logIndex: 1 }), raw({ txHash: TX2, blockTime: 2_000 }),
      raw({ chain: 'base', logIndex: 0 }),
    ]);
    const g = groupByTransaction(transfers);
    expect([...g.keys()].sort()).toEqual([`base:${TX1}`, `ethereum:${TX1}`, `ethereum:${TX2}`].sort());
    expect(g.get(`ethereum:${TX1}`)).toHaveLength(2);
    expect(groupByTransaction([]).size).toBe(0);
  });
});
