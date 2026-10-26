// Pembantu uji API Smart Money: aplikasi uji (NODE_ENV=test) dengan provider FIXTURE — DATA SIMULASI dari
// tests/fixtures/smartmoney/scenario.js — yang disinkronkan lewat layanan asli runSmartMoneySync, ditambah
// pembungkus request bersesi (cookie) dan mutasi ber-CSRF.
import { createFixtureProvider } from '../../backend/smartmoney/providers/fixtureProvider.js';
import { createLiveProviderRegistry } from '../../backend/smartmoney/providers/live.js';
import { runSmartMoneySync } from '../../backend/smartmoney/sync.js';
import { buildScenario } from '../fixtures/smartmoney/scenario.js';
import { TEST_ORIGIN, createClock, createTestApp, login } from './testApp.js';

export const SM = '/api/smart-money';

/**
 * Aplikasi uji smart money.
 * @param {{ providers?: string, seed?: boolean, scenario?: object, fixtureOptions?: object, env?: object,
 *   users?: object[], registry?: (ctx: { config: object, clock: Function, fixture: object }) => object }} [options]
 *   providers: nilai SMART_MONEY_PROVIDERS ('' = tanpa provider). seed: jalankan satu sinkronisasi di awal.
 *   registry: pembuat registri kustom (default registri live + fixture lewat extraAdapters).
 */
export async function createSmartMoneyApp({
  providers = 'fixture', seed = true, scenario = buildScenario(), fixtureOptions = {}, env = {}, users, registry,
} = {}) {
  const clock = createClock(scenario.now);
  const fixture = createFixtureProvider(scenario, fixtureOptions);
  const ctx = await createTestApp({
    env: { ...(providers ? { SMART_MONEY_PROVIDERS: providers } : {}), ...env },
    clock,
    ...(users ? { users } : {}),
    appOptions: ({ config }) => ({
      smartMoneyRegistry: registry
        ? registry({ config, clock, fixture })
        : createLiveProviderRegistry(config, { clock, extraAdapters: providers ? [fixture] : [] }),
    }),
  });
  const repo = ctx.app.services.repos.smartMoney;
  const sync = () => runSmartMoneySync({
    repo, registry: ctx.app.services.smartMoneyRegistry, clock, config: ctx.config.smartMoney,
  });
  const summary = seed ? await sync() : null;
  return { ...ctx, clock, scenario, fixture, repo, sync, summary };
}

/**
 * Sesi login dengan pembungkus request.
 * @returns {Promise<{ auth: object, userId: number, get: (url: string, headers?: object) => Promise<object>,
 *   send: (method: string, url: string, payload?: unknown, opts?: { csrf?: boolean, origin?: string|null }) => Promise<object> }>}
 */
export async function session(app, user) {
  const auth = await login(app, user);
  return {
    auth,
    userId: auth.res.json().user.id,
    get: (url, headers = {}) => app.inject({ method: 'GET', url, headers: { cookie: auth.cookie, ...headers } }),
    send: (method, url, payload, { csrf = true, origin = TEST_ORIGIN } = {}) => app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload }),
      headers: {
        cookie: auth.cookie,
        ...(csrf ? { 'x-csrf-token': auth.csrfToken } : {}),
        ...(origin ? { origin } : {}),
      },
    }),
  };
}
