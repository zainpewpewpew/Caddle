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
    // Reservasi percobaan: dihitung SEBELUM verifikasi kata sandi; ditolak bila terkunci atau
    // percobaan yang sedang berjalan sudah mencapai ambang.
    reserve: db.prepare(`UPDATE users SET failed_login_count = failed_login_count + 1, updated_at = @now
                         WHERE id = @id AND (locked_until IS NULL OR locked_until <= @now) AND failed_login_count < @lockAfter
                         RETURNING failed_login_count`),
    lockState: db.prepare('SELECT locked_until FROM users WHERE id = ?'),
    lock: db.prepare(`UPDATE users SET locked_until = MAX(COALESCE(locked_until, 0), @lockUntil), failed_login_count = 0,
                        updated_at = @now WHERE id = @id`),
    // Kunci yang masih aktif (dipasang percobaan paralel yang gagal) tidak dihapus oleh login sukses.
    succeeded: db.prepare(`UPDATE users SET failed_login_count = 0,
                             locked_until = CASE WHEN locked_until > @now THEN locked_until ELSE NULL END,
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
     * Memesan satu percobaan login secara atomik sebelum verifikasi Argon2 (yang async).
     * Tanpa ini, tebakan paralel semuanya membaca baris lama dan lolos dari penguncian.
     * @returns {{ allowed: boolean, count?: number, lockedNow?: boolean }}
     *   allowed false → akun terkunci (lockedNow true bila kunci baru dipasang karena ambang habis).
     */
    async reserveLoginAttempt(id, { now, lockAfter, lockUntil }) {
      return db.transaction(() => {
        const row = stmt.reserve.get({ id, now, lockAfter });
        if (row) return { allowed: true, count: row.failed_login_count };
        const state = stmt.lockState.get(id);
        if (state && state.locked_until !== null && state.locked_until > now) return { allowed: false, lockedNow: false };
        // Ambang habis oleh percobaan yang masih berjalan → kunci sekarang.
        stmt.lock.run({ id, lockUntil, now });
        return { allowed: false, lockedNow: true };
      })();
    },
    /**
     * Menyelesaikan percobaan yang gagal (sudah dihitung saat reservasi). Mengunci akun bila
     * percobaan ini mencapai ambang.
     */
    async recordFailedLogin(id, { count, now, lockAfter, lockUntil }) {
      if (count >= lockAfter) {
        stmt.lock.run({ id, lockUntil, now });
        return { count, locked: true };
      }
      return { count, locked: false };
    },
    async recordSuccessfulLogin(id, { now }) {
      stmt.succeeded.run({ id, now });
    },
    async updatePassword(id, { passwordHash, now }) {
      stmt.setPassword.run({ id, passwordHash, now });
    },
  };
}
