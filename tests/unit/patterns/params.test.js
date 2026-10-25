import { describe, expect, it } from 'vitest';
import { ANALYSIS_LOOKBACK } from '../../../backend/analysis/pipeline.js';
import {
  DEFAULT_PVA_PARAMS,
  DEFAULT_SA_PARAMS,
  MAX_WARMUP_CANDLES,
  PARAM_SPECS,
  PatternParamsError,
  requiredCandles,
  resolveParams,
  validateParams,
} from '../../../backend/patterns/params.js';

const paths = (errors) => errors.map((e) => e.path);

describe('parameter pola', () => {
  it('UNIT-PPRM-001 parameter default lolos validasi dan beku (termasuk spesifikasi rentang)', () => {
    expect(validateParams(DEFAULT_SA_PARAMS, 'SA')).toEqual([]);
    expect(validateParams(DEFAULT_PVA_PARAMS, 'PVA')).toEqual([]);
    expect(Object.isFrozen(DEFAULT_SA_PARAMS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_PVA_PARAMS)).toBe(true);
    expect(Object.isFrozen(PARAM_SPECS.SA.maxAvgRvol)).toBe(true);
    expect(() => { DEFAULT_SA_PARAMS.maxAvgRvol = 5; }).toThrow(TypeError);
  });

  it('UNIT-PPRM-002 setiap parameter default punya spesifikasi dan sebaliknya', () => {
    expect(Object.keys(PARAM_SPECS.SA).sort()).toEqual(Object.keys(DEFAULT_SA_PARAMS).sort());
    expect(Object.keys(PARAM_SPECS.PVA).sort()).toEqual(Object.keys(DEFAULT_PVA_PARAMS).sort());
  });

  it('POS-PPRM-001 parameter dapat disimpan sebagai JSON (pattern_definitions) dan dibaca ulang tanpa kehilangan', () => {
    for (const [pattern, defaults] of [['SA', DEFAULT_SA_PARAMS], ['PVA', DEFAULT_PVA_PARAMS]]) {
      const roundTrip = JSON.parse(JSON.stringify(defaults));
      expect(roundTrip).toEqual(defaults);
      expect(validateParams(roundTrip, pattern)).toEqual([]);
    }
  });

  it('UNIT-PPRM-003 resolveParams menggabungkan override parsial dengan default', () => {
    const p = resolveParams('SA', { maxAvgRvol: 0.8 });
    expect(p.maxAvgRvol).toBe(0.8);
    expect(p.rvolPeriod).toBe(DEFAULT_SA_PARAMS.rvolPeriod);
    expect(Object.isFrozen(p)).toBe(true);
    expect(resolveParams('PVA')).toBe(DEFAULT_PVA_PARAMS);
    expect(resolveParams('PVA', null)).toBe(DEFAULT_PVA_PARAMS);
  });

  it('NEG-PPRM-001 nilai di luar rentang ditolak dengan daftar error per path', () => {
    const errors = validateParams({ ...DEFAULT_SA_PARAMS, maxAvgRvol: 0, minScore: 101, rvolPeriod: 9 }, 'SA');
    expect(paths(errors).sort()).toEqual(['/maxAvgRvol', '/minScore', '/rvolPeriod']);
    for (const e of errors) expect(e.message).toMatch(/antara/);
  });

  it('NEG-PPRM-002 tipe salah ditolak: string, NaN, Infinity, pecahan untuk integer, boolean', () => {
    const errors = validateParams({
      ...DEFAULT_PVA_PARAMS,
      maxPriorRvol: '1',
      minVolumeGrowth: Number.NaN,
      maxAtrPercent: Number.POSITIVE_INFINITY,
      subWindows: 3.5,
      minScore: true,
    }, 'PVA');
    expect(paths(errors).sort()).toEqual(['/maxAtrPercent', '/maxPriorRvol', '/minScore', '/minVolumeGrowth', '/subWindows']);
    expect(errors.find((e) => e.path === '/subWindows').message).toMatch(/bulat/);
  });

  it('NEG-PPRM-003 key tidak dikenal dan key wajib yang hilang ditolak', () => {
    const rest = { ...DEFAULT_SA_PARAMS };
    delete rest.minScore;
    const errors = validateParams({ ...rest, maxRvol: 0.9 }, 'SA');
    expect(errors).toEqual(expect.arrayContaining([
      { path: '/maxRvol', message: 'Parameter tidak dikenal' },
      { path: '/minScore', message: 'Parameter wajib diisi' },
    ]));
  });

  it('NEG-PPRM-004 bukan objek polos atau pola tidak dikenal ditolak', () => {
    expect(validateParams(null, 'SA')).toHaveLength(1);
    expect(validateParams([], 'SA')).toHaveLength(1);
    expect(validateParams('x', 'PVA')).toHaveLength(1);
    expect(validateParams(DEFAULT_SA_PARAMS, 'XYZ')[0].message).toMatch(/tidak dikenal/);
  });

  it('NEG-PPRM-005 key __proto__ dari JSON ditolak sebagai key tidak dikenal (tanpa polusi prototipe)', () => {
    const parsed = JSON.parse(`{"__proto__":{"polluted":true},${JSON.stringify(DEFAULT_SA_PARAMS).slice(1)}`);
    expect(paths(validateParams(parsed, 'SA'))).toEqual(['/__proto__']);
    expect(() => resolveParams('SA', parsed)).toThrow(PatternParamsError);
    expect({}.polluted).toBeUndefined();
  });

  it('NEG-PPRM-006 aturan lintas-field PVA: maxSpikeDominance harus > 1/(subWindows×subWindowLength)', () => {
    const errors = validateParams({ ...DEFAULT_PVA_PARAMS, subWindows: 2, subWindowLength: 2, maxSpikeDominance: 0.25 }, 'PVA');
    expect(paths(errors)).toEqual(['/maxSpikeDominance']);
  });

  it('NEG-PPRM-008 PVA tidak punya ambang porsi lonjakan terpisah: maxSpikeGrowthShare → parameter tidak dikenal', () => {
    // volumeGrowthBroad memakai minVolumeGrowth, sehingga tidak ada ambang yang dapat dilonggarkan
    // sampai satu candle boleh menyumbang mayoritas kenaikan.
    expect(Object.hasOwn(PARAM_SPECS.PVA, 'maxSpikeGrowthShare')).toBe(false);
    expect(Object.hasOwn(DEFAULT_PVA_PARAMS, 'maxSpikeGrowthShare')).toBe(false);
    for (const value of [0.11, 0.6, 1]) {
      expect(validateParams({ ...DEFAULT_PVA_PARAMS, maxSpikeGrowthShare: value }, 'PVA')).toEqual([{ path: '/maxSpikeGrowthShare', message: 'Parameter tidak dikenal' }]);
    }
  });

  it('NEG-PPRM-007 resolveParams melempar PatternParamsError (RangeError) berisi daftar error', () => {
    let caught;
    try { resolveParams('PVA', { subWindows: 1, extra: 1 }); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(PatternParamsError);
    expect(caught).toBeInstanceOf(RangeError);
    expect(paths(caught.errors).sort()).toEqual(['/extra', '/subWindows']);
    expect(caught.message).toMatch(/PVA/);
    expect(() => resolveParams('SA', 'bukan objek')).toThrow(PatternParamsError);
  });

  it('UNIT-PPRM-004 jumlah candle minimum diturunkan dari parameter', () => {
    expect(requiredCandles('SA', DEFAULT_SA_PARAMS)).toBe(63);
    expect(requiredCandles('PVA', DEFAULT_PVA_PARAMS)).toBe(70);
    expect(requiredCandles('SA', resolveParams('SA', { rvolPeriod: 100 }))).toBe(105);
    expect(requiredCandles('PVA', resolveParams('PVA', { subWindows: 5, subWindowLength: 10 }))).toBe(100);
  });

  it('EDGE-PPRM-001 batas warm-up PVA: rvolPeriod + subWindows×subWindowLength = 300 diterima, 301 ditolak dengan pesan jelas', () => {
    const atLimit = { ...DEFAULT_PVA_PARAMS, rvolPeriod: 200, subWindows: 10, subWindowLength: 10 };
    expect(validateParams(atLimit, 'PVA')).toEqual([]);
    expect(requiredCandles('PVA', atLimit)).toBe(300);
    const over = validateParams({ ...atLimit, rvolPeriod: 201 }, 'PVA');
    expect(over).toHaveLength(1);
    expect(over[0].message).toMatch(/301 candle melebihi batas 300/);
    expect(() => resolveParams('PVA', { subWindows: 10, subWindowLength: 30, maxSpikeDominance: 0.05 })).toThrow(/melebihi batas 300/);
  });

  it('EDGE-PPRM-002 batas warm-up SA: rvolPeriod 250 + rvolWindow 50 = 300 diterima; rvolPeriod 251 (atau 300) ditolak', () => {
    const atLimit = { ...DEFAULT_SA_PARAMS, rvolPeriod: 250, rvolWindow: 50, priceLookback: 200 };
    expect(validateParams(atLimit, 'SA')).toEqual([]);
    expect(requiredCandles('SA', atLimit)).toBe(300);
    expect(paths(validateParams({ ...atLimit, rvolPeriod: 251 }, 'SA'))).toEqual(['/rvolPeriod']);
    expect(() => resolveParams('SA', { rvolPeriod: 300 })).toThrow(PatternParamsError);
  });

  it('EDGE-PPRM-003 setiap parameter yang lolos validasi punya warm-up ≤ ANALYSIS_LOOKBACK pipeline', () => {
    expect(MAX_WARMUP_CANDLES).toBeLessThanOrEqual(ANALYSIS_LOOKBACK);
    // Sudut-sudut ruang parameter yang memengaruhi warm-up (nilai lain = default).
    const corners = (pattern, keys) => keys.reduce((acc, k) => acc.flatMap((o) => [PARAM_SPECS[pattern][k].min, PARAM_SPECS[pattern][k].max].map((v) => ({ ...o, [k]: v }))), [{}]);
    for (const [pattern, defaults, keys] of [['SA', DEFAULT_SA_PARAMS, ['rvolPeriod', 'rvolWindow', 'priceLookback']], ['PVA', DEFAULT_PVA_PARAMS, ['rvolPeriod', 'subWindows', 'subWindowLength']]]) {
      for (const corner of corners(pattern, keys)) {
        const params = { ...defaults, ...corner, maxSpikeDominance: 0.5 };
        if (pattern === 'SA') delete params.maxSpikeDominance;
        const errors = validateParams(params, pattern);
        if (errors.length === 0) expect(requiredCandles(pattern, params), JSON.stringify(corner)).toBeLessThanOrEqual(ANALYSIS_LOOKBACK);
        else expect(requiredCandles(pattern, params), JSON.stringify(corner)).toBeGreaterThan(MAX_WARMUP_CANDLES);
      }
    }
  });
  it('EDGE-PPRM-004 batas warm-up mengikuti lookback pemanggil: maxWarmup 150 menolak SA rvolPeriod 200 (warm-up 205) dan PVA rvolPeriod 200 (220)', () => {
    const sa = { ...DEFAULT_SA_PARAMS, rvolPeriod: 200 };
    // Tanpa opsi: batas default 300 → lolos (perilaku lama tetap).
    expect(validateParams(sa, 'SA')).toEqual([]);
    const errors = validateParams(sa, 'SA', { maxWarmup: 150 });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/205 candle melebihi batas 150/);
    expect(() => resolveParams('SA', { rvolPeriod: 200 }, { maxWarmup: 150 })).toThrow(/205 candle melebihi batas 150/);
    expect(() => resolveParams('PVA', { rvolPeriod: 200 }, { maxWarmup: 150 })).toThrow(/220 candle melebihi batas 150/);
    // Tanpa override pun default divalidasi terhadap lookback pemanggil (SA 63, PVA 70).
    expect(resolveParams('SA', undefined, { maxWarmup: 63 })).toBe(DEFAULT_SA_PARAMS);
    expect(() => resolveParams('PVA', null, { maxWarmup: 69 })).toThrow(/70 candle melebihi batas 69/);
    // Lookback lebih panjang dari 300 tidak melonggarkan batas: detektor sendiri tetap memakai 300.
    expect(() => resolveParams('SA', { rvolPeriod: 250, rvolWindow: 50, priceLookback: 200 }, { maxWarmup: 1500 })).not.toThrow();
    expect(paths(validateParams({ ...sa, rvolPeriod: 250, rvolWindow: 50, priceLookback: 200 }, 'SA', { maxWarmup: 1500 }))).toEqual([]);
    expect(validateParams({ ...DEFAULT_PVA_PARAMS, rvolPeriod: 250, subWindows: 10, subWindowLength: 10 }, 'PVA', { maxWarmup: 1500 })[0].message).toMatch(/350 candle melebihi batas 300/);
    // Opsi tidak sah ditolak sebagai error konfigurasi, bukan diabaikan.
    expect(() => validateParams(sa, 'SA', { maxWarmup: 0 })).toThrow(RangeError);
    expect(() => validateParams(sa, 'SA', { maxWarmup: 1.5 })).toThrow(RangeError);
  });
});
