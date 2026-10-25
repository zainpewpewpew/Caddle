import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../backend/app/config.js';
import { ensureDefaultUser } from '../../backend/users/defaultUser.js';
import { changePassword } from '../../backend/users/userAdmin.js';
import { createTestApp, login } from '../helpers/testApp.js';

const DEFAULT_LOGIN = { username: 'admin', password: 'admin123@' };

describe('akun default lewat API login asli', () => {
  let ctx;
  let deps;
  beforeEach(async () => {
    ctx = await createTestApp({ users: [], env: { LOGIN_RATE_LIMIT_MAX: '50' } });
    const { repos, hasher } = ctx.app.services;
    deps = { repos, hasher };
  });
  afterEach(async () => { await ctx.app.close(); });

  const seed = () => ensureDefaultUser({
    users: deps.repos.users, audit: deps.repos.audit, hasher: deps.hasher, maxUsers: ctx.config.maxUsers,
    clock: ctx.clock, config: loadConfig({}), log: { info: vi.fn(), warn: vi.fn() },
  });

  it('SEC-DEF-004 buildApp sendiri (harness tes/E2E) tidak pernah membuat akun default', async () => {
    expect(ctx.config.defaultUser).toBe(false);
    expect(ctx.db.prepare('SELECT COUNT(*) n FROM users').get().n).toBe(0);
    expect((await login(ctx.app, DEFAULT_LOGIN)).res.statusCode).toBe(401);
  });

  it('SEC-DEF-005 akun default dapat login sebagai admin, lalu ganti kata sandi mencabut sesinya dan kata sandi lama ditolak', async () => {
    expect((await seed()).created).toBe(true);
    const first = await login(ctx.app, DEFAULT_LOGIN);
    expect(first.res.statusCode).toBe(200);
    expect(first.res.json().user).toMatchObject({ username: 'admin', role: 'admin' });
    expect((await ctx.app.inject({ url: '/api/auth/session', headers: { cookie: first.cookie } })).statusCode).toBe(200);

    const { repos, hasher } = deps;
    const result = await changePassword({ users: repos.users, sessions: repos.sessions, audit: repos.audit, hasher, clock: ctx.clock },
      { username: 'admin', password: 'kata-sandi-baru-yang-kuat' });
    expect(result.revokedSessions).toBe(1);

    expect((await ctx.app.inject({ url: '/api/auth/session', headers: { cookie: first.cookie } })).statusCode).toBe(401);
    const old = await login(ctx.app, DEFAULT_LOGIN);
    expect(old.res.statusCode).toBe(401);
    expect(old.res.json().error).toBe('LOGIN_FAILED');
    expect((await login(ctx.app, { username: 'admin', password: 'kata-sandi-baru-yang-kuat' })).res.statusCode).toBe(200);

    // Restart berikutnya tidak mengembalikan kata sandi default.
    expect(await seed()).toEqual({ created: false, reason: 'users_exist' });
    expect((await login(ctx.app, DEFAULT_LOGIN)).res.statusCode).toBe(401);
  });
});
