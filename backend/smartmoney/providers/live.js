// Registri provider smart money untuk proses NYATA (server, worker, skrip sinkronisasi): memetakan id di
// SMART_MONEY_PROVIDERS (config.smartMoney.providers, urutan = prioritas) ke pabrik adapter.
//
// Aturan:
// - Tabel pabrik: id → { displayName, requiresKey, isSimulated, create(env, deps) → adapter|null }. `create` menerima
//   env proses (kunci API dibaca DI SINI per adapter, tidak pernah dicatat) dan deps { fetchImpl, clock, sleep }.
//   Hasil null (mis. kunci belum diisi) → id tercantum di `unavailable()` beserta alasannya dan di `missing()`
//   (status NOT_CONFIGURED). Tidak pernah ada data simulasi sebagai pengganti.
// - Provider `fixture` (DATA SIMULASI) TIDAK PERNAH dibuat dari tabel ini. Ia hanya diterima lewat `extraAdapters`
//   (dibuat pemanggil dari skenario uji) dan hanya bila config.nodeEnv === 'test' (tes unit/integrasi & server E2E).
//   Skenario simulasi (tests/fixtures/smartmoney/scenario.js) tidak pernah diimpor kode backend.
// - Adapter live jalur gratis (pilihan pengguna 2026-10-26, docs/17 "Mengaktifkan data live (jalur gratis)"):
//   etherscan (ETHERSCAN_API_KEY), routescan (tanpa kunci; ROUTESCAN_API_KEY opsional), geckoterminal (tanpa kunci),
//   binance-mapping (BINANCE_API_KEY + BINANCE_API_SECRET, izin baca saja). Adapter berkunci tanpa kunci → null
//   (dilaporkan "belum dikonfigurasi", tidak pernah memanggil jaringan). Urutan SMART_MONEY_PROVIDERS = prioritas
//   per chain: Etherscan untuk chain paket gratisnya, Routescan untuk chain sisanya (fallback NOT_SUPPORTED).

import { createBinanceMappingProvider } from './binanceMapping.js';
import { createEtherscanProvider } from './etherscan.js';
import { createGeckoTerminalProvider } from './geckoTerminal.js';
import { createProviderRegistry } from './registry.js';
import { createRoutescanProvider } from './routescan.js';

const FIXTURE_ID = 'fixture';

/** Nilai kunci dari env yang sudah dipangkas, atau null bila kosong. Nilai kunci tidak pernah dicatat. */
function secret(value) {
  const v = typeof value === 'string' ? value.trim() : '';
  return v === '' ? null : v;
}

/**
 * Pabrik adapter yang dikenal. Kunci = id provider di SMART_MONEY_PROVIDERS.
 * @type {Readonly<Record<string, Readonly<{ displayName: string, requiresKey: boolean, isSimulated: boolean,
 *   create: (env: Record<string, string|undefined>, deps: { fetchImpl?: typeof fetch, clock?: () => number,
 *   sleep?: (ms: number) => Promise<void> }) => object|null, unavailableReason?: string }>>>}
 */
export const LIVE_PROVIDER_FACTORIES = Object.freeze({
  [FIXTURE_ID]: Object.freeze({
    displayName: 'Fixture (data simulasi)',
    requiresKey: false,
    isSimulated: true,
    // Sengaja null: fixture hanya lewat extraAdapters di lingkungan tes (lihat catatan modul).
    create: () => null,
    unavailableReason: 'Provider fixture (data simulasi) hanya tersedia di tes & E2E — tidak pernah di server sungguhan',
  }),
  etherscan: Object.freeze({
    displayName: 'Etherscan API V2',
    requiresKey: true,
    isSimulated: false,
    create: (env, deps) => (secret(env.ETHERSCAN_API_KEY) ? createEtherscanProvider({ apiKey: secret(env.ETHERSCAN_API_KEY), ...deps }) : null),
    unavailableReason: 'ETHERSCAN_API_KEY belum diisi di .env',
  }),
  routescan: Object.freeze({
    displayName: 'Routescan',
    requiresKey: false,
    isSimulated: false,
    create: (env, deps) => createRoutescanProvider({ apiKey: secret(env.ROUTESCAN_API_KEY), ...deps }),
  }),
  geckoterminal: Object.freeze({
    displayName: 'GeckoTerminal',
    requiresKey: false,
    isSimulated: false,
    create: (env, deps) => createGeckoTerminalProvider({ ...deps }),
  }),
  'binance-mapping': Object.freeze({
    displayName: 'Pemetaan kontrak Binance (baca saja)',
    requiresKey: true,
    isSimulated: false,
    create: (env, deps) => {
      const apiKey = secret(env.BINANCE_API_KEY);
      const apiSecret = secret(env.BINANCE_API_SECRET);
      return apiKey && apiSecret ? createBinanceMappingProvider({ apiKey, apiSecret, ...deps }) : null;
    },
    unavailableReason: 'BINANCE_API_KEY / BINANCE_API_SECRET belum diisi di .env',
  }),
});

const NOT_WIRED_REASON = 'Adapter untuk id ini belum dirakit di registri live (lihat docs/17 — Mengaktifkan data live)';
const CREATE_NULL_REASON = 'Adapter belum dapat dibuat — periksa kunci API / konfigurasi di .env';

/**
 * Registri provider aktif dari konfigurasi aplikasi.
 * @param {{ nodeEnv?: string, smartMoney?: { providers?: string[] } }} config konfigurasi aplikasi (loadConfig())
 * @param {{ fetchImpl?: typeof fetch, clock?: () => number, sleep?: (ms: number) => Promise<void>,
 *   env?: Record<string, string|undefined>, extraAdapters?: object[],
 *   factories?: Record<string, { displayName: string, requiresKey: boolean, isSimulated: boolean,
 *     create: Function, unavailableReason?: string }> }} [deps]
 *   extraAdapters: adapter siap pakai (KHUSUS tes/E2E, mis. fixture). Adapter bertanda isSimulated di luar
 *   NODE_ENV=test → TypeError (kesalahan perakitan, bukan kondisi runtime).
 * @returns {ReturnType<typeof createProviderRegistry> & {
 *   unavailable: () => Array<{ id: string, displayName: string, requiresKey: boolean|null, isSimulated: boolean, reason: string }>,
 *   configuredIds: () => string[] }}
 */
export function createLiveProviderRegistry(config, {
  fetchImpl = globalThis.fetch, clock = Date.now, sleep, env = {}, extraAdapters = [], factories = LIVE_PROVIDER_FACTORIES,
} = {}) {
  const ids = [...new Set(config?.smartMoney?.providers ?? [])];
  const isTest = config?.nodeEnv === 'test';
  if (!Array.isArray(extraAdapters)) throw new TypeError('extraAdapters harus array');
  for (const adapter of extraAdapters) {
    if (adapter?.isSimulated === true && !isTest) {
      throw new TypeError(`Adapter data simulasi (${adapter.id ?? '?'}) hanya boleh dipakai saat NODE_ENV=test`);
    }
  }
  const extraIds = new Set(extraAdapters.map((a) => a?.id));
  const deps = { fetchImpl, clock, sleep };
  const adapters = [...extraAdapters];
  const unavailable = [];
  for (const id of ids) {
    if (extraIds.has(id)) continue;
    const factory = Object.hasOwn(factories, id) ? factories[id] : null;
    if (factory === null) {
      unavailable.push({ id, displayName: id, requiresKey: null, isSimulated: false, reason: NOT_WIRED_REASON });
      continue;
    }
    const adapter = factory.create(env, deps);
    if (adapter === null || adapter === undefined) {
      unavailable.push({
        id, displayName: factory.displayName, requiresKey: factory.requiresKey, isSimulated: factory.isSimulated,
        reason: factory.unavailableReason ?? CREATE_NULL_REASON,
      });
      continue;
    }
    if (adapter.isSimulated === true && !isTest) {
      throw new TypeError(`Pabrik ${id} menghasilkan adapter data simulasi di luar NODE_ENV=test`);
    }
    adapters.push(adapter);
  }
  const registry = createProviderRegistry({ adapters, enabledIds: ids });
  return {
    ...registry,
    /** Id terkonfigurasi yang tidak memiliki adapter aktif, beserta alasannya (untuk GET /status & log). */
    unavailable: () => unavailable.map((u) => ({ ...u })),
    /** Seluruh id SMART_MONEY_PROVIDERS sesuai urutan konfigurasi. */
    configuredIds: () => [...ids],
  };
}
