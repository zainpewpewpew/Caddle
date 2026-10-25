import helmet from '@fastify/helmet';
import { isApiRoute } from './requestGuards.js';

/**
 * Header keamanan & Content Security Policy ketat.
 * Frontend tidak memakai script/style inline sehingga 'unsafe-inline' tidak diperlukan.
 */
export async function registerSecurityHeaders(app, config) {
  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        ...(config.isProduction ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    strictTransportSecurity: config.isProduction
      ? { maxAge: 31_536_000, includeSubDomains: true, preload: false }
      : false,
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    // Berdasarkan route yang cocok (bukan URL mentah) agar /%61pi/... juga tidak di-cache.
    if (isApiRoute(request)) {
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });
}
