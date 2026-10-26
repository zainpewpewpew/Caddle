import { describe, expect, it } from 'vitest';
import { linkWallets, linkedFlag } from '../../../backend/smartmoney/clusters.js';
import { T0, addr, labelMap, makeActivity, makeLabel, tokenAddr, txh } from '../../helpers/smartMoneyBuilders.js';

const A = addr(0xa1);
const B = addr(0xb2);
const C = addr(0xc3);
const D = addr(0xd4);
const FUNDER = addr(0xf00);
const HOT = addr(0xbeef); // hot wallet exchange

/** RawTransfer native minimal sesuai kontrak. */
function nativeTransfer({ from, to, at, n, amount = 1, chain = 'ethereum', toContract = null, providerCategory = null }) {
  return {
    chain, txHash: txh(n, 7), logIndex: 0, blockNumber: 100 + n, blockTime: at, from, to,
    token: { address: 'native', symbol: 'ETH', name: null, decimals: 18 }, amount, usdValue: null, priceSource: null,
    provider: 'test', isSimulated: true,
    txMeta: { initiator: from, toContract, method: null, providerCategory, dex: null },
  };
}

const buy = (wallet, tok, at, n) => makeActivity({ wallet, type: 'SWAP_BUY', token: tok, blockTime: at, txHash: txh(n, 3) });

describe('clusters — pendana pertama', () => {
  it('UNIT-SM-CL-001 dua wallet didanai EOA non-CEX yang sama → tertaut dengan bukti tx', () => {
    const r = linkWallets({
      chain: 'ethereum',
      wallets: [
        { address: A, activities: [], transfers: [nativeTransfer({ from: FUNDER, to: A, at: T0, n: 1 }), nativeTransfer({ from: addr(0x99), to: A, at: T0 + 1000, n: 2 })] },
        { address: B, activities: [], transfers: [nativeTransfer({ from: FUNDER, to: B, at: T0 + 5000, n: 3 })] },
        { address: C, activities: [], transfers: [nativeTransfer({ from: addr(0x99), to: C, at: T0, n: 4 })] },
      ],
      labels: new Map(),
    });
    expect(r.links).toHaveLength(1);
    expect(r.links[0]).toMatchObject({ type: 'COMMON_FUNDER', a: A, b: B, evidence: { funder: FUNDER, txHash: txh(3, 7), at: T0 + 5000 } });
    expect(r.links[0].evidence.txHashes).toEqual([txh(1, 7), txh(3, 7)]);
    expect(r.clusterOf.get(A)).toBe(`ethereum:${A}`);
    expect(r.clusterOf.get(B)).toBe(`ethereum:${A}`);
    expect(r.clusterOf.get(C)).toBe(`ethereum:${C}`); // pendana pertama C berbeda (0x99 hanya pendana kedua A)
  });

  it('UNIT-SM-CL-002 didanai hot wallet CEX yang sama → TIDAK tertaut', () => {
    const labels = labelMap([makeLabel({ address: HOT, label: 'Binance 14', category: 'cex' })]);
    const r = linkWallets({
      chain: 'ethereum',
      wallets: [
        { address: A, transfers: [nativeTransfer({ from: HOT, to: A, at: T0, n: 1 })] },
        { address: B, transfers: [nativeTransfer({ from: HOT, to: B, at: T0 + 10, n: 2 })] },
      ],
      labels,
    });
    expect(r.links).toEqual([]);
    expect(r.clusters.map((c) => c.members)).toEqual([[A], [B]]);
  });

  it('UNIT-SM-CL-003 pendana dari aktivitas: CEX_WITHDRAWAL diabaikan, TRANSFER_IN dari EOA dipakai', () => {
    const fund = (wallet, type, n, counterparty, at = T0) => makeActivity({
      wallet, type, token: 'native', symbol: 'ETH', counterparty, blockTime: at, txHash: txh(n, 5), usdValue: null,
    });
    const r1 = linkWallets({ chain: 'ethereum', wallets: [
      { address: A, activities: [fund(A, 'CEX_WITHDRAWAL', 1, HOT)] },
      { address: B, activities: [fund(B, 'CEX_WITHDRAWAL', 2, HOT)] },
    ] });
    expect(r1.links).toEqual([]);
    const r2 = linkWallets({ chain: 'ethereum', wallets: [
      { address: A, activities: [fund(A, 'TRANSFER_IN', 1, FUNDER)] },
      { address: B, activities: [fund(B, 'TRANSFER_IN', 2, FUNDER)] },
    ] });
    expect(r2.links.map((l) => l.type)).toEqual(['COMMON_FUNDER']);
  });
});

describe('clusters — transfer langsung & deposit bersama', () => {
  it('UNIT-SM-CL-010 transfer langsung antar-kandidat → tertaut', () => {
    const r = linkWallets({
      chain: 'ethereum',
      wallets: [{ address: A, transfers: [nativeTransfer({ from: A, to: B, at: T0, n: 9, amount: 3 })] }, { address: B }],
    });
    expect(r.links).toHaveLength(1);
    expect(r.links[0]).toMatchObject({ type: 'DIRECT_TRANSFER', a: A, b: B, evidence: { txHash: txh(9, 7), at: T0, from: A, to: B } });
    expect(r.clusters).toHaveLength(1);
    expect(r.clusters[0]).toMatchObject({ id: `ethereum:${A}`, members: [A, B] });
    expect(r.clusters[0].reasons).toHaveLength(1);
  });

  it('UNIT-SM-CL-011 transfer via kontrak bridge/cex atau dari aktivitas berlabel cex → TIDAK tertaut', () => {
    const BRIDGE = addr(0xb41d);
    const labels = labelMap([
      makeLabel({ address: BRIDGE, category: 'bridge', label: 'Bridge' }),
      makeLabel({ address: HOT, category: 'cex', label: 'Binance' }),
    ]);
    const viaBridge = linkWallets({
      chain: 'ethereum', labels,
      wallets: [{ address: A, transfers: [nativeTransfer({ from: A, to: B, at: T0, n: 1, toContract: BRIDGE })] }, { address: B }],
    });
    expect(viaBridge.links).toEqual([]);
    const bridgeCategory = linkWallets({
      chain: 'ethereum',
      wallets: [{ address: A, transfers: [nativeTransfer({ from: A, to: B, at: T0, n: 1, providerCategory: 'bridge' })] }, { address: B }],
    });
    expect(bridgeCategory.links).toEqual([]);
    const actCex = linkWallets({
      chain: 'ethereum', labels,
      wallets: [
        { address: A, activities: [makeActivity({ wallet: A, type: 'TRANSFER_OUT', counterparty: B, counterpartyLabel: { label: 'Binance', category: 'cex', source: 'x' }, txHash: txh(1) })] },
        { address: B },
      ],
    });
    expect(actCex.links).toEqual([]);
    // kandidat yang sendiri berlabel cex tidak menautkan wallet lain
    const cexCandidate = linkWallets({
      chain: 'ethereum', labels,
      wallets: [{ address: HOT, transfers: [nativeTransfer({ from: HOT, to: A, at: T0, n: 1 })] }, { address: A }],
    });
    expect(cexCandidate.links).toEqual([]);
  });

  it('UNIT-SM-CL-012 transfer langsung dari aktivitas TRANSFER_OUT → tertaut', () => {
    const r = linkWallets({
      chain: 'ethereum',
      wallets: [{ address: B, activities: [makeActivity({ wallet: B, type: 'TRANSFER_OUT', counterparty: A, txHash: txh(4), blockTime: T0 })] }, { address: A }],
    });
    expect(r.links[0]).toMatchObject({ type: 'DIRECT_TRANSFER', a: A, b: B, evidence: { from: B, to: A, txHash: txh(4) } });
  });

  it('UNIT-SM-CL-013 alamat deposit exchange (cex_deposit) yang sama → tertaut; hot wallet cex → tidak', () => {
    const DEP = addr(0xdeb0);
    const labels = labelMap([
      makeLabel({ address: DEP, category: 'cex_deposit', label: 'Binance deposit' }),
      makeLabel({ address: HOT, category: 'cex', label: 'Binance' }),
    ]);
    const dep = (wallet, to, n) => makeActivity({ wallet, type: 'CEX_DEPOSIT', counterparty: to, txHash: txh(n), blockTime: T0 + n });
    const r = linkWallets({ chain: 'ethereum', labels, wallets: [
      { address: A, activities: [dep(A, DEP, 1)] },
      { address: B, activities: [dep(B, DEP, 2)] },
      { address: C, activities: [dep(C, HOT, 3)] },
      { address: D, activities: [dep(D, HOT, 4)] },
    ] });
    expect(r.links).toHaveLength(1);
    expect(r.links[0]).toMatchObject({ type: 'SHARED_DEPOSIT', a: A, b: B, evidence: { depositAddress: DEP, txHash: txh(2) } });
    expect(r.clusterOf.get(C)).not.toBe(r.clusterOf.get(D));
  });
});

describe('clusters — ko-trading', () => {
  it('UNIT-SM-CL-020 beli token sama ≤ 60 dtk pada 3 token → tertaut; 2 token → tidak', () => {
    const t = [tokenAddr(1), tokenAddr(2), tokenAddr(3)];
    const acts = (wallet, offset, base) => t.map((tok, i) => buy(wallet, tok, T0 + i * 3_600_000 + offset, base + i));
    const three = linkWallets({ chain: 'ethereum', wallets: [{ address: A, activities: acts(A, 0, 1) }, { address: B, activities: acts(B, 45_000, 10) }] });
    expect(three.links).toHaveLength(1);
    expect(three.links[0]).toMatchObject({ type: 'CO_TRADING', a: A, b: B });
    expect(three.links[0].evidence.tokens).toEqual([...t].sort());
    expect(three.links[0].evidence.examples[0].txHashes).toHaveLength(2);

    const two = linkWallets({ chain: 'ethereum', wallets: [{ address: A, activities: acts(A, 0, 1).slice(0, 2) }, { address: B, activities: acts(B, 45_000, 10).slice(0, 2) }] });
    expect(two.links).toEqual([]);

    const slow = linkWallets({ chain: 'ethereum', wallets: [{ address: A, activities: acts(A, 0, 1) }, { address: B, activities: acts(B, 61_000, 10) }] });
    expect(slow.links).toEqual([]);
  });

  it('UNIT-SM-CL-021 pembelian aset quote (WETH) tidak dihitung ko-trading', () => {
    const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
    const toks = [WETH, tokenAddr(1), tokenAddr(2)];
    const acts = (wallet, base) => toks.map((tok, i) => buy(wallet, tok, T0 + i * 3_600_000, base + i));
    const r = linkWallets({ chain: 'ethereum', wallets: [{ address: A, activities: acts(A, 1) }, { address: B, activities: acts(B, 10) }] });
    expect(r.links).toEqual([]);
  });
});

describe('clusters — transitif, deterministik, Solana', () => {
  it('UNIT-SM-CL-030 klaster transitif A–B (transfer) + B–C (pendana) → satu klaster; D sendiri', () => {
    const r = linkWallets({
      chain: 'ethereum',
      wallets: [
        { address: C, transfers: [nativeTransfer({ from: FUNDER, to: C, at: T0, n: 3 })] },
        { address: A, transfers: [nativeTransfer({ from: A, to: B, at: T0 + 100, n: 1 })] },
        { address: B, transfers: [nativeTransfer({ from: FUNDER, to: B, at: T0, n: 2 })] },
        { address: D },
      ],
    });
    expect(r.clusters.map((c) => c.id)).toEqual([`ethereum:${A}`, `ethereum:${D}`]);
    const big = r.clusters[0];
    expect(big.members).toEqual([A, B, C]);
    expect(big.reasons.map((x) => x.type)).toEqual(['DIRECT_TRANSFER', 'COMMON_FUNDER']);
    for (const m of [A, B, C]) expect(r.clusterOf.get(m)).toBe(`ethereum:${A}`);
    expect(r.clusterOf.get(D)).toBe(`ethereum:${D}`);
    expect(linkedFlag(r, B)).toMatchObject({ code: 'LINKED', severity: 'LOW', evidence: { clusterId: `ethereum:${A}` } });
    expect(linkedFlag(r, D)).toBeNull();
  });

  it('UNIT-SM-CL-031 hasil deterministik terlepas dari urutan input dan huruf besar EVM', () => {
    const wallets = [
      { address: C, transfers: [nativeTransfer({ from: FUNDER, to: C, at: T0, n: 3 })] },
      { address: A.toUpperCase().replace('0X', '0x'), transfers: [nativeTransfer({ from: A, to: B, at: T0 + 100, n: 1 })] },
      { address: B, transfers: [nativeTransfer({ from: FUNDER, to: B, at: T0, n: 2 })] },
    ];
    const r1 = linkWallets({ chain: 'ethereum', wallets });
    const r2 = linkWallets({ chain: 'ethereum', wallets: [...wallets].reverse() });
    expect(r2).toEqual(r1);
    expect(r1.clusters[0].members).toEqual([A, B, C]);
  });

  it('UNIT-SM-CL-032 Solana peka huruf besar/kecil: alamat beda kapitalisasi = wallet berbeda', () => {
    const S1 = 'AbCdEfGhJkMnPqRsTuVwXyZ123456789abcdefghij';
    const S1lower = S1.toLowerCase();
    const S2 = 'ZzYyXxWwVvUuTtSsRrQqPpNnMmKkJjHhGgFfEeDdCc';
    const solTransfer = (from, to, n) => ({
      chain: 'solana', txHash: `sig${n}`, logIndex: 0, blockNumber: null, blockTime: T0 + n, from, to,
      token: { address: 'native', symbol: 'SOL', name: null, decimals: 9 }, amount: 1, usdValue: null, priceSource: null,
      provider: 'test', isSimulated: true, txMeta: null,
    });
    const r = linkWallets({
      chain: 'solana',
      wallets: [
        { address: S1, transfers: [solTransfer(S1lower, S2, 1)] }, // dari alamat lain (huruf kecil) → bukan S1
        { address: S2 },
      ],
    });
    expect(r.links).toEqual([]);
    expect(r.clusters.map((c) => c.id)).toEqual([`solana:${S1}`, `solana:${S2}`]);

    const linked = linkWallets({ chain: 'solana', wallets: [{ address: S1, transfers: [solTransfer(S1, S2, 1)] }, { address: S2 }, { address: S1lower }] });
    expect(linked.links).toHaveLength(1);
    // id = alamat terkecil berdasarkan kode karakter (huruf besar < huruf kecil)
    expect(linked.clusterOf.get(S2)).toBe(`solana:${S1}`);
    expect(linked.clusterOf.get(S1lower)).toBe(`solana:${S1lower}`);
  });

  it('UNIT-SM-CL-033 input kosong & wallet tanpa tautan', () => {
    expect(linkWallets({ chain: 'ethereum', wallets: [] })).toEqual({ clusters: [], clusterOf: new Map(), links: [] });
    const r = linkWallets({ chain: 'ethereum', wallets: [{ address: A }] });
    expect(r.clusters).toEqual([{ id: `ethereum:${A}`, members: [A], reasons: [] }]);
  });
});
