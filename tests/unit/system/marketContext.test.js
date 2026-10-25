import { describe, expect, it } from 'vitest';
import { buildMarketContext } from '../../../backend/system/marketContext.js';
import { marketTrendBadge } from '../../../frontend/js/views/overview.js';

// Data uji deterministik — candle 1h SINTETIS, bukan data pasar nyata.
const H1 = 3_600_000;
const START = Date.UTC(2026, 0, 5);

function hourly(n, f) {
  return Array.from({ length: n }, (_, i) => {
    const close = f(i);
    const open = i === 0 ? close : f(i - 1);
    return {
      symbol: 'BTCUSDT', timeframe: '1h', openTime: START + i * H1, closeTime: START + (i + 1) * H1 - 1,
      open, high: Math.max(open, close) * 1.002, low: Math.min(open, close) * 0.998, close,
      volume: 10, quoteVolume: 10 * close, trades: 5, takerBuyVolume: 5, takerBuyQuoteVolume: 5 * close, isClosed: true, source: 'rest',
    };
  });
}
const up = (i) => 100 + 0.3 * i + 0.6 * Math.sin((2 * Math.PI * i) / 6);

/** Repositori candle palsu: getLatest mengembalikan deret tersimpan per simbol (maks `limit`). */
const fakeCandles = (bySymbol) => ({ getLatest: async ({ symbol, limit }) => (bySymbol[symbol] ?? []).slice(-limit) });

describe('konteks pasar BTC/ETH', () => {
  it('UNIT-MCTX-001 BTC dengan 5 candle 1h → status insufficient_data, trend null (harga nyata tetap); 120 candle naik → ok BULLISH; tanpa candle → no_data', async () => {
    const short = hourly(5, up);
    const [btc, eth] = await buildMarketContext(fakeCandles({ BTCUSDT: short }));
    expect(btc).toEqual({
      symbol: 'BTCUSDT', status: 'insufficient_data', timeframe: '1h', lastPrice: short.at(-1).close, asOf: short.at(-1).closeTime,
      change24h: null, trend: null, reasons: ['INSUFFICIENT_DATA'], candleCount: 5,
    });
    expect(eth).toEqual({ symbol: 'ETHUSDT', status: 'no_data' });

    const long = hourly(150, up);
    const [full] = await buildMarketContext(fakeCandles({ BTCUSDT: long }), ['BTCUSDT']);
    expect(full).toMatchObject({ status: 'ok', trend: 'BULLISH', candleCount: 120, lastPrice: long.at(-1).close });
    expect(full.change24h).toBeCloseTo(long.at(-1).close / long.at(-25).close - 1, 12);
  });

  it('UNIT-MCTX-002 badge overview: trend null / insufficient_data → "Trend tidak tersedia" (nada warn), tidak pernah badge NEUTRAL; trend nyata → label & nada trend', () => {
    expect(marketTrendBadge({ status: 'insufficient_data', trend: null, candleCount: 5 }))
      .toEqual({ text: 'Trend tidak tersedia: data kurang (5 candle 1h)', tone: 'warn' });
    expect(marketTrendBadge({ status: 'ok', trend: null })).toEqual({ text: 'Trend tidak tersedia', tone: 'warn' });
    expect(marketTrendBadge({ status: 'ok', trend: 'BULLISH' })).toEqual({ text: 'BULLISH', tone: 'bull' });
    expect(marketTrendBadge({ status: 'ok', trend: 'NEUTRAL' })).toEqual({ text: 'NEUTRAL', tone: undefined });
    expect(marketTrendBadge({ status: 'ok', trend: 'BEARISH' })).toEqual({ text: 'BEARISH', tone: 'bear' });
  });
});
