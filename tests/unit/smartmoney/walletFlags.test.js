import { describe, expect, it } from 'vitest';
import { DEFAULT_FLAG_PARAMS, detectWalletFlags, isExcluded } from '../../../backend/smartmoney/walletFlags.js';
import { WALLET_FLAGS } from '../../../backend/smartmoney/contracts.js';
import {
  DAY, HOUR, T0, addr, labelMap, makeActivity, makeClosedTrade, makeLabel, makePnl, tokenAddr, txh,
} from '../../helpers/smartMoneyBuilders.js';

const W = addr(1);
const NOW = T0 + 120 * DAY;
const codes = (flags) => flags.map((f) => f.code);
const find = (flags, code) => flags.find((f) => f.code === code);

/** Trader normal: 12 trade tertutup di 4 token selama 100 hari (jam aktif 08–19 UTC). */
function normalTrader() {
  const acts = [];
  let n = 1;
  for (let i = 0; i < 12; i += 1) {
    const tok = tokenAddr(1 + (i % 4));
    const buyAt = T0 + i * 8 * DAY + (8 + (i % 6)) * HOUR;
    acts.push(makeActivity({ wallet: W, type: 'SWAP_BUY', token: tok, blockTime: buyAt, txHash: txh(n++) }));
    acts.push(makeActivity({ wallet: W, type: 'SWAP_SELL', token: tok, blockTime: buyAt + 2 * DAY + 3 * HOUR, txHash: txh(n++) }));
  }
  const pnl = makePnl({ closedTrades: Array.from({ length: 12 }, (_, i) => makeClosedTrade({ token: tokenAddr(1 + (i % 4)), openAt: T0 + i * 8 * DAY })) });
  return { acts, pnl };
}

/** Trader aktif normal: 250 tx dalam 100 hari, hanya jam kerja → bukan BOT. */
function activeHumanTxs() {
  return Array.from({ length: 250 }, (_, i) => makeActivity({
    wallet: W, type: i % 2 ? 'SWAP_SELL' : 'SWAP_BUY', token: tokenAddr(1 + (i % 10)),
    blockTime: T0 + Math.floor(i / 3) * DAY + (9 + (i % 3) * 4) * HOUR + (i % 7) * 60_000, txHash: txh(i + 1),
  }));
}

describe('walletFlags — label bersumber', () => {
  it.each([
    ['cex', 'CEX'], ['cex_deposit', 'CEX'], ['market_maker', 'MARKET_MAKER'], ['mev_bot', 'MEV'],
    ['dex_router', 'DEX_INFRA'], ['dex_pool', 'DEX_INFRA'], ['contract', 'CONTRACT'],
  ])('UNIT-SM-WF-001 kategori %s → %s HIGH dengan source label:<sumber>', (category, code) => {
    const labels = labelMap([makeLabel({ address: W, label: 'Binance 14', category, source: 'etherscan-nametag' })]);
    const flags = detectWalletFlags({ chain: 'ethereum', address: W, activities: [], labels, now: NOW });
    const f = find(flags, code);
    expect(f).toMatchObject({ code, severity: 'HIGH', source: 'label:etherscan-nametag' });
    expect(f.reason).toMatch(/sumber: etherscan-nametag/);
    expect(f.evidence.category).toBe(category);
    expect(isExcluded(flags)).toBe(true);
  });

  it('UNIT-SM-WF-002 label tanpa sumber diabaikan; keyakinan rendah → MEDIUM (tidak mengecualikan)', () => {
    const noSource = labelMap([makeLabel({ address: W, category: 'cex', source: '' })]);
    expect(codes(detectWalletFlags({ chain: 'ethereum', address: W, labels: noSource, now: NOW }))).not.toContain('CEX');
    const low = labelMap([makeLabel({ address: W, category: 'cex', confidence: 0.3 })]);
    const flags = detectWalletFlags({ chain: 'ethereum', address: W, labels: low, now: NOW });
    expect(find(flags, 'CEX').severity).toBe('MEDIUM');
    expect(isExcluded(flags)).toBe(false);
  });

  it('UNIT-SM-WF-003 alamat EVM huruf besar dicocokkan dengan label huruf kecil', () => {
    const mixed = addr(0xabcdef);
    const labels = labelMap([makeLabel({ address: mixed, category: 'mev_bot', source: 'arkham' })]);
    const flags = detectWalletFlags({ chain: 'ethereum', address: `0x${mixed.slice(2).toUpperCase()}`, labels, now: NOW });
    expect(find(flags, 'MEV').source).toBe('label:arkham');
  });

  it('UNIT-SM-WF-004 label kategori lain (smart_money/fund) tidak menghasilkan penanda pengecualian', () => {
    const labels = labelMap([makeLabel({ address: W, category: 'smart_money' })]);
    const { acts, pnl } = normalTrader();
    const flags = detectWalletFlags({ chain: 'ethereum', address: W, activities: acts, labels, pnl, now: NOW });
    expect(flags).toEqual([]);
  });
});

describe('walletFlags — heuristik BOT', () => {
  it('UNIT-SM-WF-010 ≥ 200 tx dengan median jeda < 60 dtk → BOT HIGH dengan contoh tx', () => {
    const acts = Array.from({ length: 220 }, (_, i) => makeActivity({ wallet: W, blockTime: T0 + i * 20_000, txHash: txh(i + 1) }));
    const flags = detectWalletFlags({ chain: 'ethereum', address: W, activities: acts, now: NOW });
    const bot = find(flags, 'BOT');
    expect(bot).toMatchObject({ severity: 'HIGH', source: 'heuristik' });
    expect(bot.reason).toMatch(/220 tx dengan median jeda 20 dtk/);
    expect(bot.evidence.txCount).toBe(220);
    expect(bot.evidence.exampleTxHashes).toHaveLength(DEFAULT_FLAG_PARAMS.maxEvidenceTx);
    expect(isExcluded(flags)).toBe(true);
  });

  it('UNIT-SM-WF-011 trader aktif normal (250 tx, jam kerja) BUKAN BOT', () => {
    const flags = detectWalletFlags({ chain: 'ethereum', address: W, activities: activeHumanTxs(), now: NOW });
    expect(codes(flags)).not.toContain('BOT');
  });

  it('UNIT-SM-WF-012 aktif merata 24 jam UTC → BOT; txTimes dipakai bila diberikan', () => {
    const txTimes = Array.from({ length: 24 * 6 }, (_, i) => T0 + i * HOUR + 17 * 60_000);
    const flags = detectWalletFlags({ chain: 'ethereum', address: W, activities: [], txTimes, now: NOW });
    const bot = find(flags, 'BOT');
    expect(bot.reason).toMatch(/aktif merata di 24 dari 24 jam UTC/);
    expect(bot.evidence.activeHoursUtc).toBe(24);
  });

  it('UNIT-SM-WF-013 banyak tx di blok yang sama → BOT; sedikit → tidak', () => {
    const mk = (blocks) => blocks.flatMap((b) => [0, 1, 2].map((k) => ({ at: T0 + b * DAY, blockNumber: 1000 + b, txHash: txh(b * 10 + k + 1) })));
    const many = detectWalletFlags({ chain: 'ethereum', address: W, txTimes: mk([0, 1, 2, 3, 4]), now: NOW });
    expect(find(many, 'BOT').reason).toMatch(/5 blok berisi ≥ 3 tx/);
    const few = detectWalletFlags({ chain: 'ethereum', address: W, txTimes: mk([0, 1]), now: NOW });
    expect(codes(few)).not.toContain('BOT');
  });
});

describe('walletFlags — MEV, MARKET_MAKER', () => {
  const sandwich = (k, tok) => [
    makeActivity({ wallet: W, type: 'SWAP_BUY', token: tok, blockTime: T0 + k * HOUR, txHash: txh(k * 2 + 1) }),
    makeActivity({ wallet: W, type: 'SWAP_SELL', token: tok, blockTime: T0 + k * HOUR, txHash: txh(k * 2 + 2) }),
  ];

  it('UNIT-SM-WF-020 beli & jual token sama di detik yang sama ≥ 3 kali → MEV HIGH', () => {
    const acts = [0, 1, 2].flatMap((k) => sandwich(k, tokenAddr(1 + k)));
    const flags = detectWalletFlags({ chain: 'ethereum', address: W, activities: acts, now: NOW });
    const mev = find(flags, 'MEV');
    expect(mev).toMatchObject({ severity: 'HIGH', source: 'heuristik' });
    expect(mev.evidence.occurrences).toBe(3);
    expect(mev.evidence.exampleTxHashes.length).toBeGreaterThan(0);
  });

  it('UNIT-SM-WF-021 hanya 2 kejadian → bukan MEV', () => {
    const acts = [0, 1].flatMap((k) => sandwich(k, tokenAddr(1)));
    expect(codes(detectWalletFlags({ chain: 'ethereum', address: W, activities: acts, now: NOW }))).not.toContain('MEV');
  });

  it('UNIT-SM-WF-022 dua arah frekuensi tinggi, net ≈ 0 pada 5 token → MARKET_MAKER HIGH', () => {
    const acts = [];
    let n = 1;
    for (let t = 1; t <= 5; t += 1) {
      for (let k = 0; k < 12; k += 1) {
        acts.push(makeActivity({ wallet: W, type: k % 2 ? 'SWAP_SELL' : 'SWAP_BUY', token: tokenAddr(t), amount: 100, blockTime: T0 + t * DAY + k * 600_000, txHash: txh(n++) }));
      }
    }
    const flags = detectWalletFlags({ chain: 'ethereum', address: W, activities: acts, now: NOW });
    const mm = find(flags, 'MARKET_MAKER');
    expect(mm).toMatchObject({ severity: 'HIGH', source: 'heuristik' });
    expect(mm.evidence.tokens).toHaveLength(5);
    expect(mm.evidence.tokens[0].netRatio).toBe(0);
  });

  it('UNIT-SM-WF-023 swing trader yang keluar penuh di 5 token (1 beli 1 jual) BUKAN market maker; 4 token MM juga tidak', () => {
    const { acts } = normalTrader();
    expect(codes(detectWalletFlags({ chain: 'ethereum', address: W, activities: acts, now: NOW }))).not.toContain('MARKET_MAKER');
    const four = [];
    let n = 1;
    for (let t = 1; t <= 4; t += 1) {
      for (let k = 0; k < 12; k += 1) four.push(makeActivity({ wallet: W, type: k % 2 ? 'SWAP_SELL' : 'SWAP_BUY', token: tokenAddr(t), amount: 100, blockTime: T0 + k * 600_000, txHash: txh(n++) }));
    }
    expect(codes(detectWalletFlags({ chain: 'ethereum', address: W, activities: four, now: NOW }))).not.toContain('MARKET_MAKER');
  });
});

describe('walletFlags — AIRDROP_FARMER, LOW_HISTORY, INCOMPLETE_PNL', () => {
  const farmActs = () => [
    ...Array.from({ length: 8 }, (_, i) => makeActivity({ wallet: W, type: 'AIRDROP', token: tokenAddr(20 + i), usdValue: null, blockTime: T0 + i * DAY, txHash: txh(100 + i) })),
    makeActivity({ wallet: W, type: 'SWAP_BUY', token: tokenAddr(1), blockTime: T0, txHash: txh(1) }),
    makeActivity({ wallet: W, type: 'SWAP_BUY', token: tokenAddr(2), blockTime: T0 + DAY, txHash: txh(2) }),
  ];

  it('UNIT-SM-WF-030 mayoritas masuk dari airdrop & PnL didominasi lot airdrop → AIRDROP_FARMER HIGH', () => {
    const pnl = makePnl({ airdropRealizedUsd: 5000, summary: { realizedPnlUsd: 100 } });
    const f = find(detectWalletFlags({ chain: 'ethereum', address: W, activities: farmActs(), pnl, now: NOW }), 'AIRDROP_FARMER');
    expect(f.severity).toBe('HIGH');
    expect(f.reason).toMatch(/80% aktivitas masuk berasal dari airdrop\/mint/);
    expect(f.evidence).toMatchObject({ inCount: 10, airdropCount: 8, airdropRealizedUsd: 5000 });
    expect(f.evidence.exampleTxHashes).toHaveLength(5);
  });

  it('UNIT-SM-WF-031 banyak airdrop tapi profit swap nyata dominan → MEDIUM, bukan HIGH', () => {
    const pnl = makePnl({ airdropRealizedUsd: 500, summary: { realizedPnlUsd: 20_000 } });
    const flags = detectWalletFlags({ chain: 'ethereum', address: W, activities: farmActs(), pnl, now: NOW });
    expect(find(flags, 'AIRDROP_FARMER').severity).toBe('MEDIUM');
    expect(find(flags, 'AIRDROP_FARMER').reason).toMatch(/PnL trading swap tetap dominan/);
    const noPnl = detectWalletFlags({ chain: 'ethereum', address: W, activities: farmActs(), now: NOW });
    expect(find(noPnl, 'AIRDROP_FARMER').severity).toBe('MEDIUM');
  });

  it('UNIT-SM-WF-032 sedikit airdrop (≤ 50 %) → tidak ditandai', () => {
    const { acts, pnl } = normalTrader();
    const withDrop = [...acts, makeActivity({ wallet: W, type: 'AIRDROP', token: tokenAddr(30), usdValue: null, blockTime: T0, txHash: txh(500) })];
    expect(codes(detectWalletFlags({ chain: 'ethereum', address: W, activities: withDrop, pnl, now: NOW }))).not.toContain('AIRDROP_FARMER');
  });

  it('UNIT-SM-WF-033 LOW_HISTORY (MEDIUM, tidak mengecualikan) untuk riwayat < 30 hari atau < 10 trade', () => {
    const acts = [makeActivity({ wallet: W, blockTime: T0, txHash: txh(1) })];
    const flags = detectWalletFlags({ chain: 'ethereum', address: W, activities: acts, pnl: makePnl(), now: T0 + 10 * DAY });
    const f = find(flags, 'LOW_HISTORY');
    expect(f.severity).toBe('MEDIUM');
    expect(f.reason).toMatch(/riwayat 10 hari \(< 30\), 0 trade tertutup \(< 10\)/);
    expect(isExcluded(flags)).toBe(false);
    const { acts: ok, pnl } = normalTrader();
    expect(codes(detectWalletFlags({ chain: 'ethereum', address: W, activities: ok, pnl, now: NOW }))).not.toContain('LOW_HISTORY');
  });

  it('UNIT-SM-WF-034 INCOMPLETE_PNL bila completenessRatio < 0,5', () => {
    const { acts, pnl } = normalTrader();
    const bad = { ...pnl, summary: { ...pnl.summary, completenessRatio: 0.3, completeness: 'PARTIAL' } };
    const f = find(detectWalletFlags({ chain: 'ethereum', address: W, activities: acts, pnl: bad, now: NOW }), 'INCOMPLETE_PNL');
    expect(f).toMatchObject({ severity: 'MEDIUM', evidence: { completenessRatio: 0.3 } });
    expect(f.reason).toMatch(/hanya 30%/);
    const fine = { ...pnl, summary: { ...pnl.summary, completenessRatio: 0.5 } };
    expect(codes(detectWalletFlags({ chain: 'ethereum', address: W, activities: acts, pnl: fine, now: NOW }))).not.toContain('INCOMPLETE_PNL');
  });

  it('UNIT-SM-WF-035 trader normal tanpa label: tidak ada penanda', () => {
    const { acts, pnl } = normalTrader();
    expect(detectWalletFlags({ chain: 'ethereum', address: W, activities: acts, pnl, now: NOW })).toEqual([]);
  });

  it('UNIT-SM-WF-036 aktivitas setelah now diabaikan (tanpa look-ahead)', () => {
    const future = Array.from({ length: 220 }, (_, i) => makeActivity({ wallet: W, blockTime: NOW + 1000 + i * 10_000, txHash: txh(i + 1000) }));
    const { acts, pnl } = normalTrader();
    expect(codes(detectWalletFlags({ chain: 'ethereum', address: W, activities: [...acts, ...future], pnl, now: NOW }))).not.toContain('BOT');
  });
});

describe('walletFlags — isExcluded & urutan', () => {
  it('UNIT-SM-WF-040 isExcluded hanya untuk EXCLUDING_FLAGS ber-severity HIGH', () => {
    expect(isExcluded([])).toBe(false);
    expect(isExcluded(undefined)).toBe(false);
    expect(isExcluded([{ code: 'BOT', severity: 'MEDIUM' }])).toBe(false);
    expect(isExcluded([{ code: 'LOW_HISTORY', severity: 'HIGH' }])).toBe(false);
    expect(isExcluded([{ code: 'AIRDROP_FARMER', severity: 'HIGH' }])).toBe(false);
    expect(isExcluded([{ code: 'LINKED', severity: 'HIGH' }])).toBe(false);
    expect(isExcluded([{ code: 'DEX_INFRA', severity: 'HIGH' }])).toBe(true);
  });

  it('UNIT-SM-WF-041 urutan penanda mengikuti WALLET_FLAGS dan deterministik', () => {
    const labels = labelMap([makeLabel({ address: W, category: 'contract' })]);
    const acts = Array.from({ length: 220 }, (_, i) => makeActivity({ wallet: W, blockTime: T0 + i * 20_000, txHash: txh(i + 1) }));
    const a = detectWalletFlags({ chain: 'ethereum', address: W, activities: acts, labels, now: NOW });
    expect(codes(a)).toEqual([...codes(a)].sort((x, y) => WALLET_FLAGS.indexOf(x) - WALLET_FLAGS.indexOf(y)));
    expect(codes(a)).toEqual(['BOT', 'CONTRACT', 'LOW_HISTORY']);
    expect(detectWalletFlags({ chain: 'ethereum', address: W, activities: [...acts].reverse(), labels, now: NOW })).toEqual(a);
  });
});
