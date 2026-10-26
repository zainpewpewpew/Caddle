import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../backend/database/connection.js';
import { MigrationError, migrate } from '../../backend/database/migrate.js';

const REQUIRED_TABLES = ['users', 'sessions', 'symbols', 'candles', 'features', 'pattern_definitions', 'pattern_examples',
  'signals', 'signal_events', 'backtest_runs', 'backtest_results', 'settings', 'audit_logs'];

const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);

function tempMigrations(files) {
  const dir = mkdtempSync(join(tmpdir(), 'lr-mig-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

describe('migrasi database', () => {
  it('UNIT-DB-001 seluruh entitas wajib dibuat', () => {
    const db = openDatabase(':memory:');
    const result = migrate(db);
    expect(result.applied).toEqual([1, 2, 3, 4, 5]);
    expect(tables(db)).toEqual(expect.arrayContaining(REQUIRED_TABLES));
  });

  it('UNIT-DB-002 migrasi idempoten — run kedua tidak menerapkan apa pun', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    expect(migrate(db).applied).toEqual([]);
  });

  it('UNIT-DB-003 foreign key aktif', () => {
    const db = openDatabase(':memory:');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('NEG-DB-001 checksum migrasi yang berubah terdeteksi', () => {
    const db = openDatabase(':memory:');
    migrate(db, { dir: tempMigrations({ '001_a.sql': 'CREATE TABLE a (x INTEGER);' }) });
    expect(() => migrate(db, { dir: tempMigrations({ '001_a.sql': 'CREATE TABLE a (x TEXT);' }) })).toThrow(/Checksum/);
  });

  it('NEG-DB-002 migrasi di database yang tidak dikenal kode ditolak', () => {
    const db = openDatabase(':memory:');
    migrate(db, { dir: tempMigrations({ '001_a.sql': 'SELECT 1;', '002_b.sql': 'SELECT 1;' }) });
    expect(() => migrate(db, { dir: tempMigrations({ '001_a.sql': 'SELECT 1;' }) })).toThrow(/tidak dikenal/);
  });

  it('NEG-DB-003 nomor migrasi tidak berurutan / nama tidak valid ditolak', () => {
    const db = openDatabase(':memory:');
    expect(() => migrate(db, { dir: tempMigrations({ '001_a.sql': '', '003_c.sql': '' }) })).toThrow(MigrationError);
    expect(() => migrate(db, { dir: tempMigrations({ '1_a.sql': '' }) })).toThrow(/Nama file/);
  });

  it('EDGE-DB-001 migrasi gagal di tengah di-rollback seluruhnya', () => {
    const db = openDatabase(':memory:');
    const dir = tempMigrations({ '001_a.sql': 'CREATE TABLE ok (x INTEGER); CREATE TABLE broken (;' });
    expect(() => migrate(db, { dir })).toThrow();
    expect(tables(db)).not.toContain('ok');
    expect(db.prepare('SELECT COUNT(*) n FROM schema_migrations').get().n).toBe(0);
  });

  describe('constraint skema', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    db.prepare(`INSERT INTO symbols (symbol, base_asset, quote_asset, contract_type, status, first_seen_at, last_seen_at)
                VALUES ('BTCUSDT', 'BTC', 'USDT', 'PERPETUAL', 'TRADING', 0, 0)`).run();
    const candle = (overrides = {}) => ({
      symbol_id: 1, timeframe: '5m', open_time: 0, close_time: 299_999, open: 10, high: 11, low: 9, close: 10.5,
      volume: 1, quote_volume: 10, trade_count: 1, is_closed: 1, source: 'rest', ingested_at: 0, ...overrides,
    });
    const insertCandle = db.prepare(`INSERT INTO candles (symbol_id, timeframe, open_time, close_time, open, high, low,
      close, volume, quote_volume, trade_count, is_closed, source, ingested_at)
      VALUES (@symbol_id, @timeframe, @open_time, @close_time, @open, @high, @low,
      @close, @volume, @quote_volume, @trade_count, @is_closed, @source, @ingested_at)`);

    it('UNIT-DB-004 identitas candle unik: symbol + timeframe + open_time', () => {
      insertCandle.run(candle());
      expect(() => insertCandle.run(candle())).toThrow(/UNIQUE|PRIMARY KEY/);
      expect(() => insertCandle.run(candle({ timeframe: '15m', close_time: 899_999 }))).not.toThrow();
    });

    it.each([
      ['high < low', { open_time: 1, high: 8 }],
      ['timeframe tidak didukung', { open_time: 2, timeframe: '4h' }],
      ['volume negatif', { open_time: 3, volume: -1 }],
      ['close_time <= open_time', { open_time: 4, close_time: 4 }],
      ['harga nol', { open_time: 5, open: 0 }],
      ['tipe data salah (STRICT)', { open_time: 6, open: 'abc' }],
    ])('NEG-DB-004 candle tidak valid ditolak: %s', (_label, overrides) => {
      expect(() => insertCandle.run(candle(overrides))).toThrow();
    });

    it('NEG-DB-005 password_hash wajib argon2id', () => {
      expect(() => db.prepare("INSERT INTO users (username, password_hash, created_at, updated_at) VALUES ('abc', 'plaintext', 0, 0)").run()).toThrow(/CHECK/);
    });

    it('NEG-DB-006 settings wajib JSON valid', () => {
      expect(() => db.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES ('x', '{bad', 0)").run()).toThrow(/CHECK/);
    });
  });
});
