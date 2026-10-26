// Runner backtest walk-forward: mekanika (bentuk hasil, train/test, laporan) dan uji kebocoran pada random walk.
import { describe, expect, it } from 'vitest';
import { renderMarkdownReport } from '../../../backend/backtest/report.js';
import { BACKTEST_WARMUP, replaySeries, runBacktest } from '../../../backend/backtest/runner.js';
import { aggregateCandles, generateSeries } from '../../../backend/backtest/synthetic.js';

const universe = (count, bars, seedBase, regimes) => {
  const out = {};
  for (let s = 1; s <= count; s += 1) {
    const symbol = `T${s}USDT`;
    const candles = generateSeries({ symbol, bars, seed: seedBase + s, regimes: regimes(bars) });
    out[symbol] = { '15m': candles, '1h': aggregateCandles(candles, '1h') };
  }
  return out;
};

describe('runner backtest', () => {
  it('UNIT-BT-RUN-001 pasar dengan akumulasi/distribusi tertanam → trade v2 & v3, laporan lengkap, v3 ⊆ selektivitas v2', async () => {
    const candles = universe(2, 900, 40, () => [
      { type: 'RANDOM_WALK', bars: 200 }, { type: 'ACCUMULATION', bars: 80 }, { type: 'RANDOM_WALK', bars: 150 },
      { type: 'DISTRIBUTION', bars: 80 }, { type: 'RANDOM_WALK', bars: 150 }, { type: 'ACCUMULATION', bars: 80 }, { type: 'RANDOM_WALK', bars: 100 },
    ]);
    const result = await runBacktest({ candles, timeframes: ['15m'] });
    expect(result.meta).toMatchObject({ baseline: 'v2', candidate: 'v3', targetR: 2, maxBars: 48, breakEvenWinRate: 1 / 3 });
    expect(result.meta.validation).toMatch(/holdout berurutan waktu/);
    const { v2, v3 } = result.variants;
    expect(result.trades.v2).toBeGreaterThan(0);
    expect(result.trades.v3).toBeLessThanOrEqual(result.trades.v2);
    for (const v of [v2, v3]) {
      expect(v.trainSummary.n + v.testSummary.n).toBeLessThanOrEqual(result.trades[v === v2 ? 'v2' : 'v3']);
      expect(Object.keys(v.byDirection).every((d) => ['LONG', 'SHORT'].includes(d))).toBe(true);
    }
    const md = renderMarkdownReport({ ...result, meta: { ...result.meta, source: 'synthetic', symbols: Object.keys(candles), timeframes: ['15m'] } });
    expect(md).toContain('Perbandingan sebelum vs sesudah');
    expect(md).toContain('holdout berurutan waktu');
  }, 60_000);

  it('UNIT-BT-RUN-002 entri hanya setelah warm-up, exit setelah entri, tier & skor konfluensi tercatat', async () => {
    const candles = universe(1, 700, 7, () => [{ type: 'RANDOM_WALK', bars: 250 }, { type: 'ACCUMULATION', bars: 80 }, { type: 'RANDOM_WALK', bars: 300 }]);
    const [[symbol, byTf]] = Object.entries(candles);
    const { trades } = await replaySeries({ symbol, timeframe: '15m', byTf });
    for (const t of [...trades.v2, ...trades.v3]) {
      expect(t.entryIndex).toBeGreaterThanOrEqual(BACKTEST_WARMUP);
      expect(t.exitIndex).toBeGreaterThan(t.entryIndex);
      expect(['A', 'B', 'C', 'D']).toContain(t.tier);
      expect(t.score).toBeGreaterThanOrEqual(0);
    }
  }, 60_000);

  it('NEG-BT-RUN-001 UJI KEBOCORAN: random walk murni → tidak ada edge positif yang signifikan (tanpa lookahead)', async () => {
    // Pada random walk tanpa drift tidak ada informasi yang dapat diprediksi. Bila runner/fitur bocor (memakai candle
    // masa depan), expectancy akan positif signifikan. Biaya membuat expectancy wajar sedikit negatif.
    const candles = universe(4, 1600, 100, (bars) => [{ type: 'RANDOM_WALK', bars }]);
    const result = await runBacktest({ candles, timeframes: ['15m'] });
    for (const key of ['v2', 'v3']) {
      const v = result.variants[key];
      for (const sum of [v.trainSummary, v.testSummary]) {
        if (sum.n < 20) continue;
        expect(sum.expectancyCi[0]).toBeLessThan(0); // batas bawah CI 95% tidak di atas nol
        expect(sum.winRate).toBeLessThan(0.45); // titik impas 2R = 33%; jauh di atas itu = curiga bocor
      }
    }
  }, 90_000);
});
