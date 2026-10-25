// Konfigurasi aplikasi berbasis environment variable.
// Semua nilai divalidasi saat startup; konfigurasi tidak valid menghentikan proses (fail fast).

const DEFAULTS = Object.freeze({
  NODE_ENV: 'development',
  HOST: '127.0.0.1',
  PORT: '8080',
  DATABASE_PATH: './data/long-radar.db',
  APP_ORIGIN: 'http://127.0.0.1:8080',
  COOKIE_SECURE: 'auto',
  SESSION_IDLE_MINUTES: '30',
  SESSION_ABSOLUTE_HOURS: '12',
  LOGIN_RATE_LIMIT_MAX: '5',
  LOGIN_RATE_LIMIT_WINDOW_MINUTES: '15',
  ACCOUNT_LOCK_THRESHOLD: '10',
  ACCOUNT_LOCK_MINUTES: '15',
  MAX_USERS: '2',
  TRUST_PROXY: 'false',
  LOG_LEVEL: 'info',
});

const ENVIRONMENTS = new Set(['development', 'test', 'production']);
const LOG_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function parseInteger(name, raw, { min, max }) {
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} harus bilangan bulat`);
  const value = Number(raw);
  if (value < min || value > max) throw new ConfigError(`${name} harus di antara ${min} dan ${max}`);
  return value;
}

function parseBoolean(name, raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new ConfigError(`${name} harus 'true' atau 'false'`);
}

function parseOrigin(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError('APP_ORIGIN bukan URL yang valid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError('APP_ORIGIN harus memakai http atau https');
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new ConfigError('APP_ORIGIN hanya boleh berisi skema, host, dan port');
  }
  return url.origin;
}

/**
 * Membaca dan memvalidasi konfigurasi.
 * @param {Record<string, string | undefined>} env
 */
export function loadConfig(env = process.env) {
  const read = (name) => {
    const value = env[name];
    return value === undefined || value === '' ? DEFAULTS[name] : String(value).trim();
  };

  const nodeEnv = read('NODE_ENV');
  if (!ENVIRONMENTS.has(nodeEnv)) throw new ConfigError('NODE_ENV tidak dikenal');
  const isProduction = nodeEnv === 'production';

  // Di produksi, nilai kritis wajib diset eksplisit — tidak boleh jatuh ke default pengembangan.
  if (isProduction) {
    for (const name of ['APP_ORIGIN', 'DATABASE_PATH']) {
      if (!env[name]) throw new ConfigError(`${name} wajib diset di produksi`);
    }
  }

  const appOrigin = parseOrigin(read('APP_ORIGIN'));
  const cookieSecureRaw = read('COOKIE_SECURE');
  const cookieSecure = cookieSecureRaw === 'auto'
    ? appOrigin.startsWith('https:')
    : parseBoolean('COOKIE_SECURE', cookieSecureRaw);

  if (isProduction && (!appOrigin.startsWith('https:') || !cookieSecure)) {
    throw new ConfigError('Produksi wajib memakai APP_ORIGIN https dan cookie Secure');
  }

  const logLevel = read('LOG_LEVEL');
  if (!LOG_LEVELS.has(logLevel)) throw new ConfigError('LOG_LEVEL tidak dikenal');

  return Object.freeze({
    nodeEnv,
    isProduction,
    host: read('HOST'),
    port: parseInteger('PORT', read('PORT'), { min: 1, max: 65535 }),
    databasePath: read('DATABASE_PATH'),
    appOrigin,
    cookieSecure,
    trustProxy: parseBoolean('TRUST_PROXY', read('TRUST_PROXY')),
    logLevel,
    session: Object.freeze({
      idleMs: parseInteger('SESSION_IDLE_MINUTES', read('SESSION_IDLE_MINUTES'), { min: 1, max: 1440 }) * 60_000,
      absoluteMs: parseInteger('SESSION_ABSOLUTE_HOURS', read('SESSION_ABSOLUTE_HOURS'), { min: 1, max: 168 }) * 3_600_000,
    }),
    login: Object.freeze({
      rateLimitMax: parseInteger('LOGIN_RATE_LIMIT_MAX', read('LOGIN_RATE_LIMIT_MAX'), { min: 1, max: 1000 }),
      rateLimitWindowMs: parseInteger('LOGIN_RATE_LIMIT_WINDOW_MINUTES', read('LOGIN_RATE_LIMIT_WINDOW_MINUTES'), { min: 1, max: 1440 }) * 60_000,
      lockThreshold: parseInteger('ACCOUNT_LOCK_THRESHOLD', read('ACCOUNT_LOCK_THRESHOLD'), { min: 1, max: 1000 }),
      lockMs: parseInteger('ACCOUNT_LOCK_MINUTES', read('ACCOUNT_LOCK_MINUTES'), { min: 1, max: 1440 }) * 60_000,
    }),
    maxUsers: parseInteger('MAX_USERS', read('MAX_USERS'), { min: 1, max: 10 }),
  });
}
