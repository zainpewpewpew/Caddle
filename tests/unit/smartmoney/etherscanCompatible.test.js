import { describe, expect, it } from 'vitest';
import { NATIVE_TOKEN } from '../../../backend/smartmoney/contracts.js';
import { normalizeTransfers } from '../../../backend/smartmoney/normalize.js';
import { validateAdapter } from '../../../backend/smartmoney/providers/adapter.js';
import { ProviderError } from '../../../backend/smartmoney/providers/errors.js';
import {
  ETHERSCAN_DEFAULT_CHAINS, ETHERSCAN_TERMS, createEtherscanProvider,
} from '../../../backend/smartmoney/providers/etherscan.js';
import {
  DEFAULT_END_BLOCK, EVM_CHAIN_IDS, SYNTHETIC_LOG_INDEX, baseUnitsToAmount, createEtherscanCompatibleProvider,
} from '../../../backend/smartmoney/providers/etherscanCompatible.js';
import {
  ROUTESCAN_DEFAULT_CHAINS, ROUTESCAN_TERMS, createRoutescanProvider,
} from '../../../backend/smartmoney/providers/routescan.js';
import {
  DAY, HOUR, NOW, NO_TX, addr, advancingTime, createFakeEtherscan, frozenTime, httpResponse, internalRow, ok, tokenTxRow,
  txHash, txListRow, units,
} from './helpers/etherscanFixtures.js';

// Tanpa jaringan: fetch palsu menjawab amplop berbentuk dokumentasi Etherscan (belum direkam live).
const W = addr('1');
const ROUTER = addr('2');
const PAIR = addr('3');
const PEPE = addr('4');
const OTHER = addr('5');
const CEX = addr('6');
const B = addr('7');
const SPAMMER = addr('8');
const KEY = 'RAHASIAKUNCI123XYZ';
const T1 = NOW - 3 * DAY;
const TERMS = { docsUrl: null, attribution: null, displayAllowed: true, notes: 'uji' };

function compat(fake, { time = frozenTime(), ...extra } = {}) {
  return createEtherscanCompatibleProvider({
    id: 'uji-compat', displayName: 'Uji kompatibel', requiresKey: false, chains: ['ethereum', 'base', 'polygon', 'bsc'],
    urlForChain: (chain) => `https://compat.invalid/api?chain=${chain}`, fetchImpl: fake.fetchImpl,
    clock: time.clock, sleep: time.sleep, ratePerSec: 1000, dailyBudget: 1000, terms: TERMS, ...extra,
  });
}

const keyOf = (t) => `${t.txHash}:${t.logIndex}`;
const SWAP_BUY_FN = 'swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline)';
const SWAP_SELL_FN = 'swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)';

/** Beli PEPE dengan 0.5 ETH (blok 100) lalu jual PEPE ke 0.6 ETH (blok 200) — bentuk dokumentasi. */
function swapData() {
  const h1 = txHash(1);
  const h2 = txHash(2);
  return {
    h1, h2,
    data: {
      txlist: [
        txListRow({ block: 100, at: T1, hash: h1, from: W, to: ROUTER, value: units('0.5'), methodId: '0x7ff36ab5', functionName: SWAP_BUY_FN }),
        txListRow({ block: 200, at: T1 + HOUR, hash: h2, from: W, to: ROUTER, value: '0', methodId: '0x18cbafe5', functionName: SWAP_SELL_FN }),
      ],
      tokentx: [
        tokenTxRow({ block: 100, at: T1, hash: h1, from: PAIR, to: W, contract: PEPE, value: units('1000') }),
        tokenTxRow({ block: 200, at: T1 + HOUR, hash: h2, from: W, to: PAIR, contract: PEPE, value: units('1000') }),
      ],
      txlistinternal: [
        internalRow({ block: 200, at: T1 + HOUR, hash: h2, from: ROUTER, to: W, value: units('0.6'), traceId: '0_1' }),
      ],
    },
  };
}

describe('etherscanCompatible — konversi jumlah', () => {
  it('UNIT-SM-ESC-001 baseUnitsToAmount: string desimal BigInt tanpa pembulatan ganda (18/6/0 desimal, hex, sangat besar)', () => {
    // Contoh nilai dokumentasi Etherscan tokentx (MKR, 18 desimal): pembagian float membulatkan dua kali.
    expect(baseUnitsToAmount('5901522149285533025181', 18)).toBe(5901.522149285533);
    expect(Number('5901522149285533025181') / 1e18).not.toBe(5901.522149285533);
    expect(baseUnitsToAmount('1234567', 6)).toBe(1.234567);
    expect(baseUnitsToAmount('1', 18)).toBe(1e-18);
    expect(baseUnitsToAmount('000500000', 6)).toBe(0.5);
    expect(baseUnitsToAmount((2n ** 256n - 1n).toString(), 18)).toBe(1.157920892373162e59);
    expect(baseUnitsToAmount('42', 0)).toBe(42);
    expect(baseUnitsToAmount('0x1e8480', 6)).toBe(2);
    expect(baseUnitsToAmount(10n ** 20n, 18)).toBe(100);
    expect(baseUnitsToAmount('0', 18)).toBe(0);
    for (const [v, d] of [['-1', 18], ['1.5', 18], ['', 18], ['1e18', 18], [null, 18], ['10', -1], ['10', 256], ['10', 1.5]]) {
      expect(baseUnitsToAmount(v, d)).toBeNull();
    }
  });
});

describe('etherscanCompatible — baris → RawTransfer', () => {
  it('UNIT-SM-ESC-002 tokentx + txlist + txlistinternal → RawTransfer kanonik (native ETH, token, internal) yang lolos normalisasi', async () => {
    const { h1, h2, data } = swapData();
    const fake = createFakeEtherscan(data);
    const res = await compat(fake).fetchWalletTransfers({ chain: 'ethereum', address: W });
    expect(fake.calls.map((c) => c.action)).toEqual(['tokentx', 'txlist', 'txlistinternal']);
    expect(res.transfers).toHaveLength(4);
    const buyMeta = { initiator: W, toContract: ROUTER, method: 'swapExactETHForTokens', providerCategory: null, dex: null };
    const sellMeta = { ...buyMeta, method: 'swapExactTokensForETH' };
    const [buyA, buyB, sellA, sellB] = res.transfers;
    const native = res.transfers.filter((t) => t.token.address === NATIVE_TOKEN);
    expect(native).toHaveLength(2);
    expect(res.transfers.find((t) => t.txHash === h1 && t.token.address === NATIVE_TOKEN)).toEqual({
      chain: 'ethereum', txHash: h1, logIndex: SYNTHETIC_LOG_INDEX.nativeTx, blockNumber: 100, blockTime: T1, from: W, to: ROUTER,
      token: { address: NATIVE_TOKEN, symbol: 'ETH', name: 'Ether', decimals: 18 }, amount: 0.5, usdValue: null, priceSource: null,
      provider: 'uji-compat', isSimulated: false, txMeta: buyMeta,
    });
    expect(res.transfers.find((t) => t.txHash === h1 && t.token.address === PEPE)).toMatchObject({
      from: PAIR, to: W, amount: 1000, token: { address: PEPE, symbol: 'PEPE', name: 'Pepe', decimals: 18 }, txMeta: buyMeta,
      blockNumber: 100, usdValue: null,
    });
    const internal = res.transfers.find((t) => t.txHash === h2 && t.token.address === NATIVE_TOKEN);
    expect(internal).toMatchObject({ from: ROUTER, to: W, amount: 0.6, blockTime: T1 + HOUR, txMeta: sellMeta });
    expect(internal.logIndex).toBeGreaterThanOrEqual(SYNTHETIC_LOG_INDEX.internal);
    expect(internal.logIndex).toBeLessThan(SYNTHETIC_LOG_INDEX.nativeTx);
    const tokenSell = res.transfers.find((t) => t.txHash === h2 && t.token.address === PEPE);
    expect(tokenSell.logIndex).toBeGreaterThanOrEqual(SYNTHETIC_LOG_INDEX.token);
    expect(tokenSell.logIndex).toBeLessThan(SYNTHETIC_LOG_INDEX.internal);
    // Urutan kanonik (blockTime, txHash, logIndex).
    expect([buyA, buyB].every((t) => t.txHash === h1) && [sellA, sellB].every((t) => t.txHash === h2)).toBe(true);
    const norm = normalizeTransfers(res.transfers);
    expect(norm.rejected).toEqual([]);
    expect(norm.transfers).toHaveLength(4);
    expect(res.nextCursor).toBeNull();
    expect(res.asOf).toBe(NOW);
    expect(JSON.parse(res.resumeCursor)).toEqual({ startBlock: 200 });
  });

  it('UNIT-SM-ESC-003 tx gagal (isError / txreceipt_status 0 / internal gagal), delegatecall, dan transfer nilai 0 dilewati', async () => {
    const at = T1;
    const fake = createFakeEtherscan({
      txlist: [
        txListRow({ block: 300, at, hash: txHash(3), from: W, to: ROUTER, value: units('1'), isError: '1' }),
        txListRow({ block: 301, at, hash: txHash(4), from: W, to: ROUTER, value: units('0.2'), receipt: '0' }),
      ],
      tokentx: [
        tokenTxRow({ block: 300, at, hash: txHash(3), from: PAIR, to: W, contract: PEPE, value: units('5') }),
        tokenTxRow({ block: 304, at, hash: txHash(7), from: SPAMMER, to: W, contract: PEPE, value: '0' }),
        tokenTxRow({ block: 305, at, hash: txHash(8), from: CEX, to: W, contract: PEPE, value: units('9') }),
      ],
      txlistinternal: [
        internalRow({ block: 302, at, hash: txHash(5), from: ROUTER, to: W, value: units('0.3'), isError: '1' }),
        internalRow({ block: 303, at, hash: txHash(6), from: ROUTER, to: W, value: units('0.1'), type: 'delegatecall' }),
      ],
    });
    const res = await compat(fake).fetchWalletTransfers({ chain: 'ethereum', address: W });
    expect(res.transfers.map((t) => [t.txHash, t.amount])).toEqual([[txHash(8), 9]]);
    expect(res.diagnostics.skipped).toMatchObject({ failedTx: 4, nonValueCall: 1, zeroValue: 1, invalidRow: 0 });
  });

  it('UNIT-SM-ESC-004 txMeta digabung per hash: initiator/toContract/method dari txlist; methodId cadangan; hash di luar txlist → null', async () => {
    const { h1, data } = swapData();
    data.txlist.push(txListRow({ block: 110, at: T1, hash: txHash(9), from: W, to: ROUTER, methodId: '0x38ED1739', functionName: '' }));
    data.tokentx.push(
      tokenTxRow({ block: 110, at: T1, hash: txHash(9), from: PAIR, to: W, contract: OTHER, value: units('3'), symbol: 'OTH', name: 'Other' }),
      tokenTxRow({
        block: 120, at: T1, hash: txHash(10), from: SPAMMER, to: W, contract: OTHER, value: units('1'),
        methodId: '0x2e7ba6ef', functionName: 'claim(uint256 index, address account, uint256 amount, bytes32[] merkleProof)',
      }),
    );
    const res = await compat(createFakeEtherscan(data)).fetchWalletTransfers({ chain: 'ethereum', address: W });
    const meta = (hash) => res.transfers.find((t) => t.txHash === hash).txMeta;
    expect(meta(h1)).toEqual({ initiator: W, toContract: ROUTER, method: 'swapExactETHForTokens', providerCategory: null, dex: null });
    expect(meta(txHash(9))).toMatchObject({ initiator: W, toContract: ROUTER, method: '0x38ed1739' });
    expect(meta(txHash(10))).toEqual({ initiator: null, toContract: null, method: 'claim', providerCategory: null, dex: null });
  });

  it('UNIT-SM-ESC-005 logIndex sintetis stabil lintas urutan respons & lintas wallet; transfer identik tetap dua; logIndex asli dipakai', async () => {
    const h = txHash(20);
    const tokenRows = [
      tokenTxRow({ block: 500, at: T1, hash: h, from: PAIR, to: W, contract: PEPE, value: units('5') }),
      tokenTxRow({ block: 500, at: T1, hash: h, from: PAIR, to: W, contract: PEPE, value: units('5') }),
      tokenTxRow({ block: 500, at: T1, hash: h, from: PAIR, to: W, contract: OTHER, value: units('7'), symbol: 'OTH' }),
    ];
    const internalRows = [
      internalRow({ block: 500, at: T1, hash: h, from: ROUTER, to: W, value: units('0.1'), traceId: '0_1' }),
      internalRow({ block: 500, at: T1, hash: h, from: ROUTER, to: W, value: units('0.1'), traceId: '0_2' }),
    ];
    const run = async (order) => {
      const fake = createFakeEtherscan({}, {
        respond: (u) => {
          const action = u.searchParams.get('action');
          const rows = action === 'tokentx' ? tokenRows : action === 'txlistinternal' ? internalRows : [];
          return rows.length ? ok(order(rows)) : NO_TX;
        },
      });
      return (await compat(fake).fetchWalletTransfers({ chain: 'ethereum', address: W })).transfers;
    };
    const a = await run((rows) => [...rows]);
    const b = await run((rows) => [...rows].reverse());
    const c = await run((rows) => [rows[1], rows[0], ...rows.slice(2)].reverse());
    expect(a).toHaveLength(5);
    expect(new Set(a.map(keyOf)).size).toBe(5);
    expect(b.map(keyOf)).toEqual(a.map(keyOf));
    expect(c).toEqual(a);
    expect(normalizeTransfers(a).duplicates).toBe(0);
    expect(a.filter((t) => t.token.address === PEPE)).toHaveLength(2);

    // Lintas wallet: transfer W→B mendapat logIndex sama dari query W maupun query B.
    const h21 = txHash(21);
    const fake = createFakeEtherscan({
      tokentx: [
        tokenTxRow({ block: 510, at: T1, hash: h21, from: W, to: B, contract: PEPE, value: units('100') }),
        tokenTxRow({ block: 510, at: T1, hash: h21, from: W, to: PAIR, contract: OTHER, value: units('1') }),
        tokenTxRow({ block: 510, at: T1, hash: h21, from: SPAMMER, to: B, contract: OTHER, value: units('3') }),
      ],
    });
    const p = compat(fake);
    const fromW = (await p.fetchWalletTransfers({ chain: 'ethereum', address: W })).transfers.find((t) => t.to === B);
    const fromB = (await p.fetchWalletTransfers({ chain: 'ethereum', address: B })).transfers.find((t) => t.from === W);
    expect(fromB.logIndex).toBe(fromW.logIndex);
    expect(normalizeTransfers([fromW, fromB]).duplicates).toBe(1);

    // logIndex asli (desimal / hex) dipakai apa adanya; tidak ada indeks sintetis.
    const real = await compat(createFakeEtherscan({
      tokentx: [
        tokenTxRow({ block: 520, at: T1, hash: txHash(22), from: PAIR, to: W, contract: PEPE, value: units('1'), logIndex: '7' }),
        tokenTxRow({ block: 520, at: T1, hash: txHash(22), from: PAIR, to: W, contract: OTHER, value: units('2'), logIndex: '0x1f' }),
      ],
    })).fetchWalletTransfers({ chain: 'ethereum', address: W });
    expect(real.transfers.map((t) => t.logIndex).sort((x, y) => x - y)).toEqual([7, 31]);
    expect(real.diagnostics.syntheticLogIndex).toBe(false);
    expect(real.diagnostics.missingFields).not.toContain('tokentx.logIndex');
  });

  it('EDGE-SM-ESC-001 nilai native tx tidak bentrok dengan logIndex asli 0 (keduanya bertahan di normalizeTransfers)', async () => {
    const h = txHash(23);
    const res = await compat(createFakeEtherscan({
      txlist: [txListRow({ block: 600, at: T1, hash: h, from: W, to: ROUTER, value: units('1'), functionName: SWAP_BUY_FN })],
      tokentx: [tokenTxRow({ block: 600, at: T1, hash: h, from: PAIR, to: W, contract: PEPE, value: units('10'), logIndex: '0' })],
    })).fetchWalletTransfers({ chain: 'ethereum', address: W });
    expect(res.transfers.map((t) => t.logIndex).sort((x, y) => x - y)).toEqual([0, SYNTHETIC_LOG_INDEX.nativeTx]);
    const norm = normalizeTransfers(res.transfers);
    expect(norm.transfers).toHaveLength(2);
    expect(norm.duplicates).toBe(0);
  });

  it('UNIT-SM-ESC-006 simbol koin native per chain: ETH (ethereum/base), POL (polygon), BNB (bsc)', async () => {
    const data = { txlist: [txListRow({ block: 700, at: T1, hash: txHash(30), from: CEX, to: W, value: units('2') })] };
    const p = compat(createFakeEtherscan(data));
    const symbolOn = async (chain) => (await p.fetchWalletTransfers({ chain, address: W })).transfers[0].token;
    expect(await symbolOn('ethereum')).toEqual({ address: NATIVE_TOKEN, symbol: 'ETH', name: 'Ether', decimals: 18 });
    expect((await symbolOn('base')).symbol).toBe('ETH');
    expect((await symbolOn('polygon')).symbol).toBe('POL');
    expect((await symbolOn('bsc')).symbol).toBe('BNB');
  });
});

describe('etherscanCompatible — kursor, paginasi, penahanan', () => {
  it('UNIT-SM-ESC-007 paginasi per blok: gabungan halaman = hasil satu tembakan, tiap halaman memuat tx yang lengkap', async () => {
    const at = (b) => T1 + b * 1000;
    const tok = (b, n, extra = {}) => tokenTxRow({ block: b, at: at(b), hash: txHash(n), from: PAIR, to: W, contract: PEPE, value: units(String(n)), ...extra });
    const data = {
      tokentx: [
        tok(10, 101), tokenTxRow({ block: 11, at: at(11), hash: txHash(102), from: W, to: PAIR, contract: PEPE, value: units('4') }),
        tok(12, 103), tok(13, 104), tok(13, 105), tok(15, 106), tok(16, 107), tok(17, 108),
      ],
      txlist: [
        txListRow({ block: 10, at: at(10), hash: txHash(101), from: W, to: ROUTER, value: units('0.1'), functionName: SWAP_BUY_FN }),
        txListRow({ block: 11, at: at(11), hash: txHash(102), from: W, to: ROUTER, functionName: SWAP_SELL_FN }),
        txListRow({ block: 14, at: at(14), hash: txHash(109), from: CEX, to: W, value: units('1') }),
        txListRow({ block: 16, at: at(16), hash: txHash(107), from: W, to: ROUTER, value: units('0.2') }),
      ],
      txlistinternal: [
        internalRow({ block: 11, at: at(11), hash: txHash(102), from: ROUTER, to: W, value: units('0.05') }),
        internalRow({ block: 15, at: at(15), hash: txHash(106), from: ROUTER, to: W, value: units('0.01') }),
      ],
    };
    const fake = createFakeEtherscan(data);
    const paged = compat(fake, { pageSize: 3 });
    const pages = [];
    let cursor = null;
    do {
      const page = await paged.fetchWalletTransfers({ chain: 'ethereum', address: W, cursor });
      pages.push(page);
      if (page.nextCursor !== null) {
        expect(JSON.parse(page.nextCursor).startBlock).toBeGreaterThan(cursor === null ? 0 : JSON.parse(cursor).startBlock);
        expect(page.resumeCursor).toBe(page.nextCursor);
        expect(page.asOf).toBeLessThanOrEqual(NOW);
      }
      cursor = page.nextCursor;
    } while (cursor !== null && pages.length < 20);
    expect(pages.length).toBe(5);
    expect(pages[0].diagnostics.pagedBy).toBe('tokentx');
    expect(fake.calls.filter((c) => c.action === 'tokentx').map((c) => c.url.searchParams.get('startblock'))).toEqual(['0', '12', '13', '15', '17']);

    const single = await compat(createFakeEtherscan(data)).fetchWalletTransfers({ chain: 'ethereum', address: W });
    const union = normalizeTransfers(pages.flatMap((p) => p.transfers));
    expect(union.transfers.map(keyOf).sort()).toEqual(single.transfers.map(keyOf).sort());
    expect(single.transfers).toHaveLength(13);
    // Kelengkapan per tx: setiap tx di satu halaman memuat semua kakinya.
    const byTx = (list) => list.reduce((m, t) => m.set(t.txHash, (m.get(t.txHash) ?? 0) + 1), new Map());
    const expectedLegs = byTx(single.transfers);
    for (const page of pages) {
      for (const [hash, n] of byTx(page.transfers)) expect(n).toBe(expectedLegs.get(hash));
    }
    expect(JSON.parse(pages.at(-1).resumeCursor)).toEqual({ startBlock: 17 });
  });

  it('EDGE-SM-ESC-002 satu blok berisi ≥ pageSize baris → peringatan, kursor maju ke blok berikutnya (tanpa loop)', async () => {
    const rows = [1, 2, 3].map((n) => tokenTxRow({ block: 50, at: T1, hash: txHash(40 + n), from: PAIR, to: W, contract: PEPE, value: units(String(n)) }));
    rows.push(tokenTxRow({ block: 51, at: T1, hash: txHash(44), from: PAIR, to: W, contract: PEPE, value: units('4') }));
    const p = compat(createFakeEtherscan({ tokentx: rows }), { pageSize: 2 });
    const first = await p.fetchWalletTransfers({ chain: 'ethereum', address: W });
    expect(first.transfers).toEqual([]);
    expect(JSON.parse(first.nextCursor)).toEqual({ startBlock: 50 });
    const second = await p.fetchWalletTransfers({ chain: 'ethereum', address: W, cursor: first.nextCursor });
    expect(second.transfers).toHaveLength(2);
    expect(JSON.parse(second.nextCursor)).toEqual({ startBlock: 51 });
    expect(second.diagnostics.warnings.join(' ')).toMatch(/Blok 50: tokentx berisi ≥ 2 baris dalam satu blok/);
    const third = await p.fetchWalletTransfers({ chain: 'ethereum', address: W, cursor: second.nextCursor });
    expect(third.transfers.map((t) => t.amount)).toEqual([4]);
    expect(third.nextCursor).toBeNull();
  });

  it('EDGE-SM-ESC-003 data terlambat: baris < settleMs ditahan; kaki internal yang terindeks belakangan tiba bersama kaki tokennya', async () => {
    const time = frozenTime();
    const late = NOW - 30_000;
    const data = {
      tokentx: [
        tokenTxRow({ block: 900, at: NOW - HOUR, hash: txHash(50), from: PAIR, to: W, contract: PEPE, value: units('1') }),
        tokenTxRow({ block: 901, at: late, hash: txHash(51), from: W, to: PAIR, contract: PEPE, value: units('1') }),
      ],
      txlist: [txListRow({ block: 901, at: late, hash: txHash(51), from: W, to: ROUTER, functionName: SWAP_SELL_FN })],
      txlistinternal: [],
    };
    const p = compat(createFakeEtherscan(data), { time });
    const first = await p.fetchWalletTransfers({ chain: 'ethereum', address: W });
    expect(first.transfers.map((t) => t.txHash)).toEqual([txHash(50)]);
    expect(first.nextCursor).toBeNull();
    expect(JSON.parse(first.resumeCursor)).toEqual({ startBlock: 901 });
    expect(first.asOf).toBe(NOW - 120_000);
    expect(first.diagnostics.deferred).toBe(2);
    // Internal tx terindeks belakangan; sinkronisasi berikutnya melanjutkan dari resumeCursor.
    data.txlistinternal.push(internalRow({ block: 901, at: late, hash: txHash(51), from: ROUTER, to: W, value: units('0.4') }));
    time.advance(5 * 60_000);
    const second = await p.fetchWalletTransfers({ chain: 'ethereum', address: W, cursor: first.resumeCursor });
    expect(second.transfers.filter((t) => t.txHash === txHash(51)).map((t) => t.token.symbol).sort()).toEqual(['ETH', 'PEPE']);
    expect(second.asOf).toBe(NOW + 5 * 60_000);
    expect(JSON.parse(second.resumeCursor)).toEqual({ startBlock: 901 });
  });

  it('EDGE-SM-ESC-004 since menyaring baris lama (mulai dari blok 0); signal batal → TIMEOUT tanpa jaringan', async () => {
    const fake = createFakeEtherscan({
      tokentx: [
        tokenTxRow({ block: 1000, at: NOW - 10 * DAY, hash: txHash(60), from: PAIR, to: W, contract: PEPE, value: units('1') }),
        tokenTxRow({ block: 2000, at: NOW - DAY, hash: txHash(61), from: PAIR, to: W, contract: PEPE, value: units('2') }),
      ],
    });
    const p = compat(fake);
    const res = await p.fetchWalletTransfers({ chain: 'ethereum', address: W, since: NOW - 2 * DAY });
    expect(fake.calls[0].url.searchParams.get('startblock')).toBe('0');
    expect(res.transfers.map((t) => t.amount)).toEqual([2]);
    expect(res.diagnostics.skipped.beforeSince).toBe(1);
    const ac = new AbortController();
    ac.abort();
    const before = fake.calls.length;
    await expect(p.fetchWalletTransfers({ chain: 'ethereum', address: W, signal: ac.signal })).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(fake.calls.length).toBe(before);
  });

  it('UNIT-SM-ESC-008 diagnostics: field hilang (logIndex, functionName) & tidak dikenal, jumlah baris mentah, URL tanpa kunci', async () => {
    const { data } = swapData();
    data.tokentx[0].fooBar = 'baru';
    delete data.txlist[0].functionName;
    const res = await compat(createFakeEtherscan(data)).fetchWalletTransfers({ chain: 'ethereum', address: W });
    expect(res.diagnostics.missingFields).toEqual(['tokentx.logIndex', 'txlist.functionName']);
    expect(res.diagnostics.unknownFields).toEqual(['tokentx.fooBar']);
    expect(res.diagnostics.syntheticLogIndex).toBe(true);
    expect(res.diagnostics.rawCounts).toEqual({ tokentx: 2, txlist: 2, txlistinternal: 1 });
    expect(res.diagnostics.range).toEqual({ fromBlock: 0, toBlockExclusive: null });
    expect(res.diagnostics.requests).toHaveLength(3);
    // Tanpa functionName, methodId menjadi cadangan.
    expect(res.transfers.find((t) => t.txHash === txHash(1)).txMeta.method).toBe('0x7ff36ab5');
  });
});

describe('etherscanCompatible — pemetaan galat & batas', () => {
  const fetchWith = async (respond, opts) => {
    const fake = createFakeEtherscan({}, { respond });
    const p = compat(fake, opts);
    return { err: await p.fetchWalletTransfers({ chain: 'ethereum', address: W }).catch((e) => e), p, fake };
  };

  it('NEG-SM-ESC-001 setiap keluarga pesan Etherscan & status HTTP dipetakan ke kode ProviderError', async () => {
    const env = (result, message = 'NOTOK') => ({ status: '0', message, result });
    const cases = [
      [env('Max rate limit reached'), { code: 'RATE_LIMITED', retryAfterMs: 1000 }],
      [env('Max calls per sec rate limit reached (3/sec)'), { code: 'RATE_LIMITED', retryAfterMs: 1000 }],
      [env('Max daily rate limit reached. 100000 (100%) of Daily API Limit used.'), { code: 'RATE_LIMITED', retryAfterMs: 12 * HOUR }],
      [env('Invalid API Key (#err2)|x'), { code: 'UNAUTHORIZED' }],
      [env('Missing/Invalid API Key'), { code: 'UNAUTHORIZED' }],
      [env('Free API access is not supported for this chain. Please upgrade your api plan for full chain coverage. https://etherscan.io/apis'), { code: 'NOT_SUPPORTED' }],
      [env('Sorry, it looks like you are trying to access an API Pro endpoint. Contact us to upgrade to API Pro.'), { code: 'NOT_SUPPORTED' }],
      [env('Missing or unsupported chainid parameter (required for v2 api), please see https://api.etherscan.io/v2/chainlist'), { code: 'NOT_SUPPORTED' }],
      [env(null, 'Query Timeout occured. Please select a smaller result dataset'), { code: 'TIMEOUT' }],
      [env('Error! Invalid address format'), { code: 'BAD_RESPONSE' }],
      [{ status: '1', message: 'OK', result: 'bukan daftar' }, { code: 'BAD_RESPONSE' }],
      [{ message: 'OK', result: [] }, { code: 'BAD_RESPONSE' }],
      [[1, 2], { code: 'BAD_RESPONSE' }],
      [httpResponse(401, ''), { code: 'UNAUTHORIZED' }],
      [httpResponse(403, ''), { code: 'UNAUTHORIZED' }],
      [httpResponse(429, '', { 'retry-after': '7' }), { code: 'RATE_LIMITED', retryAfterMs: 7000 }],
      [httpResponse(503, ''), { code: 'UNAVAILABLE' }],
      [httpResponse(404, ''), { code: 'NOT_SUPPORTED' }],
      [httpResponse(200, '<html>Just a moment...</html>'), { code: 'BAD_RESPONSE' }],
    ];
    for (const [answer, expected] of cases) {
      const { err } = await fetchWith(() => answer);
      expect(err, JSON.stringify(answer)).toBeInstanceOf(ProviderError);
      expect(err).toMatchObject({ provider: 'uji-compat', ...expected });
    }
    const { err } = await fetchWith(() => env('Free API access is not supported for this chain. Please upgrade your api plan.'));
    expect(err.message).toContain('Free API access is not supported for this chain');
    // "No transactions found" / result kosong → kosong, bukan galat.
    for (const empty of [NO_TX, { status: '0', message: 'No records found', result: [] }, { status: '0', message: 'NOTOK', result: [] }]) {
      const fake = createFakeEtherscan({}, { respond: () => empty });
      expect((await compat(fake).fetchWalletTransfers({ chain: 'ethereum', address: W })).transfers).toEqual([]);
    }
  });

  it('NEG-SM-ESC-002 chain di luar paket gratis → NOT_SUPPORTED lalu ditolak lokal 1 jam (hemat kuota); chain lain tetap jalan', async () => {
    const time = frozenTime();
    const fake = createFakeEtherscan({}, {
      respond: (u) => (u.searchParams.get('chainid') === '8453'
        ? { status: '0', message: 'NOTOK', result: 'Free API access is not supported for this chain. Please upgrade your api plan for full chain coverage.' }
        : undefined),
    });
    const p = createEtherscanProvider({ apiKey: KEY, chains: ['ethereum', 'base'], fetchImpl: fake.fetchImpl, clock: time.clock, sleep: time.sleep });
    await expect(p.fetchWalletTransfers({ chain: 'base', address: W })).rejects.toMatchObject({ code: 'NOT_SUPPORTED', provider: 'etherscan' });
    expect(fake.calls).toHaveLength(1);
    await expect(p.fetchWalletTransfers({ chain: 'base', address: B })).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    expect(fake.calls).toHaveLength(1);
    await expect(p.fetchWalletTransfers({ chain: 'ethereum', address: W })).resolves.toMatchObject({ transfers: [] });
    expect(fake.calls).toHaveLength(4);
    time.advance(HOUR + 1);
    await expect(p.fetchWalletTransfers({ chain: 'base', address: W })).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    expect(fake.calls).toHaveLength(5);
  });

  it('NEG-SM-ESC-003 batas laju provider → jeda lokal tanpa jaringan; batas harian → sampai pergantian hari UTC', async () => {
    const time = frozenTime();
    let limited = true;
    const { err, p, fake } = await fetchWith(() => (limited ? { status: '0', message: 'NOTOK', result: 'Max rate limit reached' } : undefined), { time });
    expect(err).toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 1000 });
    expect(p.quota().blockedUntil).toBe(NOW + 1000);
    await expect(p.fetchWalletTransfers({ chain: 'ethereum', address: W })).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 1000 });
    expect(fake.calls).toHaveLength(1);
    time.advance(1000);
    limited = false;
    await expect(p.fetchWalletTransfers({ chain: 'ethereum', address: W })).resolves.toMatchObject({ transfers: [] });
    expect(fake.calls).toHaveLength(4);
    expect(p.quota().blockedUntil).toBeNull();

    const daily = await fetchWith(() => ({ status: '0', message: 'NOTOK', result: 'Max daily rate limit reached' }));
    expect(daily.err.retryAfterMs).toBe(12 * HOUR);
    expect(daily.p.quota().blockedUntil).toBe(Date.UTC(2026, 9, 27));
    const http = await fetchWith(() => httpResponse(429, '', { 'retry-after': '7' }));
    expect(http.p.quota().blockedUntil).toBe(NOW + 7000);
  });

  it('NEG-SM-ESC-004 masukan tidak valid ditolak tanpa jaringan: chain tak didukung, alamat, kursor, since', async () => {
    const fake = createFakeEtherscan({});
    const p = compat(fake);
    const bad = [
      [{ chain: 'solana', address: W }, 'NOT_SUPPORTED'],
      [{ chain: 'optimism', address: W }, 'NOT_SUPPORTED'],
      [{ chain: 'ethereum', address: 'bukan-alamat' }, 'BAD_RESPONSE'],
      [{ chain: 'ethereum', address: NATIVE_TOKEN }, 'BAD_RESPONSE'],
      [{ chain: 'ethereum', address: W, cursor: 'b0:o10' }, 'BAD_RESPONSE'],
      [{ chain: 'ethereum', address: W, cursor: '{"startBlock":-1}' }, 'BAD_RESPONSE'],
      [{ chain: 'ethereum', address: W, since: 'kemarin' }, 'BAD_RESPONSE'],
    ];
    for (const [query, code] of bad) {
      await expect(p.fetchWalletTransfers(query), JSON.stringify(query)).rejects.toMatchObject({ code, provider: 'uji-compat' });
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('NEG-SM-ESC-005 kuota harian habis → RATE_LIMITED tanpa panggilan tambahan; quota() melaporkan sisa', async () => {
    const fake = createFakeEtherscan({});
    const p = compat(fake, { dailyBudget: 4 });
    await p.fetchWalletTransfers({ chain: 'ethereum', address: W });
    const err = await p.fetchWalletTransfers({ chain: 'ethereum', address: W }).catch((e) => e);
    expect(err).toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 12 * HOUR });
    expect(fake.calls).toHaveLength(4);
    expect(p.quota()).toMatchObject({ limit: 4, used: 4, remaining: 0, blockedUntil: null });
  });

  it('UNIT-SM-ESC-009 throttle: Etherscan 2/detik (jarak 500 ms), Routescan 1,5/detik (≈667 ms)', async () => {
    const t = advancingTime();
    const e = createFakeEtherscan({}, { clock: t.clock });
    await createEtherscanProvider({ apiKey: KEY, fetchImpl: e.fetchImpl, clock: t.clock, sleep: t.sleep })
      .fetchWalletTransfers({ chain: 'ethereum', address: W });
    expect(e.calls.map((c) => c.at - NOW)).toEqual([0, 500, 1000]);
    const t2 = advancingTime();
    const r = createFakeEtherscan({}, { clock: t2.clock });
    await createRoutescanProvider({ fetchImpl: r.fetchImpl, clock: t2.clock, sleep: t2.sleep }).fetchWalletTransfers({ chain: 'base', address: W });
    const gaps = r.calls.slice(1).map((c, i) => c.at - r.calls[i].at);
    expect(gaps[0]).toBeCloseTo(666.67, 1);
    expect(gaps[1]).toBeCloseTo(666.67, 1);
  });
});

describe('Etherscan & Routescan — konfigurasi', () => {
  it('UNIT-SM-ESC-010 Etherscan V2: URL, chainid per chain, endblock aman, kunci di query (bukan header)', async () => {
    const time = frozenTime();
    const fake = createFakeEtherscan({});
    const p = createEtherscanProvider({ apiKey: ` ${KEY} `, fetchImpl: fake.fetchImpl, clock: time.clock, sleep: time.sleep });
    await p.fetchWalletTransfers({ chain: 'ethereum', address: `0x${'A'.repeat(40)}` });
    const [first] = fake.calls;
    expect(`${first.url.origin}${first.url.pathname}`).toBe('https://api.etherscan.io/v2/api');
    expect(Object.fromEntries(first.url.searchParams)).toEqual({
      chainid: '1', module: 'account', action: 'tokentx', address: addr('a'), startblock: '0', endblock: String(DEFAULT_END_BLOCK),
      page: '1', offset: '1000', sort: 'asc', apikey: KEY,
    });
    expect(first.headers.apikey).toBeUndefined();
    await p.fetchWalletTransfers({ chain: 'arbitrum', address: W, cursor: '{"startBlock":123}' });
    await p.fetchWalletTransfers({ chain: 'polygon', address: W });
    expect(fake.calls.slice(3).map((c) => c.url.searchParams.get('chainid'))).toEqual(['42161', '42161', '42161', '137', '137', '137']);
    expect(fake.calls[3].url.searchParams.get('startblock')).toBe('123');
    expect(EVM_CHAIN_IDS).toEqual({ ethereum: 1, optimism: 10, bsc: 56, polygon: 137, base: 8453, arbitrum: 42161 });
    expect(DEFAULT_END_BLOCK).toBeGreaterThan(99_999_999);
  });

  it('UNIT-SM-ESC-011 Routescan: tanpa kunci (path chainId, tanpa apikey) dan dengan kunci (header apikey, bukan query)', async () => {
    const time = frozenTime();
    const keyless = createFakeEtherscan({});
    const p = createRoutescanProvider({ fetchImpl: keyless.fetchImpl, clock: time.clock, sleep: time.sleep });
    expect(p).toMatchObject({ id: 'routescan', requiresKey: false, configured: true });
    await p.fetchWalletTransfers({ chain: 'base', address: W });
    await p.fetchWalletTransfers({ chain: 'bsc', address: W });
    expect(`${keyless.calls[0].url.origin}${keyless.calls[0].url.pathname}`).toBe('https://api.routescan.io/v2/network/mainnet/evm/8453/etherscan/api');
    expect(keyless.calls[3].url.pathname).toBe('/v2/network/mainnet/evm/56/etherscan/api');
    expect(keyless.calls.every((c) => !c.url.searchParams.has('apikey') && c.headers.apikey === undefined)).toBe(true);
    expect(keyless.calls[0].url.searchParams.has('chainid')).toBe(false);
    expect(p.quota().limit).toBe(9000);

    const keyed = createFakeEtherscan({});
    const k = createRoutescanProvider({ apiKey: KEY, fetchImpl: keyed.fetchImpl, clock: time.clock, sleep: time.sleep });
    await k.fetchWalletTransfers({ chain: 'optimism', address: W });
    expect(keyed.calls[0].url.pathname).toBe('/v2/network/mainnet/evm/10/etherscan/api');
    expect(keyed.calls.every((c) => c.headers.apikey === KEY && !c.url.searchParams.has('apikey'))).toBe(true);
    expect(k.quota().limit).toBe(90_000);
  });

  it('NEG-SM-ESC-006 Etherscan tanpa kunci → NOT_CONFIGURED tanpa jaringan; metode lain NOT_SUPPORTED; adapter tetap valid', async () => {
    const fake = createFakeEtherscan({});
    for (const apiKey of [undefined, null, '', '   ']) {
      const p = createEtherscanProvider({ apiKey, fetchImpl: fake.fetchImpl });
      expect(validateAdapter(p)).toEqual([]);
      expect(p).toMatchObject({ id: 'etherscan', requiresKey: true, configured: false, isSimulated: false });
      await expect(p.fetchWalletTransfers({ chain: 'ethereum', address: W })).rejects.toMatchObject({ code: 'NOT_CONFIGURED', provider: 'etherscan' });
      await expect(p.fetchLabels({ chain: 'ethereum', addresses: [W] })).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('UNIT-SM-ESC-012 validateAdapter lulus; kapabilitas hanya walletTransfers; terms & chain default sesuai paket', () => {
    const adapters = [
      createEtherscanProvider({ apiKey: KEY }), createEtherscanProvider({}),
      createRoutescanProvider({}), createRoutescanProvider({ apiKey: KEY }),
      compat(createFakeEtherscan({})),
    ];
    for (const a of adapters) {
      expect(validateAdapter(a)).toEqual([]);
      expect([...a.capabilities]).toEqual(['walletTransfers']);
      expect(a.isSimulated).toBe(false);
    }
    expect(adapters[0].chains).toEqual(['ethereum', 'arbitrum', 'polygon']);
    expect(ETHERSCAN_DEFAULT_CHAINS).toEqual(['ethereum', 'arbitrum', 'polygon']);
    expect(adapters[0].terms).toEqual(ETHERSCAN_TERMS);
    expect(ETHERSCAN_TERMS).toMatchObject({
      docsUrl: 'https://docs.etherscan.io', attribution: 'Data riwayat transaksi: Etherscan API (Powered by Etherscan)', displayAllowed: true,
    });
    expect(ETHERSCAN_TERMS.notes).toContain('Paket gratis: penggunaan pribadi & riset, 3 panggilan/detik, 100.000/hari, chain terpilih, endpoint komunitas saja.');
    expect(adapters[2].chains).toEqual(['base', 'optimism', 'bsc', 'ethereum', 'arbitrum', 'polygon']);
    expect(ROUTESCAN_DEFAULT_CHAINS).toEqual(adapters[2].chains);
    expect(ROUTESCAN_TERMS.attribution).toBe('Data riwayat transaksi: Routescan');
    expect(ROUTESCAN_TERMS.notes).toMatch(/belum terverifikasi/);
    expect(adapters[0].quota()).toMatchObject({ limit: 90_000, used: 0 });
  });

  it('NEG-SM-ESC-007 konfigurasi rusak ditolak saat konstruksi', () => {
    const base = {
      id: 'uji', displayName: 'Uji', requiresKey: false, chains: ['ethereum'], urlForChain: () => 'https://x.invalid/api',
      fetchImpl: async () => httpResponse(200, NO_TX), ratePerSec: 1, dailyBudget: 10, terms: TERMS,
    };
    expect(() => createEtherscanCompatibleProvider(base)).not.toThrow();
    expect(() => createEtherscanCompatibleProvider({ ...base, keyMode: 'cookie' })).toThrow(TypeError);
    expect(() => createEtherscanCompatibleProvider({ ...base, chains: ['solana'] })).toThrow(TypeError);
    expect(() => createEtherscanCompatibleProvider({ ...base, apiKey: KEY })).toThrow(TypeError);
    expect(() => createEtherscanCompatibleProvider({ ...base, urlForChain: () => 'http://x.invalid/api' })).toThrow(TypeError);
    expect(() => createEtherscanCompatibleProvider({ ...base, pageSize: 0 })).toThrow(RangeError);
    expect(() => createEtherscanCompatibleProvider({ ...base, ratePerSec: 0 })).toThrow(RangeError);
    expect(() => createEtherscanCompatibleProvider({ ...base, id: 'Bukan Id' })).toThrow(TypeError);
  });
});

describe('etherscanCompatible — keamanan kunci API', () => {
  it('SEC-SM-ESC-001 kunci API tidak pernah muncul di pesan error, toJSON, hasil, maupun diagnostics (mode query & header)', async () => {
    const time = frozenTime();
    const failures = [
      () => { throw new TypeError(`fetch failed for https://api.etherscan.io/v2/api?chainid=1&apikey=${KEY}`); },
      () => httpResponse(200, { status: '0', message: 'NOTOK', result: `Invalid API Key ${KEY}` }),
      () => httpResponse(200, { status: '0', message: 'NOTOK', result: `Free API access is not supported for this chain (key ${KEY})` }),
      () => httpResponse(200, { status: '0', message: 'NOTOK', result: `Error! something odd ?apikey=${KEY}&x=1` }),
      // Kunci tepat di batas potong 160 karakter: tidak boleh tersisa sebagian.
      () => httpResponse(200, { status: '0', message: 'NOTOK', result: `Error! ${'x'.repeat(150)}${KEY} ekor` }),
      () => httpResponse(500, `boom ${KEY}`),
      () => httpResponse(429, ''),
      () => { throw Object.assign(new Error(`aborted ${KEY}`), { name: 'AbortError' }); },
    ];
    for (const make of [
      (fetchImpl) => createEtherscanProvider({ apiKey: KEY, fetchImpl, clock: time.clock, sleep: time.sleep }),
      (fetchImpl) => createRoutescanProvider({ apiKey: KEY, fetchImpl, clock: time.clock, sleep: time.sleep }),
    ]) {
      for (const failure of failures) {
        const p = make(async () => failure());
        const err = await p.fetchWalletTransfers({ chain: 'ethereum', address: W }).catch((e) => e);
        expect(err).toBeInstanceOf(ProviderError);
        expect(err.message).not.toContain(KEY.slice(0, 4));
        expect(JSON.stringify(err.toJSON())).not.toContain(KEY);
        expect(String(err.stack)).not.toContain(KEY);
      }
      // Sukses dengan pesan provider yang memantulkan kunci → warnings tersamar; URL di diagnostics tanpa kunci.
      const { data } = swapData();
      const fake = createFakeEtherscan({}, {
        respond: (u) => {
          const rows = data[u.searchParams.get('action')];
          return { status: '1', message: `OK-Missing/Invalid API Key ${KEY}, rate limit of 1/5sec applied`, result: rows };
        },
      });
      const res = await make(fake.fetchImpl).fetchWalletTransfers({ chain: 'ethereum', address: W });
      expect(res.transfers).toHaveLength(4);
      expect(JSON.stringify(res)).not.toContain(KEY);
      expect(res.diagnostics.warnings[0]).toMatch(/pesan provider/);
      expect(res.diagnostics.requests.every((u) => !u.includes('apikey'))).toBe(true);
    }
  });
});
