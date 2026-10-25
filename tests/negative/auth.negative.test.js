import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPasswordHasher } from '../../backend/auth/password.js';
import { changePassword } from '../../backend/users/userAdmin.js';
import { gateHasher } from '../helpers/gatedHasher.js';
import { ADMIN, TEST_HASHER_OPTIONS, TEST_ORIGIN, createTestApp, login } from '../helpers/testApp.js';

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

describe('login yang sedang berjalan vs ganti kata sandi dari proses lain', () => {
  const NEW_PASSWORD = 'kata-sandi-baru-yang-kuat';
  // `npm run user:password` berjalan di proses lain dengan hasher sendiri (tidak ikut ditahan gerbang).
  const cliHasher = createPasswordHasher(TEST_HASHER_OPTIONS);
  let ctx;
  let gate;

  const changeViaCli = () => {
    const { repos } = ctx.app.services;
    return changePassword({ users: repos.users, sessions: repos.sessions, audit: repos.audit, hasher: cliHasher, clock: ctx.clock },
      { username: 'mary', password: NEW_PASSWORD });
  };
  const hashOfMary = () => ctx.db.prepare("SELECT password_hash FROM users WHERE username = 'mary'").get().password_hash;
  const activeSessionsOfMary = () => ctx.db.prepare(`SELECT COUNT(*) n FROM sessions s JOIN users u ON u.id = s.user_id
                                                     WHERE u.username = 'mary' AND s.revoked_at IS NULL`).get().n;

  beforeEach(async () => {
    ctx = await createTestApp({ env: { LOGIN_RATE_LIMIT_MAX: '50' } });
    gate = gateHasher(ctx.app.services.hasher);
  });
  afterEach(async () => { await ctx.app.close(); });

  it('NEG-AUTH-010 kata sandi diganti selama verifikasi Argon2 login → login gagal generik, tanpa cookie & tanpa sesi', async () => {
    const verifying = gate.hold('verify');
    const pending = login(ctx.app); // kata sandi lama yang (masih) benar
    await verifying.arrived(); // hash lama sudah dibaca & cocok; sesi belum dibuat
    // Belum ada sesi yang dapat dicabut — inilah jendela yang dulu meloloskan sesi baru.
    expect((await changeViaCli()).revokedSessions).toBe(0);
    verifying.release();

    const { res, cookie } = await pending;
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'LOGIN_FAILED', message: 'Username atau kata sandi salah' });
    expect(cookie).toBeUndefined();
    expect(activeSessionsOfMary()).toBe(0);

    const audit = await ctx.app.services.repos.audit.recent(10);
    expect(audit.find((e) => e.action === 'auth.login')).toMatchObject({ outcome: 'failure', detail: { reason: 'bad_password', passwordChanged: true } });
    expect(audit.some((e) => e.action === 'auth.login' && e.outcome === 'success')).toBe(false);
    // Dihitung sebagai percobaan gagal (penguncian tetap berlaku), bukan login sukses.
    expect(ctx.db.prepare("SELECT failed_login_count, last_login_at FROM users WHERE username = 'mary'").get())
      .toEqual({ failed_login_count: 1, last_login_at: null });
  });

  it('NEG-AUTH-011 sesudah balapan: kata sandi lama ditolak, kata sandi baru diterima', async () => {
    const verifying = gate.hold('verify');
    const pending = login(ctx.app);
    await verifying.arrived();
    await changeViaCli();
    verifying.release();
    expect((await pending).res.statusCode).toBe(401);

    expect((await login(ctx.app)).res.statusCode).toBe(401);
    const fresh = await login(ctx.app, { username: 'mary', password: NEW_PASSWORD });
    expect(fresh.res.statusCode).toBe(200);
    expect((await ctx.app.inject({ url: '/api/auth/session', headers: { cookie: fresh.cookie } })).statusCode).toBe(200);
  });

  it('NEG-AUTH-012 rehash saat login tidak menimpa hash baru dari ganti kata sandi (compare-and-swap)', async () => {
    // Hash mary dibuat dengan parameter lama → login sukses berikutnya me-rehash kata sandi yang dikirim.
    const legacy = createPasswordHasher({ ...TEST_HASHER_OPTIONS, timeCost: TEST_HASHER_OPTIONS.timeCost + 1 });
    ctx.db.prepare("UPDATE users SET password_hash = ? WHERE username = 'mary'").run(await legacy.hash(ADMIN.password));
    expect(ctx.app.services.hasher.needsRehash(hashOfMary())).toBe(true);

    const rehashing = gate.hold('hash');
    const pending = login(ctx.app);
    await rehashing.arrived(); // verify lolos; rehash kata sandi LAMA dengan parameter sekarang sedang dibuat
    await changeViaCli();
    const changed = hashOfMary();
    rehashing.release();

    const { res } = await pending;
    // Hash baru tetap utuh: rehash kata sandi lama tidak boleh menimpanya.
    expect(hashOfMary()).toBe(changed);
    expect(await cliHasher.verify(hashOfMary(), NEW_PASSWORD)).toBe(true);
    expect(await cliHasher.verify(hashOfMary(), ADMIN.password)).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(activeSessionsOfMary()).toBe(0);
    expect((await login(ctx.app, { username: 'mary', password: NEW_PASSWORD })).res.statusCode).toBe(200);
  });
});
