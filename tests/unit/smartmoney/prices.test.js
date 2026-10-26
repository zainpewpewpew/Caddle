import { describe, expect, it } from 'vitest';
import { tokenKey } from '../../../backend/smartmoney/contracts.js';
import { DEFAULT_MAX_STALENESS_MS, IMPLIED_PRICE_SOURCE, buildImpliedPriceIndex } from '../../../backend/smartmoney/prices.js';
import { CHAIN, HOUR, T0, addr, shuffled, swap, tokenAddr } from './evaluationFixtures.js';

const A = tokenAddr(1);
const B = tokenAddr(2);
const KA = tokenKey(CHAIN, A);
const KB = tokenKey(CHAIN, B);
const W = addr(1);
const MIN = 60_000;

/** Swap token `token` berharga `price` USD/unit pada `at` (1000 unit). */
const px = (token, at, price, n, type = 'SWAP_BUY') => swap({ wallet: W, token, at, n, usd: price * 1000, amount: 1000, type });

describe('buildImpliedPriceIndex — sumber observasi', () => {
  it('UNIT-SM-PRC-001 harga = usdValue / amount hanya dari SWAP_BUY/SWAP_SELL ber-USD; jenis lain diabaikan', () => {
    const acts = [
      px(A, T0, 0.5, 1),
      swap({ wallet: W, token: A, at: T0 + MIN, n: 2, usd: 99_999, type: 'TRANSFER_IN' }),
      swap({ wallet: W, token: A, at: T0 + MIN, n: 3, usd: 99_999, type: 'CEX_WITHDRAWAL' }),
      swap({ wallet: W, token: A, at: T0 + MIN, n: 4, usd: 99_999, type: 'AIRDROP' }),
      swap({ wallet: W, token: A, at: T0 + MIN, n: 5, usd: null }),
      swap({ wallet: W, token: A, at: T0 + MIN, n: 6, usd: 0 }),
      swap({ wallet: W, token: A, at: T0 + MIN, n: 7, usd: 500, amount: 0 }),
      px(A, T0 + 2 * MIN, 0.6, 8, 'SWAP_SELL'),
    ];
    const idx = buildImpliedPriceIndex(acts);
    expect(idx.priceAt(KA, T0)).toBe(0.5);
    expect(idx.priceAt(KA, T0 + 90_000)).toBe(0.5); // transfer/airdrop/penarikan exchange di +1 menit bukan harga
    expect(idx.priceAt(KA, T0 + 2 * MIN)).toBeCloseTo(0.6, 12);
    expect(idx.observationAt(KA, T0 + 3 * MIN)).toEqual({ priceUsd: 0.6, at: T0 + 2 * MIN, source: IMPLIED_PRICE_SOURCE });
    expect(idx.priceAt(KB, T0 + 3 * MIN)).toBeNull(); // token tanpa observasi
    expect(idx.priceAt('ethereum:0xtidak-ada', T0)).toBeNull();
  });

  it('UNIT-SM-PRC-002 hanya observasi ≤ t; null sebelum observasi pertama; kedaluwarsa → null (batas inklusif)', () => {
    const acts = [px(A, T0, 1, 1)];
    const idx = buildImpliedPriceIndex(acts, { maxStalenessMs: HOUR });
    expect(idx.priceAt(KA, T0 - 1)).toBeNull();
    expect(idx.priceAt(KA, T0)).toBe(1);
    expect(idx.priceAt(KA, T0 + HOUR)).toBe(1);
    expect(idx.priceAt(KA, T0 + HOUR + 1)).toBeNull(); // harga lama tidak dipakai diam-diam
    const byDefault = buildImpliedPriceIndex(acts);
    expect(DEFAULT_MAX_STALENESS_MS).toBe(HOUR);
    expect(byDefault.priceAt(KA, T0 + DEFAULT_MAX_STALENESS_MS + 1)).toBeNull();
    expect(buildImpliedPriceIndex(acts, { maxStalenessMs: Infinity }).priceAt(KA, T0 + 1000 * HOUR)).toBe(1);
  });

  it('UNIT-SM-PRC-003 median observasi pada detik yang sama meredam pencilan (hanya yang ≤ t)', () => {
    const sameMs = buildImpliedPriceIndex([px(A, T0, 1, 1), px(A, T0, 1.02, 2), px(A, T0, 50, 3)]);
    expect(sameMs.priceAt(KA, T0)).toBeCloseTo(1.02, 12);

    const spread = buildImpliedPriceIndex([
      px(A, T0 + 100, 1, 1), px(A, T0 + 200, 1.02, 2), px(A, T0 + 300, 50, 3), px(A, T0 + 1000, 2, 4),
    ]);
    expect(spread.priceAt(KA, T0 + 150)).toBe(1);
    expect(spread.priceAt(KA, T0 + 250)).toBeCloseTo(1.01, 12); // median(1, 1,02) — pencilan +300 ms belum terjadi
    expect(spread.priceAt(KA, T0 + 999)).toBeCloseTo(1.02, 12); // median(1, 1,02, 50)
    expect(spread.observationAt(KA, T0 + 999).at).toBe(T0 + 300);
    expect(spread.priceAt(KA, T0 + 1000)).toBe(2); // detik baru tidak dicampur dengan detik sebelumnya
  });
});

describe('buildImpliedPriceIndex — tanpa look-ahead', () => {
  it('UNIT-SM-PRC-004 KEBOCORAN: observasi setelah t (termasuk di detik yang sama) tidak pernah mengubah harga di t', () => {
    const acts = [];
    for (let i = 0; i < 40; i += 1) {
      acts.push(px(A, T0 + i * 15 * MIN, 1 + (i % 7) / 10, 100 + i));
      acts.push(px(B, T0 + i * 15 * MIN + 500, 3 - (i % 5) / 10, 200 + i, 'SWAP_SELL'));
    }
    const full = buildImpliedPriceIndex(acts, { maxStalenessMs: 2 * HOUR });
    for (const cut of [T0 + HOUR, T0 + 3 * HOUR + 7 * MIN, T0 + 8 * HOUR + 500]) {
      const past = buildImpliedPriceIndex(acts.filter((a) => a.blockTime <= cut), { maxStalenessMs: 2 * HOUR });
      const future = [
        px(A, cut + 1, 1000, 900), px(B, cut + 1, 0.0001, 901), px(A, cut + 400, 1000, 902), px(A, cut + HOUR, 1000, 903),
      ];
      const poisoned = buildImpliedPriceIndex([...acts, ...future], { maxStalenessMs: 2 * HOUR });
      for (const t of [cut - 30 * MIN, cut - 1, cut]) {
        for (const key of [KA, KB]) {
          expect(full.priceAt(key, t)).toBe(past.priceAt(key, t));
          expect(poisoned.priceAt(key, t)).toBe(past.priceAt(key, t));
        }
        expect(poisoned.pricesAt(t)).toEqual(past.pricesAt(t));
      }
    }
  });
});

describe('buildImpliedPriceIndex — keluaran & ketahanan', () => {
  it('UNIT-SM-PRC-005 pricesAt(t): Map terurut per tokenKey (bentuk `prices` PnL); simbol sama ≠ token sama', () => {
    const pepe = (address) => ({ address, symbol: 'PEPE', name: null, decimals: 18 });
    const acts = [
      swap({ wallet: W, token: pepe(A), at: T0, n: 1, usd: 1000, amount: 1000 }),
      swap({ wallet: W, token: pepe(B), at: T0 + 2 * HOUR, n: 2, usd: 5, amount: 1000 }),
    ];
    const idx = buildImpliedPriceIndex(acts, { maxStalenessMs: 3 * HOUR });
    const at = idx.pricesAt(T0 + 2 * HOUR);
    expect([...at.keys()]).toEqual([KA, KB].sort());
    expect(at.get(KA)).toEqual({ priceUsd: 1, at: T0, source: 'implied-swap' });
    expect(at.get(KB)).toEqual({ priceUsd: 0.005, at: T0 + 2 * HOUR, source: 'implied-swap' });
    expect([...idx.pricesAt(T0 + 4 * HOUR).keys()]).toEqual([KB]); // A sudah kedaluwarsa
    expect(idx.pricesAt(T0 - 1).size).toBe(0);
  });

  it('UNIT-SM-PRC-006 duplikat Activity.id dihitung sekali; urutan masukan tidak berpengaruh', () => {
    const outlier = px(A, T0, 50, 1);
    const acts = [outlier, outlier, { ...outlier }, px(A, T0, 1, 2), px(A, T0, 1, 3), px(A, T0 + HOUR, 2, 4)];
    const idx = buildImpliedPriceIndex(acts, { maxStalenessMs: 2 * HOUR });
    expect(idx.priceAt(KA, T0)).toBe(1); // median(50, 1, 1), bukan median(50, 50, 50, 1, 1)
    const reordered = buildImpliedPriceIndex(shuffled(acts, 3), { maxStalenessMs: 2 * HOUR });
    for (const t of [T0, T0 + 30 * MIN, T0 + HOUR, T0 + 2 * HOUR]) expect(reordered.priceAt(KA, t)).toBe(idx.priceAt(KA, t));
  });

  it('UNIT-SM-PRC-007 masukan tidak valid ditolak dengan pesan Bahasa Indonesia', () => {
    expect(() => buildImpliedPriceIndex('bukan array')).toThrow(TypeError);
    expect(() => buildImpliedPriceIndex([], { maxStalenessMs: -1 })).toThrow(RangeError);
    expect(() => buildImpliedPriceIndex([], { maxStalenessMs: Number.NaN })).toThrow(/maxStalenessMs/);
    const idx = buildImpliedPriceIndex([px(A, T0, 1, 1), null, { type: 'SWAP_BUY' }]);
    expect(() => idx.priceAt(KA, Number.NaN)).toThrow(/epoch ms/);
    expect(() => idx.priceAt(KA, String(T0))).toThrow(TypeError);
    expect(idx.priceAt(KA, T0)).toBe(1);
  });
});
