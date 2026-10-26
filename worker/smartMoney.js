// Loop sinkronisasi Insider / Smart Money Radar untuk proses jangka panjang (worker scanner dan
// `npm run smart-money:sync -- --loop`). Menjalankan runSmartMoneySync berkala: jeda awal, lalu setiap
// SMART_MONEY_SYNC_MINUTES SETELAH putaran sebelumnya selesai — putaran tidak pernah tumpang-tindih. Kegagalan satu
// putaran dicatat (pesan disaring) dan tidak menghentikan loop maupun worker. stop() membatalkan putaran yang sedang
// berjalan (AbortSignal → status ABORTED) dan menunggu sampai selesai sebelum database ditutup.
// Tanpa adapter provider aktif (SMART_MONEY_PROVIDERS kosong / kunci belum diisi) loop tidak dijadwalkan sama sekali:
// tidak ada data simulasi sebagai pengganti.
// Putaran memakai lease lintas proses (backend/smartmoney/syncRunner.js): bila tombol "Sync sekarang" di website
// sedang menjalankan sinkronisasi di proses server, putaran terjadwal dilewati dan dicoba lagi setelah BUSY_RETRY_MS.

import { createSmartMoneyRepository } from '../backend/smartmoney/repository.js';
import { runSmartMoneySync, sanitizeProviderMessage } from '../backend/smartmoney/sync.js';
import { createSyncRunner } from '../backend/smartmoney/syncRunner.js';

/** Jeda default sebelum putaran pertama di worker (memberi waktu bootstrap scanner lebih dulu). */
export const DEFAULT_INITIAL_DELAY_MS = 60_000;
/** Jeda sebelum mencoba lagi bila putaran terjadwal dilewati karena sinkronisasi lain sedang berjalan. */
export const BUSY_RETRY_MS = 60_000;

const NOOP_LOGGER = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });

/**
 * Logger dengan field tetap (mis. { module: 'smart-money' }) di atas logger gaya pino `log(fields, msg)`.
 * @param {object} logger
 * @param {Record<string, unknown>} fields
 * @returns {{ debug: Function, info: Function, warn: Function, error: Function }}
 */
export function scopedLogger(logger, fields) {
  const base = logger ?? NOOP_LOGGER;
  if (typeof base.child === 'function') return base.child(fields);
  const wrap = (name) => (a, b) => {
    const fn = typeof base[name] === 'function' ? base[name] : () => {};
    if (typeof a === 'string') return fn.call(base, { ...fields, ...(b ?? {}) }, a);
    return fn.call(base, { ...fields, ...(a ?? {}) }, b);
  };
  return { debug: wrap('debug'), info: wrap('info'), warn: wrap('warn'), error: wrap('error') };
}

/**
 * Mulai loop sinkronisasi smart money.
 * @param {{
 *   db: import('better-sqlite3').Database,
 *   config: { smartMoney: { syncIntervalMinutes: number, maxWalletsPerSync?: number } },
 *   logger?: object, clock?: () => number,
 *   createRegistry: (config: object) => { list: () => object[], unavailable?: () => Array<{ id: string, reason: string }> },
 *   initialDelayMs?: number, intervalMs?: number,
 *   syncDeps?: { nativePrices?: object|null, enrichNativeUsd?: Function|null, tuning?: object },
 *   onRun?: (summary: object) => void,
 *   runSync?: typeof runSmartMoneySync,
 *   timers?: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout },
 * }} options config = konfigurasi aplikasi (loadConfig()); interval default = config.smartMoney.syncIntervalMinutes.
 * @returns {{ active: boolean, runNow: () => Promise<object|null>, stop: () => Promise<void>,
 *   status: () => { active: boolean, running: boolean, stopped: boolean, runs: number, lastStatus: string|null,
 *   lastFinishedAt: number|null, nextRunAt: number|null } }}
 */
export function startSmartMoneyLoop({
  db, config, logger = NOOP_LOGGER, clock = Date.now, createRegistry, initialDelayMs = DEFAULT_INITIAL_DELAY_MS, intervalMs,
  syncDeps = {}, onRun = null, runSync = runSmartMoneySync, timers = { setTimeout, clearTimeout },
}) {
  if (typeof createRegistry !== 'function') throw new TypeError('createRegistry wajib fungsi');
  const every = intervalMs ?? (config?.smartMoney?.syncIntervalMinutes ?? 15) * 60_000;
  if (!(Number.isSafeInteger(every) && every > 0)) throw new RangeError('intervalMs harus bilangan bulat > 0');
  if (!(Number.isSafeInteger(initialDelayMs) && initialDelayMs >= 0)) throw new RangeError('initialDelayMs harus bilangan bulat ≥ 0');

  const registry = createRegistry(config);
  const active = registry.list().length > 0;
  let stopped = !active;
  let timer = null;
  let nextRunAt = null;
  let running = null;
  let runs = 0;
  let lastStatus = null;
  let lastFinishedAt = null;

  const status = () => ({ active, running: running !== null, stopped, runs, lastStatus, lastFinishedAt, nextRunAt });

  if (!active) {
    const unavailable = typeof registry.unavailable === 'function' ? registry.unavailable() : [];
    logger.warn({ unavailable: unavailable.map((u) => ({ id: u.id, reason: u.reason })) },
      'sinkronisasi smart money tidak dijalankan: belum ada adapter provider yang aktif');
    return { active, runNow: async () => null, stop: async () => {}, status };
  }

  const repo = createSmartMoneyRepository(db, { clock });
  const runner = createSyncRunner({
    repo, registry, config: config.smartMoney, owner: `worker:${process.pid}`, clock, logger, syncDeps, runSync,
  });

  function schedule(delay) {
    if (stopped) return;
    nextRunAt = Math.floor(clock()) + delay;
    timer = timers.setTimeout(() => {
      timer = null;
      tick();
    }, delay);
  }

  function tick() {
    if (running) return running;
    if (stopped) return Promise.resolve(null);
    nextRunAt = null;
    let busy = false;
    running = (async () => {
      try {
        const result = await runner.runNow({ trigger: 'schedule' });
        if (result.skipped) {
          busy = true;
          logger.info({ holder: result.run?.owner ?? null, trigger: result.run?.trigger ?? null },
            'putaran terjadwal smart money dilewati: sinkronisasi lain sedang berjalan');
          return null;
        }
        const summary = result.summary;
        // runner menangkap error putaran (dicatat di log) dan mengembalikan null.
        lastStatus = summary === null ? 'FAILED' : (summary?.status ?? null);
        if (summary !== null && typeof onRun === 'function') {
          try {
            onRun(summary);
          } catch (err) {
            logger.warn({ err: sanitizeProviderMessage(err?.message) }, 'callback onRun smart money gagal');
          }
        }
        return summary;
      } catch (err) {
        lastStatus = 'FAILED';
        logger.error({ err: sanitizeProviderMessage(err?.message ?? err) }, 'putaran sinkronisasi smart money gagal');
        return null;
      } finally {
        if (!busy) {
          runs += 1;
          lastFinishedAt = Math.floor(clock());
        }
        running = null;
        schedule(busy ? Math.min(BUSY_RETRY_MS, every) : every);
      }
    })();
    return running;
  }

  schedule(initialDelayMs);
  logger.info({ providers: registry.list().map((a) => a.id), intervalMs: every, initialDelayMs }, 'loop sinkronisasi smart money aktif');

  return {
    active,
    /** Jalankan putaran sekarang (atau kembalikan putaran yang sedang berjalan — tidak pernah dua sekaligus). */
    runNow() {
      if (running) return running;
      if (stopped) return Promise.resolve(null);
      if (timer !== null) {
        timers.clearTimeout(timer);
        timer = null;
      }
      return tick();
    },
    /** Hentikan loop: batalkan jadwal, batalkan putaran berjalan, tunggu sampai selesai. */
    async stop() {
      stopped = true;
      if (timer !== null) {
        timers.clearTimeout(timer);
        timer = null;
      }
      nextRunAt = null;
      await runner.stop();
      if (running) await running;
      logger.info({ runs }, 'loop sinkronisasi smart money berhenti');
    },
    status,
  };
}
