import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../../backend/database/connection.js';
import { migrate } from '../../../backend/database/migrate.js';
import { createCandleRepository } from '../../../backend/database/repositories/candleRepository.js';
import { createRepositories } from '../../../backend/database/repositories/index.js';
import { createSymbolRepository } from '../../../backend/database/repositories/symbolRepository.js';
import { TIMEFRAME_MS } from '../../../backend/market/contracts.js';
import { createClock } from '../../helpers/testApp.js';

// Fixture sintetis — bukan data pasar nyata. Candle mengikuti bentuk kanonik contracts.js.
const T0 = Date.UTC(2026, 0, 1); // sejajar batas 5m/15m/1h
const DAY = 86_400_000;
const STEP = TIMEFRAME_MS['5m'];

function candle(overrides = {}) {
  const timeframe = overrides.timeframe ?? '5m';
  const openTime = overrides.openTime ?? T0;
  return {
    symbol: 'BTCUSDT', timeframe, openTime, closeTime: openTime + TIMEFRAME_MS[timeframe] - 1,
    open: 100, high: 105, low: 99, close: 104, volume: 12.5, quoteVolume: 1290.5, trades: 42,
    takerBuyVolume: 6.25, takerBuyQuoteVolume: 645.25, isClosed: true, source: 'rest',
    ...overrides,
  };
}

/** Deret candle tertutup berurutan dengan harga bervariasi deterministik. */
function series(n, { symbol = 'BTCUSDT', timeframe = '5m', start = T0, source = 'rest' } = {}) {
  const ms = TIMEFRAME_MS[timeframe];
  return Array.from({ length: n }, (_, i) => {
    const open = 100 + i;
    const volume = 10 + i;
    return candle({
      symbol, timeframe, source, openTime: start + i * ms,
      open, high: open + 2, low: open - 1, close: open + 1, volume, quoteVolume: volume * open, trades: 5 + i,
      takerBuyVolume: volume / 2, takerBuyQuoteVolume: (volume * open) / 2,
    });
  });
}

const SYMBOL_INFO = (symbol) => ({
  symbol, baseAsset: symbol.replace(/USDT$/, ''), quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING',
  tickSize: '0.01', stepSize: '0.001',
});

async function setup(db, clock) {
  migrate(db);
  const symbols = createSymbolRepository(db);
  await symbols.upsertFromExchange(['BTCUSDT', 'ETHUSDT', 'PEPEUSDT'].map(SYMBOL_INFO), T0);
  return { symbols, candles: createCandleRepository(db, { clock }) };
}

describe('repositori candle', () => {
  let db;
  let clock;
  let repo;
  let symbols;
  const COUNT_SQL = {
    candles: 'SELECT COUNT(*) AS n FROM candles',
    provisional_candles: 'SELECT COUNT(*) AS n FROM provisional_candles',
  };
  const count = (table = 'candles') => db.prepare(COUNT_SQL[table]).get().n;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    clock = createClock(T0 + DAY);
    ({ candles: repo, symbols } = await setup(db, clock));
  });
  afterEach(() => db.close());

  describe('upsertClosed', () => {
    it('UNIT-CDL-001 batch tertutup disisipkan; getRange mengembalikan Candle kanonik', async () => {
      const batch = series(3);
      expect(await repo.upsertClosed(batch)).toEqual({ inserted: 3, updated: 0, rejected: [] });
      const stored = await repo.getRange({ symbol: 'BTCUSDT', timeframe: '5m', from: T0, to: T0 + 2 * STEP });
      expect(stored).toEqual(batch);
      expect(Object.keys(stored[0]).sort()).toEqual(Object.keys(batch[0]).sort());
      expect(stored.every((c) => c.isClosed === true)).toBe(true);
    });

    it('UNIT-CDL-002 idempoten: data persis sama tidak dihitung sebagai update', async () => {
      await repo.upsertClosed(series(5));
      expect(await repo.upsertClosed(series(5))).toEqual({ inserted: 0, updated: 0, rejected: [] });
      expect(count()).toBe(5);
    });

    it('UNIT-CDL-003 koreksi data (REST menimpa WS) dihitung updated dan menggantikan nilai lama', async () => {
      await repo.upsertClosed(series(3, { source: 'ws' }));
      clock.advance(60_000);
      const corrected = { ...series(3)[1], close: 101.5, volume: 11.75, takerBuyVolume: 5, source: 'rest' };
      expect(await repo.upsertClosed([corrected])).toEqual({ inserted: 0, updated: 1, rejected: [] });
      const [stored] = await repo.getRange({ symbol: 'BTCUSDT', timeframe: '5m', from: T0 + STEP, to: T0 + STEP });
      expect(stored).toEqual(corrected);
      expect(db.prepare('SELECT ingested_at FROM candles WHERE open_time = ?').get(T0 + STEP).ingested_at).toBe(T0 + DAY + 60_000);
    });

    it('UNIT-CDL-004 hanya sumber berbeda (data sama) → bukan update, sumber awal dipertahankan', async () => {
      await repo.upsertClosed(series(2, { source: 'ws' }));
      expect(await repo.upsertClosed(series(2, { source: 'rest' }))).toEqual({ inserted: 0, updated: 0, rejected: [] });
      const stored = await repo.getLatest({ symbol: 'BTCUSDT', timeframe: '5m', limit: 2 });
      expect(stored.map((c) => c.source)).toEqual(['ws', 'ws']);
    });

    it('UNIT-CDL-005 urutan acak (out-of-order) diterima; hasil baca urut naik', async () => {
      const [a, b, c, d] = series(4);
      expect((await repo.upsertClosed([d, b, a, c])).inserted).toBe(4);
      await repo.upsertClosed([series(6)[5]]); // candle lebih baru
      await repo.upsertClosed([series(6)[4]]); // datang terlambat, mengisi celah
      const stored = await repo.getRange({ symbol: 'BTCUSDT', timeframe: '5m', from: T0, to: T0 + DAY });
      expect(stored.map((x) => x.openTime)).toEqual([0, 1, 2, 3, 4, 5].map((i) => T0 + i * STEP));
    });

    it('UNIT-CDL-006 duplikat dalam satu batch: versi terakhir menang, dihitung sekali', async () => {
      const first = candle({ close: 101 });
      const last = candle({ close: 103 });
      expect(await repo.upsertClosed([first, candle({ openTime: T0 + STEP }), last])).toEqual({ inserted: 2, updated: 0, rejected: [] });
      const [stored] = await repo.getRange({ symbol: 'BTCUSDT', timeframe: '5m', from: T0, to: T0 });
      expect(stored.close).toBe(103);
    });

    it('NEG-CDL-001 candle rusak ditolak dengan alasan; candle valid dalam batch yang sama tetap disimpan', async () => {
      const bad = [
        candle({ openTime: T0 + STEP, high: 98, low: 99 }), // high < low
        candle({ openTime: T0 + 2 * STEP, close: Number.NaN }),
        candle({ openTime: T0 + 3 * STEP + 7 }), // tidak sejajar
        candle({ openTime: T0 + 4 * STEP, closeTime: T0 + 5 * STEP }), // closeTime salah
        candle({ openTime: T0 + 5 * STEP, symbol: 'btcusdt' }),
        null,
      ];
      const good = candle();
      const result = await repo.upsertClosed([...bad, good]);
      expect(result.inserted).toBe(1);
      expect(result.rejected).toHaveLength(bad.length);
      expect(result.rejected.map((r) => r.candle)).toEqual(bad);
      expect(result.rejected[0].errors.join('|')).toMatch(/high lebih kecil/);
      expect(result.rejected[1].errors.join('|')).toMatch(/close harus angka/);
      expect(result.rejected[2].errors.join('|')).toMatch(/tidak sejajar/);
      expect(result.rejected[3].errors.join('|')).toMatch(/closeTime/);
      expect(result.rejected[5].errors).toEqual(['candle harus berupa objek']);
      expect(count()).toBe(1);
    });

    it('NEG-CDL-002 candle belum tertutup & candle "tertutup" dari masa depan ditolak', async () => {
      const now = clock();
      const open = floor5m(now);
      const provisional = candle({ openTime: open, isClosed: false, source: 'ws' });
      const fakeClosed = candle({ openTime: open, isClosed: true, source: 'ws' });
      const result = await repo.upsertClosed([provisional, fakeClosed]);
      expect(result.inserted).toBe(0);
      expect(result.rejected[0].errors.join('|')).toMatch(/belum tertutup/);
      expect(result.rejected[1].errors.join('|')).toMatch(/ditandai tertutup sebelum closeTime/);
      expect(count()).toBe(0);
    });

    it('NEG-CDL-003 simbol yang belum terdaftar di tabel symbols ditolak dengan error jelas', async () => {
      const result = await repo.upsertClosed([candle({ symbol: 'DOGEUSDT' }), candle()]);
      expect(result.inserted).toBe(1);
      expect(result.rejected).toEqual([{ candle: candle({ symbol: 'DOGEUSDT' }), errors: ['simbol DOGEUSDT belum terdaftar di tabel symbols'] }]);
    });

    it.each([null, 'x', { length: 0 }])('NEG-CDL-004 masukan bukan array → TypeError: %s', async (input) => {
      await expect(repo.upsertClosed(input)).rejects.toThrow(TypeError);
    });

    it('EDGE-CDL-001 presisi kecil (0.00001234) tersimpan & terbaca persis', async () => {
      const tiny = candle({
        symbol: 'PEPEUSDT', open: 0.00001234, high: 0.00001299, low: 0.00001201, close: 0.00001250,
        volume: 98_765_432_109.5, quoteVolume: 1_234_567.891, takerBuyVolume: 0.00000001, takerBuyQuoteVolume: 1e-9,
      });
      await repo.upsertClosed([tiny]);
      const [stored] = await repo.getLatest({ symbol: 'PEPEUSDT', timeframe: '5m', limit: 1 });
      expect(stored.open).toBe(0.00001234);
      expect(stored.close).toBe(0.0000125);
      expect(stored.takerBuyQuoteVolume).toBe(1e-9);
      expect(stored).toEqual(tiny);
    });

    it('EDGE-CDL-002 volume nol (tanpa transaksi) valid dan tersimpan', async () => {
      const flat = candle({ open: 5, high: 5, low: 5, close: 5, volume: 0, quoteVolume: 0, trades: 0, takerBuyVolume: 0, takerBuyQuoteVolume: 0 });
      expect((await repo.upsertClosed([flat])).inserted).toBe(1);
      expect((await repo.getLatest({ symbol: 'BTCUSDT', timeframe: '5m', limit: 1 }))[0]).toEqual(flat);
    });

    it('EDGE-CDL-003 seluruh batch dalam satu transaksi: error di tengah → rollback penuh', async () => {
      // Pemicu khusus uji: menggagalkan INSERT candle bertanda trade_count = 777 (candle ke-3).
      db.exec(`CREATE TRIGGER fail_marked BEFORE INSERT ON candles WHEN NEW.trade_count = 777
               BEGIN SELECT RAISE(ABORT, 'gagal uji'); END`);
      const batch = series(5);
      batch[2] = { ...batch[2], trades: 777 };
      await expect(repo.upsertClosed(batch)).rejects.toThrow(/gagal uji/);
      expect(count()).toBe(0);
    });

    it('EDGE-CDL-004 simbol delisted: candle historis tetap diterima & terbaca', async () => {
      await repo.upsertClosed(series(2, { symbol: 'ETHUSDT' }));
      await symbols.markDelisted(['ETHUSDT'], T0 + DAY);
      expect((await repo.upsertClosed([series(3, { symbol: 'ETHUSDT' })[2]])).inserted).toBe(1);
      expect(await repo.getLastOpenTime({ symbol: 'ETHUSDT', timeframe: '5m' })).toBe(T0 + 2 * STEP);
    });

    it('EDGE-CDL-005 opsi { now } (waktu server) menggantikan jam lokal yang tertinggal', async () => {
      const lagging = createCandleRepository(db, { clock: () => T0 + STEP - 1 }); // jam lokal = closeTime
      const c = candle();
      expect((await lagging.upsertClosed([c])).rejected).toHaveLength(1);
      expect((await lagging.upsertClosed([c], { now: c.closeTime + 1 })).inserted).toBe(1);
      await expect(lagging.upsertClosed([c], { now: 'kemarin' })).rejects.toThrow(TypeError);
    });

    it('EDGE-CDL-006 batch besar (3 timeframe × 500) tersimpan dalam satu panggilan', async () => {
      const batch = ['5m', '15m', '1h'].flatMap((timeframe) => series(500, { timeframe, start: T0 - 500 * TIMEFRAME_MS[timeframe] }));
      expect((await repo.upsertClosed(batch)).inserted).toBe(1500);
      expect(await repo.getLastOpenTime({ symbol: 'BTCUSDT', timeframe: '1h' })).toBe(T0 - 3_600_000);
      expect(await repo.findGaps({ symbol: 'BTCUSDT', timeframe: '15m', from: T0 - 500 * 15 * 60_000, to: T0 - 15 * 60_000 })).toEqual([]);
    });

    it('EDGE-CDL-007 ingested_at memakai jam repositori yang diteruskan createRepositories', async () => {
      const repos = createRepositories(db, { clock });
      await repos.candles.upsertClosed(series(1));
      expect(db.prepare('SELECT MAX(ingested_at) AS t FROM candles').get().t).toBe(T0 + DAY);
    });
  });

  describe('pembacaan', () => {
    beforeEach(async () => {
      await repo.upsertClosed([...series(10), ...series(4, { symbol: 'ETHUSDT' }), ...series(4, { timeframe: '15m' })]);
    });

    it('UNIT-CDL-007 getRange inklusif di kedua batas dan terisolasi per simbol/timeframe', async () => {
      const r = await repo.getRange({ symbol: 'BTCUSDT', timeframe: '5m', from: T0 + 2 * STEP, to: T0 + 4 * STEP });
      expect(r.map((c) => c.openTime)).toEqual([2, 3, 4].map((i) => T0 + i * STEP));
      expect(r.every((c) => c.symbol === 'BTCUSDT' && c.timeframe === '5m')).toBe(true);
      expect(await repo.getRange({ symbol: 'ETHUSDT', timeframe: '15m', from: T0, to: T0 + DAY })).toEqual([]);
      expect(await repo.getRange({ symbol: 'BTCUSDT', timeframe: '5m', from: T0 + 5 * STEP, to: T0 })).toEqual([]);
    });

    it('UNIT-CDL-008 getLatest: N candle terakhir urut naik; getLastOpenTime', async () => {
      const latest = await repo.getLatest({ symbol: 'BTCUSDT', timeframe: '5m', limit: 3 });
      expect(latest.map((c) => c.openTime)).toEqual([7, 8, 9].map((i) => T0 + i * STEP));
      expect(await repo.getLatest({ symbol: 'ETHUSDT', timeframe: '5m', limit: 100 })).toHaveLength(4);
      expect(await repo.getLastOpenTime({ symbol: 'BTCUSDT', timeframe: '5m' })).toBe(T0 + 9 * STEP);
      expect(await repo.getLastOpenTime({ symbol: 'BTCUSDT', timeframe: '1h' })).toBeNull();
      expect(await repo.getLastOpenTime({ symbol: 'DOGEUSDT', timeframe: '5m' })).toBeNull();
      expect(await repo.getLatest({ symbol: 'DOGEUSDT', timeframe: '5m', limit: 5 })).toEqual([]);
    });

    it.each([
      ['timeframe tidak didukung', (r) => r.getRange({ symbol: 'BTCUSDT', timeframe: '4h', from: T0, to: T0 })],
      ['from bukan angka', (r) => r.getRange({ symbol: 'BTCUSDT', timeframe: '5m', from: '0', to: T0 })],
      ['simbol format salah', (r) => r.getLatest({ symbol: "x' OR 1=1 --", timeframe: '5m', limit: 1 })],
      ['limit nol', (r) => r.getLatest({ symbol: 'BTCUSDT', timeframe: '5m', limit: 0 })],
      ['limit pecahan', (r) => r.getLatest({ symbol: 'BTCUSDT', timeframe: '5m', limit: 2.5 })],
      ['limit terlalu besar', (r) => r.getLatest({ symbol: 'BTCUSDT', timeframe: '5m', limit: 1_000_000 })],
      ['findGaps to NaN', (r) => r.findGaps({ symbol: 'BTCUSDT', timeframe: '5m', from: T0, to: Number.NaN })],
      ['getLastOpenTime timeframe kosong', (r) => r.getLastOpenTime({ symbol: 'BTCUSDT' })],
    ])('NEG-CDL-005 argumen baca tidak valid ditolak: %s', async (_label, call) => {
      await expect(call(repo)).rejects.toThrow(/tidak valid|tidak didukung|harus/);
    });
  });

  describe('findGaps', () => {
    const at = (i) => T0 + i * STEP;
    const store = (indexes) => repo.upsertClosed(series(Math.max(...indexes) + 1).filter((_, i) => indexes.includes(i)));
    const gaps = (from, to, symbol = 'BTCUSDT') => repo.findGaps({ symbol, timeframe: '5m', from, to });

    it('UNIT-CDL-009 tanpa gap → []', async () => {
      await store([0, 1, 2, 3, 4]);
      expect(await gaps(at(0), at(4))).toEqual([]);
    });

    it('UNIT-CDL-010 gap di awal, tengah, dan akhir rentang', async () => {
      await store([2, 3, 5, 8]);
      expect(await gaps(at(0), at(10))).toEqual([
        { from: at(0), to: at(1) },
        { from: at(4), to: at(4) },
        { from: at(6), to: at(7) },
        { from: at(9), to: at(10) },
      ]);
    });

    it('EDGE-CDL-008 batas tidak sejajar dibulatkan ke dalam; rentang terbalik → []', async () => {
      await store([1, 2]);
      expect(await gaps(at(0) + 1, at(4) - 1)).toEqual([{ from: at(3), to: at(3) }]);
      expect(await gaps(at(0) + 1, at(0) + 2)).toEqual([]); // tidak memuat open time sejajar
      expect(await gaps(at(5), at(1))).toEqual([]);
    });

    it('EDGE-CDL-009 tanpa data / simbol tidak dikenal → seluruh rentang hilang', async () => {
      expect(await gaps(at(0), at(3))).toEqual([{ from: at(0), to: at(3) }]);
      expect(await gaps(at(0), at(0), 'DOGEUSDT')).toEqual([{ from: at(0), to: at(0) }]);
    });

    it('EDGE-CDL-010 gap dihitung per timeframe; candle provisional tidak menutup gap', async () => {
      await repo.upsertClosed(series(2, { timeframe: '15m' }));
      const current = floor5m(clock());
      await repo.upsertProvisional(candle({ openTime: current, isClosed: false, source: 'ws' }));
      expect(await gaps(current - STEP, current)).toEqual([{ from: current - STEP, to: current }]);
      expect(await gaps(at(0), at(1))).toEqual([{ from: at(0), to: at(1) }]);
      expect(await repo.findGaps({ symbol: 'BTCUSDT', timeframe: '15m', from: T0, to: T0 + 15 * 60_000 })).toEqual([]);
    });
  });

  describe('candle provisional', () => {
    const live = (offsetSteps = 0, overrides = {}) => candle({
      openTime: floor5m(clock()) + offsetSteps * STEP, isClosed: false, source: 'ws', ...overrides,
    });

    it('UNIT-CDL-011 provisional disimpan terpisah dan tidak pernah masuk tabel candles', async () => {
      const p = live();
      await repo.upsertProvisional(p);
      expect(await repo.getProvisional({ symbol: 'BTCUSDT', timeframe: '5m' })).toEqual(p);
      expect(count()).toBe(0);
      expect(await repo.getLastOpenTime({ symbol: 'BTCUSDT', timeframe: '5m' })).toBeNull();
      expect(await repo.getProvisional({ symbol: 'BTCUSDT', timeframe: '15m' })).toBeNull();
      expect(await repo.getProvisional({ symbol: 'DOGEUSDT', timeframe: '5m' })).toBeNull();
    });

    it('UNIT-CDL-012 hanya satu baris terbaru per simbol × timeframe; update lebih lama diabaikan', async () => {
      await repo.upsertProvisional(live(-1, { close: 101 }));
      await repo.upsertProvisional(live(0, { close: 102 }));
      await repo.upsertProvisional(live(0, { close: 103, high: 106 })); // tick berikutnya, candle sama
      await repo.upsertProvisional(live(-1, { close: 99.5 })); // pesan terlambat
      expect(count('provisional_candles')).toBe(1);
      expect(await repo.getProvisional({ symbol: 'BTCUSDT', timeframe: '5m' })).toMatchObject({ openTime: live().openTime, close: 103, high: 106 });
    });

    it('UNIT-CDL-013 candle tertutup menggantikan provisional; provisional terlambat untuk candle tertutup diabaikan', async () => {
      const p = live(-1); // interval sebelumnya: sudah tertutup pada jam sekarang
      await repo.upsertProvisional(p);
      await repo.upsertClosed([{ ...p, isClosed: true, source: 'rest' }]);
      expect(await repo.getProvisional({ symbol: 'BTCUSDT', timeframe: '5m' })).toBeNull();
      await repo.upsertProvisional(p);
      expect(await repo.getProvisional({ symbol: 'BTCUSDT', timeframe: '5m' })).toBeNull();
      await repo.upsertProvisional(live(0));
      expect((await repo.getProvisional({ symbol: 'BTCUSDT', timeframe: '5m' })).openTime).toBe(live(0).openTime);
    });

    it.each([
      ['candle tertutup', () => candle(), /upsertClosed/],
      ['OHLC rusak', () => live(0, { high: 1 }), /high lebih kecil/],
      ['open time di masa depan', () => live(2), /masa depan/],
      ['simbol belum terdaftar', () => live(0, { symbol: 'DOGEUSDT' }), /belum terdaftar/],
      ['bukan objek', () => null, /objek/],
    ])('NEG-CDL-006 upsertProvisional menolak: %s', async (_label, make, pattern) => {
      await expect(repo.upsertProvisional(make())).rejects.toThrow(pattern);
      expect(count('provisional_candles')).toBe(0);
    });
  });

  describe('skema 003', () => {
    const rawInsert = (sql, params) => db.prepare(sql).run(params);
    const OLD_STYLE = `INSERT INTO candles (symbol_id, timeframe, open_time, close_time, open, high, low, close, volume,
      quote_volume, trade_count, is_closed, source, ingested_at)
      VALUES (1, '5m', @openTime, @openTime + 299999, 10, @high, 9, 10, 1, 10, 1, 1, 'rest', 0)`;

    it('UNIT-CDL-014 kolom taker baru berdefault 0 untuk insert gaya lama', () => {
      rawInsert(OLD_STYLE, { openTime: T0, high: 11 });
      expect(db.prepare('SELECT taker_buy_volume, taker_buy_quote_volume FROM candles').get()).toEqual({ taker_buy_volume: 0, taker_buy_quote_volume: 0 });
    });

    it('NEG-CDL-007 constraint lama tetap berlaku & kolom baru tervalidasi', () => {
      expect(() => rawInsert(OLD_STYLE, { openTime: T0, high: 8 })).toThrow(/CHECK/); // high < low
      rawInsert(OLD_STYLE, { openTime: T0, high: 11 });
      expect(() => rawInsert(OLD_STYLE, { openTime: T0, high: 11 })).toThrow(/UNIQUE|PRIMARY KEY/);
      expect(() => db.prepare('UPDATE candles SET taker_buy_volume = -1').run()).toThrow(/CHECK/);
      expect(() => db.prepare("UPDATE candles SET taker_buy_quote_volume = 'banyak'").run()).toThrow(/cannot store|CHECK/);
    });

    it('NEG-CDL-008 provisional_candles: satu baris per simbol × timeframe, STRICT, FK ke symbols', () => {
      const insert = db.prepare(`INSERT INTO provisional_candles (symbol_id, timeframe, open_time, close_time, open, high, low, close,
        volume, quote_volume, trade_count, taker_buy_volume, taker_buy_quote_volume, source, updated_at)
        VALUES (@symbolId, '5m', @openTime, @openTime + 299999, @open, 11, 9, 10, 1, 10, 1, 0, 0, 'ws', 0)`);
      insert.run({ symbolId: 1, openTime: T0, open: 10 });
      expect(() => insert.run({ symbolId: 1, openTime: T0 + STEP, open: 10 })).toThrow(/UNIQUE|PRIMARY KEY/);
      expect(() => insert.run({ symbolId: 2, openTime: T0, open: 'x' })).toThrow(/cannot store/);
      expect(() => insert.run({ symbolId: 999, openTime: T0, open: 10 })).toThrow(/FOREIGN KEY/);
    });
  });
});

describe('restart database', () => {
  it('EDGE-CDL-011 candle & provisional bertahan setelah database ditutup dan dibuka ulang', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lr-candles-'));
    const path = join(dir, 'lr.db');
    try {
      const clock = createClock(T0 + DAY);
      const db1 = openDatabase(path);
      const { candles: repo1 } = await setup(db1, clock);
      await repo1.upsertClosed(series(6));
      await repo1.upsertProvisional(candle({ openTime: floor5m(clock()), isClosed: false, source: 'ws' }));
      db1.close();

      const db2 = openDatabase(path);
      expect(migrate(db2).applied).toEqual([]);
      const repo2 = createCandleRepository(db2, { clock });
      expect(await repo2.getLastOpenTime({ symbol: 'BTCUSDT', timeframe: '5m' })).toBe(T0 + 5 * STEP);
      expect(await repo2.getRange({ symbol: 'BTCUSDT', timeframe: '5m', from: T0, to: T0 + DAY })).toEqual(series(6));
      expect((await repo2.getProvisional({ symbol: 'BTCUSDT', timeframe: '5m' })).isClosed).toBe(false);
      expect(await repo2.upsertClosed(series(6))).toEqual({ inserted: 0, updated: 0, rejected: [] });
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function floor5m(t) {
  return Math.floor(t / STEP) * STEP;
}
