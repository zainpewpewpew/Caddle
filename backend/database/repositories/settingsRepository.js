// Repositori pengaturan berversi (optimistic concurrency).

/** @param {import('better-sqlite3').Database} db */
export function createSettingsRepository(db) {
  const stmt = {
    get: db.prepare('SELECT key, value_json, version, updated_by, updated_at FROM settings WHERE key = ?'),
    insert: db.prepare(`INSERT INTO settings (key, value_json, version, updated_by, updated_at)
                        VALUES (@key, @valueJson, 1, @userId, @now) ON CONFLICT(key) DO NOTHING`),
    update: db.prepare(`UPDATE settings SET value_json = @valueJson, version = version + 1, updated_by = @userId, updated_at = @now
                        WHERE key = @key AND version = @expectedVersion`),
  };

  const toRecord = (row) => row && ({
    key: row.key,
    value: JSON.parse(row.value_json),
    version: row.version,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  });

  return {
    async get(key) {
      return toRecord(stmt.get.get(key)) ?? null;
    },
    /**
     * Menyimpan nilai bila versi saat ini sama dengan `expectedVersion`
     * (0 berarti belum ada baris). Mengembalikan record baru atau null bila terjadi konflik.
     */
    async save(key, value, { expectedVersion, userId, now }) {
      const valueJson = JSON.stringify(value);
      return db.transaction(() => {
        const changes = expectedVersion === 0
          ? stmt.insert.run({ key, valueJson, userId, now }).changes
          : stmt.update.run({ key, valueJson, userId, now, expectedVersion }).changes;
        return changes === 1 ? toRecord(stmt.get.get(key)) : null;
      })();
    },
  };
}
