import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_SETTINGS } from '../../backend/settings/scannerSettings.js';
import { createTestApp, login } from '../helpers/testApp.js';

describe('alur positif API', () => {
  let ctx;
  let auth;
  beforeEach(async () => {
    ctx = await createTestApp();
    auth = await login(ctx.app);
  });
  afterEach(async () => { await ctx.app.close(); });

  const put = (body, a = auth) => ctx.app.inject({
    method: 'PUT', url: '/api/settings/scanner', headers: { cookie: a.cookie, 'x-csrf-token': a.csrfToken }, payload: body,
  });

  it('POS-SYS-001 health & ready publik', async () => {
    expect((await ctx.app.inject({ url: '/api/health' })).json()).toEqual({ status: 'ok' });
    expect((await ctx.app.inject({ url: '/api/ready' })).json()).toEqual({ status: 'ready' });
  });

  it('POS-SYS-002 status sistem berisi metrik nyata; worker yang belum pernah berjalan dilaporkan jujur', async () => {
    const res = (await ctx.app.inject({ url: '/api/system/status', headers: { cookie: auth.cookie } })).json();
    expect(res.database.status).toBe('ok');
    expect(res.database.schemaVersion).toBe(4);
    expect(res.memory.rssBytes).toBeGreaterThan(0);
    expect(res.scanner).toEqual({ status: 'not_running', heartbeatAt: null });
    expect(res.binance).toEqual({ status: 'unknown', ws: null });
    expect(res.ingestion).toEqual({ lastRun: null, recentErrors: [] });
  });

  it('POS-SYS-005 heartbeat worker di database tampil di status sistem & overview; heartbeat basi → stale', async () => {
    const { ingestion } = ctx.app.services.repos;
    const metrics = { state: 'running', symbols: 40, streams: 120, staleStreams: 0, lastIngestionAt: ctx.clock() - 5_000,
      candleLagMs: 4_000, scanDurationMs: 1_200, queue: 0, reconnects: 1, errors: 2, ws: 'open', gaps: 0, duplicates: 3 };
    await ingestion.heartbeat({ at: ctx.clock(), state: metrics });
    await ingestion.recordError({ at: ctx.clock(), source: 'ws', message: 'koneksi ditutup' });
    const status = (await ctx.app.inject({ url: '/api/system/status', headers: { cookie: auth.cookie } })).json();
    expect(status.scanner).toMatchObject({ status: 'ok', phase: 'running', symbols: 40, streams: 120, candleLagMs: 4_000, errors: 2 });
    expect(status.binance).toEqual({ status: 'ok', ws: 'open' });
    expect(status.ingestion.recentErrors[0]).toMatchObject({ source: 'ws', message: 'koneksi ditutup' });
    const overview = (await ctx.app.inject({ url: '/api/overview', headers: { cookie: auth.cookie } })).json();
    expect(overview.scanner.status).toBe('ok');
    expect(overview.lastIngestionAt).toBe(metrics.lastIngestionAt);

    ctx.clock.advance(120_000);
    const later = (await ctx.app.inject({ url: '/api/system/status', headers: { cookie: auth.cookie } })).json();
    expect(later.scanner.status).toBe('stale');
    expect(later.scanner.candleLagMs).toBeNull();
    expect(later.binance.status).toBe('unknown');
  });

  it('POS-SYS-003 overview menghitung dari database (kosong → nol)', async () => {
    const res = (await ctx.app.inject({ url: '/api/overview', headers: { cookie: auth.cookie } })).json();
    expect(res).toMatchObject({ monitoredSymbols: 0, activeSignals: 0, earlySignals: 0, lastIngestionAt: null, recentDetections: [] });
  });

  it('POS-SYS-004 overview mencerminkan baris nyata di database', async () => {
    ctx.db.prepare(`INSERT INTO symbols (symbol, base_asset, quote_asset, contract_type, status, is_monitored, first_seen_at, last_seen_at)
                    VALUES ('ETHUSDT', 'ETH', 'USDT', 'PERPETUAL', 'TRADING', 1, 0, 0)`).run();
    const res = (await ctx.app.inject({ url: '/api/overview', headers: { cookie: auth.cookie } })).json();
    expect(res.monitoredSymbols).toBe(1);
  });

  it('POS-SYS-006 konteks pasar BTC/ETH dari candle 1h tersimpan; simbol tanpa data → no_data (bukan angka contoh)', async () => {
    const { repos } = ctx.app.services;
    await repos.symbols.upsertFromExchange([{ symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', contractType: 'PERPETUAL',
      status: 'TRADING', tickSize: '0.10', stepSize: '0.001', onboardDate: 0 }], ctx.clock());
    // Seri 1h SINTETIS yang naik teratur (bukan data pasar nyata).
    const H = 3_600_000;
    const start = Date.UTC(2025, 11, 20);
    const candles = Array.from({ length: 60 }, (_, i) => {
      const close = 100 + i + (i % 3 === 0 ? -0.5 : 0.5);
      return { symbol: 'BTCUSDT', timeframe: '1h', openTime: start + i * H, closeTime: start + (i + 1) * H - 1,
        open: close - 0.4, high: close + 0.6, low: close - 0.9, close, volume: 10, quoteVolume: 10 * close,
        trades: 5, takerBuyVolume: 5, takerBuyQuoteVolume: 5 * close, isClosed: true, source: 'rest' };
    });
    await repos.candles.upsertClosed(candles, { now: ctx.clock() });
    const { marketContext } = (await ctx.app.inject({ url: '/api/overview', headers: { cookie: auth.cookie } })).json();
    expect(marketContext[0]).toMatchObject({ symbol: 'BTCUSDT', status: 'ok', timeframe: '1h', lastPrice: candles.at(-1).close, asOf: candles.at(-1).closeTime, trend: 'BULLISH' });
    expect(marketContext[0].change24h).toBeCloseTo(candles.at(-1).close / candles.at(-25).close - 1, 10);
    expect(marketContext[1]).toEqual({ symbol: 'ETHUSDT', status: 'no_data' });
  });

  it('POS-SET-001 pengaturan default dikembalikan sebelum pernah disimpan', async () => {
    const res = (await ctx.app.inject({ url: '/api/settings/scanner', headers: { cookie: auth.cookie } })).json();
    expect(res).toMatchObject({ version: 0, isDefault: true, settings: DEFAULT_SCANNER_SETTINGS });
  });

  it('POS-SET-002 admin menyimpan pengaturan valid → versi naik, persisten, tercatat audit', async () => {
    const settings = structuredClone(DEFAULT_SCANNER_SETTINGS);
    settings.symbols = { mode: 'manual', maxAuto: 40, manual: ['BTCUSDT', 'ETHUSDT'] };
    settings.timeframes = ['1h', '15m'];
    const res = await put({ version: 0, settings });
    expect(res.statusCode).toBe(200);
    expect(res.json().version).toBe(1);
    expect(res.json().settings.timeframes).toEqual(['15m', '1h']);

    const again = await put({ version: 1, settings });
    expect(again.json().version).toBe(2);

    const read = (await ctx.app.inject({ url: '/api/settings/scanner', headers: { cookie: auth.cookie } })).json();
    expect(read.settings.symbols.manual).toEqual(['BTCUSDT', 'ETHUSDT']);
    const audit = await ctx.app.services.repos.audit.recent();
    expect(audit.filter((a) => a.action === 'settings.scanner.update')).toHaveLength(2);
  });

  it('POS-SET-003 analyst dapat membaca pengaturan', async () => {
    const analyst = await login(ctx.app, { username: 'rekan', password: 'another-strong-pass-42' });
    const res = await ctx.app.inject({ url: '/api/settings/scanner', headers: { cookie: analyst.cookie } });
    expect(res.statusCode).toBe(200);
  });
});
