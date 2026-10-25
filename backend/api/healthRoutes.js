// Endpoint liveness/readiness publik. Responsnya minimal agar tidak membocorkan detail internal.

export async function healthRoutes(app, { db }) {
  app.get('/api/health', { config: { public: true } }, async () => ({ status: 'ok' }));

  app.get('/api/ready', { config: { public: true } }, async (request, reply) => {
    try {
      db.prepare('SELECT 1').get();
      return { status: 'ready' };
    } catch (err) {
      request.log.error({ err }, 'readiness check gagal');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
}
