import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, TEST_ORIGIN, createTestApp, login } from '../helpers/testApp.js';

const PROTECTED = [
  ['GET', '/api/auth/session'], ['GET', '/api/auth/sessions'], ['POST', '/api/auth/logout'],
  ['DELETE', '/api/auth/sessions/1'], ['POST', '/api/auth/sessions/revoke-others'],
  ['GET', '/api/settings/scanner'], ['PUT', '/api/settings/scanner'],
  ['GET', '/api/system/status'], ['GET', '/api/overview'], ['GET', '/api/does-not-exist'],
];

describe('alur negatif autentikasi', () => {
  let ctx;
  beforeEach(async () => { ctx = await createTestApp({ env: { LOGIN_RATE_LIMIT_MAX: '50', ACCOUNT_LOCK_THRESHOLD: '5' } }); });
  afterEach(async () => { await ctx.app.close(); });

  it('NEG-AUTH-001 kata sandi salah → 401 generik tanpa cookie', async () => {
    const { res } = await login(ctx.app, { username: 'mary', password: 'wrong-password-123' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'LOGIN_FAILED', message: 'Username atau kata sandi salah' });
    expect(res.cookies).toHaveLength(0);
  });

  it('NEG-AUTH-002 username tidak dikenal → respons identik dengan kata sandi salah (anti enumerasi)', async () => {
    const unknown = (await login(ctx.app, { username: 'ghost', password: 'wrong-password-123' })).res;
    const wrong = (await login(ctx.app, { username: 'mary', password: 'wrong-password-123' })).res;
    expect(unknown.statusCode).toBe(wrong.statusCode);
    expect(unknown.body).toBe(wrong.body);
  });

  it.each(PROTECTED)('NEG-AUTH-003 %s %s tanpa sesi → 401', async (method, url) => {
    const res = await ctx.app.inject({ method, url, payload: method === 'GET' ? undefined : {} });
    expect(res.statusCode).toBe(401);
  });

  it.each([
    ['token acak berformat benar', 'lr_session=' + 'A'.repeat(43)],
    ['token berformat salah', 'lr_session=../../etc/passwd'],
    ['cookie kosong', 'lr_session='],
  ])('NEG-AUTH-004 cookie palsu (%s) → 401', async (_label, cookie) => {
    expect((await ctx.app.inject({ url: '/api/auth/session', headers: { cookie } })).statusCode).toBe(401);
  });

  it('NEG-AUTH-005 dashboard tanpa sesi diarahkan ke login; /index.html tidak dapat diakses langsung', async () => {
    const res = await ctx.app.inject({ url: '/' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login.html');
    expect((await ctx.app.inject({ url: '/index.html' })).statusCode).toBe(404);
  });

  it('NEG-AUTH-006 sesi idle kedaluwarsa → 401', async () => {
    const { cookie } = await login(ctx.app);
    ctx.clock.advance(ctx.config.session.idleMs + 1);
    expect((await ctx.app.inject({ url: '/api/auth/session', headers: { cookie } })).statusCode).toBe(401);
  });

  it('NEG-AUTH-007 akun terkunci setelah N kegagalan — kata sandi benar pun ditolak sampai masa kunci habis', async () => {
    for (let i = 0; i < 5; i += 1) await login(ctx.app, { username: 'mary', password: `wrong-password-${i}` });
    const locked = await login(ctx.app);
    expect(locked.res.statusCode).toBe(401);
    expect(locked.res.json().error).toBe('LOGIN_FAILED');
    ctx.clock.advance(ctx.config.login.lockMs + 1);
    expect((await login(ctx.app)).res.statusCode).toBe(200);
    const audit = await ctx.app.services.repos.audit.recent(20);
    expect(audit.some((a) => a.action === 'auth.account_locked')).toBe(true);
    expect(audit.some((a) => a.detail?.reason === 'locked')).toBe(true);
  });

  it('NEG-AUTH-008 akun dinonaktifkan tidak dapat login', async () => {
    ctx.db.prepare("UPDATE users SET is_disabled = 1 WHERE username = 'mary'").run();
    expect((await login(ctx.app)).res.statusCode).toBe(401);
  });

  it('NEG-AUTH-009 audit kegagalan tidak menyimpan kata sandi yang dicoba', async () => {
    await login(ctx.app, { username: 'mary', password: 'secret-attempt-XYZ' });
    const rows = JSON.stringify(ctx.db.prepare('SELECT * FROM audit_logs').all());
    expect(rows).not.toContain('secret-attempt-XYZ');
  });
});

describe('rate limit login', () => {
  it('NEG-RL-001 percobaan ke-6 dalam jendela waktu → 429', async () => {
    const ctx = await createTestApp();
    const codes = [];
    for (let i = 0; i < 6; i += 1) codes.push((await login(ctx.app, { username: 'mary', password: `bad-password-${i}` })).res.statusCode);
    expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
    const blocked = await login(ctx.app);
    expect(blocked.res.statusCode).toBe(429);
    expect(blocked.res.json().error).toBe('RATE_LIMITED');
    await ctx.app.close();
  });
});

describe('CSRF & origin', () => {
  let ctx;
  let auth;
  beforeEach(async () => {
    ctx = await createTestApp();
    auth = await login(ctx.app);
  });
  afterEach(async () => { await ctx.app.close(); });

  it('NEG-CSRF-001 request terautentikasi tanpa X-CSRF-Token → 403', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: auth.cookie } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('CSRF_INVALID');
    expect((await ctx.app.inject({ url: '/api/auth/session', headers: { cookie: auth.cookie } })).statusCode).toBe(200);
  });

  it('NEG-CSRF-002 token CSRF salah atau milik sesi lain → 403', async () => {
    const other = await login(ctx.app, { username: 'rekan', password: 'another-strong-pass-42' });
    for (const token of ['x'.repeat(43), other.csrfToken]) {
      const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: auth.cookie, 'x-csrf-token': token } });
      expect(res.statusCode).toBe(403);
    }
  });

  it('NEG-CSRF-003 Origin asing ditolak, termasuk pada login', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://evil.example' }, payload: { username: ADMIN.username, password: ADMIN.password } });
    expect(res.statusCode).toBe(403);
    const logout = await ctx.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrfToken, origin: 'null' } });
    expect(logout.statusCode).toBe(403);
  });

  it('NEG-CSRF-004 Sec-Fetch-Site: cross-site ditolak', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'sec-fetch-site': 'cross-site' }, payload: { username: ADMIN.username, password: ADMIN.password } });
    expect(res.statusCode).toBe(403);
  });

  it.each([
    ['text/plain', 'username=mary'],
    ['application/x-www-form-urlencoded', 'username=mary&password=x'],
    ['multipart/form-data; boundary=x', '--x--'],
  ])('NEG-CSRF-005 content-type "simple request" %s ditolak (415)', async (type, payload) => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': type, origin: TEST_ORIGIN }, payload });
    expect(res.statusCode).toBe(415);
  });
});
