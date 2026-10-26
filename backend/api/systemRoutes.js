// Status sistem nyata. Status worker berasal dari heartbeat di database; bila worker belum
// pernah berjalan dilaporkan 'not_running', bukan data palsu. `workerControl` = status supervisor
// (proses worker yang dijalankan dari website, lihat backend/system/workerSupervisor.js).
// GET /api/system/sync = subset ringan untuk memantau proses sync scanner secara langsung.
import { buildMarketContext } from '../system/marketContext.js';
import { summarizeWorker } from '../system/workerStatus.js';

export async function systemRoutes(app, { db, overview, ingestion, candles, schemaVersion, clock, startedAt, workerSupervisor, workerControl }) {
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
    const ingestionStatus = await ingestion.getStatus();
    const worker = summarizeWorker(ingestionStatus, clock());
    // Status supervisor (tombol scanner) memakai heartbeat yang sama — tanpa query kedua.
    const control = { enabled: workerControl, ...(await workerSupervisor.status({ heartbeat: ingestionStatus.heartbeat })) };
    return {
      serverTime: clock(),
      uptimeSec: Math.round((clock() - startedAt) / 1000),
      nodeVersion: process.version,
      memory: { rssBytes: mem.rss, heapUsedBytes: mem.heapUsed, heapTotalBytes: mem.heapTotal },
      database,
      ...worker,
      workerControl: control,
    };
  });

  // Polling ringan panel "Proses sync scanner" (tiap 2–10 detik, docs/09-proses-sync.md): satu baca status ingesti
  // (heartbeat dipakai ulang oleh supervisor), tanpa ping database, metrik memori, atau konteks pasar.
  // `worker` = tampilan GET /api/system/worker; `scanner` memuat `sync`; error terbaru (maks. 5) dari summarizeWorker.
  app.get('/api/system/sync', async () => {
    const ingestionStatus = await ingestion.getStatus();
    const { scanner, binance, ingestion: { recentErrors } } = summarizeWorker(ingestionStatus, clock());
    const worker = { enabled: workerControl, ...(await workerSupervisor.status({ heartbeat: ingestionStatus.heartbeat })) };
    return { serverTime: clock(), worker, scanner, binance, recentErrors };
  });

  app.get('/api/overview', async () => {
    const summary = await overview.summary();
    const { scanner, binance } = summarizeWorker(await ingestion.getStatus(), clock());
    // Waktu ingesti terakhir dari heartbeat worker (tanpa scan MAX() atas seluruh tabel candle).
    return { ...summary, lastIngestionAt: scanner.lastIngestionAt ?? null, scanner, binance, marketContext: await buildMarketContext(candles) };
  });
}
