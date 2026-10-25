import { isAbsolute } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HEARTBEAT_STALE_MS } from '../../../backend/system/workerStatus.js';
import {
  MAX_LINE_LENGTH, RESTART_COOLDOWN_MS, STOP_TIMEOUT_MS, WORKER_SCRIPT_PATH, WorkerSupervisorError, createLineForwarder,
  createWorkerSupervisor, isProcessAlive,
} from '../../../backend/system/workerSupervisor.js';
import { createFakeFork, createManualTimers, flush } from '../../helpers/fakeFork.js';
import { createClock } from '../../helpers/testApp.js';

const SCRIPT = '/opt/alphalens/worker/index.js';

function setup({ heartbeat = null, fork = createFakeFork(), stopTimeoutMs = 15_000, startTimeoutMs = 10_000, env = { DATABASE_PATH: '/tmp/x.db' }, maxLineLength, ...extra } = {}) {
  const clock = createClock();
  const timers = createManualTimers();
  const lines = [];
  const logs = [];
  const state = { heartbeat };
  const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map((level) => [level, (fields, msg) => logs.push({ level, fields, msg })]));
  const supervisor = createWorkerSupervisor({
    fork, scriptPath: SCRIPT, env, clock, logger, stopTimeoutMs, startTimeoutMs, maxLineLength,
    readExternalHeartbeat: async () => (typeof state.heartbeat === 'function' ? state.heartbeat() : state.heartbeat),
    output: (line) => lines.push(line),
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    ...extra,
  });
  return { supervisor, fork, clock, timers, lines, logs, state };
}

async function expectCode(promise, code, statusCode) {
  const err = await promise.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(WorkerSupervisorError);
  expect(err.code).toBe(code);
  expect(err.statusCode).toBe(statusCode);
}

describe('supervisor worker — transisi state', () => {
  it('UNIT-SUP-001 stopped → starting → running: fork skrip tetap, argv kosong, IPC + pipe, execArgv kosong', async () => {
    const { supervisor, fork, clock } = setup({ fork: createFakeFork({ autoSpawn: false }) });
    expect((await supervisor.status()).state).toBe('stopped');
    const started = supervisor.start();
    expect((await supervisor.status()).state).toBe('starting');
    await flush();
    expect(fork.calls).toHaveLength(1);
    const [{ scriptPath, args, options }] = fork.calls;
    expect(scriptPath).toBe(SCRIPT);
    expect(args).toEqual([]);
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe', 'ipc']);
    expect(options.execArgv).toEqual([]);
    expect(options.env).toEqual({ DATABASE_PATH: '/tmp/x.db' });
    fork.last().emit('spawn');
    const status = await started;
    expect(status).toEqual({ state: 'running', startedAt: clock(), stoppedAt: null, exitCode: null, signal: null });
  });

  it('UNIT-SUP-002 running → stopping (SIGTERM) → stopped saat child keluar; stop({ wait: false }) langsung mengembalikan stopping', async () => {
    const { supervisor, fork, clock, timers } = setup();
    await supervisor.start();
    const child = fork.last();
    const res = await supervisor.stop({ wait: false });
    expect(res.state).toBe('stopping');
    expect(child.signals).toEqual(['SIGTERM']);
    expect(timers.pending()).toEqual([15_000]);
    clock.advance(1_000);
    const done = supervisor.stop();
    child.exit(0, null);
    expect(await done).toMatchObject({ state: 'stopped', exitCode: 0, signal: null, stoppedAt: clock() });
    expect(timers.pending()).toEqual([]);
    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('UNIT-SUP-003 start ganda ditolak 409 (saat starting, running, dan dua panggilan bersamaan); hanya satu fork', async () => {
    const { supervisor, fork } = setup({ fork: createFakeFork({ autoSpawn: false }) });
    const first = supervisor.start();
    await expectCode(supervisor.start(), 'WORKER_ALREADY_RUNNING', 409);
    await flush();
    fork.last().emit('spawn');
    await first;
    await expectCode(supervisor.start(), 'WORKER_ALREADY_RUNNING', 409);
    expect(fork.calls).toHaveLength(1);
  });

  it('UNIT-SUP-004 start saat stopping → 409 WORKER_STOPPING; stop saat starting → 409 WORKER_STARTING', async () => {
    const { supervisor, fork } = setup({ fork: createFakeFork({ autoSpawn: false }) });
    const started = supervisor.start();
    await expectCode(supervisor.stop(), 'WORKER_STARTING', 409);
    await flush();
    fork.last().emit('spawn');
    await started;
    await supervisor.stop({ wait: false });
    await expectCode(supervisor.start(), 'WORKER_STOPPING', 409);
    // stop kedua saat stopping bergabung dengan proses berhenti yang sama (idempoten).
    const again = supervisor.stop();
    fork.last().exit(0);
    expect((await again).state).toBe('stopped');
    expect(fork.last().signals).toEqual(['SIGTERM']);
  });

  it('UNIT-SUP-005 stop tanpa worker → 409 WORKER_NOT_RUNNING', async () => {
    const { supervisor } = setup();
    await expectCode(supervisor.stop(), 'WORKER_NOT_RUNNING', 409);
  });

  it('UNIT-SUP-006 child tidak keluar setelah SIGTERM → SIGKILL setelah stopTimeoutMs → stopped (signal SIGKILL)', async () => {
    const { supervisor, fork, timers, logs } = setup({ stopTimeoutMs: 15_000 });
    await supervisor.start();
    const child = fork.last();
    const done = supervisor.stop();
    expect(child.signals).toEqual(['SIGTERM']);
    timers.fire(15_000);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(logs.some((l) => l.level === 'warn' && /SIGKILL/.test(l.msg))).toBe(true);
    child.exit(null, 'SIGKILL');
    expect(await done).toMatchObject({ state: 'stopped', exitCode: null, signal: 'SIGKILL' });
  });

  it('UNIT-SUP-007 batas stop default 15 detik', () => {
    expect(STOP_TIMEOUT_MS).toBe(15_000);
    expect(isAbsolute(WORKER_SCRIPT_PATH)).toBe(true);
    expect(WORKER_SCRIPT_PATH.endsWith('/worker/index.js')).toBe(true);
  });

  it.each([
    ['kode keluar 1', 1, null, 'crashed'],
    ['sinyal SIGSEGV', null, 'SIGSEGV', 'crashed'],
    ['keluar sendiri kode 0 (mis. Ctrl+C di terminal npm start)', 0, null, 'stopped'],
  ])('UNIT-SUP-008 child keluar tanpa diminta (%s) → %s; start ulang diizinkan setelah jeda', async (_label, code, signal, expected) => {
    const { supervisor, fork, logs, clock } = setup();
    await supervisor.start();
    fork.last().exit(code, signal);
    const status = await supervisor.status();
    expect(status).toMatchObject({ state: expected, exitCode: code, signal });
    if (expected === 'crashed') expect(logs.some((l) => l.level === 'error' && /tak terduga/.test(l.msg))).toBe(true);
    clock.advance(RESTART_COOLDOWN_MS);
    expect((await supervisor.start()).state).toBe('running');
    expect(fork.calls).toHaveLength(2);
    expect((await supervisor.status()).exitCode).toBeNull();
  });
});

describe('supervisor worker — worker di luar website', () => {
  it('UNIT-SUP-009 heartbeat segar tanpa child milik server → external; start & stop ditolak 409 tanpa fork', async () => {
    const ctx = setup();
    ctx.state.heartbeat = { at: ctx.clock() - 5_000, state: { state: 'running' } };
    expect((await ctx.supervisor.status()).state).toBe('external');
    await expectCode(ctx.supervisor.start(), 'WORKER_EXTERNAL', 409);
    await expectCode(ctx.supervisor.stop(), 'WORKER_EXTERNAL', 409);
    expect(ctx.fork.calls).toHaveLength(0);
    // State internal kembali 'stopped' (bukan tertahan di 'starting').
    ctx.state.heartbeat = null;
    expect((await ctx.supervisor.status()).state).toBe('stopped');
  });

  it.each([
    ['heartbeat basi', (now) => ({ at: now - HEARTBEAT_STALE_MS - 1, state: { state: 'running' } })],
    ['heartbeat akhir stopped', (now) => ({ at: now, state: { state: 'stopped' } })],
    ['tanpa heartbeat', () => null],
  ])('UNIT-SUP-010 %s → bukan external, start diizinkan', async (_label, make) => {
    const ctx = setup();
    ctx.state.heartbeat = make(ctx.clock());
    expect((await ctx.supervisor.status()).state).toBe('stopped');
    expect((await ctx.supervisor.start()).state).toBe('running');
  });

  it('UNIT-SUP-011 heartbeat "running" yang ditinggalkan child milik server (dibunuh sebelum heartbeat akhir) bukan external', async () => {
    const ctx = setup();
    await ctx.supervisor.start();
    ctx.clock.advance(10_000);
    ctx.state.heartbeat = { at: ctx.clock(), state: { state: 'running' } };
    ctx.clock.advance(1_000);
    ctx.fork.last().exit(null, 'SIGKILL');
    expect((await ctx.supervisor.status()).state).toBe('crashed');
    ctx.clock.advance(RESTART_COOLDOWN_MS);
    expect((await ctx.supervisor.start()).state).toBe('running');
  });

  it('UNIT-SUP-012 heartbeat yang ditulis SETELAH child milik server keluar → worker lain → external', async () => {
    const ctx = setup({ fork: createFakeFork({ gracefulExit: true }) });
    await ctx.supervisor.start();
    await ctx.supervisor.stop();
    ctx.clock.advance(RESTART_COOLDOWN_MS);
    ctx.state.heartbeat = { at: ctx.clock(), state: { state: 'starting' } };
    expect((await ctx.supervisor.status()).state).toBe('external');
    await expectCode(ctx.supervisor.start(), 'WORKER_EXTERNAL', 409);
  });

  it('UNIT-SUP-013 heartbeat yang diberikan pemanggil dipakai tanpa membaca ulang; gagal baca: status aman, start ditolak', async () => {
    const ctx = setup();
    let reads = 0;
    ctx.state.heartbeat = () => { reads += 1; throw new Error('database terkunci'); };
    expect((await ctx.supervisor.status({ heartbeat: { at: ctx.clock(), state: { state: 'running' } } })).state).toBe('external');
    expect(reads).toBe(0);
    expect((await ctx.supervisor.status()).state).toBe('stopped');
    expect(reads).toBe(1);
    await expect(ctx.supervisor.start()).rejects.toThrow('database terkunci');
    expect(ctx.fork.calls).toHaveLength(0);
    ctx.state.heartbeat = null;
    expect((await ctx.supervisor.status()).state).toBe('stopped');
  });
});

describe('supervisor worker — kegagalan spawn', () => {
  it('UNIT-SUP-014 fork melempar → 500 WORKER_SPAWN_FAILED, state crashed', async () => {
    const fork = () => { throw new Error('EAGAIN'); };
    const { supervisor } = setup({ fork });
    await expectCode(supervisor.start(), 'WORKER_SPAWN_FAILED', 500);
    expect((await supervisor.status()).state).toBe('crashed');
  });

  it('UNIT-SUP-015 event error sebelum spawn → crashed & start ditolak; error berulang setelah spawn tidak menjatuhkan server', async () => {
    const fork = createFakeFork({ autoSpawn: false });
    const { supervisor } = setup({ fork });
    const started = supervisor.start();
    await flush();
    fork.last().emit('error', new Error('spawn ENOENT'));
    await expectCode(started, 'WORKER_SPAWN_FAILED', 500);
    expect((await supervisor.status()).state).toBe('crashed');

    const again = supervisor.start();
    await flush();
    fork.last().emit('spawn');
    await again;
    expect(() => {
      fork.last().emit('error', new Error('kill EPERM'));
      fork.last().emit('error', new Error('kill EPERM'));
    }).not.toThrow();
    expect((await supervisor.status()).state).toBe('running');
  });

  it('UNIT-SUP-016 tidak ada event spawn dalam startTimeoutMs → SIGKILL & start ditolak', async () => {
    const fork = createFakeFork({ autoSpawn: false });
    const { supervisor, timers } = setup({ fork, startTimeoutMs: 10_000 });
    const started = supervisor.start();
    await flush();
    timers.fire(10_000);
    await expectCode(started, 'WORKER_SPAWN_FAILED', 500);
    expect(fork.last().signals).toEqual(['SIGKILL']);
    expect((await supervisor.status())).toMatchObject({ state: 'crashed', signal: 'SIGKILL' });
    // 'exit' yang datang terlambat dari child lama diabaikan.
    fork.last().exit(null, 'SIGKILL');
    expect((await supervisor.status()).state).toBe('crashed');
  });

  it('UNIT-SUP-017 child keluar sebelum spawn (mis. skrip error saat dimuat) → start ditolak, crashed dengan kode keluar', async () => {
    const fork = createFakeFork({ autoSpawn: false });
    const { supervisor } = setup({ fork });
    const started = supervisor.start();
    await flush();
    fork.last().exit(1, null);
    await expectCode(started, 'WORKER_SPAWN_FAILED', 500);
    expect(await supervisor.status()).toMatchObject({ state: 'crashed', exitCode: 1 });
  });

  it('UNIT-SUP-018 scriptPath wajib absolut; opsi batas waktu divalidasi', () => {
    expect(() => createWorkerSupervisor({ scriptPath: 'worker/index.js' })).toThrow(TypeError);
    expect(() => createWorkerSupervisor({ scriptPath: '' })).toThrow(TypeError);
    expect(() => createWorkerSupervisor({ scriptPath: SCRIPT, stopTimeoutMs: 0 })).toThrow(RangeError);
    expect(() => createWorkerSupervisor({ scriptPath: SCRIPT, fork: 'fork' })).toThrow(TypeError);
  });

  it('UNIT-SUP-019 env child adalah snapshot saat supervisor dibuat', async () => {
    const env = { DATABASE_PATH: '/tmp/a.db' };
    const { supervisor, fork } = setup({ env });
    env.DATABASE_PATH = '/tmp/lain.db';
    env.INJECTED = '1';
    await supervisor.start();
    expect(fork.calls[0].options.env).toEqual({ DATABASE_PATH: '/tmp/a.db' });
  });
});

describe('supervisor worker — shutdown server', () => {
  it('UNIT-SUP-020 shutdown menghentikan child (SIGTERM, menunggu exit) dan menolak start berikutnya (503)', async () => {
    const { supervisor, fork } = setup({ fork: createFakeFork({ gracefulExit: true }) });
    await supervisor.start();
    const child = fork.last();
    await supervisor.shutdown();
    expect(child.signals).toEqual(['SIGTERM']);
    expect((await supervisor.status()).state).toBe('stopped');
    await expectCode(supervisor.start(), 'WORKER_SHUTTING_DOWN', 503);
    await supervisor.shutdown();
    expect(fork.calls).toHaveLength(1);
  });

  it('UNIT-SUP-021 shutdown saat starting menunggu spawn lalu menghentikan child', async () => {
    const fork = createFakeFork({ autoSpawn: false, gracefulExit: true });
    const { supervisor } = setup({ fork });
    const started = supervisor.start();
    await flush();
    const closing = supervisor.shutdown();
    fork.last().emit('spawn');
    await started;
    await closing;
    expect(fork.last().signals).toEqual(['SIGTERM']);
    expect((await supervisor.status()).state).toBe('stopped');
  });

  it('UNIT-SUP-022 shutdown selama pembacaan heartbeat → start dibatalkan tanpa fork', async () => {
    const ctx = setup();
    let release;
    ctx.state.heartbeat = () => new Promise((resolve) => { release = () => resolve(null); });
    const started = ctx.supervisor.start();
    await flush();
    const closing = ctx.supervisor.shutdown();
    release();
    ctx.state.heartbeat = null;
    await expectCode(started, 'WORKER_SHUTTING_DOWN', 503);
    await closing;
    expect(ctx.fork.calls).toHaveLength(0);
    expect((await ctx.supervisor.status()).state).toBe('stopped');
  });

  it('UNIT-SUP-023 killChild mengirim sinyal sinkron; tanpa child → false', async () => {
    const { supervisor, fork } = setup();
    expect(supervisor.killChild('SIGTERM')).toBe(false);
    await supervisor.start();
    expect(supervisor.killChild('SIGTERM')).toBe(true);
    expect(supervisor.killChild()).toBe(true);
    expect(fork.last().signals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});

describe('supervisor worker — log child', () => {
  it('UNIT-SUP-024 baris stdout & stderr child diteruskan utuh, termasuk baris yang terbelah antar-chunk', async () => {
    const { supervisor, fork, lines } = setup();
    await supervisor.start();
    const child = fork.last();
    child.stdout.write('{"level":"info","msg":"worker scanner mulai"}\n{"level":"in');
    child.stdout.write('fo","msg":"status"}\n');
    child.stderr.write('Konfigurasi tidak valid: PORT\n');
    await flush();
    expect(lines).toEqual(['{"level":"info","msg":"worker scanner mulai"}', '{"level":"info","msg":"status"}', 'Konfigurasi tidak valid: PORT']);
    child.stdout.write('baris terakhir tanpa newline');
    child.exit(0);
    await flush();
    expect(lines.at(-1)).toBe('baris terakhir tanpa newline');
  });

  it('UNIT-SUP-025 baris terlalu panjang dipotong (+ penanda) dan sisanya dibuang sampai newline; baris berikutnya normal', async () => {
    const { supervisor, fork, lines } = setup({ maxLineLength: 100 });
    await supervisor.start();
    const child = fork.last();
    for (let i = 0; i < 50; i += 1) child.stdout.write('y'.repeat(1_000));
    child.stdout.write('ekor\nbaris normal\n');
    await flush();
    expect(lines).toEqual([`${'y'.repeat(100)} …[dipotong]`, 'baris normal']);
  });

  it('UNIT-SUP-026 createLineForwarder: CRLF & karakter kontrol dibuang, baris kosong dilewati, batas default 16 KiB', () => {
    const out = [];
    const fwd = createLineForwarder((l) => out.push(l));
    fwd.push('a\r\n\n\u001b[31mmerah\u001b[0m\tok\n');
    fwd.push(`${'z'.repeat(MAX_LINE_LENGTH)}\n`);
    fwd.push(`${'z'.repeat(MAX_LINE_LENGTH + 1)}\nsesudah`);
    fwd.flush();
    expect(out[0]).toBe('a');
    expect(out[1]).toBe('[31mmerah[0m\tok');
    expect(out[2]).toHaveLength(MAX_LINE_LENGTH);
    expect(out[3]).toBe(`${'z'.repeat(MAX_LINE_LENGTH)} …[dipotong]`);
    expect(out[4]).toBe('sesudah');
    expect(out).toHaveLength(5);
    expect(() => createLineForwarder(() => {}, 0)).toThrow(RangeError);
  });
});

describe('supervisor worker — jeda start ulang (temuan review)', () => {
  it('UNIT-SUP-027 child yang sudah berjalan lalu keluar (stop maupun crash) → start ulang < 10 detik ditolak 429 WORKER_COOLDOWN; tepat 10 detik diizinkan', async () => {
    expect(RESTART_COOLDOWN_MS).toBe(10_000);
    const { supervisor, fork, clock } = setup({ fork: createFakeFork({ gracefulExit: true }) });
    await supervisor.start();
    await supervisor.stop();
    clock.advance(RESTART_COOLDOWN_MS - 1);
    const err = await supervisor.start().then(() => null, (e) => e);
    expect(err).toBeInstanceOf(WorkerSupervisorError);
    expect(err).toMatchObject({ code: 'WORKER_COOLDOWN', statusCode: 429, retryAfterMs: 1 });
    expect(err.message).toMatch(/Tunggu/);
    // Penolakan tidak meninggalkan state 'starting'.
    expect((await supervisor.status()).state).toBe('stopped');
    expect(fork.calls).toHaveLength(1);
    clock.advance(1);
    expect((await supervisor.start()).state).toBe('running');

    // Crash juga memicu jeda (restart loop lewat crash tetap dibatasi).
    fork.last().exit(1, null);
    await expectCode(supervisor.start(), 'WORKER_COOLDOWN', 429);
    clock.advance(RESTART_COOLDOWN_MS);
    expect((await supervisor.start()).state).toBe('running');
    expect(fork.calls).toHaveLength(3);
  });

  it('UNIT-SUP-028 spawn gagal (child tidak pernah berjalan) tidak memicu jeda; restartCooldownMs: 0 menonaktifkan jeda; nilai tidak valid ditolak', async () => {
    const fork = createFakeFork({ autoSpawn: false });
    const { supervisor } = setup({ fork });
    const started = supervisor.start();
    await flush();
    fork.last().exit(1, null);
    await expectCode(started, 'WORKER_SPAWN_FAILED', 500);
    const again = supervisor.start();
    await flush();
    fork.last().emit('spawn');
    expect((await again).state).toBe('running');

    const nocool = setup({ fork: createFakeFork({ gracefulExit: true }), restartCooldownMs: 0 });
    await nocool.supervisor.start();
    await nocool.supervisor.stop();
    expect((await nocool.supervisor.start()).state).toBe('running');

    for (const restartCooldownMs of [-1, 1.5, '10000', Number.NaN]) {
      expect(() => createWorkerSupervisor({ scriptPath: SCRIPT, restartCooldownMs })).toThrow(RangeError);
    }
  });
});

describe('supervisor worker — heartbeat milik worker yang sudah mati (temuan review)', () => {
  const HOST = 'host-alphalens';
  const beat = (clock, owner) => ({ at: clock() - 10_000, state: { state: 'degraded', owner } });

  it('UNIT-SUP-029 heartbeat segar dengan owner.pid yang tidak hidup lagi (host sama) → bukan external; start diizinkan', async () => {
    const alive = new Set();
    const checked = [];
    const ctx = setup({ hostname: HOST, isPidAlive: (pid) => { checked.push(pid); return alive.has(pid); } });
    ctx.state.heartbeat = beat(ctx.clock, { pid: 4242, host: HOST });
    expect((await ctx.supervisor.status()).state).toBe('stopped');
    expect(checked).toEqual([4242]);
    // Proses dengan pid itu masih hidup → tetap dianggap worker di luar website.
    alive.add(4242);
    expect((await ctx.supervisor.status()).state).toBe('external');
    await expectCode(ctx.supervisor.start(), 'WORKER_EXTERNAL', 409);
    alive.delete(4242);
    expect((await ctx.supervisor.start()).state).toBe('running');
    expect(ctx.fork.calls).toHaveLength(1);
  });

  it.each([
    ['host lain (pid tidak dapat diperiksa dari sini)', { pid: 4242, host: 'host-lain' }],
    ['tanpa owner (worker versi lama / heartbeat manual)', undefined],
    ['pid 0 (grup proses)', { pid: 0, host: HOST }],
    ['pid negatif', { pid: -1, host: HOST }],
    ['pid bukan bilangan bulat', { pid: 42.5, host: HOST }],
    ['pid berupa string', { pid: '4242', host: HOST }],
  ])('UNIT-SUP-030 %s → pid tidak diperiksa, tetap external (aman: tidak menjalankan worker kedua)', async (_label, owner) => {
    const checked = [];
    const ctx = setup({ hostname: HOST, isPidAlive: (pid) => { checked.push(pid); return false; } });
    ctx.state.heartbeat = beat(ctx.clock, owner);
    expect((await ctx.supervisor.status()).state).toBe('external');
    expect(checked).toEqual([]);
  });

  it('UNIT-SUP-031 isProcessAlive: proses sendiri hidup; ESRCH → mati; EPERM (milik pengguna lain) → hidup; pid ≤ 0 tidak pernah dikirimi sinyal', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    const kill = process.kill;
    const calls = [];
    try {
      process.kill = (pid, signal) => {
        calls.push([pid, signal]);
        throw Object.assign(new Error('x'), { code: pid === 7 ? 'ESRCH' : 'EPERM' });
      };
      expect(isProcessAlive(7)).toBe(false);
      expect(isProcessAlive(8)).toBe(true);
      expect(isProcessAlive(0)).toBe(false);
      expect(isProcessAlive(-1)).toBe(false);
    } finally {
      process.kill = kill;
    }
    expect(calls).toEqual([[7, 0], [8, 0]]);
  });

  it.each([
    ['zombie (Z: sudah keluar, belum di-reap — mis. induknya ikut dibunuh)', false, 'Z'],
    ['dead (X)', false, 'X'],
    ['sleeping (S)', true, 'S'],
    ['running (R)', true, 'R'],
    ['/proc tidak tersedia (bukan Linux)', true, null],
  ])('UNIT-SUP-033 isProcessAlive: kill(pid, 0) berhasil + state /proc %s → hidup = %s', (_label, expected, st) => {
    const kill = process.kill;
    const read = [];
    try {
      process.kill = () => true;
      expect(isProcessAlive(4242, { readState: (pid) => { read.push(pid); return st; } })).toBe(expected);
    } finally {
      process.kill = kill;
    }
    expect(read).toEqual([4242]);
  });
});

describe('supervisor worker — sanitasi log child (temuan review)', () => {
  it('UNIT-SUP-032 kontrol C1 (CSI U+009B, ST U+009C, OSC U+009D, …) dan kontrol bidi dibuang; tab, teks non-ASCII biasa, dan penanda potong tetap', () => {
    const out = [];
    const fwd = createLineForwarder((l) => out.push(l), 200);
    fwd.push(`${JSON.stringify({ msg: 'sym\u009b2J\u009d0;pwned\u0007x‮' })}\n`);
    fwd.push('a\u0080b\u0085c\u009fd؜e‎f‏g‪h⁦i⁩j\tk\n');
    fwd.push('Rp 1.000 — «harga» é ✓\n');
    fwd.push(`${'q'.repeat(250)}\n`);
    const codePoints = (l) => [...l].map((c) => c.codePointAt(0));
    for (const line of out) {
      expect(codePoints(line).some((cp) => (cp >= 0x80 && cp <= 0x9f) || cp === 0x061c || cp === 0x200e || cp === 0x200f
        || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069))).toBe(false);
    }
    expect(out[0]).toBe('{"msg":"sym2J0;pwned\\u0007x"}');
    expect(out[1]).toBe('abcdefghij\tk');
    expect(out[2]).toBe('Rp 1.000 — «harga» é ✓');
    expect(out[3]).toBe(`${'q'.repeat(200)} …[dipotong]`);
  });
});
