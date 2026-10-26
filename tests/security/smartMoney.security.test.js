// API Insider / Smart Money Radar — keamanan: sesi wajib, CSRF & Origin untuk mutasi, isolasi per pengguna,
// pesan provider tersaring, error internal tidak bocor, provider fixture (data simulasi) tidak pernah aktif sendiri.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ALERT_PREFS } from '../../backend/smartmoney/alerts.js';
import { ALERT_KINDS } from '../../backend/smartmoney/contracts.js';
import { createFixtureProvider } from '../../backend/smartmoney/providers/fixtureProvider.js';
import { createLiveProviderRegistry } from '../../backend/smartmoney/providers/live.js';
import { buildScenario } from '../fixtures/smartmoney/scenario.js';
import { SM, createSmartMoneyApp, session } from '../helpers/smartMoneyApi.js';
import { ANALYST, TEST_ORIGIN, createTestApp, login } from '../helpers/testApp.js';

const EVM = `0x${'cd'.repeat(20)}`;
const ROUTES = [
  ['GET', '/status'], ['GET', '/radar'], ['GET', '/wallets'], ['GET', `/wallets/ethereum/${EVM}`], ['GET', `/tokens/ethereum/${EVM}`],
  ['GET', '/watchlist'], ['GET', '/alerts'], ['GET', '/alert-prefs'], ['GET', '/screener-links'], ['GET', '/evaluation'],
  ['POST', '/watchlist', { kind: 'WALLET', chain: 'ethereum', address: EVM }],
  ['DELETE', '/watchlist', { kind: 'WALLET', chain: 'ethereum', address: EVM }],
  ['POST', '/alerts/read', { all: true }],
  ['PUT', '/alert-prefs', { prefs: { minUsd: 1 } }],
];
const MUTATIONS = ROUTES.filter(([method]) => method !== 'GET');

describe('Keamanan API Smart Money', () => {
  let ctx;
  let s;
  let exp;
  beforeEach(async () => {
    ctx = await createSmartMoneyApp();
    s = await session(ctx.app);
    exp = ctx.scenario.expectations;
  });
  afterEach(async () => { await ctx.app.close(); });

  const smartMoneyAudit = async () => (await ctx.app.services.repos.audit.recent(100)).filter((a) => a.action.startsWith('smartmoney.'));

  it('SEC-SM-API-001 tanpa sesi setiap route → 401, termasuk masukan tidak valid (detail validasi tidak bocor)', async () => {
    for (const [method, path, payload] of ROUTES) {
      const res = await ctx.app.inject({ method, url: `${SM}${path}`, headers: { origin: TEST_ORIGIN }, ...(payload ? { payload } : {}) });
      expect(res.statusCode, `${method} ${path}`).toBe(401);
      expect(res.json()).toEqual({ error: 'UNAUTHENTICATED', message: 'Autentikasi diperlukan' });
    }
    const invalid = await ctx.app.inject({ method: 'GET', url: `${SM}/radar?limit=9999&window=x` });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json()).not.toHaveProperty('details');
    const forged = await ctx.app.inject({ method: 'GET', url: `${SM}/radar`, headers: { cookie: 'lr_session=palsu' } });
    expect(forged.statusCode).toBe(401);
  });

  it('SEC-SM-API-002 mutasi tanpa / dengan token CSRF salah → 403 CSRF_INVALID dan tidak ada state yang berubah', async () => {
    for (const [method, path, payload] of MUTATIONS) {
      const missing = await s.send(method, `${SM}${path}`, payload, { csrf: false });
      expect(missing.statusCode, `${method} ${path}`).toBe(403);
      expect(missing.json().error).toBe('CSRF_INVALID');
      const wrong = await ctx.app.inject({
        method, url: `${SM}${path}`, payload, headers: { cookie: s.auth.cookie, origin: TEST_ORIGIN, 'x-csrf-token': 'x'.repeat(43) },
      });
      expect(wrong.statusCode, `${method} ${path}`).toBe(403);
    }
    expect((await s.get(`${SM}/watchlist`)).json().items).toEqual([]);
    expect((await s.get(`${SM}/alert-prefs`)).json().isDefault).toBe(true);
    expect((await s.get(`${SM}/alerts`)).json().unread).toBe(1);
    expect(await smartMoneyAudit()).toEqual([]);
  });

  it('SEC-SM-API-003 mutasi dari Origin lain atau Sec-Fetch-Site cross-site → 403 walau token CSRF benar', async () => {
    for (const [method, path, payload] of MUTATIONS) {
      const evil = await s.send(method, `${SM}${path}`, payload, { origin: 'https://evil.example' });
      expect(evil.statusCode, `${method} ${path}`).toBe(403);
      expect(evil.json().error).toBe('FORBIDDEN');
      const crossSite = await ctx.app.inject({
        method, url: `${SM}${path}`, payload,
        headers: { cookie: s.auth.cookie, 'x-csrf-token': s.auth.csrfToken, 'sec-fetch-site': 'cross-site' },
      });
      expect(crossSite.statusCode, `${method} ${path}`).toBe(403);
    }
    expect((await s.get(`${SM}/watchlist`)).json().items).toEqual([]);
  });

  it('SEC-SM-API-004 watchlist, status baca, dan preferensi terisolasi per pengguna', async () => {
    const analyst = await session(ctx.app, ANALYST);
    const item = { kind: 'TOKEN', chain: 'ethereum', address: exp.tka.address };
    expect((await s.send('POST', `${SM}/watchlist`, item)).statusCode).toBe(201);
    expect((await analyst.get(`${SM}/watchlist`)).json().items).toEqual([]);
    expect((await analyst.get(`${SM}/radar`)).json().items.some((i) => i.watching)).toBe(false);
    // Pengguna lain tidak dapat menghapus item milik admin.
    expect((await analyst.send('DELETE', `${SM}/watchlist`, item)).statusCode).toBe(404);
    expect((await s.get(`${SM}/watchlist`)).json().items).toHaveLength(1);

    const [alert] = (await s.get(`${SM}/alerts`)).json().items;
    expect((await s.send('POST', `${SM}/alerts/read`, { ids: [alert.id] })).json()).toEqual({ updated: 1 });
    expect((await analyst.get(`${SM}/alerts`)).json()).toMatchObject({ unread: 1, items: [{ id: alert.id, read: false }] });

    expect((await analyst.send('PUT', `${SM}/alert-prefs`, { prefs: { minUsd: 5 } })).statusCode).toBe(200);
    expect((await s.get(`${SM}/alert-prefs`)).json()).toEqual({ prefs: { ...DEFAULT_ALERT_PREFS, kinds: [...ALERT_KINDS] }, isDefault: true });
  });

  it('SEC-SM-API-005 alert yang hanya muncul karena wallet DIPANTAU hanya terlihat oleh pemantaunya; penanda dihitung per pengguna', async () => {
    const fresh = await createSmartMoneyApp({ seed: false });
    try {
      const admin = await session(fresh.app);
      const analyst = await session(fresh.app, ANALYST);
      const exitWallet = fresh.scenario.expectations.cexExit.wallet;
      const buyer = fresh.scenario.expectations.tka.repeatBuyer;
      for (const address of [exitWallet, buyer]) {
        expect((await admin.send('POST', `${SM}/watchlist`, { kind: 'WALLET', chain: 'ethereum', address })).statusCode).toBe(201);
      }
      await fresh.sync();
      for (const u of [admin, analyst]) expect((await u.send('PUT', `${SM}/alert-prefs`, { prefs: { minWalletScore: 0 } })).statusCode).toBe(200);

      const adminAlerts = (await admin.get(`${SM}/alerts`)).json().items;
      const exit = adminAlerts.find((a) => a.kind === 'WALLET_EXIT' && a.wallet === exitWallet);
      expect(exit).toMatchObject({ walletWatched: true, watchlisted: true, tokenKey: `ethereum:${fresh.scenario.expectations.cexExit.token}` });
      const adminBuy = adminAlerts.find((a) => a.kind === 'NEW_BUY' && a.wallet === buyer);
      expect(adminBuy).toMatchObject({ severity: 'HIGH', walletWatched: true });

      const analystAlerts = (await analyst.get(`${SM}/alerts`)).json().items;
      expect(analystAlerts.some((a) => a.id === exit.id)).toBe(false);
      expect(analystAlerts.some((a) => a.walletWatched || a.watchlisted)).toBe(false);
      expect(analystAlerts.find((a) => a.id === adminBuy.id)).toMatchObject({ severity: 'MEDIUM', walletWatched: false });
      for (const a of [...adminAlerts, ...analystAlerts]) expect(a.evidence).not.toHaveProperty('watchOnly');
      // Tandai "semua dibaca" oleh analyst tidak menyentuh alert yang tidak ia lihat.
      await analyst.send('POST', `${SM}/alerts/read`, { all: true });
      expect((await admin.get(`${SM}/alerts`)).json().items.find((a) => a.id === exit.id).read).toBe(false);

      // Setelah analyst memantau wallet yang sama, alert tersebut ikut terlihat (dihitung ulang saat dibaca).
      await analyst.send('POST', `${SM}/watchlist`, { kind: 'WALLET', chain: 'ethereum', address: exitWallet });
      expect((await analyst.get(`${SM}/alerts`)).json().items.find((a) => a.id === exit.id)).toMatchObject({ walletWatched: true, read: false });
    } finally {
      await fresh.app.close();
    }
  });

  it('SEC-SM-API-006 pesan error provider & ringkasan run disaring: tanpa URL, kunci API, karakter kontrol, atau field asing', async () => {
    ctx.clock.advance(60_000); // percobaan baru setelah sinkron sukses → gagal total = DOWN
    const now = ctx.clock();
    await ctx.repo.recordProviderAttempt('fixture', { now, isSimulated: true });
    await ctx.repo.recordProviderFailure('fixture', {
      now, isSimulated: true, code: 'UNAUTHORIZED',
      message: 'Gagal memanggil https://api.example.test/v2/api?module=account&apikey=SECRETKEY123 \u0007(HTTP 401) key=VALUE9&token=TOK9',
    });
    await ctx.repo.setSyncState('lastRun', {
      status: 'DEGRADED', startedAt: now, finishedAt: now, fetched: 1, notes: ['lihat https://x.test/?apikey=SECRET3'],
      errors: [{ provider: 'fixture', code: 'UNAVAILABLE', method: 'fetchWalletTransfers', chain: 'ethereum', message: 'x https://h.test/a?key=SECRET2', stack: 'Error: /home/user/rahasia.js:1' }],
      internalPath: '/home/user/SECRET4.db',
    }, { now });
    const body = (await s.get(`${SM}/status`)).json();
    const text = JSON.stringify(body);
    for (const secret of ['SECRETKEY123', 'SECRET2', 'SECRET3', 'SECRET4', 'TOK9', 'https://', '\u0007', 'stack', 'rahasia.js']) {
      expect(text, secret).not.toContain(secret);
    }
    expect(body.providers[0]).toMatchObject({ state: 'DOWN', lastErrorCode: 'UNAUTHORIZED' });
    expect(body.providers[0].lastErrorMessage).toMatch(/^Gagal memanggil \[url\] \(HTTP 401\)/);
    expect(body.lastRun.errors).toEqual([{ provider: 'fixture', code: 'UNAVAILABLE', method: 'fetchWalletTransfers', chain: 'ethereum', message: 'x [url]' }]);
  });

  it('SEC-SM-API-007 kegagalan internal → 500 generik tanpa pesan/jalur internal', async () => {
    ctx.repo.listActivities = async () => {
      throw new Error('SQLITE_CORRUPT: database disk image is malformed at /home/user/data/RAHASIA.db');
    };
    for (const url of [`${SM}/radar`, `${SM}/screener-links`, `${SM}/tokens/ethereum/${exp.tka.address}`]) {
      const res = await s.get(url);
      expect(res.statusCode, url).toBe(500);
      expect(res.json()).toEqual({ error: 'INTERNAL_ERROR', message: 'Terjadi kesalahan internal' });
    }
  });

  it('SEC-SM-API-008 masukan berbentuk injeksi SQL / traversal / skrip → 400, tidak pernah 500', async () => {
    const urls = [
      `${SM}/radar?chain=${encodeURIComponent("ethereum' OR 1=1 --")}`,
      `${SM}/radar?state=${encodeURIComponent('ACCUMULATING; DROP TABLE sm_activities')}`,
      `${SM}/alerts?kind=${encodeURIComponent("NEW_BUY' --")}`,
      `${SM}/wallets/ethereum/${encodeURIComponent("0x' OR '1'='1")}`,
      `${SM}/tokens/ethereum/${encodeURIComponent('<script>alert(1)</script>')}`,
      `${SM}/wallets/${encodeURIComponent('../../etc')}/${EVM}`,
    ];
    for (const url of urls) {
      const res = await s.get(url);
      expect(res.statusCode, url).toBe(400);
    }
    const watch = await s.send('POST', `${SM}/watchlist`, { kind: 'WALLET', chain: 'ethereum', address: "0x' OR '1'='1" });
    expect(watch.statusCode).toBe(400);
    // Tabel tetap utuh.
    expect((await s.get(`${SM}/radar`)).json().items.length).toBeGreaterThan(0);
  });
});

describe('Keamanan API Smart Money — provider fixture tidak pernah aktif sendiri', () => {
  it('SEC-SM-API-009 SMART_MONEY_PROVIDERS=fixture tanpa registri uji → tidak ada provider aktif (status jujur, bukan data simulasi)', async () => {
    const ctx = await createTestApp({ env: { SMART_MONEY_PROVIDERS: 'fixture' } });
    try {
      const { cookie } = await login(ctx.app);
      const body = (await ctx.app.inject({ url: `${SM}/status`, headers: { cookie } })).json();
      expect(body.meta).toMatchObject({ providersConfigured: 0, simulated: false });
      expect(body.providers).toEqual([expect.objectContaining({
        id: 'fixture', configured: false, isSimulated: true, state: 'DOWN', lastErrorCode: 'NOT_CONFIGURED',
        lastErrorMessage: expect.stringContaining('hanya tersedia di tes'),
      })]);
      const radar = (await ctx.app.inject({ url: `${SM}/radar`, headers: { cookie } })).json();
      expect(radar.items).toEqual([]);
    } finally {
      await ctx.app.close();
    }
  });

  it('SEC-SM-API-010 adapter data simulasi ditolak registri live di luar NODE_ENV=test', () => {
    const fixture = createFixtureProvider(buildScenario());
    for (const nodeEnv of ['production', 'development']) {
      expect(() => createLiveProviderRegistry({ nodeEnv, smartMoney: { providers: ['fixture'] } }, { extraAdapters: [fixture] }))
        .toThrow(TypeError);
    }
    const registry = createLiveProviderRegistry({ nodeEnv: 'test', smartMoney: { providers: ['fixture'] } }, { extraAdapters: [fixture] });
    expect(registry.list().map((a) => a.id)).toEqual(['fixture']);
  });
});
