import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WALLET_SCORE_PARAMS, resolveWalletScoreParams, scoreWallet,
} from '../../../backend/smartmoney/walletScore.js';
import { TRADING_STYLES } from '../../../backend/smartmoney/contracts.js';
import { DAY, HOUR, T0, addr, makeActivity, makeClosedTrade, makePnl, tokenAddr, txh } from '../../helpers/smartMoneyBuilders.js';

const NOW = T0 + 200 * DAY;
const WALLET = addr(1);
const historyActs = [makeActivity({ wallet: WALLET, blockTime: T0, txHash: txh(9999) })];

/** Wallet konsisten: 40 trade, 8 token, ~20 minggu, return campuran tapi mayoritas positif. */
function consistentTrades() {
  const rets = [30, 15, -10, 25, 5];
  return Array.from({ length: 40 }, (_, i) => makeClosedTrade({
    token: tokenAddr(1 + (i % 8)), openAt: T0 + i * 3.5 * DAY, holdMs: 2 * DAY, costUsd: 1000, returnPct: rets[i % rets.length],
  }));
}

function score(pnl, extra = {}, params) {
  return scoreWallet({ chain: 'ethereum', address: WALLET, pnl, activities: historyActs, flags: [], now: NOW, ...extra }, params);
}

function expectBounded(r) {
  expect(r.score).toBeGreaterThanOrEqual(0);
  expect(r.score).toBeLessThanOrEqual(100);
  for (const [k, v] of Object.entries(r.components)) {
    expect(v, k).toBeGreaterThanOrEqual(0);
    expect(v, k).toBeLessThanOrEqual(1);
  }
}

describe('walletScore — parameter', () => {
  it('UNIT-SM-WS-001 parameter default beku, bobot sesuai kontrak (total 1)', () => {
    expect(Object.isFrozen(DEFAULT_WALLET_SCORE_PARAMS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_WALLET_SCORE_PARAMS.weights)).toBe(true);
    expect(DEFAULT_WALLET_SCORE_PARAMS.weights).toEqual({
      profitability: 0.30, consistency: 0.25, sampleSize: 0.15, risk: 0.15, diversification: 0.10, history: 0.05,
    });
    expect(DEFAULT_WALLET_SCORE_PARAMS.shrinkageK).toBe(10);
  });

  it('UNIT-SM-WS-002 override parameter diterapkan; kunci tidak dikenal ditolak', () => {
    const pnl = makePnl({ closedTrades: consistentTrades() });
    const base = score(pnl);
    const onlyProfit = score(pnl, {}, { weights: { consistency: 0, sampleSize: 0, risk: 0, diversification: 0, history: 0 } });
    expect(onlyProfit.score).not.toBe(base.score);
    expect(onlyProfit.score).toBeCloseTo(100 * onlyProfit.components.profitability, 1);
    expect(() => resolveWalletScoreParams({ foo: 1 })).toThrow(/tidak dikenal/);
    expect(() => resolveWalletScoreParams({ weights: { luck: 1 } })).toThrow(/tidak dikenal/);
    expect(() => resolveWalletScoreParams({ weights: { profitability: 0, consistency: 0, sampleSize: 0, risk: 0, diversification: 0, history: 0 } })).toThrow(RangeError);
  });

  it('UNIT-SM-WS-003 now wajib (tanpa Date.now)', () => {
    expect(() => scoreWallet({ pnl: makePnl() })).toThrow(/now/);
  });
});

describe('walletScore — aturan anti-menyesatkan', () => {
  it('UNIT-SM-WS-010 wallet konsisten: eligible, skor wajar, alasan Bahasa Indonesia berisi bukti', () => {
    const r = score(makePnl({ closedTrades: consistentTrades() }));
    expectBounded(r);
    expect(r.eligible).toBe(true);
    expect(r.limitations).toEqual([]);
    expect(r.metrics.closedTrades).toBe(40);
    expect(r.metrics.distinctTokens).toBe(8);
    expect(r.score).toBeGreaterThan(50);
    expect(r.reasons[0]).toMatch(/^40 trade tertutup di 8 token, \d+% minggu profit, drawdown maks \d+%$/);
    expect(r.reasons.some((x) => /Win rate .*informasi saja/.test(x))).toBe(true);
    expect(r.computedAt).toBe(NOW);
    expect(TRADING_STYLES).toContain(r.style);
  });

  it('UNIT-SM-WS-011 satu trade beruntung (+900 %) → skor rendah & tidak eligible', () => {
    const r = score(makePnl({ closedTrades: [makeClosedTrade({ openAt: T0 + 10 * DAY, returnPct: 900 })] }));
    expectBounded(r);
    expect(r.eligible).toBe(false);
    expect(r.components.profitability).toBe(0);
    expect(r.metrics.meanReturnExTopPct).toBe(0);
    expect(r.metrics.shrunkMeanReturnPct).toBeCloseTo(900 / 11, 3);
    expect(r.score).toBeLessThan(30);
    expect(r.limitations.join(' | ')).toMatch(/Baru 1 trade tertutup/);
    expect(r.limitations.join(' | ')).toMatch(/satu hasil beruntung/);
    const consistent = score(makePnl({ closedTrades: consistentTrades() }));
    expect(r.score).toBeLessThan(consistent.score);
  });

  it('UNIT-SM-WS-012 satu trade raksasa di antara banyak trade datar tidak mendominasi profitabilitas', () => {
    const flat = Array.from({ length: 20 }, (_, i) => makeClosedTrade({ token: tokenAddr(1 + (i % 5)), openAt: T0 + i * 7 * DAY, returnPct: 0 }));
    const withLucky = [...flat.slice(1), makeClosedTrade({ token: tokenAddr(9), openAt: T0, returnPct: 2000 })];
    const r = score(makePnl({ closedTrades: withLucky }));
    expect(r.components.profitability).toBe(0); // min(mean, meanExTop) = 0
    expect(r.limitations.join(' | ')).toMatch(/bergantung pada trade terbaik/);
  });

  it('UNIT-SM-WS-013 win rate tinggi dengan profit kecil + satu kerugian besar < wallet konsisten', () => {
    const trades = Array.from({ length: 40 }, (_, i) => makeClosedTrade({
      token: tokenAddr(1 + (i % 8)), openAt: T0 + i * 3.5 * DAY, holdMs: 2 * DAY, costUsd: 1000, returnPct: i === 30 ? -90 : 2,
    }));
    const risky = score(makePnl({ closedTrades: trades }));
    const consistent = score(makePnl({ closedTrades: consistentTrades() }));
    expectBounded(risky);
    expect(risky.metrics.winRate).toBeGreaterThan(consistent.metrics.winRate);
    expect(risky.score).toBeLessThan(consistent.score);
    expect(risky.components.risk).toBeLessThan(consistent.components.risk);
    expect(risky.metrics.worstTradeReturnPct).toBe(-90);
    expect(risky.metrics.maxDrawdownPct).toBeGreaterThan(consistent.metrics.maxDrawdownPct);
  });

  it('UNIT-SM-WS-014 95 % PnL dari satu token → penalti konsentrasi', () => {
    const spread = consistentTrades().map((t) => ({ ...t, returnPct: 10, pnlUsd: 100, proceedsUsd: 1100 }));
    const concentrated = spread.map((t) => (t.tokenKey.endsWith(tokenAddr(1))
      ? makeClosedTrade({ token: tokenAddr(1), openAt: t.openAt, holdMs: t.holdMs, costUsd: 10000, returnPct: 130 })
      : t));
    const a = score(makePnl({ closedTrades: spread }));
    const b = score(makePnl({ closedTrades: concentrated }));
    expect(a.metrics.topTokenPnlShare).toBeCloseTo(1 / 8, 3);
    expect(b.metrics.topTokenPnlShare).toBeGreaterThan(0.9);
    expect(b.components.diversification).toBeLessThan(a.components.diversification * 0.5);
    expect(b.limitations.join(' | ')).toMatch(/PnL positif berasal dari satu token/);
    expect(a.limitations.join(' | ')).not.toMatch(/satu token/);
  });

  it('UNIT-SM-WS-015 PnL tidak lengkap menurunkan skor; < 0,5 → tidak eligible', () => {
    const trades = consistentTrades();
    const full = score(makePnl({ closedTrades: trades, completenessRatio: 1 }));
    const partial = score(makePnl({ closedTrades: trades, completenessRatio: 0.7 }));
    const poor = score(makePnl({ closedTrades: trades, completenessRatio: 0.4 }));
    const unknown = score(makePnl({ closedTrades: trades, summary: { completenessRatio: null } }));
    expect(partial.score).toBeCloseTo(full.score * 0.85, 1);
    expect(partial.eligible).toBe(true);
    expect(partial.limitations.join(' | ')).toMatch(/PnL sebagian: 70%/);
    expect(poor.score).toBeLessThan(partial.score);
    expect(poor.eligible).toBe(false);
    expect(poor.limitations.join(' | ')).toMatch(/PnL tidak lengkap: hanya 40%/);
    expect(unknown.eligible).toBe(false);
    expect(unknown.metrics.completenessRatio).toBeNull();
  });

  it.each(['CEX', 'MARKET_MAKER', 'BOT', 'MEV', 'CONTRACT', 'DEX_INFRA'])('UNIT-SM-WS-016 penanda %s HIGH → tidak eligible', (code) => {
    const flags = [{ code, severity: 'HIGH', reason: 'uji', evidence: {}, source: 'heuristik' }];
    const r = score(makePnl({ closedTrades: consistentTrades() }), { flags });
    expect(r.eligible).toBe(false);
    expect(r.limitations.join(' | ')).toMatch(new RegExp(`Dikecualikan karena penanda berat: ${code}`));
  });

  it('UNIT-SM-WS-017 penanda MEDIUM tidak mengecualikan; AIRDROP_FARMER HIGH mengecualikan', () => {
    const pnl = makePnl({ closedTrades: consistentTrades() });
    const medium = score(pnl, { flags: [{ code: 'BOT', severity: 'MEDIUM', reason: 'pola ringan', evidence: {}, source: 'heuristik' }] });
    expect(medium.eligible).toBe(true);
    expect(medium.limitations.join(' | ')).toMatch(/Penanda BOT/);
    const farmer = score(pnl, { flags: [{ code: 'AIRDROP_FARMER', severity: 'HIGH', reason: 'x', evidence: {}, source: 'heuristik' }] });
    expect(farmer.eligible).toBe(false);
    expect(farmer.limitations.join(' | ')).toMatch(/airdrop/);
  });

  it('UNIT-SM-WS-018 kelayakan: < 10 trade, < 3 token, riwayat < 30 hari', () => {
    const fewTokens = consistentTrades().map((t, i) => makeClosedTrade({ token: tokenAddr(1 + (i % 2)), openAt: t.openAt, returnPct: t.returnPct }));
    const r1 = score(makePnl({ closedTrades: fewTokens }));
    expect(r1.eligible).toBe(false);
    expect(r1.limitations.join(' | ')).toMatch(/Hanya 2 token/);

    const shortNow = T0 + 20 * DAY;
    const quick = Array.from({ length: 12 }, (_, i) => makeClosedTrade({ token: tokenAddr(1 + (i % 4)), openAt: T0 + i * HOUR, holdMs: HOUR, returnPct: 10 }));
    const r2 = scoreWallet({ pnl: makePnl({ closedTrades: quick }), activities: historyActs, flags: [], now: shortNow });
    expect(r2.eligible).toBe(false);
    expect(r2.limitations.join(' | ')).toMatch(/Riwayat 20 hari \(minimal 30 hari\)/);
  });

  it('UNIT-SM-WS-019 saldo tidak dibaca: posisi raksasa tidak mengubah skor', () => {
    const trades = consistentTrades();
    const a = score(makePnl({ closedTrades: trades }));
    const whale = makePnl({ closedTrades: trades, positions: [{ tokenKey: 'ethereum:x', qtyHeld: 1e12, costBasisUsd: 1e9, unrealizedPnlUsd: 5e8 }], unrealizedPnlUsd: 5e8 });
    expect(score(whale)).toEqual(a);
  });

  it('UNIT-SM-WS-020 konsistensi: < 4 minggu aktif dibatasi 0,5 × W/4; shrinkage ke 0,5', () => {
    const threeWeeks = Array.from({ length: 12 }, (_, i) => makeClosedTrade({ token: tokenAddr(1 + (i % 4)), openAt: T0 + Math.floor(i / 4) * 7 * DAY, holdMs: HOUR, returnPct: 10 }));
    const r = score(makePnl({ closedTrades: threeWeeks }));
    expect(r.metrics.weeklyPositiveShare).toBe(1);
    expect(r.components.consistency).toBe(0.375);
    const all = score(makePnl({ closedTrades: consistentTrades().map((t) => ({ ...t, returnPct: 10, pnlUsd: 100 })) }));
    expect(all.metrics.weeklyPositiveShare).toBe(1);
    expect(all.components.consistency).toBeGreaterThan(0.8);
    expect(all.components.consistency).toBeLessThan(1);
  });

  it('UNIT-SM-WS-021 lama riwayat jenuh pada 180 hari', () => {
    const trades = consistentTrades();
    const r = score(makePnl({ closedTrades: trades }));
    expect(r.components.history).toBe(1);
    const r90 = scoreWallet({ pnl: makePnl({ closedTrades: trades.filter((t) => t.closeAt <= T0 + 90 * DAY) }), activities: historyActs, now: T0 + 90 * DAY });
    expect(r90.components.history).toBeCloseTo(0.5, 4);
  });
});

describe('walletScore — gaya, determinisme, tanpa look-ahead', () => {
  const mk = (holds) => holds.map((h, i) => makeClosedTrade({ token: tokenAddr(1 + (i % 4)), openAt: T0 + i * DAY, holdMs: h, returnPct: 5 }));

  it('UNIT-SM-WS-030 gaya dari median lama pegang', () => {
    expect(score(makePnl({ closedTrades: mk(Array(12).fill(20 * 60_000)) })).style).toBe('SCALPER');
    expect(score(makePnl({ closedTrades: mk(Array(12).fill(2 * DAY)) })).style).toBe('SWING');
    expect(score(makePnl({ closedTrades: mk(Array(12).fill(10 * DAY)) })).style).toBe('POSITION');
    const mixed = [...Array(4).fill(10 * 60_000), ...Array(4).fill(2 * DAY), ...Array(4).fill(20 * DAY)];
    expect(score(makePnl({ closedTrades: mk(mixed) })).style).toBe('MIXED');
    expect(score(makePnl()).style).toBe('UNKNOWN');
  });

  it('UNIT-SM-WS-031 deterministik dan tidak bergantung urutan input', () => {
    const trades = consistentTrades();
    const a = score(makePnl({ closedTrades: trades }));
    const b = score(makePnl({ closedTrades: [...trades].reverse() }));
    expect(b).toEqual(a);
    expect(score(makePnl({ closedTrades: trades }))).toEqual(a);
  });

  it('UNIT-SM-WS-032 trade yang ditutup setelah now diabaikan (tanpa look-ahead)', () => {
    const trades = consistentTrades();
    const cutoff = T0 + 70 * DAY;
    const before = trades.filter((t) => t.closeAt <= cutoff);
    const future = makeClosedTrade({ token: tokenAddr(3), openAt: cutoff - DAY, holdMs: 5 * DAY, returnPct: 5000 });
    const futureAct = makeActivity({ wallet: WALLET, blockTime: cutoff + DAY, txHash: txh(777) });
    const a = scoreWallet({ pnl: makePnl({ closedTrades: before }), activities: historyActs, now: cutoff });
    const b = scoreWallet({ pnl: makePnl({ closedTrades: [...trades, future] }), activities: [...historyActs, futureAct], now: cutoff });
    expect(b.score).toBe(a.score);
    expect(b.components).toEqual(a.components);
  });

  it('UNIT-SM-WS-033 komponen 0..1 dan skor 0..100 pada kasus ekstrem', () => {
    const cases = [
      makePnl(),
      makePnl({ closedTrades: [makeClosedTrade({ returnPct: -100 })] }),
      makePnl({ closedTrades: Array.from({ length: 300 }, (_, i) => makeClosedTrade({ token: tokenAddr(1 + (i % 50)), openAt: T0 + i * 12 * HOUR, returnPct: 10_000 })) }),
      makePnl({ closedTrades: Array.from({ length: 30 }, (_, i) => makeClosedTrade({ token: tokenAddr(1 + (i % 5)), openAt: T0 + i * DAY, returnPct: -50 })) }),
      makePnl({ closedTrades: [makeClosedTrade({ costUsd: 0, returnPct: null })] }),
    ];
    for (const pnl of cases) expectBounded(score(pnl));
    const best = score(cases[2]);
    expect(best.score).toBeLessThanOrEqual(100);
    expect(best.eligible).toBe(true);
  });
});
