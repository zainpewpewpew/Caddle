// Repositori candle kanonik. Hanya candle TERTUTUP yang lolos validasi masuk tabel `candles`;
// candle yang belum tertutup disimpan terpisah di `provisional_candles` (satu baris per simbol × timeframe).
// Identitas candle: (symbol, timeframe, openTime). Semua SQL memakai parameter terikat.

import { isValidSymbol, normalizeBatch, validateCandle } from '../../ingestion/candleValidator.js';
import { TIMEFRAMES, TIMEFRAME_MS } from '../../market/contracts.js';

const MAX_LATEST_LIMIT = 10_000;
const DEFAULT_LATEST_LIMIT = 500;

/** Error penyimpanan candle; `errors` berisi alasan validasi bila ada. */
export class CandleStoreError extends Error {
  constructor(message, errors = []) {
    super(errors.length ? `${message}: ${errors.join('; ')}` : message);
    this.name = 'CandleStoreError';
    this.errors = errors;
  }
}

function assertTime(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${name} harus berupa epoch ms (angka finite)`);
}

/** Memvalidasi argumen baca { symbol, timeframe }. */
function assertSeries({ symbol, timeframe } = {}) {
  if (!isValidSymbol(symbol)) throw new TypeError('symbol tidak valid');
  if (!TIMEFRAMES.includes(timeframe)) throw new TypeError(`timeframe tidak didukung: ${String(timeframe)}`);
}

/** Baris database → Candle kanonik (contracts.js). */
function toCandle(row, symbol, timeframe, isClosed) {
  return {
    symbol,
    timeframe,
    openTime: row.open_time,
    closeTime: row.close_time,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    quoteVolume: row.quote_volume,
    trades: row.trade_count,
    takerBuyVolume: row.taker_buy_volume,
    takerBuyQuoteVolume: row.taker_buy_quote_volume,
    isClosed,
    source: row.source,
  };
}

/** Candle → parameter statement. */
function toParams(candle, symbolId, now) {
  return {
    symbolId,
    timeframe: candle.timeframe,
    openTime: candle.openTime,
    closeTime: candle.closeTime,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    quoteVolume: candle.quoteVolume,
    trades: candle.trades,
    takerBuyVolume: candle.takerBuyVolume,
    takerBuyQuoteVolume: candle.takerBuyQuoteVolume,
    source: candle.source,
    now,
  };
}

const unknownSymbol = (symbol) => `simbol ${symbol} belum terdaftar di tabel symbols`;

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ clock?: () => number }} [options] jam untuk validasi "tertutup" dan `ingested_at`
 */
export function createCandleRepository(db, { clock = Date.now } = {}) {
  const stmt = {
    symbolId: db.prepare('SELECT id FROM symbols WHERE symbol = ?').pluck(),
    insert: db.prepare(`INSERT INTO candles (symbol_id, timeframe, open_time, close_time, open, high, low, close,
        volume, quote_volume, trade_count, taker_buy_volume, taker_buy_quote_volume, source, is_closed, ingested_at)
      VALUES (@symbolId, @timeframe, @openTime, @closeTime, @open, @high, @low, @close, @volume, @quoteVolume, @trades,
              @takerBuyVolume, @takerBuyQuoteVolume, @source, 1, @now)
      ON CONFLICT (symbol_id, timeframe, open_time) DO NOTHING`),
    // Hanya menulis bila data pasar berubah (mis. koreksi REST); data identik = tidak ada perubahan.
    update: db.prepare(`UPDATE candles SET close_time = @closeTime, open = @open, high = @high, low = @low, close = @close,
        volume = @volume, quote_volume = @quoteVolume, trade_count = @trades, taker_buy_volume = @takerBuyVolume,
        taker_buy_quote_volume = @takerBuyQuoteVolume, is_closed = 1, source = @source, ingested_at = @now
      WHERE symbol_id = @symbolId AND timeframe = @timeframe AND open_time = @openTime
        AND (close_time <> @closeTime OR open <> @open OR high <> @high OR low <> @low OR close <> @close
          OR volume <> @volume OR quote_volume <> @quoteVolume OR trade_count <> @trades
          OR taker_buy_volume <> @takerBuyVolume OR taker_buy_quote_volume <> @takerBuyQuoteVolume OR is_closed <> 1)`),
    dropProvisional: db.prepare(`DELETE FROM provisional_candles
      WHERE symbol_id = @symbolId AND timeframe = @timeframe AND open_time <= @openTime`),
    range: db.prepare(`SELECT c.open_time, c.close_time, c.open, c.high, c.low, c.close, c.volume, c.quote_volume,
        c.trade_count, c.taker_buy_volume, c.taker_buy_quote_volume, c.source
      FROM candles c JOIN symbols s ON s.id = c.symbol_id
      WHERE s.symbol = @symbol AND c.timeframe = @timeframe AND c.open_time BETWEEN @from AND @to
      ORDER BY c.open_time`),
    latestDesc: db.prepare(`SELECT c.open_time, c.close_time, c.open, c.high, c.low, c.close, c.volume, c.quote_volume,
        c.trade_count, c.taker_buy_volume, c.taker_buy_quote_volume, c.source
      FROM candles c JOIN symbols s ON s.id = c.symbol_id
      WHERE s.symbol = @symbol AND c.timeframe = @timeframe
      ORDER BY c.open_time DESC LIMIT @limit`),
    lastOpenTime: db.prepare(`SELECT MAX(c.open_time) FROM candles c JOIN symbols s ON s.id = c.symbol_id
      WHERE s.symbol = @symbol AND c.timeframe = @timeframe`).pluck(),
    openTimes: db.prepare(`SELECT c.open_time FROM candles c JOIN symbols s ON s.id = c.symbol_id
      WHERE s.symbol = @symbol AND c.timeframe = @timeframe AND c.open_time BETWEEN @from AND @to
      ORDER BY c.open_time`).pluck(),
    closedSince: db.prepare(`SELECT 1 FROM candles
      WHERE symbol_id = @symbolId AND timeframe = @timeframe AND open_time >= @openTime LIMIT 1`).pluck(),
    // Satu baris per simbol × timeframe; pesan provisional yang lebih lama dari baris tersimpan diabaikan.
    upsertProvisional: db.prepare(`INSERT INTO provisional_candles (symbol_id, timeframe, open_time, close_time, open,
        high, low, close, volume, quote_volume, trade_count, taker_buy_volume, taker_buy_quote_volume, source, updated_at)
      VALUES (@symbolId, @timeframe, @openTime, @closeTime, @open, @high, @low, @close, @volume, @quoteVolume, @trades,
              @takerBuyVolume, @takerBuyQuoteVolume, @source, @now)
      ON CONFLICT (symbol_id, timeframe) DO UPDATE SET open_time = excluded.open_time, close_time = excluded.close_time,
        open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close, volume = excluded.volume,
        quote_volume = excluded.quote_volume, trade_count = excluded.trade_count,
        taker_buy_volume = excluded.taker_buy_volume, taker_buy_quote_volume = excluded.taker_buy_quote_volume,
        source = excluded.source, updated_at = excluded.updated_at
      WHERE excluded.open_time >= provisional_candles.open_time`),
    provisional: db.prepare(`SELECT p.open_time, p.close_time, p.open, p.high, p.low, p.close, p.volume, p.quote_volume,
        p.trade_count, p.taker_buy_volume, p.taker_buy_quote_volume, p.source
      FROM provisional_candles p JOIN symbols s ON s.id = p.symbol_id
      WHERE s.symbol = @symbol AND p.timeframe = @timeframe`),
  };

  const resolveNow = (options) => {
    const now = options?.now ?? clock();
    assertTime(now, 'now');
    return now;
  };

  const writeClosed = db.transaction((candles, now, rejected) => {
    let inserted = 0;
    let updated = 0;
    const ids = new Map();
    const newest = new Map(); // openTime terbaru per (symbolId, timeframe) → bersihkan provisional
    for (const candle of candles) {
      if (!ids.has(candle.symbol)) ids.set(candle.symbol, stmt.symbolId.get(candle.symbol) ?? null);
      const symbolId = ids.get(candle.symbol);
      if (symbolId === null) {
        rejected.push({ candle, errors: [unknownSymbol(candle.symbol)] });
        continue;
      }
      const params = toParams(candle, symbolId, now);
      if (stmt.insert.run(params).changes === 1) inserted += 1;
      else if (stmt.update.run(params).changes === 1) updated += 1;
      newest.set(`${symbolId}\u0000${candle.timeframe}`, { symbolId, timeframe: candle.timeframe, openTime: candle.openTime });
    }
    for (const key of newest.values()) stmt.dropProvisional.run(key);
    return { inserted, updated };
  });

  return {
    /**
     * Menyimpan candle tertutup secara idempoten dalam satu transaksi.
     * Masukan boleh acak dan berduplikat (versi terakhir menang). Candle tidak valid, belum tertutup,
     * atau bersimbol yang belum terdaftar dikembalikan di `rejected` — tidak menggagalkan batch.
     * @param {import('../../market/contracts.js').Candle[]} candles
     * @param {{ now?: number }} [options] waktu acuan "tertutup" (default: clock), mis. waktu server Binance
     * @returns {Promise<{ inserted: number, updated: number, rejected: Array<{ candle: unknown, errors: string[] }> }>}
     */
    async upsertClosed(candles, options) {
      if (!Array.isArray(candles)) throw new TypeError('candles harus berupa array');
      const now = resolveNow(options);
      const rejected = [];
      const valid = [];
      for (const candle of candles) {
        const { ok, errors } = validateCandle(candle, { now });
        if (!ok) rejected.push({ candle, errors });
        else if (candle.isClosed !== true) rejected.push({ candle, errors: ['candle belum tertutup (isClosed false) — simpan lewat upsertProvisional'] });
        else valid.push(candle);
      }
      const { inserted, updated } = writeClosed(normalizeBatch(valid), now, rejected);
      return { inserted, updated, rejected };
    },

    /**
     * Candle tertutup dengan openTime di [from, to] (inklusif), urut naik.
     * @returns {Promise<import('../../market/contracts.js').Candle[]>}
     */
    async getRange({ symbol, timeframe, from, to } = {}) {
      assertSeries({ symbol, timeframe });
      assertTime(from, 'from');
      assertTime(to, 'to');
      return stmt.range.all({ symbol, timeframe, from, to }).map((row) => toCandle(row, symbol, timeframe, true));
    },

    /**
     * `limit` candle tertutup terakhir, urut naik.
     * @returns {Promise<import('../../market/contracts.js').Candle[]>}
     */
    async getLatest({ symbol, timeframe, limit = DEFAULT_LATEST_LIMIT } = {}) {
      assertSeries({ symbol, timeframe });
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LATEST_LIMIT) {
        throw new RangeError(`limit harus bilangan bulat 1–${MAX_LATEST_LIMIT}`);
      }
      return stmt.latestDesc.all({ symbol, timeframe, limit }).reverse().map((row) => toCandle(row, symbol, timeframe, true));
    },

    /** @returns {Promise<number|null>} openTime candle tertutup terbaru */
    async getLastOpenTime({ symbol, timeframe } = {}) {
      assertSeries({ symbol, timeframe });
      return stmt.lastOpenTime.get({ symbol, timeframe }) ?? null;
    },

    /**
     * Rentang openTime candle tertutup yang hilang di [from, to]. Batas dibulatkan ke dalam
     * ke open time yang sejajar interval; setiap rentang { from, to } inklusif.
     * Pemanggil sebaiknya memberi `to` ≤ openTime candle tertutup terakhir yang diharapkan.
     * @returns {Promise<Array<{ from: number, to: number }>>}
     */
    async findGaps({ symbol, timeframe, from, to } = {}) {
      assertSeries({ symbol, timeframe });
      assertTime(from, 'from');
      assertTime(to, 'to');
      const ms = TIMEFRAME_MS[timeframe];
      const start = Math.ceil(from / ms) * ms;
      const end = Math.floor(to / ms) * ms;
      if (start > end) return [];

      const gaps = [];
      let expected = start;
      for (const openTime of stmt.openTimes.all({ symbol, timeframe, from: start, to: end })) {
        if (openTime > expected) gaps.push({ from: expected, to: openTime - ms });
        expected = Math.max(expected, openTime + ms);
      }
      if (expected <= end) gaps.push({ from: expected, to: end });
      return gaps;
    },

    /**
     * Menyimpan candle yang BELUM tertutup (provisional). Tidak pernah masuk tabel `candles`.
     * Diabaikan bila sudah ada provisional lebih baru atau candle tertutup untuk interval yang sama/lebih baru.
     * @param {import('../../market/contracts.js').Candle} candle
     * @param {{ now?: number }} [options]
     * @throws {CandleStoreError} candle tidak valid, sudah tertutup, atau simbol belum terdaftar
     */
    async upsertProvisional(candle, options) {
      const now = resolveNow(options);
      const { ok, errors } = validateCandle(candle, { now });
      if (!ok) throw new CandleStoreError('candle provisional tidak valid', errors);
      if (candle.isClosed !== false) throw new CandleStoreError('candle tertutup harus disimpan lewat upsertClosed');
      db.transaction(() => {
        const symbolId = stmt.symbolId.get(candle.symbol);
        if (symbolId === undefined) throw new CandleStoreError(unknownSymbol(candle.symbol));
        const params = toParams(candle, symbolId, now);
        if (stmt.closedSince.get(params)) return;
        stmt.upsertProvisional.run(params);
      })();
    },

    /** @returns {Promise<import('../../market/contracts.js').Candle|null>} candle provisional terbaru (isClosed false) */
    async getProvisional({ symbol, timeframe } = {}) {
      assertSeries({ symbol, timeframe });
      const row = stmt.provisional.get({ symbol, timeframe });
      return row ? toCandle(row, symbol, timeframe, false) : null;
    },
  };
}
