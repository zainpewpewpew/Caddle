import { describe, expect, it } from 'vitest';
import { createFixtureProvider } from '../../../backend/smartmoney/providers/fixtureProvider.js';
import { LIVE_PROVIDER_FACTORIES, createLiveProviderRegistry } from '../../../backend/smartmoney/providers/live.js';
import { parseSmartMoneyConfig } from '../../../backend/smartmoney/config.js';
import { buildScenario } from '../../fixtures/smartmoney/scenario.js';

const SCENARIO = buildScenario();
const config = (providers, nodeEnv = 'development') => ({ nodeEnv, smartMoney: { providers } });

/** Adapter minimal yang lolos validateAdapter (tanpa jaringan). */
function stubAdapter(id, { isSimulated = false } = {}) {
  const fixture = createFixtureProvider(SCENARIO);
  return { ...fixture, id, displayName: `Contoh ${id}`, isSimulated };
}

describe('registri provider live (providers/live.js)', () => {
  it('UNIT-SM-LIVE-001 tanpa SMART_MONEY_PROVIDERS → registri kosong tanpa alasan apa pun', () => {
    const registry = createLiveProviderRegistry(config([]));
    expect(registry.list()).toEqual([]);
    expect(registry.unavailable()).toEqual([]);
    expect(registry.configuredIds()).toEqual([]);
    expect(registry.missing()).toEqual([]);
  });

  it('UNIT-SM-LIVE-002 id belum dirakit / fixture dari tabel pabrik → "belum tersedia" beserta alasan, bukan data palsu', () => {
    const registry = createLiveProviderRegistry(config(['tidakdikenal', 'fixture']));
    expect(registry.list()).toEqual([]);
    expect(registry.configuredIds()).toEqual(['tidakdikenal', 'fixture']);
    expect(registry.missing()).toEqual(['tidakdikenal', 'fixture']);
    const [unknown, fixture] = registry.unavailable();
    expect(unknown).toMatchObject({ id: 'tidakdikenal', requiresKey: null, isSimulated: false, reason: expect.stringMatching(/belum dirakit/) });
    expect(fixture).toMatchObject({ id: 'fixture', isSimulated: true, reason: expect.stringMatching(/hanya tersedia di tes/) });
    expect(LIVE_PROVIDER_FACTORIES.fixture.create({}, {})).toBeNull();
  });

  it('UNIT-SM-LIVE-006 adapter jalur gratis: tanpa kunci → belum dikonfigurasi (tanpa jaringan); dengan kunci → aktif & valid', () => {
    const calls = [];
    const fetchImpl = async (url) => { calls.push(String(url)); throw new Error('jaringan tidak boleh dipanggil'); };
    const ids = ['etherscan', 'routescan', 'geckoterminal', 'binance-mapping'];
    const off = createLiveProviderRegistry(config(ids), { env: { BINANCE_API_KEY: 'k' }, fetchImpl });
    expect(off.list().map((a) => a.id)).toEqual(['routescan', 'geckoterminal']);
    expect(off.unavailable()).toEqual([
      expect.objectContaining({ id: 'etherscan', requiresKey: true, reason: expect.stringMatching(/ETHERSCAN_API_KEY/) }),
      expect.objectContaining({ id: 'binance-mapping', requiresKey: true, reason: expect.stringMatching(/BINANCE_API_SECRET/) }),
    ]);
    const env = { ETHERSCAN_API_KEY: ' AAAABBBBCCCCDDDD ', BINANCE_API_KEY: 'a'.repeat(64), BINANCE_API_SECRET: 'b'.repeat(64) };
    const on = createLiveProviderRegistry(config(ids), { env, fetchImpl });
    expect(on.list().map((a) => a.id)).toEqual(ids);
    expect(on.unavailable()).toEqual([]);
    expect(on.list().every((a) => a.isSimulated === false)).toBe(true);
    // Prioritas per chain: Etherscan untuk chain paket gratisnya, Routescan untuk sisanya (mis. base).
    expect(on.withCapability('walletTransfers', 'ethereum').map((a) => a.id)).toEqual(['etherscan', 'routescan']);
    expect(on.withCapability('walletTransfers', 'base').map((a) => a.id)).toEqual(['routescan']);
    expect(on.withCapability('walletDiscovery', 'ethereum').map((a) => a.id)).toEqual(['geckoterminal']);
    expect(on.withCapability('binanceMapping').map((a) => a.id)).toEqual(['binance-mapping']);
    expect(calls).toEqual([]);
  });

  it('UNIT-SM-LIVE-007 binance-public: tanpa kunci apa pun → aktif (pemetaan publik), tanpa jaringan saat dirakit; mode otomatis Etherscan-saja', () => {
    const calls = [];
    const fetchImpl = async (url) => { calls.push(String(url)); throw new Error('jaringan tidak boleh dipanggil'); };
    expect(LIVE_PROVIDER_FACTORIES['binance-public']).toMatchObject({ requiresKey: false, isSimulated: false });
    const registry = createLiveProviderRegistry(config(['binance-public']), { env: {}, fetchImpl });
    const [adapter] = registry.list();
    expect(registry.list()).toHaveLength(1);
    expect(adapter).toMatchObject({ id: 'binance-public', requiresKey: false, isSimulated: false });
    expect(adapter.isConfigured()).toBe(true);
    expect(registry.unavailable()).toEqual([]);
    expect(registry.withCapability('binanceMapping').map((a) => a.id)).toEqual(['binance-public']);
    // Kunci Binance di env tidak pernah diteruskan ke mode publik.
    const env = { BINANCE_API_KEY: 'a'.repeat(64), BINANCE_API_SECRET: 'b'.repeat(64) };
    const withKeys = createLiveProviderRegistry(config(['binance-public']), { env, fetchImpl });
    expect(JSON.stringify(withKeys.list())).not.toMatch(/a{64}|b{64}/);

    // Mode otomatis dengan ETHERSCAN_API_KEY saja → empat adapter aktif, pemetaan oleh binance-public.
    const autoEnv = { ETHERSCAN_API_KEY: 'AAAABBBBCCCCDDDD' };
    const auto = createLiveProviderRegistry({ nodeEnv: 'development', smartMoney: parseSmartMoneyConfig(autoEnv) }, { env: autoEnv, fetchImpl });
    expect(auto.list().map((a) => a.id)).toEqual(['etherscan', 'routescan', 'geckoterminal', 'binance-public']);
    expect(auto.unavailable()).toEqual([]);
    expect(auto.withCapability('binanceMapping').map((a) => a.id)).toEqual(['binance-public']);
    expect(auto.withCapability('walletDiscovery', 'ethereum').every((a) => typeof a.trendingTokens === 'function')).toBe(true);
    expect(calls).toEqual([]);
  });

  it('UNIT-SM-LIVE-003 pabrik menerima env & deps; hasil null → alasan pabrik / alasan bawaan kunci', () => {
    const seen = [];
    const fetchImpl = async () => new Response('{}');
    const factories = {
      satu: { displayName: 'Satu', requiresKey: true, isSimulated: false, create: (env, deps) => { seen.push({ env, deps }); return env.SATU_KEY ? stubAdapter('satu') : null; } },
      dua: { displayName: 'Dua', requiresKey: true, isSimulated: false, create: () => null, unavailableReason: 'Isi DUA_KEY di .env' },
    };
    const off = createLiveProviderRegistry(config(['satu', 'dua']), { env: {}, fetchImpl, factories });
    expect(off.list()).toEqual([]);
    expect(off.unavailable()).toEqual([
      { id: 'satu', displayName: 'Satu', requiresKey: true, isSimulated: false, reason: expect.stringMatching(/kunci API/) },
      { id: 'dua', displayName: 'Dua', requiresKey: true, isSimulated: false, reason: 'Isi DUA_KEY di .env' },
    ]);
    expect(seen[0].deps.fetchImpl).toBe(fetchImpl);
    const on = createLiveProviderRegistry(config(['dua', 'satu']), { env: { SATU_KEY: 'x' }, factories });
    expect(on.list().map((a) => a.id)).toEqual(['satu']);
    expect(on.unavailable().map((u) => u.id)).toEqual(['dua']);
  });

  it('UNIT-SM-LIVE-004 urutan adapter aktif = urutan SMART_MONEY_PROVIDERS (prioritas); id ganda diabaikan', () => {
    const factories = {
      a: { displayName: 'A', requiresKey: false, isSimulated: false, create: () => stubAdapter('a') },
      b: { displayName: 'B', requiresKey: false, isSimulated: false, create: () => stubAdapter('b') },
    };
    const registry = createLiveProviderRegistry(config(['b', 'a', 'b']), { factories });
    expect(registry.list().map((a) => a.id)).toEqual(['b', 'a']);
    expect(registry.configuredIds()).toEqual(['b', 'a']);
  });

  it('UNIT-SM-LIVE-005 data simulasi hanya saat NODE_ENV=test (extraAdapters maupun pabrik); extraAdapters wajib array', () => {
    const simulatedFactory = { sim: { displayName: 'Sim', requiresKey: false, isSimulated: true, create: () => stubAdapter('sim', { isSimulated: true }) } };
    expect(() => createLiveProviderRegistry(config(['sim'], 'production'), { factories: simulatedFactory })).toThrow(/di luar NODE_ENV=test/);
    expect(createLiveProviderRegistry(config(['sim'], 'test'), { factories: simulatedFactory }).list().map((a) => a.id)).toEqual(['sim']);
    const fixture = createFixtureProvider(SCENARIO);
    expect(() => createLiveProviderRegistry(config(['fixture'], 'development'), { extraAdapters: [fixture] })).toThrow(TypeError);
    expect(() => createLiveProviderRegistry(config(['fixture'], 'test'), { extraAdapters: 'fixture' })).toThrow(/array/);
    // Adapter tambahan hanya aktif bila id-nya dikonfigurasi.
    expect(createLiveProviderRegistry(config([], 'test'), { extraAdapters: [fixture] }).list()).toEqual([]);
    const active = createLiveProviderRegistry(config(['fixture'], 'test'), { extraAdapters: [fixture] });
    expect(active.list()).toEqual([fixture]);
    expect(active.unavailable()).toEqual([]);
  });
});
