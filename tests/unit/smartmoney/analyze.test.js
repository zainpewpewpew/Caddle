import { describe, expect, it } from 'vitest';
import { WALLET_FLAGS, tokenKey, walletKey } from '../../../backend/smartmoney/contracts.js';
import { DEFAULT_ANALYZE_PARAMS, analyzeUniverse, isAnalyzableActivity } from '../../../backend/smartmoney/analyze.js';
import { buildAccumulationRadar } from '../../../backend/smartmoney/radar.js';
import { labelMap, makeLabel } from '../../helpers/smartMoneyBuilders.js';
import { CHAIN, DAY, HOUR, T0, addr, shuffled, swap, tokenAddr, tradeHistory } from './evaluationFixtures.js';

const NOW = T0 + 40 * DAY;
const W = [addr(1), addr(2), addr(3), addr(4)];
const X = tokenAddr(1);
const key = (address, chain = CHAIN) => walletKey(chain, address);
/** Riwayat 12 trade tertutup (4 token, 33 hari) — layak pada NOW; jeda 10 menit antar-wallet agar tidak ko-trading. */
const history = (i, extra = {}) => tradeHistory({ wallet: W[i], salt: 0x100 + i, from: T0 + i * 10 * 60_000, ...extra });
const codes = (flags) => flags.map((f) => f.code);

describe('analyzeUniverse — komposisi', () => {
  it('UNIT-SM-ANL-001 PnL → penanda → skor per wallet; walletScores berbentuk masukan radar', () => {
    const acts = [...history(0), ...history(1, { trades: 2 })];
    const r = analyzeUniverse({ activities: acts, now: NOW });
    expect([...r.wallets.keys()]).toEqual([key(W[0]), key(W[1])]);

    const w0 = r.wallets.get(key(W[0]));
    expect(w0).toMatchObject({
      chain: CHAIN, address: W[0], clusterId: key(W[0]), activityCount: 24, firstActivityAt: T0, lastActivityAt: T0 + 34 * DAY,
    });
    expect(w0.pnl.closedTrades).toHaveLength(12);
    expect(w0.score.eligible).toBe(true);
    expect(w0.score.metrics.closedTrades).toBe(12);
    expect(w0.score.computedAt).toBe(NOW);
    expect(r.walletScores.get(key(W[0]))).toEqual({ score: w0.score.score, eligible: true, flags: w0.flags });

    const w1 = r.wallets.get(key(W[1]));
    expect(w1.score.eligible).toBe(false);
    expect(codes(w1.flags)).toContain('LOW_HISTORY');
    expect(w1.score.limitations.some((t) => t.includes('trade tertutup'))).toBe(true);
    expect(r.stats).toEqual({
      activities: 28, wallets: 2, eligibleWallets: 1, chains: ['ethereum'], ignoredFuture: 0, ignoredInvalid: 0, duplicates: 0,
    });
  });

  it('UNIT-SM-ANL-002 tanpa look-ahead: aktivitas & harga setelah `now` diabaikan seluruhnya', () => {
    const openA = swap({ wallet: W[0], token: tokenAddr(500), at: NOW - 2 * HOUR, n: 1 });
    const openB = swap({ wallet: W[0], token: tokenAddr(501), at: NOW - 2 * HOUR, n: 2 });
    const past = [...history(0), openA, openB];
    const future = [
      // W0 menjual posisi terbuka dengan untung besar & menambah trade setelah now
      swap({ wallet: W[0], token: tokenAddr(500), at: NOW + HOUR, n: 3, type: 'SWAP_SELL', usd: 100_000 }),
      ...tradeHistory({ wallet: W[0], salt: 0x900, from: NOW + 1, trades: 20, returnPct: 500 }),
      // wallet yang baru muncul setelah now
      ...history(2, { from: NOW + DAY }),
    ];
    const pricePast = { priceUsd: 2, at: NOW - HOUR, source: 'uji' };
    const prices = new Map([[tokenKey(CHAIN, tokenAddr(500)), pricePast], [tokenKey(CHAIN, tokenAddr(501)), { priceUsd: 9, at: NOW + HOUR, source: 'uji' }]]);
    const withFuture = analyzeUniverse({ activities: [...future, ...past], prices, now: NOW });
    const pastOnly = analyzeUniverse({ activities: past, prices: new Map([[tokenKey(CHAIN, tokenAddr(500)), pricePast]]), now: NOW });

    expect(withFuture.wallets).toEqual(pastOnly.wallets);
    expect(withFuture.walletScores).toEqual(pastOnly.walletScores);
    expect(withFuture.clusters).toEqual(pastOnly.clusters);
    expect(withFuture.stats.ignoredFuture).toBe(future.length);
    expect(withFuture.wallets.has(key(W[2]))).toBe(false);
    const pos = withFuture.wallets.get(key(W[0])).pnl.positions.find((p) => p.tokenKey === tokenKey(CHAIN, tokenAddr(501)));
    expect(pos.priceUsd).toBeNull(); // harga masa depan dibuang sebelum PnL
    expect(pos.notes.some((n) => n.includes('setelah waktu evaluasi'))).toBe(false);
    expect(withFuture.wallets.get(key(W[0])).pnl.positions.find((p) => p.tokenKey === tokenKey(CHAIN, tokenAddr(500))).priceUsd).toBe(2);
  });

  it('UNIT-SM-ANL-003 wallet tertaut (ko-trading): satu klaster, penanda LINKED (LOW), radar menghitung satu pembeli', () => {
    const coTrade = [300, 301, 302].flatMap((tok, i) => [
      swap({ wallet: W[0], token: tokenAddr(tok), at: NOW - 5 * DAY + i * DAY, n: 10 + i }),
      swap({ wallet: W[1], token: tokenAddr(tok), at: NOW - 5 * DAY + i * DAY + 30_000, n: 20 + i }),
    ]);
    const buysX = [swap({ wallet: W[0], token: X, at: NOW - 2 * HOUR, n: 30 }), swap({ wallet: W[1], token: X, at: NOW - HOUR, n: 31 })];
    const r = analyzeUniverse({ activities: [...history(0), ...history(1), ...history(2), ...coTrade, ...buysX], now: NOW });

    const id = `${CHAIN}:${W[0]}`;
    expect(r.clusterOf.get(key(W[0]))).toBe(id);
    expect(r.clusterOf.get(key(W[1]))).toBe(id);
    expect(r.clusterOf.get(key(W[2]))).toBe(key(W[2]));
    expect(r.clusters.find((c) => c.id === id)).toMatchObject({ chain: CHAIN, members: [W[0], W[1]] });
    expect(r.links).toHaveLength(1);
    expect(r.links[0]).toMatchObject({ chain: CHAIN, type: 'CO_TRADING', a: W[0], b: W[1] });
    for (const w of [W[0], W[1]]) {
      const { flags, score, clusterId } = r.wallets.get(key(w));
      expect(clusterId).toBe(id);
      expect(flags.find((f) => f.code === 'LINKED')).toMatchObject({ severity: 'LOW', source: 'heuristik' });
      const order = flags.map((f) => WALLET_FLAGS.indexOf(f.code));
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(score.eligible).toBe(true); // LINKED tidak mengecualikan
      expect(score.limitations.some((t) => t.startsWith('Penanda LINKED'))).toBe(true);
    }
    expect(codes(r.wallets.get(key(W[2])).flags)).not.toContain('LINKED');

    const radar = buildAccumulationRadar({ activities: buysX, walletScores: r.walletScores, clusterOf: r.clusterOf, now: NOW, windowMs: 24 * HOUR });
    expect(radar[0]).toMatchObject({ buyerCount: 2, independentBuyers: 1 });
  });

  it('UNIT-SM-ANL-004 klaster dihitung per chain: alamat & pola sama di chain lain tidak pernah ditautkan', () => {
    const coTrade = (chain, wallet, offset, salt) => [300, 301, 302].map((tok, i) => swap({
      chain, wallet, token: tokenAddr(tok), at: NOW - 5 * DAY + i * DAY + offset, n: i + 1, salt,
    }));
    const acts = [
      ...coTrade('ethereum', W[0], 0, 0xe1), ...coTrade('base', W[0], 10_000, 0xb1), ...coTrade('base', W[1], 20_000, 0xb2),
    ];
    const r = analyzeUniverse({ activities: acts, now: NOW });
    expect(r.stats.chains).toEqual(['base', 'ethereum']);
    expect([...r.wallets.keys()]).toEqual([`base:${W[0]}`, `base:${W[1]}`, `ethereum:${W[0]}`]);
    expect(r.clusterOf.get(`ethereum:${W[0]}`)).toBe(`ethereum:${W[0]}`);
    expect(r.clusterOf.get(`base:${W[0]}`)).toBe(`base:${W[0]}`);
    expect(r.clusterOf.get(`base:${W[1]}`)).toBe(`base:${W[0]}`);
    expect(r.clusters.map((c) => [c.id, c.chain, c.members.length])).toEqual([[`base:${W[0]}`, 'base', 2], [`ethereum:${W[0]}`, 'ethereum', 1]]);
    expect(r.links.every((l) => l.chain === 'base')).toBe(true);
    expect(codes(r.wallets.get(`ethereum:${W[0]}`).flags)).not.toContain('LINKED');
  });

  it('UNIT-SM-ANL-005 urutan masukan, data terlambat & duplikat tidak mengubah hasil', () => {
    const acts = [...history(0), ...history(1), ...history(2), swap({ wallet: W[3], token: X, at: NOW - HOUR, n: 1 })];
    const base = analyzeUniverse({ activities: acts, now: NOW });
    const messy = analyzeUniverse({ activities: shuffled([...acts, ...acts.slice(0, 5), { ...acts[7] }], 11), now: NOW });
    expect([...messy.wallets.keys()]).toEqual([...base.wallets.keys()]);
    expect(messy.wallets).toEqual(base.wallets);
    expect(messy.walletScores).toEqual(base.walletScores);
    expect(messy.clusters).toEqual(base.clusters);
    expect(messy.links).toEqual(base.links);
    expect(messy.stats.duplicates).toBe(6);
    expect(messy.stats.activities).toBe(base.stats.activities);
  });
});

describe('analyzeUniverse — kelayakan & pengecualian', () => {
  it('UNIT-SM-ANL-006 label exchange bersumber → penanda CEX HIGH, tidak layak, diabaikan radar', () => {
    const labels = labelMap([makeLabel({ address: W[0], category: 'cex', label: 'Exchange 14' })]);
    const buyX = swap({ wallet: W[0], token: X, at: NOW - HOUR, n: 1 });
    const r = analyzeUniverse({ activities: [...history(0), buyX], labels, now: NOW });
    const w0 = r.wallets.get(key(W[0]));
    expect(w0.flags.find((f) => f.code === 'CEX')).toMatchObject({ severity: 'HIGH', source: 'label:etherscan-nametag' });
    expect(w0.score.eligible).toBe(false);
    expect(buildAccumulationRadar({ activities: [buyX], walletScores: r.walletScores, clusterOf: r.clusterOf, now: NOW, windowMs: DAY })).toEqual([]);
  });

  it('UNIT-SM-ANL-007 PnL tidak lengkap (lot dari transfer masuk / histori terpotong) → INCOMPLETE_PNL, tidak layak', () => {
    const acts = history(2).map((a) => (a.type === 'SWAP_BUY' ? { ...a, type: 'TRANSFER_IN', usdValue: null } : a));
    const r = analyzeUniverse({ activities: acts, now: NOW });
    const w = r.wallets.get(key(W[2]));
    expect(w.pnl.summary.completenessRatio).toBe(0);
    expect(codes(w.flags)).toContain('INCOMPLETE_PNL');
    expect(w.score.eligible).toBe(false);
    expect(w.score.metrics.closedTrades).toBe(0); // penjualan lot berbiaya tidak diketahui bukan profit
  });

  it('UNIT-SM-ANL-008 kelayakan hanya dari trade yang tertutup ≤ now (wallet yang baru untung kemudian belum layak)', () => {
    // 12 posisi pada 12 token berbeda: tiap posisi ditutup sekali → 12 round trip (beli bertahap pada token yang sama
    // hanya menjadi SATU trade tingkat posisi — lihat pnl.roundTrips).
    const buys = history(3, { tokens: 12 }).filter((a) => a.type === 'SWAP_BUY');
    const sells = buys.map((b, i) => swap({ wallet: W[3], token: b.token.address, at: NOW + (i + 1) * HOUR, n: 50 + i, type: 'SWAP_SELL', usd: 4000 }));
    const acts = [...buys, ...sells];
    const before = analyzeUniverse({ activities: acts, now: NOW }).wallets.get(key(W[3]));
    expect(before.score.eligible).toBe(false);
    expect(before.score.metrics.closedTrades).toBe(0);
    const after = analyzeUniverse({ activities: acts, now: NOW + DAY }).wallets.get(key(W[3]));
    expect(after.score.eligible).toBe(true);
    expect(after.score.metrics.closedTrades).toBe(12);
  });

  it('UNIT-SM-ANL-009 masukan tidak valid & parameter: error jelas, aktivitas rusak dihitung, override diteruskan', () => {
    expect(() => analyzeUniverse({ activities: [] })).toThrow(/now/);
    expect(() => analyzeUniverse({ activities: 'x', now: NOW })).toThrow(TypeError);
    expect(() => analyzeUniverse({ activities: [], prices: {}, now: NOW })).toThrow(/prices/);
    expect(() => analyzeUniverse({ activities: [], now: NOW }, { foo: 1 })).toThrow(/tidak dikenal/);
    expect(() => analyzeUniverse({ activities: history(0), now: NOW }, { score: { foo: 1 } })).toThrow(/tidak dikenal/);

    const ok = swap({ wallet: W[0], token: X, at: NOW - HOUR, n: 1 });
    expect(isAnalyzableActivity(ok)).toBe(true);
    const broken = [null, { ...ok, chain: 'dogechain' }, { ...ok, token: null }, { ...ok, blockTime: Number.NaN }, { ...ok, wallet: '' }];
    const r = analyzeUniverse({ activities: broken, now: NOW });
    expect(r.stats).toMatchObject({ ignoredInvalid: 5, wallets: 0, activities: 0 });
    expect(r.wallets.size).toBe(0);

    expect(Object.isFrozen(DEFAULT_ANALYZE_PARAMS)).toBe(true);
    const defaults = analyzeUniverse({ activities: history(0), now: NOW });
    expect(analyzeUniverse({ activities: history(0), now: NOW }, DEFAULT_ANALYZE_PARAMS).walletScores).toEqual(defaults.walletScores);
    const strict = analyzeUniverse({ activities: history(0), now: NOW }, { score: { minClosedTrades: 20 } });
    expect(strict.walletScores.get(key(W[0])).eligible).toBe(false);
  });
});
