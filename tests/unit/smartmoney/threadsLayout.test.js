// Peta Benang — tata letak murni (frontend/js/views/smartThreadsLayout.js): identitas token/wallet, batas & hitungan
// tersembunyi, klaster berdampingan, benang BUY/EXIT, USD tidak diketahui, determinisme, dan hash tampilan radar.
import { describe, expect, it } from 'vitest';
import { USD_UNKNOWN } from '../../../frontend/js/views/smartMoneyFormat.js';
import {
  CLUSTER_GAP, STRAND_WIDTH, TOKEN_SLOT, buildThreadsLayout, parseRadarView, radarViewHash, strandWeight, strandWidth,
  threadsCountText, threadsSummaryLines, tokenDisplayName,
} from '../../../frontend/js/views/smartThreadsLayout.js';

const hex = (n, len = 40) => `0x${n.toString(16).padStart(len, '0')}`;
const W = (n) => hex(0xa000 + n); // alamat wallet fiktif
const C = (n) => hex(0xc000 + n); // alamat kontrak fiktif
const TX = (n) => hex(n, 64);

const buyer = (wallet, over = {}) => ({
  wallet, score: 70, clusterId: `ethereum:${wallet}`, netBuyUsd: 1000, buys: 1, sells: 0, firstBuyAt: 1_000, lastBuyAt: 2_000,
  txs: [{ txHash: TX(1), explorerUrl: `https://etherscan.io/tx/${TX(1)}`, type: 'SWAP_BUY', at: 2_000, usd: 1000, isSimulated: false }],
  label: null, ...over,
});

const token = (address, over = {}) => {
  const chain = over.chain ?? 'ethereum';
  return {
    tokenKey: `${chain}:${address}`, chain, token: { address, symbol: 'TKN', name: 'Token', decimals: 18 },
    buyers: [], buyerCount: 0, independentBuyers: 0, exitSignals: [], state: 'ACCUMULATING', conviction: 50,
    binance: { status: 'NOT_LISTED' }, isSimulated: false, ...over,
  };
};

const exit = (wallet, type, over = {}) => ({
  wallet, type, at: 3_000, usd: 500, txHash: TX(9), explorerUrl: `https://etherscan.io/tx/${TX(9)}`, isSimulated: false,
  via: type === 'CEX_DEPOSIT' ? 'CEX' : 'SWAP', note: type === 'CEX_DEPOSIT' ? 'dipindah ke exchange, belum tentu dijual' : 'dijual via swap', ...over,
});

/** Jumlah pasangan benang yang bersilangan (urutan y wallet berlawanan dengan urutan y token). */
function crossings(layout) {
  const wy = new Map(layout.wallets.map((w) => [w.id, w.y]));
  const ty = new Map(layout.tokens.map((t) => [t.id, t.y]));
  let n = 0;
  for (let i = 0; i < layout.strands.length; i += 1) {
    for (let j = i + 1; j < layout.strands.length; j += 1) {
      const a = layout.strands[i];
      const b = layout.strands[j];
      if ((wy.get(a.walletId) - wy.get(b.walletId)) * (ty.get(a.tokenId) - ty.get(b.tokenId)) < 0) n += 1;
    }
  }
  return n;
}

const deepFreeze = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
};

/** Pengacak deterministik (tanpa Math.random): rotasi + balik. */
const shuffle = (list) => [...list.slice(2), ...list.slice(0, 2)].reverse();

function sampleItems() {
  return [
    token(C(1), {
      token: { address: C(1), symbol: 'PEPE' }, conviction: 72, buyerCount: 3, independentBuyers: 2,
      buyers: [buyer(W(1), { score: 81, netBuyUsd: 50_000, clusterId: 'ethereum:k1' }), buyer(W(2), { score: 66, clusterId: 'ethereum:k1', netBuyUsd: null }),
        buyer(W(3), { score: 90, netBuyUsd: 12_000 })],
      exitSignals: [exit(W(4), 'CEX_DEPOSIT')],
    }),
    token(C(2), {
      token: { address: C(2), symbol: 'WIF' }, conviction: 64,
      buyers: [buyer(W(3), { score: 90, netBuyUsd: 8_000, sells: 1, buys: 2 }), buyer(W(5), { score: 55 })],
      exitSignals: [exit(W(3), 'SWAP_SELL', { usd: 300 })],
    }),
    token(C(3), { token: { address: C(3), symbol: 'BONK' }, conviction: 40, buyers: [buyer(W(6), { score: 77 }), buyer(W(1), { score: 81, clusterId: 'ethereum:k1' })] }),
  ];
}

describe('Peta Benang — tata letak', () => {
  it('UNIT-SM-THREADS-001 deterministik: masukan sama (atau urutan diacak) → keluaran identik; masukan tidak diubah', () => {
    const items = deepFreeze(sampleItems());
    const a = buildThreadsLayout(items);
    const b = buildThreadsLayout(items);
    expect(b).toEqual(a);
    // Urutan item & pembeli diacak → hasil sama persis (urutan ditentukan kunci, bukan urutan masukan).
    const shuffled = shuffle(sampleItems().map((t) => ({ ...t, buyers: [...t.buyers].reverse() })));
    expect(buildThreadsLayout(shuffled)).toEqual(a);
    expect(a.tokens.map((t) => t.symbol)).toEqual(['PEPE', 'WIF', 'BONK']);
    expect(a.strands.map((s) => s.id)).toEqual([...new Set(a.strands.map((s) => s.id))]);
  });

  it('UNIT-SM-THREADS-002 batas maxTokens/maxWallets + hitungan tersembunyi yang jujur', () => {
    // 15 token, masing-masing dua wallet unik → 30 wallet; skor menurun agar urutan potong jelas.
    const items = Array.from({ length: 15 }, (_, i) => token(C(100 + i), {
      conviction: 90 - i, buyers: [buyer(W(200 + 2 * i), { score: 99 - 2 * i }), buyer(W(201 + 2 * i), { score: 98 - 2 * i })],
    }));
    const def = buildThreadsLayout(items);
    expect(def.shown.tokens).toBe(12);
    expect(def.hidden.tokens).toBe(3);
    expect(def.totals).toEqual({ tokens: 15, wallets: 30 });
    expect(def.shown.wallets).toBe(24); // hanya wallet token tersimpan
    expect(def.hidden.wallets).toBe(6);
    expect(def.tokens.map((t) => t.conviction)).toEqual([90, 89, 88, 87, 86, 85, 84, 83, 82, 81, 80, 79]);

    const cut = buildThreadsLayout(items, { maxTokens: 4, maxWallets: 5 });
    expect(cut.shown).toEqual({ tokens: 4, wallets: 5, strands: 5 });
    expect(cut.hidden).toEqual({ tokens: 11, wallets: 25 });
    // Wallet teratas menurut skor terbaik.
    expect([...cut.wallets].sort((x, y) => y.score - x.score).map((w) => w.score)).toEqual([99, 98, 97, 96, 95]);
    // Token ke-3 kehilangan satu wallet, token ke-4 kehilangan keduanya (dilaporkan per token).
    expect(cut.tokens.map((t) => t.hiddenWallets)).toEqual([0, 0, 1, 2]);
    expect(threadsCountText(cut)).toBe('Menampilkan 4 dari 15 token · 5 dari 30 wallet');
    // Seri skor → alamat menang (urutan leksikografis).
    const tie = buildThreadsLayout([token(C(1), { buyers: [buyer(W(9), { score: 50 }), buyer(W(3), { score: 50 }), buyer(W(5), { score: 50 })] })], { maxWallets: 2 });
    expect(tie.wallets.map((w) => w.address).sort()).toEqual([W(3), W(5)]);
    // Batas tidak valid → bawaan.
    expect(buildThreadsLayout(items, { maxTokens: 0, maxWallets: -1 }).shown.tokens).toBe(12);
  });

  it('UNIT-SM-THREADS-003 wallet satu klaster berdampingan, ditandai satu kelompok (= 1 pembeli independen)', () => {
    // Tanpa klaster urutan barycenter: w1 (token 0), w2 (token 1), w3 (token 2). w1 & w3 satu klaster.
    const items = [
      token(C(1), { conviction: 90, buyers: [buyer(W(1), { score: 70, clusterId: 'ethereum:kx' })] }),
      token(C(2), { conviction: 80, buyers: [buyer(W(2), { score: 50 })] }),
      token(C(3), { conviction: 70, buyers: [buyer(W(3), { score: 60, clusterId: 'ethereum:kx' })] }),
    ];
    const l = buildThreadsLayout(items);
    expect(l.wallets.map((w) => w.address)).toEqual([W(1), W(3), W(2)]);
    expect(l.clusters).toHaveLength(1);
    const [k] = l.clusters;
    expect(k).toMatchObject({ id: 'K1', size: 2, totalSize: 2, chain: 'ethereum', clusterId: 'ethereum:kx', walletIds: [`ethereum:${W(1)}`, `ethereum:${W(3)}`] });
    expect(k.y1 - k.y0).toBeCloseTo(1, 9); // tepat berdampingan
    const [w1, w3, w2] = l.wallets;
    expect(w1.group).toBe('K1');
    expect(w3.group).toBe('K1');
    expect(w1.groupSize).toBe(2);
    expect(w2.group).toBeNull();
    expect(w2.y - w3.y).toBeGreaterThanOrEqual(1 + CLUSTER_GAP - 1e-9); // jarak kelompok
    expect(threadsSummaryLines(l).at(-1)).toBe('Klaster K1: 2 wallet terkait di Ethereum — dihitung sebagai 1 pembeli independen.');

    // Klaster dengan hanya satu wallet tampil: bukan kelompok, tetapi keterkaitannya tetap dilaporkan.
    const cut = buildThreadsLayout(items, { maxWallets: 1 });
    expect(cut.clusters).toHaveLength(0);
    const lone = cut.wallets.find((w) => w.address === W(1));
    expect(lone.group).toBeNull();
    expect(lone.linkedHidden).toBe(1);
  });

  it('UNIT-SM-THREADS-004 USD null → benang tipis putus-putus "nilai USD tidak diketahui"; tebal = skala log dijepit', () => {
    const l = buildThreadsLayout([token(C(1), {
      buyers: [buyer(W(1), { netBuyUsd: null }), buyer(W(2), { netBuyUsd: 100 }), buyer(W(3), { netBuyUsd: 100_000 }),
        buyer(W(4), { netBuyUsd: 5e9 }), buyer(W(5), { netBuyUsd: -100_000, sells: 3 })],
    })]);
    const by = Object.fromEntries(l.strands.map((s) => [s.wallet, s]));
    expect(by[W(1)]).toMatchObject({ usd: null, usdKnown: false, dashed: true, usdText: USD_UNKNOWN, width: STRAND_WIDTH.min, weight: null });
    expect(by[W(2)]).toMatchObject({ usdKnown: true, dashed: false, usdText: null });
    expect(by[W(2)].width).toBeGreaterThan(STRAND_WIDTH.min);
    expect(by[W(3)].width).toBeGreaterThan(by[W(2)].width);
    expect(by[W(4)].width).toBe(STRAND_WIDTH.max); // jenuh
    expect(by[W(5)].width).toBe(by[W(3)].width); // |net| — net negatif tidak menipiskan bukti
    expect(by[W(5)].usd).toBe(-100_000);
    expect(strandWidth(null)).toBe(STRAND_WIDTH.min);
    expect(strandWidth(0)).toBe(STRAND_WIDTH.min);
    expect(strandWeight(undefined)).toBeNull();
    expect(strandWeight(1_000_000)).toBe(1);
    expect(strandWidth(1_000)).toBeCloseTo(STRAND_WIDTH.min + (STRAND_WIDTH.max - STRAND_WIDTH.min) * (Math.log10(1001) / Math.log10(1_000_001)), 2);
  });

  it('UNIT-SM-THREADS-005 benang EXIT dari exitSignals: jual via swap vs dipindah ke exchange; beli+jual = mixed', () => {
    const l = buildThreadsLayout([token(C(1), {
      buyers: [buyer(W(1), { sells: 2, buys: 3 }), buyer(W(2))],
      exitSignals: [
        exit(W(1), 'SWAP_SELL'),
        exit(W(2), 'CEX_DEPOSIT'),
        exit(W(3), 'SWAP_SELL', { usd: 400 }),
        exit(W(3), 'FULL_EXIT', { usd: 400, via: 'SWAP', note: 'kepemilikan turun ≥ 90% — dijual via swap' }),
        exit(W(4), 'CEX_DEPOSIT', { usd: null }),
        exit(W(5), 'SWAP_SELL', { usd: 100 }),
        exit(W(5), 'CEX_DEPOSIT', { usd: 50 }),
      ],
    })]);
    const by = Object.fromEntries(l.strands.map((s) => [s.wallet, s]));
    expect(l.strands).toHaveLength(5); // satu benang per (wallet, token), walau ada beberapa peristiwa
    expect(by[W(1)]).toMatchObject({ kind: 'BUY', mixed: true, hasExit: true, exitVia: 'SWAP' });
    // Deposit ke exchange BUKAN penjualan: pembeli tetap BUY, tidak mixed, tetapi ada indikasi keluar.
    expect(by[W(2)]).toMatchObject({ kind: 'BUY', mixed: false, hasExit: true, exitVia: 'CEX', deposits: 1, sells: 0 });
    // FULL_EXIT tidak dijumlah ganda dengan SWAP_SELL yang sama.
    expect(by[W(3)]).toMatchObject({ kind: 'EXIT', exitVia: 'SWAP', fullExit: true, usd: 400, sells: 1, buys: 0, mixed: false });
    expect(by[W(4)]).toMatchObject({ kind: 'EXIT', exitVia: 'CEX', usd: null, dashed: true, deposits: 1, sells: 0 });
    expect(by[W(5)]).toMatchObject({ kind: 'EXIT', exitVia: 'MIXED', usd: 150 });
    // Wallet hanya-keluar tidak punya skor → diurutkan setelah wallet berskor saat dipotong.
    expect(l.wallets.find((w) => w.address === W(3)).score).toBeNull();
    const cut = buildThreadsLayout([token(C(1), { buyers: [buyer(W(9), { score: 10 })], exitSignals: [exit(W(1), 'SWAP_SELL')] })], { maxWallets: 1 });
    expect(cut.wallets.map((w) => w.address)).toEqual([W(9)]);
    expect(cut.tokens[0]).toMatchObject({ buyStrands: 1, exitStrands: 0, hiddenWallets: 1 });
  });

  it('UNIT-SM-THREADS-006 alamat sama di dua chain = dua node wallet; alamat EVM beda huruf = satu wallet', () => {
    const same = W(7);
    const l = buildThreadsLayout([
      token(C(1), { chain: 'ethereum', conviction: 60, buyers: [buyer(same)] }),
      token(C(1), { chain: 'base', conviction: 50, buyers: [buyer(same.toUpperCase().replace('0X', '0x'), { clusterId: `base:${same}` })] }),
    ]);
    expect(l.tokens.map((t) => t.id)).toEqual([`ethereum:${C(1)}`, `base:${C(1)}`]); // kontrak sama, chain beda = dua token
    expect(l.wallets.map((w) => w.id).sort()).toEqual([`base:${same}`, `ethereum:${same}`]);
    for (const s of l.strands) expect(s.tokenId.split(':')[0]).toBe(s.walletId.split(':')[0]); // benang tidak lintas chain
    expect(l.totals.wallets).toBe(2);
    const mixedCase = buildThreadsLayout([token(C(1), { buyers: [buyer(W(8)), buyer(W(8).toUpperCase().replace('0X', '0x'))] })]);
    expect(mixedCase.wallets).toHaveLength(1);
  });

  it('UNIT-SM-THREADS-007 simbol sama, kontrak berbeda = dua node token yang dibedakan kontraknya', () => {
    const l = buildThreadsLayout([
      token(C(1), { token: { address: C(1), symbol: 'PEPE' }, conviction: 70, buyers: [buyer(W(1))] }),
      token(C(2), { token: { address: C(2), symbol: 'pepe' }, conviction: 60, buyers: [buyer(W(1))] }),
      token(C(3), { token: { address: C(3), symbol: 'WIF' }, conviction: 50, buyers: [buyer(W(2))] }),
    ]);
    expect(l.tokens).toHaveLength(3);
    const [p1, p2, wif] = l.tokens;
    expect(p1.id).not.toBe(p2.id);
    expect(p1.symbolShared).toBe(true);
    expect(p2.symbolShared).toBe(true);
    expect(wif.symbolShared).toBe(false);
    expect(tokenDisplayName(p1)).toBe(`PEPE (${C(1).slice(0, 6)}…${C(1).slice(-4)})`);
    expect(tokenDisplayName(p1, { compact: true })).toBe(`PEPE·${C(1).slice(-4)}`);
    expect(tokenDisplayName(wif)).toBe('WIF');
    // Satu wallet membeli keduanya → dua benang terpisah.
    expect(l.strands.filter((s) => s.wallet === W(1)).map((s) => s.tokenId)).toEqual([p1.id, p2.id]);
  });

  it('UNIT-SM-THREADS-008 masukan kosong/rusak → tata letak kosong tanpa melempar', () => {
    for (const input of [[], null, undefined, 'x', [null, 1, 'a', {}, { chain: 'ethereum' }, { tokenKey: '' }]]) {
      const l = buildThreadsLayout(input);
      expect(l.tokens).toEqual([]);
      expect(l.wallets).toEqual([]);
      expect(l.strands).toEqual([]);
      expect(l.clusters).toEqual([]);
      expect(l.shown).toEqual({ tokens: 0, wallets: 0, strands: 0 });
      expect(l.hidden).toEqual({ tokens: 0, wallets: 0 });
      expect(l.isSimulated).toBe(false);
      expect(l.height).toBe(1);
    }
    // Pembeli/peristiwa rusak dilewati, token tetap.
    const l = buildThreadsLayout([token(C(1), { buyers: [null, { score: 9 }, buyer(W(1))], exitSignals: [null, { type: 'SWAP_SELL' }] })]);
    expect(l.wallets).toHaveLength(1);
    expect(l.strands).toHaveLength(1);
  });

  it('UNIT-SM-THREADS-009 urutan: token menurut keyakinan lalu tokenKey; wallet menurut barycenter (tanpa persilangan), seri → skor → kunci', () => {
    const items = [
      token(C(5), { conviction: 10, buyers: [buyer(W(1), { score: 99 })] }),
      token(C(4), { conviction: 90, buyers: [buyer(W(2), { score: 10 })] }),
      token(C(3), { conviction: 90, buyers: [buyer(W(3), { score: 50 })] }),
      token(C(2), { conviction: null, buyers: [buyer(W(4), { score: 50 })] }),
    ];
    const l = buildThreadsLayout(items);
    expect(l.tokens.map((t) => t.address)).toEqual([C(3), C(4), C(5), C(2)]); // seri keyakinan → tokenKey; null terakhir
    expect(l.tokens.at(-1).conviction).toBeNull();
    // Skor tertinggi (W1) terhubung ke token paling bawah → tetap di bawah, bukan di atas: benang tidak bersilangan.
    expect(l.wallets.map((w) => w.address)).toEqual([W(3), W(2), W(1), W(4)]);
    expect(crossings(l)).toBe(0);

    // Seri barycenter → skor turun, lalu kunci.
    const tie = buildThreadsLayout([token(C(1), { buyers: [buyer(W(3), { score: 40 }), buyer(W(2), { score: 80 }), buyer(W(1), { score: 40 })] })]);
    expect(tie.wallets.map((w) => w.address)).toEqual([W(2), W(1), W(3)]);

    // Graf lebih besar: barycenter menghasilkan lebih sedikit persilangan daripada urutan skor.
    const big = Array.from({ length: 6 }, (_, i) => token(C(10 + i), {
      conviction: 90 - i * 10,
      buyers: Array.from({ length: 3 }, (__, k) => buyer(W(100 + ((i * 3 + k) % 7)), { score: 30 + ((i * 3 + k) % 7) * 9 })),
    }));
    const lb = buildThreadsLayout(big);
    const byScore = { ...lb, wallets: [...lb.wallets].sort((x, y) => y.score - x.score).map((w, i) => ({ ...w, y: i })) };
    expect(crossings(lb)).toBeLessThan(crossings(byScore));
  });

  it('UNIT-SM-THREADS-010 posisi y: dalam batas, jarak wallet ≥ 1 slot, token berjarak rata', () => {
    const items = Array.from({ length: 5 }, (_, i) => token(C(i + 1), {
      conviction: 80 - i,
      buyers: Array.from({ length: 4 }, (__, k) => buyer(W(i * 4 + k), { score: 50 + k, clusterId: k < 2 ? `ethereum:c${i}` : `ethereum:${W(i * 4 + k)}` })),
    }));
    const l = buildThreadsLayout(items);
    expect(l.height).toBeGreaterThanOrEqual(l.tokens.length * TOKEN_SLOT);
    for (const w of l.wallets) {
      expect(w.y).toBeGreaterThanOrEqual(0.5 - 1e-9);
      expect(w.y).toBeLessThanOrEqual(l.height - 0.5 + 1e-9);
    }
    for (let i = 1; i < l.wallets.length; i += 1) expect(l.wallets[i].y - l.wallets[i - 1].y).toBeGreaterThanOrEqual(1 - 1e-9);
    const gaps = l.tokens.slice(1).map((t, i) => t.y - l.tokens[i].y);
    for (const g of gaps) expect(g).toBeCloseTo(l.height / l.tokens.length, 3);
    expect(l.wallets.map((w) => w.index)).toEqual(l.wallets.map((_, i) => i));
    expect(l.clusters).toHaveLength(5);
  });

  it('UNIT-SM-THREADS-011 isSimulated per benang: token simulasi → semua benangnya; tx simulasi → benang itu saja', () => {
    const l = buildThreadsLayout([
      token(C(1), { conviction: 80, isSimulated: true, buyers: [buyer(W(1)), buyer(W(2))] }),
      token(C(2), {
        conviction: 70,
        buyers: [buyer(W(3), { txs: [{ txHash: TX(5), type: 'SWAP_BUY', at: 1, usd: 1, isSimulated: true }] }), buyer(W(4))],
        exitSignals: [exit(W(5), 'SWAP_SELL', { isSimulated: true })],
      }),
    ]);
    const sim = Object.fromEntries(l.strands.map((s) => [s.wallet, s.isSimulated]));
    expect(sim).toEqual({ [W(1)]: true, [W(2)]: true, [W(3)]: true, [W(4)]: false, [W(5)]: true });
    expect(l.isSimulated).toBe(true);
    expect(buildThreadsLayout([token(C(9), { buyers: [buyer(W(9))] })]).isSimulated).toBe(false);
  });

  it('UNIT-SM-THREADS-012 tampilan radar di hash: ?view=benang dapat ditautkan, parameter filter dipertahankan', () => {
    const q = (s) => new URLSearchParams(s);
    expect(parseRadarView(q('view=benang'))).toBe('benang');
    expect(parseRadarView(q('view=daftar'))).toBe('daftar');
    expect(parseRadarView(q('view=<x>'))).toBe('daftar');
    expect(parseRadarView(q(''))).toBe('daftar');
    expect(parseRadarView(null)).toBe('daftar');
    expect(radarViewHash('#/smart-money', 'benang')).toBe('#/smart-money?view=benang');
    expect(radarViewHash('#/smart-money?window=4h&chain=base', 'benang')).toBe('#/smart-money?window=4h&chain=base&view=benang');
    expect(radarViewHash('#/smart-money?window=4h&view=benang', 'daftar')).toBe('#/smart-money?window=4h');
    expect(radarViewHash('#/smart-money?view=benang', 'daftar')).toBe('#/smart-money');
    expect(radarViewHash('', 'benang')).toBe('#/smart-money?view=benang');
  });

  it('UNIT-SM-THREADS-013 ringkasan teks (pembaca layar): keyakinan bukan probabilitas, wallet tersembunyi disebut', () => {
    const l = buildThreadsLayout([token(C(1), {
      token: { address: C(1), symbol: 'PEPE' }, conviction: 64, state: 'MIXED',
      buyers: [buyer(W(1)), buyer(W(2))], exitSignals: [exit(W(3), 'CEX_DEPOSIT')],
    })], { maxWallets: 2 });
    const lines = threadsSummaryLines(l);
    expect(lines[0]).toBe('Peta Benang: 1 token, 2 wallet, 2 benang. Menampilkan 1 dari 1 token · 2 dari 3 wallet.');
    expect(lines[1]).toBe(`PEPE (Ethereum, kontrak ${C(1).slice(0, 6)}…${C(1).slice(-4)}): skor keyakinan 64 dari 100 (bukan probabilitas), status Campuran; 2 wallet membeli lewat swap, 1 wallet tidak ditampilkan.`);
  });
});
