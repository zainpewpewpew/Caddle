// Logika login yang terpisah dari HTTP handler.
// Pesan kegagalan sengaja generik agar tidak membocorkan keberadaan akun atau status penguncian.

export const LOGIN_FAILED = 'LOGIN_FAILED';

/**
 * @param {{ users: any, audit: any, hasher: any, sessionService: any,
 *           config: { lockThreshold: number, lockMs: number }, clock: () => number }} deps
 */
export function createAuthService({ users, audit, hasher, sessionService, config, clock }) {
  const fail = async (reason, { userId = null, ip }) => {
    await audit.record({ occurredAt: clock(), userId, action: 'auth.login', outcome: 'failure', ip, detail: { reason } });
    return { ok: false, error: LOGIN_FAILED };
  };

  return {
    async login({ username, password, ip, userAgent }) {
      const user = await users.findByUsernameForAuth(username);
      if (!user) {
        await hasher.verifyDummy(password);
        return fail('unknown_user', { ip });
      }

      const now = clock();
      if (user.is_disabled) {
        await hasher.verifyDummy(password);
        return fail('disabled', { userId: user.id, ip });
      }
      const lockOptions = { now, lockAfter: config.lockThreshold, lockUntil: now + config.lockMs };
      const attempt = await users.reserveLoginAttempt(user.id, lockOptions);
      if (!attempt.allowed) {
        if (attempt.lockedNow) {
          await audit.record({ occurredAt: now, userId: user.id, action: 'auth.account_locked', outcome: 'success', ip });
        }
        await hasher.verifyDummy(password);
        return fail('locked', { userId: user.id, ip });
      }

      const valid = await hasher.verify(user.password_hash, password);
      if (!valid) {
        const { locked } = await users.recordFailedLogin(user.id, { ...lockOptions, count: attempt.count });
        if (locked) {
          await audit.record({ occurredAt: now, userId: user.id, action: 'auth.account_locked', outcome: 'success', ip });
        }
        return fail('bad_password', { userId: user.id, ip });
      }

      if (hasher.needsRehash(user.password_hash)) {
        await users.updatePassword(user.id, { passwordHash: await hasher.hash(password), now });
      }
      await users.recordSuccessfulLogin(user.id, { now });
      const session = await sessionService.create(user.id, { ip, userAgent });
      await audit.record({ occurredAt: now, userId: user.id, action: 'auth.login', outcome: 'success', ip });

      return {
        ok: true,
        session,
        user: { id: user.id, username: user.username, role: user.role },
      };
    },

    async logout({ session, user, ip }) {
      await sessionService.revoke(session.id, user.id, 'logout');
      await audit.record({ occurredAt: clock(), userId: user.id, action: 'auth.logout', outcome: 'success', ip });
    },
  };
}
