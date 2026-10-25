// Supervisor dengan proses NYATA: child_process.fork atas worker TIRUAN (tests/fixtures/worker-stub.js).
// Tidak ada koneksi ke Binance. Memverifikasi sinyal OS, kode keluar, heartbeat lintas proses, dan
// bahwa tidak ada proses yang tertinggal.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../backend/app/buildApp.js';
import { loadConfig } from '../../backend/app/config.js';
import { openDatabase } from '../../backend/database/connection.js';
import { migrate } from '../../backend/database/migrate.js';
import { createIngestionStateRepository } from '../../backend/database/repositories/ingestionStateRepository.js';
import { MAX_LINE_LENGTH, createWorkerSupervisor } from '../../backend/system/workerSupervisor.js';
import { createUser } from '../../backend/users/userAdmin.js';
import { ADMIN, TEST_HASHER_OPTIONS, TEST_ORIGIN, login } from '../helpers/testApp.js';
import { postWorker } from '../helpers/workerTestApp.js';

const STUB = fileURLToPath(new URL('../fixtures/worker-stub.js', import.meta.url));
const PARENT = fileURLToPath(new URL('../fixtures/supervisor-parent.js', import.meta.url));

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(check, { timeoutMs = 5_000, label = 'kondisi' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout menunggu ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** pid child dari baris log JSON pertama worker tiruan. */
const pidFrom = (lines) => lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .find((e) => e?.msg === 'worker stub mulai')?.pid;

describe('supervisor worker dengan proses nyata (worker tiruan)', () => {
  let dir;
  let db;
  let ingestion;
  let supervisor;
  let lines;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lr-sup-'));
    db = openDatabase(join(dir, 'sup.db'));
    migrate(db);
    ingestion = createIngestionStateRepository(db);
    lines = [];
  });

  afterEach(async () => {
    await supervisor?.shutdown();
    supervisor = null;
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const create = (env = {}, options = {}) => {
    supervisor = createWorkerSupervisor({
      scriptPath: STUB,
      env: { DATABASE_PATH: join(dir, 'sup.db'), ...env },
      output: (line) => lines.push(line),
      readExternalHeartbeat: async () => (await ingestion.getStatus()).heartbeat,
      ...options,
    });
    return supervisor;
  };

  it('INT-SUP-001 start → proses hidup & heartbeat running di SQLite; stop → SIGTERM, keluar kode 0, heartbeat akhir stopped, tanpa proses tersisa', async () => {
    create({ WORKER_STUB_HEARTBEAT: '1' });
    expect((await supervisor.start()).state).toBe('running');
    const pid = await waitFor(() => pidFrom(lines), { label: 'log mulai' });
    expect(isAlive(pid)).toBe(true);
    await waitFor(async () => (await ingestion.getStatus()).heartbeat?.state?.state === 'running', { label: 'heartbeat running' });
    // Heartbeat milik child sendiri tidak dianggap worker luar.
    expect((await supervisor.status()).state).toBe('running');

    const stopped = await supervisor.stop();
    expect(stopped).toMatchObject({ state: 'stopped', exitCode: 0, signal: null });
    expect(isAlive(pid)).toBe(false);
    expect((await ingestion.getStatus()).heartbeat.state.state).toBe('stopped');
    expect(lines.some((l) => l.includes('"worker stub berhenti"') && l.includes('"reason":"SIGTERM"'))).toBe(true);
    expect((await supervisor.status()).state).toBe('stopped');
  });

  it('INT-SUP-002 child yang mengabaikan SIGTERM dihentikan paksa dengan SIGKILL setelah stopTimeoutMs', async () => {
    create({ WORKER_STUB_IGNORE_SIGTERM: '1' }, { stopTimeoutMs: 400 });
    await supervisor.start();
    const pid = await waitFor(() => pidFrom(lines), { label: 'log mulai' });
    const startedStop = Date.now();
    const stopped = await supervisor.stop();
    expect(Date.now() - startedStop).toBeGreaterThanOrEqual(350);
    expect(stopped).toMatchObject({ state: 'stopped', exitCode: null, signal: 'SIGKILL' });
    expect(lines.some((l) => l.includes('mengabaikan SIGTERM'))).toBe(true);
    expect(isAlive(pid)).toBe(false);
  });

  it('INT-SUP-003 child yang keluar sendiri dengan kode 3 → crashed (kode keluar 3); start ulang berhasil', async () => {
    create({ WORKER_STUB_EXIT_CODE: '3' });
    await supervisor.start();
    const crashed = await waitFor(async () => {
      const s = await supervisor.status();
      return s.state === 'crashed' ? s : null;
    }, { label: 'crash' });
    expect(crashed).toMatchObject({ exitCode: 3, signal: null });
    expect((await supervisor.start()).state).toBe('running');
  });

  it('INT-SUP-004 baris stdout raksasa dari child dipotong pada MAX_LINE_LENGTH', async () => {
    create({ WORKER_STUB_LONG_LINE: '200000' });
    await supervisor.start();
    const long = await waitFor(() => lines.find((l) => l.startsWith('xxx')), { label: 'baris panjang' });
    expect(long).toBe(`${'x'.repeat(MAX_LINE_LENGTH)} …[dipotong]`);
  });

  it('INT-SUP-007 server dibunuh paksa (SIGKILL, tanpa shutdown) → child mendeteksi kanal IPC putus dan berhenti sendiri (heartbeat akhir stopped, tanpa yatim)', async () => {
    const parent = spawn(process.execPath, [PARENT], {
      env: { ...process.env, DATABASE_PATH: join(dir, 'sup.db') }, stdio: ['ignore', 'pipe', 'inherit'],
    });
    try {
      let out = '';
      parent.stdout.setEncoding('utf8');
      parent.stdout.on('data', (chunk) => { out += chunk; });
      const workerPid = await waitFor(() => {
        const line = out.split('\n').find((l) => l.startsWith('{'));
        return line ? JSON.parse(line).workerPid : null;
      }, { label: 'pid worker dari proses induk' });
      expect(isAlive(workerPid)).toBe(true);
      parent.kill('SIGKILL');
      await waitFor(() => !isAlive(workerPid), { label: 'worker berhenti setelah induk mati' });
      expect((await ingestion.getStatus()).heartbeat.state.state).toBe('stopped');
    } finally {
      parent.kill('SIGKILL');
    }
  });

  it('INT-SUP-005 skrip yang tidak ada → node keluar kode 1 → crashed, error tampil di log server', async () => {
    supervisor = createWorkerSupervisor({ scriptPath: join(dir, 'tidak-ada.js'), output: (l) => lines.push(l) });
    await supervisor.start().catch(() => {});
    const crashed = await waitFor(async () => {
      const s = await supervisor.status();
      return s.state === 'crashed' ? s : null;
    }, { label: 'crash' });
    expect(crashed.exitCode).toBe(1);
    expect(lines.some((l) => /Cannot find module/.test(l))).toBe(true);
  });
});

describe('buildApp + worker tiruan nyata', () => {
  let dir;
  let app;
  let db;
  const savedEnv = process.env.WORKER_STUB_HEARTBEAT;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lr-sup-app-'));
    // Env proses server diwariskan ke child (bersama DATABASE_PATH dari konfigurasi).
    process.env.WORKER_STUB_HEARTBEAT = '1';
  });

  afterEach(async () => {
    await app?.close();
    app = null;
    if (savedEnv === undefined) delete process.env.WORKER_STUB_HEARTBEAT;
    else process.env.WORKER_STUB_HEARTBEAT = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it('INT-SUP-006 tombol start lewat API menjalankan child yang menulis ke DATABASE_PATH server; app.close() menghentikan child (tanpa yatim)', async () => {
    const dbPath = join(dir, 'app.db');
    const config = loadConfig({ NODE_ENV: 'test', APP_ORIGIN: TEST_ORIGIN, LOG_LEVEL: 'silent', DATABASE_PATH: dbPath, WORKER_CONTROL: 'true' });
    db = openDatabase(dbPath);
    app = await buildApp({ config, db, hasherOptions: TEST_HASHER_OPTIONS, workerScriptPath: STUB });
    app.addHook('onClose', async () => db.close());
    const { repos, hasher } = app.services;
    await createUser({ users: repos.users, audit: repos.audit, hasher, maxUsers: config.maxUsers, clock: Date.now }, ADMIN);
    const auth = await login(app);

    const res = await postWorker(app, 'start', auth);
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('running');
    const status = await waitFor(async () => {
      const s = (await app.inject({ url: '/api/system/status', headers: { cookie: auth.cookie } })).json();
      return s.scanner.status === 'ok' ? s : null;
    }, { label: 'heartbeat child di database server' });
    expect(status.workerControl.state).toBe('running');

    await app.close();
    app = null;
    // Database server sudah ditutup; heartbeat akhir child dibaca lewat koneksi baru.
    const check = openDatabase(dbPath);
    try {
      expect((await createIngestionStateRepository(check).getStatus()).heartbeat.state.state).toBe('stopped');
    } finally {
      check.close();
    }
  });
});
