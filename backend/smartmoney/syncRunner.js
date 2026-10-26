// Penjalan putaran sinkronisasi Insider / Smart Money Radar dengan lease lintas proses. Server (tombol "Sync sekarang",
// trigger 'manual') dan loop terjadwal worker scanner (trigger 'schedule') berbagi satu database, jadi lease di
// sm_sync_state (repository.acquireSyncLease) menjamin putaran tidak pernah tumpang-tindih walau berjalan di proses
// berbeda. Progres putaran (tahap + n/total wallet) ditulis ke lease agar proses lain dapat menampilkannya.
// Tidak pernah menjalankan sinkronisasi tanpa provider aktif (tidak ada data simulasi sebagai pengganti).

import { SYNC_STATE_KEYS, runSmartMoneySync, sanitizeProviderMessage } from './sync.js';

/** Lease kedaluwarsa bila pemegangnya mati tanpa melepas (mis. kill -9); diperpanjang tiap progres dan detak berkala. */
export const DEFAULT_LEASE_TTL_MS = 2 * 60_000;
/** Detak perpanjangan lease selama putaran berjalan — juga saat satu tahap lama tanpa progres (mis. antre kuota API). */
export const LEASE_HEARTBEAT_MS = 20_000;
/** Jeda minimum antara akhir putaran terakhir (proses mana pun) dan sync manual berikutnya — melindungi kuota API. */
export const DEFAULT_MANUAL_COOLDOWN_MS = 30_000;
/** Progres dalam satu tahap ditulis paling sering sekali per interval ini; pergantian tahap selalu ditulis. */
export const PROGRESS_WRITE_MS = 1000;
/** Catatan lastRun bila putaran berhenti karena kesalahan tak terduga (detail hanya di log server, sudah disaring). */
export const FAILED_RUN_NOTE = 'Putaran berhenti karena kesalahan internal — detailnya ada di log server (terminal npm start / worker).';

const NOOP_LOGGER = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });

export class SyncRunnerError extends Error {
  /**
   * @param {'NO_PROVIDERS'|'SYNC_RUNNING'|'SYNC_COOLDOWN'} code
   * @param {string} message pesan Bahasa Indonesia untuk pengguna
   * @param {{ retryAfterMs?: number|null, run?: object|null }} [extra]
   */
  constructor(code, message, { retryAfterMs = null, run = null } = {}) {
    super(message);
    this.name = 'SyncRunnerError';
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.run = run;
  }
}

/** Bentuk publik lease (tanpa id proses): owner 'server'|'worker', trigger, waktu, tahap, n/total. */
export function publicRun(lease) {
  if (!lease || typeof lease !== 'object') return null;
  const p = lease.progress ?? {};
  const kind = typeof lease.owner === 'string' && lease.owner.startsWith('worker:') ? 'worker' : 'server';
  return {
    owner: kind,
    trigger: lease.trigger === 'schedule' ? 'schedule' : 'manual',
    startedAt: Number.isSafeInteger(lease.acquiredAt) ? lease.acquiredAt : null,
    updatedAt: Number.isSafeInteger(p.updatedAt) ? p.updatedAt : null,
    phase: typeof p.phase === 'string' ? p.phase : 'start',
    done: Number.isSafeInteger(p.done) ? p.done : null,
    total: Number.isSafeInteger(p.total) ? p.total : null,
  };
}

/**
 * @param {{
 *   repo: ReturnType<typeof import('./repository.js').createSmartMoneyRepository>,
 *   registry: { list: () => object[], withCapability: Function },
 *   config: object, owner: string, clock?: () => number, logger?: object,
 *   syncDeps?: object | (() => object), runSync?: typeof runSmartMoneySync,
 *   leaseTtlMs?: number, heartbeatMs?: number, cooldownMs?: number, progressWriteMs?: number,
 * }} options config = config.smartMoney. owner = 'server:<pid>' / 'worker:<pid>' (unik per proses).
 *   syncDeps = deps tambahan runSmartMoneySync (nativePrices, enrichNativeUsd, tuning); fungsi = dibuat malas saat
 *   putaran pertama (mis. klien REST Binance hanya dibuat bila memang ada sinkronisasi).
 */
export function createSyncRunner({
  repo, registry, config, owner, clock = Date.now, logger = NOOP_LOGGER, syncDeps = {}, runSync = runSmartMoneySync,
  leaseTtlMs = DEFAULT_LEASE_TTL_MS, heartbeatMs = LEASE_HEARTBEAT_MS, cooldownMs = DEFAULT_MANUAL_COOLDOWN_MS,
  progressWriteMs = PROGRESS_WRITE_MS,
}) {
  if (!repo || typeof repo.acquireSyncLease !== 'function') throw new TypeError('repo smart money wajib diisi');
  if (!registry || typeof registry.list !== 'function') throw new TypeError('registry provider wajib diisi');
  if (typeof owner !== 'string' || owner === '') throw new TypeError('owner wajib diisi');
  const log = logger ?? NOOP_LOGGER;
  let deps = typeof syncDeps === 'function' ? null : syncDeps;
  let current = null; // { promise, controller, trigger }

  const now = () => Math.floor(clock());
  const providersActive = () => registry.list().length;

  function resolveDeps() {
    if (deps === null) deps = syncDeps() ?? {};
    return deps;
  }

  async function lastFinishedAt() {
    const v = (await repo.getSyncState(SYNC_STATE_KEYS.lastRun))?.value;
    return Number.isSafeInteger(v?.finishedAt) ? v.finishedAt : null;
  }

  /** Jalankan satu putaran yang lease-nya SUDAH dipegang proses ini; lease selalu dilepas di akhir. */
  function execute(trigger) {
    const startedAt = now();
    const controller = new AbortController();
    let lastPhase = null;
    let lastWrite = 0;
    const renew = (progress, t) => repo.renewSyncLease({ owner, ttlMs: leaseTtlMs, progress, now: t })
      .catch((err) => log.warn({ err: sanitizeProviderMessage(err?.message) }, 'gagal memperpanjang lease sinkronisasi smart money'));
    const onProgress = ({ phase, done, total }) => {
      const t = now();
      if (phase === lastPhase && t - lastWrite < progressWriteMs && done !== total) return;
      lastPhase = phase;
      lastWrite = t;
      renew({ phase, done, total }, t);
    };
    // progress null = hanya memperpanjang masa berlaku; progres terakhir tetap.
    const heartbeat = setInterval(() => renew(null, now()), heartbeatMs);
    heartbeat.unref?.();
    const promise = (async () => {
      try {
        return await runSync({
          repo, registry, clock, logger: log, config, signal: controller.signal, ...resolveDeps(), onProgress,
        });
      } catch (err) {
        log.error({ err: sanitizeProviderMessage(err?.message ?? err), trigger }, 'putaran sinkronisasi smart money gagal');
        // Hasil jujur untuk layar (bukan ringkasan lama yang tampak seperti hasil putaran ini); juga memicu jeda.
        try {
          const finishedAt = now();
          await repo.setSyncState(SYNC_STATE_KEYS.lastRun, {
            status: 'FAILED', trigger, startedAt, finishedAt, errors: [], notes: [FAILED_RUN_NOTE],
          }, { now: finishedAt });
        } catch (writeErr) {
          log.warn({ err: sanitizeProviderMessage(writeErr?.message) }, 'gagal mencatat putaran sinkronisasi smart money yang gagal');
        }
        return null;
      } finally {
        clearInterval(heartbeat);
        try {
          await repo.releaseSyncLease({ owner });
        } catch (err) {
          log.warn({ err: sanitizeProviderMessage(err?.message) }, 'gagal melepas lease sinkronisasi smart money');
        }
        current = null;
      }
    })();
    current = { promise, controller, trigger };
    return promise;
  }

  return {
    /** Banyak provider aktif (0 = sinkronisasi tidak dapat dijalankan). */
    providersActive,

    /**
     * Sync manual (tombol): menolak bila tanpa provider, masih jeda, atau putaran lain berjalan (proses mana pun).
     * Putaran berjalan di latar; hasilnya tersimpan sebagai lastRun.
     * @returns {Promise<{ run: object }>} snapshot run yang baru dimulai
     * @throws {SyncRunnerError}
     */
    async start({ trigger = 'manual' } = {}) {
      if (providersActive() === 0) {
        throw new SyncRunnerError('NO_PROVIDERS',
          'Belum ada sumber data aktif. Isi ETHERSCAN_API_KEY di .env, lalu jalankan ulang npm start.');
      }
      const t = now();
      if (current) throw new SyncRunnerError('SYNC_RUNNING', 'Sinkronisasi sedang berjalan.', { run: publicRun(await repo.getSyncLease({ now: t })) });
      const held = await repo.getSyncLease({ now: t });
      if (held) throw new SyncRunnerError('SYNC_RUNNING', runningMessage(held), { run: publicRun(held) });
      const finishedAt = await lastFinishedAt();
      if (finishedAt !== null && t - finishedAt < cooldownMs) {
        const retryAfterMs = cooldownMs - (t - finishedAt);
        throw new SyncRunnerError('SYNC_COOLDOWN', `Sinkronisasi baru saja selesai. Coba lagi dalam ${Math.ceil(retryAfterMs / 1000)} detik.`, { retryAfterMs });
      }
      const { acquired, lease } = await repo.acquireSyncLease({ owner, trigger, ttlMs: leaseTtlMs, now: t });
      if (!acquired) throw new SyncRunnerError('SYNC_RUNNING', runningMessage(lease), { run: publicRun(lease) });
      log.info({ trigger }, 'sinkronisasi smart money dimulai');
      execute(trigger);
      return { run: publicRun(lease) };
    },

    /**
     * Putaran terjadwal (worker): menunggu sampai selesai. Bila lease dipegang proses lain (mis. sync manual dari
     * website), putaran dilewati.
     * @returns {Promise<{ skipped: true, run: object|null } | { skipped: false, summary: object|null }>}
     */
    async runNow({ trigger = 'schedule' } = {}) {
      if (current) return { skipped: false, summary: await current.promise };
      const { acquired, lease } = await repo.acquireSyncLease({ owner, trigger, ttlMs: leaseTtlMs, now: now() });
      if (!acquired) return { skipped: true, run: publicRun(lease) };
      return { skipped: false, summary: await execute(trigger) };
    },

    /** @returns {Promise<{ running: boolean, run: object|null, cooldownUntil: number|null }>} dibaca dari database (lintas proses) */
    async status() {
      const t = now();
      const lease = await repo.getSyncLease({ now: t });
      const finishedAt = await lastFinishedAt();
      const cooldownUntil = finishedAt !== null && t - finishedAt < cooldownMs ? finishedAt + cooldownMs : null;
      return { running: lease !== null, run: publicRun(lease), cooldownUntil };
    },

    /** Batalkan putaran milik proses ini (shutdown) dan tunggu sampai lease dilepas. */
    async stop() {
      if (!current) return;
      current.controller.abort();
      await current.promise;
    },

    /** Promise putaran milik proses ini yang sedang berjalan (tes / shutdown), atau null. */
    pending: () => current?.promise ?? null,
  };
}

function runningMessage(lease) {
  return lease?.trigger === 'schedule'
    ? 'Sinkronisasi terjadwal dari worker scanner sedang berjalan — progresnya ditampilkan di sini.'
    : 'Sinkronisasi manual sedang berjalan — progresnya ditampilkan di sini.';
}
