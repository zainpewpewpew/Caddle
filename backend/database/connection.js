import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

/**
 * Membuka koneksi SQLite dengan pengaturan aman.
 * `:memory:` dipakai untuk pengujian.
 * @param {string} databasePath
 */
export function openDatabase(databasePath) {
  if (databasePath !== ':memory:') {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  }
  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  return db;
}
