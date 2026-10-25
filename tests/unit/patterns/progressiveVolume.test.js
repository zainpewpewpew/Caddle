import { describe, expect, it } from 'vitest';
import { GATE_CONDITIONS } from '../../../backend/patterns/conditions.js';
import { DEFAULT_PVA_PARAMS, PatternParamsError } from '../../../backend/patterns/params.js';
import { PVA_CONDITIONS, detectProgressiveVolume } from '../../../backend/patterns/progressiveVolume.js';
import {
  downtrendCandles,
  extremeVolatilityCandles,
  flatCandles,
  progressiveVolumeCandles,
  silentAccumulationCandles,
  zigzag,
} from '../../fixtures/candles/scenarios.js';
import {
  generateCandles,
  withPriceScale,
  withProvisionalLast,
  withVolumeSpike,
  withZeroVolume,
} from '../../fixtures/candles/synthetic.js';

// Semua candle berasal dari generator sintetis — bukan data pasar nyata.
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const cond = (result, id) => result.conditions.find((c) => c.id === id);
const requiredIds = PVA_CONDITIONS.filter((c) => c.required).map((c) => c.id);

describe('Pattern #002 Progressive Volume Accumulation', () => {
  it('POS-PPVA-001 volume progresif + harga naik bertahap terdeteksi pada semua seed', () => {
    for (const seed of SEEDS) {
      const candles = progressiveVolumeCandles(seed);
      const r = detectProgressiveVolume(candles);
      expect(r.detected, `seed ${seed}`).toBe(true);
      expect(r.patternScore).toBeGreaterThanOrEqual(DEFAULT_PVA_PARAMS.minScore);
      for (const id of requiredIds) expect(cond(r, id).passed, `${id} seed ${seed}`).toBe(true);
      expect(cond(r, 'volumeRising').value).toBe(DEFAULT_PVA_PARAMS.subWindows - 1);
      expect(cond(r, 'volumeGrowth').value).toBeGreaterThanOrEqual(DEFAULT_PVA_PARAMS.minVolumeGrowth);
      expect(r.invalidationPrice).toBeGreaterThan(0);
      expect(r.invalidationPrice).toBeLessThan(candles.at(-1).close);
      expect(r.evaluatedAt).toBe(candles.at(-1).closeTime);
      expect(r.riskFlags).not.toContain('EXCESSIVE_VOLATILITY');
      expect(r.riskFlags).not.toContain('DATA_QUALITY');
    }
  });

  it('UNIT-PPVA-001 bentuk output kontrak §6, bobot total 100 (wajib 75), skor dapat dijelaskan', () => {
    const r = detectProgressiveVolume(progressiveVolumeCandles(1));
    expect(Object.keys(r)).toEqual(['pattern', 'version', 'detected', 'patternScore', 'earlyScore', 'conditions', 'invalidationPrice', 'evaluatedAt', 'riskFlags', 'insufficientData']);
    expect(r).toMatchObject({ pattern: 'PVA', version: 1, insufficientData: false });
    expect(r.conditions.map((c) => c.id)).toEqual([...GATE_CONDITIONS, ...PVA_CONDITIONS].map((c) => c.id));
    expect(PVA_CONDITIONS.reduce((a, c) => a + c.weight, 0)).toBe(100);
    expect(PVA_CONDITIONS.filter((c) => c.required).reduce((a, c) => a + c.weight, 0)).toBe(75);
    for (const candles of [progressiveVolumeCandles(3), silentAccumulationCandles(3), flatCandles(3)]) {
      const res = detectProgressiveVolume(candles);
      expect(res.patternScore).toBe(res.conditions.filter((c) => c.passed).reduce((a, c) => a + c.weight, 0));
    }
  });

  it('NEG-PPVA-001 satu lonjakan volume raksasa → tidak terdeteksi; alasannya noSpikeDominance', () => {
    for (const seed of SEEDS) {
      const r = detectProgressiveVolume(withVolumeSpike(progressiveVolumeCandles(seed), -3, 30));
      expect(r.detected).toBe(false);
      const spike = cond(r, 'noSpikeDominance');
      expect(spike.passed).toBe(false);
      expect(spike.value).toBeGreaterThan(spike.threshold);
      // Kondisi wajib lain tetap lulus dan skor ≥ minScore: penolakan murni karena dominasi lonjakan.
      for (const id of requiredIds.filter((x) => x !== 'noSpikeDominance')) expect(cond(r, id).passed, id).toBe(true);
      expect(r.patternScore).toBeGreaterThanOrEqual(DEFAULT_PVA_PARAMS.minScore);
    }
  });

  it('NEG-PPVA-002 lonjakan tunggal pada volume datar tidak dianggap pertumbuhan progresif', () => {
    const r = detectProgressiveVolume(withVolumeSpike(silentAccumulationCandles(1), -2, 40));
    expect(cond(r, 'volumeGrowth').passed).toBe(true);
    expect(cond(r, 'noSpikeDominance').passed).toBe(false);
    expect(r.detected).toBe(false);
  });

  it('NEG-PPVA-003 harga datar dengan volume progresif → tidak terdeteksi (volume saja tidak cukup)', () => {
    for (const seed of SEEDS) {
      const r = detectProgressiveVolume(flatCandles(seed, { volume: 600, volumeEnd: 1700 }));
      expect(r.detected).toBe(false);
      expect(cond(r, 'volumeRising').passed).toBe(true);
      expect(cond(r, 'volumeGrowth').passed).toBe(true);
      expect(cond(r, 'priceRising').passed).toBe(false);
    }
  });

  it('NEG-PPVA-004 volume tidak naik (akumulasi senyap) → volumeGrowth gagal', () => {
    for (const seed of SEEDS) {
      const r = detectProgressiveVolume(silentAccumulationCandles(seed));
      expect(r.detected).toBe(false);
      expect(cond(r, 'volumeGrowth').passed).toBe(false);
    }
  });

  it('NEG-PPVA-005 downtrend → tidak terdeteksi', () => {
    for (const seed of SEEDS) {
      const r = detectProgressiveVolume(downtrendCandles(seed));
      expect(r.detected).toBe(false);
      expect(cond(r, 'priceRising').passed).toBe(false);
      expect(cond(r, 'higherLows').passed).toBe(false);
    }
  });

  it('NEG-PPVA-006 volatilitas ekstrem → tidak terdeteksi, flag EXCESSIVE_VOLATILITY', () => {
    for (const seed of SEEDS) {
      const r = detectProgressiveVolume(extremeVolatilityCandles(seed));
      expect(r.detected).toBe(false);
      expect(cond(r, 'atrPercentLow').passed).toBe(false);
      expect(r.riskFlags).toContain('EXCESSIVE_VOLATILITY');
    }
  });

  it('NEG-PPVA-007 kenaikan harga dari satu candle (bukan bertahap) → riseNotSingleCandle gagal', () => {
    const jump = [...Array(10).fill(0), 0.03, ...Array(9).fill(0)];
    const candles = generateCandles({
      seed: 2,
      segments: [
        { bars: 48, cycle: zigzag(3, 0.002, 3, 0.002), volumeNoise: 0.15 },
        { bars: 12, volume: 600 },
        { bars: 20, cycle: jump, volume: 600, volumeEnd: 1700 },
      ],
    });
    const r = detectProgressiveVolume(candles);
    const single = cond(r, 'riseNotSingleCandle');
    expect(single.passed).toBe(false);
    expect(single.value).toBeGreaterThan(0.9);
    expect(r.detected).toBe(false);
  });

  it('NEG-PPVA-008 parameter tidak valid → PatternParamsError', () => {
    const candles = progressiveVolumeCandles(1);
    expect(() => detectProgressiveVolume(candles, { subWindows: 1 })).toThrow(PatternParamsError);
    expect(() => detectProgressiveVolume(candles, { maxSpikeDominance: 0.01 })).toThrow(/maxSpikeDominance/);
    expect(() => detectProgressiveVolume(candles, { minVolumeGrowth: '2' })).toThrow(PatternParamsError);
  });

  it('UNIT-PPVA-002 parameter jendela mengubah ambang dan warm-up', () => {
    const candles = progressiveVolumeCandles(1);
    const r = detectProgressiveVolume(candles, { subWindows: 5, subWindowLength: 4 });
    expect(cond(r, 'volumeRising').threshold).toBe(4);
    expect(cond(r, 'enoughData').threshold).toBe(70);
    const strict = detectProgressiveVolume(candles, { minVolumeGrowth: 5 });
    expect(cond(strict, 'volumeGrowth')).toMatchObject({ passed: false, threshold: 5 });
    expect(strict.detected).toBe(false);
  });

  it('EDGE-PPVA-001 warm-up PVA = 70 candle: 69 → insufficientData, 70 → dievaluasi', () => {
    const candles = progressiveVolumeCandles(1);
    const short = detectProgressiveVolume(candles.slice(-69));
    expect(short).toMatchObject({ detected: false, insufficientData: true, patternScore: 0, invalidationPrice: null });
    expect(cond(short, 'enoughData')).toMatchObject({ passed: false, value: 69, threshold: 70 });
    expect(detectProgressiveVolume(candles.slice(-70)).insufficientData).toBe(false);
  });

  it('EDGE-PPVA-002 volume nol beruntun di sub-jendela → DATA_QUALITY dan tidak terdeteksi', () => {
    const r = detectProgressiveVolume(withZeroVolume(progressiveVolumeCandles(1), -20, 4));
    expect(r.detected).toBe(false);
    expect(r.riskFlags).toContain('DATA_QUALITY');
    expect(cond(r, 'dataQuality').passed).toBe(false);
  });

  it('EDGE-PPVA-003 candle terakhir belum tertutup → ditolak', () => {
    const r = detectProgressiveVolume(withProvisionalLast(progressiveVolumeCandles(1)));
    expect(r).toMatchObject({ detected: false, riskFlags: ['DATA_QUALITY'], earlyScore: 0, invalidationPrice: null });
  });

  it('EDGE-PPVA-004 harga sangat kecil (×1e-8) → hasil setara dengan harga normal', () => {
    for (const seed of [2, 6]) {
      const base = progressiveVolumeCandles(seed);
      const tiny = withPriceScale(base, 1e-8);
      const a = detectProgressiveVolume(base);
      const b = detectProgressiveVolume(tiny);
      expect(b.detected).toBe(a.detected);
      expect(b.patternScore).toBe(a.patternScore);
      expect(b.earlyScore).toBeCloseTo(a.earlyScore, 6);
      expect(b.invalidationPrice / 1e-8).toBeCloseTo(a.invalidationPrice, 6);
      expect(b.riskFlags).toEqual(a.riskFlags);
    }
  });

  it('UNIT-PPVA-003 deterministik dan tidak memutasi input', () => {
    const candles = Object.freeze(progressiveVolumeCandles(4).map((c) => Object.freeze(c)));
    expect(detectProgressiveVolume(candles)).toEqual(detectProgressiveVolume(candles));
  });
});
