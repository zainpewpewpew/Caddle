import { describe, expect, it } from 'vitest';
import { classifyWalletTransfers } from '../../../backend/smartmoney/classify.js';
import { NATIVE_TOKEN, explorerTxUrl, tokenKey } from '../../../backend/smartmoney/contracts.js';
import { createNativePriceResolver, enrichNativeUsd } from '../../../backend/smartmoney/nativePrices.js';
import { normalizeTransfers } from '../../../backend/smartmoney/normalize.js';
import { computeWalletPnl } from '../../../backend/smartmoney/pnl.js';
import { createEtherscanProvider } from '../../../backend/smartmoney/providers/etherscan.js';
import { createBinanceRestClient } from '../../../backend/ingestion/binance/restClient.js';
import {
  DAY, HOUR, NOW, addr, createFakeEtherscan, frozenTime, internalRow, tokenTxRow, txHash, txListRow, units,
} from './helpers/etherscanFixtures.js';

// Uji bergaya integrasi (tanpa jaringan) untuk jalur EVM gratis:
//   adapter Etherscan (fetch palsu) → normalizeTransfers → enrichNativeUsd (klien REST Binance ASLI dengan fetch
//   palsu /fapi/v1/klines) → classifyWalletTransfers → computeWalletPnl.
// Baris Etherscan BERBENTUK DARI DOKUMENTASI, BELUM DIREKAM LIVE (lihat helpers/etherscanFixtures.js).
// Skenario: wallet membeli PEPE dengan 0,5 ETH lewat router (ETH keluar di txlist, PEPE masuk di tokentx), lalu
// menjual 1000 PEPE ke ETH (PEPE keluar di tokentx, 0,6 ETH masuk sebagai transfer internal dari router).

const W = addr('1'); // wallet yang dilacak
const ROUTER = addr('2'); // router DEX — tanpa label: klasifikasi murni dari struktur tx
const PAIR = addr('3'); // pool PEPE/WETH
const PEPE = addr('4');
const SPAMMER = addr('8');
const FAKE_PEPE = addr('9'); // kontrak lain yang juga bersimbol "PEPE"
const KEY = 'KUNCIUJIPIPELINE42';
const T_BUY = Date.UTC(2026, 9, 20, 10, 15);
const T_SELL = Date.UTC(2026, 9, 22, 14, 40);
const H_BUY = txHash(0xb1);
const H_SELL = txHash(0x5e11);
const HOURLY_ETH = 'binance:ETHUSDT:1h (perkiraan per jam)';

// Close candle 1 jam ETHUSDT: hanya candle TERAKHIR yang tutup sebelum tiap tx yang bernilai wajar. Candle lain —
// termasuk candle yang MEMUAT waktu tx (close-nya terjadi setelah tx) — bernilai 9999 sebagai jebakan look-ahead.
const CLOSES = new Map([
  [Date.UTC(2026, 9, 20, 9), 3000], // beli 10:15 → candle 09:00–09:59
  [Date.UTC(2026, 9, 22, 13), 3500], // jual 14:40 → candle 13:00–13:59
]);
const TRAP = 9999;

function swapRows() {
  return {
    txlist: [
      txListRow({
        block: 100, at: T_BUY, hash: H_BUY, from: W, to: ROUTER, value: units('0.5'), methodId: '0x7ff36ab5',
        functionName: 'swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline)',
      }),
      txListRow({
        block: 200, at: T_SELL, hash: H_SELL, from: W, to: ROUTER, value: '0', methodId: '0x18cbafe5',
        functionName: 'swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
      }),
    ],
    tokentx: [
      tokenTxRow({ block: 100, at: T_BUY, hash: H_BUY, from: PAIR, to: W, contract: PEPE, value: units('1000') }),
      tokenTxRow({ block: 200, at: T_SELL, hash: H_SELL, from: W, to: PAIR, contract: PEPE, value: units('1000') }),
    ],
    txlistinternal: [
      internalRow({ block: 200, at: T_SELL, hash: H_SELL, from: ROUTER, to: W, value: units('0.6') }),
    ],
  };
}

function etherscanFor(data, time) {
  const fake = createFakeEtherscan(data, { clock: time.clock });
  return createEtherscanProvider({
    apiKey: KEY, chains: ['ethereum'], fetchImpl: fake.fetchImpl, clock: time.clock, sleep: time.sleep,
  });
}

/** Klien REST Binance asli + fetch palsu /fapi/v1/klines (status ≠ 200 → galat HTTP berbentuk Binance). */
function priceLayer(time, { status = 200 } = {}) {
  const requests = [];
  const fetch = async (href) => {
    const u = new URL(href);
    requests.push(u);
    if (status !== 200) {
      return new Response(JSON.stringify({
        code: 0, msg: "Service unavailable from a restricted location according to 'b. Eligibility' in https://www.binance.com/en/terms.",
      }), { status });
    }
    const rows = [];
    for (let open = Number(u.searchParams.get('startTime')); open <= Number(u.searchParams.get('endTime')) && open < time.clock(); open += HOUR) {
      const p = String(CLOSES.get(open) ?? TRAP);
      rows.push([open, p, p, p, p, '10.0', open + HOUR - 1, '30000.0', 5, '4.0', '12000.0', '0']);
    }
    return new Response(JSON.stringify(rows.slice(0, Number(u.searchParams.get('limit')))), { status: 200 });
  };
  const rest = createBinanceRestClient({ fetch, clock: time.clock, sleep: async () => {}, random: () => 0.5 });
  return { resolver: createNativePriceResolver({ getKlines: rest.getKlines, clock: time.clock }), requests };
}

async function pipeline(rawTransfers, resolver, now) {
  const normalized = normalizeTransfers(rawTransfers);
  const priced = await enrichNativeUsd(normalized.transfers, resolver);
  const activities = classifyWalletTransfers(priced, W);
  return { normalized, priced, activities, pnl: computeWalletPnl(activities, { now }) };
}

describe('jalur EVM gratis: Etherscan → normalisasi → harga native → klasifikasi → PnL', () => {
  it('UNIT-SM-PIPE-001 ETH→PEPE lalu PEPE→ETH via router: SWAP_BUY & SWAP_SELL bernilai USD → satu trade tertutup', async () => {
    const time = frozenTime(NOW);
    const batch = await etherscanFor(swapRows(), time).fetchWalletTransfers({ chain: 'ethereum', address: W, since: T_BUY - DAY });
    expect(batch.nextCursor).toBeNull();
    // ETH keluar + PEPE masuk (beli); PEPE keluar + ETH internal masuk (jual). txlist jual bernilai 0 → bukan transfer.
    expect(batch.transfers.map((t) => [t.txHash, t.token.symbol, t.from, t.to, t.amount])).toEqual([
      [H_BUY, 'PEPE', PAIR, W, 1000],
      [H_BUY, 'ETH', W, ROUTER, 0.5],
      [H_SELL, 'PEPE', W, PAIR, 1000],
      [H_SELL, 'ETH', ROUTER, W, 0.6],
    ]);
    expect(batch.transfers.every((t) => t.usdValue === null && t.provider === 'etherscan' && t.isSimulated === false)).toBe(true);

    const { resolver, requests } = priceLayer(time);
    const { normalized, priced, activities, pnl } = await pipeline(batch.transfers, resolver, NOW);
    expect(normalized.rejected).toEqual([]);
    expect(normalized.duplicates).toBe(0);

    // Hanya kaki ETH yang diberi harga: close candle jam SEBELUMNYA (3000 / 3500), bukan jebakan 9999.
    expect(priced.filter((t) => t.token.address === NATIVE_TOKEN).map((t) => [t.txHash, t.usdValue, t.priceSource])).toEqual([
      [H_BUY, 1500, HOURLY_ETH],
      [H_SELL, expect.closeTo(2100, 6), HOURLY_ETH],
    ]);
    expect(priced.filter((t) => t.token.address === PEPE).every((t) => t.usdValue === null)).toBe(true);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((u) => u.pathname === '/fapi/v1/klines' && u.searchParams.get('symbol') === 'ETHUSDT')).toBe(true);

    // Kaki ETH (aset quote) tidak menjadi baris; nilainya menjadi usdValue kaki PEPE.
    const common = {
      wallet: W, token: { address: PEPE, symbol: 'PEPE', name: 'Pepe', decimals: 18 }, amount: 1000, counterparty: PAIR,
      confidence: 'MEDIUM', provider: 'etherscan', isSimulated: false,
    };
    expect(activities).toEqual([
      expect.objectContaining({
        ...common, id: `ethereum:${H_BUY}:${W}:${PEPE}`, type: 'SWAP_BUY', direction: 'IN', usdValue: 1500, blockTime: T_BUY,
        explorerUrl: explorerTxUrl('ethereum', H_BUY), reason: expect.stringContaining('beli PEPE'),
      }),
      expect.objectContaining({
        ...common, id: `ethereum:${H_SELL}:${W}:${PEPE}`, type: 'SWAP_SELL', direction: 'OUT', usdValue: expect.closeTo(2100, 6),
        blockTime: T_SELL, explorerUrl: explorerTxUrl('ethereum', H_SELL), reason: expect.stringContaining('jual PEPE'),
      }),
    ]);

    expect(pnl.closedTrades).toEqual([{
      tokenKey: tokenKey('ethereum', PEPE), openAt: T_BUY, closeAt: T_SELL, qty: 1000, costUsd: 1500,
      proceedsUsd: expect.closeTo(2100, 6), pnlUsd: expect.closeTo(600, 6), returnPct: expect.closeTo(40, 6), holdMs: T_SELL - T_BUY,
    }]);
    expect(pnl.summary).toMatchObject({
      realizedPnlUsd: expect.closeTo(600, 6), totalCostUsd: 1500, closedTradesCount: 1, tokensTraded: 1,
      completenessRatio: 1, completeness: 'COMPLETE',
    });
  });

  it('UNIT-SM-PIPE-002 sinkron ulang dari resumeCursor (blok terakhir tumpang-tindih) → duplikat dibuang, hasil identik', async () => {
    const time = frozenTime(NOW);
    const provider = etherscanFor(swapRows(), time);
    const first = await provider.fetchWalletTransfers({ chain: 'ethereum', address: W });
    expect(JSON.parse(first.resumeCursor)).toEqual({ startBlock: 200 });
    time.advance(HOUR);
    const again = await provider.fetchWalletTransfers({ chain: 'ethereum', address: W, cursor: first.resumeCursor });
    expect(again.transfers.map((t) => t.txHash)).toEqual([H_SELL, H_SELL]);

    const { resolver } = priceLayer(time);
    const once = await pipeline(first.transfers, resolver, time.clock());
    const merged = await pipeline([...first.transfers, ...again.transfers], resolver, time.clock());
    const reversed = await pipeline([...again.transfers, ...first.transfers], resolver, time.clock());
    expect(merged.normalized.duplicates).toBe(2); // logIndex sintetis stabil antar-panggilan
    expect(merged.activities).toEqual(once.activities);
    expect(merged.pnl).toEqual(once.pnl);
    expect(reversed.activities).toEqual(once.activities);
    expect(reversed.pnl).toEqual(once.pnl);
    expect(once.pnl.closedTrades).toHaveLength(1);
  });

  it('EDGE-SM-PIPE-001 kaki ETH internal terindeks terlambat: tx jual ditahan (tidak menjadi TRANSFER_OUT), lalu lengkap dari resumeCursor', async () => {
    const time = frozenTime(T_SELL + 30_000);
    const data = swapRows();
    const lateInternal = data.txlistinternal.splice(0); // belum terindeks saat sinkron pertama
    const provider = etherscanFor(data, time);
    const early = await provider.fetchWalletTransfers({ chain: 'ethereum', address: W });
    expect(early.transfers.map((t) => t.txHash)).toEqual([H_BUY, H_BUY]);
    expect(early.diagnostics.deferred).toBe(2); // tokentx + txlist jual (< 2 menit)
    expect(early.nextCursor).toBeNull();
    expect(JSON.parse(early.resumeCursor)).toEqual({ startBlock: 200 });

    const { resolver } = priceLayer(time);
    const partial = await pipeline(early.transfers, resolver, time.clock());
    // Tanpa penahanan, PEPE keluar tanpa ETH masuk akan tersimpan permanen sebagai TRANSFER_OUT (INSERT OR IGNORE).
    expect(partial.activities.map((a) => [a.type, a.usdValue])).toEqual([['SWAP_BUY', 1500]]);

    data.txlistinternal.push(...lateInternal);
    time.advance(10 * 60_000);
    const late = await provider.fetchWalletTransfers({ chain: 'ethereum', address: W, cursor: early.resumeCursor });
    expect(late.transfers.map((t) => [t.txHash, t.token.symbol])).toEqual([[H_SELL, 'PEPE'], [H_SELL, 'ETH']]);
    const full = await pipeline([...early.transfers, ...late.transfers], resolver, time.clock());
    expect(full.activities.map((a) => [a.type, a.usdValue])).toEqual([['SWAP_BUY', 1500], ['SWAP_SELL', expect.closeTo(2100, 6)]]);
    expect(full.pnl.closedTrades).toEqual([expect.objectContaining({ costUsd: 1500, pnlUsd: expect.closeTo(600, 6) })]);
  });

  it('NEG-SM-PIPE-001 sumber harga gagal (HTTP 451 geo-block): swap tetap terdeteksi, USD null (bukan 0), PnL ditandai tidak lengkap', async () => {
    const time = frozenTime(NOW);
    const batch = await etherscanFor(swapRows(), time).fetchWalletTransfers({ chain: 'ethereum', address: W });
    const { resolver } = priceLayer(time, { status: 451 });
    const { priced, activities, pnl } = await pipeline(batch.transfers, resolver, NOW);
    expect(priced.every((t) => t.usdValue === null && t.priceSource === null)).toBe(true);
    expect(activities.map((a) => [a.type, a.amount, a.usdValue])).toEqual([['SWAP_BUY', 1000, null], ['SWAP_SELL', 1000, null]]);
    expect(pnl.closedTrades).toEqual([]);
    expect(pnl.summary).toMatchObject({ totalCostUsd: 0, closedTradesCount: 0, completenessRatio: 0, completeness: 'UNKNOWN' });
    expect(pnl.summary.notes.some((n) => n.includes('tidak lengkap'))).toBe(true);
    expect(pnl.positions).toEqual([expect.objectContaining({ tokenKey: tokenKey('ethereum', PEPE), completeness: 'UNKNOWN', unknownCostSoldQty: 1000 })]);
    expect(resolver.errors()).toEqual([expect.objectContaining({
      symbol: 'ETHUSDT', invalidSymbol: false, message: expect.stringContaining('HTTP 451'),
    })]);
  });

  it('UNIT-SM-PIPE-003 token lain bersimbol sama (kiriman alamat lain) bukan pembelian dan tidak tercampur posisi PEPE asli', async () => {
    const time = frozenTime(NOW);
    const data = swapRows();
    data.tokentx.push(tokenTxRow({
      block: 150, at: T_BUY + HOUR, hash: txHash(0x5a), from: SPAMMER, to: W, contract: FAKE_PEPE, value: units('1000000'),
      methodId: '0x1e89d545', functionName: 'multiTransfer(address[] recipients, uint256[] amounts)',
    }));
    const batch = await etherscanFor(data, time).fetchWalletTransfers({ chain: 'ethereum', address: W });
    const { resolver } = priceLayer(time);
    const { activities, pnl } = await pipeline(batch.transfers, resolver, NOW);
    expect(activities.map((a) => [a.type, a.token.address, a.token.symbol, a.usdValue])).toEqual([
      ['SWAP_BUY', PEPE, 'PEPE', 1500],
      ['TRANSFER_IN', FAKE_PEPE, 'PEPE', null],
      ['SWAP_SELL', PEPE, 'PEPE', expect.closeTo(2100, 6)],
    ]);
    expect(pnl.closedTrades).toEqual([expect.objectContaining({ tokenKey: tokenKey('ethereum', PEPE), pnlUsd: expect.closeTo(600, 6) })]);
    const fake = pnl.positions.find((p) => p.tokenKey === tokenKey('ethereum', FAKE_PEPE));
    expect(fake).toMatchObject({ qtyHeld: 1_000_000, knownCostQty: 0, unknownCostQty: 1_000_000, buys: 0, completeness: 'UNKNOWN' });
    expect(pnl.summary).toMatchObject({ closedTradesCount: 1, tokensTraded: 1, completeness: 'PARTIAL' });
  });
});
