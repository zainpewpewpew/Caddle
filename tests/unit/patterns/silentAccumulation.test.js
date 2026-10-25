import { describe, expect, it } from 'vitest';
import { RISK_FLAGS } from '../../../backend/market/contracts.js';
import { EARLY_SCORE, GATE_CONDITIONS, analyzeStructure, computeFeatures } from '../../../backend/patterns/conditions.js';
import { DEFAULT_SA_PARAMS, PatternParamsError } from '../../../backend/patterns/params.js';
import { SA_CONDITIONS, detectSilentAccumulation } from '../../../backend/patterns/silentAccumulation.js';
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
  withZeroVolume,
  withoutCandle,
} from '../../fixtures/candles/synthetic.js';

// Semua candle berasal dari generator sintetis — bukan data pasar nyata.
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const RESULT_KEYS = ['pattern', 'version', 'detected', 'patternScore', 'earlyScore', 'conditions', 'invalidationPrice', 'evaluatedAt', 'riskFlags', 'insufficientData'];
const cond = (result, id) => result.conditions.find((c) => c.id === id);
const requiredIds = SA_CONDITIONS.filter((c) => c.required).map((c) => c.id);

describe('Pattern #001 Silent Accumulation', () => {
  it('POS-PSA-001 akumulasi senyap terdeteksi pada semua seed: kondisi wajib lulus, skor ≥ minScore', () => {
    for (const seed of SEEDS) {
      const candles = silentAccumulationCandles(seed);
      const r = detectSilentAccumulation(candles);
      expect(r.detected, `seed ${seed}`).toBe(true);
      expect(r.patternScore).toBeGreaterThanOrEqual(DEFAULT_SA_PARAMS.minScore);
      for (const id of requiredIds) expect(cond(r, id).passed, `${id} seed ${seed}`).toBe(true);
      expect(r.insufficientData).toBe(false);
      expect(r.evaluatedAt).toBe(candles.at(-1).closeTime);
      expect(r.invalidationPrice).toBeGreaterThan(0);
      expect(r.invalidationPrice).toBeLessThan(candles.at(-1).close);
      expect(r.earlyScore).toBeGreaterThan(0);
      expect(r.earlyScore).toBeLessThanOrEqual(100);
      expect(r.riskFlags).toEqual([]);
    }
  });

  it('UNIT-PSA-001 bentuk output persis kontrak PatternResult §6', () => {
    const r = detectSilentAccumulation(silentAccumulationCandles(1));
    expect(Object.keys(r)).toEqual(RESULT_KEYS);
    expect(r).toMatchObject({ pattern: 'SA', version: 2 });
    expect(r.conditions.map((c) => c.id)).toEqual([...GATE_CONDITIONS, ...SA_CONDITIONS].map((c) => c.id));
    for (const c of r.conditions) {
      expect(Object.keys(c)).toEqual(['id', 'label', 'passed', 'value', 'threshold', 'weight']);
      expect(typeof c.label).toBe('string');
    }
    expect(r.riskFlags.every((f) => RISK_FLAGS.includes(f))).toBe(true);
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });

  it('UNIT-PSA-002 bobot total 100 (wajib 75) dan patternScore dapat dijelaskan per kondisi', () => {
    expect(SA_CONDITIONS.reduce((a, c) => a + c.weight, 0)).toBe(100);
    expect(SA_CONDITIONS.filter((c) => c.required).reduce((a, c) => a + c.weight, 0)).toBe(75);
    for (const candles of [silentAccumulationCandles(2), progressiveVolumeCandles(2), downtrendCandles(2)]) {
      const r = detectSilentAccumulation(candles);
      const passed = r.conditions.filter((c) => c.passed).reduce((a, c) => a + c.weight, 0);
      expect(r.patternScore).toBe(passed);
    }
  });

  it('UNIT-PSA-003 ambang kondisi berasal dari parameter', () => {
    const r = detectSilentAccumulation(silentAccumulationCandles(1));
    expect(cond(r, 'rvolLow').threshold).toBe(DEFAULT_SA_PARAMS.maxAvgRvol);
    expect(cond(r, 'priceGradual').threshold).toBe(DEFAULT_SA_PARAMS.maxPriceChange);
    expect(cond(r, 'enoughData')).toMatchObject({ passed: true, value: 76, threshold: 63, weight: 0 });
    const custom = detectSilentAccumulation(silentAccumulationCandles(1), { maxAvgRvol: 0.5 });
    expect(cond(custom, 'rvolLow')).toMatchObject({ threshold: 0.5, passed: false });
    expect(custom.detected).toBe(false);
  });

  it('NEG-PSA-001 volume tidak senyap (skenario volume progresif) → tidak terdeteksi karena RVOL tinggi', () => {
    for (const seed of SEEDS) {
      const r = detectSilentAccumulation(progressiveVolumeCandles(seed));
      expect(r.detected).toBe(false);
      expect(cond(r, 'rvolLow').passed).toBe(false);
      expect(cond(r, 'rvolLow').value).toBeGreaterThan(DEFAULT_SA_PARAMS.maxAvgRvol);
    }
  });

  it('NEG-PSA-002 harga datar dengan volume senyap → tidak terdeteksi (senyap saja tidak cukup)', () => {
    for (const seed of SEEDS) {
      const r = detectSilentAccumulation(flatCandles(seed, { volume: 450 }));
      expect(r.detected).toBe(false);
      expect(cond(r, 'rvolLow').passed).toBe(true);
      expect(cond(r, 'priceRising')).toMatchObject({ passed: false, value: 0 });
      expect(cond(r, 'ema7Rising').passed).toBe(false);
    }
  });

  it('NEG-PSA-003 downtrend → tidak terdeteksi, tanpa higher low, earlyScore 0', () => {
    for (const seed of SEEDS) {
      const r = detectSilentAccumulation(downtrendCandles(seed));
      expect(r.detected).toBe(false);
      expect(cond(r, 'priceRising').passed).toBe(false);
      expect(cond(r, 'higherLows').value).toBe(0);
      expect(cond(r, 'ema7Rising').value).toBeLessThan(0);
      expect(r.earlyScore).toBe(0);
      expect(r.invalidationPrice).toBeLessThan(downtrendCandles(seed).at(-1).close);
    }
  });

  it('NEG-PSA-004 volatilitas ekstrem → tidak terdeteksi dan diberi flag EXCESSIVE_VOLATILITY', () => {
    for (const seed of SEEDS) {
      const r = detectSilentAccumulation(extremeVolatilityCandles(seed));
      expect(r.detected).toBe(false);
      expect(cond(r, 'atrPercentLow').passed).toBe(false);
      expect(cond(r, 'atrNotExpanding').passed).toBe(false);
      expect(r.riskFlags).toContain('EXCESSIVE_VOLATILITY');
    }
  });

  it('NEG-PSA-005 kenaikan melebihi batas "kecil" → priceGradual gagal, tidak terdeteksi', () => {
    const r = detectSilentAccumulation(silentAccumulationCandles(1), { maxPriceChange: 0.005 });
    expect(cond(r, 'priceGradual')).toMatchObject({ passed: false, threshold: 0.005 });
    expect(r.detected).toBe(false);
  });

  it('NEG-PSA-006 higher low kurang dari minimum → tidak terdeteksi', () => {
    const candles = silentAccumulationCandles(1);
    const have = cond(detectSilentAccumulation(candles), 'higherLows').value;
    const r = detectSilentAccumulation(candles, { minHigherLows: have + 1 });
    expect(cond(r, 'higherLows').passed).toBe(false);
    expect(r.detected).toBe(false);
  });

  it('NEG-PSA-007 parameter tidak valid → PatternParamsError, bukan hasil diam-diam', () => {
    const candles = silentAccumulationCandles(1);
    expect(() => detectSilentAccumulation(candles, { maxAvgRvol: -1 })).toThrow(PatternParamsError);
    expect(() => detectSilentAccumulation(candles, { rvolWindow: 2.5 })).toThrow(/bulat/);
    expect(() => detectSilentAccumulation(candles, { typo: 1 })).toThrow(/tidak dikenal/);
    expect(() => detectSilentAccumulation(candles, [])).toThrow(PatternParamsError);
  });

  it('NEG-PSA-008 input bukan array → TypeError', () => {
    expect(() => detectSilentAccumulation(null)).toThrow(TypeError);
    expect(() => detectSilentAccumulation({ length: 100 })).toThrow(TypeError);
  });

  it('EDGE-PSA-001 data kurang dari warm-up (63) → insufficientData, nilai kondisi null, tanpa invalidasi', () => {
    const candles = silentAccumulationCandles(1);
    const r = detectSilentAccumulation(candles.slice(-62));
    expect(r).toMatchObject({ detected: false, insufficientData: true, patternScore: 0, earlyScore: 0, invalidationPrice: null, riskFlags: [] });
    expect(cond(r, 'enoughData')).toMatchObject({ passed: false, value: 62, threshold: 63 });
    expect(r.conditions.filter((c) => c.weight > 0).every((c) => c.value === null && !c.passed)).toBe(true);
    expect(r.evaluatedAt).toBe(candles.at(-1).closeTime);
    expect(detectSilentAccumulation(candles.slice(-63)).insufficientData).toBe(false);
  });

  it('EDGE-PSA-002 array kosong → insufficientData dengan evaluatedAt null', () => {
    const r = detectSilentAccumulation([]);
    expect(r).toMatchObject({ detected: false, insufficientData: true, evaluatedAt: null, invalidationPrice: null });
  });

  it('EDGE-PSA-003 volume nol beruntun → DATA_QUALITY dan tidak terdeteksi; satu candle volume nol masih diterima', () => {
    const base = silentAccumulationCandles(1);
    const streak = detectSilentAccumulation(withZeroVolume(base, -10, 3));
    expect(streak.detected).toBe(false);
    expect(streak.riskFlags).toContain('DATA_QUALITY');
    expect(cond(streak, 'dataQuality')).toMatchObject({ passed: false, value: 1, threshold: 0 });
    const single = detectSilentAccumulation(withZeroVolume(base, -10, 1));
    expect(single.detected).toBe(true);
    expect(single.riskFlags).not.toContain('DATA_QUALITY');
  });

  it('EDGE-PSA-004 candle belum tertutup ditolak; gap waktu → DATA_QUALITY', () => {
    const base = silentAccumulationCandles(1);
    const provisional = detectSilentAccumulation(withProvisionalLast(base));
    expect(provisional).toMatchObject({ detected: false, riskFlags: ['DATA_QUALITY'], invalidationPrice: null, patternScore: 0 });
    const gap = detectSilentAccumulation(withoutCandle(base, -10));
    expect(gap.detected).toBe(false);
    expect(gap.riskFlags).toContain('DATA_QUALITY');
    const broken = detectSilentAccumulation(base.map((c, i) => (i === 40 ? { ...c, close: Number.POSITIVE_INFINITY } : c)));
    expect(broken).toMatchObject({ detected: false, riskFlags: ['DATA_QUALITY'] });
  });

  it('EDGE-PSA-005 harga sangat kecil (×1e-7) → hasil setara (perhitungan invarian skala, presisi aman)', () => {
    for (const seed of [1, 4]) {
      const base = silentAccumulationCandles(seed);
      const tiny = withPriceScale(base, 1e-7);
      const a = detectSilentAccumulation(base);
      const b = detectSilentAccumulation(tiny);
      expect(b.detected).toBe(a.detected);
      expect(b.patternScore).toBe(a.patternScore);
      expect(b.earlyScore).toBeCloseTo(a.earlyScore, 6);
      expect(b.invalidationPrice / 1e-7).toBeCloseTo(a.invalidationPrice, 6);
      expect(b.invalidationPrice).toBeLessThan(tiny.at(-1).close);
      b.conditions.forEach((c, i) => expect(c.passed).toBe(a.conditions[i].passed));
    }
  });

  it('EDGE-PSA-006 quote volume sangat kecil → flag POOR_LIQUIDITY (kondisi opsional, tidak memblokir)', () => {
    const illiquid = silentAccumulationCandles(1).map((c) => ({ ...c, quoteVolume: c.quoteVolume / 1000 }));
    const r = detectSilentAccumulation(illiquid);
    expect(cond(r, 'liquidity').passed).toBe(false);
    expect(r.riskFlags).toContain('POOR_LIQUIDITY');
    expect(r.detected).toBe(true);
    expect(r.patternScore).toBe(95);
  });

  it('EDGE-PSA-007 earlyScore turun ketika harga sudah jauh berjalan dari struktur', () => {
    // Fase naik diperpanjang 3 siklus (fase akhir sama) → struktur lebih tua & harga lebih jauh.
    const seg = (bars) => [{ bars: 48, cycle: zigzag(3, 0.002, 3, 0.002), volumeNoise: 0.15 }, { bars, cycle: zigzag(5, 0.0015, 3, 0.0015), wick: 0.002, volume: 450, volumeNoise: 0.1 }];
    const early = detectSilentAccumulation(generateCandles({ seed: 1, segments: seg(28) }));
    const late = detectSilentAccumulation(generateCandles({ seed: 1, segments: seg(52) }));
    expect(early.earlyScore).toBeGreaterThan(late.earlyScore);
  });

  // Uptrend matang dengan pullback dangkal: 5 candle naik 0,2%, 2 candle turun 0,1% → higher low
  // baru tiap 7 candle (sintetis, temuan review C7).
  const maturingRun = () => generateCandles({ seed: 1, segments: [{ bars: 48, cycle: zigzag(3, 0.002, 3, 0.002), volumeNoise: 0.15 }, { bars: 60, cycle: zigzag(5, 0.002, 2, 0.001), wick: 0.002, volume: 450, volumeNoise: 0.1 }] });

  it('EDGE-PSA-008 kenaikan matang (≈10 ATR dari awal struktur) setelah pullback → earlyScore < 60 walau higher low terbaru dekat', () => {
    const candles = maturingRun().slice(0, 78);
    const r = detectSilentAccumulation(candles);
    const f = computeFeatures(candles);
    const s = analyzeStructure(candles, f, DEFAULT_SA_PARAMS.priceLookback);
    // Prasyarat skenario: terdeteksi, harga dekat higher low terbaru tetapi jauh dari awal struktur.
    expect(r.detected).toBe(true);
    expect(r.riskFlags).toContain('EXTENDED_PRICE');
    expect((f.close - s.anchorPrice) / f.atr).toBeLessThan(2);
    expect((f.close - candles[s.startIndex].low) / f.atr).toBeGreaterThan(EARLY_SCORE.maxRunAtr);
    expect(r.earlyScore).toBeLessThan(60);
    // Hanya komponen usia yang tersisa (komponen jarak 0).
    expect(r.earlyScore).toBeCloseTo(100 * EARLY_SCORE.ageWeight * (1 - (f.last - s.startIndex) / EARLY_SCORE.maxAgeBars), 1);
  });

  it('EDGE-PSA-009 walk-forward satu struktur: harga makin jauh dari awal struktur → earlyScore tidak pernah naik', () => {
    const scenarios = [maturingRun(), ...[1, 2, 3, 4].map((seed) => generateCandles({ seed, segments: [{ bars: 48, cycle: zigzag(3, 0.002, 3, 0.002), volumeNoise: 0.15 }, { bars: 60, cycle: zigzag(5, 0.0015, 3, 0.0015), wick: 0.002, volume: 450, volumeNoise: 0.1 }] }))];
    let compared = 0;
    for (const all of scenarios) {
      const rows = [];
      for (let k = 63; k <= all.length; k += 1) {
        const c = all.slice(0, k);
        const f = computeFeatures(c);
        const s = analyzeStructure(c, f, DEFAULT_SA_PARAMS.priceLookback);
        if (!s.fromSwing || s.higherLows < 1) continue;
        rows.push({ k, start: s.startIndex, run: (f.close - c[s.startIndex].low) / f.atr, early: detectSilentAccumulation(c).earlyScore });
      }
      for (let i = 0; i < rows.length; i += 1) {
        for (let j = i + 1; j < rows.length; j += 1) {
          const [a, b] = [rows[i], rows[j]];
          if (a.start !== b.start || b.run < a.run) continue;
          compared += 1;
          expect(b.early, `k ${a.k}→${b.k}, run ${a.run.toFixed(2)}→${b.run.toFixed(2)} ATR`).toBeLessThanOrEqual(a.early);
        }
      }
    }
    expect(compared).toBeGreaterThan(100);
  });

  it('UNIT-PSA-004 deterministik dan tidak memutasi input', () => {
    const candles = silentAccumulationCandles(5).map((c) => Object.freeze(c));
    Object.freeze(candles);
    const a = detectSilentAccumulation(candles);
    const b = detectSilentAccumulation(candles);
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});
