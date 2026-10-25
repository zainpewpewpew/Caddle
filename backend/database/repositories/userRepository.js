// Repositori pengguna. Semua akses SQL ke tabel `users` terpusat di sini.
// Method dibuat async agar kontraknya tetap sama saat migrasi ke PostgreSQL.

/** @param {import('better-sqlite3').Database} db */
export function createUserRepository(db) {
  const stmt = {
    count: db.prepare('SELECT COUNT(*) AS n FROM users'),
    // Kolom ditulis eksplisit: password_hash & totp_secret tidak pernah ikut kecuali untuk autentikasi.
    byId: db.prepare(`SELECT id, username, role, is_disabled, failed_login_count, locked_until, last_login_at, created_at, updated_at
                      FROM users WHERE id = ?`),
    byUsernameWithHash: db.prepare(`SELECT id, username, role, is_disabled, failed_login_count, locked_until, last_login_at, created_at, updated_at, password_hash
                                    FROM users WHERE username = ?`),
    insert: db.prepare(`INSERT INTO users (username, password_hash, role, created_at, updated_at)
                        VALUES (@username, @passwordHash, @role, @now, @now)`),
    failed: db.prepare(`UPDATE users SET failed_login_count = failed_login_count + 1, updated_at = @now
                        WHERE id = @id RETURNING failed_login_count`),
    lock: db.prepare('UPDATE users SET locked_until = @lockUntil, failed_login_count = 0 WHERE id = @id'),
    succeeded: db.prepare(`UPDATE users SET failed_login_count = 0, locked_until = NULL,
                             last_login_at = @now, updated_at = @now WHERE id = @id`),
    setPassword: db.prepare('UPDATE users SET password_hash = @passwordHash, updated_at = @now WHERE id = @id'),
  };

  return {
    async count() {
      return stmt.count.get().n;
    },
    async findById(id) {
      return stmt.byId.get(id) ?? null;
    },
    /** Mengembalikan baris termasuk password_hash — hanya untuk alur autentikasi. */
    async findByUsernameForAuth(username) {
      return stmt.byUsernameWithHash.get(username) ?? null;
    },
    async create({ username, passwordHash, role, now }) {
      const info = stmt.insert.run({ username, passwordHash, role, now });
      return Number(info.lastInsertRowid);
    },
    /**
     * Menaikkan penghitung gagal login. `lockAfter`/`lockUntil` menentukan penguncian
     * secara atomik di dalam satu transaksi agar aman dari race condition.
     */
    async recordFailedLogin(id, { now, lockAfter, lockUntil }) {
      return db.transaction(() => {
        const { failed_login_count: count } = stmt.failed.get({ id, now });
        if (count >= lockAfter) {
          stmt.lock.run({ id, lockUntil });
          return { count, locked: true };
        }
        return { count, locked: false };
      })();
    },
    async recordSuccessfulLogin(id, { now }) {
      stmt.succeeded.run({ id, now });
    },
    async updatePassword(id, { passwordHash, now }) {
      stmt.setPassword.run({ id, passwordHash, now });
    },
  };
}
