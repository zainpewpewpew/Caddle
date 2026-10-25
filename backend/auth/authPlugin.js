import { isApiRoute, requireCsrf } from '../security/requestGuards.js';

/** Request polling latar belakang (auto-refresh) yang tidak boleh memperpanjang idle timeout. */
const isBackgroundPoll = (request) => request.method === 'GET' && request.headers['x-lr-background'] === '1';

/**
 * Menghubungkan sesi ke request. Seluruh route /api/* WAJIB terautentikasi
 * kecuali diberi `config: { public: true }` (secure by default).
 * Route dengan `config: { roles: [...] }` dibatasi berdasarkan peran.
 *
 * Gerbang dipasang per route (hook onRoute) sehingga:
 * - keputusan dibuat dari pola route saat registrasi — tidak bergantung pada bentuk URL;
 * - berjalan SETELAH hook rate limit (didaftarkan lebih dulu), jadi request tanpa sesi ikut dihitung;
 * - tetap di tahap onRequest — sebelum parsing & validasi body — agar request tanpa sesi
 *   tidak pernah menerima detail validasi skema.
 * Harus dipanggil setelah plugin rate limit terdaftar dan sebelum route didefinisikan.
 */
export function registerAuth(app, { sessionService, cookieName }) {
  app.decorateRequest('auth', null);

  // Sesi di-resolve untuk semua request (halaman '/' & login.html memerlukannya) tanpa memperpanjang idle.
  app.addHook('onRequest', async (request, reply) => {
    const token = request.cookies[cookieName];
    if (token) request.auth = await sessionService.resolve(token);
    // Fail closed: route API yang terdaftar sebelum registerAuth (tanpa gerbang) tidak pernah dilayani.
    const routeConfig = request.routeOptions.config ?? {};
    if (isApiRoute(request) && !routeConfig.public && !routeConfig.authGated) {
      request.log.error({ route: request.routeOptions.url }, 'route API tanpa gerbang autentikasi');
      return reply.code(401).send({ error: 'UNAUTHENTICATED', message: 'Autentikasi diperlukan' });
    }
  });

  async function gate(request, reply) {
    const routeConfig = request.routeOptions.config ?? {};
    if (!request.auth) {
      return reply.code(401).send({ error: 'UNAUTHENTICATED', message: 'Autentikasi diperlukan' });
    }
    if (routeConfig.roles && !routeConfig.roles.includes(request.auth.user.role)) {
      return reply.code(403).send({ error: 'FORBIDDEN', message: 'Akses ditolak' });
    }
    const denied = await requireCsrf(request, reply);
    if (denied) return denied;
    // Hanya aktivitas API terautentikasi yang memperpanjang idle timeout. Polling otomatis UI
    // (GET + X-LR-Background: 1) tidak dihitung sebagai aktivitas. Header ini hanya dapat
    // MEMPERPENDEK umur sesi pemiliknya sendiri, sehingga aman dipercaya dari klien.
    if (!isBackgroundPoll(request)) await sessionService.touch(request.auth);
  }

  app.addHook('onRoute', (routeOptions) => {
    if (!routeOptions.url.startsWith('/api/') || routeOptions.config?.public) return;
    const existing = routeOptions.onRequest;
    routeOptions.onRequest = [...(Array.isArray(existing) ? existing : existing ? [existing] : []), gate];
    routeOptions.config = { ...routeOptions.config, authGated: true };
  });
}
