// DNS-over-HTTPS (DoH) khusus host Binance.
//
// Latar (diukur di Mac pemilik, 2026-11-15): ISP membajak DNS *.binance.com. Resolver sistem DAN DNS biasa ke
// 1.1.1.1 / 8.8.8.8 / 9.9.9.9 (port 53) dijawab IP halaman blokir atau dibuang, sedangkan HTTPS/WebSocket ke IP asli
// Binance tetap lancar. Sebelumnya scanner hanya jalan setelah WARP dinyalakan; modul ini membuat itu tidak perlu.
//
// Cara kerja: HANYA host Binance (*.binance.com, *.binance.vision) di-resolve lewat DoH ke resolver publik yang
// dipanggil dengan IP literal (tanpa bootstrap DNS). Host lain tetap memakai resolver sistem. TLS tidak berubah:
// SNI dan verifikasi sertifikat tetap memakai nama host asli; DoH hanya memilih alamat IP tujuan, jadi jawaban DoH
// yang salah paling buruk membuat koneksi gagal, bukan membelokkan data.
//
// Mode diatur BINANCE_DNS: 'doh' (default) | 'system' (resolver sistem saja, perilaku lama). Lihat network.js.

import dns from 'node:dns';
import { BlockList, isIP, isIPv4 } from 'node:net';

export const BINANCE_DNS_MODES = Object.freeze(['doh', 'system']);
export const DEFAULT_BINANCE_DNS_MODE = 'doh';

/**
 * Resolver DoH format JSON, dipanggil lewat IP literal (sertifikatnya memuat IP SAN). Dua penyedia berselang-seling
 * agar gangguan satu penyedia tidak memutus scanner. Diukur dari jaringan pemilik: keempatnya terjangkau tanpa WARP.
 */
export const DEFAULT_DOH_ENDPOINTS = Object.freeze([
  'https://1.1.1.1/dns-query',
  'https://8.8.8.8/resolve',
  'https://1.0.0.1/dns-query',
  'https://8.8.4.4/resolve',
]);

const BINANCE_DOMAINS = Object.freeze(['binance.com', 'binance.vision']);
const MIN_TTL_MS = 30_000;
const MAX_TTL_MS = 600_000;
const DEFAULT_TTL_SECONDS = 60;
const DEFAULT_TIMEOUT_MS = 4_000;
/** Bila semua resolver DoH gagal, jawaban terakhir yang sudah kedaluwarsa masih dipakai selama ini. */
const DEFAULT_STALE_MS = 3_600_000;
const FALLBACK_WARN_INTERVAL_MS = 60_000;

// Jawaban yang menunjuk jaringan lokal/khusus ditolak (defense in depth; sertifikat Binance tetap diverifikasi).
const NON_PUBLIC_V4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) {
  NON_PUBLIC_V4.addSubnet(network, prefix, 'ipv4');
}

export class DohError extends Error {
  /** @param {string} message @param {{ code?: string }} [options] */
  constructor(message, { code = 'DOH_FAILED' } = {}) {
    super(message);
    this.name = 'DohError';
    this.code = code;
  }
}

/**
 * BINANCE_DNS → mode. Kosong → 'doh'. Selain 'doh'/'system' (huruf kecil) ditolak agar salah ketik tidak diam-diam
 * mengubah perilaku jaringan.
 * @param {unknown} raw
 * @returns {'doh'|'system'}
 */
export function parseBinanceDnsMode(raw) {
  const value = raw === undefined || raw === null ? '' : String(raw).trim();
  if (value === '') return DEFAULT_BINANCE_DNS_MODE;
  if (!BINANCE_DNS_MODES.includes(value)) {
    throw new TypeError(`BINANCE_DNS harus salah satu dari: ${BINANCE_DNS_MODES.join(', ')}`);
  }
  return /** @type {'doh'|'system'} */ (value);
}

/** true untuk binance.com, binance.vision, dan subdomainnya (mis. fapi.binance.com, data.binance.vision). */
export function isBinanceHost(hostname) {
  if (typeof hostname !== 'string' || hostname === '') return false;
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return BINANCE_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** IPv4 unicast publik (bukan privat, loopback, link-local, CGNAT, dokumentasi, multicast, atau cadangan). */
export function isPublicIPv4(address) {
  return isIPv4(address) && !NON_PUBLIC_V4.check(address, 'ipv4');
}

/**
 * Jawaban DoH JSON (format bersama Cloudflare & Google) → alamat IPv4 publik + TTL (dijepit 30 dtk–10 mnt).
 * Rantai CNAME diabaikan; yang dipakai hanya record A di bagian Answer.
 * @param {unknown} body
 * @returns {{ addresses: string[], ttlMs: number }}
 */
export function parseDohAnswer(body) {
  if (body === null || typeof body !== 'object') {
    throw new DohError('jawaban DoH bukan objek JSON', { code: 'DOH_BAD_RESPONSE' });
  }
  const { Status: status, Answer: answer } = /** @type {{ Status?: unknown, Answer?: unknown }} */ (body);
  if (status !== 0) {
    throw new DohError(`jawaban DoH berstatus ${Number.isInteger(status) ? status : 'tidak dikenal'}`, { code: 'DOH_STATUS' });
  }
  const records = (Array.isArray(answer) ? answer : []).filter((r) => r !== null && typeof r === 'object'
    && r.type === 1 && typeof r.data === 'string' && isPublicIPv4(r.data));
  if (records.length === 0) throw new DohError('jawaban DoH tanpa alamat IPv4 publik', { code: 'DOH_NO_ADDRESS' });
  const addresses = [...new Set(records.map((r) => r.data))];
  const ttlSeconds = Math.min(...records.map((r) => (Number.isFinite(r.TTL) && r.TTL >= 0 ? r.TTL : DEFAULT_TTL_SECONDS)));
  return { addresses, ttlMs: Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, ttlSeconds * 1000)) };
}

/**
 * Resolver DoH: cache sesuai TTL, satu permintaan untuk pemanggil serentak, endpoint dicoba berurutan, dan
 * stale-if-error (jawaban lama dipakai bila semua endpoint gagal, hingga `staleMs` setelah kedaluwarsa).
 * @param {{
 *   fetch?: typeof globalThis.fetch, endpoints?: readonly string[], clock?: () => number,
 *   timeoutMs?: number, staleMs?: number,
 * }} [options]
 * @returns {{ resolve4(hostname: string): Promise<string[]>, endpoints: readonly string[] }}
 */
export function createDohResolver({
  fetch: fetchImpl = globalThis.fetch,
  endpoints = DEFAULT_DOH_ENDPOINTS,
  clock = Date.now,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  staleMs = DEFAULT_STALE_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch wajib fungsi');
  if (typeof clock !== 'function') throw new TypeError('clock wajib fungsi');
  if (!Array.isArray(endpoints) || endpoints.length === 0) throw new TypeError('endpoints DoH wajib array tidak kosong');
  const urls = endpoints.map((endpoint) => {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:') throw new TypeError('endpoint DoH wajib https');
    return url;
  });
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new RangeError('timeoutMs harus bilangan bulat ≥ 1');
  if (!Number.isInteger(staleMs) || staleMs < 0) throw new RangeError('staleMs harus bilangan bulat ≥ 0');

  /** @type {Map<string, { addresses: readonly string[], expiresAt: number, staleUntil: number }>} */
  const cache = new Map();
  /** @type {Map<string, Promise<{ addresses: readonly string[] }>>} */
  const inflight = new Map();

  /** Satu pertanyaan ke satu endpoint; timeout mencakup koneksi hingga body selesai dibaca. */
  async function queryOnce(endpoint, host) {
    const url = new URL(endpoint);
    url.searchParams.set('name', host);
    url.searchParams.set('type', 'A');
    const controller = new AbortController();
    let timer;
    const timedOut = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new DohError(`DoH timeout setelah ${timeoutMs} ms`, { code: 'DOH_TIMEOUT' }));
      }, timeoutMs);
    });
    // Race juga melindungi dari fetch/body yang mengabaikan AbortSignal.
    const guard = (promise) => Promise.race([promise, timedOut]);
    try {
      const res = await guard(fetchImpl(url.href, {
        method: 'GET',
        headers: { accept: 'application/dns-json' },
        redirect: 'error',
        signal: controller.signal,
      }));
      if (res === null || typeof res !== 'object' || typeof res.status !== 'number' || typeof res.json !== 'function') {
        throw new DohError('respons DoH tidak valid', { code: 'DOH_BAD_RESPONSE' });
      }
      if (!res.ok) throw new DohError(`DoH HTTP ${res.status}`, { code: 'DOH_HTTP' });
      return parseDohAnswer(await guard(res.json()));
    } catch (err) {
      if (err instanceof DohError) throw err;
      if (err instanceof SyntaxError) throw new DohError('jawaban DoH bukan JSON', { code: 'DOH_BAD_RESPONSE' });
      throw new DohError('DoH gagal: kesalahan jaringan', { code: 'DOH_NETWORK' });
    } finally {
      clearTimeout(timer);
    }
  }

  async function refresh(host) {
    const failures = [];
    for (const endpoint of urls) {
      try {
        const { addresses, ttlMs } = await queryOnce(endpoint, host);
        const now = clock();
        const entry = Object.freeze({
          addresses: Object.freeze(addresses), expiresAt: now + ttlMs, staleUntil: now + ttlMs + staleMs,
        });
        cache.set(host, entry);
        return entry;
      } catch (err) {
        failures.push(`${endpoint.host}: ${err.message}`);
      }
    }
    throw new DohError(`semua resolver DoH gagal untuk ${host} (${failures.join('; ')})`, { code: 'DOH_ALL_FAILED' });
  }

  return Object.freeze({
    endpoints: Object.freeze(urls.map((url) => url.host)),

    /** @param {string} hostname host Binance @returns {Promise<string[]>} alamat IPv4 publik */
    async resolve4(hostname) {
      // Nama host lain tidak pernah dikirim ke penyedia DoH.
      if (!isBinanceHost(hostname)) throw new TypeError('DoH hanya untuk host Binance');
      const host = hostname.toLowerCase().replace(/\.$/, '');
      const cached = cache.get(host);
      if (cached && cached.expiresAt > clock()) return [...cached.addresses];
      let pending = inflight.get(host);
      if (!pending) {
        pending = refresh(host).finally(() => inflight.delete(host));
        inflight.set(host, pending);
      }
      try {
        return [...(await pending).addresses];
      } catch (err) {
        if (cached && cached.staleUntil > clock()) return [...cached.addresses];
        throw err;
      }
    },
  });
}

const notFound = (hostname) => Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND', hostname });

/**
 * Fungsi `lookup` untuk net/tls.connect (dipasang di undici Agent): host Binance → DoH; host lain dan IP literal →
 * `fallbackLookup` (resolver sistem). Bila DoH gagal total dan tidak ada cache, jatuh ke resolver sistem agar jaringan
 * yang tidak memblokir DNS tetap jalan (peringatan dicatat paling sering sekali per menit).
 * @param {{ resolver: { resolve4(hostname: string): Promise<string[]> }, fallbackLookup?: Function,
 *   logger?: { warn?: Function }, clock?: () => number }} options
 */
export function createBinanceLookup({ resolver, fallbackLookup = dns.lookup, logger, clock = Date.now } = {}) {
  if (!resolver || typeof resolver.resolve4 !== 'function') throw new TypeError('resolver wajib punya resolve4');
  if (typeof fallbackLookup !== 'function') throw new TypeError('fallbackLookup wajib fungsi');
  let lastWarnAt = -Infinity;

  return function binanceLookup(hostname, options, callback) {
    let opts = options;
    let done = callback;
    if (typeof opts === 'function') {
      done = opts;
      opts = {};
    }
    const normalized = typeof opts === 'number' ? { family: opts } : (opts ?? {});
    if (isIP(hostname) !== 0 || !isBinanceHost(hostname)) {
      fallbackLookup(hostname, normalized, done);
      return;
    }
    if (normalized.family === 6 || normalized.family === 'IPv6') {
      // DoH di sini hanya IPv4; permintaan khusus IPv6 dijawab "tidak ditemukan" (seperti host tanpa AAAA).
      process.nextTick(done, notFound(hostname));
      return;
    }
    // Callback dipanggil di luar rantai promise: error di dalamnya tidak tertelan sebagai rejection.
    resolver.resolve4(hostname).then(
      (addresses) => process.nextTick(() => {
        if (normalized.all) done(null, addresses.map((address) => ({ address, family: 4 })));
        else done(null, addresses[0], 4);
      }),
      (err) => process.nextTick(() => {
        const now = clock();
        if (now - lastWarnAt >= FALLBACK_WARN_INTERVAL_MS) {
          lastWarnAt = now;
          if (typeof logger?.warn === 'function') {
            logger.warn({ host: hostname, err: err?.message }, 'DoH Binance gagal; memakai resolver sistem');
          }
        }
        fallbackLookup(hostname, normalized, done);
      }),
    );
  };
}
