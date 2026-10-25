// Tes integrasi CLI `npm run user:password`: script asli dijalankan sebagai proses terpisah terhadap
// database SQLite sementara, dengan kata sandi lewat stdin (jalur non-TTY).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPasswordHasher } from '../../backend/auth/password.js';
import { createSessionService } from '../../backend/auth/sessionService.js';
import { openDatabase } from '../../backend/database/connection.js';
import { migrate } from '../../backend/database/migrate.js';
import { createRepositories } from '../../backend/database/repositories/index.js';
import { createUser } from '../../backend/users/userAdmin.js';
import { TEST_HASHER_OPTIONS, TEST_ORIGIN } from '../helpers/testApp.js';

const SCRIPT = fileURLToPath(new URL('../../scripts/change-password.js', import.meta.url));
const NEW_PASSWORD = 'kata-sandi-baru-yang-kuat';

describe('CLI user:password', () => {
  let dir;
  let dbPath;
  let token;
  const hasher = createPasswordHasher(TEST_HASHER_OPTIONS);

  const runCli = (args, input = '') => spawnSync(process.execPath, [SCRIPT, ...args], {
    input,
    encoding: 'utf8',
    timeout: 15_000,
    env: { NODE_ENV: 'test', DATABASE_PATH: dbPath, APP_ORIGIN: TEST_ORIGIN, LOG_LEVEL: 'silent' },
  });

  /** Membuka koneksi baru (migrasi idempoten) untuk menyiapkan atau memeriksa database. */
  const inspect = async (fn) => {
    const db = openDatabase(dbPath);
    try {
      migrate(db);
      return await fn(db, createRepositories(db));
    } finally {
      db.close();
    }
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lr-cli-'));
    dbPath = join(dir, 'cli.db');
    await inspect(async (_db, repos) => {
      const clock = Date.now;
      const id = await createUser({ users: repos.users, audit: repos.audit, hasher, maxUsers: 2, clock },
        { username: 'admin', password: 'alphalens-demo', role: 'admin' });
      const sessions = createSessionService({ sessions: repos.sessions, users: repos.users, config: { idleMs: 60_000, absoluteMs: 3_600_000 }, clock });
      ({ token } = await sessions.create(id, {}));
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('INT-PWC-001 kata sandi dari stdin: hash diganti, sesi lama dicabut, audit via cli', async () => {
    const res = runCli(['--username', 'admin'], `${NEW_PASSWORD}\n`);
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Kata sandi pengguna admin diganti; 1 sesi aktif dicabut');
    expect(res.stdout).not.toContain(NEW_PASSWORD);

    await inspect(async (_db, repos) => {
      const user = await repos.users.findByUsernameForAuth('admin');
      expect(await hasher.verify(user.password_hash, NEW_PASSWORD)).toBe(true);
      expect(await hasher.verify(user.password_hash, 'alphalens-demo')).toBe(false);
      const sessions = createSessionService({ sessions: repos.sessions, users: repos.users, config: { idleMs: 60_000, absoluteMs: 3_600_000 }, clock: Date.now });
      expect(await sessions.resolve(token)).toBeNull();
      expect((await repos.audit.recent(1))[0]).toMatchObject({
        action: 'user.password_change', outcome: 'success', detail: { via: 'cli', revokedSessions: 1 },
      });
    });
  });

  it('INT-PWC-002 tanpa --username atau dengan kata sandi di argumen → pemakaian, database tidak berubah', async () => {
    for (const args of [[], ['--username', 'admin', '--password', NEW_PASSWORD]]) {
      const res = runCli(args, `${NEW_PASSWORD}\n`);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('Pemakaian: npm run user:password -- --username <username>');
    }
    await inspect(async (_db, repos) => {
      const user = await repos.users.findByUsernameForAuth('admin');
      expect(await hasher.verify(user.password_hash, 'alphalens-demo')).toBe(true);
      expect((await repos.audit.recent(1))[0].action).toBe('user.create');
    });
  });

  it('INT-PWC-003 pelanggaran kebijakan & pengguna tidak dikenal → exit 1 dengan pesan', async () => {
    const weak = runCli(['--username', 'admin'], 'pendek\n');
    expect(weak.status).toBe(1);
    expect(weak.stderr).toContain('Kata sandi tidak memenuhi kebijakan');

    const unknown = runCli(['--username', 'ghost'], `${NEW_PASSWORD}\n`);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('Pengguna tidak ditemukan');

    await inspect(async (_db, repos) => {
      const user = await repos.users.findByUsernameForAuth('admin');
      expect(await hasher.verify(user.password_hash, 'alphalens-demo')).toBe(true);
      const outcomes = (await repos.audit.recent(2)).map((e) => [e.outcome, e.detail.reason]);
      expect(outcomes).toEqual([['failure', 'unknown_user'], ['failure', 'policy']]);
    });
  });
});
