// Kontrol worker scanner dari website (lihat backend/system/workerSupervisor.js).
// GET status untuk semua pengguna terautentikasi; start/stop hanya admin, wajib token CSRF (gerbang
// authPlugin untuk method POST), dibatasi rate limit sendiri, dan tercatat di log audit (`worker.start` /
// `worker.stop`) untuk setiap pengguna yang dikenali sesinya: berhasil, ditolak supervisor, ditolak gerbang
// peran/CSRF (403), atau error tak terduga (500).
// Request tidak pernah memengaruhi skrip, argumen, atau environment child — body diabaikan.
import { WorkerSupervisorError } from '../system/workerSupervisor.js';

const DISABLED = Object.freeze({
  error: 'WORKER_CONTROL_DISABLED',
  message: 'Kontrol scanner dari website dinonaktifkan (WORKER_CONTROL=false). Jalankan npm run worker di terminal.',
});

/**
 * Batas per route (per IP) untuk POST start/stop, menggantikan batas global 300/menit. Bersama jeda start ulang
 * supervisor, mencegah loop start/stop yang membuang backoff Binance (limiter bobot & blokir 418/429 per proses).
 */
export const WORKER_ACTION_RATE_LIMIT = Object.freeze({ max: 10, timeWindow: 60_000 });

/** Kode penolakan gerbang yang dicatat apa adanya; kode lain dari respons 403 dicatat sebagai FORBIDDEN. */
const GATE_REASONS = new Set(['FORBIDDEN', 'CSRF_INVALID']);

function gateReason(payload) {
  try {
    const code = JSON.parse(typeof payload === 'string' ? payload : String(payload))?.error;
    return GATE_REASONS.has(code) ? code : 'FORBIDDEN';
  } catch {
    return 'FORBIDDEN';
  }
}

export async function workerRoutes(app, { supervisor, enabled, audit, clock }) {
  const view = async () => ({ enabled, ...(await supervisor.status()) });

  app.get('/api/system/worker', async () => view());

  const actions = [
    ['start', () => supervisor.start()],
    // Tidak menunggu proses keluar: UI memantau state 'stopping' → 'stopped' lewat polling.
    ['stop', () => supervisor.stop({ wait: false })],
  ];
  for (const [name, run] of actions) {
    const action = `worker.${name}`;
    const record = (request, outcome, detail) => audit.record({
      occurredAt: clock(), userId: request.auth.user.id, action, outcome, ip: request.ip, detail,
    });

    // Penolakan gerbang authPlugin (analyst → FORBIDDEN, token CSRF hilang/salah → CSRF_INVALID) terjadi sebelum
    // handler; hook onSend tingkat route ini tetap dijalankan untuk balasan tersebut. Hanya bila sesi dikenali:
    // tanpa sesi (401) atau Origin lintas situs (ditolak sebelum sesi dibaca) tidak ada pengguna untuk dicatat.
    const auditGateRejection = async (request, reply, payload) => {
      if (reply.statusCode !== 403 || !request.auth) return payload;
      try {
        await record(request, 'failure', { reason: gateReason(payload) });
      } catch (err) {
        request.log.error({ err }, 'gagal mencatat audit penolakan kontrol scanner');
      }
      return payload;
    };

    app.post(`/api/system/worker/${name}`, {
      config: { roles: ['admin'], rateLimit: WORKER_ACTION_RATE_LIMIT },
      onSend: auditGateRejection,
    }, async (request, reply) => {
      if (!enabled) {
        await record(request, 'failure', { reason: DISABLED.error });
        return reply.code(503).send(DISABLED);
      }
      try {
        await run();
      } catch (err) {
        if (!(err instanceof WorkerSupervisorError)) {
          // Error tak terduga (mis. database terkunci saat membaca heartbeat) tetap meninggalkan jejak audit;
          // respons 500 generik dibuat error handler buildApp.
          await record(request, 'failure', { reason: 'INTERNAL_ERROR' })
            .catch((auditErr) => request.log.error({ err: auditErr }, 'gagal mencatat audit kontrol scanner'));
          throw err;
        }
        await record(request, 'failure', { reason: err.code });
        if (typeof err.retryAfterMs === 'number') reply.header('Retry-After', String(Math.max(1, Math.ceil(err.retryAfterMs / 1000))));
        return reply.code(err.statusCode).send({ error: err.code, message: err.message });
      }
      const status = await view();
      await record(request, 'success', { state: status.state });
      return status;
    });
  }
}
