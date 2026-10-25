import { safeEqual } from '../auth/tokens.js';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const isUnsafeMethod = (method) => UNSAFE_METHODS.has(method);

/**
 * Pertahanan CSRF berlapis untuk request yang mengubah state:
 * 1. Origin harus sama dengan APP_ORIGIN (bila dikirim browser).
 * 2. Sec-Fetch-Site 'cross-site' ditolak.
 * 3. Route terautentikasi wajib membawa header X-CSRF-Token yang cocok dengan token sesi.
 * Ditambah cookie SameSite=Strict dan hanya menerima application/json.
 */
export function registerRequestGuards(app, config) {
  app.addHook('onRequest', async (request, reply) => {
    if (!isUnsafeMethod(request.method)) return;
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== config.appOrigin) {
      return reply.code(403).send({ error: 'FORBIDDEN', message: 'Origin tidak diizinkan' });
    }
    if (request.headers['sec-fetch-site'] === 'cross-site') {
      return reply.code(403).send({ error: 'FORBIDDEN', message: 'Request lintas situs ditolak' });
    }
  });
}

/** preHandler: verifikasi token CSRF terhadap sesi aktif. */
export async function requireCsrf(request, reply) {
  if (!isUnsafeMethod(request.method)) return;
  const provided = request.headers['x-csrf-token'];
  if (!request.auth || !safeEqual(provided, request.auth.session.csrf_token)) {
    return reply.code(403).send({ error: 'CSRF_INVALID', message: 'Token CSRF tidak valid' });
  }
}
