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
    async create(userId, { ip, userAgent }) {
      const now = clock();
      const token = generateToken();
      const csrfToken = generateToken();
      const expiresAt = now + config.absoluteMs;
      const idleExpiresAt = Math.min(now + config.idleMs, expiresAt);
      const id = await sessions.create({
        tokenHash: hashToken(token),
        userId,
        csrfToken,
        ip: ip ?? null,
        userAgent: userAgent ? String(userAgent).slice(0, USER_AGENT_MAX) : null,
        now,
        idleExpiresAt,
        expiresAt,
      });
      return { id, token, csrfToken, expiresAt, idleExpiresAt };
    },

    /**
     * Memvalidasi token cookie. Mengembalikan { session, user } atau null.
     * Sesi dianggap tidak valid bila dicabut, kedaluwarsa (absolut/idle), atau user dinonaktifkan.
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

      if (now - session.last_seen_at >= TOUCH_INTERVAL_MS) {
        const idleExpiresAt = Math.min(now + config.idleMs, session.expires_at);
        await sessions.touch(session.id, { now, idleExpiresAt });
        session.last_seen_at = now;
        session.idle_expires_at = idleExpiresAt;
      }
      return { session, user };
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
