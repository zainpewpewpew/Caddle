import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../../backend/database/connection.js';
import { migrate } from '../../../backend/database/migrate.js';
import { createRepositories } from '../../../backend/database/repositories/index.js';
import { ReversalRepositoryError, createReversalRepository } from '../../../backend/reversal/repository.js';
import { REVERSAL_SEED_ROWS, buildReversalEvaluation, buildReversalEvidence, buildReversalSnapshot, seedReversalCandidates } from '../../helpers/reversalSeed.js';

// Repositori Reversal Radar (docs/19 §5) atas SQLite asli (migrasi 008). Semua data SINTETIS — bukan data pasar nyata.
const T0 = Date.UTC(2027, 0, 3, 0, 0);
const M15 = 15 * 60_000;
const M5 = 5 * 60_000;
const at = (i, ms = M15) => T0 + i * ms;
const NOW = Date.UTC(2027, 0, 10);

function setup(path = ':memory:') {
  const db = openDatabase(path);
  migrate(db, { now: () => new Date(0) });
  const insert = db.prepare(`INSERT OR IGNORE INTO symbols (symbol, base_asset, quote_asset, contract_type, status, first_seen_at, last_seen_at)
    VALUES (?, ?, 'USDT', 'PERPETUAL', 'TRADING', 0, 0)`);
  insert.run('BTCUSDT', 'BTC');
  insert.run('ETHUSDT', 'ETH');
  return { db, repo: createReversalRepository(db, { clock: () => NOW }) };
}

const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const cursorRows = (db) => db.prepare('SELECT symbol_id, timeframe, last_open_time, updated_at FROM reversal_cursors ORDER BY symbol_id, timeframe').all();

/** Snapshot + event pembuka pada candle ke-i (15m). */
function opened(i, overrides = {}) {
  const snapshot = buildReversalSnapshot({ lastCandleTime: at(i), firstDetectedAt: at(i + 1) - 1, stageEnteredAt: at(i + 1) - 1, ...overrides });
  const event = {
    type: 'OPENED', fromStage: null, toStage: snapshot.stage, fromStatus: 'NONE', toStatus: snapshot.status, candleTime: at(i),
    occurredAt: at(i + 1) - 1, price: snapshot.firstDetectedPrice, reason: 'STAGE_EVIDENCE', provisional: false,
    detail: { score: snapshot.score, evidence: snapshot.evidence, levels: snapshot.levels },
  };
  return { snapshot, event };
}

/** Snapshot lanjutan (candle ke-i) dari snapshot sebelumnya, tanpa event bila tahap sama. */
function advanced(prev, i, overrides = {}) {
  return { ...prev, lastCandleTime: at(i), lastEvaluatedAt: at(i + 1) - 1, barsInStage: prev.barsInStage + 1, barsSinceDetection: prev.barsSinceDetection + 1, ...overrides };
}

function stageUp(prev, i, stage, overrides = {}) {
  const snapshot = advanced(prev, i, { stage, status: { EARLY_FORMATION: 'NEW', DEVELOPING_REVERSAL: 'DEVELOPING', CONFIRMED_BREAKOUT: 'CONFIRMED' }[stage], stageEnteredAt: at(i + 1) - 1, barsInStage: 0, peakStage: stage, ...overrides });
  const event = {
    type: 'STAGE_UP', fromStage: prev.stage, toStage: stage, fromStatus: prev.status, toStatus: snapshot.status, candleTime: at(i), occurredAt: at(i + 1) - 1,
    price: 101, reason: 'STAGE_EVIDENCE', provisional: false, detail: { score: snapshot.score },
  };
  return { snapshot, event };
}

function cancelled(prev, i, reason = 'CLOSE_BELOW_INVALIDATION') {
  const snapshot = advanced(prev, i, { status: 'CANCELLED', closeReason: reason });
  const event = {
    type: 'CANCELLED', fromStage: prev.stage, toStage: prev.stage, fromStatus: prev.status, toStatus: 'CANCELLED', candleTime: at(i), occurredAt: at(i + 1) - 1,
    price: 93.5, reason, provisional: false, detail: { invalidation: prev.levels.invalidation },
  };
  return { snapshot, event };
}

const tempDirs = [];
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe('repositori Reversal Radar — kandidat & event', () => {
  it('UNIT-RRP-001 event OPENED → kandidat baru: baris, event, kursor maju dalam transaksi yang sama; getOpen = snapshot §4 (+id) tanpa evidenceDetails', async () => {
    const { db, repo } = setup();
    const { snapshot, event } = opened(10);
    const evidence = buildReversalEvidence(snapshot.evidence, { time: at(10) });
    const saved = await repo.save({ symbol: 'BTCUSDT', timeframe: '15m', snapshot, events: [event], evidence });
    expect(saved).toEqual({ id: 1, opened: true, closed: false, saved: true });

    const row = db.prepare('SELECT * FROM reversal_candidates').get();
    expect(row).toMatchObject({
      id: 1, symbol_id: 1, timeframe: '15m', version: 1, stage: 'EARLY_FORMATION', status: 'NEW', setup_type: 'ROUNDED_BOTTOM', score: 19,
      first_detected_at: at(11) - 1, first_detected_price: 100, first_detected_atr: 1.2, stage_entered_at: at(11) - 1, last_candle_time: at(10),
      last_evaluated_at: at(11) - 1, invalidation_price: 94.7, trigger_price: 104, extended: 0, liquidity_class: 'LIQUID', close_reason: null,
      closed_at: null, updated_at: at(11) - 1,
    });
    expect(JSON.parse(row.snapshot_json).evidenceDetails).toEqual(evidence.map(({ id, group, label, detail, time, price }) => ({ id, group, label, detail, time, price })));
    expect(db.prepare('SELECT * FROM reversal_events').all()).toEqual([expect.objectContaining({
      candidate_id: 1, occurred_at: at(11) - 1, candle_time: at(10), type: 'OPENED', from_stage: null, to_stage: 'EARLY_FORMATION',
      from_status: 'NONE', to_status: 'NEW', price: 100, provisional: 0,
    })]);
    expect(JSON.parse(db.prepare('SELECT detail_json FROM reversal_events').get().detail_json)).toMatchObject({ reason: 'STAGE_EVIDENCE', score: 19 });
    expect(cursorRows(db)).toEqual([{ symbol_id: 1, timeframe: '15m', last_open_time: at(10), updated_at: at(11) - 1 }]);
    expect(await repo.lastEvaluatedCandleTime({ symbol: 'BTCUSDT', timeframe: '15m' })).toBe(at(10));

    const open = await repo.getOpen({ symbol: 'BTCUSDT', timeframe: '15m' });
    expect(open).toEqual({ id: 1, ...snapshot });
    expect(open).not.toHaveProperty('evidenceDetails');
    expect(await repo.getOpen({ symbol: 'BTCUSDT', timeframe: '5m' })).toBeNull();
    expect(await repo.getOpen({ symbol: 'XRPUSDT', timeframe: '15m' })).toBeNull();
  });

  it('UNIT-RRP-002 pembaruan tanpa event (tahap sama) memperbarui snapshot & kursor; snapshot lebih lama → STALE_SNAPSHOT; bukti lama dipertahankan bila tidak dikirim', async () => {
    const { db, repo } = setup();
    const { snapshot, event } = opened(10);
    const evidence = buildReversalEvidence(snapshot.evidence, { time: at(10) });
    await repo.save({ symbol: 'BTCUSDT', timeframe: '15m', snapshot, events: [event], evidence });
    const next = advanced(snapshot, 11, { score: 31, evidence: [...snapshot.evidence, 'EMA_CONVERGENCE'], evidenceCount: 4, levels: { ...snapshot.levels, trigger: 105 }, extended: false });
    expect(await repo.save({ symbol: 'BTCUSDT', timeframe: '15m', snapshot: next, events: [] })).toEqual({ id: 1, opened: false, closed: false, saved: true });
    expect(db.prepare('SELECT score, trigger_price, last_candle_time, updated_at FROM reversal_candidates').get())
      .toEqual({ score: 31, trigger_price: 105, last_candle_time: at(11), updated_at: at(12) - 1 });
    expect(count(db, 'reversal_events')).toBe(1);
    expect(cursorRows(db)[0].last_open_time).toBe(at(11));
    // Bukti tampilan mengikuti id snapshot.evidence: label bukti lama dipertahankan (tidak dikirim ulang), bukti baru
    // tanpa detail diturunkan minimal dari id-nya.
    const [view] = await repo.listActive();
    expect(view.evidence.map((e) => [e.id, e.label, e.group])).toEqual([
      ...evidence.map((e) => [e.id, e.label, e.group]), ['EMA_CONVERGENCE', 'EMA_CONVERGENCE', 'BASE'],
    ]);
    expect(view).toMatchObject({ score: 31, evidenceCount: 4, barsInStage: 1, barsSinceDetection: 1 });

    await expect(repo.save({ symbol: 'BTCUSDT', timeframe: '15m', snapshot: advanced(snapshot, 9), events: [] })).rejects.toMatchObject({ code: 'STALE_SNAPSHOT' });
    expect(await repo.getOpen({ symbol: 'BTCUSDT', timeframe: '15m' })).toEqual({ id: 1, ...next });
  });

  it('UNIT-RRP-003 siklus hidup: OPENED → STAGE_UP (status mengikuti tahap) → CANCELLED (closed_at, close_reason); kandidat berikutnya = baris baru', async () => {
    const { db, repo } = setup();
    const first = opened(10);
    await repo.save({ symbol: 'BTCUSDT', timeframe: '15m', snapshot: first.snapshot, events: [first.event] });
    const up = stageUp(first.snapshot, 12, 'DEVELOPING_REVERSAL');
    expect(await repo.save({ symbol: 'BTCUSDT', timeframe: '15m', snapshot: up.snapshot, events: [up.event] })).toEqual({ id: 1, opened: false, closed: false, saved: true });
    expect(db.prepare('SELECT stage, status, stage_entered_at FROM reversal_candidates').get()).toEqual({ stage: 'DEVELOPING_REVERSAL', status: 'DEVELOPING', stage_entered_at: at(13) - 1 });

    const end = cancelled(up.snapshot, 15);
    expect(await repo.save({ symbol: 'BTCUSDT', timeframe: '15m', snapshot: end.snapshot, events: [end.event] })).toEqual({ id: 1, opened: false, closed: true, saved: true });
    expect(db.prepare('SELECT stage, status, close_reason, closed_at, updated_at FROM reversal_candidates').get())
      .toEqual({ stage: 'DEVELOPING_REVERSAL', status: 'CANCELLED', close_reason: 'CLOSE_BELOW_INVALIDATION', closed_at: at(16) - 1, updated_at: at(16) - 1 });
    expect(await repo.getOpen({ symbol: 'BTCUSDT', timeframe: '15m' })).toBeNull();
    expect(await repo.listActive()).toEqual([]);
    // Snapshot terminal yang disimpan ulang tanpa event (candle lama/duplikat) = no-op.
    expect(await repo.save({ symbol: 'BTCUSDT', timeframe: '15m', snapshot: end.snapshot, events: [] })).toEqual({ id: null, opened: false, closed: false, saved: false });

    const second = opened(20, { price: 90 });
    expect(await repo.save({ symbol: 'BTCUSDT', timeframe: '15m', snapshot: second.snapshot, events: [second.event] })).toEqual({ id: 2, opened: true, closed: false, saved: true });
    const history = await repo.history({ symbol: 'BTCUSDT' });
    expect(history.map((h) => [h.id, h.status, h.closeReason, h.closedAt, h.events.map((e) => [e.type, e.fromStage, e.toStage, e.fromStatus, e.toStatus, e.provisional])])).toEqual([
      [2, 'NEW', null, null, [['OPENED', null, 'EARLY_FORMATION', 'NONE', 'NEW', false]]],
      [1, 'CANCELLED', 'CLOSE_BELOW_INVALIDATION', at(16) - 1, [
        ['OPENED', null, 'EARLY_FORMATION', 'NONE', 'NEW', false],
        ['STAGE_UP', 'EARLY_FORMATION', 'DEVELOPING_REVERSAL', 'NEW', 'DEVELOPING', false],
        ['CANCELLED', 'DEVELOPING_REVERSAL', 'DEVELOPING_REVERSAL', 'DEVELOPING', 'CANCELLED', false],
      ]],
    ]);
    expect(history[1].events[2].detail).toEqual({ reason: 'CLOSE_BELOW_INVALIDATION', invalidation: 94.7 });
    expect(cursorRows(db)[0].last_open_time).toBe(at(20));
  });

  it('UNIT-RRP-004 satu kandidat terbuka per simbol × timeframe: OPENED kedua → OPEN_CANDIDATE_EXISTS; indeks unik parsial menjaga di level database; seri lain tidak terganggu', async () => {
    const { db, repo } = setup();
    const a = opened(10);
    await repo.save({ symbol: 'BTCUSDT', timeframe: '15m', snapshot: a.snapshot, events: [a.event] });
    const b = opened(12);
    await expect(repo.save({ symbol: 'BTCUSDT', timeframe: '15m', snapshot: b.snapshot, events: [b.event] })).rejects.toMatchObject({ code: 'OPEN_CANDIDATE_EXISTS' });
    expect(count(db, 'reversal_candidates')).toBe(1);
    expect(count(db, 'reversal_events')).toBe(1);
    // Seri lain (timeframe / simbol berbeda) boleh terbuka bersamaan.
    const c = opened(12, { timeframe: '5m', lastCandleTime: at(12, M5), firstDetectedAt: at(13, M5) - 1, stageEnteredAt: at(13, M5) - 1, lastEvaluatedAt: at(13, M5) - 1 });
    c.event.candleTime = at(12, M5);
    c.event.occurredAt = at(13, M5) - 1;
    expect((await repo.save({ symbol: 'BTCUSDT', timeframe: '5m', snapshot: c.snapshot, events: [c.event] })).opened).toBe(true);
    expect((await repo.save({ symbol: 'ETHUSDT', timeframe: '15m', snapshot: b.snapshot, events: [b.event] })).opened).toBe(true);
    expect(await repo.listOpenSeries()).toEqual([
      { symbol: 'BTCUSDT', timeframe: '15m' }, { symbol: 'BTCUSDT', timeframe: '5m' }, { symbol: 'ETHUSDT', timeframe: '15m' },
    ]);
    const row = db.prepare('SELECT * FROM reversal_candidates WHERE id = 1').get();
    expect(() => db.prepare(`INSERT INTO reversal_candidates (symbol_id, timeframe, version, stage, status, score, first_detected_at, first_detected_price,
      stage_entered_at, last_candle_time, last_evaluated_at, snapshot_json, updated_at)
      VALUES (@symbol_id, @timeframe, @version, @stage, @status, @score, @first_detected_at, @first_detected_price, @stage_entered_at,
      @last_candle_time, @last_evaluated_at, @snapshot_json, @updated_at)`).run(row)).toThrow(/UNIQUE/);
  });

  it('UNIT-RRP-005 snapshot dengan tahap/status berbeda TANPA event ditolak STATE_CHANGE_WITHOUT_EVENT; tahap, riwayat & kursor tidak berubah', async () => {
    const { db, repo } = setup();
    const { snapshot, event } = opened(10);
    await repo.save({ symbol: 'BTCUSDT', timeframe: '15m', snapshot, events: [event] });
    const before = { row: db.prepare('SELECT * FROM reversal_candidates').get(), events: count(db, 'reversal_events'), cursor: cursorRows(db) };
    const jumped = advanced(snapshot, 11, { stage: 'DEVELOPING_REVERSAL', status: 'DEVELOPING', stageEnteredAt: at(12) - 1 });
    await expect(repo.save({ symbol: 'BTCUSDT', timeframe: '15m', snapshot: jumped, events: [] })).rejects.toMatchObject({ code: 'STATE_CHANGE_WITHOUT_EVENT' });
    const closed = advanced(snapshot, 11, { status: 'CANCELLED', closeReason: 'NO_PROGRESS' });
    // Terminal tanpa event = no-op (bukan error), tetap tidak mengubah apa pun.
    expect(await repo.save({ symbol: 'BTCUSDT', timeframe: '15m', snapshot: closed, events: [] })).toMatchObject({ saved: false });
    expect(db.prepare('SELECT * FROM reversal_candidates').get()).toEqual(before.row);
    expect(count(db, 'reversal_events')).toBe(before.events);
    expect(cursorRows(db)).toEqual(before.cursor);
  });

  it('NEG-RRP-001 save menolak keadaan tidak konsisten & input tidak valid sebelum menyentuh database', async () => {
    const { db, repo } = setup();
    const { snapshot, event } = opened(10);
    const none = { ...snapshot, status: 'NONE', stage: null, pendingStage: 'EARLY_FORMATION', pendingBars: 1 };
    // Snapshot NONE = histeresis sebelum kandidat: tidak disimpan, tidak boleh membawa event.
    expect(await repo.save({ symbol: 'BTCUSDT', timeframe: '15m', snapshot: none, events: [] })).toEqual({ id: null, opened: false, closed: false, saved: false });
    await expect(repo.save({ symbol: 'BTCUSDT', timeframe: '15m', snapshot: none, events: [event] })).rejects.toThrow(RangeError);
    // Pembaruan tanpa kandidat terbuka; kandidat baru langsung terminal; simbol tak dikenal; simbol/timeframe tidak valid.
    await expect(repo.save({ symbol: 'BTCUSDT', timeframe: '15m', snapshot, events: [] })).rejects.toMatchObject({ code: 'NO_OPEN_CANDIDATE' });
    const terminalOpen = { snapshot: { ...snapshot, status: 'CANCELLED', closeReason: 'NO_PROGRESS' }, event: { ...event, type: 'OPENED', toStatus: 'CANCELLED' } };
    await expect(repo.save({ symbol: 'BTCUSDT', timeframe: '15m', snapshot: terminalOpen.snapshot, events: [terminalOpen.event] })).rejects.toThrow(RangeError);
    await expect(repo.save({ symbol: 'XRPUSDT', timeframe: '15m', snapshot, events: [event] })).rejects.toMatchObject({ code: 'UNKNOWN_SYMBOL' });
    await expect(repo.save({ symbol: "BTC'; DROP TABLE reversal_candidates;--", timeframe: '15m', snapshot, events: [event] })).rejects.toThrow(RangeError);
    await expect(repo.save({ symbol: 'BTCUSDT', timeframe: '4h', snapshot, events: [event] })).rejects.toThrow(RangeError);
    await expect(repo.save({ symbol: 'BTCUSDT', timeframe: '15m', snapshot: null, events: [event] })).rejects.toThrow(TypeError);
    // Field snapshot tidak valid.
    const bad = (patch) => repo.save({ symbol: 'BTCUSDT', timeframe: '15m', snapshot: { ...snapshot, ...patch }, events: [{ ...event, toStage: patch.stage ?? event.toStage }] });
    await expect(bad({ score: 101 })).rejects.toThrow(RangeError);
    await expect(bad({ risks: ['UNKNOWN_RISK'] })).rejects.toThrow(RangeError);
    await expect(bad({ firstDetectedPrice: 0 })).rejects.toThrow(RangeError);
    await expect(bad({ lastCandleTime: 1.5 })).rejects.toThrow(TypeError);
    await expect(bad({ liquidityClass: 'DEEP' })).rejects.toThrow(RangeError);
    await expect(bad({ status: 'DEVELOPING' })).rejects.toThrow(RangeError); // status tidak sesuai tahap
    await expect(bad({ timeframe: '5m' })).rejects.toThrow(RangeError);
    // Event tidak valid: tipe provisional, rantai putus, tidak berakhir di snapshot.
    await expect(repo.save({ symbol: 'BTCUSDT', timeframe: '15m', snapshot, events: [{ ...event, type: 'PROVISIONAL_STAGE' }] })).rejects.toThrow(RangeError);
    await expect(repo.save({ symbol: 'BTCUSDT', timeframe: '15m', snapshot, events: [{ ...event, toStage: 'DEVELOPING_REVERSAL', toStatus: 'DEVELOPING' }] })).rejects.toThrow(RangeError);
    await expect(repo.save({ symbol: 'BTCUSDT', timeframe: '15m', snapshot, events: [{ ...event, candleTime: 'x' }] })).rejects.toThrow(TypeError);
    expect(count(db, 'reversal_candidates')).toBe(0);
    expect(count(db, 'reversal_events')).toBe(0);
    expect(count(db, 'reversal_cursors')).toBe(0);

    // Setelah terbuka: event dari tahap/status yang tidak sama dengan tersimpan, snapshot kandidat lain.
    await repo.save({ symbol: 'BTCUSDT', timeframe: '15m', snapshot, events: [event] });
    const up = stageUp(snapshot, 12, 'DEVELOPING_REVERSAL');
    await expect(repo.save({ symbol: 'BTCUSDT', timeframe: '15m', snapshot: up.snapshot, events: [{ ...up.event, fromStatus: 'DEVELOPING', fromStage: 'DEVELOPING_REVERSAL', toStage: 'CONFIRMED_BREAKOUT', toStatus: 'CONFIRMED' }, { ...up.event, fromStage: 'CONFIRMED_BREAKOUT', fromStatus: 'CONFIRMED' }] }))
      .rejects.toThrow(RangeError);
    await expect(repo.save({ symbol: 'BTCUSDT', timeframe: '15m', snapshot: up.snapshot, events: [{ ...up.event, fromStage: 'CONFIRMED_BREAKOUT', fromStatus: 'CONFIRMED' }] }))
      .rejects.toThrow(RangeError); // STAGE_UP harus naik tahap
    await expect(repo.save({ symbol: 'BTCUSDT', timeframe: '15m', snapshot: advanced(snapshot, 11, { firstDetectedAt: at(1) }), events: [] })).rejects.toMatchObject({ code: 'SNAPSHOT_MISMATCH' });
    const mismatch = cancelled({ ...snapshot, stage: 'DEVELOPING_REVERSAL', status: 'DEVELOPING' }, 12);
    await expect(repo.save({ symbol: 'BTCUSDT', timeframe: '15m', snapshot: mismatch.snapshot, events: [mismatch.event] })).rejects.toMatchObject({ code: 'STATE_MISMATCH' });
    expect(await repo.getOpen({ symbol: 'BTCUSDT', timeframe: '15m' })).toEqual({ id: 1, ...snapshot });
    const err = await repo.save({ symbol: 'BTCUSDT', timeframe: '15m', snapshot: advanced(snapshot, 9), events: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(ReversalRepositoryError);
    expect(err.name).toBe('ReversalRepositoryError');
  });

  it('UNIT-RRP-006 kursor: markEvaluated hanya maju; save memajukannya atomik; save yang gagal di tengah di-rollback (kursor & event tidak berubah); bertahan setelah restart (file DB)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lr-rr-cursor-'));
    tempDirs.push(dir);
    const path = join(dir, 'reversal.db');
    const { db, repo } = setup(path);
    expect(await repo.lastEvaluatedCandleTime({ symbol: 'BTCUSDT', timeframe: '15m' })).toBeNull();
    expect(await repo.markEvaluated({ symbol: 'BTCUSDT', timeframe: '15m', openTime: at(3), now: at(4) - 1 })).toEqual({ advanced: true });
    expect(await repo.markEvaluated({ symbol: 'BTCUSDT', timeframe: '15m', openTime: at(2) })).toEqual({ advanced: false });
    expect(await repo.markEvaluated({ symbol: 'BTCUSDT', timeframe: '15m', openTime: at(3) })).toEqual({ advanced: false });
    expect(cursorRows(db)).toEqual([{ symbol_id: 1, timeframe: '15m', last_open_time: at(3), updated_at: at(4) - 1 }]);
    await expect(repo.markEvaluated({ symbol: 'XRPUSDT', timeframe: '15m', openTime: at(1) })).rejects.toMatchObject({ code: 'UNKNOWN_SYMBOL' });
    await expect(repo.markEvaluated({ symbol: 'BTCUSDT', timeframe: '4h', openTime: at(1) })).rejects.toThrow(RangeError);
    await expect(repo.markEvaluated({ symbol: 'BTCUSDT', timeframe: '15m', openTime: 1.5 })).rejects.toThrow(TypeError);

    const { snapshot, event } = opened(5);
    await repo.save({ symbol: 'BTCUSDT', timeframe: '15m', snapshot, events: [event] });
    expect(await repo.lastEvaluatedCandleTime({ symbol: 'BTCUSDT', timeframe: '15m' })).toBe(at(5));
    // Gagal di tengah (detail event tidak dapat diserialisasi): tidak ada kandidat/event/kursor yang berubah.
    const up = stageUp(snapshot, 6, 'DEVELOPING_REVERSAL');
    await expect(repo.save({ symbol: 'BTCUSDT', timeframe: '15m', snapshot: up.snapshot, events: [{ ...up.event, detail: { bad: 10n } }] })).rejects.toThrow(TypeError);
    expect(cursorRows(db)[0].last_open_time).toBe(at(5));
    expect(db.prepare('SELECT stage FROM reversal_candidates').get().stage).toBe('EARLY_FORMATION');
    expect(count(db, 'reversal_events')).toBe(1);
    db.close();

    const reopened = createReversalRepository(openDatabase(path), { clock: () => NOW });
    expect(await reopened.lastEvaluatedCandleTime({ symbol: 'BTCUSDT', timeframe: '15m' })).toBe(at(5));
    expect(await reopened.lastEvaluatedCandleTime({ symbol: 'BTCUSDT', timeframe: '1h' })).toBeNull();
    expect(await reopened.getOpen({ symbol: 'BTCUSDT', timeframe: '15m' })).toEqual({ id: 1, ...snapshot });
  });
});

describe('repositori Reversal Radar — provisional', () => {
  it('UNIT-RRP-007 setProvisional: upsert satu baris per seri; event PROVISIONAL_STAGE hanya bila ada kandidat terbuka DAN tahap provisional berubah; candle ≤ kursor / lebih lama diabaikan; clearProvisional(upToOpenTime)', async () => {
    const { db, repo } = setup();
    // Tanpa kandidat terbuka: tersimpan, tanpa event.
    const r0 = await repo.setProvisional({ symbol: 'BTCUSDT', timeframe: '15m', evaluation: buildReversalEvaluation({ candleOpenTime: at(11), stage: 'EARLY_FORMATION' }), price: 100.4, now: at(11) + 30_000 });
    expect(r0).toEqual({ stored: true, eventRecorded: false, stage: 'EARLY_FORMATION', previousStage: null, candidateId: null });
    expect(db.prepare('SELECT symbol_id, timeframe, candle_open_time, evaluated_at, stage, score FROM reversal_provisional').all())
      .toEqual([{ symbol_id: 1, timeframe: '15m', candle_open_time: at(11), evaluated_at: at(11) + 30_000, stage: 'EARLY_FORMATION', score: 19 }]);
    expect(count(db, 'reversal_events')).toBe(0);
    expect(count(db, 'reversal_cursors')).toBe(0);

    const { snapshot, event } = opened(10);
    await repo.save({ symbol: 'BTCUSDT', timeframe: '15m', snapshot, events: [event] });
    // Tahap provisional sama dengan baris sebelumnya (EARLY) → tanpa event; skor diperbarui.
    const same = await repo.setProvisional({ symbol: 'BTCUSDT', timeframe: '15m', evaluation: buildReversalEvaluation({ candleOpenTime: at(11), stage: 'EARLY_FORMATION', evidenceIds: ['LL_SHALLOWER', 'ATR_CONTRACTION', 'VOLUME_DRY_UP', 'QUIET_RISE'] }), price: 100.6, now: at(11) + 60_000 });
    expect(same).toMatchObject({ stored: true, eventRecorded: false, previousStage: 'EARLY_FORMATION', candidateId: 1 });
    expect(db.prepare('SELECT score, evaluated_at FROM reversal_provisional').get()).toEqual({ score: 24, evaluated_at: at(11) + 60_000 });
    expect(count(db, 'reversal_events')).toBe(1);
    // Tahap provisional naik → satu event PROVISIONAL_STAGE (provisional = 1), kandidat & kursor tidak berubah.
    const up = await repo.setProvisional({ symbol: 'BTCUSDT', timeframe: '15m', evaluation: buildReversalEvaluation({ candleOpenTime: at(11), stage: 'DEVELOPING_REVERSAL', evidenceIds: ['LL_SHALLOWER', 'ATR_CONTRACTION', 'VOLUME_DRY_UP', 'HIGHER_LOW'] }), price: 100.9, now: at(11) + 90_000 });
    expect(up).toMatchObject({ stored: true, eventRecorded: true, stage: 'DEVELOPING_REVERSAL', previousStage: 'EARLY_FORMATION', candidateId: 1 });
    expect(db.prepare('SELECT * FROM reversal_events WHERE provisional = 1').all()).toEqual([expect.objectContaining({
      candidate_id: 1, occurred_at: at(11) + 90_000, candle_time: at(11), type: 'PROVISIONAL_STAGE', from_stage: 'EARLY_FORMATION', to_stage: 'DEVELOPING_REVERSAL',
      from_status: 'NEW', to_status: 'NEW', price: 100.9, provisional: 1,
    })]);
    expect(JSON.parse(db.prepare('SELECT detail_json FROM reversal_events WHERE provisional = 1').get().detail_json)).toMatchObject({ reason: 'PROVISIONAL_STAGE', provisional: true, score: 29, evidence: ['LL_SHALLOWER', 'ATR_CONTRACTION', 'VOLUME_DRY_UP', 'HIGHER_LOW'] });
    expect(db.prepare('SELECT stage, status, updated_at FROM reversal_candidates').get()).toEqual({ stage: 'EARLY_FORMATION', status: 'NEW', updated_at: at(11) - 1 });
    expect(cursorRows(db)[0].last_open_time).toBe(at(10));
    // Tahap sama lagi → tidak ada event baru (anti-spam); kembali ke null → event (berubah).
    expect((await repo.setProvisional({ symbol: 'BTCUSDT', timeframe: '15m', evaluation: buildReversalEvaluation({ candleOpenTime: at(11), stage: 'DEVELOPING_REVERSAL' }), now: at(11) + 120_000 })).eventRecorded).toBe(false);
    expect((await repo.setProvisional({ symbol: 'BTCUSDT', timeframe: '15m', evaluation: buildReversalEvaluation({ candleOpenTime: at(11), stage: null }), now: at(11) + 150_000 })).eventRecorded).toBe(true);
    expect(db.prepare('SELECT COUNT(*) n FROM reversal_events WHERE provisional = 1').get().n).toBe(2);
    // previousStage eksplisit menggantikan pembanding tersimpan.
    expect((await repo.setProvisional({ symbol: 'BTCUSDT', timeframe: '15m', evaluation: buildReversalEvaluation({ candleOpenTime: at(11), stage: null }), previousStage: null, now: at(11) + 160_000 })).eventRecorded).toBe(false);

    // Daftar aktif membawa kolom provisional + candleStatus RUNNING.
    const [view] = await repo.listActive();
    expect(view).toMatchObject({ id: 1, candleStatus: 'RUNNING', provisionalOnly: false, provisional: { stage: null, candleOpenTime: at(11), evaluatedAt: at(11) + 160_000, evidenceCount: 3 } });
    expect(view.provisional.evidence.map((e) => e.id)).toEqual(['LL_SHALLOWER', 'ATR_CONTRACTION', 'VOLUME_DRY_UP']);
    expect(view.provisional.risks).toEqual(['PROVISIONAL']);

    // Evaluasi provisional untuk candle yang sudah dievaluasi tertutup (≤ kursor) atau lebih lama dari baris tersimpan diabaikan.
    expect(await repo.setProvisional({ symbol: 'BTCUSDT', timeframe: '15m', evaluation: buildReversalEvaluation({ candleOpenTime: at(10), stage: 'CONFIRMED_BREAKOUT' }), now: NOW }))
      .toMatchObject({ stored: false, eventRecorded: false, reason: 'CANDLE_CLOSED' });
    await repo.setProvisional({ symbol: 'BTCUSDT', timeframe: '15m', evaluation: buildReversalEvaluation({ candleOpenTime: at(12), stage: null }), now: at(12) + 10_000 });
    expect(await repo.setProvisional({ symbol: 'BTCUSDT', timeframe: '15m', evaluation: buildReversalEvaluation({ candleOpenTime: at(11), stage: 'CONFIRMED_BREAKOUT' }), now: at(12) + 20_000 }))
      .toMatchObject({ stored: false, reason: 'STALE' });
    expect(db.prepare('SELECT candle_open_time FROM reversal_provisional').get().candle_open_time).toBe(at(12));
    expect(db.prepare('SELECT COUNT(*) n FROM reversal_events WHERE provisional = 1').get().n).toBe(2);

    // clearProvisional dengan batas: candle berikutnya yang sudah masuk tidak ikut terhapus; tanpa batas → terhapus.
    expect(await repo.clearProvisional({ symbol: 'BTCUSDT', timeframe: '15m', upToOpenTime: at(11) })).toEqual({ cleared: false });
    expect(count(db, 'reversal_provisional')).toBe(1);
    expect(await repo.clearProvisional({ symbol: 'BTCUSDT', timeframe: '15m', upToOpenTime: at(12) })).toEqual({ cleared: true });
    expect(count(db, 'reversal_provisional')).toBe(0);
    expect(await repo.clearProvisional({ symbol: 'XRPUSDT', timeframe: '15m' })).toEqual({ cleared: false });
    expect((await repo.listActive())[0]).toMatchObject({ candleStatus: 'CLOSED', provisional: null });

    // Validasi input.
    await expect(repo.setProvisional({ symbol: 'BTCUSDT', timeframe: '15m', evaluation: buildReversalEvaluation({ provisional: false }) })).rejects.toThrow(RangeError);
    await expect(repo.setProvisional({ symbol: 'BTCUSDT', timeframe: '15m', evaluation: buildReversalEvaluation({ stage: 'LATE' }) })).rejects.toThrow(RangeError);
    await expect(repo.setProvisional({ symbol: 'BTCUSDT', timeframe: '15m', evaluation: buildReversalEvaluation({ timeframe: '5m' }) })).rejects.toThrow(RangeError);
    await expect(repo.setProvisional({ symbol: 'BTCUSDT', timeframe: '15m', evaluation: null })).rejects.toThrow(TypeError);
    await expect(repo.setProvisional({ symbol: 'XRPUSDT', timeframe: '15m', evaluation: buildReversalEvaluation() })).rejects.toMatchObject({ code: 'UNKNOWN_SYMBOL' });
  });
});

describe('repositori Reversal Radar — daftar aktif, riwayat, penutupan', () => {
  async function seeded() {
    const db = openDatabase(':memory:');
    migrate(db, { now: () => new Date(0) });
    const repos = createRepositories(db, { clock: () => NOW });
    const { ids } = await seedReversalCandidates(repos, { withCandles: false });
    return { db, repo: repos.reversal, repos, ids };
  }
  const symbols = (rows) => rows.map((r) => r.symbol);

  it('UNIT-RRP-008 listActive: kandidat terbuka + provisional-only (id null, status dari tahap, RUNNING), urut score DESC; kandidat tertutup & provisional tanpa tahap tidak ikut', async () => {
    const { repo, repos, ids } = await seeded();
    const rows = await repo.listActive();
    expect(rows.map((r) => [r.symbol, r.timeframe, r.stage, r.status, r.score, r.evidenceCount, r.liquidityClass, r.extended, r.provisionalOnly, r.candleStatus])).toEqual([
      ['CCCUSDT', '1h', 'CONFIRMED_BREAKOUT', 'CONFIRMED', 88, 15, 'THIN', true, false, 'CLOSED'],
      ['BBBUSDT', '15m', 'DEVELOPING_REVERSAL', 'DEVELOPING', 70, 11, 'LIQUID', false, false, 'CLOSED'],
      ['AAAUSDT', '5m', 'EARLY_FORMATION', 'NEW', 54, 9, 'LIQUID', false, false, 'CLOSED'],
      ['EEEUSDT', '5m', 'EARLY_FORMATION', 'NEW', 48, 7, 'LIQUID', false, true, 'RUNNING'],
      ['FFFUSDT', '15m', 'EARLY_FORMATION', 'NEW', 23, 4, 'ILLIQUID', false, false, 'RUNNING'],
    ]);
    const ccc = rows[0];
    expect(ccc).toMatchObject({
      id: ids.CCCUSDT, version: 1, setupType: 'STAIRCASE', setupTypes: ['STAIRCASE', 'HIGHER_LOW_BASE'], firstDetectedPrice: 0.42, firstStage: 'DEVELOPING_REVERSAL',
      moveSinceDetectionPct: 0.09, moveSinceDetectionAtr: 2.7, risks: ['LOW_LIQUIDITY', 'EXTENDED'], closeReason: null, closedAt: null, provisional: null,
      nextConfirmation: expect.objectContaining({ kind: 'HOLD_ABOVE_TRIGGER' }), cancelCondition: expect.objectContaining({ level: expect.any(Number) }),
    });
    expect(ccc.scoreComponents.map((c) => [c.id, c.points, c.max])).toEqual([['EXHAUSTION', 19, 25], ['BASE', 25, 25], ['STRUCTURE', 24, 30], ['VOLUME', 10, 10], ['TRIGGER', 10, 10]]);
    expect(ccc.evidence[0]).toEqual({ id: 'LL_SHALLOWER', group: 'EXHAUSTION', label: 'Lower low makin dangkal', detail: expect.any(String), time: expect.any(Number), price: expect.any(Number) });
    expect(ccc.markers.map((m) => m.kind)).toEqual(['BOTTOM', 'HIGHER_LOW', 'DETECTED']);
    expect(Object.keys(ccc.levels).sort()).toEqual(['atr', 'bottom', 'ema25', 'ema7', 'higherLow', 'invalidation', 'lastSwingLow', 'trigger']);
    // Provisional-only: evaluasi candle berjalan tanpa kandidat.
    const eee = rows[3];
    expect(eee).toMatchObject({ id: null, firstDetectedAt: null, firstDetectedPrice: null, stageEnteredAt: null, peakPrice: null, closeReason: null, provisionalOnly: true });
    expect(eee.provisional).toMatchObject({ stage: 'EARLY_FORMATION', score: 48, evidenceCount: 7, candleOpenTime: eee.lastCandleTime });
    expect(eee.risks).toEqual(['PROVISIONAL']);
    // Kandidat terbuka dengan provisional bertahap lebih tinggi: kolom provisional terisi, tahap kandidat tetap.
    const fff = rows[4];
    expect(fff.provisional).toMatchObject({ stage: 'DEVELOPING_REVERSAL', evidenceCount: 5 });
    expect(fff.id).toBe(ids.FFFUSDT);
    expect(symbols(rows)).not.toContain('DDDUSDT');
    // Provisional tanpa tahap pada seri tanpa kandidat tidak ditampilkan sebagai provisional-only.
    await repos.symbols.upsertFromExchange([{ symbol: 'GGGUSDT', baseAsset: 'GGG', quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING', tickSize: '0.1', stepSize: '1', onboardDate: 0 }], NOW);
    await repo.setProvisional({ symbol: 'GGGUSDT', timeframe: '5m', evaluation: buildReversalEvaluation({ timeframe: '5m', stage: null }) });
    expect(symbols(await repo.listActive())).toEqual(['CCCUSDT', 'BBBUSDT', 'AAAUSDT', 'EEEUSDT', 'FFFUSDT']);
    expect(await repo.listOpenSeries()).toEqual([
      { symbol: 'AAAUSDT', timeframe: '5m' }, { symbol: 'BBBUSDT', timeframe: '15m' }, { symbol: 'CCCUSDT', timeframe: '1h' },
      { symbol: 'EEEUSDT', timeframe: '5m' }, { symbol: 'FFFUSDT', timeframe: '15m' },
    ]);
  });

  it('UNIT-RRP-009 listActive: filter timeframe/stage/status/liquidity/minScore/minEvidence/includeExtended/includeProvisional diterapkan SEBELUM limit; filter tidak valid ditolak', async () => {
    const { repo } = await seeded();
    expect(symbols(await repo.listActive({ timeframe: '5m' }))).toEqual(['AAAUSDT', 'EEEUSDT']);
    expect(symbols(await repo.listActive({ timeframe: '1h' }))).toEqual(['CCCUSDT']);
    expect(symbols(await repo.listActive({ stage: 'DEVELOPING_REVERSAL' }))).toEqual(['BBBUSDT']);
    expect(symbols(await repo.listActive({ stage: 'EARLY_FORMATION' }))).toEqual(['AAAUSDT', 'EEEUSDT', 'FFFUSDT']);
    expect(symbols(await repo.listActive({ status: 'NEW' }))).toEqual(['AAAUSDT', 'EEEUSDT', 'FFFUSDT']);
    expect(symbols(await repo.listActive({ status: 'CONFIRMED' }))).toEqual(['CCCUSDT']);
    expect(symbols(await repo.listActive({ liquidity: 'LIQUID' }))).toEqual(['BBBUSDT', 'AAAUSDT', 'EEEUSDT']);
    expect(symbols(await repo.listActive({ liquidity: 'THIN' }))).toEqual(['CCCUSDT', 'BBBUSDT', 'AAAUSDT', 'EEEUSDT']);
    expect(symbols(await repo.listActive({ minScore: 45 }))).toEqual(['CCCUSDT', 'BBBUSDT', 'AAAUSDT', 'EEEUSDT']);
    expect(symbols(await repo.listActive({ minScore: 60, minEvidence: 4 }))).toEqual(['CCCUSDT', 'BBBUSDT']);
    expect(symbols(await repo.listActive({ minEvidence: 8 }))).toEqual(['CCCUSDT', 'BBBUSDT', 'AAAUSDT']);
    expect(symbols(await repo.listActive({ includeExtended: false }))).toEqual(['BBBUSDT', 'AAAUSDT', 'EEEUSDT', 'FFFUSDT']);
    const noProvisional = await repo.listActive({ includeProvisional: false });
    expect(symbols(noProvisional)).toEqual(['CCCUSDT', 'BBBUSDT', 'AAAUSDT', 'FFFUSDT']);
    expect(noProvisional.every((r) => r.provisional === null && r.candleStatus === 'CLOSED')).toBe(true);
    // Limit memotong SETELAH filter & urutan: LIQUID dengan limit 1 = BBB (bukan CCC yang THIN).
    expect(symbols(await repo.listActive({ limit: 2 }))).toEqual(['CCCUSDT', 'BBBUSDT']);
    expect(symbols(await repo.listActive({ liquidity: 'LIQUID', limit: 1 }))).toEqual(['BBBUSDT']);
    expect(symbols(await repo.listActive({ timeframe: '5m', status: 'NEW', minScore: 50 }))).toEqual(['AAAUSDT']);
    expect(symbols(await repo.listActive({ timeframe: '5m', limit: 1 }))).toEqual(['AAAUSDT']);

    await expect(repo.listActive({ timeframe: '4h' })).rejects.toThrow(RangeError);
    await expect(repo.listActive({ stage: 'LATE' })).rejects.toThrow(RangeError);
    await expect(repo.listActive({ status: 'CANCELLED' })).rejects.toThrow(RangeError);
    await expect(repo.listActive({ liquidity: 'ILLIQUID' })).rejects.toThrow(RangeError);
    await expect(repo.listActive({ minScore: 101 })).rejects.toThrow(RangeError);
    await expect(repo.listActive({ minEvidence: -1 })).rejects.toThrow(RangeError);
    await expect(repo.listActive({ includeExtended: 'ya' })).rejects.toThrow(TypeError);
    await expect(repo.listActive({ limit: 0 })).rejects.toThrow(RangeError);
    await expect(repo.listActive({ limit: 501 })).rejects.toThrow(RangeError);
    await expect(repo.listActive({ sort: 'score' })).rejects.toThrow(TypeError);
    await expect(repo.listActive(null)).rejects.toThrow(TypeError);
    expect((await repo.listActive({ limit: 500 })).length).toBe(5);
  });

  it('UNIT-RRP-010 history & getById: kandidat terbuka + tertutup terbaru dulu dengan events (provisional ditandai); filter simbol/timeframe/limit; indeks terurut dipakai (tanpa TEMP B-TREE)', async () => {
    const { db, repo, ids } = await seeded();
    const all = await repo.history();
    expect(all.map((h) => [h.symbol, h.status, h.events.map((e) => `${e.type}${e.provisional ? '*' : ''}`)])).toEqual([
      ['FFFUSDT', 'NEW', ['OPENED', 'PROVISIONAL_STAGE*']],
      ['DDDUSDT', 'CANCELLED', ['OPENED', 'CANCELLED']],
      ['CCCUSDT', 'CONFIRMED', ['OPENED', 'STAGE_UP']],
      ['BBBUSDT', 'DEVELOPING', ['OPENED', 'STAGE_UP']],
      ['AAAUSDT', 'NEW', ['OPENED']],
    ]);
    const ddd = all[1];
    expect(ddd).toMatchObject({ id: ids.DDDUSDT, closeReason: 'CLOSE_BELOW_INVALIDATION', closedAt: expect.any(Number), provisional: null, candleStatus: 'CLOSED', provisionalOnly: false });
    expect(ddd.events[1]).toMatchObject({ type: 'CANCELLED', fromStage: 'EARLY_FORMATION', toStage: 'EARLY_FORMATION', fromStatus: 'NEW', toStatus: 'CANCELLED', provisional: false, detail: expect.objectContaining({ reason: 'CLOSE_BELOW_INVALIDATION' }) });
    const fff = all[0];
    expect(fff.provisional).toMatchObject({ stage: 'DEVELOPING_REVERSAL' });
    expect(fff.events[1]).toMatchObject({ type: 'PROVISIONAL_STAGE', fromStage: 'EARLY_FORMATION', toStage: 'DEVELOPING_REVERSAL', fromStatus: 'NEW', toStatus: 'NEW', provisional: true, detail: expect.objectContaining({ provisional: true }) });
    const times = fff.events.map((e) => e.candleTime);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    // Provisional-only (EEE) tidak punya baris riwayat.
    expect(symbols(all)).not.toContain('EEEUSDT');

    expect(symbols(await repo.history({ symbol: 'DDDUSDT' }))).toEqual(['DDDUSDT']);
    expect(symbols(await repo.history({ timeframe: '15m' }))).toEqual(['FFFUSDT', 'DDDUSDT', 'BBBUSDT']);
    expect(symbols(await repo.history({ symbol: 'BBBUSDT', timeframe: '5m' }))).toEqual([]);
    expect(symbols(await repo.history({ limit: 2 }))).toEqual(['FFFUSDT', 'DDDUSDT']);
    expect(await repo.history({ symbol: 'XRPUSDT' })).toEqual([]);
    await expect(repo.history({ limit: 501 })).rejects.toThrow(RangeError);
    await expect(repo.history({ symbol: 'btc' })).rejects.toThrow(RangeError);
    await expect(repo.history({ timeframe: '4h' })).rejects.toThrow(RangeError);

    const byId = await repo.getById(ids.CCCUSDT);
    expect(byId).toMatchObject({ id: ids.CCCUSDT, symbol: 'CCCUSDT', stage: 'CONFIRMED_BREAKOUT', events: [expect.objectContaining({ type: 'OPENED' }), expect.objectContaining({ type: 'STAGE_UP' })] });
    expect(await repo.getById(9999)).toBeNull();
    await expect(repo.getById(0)).rejects.toThrow(RangeError);
    await expect(repo.getById('1')).rejects.toThrow(RangeError);

    // Rencana query riwayat: indeks terurut, tanpa SCAN penuh + sort sementara.
    const plan = (sql, params) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params).map((r) => r.detail).join(' | ');
    const historyAll = plan(`SELECT c.*, sym.symbol FROM reversal_candidates c INDEXED BY idx_reversal_first_detected
      CROSS JOIN symbols sym ON sym.id = c.symbol_id WHERE (@timeframe IS NULL OR c.timeframe = @timeframe)
      ORDER BY c.first_detected_at DESC, c.id DESC LIMIT @limit`, { timeframe: null, limit: 10 });
    expect(historyAll).toContain('idx_reversal_first_detected');
    expect(historyAll).not.toMatch(/TEMP B-TREE/);
    const bySymbol = plan(`SELECT c.*, sym.symbol FROM reversal_candidates c INDEXED BY idx_reversal_symbol_first
      CROSS JOIN symbols sym ON sym.id = c.symbol_id WHERE c.symbol_id = (SELECT id FROM symbols WHERE symbol = @symbol)
      AND (@timeframe IS NULL OR c.timeframe = @timeframe) ORDER BY c.first_detected_at DESC, c.id DESC LIMIT @limit`, { symbol: 'AAAUSDT', timeframe: null, limit: 10 });
    expect(bySymbol).toContain('idx_reversal_symbol_first');
    expect(bySymbol).not.toMatch(/TEMP B-TREE/);
  });

  it('UNIT-RRP-011 closeOpenForSymbol: semua kandidat terbuka simbol (atau hanya timeframes) → EXPIRED + event (candle_time = candle terakhir dievaluasi, price = close tersimpan atau null); provisional seri dihapus; idempoten; input tidak valid ditolak', async () => {
    const { db, repo, repos, ids } = await seeded();
    const AT = Date.UTC(2027, 0, 4, 12);
    // Kandidat kedua untuk FFFUSDT di timeframe lain + candle tersimpan agar price terisi.
    const extra = opened(30, { timeframe: '1h', lastCandleTime: at(30, 3_600_000), firstDetectedAt: at(31, 3_600_000) - 1, stageEnteredAt: at(31, 3_600_000) - 1, lastEvaluatedAt: at(31, 3_600_000) - 1 });
    extra.event.candleTime = at(30, 3_600_000);
    extra.event.occurredAt = at(31, 3_600_000) - 1;
    const extraId = (await repo.save({ symbol: 'FFFUSDT', timeframe: '1h', snapshot: extra.snapshot, events: [extra.event] })).id;
    const openTime = at(40, 3_600_000);
    await repos.candles.upsertClosed([{
      symbol: 'FFFUSDT', timeframe: '1h', openTime, closeTime: openTime + 3_600_000 - 1, open: 0.09, high: 0.091, low: 0.088, close: 0.0895,
      volume: 1000, quoteVolume: 90, trades: 10, takerBuyVolume: 500, takerBuyQuoteVolume: 45, isClosed: true, source: 'rest',
    }], { now: NOW });
    const fffCursor = await repo.lastEvaluatedCandleTime({ symbol: 'FFFUSDT', timeframe: '15m' });
    expect(count(db, 'reversal_provisional')).toBe(2); // EEE (provisional-only) + FFF 15m

    // Hanya 15m FFFUSDT.
    const partial = await repo.closeOpenForSymbol({ symbol: 'FFFUSDT', timeframes: ['15m', '15m', '5m'], reason: 'MONITORING_STOPPED', at: AT });
    expect(partial).toEqual({ closed: [{ id: ids.FFFUSDT, timeframe: '15m', fromStage: 'EARLY_FORMATION', fromStatus: 'NEW', price: null }] });
    expect(await repo.getOpen({ symbol: 'FFFUSDT', timeframe: '15m' })).toBeNull();
    expect(await repo.getOpen({ symbol: 'FFFUSDT', timeframe: '1h' })).not.toBeNull();
    expect(count(db, 'reversal_provisional')).toBe(1); // provisional FFF 15m dihapus, EEE tetap
    const closedRow = db.prepare('SELECT status, close_reason, closed_at, updated_at, snapshot_json FROM reversal_candidates WHERE id = ?').get(ids.FFFUSDT);
    expect(closedRow).toMatchObject({ status: 'EXPIRED', close_reason: 'MONITORING_STOPPED', closed_at: AT, updated_at: AT });
    expect(JSON.parse(closedRow.snapshot_json)).toMatchObject({ status: 'EXPIRED', closeReason: 'MONITORING_STOPPED' });
    const [fffHistory] = await repo.history({ symbol: 'FFFUSDT', timeframe: '15m' });
    expect(fffHistory.events.at(-1)).toMatchObject({
      type: 'EXPIRED', occurredAt: AT, candleTime: fffCursor, fromStage: 'EARLY_FORMATION', toStage: 'EARLY_FORMATION', fromStatus: 'NEW', toStatus: 'EXPIRED', price: null,
      provisional: false, detail: expect.objectContaining({ reason: 'MONITORING_STOPPED', priceCandleTime: null }),
    });
    // Titik awal replay pipeline tidak bergeser.
    expect(await repo.lastEvaluatedCandleTime({ symbol: 'FFFUSDT', timeframe: '15m' })).toBe(fffCursor);

    // Semua timeframe (null): sisa 1h FFFUSDT, price dari candle tersimpan terakhir.
    expect(await repo.closeOpenForSymbol({ symbol: 'FFFUSDT', reason: 'SYMBOL_DELISTED', at: AT + 1 })).toEqual({
      closed: [{ id: extraId, timeframe: '1h', fromStage: 'EARLY_FORMATION', fromStatus: 'NEW', price: 0.0895 }],
    });
    expect((await repo.getById(extraId)).events.at(-1).detail).toMatchObject({ reason: 'SYMBOL_DELISTED', priceCandleTime: openTime });
    expect(await repo.closeOpenForSymbol({ symbol: 'FFFUSDT', reason: 'SYMBOL_DELISTED', at: AT + 2 })).toEqual({ closed: [] });
    // Seri provisional-only yang berhenti dipantau: tidak ada kandidat, tetapi baris provisional dibersihkan.
    expect(await repo.closeOpenForSymbol({ symbol: 'EEEUSDT', reason: 'MONITORING_STOPPED', at: AT })).toEqual({ closed: [] });
    expect(count(db, 'reversal_provisional')).toBe(0);
    expect(symbols(await repo.listActive())).toEqual(['CCCUSDT', 'BBBUSDT', 'AAAUSDT']);
    expect(await repo.listOpenSeries()).toEqual([{ symbol: 'AAAUSDT', timeframe: '5m' }, { symbol: 'BBBUSDT', timeframe: '15m' }, { symbol: 'CCCUSDT', timeframe: '1h' }]);
    expect(await repo.closeOpenForSymbol({ symbol: 'XRPUSDT', reason: 'MONITORING_STOPPED', at: AT })).toEqual({ closed: [] });

    const ok = { symbol: 'AAAUSDT', reason: 'MONITORING_STOPPED', at: AT };
    await expect(repo.closeOpenForSymbol({ ...ok, reason: 'NO_PROGRESS' })).rejects.toThrow(RangeError);
    await expect(repo.closeOpenForSymbol({ ...ok, at: 1.5 })).rejects.toThrow(TypeError);
    await expect(repo.closeOpenForSymbol({ ...ok, timeframes: ['4h'] })).rejects.toThrow(RangeError);
    await expect(repo.closeOpenForSymbol({ ...ok, timeframes: '5m' })).rejects.toThrow(TypeError);
    await expect(repo.closeOpenForSymbol({ ...ok, symbol: 'aaa' })).rejects.toThrow(RangeError);
    expect(await repo.getOpen({ symbol: 'AAAUSDT', timeframe: '5m' })).not.toBeNull();
  });

  it('EDGE-RRP-001 closeOpenForSymbol gagal di tengah (INSERT event ditolak) → di-rollback seluruhnya', async () => {
    const { db, repo, repos } = await seeded();
    const before = db.prepare('SELECT id, status, closed_at FROM reversal_candidates ORDER BY id').all();
    db.exec(`CREATE TRIGGER fail_second BEFORE INSERT ON reversal_events WHEN NEW.type = 'EXPIRED' AND NEW.candidate_id = 2
      BEGIN SELECT RAISE(ABORT, 'gagal sintetis'); END`);
    // BBBUSDT (id 2) → gagal; kandidat lain dari simbol yang sama tidak ada, jadi uji dengan dua kandidat: tambah 1h untuk BBB.
    const extra = opened(30, { timeframe: '1h', lastCandleTime: at(30, 3_600_000), firstDetectedAt: at(31, 3_600_000) - 1, stageEnteredAt: at(31, 3_600_000) - 1, lastEvaluatedAt: at(31, 3_600_000) - 1 });
    extra.event.candleTime = at(30, 3_600_000);
    extra.event.occurredAt = at(31, 3_600_000) - 1;
    await repo.save({ symbol: 'BBBUSDT', timeframe: '1h', snapshot: extra.snapshot, events: [extra.event] });
    await expect(repo.closeOpenForSymbol({ symbol: 'BBBUSDT', reason: 'SYMBOL_DELISTED', at: NOW })).rejects.toThrow(/gagal sintetis/);
    expect(db.prepare('SELECT id, status, closed_at FROM reversal_candidates WHERE id <= 5 ORDER BY id').all()).toEqual(before);
    expect(await repo.getOpen({ symbol: 'BBBUSDT', timeframe: '1h' })).not.toBeNull();
    expect(db.prepare("SELECT COUNT(*) n FROM reversal_events WHERE type = 'EXPIRED'").get().n).toBe(0);
    expect(repos.reversal).toBe(repo);
  });

  it('UNIT-RRP-012 matriks seed sintetis konsisten dengan kontrak §4/§5 (skor = jumlah komponen, status mengikuti tahap)', async () => {
    const { repo } = await seeded();
    for (const row of await repo.listActive({ includeProvisional: false })) {
      expect(row.score).toBe(row.scoreComponents.reduce((s, c) => s + c.points, 0));
      expect(row.status).toBe({ EARLY_FORMATION: 'NEW', DEVELOPING_REVERSAL: 'DEVELOPING', CONFIRMED_BREAKOUT: 'CONFIRMED' }[row.stage]);
      expect(row.evidenceCount).toBe(row.evidence.length);
    }
    expect(REVERSAL_SEED_ROWS.map((r) => r.symbol)).toEqual(['AAAUSDT', 'BBBUSDT', 'CCCUSDT', 'DDDUSDT', 'EEEUSDT', 'FFFUSDT']);
  });
});
