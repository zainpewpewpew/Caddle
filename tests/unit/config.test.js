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
    expect(c.databasePath).toBe('./data/alphalens.db');
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

describe('konfigurasi DEFAULT_USER (akun default prototipe)', () => {
  const PROD = { NODE_ENV: 'production', APP_ORIGIN: 'https://radar.local', DATABASE_PATH: '/data/lr.db' };

  it('UNIT-CFG-005 tanpa DEFAULT_USER: aktif hanya di development', () => {
    expect(loadConfig({}).defaultUser).toBe(true);
    expect(loadConfig({ DEFAULT_USER: '   ' }).defaultUser).toBe(true);
    expect(loadConfig({ NODE_ENV: 'test' }).defaultUser).toBe(false);
    expect(loadConfig(PROD).defaultUser).toBe(false);
  });

  it('UNIT-CFG-006 DEFAULT_USER eksplisit true/false dihormati di luar produksi', () => {
    expect(loadConfig({ DEFAULT_USER: 'false' }).defaultUser).toBe(false);
    expect(loadConfig({ NODE_ENV: 'test', DEFAULT_USER: 'true' }).defaultUser).toBe(true);
    expect(loadConfig({ ...PROD, DEFAULT_USER: 'false' }).defaultUser).toBe(false);
  });

  it('NEG-CFG-006 DEFAULT_USER=true di produksi ditolak (fail fast)', () => {
    expect(() => loadConfig({ ...PROD, DEFAULT_USER: 'true' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...PROD, DEFAULT_USER: 'true' })).toThrow(/DEFAULT_USER=true tidak diizinkan di produksi/);
  });

  it.each(['yes', '1', 'TRUE', 'on'])('NEG-CFG-007 DEFAULT_USER=%s tidak valid ditolak', (value) => {
    expect(() => loadConfig({ DEFAULT_USER: value })).toThrow(/DEFAULT_USER harus 'true' atau 'false'/);
  });
});

describe('konfigurasi WORKER_CONTROL & WORKER_AUTOSTART (tombol scanner di website)', () => {
  const PROD = { NODE_ENV: 'production', APP_ORIGIN: 'https://radar.local', DATABASE_PATH: '/data/lr.db' };

  it('UNIT-CFG-007 WORKER_CONTROL kosong: aktif hanya di development, nonaktif di test & produksi', () => {
    expect(loadConfig({}).workerControl).toBe(true);
    expect(loadConfig({ WORKER_CONTROL: '  ' }).workerControl).toBe(true);
    expect(loadConfig({ NODE_ENV: 'test' }).workerControl).toBe(false);
    expect(loadConfig(PROD).workerControl).toBe(false);
  });

  it('UNIT-CFG-008 WORKER_CONTROL eksplisit true/false dihormati (termasuk mengaktifkan di produksi)', () => {
    expect(loadConfig({ WORKER_CONTROL: 'false' }).workerControl).toBe(false);
    expect(loadConfig({ NODE_ENV: 'test', WORKER_CONTROL: 'true' }).workerControl).toBe(true);
    expect(loadConfig({ ...PROD, WORKER_CONTROL: 'true' }).workerControl).toBe(true);
  });

  it('UNIT-CFG-009 WORKER_AUTOSTART default false; true/false eksplisit dihormati', () => {
    expect(loadConfig({}).workerAutostart).toBe(false);
    expect(loadConfig(PROD).workerAutostart).toBe(false);
    expect(loadConfig({ WORKER_AUTOSTART: 'true' }).workerAutostart).toBe(true);
    expect(loadConfig({ WORKER_AUTOSTART: 'false' }).workerAutostart).toBe(false);
  });

  it.each([
    ['WORKER_CONTROL', 'yes'], ['WORKER_CONTROL', '1'], ['WORKER_CONTROL', 'TRUE'], ['WORKER_CONTROL', 'on'],
    ['WORKER_AUTOSTART', 'yes'], ['WORKER_AUTOSTART', '0'], ['WORKER_AUTOSTART', 'False'],
  ])('NEG-CFG-008 %s=%s tidak valid ditolak dengan pesan berbahasa Indonesia', (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(ConfigError);
    expect(() => loadConfig({ [name]: value })).toThrow(`${name} harus 'true' atau 'false'`);
  });
});
