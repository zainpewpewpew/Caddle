import { beforeEach, describe, expect, it } from 'vitest';
import { createPasswordHasher } from '../../backend/auth/password.js';
import { createSessionService } from '../../backend/auth/sessionService.js';
import { openDatabase } from '../../backend/database/connection.js';
import { migrate } from '../../backend/database/migrate.js';
import { createRepositories } from '../../backend/database/repositories/index.js';
import { UserAdminError, changePassword, createUser } from '../../backend/users/userAdmin.js';
import { gateHasher } from '../helpers/gatedHasher.js';
import { ADMIN, ANALYST, TEST_HASHER_OPTIONS, createClock } from '../helpers/testApp.js';

const NEW_PASSWORD = 'kata-sandi-baru-yang-kuat';

describe('ganti kata sandi (CLI)', () => {
  let db;
  let repos;
  let hasher;
  let clock;
  let sessions;
  let maryId;
  let rekanId;
  const change = (input) => changePassword({ users: repos.users, sessions: repos.sessions, audit: repos.audit, hasher, clock }, input);
  const hashOf = (id) => db.prepare('SELECT password_hash FROM users WHERE id = ?').get(id).password_hash;
  const lastAudit = async () => (await repos.audit.recent(1))[0];

  beforeEach(async () => {
    db = openDatabase(':memory:');
    migrate(db);
    repos = createRepositories(db);
    hasher = createPasswordHasher(TEST_HASHER_OPTIONS);
    clock = createClock();
    const deps = { users: repos.users, audit: repos.audit, hasher, maxUsers: 2, clock };
    maryId = await createUser(deps, ADMIN);
    rekanId = await createUser(deps, ANALYST);
    sessions = createSessionService({ sessions: repos.sessions, users: repos.users, config: { idleMs: 30 * 60_000, absoluteMs: 12 * 3_600_000 }, clock });
  });

  it('UNIT-PWC-001 sukses: hash baru Argon2id, kata sandi lama tidak berlaku, semua sesi pengguna dicabut, audit tercatat', async () => {
    const a = await sessions.create(maryId, {});
    const b = await sessions.create(maryId, {});
    const other = await sessions.create(rekanId, {});
    clock.advance(1_000);

    expect(await change({ username: 'mary', password: NEW_PASSWORD })).toEqual({ userId: maryId, revokedSessions: 2 });

    const hash = hashOf(maryId);
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await hasher.verify(hash, NEW_PASSWORD)).toBe(true);
    expect(await hasher.verify(hash, ADMIN.password)).toBe(false);
    expect(await sessions.resolve(a.token)).toBeNull();
    expect(await sessions.resolve(b.token)).toBeNull();
    expect(await sessions.resolve(other.token)).not.toBeNull();
    expect(db.prepare("SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND revoke_reason = 'password_change'").get(maryId).n).toBe(2);

    expect(await lastAudit()).toMatchObject({
      user_id: maryId, action: 'user.password_change', outcome: 'success', detail: { via: 'cli', revokedSessions: 2 },
    });
    expect(JSON.stringify(db.prepare('SELECT * FROM audit_logs').all())).not.toContain(NEW_PASSWORD);
  });

  it('EDGE-PWC-001 username tidak case-sensitive; tanpa sesi aktif → 0 dicabut', async () => {
    expect(await change({ username: 'MARY', password: NEW_PASSWORD })).toEqual({ userId: maryId, revokedSessions: 0 });
    expect(await hasher.verify(hashOf(maryId), NEW_PASSWORD)).toBe(true);
  });

  it.each([
    ['pendek', 'short-pw', /Minimal 12/],
    ['memuat username', 'xx-mary-password-xx', /username/],
    ['memuat username (beda huruf)', 'xx-MARY-password-xx', /username/],
    ['variasi rendah', 'aaaaaaaaaaaaaaa', /Variasi/],
    ['bukan teks', undefined, /teks/],
  ])('NEG-PWC-001 kebijakan menolak kata sandi %s; hash & sesi tidak berubah', async (_label, password, re) => {
    const s = await sessions.create(maryId, {});
    const before = hashOf(maryId);
    const err = await change({ username: 'mary', password }).catch((e) => e);
    expect(err).toBeInstanceOf(UserAdminError);
    expect(err.message).toMatch(/Kata sandi tidak memenuhi kebijakan/);
    expect(err.message).toMatch(re);
    expect(hashOf(maryId)).toBe(before);
    expect(await sessions.resolve(s.token)).not.toBeNull();
    expect(await lastAudit()).toMatchObject({
      user_id: maryId, action: 'user.password_change', outcome: 'failure', detail: { reason: 'policy', via: 'cli' },
    });
  });

  it.each([['ghost'], [''], [undefined], ['../etc']])('NEG-PWC-002 pengguna tidak dikenal (%s) ditolak dan diaudit', async (username) => {
    await expect(change({ username, password: NEW_PASSWORD })).rejects.toThrow(/Pengguna tidak ditemukan/);
    expect(await lastAudit()).toMatchObject({
      user_id: null, action: 'user.password_change', outcome: 'failure', detail: { reason: 'unknown_user', via: 'cli' },
    });
  });

  it('NEG-PWC-003 kata sandi baru sama dengan yang sekarang ditolak', async () => {
    const s = await sessions.create(maryId, {});
    await expect(change({ username: 'mary', password: ADMIN.password })).rejects.toThrow(/harus berbeda/);
    expect(await sessions.resolve(s.token)).not.toBeNull();
    expect(await lastAudit()).toMatchObject({ outcome: 'failure', detail: { reason: 'unchanged', via: 'cli' } });
  });

  it('UNIT-PWC-002 createUser tetap mencatat via cli secara default', async () => {
    const entries = (await repos.audit.recent(10)).filter((e) => e.action === 'user.create');
    expect(entries.map((e) => e.detail)).toEqual([{ role: 'analyst', via: 'cli' }, { role: 'admin', via: 'cli' }]);
  });
});

describe('createUser bersamaan (mis. dua proses user:create)', () => {
  let db;
  let repos;
  let clock;
  const userCount = () => db.prepare('SELECT COUNT(*) n FROM users').get().n;
  const createAudits = () => db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action = 'user.create'").get().n;

  beforeEach(() => {
    db = openDatabase(':memory:');
    migrate(db);
    repos = createRepositories(db);
    clock = createClock();
  });

  /** Semua panggilan lolos pemeriksaan awal, lalu ditahan bersamaan di Argon2 hash sebelum insert. */
  const createConcurrently = async (inputs, maxUsers) => {
    const hasher = createPasswordHasher(TEST_HASHER_OPTIONS);
    const hashing = gateHasher(hasher).hold('hash');
    const deps = { users: repos.users, audit: repos.audit, hasher, maxUsers, clock };
    const settled = inputs.map((input) => createUser(deps, input).then((id) => ({ id }), (error) => ({ error })));
    await hashing.arrived(inputs.length);
    hashing.release();
    return Promise.all(settled);
  };

  it.each([1, 2])('EDGE-USR-002 MAX_USERS=%i, tiga createUser bersamaan → tepat MAX_USERS pengguna, sisanya ditolak batas', async (maxUsers) => {
    const results = await createConcurrently([
      { username: 'satu', password: 'strong-password-001', role: 'admin' },
      { username: 'dua', password: 'strong-password-002', role: 'analyst' },
      { username: 'tiga', password: 'strong-password-003', role: 'analyst' },
    ], maxUsers);

    expect(userCount()).toBe(maxUsers);
    expect(results.filter((r) => 'id' in r)).toHaveLength(maxUsers);
    const rejected = results.filter((r) => 'error' in r).map((r) => r.error);
    expect(rejected).toHaveLength(3 - maxUsers);
    for (const error of rejected) {
      expect(error).toBeInstanceOf(UserAdminError);
      expect(error.message).toBe(`Batas ${maxUsers} pengguna sudah tercapai`);
    }
    expect(createAudits()).toBe(maxUsers);
  });

  it('EDGE-USR-003 username sama (beda huruf) bersamaan → satu dibuat, lainnya "Username sudah dipakai" (bukan SqliteError)', async () => {
    const results = await createConcurrently([
      { username: 'mary', password: 'strong-password-001', role: 'admin' },
      { username: 'MARY', password: 'strong-password-002', role: 'analyst' },
    ], 2);

    expect(userCount()).toBe(1);
    expect(results.filter((r) => 'id' in r)).toHaveLength(1);
    const [{ error }] = results.filter((r) => 'error' in r);
    expect(error).toBeInstanceOf(UserAdminError);
    expect(error.message).toBe('Username sudah dipakai');
    expect(createAudits()).toBe(1);
  });
});
