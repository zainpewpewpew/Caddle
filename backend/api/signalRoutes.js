// API sinyal (baca saja): kandidat aktif untuk screener dan riwayat sinyal dengan transisinya.
// Query string tidak dikoersi (AJV coerceTypes: false) sehingga angka divalidasi sebagai pola string.
import { ALIGNMENTS, TIMEFRAMES } from '../market/contracts.js';
import { PATTERN_STATES } from '../signals/index.js';

// limit 1..500 (sama dengan batas listActive/history di repositori). Di luar rentang → 400, tidak dipotong diam-diam.
const LIMIT = { type: 'string', pattern: '^([1-9][0-9]?|[1-4][0-9]{2}|500)$' };

const activeQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    timeframe: { type: 'string', enum: [...TIMEFRAMES] },
    classification: { type: 'string', enum: ['SA', 'PVA', 'BOTH'] },
    state: { type: 'string', enum: [...PATTERN_STATES] },
    // Alignment HTF difilter di server SEBELUM limit, agar hasil tidak terpotong oleh top-N patternScore.
    alignment: { type: 'string', enum: [...ALIGNMENTS] },
    minScore: { type: 'string', pattern: '^(100|[1-9]?[0-9])$' },
    limit: LIMIT,
  },
};

const historyQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    symbol: { type: 'string', pattern: '^[A-Z0-9]{2,30}$' },
    limit: LIMIT,
  },
};

const toInt = (value, fallback) => (value === undefined ? fallback : Number.parseInt(value, 10));

export async function signalRoutes(app, { signals, candles }) {
  async function withLastPrice(rows) {
    const out = [];
    for (const row of rows) {
      const [last] = await candles.getLatest({ symbol: row.symbol, timeframe: row.timeframe, limit: 1 });
      out.push({ ...row, lastPrice: last?.close ?? null, lastCandleAt: last?.closeTime ?? null });
    }
    return out;
  }

  app.get('/api/signals/active', { schema: { querystring: activeQuerySchema } }, async (request) => {
    const q = request.query;
    const limit = toInt(q.limit, 200);
    const rows = await signals.listActive({
      timeframe: q.timeframe ?? null,
      classification: q.classification ?? null,
      state: q.state ?? null,
      alignment: q.alignment ?? null,
      minScore: q.minScore === undefined ? null : toInt(q.minScore),
      limit,
    });
    return { items: await withLastPrice(rows), count: rows.length };
  });

  app.get('/api/signals/history', { schema: { querystring: historyQuerySchema } }, async (request) => {
    const limit = toInt(request.query.limit, 100);
    const items = await signals.history({ symbol: request.query.symbol ?? null, limit });
    return { items, count: items.length };
  });
}
