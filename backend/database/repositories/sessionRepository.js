// Repositori sesi server-side. Token mentah tidak pernah disimpan — hanya hash SHA-256.

/** @param {import('better-sqlite3').Database} db */
export function createSessionRepository(db) {
  const stmt = {
    insert: db.prepare(`INSERT INTO sessions
      (token_hash, user_id, csrf_token, ip_address, user_agent, created_at, last_seen_at, idle_expires_at, expires_at)
      VALUES (@tokenHash, @userId, @csrfToken, @ip, @userAgent, @now, @now, @idleExpiresAt, @expiresAt)`),
    byHash: db.prepare('SELECT * FROM sessions WHERE token_hash = ?'),
    touch: db.prepare('UPDATE sessions SET last_seen_at = @now, idle_expires_at = @idleExpiresAt WHERE id = @id AND revoked_at IS NULL'),
    revoke: db.prepare(`UPDATE sessions SET revoked_at = @now, revoke_reason = @reason
                        WHERE id = @id AND user_id = @userId AND revoked_at IS NULL`),
    revokeOthers: db.prepare(`UPDATE sessions SET revoked_at = @now, revoke_reason = @reason
                              WHERE user_id = @userId AND id != @keepId AND revoked_at IS NULL`),
    revokeAll: db.prepare(`UPDATE sessions SET revoked_at = @now, revoke_reason = @reason
                           WHERE user_id = @userId AND revoked_at IS NULL`),
    listActive: db.prepare(`SELECT id, ip_address, user_agent, created_at, last_seen_at, expires_at FROM sessions
                            WHERE user_id = @userId AND revoked_at IS NULL AND expires_at > @now AND idle_expires_at > @now
                            ORDER BY last_seen_at DESC`),
    purge: db.prepare('DELETE FROM sessions WHERE expires_at <= @before OR (revoked_at IS NOT NULL AND revoked_at <= @before)'),
  };

  return {
    async create(row) {
      const info = stmt.insert.run(row);
      return Number(info.lastInsertRowid);
    },
    async findByTokenHash(tokenHash) {
      return stmt.byHash.get(tokenHash) ?? null;
    },
    async touch(id, { now, idleExpiresAt }) {
      stmt.touch.run({ id, now, idleExpiresAt });
    },
    /** Mencabut sesi milik `userId`. Mengembalikan false bila sesi tidak ada/bukan miliknya. */
    async revoke(id, { userId, now, reason }) {
      return stmt.revoke.run({ id, userId, now, reason }).changes === 1;
    },
    async revokeOthers(userId, { keepId, now, reason }) {
      return stmt.revokeOthers.run({ userId, keepId, now, reason }).changes;
    },
    async revokeAllForUser(userId, { now, reason }) {
      return stmt.revokeAll.run({ userId, now, reason }).changes;
    },
    async listActive(userId, { now }) {
      return stmt.listActive.all({ userId, now });
    },
    async purgeExpired({ before }) {
      return stmt.purge.run({ before }).changes;
    },
  };
}
