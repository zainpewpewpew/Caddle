// Repositori sinyal: tabel signals, signal_events, pattern_definitions (migrasi 002).
// Satu-satunya tempat SQL sinyal ditulis; semua query statis dengan parameter terikat.
//
// Catatan skema: migrasi 002 belum memiliki kolom untuk lastCandleTime, lastEvaluatedAt,
// barsInState, peakPrice, dan peakState yang dibutuhkan untuk melanjutkan state machine
// setelah restart. Sampai migrasi baru menambah kolom tersebut, nilainya disimpan di
// explanation_json sebagai { factors: [...penjelasan skor], tracking: {...} }.

import { ALIGNMENTS, RISK_FLAGS, SIGNAL_STATES, TERMINAL_STATES, TIMEFRAMES, TIMEFRAME_MS } from '../market/contracts.js';
import { MONITORING_STOP_REASONS, PATTERN_STATES } from './params.js';

export class SignalRepositoryError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SignalRepositoryError';
    this.code = code;
  }
}

const SIGNAL_CLASSIFICATIONS = Object.freeze(['SA', 'PVA', 'BOTH']);
const SYMBOL_RE = /^[A-Z0-9]{2,30}$/;
const PATTERN_KEY_RE = /^[A-Z0-9_]{1,32}$/;
const DEFINITION_STATUSES = Object.freeze(['draft', 'review', 'validated', 'active', 'retired']);
const HISTORY_MAX = 500;
const ACTIVE_MAX = 500;

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/** JSON dengan kunci terurut agar perbandingan definisi tidak bergantung urutan properti. */
function canonicalJson(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    return v;
  };
  return JSON.stringify(sort(value));
}

function assertSymbol(symbol) {
  if (typeof symbol !== 'string' || !SYMBOL_RE.test(symbol)) throw new RangeError('Simbol tidak valid');
}
function assertTimeframe(timeframe) {
  if (!TIMEFRAMES.includes(timeframe)) throw new RangeError(`Timeframe tidak didukung: ${timeframe}`);
}
function assertLimit(limit, max) {
  if (!Number.isInteger(limit) || limit < 1 || limit > max) throw new RangeError(`limit harus bilangan bulat 1..${max}`);
}
function assertScore(v, name) {
  if (v !== null && v !== undefined && !(isFiniteNumber(v) && v >= 0 && v <= 100)) throw new RangeError(`${name} harus 0..100`);
}

function assertSnapshot(s) {
  if (!SIGNAL_CLASSIFICATIONS.includes(s.classification)) throw new RangeError(`Klasifikasi sinyal tidak valid: ${s.classification}`);
  if (!PATTERN_KEY_RE.test(String(s.patternKey))) throw new RangeError('snapshot.patternKey tidak valid');
  if (!Number.isInteger(s.patternVersion) || s.patternVersion < 1) throw new RangeError('snapshot.patternVersion tidak valid');
  if (!Number.isInteger(s.firstDetectedAt)) throw new TypeError('snapshot.firstDetectedAt harus bilangan bulat');
  if (!(isFiniteNumber(s.firstDetectedPrice) && s.firstDetectedPrice > 0)) throw new RangeError('snapshot.firstDetectedPrice harus > 0');
  if (s.invalidationPrice !== null && !isFiniteNumber(s.invalidationPrice)) throw new TypeError('snapshot.invalidationPrice harus angka atau null');
  assertScore(s.patternScore, 'patternScore');
  assertScore(s.earlyScore, 'earlyScore');
  if (s.alignment !== null && s.alignment !== undefined && !ALIGNMENTS.includes(s.alignment)) throw new RangeError('snapshot.alignment tidak valid');
  if (!Array.isArray(s.riskFlags) || s.riskFlags.some((f) => !RISK_FLAGS.includes(f))) throw new RangeError('snapshot.riskFlags harus subset RISK_FLAGS');
  if (!Number.isInteger(s.lastCandleTime)) throw new TypeError('snapshot.lastCandleTime harus bilangan bulat');
}

function assertEvent(event, snapshot) {
  if (event === null || typeof event !== 'object') throw new TypeError('event harus objek atau null');
  if (event.toState !== snapshot.state) throw new RangeError('event.toState harus sama dengan snapshot.state');
  if (event.fromState !== null && !SIGNAL_STATES.includes(event.fromState)) throw new RangeError('event.fromState tidak valid');
  if (!Number.isInteger(event.candleTime)) throw new TypeError('event.candleTime harus bilangan bulat');
  if (event.price !== null && event.price !== undefined && !isFiniteNumber(event.price)) throw new TypeError('event.price harus angka');
}

function trackingOf(snapshot) {
  return {
    lastCandleTime: snapshot.lastCandleTime,
    lastEvaluatedAt: snapshot.lastEvaluatedAt ?? null,
    barsInState: Number.isInteger(snapshot.barsInState) ? snapshot.barsInState : 0,
    peakPrice: isFiniteNumber(snapshot.peakPrice) ? snapshot.peakPrice : null,
    peakState: snapshot.peakState ?? snapshot.state,
  };
}

function parseExplanation(json) {
  if (!json) return { factors: [], tracking: null };
  const parsed = JSON.parse(json);
  if (Array.isArray(parsed)) return { factors: parsed, tracking: null };
  return { factors: Array.isArray(parsed.factors) ? parsed.factors : [], tracking: parsed.tracking ?? null };
}

/** Baris signals (+ join) → SignalSnapshot yang dapat langsung dipakai transition(). */
function toSnapshot(row) {
  const { tracking } = parseExplanation(row.explanation_json);
  const fallbackLast = row.updated_at + 1 - TIMEFRAME_MS[row.timeframe];
  return {
    id: row.id,
    state: row.state,
    classification: row.classification,
    patternKey: row.pattern_key,
    patternVersion: row.pattern_version,
    firstDetectedAt: row.first_detected_at,
    firstDetectedPrice: row.first_detected_price,
    invalidationPrice: row.invalidation_price,
    patternScore: row.pattern_score,
    earlyScore: row.early_score,
    alignment: row.alignment,
    riskFlags: JSON.parse(row.risk_flags_json),
    lastCandleTime: tracking?.lastCandleTime ?? fallbackLast,
    lastEvaluatedAt: tracking?.lastEvaluatedAt ?? row.updated_at,
    barsInState: tracking?.barsInState ?? 0,
    peakPrice: tracking?.peakPrice ?? row.first_detected_price,
    peakState: tracking?.peakState ?? row.state,
  };
}

function toView(row) {
  const { factors, tracking } = parseExplanation(row.explanation_json);
  return {
    id: row.id,
    symbol: row.symbol,
    timeframe: row.timeframe,
    classification: row.classification,
    state: row.state,
    patternKey: row.pattern_key,
    patternVersion: row.pattern_version,
    firstDetectedAt: row.first_detected_at,
    firstDetectedPrice: row.first_detected_price,
    invalidationPrice: row.invalidation_price,
    patternScore: row.pattern_score,
    earlyScore: row.early_score,
    alignment: row.alignment,
    riskFlags: JSON.parse(row.risk_flags_json),
    explanation: factors,
    peakPrice: tracking?.peakPrice ?? null,
    peakState: tracking?.peakState ?? row.state,
    barsInState: tracking?.barsInState ?? null,
    finalOutcome: row.final_outcome,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}


/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ clock?: () => number }} [deps] jam untuk created_at definisi pola bila `now` tidak diberikan
 */
export function createSignalRepository(db, { clock = () => Date.now() } = {}) {
  const stmt = {
    symbolId: db.prepare('SELECT id FROM symbols WHERE symbol = ?'),
    definition: db.prepare('SELECT id, definition_json FROM pattern_definitions WHERE pattern_key = ? AND version = ?'),
    insertDefinition: db.prepare(`INSERT INTO pattern_definitions
      (pattern_key, version, name, definition_json, status, created_at, activated_at)
      VALUES (@key, @version, @name, @definitionJson, @status, @now, @activatedAt)`),
    openFor: db.prepare(`SELECT s.*, sym.symbol, pd.pattern_key, pd.version AS pattern_version
      FROM signals s
      JOIN symbols sym ON sym.id = s.symbol_id
      JOIN pattern_definitions pd ON pd.id = s.pattern_definition_id
      WHERE s.symbol_id = ? AND s.timeframe = ? AND s.state IN ('QUIET', 'EARLY_BULLISH', 'MOMENTUM_BUILDING', 'BREAKOUT')
      ORDER BY s.first_detected_at DESC, s.id DESC LIMIT 1`),
    insertSignal: db.prepare(`INSERT INTO signals
      (symbol_id, timeframe, pattern_definition_id, classification, state, first_detected_at, first_detected_price,
       invalidation_price, pattern_score, early_score, alignment, risk_flags_json, explanation_json, final_outcome,
       updated_at, closed_at)
      VALUES (@symbolId, @timeframe, @definitionId, @classification, @state, @firstDetectedAt, @firstDetectedPrice,
       @invalidationPrice, @patternScore, @earlyScore, @alignment, @riskFlagsJson, @explanationJson, @finalOutcome,
       @updatedAt, @closedAt)`),
    updateSignal: db.prepare(`UPDATE signals SET
      classification = @classification, state = @state, invalidation_price = @invalidationPrice,
      pattern_score = @patternScore, early_score = @earlyScore, alignment = @alignment,
      risk_flags_json = @riskFlagsJson, explanation_json = @explanationJson, final_outcome = @finalOutcome,
      updated_at = @updatedAt, closed_at = @closedAt
      WHERE id = @id AND closed_at IS NULL`),
    insertEvent: db.prepare(`INSERT INTO signal_events
      (signal_id, occurred_at, candle_time, from_state, to_state, price, detail_json)
      VALUES (@signalId, @occurredAt, @candleTime, @fromState, @toState, @price, @detailJson)`),
    listActive: db.prepare(`SELECT s.*, sym.symbol, pd.pattern_key, pd.version AS pattern_version
      FROM signals s
      JOIN symbols sym ON sym.id = s.symbol_id
      JOIN pattern_definitions pd ON pd.id = s.pattern_definition_id
      WHERE s.state IN ('QUIET', 'EARLY_BULLISH', 'MOMENTUM_BUILDING', 'BREAKOUT')
        AND (@timeframe IS NULL OR s.timeframe = @timeframe)
        AND (@classification IS NULL OR s.classification = @classification)
        AND (@state IS NULL OR s.state = @state)
        AND (@minScore IS NULL OR s.pattern_score >= @minScore)
      ORDER BY s.pattern_score DESC, s.updated_at DESC, s.id DESC
      LIMIT @limit`),
    history: db.prepare(`SELECT s.*, sym.symbol, pd.pattern_key, pd.version AS pattern_version
      FROM signals s
      JOIN symbols sym ON sym.id = s.symbol_id
      JOIN pattern_definitions pd ON pd.id = s.pattern_definition_id
      WHERE (@symbol IS NULL OR sym.symbol = @symbol)
      ORDER BY s.first_detected_at DESC, s.id DESC
      LIMIT @limit`),
    events: db.prepare(`SELECT id, occurred_at, candle_time, from_state, to_state, price, detail_json
      FROM signal_events WHERE signal_id = ? ORDER BY candle_time, id`),
    openForSymbol: db.prepare(`SELECT s.*, sym.symbol, pd.pattern_key, pd.version AS pattern_version
      FROM signals s
      JOIN symbols sym ON sym.id = s.symbol_id
      JOIN pattern_definitions pd ON pd.id = s.pattern_definition_id
      WHERE s.symbol_id = @symbolId AND s.state IN ('QUIET', 'EARLY_BULLISH', 'MOMENTUM_BUILDING', 'BREAKOUT')
        AND s.timeframe IN (SELECT value FROM json_each(@timeframes))
      ORDER BY s.timeframe, s.id`),
    openSeries: db.prepare(`SELECT DISTINCT sym.symbol, s.timeframe
      FROM signals s JOIN symbols sym ON sym.id = s.symbol_id
      WHERE s.state IN ('QUIET', 'EARLY_BULLISH', 'MOMENTUM_BUILDING', 'BREAKOUT')
      ORDER BY sym.symbol, s.timeframe`),
    lastStoredClose: db.prepare(`SELECT open_time, close FROM candles
      WHERE symbol_id = ? AND timeframe = ? ORDER BY open_time DESC LIMIT 1`),
    expireSignal: db.prepare(`UPDATE signals SET state = 'EXPIRED', final_outcome = @finalOutcome,
      updated_at = @at, closed_at = @at
      WHERE id = @id AND closed_at IS NULL`),
    lastEventCandle: db.prepare(`SELECT MAX(e.candle_time) AS candle_time
      FROM signal_events e JOIN signals s ON s.id = e.signal_id
      WHERE s.symbol_id = ? AND s.timeframe = ?`),
  };

  const ensureDefinitionTx = db.transaction((row, definitionJson) => {
    const existing = stmt.definition.get(row.key, row.version);
    if (existing) {
      if (canonicalJson(JSON.parse(existing.definition_json)) !== definitionJson) {
        throw new SignalRepositoryError(`Definisi ${row.key} v${row.version} berbeda dengan yang tersimpan — naikkan versi`, 'DEFINITION_CONFLICT');
      }
      return existing.id;
    }
    return Number(stmt.insertDefinition.run({ ...row, definitionJson }).lastInsertRowid);
  });

  const saveTx = db.transaction(({ symbol, timeframe, snapshot, event, explanation, updatedAt }) => {
    const sym = stmt.symbolId.get(symbol);
    if (!sym) throw new SignalRepositoryError(`Simbol ${symbol} belum terdaftar`, 'UNKNOWN_SYMBOL');
    const open = stmt.openFor.get(sym.id, timeframe);
    const opening = event !== null && (event.fromState === 'NO_PATTERN' || event.fromState === null);
    const terminal = TERMINAL_STATES.includes(snapshot.state);
    const common = {
      classification: snapshot.classification,
      state: snapshot.state,
      invalidationPrice: snapshot.invalidationPrice,
      patternScore: snapshot.patternScore ?? null,
      earlyScore: snapshot.earlyScore ?? null,
      alignment: snapshot.alignment ?? null,
      riskFlagsJson: JSON.stringify(snapshot.riskFlags),
      finalOutcome: terminal ? `${snapshot.state}:${snapshot.peakState ?? 'UNKNOWN'}` : null,
      updatedAt,
      closedAt: terminal ? (event?.occurredAt ?? updatedAt) : null,
    };

    let id;
    if (opening) {
      if (open) throw new SignalRepositoryError('Masih ada sinyal terbuka untuk simbol & timeframe ini', 'OPEN_SIGNAL_EXISTS');
      if (terminal) throw new SignalRepositoryError('Sinyal baru tidak dapat langsung terminal', 'INVALID_TRANSITION');
      const def = stmt.definition.get(snapshot.patternKey, snapshot.patternVersion);
      if (!def) {
        throw new SignalRepositoryError(`Definisi pola ${snapshot.patternKey} v${snapshot.patternVersion} belum terdaftar`, 'UNKNOWN_PATTERN_DEFINITION');
      }
      id = Number(stmt.insertSignal.run({
        ...common,
        symbolId: sym.id, timeframe, definitionId: def.id,
        firstDetectedAt: snapshot.firstDetectedAt, firstDetectedPrice: snapshot.firstDetectedPrice,
        explanationJson: JSON.stringify({ factors: explanation ?? [], tracking: trackingOf(snapshot) }),
      }).lastInsertRowid);
    } else {
      if (!open) throw new SignalRepositoryError('Tidak ada sinyal terbuka untuk diperbarui', 'NO_OPEN_SIGNAL');
      if (open.first_detected_at !== snapshot.firstDetectedAt || open.pattern_key !== snapshot.patternKey
        || open.pattern_version !== snapshot.patternVersion) {
        throw new SignalRepositoryError('Snapshot tidak cocok dengan sinyal terbuka', 'SNAPSHOT_MISMATCH');
      }
      if (event && event.fromState !== open.state) throw new SignalRepositoryError('event.fromState tidak sama dengan state tersimpan', 'STATE_MISMATCH');
      const stored = parseExplanation(open.explanation_json);
      if (stored.tracking && stored.tracking.lastCandleTime > snapshot.lastCandleTime) {
        throw new SignalRepositoryError('Snapshot lebih lama dari yang tersimpan', 'STALE_SNAPSHOT');
      }
      id = open.id;
      stmt.updateSignal.run({
        ...common, id,
        explanationJson: JSON.stringify({ factors: explanation ?? stored.factors, tracking: trackingOf(snapshot) }),
      });
    }

    if (event) {
      const { reason = null, detail = {} } = event;
      stmt.insertEvent.run({
        signalId: id,
        occurredAt: event.occurredAt ?? updatedAt,
        candleTime: event.candleTime,
        fromState: event.fromState,
        toState: event.toState,
        price: event.price ?? null,
        detailJson: JSON.stringify({ reason, ...detail }),
      });
    }
    return { id, opened: opening, closed: terminal, saved: true };
  });

  const closeForSymbolTx = db.transaction(({ symbol, timeframes, reason, at }) => {
    const sym = stmt.symbolId.get(symbol);
    if (!sym) return [];
    const closed = [];
    for (const row of stmt.openForSymbol.all({ symbolId: sym.id, timeframes: JSON.stringify(timeframes) })) {
      const snapshot = toSnapshot(row);
      const last = stmt.lastStoredClose.get(sym.id, row.timeframe);
      const price = isFiniteNumber(last?.close) ? last.close : null;
      stmt.expireSignal.run({ id: row.id, at, finalOutcome: `EXPIRED:${snapshot.peakState ?? 'UNKNOWN'}` });
      stmt.insertEvent.run({
        signalId: row.id,
        occurredAt: at,
        // candle_time = candle terakhir yang dievaluasi (bukan `at`) agar titik awal replay pipeline
        // (lastEventCandleTime) tidak melompati candle bila simbol dipantau lagi.
        candleTime: snapshot.lastCandleTime,
        fromState: row.state,
        toState: 'EXPIRED',
        price,
        detailJson: JSON.stringify({
          reason, barsInPrevState: snapshot.barsInState, firstDetectedPrice: snapshot.firstDetectedPrice,
          invalidationPrice: snapshot.invalidationPrice, priceCandleTime: price === null ? null : last.open_time,
        }),
      });
      closed.push({ id: row.id, timeframe: row.timeframe, fromState: row.state, price });
    }
    return closed;
  });

  return {
    /**
     * Mendaftarkan definisi pola berversi secara idempoten (unik pattern_key + version).
     * Definisi berbeda untuk versi yang sama ditolak (DEFINITION_CONFLICT) — versi baru wajib dinaikkan.
     * @returns {Promise<number>} id pattern_definitions
     */
    async ensurePatternDefinition({ key, version, name, definition, status = 'active', now } = {}) {
      if (typeof key !== 'string' || !PATTERN_KEY_RE.test(key)) throw new RangeError('Kunci pola tidak valid');
      if (!Number.isInteger(version) || version < 1) throw new RangeError('Versi pola harus bilangan bulat ≥ 1');
      if (typeof name !== 'string' || name.trim() === '' || name.length > 120) throw new RangeError('Nama pola wajib 1..120 karakter');
      if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) throw new TypeError('Definisi pola harus objek');
      if (!DEFINITION_STATUSES.includes(status)) throw new RangeError('Status definisi tidak valid');
      const at = now ?? clock();
      if (!Number.isInteger(at)) throw new TypeError('now harus epoch ms');
      return ensureDefinitionTx(
        { key, version, name, status, now: at, activatedAt: status === 'active' ? at : null },
        canonicalJson(definition),
      );
    },

    /** Sinyal non-terminal terbaru untuk simbol + timeframe sebagai SignalSnapshot (atau null). */
    async getOpen({ symbol, timeframe } = {}) {
      assertSymbol(symbol);
      assertTimeframe(timeframe);
      const sym = stmt.symbolId.get(symbol);
      if (!sym) return null;
      const row = stmt.openFor.get(sym.id, timeframe);
      return row ? toSnapshot(row) : null;
    },

    /**
     * Menyimpan hasil transition() dalam satu transaksi:
     * - event pembuka (fromState NO_PATTERN) → INSERT sinyal baru;
     * - selain itu → UPDATE snapshot sinyal terbuka (closed_at & final_outcome diisi saat terminal);
     * - setiap event → INSERT signal_events.
     * Snapshot NO_PATTERN/NONE, atau snapshot terminal tanpa event, tidak disimpan (no-op).
     * @returns {Promise<{ id: number|null, opened: boolean, closed: boolean, saved: boolean }>}
     */
    async save({ symbol, timeframe, snapshot, event = null, explanation, now } = {}) {
      assertSymbol(symbol);
      assertTimeframe(timeframe);
      if (snapshot === null || typeof snapshot !== 'object') throw new TypeError('snapshot wajib objek');
      if (!SIGNAL_STATES.includes(snapshot.state)) throw new RangeError(`State tidak dikenal: ${snapshot.state}`);
      const noop = { id: null, opened: false, closed: false, saved: false };
      if (snapshot.state === 'NO_PATTERN' || snapshot.classification === 'NONE') {
        if (event) throw new RangeError('Event tidak boleh menyertai snapshot NO_PATTERN');
        return noop;
      }
      if (TERMINAL_STATES.includes(snapshot.state) && !event) return noop;
      if (!PATTERN_STATES.includes(snapshot.state) && !TERMINAL_STATES.includes(snapshot.state)) throw new RangeError('State tidak dapat disimpan');
      assertSnapshot(snapshot);
      if (event) assertEvent(event, snapshot);
      if (explanation !== undefined && !Array.isArray(explanation)) throw new TypeError('explanation harus array');
      const updatedAt = now ?? snapshot.lastEvaluatedAt ?? event?.occurredAt;
      if (!Number.isInteger(updatedAt)) throw new TypeError('Waktu pembaruan (now / snapshot.lastEvaluatedAt) wajib bilangan bulat');
      return saveTx({ symbol, timeframe, snapshot, event, explanation, updatedAt });
    },

    /**
     * Menutup semua sinyal terbuka sebuah simbol (opsional hanya timeframe tertentu) karena simbol berhenti
     * dipantau: state → EXPIRED, closed_at = updated_at = `at`, final_outcome `EXPIRED:<peakState>`, dan satu
     * baris signal_events per sinyal (reason, price = close candle tersimpan terakhir atau null) — semuanya
     * dalam satu transaksi. Tanpa alert. Simbol tak dikenal / tanpa sinyal terbuka → { closed: [] }.
     * @param {{ symbol: string, timeframes?: string[]|null, reason: 'SYMBOL_DELISTED'|'MONITORING_STOPPED', at: number }} input
     * @returns {Promise<{ closed: Array<{ id: number, timeframe: string, fromState: string, price: number|null }> }>}
     */
    async closeOpenForSymbol({ symbol, timeframes = null, reason, at } = {}) {
      assertSymbol(symbol);
      if (!MONITORING_STOP_REASONS.includes(reason)) throw new RangeError(`Reason penutupan tidak valid: ${reason}`);
      if (!Number.isInteger(at) || at < 0) throw new TypeError('at wajib epoch ms bilangan bulat');
      let list = TIMEFRAMES;
      if (timeframes !== null && timeframes !== undefined) {
        if (!Array.isArray(timeframes)) throw new TypeError('timeframes harus array atau null');
        for (const tf of timeframes) assertTimeframe(tf);
        list = [...new Set(timeframes)];
      }
      return { closed: closeForSymbolTx({ symbol, timeframes: list, reason, at }) };
    },

    /**
     * Pasangan simbol × timeframe yang masih punya sinyal terbuka (QUIET/EARLY_BULLISH/MOMENTUM_BUILDING/BREAKOUT),
     * tanpa duplikat, urut simbol lalu timeframe. Dipakai scanner untuk menutup sinyal seri yang tidak lagi
     * dipantau secara level-triggered (lihat createScanner `listOpenSeries`).
     * @returns {Promise<Array<{ symbol: string, timeframe: string }>>}
     */
    async listOpenSeries() {
      return stmt.openSeries.all().map((r) => ({ symbol: r.symbol, timeframe: r.timeframe }));
    },

    /**
     * openTime candle terakhir yang menghasilkan event sinyal untuk simbol + timeframe (atau null).
     * Dipakai pipeline setelah restart agar candle yang sudah menutup sinyal tidak membuka sinyal baru.
     */
    async lastEventCandleTime({ symbol, timeframe } = {}) {
      assertSymbol(symbol);
      assertTimeframe(timeframe);
      const sym = stmt.symbolId.get(symbol);
      if (!sym) return null;
      return stmt.lastEventCandle.get(sym.id, timeframe)?.candle_time ?? null;
    },

    /** Sinyal aktif (non-terminal), urut patternScore tertinggi. */
    async listActive(filters = {}) {
      if (filters === null || typeof filters !== 'object') throw new TypeError('filter harus objek');
      const allowed = ['timeframe', 'classification', 'state', 'minScore', 'limit'];
      for (const key of Object.keys(filters)) if (!allowed.includes(key)) throw new TypeError(`Filter tidak dikenal: ${key}`);
      const { timeframe = null, classification = null, state = null, minScore = null, limit = 200 } = filters;
      if (timeframe !== null) assertTimeframe(timeframe);
      if (classification !== null && !SIGNAL_CLASSIFICATIONS.includes(classification)) throw new RangeError('Filter klasifikasi tidak valid');
      if (state !== null && !PATTERN_STATES.includes(state)) throw new RangeError('Filter state harus state aktif');
      if (minScore !== null && !(isFiniteNumber(minScore) && minScore >= 0 && minScore <= 100)) throw new RangeError('minScore harus 0..100');
      assertLimit(limit, ACTIVE_MAX);
      return stmt.listActive.all({ timeframe, classification, state, minScore, limit }).map(toView);
    },

    /** Riwayat sinyal (terbuka & tertutup) terbaru dulu, lengkap dengan event transisinya. */
    async history({ symbol = null, limit = 50 } = {}) {
      if (symbol !== null) assertSymbol(symbol);
      assertLimit(limit, HISTORY_MAX);
      return stmt.history.all({ symbol, limit }).map((row) => ({
        ...toView(row),
        events: stmt.events.all(row.id).map((e) => ({
          id: e.id,
          occurredAt: e.occurred_at,
          candleTime: e.candle_time,
          fromState: e.from_state,
          toState: e.to_state,
          price: e.price,
          detail: e.detail_json ? JSON.parse(e.detail_json) : null,
        })),
      }));
    },
  };
}
