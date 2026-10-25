import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PVA_PARAMS,
  DEFAULT_SA_PARAMS,
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
});
