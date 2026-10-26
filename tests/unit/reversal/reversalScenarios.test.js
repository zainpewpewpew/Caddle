// Skenario sintetis Reversal Radar: deterministik, kontrak Candle, dan ciri yang diklaim tiap skenario.
// Semua data SINTETIS (tests/fixtures/candles/reversalScenarios.js) — bukan data pasar nyata.
import { describe, expect, it } from 'vitest';
import { atr, ema } from '../../../backend/indicators/index.js';
import { HIGHER_TIMEFRAMES, TIMEFRAME_MS, isAlignedOpenTime } from '../../../backend/market/contracts.js';
import { REVERSAL_TIMEFRAMES } from '../../../backend/reversal/constants.js';
import {
  BROKEN_KINDS, EVALUATION_SEEDS, FALSE_POSITIVE_SCENARIOS, MIN_SCENARIO_BARS, SCENARIO_IDS, SCENARIO_WARMUP, TUNING_SEEDS,
  brokenData, buildScenario, continuedDowntrend, failedBounce, longSideways, lowVolumeIlliquid, parseScenarioSymbol, scenarioCatalog,
  scenarioSymbol, scenarioUniverse, seedRange, startPriceFor, successfulReversal, suddenPump, uptrendContinuation,
} from '../../fixtures/candles/reversalScenarios.js';

const SEEDS = [21, 22, 23, 37, 60];
const phase = (meta, name) => meta.phases.find((p) => p.name === name);
const slice = (meta, name) => {
  const p = phase(meta, name);
  return meta.candles.slice(p.startIndex, p.endIndex + 1);
};
const minLow = (xs) => Math.min(...xs.map((c) => c.low));
const maxHigh = (xs) => Math.max(...xs.map((c) => c.high));
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

function expectCandleContract(candles, timeframe, { contiguous = true, valid = true } = {}) {
  const ms = TIMEFRAME_MS[timeframe];
  candles.forEach((c, i) => {
    expect(isAlignedOpenTime(c.openTime, timeframe)).toBe(true);
    expect(c.closeTime).toBe(c.openTime + ms - 1);
    if (contiguous && i > 0) expect(c.openTime - candles[i - 1].openTime).toBe(ms);
    if (valid) {
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
      expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
    }
    expect(c.low).toBeGreaterThan(0);
    expect(c.volume).toBeGreaterThanOrEqual(0);
    expect(c.takerBuyVolume).toBeLessThanOrEqual(c.volume + 1e-9);
    expect(c.takerBuyQuoteVolume).toBeLessThanOrEqual(c.quoteVolume + 1e-9);
    expect(c).toMatchObject({ timeframe, isClosed: true, source: 'rest' });
  });
}

describe('katalog & determinisme', () => {
  it('UNIT-RRV-001 katalog memuat 8 skenario, deterministik per seed, panjang ≥ 350 pada semua timeframe', () => {
    const catalog = scenarioCatalog();
    expect(catalog.map((s) => s.id)).toEqual([...SCENARIO_IDS]);
    expect(SCENARIO_IDS).toEqual(['successfulReversal', 'failedBounce', 'continuedDowntrend', 'longSideways', 'suddenPump', 'lowVolumeIlliquid', 'brokenData', 'uptrendContinuation']);
    for (const entry of catalog) {
      expect(typeof entry.label).toBe('string');
      expect(typeof entry.expectation).toBe('string');
      expect(entry.falsePositive).toBe(FALSE_POSITIVE_SCENARIOS.includes(entry.id));
      const a = entry.build(21);
      expect(a).toEqual(entry.build(21));
      expect(a).not.toEqual(entry.build(22));
      for (const timeframe of REVERSAL_TIMEFRAMES) {
        const c = entry.build(21, { timeframe });
        expect(c.length).toBeGreaterThanOrEqual(MIN_SCENARIO_BARS);
        expect(c[0].openTime % TIMEFRAME_MS[timeframe]).toBe(0);
        // Bentuk chart identik antar-timeframe: hanya stempel waktu yang berbeda.
        expect(c.map((x) => x.close)).toEqual(a.map((x) => x.close));
      }
    }
    expect(TUNING_SEEDS).toEqual({ from: 1, to: 20 });
    expect(EVALUATION_SEEDS).toEqual({ from: 21, to: 60 });
    expect(seedRange(EVALUATION_SEEDS)).toHaveLength(40);
    expect(seedRange({ from: 3, to: 5 })).toEqual([3, 4, 5]);
    expect(() => seedRange({ from: 5, to: 3 })).toThrow(RangeError);
    expect(() => buildScenario('tidakAda', 1)).toThrow(RangeError);
    expect(() => buildScenario('successfulReversal', -1)).toThrow(RangeError);
    expect(() => buildScenario('successfulReversal', 1, { timeframe: '4h' })).toThrow(RangeError);
  });

  it('UNIT-RRV-002 kontrak Candle: openTime sejajar, closeTime benar, tanpa gap, OHLC valid, taker ≤ volume', () => {
    for (const id of SCENARIO_IDS.filter((x) => x !== 'brokenData')) {
      for (const timeframe of REVERSAL_TIMEFRAMES) expectCandleContract(buildScenario(id, 21, { timeframe }).candles, timeframe);
    }
    const sym = scenarioSymbol('failedBounce', 42);
    expect(sym).toBe('failedBounce-42');
    expect(parseScenarioSymbol(sym)).toEqual({ scenario: 'failedBounce', seed: 42 });
    expect(parseScenarioSymbol('BTCUSDT')).toBeNull();
    expect(parseScenarioSymbol('tidakAda-1')).toBeNull();
    expect(buildScenario('suddenPump', 7).candles[0].symbol).toBe('suddenPump-7');
    // Harga awal tersebar log-uniform 0,01..1000 dan berbeda antar-seed.
    const prices = seedRange(EVALUATION_SEEDS).map(startPriceFor);
    expect(Math.min(...prices)).toBeGreaterThanOrEqual(0.01);
    expect(Math.max(...prices)).toBeLessThanOrEqual(1000);
    expect(new Set(prices).size).toBe(prices.length);
    expect(Math.min(...prices)).toBeLessThan(1);
    expect(Math.max(...prices)).toBeGreaterThan(100);
  });
});

describe('ciri skenario', () => {
  it('UNIT-RRV-003 successfulReversal: penurunan ≥ 4 ATR, lower low makin dangkal, dasar tidak ditembus, volume mengering, breakout RVOL ≥ 1,5, close akhir > high dasar', () => {
    for (const seed of SEEDS) {
      const meta = buildScenario('successfulReversal', seed);
      const { candles, landmarks } = meta;
      expect(candles).toEqual(successfulReversal(seed));
      expect(meta.phases.map((p) => p.name)).toEqual(['warmup', 'decline', 'shallower', 'base', 'higherLow', 'breakout', 'markup', 'after']);
      expect(phase(meta, 'warmup')).toMatchObject({ startIndex: 0, endIndex: SCENARIO_WARMUP - 1 });
      const b = landmarks.bottomIndex;
      // Dasar = akhir fase lower low makin dangkal (tepat sebelum fase dasar).
      expect(b).toBeGreaterThanOrEqual(phase(meta, 'shallower').startIndex);
      expect(b).toBeLessThanOrEqual(phase(meta, 'base').endIndex);
      const atr14 = atr(candles, 14);
      const topClose = Math.max(...candles.slice(Math.max(0, b - 120), b + 1).map((c) => c.close));
      expect((topClose - candles[b].low) / atr14[b]).toBeGreaterThanOrEqual(4);
      expect((topClose - candles[b].low) / topClose).toBeGreaterThanOrEqual(0.06);
      // Lower low makin dangkal: low tiap siklus 12 candle menurun, kedalaman mengecil.
      const sh = phase(meta, 'shallower');
      const lows = [0, 1, 2].map((k) => minLow(candles.slice(sh.startIndex + 12 * k, sh.startIndex + 12 * (k + 1))));
      expect(lows[1]).toBeLessThan(lows[0]);
      expect(lows[1] - lows[2]).toBeLessThan(lows[0] - lows[1]);
      // Dasar tidak ditembus close setelah bottom.
      expect(candles.slice(b + 1).every((c) => c.close > candles[b].low)).toBe(true);
      // Volume mengering di akhir dasar vs fase penurunan.
      const base = slice(meta, 'base');
      expect(mean(base.slice(-10).map((c) => c.volume))).toBeLessThan(0.7 * mean(slice(meta, 'decline').map((c) => c.volume)));
      // Breakout dengan RVOL ≥ 1,5 lalu close akhir di atas high dasar.
      const bo = phase(meta, 'breakout');
      const rvol = candles[bo.startIndex].volume / mean(candles.slice(bo.startIndex - 20, bo.startIndex).map((c) => c.volume));
      expect(rvol).toBeGreaterThanOrEqual(1.5);
      expect(landmarks.breakoutIndex).toBe(bo.startIndex);
      expect(candles.at(-1).close).toBeGreaterThan(maxHigh(base));
    }
  });

  it('UNIT-RRV-004 failedBounce: pantulan 0,5–3 ATR tanpa dasar lalu lower low baru menembus dasar', () => {
    for (const seed of SEEDS) {
      const meta = buildScenario('failedBounce', seed);
      expect(meta.candles).toEqual(failedBounce(seed));
      const decline = slice(meta, 'decline');
      const bounce = slice(meta, 'bounce');
      const atr14 = atr(meta.candles, 14);
      const bottomBefore = minLow(decline);
      const bounceAtr = (Math.max(...bounce.map((c) => c.close)) - bottomBefore) / atr14[phase(meta, 'decline').endIndex];
      expect(bounceAtr).toBeGreaterThanOrEqual(0.5);
      expect(bounceAtr).toBeLessThanOrEqual(3);
      expect(bounce.length).toBeLessThanOrEqual(6); // tanpa pembentukan dasar
      expect(minLow([...slice(meta, 'breakdown'), ...slice(meta, 'decline2')])).toBeLessThan(bottomBefore * 0.97);
    }
  });

  it('UNIT-RRV-005 continuedDowntrend: lower low terus-menerus (minimum tiap blok 35 candle menurun), EMA25 turun', () => {
    for (const seed of SEEDS) {
      const candles = continuedDowntrend(seed);
      const blocks = [];
      for (let i = SCENARIO_WARMUP; i + 35 <= candles.length; i += 35) blocks.push(minLow(candles.slice(i, i + 35)));
      expect(blocks.length).toBeGreaterThanOrEqual(5);
      for (let k = 1; k < blocks.length; k += 1) expect(blocks[k]).toBeLessThan(blocks[k - 1]);
      const e = ema(candles.map((c) => c.close), 25);
      expect(e.at(-1)).toBeLessThan(e.at(-30));
    }
  });

  it('UNIT-RRV-006 longSideways: range sempit datar tanpa dasar naik', () => {
    for (const seed of SEEDS) {
      const meta = buildScenario('longSideways', seed);
      expect(meta.candles).toEqual(longSideways(seed));
      const range = slice(meta, 'range');
      expect(range.length).toBeGreaterThanOrEqual(170);
      expect((maxHigh(range) - minLow(range)) / minLow(range)).toBeLessThanOrEqual(0.03);
      const third = Math.floor(range.length / 3);
      const first = minLow(range.slice(0, third));
      const last = minLow(range.slice(-third));
      expect(Math.abs(last - first) / first).toBeLessThan(0.01);
    }
  });

  it('UNIT-RRV-007 suddenPump: sideways sempit tanpa dasar lalu dua candle ≥ +8 % dengan RVOL ≥ 3', () => {
    for (const seed of SEEDS) {
      const meta = buildScenario('suddenPump', seed);
      expect(meta.candles).toEqual(suddenPump(seed));
      const flat = slice(meta, 'flat');
      expect((maxHigh(flat) - minLow(flat)) / minLow(flat)).toBeLessThanOrEqual(0.03);
      const pump = slice(meta, 'pump');
      expect(pump).toHaveLength(2);
      expect(pump.at(-1).close / pump[0].open).toBeGreaterThanOrEqual(1.08);
      const start = phase(meta, 'pump').startIndex;
      expect(meta.landmarks.pumpIndex).toBe(start);
      const rvol = pump[0].volume / mean(meta.candles.slice(start - 20, start).map((c) => c.volume));
      expect(rvol).toBeGreaterThanOrEqual(3);
    }
  });

  it('UNIT-RRV-008 lowVolumeIlliquid: bentuk harga sama dengan successfulReversal, quote volume per candle < 20 ribu USDT', () => {
    for (const seed of SEEDS) {
      const thin = lowVolumeIlliquid(seed);
      const rich = successfulReversal(seed);
      expect(thin.map((c) => [c.open, c.high, c.low, c.close])).toEqual(rich.map((c) => [c.open, c.high, c.low, c.close]));
      for (const timeframe of REVERSAL_TIMEFRAMES) {
        const c = lowVolumeIlliquid(seed, { timeframe });
        expect(mean(c.map((x) => x.quoteVolume))).toBeLessThan(20_000);
      }
      expect(mean(rich.map((x) => x.quoteVolume))).toBeGreaterThan(60_000);
    }
  });

  it('UNIT-RRV-009 brokenData: satu gap waktu, volume nol beruntun, satu candle rusak; jenis dapat dipilih; fase bergeser', () => {
    const seed = 21;
    const meta = buildScenario('brokenData', seed);
    expect(meta.candles).toEqual(brokenData(seed));
    const ms = TIMEFRAME_MS['15m'];
    const gaps = meta.candles.filter((c, i) => i > 0 && c.openTime - meta.candles[i - 1].openTime !== ms);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].openTime - meta.candles[meta.candles.indexOf(gaps[0]) - 1].openTime).toBe(3 * ms);
    expect(meta.candles.filter((c) => c.volume === 0)).toHaveLength(5);
    expect(meta.candles.filter((c) => c.high < Math.max(c.open, c.close))).toHaveLength(1);
    expectCandleContract(meta.candles, '15m', { contiguous: false, valid: false });
    const intact = buildScenario('successfulReversal', seed);
    expect(meta.candles).toHaveLength(intact.candles.length - 2);
    expect(phase(meta, 'base').startIndex).toBe(phase(intact, 'base').startIndex - 2);
    for (const kind of BROKEN_KINDS) {
      const c = brokenData(seed, { kind });
      const hasGap = c.some((x, i) => i > 0 && x.openTime - c[i - 1].openTime !== ms);
      expect(hasGap).toBe(kind === 'gap' || kind === 'all');
      expect(c.some((x) => x.volume === 0)).toBe(kind === 'zeroVolume' || kind === 'all');
      expect(c.some((x) => x.high < Math.max(x.open, x.close))).toBe(kind === 'corrupt' || kind === 'all');
    }
    expect(() => brokenData(seed, { kind: 'banjir' })).toThrow(RangeError);
  });

  it('UNIT-RRV-010 uptrendContinuation: EMA25 naik monoton, higher high/higher low, tanpa penurunan ≥ 3 ATR atau 6 %', () => {
    for (const seed of SEEDS) {
      const candles = uptrendContinuation(seed);
      const closes = candles.map((c) => c.close);
      const e = ema(closes, 25);
      for (let i = SCENARIO_WARMUP + 30; i < candles.length; i += 1) expect(e[i]).toBeGreaterThanOrEqual(e[i - 1]);
      const atr14 = atr(candles, 14);
      let runningHigh = closes[SCENARIO_WARMUP];
      for (let i = SCENARIO_WARMUP; i < candles.length; i += 1) {
        runningHigh = Math.max(runningHigh, closes[i]);
        expect((runningHigh - candles[i].low) / atr14[i]).toBeLessThan(3);
        expect((runningHigh - candles[i].low) / runningHigh).toBeLessThan(0.06);
      }
      const blocks = [];
      for (let i = SCENARIO_WARMUP; i + 40 <= candles.length; i += 40) blocks.push([minLow(candles.slice(i, i + 40)), maxHigh(candles.slice(i, i + 40))]);
      for (let k = 1; k < blocks.length; k += 1) {
        expect(blocks[k][0]).toBeGreaterThan(blocks[k - 1][0]);
        expect(blocks[k][1]).toBeGreaterThan(blocks[k - 1][1]);
      }
    }
  });
});

describe('scenarioUniverse', () => {
  it('UNIT-RRV-011 semesta skenario × seed dengan HTF agregasi tanpa look-ahead', () => {
    const universe = scenarioUniverse({ seeds: [21, 22], timeframe: '5m', scenarios: ['successfulReversal', 'suddenPump'] });
    expect(Object.keys(universe).sort()).toEqual(['successfulReversal-21', 'successfulReversal-22', 'suddenPump-21', 'suddenPump-22']);
    for (const [symbol, byTf] of Object.entries(universe)) {
      expect(Object.keys(byTf).sort()).toEqual(['15m', '1h', '5m']);
      const base = byTf['5m'];
      expect(base).toEqual(buildScenario(parseScenarioSymbol(symbol).scenario, parseScenarioSymbol(symbol).seed, { timeframe: '5m' }).candles);
      for (const htf of HIGHER_TIMEFRAMES['5m']) {
        const list = byTf[htf];
        expect(list.length).toBe(Math.floor(base.length / (TIMEFRAME_MS[htf] / TIMEFRAME_MS['5m'])));
        expectCandleContract(list, htf);
        expect(list.every((c) => c.closeTime <= base.at(-1).closeTime)).toBe(true);
        expect(list[0].symbol).toBe(symbol);
      }
    }
    const all = scenarioUniverse({ seeds: [21], timeframe: '1h', scenarios: 'all' });
    expect(Object.keys(all)).toHaveLength(SCENARIO_IDS.length);
    expect(Object.keys(all['brokenData-21'])).toEqual(['1h']);
    const defaults = scenarioUniverse({ scenarios: ['uptrendContinuation'] });
    expect(Object.keys(defaults)).toHaveLength(40);
    expect(Object.keys(defaults['uptrendContinuation-21']).sort()).toEqual(['15m', '1h']);
    expect(() => scenarioUniverse({ seeds: [] })).toThrow(RangeError);
    expect(() => scenarioUniverse({ seeds: [1], scenarios: ['x'] })).toThrow(RangeError);
  });
});
