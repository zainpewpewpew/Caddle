import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../../backend/database/connection.js';
import { migrate } from '../../../backend/database/migrate.js';
import { createUserRepository } from '../../../backend/database/repositories/userRepository.js';

// Hash sintetis berformat argon2id (CHECK tabel users); isinya tidak pernah diverifikasi di sini.
const HASH_A = '$argon2id$v=19$m=1024,t=1,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo';
const HASH_B = '$argon2id$v=19$m=1024,t=1,p=1$c2FsdHNhbHQ$YmFydWJhcnViYXJ1';
const NOW = Date.UTC(2026, 0, 1);

describe('repositori pengguna — pembuatan atomik & compare-and-swap', () => {
  let db;
  let users;
  const row = (username, extra = {}) => ({ username, passwordHash: HASH_A, role: 'analyst', now: NOW, maxUsers: 2, ...extra });
  const usernames = () => db.prepare('SELECT username FROM users ORDER BY id').all().map((r) => r.username);

  beforeEach(() => {
    db = openDatabase(':memory:');
    migrate(db);
    users = createUserRepository(db);
  });

  it('UNIT-USR-001 createWithLimit membuat pengguna selama di bawah batas; pada batas → limit_reached tanpa insert', async () => {
    expect(await users.createWithLimit(row('satu'))).toEqual({ created: true, id: expect.any(Number) });
    expect(await users.createWithLimit(row('dua'))).toEqual({ created: true, id: expect.any(Number) });
    expect(await users.createWithLimit(row('tiga'))).toEqual({ created: false, reason: 'limit_reached' });
    expect(usernames()).toEqual(['satu', 'dua']);
  });

  it('UNIT-USR-002 requireEmpty → not_empty bila sudah ada pengguna; username kembar (beda huruf) → username_taken, bukan SqliteError', async () => {
    expect((await users.createWithLimit(row('admin', { requireEmpty: true }))).created).toBe(true);
    expect(await users.createWithLimit(row('mary', { requireEmpty: true }))).toEqual({ created: false, reason: 'not_empty' });
    expect(await users.createWithLimit(row('ADMIN'))).toEqual({ created: false, reason: 'username_taken' });
    expect(usernames()).toEqual(['admin']);
  });

  it('UNIT-USR-003 updatePasswordIfUnchanged hanya mengganti hash bila yang tersimpan masih hash yang diharapkan', async () => {
    const { id } = await users.createWithLimit(row('mary'));
    expect(await users.updatePasswordIfUnchanged(id, { expectedHash: HASH_B, passwordHash: HASH_B, now: NOW + 1 })).toBe(false);
    expect((await users.findByUsernameForAuth('mary')).password_hash).toBe(HASH_A);
    expect(await users.updatePasswordIfUnchanged(id, { expectedHash: HASH_A, passwordHash: HASH_B, now: NOW + 2 })).toBe(true);
    expect(await users.findByUsernameForAuth('mary')).toMatchObject({ password_hash: HASH_B, updated_at: NOW + 2 });
  });
});
