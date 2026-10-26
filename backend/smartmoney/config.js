// Konfigurasi Insider / Smart Money Radar dari environment variable. Default: tidak ada provider aktif
// (fitur menampilkan "belum dikonfigurasi", tidak pernah jatuh ke data simulasi). Kunci API per provider dibaca
// oleh adapter masing-masing, bukan di sini, dan tidak pernah dicatat.

import { ConfigError } from '../app/config.js';

const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

function read(env, name, fallback) {
  const value = env[name] === undefined ? '' : String(env[name]).trim();
  return value === '' ? fallback : value;
}

function parseInteger(name, raw, { min, max }) {
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} harus bilangan bulat`);
  const value = Number(raw);
  if (value < min || value > max) throw new ConfigError(`${name} harus di antara ${min} dan ${max}`);
  return value;
}

const hasValue = (env, name) => typeof env[name] === 'string' && env[name].trim() !== '';

/**
 * Mode otomatis (jalur gratis, docs/17): provider aktif mengikuti kunci yang terisi di .env. Dengan
 * ETHERSCAN_API_KEY → etherscan (chain paket gratis) + routescan (chain sisanya, tanpa kunci) + geckoterminal
 * (penemuan wallet, tanpa kunci); dengan BINANCE_API_KEY + BINANCE_API_SECRET → binance-mapping. Tanpa kunci apa pun
 * → tidak ada provider (fitur menampilkan "belum ada sumber data"; tidak ada panggilan jaringan).
 */
function autoProviders(env) {
  const ids = [];
  if (hasValue(env, 'ETHERSCAN_API_KEY')) ids.push('etherscan', 'routescan', 'geckoterminal');
  if (hasValue(env, 'BINANCE_API_KEY') && hasValue(env, 'BINANCE_API_SECRET')) ids.push('binance-mapping');
  return ids;
}

/**
 * SMART_MONEY_PROVIDERS: kosong atau `auto` = otomatis dari kunci (autoProviders), `off` = mati, atau daftar id
 * dipisah koma (urutan = prioritas). Provider `fixture` (data simulasi) ditolak di produksi agar data simulasi tidak
 * pernah tampil di server sungguhan.
 */
function parseProviders(raw, nodeEnv, env) {
  if (raw === '' || raw === 'auto') return autoProviders(env);
  if (raw === 'off') return [];
  const ids = raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
  for (const id of ids) {
    if (!PROVIDER_ID_RE.test(id)) throw new ConfigError(`SMART_MONEY_PROVIDERS memuat id tidak valid: ${id}`);
  }
  if (nodeEnv === 'production' && ids.includes('fixture')) {
    throw new ConfigError('SMART_MONEY_PROVIDERS=fixture (data simulasi) tidak diizinkan di produksi');
  }
  return [...new Set(ids)];
}

/**
 * Membaca & memvalidasi konfigurasi smart money.
 * @param {Record<string, string | undefined>} env
 * @returns {Readonly<{ providers: string[], syncIntervalMinutes: number, staleAfterMinutes: number, maxWalletsPerSync: number }>}
 * @throws {ConfigError}
 */
export function parseSmartMoneyConfig(env = {}) {
  const nodeEnv = read(env, 'NODE_ENV', 'development');
  return Object.freeze({
    providers: Object.freeze(parseProviders(read(env, 'SMART_MONEY_PROVIDERS', ''), nodeEnv, env)),
    syncIntervalMinutes: parseInteger('SMART_MONEY_SYNC_MINUTES', read(env, 'SMART_MONEY_SYNC_MINUTES', '15'), { min: 5, max: 1440 }),
    staleAfterMinutes: parseInteger('SMART_MONEY_STALE_MINUTES', read(env, 'SMART_MONEY_STALE_MINUTES', '60'), { min: 1, max: 10_080 }),
    maxWalletsPerSync: parseInteger('SMART_MONEY_MAX_WALLETS', read(env, 'SMART_MONEY_MAX_WALLETS', '50'), { min: 1, max: 500 }),
  });
}
