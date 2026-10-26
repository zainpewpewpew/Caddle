import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../../backend/app/config.js';
import { parseSmartMoneyConfig } from '../../../backend/smartmoney/config.js';

describe('konfigurasi smart money', () => {
  it('UNIT-SM-CFG-001 default: tanpa provider, 15 menit, basi 60 menit, 50 wallet; objek beku', () => {
    const c = parseSmartMoneyConfig({});
    expect(c).toEqual({ providers: [], syncIntervalMinutes: 15, staleAfterMinutes: 60, maxWalletsPerSync: 50 });
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.providers)).toBe(true);
  });

  it('UNIT-SM-CFG-002 daftar provider dipisah koma: spasi & duplikat dibuang, urutan dipertahankan', () => {
    expect(parseSmartMoneyConfig({ SMART_MONEY_PROVIDERS: ' blockscout, dexscreener ,,blockscout' }).providers).toEqual(['blockscout', 'dexscreener']);
    expect(parseSmartMoneyConfig({ SMART_MONEY_SYNC_MINUTES: '5', SMART_MONEY_MAX_WALLETS: '500', SMART_MONEY_STALE_MINUTES: '' }))
      .toMatchObject({ syncIntervalMinutes: 5, maxWalletsPerSync: 500, staleAfterMinutes: 60 });
  });

  it.each([
    ['SMART_MONEY_SYNC_MINUTES', '4'],
    ['SMART_MONEY_SYNC_MINUTES', '1441'],
    ['SMART_MONEY_SYNC_MINUTES', '1.5'],
    ['SMART_MONEY_MAX_WALLETS', '0'],
    ['SMART_MONEY_MAX_WALLETS', '501'],
    ['SMART_MONEY_STALE_MINUTES', 'abc'],
    ['SMART_MONEY_PROVIDERS', 'Block Scout'],
  ])('NEG-SM-CFG-001 %s=%s ditolak dengan ConfigError', (name, value) => {
    expect(() => parseSmartMoneyConfig({ [name]: value })).toThrow(ConfigError);
  });

  it('NEG-SM-CFG-002 provider fixture (data simulasi) ditolak di produksi, diterima di test', () => {
    expect(() => parseSmartMoneyConfig({ NODE_ENV: 'production', SMART_MONEY_PROVIDERS: 'fixture' })).toThrow(/produksi/);
    expect(parseSmartMoneyConfig({ NODE_ENV: 'test', SMART_MONEY_PROVIDERS: 'fixture' }).providers).toEqual(['fixture']);
  });

  it('UNIT-SM-CFG-003 loadConfig memuat field smartMoney tanpa mengubah field lain', () => {
    const c = loadConfig({ SMART_MONEY_PROVIDERS: 'blockscout' });
    expect(c.smartMoney.providers).toEqual(['blockscout']);
    expect(c.port).toBe(8080);
    expect(() => loadConfig({ SMART_MONEY_SYNC_MINUTES: '0' })).toThrow(ConfigError);
  });
});
