// Pembatas laju & kuota harian bersama untuk adapter provider smart money. Jam dan fungsi tidur diinjeksi agar dapat
// diuji deterministik. Batas di sini sengaja di bawah batas resmi provider (lihat docs/14) supaya ada ruang aman.

import { ProviderError } from './errors.js';

const DAY_MS = 86_400_000;
const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Pembatas interval minimum antarpanggilan (antrean FIFO). `ratePerSec` 2 → paling cepat satu panggilan per 500 ms.
 * @param {{ ratePerSec?: number, perMinute?: number, clock?: () => number, sleep?: (ms: number) => Promise<void> }} options
 *   isi salah satu: `ratePerSec` atau `perMinute`
 * @returns {{ schedule: <T>(fn: () => Promise<T>) => Promise<T>, intervalMs: number }}
 */
export function createThrottle({ ratePerSec, perMinute, clock = Date.now, sleep = defaultSleep } = {}) {
  const intervalMs = perMinute !== undefined ? 60_000 / perMinute : 1000 / ratePerSec;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new RangeError('Laju throttle harus > 0');
  let nextAt = 0;
  let chain = Promise.resolve();

  function schedule(fn) {
    const run = async () => {
      const wait = nextAt - clock();
      if (wait > 0) await sleep(wait);
      nextAt = Math.max(clock(), nextAt) + intervalMs;
      return fn();
    };
    const result = chain.then(run, run);
    // Antrean tetap berjalan walau satu panggilan gagal; kegagalan diteruskan ke pemanggilnya sendiri.
    chain = result.catch(() => {});
    return result;
  }

  return { schedule, intervalMs };
}

/**
 * Penghitung kuota harian (hari UTC). `take()` melempar ProviderError RATE_LIMITED bila kuota habis, dengan
 * retryAfterMs sampai pergantian hari UTC.
 * @param {{ limit: number, provider: string, clock?: () => number }} options
 */
export function createDailyBudget({ limit, provider, clock = Date.now }) {
  if (!Number.isInteger(limit) || limit <= 0) throw new RangeError('Kuota harian harus bilangan bulat > 0');
  let day = Math.floor(clock() / DAY_MS);
  let used = 0;

  function roll() {
    const today = Math.floor(clock() / DAY_MS);
    if (today !== day) {
      day = today;
      used = 0;
    }
  }

  return {
    take(n = 1) {
      roll();
      if (used + n > limit) {
        throw new ProviderError('RATE_LIMITED', `${provider}: kuota harian ${limit} panggilan habis`, {
          provider, retryAfterMs: (day + 1) * DAY_MS - clock(),
        });
      }
      used += n;
    },
    status() {
      roll();
      return { limit, used, remaining: limit - used, resetsAt: (day + 1) * DAY_MS };
    },
  };
}
