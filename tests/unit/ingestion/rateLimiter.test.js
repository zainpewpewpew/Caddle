import { describe, expect, it } from 'vitest';
import { BinanceApiError, ERROR_CODES } from '../../../backend/ingestion/binance/errors.js';
import {
  ENDPOINT_WEIGHTS, createWeightLimiter, klinesWeight, parseUsedWeightHeader,
} from '../../../backend/ingestion/binance/rateLimiter.js';

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 0, 1, 0, 0, 10); // 10 detik setelah batas menit

/** Jam manual + sleep yang langsung memajukan jam (deterministik). */
function createTime(start = T0) {
  let now = start;
  const sleeps = [];
  const clock = () => now;
  const sleep = async (ms) => { sleeps.push(ms); now += ms; };
  return { clock, sleep, sleeps, advance: (ms) => { now += ms; } };
}

/** Jam manual + sleep yang menunggu sampai tes memajukan waktu (untuk uji konkurensi). */
function createManualTimers(start = T0) {
  let now = start;
  const pending = [];
  return {
    clock: () => now,
    sleep: (ms) => new Promise((resolve) => { pending.push({ at: now + ms, resolve }); }),
    pendingCount: () => pending.length,
    async advanceTo(t) {
      now = t;
      // resolve berurutan FIFO agar urutan kelanjutan deterministik
      const due = pending.filter((p) => p.at <= now);
      for (const p of due) pending.splice(pending.indexOf(p), 1);
      for (const p of due) p.resolve();
      // beri kesempatan microtask berjalan
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    },
  };
}

describe('pembatas bobot Binance', () => {
  it('UNIT-BNL-001 bobot klines mengikuti tabel limit Binance; bobot endpoint lain', () => {
    expect([1, 99, 100, 499, 500, 1000, 1001, 1500].map(klinesWeight)).toEqual([1, 1, 2, 2, 5, 5, 10, 10]);
    expect(ENDPOINT_WEIGHTS).toEqual({ time: 1, exchangeInfo: 1, ticker24hAll: 40, bookTickerAll: 5 });
    expect(() => klinesWeight(0)).toThrow(RangeError);
    expect(() => klinesWeight(1501)).toThrow(RangeError);
    expect(() => klinesWeight(2.5)).toThrow(RangeError);
  });

  it('UNIT-BNL-002 di bawah batas: tidak tidur, bobot terakumulasi', async () => {
    const t = createTime();
    const limiter = createWeightLimiter({ maxWeightPerMinute: 100, clock: t.clock, sleep: t.sleep });
    await limiter.acquire(40);
    await limiter.acquire(40);
    expect(limiter.usedWeight()).toBe(80);
    expect(t.sleeps).toEqual([]);
  });

  it('UNIT-BNL-003 melewati batas → tidur sampai jendela menit berikutnya, lalu jendela direset', async () => {
    const t = createTime();
    const limiter = createWeightLimiter({ maxWeightPerMinute: 100, clock: t.clock, sleep: t.sleep });
    await limiter.acquire(90);
    await limiter.acquire(20);
    expect(t.sleeps).toEqual([50_000]);
    expect(t.clock()).toBe(Date.UTC(2026, 0, 1, 0, 1, 0));
    expect(limiter.usedWeight()).toBe(20);
  });

  it('EDGE-BNL-001 tepat sama dengan batas diizinkan; +1 menunggu', async () => {
    const t = createTime();
    const limiter = createWeightLimiter({ maxWeightPerMinute: 100, clock: t.clock, sleep: t.sleep });
    await limiter.acquire(60);
    await limiter.acquire(40);
    expect(t.sleeps).toEqual([]);
    await limiter.acquire(1);
    expect(t.sleeps).toEqual([50_000]);
  });

  it('EDGE-BNL-002 satu bobot melebihi batas pada jendela kosong tetap jalan (tanpa deadlock)', async () => {
    const t = createTime();
    const limiter = createWeightLimiter({ maxWeightPerMinute: 30, clock: t.clock, sleep: t.sleep });
    await limiter.acquire(40);
    expect(t.sleeps).toEqual([]);
    await limiter.acquire(1);
    expect(t.sleeps).toEqual([50_000]);
  });

  it('UNIT-BNL-004 header X-MBX-USED-WEIGHT-1M menaikkan pemakaian; nilai lebih kecil tidak menurunkan; header jendela lama diabaikan', async () => {
    const t = createTime();
    const limiter = createWeightLimiter({ maxWeightPerMinute: 1800, clock: t.clock, sleep: t.sleep });
    const ticket = await limiter.acquire(5);
    limiter.record(1795, ticket);
    expect(limiter.usedWeight()).toBe(1795);
    limiter.record(10, ticket);
    expect(limiter.usedWeight()).toBe(1795);
    await limiter.acquire(40);
    expect(t.sleeps).toEqual([50_000]);
    expect(limiter.usedWeight()).toBe(40);
    limiter.record(1700, ticket); // tiket dari jendela sebelumnya
    expect(limiter.usedWeight()).toBe(40);
  });

  it('UNIT-BNL-005 jendela bergulir: usedWeight kembali 0 setelah menit berganti', async () => {
    const t = createTime();
    const limiter = createWeightLimiter({ maxWeightPerMinute: 100, clock: t.clock, sleep: t.sleep });
    await limiter.acquire(70);
    t.advance(MINUTE);
    expect(limiter.usedWeight()).toBe(0);
  });

  it('UNIT-BNL-006 blokir (429/418): acquire menunggu blokir selesai; blokir panjang melempar error retryable', async () => {
    const t = createTime();
    const limiter = createWeightLimiter({ maxWeightPerMinute: 100, clock: t.clock, sleep: t.sleep });
    limiter.blockUntil(t.clock() + 7_000, 429);
    expect(limiter.blockedForMs()).toBe(7_000);
    await limiter.acquire(1, { maxBlockWaitMs: 60_000 });
    expect(t.sleeps).toEqual([7_000]);
    expect(limiter.blockedForMs()).toBe(0);

    limiter.blockUntil(t.clock() + 120_000, 418);
    const err = await limiter.acquire(1, { maxBlockWaitMs: 60_000 }).catch((e) => e);
    expect(err).toBeInstanceOf(BinanceApiError);
    expect(err).toMatchObject({ status: 418, code: ERROR_CODES.RATE_LIMIT_BLOCKED, retryable: true, retryAfterMs: 120_000 });
    expect(t.sleeps).toEqual([7_000]);
  });

  it('EDGE-BNL-003 blokir lebih pendek tidak memperpendek blokir yang sudah ada', () => {
    const t = createTime();
    const limiter = createWeightLimiter({ maxWeightPerMinute: 100, clock: t.clock, sleep: t.sleep });
    limiter.blockUntil(t.clock() + 120_000, 418);
    limiter.blockUntil(t.clock() + 5_000, 429);
    expect(limiter.blockedForMs()).toBe(120_000);
  });

  it('UNIT-BNL-007 permintaan konkuren yang menunggu tidak melampaui batas bersama', async () => {
    const timers = createManualTimers();
    const limiter = createWeightLimiter({ maxWeightPerMinute: 10, clock: timers.clock, sleep: timers.sleep });
    await limiter.acquire(8);
    const done = [];
    const a = limiter.acquire(5).then(() => done.push('a'));
    const b = limiter.acquire(5).then(() => done.push('b'));
    const c = limiter.acquire(5).then(() => done.push('c'));
    await timers.advanceTo(T0 + 1);
    expect(done).toEqual([]);
    await timers.advanceTo(Date.UTC(2026, 0, 1, 0, 1, 0));
    await Promise.all([a, b]);
    expect(done).toEqual(['a', 'b']);
    expect(limiter.usedWeight()).toBe(10);
    await timers.advanceTo(Date.UTC(2026, 0, 1, 0, 2, 0));
    await c;
    expect(done).toEqual(['a', 'b', 'c']);
    expect(limiter.usedWeight()).toBe(5);
  });

  it('NEG-BNL-001 konfigurasi & bobot tidak valid ditolak', async () => {
    const t = createTime();
    expect(() => createWeightLimiter({ maxWeightPerMinute: 0, clock: t.clock, sleep: t.sleep })).toThrow(RangeError);
    expect(() => createWeightLimiter({ maxWeightPerMinute: 1.5, clock: t.clock, sleep: t.sleep })).toThrow(RangeError);
    expect(() => createWeightLimiter({ maxWeightPerMinute: 10, sleep: t.sleep })).toThrow(TypeError);
    expect(() => createWeightLimiter({ maxWeightPerMinute: 10, clock: t.clock })).toThrow(TypeError);
    const limiter = createWeightLimiter({ maxWeightPerMinute: 10, clock: t.clock, sleep: t.sleep });
    await expect(limiter.acquire(0)).rejects.toThrow(RangeError);
    await expect(limiter.acquire(-1)).rejects.toThrow(RangeError);
  });

  it('NEG-BNL-002 header bobot tidak valid diabaikan', () => {
    expect(parseUsedWeightHeader('123')).toBe(123);
    for (const bad of [null, undefined, '', 'abc', '-1', '1.5', '1e3', ' 12']) expect(parseUsedWeightHeader(bad)).toBeNull();
  });
});
