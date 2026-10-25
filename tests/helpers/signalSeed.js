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

/** Heartbeat worker terakhir berstatus 'stopped' + satu error ingesti (sintetis) untuk layar System Health. */
export async function seedWorkerHistory(repos, { at = Date.now() } = {}) {
  await repos.ingestion.heartbeat({ at, state: { state: 'stopped', symbols: 1, streams: 3, staleStreams: 0, lastIngestionAt: at - 60_000,
    candleLagMs: null, scanDurationMs: 850, queue: 0, reconnects: 0, errors: 1, ws: 'stopped', gaps: 0, duplicates: 0 } });
  await repos.ingestion.recordError({ at: at - 30_000, source: 'ws', message: 'contoh error uji E2E (sintetis)' });
}

