// Entry point proses worker scanner (Milestone 2–3): `npm run worker`.
// Merakit dependensi nyata (REST/WS Binance, SQLite, repositori, pipeline analisis SA/PVA),
// menjalankan scanner, dan menangani graceful shutdown (SIGTERM/SIGINT).
// Log terstruktur JSON per baris ke stdout.

import { createAnalysisPipeline } from '../backend/analysis/pipeline.js';
import { ConfigError, loadConfig } from '../backend/app/config.js';
import { openDatabase } from '../backend/database/connection.js';
import { migrate } from '../backend/database/migrate.js';
import { createRepositories } from '../backend/database/repositories/index.js';
import { createBinanceRestClient } from '../backend/ingestion/binance/restClient.js';
import { createKlineStream } from '../backend/ingestion/binance/wsClient.js';
import { createServerClock } from '../backend/ingestion/serverClock.js';
import { discoverSymbols } from '../backend/ingestion/symbolDiscovery.js';
import { DEFAULT_SCANNER_SETTINGS, SCANNER_SETTINGS_KEY } from '../backend/settings/scannerSettings.js';
import { createScanner } from './scanner.js';

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

  // Jam tersinkron waktu server Binance untuk REST, repositori (validasi "tertutup"), dan scanner.
  // Klien REST butuh jam saat dibuat, jam server butuh klien REST untuk sinkronisasi: keduanya saling
  // merujuk lewat fungsi yang baru dipanggil kemudian, jadi tidak ada dependensi melingkar saat konstruksi.
  const serverClock = createServerClock({ getServerTime: () => rest.getServerTime(), clock: Date.now, logger });
  const repos = createRepositories(db, { clock: serverClock.now });

  const rest = createBinanceRestClient({
    clock: serverClock.now,
    logger,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });

  const getSettings = async () => (await repos.settings.get(SCANNER_SETTINGS_KEY))?.value ?? DEFAULT_SCANNER_SETTINGS;

  // Pipeline analisis per candle tertutup: pola → konteks multi-timeframe → skor → state machine → SQLite.
  // settleMs: stream per timeframe diproses paralel; beri jeda singkat agar candle 15m/1h yang tutup
  // bersamaan sudah tersimpan sebelum candle 5m dievaluasi (konteks live = replay).
  let scanner = null;
  const pipeline = createAnalysisPipeline({
    repos,
    signals: repos.signals,
    getLiquidity: (symbol) => scanner?.liquidityOf(symbol),
    settleMs: 3_000,
    logger,
    onAlert: (alert) => logger.info({ symbol: alert.symbol, timeframe: alert.timeframe, state: alert.state, reason: alert.event?.reason }, 'sinyal baru / naik tahap'),
  });
  await pipeline.ensureDefinitions();

  scanner = createScanner({
    rest,
    streamFactory: (opts) => createKlineStream(opts),
    repos,
    getSettings,
    discoverSymbols,
    onClosedCandles: async ({ symbol, timeframe, candles, reason }) => {
      const result = await pipeline.onClosedCandles({ symbol, timeframe, candles, reason });
      logger.debug({ symbol, timeframe, reason, count: candles.length, ...result }, 'candle tertutup dianalisis');
    },
    clock: serverClock.now,
    serverClock,
    logger,
  });

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
