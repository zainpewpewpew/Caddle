import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SENSITIVITY_FILTERS } from '../../backend/reversal/constants.js';
import { REVERSAL_SEED_T0, seedReversalCandidates } from '../helpers/reversalSeed.js';
import { createTestApp, login } from '../helpers/testApp.js';

// API Reversal Radar (docs/19 §7) di atas matriks kandidat SINTETIS tests/helpers/reversalSeed.js:
// AAA 5m EARLY 54/9 LIQUID · BBB 15m DEVELOPING 70/11 LIQUID · CCC 1h CONFIRMED 88/15 THIN extended ·
// DDD 15m CANCELLED (riwayat saja) · EEE 5m provisional-only EARLY 48/7 · FFF 15m EARLY 23/4 ILLIQUID + provisional DEVELOPING.
const H1 = 3_600_000;
const symbols = (res) => res.json().items.map((i) => i.symbol);

describe('API Reversal Radar — alur positif', () => {
  let ctx;
  let auth;
  let repos;
  beforeEach(async () => {
    ctx = await createTestApp();
    auth = await login(ctx.app);
    repos = ctx.app.services.repos;
  });
  afterEach(async () => { await ctx.app.close(); });

  const get = (url) => ctx.app.inject({ url, headers: { cookie: auth.cookie } });
  const lastCandle = async (symbol, timeframe) => (await repos.candles.getLatest({ symbol, timeframe, limit: 1 }))[0];

  it('POS-RR-001 database kosong → daftar kosong dengan meta (timeframe, sensitivitas default HIGH, filter sensitivitas), bukan data contoh', async () => {
    const res = await get('/api/reversal/candidates');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.json()).toEqual({
      items: [], count: 0,
      meta: {
        timeframes: ['5m', '15m', '1h'], sensitivity: 'HIGH',
        filters: { LOW: { minScore: 60, minEvidence: 4 }, MEDIUM: { minScore: 45, minEvidence: 3 }, HIGH: { minScore: 0, minEvidence: 0 } },
      },
    });
    expect(res.json().meta.filters).toEqual(SENSITIVITY_FILTERS);
    expect((await get('/api/reversal/history')).json()).toEqual({ items: [], count: 0 });
  });

  it('POS-RR-002 kandidat aktif: urut skor turun, kandidat batal tidak tampil, kolom provisional/provisional-only/candleStatus, harga terakhir dari candle tersimpan', async () => {
    const { ids } = await seedReversalCandidates(repos);
    const res = await get('/api/reversal/candidates');
    expect(res.statusCode).toBe(200);
    const { items, count, meta } = res.json();
    expect(count).toBe(5);
    expect(meta.sensitivity).toBe('HIGH');
    expect(items.map((i) => [i.symbol, i.timeframe, i.score, i.stage, i.status, i.candleStatus, i.provisionalOnly])).toEqual([
      ['CCCUSDT', '1h', 88, 'CONFIRMED_BREAKOUT', 'CONFIRMED', 'CLOSED', false],
      ['BBBUSDT', '15m', 70, 'DEVELOPING_REVERSAL', 'DEVELOPING', 'CLOSED', false],
      ['AAAUSDT', '5m', 54, 'EARLY_FORMATION', 'NEW', 'CLOSED', false],
      ['EEEUSDT', '5m', 48, 'EARLY_FORMATION', 'NEW', 'RUNNING', true],
      ['FFFUSDT', '15m', 23, 'EARLY_FORMATION', 'NEW', 'RUNNING', false],
    ]);
    expect(items.map((i) => i.symbol)).not.toContain('DDDUSDT');

    const aaa = items.find((i) => i.symbol === 'AAAUSDT');
    const aaaCandle = await lastCandle('AAAUSDT', '5m');
    expect(aaa).toMatchObject({
      id: ids.AAAUSDT, version: 1, setupType: 'ROUNDED_BOTTOM', evidenceCount: 9, liquidityClass: 'LIQUID', extended: false, risks: [],
      firstDetectedAt: REVERSAL_SEED_T0 + H1 + 5 * 60_000 - 1, firstDetectedPrice: 100, provisional: null, closeReason: null, closedAt: null,
      lastPrice: aaaCandle.close, lastCandleAt: aaaCandle.closeTime,
    });
    expect(aaa.evidence).toHaveLength(9);
    expect(aaa.evidence[0]).toEqual({ id: 'LL_SHALLOWER', group: 'EXHAUSTION', label: 'Lower low makin dangkal', detail: expect.any(String), time: expect.any(Number), price: expect.any(Number) });
    expect(aaa.scoreComponents.map((c) => c.id)).toEqual(['EXHAUSTION', 'BASE', 'STRUCTURE', 'VOLUME', 'TRIGGER']);
    expect(aaa.levels).toMatchObject({ invalidation: expect.any(Number), trigger: expect.any(Number) });
    expect(aaa.nextConfirmation).toMatchObject({ kind: 'HIGHER_LOW', text: expect.any(String) });
    expect(aaa.cancelCondition).toMatchObject({ text: expect.any(String) });
    expect(Array.isArray(aaa.markers)).toBe(true);

    const ccc = items.find((i) => i.symbol === 'CCCUSDT');
    expect(ccc).toMatchObject({ id: ids.CCCUSDT, setupType: 'STAIRCASE', liquidityClass: 'THIN', extended: true, risks: ['LOW_LIQUIDITY', 'EXTENDED'], moveSinceDetectionPct: 0.09, moveSinceDetectionAtr: 2.7 });

    // Provisional-only: belum ada kandidat (id null), status mengikuti tahap provisional, tanpa harga deteksi.
    const eee = items.find((i) => i.symbol === 'EEEUSDT');
    const eeeCandle = await lastCandle('EEEUSDT', '5m');
    expect(eee).toMatchObject({ id: null, provisionalOnly: true, candleStatus: 'RUNNING', score: 48, evidenceCount: 7, liquidityClass: 'LIQUID', firstDetectedAt: null, lastPrice: eeeCandle.close, lastCandleAt: eeeCandle.closeTime });
    expect(eee.provisional).toMatchObject({ stage: 'EARLY_FORMATION', score: 48, evidenceCount: 7, candleOpenTime: eeeCandle.closeTime + 1 });
    expect(eee.provisional.evidence).toHaveLength(7);

    // Kandidat terbuka + evaluasi candle berjalan: kolom provisional terisi, tahap kandidat tidak berubah.
    const fff = items.find((i) => i.symbol === 'FFFUSDT');
    expect(fff).toMatchObject({ id: ids.FFFUSDT, stage: 'EARLY_FORMATION', liquidityClass: 'ILLIQUID', candleStatus: 'RUNNING' });
    expect(fff.provisional).toMatchObject({ stage: 'DEVELOPING_REVERSAL', evidenceCount: 5, risks: ['PROVISIONAL'] });
  });

  it('POS-RR-003 sensitivitas (filter tampilan) diterapkan di server sebelum limit; minScore eksplisit menang atas minScore sensitivitas, minEvidence tetap', async () => {
    await seedReversalCandidates(repos);
    const low = await get('/api/reversal/candidates?sensitivity=LOW');
    expect(symbols(low)).toEqual(['CCCUSDT', 'BBBUSDT']);
    expect(low.json().meta.sensitivity).toBe('LOW');
    expect(symbols(await get('/api/reversal/candidates?sensitivity=MEDIUM'))).toEqual(['CCCUSDT', 'BBBUSDT', 'AAAUSDT', 'EEEUSDT']);
    expect(symbols(await get('/api/reversal/candidates?sensitivity=HIGH'))).toEqual(['CCCUSDT', 'BBBUSDT', 'AAAUSDT', 'EEEUSDT', 'FFFUSDT']);
    expect(symbols(await get('/api/reversal/candidates?sensitivity=LOW&minScore=50'))).toEqual(['CCCUSDT', 'BBBUSDT', 'AAAUSDT']);
    expect(symbols(await get('/api/reversal/candidates?minScore=60'))).toEqual(['CCCUSDT', 'BBBUSDT']);
    // limit setelah filter: dua teratas yang LOLOS filter, bukan dua teratas keseluruhan lalu disaring.
    expect(symbols(await get('/api/reversal/candidates?sensitivity=MEDIUM&limit=3'))).toEqual(['CCCUSDT', 'BBBUSDT', 'AAAUSDT']);
    expect((await get('/api/reversal/candidates?sensitivity=LOW&limit=1')).json().count).toBe(1);
  });

  it('POS-RR-004 filter timeframe/stage/status/liquidity/includeExtended/includeProvisional/limit diterapkan di server', async () => {
    await seedReversalCandidates(repos);
    const q = async (query) => symbols(await get(`/api/reversal/candidates?${query}`));
    expect(await q('timeframe=5m')).toEqual(['AAAUSDT', 'EEEUSDT']);
    expect(await q('timeframe=1h')).toEqual(['CCCUSDT']);
    expect(await q('stage=DEVELOPING_REVERSAL')).toEqual(['BBBUSDT']);
    expect(await q('stage=EARLY_FORMATION')).toEqual(['AAAUSDT', 'EEEUSDT', 'FFFUSDT']);
    expect(await q('status=NEW')).toEqual(['AAAUSDT', 'EEEUSDT', 'FFFUSDT']);
    expect(await q('status=CONFIRMED')).toEqual(['CCCUSDT']);
    expect(await q('liquidity=LIQUID')).toEqual(['BBBUSDT', 'AAAUSDT', 'EEEUSDT']);
    expect(await q('liquidity=THIN')).toEqual(['CCCUSDT', 'BBBUSDT', 'AAAUSDT', 'EEEUSDT']);
    expect(await q('includeExtended=0')).toEqual(['BBBUSDT', 'AAAUSDT', 'EEEUSDT', 'FFFUSDT']);
    expect(await q('includeExtended=1')).toEqual(['CCCUSDT', 'BBBUSDT', 'AAAUSDT', 'EEEUSDT', 'FFFUSDT']);
    const noProvisional = (await get('/api/reversal/candidates?includeProvisional=0')).json().items;
    expect(noProvisional.map((i) => i.symbol)).toEqual(['CCCUSDT', 'BBBUSDT', 'AAAUSDT', 'FFFUSDT']);
    expect(noProvisional.find((i) => i.symbol === 'FFFUSDT')).toMatchObject({ provisional: null, candleStatus: 'CLOSED' });
    expect(await q('limit=2')).toEqual(['CCCUSDT', 'BBBUSDT']);
    expect(await q('liquidity=LIQUID&limit=1')).toEqual(['BBBUSDT']);
    expect(await q('timeframe=15m&status=NEW&includeProvisional=0')).toEqual(['FFFUSDT']);
    expect(await q('timeframe=1h&liquidity=LIQUID')).toEqual([]);
  });

  it('POS-RR-005 riwayat: kandidat terbuka & tertutup (deteksi pertama terbaru dulu) lengkap dengan event berurutan (provisional ditandai), filter simbol/timeframe/limit', async () => {
    const { ids } = await seedReversalCandidates(repos);
    const res = await get('/api/reversal/history');
    expect(res.statusCode).toBe(200);
    const { items, count } = res.json();
    expect(count).toBe(5);
    expect(items.map((i) => [i.symbol, i.status])).toEqual([
      ['FFFUSDT', 'NEW'], ['DDDUSDT', 'CANCELLED'], ['CCCUSDT', 'CONFIRMED'], ['BBBUSDT', 'DEVELOPING'], ['AAAUSDT', 'NEW'],
    ]);
    const ddd = items.find((i) => i.symbol === 'DDDUSDT');
    expect(ddd).toMatchObject({ id: ids.DDDUSDT, closeReason: 'CLOSE_BELOW_INVALIDATION', closedAt: expect.any(Number), provisional: null, candleStatus: 'CLOSED' });
    expect(ddd.events.map((e) => [e.type, e.fromStage, e.toStage, e.fromStatus, e.toStatus, e.provisional])).toEqual([
      ['OPENED', null, 'EARLY_FORMATION', 'NONE', 'NEW', false],
      ['CANCELLED', 'EARLY_FORMATION', 'EARLY_FORMATION', 'NEW', 'CANCELLED', false],
    ]);
    expect(ddd.events[1].detail).toMatchObject({ reason: 'CLOSE_BELOW_INVALIDATION' });
    const fff = items.find((i) => i.symbol === 'FFFUSDT');
    expect(fff.events.map((e) => [e.type, e.provisional, e.toStage])).toEqual([['OPENED', false, 'EARLY_FORMATION'], ['PROVISIONAL_STAGE', true, 'DEVELOPING_REVERSAL']]);
    for (const item of items) {
      const times = item.events.map((e) => e.occurredAt);
      expect(times).toEqual([...times].sort((a, b) => a - b));
      expect(item.lastPrice).toBeUndefined(); // riwayat tanpa harga terakhir (hanya daftar aktif & detail)
    }
    expect(symbols(await get('/api/reversal/history?symbol=DDDUSDT'))).toEqual(['DDDUSDT']);
    expect(symbols(await get('/api/reversal/history?symbol=EEEUSDT'))).toEqual([]); // provisional-only bukan kandidat
    expect(symbols(await get('/api/reversal/history?timeframe=15m'))).toEqual(['FFFUSDT', 'DDDUSDT', 'BBBUSDT']);
    expect(symbols(await get('/api/reversal/history?symbol=BBBUSDT&timeframe=5m'))).toEqual([]);
    expect(symbols(await get('/api/reversal/history?limit=2'))).toEqual(['FFFUSDT', 'DDDUSDT']);
  });

  it('POS-RR-006 detail kandidat per id: item + events + harga terakhir; analyst (bukan admin) boleh membaca', async () => {
    const { ids } = await seedReversalCandidates(repos);
    const res = await get(`/api/reversal/candidates/${ids.CCCUSDT}`);
    expect(res.statusCode).toBe(200);
    const item = res.json();
    const candle = await lastCandle('CCCUSDT', '1h');
    expect(item).toMatchObject({ id: ids.CCCUSDT, symbol: 'CCCUSDT', timeframe: '1h', stage: 'CONFIRMED_BREAKOUT', status: 'CONFIRMED', lastPrice: candle.close, lastCandleAt: candle.closeTime });
    expect(item.events.map((e) => [e.type, e.fromStage, e.toStage])).toEqual([
      ['OPENED', null, 'DEVELOPING_REVERSAL'], ['STAGE_UP', 'DEVELOPING_REVERSAL', 'CONFIRMED_BREAKOUT'],
    ]);
    expect(item.events[0]).toMatchObject({ id: expect.any(Number), candleTime: expect.any(Number), occurredAt: expect.any(Number), price: expect.any(Number), provisional: false, detail: expect.any(Object) });
    // Kandidat tertutup pun dapat dibaca lewat id.
    expect((await get(`/api/reversal/candidates/${ids.DDDUSDT}`)).json()).toMatchObject({ symbol: 'DDDUSDT', status: 'CANCELLED', provisional: null });

    const analyst = await login(ctx.app, { username: 'rekan', password: 'another-strong-pass-42' });
    for (const url of ['/api/reversal/candidates', '/api/reversal/history', `/api/reversal/candidates/${ids.AAAUSDT}`]) {
      const r = await ctx.app.inject({ url, headers: { cookie: analyst.cookie } });
      expect(r.statusCode).toBe(200);
    }
  });

  it('POS-RR-007 tanpa candle tersimpan: lastPrice/lastCandleAt null (tidak dikarang)', async () => {
    const { ids } = await seedReversalCandidates(repos, { withCandles: false });
    const { items } = (await get('/api/reversal/candidates')).json();
    expect(items.map((i) => [i.lastPrice, i.lastCandleAt])).toEqual(items.map(() => [null, null]));
    expect((await get(`/api/reversal/candidates/${ids.BBBUSDT}`)).json()).toMatchObject({ lastPrice: null, lastCandleAt: null });
  });
});
