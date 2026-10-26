import { describe, expect, it } from 'vitest';
import {
  CHAINS, LABEL_CATEGORIES, ZERO_ADDRESS, isQuoteAsset, normalizeAddress, normalizeTxHash,
} from '../../../backend/smartmoney/contracts.js';
import { SEED_SYMBOL } from '../../helpers/signalSeed.js';
import { buildScenario } from '../../fixtures/smartmoney/scenario.js';

// Pemeriksaan struktur dataset SIMULASI (bukan data on-chain nyata) yang dipakai tes modul smart money berikutnya.
const NOW = Date.UTC(2026, 9, 1, 12, 0);
const DAY = 86_400_000;
const s = buildScenario({ now: NOW });
const keyOf = (t) => `${t.chain}:${t.txHash}:${t.logIndex}`;
const labelOf = (chain, address) => s.labels.find((l) => l.chain === chain && l.address === address);
const txGroups = () => {
  const g = new Map();
  for (const t of s.rawTransfers) {
    const k = `${t.chain}:${t.txHash}`;
    if (!g.has(k)) g.set(k, new Map());
    g.get(k).set(t.logIndex, t);
  }
  return g;
};

describe('dataset skenario smart money (simulasi)', () => {
  it('UNIT-SM-FIX-001 setiap transfer valid menurut contracts.js dan bertanda simulasi', () => {
    expect(s.rawTransfers.length).toBeGreaterThan(1000);
    for (const t of s.rawTransfers) {
      expect(CHAINS).toContain(t.chain);
      expect(normalizeTxHash(t.chain, t.txHash)).toBe(t.txHash);
      expect(normalizeAddress(t.chain, t.from)).toBe(t.from);
      expect(normalizeAddress(t.chain, t.to)).toBe(t.to);
      expect(normalizeAddress(t.chain, t.token.address)).toBe(t.token.address);
      expect(Number.isInteger(t.logIndex) && t.logIndex >= 0).toBe(true);
      expect(t.amount).toBeGreaterThan(0);
      expect(t.blockTime).toBeLessThanOrEqual(NOW);
      expect(t.usdValue === null || t.usdValue >= 0).toBe(true);
      expect(t).toMatchObject({ provider: 'fixture', isSimulated: true });
    }
    for (const c of s.candidates) expect(normalizeAddress(c.chain, c.address)).toBe(c.address);
  });

  it('UNIT-SM-FIX-002 deterministik: now yang sama → data identik; now berbeda → waktu bergeser', () => {
    const again = buildScenario({ now: NOW });
    expect(again.rawTransfers).toEqual(s.rawTransfers);
    expect(again.labels).toEqual(s.labels);
    expect(buildScenario({ now: NOW + DAY }).rawTransfers[0].blockTime).toBe(s.rawTransfers[0].blockTime + DAY);
  });

  it('UNIT-SM-FIX-003 label selalu bersumber; kategori valid; hot wallet CEX berlabel cex/fixture-label', () => {
    for (const l of s.labels) {
      expect(LABEL_CATEGORIES).toContain(l.category);
      expect(l.source).toBe('fixture-label');
      expect(l.confidence).toBeGreaterThanOrEqual(0);
      expect(l.confidence).toBeLessThanOrEqual(1);
    }
    expect(labelOf('ethereum', s.expectations.cexHotWallet.address)).toMatchObject({ category: 'cex', source: 'fixture-label' });
    expect(s.expectations.unsourcedLabel.source).toBe('');
  });

  it('EDGE-SM-FIX-001 duplikat transfer (chain, txHash, logIndex) memang ada sesuai ekspektasi', () => {
    const counts = new Map();
    for (const t of s.rawTransfers) counts.set(keyOf(t), (counts.get(keyOf(t)) ?? 0) + 1);
    const dupKeys = [...counts].filter(([, n]) => n > 1).map(([k]) => k);
    expect(s.expectations.duplicateCount).toBe(3);
    expect(dupKeys.sort()).toEqual([...s.expectations.duplicateKeys].sort());
  });

  it('UNIT-SM-FIX-004 swap = dua transfer dalam tx yang sama, lawan pool berlabel dex_pool', () => {
    let swaps = 0;
    for (const legs of txGroups().values()) {
      const first = legs.get(0);
      if (first.txMeta.method !== 'swapExactTokensForTokens') continue;
      swaps += 1;
      expect(legs.size).toBe(2);
      const [a, b] = [legs.get(0), legs.get(1)];
      expect(a.to).toBe(b.from);
      expect(labelOf(a.chain, a.to)?.category).toBe('dex_pool');
      expect(a.token.address).not.toBe(b.token.address);
      expect(isQuoteAsset(a.chain, a.token.address) || isQuoteAsset(b.chain, b.token.address)).toBe(true);
    }
    expect(swaps).toBeGreaterThan(500);
  });

  it('UNIT-SM-FIX-005 6 trader berkualitas: ≥ 12 round trip, ≥ 60 hari, ≥ 4 token, tidak semua menang, total untung', () => {
    expect(s.expectations.qualityWallets).toHaveLength(6);
    expect(new Set(s.expectations.qualityWallets.map((q) => q.chain))).toEqual(new Set(['ethereum', 'base']));
    for (const q of s.expectations.qualityWallets) {
      expect(q.trades.length).toBeGreaterThanOrEqual(12);
      expect(new Set(q.trades.map((t) => t.token)).size).toBeGreaterThanOrEqual(4);
      const times = s.rawTransfers.filter((t) => t.chain === q.chain && (t.from === q.address || t.to === q.address) && t.txMeta.dex).map((t) => t.blockTime);
      expect(Math.max(...times) - Math.min(...times)).toBeGreaterThanOrEqual(60 * DAY);
      const wins = q.trades.filter((t) => t.proceedsUsd > t.costUsd).length;
      expect(wins).toBeGreaterThan(q.trades.length / 2);
      expect(wins).toBeLessThan(q.trades.length);
      expect(q.trades.reduce((sum, t) => sum + t.proceedsUsd - t.costUsd, 0)).toBeGreaterThan(0);
    }
  });

  it('EDGE-SM-FIX-002 BOT: ≥ 200 tx dengan median jeda < 60 detik', () => {
    const { wallet, chain } = s.expectations.bot;
    const times = [...new Set(s.rawTransfers.filter((t) => t.chain === chain && (t.from === wallet || t.to === wallet) && t.txMeta.dex).map((t) => t.blockTime))].sort((a, b) => a - b);
    expect(times.length).toBeGreaterThanOrEqual(200);
    const gaps = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
    expect(gaps[Math.floor(gaps.length / 2)]).toBeLessThan(60_000);
  });

  it('EDGE-SM-FIX-003 PEPE dua kontrak berbeda; hanya satu terpetakan (1000PEPEUSDT × 1000)', () => {
    const pepes = Object.values(s.tokens).filter((t) => t.symbol === 'PEPE');
    expect(pepes).toHaveLength(2);
    expect(pepes[0].address).not.toBe(pepes[1].address);
    const mapped = s.binanceMap.filter((m) => pepes.some((p) => p.address === m.contractAddress));
    expect(mapped).toEqual([expect.objectContaining({ contractAddress: s.expectations.pepe.mapped, futuresSymbol: '1000PEPEUSDT', multiplier: 1000 })]);
  });

  it('UNIT-SM-FIX-006 token base terpetakan ke simbol futures sinyal LONG yang di-seed (signalSeed)', () => {
    const { chain, address, futuresSymbol } = s.expectations.screenerLink;
    expect(futuresSymbol).toBe(SEED_SYMBOL);
    expect(s.binanceMap.find((m) => m.chain === chain && m.contractAddress === address)?.futuresSymbol).toBe(SEED_SYMBOL);
  });

  it('UNIT-SM-FIX-007 TKA: 3 wallet berkualitas + 2 wallet tertaut membeli di 24 jam terakhir; CEX/bridge masuk bukan swap', () => {
    const { tka } = s.expectations;
    const groups = txGroups();
    const buyersInWindow = new Set();
    for (const legs of groups.values()) {
      for (const t of legs.values()) {
        if (t.token.address === tka.address && t.blockTime >= NOW - DAY && legs.size === 2 && t.txMeta.method === 'swapExactTokensForTokens') buyersInWindow.add(t.to);
      }
    }
    expect(buyersInWindow).toEqual(new Set([...tka.qualityBuyers, ...tka.linkedBuyers]));
    for (const { txHash, type } of tka.nonBuyInflows) {
      const legs = groups.get(`ethereum:${txHash}`);
      expect(legs.size).toBe(1);
      const from = legs.get(0).from;
      expect(labelOf('ethereum', from)?.category).toBe(type === 'CEX_WITHDRAWAL' ? 'cex' : 'bridge');
    }
  });

  it('EDGE-SM-FIX-004 wallet tertaut: pendana pertama non-CEX sama + transfer langsung; trader berkualitas didanai CEX', () => {
    const firstNativeIn = (chain, w) => s.rawTransfers.filter((t) => t.chain === chain && t.to === w && t.token.address === 'native')
      .sort((a, b) => a.blockTime - b.blockTime)[0];
    const { a, b, funder, directTransferTx } = s.expectations.linked;
    expect(firstNativeIn('ethereum', a).from).toBe(funder);
    expect(firstNativeIn('ethereum', b).from).toBe(funder);
    expect(labelOf('ethereum', funder)).toBeUndefined();
    const direct = s.rawTransfers.find((t) => t.txHash === directTransferTx);
    expect([direct.from, direct.to]).toEqual([a, b]);
    for (const q of s.expectations.qualityWallets) expect(labelOf(q.chain, firstNativeIn(q.chain, q.address).from)?.category).toBe('cex');
  });

  it('EDGE-SM-FIX-005 data terlambat: tx lama yang ditandai terlambat ada dan lebih tua dari 24 jam', () => {
    const late = s.rawTransfers.filter((t) => s.expectations.lateTransferKeys.includes(keyOf(t)));
    expect(late).toHaveLength(2);
    for (const t of late) expect(t.blockTime).toBeLessThan(NOW - 7 * DAY);
  });

  it('EDGE-SM-FIX-006 LP add/remove, airdrop, PnL tidak lengkap, indikasi keluar ke exchange tersedia', () => {
    const find = (tx) => s.rawTransfers.filter((t) => t.txHash === tx);
    const add = find(s.expectations.lp.addTx);
    expect(add.find((t) => t.from === ZERO_ADDRESS && t.token.address === s.expectations.lp.lpToken)).toBeTruthy();
    expect(labelOf('ethereum', s.expectations.lp.lpToken)?.category).toBe('lp_token');
    const remove = find(s.expectations.lp.removeTx);
    expect(remove.find((t) => t.to === ZERO_ADDRESS && t.token.address === s.expectations.lp.lpToken)).toBeTruthy();
    expect(find(s.expectations.farmer.claimTxs[0])[0].txMeta).toMatchObject({ providerCategory: 'airdrop', method: 'claim' });
    expect(find(s.expectations.farmer.mintTx)[0].from).toBe(ZERO_ADDRESS);
    const inc = s.expectations.incompletePnl;
    const incIn = s.rawTransfers.filter((t) => t.to === inc.wallet && t.token.address === inc.token);
    expect(incIn.every((t) => t.txMeta.dex === null)).toBe(true);
    const exit = find(s.expectations.cexExit.txHash)[0];
    expect(labelOf('ethereum', exit.to)?.category).toBe('cex_deposit');
    expect(exit.amount).toBe(s.expectations.cexExit.qty);
  });

  it('UNIT-SM-FIX-008 kandidat memuat duplikat & alamat yang harus dibuang discovery; harga & lucky trade', () => {
    expect(s.candidates.filter((c) => c.address === s.expectations.duplicateCandidate)).toHaveLength(2);
    for (const a of s.expectations.excludedCandidates) expect(s.candidates.some((c) => c.address === a)).toBe(true);
    expect(s.expectations.lucky.returnPct).toBeGreaterThan(500);
    const stale = s.prices.find((p) => p.address === s.expectations.stalePrice.address);
    expect(NOW - stale.at).toBeGreaterThan(DAY);
    expect(s.prices.every((p) => p.priceUsd > 0 && p.source === 'fixture-price')).toBe(true);
    expect(s.priceAt('ethereum', s.tokens.TKA.address, NOW)).toBeGreaterThan(0);
    expect(s.priceAt('ethereum', '0x0000000000000000000000000000000000000001', NOW)).toBeNull();
    expect(s.rawTransfers.some((t) => t.chain === 'solana')).toBe(true);
  });
});
