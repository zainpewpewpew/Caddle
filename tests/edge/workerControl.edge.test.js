import { afterEach, describe, expect, it } from 'vitest';
import { HEARTBEAT_STALE_MS } from '../../backend/system/workerStatus.js';
import { createFakeFork, flush } from '../helpers/fakeFork.js';
import { login } from '../helpers/testApp.js';
import { createWorkerTestApp, getWorker, postWorker } from '../helpers/workerTestApp.js';

describe('kontrol scanner dari website — kasus tepi', () => {
  let ctx;
  afterEach(async () => { await ctx?.app.close(); ctx = null; });

  it('EDGE-SUP-001 dua request start bersamaan → tepat satu 200 dan satu 409; hanya satu child', async () => {
    ctx = await createWorkerTestApp();
    const auth = await login(ctx.app);
    const results = await Promise.all([postWorker(ctx.app, 'start', auth), postWorker(ctx.app, 'start', auth)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(ctx.fork.calls).toHaveLength(1);
  });

  it('EDGE-SUP-002 worker crash → crashed dengan kode keluar; heartbeat segar milik child yang crash tidak memblokir start ulang', async () => {
    ctx = await createWorkerTestApp();
    const auth = await login(ctx.app);
    await postWorker(ctx.app, 'start', auth);
    // Child sempat menulis heartbeat "running" lalu mati tanpa heartbeat akhir.
    await ctx.app.services.repos.ingestion.heartbeat({ at: ctx.clock(), state: { state: 'running' } });
    ctx.clock.advance(1_000);
    ctx.fork.last().exit(1);
    await flush();
    expect((await getWorker(ctx.app, auth)).json()).toMatchObject({ state: 'crashed', exitCode: 1, signal: null });
    const res = await postWorker(ctx.app, 'start', auth);
    expect(res.statusCode).toBe(200);
    expect(ctx.fork.calls).toHaveLength(2);
  });

  it('EDGE-SUP-003 heartbeat worker luar tepat di batas basi masih external; 1 ms setelahnya start diizinkan', async () => {
    ctx = await createWorkerTestApp();
    const auth = await login(ctx.app);
    await ctx.app.services.repos.ingestion.heartbeat({ at: ctx.clock() - HEARTBEAT_STALE_MS, state: { state: 'degraded' } });
    expect((await postWorker(ctx.app, 'start', auth)).statusCode).toBe(409);
    ctx.clock.advance(1);
    expect((await postWorker(ctx.app, 'start', auth)).statusCode).toBe(200);
  });

  it('EDGE-SUP-004 stop kedua saat masih stopping → 200 idempoten (tanpa sinyal tambahan); worker yang tidak merespons di-SIGKILL setelah 15 detik', async () => {
    ctx = await createWorkerTestApp({ fork: createFakeFork() });
    const auth = await login(ctx.app);
    await postWorker(ctx.app, 'start', auth);
    await postWorker(ctx.app, 'stop', auth);
    const again = await postWorker(ctx.app, 'stop', auth);
    expect(again.statusCode).toBe(200);
    expect(again.json().state).toBe('stopping');
    expect(ctx.fork.last().signals).toEqual(['SIGTERM']);
    ctx.timers.fire(15_000);
    expect(ctx.fork.last().signals).toEqual(['SIGTERM', 'SIGKILL']);
    ctx.fork.last().exit(null, 'SIGKILL');
    await flush();
    expect((await getWorker(ctx.app, auth)).json()).toMatchObject({ state: 'stopped', signal: 'SIGKILL' });
  });
});
