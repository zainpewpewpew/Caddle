import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../../backend/database/connection.js';
import { migrate } from '../../../backend/database/migrate.js';
import { createRepositories } from '../../../backend/database/repositories/index.js';
import { REJECTED_LIST_MAX, createSymbolRepository } from '../../../backend/database/repositories/symbolRepository.js';

// Fixture sintetis — bukan data pasar nyata. Bentuk SymbolInfo mengikuti kontrak §2
// (turunan exchangeInfo Binance USDT-M Futures).
const T0 = Date.UTC(2026, 0, 1);
const HOUR = 3_600_000;
const info = (symbol, overrides = {}) => ({
  symbol, baseAsset: symbol.replace(/USDT$/, ''), quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING',
  tickSize: '0.10', stepSize: '0.001', onboardDate: Date.UTC(2019, 8, 25), ...overrides,
});

describe('repositori simbol', () => {
  let db;
  let repo;
  const row = (symbol) => db.prepare('SELECT * FROM symbols WHERE symbol = ?').get(symbol);

  beforeEach(() => {
    db = openDatabase(':memory:');
    migrate(db);
    repo = createSymbolRepository(db);
  });

  it('UNIT-SYM-001 upsertFromExchange menyisipkan simbol baru beserta atributnya', async () => {
    const result = await repo.upsertFromExchange([info('BTCUSDT'), info('PEPEUSDT', { tickSize: '0.00001000', stepSize: '1' })], T0);
    expect(result).toEqual({ inserted: 2, updated: 0, rejected: [], rejectedCount: 0 });
    expect(await repo.getId('BTCUSDT')).toEqual(expect.any(Number));
    expect(row('PEPEUSDT')).toMatchObject({
      base_asset: 'PEPE', quote_asset: 'USDT', contract_type: 'PERPETUAL', status: 'TRADING',
      tick_size: '0.00001000', step_size: '1', is_monitored: 0, first_seen_at: T0, last_seen_at: T0,
      delisted_at: null, monitored_since: null,
    });
  });

  it('UNIT-SYM-002 pembaruan dari exchange: atribut berubah, first_seen_at tetap, last_seen_at maju', async () => {
    await repo.upsertFromExchange([info('BTCUSDT')], T0);
    const id = await repo.getId('BTCUSDT');
    const result = await repo.upsertFromExchange([info('BTCUSDT', { status: 'SETTLING', tickSize: '0.20' })], T0 + HOUR);
    expect(result).toEqual({ inserted: 0, updated: 1, rejected: [], rejectedCount: 0 });
    expect(await repo.getId('BTCUSDT')).toBe(id);
    expect(row('BTCUSDT')).toMatchObject({ status: 'SETTLING', tick_size: '0.20', first_seen_at: T0, last_seen_at: T0 + HOUR });
  });

  it('UNIT-SYM-003 setMonitored: daftar baru dipantau, sisanya dilepas; listMonitored terurut', async () => {
    await repo.upsertFromExchange(['SOLUSDT', 'BTCUSDT', 'ETHUSDT', 'XRPUSDT'].map((s) => info(s)), T0);
    expect(await repo.setMonitored(['SOLUSDT', 'BTCUSDT', 'ETHUSDT'], T0)).toEqual({
      monitored: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], skipped: [],
    });
    expect(await repo.listMonitored()).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);

    await repo.setMonitored(['ETHUSDT', 'XRPUSDT'], T0 + HOUR);
    expect(await repo.listMonitored()).toEqual(['ETHUSDT', 'XRPUSDT']);
    expect(row('ETHUSDT').monitored_since).toBe(T0); // tetap dipantau → waktu mulai tidak berubah
    expect(row('XRPUSDT').monitored_since).toBe(T0 + HOUR);
    expect(row('BTCUSDT')).toMatchObject({ is_monitored: 0, monitored_since: null });
  });

  it('UNIT-SYM-004 markDelisted: simbol dilepas dari pantauan; panggilan ulang idempoten', async () => {
    await repo.upsertFromExchange([info('BTCUSDT'), info('LUNAUSDT')], T0);
    await repo.setMonitored(['BTCUSDT', 'LUNAUSDT'], T0);
    expect(await repo.markDelisted(['LUNAUSDT'], T0 + HOUR)).toBe(1);
    expect(row('LUNAUSDT')).toMatchObject({ delisted_at: T0 + HOUR, is_monitored: 0, monitored_since: null });
    expect(await repo.listMonitored()).toEqual(['BTCUSDT']);

    expect(await repo.markDelisted(['LUNAUSDT'], T0 + 2 * HOUR)).toBe(0);
    expect(row('LUNAUSDT').delisted_at).toBe(T0 + HOUR);
    expect(await repo.getId('LUNAUSDT')).toEqual(expect.any(Number)); // riwayat tetap ada
  });

  it('UNIT-SYM-005 simbol delisted tidak dapat dipantau lagi lewat setMonitored', async () => {
    await repo.upsertFromExchange([info('BTCUSDT'), info('LUNAUSDT')], T0);
    await repo.markDelisted(['LUNAUSDT'], T0);
    expect(await repo.setMonitored(['LUNAUSDT', 'BTCUSDT'], T0 + HOUR)).toEqual({ monitored: ['BTCUSDT'], skipped: ['LUNAUSDT'] });
    expect(row('LUNAUSDT').is_monitored).toBe(0);
  });

  it('UNIT-SYM-006 repositori terdaftar di createRepositories & konsisten dengan overview', async () => {
    const repos = createRepositories(db);
    expect(repos).toHaveProperty('symbols');
    expect(repos).toHaveProperty('candles');
    expect(repos).toHaveProperty('ingestion');
    await repos.symbols.upsertFromExchange([info('BTCUSDT'), info('ETHUSDT'), info('LUNAUSDT')], T0);
    await repos.symbols.setMonitored(['BTCUSDT', 'ETHUSDT', 'LUNAUSDT'], T0);
    await repos.symbols.markDelisted(['LUNAUSDT'], T0);
    expect((await repos.overview.summary()).monitoredSymbols).toBe(2);
  });

  it('EDGE-SYM-001 listing ulang: muncul lagi dengan status TRADING → delisted_at dihapus', async () => {
    await repo.upsertFromExchange([info('BTCUSDT'), info('ETHUSDT')], T0);
    await repo.markDelisted(['BTCUSDT', 'ETHUSDT'], T0);
    await repo.upsertFromExchange([info('BTCUSDT'), info('ETHUSDT', { status: 'SETTLING' })], T0 + HOUR);
    expect(row('BTCUSDT').delisted_at).toBeNull();
    expect(row('ETHUSDT').delisted_at).toBe(T0);
  });

  it('EDGE-SYM-002 setMonitored([]) melepas semua pantauan', async () => {
    await repo.upsertFromExchange([info('BTCUSDT'), info('ETHUSDT')], T0);
    await repo.setMonitored(['BTCUSDT', 'ETHUSDT'], T0);
    expect(await repo.setMonitored([], T0 + HOUR)).toEqual({ monitored: [], skipped: [] });
    expect(await repo.listMonitored()).toEqual([]);
  });

  it('EDGE-SYM-003 duplikat dalam satu panggilan: entri terakhir menang', async () => {
    const result = await repo.upsertFromExchange([info('BTCUSDT', { tickSize: '0.10' }), info('BTCUSDT', { tickSize: '0.01' })], T0);
    expect(result).toEqual({ inserted: 1, updated: 0, rejected: [], rejectedCount: 0 });
    expect(row('BTCUSDT').tick_size).toBe('0.01');
    expect(await repo.setMonitored(['BTCUSDT', 'BTCUSDT'], T0)).toEqual({ monitored: ['BTCUSDT'], skipped: [] });
  });

  it('EDGE-SYM-004 tickSize/stepSize angka disimpan sebagai teks; null diperbolehkan', async () => {
    await repo.upsertFromExchange([info('BTCUSDT', { tickSize: 0.1, stepSize: null }), info('ETHUSDT', { tickSize: undefined })], T0);
    expect(row('BTCUSDT')).toMatchObject({ tick_size: '0.1', step_size: null });
    expect(row('ETHUSDT').tick_size).toBeNull();
  });

  it('NEG-SYM-001 SymbolInfo tidak valid ditolak tanpa menggagalkan entri valid', async () => {
    const evil = "BTC'; DROP TABLE symbols;--";
    const result = await repo.upsertFromExchange([
      info('btcusdt'),
      info('BTCUSDT_250627', { contractType: 'CURRENT_QUARTER' }),
      info(evil),
      info('ETHUSDT', { baseAsset: '' }),
      info('SOLUSDT', { status: '' }),
      info('XRPUSDT', { tickSize: 'abc' }),
      info('ADAUSDT', { stepSize: -1 }),
      null,
      info('BNBUSDT'),
    ], T0);
    expect(result.inserted).toBe(1);
    expect(result.rejected).toHaveLength(8);
    expect(result.rejectedCount).toBe(8);
    expect(result.rejected.every((r) => r.errors.length > 0)).toBe(true);
    expect(result.rejected.map((r) => r.symbol)).toContain(evil);
    expect(db.prepare('SELECT symbol FROM symbols').all()).toEqual([{ symbol: 'BNBUSDT' }]);
  });

  it('UNIT-SYM-007 kontrak delivery dari exchangeInfo (SYNUSDT_270326) tidak disimpan tetapi dilaporkan: rejectedCount 1 + simbol & alasannya', async () => {
    const result = await repo.upsertFromExchange([info('SYNUSDT'), info('SYNUSDT_270326', { contractType: 'CURRENT_QUARTER' })], T0);
    expect(result).toEqual({
      inserted: 1, updated: 0, rejectedCount: 1,
      rejected: [{ symbol: 'SYNUSDT_270326', errors: ['symbol tidak valid (harus [A-Z0-9]{1,32})'] }],
    });
    expect(row('SYNUSDT_270326')).toBeUndefined();
  });

  it('EDGE-SYM-005 120 entri tidak valid → rejected dibatasi 50 entri pertama, rejectedCount 120; simbol panjang dipotong 64 karakter, simbol non-teks → null', async () => {
    const bad = Array.from({ length: 118 }, (_, i) => info(`X${i}USDT_270326`));
    const result = await repo.upsertFromExchange([info('A'.repeat(100)), { ...info('BTCUSDT'), symbol: 42 }, ...bad, info('BTCUSDT')], T0);
    expect(result.inserted).toBe(1);
    expect(result.rejectedCount).toBe(120);
    expect(result.rejected).toHaveLength(REJECTED_LIST_MAX);
    expect(REJECTED_LIST_MAX).toBe(50);
    expect(result.rejected[0].symbol).toBe('A'.repeat(64));
    expect(result.rejected[1].symbol).toBeNull();
    expect(result.rejected.at(-1).symbol).toBe('X47USDT_270326');
  });

  it('NEG-SYM-002 simbol tidak dikenal: dilewati / null / nol', async () => {
    await repo.upsertFromExchange([info('BTCUSDT')], T0);
    expect(await repo.setMonitored(['DOGEUSDT', 'bad symbol', 'BTCUSDT'], T0)).toEqual({
      monitored: ['BTCUSDT'], skipped: ['DOGEUSDT', 'bad symbol'],
    });
    expect(await repo.getId('DOGEUSDT')).toBeNull();
    expect(await repo.getId(42)).toBeNull();
    expect(await repo.markDelisted(['DOGEUSDT'], T0)).toBe(0);
  });

  it.each([
    ['upsertFromExchange non-array', (r) => r.upsertFromExchange('BTCUSDT', T0)],
    ['upsertFromExchange tanpa now', (r) => r.upsertFromExchange([info('BTCUSDT')])],
    ['setMonitored non-array', (r) => r.setMonitored(null, T0)],
    ['setMonitored now NaN', (r) => r.setMonitored([], Number.NaN)],
    ['markDelisted non-array', (r) => r.markDelisted('BTCUSDT', T0)],
    ['markDelisted now string', (r) => r.markDelisted([], String(T0))],
  ])('NEG-SYM-003 argumen tidak valid → TypeError: %s', async (_label, call) => {
    await expect(call(repo)).rejects.toThrow(TypeError);
  });
});
