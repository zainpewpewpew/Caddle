// Repositori pengguna. Semua akses SQL ke tabel `users` terpusat di sini, kecuali pemeriksaan hash di
// sessionRepository.createIfPasswordUnchanged (harus satu transaksi dengan insert sesi).
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
    setPasswordIfUnchanged: db.prepare(`UPDATE users SET password_hash = @passwordHash, updated_at = @now
                                        WHERE id = @id AND password_hash = @expectedHash`),
  };

  // Hitung + insert dalam SATU transaksi. Dijalankan dengan BEGIN IMMEDIATE: kunci tulis diambil sebelum
  // COUNT, sehingga proses lain (CLI user:create, instance server kedua) tidak dapat menyisip di antaranya.
  const insertWithinLimit = db.transaction(({ username, passwordHash, role, now, maxUsers, requireEmpty }) => {
    const { n } = stmt.count.get();
    if (requireEmpty && n > 0) return { created: false, reason: 'not_empty' };
    if (n >= maxUsers) return { created: false, reason: 'limit_reached' };
    return { created: true, id: Number(stmt.insert.run({ username, passwordHash, role, now }).lastInsertRowid) };
  });

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
    /** Insert tanpa batas — hanya untuk fixture tes; pembuatan pengguna memakai createWithLimit. */
    async create({ username, passwordHash, role, now }) {
      const info = stmt.insert.run({ username, passwordHash, role, now });
      return Number(info.lastInsertRowid);
    },
    /**
     * Membuat pengguna hanya bila jumlah pengguna < maxUsers (dengan requireEmpty: hanya bila tabel kosong),
     * atomik terhadap pembuat lain. Hash dibuat pemanggil SEBELUMNYA agar transaksi tidak menunggu Argon2.
     * Username yang sudah ada (UNIQUE, tanpa beda huruf) → username_taken, bukan SqliteError.
     * PostgreSQL: kunci tabel/advisory lock di transaksi yang sama sebelum COUNT.
     * @returns {Promise<{ created: true, id: number }
     *   | { created: false, reason: 'not_empty' | 'limit_reached' | 'username_taken' }>}
     */
    async createWithLimit({ username, passwordHash, role, now, maxUsers, requireEmpty = false }) {
      try {
        return insertWithinLimit.immediate({ username, passwordHash, role, now, maxUsers, requireEmpty });
      } catch (err) {
        if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE') return { created: false, reason: 'username_taken' };
        throw err;
      }
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
    /**
     * Compare-and-swap: mengganti hash hanya bila yang tersimpan masih `expectedHash`. Dipakai rehash saat
     * login agar tidak menimpa hash baru yang ditulis `npm run user:password` selama Argon2 berjalan.
     * @returns {Promise<boolean>} true bila hash diganti
     */
    async updatePasswordIfUnchanged(id, { expectedHash, passwordHash, now }) {
      return stmt.setPasswordIfUnchanged.run({ id, expectedHash, passwordHash, now }).changes === 1;
    },
  };
}
