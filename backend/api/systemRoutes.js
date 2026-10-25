// Status sistem nyata. Status worker berasal dari heartbeat di database; bila worker belum
// pernah berjalan dilaporkan 'not_running', bukan data palsu.
import { buildMarketContext } from '../system/marketContext.js';
import { summarizeWorker } from '../system/workerStatus.js';

export async function systemRoutes(app, { db, overview, ingestion, candles, schemaVersion, clock, startedAt }) {
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
    const worker = summarizeWorker(await ingestion.getStatus(), clock());
    return {
      serverTime: clock(),
      uptimeSec: Math.round((clock() - startedAt) / 1000),
      nodeVersion: process.version,
      memory: { rssBytes: mem.rss, heapUsedBytes: mem.heapUsed, heapTotalBytes: mem.heapTotal },
      database,
      ...worker,
    };
  });

  app.get('/api/overview', async () => {
    const summary = await overview.summary();
    const { scanner, binance } = summarizeWorker(await ingestion.getStatus(), clock());
    // Waktu ingesti terakhir dari heartbeat worker (tanpa scan MAX() atas seluruh tabel candle).
    return { ...summary, lastIngestionAt: scanner.lastIngestionAt ?? null, scanner, binance, marketContext: await buildMarketContext(candles) };
  });
}
