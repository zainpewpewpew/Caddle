import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../backend/app/config.js';
import { checkPasswordPolicy, createPasswordHasher } from '../../backend/auth/password.js';
import { openDatabase } from '../../backend/database/connection.js';
import { migrate } from '../../backend/database/migrate.js';
import { createRepositories } from '../../backend/database/repositories/index.js';
import {
  DEFAULT_CREDENTIALS, DefaultUserError, ensureDefaultUser, exposureOf, isLoopbackHost,
} from '../../backend/users/defaultUser.js';
import { changePassword, createUser } from '../../backend/users/userAdmin.js';
import { ADMIN, TEST_HASHER_OPTIONS, createClock } from '../helpers/testApp.js';

const PROD = { NODE_ENV: 'production', APP_ORIGIN: 'https://radar.local', DATABASE_PATH: '/data/lr.db' };

describe('akun default prototipe lokal', () => {
  let db;
  let repos;
  let hasher;
  let clock;
  let log;
  const run = (env = {}, overrides = {}) => ensureDefaultUser({
    users: repos.users, audit: repos.audit, hasher, maxUsers: 2, clock, log,
    config: { ...loadConfig(env), ...overrides },
  });
  const userCount = () => db.prepare('SELECT COUNT(*) n FROM users').get().n;
  const hashOf = (username) => db.prepare('SELECT password_hash FROM users WHERE username = ?').get(username)?.password_hash;

  beforeEach(() => {
    db = openDatabase(':memory:');
    migrate(db);
    repos = createRepositories(db);
    hasher = createPasswordHasher(TEST_HASHER_OPTIONS);
    clock = createClock();
    log = { warn: vi.fn() };
  });

  it('UNIT-DEF-001 kredensial default pilihan pemilik (admin / admin123@) — pengecualian kebijakan HANYA untuk akun default', () => {
    expect(DEFAULT_CREDENTIALS).toEqual({ username: 'admin', password: 'admin123@', role: 'admin' });
    expect(Object.isFrozen(DEFAULT_CREDENTIALS)).toBe(true);
    // Sengaja tidak lolos kebijakan umum; createUser lewat CLI (tanpa skipPasswordPolicy) tetap menolaknya.
    expect(checkPasswordPolicy(DEFAULT_CREDENTIALS.password, { username: DEFAULT_CREDENTIALS.username })).not.toEqual([]);
  });

  it('NEG-DEF-007 kata sandi default ditolak createUser biasa (jalur CLI user:create) walau dikecualikan untuk seed', async () => {
    await expect(createUser(
      { users: repos.users, audit: repos.audit, hasher, maxUsers: 2, clock },
      { username: 'admin', password: 'admin123@', role: 'admin' },
    )).rejects.toThrow(/kebijakan/);
    expect(userCount()).toBe(0);
  });

  it('UNIT-DEF-002 development + loopback + tabel kosong → akun admin dibuat, kata sandi terverifikasi, audit via default', async () => {
    const result = await run();
    expect(result).toEqual({ created: true, id: expect.any(Number) });
    expect(userCount()).toBe(1);

    const user = await repos.users.findByUsernameForAuth('admin');
    expect(user).toMatchObject({ id: result.id, username: 'admin', role: 'admin', is_disabled: 0 });
    expect(user.password_hash.startsWith('$argon2id$')).toBe(true);
    expect(await hasher.verify(user.password_hash, 'admin123@')).toBe(true);

    const [entry] = await repos.audit.recent(5);
    expect(entry).toMatchObject({ user_id: result.id, action: 'user.create', outcome: 'success', detail: { role: 'admin', via: 'default' } });

    expect(log.warn).toHaveBeenCalledTimes(1);
    const message = log.warn.mock.calls[0][0];
    expect(message).toContain('username: admin');
    expect(message).toContain('kata sandi: admin123@');
    expect(message).toContain('HANYA untuk prototipe lokal');
    expect(message).toContain('npm run user:password -- --username admin');
  });

  it.each(['127.0.0.1', '::1', 'localhost'])('UNIT-DEF-003 HOST loopback %s → akun dibuat', async (host) => {
    expect((await run({ HOST: host })).created).toBe(true);
    expect(userCount()).toBe(1);
  });

  it('UNIT-DEF-004 idempoten: start kedua tidak membuat ulang, tidak me-reset hash, tidak menulis audit/log lagi', async () => {
    await run();
    const hash = hashOf('admin');
    clock.advance(60_000);
    expect(await run()).toEqual({ created: false, reason: 'users_exist' });
    expect(userCount()).toBe(1);
    expect(hashOf('admin')).toBe(hash);
    expect((await repos.audit.recent(10)).filter((e) => e.action === 'user.create')).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('NEG-DEF-001 sudah ada pengguna → tidak ada yang dibuat; hash pengguna lama tidak tersentuh', async () => {
    await createUser({ users: repos.users, audit: repos.audit, hasher, maxUsers: 2, clock }, ADMIN);
    const hash = hashOf('mary');
    expect(await run()).toEqual({ created: false, reason: 'users_exist' });
    expect(userCount()).toBe(1);
    expect(hashOf('mary')).toBe(hash);
    expect(await repos.users.findByUsernameForAuth('admin')).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('NEG-DEF-002 akun "admin" yang sudah ada dengan kata sandi lain tidak ditimpa atau di-reset', async () => {
    await createUser({ users: repos.users, audit: repos.audit, hasher, maxUsers: 2, clock },
      { username: 'admin', password: 'kata-sandi-pribadi-77', role: 'analyst' });
    const hash = hashOf('admin');
    expect(await run()).toEqual({ created: false, reason: 'users_exist' });
    expect(hashOf('admin')).toBe(hash);
    expect(await hasher.verify(hash, 'admin123@')).toBe(false);
    expect((await repos.users.findByUsernameForAuth('admin')).role).toBe('analyst');
  });

  it.each(['0.0.0.0', '::', '192.168.1.10', 'radar.local'])('NEG-DEF-003 HOST %s bukan loopback → tidak dibuat, peringatan dicatat', async (host) => {
    expect(await run({ HOST: host })).toEqual({ created: false, reason: 'non_loopback_host' });
    expect(userCount()).toBe(0);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toMatch(new RegExp(`Akun default TIDAK dibuat: HOST=${host.replace(/[.]/g, '\\.')} bukan loopback`));
    expect(log.warn.mock.calls[0][0]).not.toContain('admin123@');
  });

  it.each([
    ['APP_ORIGIN publik', { APP_ORIGIN: 'https://radar.example.com' }, 'non_loopback_origin', /APP_ORIGIN=https:\/\/radar\.example\.com bukan loopback/],
    ['APP_ORIGIN IP LAN', { APP_ORIGIN: 'http://192.168.1.10:8080' }, 'non_loopback_origin', /APP_ORIGIN=http:\/\/192\.168\.1\.10:8080 bukan loopback/],
    ['di belakang reverse proxy', { TRUST_PROXY: '127.0.0.1' }, 'behind_proxy', /TRUST_PROXY diset/],
  ])('NEG-DEF-006 HOST loopback tetapi %s → tidak dibuat, peringatan dicatat', async (_label, env, reason, re) => {
    expect(await run(env)).toEqual({ created: false, reason });
    expect(userCount()).toBe(0);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toMatch(re);
  });

  it.each(['http://localhost:8080', 'http://[::1]:8080'])('UNIT-DEF-006 APP_ORIGIN loopback %s → akun dibuat', async (origin) => {
    expect((await run({ APP_ORIGIN: origin })).created).toBe(true);
  });

  it('NEG-DEF-004 DEFAULT_USER=false → tidak dibuat, tanpa log', async () => {
    expect(await run({ DEFAULT_USER: 'false' })).toEqual({ created: false, reason: 'disabled' });
    expect(userCount()).toBe(0);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('NEG-DEF-005 NODE_ENV test/produksi → tidak dibuat (juga bila flag dipaksa aktif)', async () => {
    expect(await run({ NODE_ENV: 'test' })).toEqual({ created: false, reason: 'disabled' });
    expect(await run(PROD)).toEqual({ created: false, reason: 'disabled' });
    expect(log.warn).not.toHaveBeenCalled();

    expect(await run({ NODE_ENV: 'test', DEFAULT_USER: 'true' })).toEqual({ created: false, reason: 'not_development' });
    // Pertahanan berlapis: config produksi dengan flag aktif (loadConfig sendiri menolaknya).
    expect(await run(PROD, { defaultUser: true, host: '127.0.0.1' })).toEqual({ created: false, reason: 'not_development' });
    expect(userCount()).toBe(0);
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn.mock.calls[0][0]).toContain('hanya dibuat saat NODE_ENV=development');
  });

  it('UNIT-DEF-005 isLoopbackHost hanya menerima 127.0.0.1, ::1, localhost', () => {
    for (const host of ['127.0.0.1', '::1', 'localhost', ' LOCALHOST ']) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ['0.0.0.0', '::', '127.0.0.2', '::ffff:127.0.0.1', '10.0.0.1', 'localhost.evil.test', '', undefined]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });

  it('UNIT-DEF-007 exposureOf: null hanya untuk server lokal non-produksi', () => {
    expect(exposureOf(loadConfig({}))).toBeNull();
    expect(exposureOf(loadConfig({ NODE_ENV: 'test', HOST: '::1', APP_ORIGIN: 'http://[::1]:8080' }))).toBeNull();
    expect(exposureOf(loadConfig(PROD)).reason).toBe('production');
    expect(exposureOf(loadConfig({ HOST: '0.0.0.0' })).reason).toBe('non_loopback_host');
    expect(exposureOf(loadConfig({ APP_ORIGIN: 'https://radar.example.com' })).reason).toBe('non_loopback_origin');
    expect(exposureOf(loadConfig({ TRUST_PROXY: 'loopback' })).reason).toBe('behind_proxy');
  });

  it('SEC-DEF-001 server menolak start bila admin masih berkata sandi default dan server tidak lagi hanya lokal / produksi', async () => {
    await run();
    await expect(run({ HOST: '0.0.0.0' })).rejects.toThrow(DefaultUserError);
    await expect(run({ HOST: '0.0.0.0', DEFAULT_USER: 'false' })).rejects.toThrow(/HOST=0\.0\.0\.0 bukan loopback/);
    await expect(run({ APP_ORIGIN: 'https://radar.example.com' })).rejects.toThrow(/APP_ORIGIN=https:\/\/radar\.example\.com bukan loopback/);
    await expect(run({ TRUST_PROXY: '127.0.0.1' })).rejects.toThrow(/TRUST_PROXY diset/);
    await expect(run(PROD)).rejects.toThrow(/masih memakai kata sandi default, padahal NODE_ENV=production/);
    await expect(run(PROD)).rejects.toThrow(/npm run user:password -- --username admin/);
    // Di loopback development tetap boleh (prototipe lokal).
    expect(await run()).toEqual({ created: false, reason: 'users_exist' });
  });

  it('SEC-DEF-006 admin dengan kata sandi default LAMA (alphalens-demo, database versi sebelumnya) tetap memblokir start non-lokal', async () => {
    await createUser({ users: repos.users, audit: repos.audit, hasher, maxUsers: 2, clock },
      { username: 'admin', password: 'alphalens-demo', role: 'admin' });
    await expect(run({ HOST: '0.0.0.0' })).rejects.toThrow(DefaultUserError);
    await expect(run(PROD)).rejects.toThrow(/masih memakai kata sandi default/);
    expect(await run()).toEqual({ created: false, reason: 'users_exist' });
  });

  it('SEC-DEF-002 setelah kata sandi diganti, server boleh start di HOST non-loopback / produksi', async () => {
    await run();
    await changePassword({ users: repos.users, sessions: repos.sessions, audit: repos.audit, hasher, clock },
      { username: 'admin', password: 'kata-sandi-baru-yang-kuat' });
    expect(await run({ HOST: '0.0.0.0' })).toEqual({ created: false, reason: 'users_exist' });
    expect(await run(PROD)).toEqual({ created: false, reason: 'disabled' });
  });

  it('SEC-DEF-003 kata sandi default tidak pernah masuk audit', async () => {
    await run();
    expect(JSON.stringify(db.prepare('SELECT * FROM audit_logs').all())).not.toContain('admin123@');
  });
});
