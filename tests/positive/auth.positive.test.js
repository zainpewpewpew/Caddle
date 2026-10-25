import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, ANALYST, TEST_ORIGIN, createTestApp, login } from '../helpers/testApp.js';

describe('alur positif autentikasi', () => {
  let ctx;
  beforeEach(async () => { ctx = await createTestApp(); });
  afterEach(async () => { await ctx.app.close(); });

  it('POS-AUTH-001 login valid → 200, cookie HttpOnly + SameSite=Strict, token CSRF, tanpa hash di respons', async () => {
    const { res } = await login(ctx.app);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user).toEqual({ id: 1, username: 'mary', role: 'admin' });
    expect(body.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.body).not.toContain('argon2');
    const cookie = res.cookies[0];
    expect(cookie.name).toBe('lr_session');
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Strict');
    expect(cookie.path).toBe('/');
  });

  it('POS-AUTH-002 cookie __Host- dan Secure saat origin HTTPS', async () => {
    const https = await createTestApp({ env: { APP_ORIGIN: 'https://radar.local' } });
    const res = await https.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://radar.local' }, payload: { username: ADMIN.username, password: ADMIN.password } });
    expect(res.cookies[0].name).toBe('__Host-lr_session');
    expect(res.cookies[0].secure).toBe(true);
    await https.app.close();
  });

  it('POS-AUTH-003 sesi aktif dapat dibaca', async () => {
    const { cookie, csrfToken } = await login(ctx.app);
    const res = await ctx.app.inject({ url: '/api/auth/session', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().csrfToken).toBe(csrfToken);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('POS-AUTH-004 logout mencabut sesi di server', async () => {
    const { cookie, csrfToken } = await login(ctx.app);
    const out = await ctx.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, 'x-csrf-token': csrfToken, origin: TEST_ORIGIN } });
    expect(out.statusCode).toBe(204);
    expect(out.cookies[0].value).toBe('');
    const after = await ctx.app.inject({ url: '/api/auth/session', headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it('POS-AUTH-005 dashboard disajikan hanya untuk sesi valid; login page mengarahkan ke dashboard', async () => {
    const { cookie } = await login(ctx.app);
    const page = await ctx.app.inject({ url: '/', headers: { cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('AlphaLens');
    const loginPage = await ctx.app.inject({ url: '/login.html', headers: { cookie } });
    expect(loginPage.statusCode).toBe(302);
    expect(loginPage.headers.location).toBe('/');
  });

  it('POS-AUTH-006 daftar sesi & cabut sesi lain', async () => {
    const first = await login(ctx.app);
    const second = await login(ctx.app);
    const list = await ctx.app.inject({ url: '/api/auth/sessions', headers: { cookie: second.cookie } });
    const sessions = list.json().sessions;
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((s) => s.current)).toHaveLength(1);

    const revoke = await ctx.app.inject({
      method: 'POST', url: '/api/auth/sessions/revoke-others',
      headers: { cookie: second.cookie, 'x-csrf-token': second.csrfToken },
    });
    expect(revoke.json().revoked).toBe(1);
    expect((await ctx.app.inject({ url: '/api/auth/session', headers: { cookie: first.cookie } })).statusCode).toBe(401);
    expect((await ctx.app.inject({ url: '/api/auth/session', headers: { cookie: second.cookie } })).statusCode).toBe(200);
  });

  it('POS-AUTH-007 cabut satu sesi tertentu milik sendiri', async () => {
    const first = await login(ctx.app);
    const second = await login(ctx.app);
    const { sessions } = (await ctx.app.inject({ url: '/api/auth/sessions', headers: { cookie: second.cookie } })).json();
    const other = sessions.find((s) => !s.current);
    const res = await ctx.app.inject({ method: 'DELETE', url: `/api/auth/sessions/${other.id}`, headers: { cookie: second.cookie, 'x-csrf-token': second.csrfToken } });
    expect(res.statusCode).toBe(204);
    expect((await ctx.app.inject({ url: '/api/auth/session', headers: { cookie: first.cookie } })).statusCode).toBe(401);
  });

  it('POS-AUTH-008 login & logout tercatat di audit log', async () => {
    const { cookie, csrfToken } = await login(ctx.app);
    await ctx.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, 'x-csrf-token': csrfToken } });
    const actions = (await ctx.app.services.repos.audit.recent()).map((r) => `${r.action}:${r.outcome}`);
    expect(actions).toEqual(expect.arrayContaining(['auth.login:success', 'auth.logout:success']));
  });

  it('POS-AUTH-009 dua pengguna dapat login bersamaan secara independen', async () => {
    const a = await login(ctx.app, ADMIN);
    const b = await login(ctx.app, ANALYST);
    const ra = (await ctx.app.inject({ url: '/api/auth/session', headers: { cookie: a.cookie } })).json();
    const rb = (await ctx.app.inject({ url: '/api/auth/session', headers: { cookie: b.cookie } })).json();
    expect(ra.user.username).toBe('mary');
    expect(rb.user.username).toBe('rekan');
  });
});
