import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, login } from '../helpers/testApp.js';

describe('header keamanan & permukaan serangan statis', () => {
  let ctx;
  let auth;
  beforeAll(async () => {
    ctx = await createTestApp();
    auth = await login(ctx.app);
  });
  afterAll(async () => { await ctx.app.close(); });

  it('SEC-HDR-001 CSP ketat tanpa unsafe-inline/unsafe-eval', async () => {
    const res = await ctx.app.inject({ url: '/login.html' });
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
  });

  it('SEC-HDR-002 header pelindung standar', async () => {
    const res = await ctx.app.inject({ url: '/api/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(res.headers['permissions-policy']).toContain('camera=()');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('SEC-HDR-003 HSTS hanya aktif di produksi', async () => {
    expect((await ctx.app.inject({ url: '/api/health' })).headers['strict-transport-security']).toBeUndefined();
    const prod = await createTestApp({ env: { NODE_ENV: 'production', APP_ORIGIN: 'https://radar.local', DATABASE_PATH: ':memory:' }, users: [] });
    const hsts = (await prod.app.inject({ url: '/api/health' })).headers['strict-transport-security'];
    expect(hsts).toMatch(/max-age=31536000/);
    await prod.app.close();
  });

  it('SEC-HDR-004 respons API tidak di-cache', async () => {
    const res = await ctx.app.inject({ url: '/api/auth/session', headers: { cookie: auth.cookie } });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('SEC-CORS-001 preflight lintas origin tidak diberi izin CORS', async () => {
    const res = await ctx.app.inject({ method: 'OPTIONS', url: '/api/auth/login', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it.each([
    '/../package.json', '/%2e%2e/package.json', '/css/..%2f..%2fpackage.json', '/..%5c..%5cpackage.json',
    '/.env', '/.git/config', '/js/../../backend/app/config.js', '/index.html',
  ])('SEC-PATH-001 path traversal / file tersembunyi %s tidak bocor', async (url) => {
    const res = await ctx.app.inject({ url });
    expect([400, 403, 404]).toContain(res.statusCode);
    expect(res.body).not.toContain('"dependencies"');
    expect(res.body).not.toContain('loadConfig');
  });

  it('SEC-ERR-001 respons error tidak membocorkan stack trace atau path internal', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json' }, payload: '{bad' });
    expect(res.body).not.toMatch(/node_modules|\/home\/|at [A-Za-z]+ \(/);
  });

  it('SEC-ERR-002 rute API tak dikenal (dengan sesi) → 404 JSON generik', async () => {
    const res = await ctx.app.inject({ url: '/api/admin/secret', headers: { cookie: auth.cookie } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'NOT_FOUND', message: 'Tidak ditemukan' });
  });

  it('SEC-RL-001 rate limit global aktif pada API', async () => {
    const res = await ctx.app.inject({ url: '/api/health' });
    expect(res.headers['x-ratelimit-limit']).toBe('300');
  });
});

describe('rate limit aset statis', () => {
  it('SEC-RL-002 aset statis tidak dihitung rate limit API (mencegah JS login gagal dimuat)', async () => {
    const ctx = await createTestApp({ users: [] });
    const res = await ctx.app.inject({ url: '/css/tokens.css' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    await ctx.app.close();
  });

  it('SEC-UI-001 form login memakai POST dan tombol nonaktif sampai JS termuat (kredensial tidak pernah masuk URL)', async () => {
    const ctx = await createTestApp({ users: [] });
    const html = (await ctx.app.inject({ url: '/login.html' })).body;
    expect(html).toMatch(/<form id="login-form" method="post"/);
    expect(html).toMatch(/id="login-submit" disabled/);
    await ctx.app.close();
  });
});
