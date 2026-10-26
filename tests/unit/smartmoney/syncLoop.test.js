import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../../backend/database/connection.js';
import { migrate } from '../../../backend/database/migrate.js';
import { createFixtureProvider } from '../../../backend/smartmoney/providers/fixtureProvider.js';
import { createProviderRegistry } from '../../../backend/smartmoney/providers/registry.js';
import { createSmartMoneyRepository } from '../../../backend/smartmoney/repository.js';
import { DEFAULT_INITIAL_DELAY_MS, scopedLogger, startSmartMoneyLoop } from '../../../worker/smartMoney.js';
import { buildScenario } from '../../fixtures/smartmoney/scenario.js';

const MIN = 60_000;
const CONFIG = Object.freeze({ nodeEnv: 'test', smartMoney: Object.freeze({ providers: ['fixture'], syncIntervalMinutes: 15, maxWalletsPerSync: 50 }) });

/** Timer palsu: tidak ada yang berjalan sampai `fire()` dipanggil. */
function fakeTimers() {
  const pending = new Map();
  let nextId = 1;
  return {
    setTimeout: (fn, ms) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => { pending.delete(id); },
    delays: () => [...pending.values()].map((p) => p.ms),
    fire: () => {
      const [id, p] = [...pending.entries()][0];
      pending.delete(id);
      p.fn();
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function recordingLogger() {
  const entries = [];
  const at = (level) => (fields, msg) => entries.push({ level, fields, msg });
  return { entries, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

const ADAPTER = Object.freeze({ id: 'contoh', isSimulated: false });
const registryWith = (adapters, unavailable = []) => ({ list: () => [...adapters], unavailable: () => unavailable, withCapability: () => [] });

function setup({ runSync, adapters = [ADAPTER], unavailable = [], ...rest } = {}) {
  const db = openDatabase(':memory:');
  migrate(db, { now: () => new Date(0) });
  let t = Date.UTC(2026, 9, 1, 12);
  const clock = () => t;
  const timers = fakeTimers();
  const logger = recordingLogger();
  const calls = [];
  const registry = registryWith(adapters, unavailable);
  const loop = startSmartMoneyLoop({
    db, config: CONFIG, logger, clock, timers, createRegistry: () => registry,
    runSync: async (deps) => {
      calls.push(deps);
      return runSync ? runSync(deps, calls.length) : { status: 'OK' };
    },
    ...rest,
  });
  return { db, loop, timers, logger, calls, registry, advance: (ms) => { t += ms; }, now: () => t };
}

describe('loop sinkronisasi smart money (worker/smartMoney.js)', () => {
  it('UNIT-SM-LOOP-001 tanpa adapter aktif: loop tidak dijadwalkan, peringatan memuat alasan, runNow/stop aman', async () => {
    const { loop, timers, logger, calls } = setup({ adapters: [], unavailable: [{ id: 'etherscan', reason: 'kunci belum diisi' }] });
    expect(loop.active).toBe(false);
    expect(timers.delays()).toEqual([]);
    const warn = logger.entries.find((e) => e.level === 'warn');
    expect(warn.msg).toMatch(/belum ada adapter provider yang aktif/);
    expect(warn.fields.unavailable).toEqual([{ id: 'etherscan', reason: 'kunci belum diisi' }]);
    expect(await loop.runNow()).toBeNull();
    await loop.stop();
    expect(calls).toHaveLength(0);
    expect(loop.status()).toMatchObject({ active: false, running: false, stopped: true, runs: 0, nextRunAt: null });
  });

  it('UNIT-SM-LOOP-002 jeda awal lalu interval dihitung SETELAH putaran selesai; deps sinkronisasi diteruskan', async () => {
    const nativePrices = { priceAt: async () => null };
    const enrich = async (t) => t;
    const { loop, timers, calls, registry, advance, now } = setup({ syncDeps: { nativePrices, enrichNativeUsd: enrich } });
    expect(loop.active).toBe(true);
    expect(timers.delays()).toEqual([DEFAULT_INITIAL_DELAY_MS]);
    expect(loop.status().nextRunAt).toBe(now() + DEFAULT_INITIAL_DELAY_MS);
    advance(DEFAULT_INITIAL_DELAY_MS);
    timers.fire();
    expect(loop.status().running).toBe(true);
    expect(timers.delays()).toEqual([]); // tidak ada jadwal selama putaran berjalan
    await loop.runNow(); // putaran yang sama (tidak memulai yang baru)
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ registry, config: CONFIG.smartMoney, nativePrices, enrichNativeUsd: enrich });
    expect(typeof calls[0].repo.listAllActivities).toBe('function');
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
    expect(timers.delays()).toEqual([15 * MIN]); // SMART_MONEY_SYNC_MINUTES
    expect(loop.status()).toMatchObject({ running: false, runs: 1, lastStatus: 'OK', lastFinishedAt: now(), nextRunAt: now() + 15 * MIN });
    timers.fire();
    await loop.runNow();
    expect(calls).toHaveLength(2);
    await loop.stop();
  });

  it('UNIT-SM-LOOP-003 tidak pernah tumpang-tindih: runNow saat putaran berjalan mengembalikan putaran yang sama', async () => {
    const gate = deferred();
    const { loop, timers, calls } = setup({ runSync: () => gate.promise, initialDelayMs: 0 });
    const first = loop.runNow(); // membatalkan timer jeda awal, langsung jalan
    expect(timers.delays()).toEqual([]);
    const second = loop.runNow();
    expect(second).toBe(first);
    expect(calls).toHaveLength(1);
    gate.resolve({ status: 'DEGRADED' });
    expect(await first).toEqual({ status: 'DEGRADED' });
    expect(loop.status()).toMatchObject({ runs: 1, lastStatus: 'DEGRADED' });
    expect(timers.delays()).toEqual([15 * MIN]);
    await loop.stop();
  });

  it('UNIT-SM-LOOP-004 putaran gagal dicatat (pesan disaring) dan loop tetap terjadwal; callback onRun yang error diisolasi', async () => {
    const seen = [];
    const { loop, timers, logger } = setup({
      runSync: (_deps, n) => {
        if (n === 1) throw new Error('gagal ke https://api.contoh.io/v2?apikey=RAHASIA\nbaris2');
        return { status: 'OK' };
      },
      onRun: (summary) => {
        seen.push(summary);
        throw new Error('callback rusak');
      },
    });
    expect(await loop.runNow()).toBeNull();
    expect(loop.status()).toMatchObject({ runs: 1, lastStatus: 'FAILED' });
    const error = logger.entries.find((e) => e.level === 'error');
    expect(error.fields.err).toBe('gagal ke [url] baris2');
    expect(JSON.stringify(logger.entries)).not.toContain('RAHASIA');
    expect(timers.delays()).toEqual([15 * MIN]);
    expect(await loop.runNow()).toEqual({ status: 'OK' });
    expect(seen).toEqual([{ status: 'OK' }]);
    expect(logger.entries.some((e) => e.level === 'warn' && /onRun/.test(e.msg))).toBe(true);
    expect(loop.status()).toMatchObject({ runs: 2, lastStatus: 'OK' });
    await loop.stop();
  });

  it('UNIT-SM-LOOP-005 stop() membatalkan putaran berjalan (AbortSignal), menunggu selesai, dan tidak menjadwalkan lagi', async () => {
    let signal;
    const { loop, timers } = setup({
      runSync: (deps) => {
        signal = deps.signal;
        return new Promise((resolve) => deps.signal.addEventListener('abort', () => resolve({ status: 'ABORTED' })));
      },
    });
    const running = loop.runNow();
    expect(signal.aborted).toBe(false);
    await loop.stop();
    expect(signal.aborted).toBe(true);
    expect(await running).toEqual({ status: 'ABORTED' });
    expect(timers.delays()).toEqual([]);
    expect(loop.status()).toMatchObject({ stopped: true, running: false, runs: 1, lastStatus: 'ABORTED', nextRunAt: null });
    expect(await loop.runNow()).toBeNull();
    await loop.stop(); // idempoten
  });

  it('UNIT-SM-LOOP-006 stop() sebelum putaran pertama membatalkan jadwal jeda awal', async () => {
    const { loop, timers, calls } = setup();
    expect(timers.delays()).toHaveLength(1);
    await loop.stop();
    expect(timers.delays()).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('UNIT-SM-LOOP-007 validasi opsi: createRegistry wajib, interval & jeda awal bilangan bulat yang sah', async () => {
    const db = openDatabase(':memory:');
    migrate(db, { now: () => new Date(0) });
    const base = {
      db, config: CONFIG, createRegistry: () => registryWith([ADAPTER]), timers: fakeTimers(), runSync: async () => ({ status: 'OK' }),
    };
    expect(() => startSmartMoneyLoop({ ...base, createRegistry: undefined })).toThrow(TypeError);
    expect(() => startSmartMoneyLoop({ ...base, intervalMs: 0 })).toThrow(RangeError);
    expect(() => startSmartMoneyLoop({ ...base, intervalMs: 1.5 })).toThrow(RangeError);
    expect(() => startSmartMoneyLoop({ ...base, initialDelayMs: -1 })).toThrow(RangeError);
    const timers = fakeTimers();
    const loop = startSmartMoneyLoop({ ...base, timers, initialDelayMs: 5, config: { smartMoney: { syncIntervalMinutes: 30 } } });
    expect(timers.delays()).toEqual([5]);
    const run = loop.runNow();
    expect(timers.delays()).toEqual([]); // jeda awal dibatalkan oleh runNow
    await run;
    expect(timers.delays()).toEqual([30 * MIN]); // interval = SMART_MONEY_SYNC_MINUTES dari config
    await loop.stop();
    db.close();
  });

  it('UNIT-SM-LOOP-008 integrasi: runSmartMoneySync sungguhan + provider fixture (DATA SIMULASI) menyimpan aktivitas', async () => {
    const scenario = buildScenario();
    const db = openDatabase(':memory:');
    migrate(db, { now: () => new Date(0) });
    const fixture = createFixtureProvider(scenario);
    const timers = fakeTimers();
    const summaries = [];
    const loop = startSmartMoneyLoop({
      db, config: CONFIG, clock: () => scenario.now, timers, initialDelayMs: 0, onRun: (s) => summaries.push(s),
      createRegistry: () => createProviderRegistry({ adapters: [fixture], enabledIds: ['fixture'] }),
    });
    const summary = await loop.runNow();
    expect(summary.status).toBe('OK');
    expect(summary.inserted).toBeGreaterThan(0);
    expect(summaries).toEqual([summary]);
    const repo = createSmartMoneyRepository(db, { clock: () => scenario.now });
    expect((await repo.coverage()).activities).toBe(summary.inserted);
    expect(await repo.hasSimulatedData()).toBe(true);
    await loop.stop();
    db.close();
  });

  it('UNIT-SM-LOOP-009 scopedLogger menambah field tetap (child() bila ada; gaya fields,msg & msg,fields)', () => {
    const entries = [];
    const flat = { info: (fields, msg) => entries.push({ fields, msg }), warn: (fields, msg) => entries.push({ fields, msg }) };
    const log = scopedLogger(flat, { module: 'smart-money' });
    log.info({ a: 1 }, 'satu');
    log.warn('dua', { b: 2 });
    log.debug({ c: 3 }, 'tiga'); // logger dasar tanpa debug → diabaikan tanpa error
    expect(entries).toEqual([
      { fields: { module: 'smart-money', a: 1 }, msg: 'satu' },
      { fields: { module: 'smart-money', b: 2 }, msg: 'dua' },
    ]);
    const child = { marker: true };
    expect(scopedLogger({ child: (fields) => ({ ...child, fields }) }, { module: 'x' })).toEqual({ marker: true, fields: { module: 'x' } });
    expect(() => scopedLogger(null, { module: 'x' }).error('aman')).not.toThrow();
  });
});
