import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../../backend/database/connection.js';
import { migrate } from '../../../backend/database/migrate.js';
import { createIngestionStateRepository } from '../../../backend/database/repositories/ingestionStateRepository.js';

const T0 = Date.UTC(2026, 0, 1);
const MIN = 60_000;

describe('repositori status ingesti', () => {
  let db;
  let repo;

  beforeEach(() => {
    db = openDatabase(':memory:');
    migrate(db);
    repo = createIngestionStateRepository(db);
  });

  it('UNIT-IST-001 status kosong sebelum worker pernah berjalan', async () => {
    expect(await repo.getStatus()).toEqual({ lastRun: null, recentErrors: [], heartbeat: null });
  });

  it('UNIT-IST-002 recordRun: run terakhir (berdasarkan startedAt) beserta durasinya', async () => {
    const id1 = await repo.recordRun({ startedAt: T0, finishedAt: T0 + 2_000, symbols: 40, candles: 120, errors: 0 });
    const id2 = await repo.recordRun({ startedAt: T0 + 5 * MIN, finishedAt: T0 + 5 * MIN + 3_500, symbols: 40, candles: 118, errors: 2 });
    await repo.recordRun({ startedAt: T0 + MIN, finishedAt: T0 + MIN + 100, symbols: 1, candles: 1, errors: 0 }); // tercatat terlambat
    expect(id2).toBeGreaterThan(id1);
    expect((await repo.getStatus()).lastRun).toEqual({
      id: id2, startedAt: T0 + 5 * MIN, finishedAt: T0 + 5 * MIN + 3_500, durationMs: 3_500, symbols: 40, candles: 118, errors: 2,
    });
  });

  it('UNIT-IST-003 recordRun menerima array (dihitung panjangnya)', async () => {
    await repo.recordRun({ startedAt: T0, finishedAt: T0, symbols: ['BTCUSDT', 'ETHUSDT'], candles: [{}, {}, {}], errors: [] });
    expect((await repo.getStatus()).lastRun).toMatchObject({ symbols: 2, candles: 3, errors: 0, durationMs: 0 });
  });

  it('UNIT-IST-004 recordError: ≤ 20 error terbaru, terbaru lebih dulu', async () => {
    for (let i = 0; i < 25; i += 1) await repo.recordError({ at: T0 + i * MIN, source: 'rest', message: `HTTP 503 #${i}` });
    const { recentErrors } = await repo.getStatus();
    expect(recentErrors).toHaveLength(20);
    expect(recentErrors[0]).toEqual({ id: expect.any(Number), at: T0 + 24 * MIN, source: 'rest', message: 'HTTP 503 #24' });
    expect(recentErrors[19].message).toBe('HTTP 503 #5');
  });

  it('UNIT-IST-005 heartbeat singleton: panggilan berikutnya menimpa, state JSON utuh', async () => {
    await repo.heartbeat({ at: T0, state: { state: 'starting' } });
    await repo.heartbeat({ at: T0 + MIN, state: { state: 'running', queue: 3, candleLagMs: 1250, symbols: ['BTCUSDT'] } });
    expect((await repo.getStatus()).heartbeat).toEqual({
      at: T0 + MIN, state: { state: 'running', queue: 3, candleLagMs: 1250, symbols: ['BTCUSDT'] },
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM worker_heartbeat').get().n).toBe(1);
  });

  it('EDGE-IST-001 pesan error panjang dipotong 500 karakter; Error & non-string dikonversi', async () => {
    await repo.recordError({ at: T0, source: 'ws', message: 'x'.repeat(5_000) });
    await repo.recordError({ at: T0 + 1, source: 'ws', message: new Error('koneksi terputus') });
    await repo.recordError({ at: T0 + 2, source: 'worker', message: { code: -1003 } });
    const [obj, err, long] = (await repo.getStatus()).recentErrors;
    expect(long.message).toHaveLength(500);
    expect(err.message).toBe('koneksi terputus');
    expect(obj.message).toBe('{"code":-1003}');
  });

  it('EDGE-IST-002 retensi: hanya N error terbaru yang disimpan', async () => {
    const small = createIngestionStateRepository(db, { errorRetention: 5 });
    for (let i = 0; i < 12; i += 1) await small.recordError({ at: T0 + i, source: 'rest', message: `e${i}` });
    expect(db.prepare('SELECT COUNT(*) AS n FROM ingestion_errors').get().n).toBe(5);
    expect((await small.getStatus()).recentErrors.map((e) => e.message)).toEqual(['e11', 'e10', 'e9', 'e8', 'e7']);
  });

  it('EDGE-IST-003 heartbeat tanpa state disimpan sebagai objek kosong', async () => {
    await repo.heartbeat({ at: T0 });
    expect((await repo.getStatus()).heartbeat).toEqual({ at: T0, state: {} });
  });

  it.each([
    ['finishedAt < startedAt', { startedAt: T0, finishedAt: T0 - 1, symbols: 0, candles: 0, errors: 0 }],
    ['startedAt bukan angka', { startedAt: 'kemarin', finishedAt: T0, symbols: 0, candles: 0, errors: 0 }],
    ['jumlah negatif', { startedAt: T0, finishedAt: T0, symbols: -1, candles: 0, errors: 0 }],
    ['jumlah pecahan', { startedAt: T0, finishedAt: T0, symbols: 1, candles: 2.5, errors: 0 }],
    ['jumlah hilang', { startedAt: T0, finishedAt: T0, symbols: 1, candles: 2 }],
  ])('NEG-IST-001 recordRun tidak valid ditolak: %s', async (_label, run) => {
    await expect(repo.recordRun(run)).rejects.toThrow(TypeError);
    expect((await repo.getStatus()).lastRun).toBeNull();
  });

  it.each([
    ['at bukan angka', { at: null, source: 'rest', message: 'x' }],
    ['source kosong', { at: T0, source: '', message: 'x' }],
    ['source bukan teks', { at: T0, source: 42, message: 'x' }],
  ])('NEG-IST-002 recordError tidak valid ditolak: %s', async (_label, entry) => {
    await expect(repo.recordError(entry)).rejects.toThrow(TypeError);
  });

  it('NEG-IST-003 heartbeat tidak valid ditolak (at bukan angka, state tidak dapat di-serialisasi)', async () => {
    await expect(repo.heartbeat({ at: undefined, state: {} })).rejects.toThrow(TypeError);
    const cyclic = {};
    cyclic.self = cyclic;
    await expect(repo.heartbeat({ at: T0, state: cyclic })).rejects.toThrow(TypeError);
    expect((await repo.getStatus()).heartbeat).toBeNull();
  });

  it('NEG-IST-004 constraint skema 003: singleton heartbeat, panjang pesan, JSON valid, STRICT', () => {
    expect(() => db.prepare("INSERT INTO worker_heartbeat (id, at, state_json) VALUES (2, 0, '{}')").run()).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO worker_heartbeat (id, at, state_json) VALUES (1, 0, '{rusak')").run()).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO ingestion_errors (at, source, message) VALUES (0, 'rest', ?)").run('x'.repeat(501))).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO ingestion_errors (at, source, message) VALUES ('kemarin', 'rest', 'x')").run()).toThrow(/cannot store/);
    expect(() => db.prepare('INSERT INTO ingestion_runs (started_at, finished_at, symbols, candles, errors) VALUES (10, 5, 0, 0, 0)').run()).toThrow(/CHECK/);
  });

  it('NEG-IST-005 opsi retensi tidak valid → RangeError', () => {
    expect(() => createIngestionStateRepository(db, { errorRetention: 0 })).toThrow(RangeError);
  });

  it('EDGE-IST-004 status bertahan setelah restart (file database sementara)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lr-ingest-'));
    const path = join(dir, 'lr.db');
    try {
      const db1 = openDatabase(path);
      migrate(db1);
      const r1 = createIngestionStateRepository(db1);
      await r1.recordRun({ startedAt: T0, finishedAt: T0 + 1_000, symbols: 3, candles: 9, errors: 1 });
      await r1.recordError({ at: T0 + 500, source: 'rest', message: 'HTTP 429' });
      await r1.heartbeat({ at: T0 + 1_000, state: { state: 'running' } });
      db1.close();

      const db2 = openDatabase(path);
      expect(migrate(db2).applied).toEqual([]);
      const status = await createIngestionStateRepository(db2).getStatus();
      expect(status.lastRun).toMatchObject({ symbols: 3, candles: 9, errors: 1 });
      expect(status.recentErrors.map((e) => e.message)).toEqual(['HTTP 429']);
      expect(status.heartbeat).toEqual({ at: T0 + 1_000, state: { state: 'running' } });
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
