// Sensitivitas pengecualian pembanding (docs/25 §2.2): mask kandidat pembanding per varian.
import { describe, expect, it } from 'vitest';
import { MATCH_DEFAULTS } from '../../../backend/research/matchedBaseline.js';
import { EXCLUSION_VARIANTS, exclusionMask } from '../../../scripts/research-matched-exclusion.js';

const on = (mask) => [...mask].flatMap((v, k) => (v ? [k] : []));

describe('research-matched-exclusion', () => {
  it('UNIT-MEX-001 exclusionMask: e − before … e + after, dipotong di tepi, gabungan beberapa alert', () => {
    expect(on(exclusionMask(10, [5], { before: 2, after: 1 }))).toEqual([3, 4, 5, 6]);
    expect(on(exclusionMask(10, [1, 8], { before: 2, after: 2 }))).toEqual([0, 1, 2, 3, 6, 7, 8, 9]);
    expect(on(exclusionMask(10, [4], { before: 0, after: 0 }))).toEqual([4]);
    expect(on(exclusionMask(5, [], { before: 3, after: 3 }))).toEqual([]);
  });

  it('UNIT-MEX-002 varian: simetris = desain terkunci (±exclusion); lampau & tanpa hanya memakai masa lalu', () => {
    const byKey = Object.fromEntries(EXCLUSION_VARIANTS.map((v) => [v.key, v]));
    expect(byKey.simetris).toMatchObject({ before: MATCH_DEFAULTS.exclusion, after: MATCH_DEFAULTS.exclusion });
    expect(byKey.lampau).toMatchObject({ before: 0, after: MATCH_DEFAULTS.exclusion });
    expect(byKey.tanpa).toMatchObject({ before: 0, after: 0 });
    // Candle tepat sebelum alert: dikeluarkan desain terkunci (memakai masa depan), dipertahankan varian kausal.
    const e = 20;
    for (const v of EXCLUSION_VARIANTS) expect(exclusionMask(40, [e], v)[e - 1]).toBe(v.key === 'simetris' ? 1 : 0);
  });
});
