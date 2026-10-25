import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TIMEFRAME_MS, isAlignedOpenTime } from '../../../backend/market/contracts.js';
import { silentAccumulationCandles } from '../../fixtures/candles/scenarios.js';
import {
  generateCandles,
  mulberry32,
  withPriceScale,
  withProvisionalLast,
  withVolumeSpike,
  withZeroVolume,
  withoutCandle,
} from '../../fixtures/candles/synthetic.js';

// Fixture sintetis — bukan data pasar nyata.
describe('generator candle sintetis', () => {
  it('UNIT-PSYN-001 PRNG seeded deterministik dan berbeda antar-seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 5 }, a);
    expect(Array.from({ length: 5 }, b)).toEqual(seqA);
    expect(Array.from({ length: 5 }, mulberry32(43))).not.toEqual(seqA);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('UNIT-PSYN-002 candle mengikuti kontrak: waktu sejajar, closeTime = openTime + interval − 1, OHLC konsisten, tertutup', () => {
    const candles = generateCandles({ seed: 7, timeframe: '15m', segments: [{ bars: 30, drift: 0.001, volume: 500, volumeEnd: 900 }] });
    expect(candles).toHaveLength(30);
    candles.forEach((c, i) => {
      expect(isAlignedOpenTime(c.openTime, '15m')).toBe(true);
      expect(c.closeTime).toBe(c.openTime + TIMEFRAME_MS['15m'] - 1);
      if (i > 0) {
        expect(c.openTime - candles[i - 1].openTime).toBe(TIMEFRAME_MS['15m']);
        expect(c.open).toBe(candles[i - 1].close);
      }
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
      expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
      expect(c.volume).toBeGreaterThanOrEqual(0);
      expect(c).toMatchObject({ symbol: 'SYNUSDT', timeframe: '15m', isClosed: true, source: 'rest' });
    });
  });

  it('UNIT-PSYN-003 seed & segmen sama → candle identik; generator tidak memakai Math.random', () => {
    expect(silentAccumulationCandles(3)).toEqual(silentAccumulationCandles(3));
    expect(silentAccumulationCandles(3)).not.toEqual(silentAccumulationCandles(4));
    const source = readFileSync(new URL('../../fixtures/candles/synthetic.js', import.meta.url), 'utf8');
    expect(source).not.toMatch(/Math\.random\s*\(/);
  });

  it('UNIT-PSYN-004 modifier tidak mengubah array asli', () => {
    const base = silentAccumulationCandles(1);
    const snapshot = JSON.stringify(base);
    const spiked = withVolumeSpike(base, -1, 10);
    expect(spiked.at(-1).volume).toBeCloseTo(base.at(-1).volume * 10, 9);
    const zeroed = withZeroVolume(base, -5, 3);
    expect(zeroed.slice(-5, -2).every((c) => c.volume === 0 && c.quoteVolume === 0)).toBe(true);
    expect(zeroed.at(-1).volume).toBe(base.at(-1).volume);
    expect(withoutCandle(base, 10)).toHaveLength(base.length - 1);
    expect(withProvisionalLast(base).at(-1).isClosed).toBe(false);
    const tiny = withPriceScale(base, 1e-6);
    expect(tiny[0].close).toBeCloseTo(base[0].close * 1e-6, 15);
    expect(tiny[0].quoteVolume).toBe(base[0].quoteVolume);
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});
