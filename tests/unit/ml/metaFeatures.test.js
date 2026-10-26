// Fitur meta-labeling: bentuk vektor, cermin arah, dan TANPA LOOKAHEAD lewat runner.
import { describe, expect, it } from 'vitest';
import { replaySeries, runBacktest } from '../../../backend/backtest/runner.js';
import { renderMarkdownReport } from '../../../backend/backtest/report.js';
import { aggregateCandles, generateSeries } from '../../../backend/backtest/synthetic.js';
import { META_FEATURE_NAMES, metaFeatures } from '../../../backend/ml/metaFeatures.js';

const series = (bars, seed, regimes) => {
  const candles = generateSeries({ symbol: 'MLUSDT', bars, seed, regimes });
  return { '15m': candles, '1h': aggregateCandles(candles, '1h') };
};

describe('metaFeatures', () => {
  it('UNIT-ML-FEAT-001 panjang tetap, data kosong → NaN (bukan error), arah SHORT dicerminkan', () => {
    const byTf = series(200, 1, [{ type: 'RANDOM_WALK', bars: 200 }]);
    const candles = byTf['15m'];
    const last = candles.at(-1);
    const base = { timeframe: '15m', candles, entryPrice: last.close, entryTime: last.closeTime, features: { orderFlow: { flowBias: 0.4, takerBuyRatio: 0.6 } } };
    const long = metaFeatures({ ...base, direction: 'LONG', stopPrice: last.close * 0.99 });
    const short = metaFeatures({ ...base, direction: 'SHORT', stopPrice: last.close * 1.01 });
    expect(long).toHaveLength(META_FEATURE_NAMES.length);
    const at = (v, name) => v[META_FEATURE_NAMES.indexOf(name)];
    expect(at(long, 'flowBias')).toBeCloseTo(0.4);
    expect(at(short, 'flowBias')).toBeCloseTo(-0.4);
    expect(at(long, 'takerImbalance')).toBeCloseTo(0.1);
    expect(at(short, 'takerImbalance')).toBeCloseTo(-0.1);
    expect(at(short, 'isShort')).toBe(1);
    expect(at(long, 'tf15m')).toBe(1);
    expect(Number.isNaN(at(long, 'confluenceScore'))).toBe(true);
    expect(at(long, 'riskAtr')).toBeGreaterThan(0);
    expect(() => metaFeatures({ ...base, direction: 'UP' })).toThrow(RangeError);
  });

  it('NEG-ML-FEAT-001 UJI KEBOCORAN: vektor fitur entri identik walau candle masa depan diubah/dipotong', async () => {
    const byTf = series(900, 21, [
      { type: 'RANDOM_WALK', bars: 250 }, { type: 'ACCUMULATION', bars: 80 }, { type: 'RANDOM_WALK', bars: 250 },
      { type: 'DISTRIBUTION', bars: 80 }, { type: 'RANDOM_WALK', bars: 240 },
    ]);
    const cut = 700;
    const short = { '15m': byTf['15m'].slice(0, cut) };
    short['1h'] = byTf['1h'].filter((c) => c.closeTime <= short['15m'].at(-1).closeTime);
    const full = await replaySeries({ symbol: 'MLUSDT', timeframe: '15m', byTf, options: { ml: true } });
    const part = await replaySeries({ symbol: 'MLUSDT', timeframe: '15m', byTf: short, options: { ml: true } });
    const key = (t) => `${t.direction}|${t.entryIndex}`;
    const fullByKey = new Map(full.trades.v2.map((t) => [key(t), t]));
    expect(part.trades.v2.length).toBeGreaterThan(0);
    for (const t of part.trades.v2) {
      expect(t.ml).toHaveLength(META_FEATURE_NAMES.length);
      expect(fullByKey.get(key(t))?.ml).toEqual(t.ml);
    }
  }, 90_000);

  it('NEG-ML-RW-001 random walk murni → ML TIDAK diadopsi dan kontrol acak tidak menunjukkan kebocoran; laporan memuat lab ML', async () => {
    const candles = {};
    for (let s = 1; s <= 6; s += 1) {
      const c = generateSeries({ symbol: `R${s}USDT`, bars: 3000, seed: 300 + s, regimes: [{ type: 'RANDOM_WALK', bars: 3000 }] });
      candles[`R${s}USDT`] = { '15m': c, '1h': aggregateCandles(c, '1h') };
    }
    const result = await runBacktest({ candles, timeframes: ['15m'], ml: true });
    expect(result.ml.samples).toBeGreaterThan(0);
    expect(result.ml.verdict.adopted).toBe(false);
    expect(result.ml.verdict.leakageSuspected).toBe(false);
    const md = renderMarkdownReport({ ...result, meta: { ...result.meta, source: 'synthetic' } });
    expect(md).toContain('## Lab meta-labeling (machine learning)');
    expect(md).toContain('ML TIDAK diadopsi');
    expect(md).toContain('Data sintetis');
    const plain = await runBacktest({ candles: { R1USDT: candles.R1USDT }, timeframes: ['15m'] });
    expect(plain.ml).toBeNull();
    expect(renderMarkdownReport(plain)).not.toContain('Lab meta-labeling');
  }, 180_000);
});
