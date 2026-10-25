import { createAnalysisPipeline } from '../../backend/analysis/pipeline.js';
import { silentAccumulationCandles } from '../fixtures/candles/scenarios.js';

// Mengisi database dengan sinyal hasil pipeline ASLI atas candle SINTETIS (bukan data pasar nyata).
export const SEED_SYMBOL = 'SYNUSDT';
const NOW = Date.UTC(2027, 0, 1);

export async function seedSignals(repos, { symbol = SEED_SYMBOL, seed = 1 } = {}) {
  await repos.symbols.upsertFromExchange([{
    symbol, baseAsset: symbol.replace(/USDT$/, ''), quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING',
    tickSize: '0.0001', stepSize: '1', onboardDate: 0,
  }], NOW);
  const pipeline = createAnalysisPipeline({ repos, signals: repos.signals });
  const candles = silentAccumulationCandles(seed).map((c) => ({ ...c, symbol }));
  for (const candle of candles) {
    await repos.candles.upsertClosed([candle], { now: NOW });
    await pipeline.onClosedCandles({ symbol, timeframe: '5m' });
  }
  return { candles };
}
