// Konteks pasar BTC & ETH dari candle 1h tertutup yang tersimpan (bukan data contoh).
// Bila simbol belum diingesti, statusnya 'no_data'.
import { classifyTrend } from '../timeframe/index.js';

export const CONTEXT_SYMBOLS = Object.freeze(['BTCUSDT', 'ETHUSDT']);
const LOOKBACK = 120;

/** @param {{ getLatest: Function }} candles repositori candle */
export async function buildMarketContext(candles, symbols = CONTEXT_SYMBOLS) {
  const items = [];
  for (const symbol of symbols) {
    const series = await candles.getLatest({ symbol, timeframe: '1h', limit: LOOKBACK });
    if (series.length === 0) {
      items.push({ symbol, status: 'no_data' });
      continue;
    }
    const last = series[series.length - 1];
    const dayAgo = series.length > 24 ? series[series.length - 25] : null;
    const { trend, reasons } = classifyTrend(series);
    items.push({
      symbol,
      status: 'ok',
      timeframe: '1h',
      lastPrice: last.close,
      asOf: last.closeTime,
      change24h: dayAgo ? last.close / dayAgo.close - 1 : null,
      trend,
      reasons,
    });
  }
  return items;
}
