import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../../backend/database/connection.js';
import { migrate } from '../../../backend/database/migrate.js';
import { createRepositories } from '../../../backend/database/repositories/index.js';
import { matchToken } from '../../../backend/smartmoney/binanceMatch.js';
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
    // Baris tidak valid DITOLAK per baris (dilaporkan, tidak disimpan) — tidak menggagalkan / mengosongkan mapping.
    const bad = await repo.upsertBinanceMap([
      { chain: 'ethereum', contractAddress: addr('pepe-b'), binanceAsset: 'PEPE', source: '' },
      { chain: 'ethereum', contractAddress: addr('pepe-b'), binanceAsset: 'PEPE', multiplier: 0, source: 's' },
    ]);
    expect(bad.upserted).toBe(0);
    expect(bad.rejected.map((r) => r.reason)).toEqual([expect.stringMatching(/sumber/), expect.stringMatching(/multiplier/)]);
    expect((await repo.listBinanceMap()).map((r) => r.contractAddress)).toEqual([pepeA]);
  });

  it('UNIT-SM-REPO-015 mapping Binance: dua baris berbeda untuk satu kontrak bertahan → matchToken AMBIGUOUS (round-trip)', async () => {
    const { repo } = setup();
    const c = addr('shared-contract');
    const res = await repo.upsertBinanceMap([
      { chain: 'ethereum', contractAddress: c, binanceAsset: 'PEPE', spotSymbol: 'PEPEUSDT', futuresSymbol: 'PEPEUSDT', multiplier: 1, source: 'binance-getall', verifiedAt: NOW },
      { chain: 'ethereum', contractAddress: c, binanceAsset: 'PEPE', spotSymbol: 'PEPEUSDT', futuresSymbol: '1000PEPEUSDT', multiplier: 1000, source: 'binance-getall+prefix-rule', verifiedAt: NOW },
    ], { provider: 'binance-mapping' });
    expect(res).toEqual({ upserted: 2, rejected: [] });
    const stored = await repo.listBinanceMap();
    expect(stored).toHaveLength(2);
    expect(matchToken({ chain: 'ethereum', address: c, symbol: 'PEPE' }, stored).status).toBe('AMBIGUOUS');
    // Hanya satu baris (setelah penyegaran berikutnya) → MATCHED; baris lama milik provider yang sama ikut terganti.
    await repo.upsertBinanceMap([
      { chain: 'ethereum', contractAddress: c, binanceAsset: 'PEPE', spotSymbol: 'PEPEUSDT', futuresSymbol: '1000PEPEUSDT', multiplier: 1000, source: 'binance-getall+prefix-rule', verifiedAt: NOW + 1 },
    ], { provider: 'binance-mapping' });
    const after = await repo.listBinanceMap();
    expect(after).toHaveLength(1);
    expect(matchToken({ chain: 'ethereum', address: c, symbol: 'PEPE' }, after)).toMatchObject({ status: 'MATCHED', futuresSymbol: '1000PEPEUSDT', multiplier: 1000 });
  });

  it('EDGE-SM-REPO-007 penyegaran mapping: kontrak delisting hilang, provider lain tidak tersentuh, baris rusak dilewati', async () => {
    const { repo } = setup();
    const row = (name, o = {}) => ({ chain: 'ethereum', contractAddress: addr(name), binanceAsset: name.toUpperCase(), spotSymbol: null, futuresSymbol: `${name.toUpperCase()}USDT`, multiplier: 1, source: 'binance-getall', verifiedAt: NOW, ...o });
    await repo.upsertBinanceMap([row('aaa'), row('bbb')], { provider: 'binance-mapping' });
    await repo.upsertBinanceMap([row('ccc', { source: 'fixture-map' })]);
    const res = await repo.upsertBinanceMap([
      row('aaa'),
      row('ddd', { binanceAsset: '币安人生', futuresSymbol: '币安人生USDT' }), // simbol non-ASCII → baris dilewati
    ], { provider: 'binance-mapping' });
    expect(res.upserted).toBe(1);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0].reason).toMatch(/futuresSymbol tidak valid/);
    expect((await repo.listBinanceMap()).map((r) => r.binanceAsset).sort()).toEqual(['AAA', 'CCC']);
    // Respons tanpa satu pun baris valid tidak mengosongkan mapping yang ada.
    expect((await repo.upsertBinanceMap([row('eee', { multiplier: -1 })], { provider: 'binance-mapping' })).upserted).toBe(0);
    expect((await repo.listBinanceMap()).map((r) => r.binanceAsset).sort()).toEqual(['AAA', 'CCC']);
    await expect(repo.upsertBinanceMap([row('aaa')], { provider: 'Bukan Id' })).rejects.toThrow(RangeError);
  });

  it('UNIT-SM-REPO-016 getLabels: label infrastruktur (cex) menang atas label lain berkeyakinan lebih tinggi', async () => {
    const { repo } = setup();
    const hot = addr('hot-wallet');
    await repo.upsertLabels([
      label({ address: hot, label: 'Exchange 14', category: 'cex', source: 'eth-labels', confidence: 0.8 }),
      label({ address: hot, label: 'Large holder', category: 'fund', source: 'vendor-x', confidence: 0.9 }),
    ]);
    expect((await repo.getLabels({ chain: 'ethereum' })).get(`ethereum:${hot}`)).toMatchObject({ category: 'cex', source: 'eth-labels' });
    expect((await repo.getLabels({ addresses: [hot] })).get(`ethereum:${hot}`).category).toBe('cex');
    expect((await repo.listLabelsFor('ethereum', hot)).map((l) => l.category).sort()).toEqual(['cex', 'fund']);
    const many = await repo.listLabelsForMany('ethereum', [hot, POOL, 'bukan-alamat']);
    expect([...many.keys()]).toEqual([hot]);
    expect(many.get(hot)).toHaveLength(2);
  });

  it('UNIT-SM-REPO-017 transfer mentah: baru per wallet, kiriman ulang diabaikan, info terlambat melengkapi', async () => {
    const { repo } = setup();
    const other = addr('wallet-2');
    const t = {
      chain: 'ethereum', txHash: tx('raw-1'), logIndex: 3, blockNumber: null, blockTime: NOW - 1000, from: WALLET, to: other,
      token: { address: TOKEN, symbol: '?', name: null, decimals: null }, amount: 5, usdValue: null, priceSource: null,
      provider: 'fixture', isSimulated: true, txMeta: { initiator: WALLET, toContract: null, method: null, providerCategory: null, dex: null },
    };
    expect(await repo.insertRawTransfers([t], WALLET)).toEqual([t]);
    expect(await repo.insertRawTransfers([t], WALLET)).toEqual([]);
    // Transfer antara dua wallet yang dilacak = baru bagi wallet kedua juga.
    expect(await repo.insertRawTransfers([t], other)).toHaveLength(1);
    const later = { ...t, usdValue: 12.5, priceSource: 'p', token: { ...t.token, symbol: 'TKA', decimals: 18 }, txMeta: { ...t.txMeta, providerCategory: 'swap' } };
    const [merged] = await repo.insertRawTransfers([later], WALLET);
    expect(merged).toMatchObject({ usdValue: 12.5, priceSource: 'p', token: { symbol: 'TKA', decimals: 18 }, txMeta: { providerCategory: 'swap', initiator: WALLET } });
    // Nilai yang sudah diketahui tidak ditimpa.
    expect(await repo.insertRawTransfers([{ ...later, usdValue: 99 }], WALLET)).toEqual([]);
    expect(await repo.listRawTransfersForTxs('ethereum', WALLET.toUpperCase().replace('0X', '0x'), [tx('raw-1'), tx('none')])).toEqual([merged]);
    expect(await repo.listRawTransfersForTxs('ethereum', WALLET, [])).toEqual([]);
    await expect(repo.insertRawTransfers([{ ...t, logIndex: -1 }], WALLET)).rejects.toThrow(RangeError);
    await expect(repo.listRawTransfersForTxs('ethereum', WALLET, ['0x12'])).rejects.toThrow(RangeError);
  });

  it('UNIT-SM-REPO-018 replaceActivitiesForTxs: hapus + sisip atomik per wallet × tx; baris basi hilang', async () => {
    const { db, repo } = setup();
    const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const transferIn = activity({ type: 'TRANSFER_IN', counterparty: POOL, reason: 'transfer masuk' });
    const otherTx = activity({ txHash: tx('tx-2'), type: 'TRANSFER_IN', reason: 'tx lain' });
    await repo.insertActivities([transferIn, otherTx], { now: NOW - 50 });
    // Kaki terlambat: tx yang sama ternyata swap → SWAP_BUY token + (baris lama USDC dihapus bila ada).
    const stale = activity({ token: { address: usdc, symbol: 'USDC', name: 'USD Coin', decimals: 6 }, type: 'TRANSFER_OUT', direction: 'OUT', reason: 'keluar' });
    await repo.insertActivities([stale], { now: NOW - 50 });
    const res = await repo.replaceActivitiesForTxs('ethereum', WALLET, [tx('tx-1')], [activity({ reason: 'swap lengkap' })], { now: NOW });
    expect(res).toEqual({ deleted: 2, inserted: 1, newIds: [], changedIds: [transferIn.id], removedIds: [stale.id] });
    const rows = await repo.listActivities({ chain: 'ethereum', wallet: WALLET });
    expect(rows.map((a) => [a.txHash, a.type])).toEqual([[tx('tx-1'), 'SWAP_BUY'], [tx('tx-2'), 'TRANSFER_IN']].sort((x, y) => (x[0] < y[0] ? -1 : 1)));
    // ingested_at baris yang tetap ada dipertahankan.
    expect(db.prepare('SELECT ingested_at FROM sm_activities WHERE id = ?').get(transferIn.id).ingested_at).toBe(NOW - 50);
    // Aktivitas di luar wallet × tx → RangeError, tidak ada yang berubah.
    await expect(repo.replaceActivitiesForTxs('ethereum', WALLET, [tx('tx-1')], [activity({ txHash: tx('tx-3') })])).rejects.toThrow(RangeError);
    expect(await repo.listActivities({ chain: 'ethereum', wallet: WALLET })).toHaveLength(2);
    const fresh = await repo.replaceActivitiesForTxs('ethereum', WALLET, [tx('tx-9')], [activity({ txHash: tx('tx-9') })]);
    expect(fresh.newIds).toEqual([activity({ txHash: tx('tx-9') }).id]);
  });

  it('UNIT-SM-REPO-019 listActivities order desc: LIMIT memotong yang tertua; holdingsBefore', async () => {
    const { repo } = setup();
    await repo.insertActivities([1, 2, 3].map((i) => activity({ txHash: tx(`o-${i}`), blockTime: NOW - (4 - i) * 1000 })));
    expect((await repo.listActivities({ limit: 2 })).map((a) => NOW - a.blockTime)).toEqual([3000, 2000]);
    expect((await repo.listActivities({ limit: 2, order: 'desc' })).map((a) => NOW - a.blockTime)).toEqual([1000, 2000]);
    expect((await repo.listActivities({ chain: 'ethereum', wallet: WALLET, limit: 1, order: 'desc' }))[0].blockTime).toBe(NOW - 1000);
    expect((await repo.listActivities({ chain: 'ethereum', tokenAddress: TOKEN, limit: 1, order: 'desc' }))[0].blockTime).toBe(NOW - 1000);
    await expect(repo.listActivities({ order: 'acak' })).rejects.toThrow(RangeError);
    expect(await repo.listAllActivities()).toHaveLength(3);
    await repo.insertActivities([activity({ txHash: tx('sell'), type: 'SWAP_SELL', direction: 'OUT', amount: 1000, blockTime: NOW - 500 })]);
    const h = await repo.holdingsBefore({ before: NOW - 1500, wallets: [`ethereum:${WALLET}`, `ethereum:${addr('kosong')}`] });
    expect(h.get(`ethereum:${WALLET}`).get(`ethereum:${TOKEN}`)).toBe(2000);
    expect(h.get(`ethereum:${addr('kosong')}`).size).toBe(0);
    // Tiga beli (3000) − satu jual (1000) sebelum NOW.
    expect((await repo.holdingsBefore({ before: NOW, wallets: [`ethereum:${WALLET}`] })).get(`ethereum:${WALLET}`).get(`ethereum:${TOKEN}`)).toBe(2000);
    // Dijual habis → tidak tercantum (saldo 0 bukan "memegang").
    await repo.insertActivities([activity({ txHash: tx('sell-2'), type: 'SWAP_SELL', direction: 'OUT', amount: 2000, blockTime: NOW - 100 })]);
    expect((await repo.holdingsBefore({ before: NOW, wallets: [`ethereum:${WALLET}`] })).get(`ethereum:${WALLET}`).size).toBe(0);
  });

  it('NEG-SM-REPO-003 alert tanpa isSimulated boolean ditolak; lastAlertTimes per kunci dasar', async () => {
    const { repo } = setup();
    await expect(repo.insertAlerts([alert({ isSimulated: undefined })])).rejects.toThrow(/isSimulated/);
    await expect(repo.insertAlerts([alert({ isSimulated: 1 })])).rejects.toThrow(/isSimulated/);
    await repo.insertAlerts([
      alert({ dedupeKey: `NEW_BUY:ethereum:${TOKEN}:${WALLET}:10`, createdAt: NOW - 10 }),
      alert({ dedupeKey: `NEW_BUY:ethereum:${TOKEN}:${WALLET}:11`, createdAt: NOW - 5 }),
      alert({ kind: 'MULTI_WALLET_BUY', wallet: null, dedupeKey: `MULTI_WALLET_BUY:ethereum:${TOKEN}:*:11`, createdAt: NOW - 100 }),
    ]);
    const times = await repo.lastAlertTimes({ since: NOW - 50 });
    expect(times).toEqual(new Map([[`NEW_BUY:ethereum:${TOKEN}:${WALLET}`, NOW - 5]]));
    expect((await repo.lastAlertTimes()).get(`MULTI_WALLET_BUY:ethereum:${TOKEN}:*`)).toBe(NOW - 100);
  });

  it('UNIT-SM-REPO-021 aktivitas menyimpan blockNumber/logIndex (null = tidak diketahui); perubahan logIndex = berubah', async () => {
    const { repo } = setup();
    await repo.insertActivities([activity({ blockNumber: 21_000_000, logIndex: 7 }), activity({ txHash: tx('tx-2') })]);
    const rows = await repo.listActivities({ chain: 'ethereum', wallet: WALLET, limit: 10 });
    expect(rows.find((a) => a.txHash === tx('tx-1'))).toMatchObject({ blockNumber: 21_000_000, logIndex: 7 });
    expect(rows.find((a) => a.txHash === tx('tx-2'))).toMatchObject({ blockNumber: null, logIndex: null });
    await expect(repo.insertActivities([activity({ txHash: tx('tx-3'), logIndex: -1 })])).rejects.toThrow(/logIndex/);
    await expect(repo.insertActivities([activity({ txHash: tx('tx-3'), blockNumber: 1.5 })])).rejects.toThrow(/blockNumber/);
    const res = await repo.replaceActivitiesForTxs('ethereum', WALLET, [tx('tx-2')], [activity({ txHash: tx('tx-2'), blockNumber: 5, logIndex: 0 })]);
    expect(res.changedIds).toEqual([activity({ txHash: tx('tx-2') }).id]);
  });

  it('UNIT-SM-REPO-022 alert menyimpan eventAt; lastAlertTimes memakai eventAt (createdAt bila tidak ada) per alertBaseKey', async () => {
    const { repo, u1 } = setup();
    await repo.insertAlerts([
      alert({ dedupeKey: `NEW_BUY:ethereum:${TOKEN}:${WALLET}:20`, createdAt: NOW, eventAt: NOW - 600_000 }),
      alert({ kind: 'LARGE_SELL', dedupeKey: `LARGE_SELL:ethereum:${TOKEN}:${WALLET}:20`, createdAt: NOW - 50 }),
    ]);
    const [newest] = await repo.listAlerts({ userId: u1, limit: 10 });
    expect(newest).toMatchObject({ kind: 'NEW_BUY', createdAt: NOW, eventAt: NOW - 600_000 });
    const times = await repo.lastAlertTimes({ since: NOW - 1000 });
    expect(times.get(`NEW_BUY:ethereum:${TOKEN}:${WALLET}`)).toBe(NOW - 600_000);
    expect(times.get(`LARGE_SELL:ethereum:${TOKEN}:${WALLET}`)).toBe(NOW - 50);
    await expect(repo.insertAlerts([alert({ dedupeKey: 'x:1', eventAt: -5 })])).rejects.toThrow(/eventAt/);
  });

  it('UNIT-SM-REPO-020 dukungan sinkronisasi: status, watchlist & preferensi semua pengguna, waktu sinkron wallet, ringkasan skor', async () => {
    const { repo, u1, u2 } = setup();
    expect(await repo.getSyncState('binanceMap')).toBeNull();
    await repo.setSyncState('binanceMap', { refreshedAt: 5 }, { now: 7 });
    expect(await repo.getSyncState('binanceMap')).toEqual({ value: { refreshedAt: 5 }, updatedAt: 7 });
    await expect(repo.setSyncState('', 1)).rejects.toThrow(RangeError);
    await repo.addToWatchlist(u2, { kind: 'TOKEN', chain: 'ethereum', address: TOKEN });
    await repo.addToWatchlist(u1, { kind: 'WALLET', chain: 'ethereum', address: WALLET });
    expect(await repo.listAllWatchlist()).toEqual([
      { userId: u1, kind: 'WALLET', chain: 'ethereum', address: WALLET },
      { userId: u2, kind: 'TOKEN', chain: 'ethereum', address: TOKEN },
    ]);
    await repo.saveAlertPrefs(u2, { minUsd: 10 });
    expect(await repo.listAllAlertPrefs()).toEqual([{ userId: u2, prefs: { minUsd: 10 } }]);
    await repo.setCursor('fixture', 'ethereum', WALLET, 'a', { now: 10 });
    await repo.setCursor('lain', 'ethereum', WALLET, 'b', { now: 20 });
    await repo.setCursor('fixture', 'ethereum', '', 'chain', { now: 30 });
    expect(await repo.listWalletSyncTimes()).toEqual(new Map([[`ethereum:${WALLET}`, 20]]));
    const base = { chain: 'ethereum', computedAt: NOW, style: 'SWING', components: {}, metrics: {}, reasons: [], limitations: [], pnl: null };
    await repo.saveWalletScores([
      { ...base, address: addr('a1'), score: 50, eligible: true, clusterId: `ethereum:${addr('a1')}`, flags: [] },
      { ...base, address: addr('a2'), score: 40, eligible: false, clusterId: `ethereum:${addr('a1')}`, flags: [{ code: 'LINKED', severity: 'LOW' }] },
    ]);
    const summaries = await repo.listScoreSummaries({ chain: 'ethereum' });
    const expected = [[addr('a1'), 50, true, 0], [addr('a2'), 40, false, 1]].sort((x, y) => (x[0] < y[0] ? -1 : 1));
    expect(summaries.map((s) => [s.address, s.score, s.eligible, s.flags.length])).toEqual(expected);
    expect(summaries[0]).toMatchObject({ chain: 'ethereum', style: 'SWING', clusterId: `ethereum:${addr('a1')}` });
    expect(await repo.listScoreSummaries({ chain: 'base' })).toEqual([]);
    expect(await repo.clusterSizes()).toEqual(new Map([[`ethereum:${addr('a1')}`, 2]]));
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
