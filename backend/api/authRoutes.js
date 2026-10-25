import { PASSWORD_MAX_LENGTH } from '../auth/password.js';

const loginBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['username', 'password'],
  properties: {
    username: { type: 'string', minLength: 3, maxLength: 32, pattern: '^[A-Za-z0-9_.-]+$' },
    password: { type: 'string', minLength: 1, maxLength: PASSWORD_MAX_LENGTH * 4 },
  },
};

const sessionIdParams = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' } },
};

const publicUser = (user) => ({ id: user.id, username: user.username, role: user.role });

export async function authRoutes(app, { authService, sessionService, audit, config, cookieName, clock }) {
  const cookieOptions = (expiresAt) => ({
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict',
    path: '/',
    expires: new Date(expiresAt),
  });

  app.post('/api/auth/login', {
    config: {
      public: true,
      rateLimit: { max: config.login.rateLimitMax, timeWindow: config.login.rateLimitWindowMs },
    },
    schema: { body: loginBodySchema },
  }, async (request, reply) => {
    const result = await authService.login({
      username: request.body.username,
      password: request.body.password,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
    if (!result.ok) {
      return reply.code(401).send({ error: 'LOGIN_FAILED', message: 'Username atau kata sandi salah' });
    }
    // Sesi lama pada browser yang sama dicabut (mencegah session fixation).
    if (request.auth) await sessionService.revoke(request.auth.session.id, request.auth.user.id, 'replaced');
    reply.setCookie(cookieName, result.session.token, cookieOptions(result.session.expiresAt));
    return { user: result.user, csrfToken: result.session.csrfToken, expiresAt: result.session.expiresAt };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    await authService.logout({ ...request.auth, ip: request.ip });
    reply.clearCookie(cookieName, { path: '/', secure: config.cookieSecure, httpOnly: true, sameSite: 'strict' });
    return reply.code(204).send();
  });

  app.get('/api/auth/session', async (request) => {
    const { user, session } = request.auth;
    return {
      user: publicUser(user),
      csrfToken: session.csrf_token,
      expiresAt: session.expires_at,
      idleExpiresAt: session.idle_expires_at,
    };
  });

  app.get('/api/auth/sessions', async (request) => {
    const { user, session } = request.auth;
    const rows = await sessionService.listActive(user.id);
    return {
      sessions: rows.map((row) => ({
        id: row.id,
        current: row.id === session.id,
        ipAddress: row.ip_address,
        userAgent: row.user_agent,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        expiresAt: row.expires_at,
      })),
    };
  });

  app.delete('/api/auth/sessions/:id', { schema: { params: sessionIdParams } }, async (request, reply) => {
    const { user, session } = request.auth;
    const id = Number(request.params.id);
    const revoked = await sessionService.revoke(id, user.id, 'revoked_by_user');
    if (!revoked) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Sesi tidak ditemukan' });
    await audit.record({ occurredAt: clock(), userId: user.id, action: 'auth.session_revoked', outcome: 'success', ip: request.ip, detail: { sessionId: id } });
    if (id === session.id) reply.clearCookie(cookieName, { path: '/', secure: config.cookieSecure, httpOnly: true, sameSite: 'strict' });
    return reply.code(204).send();
  });

  app.post('/api/auth/sessions/revoke-others', async (request) => {
    const { user, session } = request.auth;
    const count = await sessionService.revokeOthers(user.id, session.id);
    await audit.record({ occurredAt: clock(), userId: user.id, action: 'auth.sessions_revoked', outcome: 'success', ip: request.ip, detail: { count } });
    return { revoked: count };
  });
}
