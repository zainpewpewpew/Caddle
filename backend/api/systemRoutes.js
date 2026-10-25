// Status sistem nyata. Komponen yang belum dibangun dilaporkan sebagai 'not_implemented',
// bukan sebagai data palsu.

export async function systemRoutes(app, { db, overview, schemaVersion, clock, startedAt }) {
  app.get('/api/system/status', async () => {
    let database;
    try {
      const started = performance.now();
      db.prepare('SELECT 1').get();
      database = { status: 'ok', schemaVersion: schemaVersion(), latencyMs: Number((performance.now() - started).toFixed(3)) };
    } catch {
      database = { status: 'error', schemaVersion: null, latencyMs: null };
    }
    const mem = process.memoryUsage();
    return {
      serverTime: clock(),
      uptimeSec: Math.round((clock() - startedAt) / 1000),
      nodeVersion: process.version,
      memory: { rssBytes: mem.rss, heapUsedBytes: mem.heapUsed, heapTotalBytes: mem.heapTotal },
      database,
      binance: { status: 'not_implemented', milestone: 2 },
      scanner: { status: 'not_implemented', milestone: 2 },
    };
  });

  app.get('/api/overview', async () => {
    const summary = await overview.summary();
    return {
      ...summary,
      scanner: { status: 'not_implemented', milestone: 2 },
      marketContext: { status: 'not_implemented', milestone: 2 },
    };
  });
}
