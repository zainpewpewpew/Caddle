import { buildApp } from '../../backend/app/buildApp.js';
import { loadConfig } from '../../backend/app/config.js';
import { openDatabase } from '../../backend/database/connection.js';
import { createUser } from '../../backend/users/userAdmin.js';

// Parameter Argon2id ringan KHUSUS pengujian agar suite cepat. Produksi memakai DEFAULT_ARGON2_OPTIONS.
export const TEST_HASHER_OPTIONS = { memoryCost: 1024, timeCost: 1, parallelism: 1 };
export const TEST_ORIGIN = 'http://127.0.0.1:8080';
export const ADMIN = { username: 'mary', password: 'correct-horse-battery-9', role: 'admin' };
export const ANALYST = { username: 'rekan', password: 'another-strong-pass-42', role: 'analyst' };

/** Jam yang dapat dimajukan secara deterministik. */
export function createClock(start = Date.UTC(2026, 0, 1, 0, 0, 0)) {
  let now = start;
  const clock = () => now;
  clock.advance = (ms) => { now += ms; };
  return clock;
}

/**
 * @param {{ env?: object, users?: object[], clock?: Function,
 *           appOptions?: object | ((ctx: { db: object, clock: Function, config: object }) => object) }} [options]
 *   appOptions: opsi tambahan buildApp (mis. `workerSupervisor` dengan fork tiruan) — boleh fungsi bila butuh db.
 */
export async function createTestApp({ env = {}, users = [ADMIN, ANALYST], clock = createClock(), appOptions = {} } = {}) {
  const config = loadConfig({ NODE_ENV: 'test', APP_ORIGIN: TEST_ORIGIN, LOG_LEVEL: 'silent', ...env });
  const db = openDatabase(':memory:');
  const extra = typeof appOptions === 'function' ? appOptions({ db, clock, config }) : appOptions;
  const app = await buildApp({ config, db, clock, hasherOptions: TEST_HASHER_OPTIONS, ...extra });
  const { repos, hasher } = app.services;
  for (const u of users) {
    await createUser({ users: repos.users, audit: repos.audit, hasher, maxUsers: config.maxUsers, clock }, u);
  }
  app.addHook('onClose', async () => db.close());
  return { app, db, config, clock };
}

/** Login dan kembalikan cookie + token CSRF untuk request berikutnya. */
export async function login(app, { username, password } = ADMIN) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: TEST_ORIGIN },
    payload: { username, password },
  });
  const setCookie = res.cookies[0];
  return {
    res,
    cookie: setCookie ? `${setCookie.name}=${setCookie.value}` : undefined,
    csrfToken: res.statusCode === 200 ? res.json().csrfToken : undefined,
  };
}
