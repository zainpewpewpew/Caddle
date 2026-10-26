import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../backend/app/buildApp.js';
import { loadConfig } from '../../backend/app/config.js';
import { createPasswordHasher } from '../../backend/auth/password.js';
import { openDatabase } from '../../backend/database/connection.js';
import { createRepositories } from '../../backend/database/repositories/index.js';
import { migrate } from '../../backend/database/migrate.js';
import { DEFAULT_SCANNER_SETTINGS } from '../../backend/settings/scannerSettings.js';
import { UserAdminError, createUser } from '../../backend/users/userAdmin.js';
import { ADMIN, TEST_HASHER_OPTIONS, TEST_ORIGIN, createClock, createTestApp, login } from '../helpers/testApp.js';

describe('kasus tepi', () => {
  let ctx;
  beforeEach(async () => { ctx = await createTestApp({ env: { LOGIN_RATE_LIMIT_MAX: '100' } }); });
  afterEach(async () => { await ctx.app.close(); });

  it('EDGE-SET-001 dua update bersamaan dengan versi sama → satu sukses, satu 409 (tanpa lost update)', async () => {
    const a = await login(ctx.app);
    const b = await login(ctx.app);
    const settings = structuredClone(DEFAULT_SCANNER_SETTINGS);
    const send = (auth, maxAuto) => ctx.app.inject({
      method: 'PUT', url: '/api/settings/scanner', headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrfToken },
      payload: { version: 0, settings: { ...settings, symbols: { ...settings.symbols, maxAuto } } },
    });
    const results = await Promise.all([send(a, 30), send(b, 50)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const winner = results.find((r) => r.statusCode === 200).json();
    const stored = (await ctx.app.inject({ url: '/api/settings/scanner', headers: { cookie: a.cookie } })).json();
    expect(stored.settings.symbols.maxAuto).toBe(winner.settings.symbols.maxAuto);
    expect(stored.version).toBe(1);
  });

  it('EDGE-SET-002 versi usang setelah update → 409', async () => {
    const a = await login(ctx.app);
    const put = (version) => ctx.app.inject({
      method: 'PUT', url: '/api/settings/scanner', headers: { cookie: a.cookie, 'x-csrf-token': a.csrfToken },
      payload: { version, settings: DEFAULT_SCANNER_SETTINGS },
    });
    expect((await put(0)).statusCode).toBe(200);
    expect((await put(0)).statusCode).toBe(409);
    expect((await put(5)).statusCode).toBe(409);
  });

  it('EDGE-AUTH-001 username tidak case-sensitive', async () => {
    expect((await login(ctx.app, { username: 'MARY', password: ADMIN.password })).res.statusCode).toBe(200);
  });

  it('EDGE-AUTH-002 banyak login paralel untuk user yang sama menghasilkan sesi independen', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => login(ctx.app)));
    expect(new Set(results.map((r) => r.cookie)).size).toBe(5);
    expect(ctx.db.prepare('SELECT COUNT(*) n FROM sessions WHERE revoked_at IS NULL').get().n).toBe(5);
  });

  it('EDGE-AUTH-003 login ulang dari browser yang sama mencabut sesi lama (anti session fixation)', async () => {
    const first = await login(ctx.app);
    const second = await ctx.app.inject({
      method: 'POST', url: '/api/auth/login', headers: { cookie: first.cookie, origin: TEST_ORIGIN },
      payload: { username: ADMIN.username, password: ADMIN.password },
    });
    expect(second.statusCode).toBe(200);
    expect((await ctx.app.inject({ url: '/api/auth/session', headers: { cookie: first.cookie } })).statusCode).toBe(401);
  });

  it('EDGE-AUTH-004 kegagalan login paralel tetap dihitung atomik dan memicu penguncian', async () => {
    const locked = await createTestApp({ env: { LOGIN_RATE_LIMIT_MAX: '100', ACCOUNT_LOCK_THRESHOLD: '3' } });
    await Promise.all(Array.from({ length: 6 }, (_, i) => login(locked.app, { username: 'mary', password: `bad-password-${i}` })));
    const row = locked.db.prepare("SELECT locked_until FROM users WHERE username = 'mary'").get();
    expect(row.locked_until).toBeGreaterThan(locked.clock());
    await locked.app.close();
  });

  it('EDGE-AUTH-006 tebakan paralel melebihi ambang: hanya ambang yang diverifikasi, kata sandi benar sesudahnya ditolak', async () => {
    const locked = await createTestApp({ env: { LOGIN_RATE_LIMIT_MAX: '100', ACCOUNT_LOCK_THRESHOLD: '3' } });
    const { hasher } = locked.app.services;
    // Hitung hanya verifikasi terhadap hash asli (verifyDummy memakai hash dummy).
    const realHash = locked.db.prepare("SELECT password_hash FROM users WHERE username = 'mary'").get().password_hash;
    let verified = 0;
    const original = hasher.verify;
    hasher.verify = async (hash, password) => { if (hash === realHash) verified += 1; return original.call(hasher, hash, password); };
    try {
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) => login(locked.app, { username: 'mary', password: `bad-password-${i}` })));
      expect(results.every((r) => r.res.statusCode === 401)).toBe(true);
      // Tanpa reservasi atomik, ke-12 tebakan membaca baris lama dan semuanya diverifikasi.
      expect(verified).toBeLessThanOrEqual(3);
      const correct = await login(locked.app);
      expect(correct.res.statusCode).toBe(401);
      expect(verified).toBeLessThanOrEqual(3);
      const audit = locked.db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action = 'auth.account_locked'").get().n;
      expect(audit).toBeGreaterThanOrEqual(1);
    } finally {
      hasher.verify = original;
      await locked.app.close();
    }
  });

  it('EDGE-AUTH-007 login benar yang paralel dengan tebakan salah tidak menghapus kunci yang dipasang tebakan tersebut', async () => {
    const locked = await createTestApp({ env: { LOGIN_RATE_LIMIT_MAX: '100', ACCOUNT_LOCK_THRESHOLD: '3' } });
    try {
      const attempts = [login(locked.app), ...Array.from({ length: 5 }, (_, i) => login(locked.app, { username: 'mary', password: `bad-password-${i}` }))];
      const [ok] = await Promise.all(attempts);
      expect(ok.res.statusCode).toBe(200);
      const row = locked.db.prepare("SELECT locked_until FROM users WHERE username = 'mary'").get();
      expect(row.locked_until).toBeGreaterThan(locked.clock());
      expect((await login(locked.app)).res.statusCode).toBe(401);
    } finally {
      await locked.app.close();
    }
  });

  it('EDGE-AUTH-008 hash berparameter lama di-rehash saat login sukses (tanpa balapan), sesi tetap dibuat', async () => {
    const legacy = createPasswordHasher({ ...TEST_HASHER_OPTIONS, timeCost: TEST_HASHER_OPTIONS.timeCost + 1 });
    const hashOfMary = () => ctx.db.prepare("SELECT password_hash FROM users WHERE username = 'mary'").get().password_hash;
    ctx.db.prepare("UPDATE users SET password_hash = ? WHERE username = 'mary'").run(await legacy.hash(ADMIN.password));
    const { hasher } = ctx.app.services;
    expect(hasher.needsRehash(hashOfMary())).toBe(true);

    const auth = await login(ctx.app);
    expect(auth.res.statusCode).toBe(200);
    expect(hasher.needsRehash(hashOfMary())).toBe(false);
    expect(await hasher.verify(hashOfMary(), ADMIN.password)).toBe(true);
    expect((await ctx.app.inject({ url: '/api/auth/session', headers: { cookie: auth.cookie } })).statusCode).toBe(200);
  });

  it('EDGE-AUTH-005 sesi kedaluwarsa absolut meskipun terus aktif', async () => {
    const { cookie } = await login(ctx.app);
    const step = 20 * 60_000;
    let status = 200;
    let elapsed = 0;
    while (status === 200 && elapsed < 48 * 3_600_000) {
      ctx.clock.advance(step);
      elapsed += step;
      status = (await ctx.app.inject({ url: '/api/auth/session', headers: { cookie } })).statusCode;
    }
    expect(status).toBe(401);
    expect(elapsed).toBeGreaterThanOrEqual(ctx.config.session.absoluteMs);
    expect(elapsed).toBeLessThanOrEqual(ctx.config.session.absoluteMs + step);
  });
});

describe('batas pengguna', () => {
  it('EDGE-USR-001 maksimal dua pengguna; pengguna ketiga ditolak', async () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const deps = { users: repos.users, audit: repos.audit, hasher: createPasswordHasher(TEST_HASHER_OPTIONS), maxUsers: 2, clock: Date.now };
    await createUser(deps, { username: 'satu', password: 'strong-password-001', role: 'admin' });
    await createUser(deps, { username: 'dua', password: 'strong-password-002', role: 'analyst' });
    await expect(createUser(deps, { username: 'tiga', password: 'strong-password-003', role: 'analyst' })).rejects.toThrow(/Batas 2/);
    await expect(createUser(deps, { username: 'SATU', password: 'strong-password-004', role: 'admin' })).rejects.toThrow(UserAdminError);
    await expect(createUser(deps, { username: 'x', password: 'strong-password-005', role: 'admin' })).rejects.toThrow(/Username/);
    await expect(createUser(deps, { username: 'abc', password: 'strong-password-006', role: 'root' })).rejects.toThrow(/Peran/);
  });
});

describe('restart aplikasi', () => {
  it('EDGE-RST-001 sesi & pengaturan bertahan setelah restart; migrasi tidak diterapkan ulang', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lr-restart-'));
    const dbPath = join(dir, 'lr.db');
    const config = loadConfig({ NODE_ENV: 'test', APP_ORIGIN: TEST_ORIGIN, LOG_LEVEL: 'silent', DATABASE_PATH: dbPath });
    const clock = createClock();

    const db1 = openDatabase(dbPath);
    const app1 = await buildApp({ config, db: db1, clock, hasherOptions: TEST_HASHER_OPTIONS });
    await createUser({ ...app1.services.repos, hasher: app1.services.hasher, maxUsers: 2, clock }, ADMIN);
    const auth = await login(app1);
    await app1.close();
    db1.close();

    const db2 = openDatabase(dbPath);
    const app2 = await buildApp({ config, db: db2, clock, hasherOptions: TEST_HASHER_OPTIONS });
    expect(db2.prepare('SELECT COUNT(*) n FROM schema_migrations').get().n).toBe(5);
    expect((await app2.inject({ url: '/api/auth/session', headers: { cookie: auth.cookie } })).statusCode).toBe(200);
    await app2.close();
    db2.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('EDGE-RST-002 readiness 503 bila database tidak tersedia', async () => {
    const ctx = await createTestApp();
    ctx.db.close();
    const res = await ctx.app.inject({ url: '/api/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'unavailable' });
    ctx.app.removeAllListeners?.();
    await ctx.app.close().catch(() => {});
  });
});
