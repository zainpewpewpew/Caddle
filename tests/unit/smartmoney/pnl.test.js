import { describe, expect, it } from 'vitest';
import { tokenKey } from '../../../backend/smartmoney/contracts.js';
import { ROUND_TRIP_DUST_RATIO, STALE_PRICE_MS, computeWalletPnl } from '../../../backend/smartmoney/pnl.js';

const addr = (c) => `0x${c.repeat(40)}`;
const W = addr('1');
const PEPE = addr('4');
const FAKE_PEPE = addr('5');
const FOO = addr('6');
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const SYMBOLS = { [PEPE]: 'PEPE', [FAKE_PEPE]: 'PEPE', [FOO]: 'FOO', [WETH]: 'WETH' };
const H = 3_600_000;
const T0 = 1_767_225_600_000;
const NOW = T0 + 100 * H;
const K_PEPE = tokenKey('ethereum', PEPE);
const K_FOO = tokenKey('ethereum', FOO);
const K_FAKE = tokenKey('ethereum', FAKE_PEPE);

let seq = 0;
/** Activity minimal sesuai kontrak (§1). `n` membedakan tx agar id unik. */
function act(type, token, amount, usdValue, time, { n = seq++, chain = 'ethereum' } = {}) {
  const txHash = `0x${String(n).padStart(64, '0')}`;
  const direction = ['SWAP_BUY', 'TRANSFER_IN', 'CEX_WITHDRAWAL', 'BRIDGE_IN', 'AIRDROP', 'MINT', 'LP_REMOVE'].includes(type) ? 'IN' : 'OUT';
  return {
    id: `${chain}:${txHash}:${W}:${token}`, chain, txHash, blockTime: time, wallet: W,
    token: { address: token, symbol: SYMBOLS[token] ?? 'TKN', name: null, decimals: 18 },
    type, direction, amount, usdValue, counterparty: null, counterpartyLabel: null, confidence: 'MEDIUM',
    reason: 'uji', provider: 'fixture', isSimulated: true, explorerUrl: null,
  };
}
const price = (priceUsd, at = NOW - H) => ({ priceUsd, at, source: 'uji' });
const pos = (res, key) => res.positions.find((p) => p.tokenKey === key);

describe('pnl.computeWalletPnl — FIFO', () => {
  it('UNIT-SM-PNL-001 round trip untung: realized, closedTrade, holdMs, returnPct (persen), COMPLETE', () => {
    const res = computeWalletPnl([
      act('SWAP_BUY', PEPE, 1000, 100, T0),
      act('SWAP_SELL', PEPE, 1000, 150, T0 + H),
    ], { prices: new Map(), now: NOW });
    const p = pos(res, K_PEPE);
    expect(p).toMatchObject({
      qtyHeld: 0, knownCostQty: 0, costBasisUsd: 0, unknownCostQty: 0, realizedPnlUsd: 50, unrealizedPnlUsd: 0,
      buys: 1, sells: 1, firstBuyAt: T0, lastActivityAt: T0 + H, completeness: 'COMPLETE', stalePrice: false,
    });
    expect(res.closedTrades).toEqual([{
      tokenKey: K_PEPE, openAt: T0, closeAt: T0 + H, qty: 1000, costUsd: 100, proceedsUsd: 150, pnlUsd: 50, returnPct: 50, holdMs: H,
    }]);
    expect(res.summary).toMatchObject({
      realizedPnlUsd: 50, unrealizedPnlUsd: 0, totalCostUsd: 100, airdropRealizedUsd: 0, tradesCount: 2,
      closedTradesCount: 1, tokensTraded: 1, completenessRatio: 1, completeness: 'COMPLETE',
    });
  });

  it('UNIT-SM-PNL-002 round trip rugi', () => {
    const res = computeWalletPnl([act('SWAP_BUY', PEPE, 100, 200, T0), act('SWAP_SELL', PEPE, 100, 50, T0 + 2 * H)], { now: NOW });
    expect(res.summary.realizedPnlUsd).toBe(-150);
    expect(res.closedTrades[0]).toMatchObject({ pnlUsd: -150, returnPct: -75, holdMs: 2 * H });
  });

  it('UNIT-SM-PNL-003 jual parsial melintasi beberapa lot (FIFO) + unrealized sisa lot', () => {
    const acts = [
      act('SWAP_BUY', PEPE, 100, 100, T0),
      act('SWAP_BUY', PEPE, 100, 200, T0 + H),
      act('SWAP_SELL', PEPE, 150, 450, T0 + 2 * H),
    ];
    const res = computeWalletPnl(acts, { prices: new Map([[K_PEPE, price(4)]]), now: NOW });
    expect(res.closedTrades.map((t) => [t.openAt, t.qty, t.costUsd, t.proceedsUsd, t.pnlUsd])).toEqual([
      [T0, 100, 100, 300, 200],
      [T0 + H, 50, 100, 150, 50],
    ]);
    const p = pos(res, K_PEPE);
    expect(p.realizedPnlUsd).toBe(250);
    expect(p.qtyHeld).toBe(50);
    expect(p.costBasisUsd).toBe(100);
    expect(p.unrealizedPnlUsd).toBe(100);
    expect(p.priceUsd).toBe(4);
    expect(res.summary.unrealizedPnlUsd).toBe(100);

    const after = computeWalletPnl([...acts, act('SWAP_SELL', PEPE, 50, 50, T0 + 3 * H)], { now: NOW });
    expect(pos(after, K_PEPE).realizedPnlUsd).toBe(200);
    expect(after.closedTrades).toHaveLength(3);
    expect(pos(after, K_PEPE).qtyHeld).toBe(0);
  });

  it('UNIT-SM-PNL-004 PnL tidak lengkap: transfer masuk lalu dijual → bukan profit, completeness UNKNOWN/PARTIAL', () => {
    const only = computeWalletPnl([act('TRANSFER_IN', PEPE, 100, null, T0), act('SWAP_SELL', PEPE, 100, 500, T0 + H)], { now: NOW });
    expect(pos(only, K_PEPE)).toMatchObject({ realizedPnlUsd: 0, unknownCostSoldQty: 100, completeness: 'UNKNOWN' });
    expect(only.closedTrades).toEqual([]);
    expect(only.summary).toMatchObject({ realizedPnlUsd: 0, completenessRatio: 0, completeness: 'UNKNOWN' });
    expect(pos(only, K_PEPE).notes.join(' ')).toMatch(/biaya tidak diketahui/);

    const mixed = computeWalletPnl([
      act('SWAP_BUY', PEPE, 100, 100, T0),
      act('CEX_WITHDRAWAL', PEPE, 100, null, T0 + H),
      act('SWAP_SELL', PEPE, 200, 400, T0 + 2 * H),
    ], { now: NOW });
    expect(pos(mixed, K_PEPE)).toMatchObject({ realizedPnlUsd: 100, unknownCostSoldQty: 100, completeness: 'PARTIAL' });
    expect(mixed.summary.completenessRatio).toBe(0.5);
    expect(mixed.summary.completeness).toBe('PARTIAL');
    expect(mixed.summary.notes.join(' ')).toMatch(/50% nilai jual \(USD\)/);
  });

  it('UNIT-SM-PNL-005 airdrop dijual: dilaporkan terpisah (airdropRealizedUsd), bukan realized trading', () => {
    const res = computeWalletPnl([
      act('AIRDROP', FOO, 1000, null, T0),
      act('MINT', FOO, 500, null, T0 + 1),
      act('SWAP_SELL', FOO, 1500, 300, T0 + H),
    ], { now: NOW });
    const p = pos(res, K_FOO);
    expect(p.realizedPnlUsd).toBe(0);
    expect(p.airdropRealizedUsd).toBe(300);
    expect(p.unknownCostSoldQty).toBe(1500);
    expect(res.closedTrades).toEqual([]);
    expect(res.summary).toMatchObject({ realizedPnlUsd: 0, airdropRealizedUsd: 300, closedTradesCount: 0 });
    expect(res.summary.notes.join(' ')).toMatch(/airdrop/);
  });

  it('UNIT-SM-PNL-006 histori terpotong: jual melebihi saldo terlihat → unknownCostSoldQty, PARTIAL + catatan', () => {
    const res = computeWalletPnl([act('SWAP_BUY', PEPE, 100, 100, T0), act('SWAP_SELL', PEPE, 150, 300, T0 + H)], { now: NOW });
    const p = pos(res, K_PEPE);
    expect(p.realizedPnlUsd).toBe(100);
    expect(p.unknownCostSoldQty).toBe(50);
    expect(p.qtyHeld).toBe(0);
    expect(p.completeness).toBe('PARTIAL');
    expect(p.notes.join(' ')).toMatch(/histori kemungkinan terpotong/);
    expect(res.summary.completenessRatio).toBeCloseTo(100 / 150, 12);
  });

  it('UNIT-SM-PNL-007 tanpa harga: unrealized null (bukan 0) di posisi & ringkasan', () => {
    const res = computeWalletPnl([act('SWAP_BUY', PEPE, 100, 100, T0)], { prices: new Map(), now: NOW });
    expect(pos(res, K_PEPE)).toMatchObject({ unrealizedPnlUsd: null, priceUsd: null, priceAt: null, qtyHeld: 100, costBasisUsd: 100 });
    expect(res.summary.unrealizedPnlUsd).toBeNull();
    expect(res.summary.notes.join(' ')).toMatch(/Harga tidak tersedia/);
  });

  it('UNIT-SM-PNL-008 harga basi (> 24 jam) ditandai stalePrice; harga setelah `now` diabaikan (tanpa look-ahead)', () => {
    const acts = [act('SWAP_BUY', PEPE, 100, 100, T0)];
    const stale = computeWalletPnl(acts, { prices: new Map([[K_PEPE, price(2, NOW - STALE_PRICE_MS - 1)]]), now: NOW });
    expect(pos(stale, K_PEPE)).toMatchObject({ stalePrice: true, unrealizedPnlUsd: 100, priceAt: NOW - STALE_PRICE_MS - 1 });
    const fresh = computeWalletPnl(acts, { prices: new Map([[K_PEPE, price(2, NOW - STALE_PRICE_MS)]]), now: NOW });
    expect(pos(fresh, K_PEPE).stalePrice).toBe(false);
    const future = computeWalletPnl(acts, { prices: new Map([[K_PEPE, price(9, NOW + 1)]]), now: NOW });
    expect(pos(future, K_PEPE)).toMatchObject({ priceUsd: null, unrealizedPnlUsd: null });
    expect(pos(future, K_PEPE).notes.join(' ')).toMatch(/look-ahead/);
  });

  it('UNIT-SM-PNL-009 banyak token (termasuk simbol sama beda kontrak) dihitung terpisah', () => {
    const res = computeWalletPnl([
      act('SWAP_BUY', PEPE, 100, 100, T0),
      act('SWAP_BUY', FAKE_PEPE, 100, 10, T0),
      act('SWAP_BUY', FOO, 10, 50, T0 + 1),
      act('SWAP_SELL', PEPE, 100, 120, T0 + H),
      act('SWAP_SELL', FAKE_PEPE, 100, 1, T0 + H),
    ], { prices: new Map([[K_FOO, price(6)]]), now: NOW });
    expect(res.positions.map((p) => p.tokenKey)).toEqual([K_PEPE, K_FAKE, K_FOO].sort());
    expect(pos(res, K_PEPE).realizedPnlUsd).toBe(20);
    expect(pos(res, K_FAKE).realizedPnlUsd).toBe(-9);
    expect(pos(res, K_FOO).unrealizedPnlUsd).toBe(10);
    expect(res.summary).toMatchObject({
      realizedPnlUsd: 11, unrealizedPnlUsd: 10, totalCostUsd: 160, tradesCount: 5, closedTradesCount: 2, tokensTraded: 3,
    });
  });

  it('UNIT-SM-PNL-010 aktivitas duplikat (id sama) hanya dihitung sekali', () => {
    const buy = act('SWAP_BUY', PEPE, 100, 100, T0);
    const sell = act('SWAP_SELL', PEPE, 100, 150, T0 + H);
    const res = computeWalletPnl([buy, sell, { ...buy }, { ...sell, usdValue: 9999 }], { now: NOW });
    expect(res.summary.realizedPnlUsd).toBe(50);
    expect(res.summary.tradesCount).toBe(2);
    expect(res.closedTrades).toHaveLength(1);
    expect(res.summary.notes.join(' ')).toMatch(/2 aktivitas duplikat/);
  });

  it('UNIT-SM-PNL-011 data terlambat: urutan masukan tidak memengaruhi hasil (blockTime lalu id)', () => {
    const acts = [
      act('SWAP_BUY', PEPE, 100, 100, T0, { n: 10 }),
      act('SWAP_BUY', PEPE, 100, 300, T0, { n: 11 }), // blockTime sama → urutan id
      act('SWAP_SELL', PEPE, 100, 200, T0 + H, { n: 12 }),
      act('CEX_DEPOSIT', PEPE, 50, null, T0 + 2 * H, { n: 13 }),
    ];
    const ordered = computeWalletPnl(acts, { now: NOW });
    const shuffled = computeWalletPnl([acts[3], acts[1], acts[2], acts[0]], { now: NOW });
    expect(shuffled).toEqual(ordered);
    expect(ordered.closedTrades[0].costUsd).toBe(100); // lot n=10 dikonsumsi lebih dulu
    expect(pos(ordered, K_PEPE)).toMatchObject({ qtyHeld: 50, costBasisUsd: 150, movedOutQty: 50 });
  });

  it('UNIT-SM-PNL-012 MOVE_OUT (deposit exchange, transfer keluar) mengonsumsi lot tanpa realisasi PnL', () => {
    const res = computeWalletPnl([
      act('SWAP_BUY', PEPE, 100, 100, T0),
      act('CEX_DEPOSIT', PEPE, 60, null, T0 + H),
      act('SWAP_SELL', PEPE, 40, 80, T0 + 2 * H),
      act('TRANSFER_OUT', PEPE, 10, null, T0 + 3 * H),
    ], { now: NOW });
    const p = pos(res, K_PEPE);
    expect(p).toMatchObject({ realizedPnlUsd: 40, movedOutQty: 70, qtyHeld: 0, completeness: 'COMPLETE' });
    expect(p.notes.join(' ')).toMatch(/dipindahkan keluar melebihi saldo/);
    expect(res.summary.completenessRatio).toBe(1);
  });

  it('UNIT-SM-PNL-013 beli tanpa usdValue → lot berbiaya tidak diketahui; jual tanpa usdValue → hasil tidak diketahui', () => {
    const noCost = computeWalletPnl([act('SWAP_BUY', PEPE, 100, null, T0), act('SWAP_SELL', PEPE, 100, 50, T0 + H)], { now: NOW });
    expect(pos(noCost, K_PEPE)).toMatchObject({ realizedPnlUsd: 0, unknownCostSoldQty: 100, completeness: 'UNKNOWN' });
    expect(noCost.summary.totalCostUsd).toBe(0);
    const noProceeds = computeWalletPnl([act('SWAP_BUY', PEPE, 100, 100, T0), act('SWAP_SELL', PEPE, 100, null, T0 + H)], { now: NOW });
    expect(pos(noProceeds, K_PEPE)).toMatchObject({ realizedPnlUsd: 0, unknownProceedsSoldQty: 100, completeness: 'UNKNOWN' });
    expect(noProceeds.summary.completenessRatio).toBe(0);
    expect(noProceeds.closedTrades).toEqual([]);
  });

  it('UNIT-SM-PNL-014 aset quote tidak menjadi posisi; UNKNOWN menandai posisi PARTIAL', () => {
    const res = computeWalletPnl([
      act('SWAP_BUY', WETH, 1, 3000, T0),
      act('SWAP_BUY', PEPE, 100, 100, T0),
      act('UNKNOWN', PEPE, 5, null, T0 + H),
    ], { prices: new Map([[K_PEPE, price(1)]]), now: NOW });
    expect(res.positions.map((p) => p.tokenKey)).toEqual([K_PEPE]);
    expect(pos(res, K_PEPE)).toMatchObject({ qtyHeld: 100, completeness: 'PARTIAL' });
    expect(res.summary.totalCostUsd).toBe(100);
  });

  it('UNIT-SM-PNL-015 saldo dari transfer masuk yang masih dipegang: unrealized hanya dari lot berbiaya diketahui', () => {
    const res = computeWalletPnl([
      act('SWAP_BUY', PEPE, 100, 100, T0),
      act('BRIDGE_IN', PEPE, 100, null, T0 + 1),
    ], { prices: new Map([[K_PEPE, price(3)]]), now: NOW });
    expect(pos(res, K_PEPE)).toMatchObject({
      qtyHeld: 200, knownCostQty: 100, unknownCostQty: 100, unrealizedPnlUsd: 200, completeness: 'PARTIAL',
    });
  });

  it('UNIT-SM-PNL-016 toleransi floating-point: 0.1 + 0.2 dibeli lalu 0.3 dijual tidak menyisakan lot hantu', () => {
    const res = computeWalletPnl([
      act('SWAP_BUY', PEPE, 0.1, 1, T0),
      act('SWAP_BUY', PEPE, 0.2, 2, T0 + 1),
      act('SWAP_SELL', PEPE, 0.3, 6, T0 + 2),
    ], { now: NOW });
    const p = pos(res, K_PEPE);
    expect(p.qtyHeld).toBeLessThan(1e-12);
    expect(p.unknownCostSoldQty).toBe(0);
    expect(p.unrealizedPnlUsd).toBe(0);
    expect(p.completeness).toBe('COMPLETE');
    expect(p.realizedPnlUsd).toBeCloseTo(3, 9);
  });

  it('UNIT-SM-PNL-017 masukan kosong → ringkasan UNKNOWN; `now` wajib', () => {
    const res = computeWalletPnl([], { now: NOW });
    expect(res.positions).toEqual([]);
    expect(res.summary).toMatchObject({ realizedPnlUsd: 0, unrealizedPnlUsd: 0, completenessRatio: 1, completeness: 'UNKNOWN' });
    expect(computeWalletPnl(undefined, { now: NOW }).positions).toEqual([]);
    expect(() => computeWalletPnl([], {})).toThrow(/now/);
  });

  it('UNIT-SM-PNL-018 masukan tidak dimutasi', () => {
    const acts = [act('SWAP_BUY', PEPE, 100, 100, T0), act('SWAP_SELL', PEPE, 60, 90, T0 + H)];
    const snapshot = structuredClone(acts);
    computeWalletPnl(acts, { now: NOW });
    expect(acts).toEqual(snapshot);
  });
});

describe('pnl.computeWalletPnl — round trip tingkat posisi, kelengkapan USD, urutan dalam detik yang sama', () => {
  const D = 24 * H;
  const MEME = addr('7');
  const BIG = addr('8');
  const K_MEME = tokenKey('ethereum', MEME);

  it('UNIT-SM-PNL-019 potongan lot FIFO ≠ trade: 10 beli kecil + 1 jual = 1 round trip; 1 beli + 10 jual parsial = 1 round trip', () => {
    const scaleIn = [];
    for (let i = 0; i < 10; i += 1) scaleIn.push(act('SWAP_BUY', PEPE, 100, 100, T0 + i * 60_000));
    scaleIn.push(act('SWAP_SELL', PEPE, 1000, 10_000, T0 + 5 * D));
    const a = computeWalletPnl(scaleIn, { now: NOW + 10 * D });
    expect(a.closedTrades).toHaveLength(10);
    expect(a.roundTrips).toHaveLength(1);
    expect(a.roundTrips[0]).toMatchObject({
      tokenKey: K_PEPE, openAt: T0, closeAt: T0 + 5 * D, qty: 1000, costUsd: 1000, proceedsUsd: 10_000, pnlUsd: 9000,
      returnPct: 900, fragments: 10, sellCount: 1, closedFlat: true,
    });
    // lama pegang berbobot biaya: rata-rata (5 hari − i menit)
    expect(a.roundTrips[0].holdMs).toBeCloseTo(5 * D - 4.5 * 60_000, 6);
    expect(a.summary).toMatchObject({ closedTradesCount: 10, roundTripsCount: 1 });

    const scaleOut = [act('SWAP_BUY', PEPE, 1000, 1000, T0)];
    for (let i = 0; i < 10; i += 1) scaleOut.push(act('SWAP_SELL', PEPE, 100, 150, T0 + D + i * 60_000));
    const b = computeWalletPnl(scaleOut, { now: NOW + 10 * D });
    expect(b.closedTrades).toHaveLength(10);
    expect(b.roundTrips).toEqual([expect.objectContaining({ costUsd: 1000, proceedsUsd: 1500, returnPct: 50, sellCount: 10, closedFlat: true })]);
  });

  it('UNIT-SM-PNL-020 round trip: posisi belum datar → per transaksi jual; masuk lagi setelah datar → round trip baru; sisa debu digabung', () => {
    const open = computeWalletPnl([
      act('SWAP_BUY', PEPE, 1000, 1000, T0),
      act('SWAP_SELL', PEPE, 300, 600, T0 + D),
      act('SWAP_SELL', PEPE, 300, 300, T0 + 2 * D),
    ], { now: NOW + 10 * D });
    expect(open.roundTrips.map((r) => [r.closeAt, r.returnPct, r.closedFlat, r.sellCount])).toEqual([
      [T0 + D, 100, false, 1],
      [T0 + 2 * D, 0, false, 1],
    ]);
    const reentry = computeWalletPnl([
      act('SWAP_BUY', PEPE, 100, 100, T0),
      act('SWAP_SELL', PEPE, 100, 120, T0 + D),
      act('SWAP_BUY', PEPE, 100, 100, T0 + 2 * D),
      act('SWAP_SELL', PEPE, 100, 80, T0 + 3 * D),
    ], { now: NOW + 10 * D });
    expect(reentry.roundTrips.map((r) => r.pnlUsd)).toEqual([20, -20]);
    // jual 99,5 % → episode ditutup (sisa ≤ 1 % puncak); jual sisa debu belakangan tidak menambah round trip
    expect(ROUND_TRIP_DUST_RATIO).toBe(0.01);
    const dust = computeWalletPnl([
      act('SWAP_BUY', PEPE, 1000, 1000, T0),
      act('SWAP_SELL', PEPE, 995, 1990, T0 + D),
      act('SWAP_SELL', PEPE, 5, 50, T0 + 9 * D),
    ], { now: NOW + 10 * D });
    expect(dust.closedTrades).toHaveLength(2);
    expect(dust.roundTrips).toHaveLength(1);
    expect(dust.roundTrips[0]).toMatchObject({ closeAt: T0 + D, qty: 1000, costUsd: 1000, proceedsUsd: 2040, pnlUsd: 1040, sellCount: 2, closedFlat: true });
    // posisi dipindah keluar seluruhnya tanpa realisasi → tidak ada round trip
    const moved = computeWalletPnl([act('SWAP_BUY', PEPE, 100, 100, T0), act('TRANSFER_OUT', PEPE, 100, null, T0 + D)], { now: NOW });
    expect(moved.roundTrips).toEqual([]);
  });

  it('UNIT-SM-PNL-021 completenessRatio berbobot USD — kuantitas tidak dijumlahkan lintas token', () => {
    // A: $100k token berbiaya tidak diketahui dijual + round trip $500 pada 1e9 unit token murah → hampir semua tidak lengkap.
    const a = computeWalletPnl([
      act('CEX_WITHDRAWAL', BIG, 100, null, T0),
      act('SWAP_SELL', BIG, 100, 100_000, T0 + D),
      act('SWAP_BUY', MEME, 1e9, 500, T0 + 2 * D),
      act('SWAP_SELL', MEME, 1e9, 900, T0 + 3 * D),
    ], { now: NOW + 10 * D });
    expect(a.summary.completenessRatio).toBeCloseTo(900 / 100_900, 12);
    expect(a.summary.completenessBasis).toBe('USD');
    // B (kebalikan): round trip $100k lengkap + 1e9 unit token transfer masuk dijual $5 → hampir lengkap.
    const b = computeWalletPnl([
      act('SWAP_BUY', BIG, 100, 50_000, T0),
      act('SWAP_SELL', BIG, 100, 100_000, T0 + D),
      act('TRANSFER_IN', MEME, 1e9, null, T0 + 2 * D),
      act('SWAP_SELL', MEME, 1e9, 5, T0 + 3 * D),
    ], { now: NOW + 10 * D });
    expect(b.summary.completenessRatio).toBeCloseTo(100_000 / 100_005, 12);
    // penjualan tanpa nilai USD → rata-rata rasio per token (bukan Σ kuantitas lintas token)
    const c = computeWalletPnl([
      act('SWAP_BUY', BIG, 100, 50_000, T0),
      act('SWAP_SELL', BIG, 100, null, T0 + D),
      act('SWAP_BUY', MEME, 1e9, 500, T0 + 2 * D),
      act('SWAP_SELL', MEME, 1e9, 900, T0 + 3 * D),
    ], { now: NOW + 10 * D });
    expect(c.summary).toMatchObject({ completenessRatio: 0.5, completenessBasis: 'TOKEN_AVERAGE' });
    expect(c.summary.notes.join(' ')).toMatch(/rata-rata per token/);
    expect(computeWalletPnl([act('SWAP_BUY', MEME, 1, 1, T0)], { now: NOW }).summary).toMatchObject({ completenessRatio: 1, completenessBasis: 'NONE' });
    expect(pos(c, K_MEME).realizedPnlUsd).toBe(400);
  });

  it('UNIT-SM-PNL-022 beli & jual di detik yang sama: urut blockNumber/logIndex, tanpa itu MASUK sebelum KELUAR (bukan teks txHash)', () => {
    const t = T0 + H;
    // id jual (0x00…) < id beli (0xff…) — urutan teks id akan memproses jual lebih dulu (oversold palsu).
    const buy = { ...act('SWAP_BUY', PEPE, 100, 100, t, { n: 999_999 }), id: `ethereum:0x${'f'.repeat(64)}:${W}:${PEPE}` };
    const sell = { ...act('SWAP_SELL', PEPE, 100, 130, t, { n: 0 }), id: `ethereum:0x${'0'.repeat(64)}:${W}:${PEPE}` };
    const noBlock = computeWalletPnl([sell, buy], { now: NOW });
    expect(pos(noBlock, K_PEPE)).toMatchObject({ qtyHeld: 0, realizedPnlUsd: 30, unknownCostSoldQty: 0 });
    expect(noBlock.summary.completenessRatio).toBe(1);
    // urutan on-chain diketahui (blok & logIndex) → diikuti, walau jual dulu (histori terpotong yang sebenarnya)
    const sellFirst = computeWalletPnl([
      { ...buy, blockNumber: 50, logIndex: 9 },
      { ...sell, blockNumber: 50, logIndex: 2 },
    ], { now: NOW });
    expect(pos(sellFirst, K_PEPE)).toMatchObject({ qtyHeld: 100, unknownCostSoldQty: 100, realizedPnlUsd: 0 });
    const byBlock = computeWalletPnl([{ ...buy, blockNumber: 49, logIndex: 9 }, { ...sell, blockNumber: 50, logIndex: 2 }], { now: NOW });
    expect(pos(byBlock, K_PEPE).realizedPnlUsd).toBe(30);
    // logIndex sintetis (≥ 1e15) tidak dipakai sebagai urutan → kembali ke MASUK sebelum KELUAR
    const synthetic = computeWalletPnl([
      { ...buy, blockNumber: 50, logIndex: 1e15 + 9 },
      { ...sell, blockNumber: 50, logIndex: 2 },
    ], { now: NOW });
    expect(pos(synthetic, K_PEPE).realizedPnlUsd).toBe(30);
    // sebagian tanpa blockNumber → seluruh kelompok memakai aturan arah; hasil tidak bergantung urutan masukan
    const third = { ...act('SWAP_SELL', PEPE, 50, 60, t, { n: 5 }), blockNumber: 50, logIndex: 1 };
    const mixedA = computeWalletPnl([{ ...buy, blockNumber: 50, logIndex: 9 }, sell, third], { now: NOW });
    const mixedB = computeWalletPnl([third, sell, { ...buy, blockNumber: 50, logIndex: 9 }], { now: NOW });
    expect(mixedB).toEqual(mixedA);
    expect(pos(mixedA, K_PEPE).knownCostQty).toBe(0);
  });
});
