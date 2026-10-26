import { describe, expect, it } from 'vitest';
import { REVERSAL_LOOKBACK, REVERSAL_TIMEFRAMES, STAGES } from '../../../backend/reversal/constants.js';
import {
  DEFAULT_REVERSAL_PARAMS, MAX_REQUIRED_CANDLES, REVERSAL_MAP_SPECS, REVERSAL_PARAM_SPECS, requiredCandles, resolveReversalParams,
} from '../../../backend/reversal/params.js';

describe('parameter Reversal Radar', () => {
  it('UNIT-RR-PRM-001 default beku, lolos validasi, setiap parameter punya spesifikasi (dan sebaliknya)', () => {
    expect(Object.isFrozen(DEFAULT_REVERSAL_PARAMS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_REVERSAL_PARAMS.expiryBars)).toBe(true);
    const p = resolveReversalParams();
    expect(p).toEqual(DEFAULT_REVERSAL_PARAMS);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.enterConfirmBars)).toBe(true);
    const specKeys = [...Object.keys(REVERSAL_PARAM_SPECS), ...Object.keys(REVERSAL_MAP_SPECS)].sort();
    expect(Object.keys(DEFAULT_REVERSAL_PARAMS).sort()).toEqual(specKeys);
    expect(REVERSAL_MAP_SPECS.enterConfirmBars.keys).toBe(REVERSAL_TIMEFRAMES);
    expect(REVERSAL_MAP_SPECS.expiryBars.keys).toBe(STAGES);
  });

  it('UNIT-RR-PRM-002 nilai kontrak §3.1/§4 (setelah penyetelan docs/21 §3) tersimpan sebagai default', () => {
    expect(DEFAULT_REVERSAL_PARAMS).toMatchObject({
      bottomLookback: 60, declineLookback: 120, minDeclineAtr: 3, minDeclinePct: 0.06, minBottomAge: 5, llStoppedBars: 8, bowlWindow: 40,
      atrContractionLookback: 20, rangeContractionLookback: 20, breakRvol: 1.5, invalidationBufferAtr: 0.25, failedBreakAtr: 0.75, lateAtr: 4,
      minEarlyEvidence: 2, minEarlyGroups: 2, minTriggerAboveBottomAtr: 1.5, minBaseBarsForTrigger: 8,
      weakBarsLimit: 6, extendedAtr: 2.5, extendedPct: 0.08, thinLiquidityRatio: 0.25, minQuoteVolume24h: 50_000_000,
      enterConfirmBars: { '5m': 2, '15m': 1, '1h': 1 },
      expiryBars: { EARLY_FORMATION: 48, DEVELOPING_REVERSAL: 36, CONFIRMED_BREAKOUT: 24 },
      minAvgQuoteVolume: { '5m': 20_000, '15m': 60_000, '1h': 240_000 },
    });
  });

  it('UNIT-RR-PRM-003 requiredCandles default 120 ≤ MAX_REQUIRED_CANDLES 150 ≤ REVERSAL_LOOKBACK 300; warm-up berlebihan ditolak', () => {
    expect(requiredCandles(DEFAULT_REVERSAL_PARAMS)).toBe(120);
    expect(requiredCandles(DEFAULT_REVERSAL_PARAMS)).toBeLessThanOrEqual(MAX_REQUIRED_CANDLES);
    expect(MAX_REQUIRED_CANDLES).toBeLessThanOrEqual(REVERSAL_LOOKBACK);
    expect(requiredCandles(resolveReversalParams({ minContextBars: 30 }))).toBe(63); // median ATR 50 + ATR 14 − 1
    expect(() => resolveReversalParams({ volatilityBaseline: 100, atrPeriod: 50, minContextBars: 150 })).not.toThrow();
    expect(() => resolveReversalParams({ volatilityBaseline: 100, atrPeriod: 50, bowlWindow: 120, rangeContractionLookback: 60, volumeDryUpBaseline: 150 })).toThrow(RangeError);
  });

  it('UNIT-RR-PRM-004 override parsial digabung (termasuk peta), hasil idempoten bila diberikan kembali', () => {
    const p = resolveReversalParams({ breakRvol: 2, enterConfirmBars: { '5m': 3 }, expiryBars: { CONFIRMED_BREAKOUT: 12 } }, '5m');
    expect(p.breakRvol).toBe(2);
    expect(p.enterConfirmBars).toEqual({ '5m': 3, '15m': 1, '1h': 1 });
    expect(p.expiryBars).toEqual({ EARLY_FORMATION: 48, DEVELOPING_REVERSAL: 36, CONFIRMED_BREAKOUT: 12 });
    expect(p.minAvgQuoteVolume).toEqual(DEFAULT_REVERSAL_PARAMS.minAvgQuoteVolume);
    expect(resolveReversalParams(p, '15m')).toEqual(p);
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
    expect(resolveReversalParams(null)).toEqual(DEFAULT_REVERSAL_PARAMS);
  });

  it('NEG-RR-PRM-001 kunci tak dikenal → TypeError; nilai tak valid → RangeError; timeframe tak dikenal → RangeError', () => {
    expect(() => resolveReversalParams({ bogus: 1 })).toThrow(TypeError);
    expect(() => resolveReversalParams({ enterConfirmBars: { '4h': 1 } })).toThrow(TypeError);
    expect(() => resolveReversalParams({ expiryBars: { QUIET: 1 } })).toThrow(TypeError);
    expect(() => resolveReversalParams({ enterConfirmBars: 2 })).toThrow(TypeError);
    expect(() => resolveReversalParams('x')).toThrow(TypeError);
    expect(() => resolveReversalParams([])).toThrow(TypeError);
    expect(() => resolveReversalParams({ breakRvol: 0 })).toThrow(RangeError);
    expect(() => resolveReversalParams({ breakRvol: 'a' })).toThrow(RangeError);
    expect(() => resolveReversalParams({ bottomLookback: 10.5 })).toThrow(RangeError);
    expect(() => resolveReversalParams({ enterConfirmBars: { '5m': 0 } })).toThrow(RangeError);
    expect(() => resolveReversalParams({ emaFast: 30 })).toThrow(RangeError);
    expect(() => resolveReversalParams({ bowlVertexMin: 0.9 })).toThrow(RangeError);
    expect(() => resolveReversalParams({ bottomHeldCloseAtr: 2, bottomHeldDepartAtr: 1 })).toThrow(RangeError);
    expect(() => resolveReversalParams({}, '4h')).toThrow(RangeError);
    expect(() => resolveReversalParams({}, '5m')).not.toThrow();
  });
});
