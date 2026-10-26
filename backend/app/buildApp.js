import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';

import { authRoutes } from '../api/authRoutes.js';
import { healthRoutes } from '../api/healthRoutes.js';
import { marketRoutes } from '../api/marketRoutes.js';
import { settingsRoutes } from '../api/settingsRoutes.js';
import { signalRoutes } from '../api/signalRoutes.js';
import { systemRoutes } from '../api/systemRoutes.js';
import { workerRoutes } from '../api/workerRoutes.js';
import { registerAuth } from '../auth/authPlugin.js';
import { createAuthService } from '../auth/authService.js';
import { createPasswordHasher } from '../auth/password.js';
import { createSessionService } from '../auth/sessionService.js';
import { migrate } from '../database/migrate.js';
import { createRepositories } from '../database/repositories/index.js';
import { registerSecurityHeaders } from '../security/headers.js';
import { isApiRoute, registerRequestGuards } from '../security/requestGuards.js';
import { WORKER_SCRIPT_PATH, WorkerSupervisorError, createWorkerSupervisor } from '../system/workerSupervisor.js';

const FRONTEND_ROOT = fileURLToPath(new URL('../../frontend/', import.meta.url));
const SESSION_PURGE_INTERVAL_MS = 15 * 60_000;
// Library grafik (TradingView Lightweight Charts, Apache-2.0 — lihat THIRD_PARTY_NOTICES.md). Hanya SATU file build
// standalone produksi yang disajikan di path tetap; direktori node_modules tidak pernah dibuka untuk umum.
const CHART_VENDOR_DIR = path.join(path.dirname(createRequire(import.meta.url).resolve('lightweight-charts/package.json')), 'dist');
const CHART_VENDOR_FILE = 'lightweight-charts.standalone.production.js';

/**
 * Merakit aplikasi Fastify. Seluruh dependensi diinjeksi agar dapat diuji tanpa jaringan.
 * @param {{ config: ReturnType<import('./config.js').loadConfig>, db: import('better-sqlite3').Database,
 *           clock?: () => number, hasherOptions?: object, logger?: any,
 *           workerSupervisor?: ReturnType<typeof createWorkerSupervisor>, workerScriptPath?: string,
 *           workerRestartCooldownMs?: number }} options
 *   workerSupervisor / workerScriptPath / workerRestartCooldownMs: KHUSUS tes & E2E (supervisor dengan fork tiruan,
 *   skrip worker tiruan, jeda start ulang lebih pendek). Tidak pernah dibaca dari env maupun request; server produksi
 *   selalu menjalankan worker/index.js dengan jeda RESTART_COOLDOWN_MS.
 */
export async function buildApp({
  config, db, clock = Date.now, hasherOptions, logger, workerSupervisor, workerScriptPath, workerRestartCooldownMs,
}) {
  const app = Fastify({
    logger: logger ?? {
      level: config.logLevel,
      redact: ['req.headers.cookie', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]'],
    },
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024,
    connectionTimeout: 30_000,
    requestTimeout: 30_000,
    keepAliveTimeout: 5_000,
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
    return503OnClosing: true,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false, allErrors: false } },
  });

  // Hanya JSON yang diterima. text/plain dihapus karena dapat dikirim lintas situs tanpa preflight CORS.
  app.removeContentTypeParser('text/plain');

  const { current: currentSchemaVersion } = migrate(db);
  const schemaVersion = () => currentSchemaVersion;

  const repos = createRepositories(db, { clock });
  const hasher = createPasswordHasher(hasherOptions);
  const sessionService = createSessionService({
    sessions: repos.sessions, users: repos.users, config: config.session, clock,
  });
  const authService = createAuthService({
    users: repos.users, audit: repos.audit, hasher, sessionService, config: config.login, clock,
  });
  // Prefix __Host- memaksa cookie Secure, path=/, tanpa Domain (hanya bila HTTPS).
  const cookieName = config.cookieSecure ? '__Host-lr_session' : 'lr_session';

  // Worker scanner sebagai child process terpisah (tombol di System Health). DATABASE_PATH diteruskan
  // eksplisit agar child selalu menulis ke database yang sama dengan server.
  const supervisor = workerSupervisor ?? createWorkerSupervisor({
    scriptPath: workerScriptPath ?? WORKER_SCRIPT_PATH,
    env: { ...process.env, DATABASE_PATH: config.databasePath },
    logger: app.log.child({ module: 'worker-supervisor' }),
    clock,
    readExternalHeartbeat: async () => (await repos.ingestion.getStatus()).heartbeat,
    ...(workerRestartCooldownMs !== undefined ? { restartCooldownMs: workerRestartCooldownMs } : {}),
  });

  app.decorate('services', { hasher, sessionService, authService, repos, workerSupervisor: supervisor });

  await registerSecurityHeaders(app, config);
  registerRequestGuards(app, config);
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: 60_000,
    // Aset statis (CSS/JS/ikon) tidak dihitung; batas ini melindungi endpoint API.
    // Keputusan dari route yang cocok, bukan URL mentah (path ter-encode / absolute-form).
    allowList: (request) => !isApiRoute(request),
    errorResponseBuilder: (request, context) => ({
      statusCode: context.statusCode,
      error: 'RATE_LIMITED',
      message: 'Terlalu banyak permintaan. Coba lagi nanti.',
    }),
  });
  registerAuth(app, { sessionService, cookieName });

  app.setErrorHandler((err, request, reply) => {
    if (err.validation) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: 'Input tidak valid',
        details: err.validation.slice(0, 5).map((v) => ({ path: v.instancePath || '/', message: v.message })),
      });
    }
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) {
      request.log.error({ err }, 'unhandled error');
      return reply.code(500).send({ error: 'INTERNAL_ERROR', message: 'Terjadi kesalahan internal' });
    }
    if (status === 429) return reply.code(429).send({ error: 'RATE_LIMITED', message: 'Terlalu banyak permintaan. Coba lagi nanti.' });
    const code = err.code === 'FST_ERR_CTP_BODY_TOO_LARGE' ? 'PAYLOAD_TOO_LARGE'
      : err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' ? 'UNSUPPORTED_MEDIA_TYPE'
        : 'BAD_REQUEST';
    return reply.code(status).send({ error: code, message: 'Permintaan tidak dapat diproses' });
  });

  // Catch-all API: path /api/* yang tidak dikenal tetap melewati gerbang auth (tanpa sesi → 401,
  // dengan sesi → 404) sehingga peta route tidak bocor dan tidak jatuh ke handler file statis.
  app.all('/api/*', async (request, reply) => reply.code(404).send({ error: 'NOT_FOUND', message: 'Tidak ditemukan' }));

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: 'NOT_FOUND', message: 'Tidak ditemukan' });
  });

  const deps = { db, config, clock, cookieName, audit: repos.audit, settings: repos.settings, overview: repos.overview };
  await app.register(healthRoutes, deps);
  await app.register(authRoutes, { ...deps, authService, sessionService });
  await app.register(settingsRoutes, deps);
  await app.register(systemRoutes, {
    ...deps, ingestion: repos.ingestion, candles: repos.candles, schemaVersion, startedAt: clock(),
    workerSupervisor: supervisor, workerControl: config.workerControl,
  });
  await app.register(workerRoutes, { supervisor, enabled: config.workerControl, audit: repos.audit, clock });
  await app.register(signalRoutes, { signals: repos.signals, candles: repos.candles });
  await app.register(marketRoutes, { candles: repos.candles });

  // Frontend statis. index.html hanya disajikan lewat route '/' yang memeriksa sesi.
  await app.register(fastifyStatic, {
    root: FRONTEND_ROOT,
    index: false,
    wildcard: true,
    dotfiles: 'deny',
    allowedPath: (pathName) => pathName !== '/index.html',
  });

  // File vendor grafik: publik seperti aset statis lain (kode open-source, tanpa data), header cache & tipe konten
  // sama dengan handler statis (@fastify/static). Dimuat malas oleh frontend/js/lib/chart.js, tidak oleh login.
  app.get('/vendor/lightweight-charts.js', { config: { public: true } }, async (request, reply) => (
    reply.sendFile(CHART_VENDOR_FILE, CHART_VENDOR_DIR)));

  app.get('/', { config: { public: true } }, async (request, reply) => {
    if (!request.auth) return reply.redirect('/login.html', 302);
    reply.header('Cache-Control', 'no-store');
    return reply.sendFile('index.html');
  });

  app.get('/login.html', { config: { public: true } }, async (request, reply) => {
    if (request.auth) return reply.redirect('/', 302);
    reply.header('Cache-Control', 'no-store');
    return reply.sendFile('login.html');
  });

  let purgeTimer;
  app.addHook('onReady', async () => {
    purgeTimer = setInterval(() => {
      sessionService.purgeExpired().catch((err) => app.log.error({ err }, 'purge sesi gagal'));
    }, SESSION_PURGE_INTERVAL_MS);
    purgeTimer.unref();
  });
  app.addHook('onClose', async () => clearInterval(purgeTimer));

  // WORKER_AUTOSTART: worker dijalankan saat server siap (sebelum listen), tercatat di audit tanpa user.
  app.addHook('onReady', async () => {
    if (!config.workerAutostart) return;
    if (!config.workerControl) {
      app.log.warn('WORKER_AUTOSTART=true diabaikan karena WORKER_CONTROL=false');
      return;
    }
    const record = (outcome, detail) => repos.audit.record({ occurredAt: clock(), action: 'worker.start', outcome, detail });
    try {
      const status = await supervisor.start();
      await record('success', { via: 'autostart', state: status.state });
    } catch (err) {
      if (!(err instanceof WorkerSupervisorError)) throw err;
      app.log.warn({ code: err.code }, 'autostart worker scanner dibatalkan');
      await record('failure', { via: 'autostart', reason: err.code });
    }
  });
  // Child tidak boleh menjadi yatim: menutup aplikasi selalu menghentikan worker lebih dulu.
  app.addHook('onClose', async () => supervisor.shutdown());

  return app;
}
