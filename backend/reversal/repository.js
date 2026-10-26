// Repositori Reversal Radar (docs/19-kontrak-reversal-radar.md §5): tabel reversal_candidates, reversal_events,
// reversal_cursors, dan reversal_provisional (migrasi 008). Satu-satunya tempat SQL reversal ditulis; semua query
// statis dengan parameter terikat (tidak ada interpolasi string).
//
// Prinsip:
// - satu kandidat TERBUKA per simbol × timeframe (indeks unik parsial idx_reversal_one_open; repositori menolak lebih
//   dulu dengan OPEN_CANDIDATE_EXISTS);
// - setiap perubahan tahap/status wajib tercatat sebagai event dalam transaksi yang sama (STATE_CHANGE_WITHOUT_EVENT),
//   sehingga riwayat tidak pernah tertinggal dari snapshot tersimpan;
// - kursor (reversal_cursors) maju dalam transaksi yang sama dengan kandidat + event (restart tidak mengevaluasi ulang
//   candle yang menutup kandidat);
// - evaluasi provisional (candle berjalan) disimpan TERPISAH (reversal_provisional): tidak pernah membuka/menutup
//   kandidat, tidak pernah memajukan kursor; event PROVISIONAL_STAGE hanya saat tahap provisional berubah.
//
// Snapshot tersimpan (snapshot_json) = ReversalSnapshot §4 apa adanya, ditambah kunci `evidenceDetails` (bukti lengkap
// { id, group, label, detail, time, price } dari evaluasi saat disimpan) untuk tampilan; getOpen() mengembalikan snapshot
// TANPA kunci itu agar `prev` yang diberikan ke transitionReversal persis bentuk §4.

import { TIMEFRAMES } from '../market/contracts.js';
import {
  CANCEL_REASONS, CLASSIFICATIONS, EVENT_TYPES, EVIDENCE_GROUP_OF, LIQUIDITY_CLASSES, OPEN_STATUSES, REVERSAL_TIMEFRAMES, RISKS,
  SETUP_TYPES, STAGES, STAGE_RANK, STATUSES, STATUS_OF_STAGE, TERMINAL_STATUSES,
} from './constants.js';

export class ReversalRepositoryError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ReversalRepositoryError';
    this.code = code;
  }
}

/** Reason penutupan di luar candle (simbol/seri berhenti dipantau) — sama dengan signals/params MONITORING_STOP_REASONS. */
export const REVERSAL_MONITORING_STOP_REASONS = Object.freeze(['SYMBOL_DELISTED', 'MONITORING_STOPPED']);
/** Event dari candle tertutup (bukan provisional). */
const CLOSED_EVENT_TYPES = Object.freeze(EVENT_TYPES.filter((t) => t !== 'PROVISIONAL_STAGE'));
/** Peringkat kelas likuiditas untuk filter "minimum kelas" (UNKNOWN/ILLIQUID = 0 → tersaring bila filter dipakai). */
const LIQUIDITY_RANK = Object.freeze({ LIQUID: 2, THIN: 1 });
const SYMBOL_RE = /^[A-Z0-9]{2,30}$/;
const HISTORY_MAX = 500;
const ACTIVE_MAX = 500;

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function assertSymbol(symbol) {
  if (typeof symbol !== 'string' || !SYMBOL_RE.test(symbol)) throw new RangeError('Simbol tidak valid');
}
function assertTimeframe(timeframe) {
  if (!REVERSAL_TIMEFRAMES.includes(timeframe)) throw new RangeError(`Timeframe tidak didukung Reversal Radar: ${String(timeframe)}`);
}
function assertLimit(limit, max) {
  if (!Number.isInteger(limit) || limit < 1 || limit > max) throw new RangeError(`limit harus bilangan bulat 1..${max}`);
}
function assertEpoch(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} wajib epoch ms bilangan bulat`);
}
function assertNullableNumber(value, name) {
  if (value !== null && value !== undefined && !isFiniteNumber(value)) throw new TypeError(`${name} harus angka atau null`);
}
function assertScore(value, name) {
  if (!(isFiniteNumber(value) && value >= 0 && value <= 100)) throw new RangeError(`${name} harus 0..100`);
}
function assertStageOrNull(value, name) {
  if (value !== null && !STAGES.includes(value)) throw new RangeError(`${name} tidak valid: ${String(value)}`);
}

/** Validasi snapshot §4 yang akan DISIMPAN (status bukan NONE). */
function assertSnapshot(s, timeframe) {
  if (!Number.isInteger(s.version) || s.version < 1) throw new RangeError('snapshot.version harus bilangan bulat ≥ 1');
  if (s.timeframe !== undefined && s.timeframe !== timeframe) throw new RangeError('snapshot.timeframe tidak sama dengan argumen timeframe');
  if (!STATUSES.includes(s.status)) throw new RangeError(`snapshot.status tidak valid: ${String(s.status)}`);
  if (!STAGES.includes(s.stage)) throw new RangeError(`snapshot.stage tidak valid: ${String(s.stage)}`);
  if (OPEN_STATUSES.includes(s.status) && STATUS_OF_STAGE[s.stage] !== s.status) {
    throw new RangeError(`snapshot.status ${s.status} tidak sesuai tahap ${s.stage}`);
  }
  if (s.setupType !== null && s.setupType !== undefined && !SETUP_TYPES.includes(s.setupType)) throw new RangeError('snapshot.setupType tidak valid');
  if (s.setupTypes !== undefined && (!Array.isArray(s.setupTypes) || s.setupTypes.some((t) => !SETUP_TYPES.includes(t)))) {
    throw new RangeError('snapshot.setupTypes harus subset SETUP_TYPES');
  }
  if (s.classification !== null && s.classification !== undefined && !CLASSIFICATIONS.includes(s.classification)) {
    throw new RangeError('snapshot.classification tidak valid');
  }
  assertScore(s.score, 'snapshot.score');
  assertEpoch(s.firstDetectedAt, 'snapshot.firstDetectedAt');
  if (!(isFiniteNumber(s.firstDetectedPrice) && s.firstDetectedPrice > 0)) throw new RangeError('snapshot.firstDetectedPrice harus > 0');
  assertNullableNumber(s.firstDetectedAtr, 'snapshot.firstDetectedAtr');
  assertEpoch(s.stageEnteredAt, 'snapshot.stageEnteredAt');
  assertEpoch(s.lastCandleTime, 'snapshot.lastCandleTime');
  assertEpoch(s.lastEvaluatedAt, 'snapshot.lastEvaluatedAt');
  if (s.levels !== undefined && !isPlainObject(s.levels)) throw new TypeError('snapshot.levels harus objek');
  assertNullableNumber(s.levels?.invalidation, 'snapshot.levels.invalidation');
  assertNullableNumber(s.levels?.trigger, 'snapshot.levels.trigger');
  if (!Array.isArray(s.risks) || s.risks.some((r) => !RISKS.includes(r))) throw new RangeError('snapshot.risks harus subset RISKS');
  if (s.liquidityClass !== null && s.liquidityClass !== undefined && !LIQUIDITY_CLASSES.includes(s.liquidityClass)) {
    throw new RangeError('snapshot.liquidityClass tidak valid');
  }
  if (s.extended !== undefined && typeof s.extended !== 'boolean') throw new TypeError('snapshot.extended harus boolean');
  if (s.evidence !== undefined && !Array.isArray(s.evidence)) throw new TypeError('snapshot.evidence harus array');
  if (s.markers !== undefined && !Array.isArray(s.markers)) throw new TypeError('snapshot.markers harus array');
  if (s.closeReason !== null && s.closeReason !== undefined && !CANCEL_REASONS.includes(s.closeReason)) {
    throw new RangeError('snapshot.closeReason tidak valid');
  }
  if (TERMINAL_STATUSES.includes(s.status) && (s.closeReason === null || s.closeReason === undefined)) {
    throw new RangeError('snapshot terminal wajib memiliki closeReason');
  }
}

/** Validasi satu event candle tertutup (§4 ReversalEvent) terhadap event sebelumnya & snapshot akhir. */
function assertEvent(event, index, events, snapshot) {
  if (!isPlainObject(event)) throw new TypeError('event harus objek');
  if (!CLOSED_EVENT_TYPES.includes(event.type)) throw new RangeError(`event.type tidak valid untuk candle tertutup: ${String(event.type)}`);
  if (event.provisional === true) throw new RangeError('event provisional tidak boleh disimpan lewat save()');
  assertStageOrNull(event.fromStage ?? null, 'event.fromStage');
  assertStageOrNull(event.toStage ?? null, 'event.toStage');
  const fromStatus = event.fromStatus ?? null;
  if (fromStatus !== null && fromStatus !== 'NONE' && !STATUSES.includes(fromStatus)) throw new RangeError('event.fromStatus tidak valid');
  if (!STATUSES.includes(event.toStatus)) throw new RangeError('event.toStatus tidak valid');
  assertEpoch(event.candleTime, 'event.candleTime');
  if (event.occurredAt !== undefined && event.occurredAt !== null) assertEpoch(event.occurredAt, 'event.occurredAt');
  assertNullableNumber(event.price, 'event.price');
  if (event.type === 'OPENED') {
    if (index !== 0) throw new RangeError('event OPENED hanya boleh menjadi event pertama');
    if ((event.fromStage ?? null) !== null) throw new RangeError('event OPENED harus berawal tanpa tahap (fromStage null)');
    if (!OPEN_STATUSES.includes(event.toStatus)) throw new RangeError('event OPENED harus menuju status terbuka');
  }
  if (event.type === 'STAGE_UP' && !(STAGE_RANK[event.toStage] > STAGE_RANK[event.fromStage])) {
    throw new RangeError('event STAGE_UP harus naik tahap');
  }
  if (event.type === 'CANCELLED' && event.toStatus !== 'CANCELLED') throw new RangeError('event CANCELLED harus menuju status CANCELLED');
  if (event.type === 'EXPIRED' && event.toStatus !== 'EXPIRED') throw new RangeError('event EXPIRED harus menuju status EXPIRED');
  if (index > 0) {
    const prev = events[index - 1];
    if ((event.fromStage ?? null) !== (prev.toStage ?? null) || fromStatus !== prev.toStatus) {
      throw new RangeError('rantai event tidak bersambung (fromStage/fromStatus ≠ event sebelumnya)');
    }
  }
  if (index === events.length - 1 && ((event.toStage ?? null) !== snapshot.stage || event.toStatus !== snapshot.status)) {
    throw new RangeError('event terakhir harus berakhir pada tahap & status snapshot');
  }
}

/** Satu entri bukti untuk tampilan: id (string) → objek minimal; objek check evaluasi → bentuk ringkas. */
function normalizeEvidence(entry) {
  if (typeof entry === 'string') {
    return { id: entry, group: EVIDENCE_GROUP_OF[entry] ?? null, label: entry, detail: null, time: null, price: null };
  }
  if (!isPlainObject(entry) || typeof entry.id !== 'string') return null;
  return {
    id: entry.id,
    group: entry.group ?? EVIDENCE_GROUP_OF[entry.id] ?? null,
    label: typeof entry.label === 'string' ? entry.label : entry.id,
    detail: typeof entry.detail === 'string' ? entry.detail : null,
    time: isFiniteNumber(entry.time) ? entry.time : null,
    price: isFiniteNumber(entry.price) ? entry.price : null,
  };
}
const normalizeEvidenceList = (list) => (Array.isArray(list) ? list.map(normalizeEvidence).filter((e) => e !== null) : []);
const evidenceIds = (list) => (Array.isArray(list) ? list.map((e) => (typeof e === 'string' ? e : e?.id)).filter((id) => typeof id === 'string') : []);

/** Snapshot yang disimpan: snapshot §4 (tanpa `id`) + evidenceDetails untuk tampilan. */
function storedSnapshot(snapshot, evidence, previous) {
  const rest = { ...snapshot };
  delete rest.id;
  delete rest.evidenceDetails;
  // evidenceDetails selalu mengikuti id di snapshot.evidence: detail dari evaluasi terbaru (`evidence`) bila memuat id
  // itu, lalu dari detail tersimpan sebelumnya (bukti lama yang tidak muncul di evaluasi berikutnya tetap berlabel),
  // terakhir minimal dari id.
  const fresh = new Map(normalizeEvidenceList(evidence).map((e) => [e.id, e]));
  const old = new Map(normalizeEvidenceList(previous?.evidenceDetails).map((e) => [e.id, e]));
  const ids = Array.isArray(snapshot.evidence)
    ? snapshot.evidence.map((e) => (typeof e === 'string' ? e : e?.id)).filter((id) => typeof id === 'string') : [];
  return { ...rest, evidenceDetails: ids.map((id) => fresh.get(id) ?? old.get(id) ?? normalizeEvidence(id)) };
}

function parseSnapshot(json) {
  return JSON.parse(json);
}

/** Baris reversal_candidates → ReversalSnapshot (+ id) persis bentuk §4 (tanpa evidenceDetails). */
function toSnapshot(row) {
  const snapshot = parseSnapshot(row.snapshot_json);
  delete snapshot.evidenceDetails;
  return { id: row.id, ...snapshot };
}

/** Bentuk `provisional` pada baris API dari baris reversal_provisional (null bila tidak ada). */
function provisionalView(p) {
  if (!p) return null;
  const ev = parseSnapshot(p.snapshot_json);
  return {
    stage: p.stage,
    score: p.score,
    evaluatedAt: p.evaluated_at,
    candleOpenTime: p.candle_open_time,
    evidenceCount: Number.isInteger(ev.evidenceCount) ? ev.evidenceCount : evidenceIds(ev.evidence).length,
    evidence: normalizeEvidenceList(ev.evidence),
    risks: Array.isArray(ev.risks) ? ev.risks : [],
  };
}

function eventView(e) {
  return {
    id: e.id,
    type: e.type,
    occurredAt: e.occurred_at,
    candleTime: e.candle_time,
    fromStage: e.from_stage,
    toStage: e.to_stage,
    fromStatus: e.from_status,
    toStatus: e.to_status,
    price: e.price,
    provisional: e.provisional === 1,
    detail: e.detail_json ? JSON.parse(e.detail_json) : null,
  };
}

/**
 * Baris kandidat (+ simbol) → baris API §5. `p` = baris reversal_provisional seri yang sama (hanya untuk kandidat
 * terbuka; null bila tidak ada / tidak diminta).
 */
function toView(row, p = null) {
  const s = parseSnapshot(row.snapshot_json);
  const evidence = Array.isArray(s.evidenceDetails) ? s.evidenceDetails : normalizeEvidenceList(s.evidence);
  const provisional = row.closed_at === null ? provisionalView(p) : null;
  return {
    id: row.id,
    symbol: row.symbol,
    timeframe: row.timeframe,
    version: row.version,
    stage: row.stage,
    status: row.status,
    setupType: row.setup_type,
    setupTypes: Array.isArray(s.setupTypes) ? s.setupTypes : [],
    score: row.score,
    scoreComponents: Array.isArray(s.scoreComponents) ? s.scoreComponents : [],
    evidence,
    evidenceCount: Number.isInteger(s.evidenceCount) ? s.evidenceCount : evidence.length,
    firstDetectedAt: row.first_detected_at,
    firstDetectedPrice: row.first_detected_price,
    firstDetectedAtr: row.first_detected_atr,
    firstStage: s.firstStage ?? null,
    stageEnteredAt: row.stage_entered_at,
    barsInStage: Number.isInteger(s.barsInStage) ? s.barsInStage : null,
    barsSinceDetection: Number.isInteger(s.barsSinceDetection) ? s.barsSinceDetection : null,
    lastCandleTime: row.last_candle_time,
    lastEvaluatedAt: row.last_evaluated_at,
    levels: isPlainObject(s.levels) ? s.levels : {},
    nextConfirmation: isPlainObject(s.nextConfirmation) ? s.nextConfirmation : null,
    cancelCondition: isPlainObject(s.cancelCondition) ? s.cancelCondition : null,
    risks: Array.isArray(s.risks) ? s.risks : [],
    liquidityClass: row.liquidity_class,
    extended: row.extended === 1,
    moveSinceDetectionPct: isFiniteNumber(s.moveSinceDetectionPct) ? s.moveSinceDetectionPct : null,
    moveSinceDetectionAtr: isFiniteNumber(s.moveSinceDetectionAtr) ? s.moveSinceDetectionAtr : null,
    peakPrice: isFiniteNumber(s.peakPrice) ? s.peakPrice : null,
    peakStage: s.peakStage ?? null,
    markers: Array.isArray(s.markers) ? s.markers : [],
    closeReason: row.close_reason,
    closedAt: row.closed_at,
    updatedAt: row.updated_at,
    provisional,
    provisionalOnly: false,
    // Candle berjalan sudah dievaluasi setelah candle tutup terakhir → status candle RUNNING.
    candleStatus: provisional && provisional.candleOpenTime > row.last_candle_time ? 'RUNNING' : 'CLOSED',
  };
}

/** Baris reversal_provisional TANPA kandidat terbuka → baris API "provisional-only" (id null). */
function provisionalOnlyView(p) {
  const ev = parseSnapshot(p.snapshot_json);
  const provisional = provisionalView(p);
  return {
    id: null,
    symbol: p.symbol,
    timeframe: p.timeframe,
    version: Number.isInteger(ev.version) ? ev.version : null,
    stage: p.stage,
    status: STATUS_OF_STAGE[p.stage] ?? null,
    setupType: ev.setupType ?? null,
    setupTypes: Array.isArray(ev.setupTypes) ? ev.setupTypes : [],
    score: p.score,
    scoreComponents: Array.isArray(ev.score?.components) ? ev.score.components : [],
    evidence: provisional.evidence,
    evidenceCount: provisional.evidenceCount,
    firstDetectedAt: null,
    firstDetectedPrice: null,
    firstDetectedAtr: null,
    firstStage: null,
    stageEnteredAt: null,
    barsInStage: null,
    barsSinceDetection: null,
    lastCandleTime: p.candle_open_time,
    lastEvaluatedAt: p.evaluated_at,
    levels: isPlainObject(ev.levels) ? ev.levels : {},
    nextConfirmation: isPlainObject(ev.nextConfirmation) ? ev.nextConfirmation : null,
    cancelCondition: isPlainObject(ev.cancelCondition) ? ev.cancelCondition : null,
    risks: provisional.risks,
    liquidityClass: ev.context?.liquidityClass ?? null,
    extended: false,
    moveSinceDetectionPct: null,
    moveSinceDetectionAtr: null,
    peakPrice: null,
    peakStage: null,
    markers: Array.isArray(ev.markers) ? ev.markers : [],
    closeReason: null,
    closedAt: null,
    updatedAt: p.evaluated_at,
    provisional,
    provisionalOnly: true,
    candleStatus: 'RUNNING',
  };
}

/** Urutan daftar aktif: score DESC, first_detected_at DESC (provisional-only tanpa deteksi → setelah kandidat setara), id DESC. */
function compareActive(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const fa = a.firstDetectedAt ?? -1;
  const fb = b.firstDetectedAt ?? -1;
  if (fb !== fa) return fb - fa;
  return (b.id ?? -1) - (a.id ?? -1);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ clock?: () => number }} [deps] jam untuk `now` yang tidak diberikan (updated_at, evaluated_at provisional)
 */
export function createReversalRepository(db, { clock = () => Date.now() } = {}) {
  const stmt = {
    symbolId: db.prepare('SELECT id FROM symbols WHERE symbol = ?'),
    openFor: db.prepare(`SELECT c.*, sym.symbol FROM reversal_candidates c JOIN symbols sym ON sym.id = c.symbol_id
      WHERE c.symbol_id = ? AND c.timeframe = ? AND c.closed_at IS NULL`),
    byId: db.prepare(`SELECT c.*, sym.symbol FROM reversal_candidates c JOIN symbols sym ON sym.id = c.symbol_id WHERE c.id = ?`),
    insertCandidate: db.prepare(`INSERT INTO reversal_candidates
      (symbol_id, timeframe, version, stage, status, setup_type, score, first_detected_at, first_detected_price, first_detected_atr,
       stage_entered_at, last_candle_time, last_evaluated_at, invalidation_price, trigger_price, extended, liquidity_class,
       snapshot_json, close_reason, closed_at, updated_at)
      VALUES (@symbolId, @timeframe, @version, @stage, @status, @setupType, @score, @firstDetectedAt, @firstDetectedPrice, @firstDetectedAtr,
       @stageEnteredAt, @lastCandleTime, @lastEvaluatedAt, @invalidationPrice, @triggerPrice, @extended, @liquidityClass,
       @snapshotJson, @closeReason, @closedAt, @updatedAt)`),
    updateCandidate: db.prepare(`UPDATE reversal_candidates SET
      stage = @stage, status = @status, setup_type = @setupType, score = @score, stage_entered_at = @stageEnteredAt,
      last_candle_time = @lastCandleTime, last_evaluated_at = @lastEvaluatedAt, invalidation_price = @invalidationPrice,
      trigger_price = @triggerPrice, extended = @extended, liquidity_class = @liquidityClass, snapshot_json = @snapshotJson,
      close_reason = @closeReason, closed_at = @closedAt, updated_at = @updatedAt
      WHERE id = @id AND closed_at IS NULL`),
    insertEvent: db.prepare(`INSERT INTO reversal_events
      (candidate_id, occurred_at, candle_time, type, from_stage, to_stage, from_status, to_status, price, provisional, detail_json)
      VALUES (@candidateId, @occurredAt, @candleTime, @type, @fromStage, @toStage, @fromStatus, @toStatus, @price, @provisional, @detailJson)`),
    // Urutan kronologis kejadian (occurred_at), bukan candle_time: event EXPIRED karena pemantauan berhenti memakai
    // candle_time candle tutup terakhir, sedangkan event PROVISIONAL_STAGE memakai candle berjalan (lebih baru).
    events: db.prepare(`SELECT id, occurred_at, candle_time, type, from_stage, to_stage, from_status, to_status, price, provisional, detail_json
      FROM reversal_events WHERE candidate_id = ? ORDER BY occurred_at, id`),
    cursor: db.prepare('SELECT last_open_time FROM reversal_cursors WHERE symbol_id = ? AND timeframe = ?'),
    advanceCursor: db.prepare(`INSERT INTO reversal_cursors (symbol_id, timeframe, last_open_time, updated_at)
      VALUES (@symbolId, @timeframe, @openTime, @at)
      ON CONFLICT (symbol_id, timeframe) DO UPDATE SET last_open_time = excluded.last_open_time, updated_at = excluded.updated_at
      WHERE excluded.last_open_time > reversal_cursors.last_open_time`),
    provisionalFor: db.prepare(`SELECT p.*, sym.symbol FROM reversal_provisional p JOIN symbols sym ON sym.id = p.symbol_id
      WHERE p.symbol_id = ? AND p.timeframe = ?`),
    upsertProvisional: db.prepare(`INSERT INTO reversal_provisional (symbol_id, timeframe, candle_open_time, evaluated_at, stage, score, snapshot_json)
      VALUES (@symbolId, @timeframe, @candleOpenTime, @evaluatedAt, @stage, @score, @snapshotJson)
      ON CONFLICT (symbol_id, timeframe) DO UPDATE SET candle_open_time = excluded.candle_open_time, evaluated_at = excluded.evaluated_at,
        stage = excluded.stage, score = excluded.score, snapshot_json = excluded.snapshot_json`),
    deleteProvisional: db.prepare(`DELETE FROM reversal_provisional
      WHERE symbol_id = @symbolId AND timeframe = @timeframe AND (@upToOpenTime IS NULL OR candle_open_time <= @upToOpenTime)`),
    // Daftar aktif: kandidat terbuka + kolom provisional seri yang sama. Semua filter diterapkan SEBELUM limit.
    listActive: db.prepare(`SELECT c.*, sym.symbol,
        p.candle_open_time AS p_candle_open_time, p.evaluated_at AS p_evaluated_at, p.stage AS p_stage, p.score AS p_score,
        p.snapshot_json AS p_snapshot_json
      FROM reversal_candidates c
      JOIN symbols sym ON sym.id = c.symbol_id
      LEFT JOIN reversal_provisional p ON p.symbol_id = c.symbol_id AND p.timeframe = c.timeframe
      WHERE c.closed_at IS NULL
        AND (@timeframe IS NULL OR c.timeframe = @timeframe)
        AND (@stage IS NULL OR c.stage = @stage)
        AND (@status IS NULL OR c.status = @status)
        AND (@minScore IS NULL OR c.score >= @minScore)
        AND (@minEvidence IS NULL OR COALESCE(json_extract(c.snapshot_json, '$.evidenceCount'), 0) >= @minEvidence)
        AND (@minLiquidityRank IS NULL OR (CASE c.liquidity_class WHEN 'LIQUID' THEN 2 WHEN 'THIN' THEN 1 ELSE 0 END) >= @minLiquidityRank)
        AND (@includeExtended = 1 OR c.extended = 0)
      ORDER BY c.score DESC, c.first_detected_at DESC, c.id DESC
      LIMIT @limit`),
    // Kandidat provisional-only: evaluasi candle berjalan bertahap pada seri TANPA kandidat terbuka.
    listProvisionalOnly: db.prepare(`SELECT p.*, sym.symbol
      FROM reversal_provisional p
      JOIN symbols sym ON sym.id = p.symbol_id
      WHERE p.stage IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM reversal_candidates c
                        WHERE c.symbol_id = p.symbol_id AND c.timeframe = p.timeframe AND c.closed_at IS NULL)
        AND (@timeframe IS NULL OR p.timeframe = @timeframe)
        AND (@stage IS NULL OR p.stage = @stage)
        AND (@status IS NULL OR (CASE p.stage WHEN 'EARLY_FORMATION' THEN 'NEW' WHEN 'DEVELOPING_REVERSAL' THEN 'DEVELOPING'
                                 WHEN 'CONFIRMED_BREAKOUT' THEN 'CONFIRMED' END) = @status)
        AND (@minScore IS NULL OR COALESCE(p.score, 0) >= @minScore)
        AND (@minEvidence IS NULL OR COALESCE(json_extract(p.snapshot_json, '$.evidenceCount'), 0) >= @minEvidence)
        AND (@minLiquidityRank IS NULL OR (CASE json_extract(p.snapshot_json, '$.context.liquidityClass')
                                           WHEN 'LIQUID' THEN 2 WHEN 'THIN' THEN 1 ELSE 0 END) >= @minLiquidityRank)
      ORDER BY p.score DESC, p.evaluated_at DESC
      LIMIT @limit`),
    // Riwayat: dua statement (tanpa / dengan simbol) agar masing-masing memakai indeks migrasi 008 (INDEXED BY + CROSS
    // JOIN mengunci rencana: indeks urut first_detected_at dipindai mundur, tanpa SCAN penuh + sort sementara).
    historyAll: db.prepare(`SELECT c.*, sym.symbol
      FROM reversal_candidates c INDEXED BY idx_reversal_first_detected
      CROSS JOIN symbols sym ON sym.id = c.symbol_id
      WHERE (@timeframe IS NULL OR c.timeframe = @timeframe)
      ORDER BY c.first_detected_at DESC, c.id DESC
      LIMIT @limit`),
    historyBySymbol: db.prepare(`SELECT c.*, sym.symbol
      FROM reversal_candidates c INDEXED BY idx_reversal_symbol_first
      CROSS JOIN symbols sym ON sym.id = c.symbol_id
      WHERE c.symbol_id = (SELECT id FROM symbols WHERE symbol = @symbol)
        AND (@timeframe IS NULL OR c.timeframe = @timeframe)
      ORDER BY c.first_detected_at DESC, c.id DESC
      LIMIT @limit`),
    openSeries: db.prepare(`SELECT symbol, timeframe FROM (
        SELECT sym.symbol AS symbol, c.timeframe AS timeframe FROM reversal_candidates c JOIN symbols sym ON sym.id = c.symbol_id
        WHERE c.closed_at IS NULL
        UNION
        SELECT sym.symbol, p.timeframe FROM reversal_provisional p JOIN symbols sym ON sym.id = p.symbol_id
        WHERE p.stage IS NOT NULL)
      ORDER BY symbol, timeframe`),
    openForSymbol: db.prepare(`SELECT c.*, sym.symbol FROM reversal_candidates c JOIN symbols sym ON sym.id = c.symbol_id
      WHERE c.symbol_id = @symbolId AND c.closed_at IS NULL AND c.timeframe IN (SELECT value FROM json_each(@timeframes))
      ORDER BY c.timeframe, c.id`),
    lastStoredClose: db.prepare(`SELECT open_time, close FROM candles
      WHERE symbol_id = ? AND timeframe = ? ORDER BY open_time DESC LIMIT 1`),
    expireCandidate: db.prepare(`UPDATE reversal_candidates SET status = 'EXPIRED', close_reason = @reason, closed_at = @at, updated_at = @at,
      snapshot_json = @snapshotJson WHERE id = @id AND closed_at IS NULL`),
    deleteProvisionalForSymbol: db.prepare(`DELETE FROM reversal_provisional
      WHERE symbol_id = @symbolId AND timeframe IN (SELECT value FROM json_each(@timeframes))`),
  };

  const provisionalRowOf = (row) => (row.p_snapshot_json ? {
    candle_open_time: row.p_candle_open_time, evaluated_at: row.p_evaluated_at, stage: row.p_stage, score: row.p_score,
    snapshot_json: row.p_snapshot_json,
  } : null);

  const withEvents = (row) => ({ ...toView(row, row.closed_at === null ? stmt.provisionalFor.get(row.symbol_id, row.timeframe) : null),
    events: stmt.events.all(row.id).map(eventView) });

  const saveTx = db.transaction(({ symbol, timeframe, snapshot, events, evidence, updatedAt }) => {
    const sym = stmt.symbolId.get(symbol);
    if (!sym) throw new ReversalRepositoryError(`Simbol ${symbol} belum terdaftar`, 'UNKNOWN_SYMBOL');
    const open = stmt.openFor.get(sym.id, timeframe);
    const opening = events.length > 0 && events[0].type === 'OPENED';
    const terminal = TERMINAL_STATUSES.includes(snapshot.status);
    const closing = terminal ? events.find((e) => TERMINAL_STATUSES.includes(e.toStatus)) ?? null : null;
    const previous = open ? parseSnapshot(open.snapshot_json) : null;
    const common = {
      stage: snapshot.stage,
      status: snapshot.status,
      setupType: snapshot.setupType ?? null,
      score: snapshot.score,
      stageEnteredAt: snapshot.stageEnteredAt,
      lastCandleTime: snapshot.lastCandleTime,
      lastEvaluatedAt: snapshot.lastEvaluatedAt,
      invalidationPrice: isFiniteNumber(snapshot.levels?.invalidation) ? snapshot.levels.invalidation : null,
      triggerPrice: isFiniteNumber(snapshot.levels?.trigger) ? snapshot.levels.trigger : null,
      extended: snapshot.extended === true ? 1 : 0,
      liquidityClass: snapshot.liquidityClass ?? null,
      snapshotJson: JSON.stringify(storedSnapshot(snapshot, evidence, previous)),
      closeReason: terminal ? snapshot.closeReason : null,
      closedAt: terminal ? (closing?.occurredAt ?? updatedAt) : null,
      updatedAt,
    };

    let id;
    if (opening) {
      if (open) throw new ReversalRepositoryError('Masih ada kandidat reversal terbuka untuk simbol & timeframe ini', 'OPEN_CANDIDATE_EXISTS');
      if (terminal) throw new ReversalRepositoryError('Kandidat baru tidak dapat langsung terminal', 'INVALID_TRANSITION');
      id = Number(stmt.insertCandidate.run({
        ...common,
        symbolId: sym.id,
        timeframe,
        version: snapshot.version,
        firstDetectedAt: snapshot.firstDetectedAt,
        firstDetectedPrice: snapshot.firstDetectedPrice,
        firstDetectedAtr: isFiniteNumber(snapshot.firstDetectedAtr) ? snapshot.firstDetectedAtr : null,
      }).lastInsertRowid);
    } else {
      if (!open) throw new ReversalRepositoryError('Tidak ada kandidat reversal terbuka untuk diperbarui', 'NO_OPEN_CANDIDATE');
      if (open.first_detected_at !== snapshot.firstDetectedAt || open.version !== snapshot.version) {
        throw new ReversalRepositoryError('Snapshot tidak cocok dengan kandidat terbuka', 'SNAPSHOT_MISMATCH');
      }
      if (events.length > 0 && ((events[0].fromStage ?? null) !== open.stage || (events[0].fromStatus ?? null) !== open.status)) {
        throw new ReversalRepositoryError('event.fromStage/fromStatus tidak sama dengan yang tersimpan', 'STATE_MISMATCH');
      }
      // Setiap perubahan tahap/status wajib tercatat di reversal_events (transaksi yang sama).
      if (events.length === 0 && (snapshot.stage !== open.stage || snapshot.status !== open.status)) {
        throw new ReversalRepositoryError(
          `Perubahan ${open.stage}/${open.status} → ${snapshot.stage}/${snapshot.status} tanpa event`, 'STATE_CHANGE_WITHOUT_EVENT',
        );
      }
      if (open.last_candle_time > snapshot.lastCandleTime) throw new ReversalRepositoryError('Snapshot lebih lama dari yang tersimpan', 'STALE_SNAPSHOT');
      id = open.id;
      stmt.updateCandidate.run({ ...common, id });
    }

    // Candle snapshot ini sudah dievaluasi: kursor maju dalam transaksi yang sama dengan kandidat + event.
    stmt.advanceCursor.run({ symbolId: sym.id, timeframe, openTime: snapshot.lastCandleTime, at: updatedAt });

    for (const event of events) {
      const { reason = null, detail = {} } = event;
      stmt.insertEvent.run({
        candidateId: id,
        occurredAt: event.occurredAt ?? updatedAt,
        candleTime: event.candleTime,
        type: event.type,
        fromStage: event.fromStage ?? null,
        toStage: event.toStage ?? null,
        fromStatus: event.fromStatus ?? null,
        toStatus: event.toStatus,
        price: isFiniteNumber(event.price) ? event.price : null,
        provisional: 0,
        detailJson: JSON.stringify({ reason, ...detail }),
      });
    }
    return { id, opened: opening, closed: terminal, saved: true };
  });

  const setProvisionalTx = db.transaction(({ symbol, timeframe, evaluation, previousStage, price, at }) => {
    const sym = stmt.symbolId.get(symbol);
    if (!sym) throw new ReversalRepositoryError(`Simbol ${symbol} belum terdaftar`, 'UNKNOWN_SYMBOL');
    const none = { stored: false, eventRecorded: false, stage: evaluation.stage, previousStage: null, candidateId: null };
    // Candle yang sudah dievaluasi sebagai candle tertutup (kursor) tidak boleh ditimpa evaluasi provisional terlambat.
    const cursor = stmt.cursor.get(sym.id, timeframe);
    if (cursor && evaluation.candleOpenTime <= cursor.last_open_time) return { ...none, reason: 'CANDLE_CLOSED' };
    const existing = stmt.provisionalFor.get(sym.id, timeframe);
    if (existing && existing.candle_open_time > evaluation.candleOpenTime) return { ...none, reason: 'STALE' };
    const open = stmt.openFor.get(sym.id, timeframe);
    // Pembanding "tahap provisional sebelumnya": argumen pemanggil, lalu baris provisional, lalu tahap kandidat terbuka.
    const baseline = previousStage !== undefined ? previousStage : existing ? existing.stage : open ? open.stage : null;
    const score = isPlainObject(evaluation.score) ? evaluation.score.total : evaluation.score;
    stmt.upsertProvisional.run({
      symbolId: sym.id, timeframe, candleOpenTime: evaluation.candleOpenTime, evaluatedAt: at, stage: evaluation.stage,
      score: isFiniteNumber(score) ? score : null, snapshotJson: JSON.stringify(evaluation),
    });
    let eventRecorded = false;
    if (open && evaluation.stage !== baseline) {
      stmt.insertEvent.run({
        candidateId: open.id,
        occurredAt: at,
        candleTime: evaluation.candleOpenTime,
        type: 'PROVISIONAL_STAGE',
        fromStage: baseline,
        toStage: evaluation.stage,
        fromStatus: open.status,
        toStatus: open.status,
        price: isFiniteNumber(price) ? price : null,
        provisional: 1,
        detailJson: JSON.stringify({
          reason: 'PROVISIONAL_STAGE', provisional: true, score: isFiniteNumber(score) ? score : null,
          evidence: evidenceIds(evaluation.evidence), levels: isPlainObject(evaluation.levels) ? evaluation.levels : null,
        }),
      });
      eventRecorded = true;
    }
    return { stored: true, eventRecorded, stage: evaluation.stage, previousStage: baseline, candidateId: open?.id ?? null };
  });

  const closeForSymbolTx = db.transaction(({ symbol, timeframes, reason, at }) => {
    const sym = stmt.symbolId.get(symbol);
    if (!sym) return [];
    const closed = [];
    const list = JSON.stringify(timeframes);
    for (const row of stmt.openForSymbol.all({ symbolId: sym.id, timeframes: list })) {
      const snapshot = parseSnapshot(row.snapshot_json);
      const last = stmt.lastStoredClose.get(sym.id, row.timeframe);
      const price = isFiniteNumber(last?.close) ? last.close : null;
      stmt.expireCandidate.run({
        id: row.id, at, reason,
        snapshotJson: JSON.stringify({ ...snapshot, status: 'EXPIRED', closeReason: reason, lastEvaluatedAt: at }),
      });
      stmt.insertEvent.run({
        candidateId: row.id,
        occurredAt: at,
        // candle_time = candle terakhir yang dievaluasi (bukan `at`) agar titik awal replay pipeline tidak melompat.
        candleTime: row.last_candle_time,
        type: 'EXPIRED',
        fromStage: row.stage,
        toStage: row.stage,
        fromStatus: row.status,
        toStatus: 'EXPIRED',
        price,
        provisional: 0,
        detailJson: JSON.stringify({
          reason, barsInStage: snapshot.barsInStage ?? null, firstDetectedPrice: row.first_detected_price,
          invalidation: row.invalidation_price, priceCandleTime: price === null ? null : last.open_time,
        }),
      });
      closed.push({ id: row.id, timeframe: row.timeframe, fromStage: row.stage, fromStatus: row.status, price });
    }
    // Evaluasi provisional seri yang berhenti dipantau tidak akan diperbarui lagi → dihapus agar tidak menggantung di daftar.
    stmt.deleteProvisionalForSymbol.run({ symbolId: sym.id, timeframes: list });
    return closed;
  });

  return {
    /** Kandidat terbuka untuk simbol + timeframe sebagai ReversalSnapshot §4 (+ `id`), atau null. */
    async getOpen({ symbol, timeframe } = {}) {
      assertSymbol(symbol);
      assertTimeframe(timeframe);
      const sym = stmt.symbolId.get(symbol);
      if (!sym) return null;
      const row = stmt.openFor.get(sym.id, timeframe);
      return row ? toSnapshot(row) : null;
    },

    /**
     * Menyimpan hasil transitionReversal() dalam satu transaksi:
     * - event OPENED (event pertama) → INSERT kandidat baru (ditolak bila masih ada yang terbuka);
     * - selain itu → UPDATE kandidat terbuka; status terminal mengisi closed_at + close_reason;
     *   snapshot dengan tahap/status berbeda dari yang tersimpan wajib disertai event (STATE_CHANGE_WITHOUT_EVENT);
     * - setiap event → INSERT reversal_events (provisional = 0); kursor maju ke snapshot.lastCandleTime.
     * Snapshot status NONE (belum ada kandidat, hanya histeresis pending) tidak disimpan (no-op, events harus kosong);
     * snapshot terminal tanpa event (candle lama/duplikat) juga no-op.
     * `evidence` (opsional) = daftar bukti lengkap evaluasi (`evaluation.evidence`) untuk tampilan; tanpa argumen ini
     * bukti lama dipertahankan, atau diturunkan dari id di snapshot.evidence.
     * @returns {Promise<{ id: number|null, opened: boolean, closed: boolean, saved: boolean }>}
     */
    async save({ symbol, timeframe, snapshot, events = [], evidence, now } = {}) {
      assertSymbol(symbol);
      assertTimeframe(timeframe);
      if (!isPlainObject(snapshot)) throw new TypeError('snapshot wajib objek');
      if (!Array.isArray(events)) throw new TypeError('events harus array');
      const noop = { id: null, opened: false, closed: false, saved: false };
      if (snapshot.status === 'NONE' || snapshot.status === undefined || snapshot.status === null) {
        if (events.length > 0) throw new RangeError('Event tidak boleh menyertai snapshot tanpa kandidat (status NONE)');
        return noop;
      }
      if (TERMINAL_STATUSES.includes(snapshot.status) && events.length === 0) return noop;
      assertSnapshot(snapshot, timeframe);
      events.forEach((event, i) => assertEvent(event, i, events, snapshot));
      if (evidence !== undefined && !Array.isArray(evidence)) throw new TypeError('evidence harus array');
      const updatedAt = now ?? snapshot.lastEvaluatedAt;
      assertEpoch(updatedAt, 'Waktu pembaruan (now / snapshot.lastEvaluatedAt)');
      return saveTx({ symbol, timeframe, snapshot, events, evidence, updatedAt });
    },

    /**
     * Mencatat bahwa candle `openTime` sudah dievaluasi (termasuk candle tanpa kandidat). Kursor hanya maju; nilai
     * yang lebih lama/sama diabaikan (idempoten). save() memajukan kursor sendiri.
     * @returns {Promise<{ advanced: boolean }>}
     */
    async markEvaluated({ symbol, timeframe, openTime, now } = {}) {
      assertSymbol(symbol);
      assertTimeframe(timeframe);
      assertEpoch(openTime, 'openTime');
      const at = now ?? clock();
      assertEpoch(at, 'now');
      const sym = stmt.symbolId.get(symbol);
      if (!sym) throw new ReversalRepositoryError(`Simbol ${symbol} belum terdaftar`, 'UNKNOWN_SYMBOL');
      return { advanced: stmt.advanceCursor.run({ symbolId: sym.id, timeframe, openTime, at }).changes > 0 };
    },

    /** openTime candle dasar terakhir yang sudah dievaluasi pipeline untuk seri ini (kursor), atau null. */
    async lastEvaluatedCandleTime({ symbol, timeframe } = {}) {
      assertSymbol(symbol);
      assertTimeframe(timeframe);
      const sym = stmt.symbolId.get(symbol);
      if (!sym) return null;
      return stmt.cursor.get(sym.id, timeframe)?.last_open_time ?? null;
    },

    /**
     * Upsert evaluasi provisional (candle berjalan, `evaluation.provisional === true`) untuk seri ini. Bila ada kandidat
     * terbuka dan `evaluation.stage` berbeda dari tahap provisional sebelumnya (`previousStage`; tanpa argumen: baris
     * provisional sebelumnya, atau tahap kandidat terbuka) → satu event PROVISIONAL_STAGE (provisional = 1). Tidak pernah
     * membuka/menutup kandidat atau memajukan kursor. Evaluasi untuk candle yang sudah dievaluasi tertutup (≤ kursor) atau
     * lebih lama dari baris provisional tersimpan diabaikan (stored: false).
     * @param {{ symbol: string, timeframe: string, evaluation: object, previousStage?: string|null, price?: number|null, now?: number }} input
     *   price: close candle berjalan (untuk event); now: waktu evaluasi (default clock).
     * @returns {Promise<{ stored: boolean, eventRecorded: boolean, stage: string|null, previousStage: string|null, candidateId: number|null, reason?: string }>}
     */
    async setProvisional({ symbol, timeframe, evaluation, previousStage, price = null, now } = {}) {
      assertSymbol(symbol);
      assertTimeframe(timeframe);
      if (!isPlainObject(evaluation)) throw new TypeError('evaluation wajib objek');
      if (evaluation.provisional !== true) throw new RangeError('evaluation.provisional harus true untuk setProvisional');
      if (evaluation.timeframe !== undefined && evaluation.timeframe !== timeframe) throw new RangeError('evaluation.timeframe tidak sama dengan argumen timeframe');
      assertEpoch(evaluation.candleOpenTime, 'evaluation.candleOpenTime');
      assertStageOrNull(evaluation.stage ?? null, 'evaluation.stage');
      const score = isPlainObject(evaluation.score) ? evaluation.score.total : evaluation.score;
      if (score !== null && score !== undefined) assertScore(score, 'evaluation.score');
      if (previousStage !== undefined) assertStageOrNull(previousStage, 'previousStage');
      assertNullableNumber(price, 'price');
      const at = now ?? clock();
      assertEpoch(at, 'now');
      return setProvisionalTx({ symbol, timeframe, evaluation: { ...evaluation, stage: evaluation.stage ?? null }, previousStage, price, at });
    },

    /**
     * Menghapus evaluasi provisional seri ini (dipanggil setelah candle tutup). `upToOpenTime` (opsional) hanya menghapus
     * baris dengan candle_open_time ≤ nilai itu, agar evaluasi provisional candle BERIKUTNYA yang sudah masuk tidak ikut hilang.
     * @returns {Promise<{ cleared: boolean }>}
     */
    async clearProvisional({ symbol, timeframe, upToOpenTime = null } = {}) {
      assertSymbol(symbol);
      assertTimeframe(timeframe);
      if (upToOpenTime !== null) assertEpoch(upToOpenTime, 'upToOpenTime');
      const sym = stmt.symbolId.get(symbol);
      if (!sym) return { cleared: false };
      return { cleared: stmt.deleteProvisional.run({ symbolId: sym.id, timeframe, upToOpenTime }).changes > 0 };
    },

    /**
     * Kandidat terbuka (status NEW/DEVELOPING/CONFIRMED) + kolom `provisional` (evaluasi candle berjalan seri itu, atau null)
     * + kandidat provisional-only (`provisionalOnly: true`, `id: null`) bila includeProvisional. Semua filter diterapkan
     * sebelum limit; urutan score DESC, first_detected_at DESC. `liquidity` = kelas minimum ('LIQUID' hanya LIQUID; 'THIN' =
     * LIQUID + THIN; ILLIQUID/UNKNOWN tidak pernah lolos filter). `minEvidence` = jumlah bukti minimum (filter sensitivitas).
     */
    async listActive(filters = {}) {
      if (!isPlainObject(filters)) throw new TypeError('filter harus objek');
      const allowed = ['timeframe', 'stage', 'status', 'liquidity', 'minScore', 'minEvidence', 'includeExtended', 'includeProvisional', 'limit'];
      for (const key of Object.keys(filters)) if (!allowed.includes(key)) throw new TypeError(`Filter tidak dikenal: ${key}`);
      const {
        timeframe = null, stage = null, status = null, liquidity = null, minScore = null, minEvidence = null,
        includeExtended = true, includeProvisional = true, limit = 200,
      } = filters;
      if (timeframe !== null) assertTimeframe(timeframe);
      if (stage !== null && !STAGES.includes(stage)) throw new RangeError('Filter stage tidak valid');
      if (status !== null && !OPEN_STATUSES.includes(status)) throw new RangeError('Filter status harus status terbuka');
      if (liquidity !== null && !(liquidity in LIQUIDITY_RANK)) throw new RangeError('Filter liquidity harus LIQUID atau THIN');
      if (minScore !== null) assertScore(minScore, 'minScore');
      if (minEvidence !== null && !(Number.isInteger(minEvidence) && minEvidence >= 0)) throw new RangeError('minEvidence harus bilangan bulat ≥ 0');
      if (typeof includeExtended !== 'boolean' || typeof includeProvisional !== 'boolean') throw new TypeError('includeExtended/includeProvisional harus boolean');
      assertLimit(limit, ACTIVE_MAX);
      const params = {
        timeframe, stage, status, minScore, minEvidence, minLiquidityRank: liquidity === null ? null : LIQUIDITY_RANK[liquidity],
        includeExtended: includeExtended ? 1 : 0, limit,
      };
      const rows = stmt.listActive.all(params).map((row) => toView(row, includeProvisional ? provisionalRowOf(row) : null));
      const extra = includeProvisional ? stmt.listProvisionalOnly.all(params).map(provisionalOnlyView) : [];
      return [...rows, ...extra].sort(compareActive).slice(0, limit);
    },

    /** Riwayat kandidat (terbuka & tertutup) terbaru dulu, lengkap dengan `events` (termasuk provisional, ditandai). */
    async history({ symbol = null, timeframe = null, limit = 100 } = {}) {
      if (symbol !== null) assertSymbol(symbol);
      if (timeframe !== null) assertTimeframe(timeframe);
      assertLimit(limit, HISTORY_MAX);
      const rows = symbol === null ? stmt.historyAll.all({ timeframe, limit }) : stmt.historyBySymbol.all({ symbol, timeframe, limit });
      return rows.map(withEvents);
    },

    /** Satu kandidat (id) + events, atau null bila tidak ada. */
    async getById(id) {
      if (!Number.isSafeInteger(id) || id < 1) throw new RangeError('id harus bilangan bulat ≥ 1');
      const row = stmt.byId.get(id);
      return row ? withEvents(row) : null;
    },

    /**
     * Pasangan simbol × timeframe yang masih punya kandidat terbuka ATAU evaluasi provisional bertahap (keduanya harus
     * dibersihkan bila seri berhenti dipantau), tanpa duplikat, urut simbol lalu timeframe.
     * @returns {Promise<Array<{ symbol: string, timeframe: string }>>}
     */
    async listOpenSeries() {
      return stmt.openSeries.all().map((r) => ({ symbol: r.symbol, timeframe: r.timeframe }));
    },

    /**
     * Menutup semua kandidat terbuka sebuah simbol (opsional hanya `timeframes`) karena seri berhenti dipantau: status →
     * EXPIRED, close_reason = reason, closed_at = updated_at = `at`, satu event EXPIRED per kandidat (price = close candle
     * tersimpan terakhir atau null), dan baris provisional seri itu dihapus — semua dalam satu transaksi. Tanpa alert.
     * @param {{ symbol: string, timeframes?: string[]|null, reason: 'SYMBOL_DELISTED'|'MONITORING_STOPPED', at: number }} input
     * @returns {Promise<{ closed: Array<{ id: number, timeframe: string, fromStage: string, fromStatus: string, price: number|null }> }>}
     */
    async closeOpenForSymbol({ symbol, timeframes = null, reason, at } = {}) {
      assertSymbol(symbol);
      if (!REVERSAL_MONITORING_STOP_REASONS.includes(reason)) throw new RangeError(`Reason penutupan tidak valid: ${String(reason)}`);
      assertEpoch(at, 'at');
      let list = REVERSAL_TIMEFRAMES;
      if (timeframes !== null && timeframes !== undefined) {
        if (!Array.isArray(timeframes)) throw new TypeError('timeframes harus array atau null');
        // Timeframe di luar Reversal Radar (bila kontrak timeframe berubah) diabaikan; nilai di luar TIMEFRAMES ditolak.
        for (const tf of timeframes) if (!TIMEFRAMES.includes(tf)) throw new RangeError(`Timeframe tidak didukung: ${String(tf)}`);
        list = REVERSAL_TIMEFRAMES.filter((tf) => timeframes.includes(tf));
      }
      if (list.length === 0) return { closed: [] };
      return { closed: closeForSymbolTx({ symbol, timeframes: list, reason, at }) };
    },
  };
}
