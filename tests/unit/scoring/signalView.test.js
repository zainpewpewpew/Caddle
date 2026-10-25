import { describe, expect, it } from 'vitest';
import { RISK_FLAGS } from '../../../backend/market/contracts.js';
import { DEFAULT_VIEW_PARAMS, buildSignalView, selectScores } from '../../../backend/scoring/index.js';

// PatternResult palsu sesuai kontrak docs/07 §6 (modul patterns dikerjakan paralel).
function result(pattern, overrides = {}) {
  return {
    pattern, version: 1, detected: true, patternScore: 75, earlyScore: 60,
    conditions: [
      { id: 'flat_range', label: 'Rentang harga sempit', passed: true, value: 0.012, threshold: 0.02, weight: 2 },
      { id: 'volume_rise', label: 'Volume naik bertahap', passed: true, value: 1.4, threshold: 1.2, weight: 1 },
      { id: 'higher_lows', label: 'Higher low berurutan', passed: false, value: 1, threshold: 2, weight: 1 },
    ],
    invalidationPrice: 95, evaluatedAt: 1_767_607_499_999, riskFlags: [], insufficientData: false,
    ...overrides,
  };
}
const view = (over = {}) => buildSignalView({
  symbol: 'SOLUSDT', timeframe: '5m',
  patterns: { classification: 'SA', sa: result('SA'), pva: result('PVA', { detected: false, patternScore: 30, earlyScore: 20 }) },
  context: { alignment: 'ALIGNED', trends: { '5m': { trend: 'NEUTRAL' }, '15m': { trend: 'BULLISH' }, '1h': { trend: 'BULLISH' } } },
  liquidity: { quoteVolume24h: 120_000_000, spreadBps: 2 },
  dataQuality: { ok: true, issues: [] },
  ...over,
});
const sum = (entries, prefix) => entries.filter((e) => e.factor.startsWith(prefix)).reduce((a, e) => a + e.contribution, 0);

describe('signal view & penjelasan skor', () => {
  it('POS-SVW-001 skor dari pola sesuai klasifikasi dan dapat dijelaskan per kondisi', () => {
    const v = view();
    expect(v.patternScore).toBe(75);
    expect(v.earlyScore).toBe(60);
    expect(v.riskFlags).toEqual([]);
    const sa = v.explanation.filter((e) => e.factor.startsWith('PATTERN:SA:'));
    expect(sa.map((e) => e.factor)).toEqual(['PATTERN:SA:flat_range', 'PATTERN:SA:volume_rise', 'PATTERN:SA:higher_lows']);
    expect(sa[0].contribution).toBeCloseTo(50, 9); // bobot 2 dari 4
    expect(sa[2].contribution).toBe(0); // kondisi gagal tidak berkontribusi
    expect(sa[2].detail).toMatch(/tidak memenuhi/);
    // Bobot lolos = 75 → tidak ada residual.
    expect(v.explanation.some((e) => e.factor === 'PATTERN:SA:RESIDUAL')).toBe(false);
    expect(sum(v.explanation, 'PATTERN:')).toBeCloseTo(v.patternScore, 9);
    expect(sum(v.explanation, 'EARLY:')).toBeCloseTo(v.earlyScore, 9);
  });

  it('UNIT-SVW-001 setiap entri penjelasan berbentuk { factor, contribution, detail } dan skor bukan probabilitas', () => {
    const v = view();
    for (const e of v.explanation) {
      expect(Object.keys(e).sort()).toEqual(['contribution', 'detail', 'factor']);
      expect(typeof e.detail).toBe('string');
      expect(Number.isFinite(e.contribution)).toBe(true);
    }
    expect(JSON.stringify(v)).not.toMatch(/probab/i);
    // Konteks & risiko hanya informatif: kontribusinya nol.
    expect(sum(v.explanation, 'CONTEXT:')).toBe(0);
    expect(v.explanation.find((e) => e.factor === 'CONTEXT:ALIGNMENT').detail).toMatch(/15m BULLISH/);
  });

  it('UNIT-SVW-002 skor detektor yang tidak sama dengan bobot lolos dijelaskan lewat RESIDUAL', () => {
    const v = view({ patterns: { classification: 'SA', sa: result('SA', { patternScore: 70 }), pva: null } });
    const residual = v.explanation.find((e) => e.factor === 'PATTERN:SA:RESIDUAL');
    expect(residual.contribution).toBeCloseTo(-5, 9);
    expect(sum(v.explanation, 'PATTERN:')).toBeCloseTo(70, 9);
  });

  it('UNIT-SVW-003 BOTH → skor maksimum SA/PVA, sumber dicatat di PATTERN:SELECTION', () => {
    const v = view({ patterns: { classification: 'BOTH', sa: result('SA', { patternScore: 62, earlyScore: 80 }), pva: result('PVA', { patternScore: 88, earlyScore: 40 }) } });
    expect(v.patternScore).toBe(88);
    expect(v.earlyScore).toBe(80);
    expect(v.explanation.find((e) => e.factor === 'PATTERN:SELECTION').detail).toMatch(/PVA/);
    expect(v.explanation.some((e) => e.factor.startsWith('PATTERN:PVA:'))).toBe(true);
    expect(v.explanation.some((e) => e.factor.startsWith('PATTERN:SA:'))).toBe(false);
    expect(v.explanation.find((e) => e.factor.startsWith('EARLY:')).factor).toBe('EARLY:SA');
    expect(sum(v.explanation, 'PATTERN:')).toBeCloseTo(88, 9);
    expect(selectScores({ classification: 'PVA', sa: result('SA', { patternScore: 99 }), pva: result('PVA', { patternScore: 41 }) }).patternScore).toBe(41);
  });

  it('UNIT-SVW-004 NONE → skor diagnostik maksimum dari hasil yang tersedia', () => {
    const s = selectScores({ classification: 'NONE', sa: result('SA', { detected: false, patternScore: 35, earlyScore: 10 }), pva: undefined });
    expect(s).toMatchObject({ patternScore: 35, earlyScore: 10, patternSource: 'SA' });
    expect(selectScores({ classification: 'NONE', sa: null, pva: null })).toMatchObject({ patternScore: 0, earlyScore: 0, patternSource: null });
  });

  it('POS-SVW-002 risk flag gabungan: pola + COUNTERTREND_HTF + likuiditas + spread + kualitas data', () => {
    const v = view({
      patterns: { classification: 'BOTH', sa: result('SA', { riskFlags: ['EXTENDED_PRICE'] }), pva: result('PVA', { riskFlags: ['EXCESSIVE_VOLATILITY', 'EXTENDED_PRICE'] }) },
      context: { alignment: 'COUNTERTREND', trends: { '15m': { trend: 'BEARISH' }, '1h': { trend: 'NEUTRAL' } } },
      liquidity: { quoteVolume24h: 1_000_000, spreadBps: 25 },
      dataQuality: { ok: false, issues: ['GAP_DETECTED'] },
    });
    expect(v.riskFlags).toEqual(['POOR_LIQUIDITY', 'WIDE_SPREAD', 'EXCESSIVE_VOLATILITY', 'COUNTERTREND_HTF', 'EXTENDED_PRICE', 'DATA_QUALITY']);
    expect(v.riskFlags.every((f) => RISK_FLAGS.includes(f))).toBe(true);
    expect(v.explanation.find((e) => e.factor === 'RISK:COUNTERTREND_HTF').detail).toMatch(/15m/);
    expect(v.explanation.find((e) => e.factor === 'RISK:DATA_QUALITY').detail).toMatch(/GAP_DETECTED/);
    expect(v.explanation.find((e) => e.factor === 'RISK:EXTENDED_PRICE').detail).toMatch(/SA, PVA/);
    // Risiko tidak mengubah skor pola.
    expect(v.patternScore).toBe(75);
  });

  it('EDGE-SVW-001 tepat di batas likuiditas/spread tidak ditandai', () => {
    const v = view({ liquidity: { quoteVolume24h: DEFAULT_VIEW_PARAMS.minQuoteVolume24h, spreadBps: DEFAULT_VIEW_PARAMS.maxSpreadBps } });
    expect(v.riskFlags).toEqual([]);
    const strict = view({ liquidity: { quoteVolume24h: 60_000_000, spreadBps: 4 }, params: { minQuoteVolume24h: 80_000_000, maxSpreadBps: 3 } });
    expect(strict.riskFlags).toEqual(['POOR_LIQUIDITY', 'WIDE_SPREAD']);
  });

  it('UNIT-SVW-005 params (ambang pengguna 1 jt / 30 bps) → flag dinilai dengan batas itu dan penjelasan menampilkan batas yang dipakai', () => {
    const v = view({ liquidity: { quoteVolume24h: 900_000, spreadBps: 25 }, params: { minQuoteVolume24h: 1_000_000, maxSpreadBps: 30 } });
    expect(v.riskFlags).toEqual(['POOR_LIQUIDITY']);
    expect(v.explanation.find((e) => e.factor === 'RISK:POOR_LIQUIDITY').detail).toBe('Quote volume 24 jam 900000 < batas 1000000');
    expect(v.explanation.find((e) => e.factor === 'CONTEXT:LIQUIDITY').detail).toBe('Quote volume 24 jam 900000 (batas 1000000), spread 25 bps (batas 30)');
    // Override sebagian: kunci lain tetap default.
    const partial = view({ liquidity: { quoteVolume24h: 900_000, spreadBps: 25 }, params: { maxSpreadBps: 30 } });
    expect(partial.explanation.find((e) => e.factor === 'CONTEXT:LIQUIDITY').detail)
      .toBe(`Quote volume 24 jam 900000 (batas ${DEFAULT_VIEW_PARAMS.minQuoteVolume24h}), spread 25 bps (batas 30)`);
  });

  it('EDGE-SVW-002 likuiditas/konteks/kualitas data tidak tersedia → tanpa flag, dijelaskan', () => {
    const v = view({ liquidity: undefined, context: undefined, dataQuality: undefined });
    expect(v.riskFlags).toEqual([]);
    expect(v.alignment).toBeNull();
    expect(v.explanation.find((e) => e.factor === 'CONTEXT:LIQUIDITY').detail).toMatch(/tidak tersedia/);
    expect(v.explanation.find((e) => e.factor === 'CONTEXT:ALIGNMENT').detail).toMatch(/tidak tersedia/);
  });

  it('EDGE-SVW-003 flag tak dikenal dari detektor dibuang; flag duplikat hanya sekali', () => {
    const v = view({ patterns: { classification: 'SA', sa: result('SA', { riskFlags: ['FOO', 'EXTENDED_PRICE', 'EXTENDED_PRICE'] }), pva: null } });
    expect(v.riskFlags).toEqual(['EXTENDED_PRICE']);
  });

  it('EDGE-SVW-004 skor di luar 0..100 dijepit; kondisi tanpa bobot tidak membagi nol', () => {
    const v = view({ patterns: { classification: 'SA', sa: result('SA', { patternScore: 140, earlyScore: -3, conditions: [] }), pva: null } });
    expect(v.patternScore).toBe(100);
    expect(v.earlyScore).toBe(0);
    expect(sum(v.explanation, 'PATTERN:')).toBeCloseTo(100, 9);
    const zero = view({ patterns: { classification: 'SA', sa: result('SA', { conditions: [{ id: 'x', label: 'x', passed: true, value: 1, threshold: 1, weight: 0 }] }), pva: null } });
    expect(zero.explanation.find((e) => e.factor === 'PATTERN:SA:x').contribution).toBe(0);
  });

  it('NEG-SVW-001 input tidak valid ditolak', () => {
    expect(() => view({ patterns: { classification: 'XYZ', sa: result('SA'), pva: null } })).toThrow(RangeError);
    expect(() => view({ patterns: { classification: 'PVA', sa: result('SA'), pva: null } })).toThrow(/PVA/);
    expect(() => view({ patterns: { classification: 'SA', sa: result('SA', { patternScore: Number.NaN }), pva: null } })).toThrow(TypeError);
    expect(() => view({ patterns: null })).toThrow(TypeError);
    expect(() => view({ context: { alignment: 'SIDEWAYS' } })).toThrow(RangeError);
    expect(() => view({ params: { minQuoteVolume24h: -1 } })).toThrow(RangeError);
  });
});
