// Fitur v3 (struktur pasar, order flow, rezim, likuiditas/Wyckoff) untuk skor konfluensi LONG & SHORT.
// Dihitung SEKALI per candle untuk kedua arah: fitur tidak berarah (tanda + = bullish), arah diterapkan oleh
// backend/scoring/confluence.js. Semua fungsi murni dan hanya memakai candle ≤ indeks terakhir (tanpa lookahead).
import { analyzeLiquidity } from './liquidity.js';
import { analyzeMarketStructure } from './marketStructure.js';
import { analyzeOrderFlow } from './orderFlow.js';
import { analyzeRegime } from './regime.js';

export { analyzeLiquidity, LIQUIDITY_THRESHOLDS } from './liquidity.js';
export { analyzeMarketStructure, STRUCTURE_PARAMS } from './marketStructure.js';
export { FLOW_BIAS_WEIGHTS, ORDER_FLOW_THRESHOLDS, accumulationDistribution, analyzeOrderFlow, cmf, cvd, obv } from './orderFlow.js';
export { REGIMES, REGIME_THRESHOLDS, adx, analyzeRegime, bollingerBandwidth, choppiness, efficiencyRatio } from './regime.js';

/** Satu fitur; data yang tidak dapat dihitung (input rusak) → null agar konfluensi melewati komponennya. */
function safely(fn, candles) {
  try {
    return fn(candles);
  } catch {
    return null;
  }
}

/**
 * Semua fitur v3 pada candle terakhir.
 * @param {import('../market/contracts.js').Candle[]} candles candle tertutup satu seri, urut naik
 * @returns {{ structure: object|null, orderFlow: object|null, regime: object|null, liquidity: object|null }}
 */
export function extractFeatures(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return { structure: null, orderFlow: null, regime: null, liquidity: null };
  return {
    structure: safely(analyzeMarketStructure, candles),
    orderFlow: safely(analyzeOrderFlow, candles),
    regime: safely(analyzeRegime, candles),
    liquidity: safely(analyzeLiquidity, candles),
  };
}
