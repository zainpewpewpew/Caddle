import { generateToken, hashToken, isWellFormedToken } from './tokens.js';

// Pembaruan last_seen dibatasi agar tidak menulis ke database di setiap request.
const TOUCH_INTERVAL_MS = 60_000;
const USER_AGENT_MAX = 256;

/**
 * Layanan sesi server-side.
 * @param {{ sessions: any, users: any, config: { idleMs: number, absoluteMs: number }, clock: () => number }} deps
 */
export function createSessionService({ sessions, users, config, clock }) {
  return {
    /**
     * Membuat sesi baru. Dengan `passwordHash` (alur login: hash yang baru saja diverifikasi), sesi hanya
     * dibuat bila hash tersimpan masih sama — diperiksa atomik bersama insert — dan null bila kata sandi
     * sudah diganti sementara itu.
     * @returns {Promise<{ id: number, token: string, csrfToken: string, expiresAt: number, idleExpiresAt: number } | null>}
     */
    async create(userId, { ip, userAgent, passwordHash } = {}) {
      const now = clock();
      const token = generateToken();
      const csrfToken = generateToken();
      const expiresAt = now + config.absoluteMs;
      const idleExpiresAt = Math.min(now + config.idleMs, expiresAt);
      const row = {
        tokenHash: hashToken(token),
        userId,
        csrfToken,
        ip: ip ?? null,
        userAgent: userAgent ? String(userAgent).slice(0, USER_AGENT_MAX) : null,
        now,
        idleExpiresAt,
        expiresAt,
      };
      const id = passwordHash === undefined
        ? await sessions.create(row)
        : await sessions.createIfPasswordUnchanged(row, { passwordHash });
      if (id === null) return null;
      return { id, token, csrfToken, expiresAt, idleExpiresAt };
    },

    /**
     * Memvalidasi token cookie. Mengembalikan { session, user } atau null.
     * Sesi dianggap tidak valid bila dicabut, kedaluwarsa (absolut/idle), atau user dinonaktifkan.
     * Tidak memperpanjang idle timeout — hanya `touch()` (dipanggil untuk aktivitas API terautentikasi)
     * yang melakukannya, agar health check, aset statis, dan halaman publik tidak menjaga sesi tetap hidup.
     */
    async resolve(token) {
      if (!isWellFormedToken(token)) return null;
      const session = await sessions.findByTokenHash(hashToken(token));
      if (!session) return null;
      const now = clock();
      if (session.revoked_at !== null) return null;
      if (session.expires_at <= now || session.idle_expires_at <= now) return null;

      const user = await users.findById(session.user_id);
      if (!user || user.is_disabled) return null;
      return { session, user };
    },

    /** Memperpanjang idle timeout (sliding), paling sering sekali per TOUCH_INTERVAL_MS. */
    async touch(auth) {
      const { session } = auth;
      const now = clock();
      if (now - session.last_seen_at < TOUCH_INTERVAL_MS) return;
      const idleExpiresAt = Math.min(now + config.idleMs, session.expires_at);
      await sessions.touch(session.id, { now, idleExpiresAt });
      session.last_seen_at = now;
      session.idle_expires_at = idleExpiresAt;
    },

    async revoke(sessionId, userId, reason) {
      return sessions.revoke(sessionId, { userId, now: clock(), reason });
    },

    async revokeOthers(userId, keepId) {
      return sessions.revokeOthers(userId, { keepId, now: clock(), reason: 'revoked_by_user' });
    },

    async listActive(userId) {
      return sessions.listActive(userId, { now: clock() });
    },

    async purgeExpired() {
      return sessions.purgeExpired({ before: clock() });
    },
  };
}
