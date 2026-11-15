import { isIP } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DOH_ENDPOINTS, DohError, createBinanceLookup, createDohResolver, isBinanceHost, isPublicIPv4,
  parseBinanceDnsMode, parseDohAnswer,
} from '../../../backend/ingestion/binance/doh.js';

// Semua jawaban DoH berasal dari fetch palsu — tidak ada request jaringan sungguhan di tes ini.
// IP di fixture meniru bentuk jawaban nyata (CloudFront/AWS) tetapi hanya data uji.

/** Jawaban DoH JSON: rantai CNAME (diabaikan) lalu record A. */
const answer = (ips, { ttl = 60, status = 0, cname = true } = {}) => ({
  Status: status,
  Answer: [
    ...(cname ? [{ name: 'fapi.binance.com', type: 5, TTL: ttl, data: 'd1.cloudfront.net.' }] : []),
    ...ips.map((ip) => ({ name: 'd1.cloudfront.net', type: 1, TTL: ttl, data: ip })),
  ],
});

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body instanceof Error) throw body;
      return body;
    },
  };
}

/** Fetch palsu: handler(url, init, nomorPanggilan) → Response-like | Promise | throw. */
function fakeFetch(handler) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: new URL(url), init });
    return handler(new URL(url), init, calls.length);
  };
  fetch.calls = calls;
  return fetch;
}

/** Panggil lookup gaya callback sebagai promise. */
const lookupAsync = (lookup, host, options) => new Promise((resolve) => {
  lookup(host, options, (err, address, family) => resolve({ err, address, family }));
});

describe('mode & host', () => {
  it('UNIT-DOH-001 BINANCE_DNS: kosong → doh; doh/system diterima; nilai lain ditolak', () => {
    expect(parseBinanceDnsMode(undefined)).toBe('doh');
    expect(parseBinanceDnsMode('')).toBe('doh');
    expect(parseBinanceDnsMode('  ')).toBe('doh');
    expect(parseBinanceDnsMode('doh')).toBe('doh');
    expect(parseBinanceDnsMode('system')).toBe('system');
    for (const bad of ['DOH', 'System', 'warp', 'true', 'dot']) {
      expect(() => parseBinanceDnsMode(bad)).toThrow(TypeError);
    }
  });

  it('UNIT-DOH-002 hanya binance.com/binance.vision & subdomainnya yang dianggap host Binance', () => {
    for (const host of ['fapi.binance.com', 'FSTREAM.Binance.COM', 'fstream.binance.com.', 'data.binance.vision', 'binance.com', 'www.binance.com']) {
      expect(isBinanceHost(host), host).toBe(true);
    }
    for (const host of ['evilbinance.com', 'binance.com.evil.io', 'binance.co', 'example.com', 'binance.vision.example', '', undefined]) {
      expect(isBinanceHost(host), String(host)).toBe(false);
    }
  });

  it('UNIT-DOH-003 alamat lokal/khusus bukan IPv4 publik', () => {
    for (const ip of ['54.192.164.11', '3.113.118.97', '172.32.0.1', '100.128.0.1', '192.0.3.1']) {
      expect(isPublicIPv4(ip), ip).toBe(true);
    }
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.5.4', '172.31.255.255', '192.168.0.1', '100.64.0.1', '169.254.1.1',
      '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.2.10', '198.18.0.1', '::1', 'bukan-ip']) {
      expect(isPublicIPv4(ip), ip).toBe(false);
    }
  });

  it('UNIT-DOH-004 endpoint bawaan: https IP literal dari dua penyedia (tanpa bootstrap DNS)', () => {
    for (const endpoint of DEFAULT_DOH_ENDPOINTS) {
      const url = new URL(endpoint);
      expect(url.protocol).toBe('https:');
      expect(isIP(url.hostname)).toBe(4);
    }
    expect(new Set(DEFAULT_DOH_ENDPOINTS.map((e) => new URL(e).pathname))).toEqual(new Set(['/dns-query', '/resolve']));
  });
});

describe('parseDohAnswer', () => {
  it('UNIT-DOH-005 hanya record A publik; CNAME diabaikan; duplikat dibuang; TTL dijepit 30 dtk–10 mnt', () => {
    expect(parseDohAnswer(answer(['54.192.164.11', '54.192.164.47', '54.192.164.11'], { ttl: 120 })))
      .toEqual({ addresses: ['54.192.164.11', '54.192.164.47'], ttlMs: 120_000 });
    expect(parseDohAnswer(answer(['54.192.164.11'], { ttl: 5 })).ttlMs).toBe(30_000);
    expect(parseDohAnswer(answer(['54.192.164.11'], { ttl: 99_999 })).ttlMs).toBe(600_000);
    const noTtl = { Status: 0, Answer: [{ type: 1, data: '54.192.164.11' }] };
    expect(parseDohAnswer(noTtl).ttlMs).toBe(60_000);
    expect(parseDohAnswer(answer(['10.0.0.1', '54.192.164.11'])).addresses).toEqual(['54.192.164.11']);
  });

  it('UNIT-DOH-006 jawaban tanpa IP publik, berstatus error, atau bukan objek ditolak dengan kode jelas', () => {
    const codeOf = (body) => {
      try {
        parseDohAnswer(body);
        return null;
      } catch (err) {
        expect(err).toBeInstanceOf(DohError);
        return err.code;
      }
    };
    expect(codeOf(answer(['127.0.0.1', '192.168.1.1']))).toBe('DOH_NO_ADDRESS');
    expect(codeOf({ Status: 0 })).toBe('DOH_NO_ADDRESS');
    expect(codeOf(answer([], { status: 3 }))).toBe('DOH_STATUS');
    expect(codeOf(null)).toBe('DOH_BAD_RESPONSE');
    expect(codeOf('teks')).toBe('DOH_BAD_RESPONSE');
  });
});

describe('createDohResolver', () => {
  it('UNIT-DOH-007 bentuk permintaan benar; cache sesuai TTL (tanpa beda huruf/titik akhir); refresh setelah kedaluwarsa', async () => {
    let now = 1_000_000;
    const fetch = fakeFetch(() => response(200, answer(['54.192.164.11', '54.192.164.47'], { ttl: 120 })));
    const resolver = createDohResolver({ fetch, clock: () => now });

    expect(await resolver.resolve4('fapi.binance.com')).toEqual(['54.192.164.11', '54.192.164.47']);
    const { url, init } = fetch.calls[0];
    expect(url.origin).toBe('https://1.1.1.1');
    expect(url.pathname).toBe('/dns-query');
    expect(url.searchParams.get('name')).toBe('fapi.binance.com');
    expect(url.searchParams.get('type')).toBe('A');
    expect(init).toMatchObject({ method: 'GET', headers: { accept: 'application/dns-json' }, redirect: 'error' });
    expect(init.signal).toBeInstanceOf(AbortSignal);

    now += 119_000;
    expect(await resolver.resolve4('FAPI.binance.com.')).toEqual(['54.192.164.11', '54.192.164.47']);
    expect(fetch.calls).toHaveLength(1);

    now += 2_000;
    await resolver.resolve4('fapi.binance.com');
    expect(fetch.calls).toHaveLength(2);
    expect(resolver.endpoints).toEqual(['1.1.1.1', '8.8.8.8', '1.0.0.1', '8.8.4.4']);
  });

  it('UNIT-DOH-008 endpoint dicoba berurutan: error jaringan, HTTP 503, jawaban privat → endpoint berikutnya', async () => {
    const fetch = fakeFetch((_url, _init, n) => {
      if (n === 1) throw new Error('ECONNRESET');
      if (n === 2) return response(503, {});
      if (n === 3) return response(200, answer(['10.0.0.1']));
      return response(200, answer(['3.113.118.97']));
    });
    const resolver = createDohResolver({ fetch });
    expect(await resolver.resolve4('fstream.binance.com')).toEqual(['3.113.118.97']);
    expect(fetch.calls.map((c) => c.url.host)).toEqual(['1.1.1.1', '8.8.8.8', '1.0.0.1', '8.8.4.4']);
  });

  it('UNIT-DOH-009 semua endpoint gagal → DohError DOH_ALL_FAILED berisi alasan tiap resolver', async () => {
    const resolver = createDohResolver({ fetch: fakeFetch(() => response(500, {})) });
    const err = await resolver.resolve4('fapi.binance.com').catch((e) => e);
    expect(err).toBeInstanceOf(DohError);
    expect(err.code).toBe('DOH_ALL_FAILED');
    expect(err.message).toMatch(/1\.1\.1\.1: DoH HTTP 500/);
    expect(err.message).toMatch(/8\.8\.4\.4: DoH HTTP 500/);
  });

  it('UNIT-DOH-010 respons atau body yang menggantung kena timeout lalu pindah endpoint', async () => {
    const fetch = fakeFetch((_url, _init, n) => {
      if (n === 1) return new Promise(() => {});
      if (n === 2) return { ok: true, status: 200, json: () => new Promise(() => {}) };
      return response(200, answer(['54.192.164.36']));
    });
    const resolver = createDohResolver({ fetch, timeoutMs: 25 });
    expect(await resolver.resolve4('fapi.binance.com')).toEqual(['54.192.164.36']);
    expect(fetch.calls[0].init.signal.aborted).toBe(true);
    expect(fetch.calls[1].init.signal.aborted).toBe(true);
  });

  it('UNIT-DOH-011 stale-if-error: jawaban lama dipakai bila semua resolver gagal, hingga batas staleMs', async () => {
    let now = 0;
    let healthy = true;
    const fetch = fakeFetch(() => (healthy ? response(200, answer(['54.192.164.11'], { ttl: 60 })) : response(500, {})));
    const resolver = createDohResolver({ fetch, clock: () => now, staleMs: 600_000 });
    await resolver.resolve4('fapi.binance.com');

    healthy = false;
    now = 61_000;
    expect(await resolver.resolve4('fapi.binance.com')).toEqual(['54.192.164.11']);
    now = 661_000;
    await expect(resolver.resolve4('fapi.binance.com')).rejects.toMatchObject({ code: 'DOH_ALL_FAILED' });
  });

  it('UNIT-DOH-012 pemanggil serentak untuk host yang sama berbagi satu permintaan DoH', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const fetch = fakeFetch(async () => {
      await gate;
      return response(200, answer(['54.192.164.11']));
    });
    const resolver = createDohResolver({ fetch });
    const all = Promise.all([
      resolver.resolve4('fapi.binance.com'), resolver.resolve4('fapi.binance.com'), resolver.resolve4('FAPI.BINANCE.COM'),
    ]);
    release();
    expect(await all).toEqual([['54.192.164.11'], ['54.192.164.11'], ['54.192.164.11']]);
    expect(fetch.calls).toHaveLength(1);
  });

  it('UNIT-DOH-013 host selain Binance tidak pernah dikirim ke penyedia DoH', async () => {
    const fetch = fakeFetch(() => { throw new Error('tidak boleh dipanggil'); });
    const resolver = createDohResolver({ fetch });
    await expect(resolver.resolve4('example.com')).rejects.toThrow(TypeError);
    await expect(resolver.resolve4('binance.com.evil.io')).rejects.toThrow(/hanya untuk host Binance/);
    expect(fetch.calls).toHaveLength(0);
  });

  it('UNIT-DOH-014 opsi tidak valid ditolak saat dibuat', () => {
    const fetch = fakeFetch(() => response(200, answer(['54.192.164.11'])));
    expect(() => createDohResolver({ fetch: 'x' })).toThrow(TypeError);
    expect(() => createDohResolver({ fetch, endpoints: [] })).toThrow(TypeError);
    expect(() => createDohResolver({ fetch, endpoints: ['http://1.1.1.1/dns-query'] })).toThrow(/https/);
    expect(() => createDohResolver({ fetch, timeoutMs: 0 })).toThrow(RangeError);
    expect(() => createDohResolver({ fetch, staleMs: -1 })).toThrow(RangeError);
  });
});

describe('createBinanceLookup (lookup net/tls untuk undici)', () => {
  it('UNIT-DOH-015 host Binance → alamat DoH (opsi all, family angka, atau callback saja); IPv6-only → ENOTFOUND', async () => {
    const resolver = { resolve4: vi.fn(async () => ['54.192.164.11', '54.192.164.47']) };
    const fallbackLookup = vi.fn((_host, _opts, cb) => cb(null, '127.0.0.1', 4));
    const lookup = createBinanceLookup({ resolver, fallbackLookup });

    expect(await lookupAsync(lookup, 'fapi.binance.com', { all: true })).toEqual({
      err: null, address: [{ address: '54.192.164.11', family: 4 }, { address: '54.192.164.47', family: 4 }], family: undefined,
    });
    expect(await lookupAsync(lookup, 'fapi.binance.com', {})).toEqual({ err: null, address: '54.192.164.11', family: 4 });
    expect(await lookupAsync(lookup, 'fapi.binance.com', 4)).toEqual({ err: null, address: '54.192.164.11', family: 4 });
    const callbackOnly = await new Promise((resolve) => {
      lookup('fstream.binance.com', (err, address, family) => resolve({ err, address, family }));
    });
    expect(callbackOnly).toEqual({ err: null, address: '54.192.164.11', family: 4 });

    const v6 = await lookupAsync(lookup, 'fapi.binance.com', { family: 6 });
    expect(v6.err.code).toBe('ENOTFOUND');
    expect(resolver.resolve4).toHaveBeenCalledTimes(4);
    expect(fallbackLookup).not.toHaveBeenCalled();
  });

  it('UNIT-DOH-016 host lain dan IP literal memakai resolver sistem, tanpa menyentuh DoH', async () => {
    const resolver = { resolve4: vi.fn(async () => ['54.192.164.11']) };
    const fallbackLookup = vi.fn((_host, _opts, cb) => cb(null, '93.184.216.34', 4));
    const lookup = createBinanceLookup({ resolver, fallbackLookup });
    expect((await lookupAsync(lookup, 'api.etherscan.io', { all: false })).address).toBe('93.184.216.34');
    await lookupAsync(lookup, '54.192.164.11', {});
    expect(fallbackLookup.mock.calls.map((c) => c[0])).toEqual(['api.etherscan.io', '54.192.164.11']);
    expect(resolver.resolve4).not.toHaveBeenCalled();
  });

  it('UNIT-DOH-017 DoH gagal total → resolver sistem; peringatan paling sering sekali per menit', async () => {
    let now = 0;
    const resolver = { resolve4: vi.fn(async () => { throw new DohError('semua resolver DoH gagal', { code: 'DOH_ALL_FAILED' }); }) };
    const fallbackLookup = vi.fn((_host, _opts, cb) => cb(null, '54.192.164.47', 4));
    const logger = { warn: vi.fn() };
    const lookup = createBinanceLookup({ resolver, fallbackLookup, logger, clock: () => now });

    expect(await lookupAsync(lookup, 'fapi.binance.com', {})).toEqual({ err: null, address: '54.192.164.47', family: 4 });
    expect(fallbackLookup).toHaveBeenCalledWith('fapi.binance.com', {}, expect.any(Function));
    await lookupAsync(lookup, 'fapi.binance.com', {});
    expect(logger.warn).toHaveBeenCalledTimes(1);
    now = 60_000;
    await lookupAsync(lookup, 'fapi.binance.com', {});
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls[0][1]).toMatch(/DoH Binance gagal/);
  });

  it('UNIT-DOH-018 resolver wajib ada', () => {
    expect(() => createBinanceLookup({})).toThrow(TypeError);
    expect(() => createBinanceLookup({ resolver: { resolve4: async () => [] }, fallbackLookup: 1 })).toThrow(TypeError);
  });
});
