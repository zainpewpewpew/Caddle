import { connect } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ANALYST, createTestApp, login, TEST_ORIGIN } from '../helpers/testApp.js';

// Regresi temuan review: gerbang auth/CSRF/rate limit dulu memeriksa `request.url` mentah,
// sementara router mendekode path (%61pi → api) dan membuang prefix absolute-form (http://host).
const PROTECTED = ['/api/overview', '/api/system/status', '/api/settings/scanner', '/api/signals/active', '/api/auth/session'];

/** Varian target request yang dirutekan ke handler yang sama oleh router. */
const variants = (path) => [
  path.replace('/api/', '/%61pi/'),
  path.replace('/api/', '/%61%70%69/'),
  path.replace('/api/', '/ap%69/'),
];

describe('gerbang berbasis route yang cocok, bukan URL mentah', () => {
  let ctx;
  beforeEach(async () => { ctx = await createTestApp(); });
  afterEach(async () => { await ctx.app.close(); });

  it.each(PROTECTED.flatMap(variants))('SEC-RT-001 %s tanpa sesi → 401, tanpa data', async (url) => {
    const res = await ctx.app.inject({ url });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'UNAUTHENTICATED', message: 'Autentikasi diperlukan' });
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('SEC-RT-002 analyst tidak dapat mengubah pengaturan admin lewat path ter-encode, dengan atau tanpa CSRF', async () => {
    const analyst = await login(ctx.app, ANALYST);
    const current = (await ctx.app.inject({ url: '/api/settings/scanner', headers: { cookie: analyst.cookie } })).json();
    for (const headers of [{}, { 'x-csrf-token': analyst.csrfToken }]) {
      const res = await ctx.app.inject({
        method: 'PUT', url: '/%61pi/settings/scanner',
        headers: { cookie: analyst.cookie, origin: TEST_ORIGIN, ...headers },
        payload: { version: current.version, settings: current.settings },
      });
      expect([403]).toContain(res.statusCode);
    }
    expect(ctx.db.prepare('SELECT COUNT(*) n FROM settings').get().n).toBe(0);
  });

  it('SEC-RT-003 admin dengan sesi tetap wajib CSRF lewat path ter-encode', async () => {
    const admin = await login(ctx.app);
    const current = (await ctx.app.inject({ url: '/api/settings/scanner', headers: { cookie: admin.cookie } })).json();
    const res = await ctx.app.inject({
      method: 'PUT', url: '/%61pi/settings/scanner', headers: { cookie: admin.cookie, origin: TEST_ORIGIN },
      payload: { version: current.version, settings: current.settings },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('CSRF_INVALID');
  });

  it.each(['/api/tidak-ada', '/%61pi/tidak-ada', '/api/settings/scanner/extra'])('SEC-RT-004 rute API tak dikenal %s: tanpa sesi 401, dengan sesi 404', async (url) => {
    expect((await ctx.app.inject({ url })).statusCode).toBe(401);
    const admin = await login(ctx.app);
    const res = await ctx.app.inject({ url, headers: { cookie: admin.cookie } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('NOT_FOUND');
  });

  it('SEC-RT-005 rate limit login berlaku juga untuk path ter-encode', async () => {
    const codes = [];
    for (let i = 0; i < 7; i += 1) {
      const url = i % 2 ? '/%61pi/auth/login' : '/api/auth/login';
      const res = await ctx.app.inject({ method: 'POST', url, headers: { origin: TEST_ORIGIN }, payload: { username: 'mary', password: `salah-${i}-xxxxxxxx` } });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes.slice(5)).toEqual([429, 429]);
  });

  it('SEC-RT-006 rate limit global API menghitung request tanpa sesi juga', async () => {
    let last;
    for (let i = 0; i < 301; i += 1) last = await ctx.app.inject({ url: i % 2 ? '/%61pi/overview' : '/api/overview' });
    expect(last.statusCode).toBe(429);
  });
});

describe('request absolute-form lewat HTTP nyata', () => {
  let ctx;
  let port;
  beforeEach(async () => {
    ctx = await createTestApp();
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    port = ctx.app.server.address().port;
  });
  afterEach(async () => { await ctx.app.close(); });

  const raw = (target) => new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let data = '';
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
    socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
  });

  it.each([
    'http://127.0.0.1/api/overview',
    'https://evil.example/api/system/status',
    'http://127.0.0.1/%61pi/settings/scanner',
  ])('SEC-RT-007 GET %s tanpa sesi → 401', async (target) => {
    const response = await raw(target);
    expect(response.split('\r\n')[0]).toMatch(/^HTTP\/1\.1 (401|400)/);
    expect(response).not.toMatch(/"monitoredSymbols"|"nodeVersion"|"timeframes"/);
  });
});

describe('idle timeout & gerbang fail-closed', () => {
  it('SEC-RT-008 polling /api/ready dengan cookie tidak memperpanjang idle; aktivitas API terautentikasi memperpanjang', async () => {
    const ctx = await createTestApp();
    try {
      const a = await login(ctx.app);
      const session = () => ctx.app.inject({ url: '/api/auth/session', headers: { cookie: a.cookie } });
      for (let i = 0; i < 2; i += 1) {
        ctx.clock.advance(20 * 60_000);
        expect((await ctx.app.inject({ url: '/api/ready', headers: { cookie: a.cookie } })).statusCode).toBe(200);
        expect((await ctx.app.inject({ url: '/js/app.js', headers: { cookie: a.cookie } })).statusCode).toBe(200);
      }
      // 40 menit tanpa aktivitas API terautentikasi → sesi idle kedaluwarsa (batas 30 menit).
      expect((await session()).statusCode).toBe(401);

      const b = await login(ctx.app);
      for (let i = 0; i < 3; i += 1) {
        ctx.clock.advance(20 * 60_000);
        expect((await ctx.app.inject({ url: '/api/auth/session', headers: { cookie: b.cookie } })).statusCode).toBe(200);
      }
    } finally {
      await ctx.app.close();
    }
  });

  it('SEC-RT-009 route API yang terdaftar sebelum registerAuth (tanpa gerbang) ditolak, bukan dilayani', async () => {
    const { default: Fastify } = await import('fastify');
    const { default: cookie } = await import('@fastify/cookie');
    const { registerAuth } = await import('../../backend/auth/authPlugin.js');
    const app = Fastify({ logger: false });
    await app.register(cookie);
    app.get('/api/terlalu-awal', async () => ({ rahasia: true }));
    registerAuth(app, { sessionService: { resolve: async () => null, touch: async () => {} }, cookieName: 'lr_session' });
    app.get('/api/terlindungi', async () => ({ ok: true }));
    try {
      const early = await app.inject({ url: '/api/terlalu-awal' });
      expect(early.statusCode).toBe(401);
      expect(early.body).not.toContain('rahasia');
      expect((await app.inject({ url: '/api/terlindungi' })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe('IP klien di belakang proxy', () => {
  it.each([
    ['tanpa proxy tepercaya', 'false', '127.0.0.1'],
    ['proxy tepercaya 127.0.0.1', '127.0.0.1', '198.51.100.7'],
    ['proxy tepercaya bukan peer ini', '10.9.9.9', '127.0.0.1'],
  ])('SEC-RT-010 %s: X-Forwarded-For palsu di kiri tidak menjadi IP klien', async (_label, trust, expected) => {
    const ctx = await createTestApp({ env: { TRUST_PROXY: trust } });
    try {
      ctx.app.get('/api/__ip', async (request) => ({ ip: request.ip }));
      const a = await login(ctx.app);
      const res = await ctx.app.inject({
        url: '/api/__ip', remoteAddress: '127.0.0.1',
        headers: { cookie: a.cookie, 'x-forwarded-for': '203.0.113.9, 198.51.100.7' },
      });
      expect(res.json().ip).toBe(expected);
    } finally {
      await ctx.app.close();
    }
  });
});
