import { describe, expect, it } from 'vitest';
import { ADAPTER_METHODS, fetchJson, notSupported, redactUrl, validateAdapter } from '../../../backend/smartmoney/providers/adapter.js';
import { ProviderError, parseRetryAfter, toProviderError } from '../../../backend/smartmoney/providers/errors.js';
import { createFixtureProvider } from '../../../backend/smartmoney/providers/fixtureProvider.js';
import { createProviderRegistry } from '../../../backend/smartmoney/providers/registry.js';
import { buildScenario } from '../../fixtures/smartmoney/scenario.js';

// Tanpa jaringan: fetch diganti fungsi palsu; data provider fixture = SIMULASI.
const scenario = buildScenario({ now: Date.UTC(2026, 9, 1, 12, 0) });

function fakeAdapter(o = {}) {
  const base = {
    id: 'contoh', displayName: 'Contoh', requiresKey: true, isSimulated: false, chains: ['ethereum'],
    capabilities: new Set(['walletTransfers']),
    terms: { docsUrl: 'https://contoh.invalid/docs', attribution: null, displayAllowed: true, notes: '' },
  };
  for (const m of ADAPTER_METHODS) base[m] = notSupported('contoh', m);
  return { ...base, ...o };
}

const response = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: new Headers(headers),
  text: async () => body,
});

describe('error provider', () => {
  it('UNIT-SM-PRV-001 toProviderError memetakan AbortError/Timeout, HTTP, JSON rusak, jaringan', () => {
    const abort = Object.assign(new Error('x'), { name: 'AbortError' });
    expect(toProviderError(abort, 'p').code).toBe('TIMEOUT');
    expect(toProviderError(new DOMException('t', 'TimeoutError'), 'p').code).toBe('TIMEOUT');
    expect(toProviderError({ status: 401 }, 'p').code).toBe('UNAUTHORIZED');
    expect(toProviderError({ status: 403 }, 'p').code).toBe('UNAUTHORIZED');
    const rl = toProviderError({ status: 429, headers: new Headers({ 'retry-after': '30' }) }, 'p');
    expect([rl.code, rl.retryAfterMs, rl.provider]).toEqual(['RATE_LIMITED', 30_000, 'p']);
    expect(toProviderError({ statusCode: 503 }, 'p').code).toBe('UNAVAILABLE');
    expect(toProviderError({ status: 404 }, 'p').code).toBe('BAD_RESPONSE');
    expect(toProviderError(new SyntaxError('Unexpected token'), 'p').code).toBe('BAD_RESPONSE');
    expect(toProviderError(new TypeError('fetch failed'), 'p').code).toBe('UNAVAILABLE');
    const existing = new ProviderError('NOT_SUPPORTED');
    expect(toProviderError(existing, 'p')).toBe(existing);
    expect(existing.provider).toBe('p');
  });

  it('NEG-SM-PRV-001 kode error asing ditolak; pesan menyamarkan kunci API', () => {
    expect(() => new ProviderError('BOOM')).toThrow(RangeError);
    const e = new ProviderError('UNAVAILABLE', 'gagal https://x.invalid/api?module=a&apikey=RAHASIA123&key=K2');
    expect(e.message).not.toMatch(/RAHASIA123|K2/);
    expect(e.message).toContain('apikey=REDACTED');
    expect(e.toJSON()).toEqual({ provider: null, code: 'UNAVAILABLE', retryAfterMs: null, message: e.message });
  });

  it('UNIT-SM-PRV-002 Retry-After: detik, tanggal HTTP, tidak valid', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), { now: 4000 })).toBe(6000);
    expect(parseRetryAfter('besok')).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe('kontrak adapter & fetchJson', () => {
  it('UNIT-SM-PRV-003 validateAdapter menerima adapter lengkap dan melaporkan bentuk yang salah', () => {
    expect(validateAdapter(fakeAdapter())).toEqual([]);
    expect(validateAdapter(createFixtureProvider(scenario))).toEqual([]);
    const bad = validateAdapter(fakeAdapter({ id: 'Bad Id', chains: ['dogechain'], capabilities: ['walletTransfers'], fetchLabels: undefined, terms: null }));
    expect(bad.length).toBe(5);
    expect(validateAdapter(null)).toEqual(['adapter harus objek']);
  });

  it('UNIT-SM-PRV-004 notSupported menolak dengan NOT_SUPPORTED', async () => {
    await expect(notSupported('contoh', 'fetchLabels')()).rejects.toMatchObject({ code: 'NOT_SUPPORTED', provider: 'contoh' });
  });

  it('UNIT-SM-PRV-005 fetchJson sukses mengirim header & signal', async () => {
    let seen;
    const fetchImpl = async (url, init) => { seen = { url, init }; return response(200, '{"ok":true}'); };
    expect(await fetchJson(fetchImpl, 'https://x.invalid/a', { headers: { 'x-api-key': 'K' }, provider: 'p' })).toEqual({ ok: true });
    expect(seen.init.headers['x-api-key']).toBe('K');
    expect(seen.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('NEG-SM-PRV-002 fetchJson: HTTP 429/401/500, JSON rusak, jaringan — kunci API tidak bocor ke pesan', async () => {
    const url = 'https://x.invalid/api?address=0xabc&apikey=RAHASIA&api_key=R2';
    const cases = [
      [response(429, '', { 'retry-after': '12' }), { code: 'RATE_LIMITED', retryAfterMs: 12_000 }],
      [response(401, ''), { code: 'UNAUTHORIZED' }],
      [response(502, ''), { code: 'UNAVAILABLE' }],
      [response(200, '<html>'), { code: 'BAD_RESPONSE' }],
    ];
    for (const [res, expected] of cases) {
      const err = await fetchJson(async () => res, url, { provider: 'p' }).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).toMatchObject({ provider: 'p', ...expected });
      expect(err.message).not.toMatch(/RAHASIA|R2/);
    }
    const net = await fetchJson(async () => { throw new TypeError(`fetch failed ${url}`); }, url, { provider: 'p' }).catch((e) => e);
    expect(net.code).toBe('UNAVAILABLE');
    expect(net.message).not.toMatch(/RAHASIA|R2/);
    expect(redactUrl(url)).toBe('https://x.invalid/api?address=0xabc&apikey=REDACTED&api_key=REDACTED');
  });

  it('EDGE-SM-PRV-001 fetchJson batas waktu → TIMEOUT; pembatalan pemanggil → TIMEOUT', async () => {
    const hang = (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    await expect(fetchJson(hang, 'https://x.invalid/', { timeoutMs: 20, provider: 'p' })).rejects.toMatchObject({ code: 'TIMEOUT' });
    const ac = new AbortController();
    const p = fetchJson(hang, 'https://x.invalid/', { timeoutMs: 10_000, signal: ac.signal, provider: 'p' });
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});

describe('registri provider', () => {
  it('UNIT-SM-PRV-006 hanya adapter yang diaktifkan; urutan konfigurasi; kapabilitas & chain', () => {
    const a = fakeAdapter({ id: 'alfa', chains: ['ethereum', 'base'], capabilities: new Set(['walletTransfers', 'labels']) });
    const b = fakeAdapter({ id: 'bravo', chains: ['solana'], capabilities: new Set(['walletTransfers']) });
    const reg = createProviderRegistry({ adapters: [a, b], enabledIds: ['bravo', 'alfa', 'hilang'] });
    expect(reg.list().map((x) => x.id)).toEqual(['bravo', 'alfa']);
    expect(reg.get('alfa')).toBe(a);
    expect(reg.get('hilang')).toBeNull();
    expect(reg.withCapability('walletTransfers', 'solana').map((x) => x.id)).toEqual(['bravo']);
    expect(reg.withCapability('labels').map((x) => x.id)).toEqual(['alfa']);
    expect(reg.missing()).toEqual(['hilang']);
  });

  it('NEG-SM-PRV-003 fixture tidak pernah otomatis aktif; adapter rusak / id ganda ditolak', () => {
    expect(createProviderRegistry({ adapters: [], enabledIds: ['fixture'] }).list()).toEqual([]);
    expect(createProviderRegistry({ adapters: [createFixtureProvider(scenario)], enabledIds: [] }).list()).toEqual([]);
    expect(createProviderRegistry({ adapters: [createFixtureProvider(scenario)], enabledIds: ['fixture'] }).list()[0].isSimulated).toBe(true);
    expect(createProviderRegistry().list()).toEqual([]);
    expect(() => createProviderRegistry({ adapters: [fakeAdapter({ chains: [] })] })).toThrow(TypeError);
    expect(() => createProviderRegistry({ adapters: [fakeAdapter(), fakeAdapter()] })).toThrow(/ganda/);
  });
});

describe('provider fixture (data simulasi)', () => {
  const q1 = scenario.wallets.Q1;

  it('UNIT-SM-PRV-007 melayani transfer wallet terurut, paginasi kursor, label, harga, kandidat, mapping', async () => {
    const p = createFixtureProvider(scenario, { pageSize: 10 });
    expect(p).toMatchObject({ id: 'fixture', isSimulated: true });
    const all = [];
    let cursor = null;
    do {
      const page = await p.fetchWalletTransfers({ chain: 'ethereum', address: q1, cursor });
      all.push(...page.transfers);
      cursor = page.nextCursor;
      expect(page.asOf).toBe(scenario.now);
    } while (cursor);
    const expected = scenario.rawTransfers.filter((t) => t.chain === 'ethereum' && (t.from === q1 || t.to === q1));
    expect(all).toHaveLength(expected.length);
    expect(all.every((t) => t.isSimulated && t.provider === 'fixture')).toBe(true);
    expect(all.map((t) => t.blockTime)).toEqual([...all.map((t) => t.blockTime)].sort((a, b) => a - b));
    const pool = scenario.labels.find((l) => l.category === 'dex_pool' && l.chain === 'base');
    expect(await p.fetchLabels({ chain: 'base', addresses: [pool.address] })).toEqual([pool]);
    expect((await p.fetchPrices({ chain: 'ethereum', addresses: [scenario.tokens.TKA.address] }))[0].priceUsd).toBeGreaterThan(0);
    expect((await p.discoverWallets({ chain: 'solana' })).length).toBe(2);
    expect(await p.fetchBinanceMapping({})).toEqual(scenario.binanceMap);
    expect(p.chains).toEqual(['base', 'ethereum', 'solana']);
  });

  it('EDGE-SM-PRV-002 since membatasi transfer; data terlambat baru muncul pada batch kedua walau lebih tua dari since', async () => {
    const { wallet, chain } = scenario.expectations.late;
    const lateKeys = new Set(scenario.expectations.lateTransferKeys);
    const isLate = (t) => lateKeys.has(`${t.chain}:${t.txHash}:${t.logIndex}`);
    const p = createFixtureProvider(scenario, { lateTransfers: true });
    const first = await p.fetchWalletTransfers({ chain, address: wallet });
    expect(first.transfers.some(isLate)).toBe(false);
    const since = scenario.now - 86_400_000;
    const second = await p.fetchWalletTransfers({ chain, address: wallet, since });
    expect(second.transfers.filter(isLate)).toHaveLength(2);
    expect(second.transfers.filter((t) => !isLate(t)).every((t) => t.blockTime >= since)).toBe(true);
  });

  it('EDGE-SM-PRV-003 injeksi kegagalan sumber data: UNAVAILABLE, RATE_LIMITED (retryAfter), pulih via setFailure', async () => {
    const p = createFixtureProvider(scenario, { failWith: 'UNAVAILABLE' });
    await expect(p.fetchWalletTransfers({ chain: 'ethereum', address: q1 })).rejects.toMatchObject({ code: 'UNAVAILABLE', provider: 'fixture' });
    await expect(p.fetchLabels({ chain: 'ethereum' })).rejects.toBeInstanceOf(ProviderError);
    p.setFailure('RATE_LIMITED');
    await expect(p.discoverWallets({ chain: 'ethereum' })).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 60_000 });
    p.setFailure(null);
    expect((await p.fetchWalletTransfers({ chain: 'ethereum', address: q1 })).transfers.length).toBeGreaterThan(0);
    expect(() => p.setFailure('MELEDAK')).toThrow(RangeError);
  });

  it('EDGE-SM-PRV-004 TIMEOUT: kegagalan simulasi & jeda yang dibatalkan signal', async () => {
    await expect(createFixtureProvider(scenario, { failWith: 'TIMEOUT' }).fetchPrices({ chain: 'ethereum' })).rejects.toMatchObject({ code: 'TIMEOUT' });
    const slow = createFixtureProvider(scenario, { delayMs: 5000 });
    await expect(slow.fetchPrices({ chain: 'ethereum', signal: AbortSignal.timeout(20) })).rejects.toMatchObject({ code: 'TIMEOUT' });
    const quick = createFixtureProvider(scenario, { delayMs: 5 });
    expect((await quick.fetchPrices({ chain: 'base' })).length).toBeGreaterThan(0);
  });

  it('NEG-SM-PRV-004 kursor tidak dikenal → BAD_RESPONSE', async () => {
    const p = createFixtureProvider(scenario);
    await expect(p.fetchWalletTransfers({ chain: 'ethereum', address: q1, cursor: 'xyz' })).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });
});
