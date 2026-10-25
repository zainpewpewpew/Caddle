import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_SETTINGS } from '../../backend/settings/scannerSettings.js';
import { createTestApp, login } from '../helpers/testApp.js';

describe('validasi input', () => {
  let ctx;
  let auth;
  beforeEach(async () => {
    ctx = await createTestApp({ env: { LOGIN_RATE_LIMIT_MAX: '100' } });
    auth = await login(ctx.app);
  });
  afterEach(async () => { await ctx.app.close(); });

  const post = (payload, headers = {}) => ctx.app.inject({
    method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json', ...headers }, payload,
  });
  const put = (payload, a = auth) => ctx.app.inject({
    method: 'PUT', url: '/api/settings/scanner', headers: { cookie: a.cookie, 'x-csrf-token': a.csrfToken }, payload,
  });
  const settingsWith = (mutate) => {
    const s = structuredClone(DEFAULT_SCANNER_SETTINGS);
    mutate(s);
    return { version: 0, settings: s };
  };

  it('NEG-IN-001 JSON rusak → 400 tanpa stack trace', async () => {
    const res = await post('{"username": "mary",');
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toMatch(/at .*\.js|stack/i);
  });

  it('NEG-IN-002 payload > 64KB → 413', async () => {
    const res = await post(JSON.stringify({ username: 'mary', password: 'x'.repeat(70 * 1024) }));
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe('PAYLOAD_TOO_LARGE');
  });

  it.each([
    ['field tambahan', { username: 'mary', password: 'x', admin: true }],
    ['username bukan string', { username: ['mary'], password: 'x' }],
    ['username karakter ilegal', { username: "mary' OR '1'='1", password: 'x' }],
    ['tanpa password', { username: 'mary' }],
    ['password terlalu panjang', { username: 'mary', password: 'x'.repeat(513) }],
    ['body array', [1, 2]],
  ])('NEG-IN-003 login dengan %s → 400', async (_label, payload) => {
    expect((await post(JSON.stringify(payload))).statusCode).toBe(400);
  });

  it('NEG-IN-004 prototype pollution via __proto__ / constructor ditolak', async () => {
    expect((await post('{"username":"mary","password":"x","__proto__":{"isAdmin":true}}')).statusCode).toBe(400);
    expect((await post('{"username":"mary","password":"x","constructor":{"prototype":{"isAdmin":true}}}')).statusCode).toBe(400);
    expect({}.isAdmin).toBeUndefined();
  });

  it('NEG-IN-005 SQL injection pada password diperlakukan sebagai teks biasa', async () => {
    const res = await post(JSON.stringify({ username: 'mary', password: "' OR 1=1; DROP TABLE users; --" }));
    expect(res.statusCode).toBe(401);
    expect(ctx.db.prepare('SELECT COUNT(*) n FROM users').get().n).toBe(2);
  });

  it.each([
    ['XSS pada simbol manual', (s) => { s.symbols.manual = ['<img src=x onerror=alert(1)>']; }],
    ['simbol non-USDT', (s) => { s.symbols.manual = ['BTCBUSD']; }],
    ['simbol tanpa base asset', (s) => { s.symbols.manual = ['USDT']; }],
    ['timeframe tidak didukung', (s) => { s.timeframes = ['4h']; }],
    ['timeframe duplikat', (s) => { s.timeframes = ['5m', '5m']; }],
    ['timeframe kosong', (s) => { s.timeframes = []; }],
    ['angka sebagai string (tanpa coercion)', (s) => { s.symbols.maxAuto = '40'; }],
    ['maxAuto pecahan', (s) => { s.symbols.maxAuto = 40.5; }],
    ['spread negatif', (s) => { s.liquidity.maxSpreadBps = -1; }],
    ['volume di atas batas', (s) => { s.liquidity.minQuoteVolume24h = 1e13; }],
    ['field tak dikenal', (s) => { s.liquidity.extra = 1; }],
    ['mode manual tanpa simbol', (s) => { s.symbols.mode = 'manual'; }],
    ['tahap alert tidak dikenal', (s) => { s.alerts.minStage = 'MOON'; }],
    ['simbol > 100', (s) => { s.symbols.manual = Array.from({ length: 101 }, (_, i) => `C${i}USDT`); }],
  ])('NEG-IN-006 pengaturan dengan %s → 400 dan tidak tersimpan', async (_label, mutate) => {
    const res = await put(settingsWith(mutate));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('VALIDATION_ERROR');
    expect(ctx.db.prepare('SELECT COUNT(*) n FROM settings').get().n).toBe(0);
  });

  it('NEG-IN-007 version negatif / bukan integer → 400', async () => {
    expect((await put({ version: -1, settings: DEFAULT_SCANNER_SETTINGS })).statusCode).toBe(400);
    expect((await put({ version: '0', settings: DEFAULT_SCANNER_SETTINGS })).statusCode).toBe(400);
  });

  it.each(['0', '-1', 'abc', '1e3', '99999999999999999999'])('NEG-IN-008 id sesi tidak valid "%s" → 400', async (id) => {
    const res = await ctx.app.inject({ method: 'DELETE', url: `/api/auth/sessions/${id}`, headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrfToken } });
    expect(res.statusCode).toBe(400);
  });
});

describe('otorisasi', () => {
  let ctx;
  beforeEach(async () => { ctx = await createTestApp(); });
  afterEach(async () => { await ctx.app.close(); });

  it('NEG-AZ-001 analyst tidak dapat mengubah pengaturan (403) dan tidak ada perubahan', async () => {
    const analyst = await login(ctx.app, { username: 'rekan', password: 'another-strong-pass-42' });
    const res = await ctx.app.inject({
      method: 'PUT', url: '/api/settings/scanner', headers: { cookie: analyst.cookie, 'x-csrf-token': analyst.csrfToken },
      payload: { version: 0, settings: DEFAULT_SCANNER_SETTINGS },
    });
    expect(res.statusCode).toBe(403);
    expect(ctx.db.prepare('SELECT COUNT(*) n FROM settings').get().n).toBe(0);
  });

  it('NEG-AZ-002 pengguna tidak dapat mencabut sesi milik pengguna lain (404, sesi tetap aktif)', async () => {
    const admin = await login(ctx.app);
    const analyst = await login(ctx.app, { username: 'rekan', password: 'another-strong-pass-42' });
    const adminSessionId = ctx.db.prepare('SELECT id FROM sessions WHERE user_id = 1').get().id;
    const res = await ctx.app.inject({ method: 'DELETE', url: `/api/auth/sessions/${adminSessionId}`, headers: { cookie: analyst.cookie, 'x-csrf-token': analyst.csrfToken } });
    expect(res.statusCode).toBe(404);
    expect((await ctx.app.inject({ url: '/api/auth/session', headers: { cookie: admin.cookie } })).statusCode).toBe(200);
  });

  it('NEG-AZ-003 daftar sesi hanya memuat sesi milik sendiri', async () => {
    await login(ctx.app);
    const analyst = await login(ctx.app, { username: 'rekan', password: 'another-strong-pass-42' });
    const { sessions } = (await ctx.app.inject({ url: '/api/auth/sessions', headers: { cookie: analyst.cookie } })).json();
    expect(sessions).toHaveLength(1);
  });
});
