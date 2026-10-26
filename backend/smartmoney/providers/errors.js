// Error provider data smart money. Semua kegagalan adapter dinormalkan menjadi ProviderError dengan `code` ∈
// PROVIDER_ERROR_CODES sehingga layanan sinkronisasi & API tidak pernah meneruskan error mentah (yang bisa memuat
// URL berkunci API atau isi respons pihak ketiga).

import { PROVIDER_ERROR_CODES } from '../contracts.js';

const SECRET_PARAM_RE = /([?&](?:api[-_]?key|apikey|key|token|access[-_]?token|auth|secret|signature)=)[^&#\s"']*/gi;
const MESSAGE_MAX = 300;

/** Samarkan nilai parameter query yang tampak seperti kunci API dalam teks bebas (mis. URL di pesan error). */
export function redactSecrets(text) {
  return String(text).replace(SECRET_PARAM_RE, '$1REDACTED');
}

const DEFAULT_MESSAGES = Object.freeze({
  RATE_LIMITED: 'Batas permintaan provider tercapai',
  UNAUTHORIZED: 'Kunci API provider ditolak atau tidak memiliki akses',
  UNAVAILABLE: 'Provider tidak tersedia',
  BAD_RESPONSE: 'Respons provider tidak valid',
  TIMEOUT: 'Permintaan ke provider melewati batas waktu',
  NOT_SUPPORTED: 'Fitur tidak didukung provider ini',
  NOT_CONFIGURED: 'Provider belum dikonfigurasi',
});

export class ProviderError extends Error {
  /**
   * @param {string} code salah satu PROVIDER_ERROR_CODES
   * @param {string} [message] pesan Bahasa Indonesia (nilai kunci API di URL otomatis disamarkan)
   * @param {{ provider?: string|null, retryAfterMs?: number|null, status?: number|null }} [options]
   */
  constructor(code, message, { provider = null, retryAfterMs = null, status = null } = {}) {
    if (!PROVIDER_ERROR_CODES.includes(code)) throw new RangeError(`Kode error provider tidak dikenal: ${String(code)}`);
    super(redactSecrets(message ?? DEFAULT_MESSAGES[code]).slice(0, MESSAGE_MAX));
    this.name = 'ProviderError';
    this.code = code;
    this.provider = provider;
    this.retryAfterMs = Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : null;
    this.status = Number.isInteger(status) ? status : null;
  }

  /** Bentuk aman untuk API / status provider. */
  toJSON() {
    return { provider: this.provider, code: this.code, retryAfterMs: this.retryAfterMs, message: this.message };
  }
}

/**
 * Header Retry-After (detik atau tanggal HTTP) → milidetik, atau null bila tidak ada / tidak valid.
 * @param {string|null|undefined} value
 * @param {{ now?: number }} [options] waktu sekarang untuk bentuk tanggal HTTP
 */
export function parseRetryAfter(value, { now = Date.now() } = {}) {
  if (value === null || value === undefined) return null;
  const v = String(value).trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** Kode error untuk status HTTP non-2xx. */
export function codeForStatus(status) {
  if (status === 401 || status === 403) return 'UNAUTHORIZED';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'UNAVAILABLE';
  return 'BAD_RESPONSE';
}

function headerOf(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name] ?? null;
}

/**
 * Normalkan error apa pun menjadi ProviderError:
 * AbortError/TimeoutError → TIMEOUT; HTTP 401/403 → UNAUTHORIZED; 429 → RATE_LIMITED (+ Retry-After);
 * 5xx → UNAVAILABLE; 4xx lain & JSON rusak (SyntaxError) → BAD_RESPONSE; error jaringan/lain → UNAVAILABLE.
 * ProviderError yang sudah ada dikembalikan apa adanya (provider diisi bila kosong).
 * @param {unknown} err
 * @param {string} provider id adapter
 * @returns {ProviderError}
 */
export function toProviderError(err, provider) {
  if (err instanceof ProviderError) {
    if (err.provider === null) err.provider = provider;
    return err;
  }
  const name = err?.name;
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new ProviderError('TIMEOUT', `${provider}: permintaan dibatalkan atau melewati batas waktu`, { provider });
  }
  const status = Number.isInteger(err?.status) ? err.status : Number.isInteger(err?.statusCode) ? err.statusCode : null;
  if (status !== null && status >= 400) {
    const code = codeForStatus(status);
    const retryAfterMs = code === 'RATE_LIMITED' ? (err.retryAfterMs ?? parseRetryAfter(headerOf(err.headers, 'retry-after'))) : null;
    return new ProviderError(code, `${provider}: HTTP ${status}`, { provider, retryAfterMs, status });
  }
  if (err instanceof SyntaxError) return new ProviderError('BAD_RESPONSE', `${provider}: respons bukan JSON yang valid`, { provider });
  const detail = err instanceof Error && err.message ? `: ${err.message}` : '';
  return new ProviderError('UNAVAILABLE', `${provider}: gagal menghubungi provider${detail}`, { provider });
}
