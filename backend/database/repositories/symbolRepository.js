// Repositori simbol Binance USDT-M Futures: metadata exchange, status pantauan, dan delisting.
// Daftar simbol dikirim sebagai parameter JSON (json_each) — tanpa interpolasi string SQL.

import { isValidSymbol } from '../../ingestion/candleValidator.js';

const TEXT_MAX = 32;
// Batas daftar entri yang ditolak di hasil upsertFromExchange (jumlah totalnya tetap dilaporkan di rejectedCount),
// agar respons exchangeInfo yang aneh tidak menghasilkan log/objek tanpa batas.
export const REJECTED_LIST_MAX = 50;
const REJECTED_SYMBOL_MAX = 64;
const DECIMAL_PATTERN = /^[0-9]+(\.[0-9]+)?([eE]-?[0-9]+)?$/;

const isText = (value, { allowEmpty = false } = {}) => typeof value === 'string'
  && value.length <= TEXT_MAX && (allowEmpty || value.length > 0);

function assertNow(now) {
  if (typeof now !== 'number' || !Number.isFinite(now)) throw new TypeError('now wajib berupa epoch ms');
}

function assertArray(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} harus berupa array`);
}

/** tickSize/stepSize disimpan sebagai TEXT agar nilai desimal persis terjaga. */
function toDecimalText(value, field, errors) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return String(value);
  if (typeof value === 'string' && value.length <= TEXT_MAX && DECIMAL_PATTERN.test(value) && Number(value) > 0) return value;
  errors.push(`${field} harus desimal > 0 atau null`);
  return null;
}

/** Memvalidasi SymbolInfo (kontrak §2) dan memetakannya ke parameter baris. */
function toRow(info, now) {
  if (info === null || typeof info !== 'object' || Array.isArray(info)) {
    return { errors: ['SymbolInfo harus berupa objek'] };
  }
  const errors = [];
  if (!isValidSymbol(info.symbol)) errors.push('symbol tidak valid (harus [A-Z0-9]{1,32})');
  if (!isText(info.baseAsset)) errors.push('baseAsset wajib teks 1–32 karakter');
  if (!isText(info.quoteAsset)) errors.push('quoteAsset wajib teks 1–32 karakter');
  if (!isText(info.contractType, { allowEmpty: true })) errors.push('contractType wajib teks ≤ 32 karakter');
  if (!isText(info.status)) errors.push('status wajib teks 1–32 karakter');
  const tickSize = toDecimalText(info.tickSize, 'tickSize', errors);
  const stepSize = toDecimalText(info.stepSize, 'stepSize', errors);
  if (errors.length) return { errors };
  return {
    errors,
    row: {
      symbol: info.symbol, baseAsset: info.baseAsset, quoteAsset: info.quoteAsset, contractType: info.contractType,
      status: info.status, tickSize, stepSize, now,
    },
  };
}

/** Daftar simbol unik, urutan masukan dipertahankan. */
const unique = (symbols) => [...new Set(symbols)];

/** @param {import('better-sqlite3').Database} db */
export function createSymbolRepository(db) {
  const stmt = {
    getId: db.prepare('SELECT id FROM symbols WHERE symbol = ?'),
    insert: db.prepare(`INSERT INTO symbols
      (symbol, base_asset, quote_asset, contract_type, status, tick_size, step_size, first_seen_at, last_seen_at)
      VALUES (@symbol, @baseAsset, @quoteAsset, @contractType, @status, @tickSize, @stepSize, @now, @now)`),
    // Muncul lagi dengan status TRADING setelah delisting → dianggap listing ulang.
    update: db.prepare(`UPDATE symbols SET base_asset = @baseAsset, quote_asset = @quoteAsset,
      contract_type = @contractType, status = @status, tick_size = @tickSize, step_size = @stepSize,
      last_seen_at = @now, delisted_at = CASE WHEN @status = 'TRADING' THEN NULL ELSE delisted_at END
      WHERE symbol = @symbol`),
    unmonitorOthers: db.prepare(`UPDATE symbols SET is_monitored = 0, monitored_since = NULL
      WHERE is_monitored = 1 AND (delisted_at IS NOT NULL OR symbol NOT IN (SELECT value FROM json_each(@list)))`),
    monitor: db.prepare(`UPDATE symbols SET is_monitored = 1,
      monitored_since = CASE WHEN is_monitored = 1 THEN COALESCE(monitored_since, @now) ELSE @now END
      WHERE delisted_at IS NULL AND symbol IN (SELECT value FROM json_each(@list))`),
    listMonitored: db.prepare(`SELECT symbol FROM symbols
      WHERE is_monitored = 1 AND delisted_at IS NULL ORDER BY symbol`),
    markDelisted: db.prepare(`UPDATE symbols SET delisted_at = @now, is_monitored = 0, monitored_since = NULL
      WHERE delisted_at IS NULL AND symbol IN (SELECT value FROM json_each(@list))`),
  };

  const listMonitored = () => stmt.listMonitored.all().map((r) => r.symbol);

  return {
    /**
     * Menyisipkan/memperbarui metadata simbol dari exchangeInfo dalam satu transaksi.
     * Entri tidak valid (mis. kontrak delivery `XXXUSDT_YYMMDD` yang tidak lolos pola simbol) TIDAK disimpan dan
     * dilaporkan: `rejectedCount` = jumlah total, `rejected` = maks REJECTED_LIST_MAX entri pertama
     * (`symbol` = teks ≤ 64 karakter atau null). Duplikat dalam masukan → entri terakhir menang.
     * @param {Array<object>} symbols SymbolInfo[]
     * @param {number} now epoch ms
     * @returns {Promise<{ inserted: number, updated: number, rejectedCount: number,
     *   rejected: Array<{ symbol: string|null, errors: string[] }> }>}
     */
    async upsertFromExchange(symbols, now) {
      assertArray(symbols, 'symbols');
      assertNow(now);
      const rejected = [];
      let rejectedCount = 0;
      const rows = new Map();
      for (const info of symbols) {
        const { errors, row } = toRow(info, now);
        if (errors.length) {
          rejectedCount += 1;
          if (rejected.length < REJECTED_LIST_MAX) {
            const symbol = typeof info?.symbol === 'string' ? info.symbol.slice(0, REJECTED_SYMBOL_MAX) : null;
            rejected.push({ symbol, errors });
          }
        } else {
          rows.set(row.symbol, row);
        }
      }
      return db.transaction(() => {
        let inserted = 0;
        let updated = 0;
        for (const row of rows.values()) {
          if (stmt.getId.get(row.symbol)) {
            stmt.update.run(row);
            updated += 1;
          } else {
            stmt.insert.run(row);
            inserted += 1;
          }
        }
        return { inserted, updated, rejected, rejectedCount };
      })();
    },

    /**
     * Menetapkan himpunan simbol yang dipantau; simbol lain dilepas dari pantauan.
     * Simbol yang tidak dikenal, formatnya salah, atau sudah delisted dikembalikan di `skipped`.
     * @param {string[]} symbols
     * @param {number} now epoch ms (dicatat sebagai `monitored_since` untuk simbol yang baru dipantau)
     * @returns {Promise<{ monitored: string[], skipped: string[] }>}
     */
    async setMonitored(symbols, now) {
      assertArray(symbols, 'symbols');
      assertNow(now);
      const requested = unique(symbols);
      const list = JSON.stringify(requested.filter(isValidSymbol));
      return db.transaction(() => {
        stmt.unmonitorOthers.run({ list });
        stmt.monitor.run({ list, now });
        const monitored = listMonitored();
        const active = new Set(monitored);
        return { monitored, skipped: requested.filter((s) => !active.has(s)) };
      })();
    },

    /** @returns {Promise<string[]>} simbol yang dipantau dan belum delisted, terurut. */
    async listMonitored() {
      return listMonitored();
    },

    /**
     * Menandai simbol delisted (riwayat candle tetap disimpan). Idempoten: waktu delisting pertama dipertahankan.
     * @returns {Promise<number>} jumlah simbol yang baru ditandai
     */
    async markDelisted(symbols, now) {
      assertArray(symbols, 'symbols');
      assertNow(now);
      const list = JSON.stringify(unique(symbols).filter(isValidSymbol));
      return stmt.markDelisted.run({ list, now }).changes;
    },

    /** @returns {Promise<number|null>} */
    async getId(symbol) {
      if (!isValidSymbol(symbol)) return null;
      return stmt.getId.get(symbol)?.id ?? null;
    },
  };
}
