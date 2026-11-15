// API Reversal Radar (baca saja, docs/19-kontrak-reversal-radar.md §7): kandidat reversal aktif untuk LONG Scanner,
// riwayat kandidat beserta event-nya, dan detail satu kandidat. Di balik auth yang sama dengan /api/signals/*.
// Query string tidak dikoersi (AJV coerceTypes: false) sehingga angka divalidasi sebagai pola string.
// `sensitivity` (LOW/MEDIUM/HIGH) adalah FILTER TAMPILAN (skor & jumlah bukti minimum, SENSITIVITY_FILTERS) yang
// diterapkan di server SEBELUM limit — bukan parameter mesin, sehingga histori tidak bergantung pilihan UI.
// Skor kandidat = skor aturan yang dapat dijelaskan, BUKAN probabilitas; tidak ada perintah transaksi.
// Kandidat aktif hanya untuk timeframe radar AKTIF (REVERSAL_ACTIVE_TIMEFRAMES, saat ini 1h): kandidat lama 5m/15m yang
// belum ditutup worker tidak pernah tampil; ?timeframe= di luar daftar aktif → daftar kosong (bukan 400).
import {
  LIQUIDITY_CLASSES, OPEN_STATUSES, REVERSAL_ACTIVE_TIMEFRAMES, REVERSAL_TIMEFRAMES, SENSITIVITIES, SENSITIVITY_FILTERS, STAGES,
} from '../reversal/constants.js';

// limit 1..500 (sama dengan batas listActive/history di repositori). Di luar rentang → 400, tidak dipotong diam-diam.
const LIMIT = { type: 'string', pattern: '^([1-9][0-9]?|[1-4][0-9]{2}|500)$' };
const FLAG = { type: 'string', enum: ['0', '1'] };
const DEFAULT_ACTIVE_LIMIT = 200;
const DEFAULT_HISTORY_LIMIT = 100;
/** Tanpa `sensitivity` = HIGH (semua kandidat mesin, tanpa filter tampilan). UI mengirim pilihannya (default MEDIUM). */
const DEFAULT_SENSITIVITY = 'HIGH';

const candidatesQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    timeframe: { type: 'string', enum: [...REVERSAL_TIMEFRAMES] },
    stage: { type: 'string', enum: [...STAGES] },
    // Hanya status terbuka; kandidat batal/kedaluwarsa ada di /history.
    status: { type: 'string', enum: [...OPEN_STATUSES] },
    // Kelas likuiditas MINIMUM: LIQUID = hanya likuid, THIN = likuid + tipis.
    liquidity: { type: 'string', enum: LIQUIDITY_CLASSES.filter((c) => c === 'LIQUID' || c === 'THIN') },
    minScore: { type: 'string', pattern: '^(100|[1-9]?[0-9])$' },
    sensitivity: { type: 'string', enum: [...SENSITIVITIES] },
    includeExtended: FLAG,
    includeProvisional: FLAG,
    limit: LIMIT,
  },
};

const historyQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    symbol: { type: 'string', pattern: '^[A-Z0-9]{2,30}$' },
    timeframe: { type: 'string', enum: [...REVERSAL_TIMEFRAMES] },
    limit: LIMIT,
  },
};

const candidateParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' } },
};

const toInt = (value, fallback) => (value === undefined ? fallback : Number.parseInt(value, 10));

/**
 * @param {{ reversal: object, candles: object, timeframes?: readonly string[]|null }} deps repositori reversal (§5) &
 *   candle (harga terakhir per seri). `timeframes`: timeframe radar aktif (default REVERSAL_ACTIVE_TIMEFRAMES); null =
 *   semua REVERSAL_TIMEFRAMES (tanpa pembatasan, dipakai tes mekanika).
 */
export async function reversalRoutes(app, { reversal, candles, timeframes = REVERSAL_ACTIVE_TIMEFRAMES }) {
  if (!reversal || !candles) throw new TypeError('reversal dan candles wajib ada');
  if (timeframes !== null && !Array.isArray(timeframes)) throw new TypeError('timeframes harus array atau null');
  const active = timeframes === null ? [...REVERSAL_TIMEFRAMES] : REVERSAL_TIMEFRAMES.filter((tf) => timeframes.includes(tf));
  const allActive = active.length === REVERSAL_TIMEFRAMES.length;

  /**
   * Menambahkan lastPrice/lastCandleAt (candle tutup terakhir seri) dan livePrice/livePriceAt (candle berjalan dari
   * WebSocket) ke setiap baris; tanpa candle → null, tidak dikarang.
   */
  async function withLastPrice(rows) {
    const out = [];
    for (const row of rows) {
      const [last] = await candles.getLatest({ symbol: row.symbol, timeframe: row.timeframe, limit: 1 });
      const live = typeof candles.getLivePrice === 'function' ? await candles.getLivePrice({ symbol: row.symbol, timeframe: row.timeframe }) : null;
      out.push({
        ...row, lastPrice: last?.close ?? null, lastCandleAt: last?.closeTime ?? null,
        livePrice: live?.price ?? null, livePriceAt: live?.at ?? null,
      });
    }
    return out;
  }

  app.get('/api/reversal/candidates', { schema: { querystring: candidatesQuerySchema } }, async (request) => {
    const q = request.query;
    const sensitivity = q.sensitivity ?? DEFAULT_SENSITIVITY;
    const filter = SENSITIVITY_FILTERS[sensitivity];
    const meta = { timeframes: active, sensitivity, filters: SENSITIVITY_FILTERS };
    if (q.timeframe !== undefined && !active.includes(q.timeframe)) return { items: [], count: 0, meta };
    // Satu timeframe aktif → disaring di query (sebelum limit); beberapa (bukan semua) → disaring setelah query.
    const timeframe = q.timeframe ?? (allActive ? null : active.length === 1 ? active[0] : null);
    const rows = await reversal.listActive({
      timeframe,
      stage: q.stage ?? null,
      status: q.status ?? null,
      liquidity: q.liquidity ?? null,
      // minScore eksplisit menang atas minScore sensitivitas; minEvidence selalu dari sensitivitas.
      minScore: q.minScore === undefined ? filter.minScore : toInt(q.minScore),
      minEvidence: filter.minEvidence,
      includeExtended: q.includeExtended !== '0',
      includeProvisional: q.includeProvisional !== '0',
      limit: toInt(q.limit, DEFAULT_ACTIVE_LIMIT),
    });
    const scoped = timeframe === null && !allActive ? rows.filter((r) => active.includes(r.timeframe)) : rows;
    const items = await withLastPrice(scoped);
    return { items, count: items.length, meta };
  });

  app.get('/api/reversal/history', { schema: { querystring: historyQuerySchema } }, async (request) => {
    const q = request.query;
    const items = await reversal.history({ symbol: q.symbol ?? null, timeframe: q.timeframe ?? null, limit: toInt(q.limit, DEFAULT_HISTORY_LIMIT) });
    return { items, count: items.length };
  });

  app.get('/api/reversal/candidates/:id', { schema: { params: candidateParamsSchema } }, async (request, reply) => {
    const item = await reversal.getById(Number.parseInt(request.params.id, 10));
    if (!item) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Kandidat reversal tidak ditemukan' });
    const [withPrice] = await withLastPrice([item]);
    return withPrice;
  });
}
