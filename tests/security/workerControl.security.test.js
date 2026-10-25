import { afterEach, describe, expect, it } from 'vitest';
import { WORKER_SCRIPT_PATH } from '../../backend/system/workerSupervisor.js';
import { ANALYST, login } from '../helpers/testApp.js';
import { createWorkerTestApp, postWorker, workerAudit } from '../helpers/workerTestApp.js';

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

  // ---- Temuan review: jejak audit untuk penolakan di gerbang & error tak terduga ----

  const userId = (db, username) => db.prepare('SELECT id FROM users WHERE username = ?').get(username).id;

  it.each(['start', 'stop'])('SEC-SUP-006 analyst POST %s → 403 dan tercatat di audit (failure, FORBIDDEN, user analyst)', async (action) => {
    ctx = await createWorkerTestApp();
    const analyst = await login(ctx.app, ANALYST);
    const res = await postWorker(ctx.app, action, analyst);
    expect(res.statusCode).toBe(403);
    expect(await workerAudit(ctx.app)).toEqual([expect.objectContaining({
      action: `worker.${action}`, outcome: 'failure', user_id: userId(ctx.db, ANALYST.username), ip_address: '127.0.0.1',
      detail: { reason: 'FORBIDDEN' },
    })]);
    expect(ctx.fork.calls).toHaveLength(0);
  });

  it.each([
    ['start', 'tanpa header X-CSRF-Token', undefined],
    ['stop', 'tanpa header X-CSRF-Token', undefined],
    ['start', 'token CSRF salah', 'A'.repeat(43)],
  ])('SEC-SUP-007 admin POST %s %s → 403 dan tercatat di audit (failure, CSRF_INVALID)', async (action, _label, token) => {
    ctx = await createWorkerTestApp();
    const admin = await login(ctx.app);
    const res = await postWorker(ctx.app, action, admin, { headers: { 'x-csrf-token': token } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('CSRF_INVALID');
    expect(await workerAudit(ctx.app)).toEqual([expect.objectContaining({
      action: `worker.${action}`, outcome: 'failure', user_id: userId(ctx.db, 'mary'), detail: { reason: 'CSRF_INVALID' },
    })]);
  });

  it('SEC-SUP-008 error tak terduga (baca heartbeat gagal, SQLITE_BUSY) → 500 INTERNAL_ERROR tanpa detail internal, tercatat failure INTERNAL_ERROR', async () => {
    ctx = await createWorkerTestApp({
      supervisorOptions: { readExternalHeartbeat: async () => { throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }); } },
    });
    const admin = await login(ctx.app);
    const res = await postWorker(ctx.app, 'start', admin);
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'INTERNAL_ERROR', message: 'Terjadi kesalahan internal' });
    expect(await workerAudit(ctx.app)).toEqual([expect.objectContaining({
      action: 'worker.start', outcome: 'failure', user_id: userId(ctx.db, 'mary'), detail: { reason: 'INTERNAL_ERROR' },
    })]);
    expect(ctx.fork.calls).toHaveLength(0);
  });

  it('SEC-SUP-009 permintaan yang ditolak sebelum sesi dikenali (tanpa sesi 401, Origin lintas situs) tidak membuat baris audit', async () => {
    ctx = await createWorkerTestApp();
    const admin = await login(ctx.app);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/system/worker/start' })).statusCode).toBe(401);
    expect((await postWorker(ctx.app, 'start', admin, { headers: { origin: 'https://evil.example' } })).statusCode).toBe(403);
    expect(await workerAudit(ctx.app)).toEqual([]);
  });

  it.each(['start', 'stop'])('SEC-SUP-010 rate limit khusus POST %s: maks. 10 per menit per IP → permintaan ke-11 429 RATE_LIMITED (lebih ketat dari batas global 300)', async (action) => {
    ctx = await createWorkerTestApp();
    const admin = await login(ctx.app);
    const codes = [];
    for (let i = 0; i < 11; i += 1) codes.push((await postWorker(ctx.app, action, admin)).statusCode);
    expect(codes.slice(0, 10).every((c) => c !== 429)).toBe(true);
    expect(codes[10]).toBe(429);
    const limited = await postWorker(ctx.app, action, admin);
    expect(limited.json()).toMatchObject({ error: 'RATE_LIMITED' });
    expect(ctx.fork.calls.length).toBeLessThanOrEqual(1);
    // Route lain tidak ikut dibatasi oleh penghitung start/stop.
    expect((await ctx.app.inject({ url: '/api/system/worker', headers: { cookie: admin.cookie } })).statusCode).toBe(200);
  });
});
