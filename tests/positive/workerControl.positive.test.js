import { afterEach, describe, expect, it } from 'vitest';
import { WORKER_SCRIPT_PATH } from '../../backend/system/workerSupervisor.js';
import { createFakeFork, flush } from '../helpers/fakeFork.js';
import { ANALYST, createTestApp, login } from '../helpers/testApp.js';
import { createWorkerTestApp, getWorker, postWorker, workerAudit } from '../helpers/workerTestApp.js';

const STOPPED = { enabled: true, state: 'stopped', startedAt: null, stoppedAt: null, exitCode: null, signal: null };

describe('kontrol scanner dari website — alur positif', () => {
  let ctx;
  afterEach(async () => { await ctx?.app.close(); ctx = null; });

  it('POS-SUP-001 GET /api/system/worker untuk admin & analyst: state awal stopped', async () => {
    ctx = await createWorkerTestApp();
    for (const user of [undefined, ANALYST]) {
      const auth = await login(ctx.app, user);
      const res = await getWorker(ctx.app, auth);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(STOPPED);
    }
  });

  it('POS-SUP-002 admin start → 200 running; fork worker/index.js; audit worker.start success; status sistem ikut berubah', async () => {
    ctx = await createWorkerTestApp();
    const auth = await login(ctx.app);
    const res = await postWorker(ctx.app, 'start', auth);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ...STOPPED, state: 'running', startedAt: ctx.clock() });
    expect(ctx.fork.calls).toHaveLength(1);
    expect(ctx.fork.calls[0].scriptPath).toBe(WORKER_SCRIPT_PATH);
    expect(ctx.fork.calls[0].args).toEqual([]);

    const [audit] = await workerAudit(ctx.app);
    const admin = ctx.db.prepare("SELECT id FROM users WHERE username = 'mary'").get();
    expect(audit).toMatchObject({ action: 'worker.start', outcome: 'success', user_id: admin.id, ip_address: '127.0.0.1', detail: { state: 'running' } });

    expect((await getWorker(ctx.app, auth)).json().state).toBe('running');
    const status = (await ctx.app.inject({ url: '/api/system/status', headers: { cookie: auth.cookie } })).json();
    expect(status.workerControl).toEqual({ ...STOPPED, state: 'running', startedAt: ctx.clock() });
  });

  it('POS-SUP-003 admin stop → 200 stopping (SIGTERM); setelah child keluar → stopped; audit worker.stop success', async () => {
    ctx = await createWorkerTestApp({ fork: createFakeFork() });
    const auth = await login(ctx.app);
    await postWorker(ctx.app, 'start', auth);
    const child = ctx.fork.last();
    ctx.clock.advance(60_000);
    const res = await postWorker(ctx.app, 'stop', auth);
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('stopping');
    expect(child.signals).toEqual(['SIGTERM']);
    child.exit(0);
    await flush();
    expect((await getWorker(ctx.app, auth)).json()).toMatchObject({ state: 'stopped', exitCode: 0, signal: null, stoppedAt: ctx.clock() });
    const [audit] = await workerAudit(ctx.app);
    expect(audit).toMatchObject({ action: 'worker.stop', outcome: 'success', detail: { state: 'stopping' } });
  });

  it('POS-SUP-004 /api/system/status memuat workerControl; default lingkungan test: kontrol nonaktif', async () => {
    ctx = await createTestApp();
    const auth = await login(ctx.app);
    const status = (await ctx.app.inject({ url: '/api/system/status', headers: { cookie: auth.cookie } })).json();
    expect(status.workerControl).toEqual({ ...STOPPED, enabled: false });
    expect((await getWorker(ctx.app, auth)).json()).toEqual({ ...STOPPED, enabled: false });
  });

  it('POS-SUP-005 WORKER_AUTOSTART=true → worker dijalankan saat server siap; audit tanpa user (via autostart)', async () => {
    ctx = await createWorkerTestApp({ env: { WORKER_AUTOSTART: 'true' } });
    await ctx.app.ready();
    expect(ctx.fork.calls).toHaveLength(1);
    const auth = await login(ctx.app);
    expect((await getWorker(ctx.app, auth)).json().state).toBe('running');
    const [audit] = await workerAudit(ctx.app);
    expect(audit).toMatchObject({ action: 'worker.start', outcome: 'success', user_id: null, detail: { via: 'autostart', state: 'running' } });
  });

  it('POS-SUP-006 app.close() (shutdown server) menghentikan worker lebih dulu: SIGTERM dan menunggu exit', async () => {
    ctx = await createWorkerTestApp();
    const auth = await login(ctx.app);
    await postWorker(ctx.app, 'start', auth);
    const child = ctx.fork.last();
    let exited = false;
    child.once('exit', () => { exited = true; });
    await ctx.app.close();
    ctx = null;
    expect(child.signals).toEqual(['SIGTERM']);
    expect(exited).toBe(true);
  });

  it('POS-SUP-007 server restart setelah worker miliknya mati tanpa heartbeat akhir (pid di heartbeat sudah tidak hidup) → state stopped, WORKER_AUTOSTART tetap menjalankan worker', async () => {
    const DEAD = 4_242;
    ctx = await createWorkerTestApp({
      env: { WORKER_AUTOSTART: 'true' },
      supervisorOptions: { hostname: 'host-a', isPidAlive: (pid) => pid !== DEAD },
    });
    // Heartbeat "degraded" 10 detik lalu dari worker yang mati karena SIGHUP/SIGKILL (tanpa heartbeat 'stopped').
    await ctx.app.services.repos.ingestion.heartbeat({
      at: ctx.clock() - 10_000, state: { state: 'degraded', owner: { pid: DEAD, host: 'host-a' } },
    });
    await ctx.app.ready();
    expect(ctx.fork.calls).toHaveLength(1);
    const auth = await login(ctx.app);
    expect((await getWorker(ctx.app, auth)).json().state).toBe('running');
    const [audit] = await workerAudit(ctx.app);
    expect(audit).toMatchObject({ action: 'worker.start', outcome: 'success', detail: { via: 'autostart', state: 'running' } });
  });

  it('POS-SUP-008 heartbeat segar dari pid yang sudah mati → GET stopped dan admin dapat menjalankan scanner (bukan 409 WORKER_EXTERNAL)', async () => {
    ctx = await createWorkerTestApp({ supervisorOptions: { hostname: 'host-a', isPidAlive: () => false } });
    await ctx.app.services.repos.ingestion.heartbeat({ at: ctx.clock() - 5_000, state: { state: 'running', owner: { pid: 999_999, host: 'host-a' } } });
    const auth = await login(ctx.app);
    expect((await getWorker(ctx.app, auth)).json().state).toBe('stopped');
    expect((await postWorker(ctx.app, 'start', auth)).statusCode).toBe(200);
  });
});
