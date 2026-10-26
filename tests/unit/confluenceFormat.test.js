import { describe, expect, it } from 'vitest';
import {
  confluenceBreakdown, confluenceFieldsOf, confluenceValue, formatWinProbability, meetsMinTier, normalizeTier, tierRank,
} from '../../frontend/js/views/signalFormat.js';

describe('format konfluensi & tier (frontend)', () => {
  it('UNIT-CNF-001 tier dinormalisasi; nilai lama/tidak valid → null', () => {
    expect(normalizeTier('A')).toBe('A');
    expect(normalizeTier(' b ')).toBe('B');
    for (const v of [undefined, null, '', 'E', 'AA', 3, {}]) expect(normalizeTier(v)).toBeNull();
    expect([tierRank('A'), tierRank('B'), tierRank('C'), tierRank('D'), tierRank(undefined)]).toEqual([4, 3, 2, 1, null]);
  });

  it('UNIT-CNF-002 meetsMinTier: tanpa minimum selalu lolos; baris tanpa tier tidak memenuhi minimum', () => {
    expect(meetsMinTier(undefined, '')).toBe(true);
    expect(meetsMinTier('D', undefined)).toBe(true);
    expect(meetsMinTier('A', 'B')).toBe(true);
    expect(meetsMinTier('B', 'B')).toBe(true);
    expect(meetsMinTier('C', 'B')).toBe(false);
    expect(meetsMinTier(undefined, 'D')).toBe(false);
    expect(meetsMinTier('A', 'X')).toBe(true);
  });

  it('UNIT-CNF-003 probabilitas menang hanya bila terkalibrasi (0..1); selain itu null, bukan placeholder', () => {
    expect(formatWinProbability(0.624)).toBe('62%');
    expect(formatWinProbability(0)).toBe('0%');
    expect(formatWinProbability(1)).toBe('100%');
    for (const v of [null, undefined, NaN, -0.1, 1.2, '0.5']) expect(formatWinProbability(v)).toBeNull();
  });

  it('UNIT-CNF-004 skor konfluensi dibulatkan & dijepit; non-angka → null', () => {
    expect(confluenceValue(71.6)).toBe(72);
    expect(confluenceValue(140)).toBe(100);
    expect(confluenceValue(-3)).toBe(0);
    expect(confluenceValue(undefined)).toBeNull();
    expect(confluenceValue('80')).toBeNull();
  });

  it('UNIT-CNF-005 confluenceBreakdown memilah komponen, konfirmasi, konflik, dan tier', () => {
    const out = confluenceBreakdown([
      { factor: 'PATTERN:SA', contribution: 30, detail: 'bukan konfluensi' },
      { factor: 'CONFLUENCE:TIER', contribution: 0, detail: 'Tier A' },
      { factor: 'CONFLUENCE:pattern', contribution: 25, detail: 'SA kuat' },
      { factor: 'CONFLUENCE:htf', contribution: 15 },
      { factor: 'CONFLUENCE:orderFlow', contribution: 'x', detail: '' },
      { factor: 'CONFLUENCE:custom', contribution: 4 },
      { factor: 'CONFLUENCE:CONFIRM', contribution: 5, detail: 'Volume naik' },
      { factor: 'CONFLUENCE:CONFLICT', contribution: -8, detail: 'HTF turun' },
      { factor: 'CONFLUENCE:' },
      null,
    ]);
    expect(out.tier).toEqual({ detail: 'Tier A' });
    expect(out.components).toEqual([
      { name: 'pattern', label: 'Pola', contribution: 25, detail: 'SA kuat' },
      { name: 'htf', label: 'Timeframe lebih tinggi', contribution: 15, detail: null },
      { name: 'orderFlow', label: 'Order flow', contribution: null, detail: null },
      { name: 'custom', label: 'custom', contribution: 4, detail: null },
    ]);
    expect(out.confirms).toEqual([{ contribution: 5, detail: 'Volume naik' }]);
    expect(out.conflicts).toEqual([{ contribution: -8, detail: 'HTF turun' }]);
  });

  it('UNIT-CNF-006 explanation kosong/lama → hasil kosong; kolom hanya bila data membawanya', () => {
    expect(confluenceBreakdown(undefined)).toEqual({ components: [], confirms: [], conflicts: [], tier: null });
    expect(confluenceFieldsOf([{ symbol: 'A' }, { symbol: 'B', winProbability: null }])).toEqual({ tier: false, score: false, winProbability: false });
    expect(confluenceFieldsOf([{ confidenceTier: 'B' }, { confluenceScore: 64 }])).toEqual({ tier: true, score: true, winProbability: false });
    expect(confluenceFieldsOf([{ winProbability: 0.55 }]).winProbability).toBe(true);
    expect(confluenceFieldsOf(null)).toEqual({ tier: false, score: false, winProbability: false });
  });
});
