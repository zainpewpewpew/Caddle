import { requireCsrf } from '../security/requestGuards.js';

/**
 * Menghubungkan sesi ke request. Seluruh route /api/* WAJIB terautentikasi
 * kecuali diberi `config: { public: true }` (secure by default).
 * Route dengan `config: { roles: [...] }` dibatasi berdasarkan peran.
 */
export function registerAuth(app, { sessionService, cookieName }) {
  app.decorateRequest('auth', null);

  // Gerbang autentikasi dijalankan di onRequest — sebelum parsing & validasi body —
  // agar request tanpa sesi tidak pernah menerima detail validasi skema.
  app.addHook('onRequest', async (request, reply) => {
    const token = request.cookies[cookieName];
    if (token) request.auth = await sessionService.resolve(token);

    const routeConfig = request.routeOptions.config ?? {};
    if (!request.url.startsWith('/api/') || routeConfig.public) return;

    if (!request.auth) {
      return reply.code(401).send({ error: 'UNAUTHENTICATED', message: 'Autentikasi diperlukan' });
    }
    if (routeConfig.roles && !routeConfig.roles.includes(request.auth.user.role)) {
      return reply.code(403).send({ error: 'FORBIDDEN', message: 'Akses ditolak' });
    }
    return requireCsrf(request, reply);
  });
}
