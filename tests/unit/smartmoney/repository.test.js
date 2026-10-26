import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../../backend/database/connection.js';
import { migrate } from '../../../backend/database/migrate.js';
import { createRepositories } from '../../../backend/database/repositories/index.js';
import { createSmartMoneyRepository } from '../../../backend/smartmoney/repository.js';

// Data uji deterministik — alamat & hash FIKTIF (sha256 dari label), bukan data on-chain nyata.
const NOW = Date.UTC(2026, 9, 1, 12, 0);
const hex = (label, len) => createHash('sha256').update(label).digest('hex').slice(0, len);
const addr = (label) => `0x${hex(label, 40)}`;
const tx = (label) => `0x${hex(label, 64)}`;

const WALLET = addr('wallet-1');
const TOKEN = addr('token-tka');
const POOL = addr('pool-tka');

function setup() {
  const db = openDatabase(':memory:');
  migrate(db, { now: () => new Date(0) });
  const addUser = db.prepare(`INSERT INTO users (username, password_hash, role, created_at, updated_at)
    VALUES (?, '$argon2id$v=19$fiktif', 'analyst', 0, 0)`);
  const u1 = Number(addUser.run('analis1').lastInsertRowid);
  const u2 = Number(addUser.run('analis2').lastInsertRowid);
  return { db, repo: createSmartMoneyRepository(db, { clock: () => NOW }), u1, u2 };
}

function activity(o = {}) {
  const txHash = o.txHash ?? tx('tx-1');
  const wallet = o.wallet ?? WALLET;
  const token = o.token ?? { address: TOKEN, symbol: 'TKA', name: 'Token A', decimals: 18 };
  return {
    id: `ethereum:${txHash}:${wallet}:${token.address}`,
    chain: 'ethereum', txHash, blockTime: NOW - 3_600_000, wallet, token,
    type: 'SWAP_BUY', direction: 'IN', amount: 1000, usdValue: 500,
    counterparty: POOL, counterpartyLabel: { label: 'Pool TKA/USDC', category: 'dex_pool', source: 'fixture-label' },
    confidence: 'HIGH', reason: 'Swap: wallet mengirim 500 USDC dan menerima 1000 TKA dalam tx yang sama',
    provider: 'fixture', isSimulated: true, explorerUrl: `https://etherscan.io/tx/${txHash}`,
    ...o,
  };
}

const label = (o = {}) => ({
  chain: 'ethereum', address: POOL, label: 'Pool TKA/USDC', category: 'dex_pool', source: 'fixture-label',
  confidence: 0.9, fetchedAt: NOW - 1000, ...o,
});

const alert = (o = {}) => ({
  kind: 'NEW_BUY', severity: 'MEDIUM', dedupeKey: `NEW_BUY:ethereum:${TOKEN}:${WALLET}:1`, chain: 'ethereum',
  tokenKey: `ethereum:${TOKEN}`, wallet: WALLET, title: 'Pembelian baru', message: 'Wallet membeli TKA',
  evidence: { txHashes: [tx('tx-1')], explorerUrls: [] }, createdAt: NOW, isSimulated: true, ...o,
});

describe('repositori smart money', () => {
  it('UNIT-SM-REPO-001 terdaftar di createRepositories sebagai smartMoney', () => {
    const { db } = setup();
    expect(typeof createRepositories(db).smartMoney.insertActivities).toBe('function');
  });

  it('UNIT-SM-REPO-002 aktivitas tersimpan & dibaca kembali dalam bentuk Activity (alamat dinormalisasi)', async () => {
    const { repo } = setup();
    const upper = activity({ wallet: WALLET.toUpperCase().replace('0X', '0x') });
    const res = await repo.insertActivities([{ ...upper, id: activity().id }]);
    expect(res).toEqual({ inserted: 1, duplicates: 0, usdFilled: 0 });
    const [row] = await repo.listActivities({ chain: 'ethereum', wallet: WALLET, limit: 10 });
    expect(row).toMatchObject({
      id: activity().id, wallet: WALLET, type: 'SWAP_BUY', direction: 'IN', amount: 1000, usdValue: 500,
      token: { address: TOKEN, symbol: 'TKA', name: 'Token A', decimals: 18 }, isSimulated: true, provider: 'fixture',
      counterpartyLabel: { category: 'dex_pool', source: 'fixture-label' },
    });
    expect(row.explorerUrl).toBe(`https://etherscan.io/tx/${tx('tx-1')}`);
  });

  it('EDGE-SM-REPO-001 transaksi duplikat (id sama) diabaikan, tidak dihitung dua kali', async () => {
    const { repo } = setup();
    expect(await repo.insertActivities([activity(), activity()])).toEqual({ inserted: 1, duplicates: 1, usdFilled: 0 });
    expect(await repo.insertActivities([activity()])).toEqual({ inserted: 0, duplicates: 1, usdFilled: 0 });
    expect(await repo.listActivities({ limit: 100 })).toHaveLength(1);
  });

  it('EDGE-SM-REPO-002 data terlambat: nilai USD null diisi oleh batch berikutnya, nilai yang ada tidak ditimpa', async () => {
    const { repo } = setup();
    await repo.insertActivities([activity({ usdValue: null })]);
    expect((await repo.listActivities({ limit: 1 }))[0].usdValue).toBeNull();
    expect(await repo.insertActivities([activity({ usdValue: 480 })])).toEqual({ inserted: 0, duplicates: 1, usdFilled: 1 });
    expect((await repo.listActivities({ limit: 1 }))[0].usdValue).toBe(480);
    expect(await repo.insertActivities([activity({ usdValue: 999 })])).toEqual({ inserted: 0, duplicates: 1, usdFilled: 0 });
    expect((await repo.listActivities({ limit: 1 }))[0].usdValue).toBe(480);
  });

  it('EDGE-SM-REPO-003 transaksi lama yang datang terlambat tetap terurut block_time', async () => {
    const { repo } = setup();
    await repo.insertActivities([activity({ txHash: tx('baru'), blockTime: NOW - 1000 })]);
    await repo.insertActivities([activity({ txHash: tx('lama'), blockTime: NOW - 10 * 86_400_000 })]);
    const rows = await repo.listActivities({ chain: 'ethereum', tokenAddress: TOKEN, limit: 10 });
    expect(rows.map((r) => r.txHash)).toEqual([tx('lama'), tx('baru')]);
  });

  it('UNIT-SM-REPO-003 filter aktivitas: jenis, rentang waktu, limit; wallet tanpa chain ditolak', async () => {
    const { repo } = setup();
    await repo.insertActivities([
      activity({ txHash: tx('a'), blockTime: 1000 }),
      activity({ txHash: tx('b'), blockTime: 2000, type: 'TRANSFER_IN', confidence: 'MEDIUM' }),
      activity({ txHash: tx('c'), blockTime: 3000, type: 'SWAP_SELL', direction: 'OUT' }),
    ]);
    expect((await repo.listActivities({ types: ['SWAP_BUY', 'SWAP_SELL'] })).map((r) => r.blockTime)).toEqual([1000, 3000]);
    expect((await repo.listActivities({ since: 1500, until: 2500 })).map((r) => r.blockTime)).toEqual([2000]);
    expect(await repo.listActivities({ limit: 2 })).toHaveLength(2);
    await expect(repo.listActivities({ wallet: WALLET })).rejects.toThrow(RangeError);
    await expect(repo.listActivities({ types: ['BELI'] })).rejects.toThrow(RangeError);
  });

  it('NEG-SM-REPO-001 aktivitas tidak valid ditolak seluruh batch (amount ≤ 0, jenis asing, hash rusak)', async () => {
    const { repo } = setup();
    await expect(repo.insertActivities([activity(), activity({ txHash: tx('x'), amount: 0 })])).rejects.toThrow(RangeError);
    await expect(repo.insertActivities([activity({ type: 'BELI' })])).rejects.toThrow(/Jenis aktivitas/);
    await expect(repo.insertActivities([activity({ txHash: '0x123' })])).rejects.toThrow(/txHash/);
    expect(await repo.listActivities()).toEqual([]);
  });

  it('NEG-SM-REPO-002 label tanpa sumber ditolak dan tidak disimpan; label valid tetap tersimpan', async () => {
    const { repo } = setup();
    const res = await repo.upsertLabels([label(), label({ address: WALLET, source: '' }), label({ address: TOKEN, source: undefined })]);
    expect(res.upserted).toBe(1);
    expect(res.rejected.map((r) => r.reason)).toEqual(['label tanpa sumber ditolak', 'label tanpa sumber ditolak']);
    const labels = await repo.getLabels({ chain: 'ethereum', addresses: [POOL, WALLET, TOKEN] });
    expect([...labels.keys()]).toEqual([`ethereum:${POOL}`]);
  });

  it('UNIT-SM-REPO-004 getLabels memilih label terbaik per alamat; listLabelsFor memuat semua sumber', async () => {
    const { repo } = setup();
    await repo.upsertLabels([label({ source: 'sumber-a', confidence: 0.6 }), label({ source: 'sumber-b', label: 'Uniswap pool', confidence: 0.95 })]);
    const best = (await repo.getLabels({ chain: 'ethereum', addresses: [POOL.toUpperCase().replace('0X', '0x')] })).get(`ethereum:${POOL}`);
    expect(best).toMatchObject({ source: 'sumber-b', label: 'Uniswap pool', category: 'dex_pool' });
    expect((await repo.listLabelsFor('ethereum', POOL)).map((l) => l.source)).toEqual(['sumber-a', 'sumber-b']);
    expect((await repo.getLabels({ chain: 'base' })).size).toBe(0);
  });

  it('UNIT-SM-REPO-005 watchlist per pengguna terisolasi; masukan tidak valid → null/false', async () => {
    const { repo, u1, u2 } = setup();
    expect(await repo.addToWatchlist(u1, { kind: 'WALLET', chain: 'ethereum', address: WALLET.toUpperCase().replace('0X', '0x'), note: 'pantau' }))
      .toMatchObject({ kind: 'WALLET', chain: 'ethereum', address: WALLET, note: 'pantau', createdAt: NOW });
    await repo.addToWatchlist(u2, { kind: 'TOKEN', chain: 'ethereum', address: TOKEN });
    expect((await repo.listWatchlist(u1)).map((w) => w.address)).toEqual([WALLET]);
    expect((await repo.listWatchlist(u2)).map((w) => w.address)).toEqual([TOKEN]);
    expect(await repo.removeFromWatchlist(u2, { kind: 'WALLET', chain: 'ethereum', address: WALLET })).toBe(false);
    expect(await repo.listWatchlist(u1)).toHaveLength(1);
    expect(await repo.addToWatchlist(u1, { kind: 'WALLET', chain: 'ethereum', address: '0x123' })).toBeNull();
    expect(await repo.addToWatchlist(u1, { kind: 'POOL', chain: 'ethereum', address: WALLET })).toBeNull();
    expect(await repo.addToWatchlist(u1, { kind: 'WALLET', chain: 'dogechain', address: WALLET })).toBeNull();
    expect(await repo.addToWatchlist(u1, { kind: 'WALLET', chain: 'ethereum', address: 'native' })).toBeNull();
    expect(await repo.removeFromWatchlist(u1, { kind: 'WALLET', chain: 'ethereum', address: WALLET })).toBe(true);
    expect(await repo.listWatchlist(u1)).toEqual([]);
  });

  it('EDGE-SM-REPO-004 alert dedupe lewat dedupe_key; existingAlertKeys', async () => {
    const { repo } = setup();
    expect(await repo.insertAlerts([alert(), alert()])).toBe(1);
    expect(await repo.insertAlerts([alert({ title: 'lain' }), alert({ dedupeKey: 'k2' })])).toBe(1);
    expect(await repo.existingAlertKeys([alert().dedupeKey, 'k2', 'k3'])).toEqual(new Set([alert().dedupeKey, 'k2']));
    expect(await repo.existingAlertKeys([])).toEqual(new Set());
  });

  it('UNIT-SM-REPO-006 status baca alert per pengguna; unreadOnly; tandai semua', async () => {
    const { repo, u1, u2 } = setup();
    await repo.insertAlerts([alert({ dedupeKey: 'a', createdAt: NOW - 2 }), alert({ dedupeKey: 'b', createdAt: NOW - 1, kind: 'LARGE_SELL' })]);
    const [b, a] = await repo.listAlerts({ userId: u1 });
    expect([b.dedupeKey, a.dedupeKey]).toEqual(['b', 'a']);
    expect(await repo.markAlertsRead(u1, [a.id])).toBe(1);
    expect((await repo.listAlerts({ userId: u1 })).map((x) => x.read)).toEqual([false, true]);
    expect((await repo.listAlerts({ userId: u2 })).map((x) => x.read)).toEqual([false, false]);
    expect((await repo.listAlerts({ userId: u1, unreadOnly: true })).map((x) => x.dedupeKey)).toEqual(['b']);
    expect((await repo.listAlerts({ userId: u2, kind: 'LARGE_SELL' })).map((x) => x.dedupeKey)).toEqual(['b']);
    expect(await repo.markAlertsRead(u2, 'all')).toBe(2);
    expect(await repo.markAlertsRead(u2, 'all')).toBe(0);
    expect(await repo.listAlerts({ userId: u2, unreadOnly: true })).toEqual([]);
  });

  it('EDGE-SM-REPO-005 hapus pengguna → watchlist, status baca, dan preferensi ikut terhapus (cascade)', async () => {
    const { db, repo, u1, u2 } = setup();
    await repo.addToWatchlist(u1, { kind: 'TOKEN', chain: 'ethereum', address: TOKEN });
    await repo.insertAlerts([alert()]);
    await repo.markAlertsRead(u1, 'all');
    await repo.markAlertsRead(u2, 'all');
    await repo.saveAlertPrefs(u1, { minUsd: 5000 });
    expect(await repo.getAlertPrefs(u1)).toEqual({ minUsd: 5000 });
    db.prepare('DELETE FROM users WHERE id = ?').run(u1);
    const count = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE user_id = ?`).get(u1).n;
    expect([count('sm_watchlist'), count('sm_alert_reads'), count('sm_alert_prefs')]).toEqual([0, 0, 0]);
    expect((await repo.listAlerts({ userId: u2 }))[0].read).toBe(true);
    expect(await repo.getAlertPrefs(u1)).toBeNull();
  });

  it('UNIT-SM-REPO-007 deteksi data simulasi & cakupan', async () => {
    const { repo } = setup();
    expect(await repo.hasSimulatedData()).toBe(false);
    expect(await repo.coverage()).toEqual({ wallets: 0, activities: 0, chains: [], lastActivityAt: null });
    await repo.insertActivities([activity({ isSimulated: false })]);
    expect(await repo.hasSimulatedData()).toBe(false);
    await repo.upsertWallets([{ chain: 'base', address: WALLET, firstSeenAt: NOW, discoveredVia: 'fixture', isSimulated: true }]);
    expect(await repo.hasSimulatedData()).toBe(true);
    expect(await repo.coverage()).toEqual({ wallets: 1, activities: 1, chains: ['base', 'ethereum'], lastActivityAt: NOW - 3_600_000 });
  });

  it('UNIT-SM-REPO-008 upsert wallet mempertahankan sumber penemuan & waktu paling awal', async () => {
    const { repo } = setup();
    await repo.upsertWallets([{ chain: 'ethereum', address: WALLET, firstSeenAt: 2000, lastActivityAt: 5000, discoveredVia: 'blockscout', discoveryReason: 'pembeli awal' }]);
    await repo.upsertWallets([{ chain: 'ethereum', address: WALLET, firstSeenAt: 1000, lastActivityAt: 4000, discoveredVia: 'lain', discoveryReason: 'x' }]);
    expect(await repo.getWallet('ethereum', WALLET)).toMatchObject({ firstSeenAt: 1000, lastActivityAt: 5000, discoveredVia: 'blockscout', discoveryReason: 'pembeli awal' });
    await expect(repo.upsertWallets([{ chain: 'ethereum', address: 'bukan-alamat', firstSeenAt: 1, discoveredVia: 'x' }])).rejects.toThrow(RangeError);
  });

  it('UNIT-SM-REPO-009 skor wallet: filter eligible/gaya/minScore dan wallet ber-flag HIGH disembunyikan default', async () => {
    const { repo } = setup();
    const base = { chain: 'ethereum', computedAt: NOW, components: {}, metrics: { closedTrades: 12 }, reasons: ['r'], limitations: [], pnl: null };
    await repo.saveWalletScores([
      { ...base, address: addr('q1'), score: 80, eligible: true, style: 'SWING', clusterId: 'ethereum:c1', flags: [] },
      { ...base, address: addr('q2'), score: 70, eligible: true, style: 'POSITION', clusterId: 'ethereum:c1', flags: [{ code: 'LOW_HISTORY', severity: 'MEDIUM' }] },
      { ...base, address: addr('bot'), score: 90, eligible: false, style: 'SCALPER', clusterId: null, flags: [{ code: 'BOT', severity: 'HIGH' }] },
    ]);
    expect((await repo.listWalletScores()).map((s) => s.score)).toEqual([80, 70]);
    expect((await repo.listWalletScores({ includeFlagged: true })).map((s) => s.score)).toEqual([90, 80, 70]);
    expect((await repo.listWalletScores({ style: 'POSITION' })).map((s) => s.score)).toEqual([70]);
    expect((await repo.listWalletScores({ minScore: 75 })).map((s) => s.score)).toEqual([80]);
    expect((await repo.listWalletScores({ eligible: false, includeFlagged: true })).map((s) => s.score)).toEqual([90]);
    expect(await repo.getWalletScore('ethereum', addr('q2'))).toMatchObject({ eligible: true, metrics: { closedTrades: 12 }, flags: [{ code: 'LOW_HISTORY' }] });
    expect(await repo.getClusterMembers('ethereum', 'ethereum:c1')).toEqual([addr('q1'), addr('q2')].sort());
    await expect(repo.saveWalletScores([{ ...base, address: addr('x'), score: 101, eligible: true, style: 'SWING' }])).rejects.toThrow(RangeError);
  });

  it('EDGE-SM-REPO-006 tautan wallet: pasangan diurutkan a<b, diganti per chain', async () => {
    const { repo } = setup();
    const [x, y] = [addr('l1'), addr('l2')].sort();
    expect(await repo.replaceWalletLinks('ethereum', [
      { a: y, b: x, type: 'SAME_FUNDER', evidence: { txHash: tx('f') } },
      { a: x, b: y, type: 'SAME_FUNDER', evidence: { txHash: tx('f') } },
      { a: x, b: y, type: 'DIRECT_TRANSFER', evidence: { txHash: tx('d') } },
    ])).toBe(3);
    expect((await repo.listWalletLinks('ethereum', y)).map((l) => [l.a, l.b, l.type])).toEqual([[x, y, 'DIRECT_TRANSFER'], [x, y, 'SAME_FUNDER']]);
    await repo.replaceWalletLinks('ethereum', []);
    expect(await repo.listWalletLinks('ethereum', x)).toEqual([]);
    await expect(repo.replaceWalletLinks('ethereum', [{ a: x, b: x, type: 'SAME_FUNDER' }])).rejects.toThrow(RangeError);
  });

  it('UNIT-SM-REPO-010 mapping Binance: dua token bersimbol sama = dua baris berbeda; tanpa sumber ditolak', async () => {
    const { repo } = setup();
    const pepeA = addr('pepe-a');
    await repo.upsertBinanceMap([{ chain: 'ethereum', contractAddress: pepeA, binanceAsset: 'PEPE', spotSymbol: 'PEPEUSDT', futuresSymbol: '1000PEPEUSDT', multiplier: 1000, source: 'fixture-map', verifiedAt: NOW }]);
    expect(await repo.listBinanceMap()).toEqual([{ chain: 'ethereum', contractAddress: pepeA, binanceAsset: 'PEPE', spotSymbol: 'PEPEUSDT', futuresSymbol: '1000PEPEUSDT', multiplier: 1000, source: 'fixture-map', verifiedAt: NOW }]);
    await expect(repo.upsertBinanceMap([{ chain: 'ethereum', contractAddress: addr('pepe-b'), binanceAsset: 'PEPE', source: '' }])).rejects.toThrow(/sumber/);
    await expect(repo.upsertBinanceMap([{ chain: 'ethereum', contractAddress: addr('pepe-b'), binanceAsset: 'PEPE', multiplier: 0, source: 's' }])).rejects.toThrow(/multiplier/);
  });

  it('UNIT-SM-REPO-011 status provider: percobaan, sukses, kegagalan (sukses menghapus error)', async () => {
    const { repo } = setup();
    await repo.recordProviderAttempt('blockscout', { now: 1 });
    await repo.recordProviderFailure('blockscout', { now: 2, code: 'RATE_LIMITED', message: 'x'.repeat(900) });
    let [s] = await repo.listProviderStatus();
    expect(s).toMatchObject({ provider: 'blockscout', lastAttemptAt: 2, lastSuccessAt: null, lastErrorCode: 'RATE_LIMITED', isSimulated: false });
    expect(s.lastErrorMessage).toHaveLength(500);
    await repo.recordProviderSuccess('blockscout', { now: 3, coverage: { chains: ['ethereum'] } });
    [s] = await repo.listProviderStatus();
    expect(s).toMatchObject({ lastAttemptAt: 3, lastSuccessAt: 3, lastErrorCode: null, lastErrorMessage: null, coverage: { chains: ['ethereum'] } });
    await expect(repo.recordProviderFailure('blockscout', { code: 'BOOM' })).rejects.toThrow(RangeError);
  });

  it('UNIT-SM-REPO-012 kursor sinkronisasi per provider × chain × alamat', async () => {
    const { repo } = setup();
    expect(await repo.getCursor('fixture', 'ethereum', WALLET)).toBeNull();
    await repo.setCursor('fixture', 'ethereum', WALLET, 'o:500');
    await repo.setCursor('fixture', 'ethereum', '', 'chain-level');
    expect(await repo.getCursor('fixture', 'ethereum', WALLET.toUpperCase().replace('0X', '0x'))).toBe('o:500');
    expect(await repo.getCursor('fixture', 'ethereum')).toBe('chain-level');
    expect(await repo.getCursor('lain', 'ethereum', WALLET)).toBeNull();
  });

  it('UNIT-SM-REPO-013 evaluasi terakhir; tanpa evaluasi → null', async () => {
    const { repo } = setup();
    expect(await repo.latestEvaluation()).toBeNull();
    await repo.saveEvaluation({ computedAt: 1, params: { stepMs: 1 }, report: { signals: 1 } });
    const id = await repo.saveEvaluation({ computedAt: 2, params: {}, report: { signals: 2 }, isSimulated: true });
    expect(await repo.latestEvaluation()).toEqual({ id, computedAt: 2, params: {}, report: { signals: 2 }, isSimulated: true });
    expect(await repo.hasSimulatedData()).toBe(true);
  });

  it('UNIT-SM-REPO-014 metadata token: nilai null tidak menimpa', async () => {
    const { repo } = setup();
    await repo.upsertTokens([{ chain: 'ethereum', address: TOKEN, symbol: 'TKA', name: 'Token A', decimals: 18 }]);
    await repo.upsertTokens([{ chain: 'ethereum', address: TOKEN, symbol: null, name: null, decimals: null }]);
    expect(await repo.getToken('ethereum', TOKEN)).toMatchObject({ symbol: 'TKA', name: 'Token A', decimals: 18 });
  });
});
