import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../../backend/database/connection.js';
import { migrate } from '../../../backend/database/migrate.js';
import { createCandleRepository } from '../../../backend/database/repositories/candleRepository.js';
import { SignalRepositoryError, createSignalRepository, transition } from '../../../backend/signals/index.js';

// Data uji deterministik — sintetis, bukan data pasar nyata.
const T0 = Date.UTC(2026, 0, 5, 10, 0);
const TF_MS = { '5m': 5 * 60_000, '15m': 15 * 60_000, '1h': 60 * 60_000 };

const SA_V1 = { key: 'SA', version: 1, name: 'Silent Accumulation', definition: { window: 48, conditions: ['flat_range', 'volume_rise'] } };
const PVA_V1 = { key: 'PVA', version: 1, name: 'Progressive Volume Accumulation', definition: { window: 24 } };

function candle(i, close, timeframe = '5m') {
  const ms = TF_MS[timeframe];
  return {
    symbol: 'BTCUSDT', timeframe, openTime: T0 + i * ms, closeTime: T0 + (i + 1) * ms - 1,
    open: close, high: close + 0.2, low: close - 0.2, close, volume: 100, quoteVolume: 100 * close,
    trades: 10, takerBuyVolume: 50, takerBuyQuoteVolume: 50 * close, isClosed: true, source: 'ws',
  };
}
// PatternResult palsu sesuai kontrak docs/07 §6.
const result = (pattern, o = {}) => ({
  pattern, version: 1, detected: true, patternScore: 70, earlyScore: 40, conditions: [],
  invalidationPrice: 95, evaluatedAt: 0, riskFlags: [], insufficientData: false, ...o,
});
const off = (pattern) => result(pattern, { detected: false, patternScore: 20, earlyScore: 10, invalidationPrice: null });

function input(i, close, { cls = 'SA', sa = {}, pva = {}, timeframe = '5m', market = {}, alignment = 'PARTIALLY_CONFIRMED' } = {}) {
  const hasSa = cls === 'SA' || cls === 'BOTH';
  const hasPva = cls === 'PVA' || cls === 'BOTH';
  return {
    candle: candle(i, close, timeframe),
    patterns: { classification: cls, sa: hasSa ? result('SA', sa) : off('SA'), pva: hasPva ? result('PVA', pva) : off('PVA') },
    context: { alignment },
    market: { atr: 1, rvol: 1, resistance: 104, ...market },
  };
}

/** Skenario lengkap: QUIET → EARLY → (tetap) → MOMENTUM → BREAKOUT → (tetap) → EXPIRED. */
const LIFECYCLE = [
  input(0, 100),
  input(1, 100.2, { sa: { earlyScore: 75 } }),
  input(2, 100.5),
  input(3, 101.3),
  input(4, 104.8, { market: { rvol: 2.5 } }),
  input(5, 105.1),
  input(6, 105),
];
const PARAMS = { expiryBars: { BREAKOUT: 2 } };

function setup(path = ':memory:') {
  const db = openDatabase(path);
  migrate(db, { now: () => new Date(0) });
  const insert = db.prepare(`INSERT OR IGNORE INTO symbols (symbol, base_asset, quote_asset, contract_type, status, first_seen_at, last_seen_at)
    VALUES (?, ?, 'USDT', 'PERPETUAL', 'TRADING', 0, 0)`);
  insert.run('BTCUSDT', 'BTC');
  insert.run('ETHUSDT', 'ETH');
  return { db, repo: createSignalRepository(db, { clock: () => T0 }) };
}

/** Menjalankan transisi dan menyimpan hasilnya — seperti yang dilakukan worker. */
async function drive(repo, steps, { symbol = 'BTCUSDT', timeframe = '5m', prev = null, params = PARAMS } = {}) {
  let snap = prev;
  const results = [];
  for (const step of steps) {
    const r = transition(snap, step, params);
    const saved = await repo.save({ symbol, timeframe, snapshot: r.next, event: r.event });
    results.push({ ...r, saved });
    snap = r.next;
  }
  return { snap, results };
}

const tempDirs = [];
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe('repositori sinyal', () => {
  it('UNIT-SREP-001 ensurePatternDefinition idempoten per (pattern_key, version)', async () => {
    const { db, repo } = setup();
    const id = await repo.ensurePatternDefinition(SA_V1);
    // Urutan kunci berbeda = definisi yang sama.
    expect(await repo.ensurePatternDefinition({ ...SA_V1, definition: { conditions: ['flat_range', 'volume_rise'], window: 48 } })).toBe(id);
    expect(db.prepare("SELECT COUNT(*) n FROM pattern_definitions WHERE pattern_key = 'SA'").get().n).toBe(1);
    expect(db.prepare('SELECT status, created_at, activated_at FROM pattern_definitions WHERE id = ?').get(id))
      .toEqual({ status: 'active', created_at: T0, activated_at: T0 });
    const v2 = await repo.ensurePatternDefinition({ ...SA_V1, version: 2, definition: { window: 36 } });
    expect(v2).not.toBe(id);
    await expect(repo.ensurePatternDefinition({ ...SA_V1, definition: { window: 12 } })).rejects.toMatchObject({ code: 'DEFINITION_CONFLICT' });
  });

  it('NEG-SREP-001 definisi pola tidak valid ditolak sebelum menyentuh database', async () => {
    const { repo } = setup();
    await expect(repo.ensurePatternDefinition({ ...SA_V1, key: 'sa' })).rejects.toThrow(RangeError);
    await expect(repo.ensurePatternDefinition({ ...SA_V1, key: "SA'; DROP TABLE signals; --" })).rejects.toThrow(RangeError);
    await expect(repo.ensurePatternDefinition({ ...SA_V1, version: 0 })).rejects.toThrow(RangeError);
    await expect(repo.ensurePatternDefinition({ ...SA_V1, definition: [] })).rejects.toThrow(TypeError);
    await expect(repo.ensurePatternDefinition({ ...SA_V1, name: ' ' })).rejects.toThrow(RangeError);
    await expect(repo.ensurePatternDefinition({ ...SA_V1, status: 'live' })).rejects.toThrow(RangeError);
  });

  it('POS-SREP-001 siklus hidup lengkap tersimpan: sinyal, snapshot, event, closed_at', async () => {
    const { db, repo } = setup();
    await repo.ensurePatternDefinition(SA_V1);
    const { results } = await drive(repo, LIFECYCLE);
    expect(results.map((r) => r.next.state)).toEqual(['QUIET', 'EARLY_BULLISH', 'EARLY_BULLISH', 'MOMENTUM_BUILDING', 'BREAKOUT', 'BREAKOUT', 'EXPIRED']);
    expect(results[0].saved).toMatchObject({ opened: true, saved: true });
    const ids = new Set(results.map((r) => r.saved.id));
    expect(ids.size).toBe(1);

    const row = db.prepare('SELECT * FROM signals').get();
    expect(row).toMatchObject({
      classification: 'SA', state: 'EXPIRED', first_detected_at: T0 + TF_MS['5m'] - 1, first_detected_price: 100,
      invalidation_price: 95, closed_at: T0 + 7 * TF_MS['5m'] - 1, final_outcome: 'EXPIRED:BREAKOUT', timeframe: '5m',
    });
    const events = db.prepare('SELECT from_state, to_state, candle_time, occurred_at, detail_json FROM signal_events ORDER BY id').all();
    expect(events.map((e) => `${e.from_state}>${e.to_state}`)).toEqual([
      'NO_PATTERN>QUIET', 'QUIET>EARLY_BULLISH', 'EARLY_BULLISH>MOMENTUM_BUILDING', 'MOMENTUM_BUILDING>BREAKOUT', 'BREAKOUT>EXPIRED',
    ]);
    expect(events[3]).toMatchObject({ candle_time: T0 + 4 * TF_MS['5m'], occurred_at: T0 + 5 * TF_MS['5m'] - 1 });
    expect(JSON.parse(events[3].detail_json)).toMatchObject({ reason: 'BREAKOUT_CONFIRMED', rvol: 2.5, resistance: 104 });
    expect(await repo.getOpen({ symbol: 'BTCUSDT', timeframe: '5m' })).toBeNull();

    const [h] = await repo.history({ symbol: 'BTCUSDT', limit: 10 });
    expect(h).toMatchObject({ state: 'EXPIRED', patternKey: 'SA', patternVersion: 1, peakState: 'BREAKOUT', finalOutcome: 'EXPIRED:BREAKOUT' });
    expect(h.events.map((e) => e.toState)).toEqual(['QUIET', 'EARLY_BULLISH', 'MOMENTUM_BUILDING', 'BREAKOUT', 'EXPIRED']);
    expect(h.events[0].detail.reason).toBe('PATTERN_DETECTED');
  });

  it('UNIT-SREP-002 NO_PATTERN/NONE tidak pernah disimpan; terminal tanpa event = no-op', async () => {
    const { db, repo } = setup();
    await repo.ensurePatternDefinition(SA_V1);
    const idle = transition(null, input(0, 100, { cls: 'NONE' }));
    expect(await repo.save({ symbol: 'BTCUSDT', timeframe: '5m', snapshot: idle.next, event: idle.event })).toMatchObject({ saved: false, id: null });
    expect(db.prepare('SELECT COUNT(*) n FROM signals').get().n).toBe(0);
    // CHECK skema juga menolak klasifikasi NONE secara langsung.
    expect(() => db.prepare(`INSERT INTO signals (symbol_id, timeframe, pattern_definition_id, classification, state, first_detected_at,
      first_detected_price, updated_at) VALUES (1, '5m', 1, 'NONE', 'QUIET', 0, 1, 0)`).run()).toThrow(/CHECK/);

    const { snap } = await drive(repo, [input(0, 100), input(1, 90)]);
    expect(snap.state).toBe('INVALIDATED');
    expect(await repo.save({ symbol: 'BTCUSDT', timeframe: '5m', snapshot: snap, event: null })).toMatchObject({ saved: false });
    expect(db.prepare('SELECT COUNT(*) n FROM signal_events').get().n).toBe(2);
  });

  it('UNIT-SREP-003 getOpen mengembalikan snapshot yang identik dengan hasil transition', async () => {
    const { repo } = setup();
    await repo.ensurePatternDefinition(SA_V1);
    const { snap } = await drive(repo, LIFECYCLE.slice(0, 5));
    const restored = await repo.getOpen({ symbol: 'BTCUSDT', timeframe: '5m' });
    expect(restored).toEqual({ id: expect.any(Number), ...snap });
    expect(await repo.getOpen({ symbol: 'BTCUSDT', timeframe: '15m' })).toBeNull();
    expect(await repo.getOpen({ symbol: 'XRPUSDT', timeframe: '5m' })).toBeNull();
  });

  it('POS-SREP-002 persistensi & restart (file DB sementara): hasil sama dengan proses tanpa restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lr-signals-'));
    tempDirs.push(dir);
    const file = join(dir, 'signals.db');

    // Proses 1: jalankan separuh skenario lalu "crash" (tutup koneksi).
    const first = setup(file);
    await first.repo.ensurePatternDefinition(SA_V1);
    await drive(first.repo, LIFECYCLE.slice(0, 4));
    first.db.close();

    // Proses 2: buka ulang, migrasi idempoten, lanjutkan dari getOpen. Candle terakhir dikirim ulang (duplikat) → diabaikan.
    const second = setup(file);
    expect(migrate(second.db).applied).toEqual([]);
    await second.repo.ensurePatternDefinition(SA_V1);
    const prev = await second.repo.getOpen({ symbol: 'BTCUSDT', timeframe: '5m' });
    expect(prev).toMatchObject({ state: 'MOMENTUM_BUILDING', lastCandleTime: T0 + 3 * TF_MS['5m'], firstDetectedPrice: 100 });
    const resumed = await drive(second.repo, [LIFECYCLE[3], ...LIFECYCLE.slice(4)], { prev });
    expect(resumed.results[0].event).toBeNull();
    const historyAfterRestart = await second.repo.history({ limit: 5 });
    second.db.close();

    // Referensi: proses tanpa restart.
    const ref = setup();
    await ref.repo.ensurePatternDefinition(SA_V1);
    const uninterrupted = await drive(ref.repo, LIFECYCLE);
    expect(resumed.snap).toEqual({ id: expect.any(Number), ...uninterrupted.snap });
    const strip = (h) => h.map(({ id: _id, events, ...rest }) => ({ ...rest, events: events.map(({ id: _e, ...e }) => e) }));
    expect(strip(historyAfterRestart)).toEqual(strip(await ref.repo.history({ limit: 5 })));
  });

  it('UNIT-SREP-004 perubahan versi pola: sinyal lama tetap mereferensikan versi lamanya', async () => {
    const { db, repo } = setup();
    const v1 = await repo.ensurePatternDefinition(SA_V1);
    const first = await drive(repo, [input(0, 100), input(1, 100.3, { sa: { version: 2 } }), input(2, 94, { sa: { version: 2 } })]);
    expect(first.snap).toMatchObject({ state: 'INVALIDATED', patternVersion: 1 });
    const v2 = await repo.ensurePatternDefinition({ ...SA_V1, version: 2, definition: { window: 36 } });
    await drive(repo, [input(3, 96, { sa: { version: 2, invalidationPrice: 93 } })], { prev: first.snap });
    const rows = db.prepare('SELECT state, pattern_definition_id FROM signals ORDER BY id').all();
    expect(rows).toEqual([{ state: 'INVALIDATED', pattern_definition_id: v1 }, { state: 'QUIET', pattern_definition_id: v2 }]);
    const hist = await repo.history({ symbol: 'BTCUSDT', limit: 10 });
    expect(hist.map((h) => [h.state, h.patternVersion])).toEqual([['QUIET', 2], ['INVALIDATED', 1]]);
  });

  it('UNIT-SREP-005 listActive memfilter timeframe, klasifikasi, state, dan skor minimum', async () => {
    const { repo } = setup();
    await repo.ensurePatternDefinition(SA_V1);
    await repo.ensurePatternDefinition(PVA_V1);
    await drive(repo, [input(0, 100, { sa: { patternScore: 82, earlyScore: 80 } })]); // BTC 5m SA EARLY 82
    await drive(repo, [input(0, 50, { cls: 'PVA', timeframe: '15m', pva: { patternScore: 55, invalidationPrice: 45 } })], { symbol: 'ETHUSDT', timeframe: '15m' }); // ETH 15m PVA QUIET 55
    await drive(repo, [input(0, 100, { cls: 'BOTH', timeframe: '1h', sa: { patternScore: 60 }, pva: { patternScore: 71 } }),
      input(1, 101.5, { cls: 'BOTH', timeframe: '1h' })], { timeframe: '1h' }); // BTC 1h BOTH MOMENTUM 70
    await drive(repo, [input(0, 50, { cls: 'SA', sa: { invalidationPrice: 45 } }), input(1, 40)], { symbol: 'ETHUSDT' }); // ETH 5m tertutup

    const all = await repo.listActive();
    expect(all.map((s) => [s.symbol, s.timeframe, s.classification, s.state, s.patternScore])).toEqual([
      ['BTCUSDT', '5m', 'SA', 'EARLY_BULLISH', 82],
      ['BTCUSDT', '1h', 'BOTH', 'MOMENTUM_BUILDING', 70],
      ['ETHUSDT', '15m', 'PVA', 'QUIET', 55],
    ]);
    expect(all[1].patternKey).toBe('PVA');
    expect((await repo.listActive({ timeframe: '15m' })).map((s) => s.symbol)).toEqual(['ETHUSDT']);
    expect((await repo.listActive({ classification: 'BOTH' })).map((s) => s.timeframe)).toEqual(['1h']);
    expect((await repo.listActive({ state: 'EARLY_BULLISH' })).map((s) => s.timeframe)).toEqual(['5m']);
    expect((await repo.listActive({ minScore: 70 })).map((s) => s.patternScore)).toEqual([82, 70]);
    expect(await repo.listActive({ minScore: 70, timeframe: '15m' })).toEqual([]);
    expect((await repo.listActive({ limit: 1 })).length).toBe(1);
  });

  it('NEG-SREP-002 filter tidak valid ditolak (termasuk upaya injeksi SQL)', async () => {
    const { repo } = setup();
    await expect(repo.listActive({ timeframe: "5m' OR 1=1 --" })).rejects.toThrow(RangeError);
    await expect(repo.listActive({ classification: 'NONE' })).rejects.toThrow(RangeError);
    await expect(repo.listActive({ state: 'INVALIDATED' })).rejects.toThrow(RangeError);
    await expect(repo.listActive({ minScore: 101 })).rejects.toThrow(RangeError);
    await expect(repo.listActive({ minScore: '50' })).rejects.toThrow(RangeError);
    await expect(repo.listActive({ symbol: 'BTCUSDT' })).rejects.toThrow(TypeError);
    await expect(repo.history({ limit: 0 })).rejects.toThrow(RangeError);
    await expect(repo.history({ limit: 501 })).rejects.toThrow(RangeError);
    await expect(repo.history({ symbol: 'btc' })).rejects.toThrow(RangeError);
    await expect(repo.getOpen({ symbol: 'BTCUSDT', timeframe: '4h' })).rejects.toThrow(RangeError);
  });

  it('NEG-SREP-003 save menolak keadaan yang tidak konsisten', async () => {
    const { repo } = setup();
    const opening = transition(null, input(0, 100));
    const save = (o) => repo.save({ symbol: 'BTCUSDT', timeframe: '5m', snapshot: opening.next, event: opening.event, ...o });

    await expect(save()).rejects.toMatchObject({ code: 'UNKNOWN_PATTERN_DEFINITION' });
    await repo.ensurePatternDefinition(SA_V1);
    await expect(save({ symbol: 'XRPUSDT' })).rejects.toMatchObject({ code: 'UNKNOWN_SYMBOL' });
    await expect(save({ timeframe: '4h' })).rejects.toThrow(RangeError);
    await expect(save({ event: { ...opening.event, toState: 'BREAKOUT' } })).rejects.toThrow(RangeError);
    await expect(save({ snapshot: { ...opening.next, patternScore: 150 } })).rejects.toThrow(RangeError);
    await expect(save({ snapshot: { ...opening.next, riskFlags: ['MOON'] } })).rejects.toThrow(RangeError);

    // Pembaruan tanpa sinyal terbuka.
    const later = transition(opening.next, input(1, 100.1));
    await expect(repo.save({ symbol: 'BTCUSDT', timeframe: '5m', snapshot: later.next, event: later.event })).rejects.toMatchObject({ code: 'NO_OPEN_SIGNAL' });

    await save();
    await expect(save()).rejects.toMatchObject({ code: 'OPEN_SIGNAL_EXISTS' });
    await repo.save({ symbol: 'BTCUSDT', timeframe: '5m', snapshot: later.next, event: later.event });
    // Snapshot lebih lama dari yang tersimpan (penulis lain sudah lebih maju).
    await expect(repo.save({ symbol: 'BTCUSDT', timeframe: '5m', snapshot: opening.next, event: null })).rejects.toMatchObject({ code: 'STALE_SNAPSHOT' });
    // Snapshot dari sinyal lain (firstDetectedAt berbeda).
    await expect(repo.save({ symbol: 'BTCUSDT', timeframe: '5m', snapshot: { ...later.next, firstDetectedAt: 1 }, event: null }))
      .rejects.toMatchObject({ code: 'SNAPSHOT_MISMATCH' });
    expect(new SignalRepositoryError('x', 'Y')).toBeInstanceOf(Error);
  });

  it('NEG-SREP-005 save snapshot BREAKOUT tanpa event di atas sinyal QUIET → ditolak STATE_CHANGE_WITHOUT_EVENT; state & riwayat tidak berubah', async () => {
    const { db, repo } = setup();
    await repo.ensurePatternDefinition(SA_V1);
    const opened = transition(null, input(0, 100));
    await repo.save({ symbol: 'BTCUSDT', timeframe: '5m', snapshot: opened.next, event: opened.event });
    const jumped = { ...opened.next, state: 'BREAKOUT', lastCandleTime: opened.next.lastCandleTime + TF_MS['5m'] };
    await expect(repo.save({ symbol: 'BTCUSDT', timeframe: '5m', snapshot: jumped, event: null }))
      .rejects.toMatchObject({ code: 'STATE_CHANGE_WITHOUT_EVENT' });
    const [h] = await repo.history({ symbol: 'BTCUSDT', limit: 1 });
    expect(h.state).toBe('QUIET');
    expect(h.events.map((e) => `${e.fromState}>${e.toState}`)).toEqual(['NO_PATTERN>QUIET']);
    expect(db.prepare('SELECT COUNT(*) n FROM signal_events').get().n).toBe(1);
    // Snapshot tanpa perubahan state (skor/klasifikasi/tracking) tetap boleh tanpa event.
    const same = transition(opened.next, input(1, 100.1));
    expect(same.event).toBeNull();
    expect(await repo.save({ symbol: 'BTCUSDT', timeframe: '5m', snapshot: same.next, event: null })).toMatchObject({ saved: true });
  });

  it('EDGE-SREP-001 kegagalan di tengah save di-rollback seluruhnya', async () => {
    const { db, repo } = setup();
    await repo.ensurePatternDefinition(SA_V1);
    const r = transition(null, input(0, 100));
    const badEvent = { ...r.event, detail: { bad: 10n } }; // BigInt tidak dapat diserialisasi → gagal setelah INSERT sinyal
    await expect(repo.save({ symbol: 'BTCUSDT', timeframe: '5m', snapshot: r.next, event: badEvent })).rejects.toThrow(TypeError);
    expect(db.prepare('SELECT COUNT(*) n FROM signals').get().n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) n FROM signal_events').get().n).toBe(0);
  });

  it('POS-SREP-003 closeOpenForSymbol SYMBOL_DELISTED: semua sinyal terbuka BTCUSDT (5m, 1h) → EXPIRED + event dalam satu transaksi; price = close tersimpan terakhir (null tanpa candle); ETHUSDT tidak tersentuh', async () => {
    const { db, repo } = setup();
    await repo.ensurePatternDefinition(SA_V1);
    const m5 = await drive(repo, LIFECYCLE.slice(0, 4)); // QUIET → EARLY → (tetap) → MOMENTUM (terbuka)
    await drive(repo, [input(0, 100, { timeframe: '1h' })], { timeframe: '1h' });
    await drive(repo, [input(0, 100)], { symbol: 'ETHUSDT' });
    // Candle tersimpan BTCUSDT 5m sampai indeks 5 (lebih baru dari candle terakhir yang dievaluasi, 3).
    const candles = createCandleRepository(db, { clock: () => T0 + 1_000 * TF_MS['5m'] });
    await candles.upsertClosed([candle(4, 104.8), candle(5, 105.1)]);
    const lastEvent = await repo.lastEventCandleTime({ symbol: 'BTCUSDT', timeframe: '5m' });
    const AT = T0 + 9 * TF_MS['5m'] + 7_000;

    const { closed } = await repo.closeOpenForSymbol({ symbol: 'BTCUSDT', reason: 'SYMBOL_DELISTED', at: AT });
    expect(closed).toEqual([
      { id: expect.any(Number), timeframe: '1h', fromState: 'QUIET', price: null },
      { id: m5.results[0].saved.id, timeframe: '5m', fromState: 'MOMENTUM_BUILDING', price: 105.1 },
    ]);
    expect(await repo.getOpen({ symbol: 'BTCUSDT', timeframe: '5m' })).toBeNull();
    expect(await repo.getOpen({ symbol: 'BTCUSDT', timeframe: '1h' })).toBeNull();
    expect(await repo.getOpen({ symbol: 'ETHUSDT', timeframe: '5m' })).not.toBeNull();
    expect((await repo.listActive()).map((a) => a.symbol)).toEqual(['ETHUSDT']);

    const rows = db.prepare(`SELECT s.timeframe, s.state, s.final_outcome, s.closed_at, s.updated_at FROM signals s
      JOIN symbols sym ON sym.id = s.symbol_id WHERE sym.symbol = 'BTCUSDT' ORDER BY s.timeframe`).all();
    expect(rows).toEqual([
      { timeframe: '1h', state: 'EXPIRED', final_outcome: 'EXPIRED:QUIET', closed_at: AT, updated_at: AT },
      { timeframe: '5m', state: 'EXPIRED', final_outcome: 'EXPIRED:MOMENTUM_BUILDING', closed_at: AT, updated_at: AT },
    ]);
    const [h] = (await repo.history({ symbol: 'BTCUSDT', limit: 10 })).filter((x) => x.timeframe === '5m');
    expect(h.events.at(-1)).toEqual({
      id: expect.any(Number), occurredAt: AT, candleTime: T0 + 3 * TF_MS['5m'], fromState: 'MOMENTUM_BUILDING', toState: 'EXPIRED', price: 105.1,
      detail: { reason: 'SYMBOL_DELISTED', barsInPrevState: 0, firstDetectedPrice: 100, invalidationPrice: 95, priceCandleTime: T0 + 5 * TF_MS['5m'] },
    });
    expect(h).toMatchObject({ state: 'EXPIRED', finalOutcome: 'EXPIRED:MOMENTUM_BUILDING', closedAt: AT });
    // Titik awal replay pipeline tidak bergeser (candle_time = candle terakhir yang dievaluasi).
    expect(await repo.lastEventCandleTime({ symbol: 'BTCUSDT', timeframe: '5m' })).toBe(lastEvent);

    // Idempoten: tidak ada lagi yang terbuka. Setelah listing ulang, deteksi berikutnya membuka sinyal BARU.
    expect(await repo.closeOpenForSymbol({ symbol: 'BTCUSDT', reason: 'SYMBOL_DELISTED', at: AT + 1 })).toEqual({ closed: [] });
    const reopened = await drive(repo, [input(12, 103)]);
    expect(reopened.results[0].saved).toMatchObject({ opened: true });
    expect(reopened.results[0].saved.id).not.toBe(m5.results[0].saved.id);
    expect(db.prepare("SELECT COUNT(*) n FROM signal_events WHERE to_state = 'EXPIRED'").get().n).toBe(2);
  });

  it('UNIT-SREP-006 closeOpenForSymbol MONITORING_STOPPED dengan timeframes [1h] → hanya sinyal 1h ditutup; simbol tak dikenal → { closed: [] }', async () => {
    const { db, repo } = setup();
    await repo.ensurePatternDefinition(SA_V1);
    await drive(repo, [input(0, 100)]);
    await drive(repo, [input(0, 100, { timeframe: '1h' })], { timeframe: '1h' });
    const { closed } = await repo.closeOpenForSymbol({ symbol: 'BTCUSDT', timeframes: ['1h', '1h'], reason: 'MONITORING_STOPPED', at: T0 + 5 * TF_MS['1h'] });
    expect(closed).toEqual([{ id: expect.any(Number), timeframe: '1h', fromState: 'QUIET', price: null }]);
    expect(await repo.getOpen({ symbol: 'BTCUSDT', timeframe: '5m' })).not.toBeNull();
    const event = db.prepare("SELECT detail_json FROM signal_events WHERE to_state = 'EXPIRED'").get();
    expect(JSON.parse(event.detail_json)).toMatchObject({ reason: 'MONITORING_STOPPED', priceCandleTime: null });
    expect(await repo.closeOpenForSymbol({ symbol: 'SOLUSDT', reason: 'MONITORING_STOPPED', at: T0 })).toEqual({ closed: [] });
  });

  it('UNIT-SREP-007 listOpenSeries → pasangan simbol×timeframe bersinyal terbuka (tanpa duplikat, urut simbol lalu timeframe); sinyal terminal & yang ditutup closeOpenForSymbol tidak ikut; DB kosong → []', async () => {
    const { db, repo } = setup();
    expect(await repo.listOpenSeries()).toEqual([]);
    db.prepare(`INSERT INTO symbols (symbol, base_asset, quote_asset, contract_type, status, first_seen_at, last_seen_at)
      VALUES ('SOLUSDT', 'SOL', 'USDT', 'PERPETUAL', 'TRADING', 0, 0)`).run();
    await repo.ensurePatternDefinition(SA_V1);
    await drive(repo, LIFECYCLE, { symbol: 'SOLUSDT' }); // berakhir EXPIRED (terminal)
    await drive(repo, [input(0, 100)], { symbol: 'ETHUSDT' });
    await drive(repo, LIFECYCLE.slice(0, 4));
    await drive(repo, [input(0, 100, { timeframe: '1h' })], { timeframe: '1h' });
    expect(await repo.getOpen({ symbol: 'SOLUSDT', timeframe: '5m' })).toBeNull();
    expect(await repo.listOpenSeries()).toEqual([
      { symbol: 'BTCUSDT', timeframe: '1h' }, { symbol: 'BTCUSDT', timeframe: '5m' }, { symbol: 'ETHUSDT', timeframe: '5m' },
    ]);
    await repo.closeOpenForSymbol({ symbol: 'BTCUSDT', reason: 'MONITORING_STOPPED', at: T0 + 9 * TF_MS['5m'] });
    expect(await repo.listOpenSeries()).toEqual([{ symbol: 'ETHUSDT', timeframe: '5m' }]);
  });

  it('NEG-SREP-004 closeOpenForSymbol menolak reason di luar MONITORING_STOP_REASONS, waktu/timeframe/simbol tidak valid — tanpa perubahan', async () => {
    const { db, repo } = setup();
    await repo.ensurePatternDefinition(SA_V1);
    await drive(repo, [input(0, 100)]);
    const ok = { symbol: 'BTCUSDT', reason: 'SYMBOL_DELISTED', at: T0 };
    await expect(repo.closeOpenForSymbol({ ...ok, reason: 'NO_PROGRESS' })).rejects.toThrow(RangeError);
    await expect(repo.closeOpenForSymbol({ ...ok, at: 1.5 })).rejects.toThrow(TypeError);
    await expect(repo.closeOpenForSymbol({ ...ok, at: undefined })).rejects.toThrow(TypeError);
    await expect(repo.closeOpenForSymbol({ ...ok, timeframes: ['4h'] })).rejects.toThrow(RangeError);
    await expect(repo.closeOpenForSymbol({ ...ok, timeframes: '5m' })).rejects.toThrow(TypeError);
    await expect(repo.closeOpenForSymbol({ ...ok, symbol: "BTC'; DROP TABLE signals;--" })).rejects.toThrow(RangeError);
    expect(await repo.getOpen({ symbol: 'BTCUSDT', timeframe: '5m' })).not.toBeNull();
    expect(db.prepare('SELECT COUNT(*) n FROM signal_events').get().n).toBe(1);
  });

  it('EDGE-SREP-003 closeOpenForSymbol gagal di tengah (INSERT event sinyal kedua ditolak) → di-rollback seluruhnya', async () => {
    const { db, repo } = setup();
    await repo.ensurePatternDefinition(SA_V1);
    await drive(repo, [input(0, 100)]);
    await drive(repo, [input(0, 100, { timeframe: '1h' })], { timeframe: '1h' });
    db.exec(`CREATE TEMP TRIGGER fail_second_expire BEFORE INSERT ON signal_events
      WHEN NEW.to_state = 'EXPIRED' AND (SELECT COUNT(*) FROM signal_events WHERE to_state = 'EXPIRED') >= 1
      BEGIN SELECT RAISE(ABORT, 'gagal sintetis'); END`);
    await expect(repo.closeOpenForSymbol({ symbol: 'BTCUSDT', reason: 'SYMBOL_DELISTED', at: T0 })).rejects.toThrow(/gagal sintetis/);
    expect(db.prepare("SELECT COUNT(*) n FROM signals WHERE state = 'EXPIRED'").get().n).toBe(0);
    expect(db.prepare("SELECT COUNT(*) n FROM signal_events WHERE to_state = 'EXPIRED'").get().n).toBe(0);
    expect((await repo.listActive()).map((a) => a.timeframe).sort()).toEqual(['1h', '5m']);
  });

  it('UNIT-SREP-008 kursor analisis: markEvaluated hanya maju; save memajukannya dalam transaksi yang sama; lastEvaluatedCandleTime = max(kursor, event terakhir); bertahan setelah restart (file DB)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lr-cursor-'));
    tempDirs.push(dir);
    const path = join(dir, 'signals.db');
    const { db, repo } = setup(path);
    await repo.ensurePatternDefinition(SA_V1);
    const at = (i) => T0 + i * TF_MS['5m'];
    const cursorRow = () => db.prepare('SELECT last_open_time, updated_at FROM analysis_cursors').all();
    expect(await repo.lastEvaluatedCandleTime({ symbol: 'BTCUSDT', timeframe: '5m' })).toBeNull();

    // Candle tanpa sinyal (NO_PATTERN) → kursor maju; nilai lebih lama/sama diabaikan.
    expect(await repo.markEvaluated({ symbol: 'BTCUSDT', timeframe: '5m', openTime: at(3), now: at(4) - 1 })).toEqual({ advanced: true });
    expect(await repo.markEvaluated({ symbol: 'BTCUSDT', timeframe: '5m', openTime: at(2) })).toEqual({ advanced: false });
    expect(await repo.markEvaluated({ symbol: 'BTCUSDT', timeframe: '5m', openTime: at(3) })).toEqual({ advanced: false });
    expect(cursorRow()).toEqual([{ last_open_time: at(3), updated_at: at(4) - 1 }]);

    // save() sinyal di candle 5 memajukan kursor ke candle snapshot (atomik dengan sinyal + event).
    const opened = transition(null, input(5, 100));
    await repo.save({ symbol: 'BTCUSDT', timeframe: '5m', snapshot: opened.next, event: opened.event });
    expect(await repo.lastEvaluatedCandleTime({ symbol: 'BTCUSDT', timeframe: '5m' })).toBe(at(5));
    // Save yang gagal di tengah (event tidak dapat diserialisasi) tidak memajukan kursor.
    const next = transition(opened.next, input(6, 100.1, { sa: { earlyScore: 80 } }));
    await expect(repo.save({ symbol: 'BTCUSDT', timeframe: '5m', snapshot: next.next, event: { ...next.event, detail: { bad: 10n } } })).rejects.toThrow(TypeError);
    expect(cursorRow()).toEqual([{ last_open_time: at(5), updated_at: at(6) - 1 }]);

    // DB tanpa kursor (sebelum migrasi 004) → event terakhir tetap menjadi titik awal.
    db.prepare('DELETE FROM analysis_cursors').run();
    expect(await repo.lastEvaluatedCandleTime({ symbol: 'BTCUSDT', timeframe: '5m' })).toBe(at(5));
    await repo.markEvaluated({ symbol: 'BTCUSDT', timeframe: '5m', openTime: at(9) });
    db.close();

    const reopened = createSignalRepository(openDatabase(path), { clock: () => T0 });
    expect(await reopened.lastEvaluatedCandleTime({ symbol: 'BTCUSDT', timeframe: '5m' })).toBe(at(9));
    expect(await reopened.lastEvaluatedCandleTime({ symbol: 'BTCUSDT', timeframe: '1h' })).toBeNull();
    expect(await reopened.lastEvaluatedCandleTime({ symbol: 'XRPUSDT', timeframe: '5m' })).toBeNull();
    await expect(reopened.markEvaluated({ symbol: 'XRPUSDT', timeframe: '5m', openTime: at(1) })).rejects.toMatchObject({ code: 'UNKNOWN_SYMBOL' });
    await expect(reopened.markEvaluated({ symbol: 'BTCUSDT', timeframe: '4h', openTime: at(1) })).rejects.toThrow(RangeError);
    await expect(reopened.markEvaluated({ symbol: 'BTCUSDT', timeframe: '5m', openTime: 1.5 })).rejects.toThrow(TypeError);
  });

  it('UNIT-SREP-009 history (dengan & tanpa simbol) memakai indeks terurut: tanpa SCAN penuh + TEMP B-TREE; hasil terbaru dulu, simbol tak dikenal → []', async () => {
    const { db } = setup();
    // Tangkap SQL yang disiapkan repositori untuk query riwayat (ORDER BY first_detected_at DESC … LIMIT @limit).
    const prepared = [];
    const spy = new Proxy(db, { get: (target, key) => (key === 'prepare'
      ? (sql) => { prepared.push(sql); return target.prepare(sql); }
      : (typeof target[key] === 'function' ? target[key].bind(target) : target[key])) });
    const repo = createSignalRepository(spy, { clock: () => T0 });
    const historySql = prepared.filter((sql) => /ORDER BY s\.first_detected_at DESC, s\.id DESC\s+LIMIT @limit/.test(sql));
    expect(historySql.length).toBeGreaterThan(0);
    for (const sql of historySql) {
      const params = sql.includes('@symbol') ? { symbol: 'BTCUSDT', limit: 10 } : { limit: 10 };
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params).map((r) => r.detail);
      expect(plan.join(' | ')).not.toMatch(/TEMP B-TREE/);
      // Filter simbol = seek indeks per simbol, bukan memindai seluruh sinyal lalu menyaring.
      if (sql.includes('@symbol')) expect(plan.join(' | ')).toMatch(/SEARCH s USING INDEX idx_signals_symbol_first_detected/);
      else expect(plan.join(' | ')).toMatch(/SCAN s USING INDEX idx_signals_first_detected/);
    }

    await repo.ensurePatternDefinition(SA_V1);
    await drive(repo, [input(0, 100)], { symbol: 'ETHUSDT' });
    await drive(repo, [input(2, 100, { timeframe: '1h' })], { timeframe: '1h' });
    await drive(repo, [input(1, 100)]);
    const all = await repo.history({ limit: 10 });
    expect(all.map((h) => [h.symbol, h.timeframe])).toEqual([['BTCUSDT', '1h'], ['BTCUSDT', '5m'], ['ETHUSDT', '5m']]);
    expect((await repo.history({ symbol: 'BTCUSDT', limit: 1 })).map((h) => h.timeframe)).toEqual(['1h']);
    expect(await repo.history({ symbol: 'XRPUSDT' })).toEqual([]);
  });

  it('EDGE-SREP-002 simpan ulang snapshot yang sama idempoten; penjelasan dipertahankan bila tidak dikirim', async () => {
    const { db, repo } = setup();
    await repo.ensurePatternDefinition(SA_V1);
    const r = transition(null, input(0, 100));
    const explanation = [{ factor: 'PATTERN:SA:flat_range', contribution: 70, detail: 'Rentang sempit' }];
    await repo.save({ symbol: 'BTCUSDT', timeframe: '5m', snapshot: r.next, event: r.event, explanation });
    await repo.save({ symbol: 'BTCUSDT', timeframe: '5m', snapshot: r.next, event: null });
    await repo.save({ symbol: 'BTCUSDT', timeframe: '5m', snapshot: r.next, event: null });
    expect(db.prepare('SELECT COUNT(*) n FROM signal_events').get().n).toBe(1);
    const [active] = await repo.listActive();
    expect(active.explanation).toEqual(explanation);
    expect(active.updatedAt).toBe(r.next.lastEvaluatedAt);
  });
});
