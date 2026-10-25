// Kontrol worker scanner dari website (lihat backend/system/workerSupervisor.js).
// GET status untuk semua pengguna terautentikasi; start/stop hanya admin, wajib token CSRF (gerbang
// authPlugin untuk method POST), dan selalu tercatat di log audit (`worker.start` / `worker.stop`).
// Request tidak pernah memengaruhi skrip, argumen, atau environment child — body diabaikan.
import { WorkerSupervisorError } from '../system/workerSupervisor.js';

const DISABLED = Object.freeze({
  error: 'WORKER_CONTROL_DISABLED',
  message: 'Kontrol scanner dari website dinonaktifkan (WORKER_CONTROL=false). Jalankan npm run worker di terminal.',
});

export async function workerRoutes(app, { supervisor, enabled, audit, clock }) {
  const view = async () => ({ enabled, ...(await supervisor.status()) });

  app.get('/api/system/worker', async () => view());

  const actions = [
    ['start', () => supervisor.start()],
    // Tidak menunggu proses keluar: UI memantau state 'stopping' → 'stopped' lewat polling.
    ['stop', () => supervisor.stop({ wait: false })],
  ];
  for (const [name, run] of actions) {
    app.post(`/api/system/worker/${name}`, { config: { roles: ['admin'] } }, async (request, reply) => {
      const record = (outcome, detail) => audit.record({
        occurredAt: clock(), userId: request.auth.user.id, action: `worker.${name}`, outcome, ip: request.ip, detail,
      });
      if (!enabled) {
        await record('failure', { reason: DISABLED.error });
        return reply.code(503).send(DISABLED);
      }
      try {
        await run();
      } catch (err) {
        if (!(err instanceof WorkerSupervisorError)) throw err;
        await record('failure', { reason: err.code });
        return reply.code(err.statusCode).send({ error: err.code, message: err.message });
      }
      const status = await view();
      await record('success', { state: status.state });
      return status;
    });
  }
}
