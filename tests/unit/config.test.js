import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../backend/app/config.js';

describe('konfigurasi environment', () => {
  it('UNIT-CFG-001 default pengembangan valid dan cookie non-Secure untuk origin http', () => {
    const c = loadConfig({});
    expect(c.nodeEnv).toBe('development');
    expect(c.port).toBe(8080);
    expect(c.cookieSecure).toBe(false);
    expect(c.session.idleMs).toBe(30 * 60_000);
    expect(c.maxUsers).toBe(2);
  });

  it('UNIT-CFG-002 COOKIE_SECURE=auto menjadi true untuk origin https', () => {
    expect(loadConfig({ APP_ORIGIN: 'https://radar.local' }).cookieSecure).toBe(true);
  });

  it('NEG-CFG-001 produksi tanpa APP_ORIGIN ditolak', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', DATABASE_PATH: '/data/x.db' })).toThrow(ConfigError);
  });

  it('NEG-CFG-002 produksi tanpa DATABASE_PATH ditolak', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', APP_ORIGIN: 'https://radar.local' })).toThrow(/DATABASE_PATH/);
  });

  it('NEG-CFG-003 produksi dengan origin http ditolak', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', APP_ORIGIN: 'http://radar.local', DATABASE_PATH: '/d.db' })).toThrow(/https/);
  });

  it('NEG-CFG-004 produksi dengan COOKIE_SECURE=false ditolak', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', APP_ORIGIN: 'https://r.local', DATABASE_PATH: '/d.db', COOKIE_SECURE: 'false' })).toThrow(ConfigError);
  });

  it.each([
    ['PORT', 'abc'], ['PORT', '0'], ['PORT', '70000'], ['NODE_ENV', 'staging'], ['LOG_LEVEL', 'verbose'],
    ['TRUST_PROXY', 'yes'], ['TRUST_PROXY', 'true'], ['TRUST_PROXY', '1'], ['TRUST_PROXY', '0'],
    ['TRUST_PROXY', '10.0.0.0/33'], ['TRUST_PROXY', 'proxy.local'], ['TRUST_PROXY', '127.0.0.1,'], ['APP_ORIGIN', 'notaurl'], ['APP_ORIGIN', 'ftp://x.local'], ['APP_ORIGIN', 'https://x.local/path'],
    ['APP_ORIGIN', 'https://user:pw@x.local'], ['SESSION_IDLE_MINUTES', '-5'], ['MAX_USERS', '0'],
  ])('NEG-CFG-005 nilai tidak valid %s=%s ditolak', (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(ConfigError);
  });

  it('UNIT-CFG-004 TRUST_PROXY menerima daftar IP/CIDR/kata kunci proxy, bukan true atau jumlah hop', () => {
    expect(loadConfig({}).trustProxy).toBe(false);
    expect(loadConfig({ TRUST_PROXY: '127.0.0.1, ::1, 10.0.0.0/8' }).trustProxy).toEqual(['127.0.0.1', '::1', '10.0.0.0/8']);
    expect(loadConfig({ TRUST_PROXY: 'loopback' }).trustProxy).toEqual(['loopback']);
  });

  it('EDGE-CFG-001 nilai env berisi spasi saja memakai default; produksi menolak path kosong & :memory:', () => {
    expect(loadConfig({ HOST: '   ' }).host).toBe('127.0.0.1');
    expect(() => loadConfig({ NODE_ENV: 'production', APP_ORIGIN: 'https://r.local', DATABASE_PATH: '  ' })).toThrow(/DATABASE_PATH/);
    expect(() => loadConfig({ NODE_ENV: 'production', APP_ORIGIN: 'https://r.local', DATABASE_PATH: ':memory:' })).toThrow(/memory/);
  });

  it('UNIT-CFG-003 produksi lengkap diterima dan bersifat immutable', () => {
    const c = loadConfig({ NODE_ENV: 'production', APP_ORIGIN: 'https://radar.local', DATABASE_PATH: '/data/lr.db' });
    expect(c.isProduction).toBe(true);
    expect(c.cookieSecure).toBe(true);
    expect(Object.isFrozen(c)).toBe(true);
  });
});
