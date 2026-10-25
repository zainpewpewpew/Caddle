import { describe, expect, it } from 'vitest';
import { GATE_CONDITIONS, mean } from '../../../backend/patterns/conditions.js';
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
    expect(r).toMatchObject({ pattern: 'PVA', version: 2, insufficientData: false });
    expect(r.conditions.map((c) => c.id)).toEqual([...GATE_CONDITIONS, ...PVA_CONDITIONS].map((c) => c.id));
    expect(PVA_CONDITIONS.reduce((a, c) => a + c.weight, 0)).toBe(100);
    expect(PVA_CONDITIONS.filter((c) => c.required).reduce((a, c) => a + c.weight, 0)).toBe(75);
    for (const candles of [progressiveVolumeCandles(3), silentAccumulationCandles(3), flatCandles(3)]) {
      const res = detectProgressiveVolume(candles);
      expect(res.patternScore).toBe(res.conditions.filter((c) => c.passed).reduce((a, c) => a + c.weight, 0));
    }
  });

  it('NEG-PPVA-001 satu lonjakan volume raksasa pada ramp asli → tidak terdeteksi; alasannya noSpikeDominance', () => {
    for (const seed of SEEDS) {
      const r = detectProgressiveVolume(withVolumeSpike(progressiveVolumeCandles(seed), -3, 30));
      expect(r.detected).toBe(false);
      const spike = cond(r, 'noSpikeDominance');
      expect(spike.passed).toBe(false);
      expect(spike.value).toBeGreaterThan(spike.threshold);
      // Kondisi wajib lain tetap lulus dan skor ≥ minScore: penolakan murni karena dominasi lonjakan.
      // volumeGrowthBroad ikut lulus karena ramp di bawahnya memang tumbuh merata.
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

  // Jalur harga persis progressiveVolumeCandles (12 + 20 candle naik bertahap), tetapi volume
  // DATAR ±600 di seluruh fase naik.
  const flatVolumeUp = (seed, volumeNoise = 0.1) => {
    const up = (bars) => ({ bars, cycle: zigzag(5, 0.0015, 3, 0.0015), wick: 0.002, volume: 600, volumeNoise });
    return generateCandles({ seed, segments: [{ bars: 48, cycle: zigzag(3, 0.002, 3, 0.002), volume: 1000, volumeNoise: 0.15 }, up(12), up(20)] });
  };

  it('NEG-PPVA-009 satu candle 3,5× rata-rata pada volume datar (porsi jendela 0,15 lolos) → ditolak volumeGrowthBroad', () => {
    for (const seed of SEEDS) {
      // Tanpa derau: rata-rata sub-jendela naik 1% per sub-jendela; candle ke-3 dari akhir = 2100
      // (3,5× rata-rata) sendirian menaikkan rata-rata sub-jendela terakhir ≥ 1,5×.
      const base = flatVolumeUp(seed, 0);
      const n = base.length;
      const volumes = Array.from({ length: 20 }, (_, j) => (j === 17 ? 2100 : 600 * (1 + 0.01 * Math.floor(j / 5))));
      const candles = base.map((c, i) => (i < n - 20 ? c : { ...c, volume: volumes[i - (n - 20)], quoteVolume: c.quoteVolume * (volumes[i - (n - 20)] / c.volume) }));
      const r = detectProgressiveVolume(candles);
      expect(r.detected, `seed ${seed}`).toBe(false);
      expect(cond(r, 'volumeRising').passed).toBe(true);
      expect(cond(r, 'volumeGrowth').passed).toBe(true);
      expect(cond(r, 'noSpikeDominance')).toMatchObject({ passed: true });
      // Median bawah sub-jendela terakhir [618, 618, 2100, 618, 618] = 618 → 618 / 600 = 1,03.
      const first = mean(volumes.slice(0, 5));
      const expected = [...volumes.slice(15)].sort((a, b) => a - b)[2] / first;
      expect(cond(r, 'volumeGrowthBroad')).toMatchObject({ passed: false, threshold: DEFAULT_PVA_PARAMS.minVolumeGrowth });
      expect(cond(r, 'volumeGrowthBroad').value).toBeCloseTo(expected, 9);
      expect(cond(r, 'volumeGrowthBroad').value).toBeCloseTo(1.03, 9);
    }
  });

  it('NEG-PPVA-010 satu lonjakan realistis 3–5× di sub-jendela terakhir pada volume datar berderau → tidak pernah terdeteksi', () => {
    const results = [];
    for (const multiplier of [3, 3.5, 4, 4.5, 5]) {
      for (const index of [-1, -3, -5]) {
        for (let seed = 1; seed <= 150; seed += 1) {
          results.push({ label: `${multiplier}× @${index} seed ${seed}`, r: detectProgressiveVolume(withVolumeSpike(flatVolumeUp(seed), index, multiplier)) });
        }
      }
    }
    expect(results.filter((x) => x.r.detected).map((x) => x.label)).toEqual([]);
    // Kasus yang lolos penjaga lama (pertumbuhan & porsi jendela) harus ditolak penjaga baru.
    const binding = results.filter(({ r }) => cond(r, 'volumeGrowth').passed && cond(r, 'noSpikeDominance').passed);
    expect(binding.length).toBeGreaterThan(50);
    for (const { label, r } of binding) expect(cond(r, 'volumeGrowthBroad').passed, label).toBe(false);
  });

  // Jalur harga sama; volume fase naik terakhir ramp ringan 600 → volumeEnd (di bawah ambang
  // pertumbuhan bila tanpa lonjakan).
  const mildRampUp = (seed, volumeEnd) => {
    const up = (bars, end = 600) => ({ bars, cycle: zigzag(5, 0.0015, 3, 0.0015), wick: 0.002, volume: 600, volumeEnd: end, volumeNoise: 0.1 });
    return generateCandles({ seed, segments: [{ bars: 48, cycle: zigzag(3, 0.002, 3, 0.002), volume: 1000, volumeNoise: 0.15 }, up(12), up(20, volumeEnd)] });
  };

  it('NEG-PPVA-011 ramp ringan di bawah ambang + satu candle 2–3× → tetap tidak terdeteksi (lonjakan tidak boleh mengangkatnya)', () => {
    // Kasus review: ramp 600 → 750, seed 19, satu candle 2,5× di indeks −4.
    const base = mildRampUp(19, 750);
    expect(detectProgressiveVolume(base).detected).toBe(false);
    const spiked = detectProgressiveVolume(withVolumeSpike(base, -4, 2.5));
    expect(cond(spiked, 'volumeGrowth').passed).toBe(true);
    expect(spiked.detected).toBe(false);
    expect(cond(spiked, 'volumeGrowthBroad')).toMatchObject({ passed: false, threshold: DEFAULT_PVA_PARAMS.minVolumeGrowth });
    // Sapuan: setiap kasus yang tanpa lonjakan tidak terdeteksi tetap tidak terdeteksi.
    const lifted = [];
    for (const end of [700, 750, 800]) {
      for (const multiplier of [2, 2.5, 3]) {
        for (const index of [-1, -2, -3, -4, -5]) {
          for (let seed = 1; seed <= 100; seed += 1) {
            const candles = mildRampUp(seed, end);
            if (detectProgressiveVolume(candles).detected) continue;
            if (detectProgressiveVolume(withVolumeSpike(candles, index, multiplier)).detected) lifted.push(`${end} ${multiplier}× @${index} seed ${seed}`);
          }
        }
      }
    }
    expect(lifted).toEqual([]);
  });

  it('NEG-PPVA-012 dua candle 2,3–3,5× (berdampingan atau terpisah) pada volume datar → tidak terdeteksi; ditolak volumeGrowthBroad', () => {
    // Tanpa derau (setup NEG-PPVA-009): rata-rata sub-jendela naik 1% per sub-jendela.
    for (const multiplier of [2.3, 2.5, 3]) {
      for (const seed of SEEDS) {
        const base = flatVolumeUp(seed, 0);
        const n = base.length;
        const volumes = Array.from({ length: 20 }, (_, j) => ([17, 18].includes(j) ? 600 * multiplier : 600 * (1 + 0.01 * Math.floor(j / 5))));
        const candles = base.map((c, i) => (i < n - 20 ? c : { ...c, volume: volumes[i - (n - 20)], quoteVolume: c.quoteVolume * (volumes[i - (n - 20)] / c.volume) }));
        const r = detectProgressiveVolume(candles);
        expect(r.detected, `${multiplier}× seed ${seed}`).toBe(false);
        expect(cond(r, 'volumeGrowth').passed).toBe(true);
        expect(cond(r, 'noSpikeDominance').passed).toBe(true);
        expect(cond(r, 'volumeGrowthBroad').passed).toBe(false);
        expect(cond(r, 'volumeGrowthBroad').value).toBeCloseTo(1.03, 9);
      }
    }
    // Berderau: pasangan berdampingan dan terpisah di sub-jendela terakhir.
    const detected = [];
    for (const multiplier of [2.3, 2.5, 3, 3.5]) {
      for (const pair of [[-3, -2], [-1, -4], [-5, -1]]) {
        for (let seed = 1; seed <= 150; seed += 1) {
          const candles = pair.reduce((c, index) => withVolumeSpike(c, index, multiplier), flatVolumeUp(seed));
          if (detectProgressiveVolume(candles).detected) detected.push(`${multiplier}× @${pair} seed ${seed}`);
        }
      }
    }
    expect(detected).toEqual([]);
  });

  it('POS-PPVA-002 ramp volume progresif asli (juga dengan satu candle 2×) tetap terdeteksi; pertumbuhan median bawah jauh di atas ambang', () => {
    for (const seed of SEEDS) {
      const ramp = detectProgressiveVolume(progressiveVolumeCandles(seed));
      expect(ramp.detected, `seed ${seed}`).toBe(true);
      expect(cond(ramp, 'volumeGrowthBroad').passed).toBe(true);
      expect(cond(ramp, 'volumeGrowthBroad').value).toBeGreaterThan(1.9);
      const mild = detectProgressiveVolume(withVolumeSpike(progressiveVolumeCandles(seed), -3, 2));
      expect(mild.detected, `2× seed ${seed}`).toBe(true);
    }
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
    // maxSpikeGrowthShare dihapus (diganti volumeGrowthBroad yang memakai minVolumeGrowth) → key tidak dikenal.
    expect(() => detectProgressiveVolume(candles, { maxSpikeGrowthShare: 0.2 })).toThrow(/maxSpikeGrowthShare Parameter tidak dikenal/);
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
