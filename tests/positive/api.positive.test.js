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

  it('POS-SYS-002 status sistem berisi metrik nyata & komponen yang belum ada ditandai jujur', async () => {
    const res = (await ctx.app.inject({ url: '/api/system/status', headers: { cookie: auth.cookie } })).json();
    expect(res.database.status).toBe('ok');
    expect(res.database.schemaVersion).toBe(2);
    expect(res.memory.rssBytes).toBeGreaterThan(0);
    expect(res.binance.status).toBe('not_implemented');
    expect(res.scanner.status).toBe('not_implemented');
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
