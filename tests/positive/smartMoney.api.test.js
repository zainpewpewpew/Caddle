// API Insider / Smart Money Radar — alur positif (docs/15 §4–§5). Data = DATA SIMULASI fixture
// (tests/fixtures/smartmoney/scenario.js) yang dimasukkan lewat sinkronisasi asli (runSmartMoneySync).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ALERT_PREFS } from '../../backend/smartmoney/alerts.js';
import {
  ALERT_KINDS, DISCLAIMERS, RELEVANCE_LEVELS, explorerAddressUrl, explorerTokenUrl, explorerTxUrl,
} from '../../backend/smartmoney/contracts.js';
import { runSmartMoneySync } from '../../backend/smartmoney/sync.js';
import { DEFAULT_MANUAL_COOLDOWN_MS } from '../../backend/smartmoney/syncRunner.js';
import { seedSignals } from '../helpers/signalSeed.js';
import { SM, createSmartMoneyApp, session } from '../helpers/smartMoneyApi.js';
import { ANALYST } from '../helpers/testApp.js';

const DEFAULT_PREFS = { ...DEFAULT_ALERT_PREFS, kinds: [...ALERT_KINDS] };
const isDesc = (values) => values.every((v, i) => i === 0 || values[i - 1] >= v);

describe('API Smart Money — tanpa provider (keadaan jujur "belum ada sumber data")', () => {
  let ctx;
  let s;
  beforeAll(async () => {
    ctx = await createSmartMoneyApp({ providers: '', seed: false });
    s = await session(ctx.app);
  });
  afterAll(async () => { await ctx.app.close(); });

  it('POS-SM-API-001 semua endpoint baca → 200 dengan meta providersConfigured 0, daftar kosong, tanpa data contoh', async () => {
    for (const path of ['/status', '/radar', '/wallets', '/alerts', '/screener-links', '/evaluation', '/watchlist']) {
      const res = await s.get(`${SM}${path}`);
      expect(res.statusCode, path).toBe(200);
      expect(res.headers['cache-control'], path).toContain('no-store');
      expect(res.json().meta, path).toEqual({
        simulated: false, dataAsOf: null, lastSyncAt: null, isStale: true,
        coverage: { chains: [], wallets: 0, activities: 0 }, providersConfigured: 0, disclaimers: { ...DISCLAIMERS }, attributions: [],
      });
    }
    expect((await s.get(`${SM}/radar`)).json()).toMatchObject({ window: '24h', computedAt: ctx.scenario.now, items: [] });
    expect((await s.get(`${SM}/wallets`)).json().items).toEqual([]);
    expect((await s.get(`${SM}/alerts`)).json()).toMatchObject({ items: [], unread: 0 });
    expect((await s.get(`${SM}/screener-links`)).json().items).toEqual({});
    expect((await s.get(`${SM}/evaluation`)).json()).toMatchObject({ available: false });
    expect((await s.get(`${SM}/status`)).json()).toMatchObject({ providers: [], lastRun: null });
    expect((await s.get(`${SM}/watchlist`)).json().items).toEqual([]);
    expect((await s.get(`${SM}/alert-prefs`)).json()).toEqual({ prefs: DEFAULT_PREFS, isDefault: true });
  });
});

describe('API Smart Money — data simulasi tersinkron (baca)', () => {
  let ctx;
  let s;
  let exp;
  let W;
  beforeAll(async () => {
    ctx = await createSmartMoneyApp();
    // Sinyal LONG SYNUSDT dari pipeline asli atas candle SINTETIS → token SYN (base) MATCHED dapat ditautkan.
    await seedSignals(ctx.app.services.repos);
    s = await session(ctx.app);
    exp = ctx.scenario.expectations;
    W = ctx.scenario.wallets;
  });
  afterAll(async () => { await ctx.app.close(); });

  it('POS-SM-API-002 /status: provider fixture terkonfigurasi OK, meta segar & bertanda simulasi, ringkasan run terakhir', async () => {
    const body = (await s.get(`${SM}/status`)).json();
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0]).toMatchObject({
      id: 'fixture', displayName: 'Fixture (data simulasi)', requiresKey: false, configured: true, isSimulated: true,
      state: 'OK', lastAttemptAt: ctx.scenario.now, lastSuccessAt: ctx.scenario.now, lastErrorCode: null, lastErrorMessage: null,
    });
    expect(body.providers[0].capabilities).toEqual([...body.providers[0].capabilities].sort());
    expect(body.meta).toMatchObject({
      simulated: true, providersConfigured: 1, lastSyncAt: ctx.scenario.now, isStale: false, attributions: [],
      coverage: { chains: ['base', 'ethereum'], wallets: ctx.summary.wallets.tracked, activities: expect.any(Number) },
    });
    expect(body.meta.dataAsOf).toBeLessThanOrEqual(ctx.scenario.now);
    expect(body.lastRun).toMatchObject({
      status: 'OK', inserted: ctx.summary.inserted, alerts: ctx.summary.alerts, finishedAt: ctx.scenario.now, errors: [],
    });
  });

  it('POS-SM-API-003 radar 24 jam: TKA dibeli wallet independen (klaster tertaut dihitung satu), bukti tx, bukan-beli dipisah', async () => {
    const body = (await s.get(`${SM}/radar?window=24h`)).json();
    expect(body).toMatchObject({ window: '24h', computedAt: ctx.scenario.now });
    expect(isDesc(body.items.map((i) => i.conviction))).toBe(true);
    const tka = body.items.find((i) => i.tokenKey === `ethereum:${exp.tka.address}`);
    expect(tka).toMatchObject({
      chain: 'ethereum', state: 'ACCUMULATING', independentBuyers: exp.tka.expectedIndependentClusters, isSimulated: true,
      watching: false, binance: { status: 'MATCHED', futuresSymbol: 'TKAUSDT' },
    });
    const buyers = tka.buyers.map((b) => b.wallet);
    expect(buyers).toEqual(expect.arrayContaining([...exp.tka.qualityBuyers, ...exp.tka.linkedBuyers]));
    const [l1, l2] = exp.tka.linkedBuyers.map((w) => tka.buyers.find((b) => b.wallet === w));
    expect(l1.clusterId).toBe(l2.clusterId);
    // Penarikan exchange & bridge masuk milik Q4 tidak pernah dihitung sebagai pembelian.
    expect(buyers).not.toContain(W.Q4);
    expect(tka.excluded.cexWithdrawal).toBeGreaterThanOrEqual(1);
    expect(tka.excluded.bridge).toBeGreaterThanOrEqual(1);
    for (const b of tka.buyers) {
      expect(b).toHaveProperty('label');
      for (const t of b.txs) expect(t.explorerUrl).toBe(explorerTxUrl('ethereum', t.txHash));
    }
    expect(tka.reasons.length).toBeGreaterThan(0);
    expect(tka.screener.note).toContain(DISCLAIMERS.spotVsFutures);
    expect(body.meta).toMatchObject({ simulated: true, disclaimers: { conviction: DISCLAIMERS.conviction } });
  });

  it('POS-SM-API-004 filter radar diterapkan di server: chain, minBuyers, state, linked, limit, jendela', async () => {
    const items = async (q) => (await s.get(`${SM}/radar?${q}`)).json().items;
    const all = await items('');
    expect(all.length).toBeGreaterThan(3);
    const base = await items('chain=base');
    expect(base.length).toBeGreaterThan(0);
    expect(base.every((i) => i.chain === 'base')).toBe(true);
    expect((await items('minBuyers=3')).map((i) => i.token.symbol)).toEqual(['TKA']);
    const exiting = await items('state=EXITING');
    expect(exiting.length).toBeGreaterThan(0);
    expect(exiting.every((i) => i.state === 'EXITING')).toBe(true);
    const linked = await items('linked=true');
    expect(linked.every((i) => i.binance.status === 'MATCHED')).toBe(true);
    expect(linked.map((i) => i.binance.futuresSymbol).sort()).toEqual(['1000PEPEUSDT', 'SYNUSDT', 'TKAUSDT']);
    expect(await items('linked=false')).toHaveLength(all.length);
    expect(await items('limit=1')).toEqual([all[0]]);
    const week = (await items('window=7d')).map((i) => i.tokenKey);
    expect(week).toEqual(expect.arrayContaining(all.map((i) => i.tokenKey)));
    const hour = await items('window=1h');
    expect(hour.length).toBeLessThanOrEqual(all.length);
  });

  it('POS-SM-API-005 hanya kontrak MATCHED yang ditautkan ke Binance & sinyal LONG; simbol sama kontrak beda tidak', async () => {
    const items = (await s.get(`${SM}/radar`)).json().items;
    const mapped = items.find((i) => i.tokenKey === `ethereum:${exp.pepe.mapped}`);
    const sameSymbol = items.find((i) => i.tokenKey === `ethereum:${exp.pepe.unmapped}`);
    expect(mapped.binance).toMatchObject({ status: 'MATCHED', futuresSymbol: exp.pepe.futuresSymbol, multiplier: exp.pepe.multiplier });
    expect(sameSymbol.token.symbol).toBe(mapped.token.symbol);
    expect(sameSymbol.binance.status).toBe('SYMBOL_ONLY');
    expect(sameSymbol.screener).toMatchObject({ relevance: 'TIDAK_TERHUBUNG', signals: [] });
    const syn = items.find((i) => i.tokenKey === `base:${exp.screenerLink.address}`);
    expect(syn.binance.futuresSymbol).toBe(exp.screenerLink.futuresSymbol);
    expect(syn.screener.signals.length).toBeGreaterThan(0);
    expect(syn.screener.signals.every((sig) => ['5m', '15m', '1h'].includes(sig.timeframe))).toBe(true);
    expect(RELEVANCE_LEVELS).toContain(syn.screener.relevance);
    expect(syn.screener.relevance).not.toBe('TIDAK_TERHUBUNG');
  });

  it('POS-SM-API-006 Wallet Discovery: urut skor, flag berat disembunyikan default, filter eligible/chain/gaya/minScore', async () => {
    const list = (await s.get(`${SM}/wallets`)).json().items;
    expect(isDesc(list.map((w) => w.score))).toBe(true);
    const addresses = list.map((w) => w.address);
    expect(addresses).not.toContain(exp.marketMaker.wallet);
    expect(addresses).not.toContain(exp.bot.wallet);
    const l1 = list.find((w) => w.address === exp.linked.a);
    expect(l1).toEqual({
      chain: 'ethereum', address: exp.linked.a, score: expect.any(Number), eligible: true, style: expect.any(String),
      clusterId: expect.any(String), clusterSize: 2, flags: expect.any(Array), metrics: expect.any(Object),
      topReason: expect.any(String), labels: [], lastActivityAt: expect.any(Number), watching: false, isSimulated: true,
    });
    const flagged = (await s.get(`${SM}/wallets?includeFlagged=true&limit=500`)).json().items;
    const bot = flagged.find((w) => w.address === exp.bot.wallet);
    expect(bot.eligible).toBe(false);
    expect(bot.flags.some((f) => f.code === 'BOT' && f.severity === 'HIGH')).toBe(true);
    expect(bot.topReason).toEqual(expect.any(String));
    const eligible = (await s.get(`${SM}/wallets?eligible=true`)).json().items;
    expect(eligible.length).toBeGreaterThan(0);
    expect(eligible.every((w) => w.eligible)).toBe(true);
    expect((await s.get(`${SM}/wallets?eligible=false`)).json().items.every((w) => !w.eligible)).toBe(true);
    expect((await s.get(`${SM}/wallets?chain=base`)).json().items.every((w) => w.chain === 'base')).toBe(true);
    expect((await s.get(`${SM}/wallets?style=SWING`)).json().items.every((w) => w.style === 'SWING')).toBe(true);
    expect((await s.get(`${SM}/wallets?minScore=45`)).json().items.every((w) => w.score >= 45)).toBe(true);
    expect((await s.get(`${SM}/wallets?limit=2`)).json().items).toHaveLength(2);
  });

  it('POS-SM-API-007 profil wallet: identitas+explorer, skor+alasan, klaster dengan bukti, PnL, aktivitas terbaru dulu', async () => {
    const res = await s.get(`${SM}/wallets/ethereum/${exp.linked.a}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.wallet).toMatchObject({
      chain: 'ethereum', address: exp.linked.a, explorerUrl: explorerAddressUrl('ethereum', exp.linked.a), isSimulated: true,
      firstSeenAt: expect.any(Number), discoveredVia: expect.any(String),
    });
    expect(body.score).toMatchObject({ eligible: true, reasons: expect.any(Array), limitations: expect.any(Array), computedAt: ctx.scenario.now });
    expect(body.score.reasons.length).toBeGreaterThan(0);
    expect(body.cluster.members).toEqual(expect.arrayContaining([exp.linked.a, exp.linked.b]));
    expect(body.cluster.reasons.length).toBeGreaterThan(0);
    expect(body.cluster.reasons.every((r) => [exp.linked.a, exp.linked.b].includes(r.a) && [exp.linked.a, exp.linked.b].includes(r.b))).toBe(true);
    expect(body.pnl.summary).toMatchObject({ closedTradesCount: expect.any(Number) });
    expect(Array.isArray(body.pnl.positions)).toBe(true);
    expect(body.activities.length).toBeGreaterThan(0);
    expect(body.activities.length).toBeLessThanOrEqual(200);
    expect(isDesc(body.activities.map((a) => a.blockTime))).toBe(true);
    expect(body.activities.every((a) => a.wallet === exp.linked.a && a.explorerUrl === explorerTxUrl('ethereum', a.txHash))).toBe(true);
    expect(body).toMatchObject({ watching: false, meta: { simulated: true } });
  });

  it('POS-SM-API-008 detail token: Binance MATCHED, radar 24 jam, aktivitas per wallet terbaru dulu, screener', async () => {
    const body = (await s.get(`${SM}/tokens/ethereum/${exp.tka.address}`)).json();
    expect(body.token).toEqual({
      chain: 'ethereum', address: exp.tka.address, symbol: 'TKA', name: expect.any(String), decimals: 18,
      explorerUrl: explorerTokenUrl('ethereum', exp.tka.address), isSimulated: true,
    });
    expect(body.binance).toMatchObject({ status: 'MATCHED', futuresSymbol: 'TKAUSDT' });
    expect(body.radar).toMatchObject({ tokenKey: `ethereum:${exp.tka.address}`, independentBuyers: exp.tka.expectedIndependentClusters, isSimulated: true });
    expect(body.activities.every((a) => a.token.address === exp.tka.address)).toBe(true);
    expect(isDesc(body.activities.map((a) => a.blockTime))).toBe(true);
    expect(body.activities.map((a) => a.txHash)).toEqual(expect.arrayContaining(exp.tka.buyTxs));
    expect(RELEVANCE_LEVELS).toContain(body.screener.relevance);
    expect(body.screener.note).toContain(DISCLAIMERS.spotVsFutures);
    expect(body.watching).toBe(false);
  });

  it('POS-SM-API-009 alert dengan preferensi default: hanya yang lolos ambang; bukti tx & penanda simulasi', async () => {
    const body = (await s.get(`${SM}/alerts`)).json();
    // Default minWalletScore 60: seluruh wallet simulasi < 60 → hanya alert multi-wallet (tanpa wallet) yang lolos.
    expect(body.items.map((a) => a.kind)).toEqual(['MULTI_WALLET_BUY']);
    expect(body.unread).toBe(1);
    expect(body.items[0]).toMatchObject({
      id: expect.any(Number), read: false, isSimulated: true, chain: 'ethereum', tokenKey: `ethereum:${exp.tka.address}`,
      wallet: null, symbol: 'TKA', usd: expect.any(Number), watchlisted: false, walletWatched: false,
    });
    expect(body.items[0].evidence.txHashes.length).toBeGreaterThan(0);
    expect(body.items[0].evidence).not.toHaveProperty('watchOnly');
    expect(body.meta.simulated).toBe(true);
  });

  it('POS-SM-API-010 /screener-links: peta futuresSymbol → ringkasan, hanya token MATCHED', async () => {
    const body = (await s.get(`${SM}/screener-links`)).json();
    expect(Object.keys(body.items).sort()).toEqual(['1000PEPEUSDT', 'SYNUSDT', 'TKAUSDT']);
    expect(body.items.TKAUSDT).toEqual({
      tokenKey: `ethereum:${exp.tka.address}`, symbol: 'TKA', chain: 'ethereum', address: exp.tka.address,
      independentBuyers: exp.tka.expectedIndependentClusters, conviction: expect.any(Number), state: 'ACCUMULATING',
      lastActivityAt: expect.any(Number), isSimulated: true,
    });
    // Kontrak yang dipetakan — bukan token lain bersimbol sama.
    expect(body.items['1000PEPEUSDT'].address).toBe(exp.pepe.mapped);
    expect(body.meta.simulated).toBe(true);
  });
});

describe('API Smart Money — watchlist, alert, preferensi (per pengguna)', () => {
  let ctx;
  let s;
  let exp;
  beforeEach(async () => {
    ctx = await createSmartMoneyApp();
    s = await session(ctx.app);
    exp = ctx.scenario.expectations;
  });
  afterEach(async () => { await ctx.app.close(); });

  it('POS-SM-API-011 ikuti token & wallet → 201, ringkasan di watchlist, `watching` di radar/wallet/profil/token, audit', async () => {
    const tkaAdd = await s.send('POST', `${SM}/watchlist`, { kind: 'TOKEN', chain: 'ethereum', address: exp.tka.address, note: 'pantau akumulasi' });
    expect(tkaAdd.statusCode).toBe(201);
    expect(tkaAdd.json()).toEqual({ kind: 'TOKEN', chain: 'ethereum', address: exp.tka.address, note: 'pantau akumulasi', createdAt: ctx.scenario.now });
    const walletAdd = await s.send('POST', `${SM}/watchlist`, { kind: 'WALLET', chain: 'ethereum', address: exp.tka.repeatBuyer });
    expect(walletAdd.statusCode).toBe(201);

    const items = (await s.get(`${SM}/watchlist`)).json().items;
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.kind === 'TOKEN').summary).toMatchObject({ symbol: 'TKA', conviction: expect.any(Number), state: 'ACCUMULATING' });
    expect(items.find((i) => i.kind === 'WALLET').summary).toMatchObject({ score: expect.any(Number), eligible: true, tracked: true });

    const radar = (await s.get(`${SM}/radar`)).json().items;
    expect(radar.find((i) => i.tokenKey === `ethereum:${exp.tka.address}`).watching).toBe(true);
    expect(radar.filter((i) => i.watching)).toHaveLength(1);
    expect((await s.get(`${SM}/wallets`)).json().items.find((w) => w.address === exp.tka.repeatBuyer).watching).toBe(true);
    expect((await s.get(`${SM}/wallets/ethereum/${exp.tka.repeatBuyer}`)).json().watching).toBe(true);
    expect((await s.get(`${SM}/tokens/ethereum/${exp.tka.address}`)).json().watching).toBe(true);

    const del = await s.send('DELETE', `${SM}/watchlist`, { kind: 'TOKEN', chain: 'ethereum', address: exp.tka.address });
    expect(del.statusCode).toBe(204);
    expect(del.body).toBe('');
    expect((await s.get(`${SM}/watchlist`)).json().items.map((i) => i.kind)).toEqual(['WALLET']);

    const audit = await ctx.app.services.repos.audit.recent(10);
    const actions = audit.filter((a) => a.action.startsWith('smartmoney.')).map((a) => [a.action, a.user_id, a.detail.kind]);
    expect(actions).toEqual([
      ['smartmoney.watchlist.remove', s.userId, 'TOKEN'],
      ['smartmoney.watchlist.add', s.userId, 'WALLET'],
      ['smartmoney.watchlist.add', s.userId, 'TOKEN'],
    ]);
  });

  it('POS-SM-API-012 tandai alert dibaca per id dan "semua"; ambang lebih longgar menampilkan lebih banyak alert', async () => {
    const first = (await s.get(`${SM}/alerts`)).json();
    const read = await s.send('POST', `${SM}/alerts/read`, { ids: [first.items[0].id] });
    expect(read.json()).toEqual({ updated: 1 });
    const after = (await s.get(`${SM}/alerts`)).json();
    expect(after.unread).toBe(0);
    expect(after.items[0].read).toBe(true);
    expect((await s.get(`${SM}/alerts?unread=true`)).json().items).toEqual([]);

    expect((await s.send('PUT', `${SM}/alert-prefs`, { prefs: { minWalletScore: 0 } })).statusCode).toBe(200);
    const more = (await s.get(`${SM}/alerts`)).json();
    const kinds = new Set(more.items.map((a) => a.kind));
    expect(kinds).toEqual(new Set(['MULTI_WALLET_BUY', 'NEW_BUY', 'REPEAT_ACCUMULATION', 'LARGE_SELL']));
    expect(isDesc(more.items.map((a) => a.createdAt))).toBe(true);
    const largeSell = more.items.find((a) => a.kind === 'LARGE_SELL');
    expect(largeSell).toMatchObject({ wallet: exp.largeSell.wallet, tokenKey: `ethereum:${exp.largeSell.token}`, usd: expect.any(Number) });
    expect(largeSell.evidence.txHashes).toContain(exp.largeSell.txHash);
    const newBuys = (await s.get(`${SM}/alerts?kind=NEW_BUY`)).json();
    expect(newBuys.items.length).toBeGreaterThan(0);
    expect(newBuys.items.every((a) => a.kind === 'NEW_BUY')).toBe(true);
    expect(newBuys.unread).toBe(more.unread);
    expect((await s.get(`${SM}/alerts?limit=2`)).json().items).toHaveLength(2);

    const all = await s.send('POST', `${SM}/alerts/read`, { all: true });
    expect(all.json()).toEqual({ updated: more.unread });
    expect((await s.get(`${SM}/alerts`)).json().unread).toBe(0);
  });

  it('POS-SM-API-013 preferensi notifikasi: default → simpan (dinormalisasi, urutan jenis kanonik) → dibaca ulang, diaudit', async () => {
    expect((await s.get(`${SM}/alert-prefs`)).json()).toEqual({ prefs: DEFAULT_PREFS, isDefault: true });
    const put = await s.send('PUT', `${SM}/alert-prefs`, {
      prefs: { kinds: ['LARGE_SELL', 'NEW_BUY'], minUsd: 500, cooldownMs: 3_600_000, watchlistOnly: true },
    });
    expect(put.statusCode).toBe(200);
    const saved = { ...DEFAULT_PREFS, kinds: ['NEW_BUY', 'LARGE_SELL'], minUsd: 500, cooldownMs: 3_600_000, watchlistOnly: true };
    expect(put.json()).toEqual({ prefs: saved, isDefault: false });
    expect((await s.get(`${SM}/alert-prefs`)).json()).toEqual({ prefs: saved, isDefault: false });
    const [entry] = await ctx.app.services.repos.audit.recent(1);
    expect(entry).toMatchObject({ action: 'smartmoney.alertPrefs.update', outcome: 'success', user_id: s.userId, detail: { prefs: saved } });
  });

  it('POS-SM-API-014 laporan evaluasi terakhir tersedia setelah disimpan (bertanda simulasi)', async () => {
    await ctx.repo.saveEvaluation({ computedAt: ctx.scenario.now, params: { stepMs: 3_600_000 }, report: { signals: 3 }, isSimulated: true });
    expect((await s.get(`${SM}/evaluation`)).json()).toMatchObject({
      available: true, computedAt: ctx.scenario.now, params: { stepMs: 3_600_000 }, report: { signals: 3 }, isSimulated: true,
      meta: { simulated: true },
    });
  });

  it('POS-SM-API-015 analyst (bukan admin) boleh membaca dan mengelola watchlist & preferensinya sendiri', async () => {
    const analyst = await session(ctx.app, ANALYST);
    expect((await analyst.get(`${SM}/radar`)).statusCode).toBe(200);
    expect((await analyst.send('POST', `${SM}/watchlist`, { kind: 'TOKEN', chain: 'ethereum', address: exp.tka.address })).statusCode).toBe(201);
    expect((await analyst.send('PUT', `${SM}/alert-prefs`, { prefs: { minUsd: 10 } })).statusCode).toBe(200);
    expect((await analyst.get(`${SM}/watchlist`)).json().items).toHaveLength(1);
    // Watchlist & preferensi admin tidak tersentuh.
    expect((await s.get(`${SM}/watchlist`)).json().items).toEqual([]);
    expect((await s.get(`${SM}/alert-prefs`)).json().isDefault).toBe(true);
  });
});

describe('API Smart Money — tombol "Sync sekarang"', () => {
  let ctx;
  afterEach(async () => { await ctx?.app.close(); ctx = null; });

  const syncAudit = async () => (await ctx.app.services.repos.audit.recent(50)).filter((a) => a.action === 'smartmoney.sync');

  it('POS-SM-API-016 GET /sync: ringkasan putaran terakhir, jeda aktif setelah putaran, admin boleh memicu, analyst tidak', async () => {
    ctx = await createSmartMoneyApp();
    const admin = await session(ctx.app);
    const body = (await admin.get(`${SM}/sync`)).json();
    expect(body).toMatchObject({
      running: false, run: null, canTrigger: true, reason: null, providersConfigured: 1, intervalMinutes: 15,
      cooldownUntil: ctx.summary.finishedAt + DEFAULT_MANUAL_COOLDOWN_MS,
      lastRun: { status: 'OK', startedAt: ctx.summary.startedAt, finishedAt: ctx.summary.finishedAt, inserted: ctx.summary.inserted },
    });
    const analyst = await session(ctx.app, ANALYST);
    expect((await analyst.get(`${SM}/sync`)).json()).toMatchObject({ canTrigger: false, reason: 'NOT_ADMIN', lastRun: { status: 'OK' } });
    ctx.clock.advance(DEFAULT_MANUAL_COOLDOWN_MS);
    expect((await admin.get(`${SM}/sync`)).json().cooldownUntil).toBeNull();
  });

  it('POS-SM-API-017 POST /sync → 202 seketika, putaran berjalan di latar dan menulis lastRun baru; diaudit', async () => {
    ctx = await createSmartMoneyApp();
    const admin = await session(ctx.app);
    ctx.clock.advance(DEFAULT_MANUAL_COOLDOWN_MS);
    const now = ctx.clock();
    const res = await admin.send('POST', `${SM}/sync`);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({
      started: true, run: { owner: 'server', trigger: 'manual', startedAt: now, updatedAt: now, phase: 'start', done: null, total: null },
    });
    await ctx.app.services.smartMoneySync.pending(); // null bila putaran (fixture, cepat) sudah selesai lebih dulu
    const after = (await admin.get(`${SM}/sync`)).json();
    expect(after).toMatchObject({ running: false, run: null, lastRun: { status: 'OK', startedAt: now }, cooldownUntil: now + DEFAULT_MANUAL_COOLDOWN_MS });
    expect(await ctx.repo.getSyncLease()).toBeNull();
    // Data radar tetap ada (putaran ulang atas data yang sama tidak menghapus apa pun).
    expect((await admin.get(`${SM}/radar`)).json().items.length).toBeGreaterThan(0);
    const [entry] = await syncAudit();
    expect(entry).toMatchObject({ outcome: 'success', user_id: admin.userId, detail: { trigger: 'manual', providers: ['fixture'] } });
  });

  it('POS-SM-API-018 progres per tahap terlihat semua pengguna selama berjalan; klik kedua → 409 SYNC_RUNNING; selesai → lastRun', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    ctx = await createSmartMoneyApp({
      appOptions: {
        smartMoneySync: {
          runSync: async (deps) => {
            deps.onProgress({ phase: 'mapping', done: null, total: null });
            deps.onProgress({ phase: 'transfers', done: 2, total: 5 });
            await gate;
            return runSmartMoneySync(deps);
          },
        },
      },
    });
    const admin = await session(ctx.app);
    const analyst = await session(ctx.app, ANALYST);
    ctx.clock.advance(DEFAULT_MANUAL_COOLDOWN_MS);
    expect((await admin.send('POST', `${SM}/sync`)).statusCode).toBe(202);
    const during = (await analyst.get(`${SM}/sync`)).json();
    expect(during).toMatchObject({
      running: true, canTrigger: false, reason: 'NOT_ADMIN',
      run: { owner: 'server', trigger: 'manual', phase: 'transfers', done: 2, total: 5 },
    });
    const again = await admin.send('POST', `${SM}/sync`);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: 'SYNC_RUNNING', message: expect.stringMatching(/sedang berjalan/), run: { phase: 'transfers', done: 2, total: 5 } });
    release();
    await ctx.app.services.smartMoneySync.pending();
    expect((await admin.get(`${SM}/sync`)).json()).toMatchObject({ running: false, run: null, lastRun: { status: 'OK', startedAt: ctx.clock() } });
    expect((await syncAudit()).map((a) => [a.outcome, a.detail.reason ?? null])).toEqual([['failure', 'SYNC_RUNNING'], ['success', null]]);
  });
});
