// Perakitan dependensi worker scanner TANPA efek samping: tidak membuka database, tidak memasang
// handler sinyal OS, tidak memulai timer/jaringan saat dipanggil. Dipakai worker/index.js (produksi)
// dan tes integrasi, sehingga tes menguji perakitan yang sama persis — terutama jam mana yang dipakai
// repositori (validasi "tertutup" candle), klien REST (isClosed kline), dan scanner.
//
// Satu pipeline atas candle tertutup: analisis SA/PVA (LONG Scanner, 1h) & SD/PVD (SHORT Scanner, 15m, konteks HTF 1h) —
// DIRECTION_TIMEFRAMES. Error diteruskan ke scanner (tercatat sebagai error ingesti sumber 'analysis'). Timeframe
// ingesti = timeframe arah aktif ∪ CHART_TIMEFRAMES (5m diingesti HANYA untuk grafik Symbol Intelligence).
// Reversal Radar dihapus dari worker & website 2026-11-15 (keputusan pengguna: LONG Scanner kembali ke pola SA/PVA,
// yang lebih sesuai); mesinnya tetap di backend/reversal untuk alat riset `npm run reversal:replay`, dan riwayat
// kandidatnya tetap di database.

import { createAnalysisPipeline } from '../backend/analysis/pipeline.js';
import { createRepositories } from '../backend/database/repositories/index.js';
import { createBinanceRestClient } from '../backend/ingestion/binance/restClient.js';
import { createKlineStream } from '../backend/ingestion/binance/wsClient.js';
import { CLOSE_MARGIN_MS } from '../backend/ingestion/backfill.js';
import { createServerClock } from '../backend/ingestion/serverClock.js';
import { discoverSymbols } from '../backend/ingestion/symbolDiscovery.js';
import { CHART_TIMEFRAMES, DIRECTIONS, DIRECTION_TIMEFRAMES, TIMEFRAMES, scannedTimeframes } from '../backend/market/contracts.js';
import { DEFAULT_SCANNER_SETTINGS, SCANNER_SETTINGS_KEY } from '../backend/settings/scannerSettings.js';
import { createActivityFeed } from './activity.js';
import { createScanner } from './scanner.js';

/** Jeda tunggu candle HTF (1h) yang tutup bersamaan sebelum candle 15m dievaluasi (lihat createAnalysisPipeline). */
export const WORKER_SETTLE_MS = 3_000;
/** Scan berkala worker: semua seri diperiksa & ditambal tiap menit (keputusan pengguna 2026-11-15). */
export const SCAN_INTERVAL_MS = 60_000;

const NOOP_LOGGER = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });

/**
 * Timeframe yang diingesti worker: gabungan timeframe per arah (SA/PVA, SD/PVD, beserta HTF konteksnya) ∪ timeframe
 * grafik (CHART_TIMEFRAMES). Analisis tetap hanya pada timeframe arah aktif (DIRECTION_TIMEFRAMES).
 */
export function workerTimeframes(directions = DIRECTIONS, chartTimeframes = CHART_TIMEFRAMES) {
  const scanned = scannedTimeframes(directions);
  return TIMEFRAMES.filter((tf) => scanned.includes(tf) || chartTimeframes.includes(tf));
}

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
 *   directions?: Array<'LONG'|'SHORT'>,
 *   onAnalysed?: (e: { symbol: string, timeframe: string, candles: object[], reason: string, result: object }) => void,
 *   onMonitoringStopped?: (e: { symbol: string, timeframes: string[]|null, reason: string, at: number }) => void,
 *   heartbeatOwner?: { pid: number, host: string } | null,
 *   analysisParams?: object,
 *   directionTimeframes?: Record<string, string[]>|null,
 *   activity?: object,
 * }} deps
 *   directionTimeframes: timeframe per arah (default DIRECTION_TIMEFRAMES: LONG 1h, SHORT 15m); null = semua (tes).
 *   clock: jam LOKAL host (default Date.now). Jam server (`serverClock.now` = jam lokal + offset terukur)
 *   dibuat di sini dan menjadi jam repositori, klien REST, dan scanner (`clock`); jam lokal menjadi
 *   `localClock` scanner untuk stempel operasional (heartbeat, run, error, lastIngestionAt).
 *   fetch/restSleep/restRandom/streamFactory/setTimer/clearTimer/pipelineSleep: injeksi I/O (default produksi).
 *   onAnalysed/onMonitoringStopped: pengamat (log/tes) — dipanggil SETELAH analisis / SEBELUM penutupan sinyal.
 *   onAlert: menerima { symbol, timeframe, direction, state, event, view } (lihat createAnalysisPipeline).
 *   directions: arah yang dipindai (default kedua arah: LONG = SA/PVA, SHORT = SD/PVD). Satu worker, satu
 *   pipeline; setiap candle tertutup dievaluasi untuk semua arah dengan candle & fitur bersama.
 *   heartbeatOwner: identitas proses untuk heartbeat (worker/index.js mengisi pid + hostname; default null).
 *   analysisParams: `params` pipeline analisis (override pola/sinyal/konfluensi + `calibration` hasil backtest;
 *   lihat analyzeDirectionsAt). Default {} = parameter bawaan v3 (gerbang tier EARLY minEarlyTier 'B').
 *   activity: log aktivitas (worker/activity.js); default feed baru berjam `clock`. Sinyal yang memicu alert dan candle
 *   yang dianalisis ikut dicatat di sini, di samping aktivitas scanner. Scan berkala SCAN_INTERVAL_MS (opsi scanner
 *   `scanIntervalMs`, null = mati) melaporkan sinyal terbuka arah aktif (DIRECTION_TIMEFRAMES).
 * @returns {{ serverClock: object, repos: object, rest: object, pipeline: object, scanner: object,
 *   getSettings: () => Promise<object>, activity: object }}
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
  heartbeatOwner = null,
  directions = DIRECTIONS,
  directionTimeframes = DIRECTION_TIMEFRAMES,
  analysisParams = {},
  activity = createActivityFeed({ clock }),
} = {}) {
  if (!db) throw new TypeError('db wajib ada');

  // Jam tersinkron waktu server Binance untuk REST, repositori (validasi "tertutup"), dan scanner.
  // Klien REST butuh jam saat dibuat, jam server butuh klien REST untuk sinkronisasi: keduanya saling
  // merujuk lewat fungsi yang baru dipanggil kemudian, jadi tidak ada dependensi melingkar saat konstruksi.
  const serverClock = createServerClock({ getServerTime: (opts) => rest.sampleServerTime(opts), clock, logger });
  const repos = createRepositories(db, { clock: serverClock.now });
  // Margin penutupan yang sama untuk isClosed kline REST dan rencana backfill/gap/sweep scanner.
  const closeMarginMs = scannerOptions?.closeMarginMs ?? CLOSE_MARGIN_MS;
  // isClosed kline REST & rencana REST scanner memakai jam acuan penutupan (serverClock.closureNow): sama dengan
  // serverClock.now, kecuali jam host diketahui di depan server (OFFSET_OUT_OF_RANGE) — candle berjalan tetap parsial.
  const rest = createBinanceRestClient({
    fetch, clock: serverClock.now, closureClock: serverClock.closureNow, sleep: restSleep, random: restRandom, logger, closeMarginMs,
  });

  const getSettings = async () => (await repos.settings.get(SCANNER_SETTINGS_KEY))?.value ?? DEFAULT_SCANNER_SETTINGS;

  // Pipeline analisis per candle tertutup: pola → konteks multi-timeframe → skor → state machine → SQLite,
  // untuk arah LONG dan SHORT sekaligus (Short Scanner — kandidat riset, bukan eksekusi order).
  // settleMs: stream per timeframe diproses paralel; beri jeda singkat agar candle 1h yang tutup
  // bersamaan sudah tersimpan sebelum candle 15m dievaluasi (konteks live = replay).
  let scanner = null;
  const pipeline = createAnalysisPipeline({
    repos,
    signals: repos.signals,
    getLiquidity: (symbol) => scanner?.liquidityOf(symbol),
    settleMs,
    sleep: pipelineSleep,
    logger,
    // Alert sinyal → log aktivitas (strip status UI) lalu pengamat pemanggil (log worker / tes).
    onAlert: (alert) => {
      activity.signal(alert);
      onAlert?.(alert);
    },
    directions,
    // LONG hanya 1h, SHORT hanya 15m (keputusan pengguna 2026-11-15); seri lain hanya konteks HTF/grafik.
    directionTimeframes,
    params: analysisParams,
  });

  // Timeframe yang benar-benar dianalisis pipeline (arah aktif × DIRECTION_TIMEFRAMES); 5m grafik tidak termasuk. Hanya
  // candle timeframe ini yang dicatat di log aktivitas "Candle … tutup · n koin dianalisis".
  const analysedTimeframes = new Set(directions.flatMap((d) => (directionTimeframes === null ? TIMEFRAMES : (directionTimeframes[d] ?? []))));

  async function onClosedCandles({ symbol, timeframe, candles, reason }) {
    const result = await pipeline.onClosedCandles({ symbol, timeframe, candles, reason });
    onAnalysed?.({ symbol, timeframe, candles, reason, result });
    // Satu entri per timeframe × waktu tutup (digabung activity.candles): "Candle 15m 19:15 tutup · 40 koin dianalisis".
    if (candles.length > 0 && analysedTimeframes.has(timeframe)) activity.candles({ timeframe, closeTime: candles.at(-1).closeTime });
  }

  scanner = createScanner({
    rest,
    streamFactory,
    repos,
    getSettings,
    discoverSymbols,
    onClosedCandles,
    // Simbol delisted / keluar dari set pantauan tidak menerima candle lagi → sinyal terbukanya ditutup (EXPIRED).
    onMonitoringStopped: async (e) => {
      onMonitoringStopped?.(e);
      await pipeline.closeSymbol(e);
    },
    // Rekonsiliasi level-triggered: sinyal terbuka untuk seri yang tidak dipantau ditutup tiap discovery berhasil.
    listOpenSeries: () => repos.signals.listOpenSeries(),
    // Waktu pasar (closeTime, backfill, sweep) = jam server; stempel operasional yang dibandingkan
    // /api/system/status dengan Date.now proses API (heartbeat, run, error, lastIngestionAt) = jam lokal.
    clock: serverClock.now,
    localClock: clock,
    closureClock: serverClock.closureNow,
    serverClock,
    logger,
    setTimer,
    clearTimer,
    // Timeframe ingesti tetap = DIRECTION_TIMEFRAMES arah aktif ∪ CHART_TIMEFRAMES (pengaturan `timeframes` lama diabaikan).
    // Scan berkala tiap SCAN_INTERVAL_MS kecuali tes menimpanya lewat scannerOptions.scanIntervalMs.
    options: { timeframes: workerTimeframes(directions), scanIntervalMs: SCAN_INTERVAL_MS, ...scannerOptions, closeMarginMs },
    heartbeatOwner,
    activity,
    countOpen: () => countOpen({ repos, directions, directionTimeframes }),
  });

  return { serverClock, repos, rest, pipeline, scanner, getSettings, activity };
}

/**
 * Sinyal terbuka yang TAMPIL di UI (arah aktif × timeframe arah itu) — untuk ringkasan scan berkala
 * ("sinyal terbuka LONG 4 · SHORT 2").
 */
async function countOpen({ repos, directions, directionTimeframes }) {
  const { signals } = await repos.overview.openCounts();
  const shown = (direction, timeframe) => directions.includes(direction)
    && (directionTimeframes === null || (directionTimeframes[direction] ?? []).includes(timeframe));
  const sum = (keep) => signals.reduce((total, row) => total + (keep(row) ? row.n : 0), 0);
  return {
    long: sum((r) => r.direction === 'LONG' && shown('LONG', r.timeframe)),
    short: sum((r) => r.direction === 'SHORT' && shown('SHORT', r.timeframe)),
  };
}
