import { describe, expect, it } from 'vitest';
import { DISCLAIMERS, tokenKey, walletKey } from '../../../backend/smartmoney/contracts.js';
import { DEFAULT_RADAR_PARAMS, buildAccumulationRadar, formatUsd, isWalletExcluded } from '../../../backend/smartmoney/radar.js';
import { HOUR, PEPE, PEPE_FAKE, T0, WETH, act, addr, scores } from './radarAlertFixtures.js';

const NOW = T0 + 24 * HOUR;
const WINDOW = 24 * HOUR;
const W = [addr(1), addr(2), addr(3), addr(4), addr(5)];
const PEPE_KEY = tokenKey('ethereum', PEPE.address);

function radar(activities, extra = {}, params) {
  return buildAccumulationRadar({
    activities, walletScores: extra.walletScores ?? scores(W.map((w) => [w, 80])), clusterOf: extra.clusterOf ?? new Map(),
    now: extra.now ?? NOW, windowMs: extra.windowMs ?? WINDOW, prices: extra.prices, holdingsBefore: extra.holdingsBefore,
  }, params);
}
const only = (list, key = PEPE_KEY) => list.find((r) => r.tokenKey === key);

describe('buildAccumulationRadar', () => {
  it('UNIT-SM-RAD-001 beberapa wallet independen berakumulasi → keyakinan tinggi & ACCUMULATING', () => {
    const acts = [
      act({ wallet: W[0], at: NOW - 10 * HOUR, usd: 20_000 }), act({ wallet: W[0], at: NOW - 5 * HOUR, usd: 15_000 }),
      act({ wallet: W[1], at: NOW - 8 * HOUR, usd: 25_000 }), act({ wallet: W[1], at: NOW - 2 * HOUR, usd: 10_000 }),
      act({ wallet: W[2], at: NOW - 1 * HOUR, usd: 30_000 }),
    ];
    const r = only(radar(acts));
    expect(r.buyerCount).toBe(3);
    expect(r.independentBuyers).toBe(3);
    expect(r.state).toBe('ACCUMULATING');
    expect(r.grossBuyUsd).toBe(100_000);
    expect(r.netFlowUsd).toBe(100_000);
    expect(r.conviction).toBeGreaterThanOrEqual(60);
    expect(r.convictionComponents.concentrationPenalty).toBe(0);
    expect(r.convictionComponents.exitPenalty).toBe(0);
    expect(r.reasons).toContain(DISCLAIMERS.conviction);
    expect(r.buyers[0].txs[0].explorerUrl).toMatch(/^https:\/\/etherscan\.io\/tx\/0x/);
    for (const v of Object.values(r.convictionComponents)) expect(v).toBeGreaterThanOrEqual(0);
  });

  it('UNIT-SM-RAD-002 tiga wallet tertaut (satu klaster) = satu pembeli independen + penalti konsentrasi', () => {
    const acts = [
      act({ wallet: W[0], at: NOW - 10 * HOUR, usd: 20_000 }), act({ wallet: W[1], at: NOW - 8 * HOUR, usd: 25_000 }),
      act({ wallet: W[2], at: NOW - 1 * HOUR, usd: 30_000 }),
    ];
    const clusterOf = new Map([[W[0], `ethereum:${W[0]}`], [W[1], `ethereum:${W[0]}`], [W[2], `ethereum:${W[0]}`]]);
    const linked = only(radar(acts, { clusterOf }));
    const independent = only(radar(acts));
    expect(linked.buyerCount).toBe(3);
    expect(linked.independentBuyers).toBe(1);
    expect(linked.convictionComponents.concentrationPenalty).toBe(1);
    expect(linked.conviction).toBeLessThan(independent.conviction - 20);
    expect(linked.risks.some((t) => t.includes('Satu klaster mendominasi'))).toBe(true);
    expect(linked.buyers.every((b) => b.clusterId === `ethereum:${W[0]}`)).toBe(true);
  });

  it('UNIT-SM-RAD-003 penarikan exchange / transfer / airdrop tidak menciptakan pembeli', () => {
    const acts = [
      act({ wallet: W[0], type: 'CEX_WITHDRAWAL', usd: 50_000 }), act({ wallet: W[1], type: 'TRANSFER_IN' }),
      act({ wallet: W[2], type: 'AIRDROP', usd: null }), act({ wallet: W[3], type: 'BRIDGE_IN' }), act({ wallet: W[4], type: 'LP_REMOVE' }),
    ].map((a) => ({ ...a, blockTime: NOW - HOUR }));
    expect(radar(acts)).toEqual([]); // tanpa swap/indikasi keluar → bukan entri radar
    const withBuy = only(radar([...acts, act({ wallet: W[0], at: NOW - HOUR, usd: 1000 })]));
    expect(withBuy.buyerCount).toBe(1);
    expect(withBuy.grossBuyUsd).toBe(1000);
    expect(withBuy.excluded).toMatchObject({ cexWithdrawal: 1, transferIn: 1, airdrop: 1, bridge: 1, lp: 1, mint: 0 });
  });

  it('UNIT-SM-RAD-004 penjualan menurunkan keyakinan → DISTRIBUTING', () => {
    const buys = [
      act({ wallet: W[0], at: NOW - 10 * HOUR, usd: 10_000, amount: 1000 }), act({ wallet: W[1], at: NOW - 9 * HOUR, usd: 10_000, amount: 1000 }),
      act({ wallet: W[2], at: NOW - 8 * HOUR, usd: 10_000, amount: 1000 }),
    ];
    const base = only(radar(buys));
    const sells = [W[0], W[1], W[2]].map((w, i) => act({ wallet: w, type: 'SWAP_SELL', at: NOW - (3 - i) * HOUR, usd: 20_000, amount: 400 }));
    const r = only(radar([...buys, ...sells]));
    expect(r.sellerCount).toBe(3);
    expect(r.state).toBe('DISTRIBUTING');
    expect(r.conviction).toBeLessThan(base.conviction);
    expect(r.netFlowUsd).toBe(-30_000);
    expect(r.exitSignals.filter((e) => e.type === 'SWAP_SELL')).toHaveLength(3);
  });

  it('UNIT-SM-RAD-005 keluar penuh (net ~0) → FULL_EXIT & EXITING', () => {
    const acts = [
      act({ wallet: W[0], at: NOW - 10 * HOUR, amount: 1000, usd: 10_000 }), act({ wallet: W[1], at: NOW - 9 * HOUR, amount: 1000, usd: 10_000 }),
      act({ wallet: W[0], type: 'SWAP_SELL', at: NOW - 2 * HOUR, amount: 995, usd: 12_000 }),
    ];
    const r = only(radar(acts));
    expect(r.state).toBe('EXITING');
    const full = r.exitSignals.find((e) => e.type === 'FULL_EXIT');
    expect(full).toMatchObject({ wallet: W[0], via: 'SWAP', at: NOW - 2 * HOUR });
    expect(r.risks.some((t) => t.includes('keluar penuh'))).toBe(true);
    expect(r.conviction).toBeLessThan(only(radar(acts.slice(0, 2))).conviction);
  });

  it('UNIT-SM-RAD-006 deposit exchange = indikasi keluar dengan teks "belum tentu dijual"; holdingsBefore ≥ 90% → FULL_EXIT', () => {
    const tk = PEPE_KEY;
    const holdingsBefore = new Map([[walletKey('ethereum', W[0]), new Map([[tk, 5000]])], [walletKey('ethereum', W[1]), new Map()]]);
    const acts = [
      act({ wallet: W[1], at: NOW - 6 * HOUR, amount: 1000, usd: 5000 }),
      act({ wallet: W[0], type: 'CEX_DEPOSIT', at: NOW - 3 * HOUR, amount: 4800, usd: 24_000 }),
    ];
    const r = only(radar(acts, { holdingsBefore }));
    const cex = r.exitSignals.find((e) => e.type === 'CEX_DEPOSIT');
    expect(cex.note).toContain('dipindah ke exchange, belum tentu dijual');
    const full = r.exitSignals.find((e) => e.type === 'FULL_EXIT');
    expect(full).toMatchObject({ wallet: W[0], via: 'CEX', usd: 24_000 });
    expect(full.note).toContain('belum tentu dijual');
    expect(r.state).toBe('EXITING');
    expect(r.risks.some((t) => t.includes('dipindah ke exchange, belum tentu dijual'))).toBe(true);
    // saldo total: (5000 + 0) → (200 + 1000) = −76%
    expect(r.holdingChangePct).toBeCloseTo(-76, 6);
    expect(r.buyerCount).toBe(1); // deposit exchange bukan penjualan / pembelian
    expect(r.sellerCount).toBe(0);
  });

  it('UNIT-SM-RAD-007 batas jendela inklusif; aktivitas terlambat di luar jendela & setelah now diabaikan', () => {
    const acts = [
      act({ wallet: W[0], at: NOW - WINDOW, usd: 1000 }), // tepat batas awal → masuk
      act({ wallet: W[1], at: NOW, usd: 2000 }), // tepat now → masuk
      act({ wallet: W[2], at: NOW - WINDOW - 1, usd: 99_999 }), // terlambat datang, lebih tua → diabaikan
      act({ wallet: W[3], at: NOW + 1, usd: 99_999 }), // masa depan (look-ahead) → diabaikan
    ];
    const r = only(radar(acts));
    expect(r.buyers.map((b) => b.wallet).sort()).toEqual([W[0], W[1]]);
    expect(r.grossBuyUsd).toBe(3000);
    expect(r.firstActivityAt).toBe(NOW - WINDOW);
    expect(r.lastActivityAt).toBe(NOW);
  });

  it('UNIT-SM-RAD-008 aktivitas duplikat (id sama) dihitung sekali, urutan masukan tidak mengubah hasil', () => {
    const a = act({ wallet: W[0], at: NOW - HOUR, usd: 5000 });
    const b = act({ wallet: W[1], at: NOW - 2 * HOUR, usd: 7000 });
    const r1 = radar([a, b, { ...a }, { ...b }]);
    const r2 = radar([b, a]);
    expect(only(r1).grossBuyUsd).toBe(12_000);
    expect(only(r1).buyers.find((x) => x.wallet === W[0]).buys).toBe(1);
    expect(r1).toEqual(r2);
  });

  it('UNIT-SM-RAD-009 token simbol sama kontrak berbeda = entri terpisah; token quote diabaikan', () => {
    const acts = [
      act({ wallet: W[0], token: PEPE, at: NOW - HOUR, usd: 5000 }),
      act({ wallet: W[1], token: PEPE_FAKE, at: NOW - HOUR, usd: 5000 }),
      act({ wallet: W[2], token: WETH, at: NOW - HOUR, usd: 5000 }),
    ];
    const list = radar(acts);
    expect(list.map((r) => r.tokenKey).sort()).toEqual([PEPE_KEY, tokenKey('ethereum', PEPE_FAKE.address)].sort());
    expect(list.every((r) => r.token.symbol === 'PEPE' && r.buyerCount === 1)).toBe(true);
  });

  it('UNIT-SM-RAD-010 wallet tidak eligible / berpenanda HIGH pengecuali / tanpa skor diabaikan', () => {
    const walletScores = scores([
      [W[0], 90], [W[1], 90, { eligible: false }],
      [W[2], 90, { flags: [{ code: 'BOT', severity: 'HIGH' }] }],
      [W[3], 70, { flags: [{ code: 'LOW_HISTORY', severity: 'MEDIUM' }, { code: 'MEV', severity: 'MEDIUM' }] }],
    ]);
    const acts = W.map((w) => act({ wallet: w, at: NOW - HOUR, usd: 1000 }));
    const r = only(radar(acts, { walletScores }));
    expect(r.buyers.map((b) => b.wallet).sort()).toEqual([W[0], W[3]]);
    expect(isWalletExcluded(undefined)).toBe(true);
    expect(isWalletExcluded({ eligible: true, flags: [{ code: 'CEX', severity: 'HIGH' }] })).toBe(true);
    expect(isWalletExcluded({ eligible: true, flags: [{ code: 'AIRDROP_FARMER', severity: 'HIGH' }] })).toBe(false);
  });

  it('UNIT-SM-RAD-011 nilai USD tidak diketahui tidak dijumlahkan sebagai 0 dan dicatat di alasan', () => {
    const acts = [act({ wallet: W[0], at: NOW - HOUR, usd: 4000 }), act({ wallet: W[1], at: NOW - HOUR, usd: null })];
    const r = only(radar(acts));
    expect(r.unknownUsdCount).toBe(1);
    expect(r.grossBuyUsd).toBe(4000);
    expect(r.reasons.some((t) => t.includes('tanpa nilai USD tidak dijumlahkan'))).toBe(true);
    const allUnknown = only(radar([act({ wallet: W[0], at: NOW - HOUR, usd: null })]));
    expect(allUnknown.grossBuyUsd).toBeNull();
    expect(allUnknown.netFlowUsd).toBeNull();
    expect(allUnknown.buyers[0].netBuyUsd).toBeNull();
    expect(allUnknown.convictionComponents.flow).toBe(0);
  });

  it('UNIT-SM-RAD-012 urutan deterministik: keyakinan turun lalu tokenKey; validasi input', () => {
    const t1 = { ...PEPE, address: addr(0xc001), symbol: 'AAA' };
    const t2 = { ...PEPE, address: addr(0xc002), symbol: 'BBB' };
    const acts = [act({ wallet: W[0], token: t2, at: NOW - HOUR }), act({ wallet: W[0], token: t1, at: NOW - HOUR })];
    const list = radar(acts);
    expect(list[0].conviction).toBe(list[1].conviction);
    expect(list.map((r) => r.token.symbol)).toEqual(['AAA', 'BBB']);
    expect(() => buildAccumulationRadar({ activities: [], walletScores: new Map(), now: 1.5, windowMs: 1 })).toThrow(TypeError);
    expect(() => buildAccumulationRadar({ activities: [], walletScores: new Map(), now: 1, windowMs: 0 })).toThrow(RangeError);
    expect(DEFAULT_RADAR_PARAMS.weights.breadth + DEFAULT_RADAR_PARAMS.weights.quality + DEFAULT_RADAR_PARAMS.weights.flow
      + DEFAULT_RADAR_PARAMS.weights.repeat + DEFAULT_RADAR_PARAMS.weights.recency).toBe(100);
    expect(formatUsd(12_345.6)).toBe('$12.346');
    expect(formatUsd(null)).toBe('nilai USD tidak diketahui');
  });

  it('UNIT-SM-RAD-013 akumulasi berulang menaikkan komponen repeat; holdingsBefore tidak lengkap → holdingChangePct null', () => {
    const acts = [act({ wallet: W[0], at: NOW - 5 * HOUR }), act({ wallet: W[0], at: NOW - 3 * HOUR }), act({ wallet: W[1], at: NOW - HOUR })];
    const r = only(radar(acts, { holdingsBefore: new Map([[walletKey('ethereum', W[0]), new Map()]]) }));
    expect(r.convictionComponents.repeat).toBe(0.5);
    expect(r.holdingChangePct).toBeNull();
    expect(r.reasons.some((t) => t.includes('membeli berulang'))).toBe(true);
  });
});
