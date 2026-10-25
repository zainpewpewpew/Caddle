import { beforeEach, describe, expect, it } from 'vitest';
import { createSessionService } from '../../backend/auth/sessionService.js';
import { openDatabase } from '../../backend/database/connection.js';
import { migrate } from '../../backend/database/migrate.js';
import { createRepositories } from '../../backend/database/repositories/index.js';
import { createClock } from '../helpers/testApp.js';

const IDLE = 30 * 60_000;
const ABSOLUTE = 12 * 3_600_000;
const HASH = '$argon2id$v=19$m=1024,t=1,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo';

describe('layanan sesi', () => {
  let svc;
  let clock;
  let db;
  let userId;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    clock = createClock();
    userId = await repos.users.create({ username: 'mary', passwordHash: HASH, role: 'admin', now: clock() });
    svc = createSessionService({ sessions: repos.sessions, users: repos.users, config: { idleMs: IDLE, absoluteMs: ABSOLUTE }, clock });
  });

  it('UNIT-SES-001 token mentah tidak disimpan di database', async () => {
    const s = await svc.create(userId, { ip: '127.0.0.1', userAgent: 'vitest' });
    const raw = db.prepare('SELECT * FROM sessions').all();
    expect(JSON.stringify(raw)).not.toContain(s.token);
    expect((await svc.resolve(s.token)).user.username).toBe('mary');
  });

  it('EDGE-SES-001 tepat di batas idle → kedaluwarsa', async () => {
    const s = await svc.create(userId, {});
    clock.advance(IDLE - 1);
    expect(await svc.resolve(s.token)).not.toBeNull();
    clock.advance(IDLE);
    expect(await svc.resolve(s.token)).toBeNull();
  });

  it('UNIT-SES-002 aktivitas memperpanjang idle (sliding) tetapi tidak melewati batas absolut', async () => {
    const s = await svc.create(userId, {});
    for (let i = 0; i < 30; i += 1) {
      clock.advance(25 * 60_000);
      const r = await svc.resolve(s.token);
      if (r === null) {
        expect(i * 25 * 60_000).toBeGreaterThanOrEqual(ABSOLUTE - 25 * 60_000);
        return;
      }
    }
    throw new Error('sesi tidak pernah kedaluwarsa absolut');
  });

  it('NEG-SES-001 sesi dicabut tidak dapat dipakai', async () => {
    const s = await svc.create(userId, {});
    expect(await svc.revoke(s.id, userId, 'logout')).toBe(true);
    expect(await svc.resolve(s.token)).toBeNull();
  });

  it('NEG-SES-002 pengguna lain tidak dapat mencabut sesi bukan miliknya', async () => {
    const s = await svc.create(userId, {});
    expect(await svc.revoke(s.id, userId + 1, 'x')).toBe(false);
    expect(await svc.resolve(s.token)).not.toBeNull();
  });

  it('NEG-SES-003 user dinonaktifkan → sesi tidak valid', async () => {
    const s = await svc.create(userId, {});
    db.prepare('UPDATE users SET is_disabled = 1 WHERE id = ?').run(userId);
    expect(await svc.resolve(s.token)).toBeNull();
  });

  it('EDGE-SES-002 user-agent sangat panjang dipotong', async () => {
    await svc.create(userId, { userAgent: 'x'.repeat(10_000) });
    expect(db.prepare('SELECT length(user_agent) n FROM sessions').get().n).toBe(256);
  });

  it('UNIT-SES-003 purge menghapus sesi kedaluwarsa', async () => {
    await svc.create(userId, {});
    clock.advance(ABSOLUTE + 1);
    expect(await svc.purgeExpired()).toBe(1);
  });
});
