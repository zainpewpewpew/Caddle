import { afterEach, describe, expect, it } from 'vitest';
import { WORKER_SCRIPT_PATH } from '../../backend/system/workerSupervisor.js';
import { login } from '../helpers/testApp.js';
import { createWorkerTestApp, postWorker } from '../helpers/workerTestApp.js';

const STATUS_KEYS = ['enabled', 'exitCode', 'signal', 'startedAt', 'state', 'stoppedAt'];

describe('kontrol scanner dari website — keamanan', () => {
  let ctx;
  afterEach(async () => { await ctx?.app.close(); ctx = null; });

  it.each([
    ['tanpa header X-CSRF-Token', { 'x-csrf-token': undefined }, 'CSRF_INVALID'],
    ['token CSRF salah', { 'x-csrf-token': 'A'.repeat(43) }, 'CSRF_INVALID'],
    ['Origin lintas situs', { origin: 'https://evil.example' }, 'FORBIDDEN'],
    ['Sec-Fetch-Site cross-site', { 'sec-fetch-site': 'cross-site' }, 'FORBIDDEN'],
  ])('SEC-SUP-001 admin start %s → 403, worker tidak dijalankan', async (_label, headers, code) => {
    ctx = await createWorkerTestApp();
    const auth = await login(ctx.app);
    const res = await postWorker(ctx.app, 'start', auth, { headers });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe(code);
    expect(ctx.fork.calls).toHaveLength(0);
  });

  it('SEC-SUP-002 stop tanpa token CSRF → 403, worker tetap berjalan', async () => {
    ctx = await createWorkerTestApp();
    const auth = await login(ctx.app);
    await postWorker(ctx.app, 'start', auth);
    const res = await postWorker(ctx.app, 'stop', auth, { headers: { 'x-csrf-token': undefined } });
    expect(res.statusCode).toBe(403);
    expect(ctx.fork.last().signals).toEqual([]);
  });

  it('SEC-SUP-003 body & query request tidak dapat memengaruhi skrip, argumen, atau environment child', async () => {
    ctx = await createWorkerTestApp();
    const auth = await login(ctx.app);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/system/worker/start?scriptPath=/bin/sh&args=-c&env=X',
      headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrfToken, 'content-type': 'application/json' },
      payload: { scriptPath: '/bin/sh', args: ['-c', 'id'], env: { NODE_OPTIONS: '--require /tmp/evil.js' }, execArgv: ['--inspect'] },
    });
    expect(res.statusCode).toBe(200);
    const [{ scriptPath, args, options }] = ctx.fork.calls;
    expect(scriptPath).toBe(WORKER_SCRIPT_PATH);
    expect(args).toEqual([]);
    expect(options.execArgv).toEqual([]);
    expect(options.env).toEqual({ DATABASE_PATH: ':memory:' });
  });

  it('SEC-SUP-004 respons status hanya berisi field state — tanpa pid, path, env, atau log', async () => {
    ctx = await createWorkerTestApp();
    const auth = await login(ctx.app);
    const started = await postWorker(ctx.app, 'start', auth);
    expect(Object.keys(started.json()).sort()).toEqual(STATUS_KEYS);
    const status = (await ctx.app.inject({ url: '/api/system/status', headers: { cookie: auth.cookie } })).json();
    expect(Object.keys(status.workerControl).sort()).toEqual(STATUS_KEYS);
    expect(JSON.stringify(started.json())).not.toMatch(/worker\/index|DATABASE_PATH|pid/);
  });

  it('SEC-SUP-005 rute start/stop hanya POST; GET start → 404 lewat catch-all (bukan menjalankan worker)', async () => {
    ctx = await createWorkerTestApp();
    const auth = await login(ctx.app);
    const res = await ctx.app.inject({ url: '/api/system/worker/start', headers: { cookie: auth.cookie } });
    expect(res.statusCode).toBe(404);
    expect(ctx.fork.calls).toHaveLength(0);
  });
});
