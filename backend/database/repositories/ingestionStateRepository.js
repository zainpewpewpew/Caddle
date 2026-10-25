// Status operasional ingesti: riwayat run, error terbaru, dan heartbeat worker (singleton).
// Dipakai halaman kesehatan & status sistem. Tidak pernah menyimpan rahasia — hanya pesan error ringkas.

const MESSAGE_MAX = 500;
const SOURCE_MAX = 64;
const RECENT_ERRORS = 20;
const DEFAULT_ERROR_RETENTION = 5_000;

function assertTime(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${name} wajib berupa epoch ms`);
}

/** Jumlah: bilangan bulat ≥ 0, atau array (dihitung panjangnya). */
function toCount(value, name) {
  if (Array.isArray(value)) return value.length;
  if (Number.isSafeInteger(value) && value >= 0) return value;
  throw new TypeError(`${name} harus bilangan bulat ≥ 0 atau array`);
}

/** Memotong teks berdasarkan code point agar pasangan surrogate tidak terbelah. */
function truncate(text, max) {
  return text.length <= max ? text : Array.from(text.slice(0, max * 2)).slice(0, max).join('');
}

function toMessage(message) {
  if (typeof message === 'string') return message;
  if (message instanceof Error) return message.message;
  try {
    return JSON.stringify(message) ?? String(message);
  } catch {
    return String(message);
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ errorRetention?: number }} [options] jumlah maksimum baris error yang disimpan
 */
export function createIngestionStateRepository(db, { errorRetention = DEFAULT_ERROR_RETENTION } = {}) {
  if (!Number.isSafeInteger(errorRetention) || errorRetention < 1) throw new RangeError('errorRetention harus bilangan bulat ≥ 1');

  const stmt = {
    insertRun: db.prepare(`INSERT INTO ingestion_runs (started_at, finished_at, symbols, candles, errors)
      VALUES (@startedAt, @finishedAt, @symbols, @candles, @errors)`),
    lastRun: db.prepare(`SELECT id, started_at, finished_at, symbols, candles, errors FROM ingestion_runs
      ORDER BY started_at DESC, id DESC LIMIT 1`),
    insertError: db.prepare('INSERT INTO ingestion_errors (at, source, message) VALUES (@at, @source, @message)'),
    // id bertambah monoton dan hanya baris tertua yang dihapus, sehingga id tetap berurutan.
    pruneErrors: db.prepare('DELETE FROM ingestion_errors WHERE id <= @lastId - @keep'),
    recentErrors: db.prepare(`SELECT id, at, source, message FROM ingestion_errors
      ORDER BY at DESC, id DESC LIMIT @limit`),
    heartbeat: db.prepare(`INSERT INTO worker_heartbeat (id, at, state_json) VALUES (1, @at, @stateJson)
      ON CONFLICT (id) DO UPDATE SET at = excluded.at, state_json = excluded.state_json`),
    getHeartbeat: db.prepare('SELECT at, state_json FROM worker_heartbeat WHERE id = 1'),
  };

  const writeError = db.transaction((row) => {
    const lastId = stmt.insertError.run(row).lastInsertRowid;
    stmt.pruneErrors.run({ lastId, keep: errorRetention });
  });

  return {
    /**
     * Mencatat satu run ingesti yang sudah selesai.
     * @param {{ startedAt: number, finishedAt: number, symbols: number|Array, candles: number|Array, errors: number|Array }} run
     * @returns {Promise<number>} id run
     */
    async recordRun({ startedAt, finishedAt, symbols, candles, errors } = {}) {
      assertTime(startedAt, 'startedAt');
      assertTime(finishedAt, 'finishedAt');
      if (finishedAt < startedAt) throw new TypeError('finishedAt tidak boleh sebelum startedAt');
      const row = {
        startedAt, finishedAt,
        symbols: toCount(symbols, 'symbols'),
        candles: toCount(candles, 'candles'),
        errors: toCount(errors, 'errors'),
      };
      return Number(stmt.insertRun.run(row).lastInsertRowid);
    },

    /**
     * Mencatat error ingesti. Pesan dipotong ≤ 500 karakter; Error/objek dikonversi ke teks.
     * Hanya `errorRetention` baris terbaru yang dipertahankan.
     * @param {{ at: number, source: string, message: unknown }} entry
     */
    async recordError({ at, source, message } = {}) {
      assertTime(at, 'at');
      if (typeof source !== 'string' || source.length === 0) throw new TypeError('source wajib teks tidak kosong');
      writeError({ at, source: truncate(source, SOURCE_MAX), message: truncate(toMessage(message), MESSAGE_MAX) });
    },

    /**
     * Memperbarui heartbeat worker (satu baris). `state` harus dapat di-serialisasi JSON.
     * @param {{ at: number, state?: unknown }} beat
     */
    async heartbeat({ at, state = {} } = {}) {
      assertTime(at, 'at');
      let stateJson;
      try {
        stateJson = JSON.stringify(state ?? {});
      } catch {
        stateJson = undefined;
      }
      if (typeof stateJson !== 'string') throw new TypeError('state heartbeat harus dapat di-serialisasi JSON');
      stmt.heartbeat.run({ at, stateJson });
    },

    /**
     * @returns {Promise<{ lastRun: null|{ id, startedAt, finishedAt, durationMs, symbols, candles, errors },
     *   recentErrors: Array<{ id, at, source, message }>, heartbeat: null|{ at, state } }>}
     */
    async getStatus() {
      const run = stmt.lastRun.get();
      const beat = stmt.getHeartbeat.get();
      return {
        lastRun: run ? {
          id: run.id,
          startedAt: run.started_at,
          finishedAt: run.finished_at,
          durationMs: run.finished_at - run.started_at,
          symbols: run.symbols,
          candles: run.candles,
          errors: run.errors,
        } : null,
        recentErrors: stmt.recentErrors.all({ limit: RECENT_ERRORS }),
        heartbeat: beat ? { at: beat.at, state: JSON.parse(beat.state_json) } : null,
      };
    },
  };
}
