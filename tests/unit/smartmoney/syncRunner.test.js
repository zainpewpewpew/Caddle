import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../../backend/database/connection.js';
import { migrate } from '../../../backend/database/migrate.js';
import { createFixtureProvider } from '../../../backend/smartmoney/providers/fixtureProvider.js';
import { createProviderRegistry } from '../../../backend/smartmoney/providers/registry.js';
import { createSmartMoneyRepository } from '../../../backend/smartmoney/repository.js';
import { SYNC_STATE_KEYS } from '../../../backend/smartmoney/sync.js';
import {
  DEFAULT_MANUAL_COOLDOWN_MS, FAILED_RUN_NOTE, SyncRunnerError, createSyncRunner, publicRun,
} from '../../../backend/smartmoney/syncRunner.js';
import { buildScenario } from '../../fixtures/smartmoney/scenario.js';

const MIN = 60_000;
const START = Date.UTC(2026, 9, 1, 12);
const ADAPTER = Object.freeze({ id: 'contoh', isSimulated: false });
const registryWith = (adapters) => ({ list: () => [...adapters], withCapability: () => [] });

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function setup({ runSync, adapters = [ADAPTER], ...rest } = {}) {
  const db = openDatabase(':memory:');
  migrate(db, { now: () => new Date(0) });
  let t = START;
  const clock = () => t;
  const repo = createSmartMoneyRepository(db, { clock });
  const calls = [];
  const logs = [];
  const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map((lvl) => [lvl, (fields, msg) => logs.push({ lvl, fields, msg })]));
  const runner = createSyncRunner({
    repo, registry: registryWith(adapters), config: { maxWalletsPerSync: 50 }, owner: 'server:1', clock, logger,
    runSync: async (deps) => {
      calls.push(deps);
      return runSync ? runSync(deps, calls.length) : { status: 'OK' };
    },
    ...rest,
  });
  return { db, repo, runner, calls, logs, clock, advance: (ms) => { t += ms; } };
}

const codeOf = async (promise) => {
  try {
    await promise;
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(SyncRunnerError);
    return err;
  }
};

describe('penjalan sinkronisasi smart money (syncRunner)', () => {
  it('UNIT-SM-RUN-001 sync manual: lease diambil, progres per tahap terbaca, lease dilepas saat selesai', async () => {
    const gate = deferred();
    const { repo, runner, calls, advance } = setup({
      runSync: async (deps) => {
        deps.onProgress({ phase: 'mapping', done: null, total: null });
        advance(2000);
        deps.onProgress({ phase: 'transfers', done: 0, total: 3 });
        deps.onProgress({ phase: 'transfers', done: 1, total: 3 }); // < 1 dtk sejak tulis terakhir: ditahan
        deps.onProgress({ phase: 'transfers', done: 3, total: 3 }); // akhir tahap: selalu ditulis
        await gate.promise;
        return { status: 'OK' };
      },
    });
    const { run } = await runner.start();
    expect(run).toMatchObject({ owner: 'server', trigger: 'manual', startedAt: START, phase: 'start' });
    await Promise.resolve();
    const during = await runner.status();
    expect(during.running).toBe(true);
    expect(during.run).toMatchObject({ owner: 'server', trigger: 'manual', phase: 'transfers', done: 3, total: 3 });
    expect(typeof calls[0].signal?.aborted).toBe('boolean');
    // Proses ini tidak menjalankan dua putaran sekaligus.
    expect((await codeOf(runner.start())).code).toBe('SYNC_RUNNING');
    gate.resolve();
    await runner.pending();
    expect(await repo.getSyncLease()).toBeNull();
    expect((await runner.status()).running).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('UNIT-SM-RUN-002 tanpa provider aktif → NO_PROVIDERS, tidak ada putaran maupun lease', async () => {
    const { repo, runner, calls } = setup({ adapters: [] });
    const err = await codeOf(runner.start());
    expect(err.code).toBe('NO_PROVIDERS');
    expect(err.message).toMatch(/ETHERSCAN_API_KEY/);
    expect(calls).toHaveLength(0);
    expect(await repo.getSyncLease()).toBeNull();
    expect(runner.providersActive()).toBe(0);
  });

  it('UNIT-SM-RUN-003 putaran terjadwal worker sedang berjalan → SYNC_RUNNING dengan progres worker', async () => {
    const { repo, runner, calls } = setup();
    await repo.acquireSyncLease({ owner: 'worker:77', trigger: 'schedule', ttlMs: 10 * MIN });
    await repo.renewSyncLease({ owner: 'worker:77', ttlMs: 10 * MIN, progress: { phase: 'discovery', done: 1, total: 4 } });
    const err = await codeOf(runner.start());
    expect(err.code).toBe('SYNC_RUNNING');
    expect(err.message).toMatch(/terjadwal/);
    expect(err.run).toMatchObject({ owner: 'worker', trigger: 'schedule', phase: 'discovery', done: 1, total: 4 });
    expect(JSON.stringify(err.run)).not.toContain('77'); // id proses tidak dibocorkan
    expect(calls).toHaveLength(0);
    expect(await runner.status()).toMatchObject({ running: true, run: { owner: 'worker' } });
  });

  it('UNIT-SM-RUN-004 jeda setelah putaran terakhir (proses mana pun) → SYNC_COOLDOWN dengan retryAfterMs', async () => {
    const { repo, runner, advance, clock } = setup();
    await repo.setSyncState(SYNC_STATE_KEYS.lastRun, { status: 'OK', startedAt: clock() - 5000, finishedAt: clock() }, { now: clock() });
    advance(10_000);
    const err = await codeOf(runner.start());
    expect(err.code).toBe('SYNC_COOLDOWN');
    expect(err.retryAfterMs).toBe(DEFAULT_MANUAL_COOLDOWN_MS - 10_000);
    expect((await runner.status()).cooldownUntil).toBe(clock() - 10_000 + DEFAULT_MANUAL_COOLDOWN_MS);
    advance(DEFAULT_MANUAL_COOLDOWN_MS);
    expect((await runner.start()).run.trigger).toBe('manual');
    await runner.pending();
    expect((await runner.status()).cooldownUntil).toBeNull(); // stub runSync tidak menulis lastRun baru
  });

  it('UNIT-SM-RUN-005 putaran gagal: dicatat (pesan disaring), lastRun FAILED, lease tetap dilepas, putaran terjadwal tetap bisa jalan', async () => {
    const { repo, runner, logs } = setup({
      runSync: (_deps, n) => {
        if (n === 1) throw new Error('gagal ke https://api.contoh.io/v2?apikey=RAHASIA');
        return { status: 'OK' };
      },
    });
    await runner.start();
    expect(await runner.pending()).toBeNull();
    expect(await repo.getSyncLease()).toBeNull();
    expect(JSON.stringify(logs)).not.toContain('RAHASIA');
    expect(logs.some((l) => l.lvl === 'error')).toBe(true);
    // lastRun jujur: FAILED + catatan generik (tanpa pesan error mentah), dan jeda berlaku.
    const last = (await repo.getSyncState(SYNC_STATE_KEYS.lastRun)).value;
    expect(last).toEqual({ status: 'FAILED', trigger: 'manual', startedAt: START, finishedAt: START, errors: [], notes: [FAILED_RUN_NOTE] });
    expect(JSON.stringify(last)).not.toContain('RAHASIA');
    expect((await codeOf(runner.start())).code).toBe('SYNC_COOLDOWN');
    expect((await runner.runNow({ trigger: 'schedule' })).summary).toEqual({ status: 'OK' });
  });

  it('UNIT-SM-RUN-006 stop() membatalkan putaran (AbortSignal) dan menunggu lease dilepas', async () => {
    const { repo, runner } = setup({
      runSync: (deps) => new Promise((resolve) => deps.signal.addEventListener('abort', () => resolve({ status: 'ABORTED' }))),
    });
    await runner.start();
    await runner.stop();
    expect(await repo.getSyncLease()).toBeNull();
    expect(runner.pending()).toBeNull();
    await runner.stop(); // aman dipanggil lagi
  });

  it('UNIT-SM-RUN-007 syncDeps berupa fungsi dibuat malas sekali; runNow melewati putaran bila lease milik proses lain', async () => {
    let made = 0;
    const { repo, runner, calls } = setup({ syncDeps: () => { made += 1; return { tuning: { marker: 1 } }; } });
    expect(made).toBe(0);
    await runner.runNow();
    await runner.runNow();
    expect(made).toBe(1);
    expect(calls.map((c) => c.tuning)).toEqual([{ marker: 1 }, { marker: 1 }]);
    await repo.acquireSyncLease({ owner: 'worker:5', trigger: 'schedule', ttlMs: MIN });
    expect(await runner.runNow()).toMatchObject({ skipped: true, run: { owner: 'worker', trigger: 'schedule' } });
    expect(calls).toHaveLength(2);
  });

  it('UNIT-SM-RUN-008 integrasi: runSmartMoneySync sungguhan + fixture (DATA SIMULASI) menulis lastRun dan melepas lease', async () => {
    const scenario = buildScenario();
    const db = openDatabase(':memory:');
    migrate(db, { now: () => new Date(0) });
    const clock = () => scenario.now;
    const repo = createSmartMoneyRepository(db, { clock });
    const fixture = createFixtureProvider(scenario);
    const registry = createProviderRegistry({ adapters: [fixture], enabledIds: [fixture.id] });
    const phases = [];
    const runner = createSyncRunner({
      repo, registry, config: { maxWalletsPerSync: 50 }, owner: 'server:1', clock,
      syncDeps: { tuning: { alertMaxEventAgeMs: 86_400_000 } },
      runSync: async (deps) => {
        const { runSmartMoneySync } = await import('../../../backend/smartmoney/sync.js');
        return runSmartMoneySync({ ...deps, onProgress: (p) => { phases.push(p.phase); deps.onProgress(p); } });
      },
    });
    await runner.start();
    const summary = await runner.pending();
    expect(summary.status).toBe('OK');
    expect([...new Set(phases)]).toEqual(['start', 'mapping', 'discovery', 'transfers', 'analysis', 'alerts']);
    expect((await repo.getSyncState(SYNC_STATE_KEYS.lastRun)).value.status).toBe('OK');
    expect(await repo.getSyncLease()).toBeNull();
    db.close();
  });

  it('UNIT-SM-RUN-010 detak lease: masa berlaku diperpanjang selama tahap lama tanpa progres, progres terakhir tetap', async () => {
    const gate = deferred();
    const { repo, runner, advance, clock } = setup({
      heartbeatMs: 5,
      runSync: async (deps) => {
        deps.onProgress({ phase: 'discovery', done: 1, total: 4 });
        await gate.promise;
        return { status: 'OK' };
      },
    });
    await runner.start();
    advance(90_000); // > separuh TTL tanpa progres
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    const lease = await repo.getSyncLease();
    expect(lease.expiresAt).toBe(clock() + 2 * MIN);
    expect(lease.progress).toMatchObject({ phase: 'discovery', done: 1, total: 4, updatedAt: START });
    gate.resolve();
    await runner.pending();
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(await repo.getSyncLease()).toBeNull(); // detak berhenti bersama putaran (tidak menghidupkan lease lagi)
  });

  it('UNIT-SM-RUN-011 dua klik serentak di satu proses → hanya satu putaran, yang lain SYNC_RUNNING', async () => {
    const gate = deferred();
    const { runner, calls } = setup({ runSync: async () => { await gate.promise; return { status: 'OK' }; } });
    const results = await Promise.allSettled([runner.start(), runner.start(), runner.start()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected.map((r) => r.reason.code)).toEqual(['SYNC_RUNNING', 'SYNC_RUNNING']);
    expect(rejected[0].reason.run).toMatchObject({ owner: 'server', trigger: 'manual' });
    gate.resolve();
    await runner.pending();
    expect(calls).toHaveLength(1);
  });

  it('UNIT-SM-RUN-009 publicRun: bentuk aman (owner server/worker tanpa pid), nilai rusak → null', () => {
    expect(publicRun(null)).toBeNull();
    expect(publicRun({ owner: 'worker:123', trigger: 'schedule', acquiredAt: 5, progress: { phase: 'alerts', done: 2, total: 2, updatedAt: 9 } }))
      .toEqual({ owner: 'worker', trigger: 'schedule', startedAt: 5, updatedAt: 9, phase: 'alerts', done: 2, total: 2 });
    expect(publicRun({ owner: 'server:1', trigger: 'aneh', acquiredAt: 'x', progress: { phase: 3, done: 1.5 } }))
      .toEqual({ owner: 'server', trigger: 'manual', startedAt: null, updatedAt: null, phase: 'start', done: null, total: null });
  });
});
