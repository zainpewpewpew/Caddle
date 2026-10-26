// API data pasar (baca saja): candle kanonik TERTUTUP untuk grafik simbol (side panel screener & Symbol Intelligence).
// Query string tidak dikoersi (AJV coerceTypes: false) sehingga angka divalidasi sebagai pola string.
// Candle yang belum tertutup (provisional) tidak pernah dikirim: grafik hanya menampilkan data yang juga dipakai sinyal.
import { isValidSymbol } from '../ingestion/candleValidator.js';
import { TIMEFRAMES } from '../market/contracts.js';

// limit 1..1000. Di luar rentang → 400, tidak dipotong diam-diam.
const LIMIT = { type: 'string', pattern: '^([1-9][0-9]{0,2}|1000)$' };
const DEFAULT_LIMIT = 300;

const candlesQuerySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['symbol', 'timeframe'],
  properties: {
    symbol: { type: 'string', pattern: '^[A-Z0-9]{2,30}$' },
    timeframe: { type: 'string', enum: [...TIMEFRAMES] },
    limit: LIMIT,
  },
};

/** Candle kanonik → bentuk ringkas untuk grafik (epoch ms UTC, urut naik). */
const toChartCandle = ({ openTime, open, high, low, close, volume }) => ({ openTime, open, high, low, close, volume });

export async function marketRoutes(app, { candles }) {
  app.get('/api/market/candles', { schema: { querystring: candlesQuerySchema } }, async (request) => {
    const { symbol, timeframe } = request.query;
    const limit = request.query.limit === undefined ? DEFAULT_LIMIT : Number.parseInt(request.query.limit, 10);
    // Simbol yang belum pernah diingesti (atau tidak dikenal) = daftar kosong, bukan error: tidak membocorkan
    // apakah simbol terdaftar dan UI cukup menampilkan empty state.
    const rows = isValidSymbol(symbol) ? await candles.getLatest({ symbol, timeframe, limit }) : [];
    const items = rows.map(toChartCandle);
    return { symbol, timeframe, items, count: items.length };
  });
}
