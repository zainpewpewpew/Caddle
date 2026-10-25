import { afterEach, describe, expect, it } from 'vitest';
import { createFakeFork } from '../helpers/fakeFork.js';
import { ANALYST, createTestApp, login } from '../helpers/testApp.js';
import { createWorkerTestApp, getWorker, postWorker, workerAudit } from '../helpers/workerTestApp.js';

const ROUTES = [['GET', '/api/system/worker'], ['POST', '/api/system/worker/start'], ['POST', '/api/system/worker/stop']];

describe('kontrol scanner dari website — alur negatif', () => {
  let ctx;
  afterEach(async () => { await ctx?.app.close(); ctx = null; });

  it.each(ROUTES)('NEG-SUP-001 %s %s tanpa sesi → 401, worker tidak dijalankan', async (method, url) => {
    ctx = await createWorkerTestApp();
    const res = await ctx.app.inject({ method, url });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('UNAUTHENTICATED');
    expect(ctx.fork.calls).toHaveLength(0);
  });

  it.each(['start', 'stop'])('NEG-SUP-002 analyst POST %s → 403 FORBIDDEN, worker tidak disentuh', async (action) => {
    ctx = await createWorkerTestApp();
    const admin = await login(ctx.app);
    if (action === 'stop') await postWorker(ctx.app, 'start', admin);
    const analyst = await login(ctx.app, ANALYST);
    const res = await postWorker(ctx.app, action, analyst);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('FORBIDDEN');
    expect(ctx.fork.calls).toHaveLength(action === 'stop' ? 1 : 0);
    if (action === 'stop') expect(ctx.fork.last().signals).toEqual([]);
  });

  it('NEG-SUP-003 start kedua saat berjalan → 409 WORKER_ALREADY_RUNNING; audit failure berisi alasan', async () => {
    ctx = await createWorkerTestApp();
    const auth = await login(ctx.app);
    expect((await postWorker(ctx.app, 'start', auth)).statusCode).toBe(200);
    const res = await postWorker(ctx.app, 'start', auth);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'WORKER_ALREADY_RUNNING', message: 'Scanner sudah berjalan.' });
    expect(ctx.fork.calls).toHaveLength(1);
    const [audit] = await workerAudit(ctx.app);
    expect(audit).toMatchObject({ action: 'worker.start', outcome: 'failure', detail: { reason: 'WORKER_ALREADY_RUNNING' } });
  });

  it('NEG-SUP-004 stop tanpa worker berjalan → 409 WORKER_NOT_RUNNING (audit failure)', async () => {
    ctx = await createWorkerTestApp();
    const auth = await login(ctx.app);
    const res = await postWorker(ctx.app, 'stop', auth);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('WORKER_NOT_RUNNING');
    const [audit] = await workerAudit(ctx.app);
    expect(audit).toMatchObject({ action: 'worker.stop', outcome: 'failure', detail: { reason: 'WORKER_NOT_RUNNING' } });
  });

  it('NEG-SUP-005 worker di luar website (heartbeat segar di database) → GET external; start & stop 409 WORKER_EXTERNAL tanpa fork', async () => {
    ctx = await createWorkerTestApp();
    await ctx.app.services.repos.ingestion.heartbeat({ at: ctx.clock() - 10_000, state: { state: 'running', ws: 'open' } });
    const auth = await login(ctx.app);
    expect((await getWorker(ctx.app, auth)).json().state).toBe('external');
    for (const action of ['start', 'stop']) {
      const res = await postWorker(ctx.app, action, auth);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('WORKER_EXTERNAL');
      expect(res.json().message).toMatch(/di luar website/);
    }
    expect(ctx.fork.calls).toHaveLength(0);
    const status = (await ctx.app.inject({ url: '/api/system/status', headers: { cookie: auth.cookie } })).json();
    expect(status.workerControl.state).toBe('external');
    expect(status.scanner.status).toBe('ok');
  });

  it('NEG-SUP-006 start saat worker sedang dihentikan → 409 WORKER_STOPPING', async () => {
    ctx = await createWorkerTestApp({ fork: createFakeFork() });
    const auth = await login(ctx.app);
    await postWorker(ctx.app, 'start', auth);
    expect((await postWorker(ctx.app, 'stop', auth)).json().state).toBe('stopping');
    const res = await postWorker(ctx.app, 'start', auth);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('WORKER_STOPPING');
    ctx.fork.last().exit(0);
  });

  it.each(['start', 'stop'])('NEG-SUP-007 kontrol nonaktif (default test/produksi) → POST %s 503 WORKER_CONTROL_DISABLED, audit failure', async (action) => {
    ctx = await createTestApp();
    const auth = await login(ctx.app);
    const res = await postWorker(ctx.app, action, auth);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'WORKER_CONTROL_DISABLED' });
    expect(res.json().message).toMatch(/WORKER_CONTROL=false/);
    expect((await getWorker(ctx.app, auth)).json()).toMatchObject({ enabled: false, state: 'stopped' });
    const [audit] = await workerAudit(ctx.app);
    expect(audit).toMatchObject({ action: `worker.${action}`, outcome: 'failure', detail: { reason: 'WORKER_CONTROL_DISABLED' } });
  });

  it('NEG-SUP-008 WORKER_AUTOSTART=true tanpa WORKER_CONTROL → diabaikan (tidak ada fork)', async () => {
    const fork = createFakeFork();
    ctx = await createWorkerTestApp({ fork, env: { WORKER_CONTROL: 'false', WORKER_AUTOSTART: 'true' } });
    await ctx.app.ready();
    expect(fork.calls).toHaveLength(0);
  });

  it('NEG-SUP-009 autostart saat worker lain sudah berjalan → dibatalkan & diaudit, server tetap siap', async () => {
    ctx = await createWorkerTestApp({ env: { WORKER_AUTOSTART: 'true' } });
    await ctx.app.services.repos.ingestion.heartbeat({ at: ctx.clock(), state: { state: 'running' } });
    await ctx.app.ready();
    expect(ctx.fork.calls).toHaveLength(0);
    const [audit] = await workerAudit(ctx.app);
    expect(audit).toMatchObject({ action: 'worker.start', outcome: 'failure', user_id: null, detail: { via: 'autostart', reason: 'WORKER_EXTERNAL' } });
    expect((await ctx.app.inject({ url: '/api/health' })).statusCode).toBe(200);
  });

  it('NEG-SUP-010 start ulang segera setelah stop → 429 WORKER_COOLDOWN + Retry-After, tanpa fork, audit failure; setelah 10 detik → 200', async () => {
    ctx = await createWorkerTestApp();
    const auth = await login(ctx.app);
    expect((await postWorker(ctx.app, 'start', auth)).statusCode).toBe(200);
    expect((await postWorker(ctx.app, 'stop', auth)).statusCode).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect((await getWorker(ctx.app, auth)).json().state).toBe('stopped');
    ctx.clock.advance(2_500);
    const res = await postWorker(ctx.app, 'start', auth);
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: 'WORKER_COOLDOWN', message: expect.stringMatching(/Tunggu/) });
    expect(res.headers['retry-after']).toBe('8');
    expect(ctx.fork.calls).toHaveLength(1);
    const [audit] = await workerAudit(ctx.app);
    expect(audit).toMatchObject({ action: 'worker.start', outcome: 'failure', detail: { reason: 'WORKER_COOLDOWN' } });
    ctx.clock.advance(7_500);
    expect((await postWorker(ctx.app, 'start', auth)).statusCode).toBe(200);
    expect(ctx.fork.calls).toHaveLength(2);
  });
});
