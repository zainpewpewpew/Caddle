// Entry point proses worker scanner (Milestone 2–3): `npm run worker`, atau dijalankan server sebagai child
// process lewat tombol "Jalankan scanner" (backend/system/workerSupervisor.js).
// Membuka SQLite + migrasi, merakit dependensi nyata lewat worker/assemble.js (REST/WS Binance, jam
// server, repositori, pipeline analisis SA/PVA), menjalankan scanner, dan menangani graceful shutdown (SIGTERM/SIGINT).
// Log terstruktur JSON per baris ke stdout.

import { ConfigError, loadConfig } from '../backend/app/config.js';
import { openDatabase } from '../backend/database/connection.js';
import { migrate } from '../backend/database/migrate.js';
import { assembleWorker } from './assemble.js';

const LEVELS = Object.freeze({ trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60, silent: Infinity });
const RESERVED = new Set(['time', 'level', 'msg']);
const SHUTDOWN_TIMEOUT_MS = 10_000;
const STATUS_LOG_INTERVAL_MS = 60_000;

function serialize(value) {
  if (value instanceof Error) return { name: value.name, message: value.message, status: value.status };
  return value;
}

/**
 * Logger JSON ringan (tanpa dependensi). Mendukung gaya pino `log(fields, msg)` dan `log(msg, fields)`.
 * @param {{ level?: string, write?: (line: string) => void, clock?: () => number }} options
 */
function createJsonLogger({ level = 'info', write = (line) => process.stdout.write(`${line}\n`), clock = Date.now } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const at = (name) => (a, b) => {
    if (LEVELS[name] < threshold) return;
    const [fields, msg] = typeof a === 'string' ? [b, a] : [a, b];
    const entry = { time: new Date(clock()).toISOString(), level: name, msg: typeof msg === 'string' ? msg : '' };
    if (fields && typeof fields === 'object') {
      for (const [key, value] of Object.entries(fields)) {
        if (!RESERVED.has(key)) entry[key] = serialize(value);
      }
    }
    let line;
    try {
      line = JSON.stringify(entry);
    } catch {
      line = JSON.stringify({ time: entry.time, level: name, msg: entry.msg, note: 'field log tidak dapat diserialisasi' });
    }
    write(line);
  };
  return { trace: at('trace'), debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), fatal: at('fatal') };
}

async function main() {
  // Saat dijalankan dari website, stdout/stderr adalah pipe ke server. Bila server mati, tulisan log gagal
  // (EPIPE) sebagai event 'error' asinkron; tanpa listener event itu menjadi uncaughtException yang
  // handler-nya menulis log lagi (EPIPE lagi) dan graceful shutdown tidak pernah selesai. Log yang tidak
  // dapat ditulis dibuang saja.
  for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Konfigurasi tidak valid: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  const logger = createJsonLogger({ level: config.logLevel });
  if (typeof globalThis.WebSocket !== 'function') {
    logger.fatal({}, 'WebSocket global tidak tersedia (butuh Node 22)');
    process.exit(1);
  }

  const db = openDatabase(config.databasePath);
  const { applied, current } = migrate(db);
  logger.info({ applied, schemaVersion: current }, 'migrasi database selesai');

  // Perakitan jam server, repositori, REST, pipeline, dan scanner ada di worker/assemble.js (tanpa efek
  // samping) agar tes integrasi menguji perakitan yang sama.
  const { pipeline, scanner } = assembleWorker({
    db,
    logger,
    clock: Date.now,
    onAlert: (alert) => logger.info({ symbol: alert.symbol, timeframe: alert.timeframe, state: alert.state, reason: alert.event?.reason }, 'sinyal baru / naik tahap'),
    onAnalysed: ({ symbol, timeframe, reason, candles, result }) => {
      logger.debug({ symbol, timeframe, reason, count: candles.length, ...result }, 'candle tertutup dianalisis');
    },
  });
  await pipeline.ensureDefinitions();

  const statusTimer = setInterval(() => logger.info(scanner.status(), 'status scanner'), STATUS_LOG_INTERVAL_MS);

  let shuttingDown = false;
  const shutdown = async (reason, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ reason }, 'menghentikan worker');
    const forceExit = setTimeout(() => {
      logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'shutdown melewati batas waktu, keluar paksa');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();
    clearInterval(statusTimer);
    let code = exitCode;
    try {
      await scanner.stop();
    } catch (err) {
      logger.error({ err }, 'gagal menghentikan scanner');
      code = 1;
    }
    try {
      db.close();
    } catch (err) {
      logger.error({ err }, 'gagal menutup database');
      code = 1;
    }
    logger.info({ code }, 'worker berhenti');
    process.exit(code);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  // Dijalankan dari website (child process server dengan kanal IPC): bila server mati tanpa sempat
  // menghentikan worker, kanal IPC terputus → worker berhenti sendiri, tidak menjadi proses yatim.
  if (typeof process.send === 'function') process.on('disconnect', () => shutdown('disconnect'));
  process.on('unhandledRejection', (err) => {
    logger.fatal({ err }, 'unhandled rejection');
    shutdown('unhandledRejection', 1);
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    shutdown('uncaughtException', 1);
  });

  logger.info({ databasePath: config.databasePath }, 'worker scanner mulai');
  await scanner.start();
  logger.info(scanner.status(), 'bootstrap scanner selesai');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
