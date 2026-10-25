// Error terstruktur untuk klien Binance USDT-M Futures.
// Teks dari respons eksternal (msg Binance, nilai field) dipotong dan dibersihkan dari
// karakter kontrol sebelum masuk ke pesan error/log — data Binance tidak tepercaya.

/**
 * Kode error lokal (string) untuk kegagalan yang tidak membawa kode numerik Binance.
 * Bila body error Binance memuat `code` numerik (mis. -1121, -1003), kode itulah yang dipakai.
 */
export const ERROR_CODES = Object.freeze({
  TIMEOUT: 'TIMEOUT',
  NETWORK: 'NETWORK',
  BAD_RESPONSE: 'BAD_RESPONSE',
  HTTP_ERROR: 'HTTP_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
  IP_BANNED: 'IP_BANNED',
  RATE_LIMIT_BLOCKED: 'RATE_LIMIT_BLOCKED',
});

const MAX_TEXT = 200;

/** Potong & buang karakter kontrol dari teks eksternal. */
export function sanitizeText(value, max = MAX_TEXT) {
  const text = String(value);
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    out += cp < 0x20 || cp === 0x7f ? ' ' : ch;
    if (out.length >= max) return `${out.slice(0, max)}…`;
  }
  return out;
}

/**
 * Kegagalan memanggil API Binance (HTTP, timeout, jaringan, rate limit).
 * - `status`: status HTTP, atau null bila tidak ada respons (timeout/jaringan).
 * - `code`: kode numerik Binance bila ada di body, selain itu salah satu ERROR_CODES.
 * - `retryable`: true bila permintaan yang sama boleh diulang nanti.
 * - `retryAfterMs`: jeda minimum sebelum mengulang (dari header Retry-After), atau null.
 */
export class BinanceApiError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number|null, code?: number|string|null, retryable?: boolean,
   *           retryAfterMs?: number|null, path?: string|null, cause?: unknown }} [details]
   */
  constructor(message, { status = null, code = null, retryable = false, retryAfterMs = null, path = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'BinanceApiError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.path = path;
  }
}

/**
 * Respons Binance berhasil diterima tetapi isinya tidak sesuai format (baris kline rusak,
 * field hilang, angka tidak valid). Tidak pernah diulang otomatis dan tidak pernah
 * "diperbaiki" diam-diam: seluruh batch ditolak dengan daftar masalah per baris.
 * `issues`: [{ index, field, reason, value }] — index = posisi baris (null untuk level respons).
 */
export class BinanceDataError extends Error {
  /**
   * @param {string} message
   * @param {{ path?: string|null, issues?: Array<{ index: number|null, field: string|null, reason: string, value?: string }> }} [details]
   */
  constructor(message, { path = null, issues = [] } = {}) {
    super(message);
    this.name = 'BinanceDataError';
    this.path = path;
    this.issues = issues;
    this.retryable = false;
  }
}
