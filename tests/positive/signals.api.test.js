import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SEED_SYMBOL, seedSignals } from '../helpers/signalSeed.js';
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
