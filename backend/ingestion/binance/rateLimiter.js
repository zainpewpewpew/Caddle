// Pembatas bobot request Binance USDT-M Futures (REQUEST_WEIGHT per menit per IP).
// Binance menghitung bobot dalam jendela tetap per menit UTC dan melaporkannya lewat header
// X-MBX-USED-WEIGHT-1M. Pembatas ini mencadangkan bobot perkiraan sebelum request, lalu
// menyelaraskannya dengan header (nilai terbesar menang — konservatif). Jam & sleep diinjeksi.

import { BinanceApiError, ERROR_CODES } from './errors.js';

export const WEIGHT_WINDOW_MS = 60_000;
export const USED_WEIGHT_HEADER = 'x-mbx-used-weight-1m';

/** Bobot perkiraan endpoint tanpa parameter symbol (dokumentasi Binance USDT-M). */
export const ENDPOINT_WEIGHTS = Object.freeze({
  time: 1,
  exchangeInfo: 1,
  ticker24hAll: 40,
  bookTickerAll: 5,
});

/**
 * Bobot GET /fapi/v1/klines menurut parameter limit: <100 → 1, <500 → 2, ≤1000 → 5, >1000 → 10.
 * @param {number} limit bilangan bulat 1..1500
 */
export function klinesWeight(limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1500) throw new RangeError('limit klines harus bilangan bulat 1..1500');
  if (limit < 100) return 1;
  if (limit < 500) return 2;
  if (limit <= 1000) return 5;
  return 10;
}

/**
 * Parse nilai header X-MBX-USED-WEIGHT-1M.
 * @returns {number|null} null bila header tidak ada atau bukan bilangan bulat ≥ 0
 */
export function parseUsedWeightHeader(value) {
  if (typeof value !== 'string' || !/^\d{1,9}$/.test(value)) return null;
  return Number(value);
}

/**
 * Buat pembatas bobot per jendela menit.
 * @param {{ maxWeightPerMinute: number, clock: () => number, sleep: (ms: number) => Promise<void>,
 *           windowMs?: number }} options
 * @returns {{
 *   acquire(weight: number, opts?: { maxBlockWaitMs?: number }): Promise<{ windowStart: number }>,
 *   record(usedWeight: number|null, ticket?: { windowStart: number }): void,
 *   blockUntil(until: number, status?: number|null): void,
 *   blockedForMs(): number,
 *   usedWeight(): number,
 * }}
 */
export function createWeightLimiter({ maxWeightPerMinute, clock, sleep, windowMs = WEIGHT_WINDOW_MS }) {
  if (!Number.isInteger(maxWeightPerMinute) || maxWeightPerMinute < 1) throw new RangeError('maxWeightPerMinute harus bilangan bulat ≥ 1');
  if (!Number.isInteger(windowMs) || windowMs < 1) throw new RangeError('windowMs harus bilangan bulat ≥ 1');
  if (typeof clock !== 'function') throw new TypeError('clock wajib fungsi');
  if (typeof sleep !== 'function') throw new TypeError('sleep wajib fungsi');

  const windowOf = (t) => Math.floor(t / windowMs) * windowMs;
  let windowStart = windowOf(clock());
  let used = 0;
  let blockedUntil = 0;
  let blockStatus = null;

  function roll(now) {
    const current = windowOf(now);
    if (current > windowStart) {
      windowStart = current;
      used = 0;
    }
  }

  return {
    /**
     * Cadangkan `weight` di jendela berjalan; tidur bila jendela penuh atau klien sedang diblokir.
     * Bobot tunggal > batas tetap dijalankan sendirian pada jendela kosong (mencegah deadlock).
     * Bila blokir tersisa > maxBlockWaitMs, lempar BinanceApiError retryable (tanpa tidur).
     */
    async acquire(weight, { maxBlockWaitMs = Number.POSITIVE_INFINITY } = {}) {
      if (!Number.isInteger(weight) || weight < 1) throw new RangeError('Bobot request harus bilangan bulat ≥ 1');
      for (;;) {
        const now = clock();
        if (now < blockedUntil) {
          const remaining = blockedUntil - now;
          if (remaining > maxBlockWaitMs) {
            throw new BinanceApiError(`Request Binance ditahan ${Math.ceil(remaining / 1000)} detik setelah rate limit`, {
              status: blockStatus, code: ERROR_CODES.RATE_LIMIT_BLOCKED, retryable: true, retryAfterMs: remaining,
            });
          }
          await sleep(remaining);
          continue;
        }
        roll(now);
        if (used > 0 && used + weight > maxWeightPerMinute) {
          await sleep(Math.max(1, windowStart + windowMs - now));
          continue;
        }
        used += weight;
        return { windowStart };
      }
    },

    /** Selaraskan dengan header Binance; diabaikan bila tiket berasal dari jendela sebelumnya. */
    record(usedWeight, ticket) {
      if (!Number.isInteger(usedWeight) || usedWeight < 0) return;
      roll(clock());
      if (ticket && ticket.windowStart !== windowStart) return;
      used = Math.max(used, usedWeight);
    },

    /** Tahan semua request sampai `until` (epoch ms). Blokir yang lebih lama tidak diperpendek. */
    blockUntil(until, status = null) {
      if (!Number.isFinite(until) || until <= blockedUntil) return;
      blockedUntil = until;
      blockStatus = status;
    },

    blockedForMs() {
      return Math.max(0, blockedUntil - clock());
    },

    usedWeight() {
      roll(clock());
      return used;
    },
  };
}
