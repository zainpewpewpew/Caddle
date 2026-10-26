import { describe, expect, it } from 'vitest';
import { ProviderError } from '../../../backend/smartmoney/providers/errors.js';
import { createDailyBudget, createThrottle } from '../../../backend/smartmoney/providers/throttle.js';

function fakeTime(start = 1_000_000) {
  let now = start;
  const slept = [];
  return {
    clock: () => now,
    sleep: async (ms) => { slept.push(ms); now += ms; },
    advance: (ms) => { now += ms; },
    slept,
  };
}

describe('throttle provider smart money', () => {
  it('UNIT-SM-THR-001 panggilan berurutan dijeda sesuai laju (2/detik = 500 ms)', async () => {
    const t = fakeTime();
    const throttle = createThrottle({ ratePerSec: 2, clock: t.clock, sleep: t.sleep });
    const calls = [];
    await Promise.all([1, 2, 3].map((i) => throttle.schedule(async () => { calls.push([i, t.clock()]); })));
    expect(calls.map((c) => c[0])).toEqual([1, 2, 3]);
    expect(calls[1][1] - calls[0][1]).toBe(500);
    expect(calls[2][1] - calls[1][1]).toBe(500);
  });

  it('UNIT-SM-THR-002 perMinute 6 → jeda 10 detik; kegagalan satu panggilan tidak menghentikan antrean', async () => {
    const t = fakeTime();
    const throttle = createThrottle({ perMinute: 6, clock: t.clock, sleep: t.sleep });
    expect(throttle.intervalMs).toBe(10_000);
    const failing = throttle.schedule(async () => { throw new Error('gagal'); });
    const ok = throttle.schedule(async () => 'ok');
    await expect(failing).rejects.toThrow('gagal');
    await expect(ok).resolves.toBe('ok');
    expect(t.slept).toEqual([10_000]);
  });

  it('UNIT-SM-THR-003 laju tidak valid ditolak', () => {
    expect(() => createThrottle({ ratePerSec: 0 })).toThrow(RangeError);
  });

  it('UNIT-SM-THR-004 kuota harian habis → RATE_LIMITED sampai pergantian hari UTC, lalu pulih', () => {
    const t = fakeTime(Date.UTC(2026, 9, 26, 23, 0, 0));
    const budget = createDailyBudget({ limit: 2, provider: 'etherscan', clock: t.clock });
    budget.take();
    budget.take();
    let error;
    try { budget.take(); } catch (err) { error = err; }
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.retryAfterMs).toBe(3_600_000);
    t.advance(3_600_000);
    expect(() => budget.take()).not.toThrow();
    expect(budget.status()).toMatchObject({ limit: 2, used: 1, remaining: 1 });
  });
});
