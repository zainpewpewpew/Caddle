import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SEED_SYMBOL, seedSignalMatrix, seedSignals } from '../helpers/signalSeed.js';
import { createTestApp, login } from '../helpers/testApp.js';

describe('API sinyal — alur positif', () => {
  let ctx;
  let auth;
  beforeEach(async () => {
    ctx = await createTestApp();
    auth = await login(ctx.app);
  });
  afterEach(async () => { await ctx.app.close(); });

  const get = (url) => ctx.app.inject({ url, headers: { cookie: auth.cookie } });

  it('POS-SIG-001 database kosong → daftar kosong, bukan data contoh', async () => {
    expect((await get('/api/signals/active')).json()).toEqual({ items: [], count: 0 });
    expect((await get('/api/signals/history')).json()).toEqual({ items: [], count: 0 });
  });

  it('POS-SIG-002 sinyal dari pipeline tampil di daftar aktif dengan skor, penjelasan, dan harga terakhir', async () => {
    const { candles } = await seedSignals(ctx.app.services.repos);
    const res = await get('/api/signals/active');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    const { items, count } = res.json();
    expect(count).toBe(1);
    expect(items[0]).toMatchObject({ symbol: SEED_SYMBOL, timeframe: '5m', lastPrice: candles.at(-1).close, lastCandleAt: candles.at(-1).closeTime });
    expect(items[0].patternScore).toBeGreaterThanOrEqual(85);
    expect(items[0].explanation.length).toBeGreaterThan(0);
    expect(['QUIET', 'EARLY_BULLISH', 'MOMENTUM_BUILDING', 'BREAKOUT']).toContain(items[0].state);
  });

  it('POS-SIG-003 filter timeframe/klasifikasi/skor diterapkan di server', async () => {
    await seedSignals(ctx.app.services.repos);
    expect((await get('/api/signals/active?timeframe=1h')).json().count).toBe(0);
    expect((await get('/api/signals/active?timeframe=5m&minScore=85')).json().count).toBe(1);
    expect((await get('/api/signals/active?classification=PVA')).json().count).toBe(0);
    expect((await get('/api/signals/active?limit=1')).json().count).toBe(1);
  });

  it('POS-SIG-004 riwayat memuat transisi state berurutan, dapat difilter per simbol', async () => {
    await seedSignals(ctx.app.services.repos);
    const { items } = (await get(`/api/signals/history?symbol=${SEED_SYMBOL}`)).json();
    expect(items).toHaveLength(1);
    expect(items[0].events[0].fromState).toBe('NO_PATTERN');
    const times = items[0].events.map((e) => e.candleTime);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect((await get('/api/signals/history?symbol=BTCUSDT')).json().count).toBe(0);
  });

  it('POS-SIG-005 analyst (bukan admin) boleh membaca sinyal', async () => {
    const analyst = await login(ctx.app, { username: 'rekan', password: 'another-strong-pass-42' });
    const res = await ctx.app.inject({ url: '/api/signals/active', headers: { cookie: analyst.cookie } });
    expect(res.statusCode).toBe(200);
  });
});

// Matriks sinyal SINTETIS (tests/helpers/signalSeed.js SIGNAL_MATRIX): 6 sinyal aktif + 1 tertutup dengan skor,
// state, klasifikasi, alignment, dan timeframe berbeda, sehingga setiap filter benar-benar membedakan baris.
// Urutan server: patternScore DESC, updated_at DESC, id DESC → AAA 90, DDD 75 (lebih baru), CCC 75, BBB 60, GGG 50, EEE 45.
describe('API sinyal — filter & urutan atas matriks sinyal sintetis', () => {
  let ctx;
  let auth;
  beforeEach(async () => {
    ctx = await createTestApp();
    auth = await login(ctx.app);
    await seedSignalMatrix(ctx.app.services.repos);
  });
  afterEach(async () => { await ctx.app.close(); });

  const symbols = async (url) => {
    const res = await ctx.app.inject({ url, headers: { cookie: auth.cookie } });
    expect(res.statusCode).toBe(200);
    const { items, count } = res.json();
    expect(count).toBe(items.length);
    return items.map((s) => s.symbol);
  };

  it('POS-SIG-006 tanpa filter → 6 sinyal aktif urut patternScore lalu update terbaru; sinyal tertutup & harga tak dikenal tidak dikarang', async () => {
    const res = await ctx.app.inject({ url: '/api/signals/active', headers: { cookie: auth.cookie } });
    const { items, count } = res.json();
    expect(Object.keys(res.json()).sort()).toEqual(['count', 'items']);
    expect(count).toBe(6);
    expect(items.map((s) => [s.symbol, s.patternScore])).toEqual([
      ['AAAUSDT', 90], ['DDDUSDT', 75], ['CCCUSDT', 75], ['BBBUSDT', 60], ['GGGUSDT', 50], ['EEEUSDT', 45],
    ]);
    expect(items.map((s) => s.symbol)).not.toContain('FFFUSDT');
    // Tanpa candle tersimpan → harga terakhir tidak diketahui (null), bukan angka contoh.
    expect(items.every((s) => s.lastPrice === null && s.lastCandleAt === null)).toBe(true);
    expect(items.find((s) => s.symbol === 'EEEUSDT').alignment).toBeNull();
  });

  it.each([
    ['5m', ['AAAUSDT', 'DDDUSDT', 'EEEUSDT']],
    ['15m', ['BBBUSDT', 'GGGUSDT']],
    ['1h', ['CCCUSDT']],
  ])('POS-SIG-007 timeframe=%s → hanya sinyal timeframe itu %j', async (tf, expected) => {
    expect(await symbols(`/api/signals/active?timeframe=${tf}`)).toEqual(expected);
  });

  it.each([
    ['SA', ['AAAUSDT', 'GGGUSDT', 'EEEUSDT']],
    ['PVA', ['DDDUSDT', 'BBBUSDT']],
    ['BOTH', ['CCCUSDT']],
  ])('POS-SIG-008 classification=%s → hanya klasifikasi itu %j', async (cls, expected) => {
    expect(await symbols(`/api/signals/active?classification=${cls}`)).toEqual(expected);
  });

  it.each([
    ['QUIET', ['BBBUSDT', 'EEEUSDT']],
    ['EARLY_BULLISH', ['AAAUSDT', 'GGGUSDT']],
    ['MOMENTUM_BUILDING', ['CCCUSDT']],
    ['BREAKOUT', ['DDDUSDT']],
  ])('POS-SIG-009 state=%s → hanya sinyal pada tahap itu %j', async (state, expected) => {
    expect(await symbols(`/api/signals/active?state=${state}`)).toEqual(expected);
  });

  it.each([
    ['0', ['AAAUSDT', 'DDDUSDT', 'CCCUSDT', 'BBBUSDT', 'GGGUSDT', 'EEEUSDT']],
    ['75', ['AAAUSDT', 'DDDUSDT', 'CCCUSDT']],
    ['76', ['AAAUSDT']],
    ['100', []],
  ])('POS-SIG-010 minScore=%s → hanya patternScore ≥ batas (inklusif) %j', async (min, expected) => {
    expect(await symbols(`/api/signals/active?minScore=${min}`)).toEqual(expected);
  });

  it.each([
    ['limit=1', ['AAAUSDT']],
    ['limit=3', ['AAAUSDT', 'DDDUSDT', 'CCCUSDT']],
    ['timeframe=5m&minScore=50&limit=1', ['AAAUSDT']],
    ['timeframe=5m&state=QUIET', ['EEEUSDT']],
    ['classification=SA&state=EARLY_BULLISH&minScore=60', ['AAAUSDT']],
  ])('POS-SIG-011 %s → limit memotong setelah urutan & filter digabung (AND) %j', async (qs, expected) => {
    expect(await symbols(`/api/signals/active?${qs}`)).toEqual(expected);
  });

  it.each(['1', '9', '10', '99', '100', '499', '500'])('POS-SIG-013 limit=%s (batas 1–500) diterima untuk daftar aktif & riwayat', async (limit) => {
    const n = Number(limit);
    expect(await symbols(`/api/signals/active?limit=${limit}`)).toHaveLength(Math.min(n, 6));
    expect(await symbols(`/api/signals/history?limit=${limit}`)).toHaveLength(Math.min(n, 7));
  });

  it('POS-SIG-012 riwayat memuat sinyal tertutup, urut deteksi terbaru, limit & simbol membedakan baris', async () => {
    expect(await symbols('/api/signals/history')).toEqual(
      ['FFFUSDT', 'GGGUSDT', 'EEEUSDT', 'DDDUSDT', 'CCCUSDT', 'BBBUSDT', 'AAAUSDT'],
    );
    expect(await symbols('/api/signals/history?limit=2')).toEqual(['FFFUSDT', 'GGGUSDT']);
    const res = await ctx.app.inject({ url: '/api/signals/history?symbol=FFFUSDT', headers: { cookie: auth.cookie } });
    const { items } = res.json();
    expect(items.map((s) => s.state)).toEqual(['INVALIDATED']);
    expect(items[0].events.map((e) => [e.fromState, e.toState])).toEqual([['NO_PATTERN', 'QUIET'], ['QUIET', 'INVALIDATED']]);
  });
});
