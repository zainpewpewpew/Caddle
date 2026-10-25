// Aplikasi uji dengan kontrol scanner aktif dan supervisor ber-fork TIRUAN (tanpa proses nyata).
import { createIngestionStateRepository } from '../../backend/database/repositories/ingestionStateRepository.js';
import { WORKER_SCRIPT_PATH, createWorkerSupervisor } from '../../backend/system/workerSupervisor.js';
import { createFakeFork, createManualTimers } from './fakeFork.js';
import { TEST_ORIGIN, createTestApp } from './testApp.js';

/**
 * @param {{ env?: object, fork?: Function, clock?: Function }} [options]
 * @returns {Promise<{ app, db, config, clock, fork, timers, lines: string[] }>}
 */
export async function createWorkerTestApp({ env = {}, fork = createFakeFork({ gracefulExit: true }), ...rest } = {}) {
  const timers = createManualTimers();
  const lines = [];
  const ctx = await createTestApp({
    env: { WORKER_CONTROL: 'true', ...env },
    ...rest,
    appOptions: ({ db, clock }) => {
      // Dibuat saat pertama dipakai: migrasi baru berjalan di dalam buildApp.
      let ingestion = null;
      const readHeartbeat = async () => {
        ingestion ??= createIngestionStateRepository(db);
        return (await ingestion.getStatus()).heartbeat;
      };
      return {
        workerSupervisor: createWorkerSupervisor({
          fork,
          scriptPath: WORKER_SCRIPT_PATH,
          env: { DATABASE_PATH: ':memory:' },
          clock,
          output: (line) => lines.push(line),
          readExternalHeartbeat: readHeartbeat,
          setTimer: timers.setTimer,
          clearTimer: timers.clearTimer,
        }),
      };
    },
  });
  return { ...ctx, fork, timers, lines };
}

/** POST start/stop dengan sesi + token CSRF (seperti klien API frontend). Header bernilai undefined dihapus. */
export function postWorker(app, action, auth, { headers = {}, payload } = {}) {
  const merged = { cookie: auth.cookie, 'x-csrf-token': auth.csrfToken, origin: TEST_ORIGIN, ...headers };
  for (const [name, value] of Object.entries(merged)) if (value === undefined) delete merged[name];
  return app.inject({ method: 'POST', url: `/api/system/worker/${action}`, headers: merged, payload });
}

export const getWorker = (app, auth) => app.inject({ url: '/api/system/worker', headers: { cookie: auth.cookie } });

/** Baris audit worker.* terbaru lebih dulu. */
export async function workerAudit(app) {
  return (await app.services.repos.audit.recent(100)).filter((a) => a.action.startsWith('worker.'));
}
