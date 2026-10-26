// Repositori sinyal: tabel signals, signal_events, pattern_definitions (migrasi 002) dan
// analysis_cursors (migrasi 004: candle terakhir yang dievaluasi pipeline per seri).
// Satu-satunya tempat SQL sinyal ditulis; semua query statis dengan parameter terikat.
//
// Arah (migrasi 005): setiap sinyal punya `direction` 'LONG' | 'SHORT' (baris lama = LONG). Satu sinyal
// terbuka per simbol × timeframe × ARAH (indeks unik parsial idx_signals_one_open), dan kursor analisis
// per simbol × timeframe × arah. Argumen `direction` yang tidak diberikan = 'LONG', sehingga pemanggil
// lama tidak berubah perilakunya (termasuk history(); kedua arah hanya dengan `direction: null` eksplisit).
//
// Catatan skema: migrasi 002 belum memiliki kolom untuk lastCandleTime, lastEvaluatedAt,
// barsInState, peakPrice, dan peakState yang dibutuhkan untuk melanjutkan state machine
// setelah restart. Sampai migrasi baru menambah kolom tersebut, nilainya disimpan di
// explanation_json sebagai { factors: [...penjelasan skor], tracking: {...} }.

import {
  ALIGNMENTS, CONFIDENCE_TIERS, DIRECTIONS, RISK_FLAGS, SIGNAL_STATES, TERMINAL_STATES, TIMEFRAMES, TIMEFRAME_MS, resolveDirection,
  tierRank,
} from '../market/contracts.js';
import { MONITORING_STOP_REASONS, PATTERN_STATES, PATTERN_STATES_BY_DIRECTION } from './params.js';

export class SignalRepositoryError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SignalRepositoryError';
    this.code = code;
  }
}

/** Klasifikasi sinyal tersimpan per arah (NONE tidak pernah disimpan). */
const SIGNAL_CLASSIFICATIONS_BY_DIRECTION = Object.freeze({
  LONG: Object.freeze(['SA', 'PVA', 'BOTH']),
  SHORT: Object.freeze(['SD', 'PVD', 'BOTH']),
});
/** Nilai filter klasifikasi yang diterima listActive (gabungan kedua arah). */
const FILTER_CLASSIFICATIONS = Object.freeze(['SA', 'PVA', 'SD', 'PVD', 'BOTH']);
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

function assertDirection(direction) {
  if (!DIRECTIONS.includes(direction)) throw new RangeError(`Arah tidak valid: ${String(direction)}`);
}

/** Validasi snapshot yang akan disimpan; mengembalikan arahnya (tanpa field `direction` = LONG). */
function assertSnapshot(s) {
  const direction = resolveDirection(s.direction);
  if (!SIGNAL_CLASSIFICATIONS_BY_DIRECTION[direction].includes(s.classification)) {
    throw new RangeError(`Klasifikasi sinyal tidak valid: ${s.classification}`);
  }
  if (PATTERN_STATES.includes(s.state) && !PATTERN_STATES_BY_DIRECTION[direction].includes(s.state)) {
    throw new RangeError(`State ${s.state} tidak berlaku untuk arah ${direction}`);
  }
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
  if (s.confluenceScore !== undefined && s.confluenceScore !== null) assertScore(s.confluenceScore, 'confluenceScore');
  if (s.confidenceTier !== undefined && s.confidenceTier !== null && !CONFIDENCE_TIERS.includes(s.confidenceTier)) {
    throw new RangeError('snapshot.confidenceTier tidak valid');
  }
  if (s.winProbability !== undefined && s.winProbability !== null && !(isFiniteNumber(s.winProbability) && s.winProbability >= 0 && s.winProbability <= 1)) {
    throw new RangeError('snapshot.winProbability harus 0..1 atau null');
  }
  return direction;
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
    direction: row.direction,
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
    ...confluenceOfRow(row),
  };
}

/** Kolom konfluensi v3 (migrasi 006) → field snapshot/view; baris tanpa skor konfluensi tidak menambah field. */
function confluenceOfRow(row) {
  if (row.confluence_score === null || row.confluence_score === undefined) return {};
  return { confluenceScore: row.confluence_score, confidenceTier: row.confidence_tier, winProbability: row.win_probability ?? null };
}

function toView(row) {
  const { factors, tracking } = parseExplanation(row.explanation_json);
  return {
    id: row.id,
    symbol: row.symbol,
    timeframe: row.timeframe,
    direction: row.direction,
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
    confluenceScore: row.confluence_score ?? null,
    confidenceTier: row.confidence_tier ?? null,
    winProbability: row.win_probability ?? null,
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
      WHERE s.symbol_id = ? AND s.timeframe = ? AND s.direction = ?
        AND s.state IN ('QUIET', 'EARLY_BULLISH', 'MOMENTUM_BUILDING', 'BREAKOUT', 'EARLY_BEARISH', 'BREAKDOWN')
      ORDER BY s.first_detected_at DESC, s.id DESC LIMIT 1`),
    insertSignal: db.prepare(`INSERT INTO signals
      (symbol_id, timeframe, direction, pattern_definition_id, classification, state, first_detected_at, first_detected_price,
       invalidation_price, pattern_score, early_score, alignment, risk_flags_json, explanation_json, final_outcome,
       updated_at, closed_at, confluence_score, confidence_tier, win_probability)
      VALUES (@symbolId, @timeframe, @direction, @definitionId, @classification, @state, @firstDetectedAt, @firstDetectedPrice,
       @invalidationPrice, @patternScore, @earlyScore, @alignment, @riskFlagsJson, @explanationJson, @finalOutcome,
       @updatedAt, @closedAt, @confluenceScore, @confidenceTier, @winProbability)`),
    updateSignal: db.prepare(`UPDATE signals SET
      classification = @classification, state = @state, invalidation_price = @invalidationPrice,
      pattern_score = @patternScore, early_score = @earlyScore, alignment = @alignment,
      risk_flags_json = @riskFlagsJson, explanation_json = @explanationJson, final_outcome = @finalOutcome,
      updated_at = @updatedAt, closed_at = @closedAt,
      confluence_score = @confluenceScore, confidence_tier = @confidenceTier, win_probability = @winProbability
      WHERE id = @id AND closed_at IS NULL`),
    insertEvent: db.prepare(`INSERT INTO signal_events
      (signal_id, occurred_at, candle_time, from_state, to_state, price, detail_json)
      VALUES (@signalId, @occurredAt, @candleTime, @fromState, @toState, @price, @detailJson)`),
    listActive: db.prepare(`SELECT s.*, sym.symbol, pd.pattern_key, pd.version AS pattern_version
      FROM signals s
      JOIN symbols sym ON sym.id = s.symbol_id
      JOIN pattern_definitions pd ON pd.id = s.pattern_definition_id
      WHERE s.state IN ('QUIET', 'EARLY_BULLISH', 'MOMENTUM_BUILDING', 'BREAKOUT', 'EARLY_BEARISH', 'BREAKDOWN')
        AND s.direction = @direction
        AND (@timeframe IS NULL OR s.timeframe = @timeframe)
        AND (@classification IS NULL OR s.classification = @classification)
        AND (@state IS NULL OR s.state = @state)
        AND (@alignment IS NULL OR s.alignment = @alignment)
        AND (@minScore IS NULL OR s.pattern_score >= @minScore)
        AND (@minTierRank IS NULL OR (CASE s.confidence_tier WHEN 'A' THEN 4 WHEN 'B' THEN 3 WHEN 'C' THEN 2 WHEN 'D' THEN 1 ELSE 0 END) >= @minTierRank)
      ORDER BY (CASE s.confidence_tier WHEN 'A' THEN 4 WHEN 'B' THEN 3 WHEN 'C' THEN 2 WHEN 'D' THEN 1 ELSE 0 END) DESC,
        COALESCE(s.confluence_score, -1) DESC, s.pattern_score DESC, s.updated_at DESC, s.id DESC
      LIMIT @limit`),
    // Dua statement (tanpa / dengan simbol) agar masing-masing memakai indeks migrasi 004:
    // bentuk `(@symbol IS NULL OR …)` memaksa SCAN seluruh tabel (+ sort sementara) pada setiap request.
    historyAll: db.prepare(`SELECT s.*, sym.symbol, pd.pattern_key, pd.version AS pattern_version
      FROM signals s
      JOIN symbols sym ON sym.id = s.symbol_id
      JOIN pattern_definitions pd ON pd.id = s.pattern_definition_id
      ORDER BY s.first_detected_at DESC, s.id DESC
      LIMIT @limit`),
    historyBySymbol: db.prepare(`SELECT s.*, sym.symbol, pd.pattern_key, pd.version AS pattern_version
      FROM signals s
      JOIN symbols sym ON sym.id = s.symbol_id
      JOIN pattern_definitions pd ON pd.id = s.pattern_definition_id
      WHERE s.symbol_id = (SELECT id FROM symbols WHERE symbol = @symbol)
      ORDER BY s.first_detected_at DESC, s.id DESC
      LIMIT @limit`),
    // Riwayat satu arah (migrasi 005). Arah ditulis sebagai literal di SQL statis (bukan interpolasi, bukan
    // parameter) agar bentuk parameter tetap { limit } / { symbol, limit }. INDEXED BY + CROSS JOIN mengunci
    // rencana yang sama dengan statement tanpa arah: indeks urut first_detected_at dipindai (tanpa sort
    // sementara) dan arah hanya disaring per baris — tanpa indeks arah yang dapat menggeser pilihan planner.
    historyAllLong: db.prepare(`SELECT s.*, sym.symbol, pd.pattern_key, pd.version AS pattern_version
      FROM signals s INDEXED BY idx_signals_first_detected
      CROSS JOIN symbols sym ON sym.id = s.symbol_id
      CROSS JOIN pattern_definitions pd ON pd.id = s.pattern_definition_id
      WHERE s.direction = 'LONG'
      ORDER BY s.first_detected_at DESC, s.id DESC
      LIMIT @limit`),
    historyAllShort: db.prepare(`SELECT s.*, sym.symbol, pd.pattern_key, pd.version AS pattern_version
      FROM signals s INDEXED BY idx_signals_first_detected
      CROSS JOIN symbols sym ON sym.id = s.symbol_id
      CROSS JOIN pattern_definitions pd ON pd.id = s.pattern_definition_id
      WHERE s.direction = 'SHORT'
      ORDER BY s.first_detected_at DESC, s.id DESC
      LIMIT @limit`),
    historyBySymbolLong: db.prepare(`SELECT s.*, sym.symbol, pd.pattern_key, pd.version AS pattern_version
      FROM signals s INDEXED BY idx_signals_symbol_first_detected
      CROSS JOIN symbols sym ON sym.id = s.symbol_id
      CROSS JOIN pattern_definitions pd ON pd.id = s.pattern_definition_id
      WHERE s.symbol_id = (SELECT id FROM symbols WHERE symbol = @symbol) AND s.direction = 'LONG'
      ORDER BY s.first_detected_at DESC, s.id DESC
      LIMIT @limit`),
    historyBySymbolShort: db.prepare(`SELECT s.*, sym.symbol, pd.pattern_key, pd.version AS pattern_version
      FROM signals s INDEXED BY idx_signals_symbol_first_detected
      CROSS JOIN symbols sym ON sym.id = s.symbol_id
      CROSS JOIN pattern_definitions pd ON pd.id = s.pattern_definition_id
      WHERE s.symbol_id = (SELECT id FROM symbols WHERE symbol = @symbol) AND s.direction = 'SHORT'
      ORDER BY s.first_detected_at DESC, s.id DESC
      LIMIT @limit`),
    events: db.prepare(`SELECT id, occurred_at, candle_time, from_state, to_state, price, detail_json
      FROM signal_events WHERE signal_id = ? ORDER BY candle_time, id`),
    openForSymbol: db.prepare(`SELECT s.*, sym.symbol, pd.pattern_key, pd.version AS pattern_version
      FROM signals s
      JOIN symbols sym ON sym.id = s.symbol_id
      JOIN pattern_definitions pd ON pd.id = s.pattern_definition_id
      WHERE s.symbol_id = @symbolId AND s.state IN ('QUIET', 'EARLY_BULLISH', 'MOMENTUM_BUILDING', 'BREAKOUT', 'EARLY_BEARISH', 'BREAKDOWN')
        AND s.timeframe IN (SELECT value FROM json_each(@timeframes))
      ORDER BY s.timeframe, s.id`),
    openSeries: db.prepare(`SELECT DISTINCT sym.symbol, s.timeframe
      FROM signals s JOIN symbols sym ON sym.id = s.symbol_id
      WHERE s.state IN ('QUIET', 'EARLY_BULLISH', 'MOMENTUM_BUILDING', 'BREAKOUT', 'EARLY_BEARISH', 'BREAKDOWN')
      ORDER BY sym.symbol, s.timeframe`),
    lastStoredClose: db.prepare(`SELECT open_time, close FROM candles
      WHERE symbol_id = ? AND timeframe = ? ORDER BY open_time DESC LIMIT 1`),
    expireSignal: db.prepare(`UPDATE signals SET state = 'EXPIRED', final_outcome = @finalOutcome,
      updated_at = @at, closed_at = @at
      WHERE id = @id AND closed_at IS NULL`),
    lastEventCandle: db.prepare(`SELECT MAX(e.candle_time) AS candle_time
      FROM signal_events e JOIN signals s ON s.id = e.signal_id
      WHERE s.symbol_id = ? AND s.timeframe = ? AND s.direction = ?`),
    // Kursor analisis (per arah, migrasi 005) lebih diutamakan; event arah yang sama tetap ikut (DB sebelum
    // migrasi 004 belum punya kursor).
    lastEvaluated: db.prepare(`SELECT MAX(t) AS t FROM (
        SELECT last_open_time AS t FROM analysis_cursors
        WHERE symbol_id = @symbolId AND timeframe = @timeframe AND direction = @direction
        UNION ALL
        SELECT MAX(e.candle_time) FROM signal_events e JOIN signals s ON s.id = e.signal_id
        WHERE s.symbol_id = @symbolId AND s.timeframe = @timeframe AND s.direction = @direction)`),
    advanceCursor: db.prepare(`INSERT INTO analysis_cursors (symbol_id, timeframe, direction, last_open_time, updated_at)
      VALUES (@symbolId, @timeframe, @direction, @openTime, @at)
      ON CONFLICT (symbol_id, timeframe, direction) DO UPDATE SET last_open_time = excluded.last_open_time, updated_at = excluded.updated_at
      WHERE excluded.last_open_time > analysis_cursors.last_open_time`),
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

  const historyByDirection = {
    LONG: { all: stmt.historyAllLong, bySymbol: stmt.historyBySymbolLong },
    SHORT: { all: stmt.historyAllShort, bySymbol: stmt.historyBySymbolShort },
  };

  const saveTx = db.transaction(({ symbol, timeframe, direction, snapshot, event, explanation, updatedAt }) => {
    const sym = stmt.symbolId.get(symbol);
    if (!sym) throw new SignalRepositoryError(`Simbol ${symbol} belum terdaftar`, 'UNKNOWN_SYMBOL');
    const open = stmt.openFor.get(sym.id, timeframe, direction);
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
      // Konfluensi v3 (migrasi 006); snapshot lama/v2 tanpa field ini → NULL.
      confluenceScore: isFiniteNumber(snapshot.confluenceScore) ? snapshot.confluenceScore : null,
      confidenceTier: snapshot.confidenceTier ?? null,
      winProbability: isFiniteNumber(snapshot.winProbability) ? snapshot.winProbability : null,
      finalOutcome: terminal ? `${snapshot.state}:${snapshot.peakState ?? 'UNKNOWN'}` : null,
      updatedAt,
      closedAt: terminal ? (event?.occurredAt ?? updatedAt) : null,
    };

    let id;
    if (opening) {
      if (open) throw new SignalRepositoryError('Masih ada sinyal terbuka untuk simbol & timeframe ini (arah yang sama)', 'OPEN_SIGNAL_EXISTS');
      if (terminal) throw new SignalRepositoryError('Sinyal baru tidak dapat langsung terminal', 'INVALID_TRANSITION');
      const def = stmt.definition.get(snapshot.patternKey, snapshot.patternVersion);
      if (!def) {
        throw new SignalRepositoryError(`Definisi pola ${snapshot.patternKey} v${snapshot.patternVersion} belum terdaftar`, 'UNKNOWN_PATTERN_DEFINITION');
      }
      id = Number(stmt.insertSignal.run({
        ...common,
        symbolId: sym.id, timeframe, direction, definitionId: def.id,
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
      // Setiap perubahan state wajib tercatat di signal_events (transaksi yang sama), agar riwayat tidak
      // pernah tertinggal dari state tersimpan.
      if (!event && snapshot.state !== open.state) {
        throw new SignalRepositoryError(`Perubahan state ${open.state} → ${snapshot.state} tanpa event`, 'STATE_CHANGE_WITHOUT_EVENT');
      }
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

    // Candle snapshot ini sudah dievaluasi: kursor analisis maju dalam transaksi yang sama dengan
    // sinyal + event, sehingga restart tidak pernah mengevaluasi ulang candle yang menutup sinyal.
    stmt.advanceCursor.run({ symbolId: sym.id, timeframe, direction, openTime: snapshot.lastCandleTime, at: updatedAt });

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
        // (lastEvaluatedCandleTime) tidak melompati candle bila simbol dipantau lagi.
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

    /**
     * Sinyal non-terminal terbaru untuk simbol + timeframe + arah sebagai SignalSnapshot (atau null).
     * `direction` default 'LONG' (pemanggil lama).
     */
    async getOpen({ symbol, timeframe, direction = 'LONG' } = {}) {
      assertSymbol(symbol);
      assertTimeframe(timeframe);
      assertDirection(direction);
      const sym = stmt.symbolId.get(symbol);
      if (!sym) return null;
      const row = stmt.openFor.get(sym.id, timeframe, direction);
      return row ? toSnapshot(row) : null;
    },

    /**
     * Menyimpan hasil transition() dalam satu transaksi:
     * - event pembuka (fromState NO_PATTERN) → INSERT sinyal baru;
     * - selain itu → UPDATE snapshot sinyal terbuka (closed_at & final_outcome diisi saat terminal);
     *   snapshot dengan state berbeda dari yang tersimpan wajib disertai event (STATE_CHANGE_WITHOUT_EVENT);
     * - setiap event → INSERT signal_events.
     * Arah diambil dari snapshot.direction (tidak ada = LONG); sinyal terbuka dicari per arah, sehingga sinyal
     * LONG dan SHORT pada seri yang sama tidak saling mengganggu.
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
      const direction = assertSnapshot(snapshot);
      if (event) assertEvent(event, snapshot);
      if (explanation !== undefined && !Array.isArray(explanation)) throw new TypeError('explanation harus array');
      const updatedAt = now ?? snapshot.lastEvaluatedAt ?? event?.occurredAt;
      if (!Number.isInteger(updatedAt)) throw new TypeError('Waktu pembaruan (now / snapshot.lastEvaluatedAt) wajib bilangan bulat');
      return saveTx({ symbol, timeframe, direction, snapshot, event, explanation, updatedAt });
    },

    /**
     * Menutup semua sinyal terbuka sebuah simbol — LONG dan SHORT (opsional hanya timeframe tertentu) karena simbol
     * berhenti dipantau: state → EXPIRED, closed_at = updated_at = `at`, final_outcome `EXPIRED:<peakState>`, dan satu
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
     * Pasangan simbol × timeframe yang masih punya sinyal terbuka (state pola mana pun: QUIET/EARLY_BULLISH/
     * MOMENTUM_BUILDING/BREAKOUT untuk LONG, QUIET/EARLY_BEARISH/MOMENTUM_BUILDING/BREAKDOWN untuk SHORT),
     * tanpa duplikat (kedua arah digabung), urut simbol lalu timeframe. Dipakai scanner untuk menutup sinyal
     * seri yang tidak lagi dipantau secara level-triggered (lihat createScanner `listOpenSeries`).
     * @returns {Promise<Array<{ symbol: string, timeframe: string }>>}
     */
    async listOpenSeries() {
      return stmt.openSeries.all().map((r) => ({ symbol: r.symbol, timeframe: r.timeframe }));
    },

    /**
     * openTime candle terakhir yang menghasilkan event sinyal untuk simbol + timeframe + arah (atau null;
     * `direction` default 'LONG'). Pipeline memakai lastEvaluatedCandleTime (kursor analisis, mencakup nilai
     * ini) sebagai titik awal replay.
     */
    async lastEventCandleTime({ symbol, timeframe, direction = 'LONG' } = {}) {
      assertSymbol(symbol);
      assertTimeframe(timeframe);
      assertDirection(direction);
      const sym = stmt.symbolId.get(symbol);
      if (!sym) return null;
      return stmt.lastEventCandle.get(sym.id, timeframe, direction)?.candle_time ?? null;
    },

    /**
     * openTime candle dasar terakhir yang sudah dievaluasi pipeline untuk simbol + timeframe + arah (atau null;
     * `direction` default 'LONG'): maksimum dari kursor analisis arah itu (markEvaluated / save) dan candle
     * event terakhir arah itu. Titik awal replay pipeline setelah restart — candle dengan openTime ≤ nilai ini
     * tidak dievaluasi ulang untuk arah tersebut.
     */
    async lastEvaluatedCandleTime({ symbol, timeframe, direction = 'LONG' } = {}) {
      assertSymbol(symbol);
      assertTimeframe(timeframe);
      assertDirection(direction);
      const sym = stmt.symbolId.get(symbol);
      if (!sym) return null;
      return stmt.lastEvaluated.get({ symbolId: sym.id, timeframe, direction })?.t ?? null;
    },

    /**
     * Mencatat bahwa candle `openTime` sudah dievaluasi untuk satu arah (`direction` default 'LONG'; candle
     * tanpa sinyal tersimpan, mis. NO_PATTERN). Kursor hanya maju; nilai yang lebih lama/sama diabaikan
     * (idempoten). save() memajukan kursor arah snapshot sendiri.
     * @returns {Promise<{ advanced: boolean }>}
     */
    async markEvaluated({ symbol, timeframe, openTime, now, direction = 'LONG' } = {}) {
      assertSymbol(symbol);
      assertTimeframe(timeframe);
      assertDirection(direction);
      if (!Number.isSafeInteger(openTime) || openTime < 0) throw new TypeError('openTime wajib epoch ms bilangan bulat');
      const at = now ?? clock();
      if (!Number.isInteger(at)) throw new TypeError('now harus epoch ms');
      const sym = stmt.symbolId.get(symbol);
      if (!sym) throw new SignalRepositoryError(`Simbol ${symbol} belum terdaftar`, 'UNKNOWN_SYMBOL');
      return { advanced: stmt.advanceCursor.run({ symbolId: sym.id, timeframe, direction, openTime, at }).changes > 0 };
    },

    /**
     * Sinyal aktif (non-terminal) SATU arah (`direction` default 'LONG'), urut patternScore tertinggi; semua
     * filter diterapkan sebelum limit. Filter klasifikasi/state yang hanya berlaku untuk arah lain menghasilkan
     * daftar kosong (bukan error), agar filter UI dapat dipakai lintas arah.
     */
    async listActive(filters = {}) {
      if (filters === null || typeof filters !== 'object') throw new TypeError('filter harus objek');
      const allowed = ['direction', 'timeframe', 'classification', 'state', 'alignment', 'minScore', 'minTier', 'limit'];
      for (const key of Object.keys(filters)) if (!allowed.includes(key)) throw new TypeError(`Filter tidak dikenal: ${key}`);
      const {
        direction = 'LONG', timeframe = null, classification = null, state = null, alignment = null, minScore = null, minTier = null,
        limit = 200,
      } = filters;
      assertDirection(direction);
      if (timeframe !== null) assertTimeframe(timeframe);
      if (classification !== null && !FILTER_CLASSIFICATIONS.includes(classification)) throw new RangeError('Filter klasifikasi tidak valid');
      if (state !== null && !PATTERN_STATES.includes(state)) throw new RangeError('Filter state harus state aktif');
      // Alignment null (konteks HTF tidak diketahui) tidak dapat dipilih sebagai filter; tanpa filter tetap tampil.
      if (alignment !== null && !ALIGNMENTS.includes(alignment)) throw new RangeError('Filter alignment tidak valid');
      if (minScore !== null && !(isFiniteNumber(minScore) && minScore >= 0 && minScore <= 100)) throw new RangeError('minScore harus 0..100');
      // minTier (v3): hanya sinyal dengan tier konfluensi ≥ minTier; sinyal lama tanpa tier tersaring keluar.
      if (minTier !== null && !CONFIDENCE_TIERS.includes(minTier)) throw new RangeError('minTier harus A/B/C/D');
      assertLimit(limit, ACTIVE_MAX);
      const minTierRank = minTier === null ? null : tierRank(minTier);
      return stmt.listActive.all({ direction, timeframe, classification, state, alignment, minScore, minTierRank, limit }).map(toView);
    },

    /**
     * Riwayat sinyal (terbuka & tertutup) terbaru dulu, lengkap dengan event transisinya.
     * `direction` tidak diberikan = 'LONG' (pemanggil lama); 'LONG' / 'SHORT' = satu arah saja; null eksplisit =
     * kedua arah (dipakai GET /api/signals/history tanpa direction).
     */
    async history({ symbol = null, limit = 50, direction = 'LONG' } = {}) {
      if (symbol !== null) assertSymbol(symbol);
      assertLimit(limit, HISTORY_MAX);
      if (direction !== null) assertDirection(direction);
      const statements = direction === null
        ? { all: stmt.historyAll, bySymbol: stmt.historyBySymbol }
        : historyByDirection[direction];
      const rows = symbol === null ? statements.all.all({ limit }) : statements.bySymbol.all({ symbol, limit });
      return rows.map((row) => ({
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
