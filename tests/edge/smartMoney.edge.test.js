// API Insider / Smart Money Radar — kasus tepi: kesegaran data, batas jendela radar, status provider, cooldown &
// ambang per pengguna, normalisasi alamat, data kosong yang jujur.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyUserCooldown, providerState } from '../../backend/api/smartMoneyRoutes.js';
import { DEFAULT_ALERT_PREFS } from '../../backend/smartmoney/alerts.js';
import { ALERT_KINDS } from '../../backend/smartmoney/contracts.js';
import { SM, createSmartMoneyApp, session } from '../helpers/smartMoneyApi.js';

const HOUR = 3_600_000;
const TOKEN = `0x${'7a'.repeat(20)}`;
const WALLET = `0x${'5b'.repeat(20)}`;

/** Alert tersimpan sesuai bentuk sinkronisasi (evidence membawa usd/walletScore/symbol/watchOnly). */
function storedAlert({ kind = 'MULTI_WALLET_BUY', wallet = null, createdAt, bucket = 0, usd = 50_000, walletScore = null,
  independentBuyers = 5, watchOnly = false, tokenAddress = TOKEN } = {}) {
  return {
    kind, severity: 'MEDIUM', dedupeKey: `${kind}:ethereum:${tokenAddress}:${wallet ?? '*'}:${bucket}`, chain: 'ethereum',
    tokenKey: `ethereum:${tokenAddress}`, wallet, title: `Uji ${kind} ${bucket}`, message: 'Alert uji (data simulasi).',
    evidence: { txHashes: [], explorerUrls: [], usd, walletScore, symbol: 'UJI', watchOnly, ...(kind === 'MULTI_WALLET_BUY' ? { independentBuyers } : {}) },
    createdAt, isSimulated: true,
  };
}

describe('Fungsi murni route smart money', () => {
  it('EDGE-SM-API-001 providerState: NEVER / OK / DEGRADED / DOWN dari urutan attempt → success → failure', () => {
    expect(providerState(null)).toBe('NEVER');
    expect(providerState({ lastAttemptAt: null, lastSuccessAt: null, lastErrorCode: null })).toBe('NEVER');
    expect(providerState({ lastAttemptAt: 10, lastSuccessAt: null, lastErrorCode: null })).toBe('NEVER');
    expect(providerState({ lastAttemptAt: 10, lastSuccessAt: 10, lastErrorCode: null })).toBe('OK');
    expect(providerState({ lastAttemptAt: 10, lastSuccessAt: 10, lastErrorCode: 'TIMEOUT' })).toBe('DEGRADED');
    expect(providerState({ lastAttemptAt: 20, lastSuccessAt: 10, lastErrorCode: 'TIMEOUT' })).toBe('DOWN');
    expect(providerState({ lastAttemptAt: 20, lastSuccessAt: null, lastErrorCode: 'UNAUTHORIZED' })).toBe('DOWN');
  });

  it('EDGE-SM-API-002 applyUserCooldown: alert pertama per kunci dasar dipertahankan, ulangan dalam jeda disembunyikan', () => {
    const a = (id, base, createdAt) => ({ id, dedupeKey: `${base}:${Math.floor(createdAt / 6)}`, createdAt });
    const alerts = [a(5, 'NEW_BUY:t:w', 30), a(4, 'NEW_BUY:t:w', 20), a(3, 'LARGE_SELL:t:w', 12), a(2, 'NEW_BUY:t:w', 10), a(1, 'NEW_BUY:t:w', 0)];
    // Jeda 15: 0 dipertahankan, 10 disembunyikan, 20 (≥ 15 dari 0) dipertahankan, 30 (10 dari 20) disembunyikan.
    expect(applyUserCooldown(alerts, 15).map((x) => x.id)).toEqual([4, 3, 1]);
    expect(applyUserCooldown(alerts, 0).map((x) => x.id)).toEqual([5, 4, 3, 2, 1]);
    expect(applyUserCooldown(alerts, 1000).map((x) => x.id)).toEqual([3, 1]);
    expect(applyUserCooldown([], 10)).toEqual([]);
    expect(() => applyUserCooldown(null, 10)).toThrow(TypeError);
    expect(() => applyUserCooldown([], -1)).toThrow(RangeError);
  });
});

describe('API Smart Money — kasus tepi dengan data simulasi', () => {
  let ctx;
  let s;
  let exp;
  beforeEach(async () => {
    ctx = await createSmartMoneyApp();
    s = await session(ctx.app);
    exp = ctx.scenario.expectations;
  });
  afterEach(async () => { await ctx.app.close(); });

  it('EDGE-SM-API-003 isStale mengikuti SMART_MONEY_STALE_MINUTES (default 60) sejak sinkron sukses terakhir', async () => {
    expect((await s.get(`${SM}/status`)).json().meta.isStale).toBe(false);
    // Login ulang setelah jam dimajukan: sesi lama dapat melewati idle timeout.
    ctx.clock.advance(60 * 60_000);
    s = await session(ctx.app);
    expect((await s.get(`${SM}/radar`)).json().meta.isStale).toBe(false);
    ctx.clock.advance(1);
    s = await session(ctx.app);
    const meta = (await s.get(`${SM}/radar`)).json().meta;
    expect(meta).toMatchObject({ isStale: true, lastSyncAt: ctx.scenario.now });
  });

  it('EDGE-SM-API-004 radar 24 jam kosong setelah jendela lewat, 7 hari masih memuat; detail token tetap jujur (radar null)', async () => {
    ctx.clock.advance(30 * HOUR);
    s = await session(ctx.app);
    expect((await s.get(`${SM}/radar`)).json().items).toEqual([]);
    expect((await s.get(`${SM}/radar?window=7d`)).json().items.length).toBeGreaterThan(0);
    expect((await s.get(`${SM}/screener-links`)).json().items).toEqual({});
    const token = (await s.get(`${SM}/tokens/ethereum/${exp.tka.address}`)).json();
    expect(token.radar).toBeNull();
    expect(token.binance.status).toBe('MATCHED');
    // Tanpa akumulasi 24 jam keyakinan dianggap 0: relevansi tidak pernah "tinggi" karena data lama.
    expect(['RENDAH', 'SEDANG']).toContain(token.screener.relevance);
    expect(token.activities.length).toBeGreaterThan(0);
  });

  it('EDGE-SM-API-005 token tanpa mapping Binance & tanpa radar 24 jam → NOT_LISTED, radar null, aktivitas tetap tampil', async () => {
    const tkb = ctx.scenario.tokens.TKB;
    const body = (await s.get(`${SM}/tokens/${tkb.chain}/${tkb.address}`)).json();
    expect(body).toMatchObject({ radar: null, binance: { status: 'NOT_LISTED' }, screener: { relevance: 'TIDAK_TERHUBUNG', signals: [] } });
    expect(body.activities.length).toBeGreaterThan(0);
    expect((await s.get(`${SM}/radar?chain=solana`)).json().items).toEqual([]);
  });

  it('EDGE-SM-API-006 alamat EVM huruf besar/checksum dinormalisasi ke huruf kecil (satu item watchlist yang sama)', async () => {
    const upper = `0x${exp.linked.a.slice(2).toUpperCase()}`;
    const profile = await s.get(`${SM}/wallets/ethereum/${upper}`);
    expect(profile.statusCode).toBe(200);
    expect(profile.json().wallet.address).toBe(exp.linked.a);
    const added = await s.send('POST', `${SM}/watchlist`, { kind: 'WALLET', chain: 'ethereum', address: upper });
    expect(added.json().address).toBe(exp.linked.a);
    await s.send('POST', `${SM}/watchlist`, { kind: 'WALLET', chain: 'ethereum', address: exp.linked.a });
    expect((await s.get(`${SM}/watchlist`)).json().items).toHaveLength(1);
    const mixed = `0x${exp.linked.a.slice(2, 22).toUpperCase()}${exp.linked.a.slice(22)}`;
    expect((await s.send('DELETE', `${SM}/watchlist`, { kind: 'WALLET', chain: 'ethereum', address: mixed })).statusCode).toBe(204);
    expect((await s.get(`${SM}/tokens/ethereum/${exp.tka.address.toUpperCase().replace('0X', '0x')}`)).statusCode).toBe(200);
  });

  it('EDGE-SM-API-007 dua kontrak dipetakan ke futures yang sama → /screener-links memakai keyakinan tertinggi', async () => {
    const rows = ctx.scenario.binanceMap.map((r) => (r.contractAddress === exp.screenerLink.address
      ? { ...r, binanceAsset: 'TKA', futuresSymbol: 'TKAUSDT' } : r));
    expect((await ctx.repo.upsertBinanceMap(rows, { provider: 'fixture' })).rejected).toEqual([]);
    const items = (await s.get(`${SM}/screener-links`)).json().items;
    expect(Object.keys(items).sort()).toEqual(['1000PEPEUSDT', 'TKAUSDT']);
    expect(items.TKAUSDT.tokenKey).toBe(`ethereum:${exp.tka.address}`);
  });

  it('EDGE-SM-API-008 wallet di watchlist yang belum disinkron: ringkasan "menunggu sinkronisasi", profil 404 (belum dilacak)', async () => {
    const fresh = `0x${'9c'.repeat(20)}`;
    expect((await s.send('POST', `${SM}/watchlist`, { kind: 'WALLET', chain: 'base', address: fresh })).statusCode).toBe(201);
    const [item] = (await s.get(`${SM}/watchlist`)).json().items;
    expect(item.summary).toEqual({ label: null, score: null, eligible: null, tracked: false, text: 'menunggu sinkronisasi berikutnya' });
    expect((await s.get(`${SM}/wallets/base/${fresh}`)).statusCode).toBe(404);
    // Wallet dilacak tanpa skor (belum dianalisis) → profil jujur tanpa skor/PnL rekaan.
    await ctx.repo.upsertWallets([{ chain: 'base', address: fresh, firstSeenAt: ctx.clock(), discoveredVia: 'watchlist' }]);
    const profile = (await s.get(`${SM}/wallets/base/${fresh}`)).json();
    expect(profile).toMatchObject({ score: null, flags: [], cluster: null, pnl: { summary: null, positions: [] }, activities: [], watching: true });
  });

  it('EDGE-SM-API-009 status: id terkonfigurasi tanpa adapter & provider lama yang tidak lagi dikonfigurasi tercantum jujur', async () => {
    const now = ctx.clock();
    await ctx.repo.recordProviderAttempt('lama', { now: now - HOUR });
    await ctx.repo.recordProviderSuccess('lama', { now: now - HOUR });
    // 'contoh-x': id sah yang tidak pernah punya adapter di registri live.
    const custom = await createSmartMoneyApp({ seed: false, providers: 'fixture,contoh-x' });
    try {
      const admin = await session(custom.app);
      const body = (await admin.get(`${SM}/status`)).json();
      expect(body.meta.providersConfigured).toBe(1);
      expect(body.providers.map((p) => [p.id, p.configured, p.state])).toEqual([['fixture', true, 'NEVER'], ['contoh-x', false, 'DOWN']]);
      expect(body.providers[1]).toMatchObject({ lastErrorCode: 'NOT_CONFIGURED', lastErrorMessage: expect.stringContaining('belum dirakit') });
    } finally {
      await custom.app.close();
    }
    const body = (await s.get(`${SM}/status`)).json();
    expect(body.providers.find((p) => p.id === 'lama')).toMatchObject({ configured: false, state: 'OK', note: expect.any(String) });
  });
});

describe('API Smart Money — alert per pengguna (alert uji disisipkan langsung)', () => {
  let ctx;
  let s;
  const t0 = Date.UTC(2026, 9, 1, 0, 0);
  beforeEach(async () => {
    ctx = await createSmartMoneyApp({ seed: false });
    ctx.clock.advance(t0 + 24 * HOUR - ctx.clock());
    s = await session(ctx.app);
  });
  afterEach(async () => { await ctx.app.close(); });

  const titles = async (q = '') => (await s.get(`${SM}/alerts${q}`)).json().items.map((a) => a.title);

  it('EDGE-SM-API-010 cooldown pengguna lebih panjang dari ember server menyembunyikan ulangan; unread ikut', async () => {
    await ctx.repo.insertAlerts([storedAlert({ createdAt: t0, bucket: 1 }), storedAlert({ createdAt: t0 + 7 * HOUR, bucket: 2 })]);
    expect(await titles()).toEqual(['Uji MULTI_WALLET_BUY 2', 'Uji MULTI_WALLET_BUY 1']);
    await s.send('PUT', `${SM}/alert-prefs`, { prefs: { cooldownMs: 24 * HOUR } });
    const body = (await s.get(`${SM}/alerts`)).json();
    expect(body.items.map((a) => a.title)).toEqual(['Uji MULTI_WALLET_BUY 1']);
    expect(body.unread).toBe(1);
    // "Tandai semua" hanya menandai alert yang terlihat.
    expect((await s.send('POST', `${SM}/alerts/read`, { all: true })).json()).toEqual({ updated: 1 });
    await s.send('PUT', `${SM}/alert-prefs`, { prefs: {} });
    expect((await s.get(`${SM}/alerts`)).json().unread).toBe(1);
  });

  it('EDGE-SM-API-011 ambang per pengguna: largeSellUsd, minIndependentBuyers, minWalletScore, jenis, watchlistOnly', async () => {
    await ctx.repo.insertAlerts([
      storedAlert({ kind: 'LARGE_SELL', wallet: WALLET, usd: 15_000, walletScore: 80, createdAt: t0 + 1 }),
      storedAlert({ kind: 'MULTI_WALLET_BUY', independentBuyers: 3, createdAt: t0 + 2 }),
      storedAlert({ kind: 'NEW_BUY', wallet: WALLET, usd: 2_000, walletScore: 40, createdAt: t0 + 3 }),
    ]);
    expect(await titles()).toEqual(['Uji MULTI_WALLET_BUY 0', 'Uji LARGE_SELL 0']);
    await s.send('PUT', `${SM}/alert-prefs`, { prefs: { largeSellUsd: 20_000, minIndependentBuyers: 4 } });
    expect(await titles()).toEqual([]);
    await s.send('PUT', `${SM}/alert-prefs`, { prefs: { minWalletScore: 30, kinds: ['NEW_BUY'] } });
    expect(await titles()).toEqual(['Uji NEW_BUY 0']);
    await s.send('PUT', `${SM}/alert-prefs`, { prefs: { minWalletScore: 0, watchlistOnly: true } });
    expect(await titles()).toEqual([]);
    await s.send('POST', `${SM}/watchlist`, { kind: 'TOKEN', chain: 'ethereum', address: TOKEN });
    expect(await titles()).toEqual(['Uji NEW_BUY 0', 'Uji MULTI_WALLET_BUY 0', 'Uji LARGE_SELL 0']);
    const [newBuy] = (await s.get(`${SM}/alerts`)).json().items;
    expect(newBuy).toMatchObject({ watchlisted: true, walletWatched: false, severity: 'MEDIUM' });
  });

  it('EDGE-SM-API-012 wallet dipantau: lolos skor minimum, NEW_BUY naik HIGH, alert watchOnly hanya bagi pemantau', async () => {
    await ctx.repo.insertAlerts([
      storedAlert({ kind: 'NEW_BUY', wallet: WALLET, usd: 2_000, walletScore: 10, createdAt: t0 + 1 }),
      storedAlert({ kind: 'WALLET_EXIT', wallet: WALLET, usd: null, walletScore: 10, watchOnly: true, createdAt: t0 + 2 }),
    ]);
    expect(await titles()).toEqual([]);
    await s.send('POST', `${SM}/watchlist`, { kind: 'WALLET', chain: 'ethereum', address: WALLET });
    const items = (await s.get(`${SM}/alerts`)).json().items;
    expect(items.map((a) => [a.kind, a.severity, a.walletWatched])).toEqual([['WALLET_EXIT', 'MEDIUM', true], ['NEW_BUY', 'HIGH', true]]);
    expect(items.every((a) => !('watchOnly' in a.evidence))).toBe(true);
  });

  it('EDGE-SM-API-013 preferensi tersimpan rusak → default dipakai (tanpa error); id tidak dikenal tidak dihitung', async () => {
    await ctx.repo.saveAlertPrefs(s.userId, { minUsd: -5, asing: true });
    expect((await s.get(`${SM}/alert-prefs`)).json()).toEqual({ prefs: { ...DEFAULT_ALERT_PREFS, kinds: [...ALERT_KINDS] }, isDefault: true });
    await ctx.repo.insertAlerts([storedAlert({ createdAt: t0 })]);
    const body = (await s.get(`${SM}/alerts?limit=1`)).json();
    expect(body).toMatchObject({ unread: 1, items: [{ title: 'Uji MULTI_WALLET_BUY 0' }] });
    expect((await s.send('POST', `${SM}/alerts/read`, { ids: [body.items[0].id, 99_999] })).json()).toEqual({ updated: 1 });
    expect((await s.send('POST', `${SM}/alerts/read`, { all: true })).json()).toEqual({ updated: 0 });
  });
});
