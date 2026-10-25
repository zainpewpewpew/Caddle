import { describe, expect, it } from 'vitest';
import { createBinanceRestClient } from '../../backend/ingestion/binance/restClient.js';
import { createKlineStream } from '../../backend/ingestion/binance/wsClient.js';
import { discoverSymbols } from '../../backend/ingestion/symbolDiscovery.js';
import { validateCandle } from '../../backend/ingestion/candleValidator.js';
import { TIMEFRAME_MS } from '../../backend/market/contracts.js';
import { DEFAULT_SCANNER_SETTINGS } from '../../backend/settings/scannerSettings.js';

// Uji integrasi LIVE terbatas terhadap data pasar PUBLIK Binance USDT-M Futures (baca saja, tanpa
// API key, tanpa order). TIDAK termasuk suite default — hanya `LIVE_BINANCE=1 npm run test:live`.
// Bobot request total kecil (< 100 dari batas 2400/menit). Bukan pemindaian keamanan.
const LIVE = process.env.LIVE_BINANCE === '1';

describe.skipIf(!LIVE)('LIVE Binance USDT-M (data pasar publik)', () => {
  const rest = createBinanceRestClient({ timeoutMs: 15_000, maxRetries: 1 });

  it('LIVE-BN-001 waktu server dekat dengan jam lokal (selisih < 60 dtk)', async () => {
    const serverTime = await rest.getServerTime();
    expect(Math.abs(serverTime - Date.now())).toBeLessThan(60_000);
  });

  it('LIVE-BN-002 exchangeInfo + ticker + bookTicker → discovery memilih perpetual USDT yang TRADING', async () => {
    const [symbols, tickers, bookTickers] = await Promise.all([rest.getExchangeInfo(), rest.get24hTickers(), rest.getBookTickers()]);
    expect(symbols.length).toBeGreaterThan(50);
    const { selected } = discoverSymbols({ symbols, tickers, bookTickers, settings: DEFAULT_SCANNER_SETTINGS });
    expect(selected.length).toBeGreaterThan(0);
    const bySymbol = new Map(symbols.map((s) => [s.symbol, s]));
    for (const s of selected) {
      expect(bySymbol.get(s.symbol)).toMatchObject({ contractType: 'PERPETUAL', quoteAsset: 'USDT', status: 'TRADING' });
      expect(s.quoteVolume24h).toBeGreaterThanOrEqual(DEFAULT_SCANNER_SETTINGS.liquidity.minQuoteVolume24h);
    }
  });

  it.each(['5m', '15m', '1h'])('LIVE-BN-003 klines BTCUSDT %s: candle valid, berurutan, hanya yang lewat closeTime bertanda tertutup', async (timeframe) => {
    const candles = await rest.getKlines({ symbol: 'BTCUSDT', timeframe, limit: 5 });
    const now = Date.now();
    expect(candles).toHaveLength(5);
    for (const [i, c] of candles.entries()) {
      expect(c.closeTime).toBe(c.openTime + TIMEFRAME_MS[timeframe] - 1);
      if (i > 0) expect(c.openTime - candles[i - 1].openTime).toBe(TIMEFRAME_MS[timeframe]);
      // Semua kecuali candle terakhir sudah lewat closeTime → wajib tertutup & lolos validasi.
      if (i < candles.length - 1) {
        expect(c.isClosed).toBe(true);
        expect(validateCandle(c, { now }).errors).toEqual([]);
      }
    }
    // Candle terakhir biasanya masih berjalan → provisional, tidak boleh masuk tabel kanonik.
    expect(candles.at(-1).isClosed).toBe(candles.at(-1).closeTime < now);
  });

  it('LIVE-BN-004 WebSocket kline menerima update (provisional) BTCUSDT 5m dalam 20 detik', async () => {
    const received = [];
    const stream = createKlineStream({ streams: [{ symbol: 'BTCUSDT', timeframe: '5m' }], onCandle: (c) => received.push(c) });
    stream.start();
    const started = Date.now();
    while (received.length === 0 && Date.now() - started < 20_000) await new Promise((r) => setTimeout(r, 250));
    stream.stop();
    expect(received.length).toBeGreaterThan(0);
    expect(received[0]).toMatchObject({ symbol: 'BTCUSDT', timeframe: '5m', source: 'ws' });
  }, 30_000);
});
