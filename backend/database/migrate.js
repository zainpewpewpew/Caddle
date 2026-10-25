import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
const FILE_PATTERN = /^(\d{3})_([a-z0-9_]+)\.sql$/;

export class MigrationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MigrationError';
  }
}

/** Membaca daftar migrasi dari direktori, terurut berdasarkan versi. */
export function loadMigrations(dir = MIGRATIONS_DIR) {
  const migrations = readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .map((file) => {
      const match = FILE_PATTERN.exec(file);
      if (!match) throw new MigrationError(`Nama file migrasi tidak valid: ${file}`);
      const sql = readFileSync(join(dir, file), 'utf8');
      return {
        version: Number(match[1]),
        name: match[2],
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    })
    .sort((a, b) => a.version - b.version);

  migrations.forEach((m, index) => {
    if (m.version !== index + 1) throw new MigrationError(`Versi migrasi harus berurutan mulai 001 (ditemukan ${m.version})`);
  });
  return migrations;
}

/**
 * Menjalankan migrasi yang belum diterapkan. Setiap migrasi berjalan di dalam transaksi.
 * Checksum migrasi yang sudah diterapkan diverifikasi untuk mendeteksi perubahan diam-diam.
 * @param {import('better-sqlite3').Database} db
 * @returns {{ applied: number[], current: number }}
 */
export function migrate(db, { dir = MIGRATIONS_DIR, now = () => new Date() } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    checksum   TEXT    NOT NULL,
    applied_at TEXT    NOT NULL
  ) STRICT`);

  const migrations = loadMigrations(dir);
  const appliedRows = db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all();
  const known = new Map(migrations.map((m) => [m.version, m]));

  for (const row of appliedRows) {
    const m = known.get(row.version);
    if (!m) throw new MigrationError(`Database memiliki migrasi ${row.version} yang tidak dikenal kode ini`);
    if (m.checksum !== row.checksum) throw new MigrationError(`Checksum migrasi ${row.version} berubah setelah diterapkan`);
  }

  const appliedVersions = new Set(appliedRows.map((r) => r.version));
  const insert = db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)');
  const applied = [];

  for (const m of migrations) {
    if (appliedVersions.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      insert.run(m.version, m.name, m.checksum, now().toISOString());
    })();
    applied.push(m.version);
  }

  return { applied, current: migrations.length ? migrations[migrations.length - 1].version : 0 };
}
