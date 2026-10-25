// Balapan lintas proses yang direproduksi reviewer: server (proses tes ini) vs CLI asli
// (`npm run user:password` / `npm run user:create`) sebagai proses terpisah atas database SQLite yang sama.
// Interleaving dibuat deterministik dengan menahan Argon2 server di gerbang (tests/helpers/gatedHasher.js)
// selama CLI berjalan sampai selesai (spawnSync).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../backend/app/buildApp.js';
import { loadConfig } from '../../backend/app/config.js';
import { createPasswordHasher } from '../../backend/auth/password.js';
import { openDatabase } from '../../backend/database/connection.js';
import { migrate } from '../../backend/database/migrate.js';
import { createRepositories } from '../../backend/database/repositories/index.js';
import { ensureDefaultUser } from '../../backend/users/defaultUser.js';
import { createUser } from '../../backend/users/userAdmin.js';
import { gateHasher } from '../helpers/gatedHasher.js';
import { TEST_HASHER_OPTIONS, TEST_ORIGIN, login } from '../helpers/testApp.js';

const script = (name) => fileURLToPath(new URL(`../../scripts/${name}`, import.meta.url));
const DEFAULT_LOGIN = { username: 'admin', password: 'admin123@' };
const NEW_PASSWORD = 'kata-sandi-baru-yang-kuat';

describe('balapan server vs CLI di proses lain', () => {
  let dir;
  let dbPath;

  const runCli = (name, args, input, env = {}) => spawnSync(process.execPath, [script(name), ...args], {
    input,
    encoding: 'utf8',
    timeout: 30_000,
    env: { NODE_ENV: 'test', DATABASE_PATH: dbPath, APP_ORIGIN: TEST_ORIGIN, LOG_LEVEL: 'silent', ...env },
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lr-race-'));
    dbPath = join(dir, 'race.db');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('INT-RACE-001 user:password selesai saat login (kata sandi lama) menunggu Argon2 → login 401, tanpa sesi', async () => {
    const config = loadConfig({ NODE_ENV: 'test', APP_ORIGIN: TEST_ORIGIN, LOG_LEVEL: 'silent', DATABASE_PATH: dbPath });
    const db = openDatabase(dbPath);
    const app = await buildApp({ config, db, hasherOptions: TEST_HASHER_OPTIONS });
    try {
      const { repos, hasher } = app.services;
      await createUser({ users: repos.users, audit: repos.audit, hasher, maxUsers: 2, clock: Date.now }, { ...DEFAULT_LOGIN, role: 'admin' });
      const verifying = gateHasher(hasher).hold('verify');
      const pending = login(app, DEFAULT_LOGIN);
      await verifying.arrived(); // hash lama sudah diverifikasi; sesi belum dibuat

      const cli = runCli('change-password.js', ['--username', 'admin'], `${NEW_PASSWORD}\n`);
      expect(cli.stderr).toBe('');
      expect(cli.status).toBe(0);
      expect(cli.stdout).toContain('Kata sandi pengguna admin diganti; 0 sesi aktif dicabut');
      verifying.release();

      const { res, cookie } = await pending;
      expect(res.statusCode).toBe(401);
      expect(cookie).toBeUndefined();
      expect(db.prepare('SELECT COUNT(*) n FROM sessions WHERE revoked_at IS NULL').get().n).toBe(0);
      expect((await login(app, DEFAULT_LOGIN)).res.statusCode).toBe(401);
      expect((await login(app, { username: 'admin', password: NEW_PASSWORD })).res.statusCode).toBe(200);
    } finally {
      await app.close();
      db.close();
    }
  });

  it('INT-RACE-002 MAX_USERS=1: user:create selesai saat seed default menunggu Argon2 → admin tidak dibuat', async () => {
    const db = openDatabase(dbPath);
    try {
      migrate(db);
      const repos = createRepositories(db);
      const hasher = createPasswordHasher(TEST_HASHER_OPTIONS);
      const hashing = gateHasher(hasher).hold('hash');
      const log = { info: vi.fn(), warn: vi.fn() };
      const seeding = ensureDefaultUser({
        users: repos.users, audit: repos.audit, hasher, maxUsers: 1, clock: Date.now, config: loadConfig({}), log,
      });
      await hashing.arrived(); // seed sudah melihat tabel kosong

      const cli = runCli('create-user.js', ['--username', 'mary', '--role', 'admin'], 'correct-horse-battery-9\n', { MAX_USERS: '1' });
      expect(cli.stderr).toBe('');
      expect(cli.status).toBe(0);
      hashing.release();

      expect(await seeding).toEqual({ created: false, reason: 'users_exist' });
      expect(db.prepare('SELECT username FROM users').all()).toEqual([{ username: 'mary' }]);
      expect(log.warn).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
});
