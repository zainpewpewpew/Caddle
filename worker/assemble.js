// Perakitan dependensi worker scanner TANPA efek samping: tidak membuka database, tidak memasang
// handler sinyal OS, tidak memulai timer/jaringan saat dipanggil. Dipakai worker/index.js (produksi)
// dan tes integrasi, sehingga tes menguji perakitan yang sama persis — terutama jam mana yang dipakai
// repositori (validasi "tertutup" candle), klien REST (isClosed kline), dan scanner.

import { createAnalysisPipeline } from '../backend/analysis/pipeline.js';
import { createRepositories } from '../backend/database/repositories/index.js';
import { createBinanceRestClient } from '../backend/ingestion/binance/restClient.js';
import { createKlineStream } from '../backend/ingestion/binance/wsClient.js';
import { createServerClock } from '../backend/ingestion/serverClock.js';
import { discoverSymbols } from '../backend/ingestion/symbolDiscovery.js';
import { DEFAULT_SCANNER_SETTINGS, SCANNER_SETTINGS_KEY } from '../backend/settings/scannerSettings.js';
import { createScanner } from './scanner.js';

/** Jeda tunggu candle HTF yang tutup bersamaan sebelum candle 5m dievaluasi (lihat createAnalysisPipeline). */
export const WORKER_SETTLE_MS = 3_000;

const NOOP_LOGGER = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });

/**
 * @param {{
 *   db: import('better-sqlite3').Database,
 *   logger?: object,
 *   clock?: () => number,
 *   fetch?: typeof globalThis.fetch,
 *   restSleep?: (ms: number) => Promise<void>,
 *   restRandom?: () => number,
 *   streamFactory?: (opts: object) => { start(): void, stop(): void, state(): object },
 *   setTimer?: Function, clearTimer?: Function,
 *   scannerOptions?: object,
 *   settleMs?: number,
 *   pipelineSleep?: (ms: number) => Promise<void>,
 *   onAlert?: (alert: object) => void,
 *   onAnalysed?: (e: { symbol: string, timeframe: string, candles: object[], reason: string, result: object }) => void,
 *   onMonitoringStopped?: (e: { symbol: string, timeframes: string[]|null, reason: string, at: number }) => void,
 * }} deps
 *   clock: jam LOKAL host (default Date.now). Jam server (`serverClock.now` = jam lokal + offset terukur)
 *   dibuat di sini dan menjadi jam repositori, klien REST, dan scanner.
 *   fetch/restSleep/restRandom/streamFactory/setTimer/clearTimer/pipelineSleep: injeksi I/O (default produksi).
 *   onAnalysed/onMonitoringStopped: pengamat (log/tes) — dipanggil SETELAH analisis / SEBELUM penutupan sinyal.
 * @returns {{ serverClock: object, repos: object, rest: object, pipeline: object, scanner: object,
 *   getSettings: () => Promise<object> }}
 *   Pemanggil wajib `await pipeline.ensureDefinitions()` sebelum `scanner.start()`.
 */
export function assembleWorker({
  db,
  logger = NOOP_LOGGER,
  clock = Date.now,
  fetch,
  restSleep,
  restRandom,
  streamFactory = (opts) => createKlineStream(opts),
  setTimer,
  clearTimer,
  scannerOptions,
  settleMs = WORKER_SETTLE_MS,
  pipelineSleep,
  onAlert,
  onAnalysed,
  onMonitoringStopped,
} = {}) {
  if (!db) throw new TypeError('db wajib ada');

  // Jam tersinkron waktu server Binance untuk REST, repositori (validasi "tertutup"), dan scanner.
  // Klien REST butuh jam saat dibuat, jam server butuh klien REST untuk sinkronisasi: keduanya saling
  // merujuk lewat fungsi yang baru dipanggil kemudian, jadi tidak ada dependensi melingkar saat konstruksi.
  const serverClock = createServerClock({ getServerTime: (opts) => rest.sampleServerTime(opts), clock, logger });
  const repos = createRepositories(db, { clock: serverClock.now });
  const rest = createBinanceRestClient({ fetch, clock: serverClock.now, sleep: restSleep, random: restRandom, logger });

  const getSettings = async () => (await repos.settings.get(SCANNER_SETTINGS_KEY))?.value ?? DEFAULT_SCANNER_SETTINGS;

  // Pipeline analisis per candle tertutup: pola → konteks multi-timeframe → skor → state machine → SQLite.
  // settleMs: stream per timeframe diproses paralel; beri jeda singkat agar candle 15m/1h yang tutup
  // bersamaan sudah tersimpan sebelum candle 5m dievaluasi (konteks live = replay).
  let scanner = null;
  const pipeline = createAnalysisPipeline({
    repos,
    signals: repos.signals,
    getLiquidity: (symbol) => scanner?.liquidityOf(symbol),
    settleMs,
    sleep: pipelineSleep,
    logger,
    onAlert,
  });

  scanner = createScanner({
    rest,
    streamFactory,
    repos,
    getSettings,
    discoverSymbols,
    onClosedCandles: async ({ symbol, timeframe, candles, reason }) => {
      const result = await pipeline.onClosedCandles({ symbol, timeframe, candles, reason });
      onAnalysed?.({ symbol, timeframe, candles, reason, result });
    },
    // Simbol delisted / keluar dari set pantauan tidak menerima candle lagi → sinyal terbukanya ditutup (EXPIRED).
    onMonitoringStopped: async (e) => {
      onMonitoringStopped?.(e);
      await pipeline.closeSymbol(e);
    },
    clock: serverClock.now,
    serverClock,
    logger,
    setTimer,
    clearTimer,
    options: scannerOptions,
  });

  return { serverClock, repos, rest, pipeline, scanner, getSettings };
}
