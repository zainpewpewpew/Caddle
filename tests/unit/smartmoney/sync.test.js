import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../../backend/database/connection.js';
import { migrate } from '../../../backend/database/migrate.js';
import { DEFAULT_ALERT_PREFS } from '../../../backend/smartmoney/alerts.js';
import { matchToken } from '../../../backend/smartmoney/binanceMatch.js';
import { EXCLUDING_FLAGS, QUOTE_ASSETS, tokenKey, walletKey } from '../../../backend/smartmoney/contracts.js';
import { enrichNativeUsd } from '../../../backend/smartmoney/nativePrices.js';
import { ProviderError } from '../../../backend/smartmoney/providers/errors.js';
import { createFixtureProvider } from '../../../backend/smartmoney/providers/fixtureProvider.js';
import { createProviderRegistry } from '../../../backend/smartmoney/providers/registry.js';
import { createSmartMoneyRepository } from '../../../backend/smartmoney/repository.js';
import {
  DEFAULT_SYNC_TUNING, SYNC_STATE_KEYS, matchedTokensFromMapping, permissiveAlertPrefs, runSmartMoneySync,
  sanitizeProviderMessage,
} from '../../../backend/smartmoney/sync.js';
import { buildScenario } from '../../fixtures/smartmoney/scenario.js';

// Seluruh data berasal dari skenario SIMULASI (alamat & hash fiktif) lewat provider fixture.
const SCENARIO = buildScenario();
const E = SCENARIO.expectations;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function setup({ adapters, fixtureOptions = {}, config = { maxWalletsPerSync: 50 }, users = 0 } = {}) {
  const db = openDatabase(':memory:');
  migrate(db, { now: () => new Date(0) });
  let t = SCENARIO.now;
  const clock = () => t;
  const repo = createSmartMoneyRepository(db, { clock });
  const fixture = createFixtureProvider(SCENARIO, fixtureOptions);
  const list = adapters ? adapters(fixture) : [fixture];
  const registry = createProviderRegistry({ adapters: list, enabledIds: list.map((a) => a.id) });
  const addUser = db.prepare(`INSERT INTO users (username, password_hash, role, created_at, updated_at)
    VALUES (?, '$argon2id$v=19$fiktif', 'analyst', 0, 0)`);
  const userIds = Array.from({ length: users }, (_, i) => Number(addUser.run(`analis${i + 1}`).lastInsertRowid));
  return {
    db, repo, fixture, registry, userIds,
    advance: (ms) => { t += ms; },
    run: (extra = {}) => runSmartMoneySync({ repo, registry, clock, config, ...extra }),
  };
}

/** Adapter turunan (metode closure fixture tidak memakai `this`). */
const derive = (adapter, overrides) => ({ ...adapter, ...overrides });

function spyOn(adapter, method) {
  const calls = [];
  const original = adapter[method];
  return { calls, adapter: derive(adapter, { [method]: async (args) => { calls.push(args); return original(args); } }) };
}

const activityOf = async (repo, chain, wallet, txHash) => (await repo.listActivities({ chain, wallet, limit: 100_000 }))
  .filter((a) => a.txHash === txHash);

describe('sinkronisasi smart money (runSmartMoneySync)', () => {
  it('UNIT-SM-SYNC-001 alur normal: mapping, penemuan (CEX/pool dibuang), transfer, klasifikasi, skor, status provider', async () => {
    const { repo, run } = setup();
    const s = await run();
    expect(s.status).toBe('OK');
    expect(s.errors).toEqual([]);
    expect(s.mapping).toMatchObject({ refreshed: ['fixture'], upserted: SCENARIO.binanceMap.length, rejected: 0 });
    // 12 ethereum + 3 base kandidat valid; hot wallet CEX & pool berlabel dibuang; Q1 ganda digabung.
    expect(s.discovery.added).toBe(15);
    expect(s.discovery.skippedChains).toEqual(['solana']);
    expect(s.notes.some((n) => n.includes('solana') && n.includes('MATCHED'))).toBe(true);
    const tracked = await repo.listWallets();
    const keys = new Set(tracked.map((w) => walletKey(w.chain, w.address)));
    for (const excluded of E.excludedCandidates) expect(keys.has(walletKey('ethereum', excluded))).toBe(false);
    expect(tracked.filter((w) => w.address === E.duplicateCandidate)).toHaveLength(1);
    expect(tracked.every((w) => w.isSimulated === true)).toBe(true);
    expect(s.wallets).toMatchObject({ tracked: 15, selected: 15, synced: 15, failed: 0 });
    expect(s.inserted).toBeGreaterThan(500);
    expect(s.scored).toBe(15);
    // Semua aktivitas dari provider simulasi bertanda simulasi.
    const acts = await repo.listActivities({ limit: 100_000 });
    expect(acts.length).toBe(s.inserted);
    expect(acts.every((a) => a.isSimulated === true && a.provider === 'fixture')).toBe(true);
    const [status] = await repo.listProviderStatus();
    expect(status).toMatchObject({ provider: 'fixture', lastErrorCode: null, isSimulated: true, lastSuccessAt: SCENARIO.now });
    expect(s.providers).toEqual([expect.objectContaining({ id: 'fixture', state: 'OK', failed: 0 })]);
    const lastRun = await repo.getSyncState(SYNC_STATE_KEYS.lastRun);
    expect(lastRun.value).toMatchObject({ status: 'OK', inserted: s.inserted });
  });

  it('UNIT-SM-SYNC-002 klasifikasi tersimpan: hanya swap = beli; penarikan CEX/bridge/deposit CEX bukan beli/jual', async () => {
    const { repo, run } = setup();
    await run();
    const [withdrawal, bridgeIn] = E.tka.nonBuyInflows;
    expect((await activityOf(repo, 'ethereum', withdrawal.wallet, withdrawal.txHash))[0].type).toBe('CEX_WITHDRAWAL');
    expect((await activityOf(repo, 'ethereum', bridgeIn.wallet, bridgeIn.txHash))[0].type).toBe('BRIDGE_IN');
    expect((await activityOf(repo, 'ethereum', E.cexExit.wallet, E.cexExit.txHash))[0].type).toBe('CEX_DEPOSIT');
    const sell = await activityOf(repo, 'ethereum', E.largeSell.wallet, E.largeSell.txHash);
    expect(sell.map((a) => a.type)).toEqual(['SWAP_SELL']);
    // Simbol sama, kontrak berbeda → token berbeda.
    const a = await activityOf(repo, 'ethereum', SCENARIO.wallets.Q2, E.pepe.mappedBuyTx);
    const b = await activityOf(repo, 'ethereum', SCENARIO.wallets.Q3, E.pepe.unmappedBuyTx);
    expect(a[0].token.address).toBe(E.pepe.mapped);
    expect(b[0].token.address).toBe(E.pepe.unmapped);
    expect(a[0].token.symbol).toBe(b[0].token.symbol);
    expect((await repo.getToken('ethereum', E.pepe.mapped)).symbol).toBe('PEPE');
  });

  it('UNIT-SM-SYNC-003 wallet tertaut satu klaster (dihitung sekali); alert multi-wallet = 4 klaster independen', async () => {
    const { repo, run } = setup();
    await run();
    const l1 = await repo.getWalletScore('ethereum', E.linked.a);
    const l2 = await repo.getWalletScore('ethereum', E.linked.b);
    expect(l1.clusterId).toBe(l2.clusterId);
    expect(l1.flags.map((f) => f.code)).toContain('LINKED');
    const links = await repo.listWalletLinks('ethereum', E.linked.a);
    expect(links.map((l) => l.type)).toEqual(expect.arrayContaining(['DIRECT_TRANSFER', 'COMMON_FUNDER']));
    expect((await repo.clusterSizes()).get(l1.clusterId)).toBe(2);
    const alerts = await repo.listAlerts({ userId: 1, limit: 100 });
    const multi = alerts.find((x) => x.kind === 'MULTI_WALLET_BUY' && x.tokenKey === tokenKey('ethereum', E.tka.address));
    expect(multi.evidence.independentBuyers).toBe(E.tka.expectedIndependentClusters);
    expect(multi.message).toContain('bukan probabilitas profit');
  });

  it('UNIT-SM-SYNC-004 PnL tidak lengkap & flag tersimpan; wallet infrastruktur tidak eligible', async () => {
    const { repo, run } = setup();
    await run();
    const inc = await repo.getWalletScore('ethereum', E.incompletePnl.wallet);
    expect(inc.flags.map((f) => f.code)).toContain('INCOMPLETE_PNL');
    expect(inc.eligible).toBe(false);
    expect(inc.pnl.summary.completeness).not.toBe('COMPLETE');
    const bot = await repo.getWalletScore('base', E.bot.wallet);
    expect(bot.flags.some((f) => f.code === 'BOT' && f.severity === 'HIGH')).toBe(true);
    const mm = await repo.getWalletScore('ethereum', E.marketMaker.wallet);
    expect(mm.eligible).toBe(false);
    expect(mm.flags.some((f) => EXCLUDING_FLAGS.includes(f.code) && f.severity === 'HIGH')).toBe(true);
    expect((await repo.listWalletScores({ limit: 100 })).some((w) => w.address === E.bot.wallet)).toBe(false);
  });

  it('EDGE-SM-SYNC-001 transaksi duplikat: dibuang saat normalisasi; run ulang idempoten (tanpa aktivitas/alert ganda)', async () => {
    const { repo, run, advance } = setup();
    const s1 = await run();
    expect(s1.duplicates).toBeGreaterThanOrEqual(E.duplicateCount);
    const count1 = (await repo.listActivities({ limit: 100_000 })).length;
    const alerts1 = (await repo.listAlerts({ userId: 1, limit: 1000 })).length;
    advance(15 * MIN);
    const s2 = await run();
    expect(s2.status).toBe('OK');
    expect(s2.inserted).toBe(0);
    expect(s2.reclassified).toBe(0);
    expect(s2.duplicates).toBe(s2.fetched);
    expect(s2.alerts).toBe(0);
    expect((await repo.listActivities({ limit: 100_000 })).length).toBe(count1);
    expect((await repo.listAlerts({ userId: 1, limit: 1000 })).length).toBe(alerts1);
  });

  it('EDGE-SM-SYNC-002 data terlambat: kaki quote datang belakangan → TRANSFER_IN diklasifikasi ulang menjadi SWAP_BUY', async () => {
    const q3BuyTx = E.tka.buyTxs[4];
    const { repo, run, advance } = setup({ fixtureOptions: { lateTransfers: [`ethereum:${q3BuyTx}:0`] } });
    await run();
    const before = await activityOf(repo, 'ethereum', SCENARIO.wallets.Q3, q3BuyTx);
    expect(before.map((a) => a.type)).toEqual(['TRANSFER_IN']);
    advance(15 * MIN);
    const s2 = await run();
    expect(s2.reclassified).toBeGreaterThanOrEqual(1);
    const after = await activityOf(repo, 'ethereum', SCENARIO.wallets.Q3, q3BuyTx);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: before[0].id, type: 'SWAP_BUY', direction: 'IN' });
    expect(after[0].usdValue).toBeGreaterThan(0);
    // Pembelian yang baru diketahui memicu alert beli baru (data ≤ 24 jam).
    const alerts = await repo.listAlerts({ userId: 1, limit: 1000 });
    expect(alerts.some((a) => a.kind === 'NEW_BUY' && a.wallet === SCENARIO.wallets.Q3
      && a.tokenKey === tokenKey('ethereum', E.tka.address))).toBe(true);
  });

  it('EDGE-SM-SYNC-003 data terlambat: kaki token datang belakangan → TRANSFER_OUT USDC basi dihapus, SWAP_BUY masuk', async () => {
    const q3BuyTx = E.tka.buyTxs[4];
    const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const { repo, run, advance } = setup({ fixtureOptions: { lateTransfers: [`ethereum:${q3BuyTx}:1`] } });
    await run();
    const before = await activityOf(repo, 'ethereum', SCENARIO.wallets.Q3, q3BuyTx);
    expect(before.map((a) => [a.type, a.token.address])).toEqual([['TRANSFER_OUT', usdc]]);
    advance(15 * MIN);
    const s2 = await run();
    expect(s2.inserted).toBeGreaterThanOrEqual(1);
    expect(s2.reclassified).toBeGreaterThanOrEqual(1);
    const after = await activityOf(repo, 'ethereum', SCENARIO.wallets.Q3, q3BuyTx);
    expect(after.map((a) => [a.type, a.token.address])).toEqual([['SWAP_BUY', E.tka.address]]);
  });

  it('EDGE-SM-SYNC-004 data terlambat lintas batch (kedua kaki tertahan) masuk pada run berikutnya tanpa duplikat', async () => {
    const { repo, run, advance } = setup({ fixtureOptions: { lateTransfers: true } });
    await run();
    expect(await activityOf(repo, 'base', E.late.wallet, E.late.buyTx)).toEqual([]);
    advance(15 * MIN);
    const s2 = await run();
    expect(s2.inserted).toBe(1);
    const late = await activityOf(repo, 'base', E.late.wallet, E.late.buyTx);
    expect(late.map((a) => a.type)).toEqual(['SWAP_BUY']);
    advance(15 * MIN);
    expect((await run()).inserted).toBe(0);
  });

  it('EDGE-SM-SYNC-005 sumber data gagal: run tidak melempar, status DEGRADED, provider DOWN; pulih pada run berikutnya', async () => {
    const { repo, fixture, run, advance } = setup({ fixtureOptions: { failWith: 'UNAVAILABLE' } });
    const s1 = await run();
    expect(s1.status).toBe('DEGRADED');
    expect(s1.errors[0]).toMatchObject({ provider: 'fixture', code: 'UNAVAILABLE', method: 'fetchBinanceMapping' });
    expect(s1.errors.every((e) => !/https?:\/\//.test(e.message))).toBe(true);
    expect(s1.inserted).toBe(0);
    expect(s1.providers[0].state).toBe('DOWN');
    const [down] = await repo.listProviderStatus();
    expect(down).toMatchObject({ lastErrorCode: 'UNAVAILABLE', lastSuccessAt: null });
    fixture.setFailure(null);
    advance(15 * MIN);
    const s2 = await run();
    expect(s2.status).toBe('OK');
    expect(s2.inserted).toBeGreaterThan(500);
    const [up] = await repo.listProviderStatus();
    expect(up).toMatchObject({ lastErrorCode: null, lastSuccessAt: SCENARIO.now + 15 * MIN });
  });

  it('EDGE-SM-SYNC-006 satu provider gagal sebagian → DEGRADED (sukses & error pada run yang sama); wallet lain lanjut', async () => {
    const victim = SCENARIO.wallets.Q1;
    const { repo, run } = setup({
      adapters: (f) => [derive(f, {
        fetchWalletTransfers: async (args) => {
          if (args.address === victim) throw new ProviderError('TIMEOUT', 'fixture: batas waktu https://api.contoh.test/x?apikey=RAHASIA', { provider: 'fixture' });
          return f.fetchWalletTransfers(args);
        },
      })],
    });
    const s = await run();
    expect(s.status).toBe('DEGRADED');
    expect(s.wallets).toMatchObject({ synced: 14, failed: 1 });
    expect(s.errors).toEqual([expect.objectContaining({ code: 'TIMEOUT', chain: 'ethereum' })]);
    expect(s.errors[0].message).not.toMatch(/RAHASIA|https?:/);
    const [st] = await repo.listProviderStatus();
    expect(st.lastErrorCode).toBe('TIMEOUT');
    expect(st.lastSuccessAt).toBe(st.lastAttemptAt); // DEGRADED: sukses & gagal pada run yang sama
    expect(await repo.listActivities({ chain: 'ethereum', wallet: victim })).toEqual([]);
    expect((await repo.listActivities({ chain: 'ethereum', wallet: SCENARIO.wallets.Q2 })).length).toBeGreaterThan(0);
  });

  it('EDGE-SM-SYNC-007 RATE_LIMITED menghentikan provider itu sampai akhir run; provider cadangan melayani wallet', async () => {
    const limited = spyOn(createFixtureProvider(SCENARIO, { failWith: 'RATE_LIMITED' }), 'fetchWalletTransfers');
    const { run, repo } = setup({
      adapters: (f) => [
        derive(limited.adapter, { id: 'utama', capabilities: new Set(['walletTransfers']) }),
        derive(f, { id: 'cadangan' }),
      ],
    });
    const s = await run();
    expect(limited.calls).toHaveLength(1);
    expect(s.notes.some((n) => n.includes('"utama"') && n.includes('RATE_LIMITED'))).toBe(true);
    expect(s.wallets.synced).toBe(14);
    expect(s.wallets.failed).toBe(1);
    const statuses = new Map((await repo.listProviderStatus()).map((p) => [p.provider, p]));
    expect(statuses.get('utama')).toMatchObject({ lastErrorCode: 'RATE_LIMITED', lastSuccessAt: null });
    expect(statuses.get('cadangan')).toMatchObject({ lastErrorCode: null });
  });

  it('EDGE-SM-SYNC-008 NOT_SUPPORTED → beralih ke provider berikutnya tanpa menandai provider pertama gagal', async () => {
    const { run, repo } = setup({
      adapters: (f) => [
        derive(f, {
          id: 'parsial',
          capabilities: new Set(['walletTransfers']),
          fetchWalletTransfers: async ({ chain }) => {
            throw new ProviderError('NOT_SUPPORTED', `parsial: chain ${chain} tidak didukung`, { provider: 'parsial' });
          },
        }),
        f,
      ],
    });
    const s = await run();
    expect(s.status).toBe('OK');
    expect(s.wallets.synced).toBe(15);
    const statuses = new Map((await repo.listProviderStatus()).map((p) => [p.provider, p]));
    expect(statuses.has('parsial')).toBe(false); // tidak pernah benar-benar dipakai → status tidak berubah (NEVER)
    expect(s.providers.find((p) => p.id === 'parsial')).toMatchObject({ state: 'NEVER', notSupported: 2 });
  });

  it('EDGE-SM-SYNC-009 respons provider rusak: BAD_RESPONSE dicatat, transfer chain lain/tidak valid ditolak, adapter simulasi memaksa isSimulated', async () => {
    const victim = SCENARIO.wallets.Q2;
    const { run, repo } = setup({
      adapters: (f) => [derive(f, {
        fetchWalletTransfers: async (args) => {
          if (args.address === victim) return { transfers: 'bukan-array', nextCursor: null };
          const res = await f.fetchWalletTransfers(args);
          const tampered = res.transfers.map((t) => ({ ...t, isSimulated: false }));
          return { ...res, transfers: [...tampered, { ...tampered[0], chain: 'polygon' }, { junk: true }] };
        },
      })],
    });
    const s = await run();
    expect(s.errors).toEqual([expect.objectContaining({ code: 'BAD_RESPONSE', method: 'fetchWalletTransfers' })]);
    expect(s.rejected).toBeGreaterThanOrEqual(2 * 14);
    expect((await repo.listActivities({ limit: 100_000 })).every((a) => a.isSimulated === true)).toBe(true);
  });

  it('UNIT-SM-SYNC-005 tanpa provider: NO_PROVIDERS dengan catatan jujur, tidak ada data yang ditulis', async () => {
    const db = openDatabase(':memory:');
    migrate(db, { now: () => new Date(0) });
    const repo = createSmartMoneyRepository(db, { clock: () => SCENARIO.now });
    const registry = createProviderRegistry({ adapters: [], enabledIds: ['etherscan'] });
    const s = await runSmartMoneySync({ repo, registry, clock: () => SCENARIO.now, config: { maxWalletsPerSync: 10 } });
    expect(s.status).toBe('NO_PROVIDERS');
    expect(s.notes.join(' ')).toMatch(/etherscan/);
    expect(s.notes.join(' ')).toMatch(/Tidak ada data simulasi/);
    expect(await repo.coverage()).toMatchObject({ wallets: 0, activities: 0 });
    expect((await repo.getSyncState(SYNC_STATE_KEYS.lastRun)).value.status).toBe('NO_PROVIDERS');
  });

  it('UNIT-SM-SYNC-006 alert: teks netral, isSimulated dari aktivitas sumber; alert khusus wallet dipantau ditandai watchOnly', async () => {
    const { repo, run, userIds } = setup({ users: 1 });
    await repo.addToWatchlist(userIds[0], { kind: 'WALLET', chain: 'ethereum', address: E.cexExit.wallet });
    // Wallet Solana yang tidak ditemukan discovery tetap dilacak karena ada di watchlist.
    await repo.addToWatchlist(userIds[0], { kind: 'WALLET', chain: 'solana', address: E.solana.buyer });
    const s = await run();
    expect(s.alerts).toBeGreaterThan(0);
    const alerts = await repo.listAlerts({ userId: userIds[0], limit: 1000 });
    expect(alerts.every((a) => a.isSimulated === true)).toBe(true);
    const shared = alerts.filter((a) => a.evidence.watchOnly !== true);
    expect(shared.length).toBeGreaterThan(0);
    expect(shared.every((a) => !/dipantau/i.test(a.message))).toBe(true);
    const exit = alerts.find((a) => a.kind === 'WALLET_EXIT' && a.wallet === E.cexExit.wallet);
    expect(exit).toBeDefined();
    expect(exit.evidence.watchOnly).toBe(true);
    expect(exit.message).toContain('belum tentu dijual');
    expect(exit.evidence.txHashes).toContain(E.cexExit.txHash);
    expect(await repo.getWallet('solana', E.solana.buyer)).toMatchObject({ discoveredVia: 'watchlist' });
    expect((await activityOf(repo, 'solana', E.solana.buyer, E.solana.buyTx)).map((a) => a.type)).toEqual(['SWAP_BUY']);
    // Kunci dedupe memakai cooldown tetap server, bukan preferensi pengguna.
    await repo.saveAlertPrefs(userIds[0], { cooldownMs: 60_000, minUsd: 0 });
    const bucket = Math.floor(exit.dedupeKey.split(':').pop());
    expect(Number.isInteger(bucket)).toBe(true);
    const multi = alerts.find((a) => a.kind === 'MULTI_WALLET_BUY');
    const lastBuy = Math.max(...SCENARIO.rawTransfers.filter((t) => multi.evidence.txHashes.includes(t.txHash)).map((t) => t.blockTime));
    expect(multi.dedupeKey.endsWith(`:${Math.floor(lastBuy / DEFAULT_ALERT_PREFS.cooldownMs)}`)).toBe(true);
  });

  it('UNIT-SM-SYNC-007 kursor & paginasi: halaman kecil dilanjutkan lintas run sampai identik dengan sinkron penuh', async () => {
    const full = setup();
    await full.run();
    const fullIds = (await full.repo.listActivities({ limit: 100_000 })).map((a) => a.id).sort();

    const paged = setup({ fixtureOptions: { pageSize: 60 } });
    let runs = 0;
    let s;
    do {
      s = await paged.run({ tuning: { maxPagesPerWallet: 2 } });
      paged.advance(MIN);
      runs += 1;
    } while (s.inserted > 0 && runs < 40);
    expect(runs).toBeGreaterThan(3);
    const ids = (await paged.repo.listActivities({ limit: 100_000 })).map((a) => a.id).sort();
    expect(ids).toEqual(fullIds);
    // Kursor tersimpan (format v1); setelah batch pertama selesai `since` maju ke transfer terbaru − tumpang-tindih.
    const cursor = JSON.parse(await paged.repo.getCursor('fixture', 'base', E.bot.wallet));
    expect(cursor.v).toBe(1);
    expect(cursor.since).toBeGreaterThan(SCENARIO.now - 4 * DAY);
    expect(cursor.maxSeen).toBeLessThanOrEqual(SCENARIO.now);
  });

  it('UNIT-SM-SYNC-008 batas wallet per run: watchlist dulu, lalu yang belum/paling lama disinkronkan (bergilir)', async () => {
    const { repo, run, advance, userIds } = setup({ users: 1, config: { maxWalletsPerSync: 4 } });
    // Wallet Solana (tidak pernah ditemukan discovery: tanpa token MATCHED) hanya dilacak karena watchlist.
    await repo.addToWatchlist(userIds[0], { kind: 'WALLET', chain: 'solana', address: E.solana.buyer });
    const s1 = await run();
    expect(s1.discovery.added).toBe(4);
    expect(s1.wallets.selected).toBe(4);
    const synced1 = await repo.listWalletSyncTimes();
    expect(synced1.has(walletKey('solana', E.solana.buyer))).toBe(true);
    for (let i = 0; i < 6; i += 1) {
      advance(15 * MIN);
      await run();
    }
    const tracked = await repo.listWallets();
    const synced = await repo.listWalletSyncTimes();
    expect(tracked.length).toBe(16);
    expect(tracked.every((w) => synced.has(walletKey(w.chain, w.address)))).toBe(true);
  });

  it('UNIT-SM-SYNC-009 mapping Binance disegarkan paling sering sekali per 24 jam; penemuan bergilir per token', async () => {
    const mapping = spyOn(createFixtureProvider(SCENARIO), 'fetchBinanceMapping');
    const discovery = spyOn(mapping.adapter, 'discoverWallets');
    const { run, advance } = setup({ adapters: () => [discovery.adapter] });
    await run({ tuning: { discoveryTokensPerRun: 1 } });
    advance(HOUR);
    await run({ tuning: { discoveryTokensPerRun: 1 } });
    expect(mapping.calls).toHaveLength(1);
    advance(DAY);
    await run({ tuning: { discoveryTokensPerRun: 1 } });
    expect(mapping.calls).toHaveLength(2);
    const picked = discovery.calls.map((c) => `${c.chain}:${c.tokens.map((t) => t.address).join(',')}`);
    expect(discovery.calls.every((c) => c.tokens.length === 1)).toBe(true);
    expect(new Set(picked).size).toBe(3); // tiga token MATCHED (PEPE_A, TKA, SYN) bergiliran
    expect(discovery.calls[0].since).toBe(SCENARIO.now - DEFAULT_SYNC_TUNING.discoveryLookbackMs);
  });

  it('UNIT-SM-SYNC-010 USD koin native diisi enrichNativeUsd bila provider tidak memberi; kegagalannya tidak menghentikan run', async () => {
    // Provider tanpa nilai USD sama sekali (seperti Etherscan): hanya kaki WETH yang dapat dinilai dari harga native.
    const weth = Object.keys(QUOTE_ASSETS.ethereum).find((a) => QUOTE_ASSETS.ethereum[a] === 'WETH');
    const stripUsd = (f) => derive(f, {
      fetchWalletTransfers: async (args) => {
        const res = await f.fetchWalletTransfers(args);
        return { ...res, transfers: res.transfers.map((t) => ({ ...t, usdValue: null, priceSource: null })) };
      },
    });
    const q2TkaTx = E.tka.buyTxs[3];
    const wethLeg = SCENARIO.rawTransfers.find((t) => t.txHash === q2TkaTx && t.token.address === weth);
    const resolver = { priceAt: async () => ({ priceUsd: 3000, at: SCENARIO.now - HOUR, source: 'binance:ETHUSDT:1h' }) };
    const priced = setup({ adapters: (f) => [stripUsd(f)] });
    await priced.run({ nativePrices: resolver, enrichNativeUsd });
    const [buy] = await activityOf(priced.repo, 'ethereum', SCENARIO.wallets.Q2, q2TkaTx);
    expect(buy.type).toBe('SWAP_BUY');
    expect(buy.usdValue).toBeCloseTo(wethLeg.amount * 3000, 6);

    const broken = setup({ adapters: (f) => [stripUsd(f)] });
    const s = await broken.run({ nativePrices: resolver, enrichNativeUsd: async () => { throw new Error('jaringan putus'); } });
    expect(s.notes.some((n) => n.includes('null'))).toBe(true);
    const [unknown] = await activityOf(broken.repo, 'ethereum', SCENARIO.wallets.Q2, q2TkaTx);
    expect(unknown.type).toBe('SWAP_BUY');
    expect(unknown.usdValue).toBeNull(); // tidak diketahui ≠ 0
  });

  it('UNIT-SM-SYNC-011 dibatalkan (shutdown): ABORTED tanpa analisis; argumen tidak valid → TypeError', async () => {
    const { repo, run } = setup();
    const ctrl = new AbortController();
    ctrl.abort();
    const s = await run({ signal: ctrl.signal });
    expect(s.status).toBe('ABORTED');
    expect(s.scored).toBe(0);
    expect(await repo.coverage()).toMatchObject({ activities: 0 });
    await expect(runSmartMoneySync({ registry: { list: () => [] }, config: {} })).rejects.toThrow(TypeError);
    await expect(run({ tuning: { tidakAda: 1 } })).rejects.toThrow(TypeError);
    await expect(run({ tuning: { maxPagesPerWallet: 0 } })).rejects.toThrow(RangeError);
  });

  it('UNIT-SM-SYNC-012 helper: preferensi paling longgar (cooldown tetap), token MATCHED, pesan aman', () => {
    const prefs = permissiveAlertPrefs([
      { prefs: { minUsd: 250, cooldownMs: 60_000 } },
      { prefs: { largeSellUsd: 5000, minIndependentBuyers: 2 } },
      { prefs: { minUsd: -1 } }, // tidak valid → diabaikan
    ]);
    expect(prefs).toMatchObject({ minUsd: 250, largeSellUsd: 5000, minIndependentBuyers: 2, minWalletScore: 0, watchlistOnly: false });
    expect(prefs.cooldownMs).toBe(DEFAULT_ALERT_PREFS.cooldownMs);
    const rows = [
      ...SCENARIO.binanceMap,
      { ...SCENARIO.binanceMap[0], binanceAsset: 'PEPE2', futuresSymbol: 'PEPE2USDT', multiplier: 1 },
    ];
    const matched = matchedTokensFromMapping(rows);
    expect(matched.map((t) => t.symbol).sort()).toEqual(['SYN', 'TKA']); // PEPE_A kini AMBIGUOUS
    expect(matchToken({ chain: 'ethereum', address: E.pepe.mapped }, rows).status).toBe('AMBIGUOUS');
    expect(sanitizeProviderMessage('gagal https://api.x.test/a?apikey=K\n detail')).toBe('gagal [url] detail');
  });
});
