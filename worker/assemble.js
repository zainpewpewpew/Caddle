// Perakitan dependensi worker scanner TANPA efek samping: tidak membuka database, tidak memasang
// handler sinyal OS, tidak memulai timer/jaringan saat dipanggil. Dipakai worker/index.js (produksi)
// dan tes integrasi, sehingga tes menguji perakitan yang sama persis — terutama jam mana yang dipakai
// repositori (validasi "tertutup" candle), klien REST (isClosed kline), dan scanner.
//
// Dua pipeline berjalan berdampingan atas candle tertutup yang sama (docs/19 §6):
// - pipeline analisis SA/PVA (LONG 1h) & SD/PVD (SHORT 15m, konteks HTF 1h) — DIRECTION_TIMEFRAMES;
// - pipeline Reversal Radar (LONG Scanner; hanya 1h — REVERSAL_ACTIVE_TIMEFRAMES) + evaluasi provisional candle berjalan.
// Keduanya dipanggil dari onClosedCandles scanner secara berurutan (SA/PVA dulu — jeda settle HTF-nya sekaligus memberi
// waktu candle HTF tersimpan sebelum reversal); gagal satu tidak membatalkan yang lain, error diteruskan ke scanner
// (tercatat sebagai error ingesti sumber 'analysis'). Timeframe ingesti = gabungan keduanya ∪ CHART_TIMEFRAMES (5m tetap
// diingesti HANYA untuk grafik Symbol Intelligence; kedua pipeline melewatinya).

import { createAnalysisPipeline } from '../backend/analysis/pipeline.js';
import { createRepositories } from '../backend/database/repositories/index.js';
import { createBinanceRestClient } from '../backend/ingestion/binance/restClient.js';
import { createKlineStream } from '../backend/ingestion/binance/wsClient.js';
import { CLOSE_MARGIN_MS } from '../backend/ingestion/backfill.js';
import { createServerClock } from '../backend/ingestion/serverClock.js';
import { discoverSymbols } from '../backend/ingestion/symbolDiscovery.js';
import { CHART_TIMEFRAMES, DIRECTIONS, DIRECTION_TIMEFRAMES, TIMEFRAMES, scannedTimeframes } from '../backend/market/contracts.js';
import { REVERSAL_ACTIVE_TIMEFRAMES } from '../backend/reversal/constants.js';
import { createReversalPipeline } from '../backend/reversal/pipeline.js';
import { DEFAULT_SCANNER_SETTINGS, SCANNER_SETTINGS_KEY } from '../backend/settings/scannerSettings.js';
import { createActivityFeed } from './activity.js';
import { createScanner } from './scanner.js';

/** Jeda tunggu candle HTF (1h) yang tutup bersamaan sebelum candle 15m dievaluasi (lihat createAnalysisPipeline). */
export const WORKER_SETTLE_MS = 3_000;
/** Scan berkala worker: semua seri diperiksa & ditambal tiap menit (keputusan pengguna 2026-11-15). */
export const SCAN_INTERVAL_MS = 60_000;

const NOOP_LOGGER = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });

/**
 * Timeframe yang diingesti worker: gabungan timeframe per arah (SA/PVA, SD/PVD) ∪ timeframe Reversal Radar aktif ∪
 * timeframe grafik (CHART_TIMEFRAMES). Analisis tetap hanya pada timeframe aktif tiap pipeline.
 */
export function workerTimeframes(directions = DIRECTIONS, reversalTimeframes = REVERSAL_ACTIVE_TIMEFRAMES, chartTimeframes = CHART_TIMEFRAMES) {
  const scanned = scannedTimeframes(directions);
  return TIMEFRAMES.filter((tf) => scanned.includes(tf) || reversalTimeframes.includes(tf) || chartTimeframes.includes(tf));
}

/** Gabungan dua daftar seri { symbol, timeframe } tanpa duplikat, urut simbol lalu timeframe. */
function mergeSeries(...lists) {
  const seen = new Map();
  for (const list of lists) for (const s of list) seen.set(`${s.symbol}:${s.timeframe}`, { symbol: s.symbol, timeframe: s.timeframe });
  return [...seen.values()].sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : TIMEFRAMES.indexOf(a.timeframe) - TIMEFRAMES.indexOf(b.timeframe)));
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
 *   onReversalAlert?: (alert: object) => void,
 *   directions?: Array<'LONG'|'SHORT'>,
 *   onAnalysed?: (e: { symbol: string, timeframe: string, candles: object[], reason: string, result: object, reversal: object|null }) => void,
 *   onMonitoringStopped?: (e: { symbol: string, timeframes: string[]|null, reason: string, at: number }) => void,
 *   heartbeatOwner?: { pid: number, host: string } | null,
 *   analysisParams?: object,
 *   directionTimeframes?: Record<string, string[]>|null,
 *   reversalParams?: object,
 *   reversalTimeframes?: string[],
 *   reversalEngine?: { evaluate?: Function, transition?: Function, resolveParams?: Function },
 *   reversalOptions?: object,
 * }} deps
 *   directionTimeframes: timeframe per arah (default DIRECTION_TIMEFRAMES: LONG 1h, SHORT 15m); null = semua (tes).
 *   clock: jam LOKAL host (default Date.now). Jam server (`serverClock.now` = jam lokal + offset terukur)
 *   dibuat di sini dan menjadi jam repositori, klien REST, dan scanner (`clock`); jam lokal menjadi
 *   `localClock` scanner untuk stempel operasional (heartbeat, run, error, lastIngestionAt) dan throttle provisional reversal.
 *   fetch/restSleep/restRandom/streamFactory/setTimer/clearTimer/pipelineSleep: injeksi I/O (default produksi).
 *   onAnalysed/onMonitoringStopped: pengamat (log/tes) — dipanggil SETELAH analisis / SEBELUM penutupan sinyal & kandidat.
 *   onAlert: menerima { symbol, timeframe, direction, state, event, view } (lihat createAnalysisPipeline).
 *   onReversalAlert: menerima { symbol, timeframe, candidateId, stage, status, events, snapshot, evaluation }
 *   (lihat createReversalPipeline) — kandidat dibuka / naik tahap / batal dari tahap ≥ DEVELOPING.
 *   directions: arah yang dipindai (default kedua arah: LONG = SA/PVA, SHORT = SD/PVD). Satu worker, satu
 *   pipeline; setiap candle tertutup dievaluasi untuk semua arah dengan candle & fitur bersama.
 *   heartbeatOwner: identitas proses untuk heartbeat (worker/index.js mengisi pid + hostname; default null).
 *   analysisParams: `params` pipeline analisis (override pola/sinyal/konfluensi + `calibration` hasil backtest;
 *   lihat analyzeDirectionsAt). Default {} = parameter bawaan v3 (gerbang tier EARLY minEarlyTier 'B').
 *   reversalParams: override parsial DEFAULT_REVERSAL_PARAMS pipeline reversal (default {} = bawaan).
 *   reversalTimeframes: timeframe Reversal Radar yang dievaluasi (default REVERSAL_ACTIVE_TIMEFRAMES = 1h; subset
 *   REVERSAL_TIMEFRAMES); ikut menentukan timeframe ingesti.
 *   reversalEngine: KHUSUS tes — evaluate/transition/resolveParams palsu untuk pipeline reversal (default mesin asli).
 *   reversalOptions: opsi lain createReversalPipeline (mis. provisionalMinIntervalMs, maxReplay) — KHUSUS tes.
 *   activity: log aktivitas (worker/activity.js); default feed baru berjam `clock`. Sinyal & kandidat reversal yang
 *   memicu alert ikut dicatat di sini, di samping aktivitas scanner. Scan berkala SCAN_INTERVAL_MS (opsi scanner
 *   `scanIntervalMs`, null = mati) melaporkan sinyal terbuka arah aktif (DIRECTION_TIMEFRAMES) & kandidat radar aktif.
 * @returns {{ serverClock: object, repos: object, rest: object, pipeline: object, reversal: object, scanner: object,
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
  onReversalAlert,
  onAnalysed,
  onMonitoringStopped,
  heartbeatOwner = null,
  directions = DIRECTIONS,
  directionTimeframes = DIRECTION_TIMEFRAMES,
  analysisParams = {},
  reversalParams = {},
  reversalTimeframes = REVERSAL_ACTIVE_TIMEFRAMES,
  reversalEngine,
  reversalOptions,
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

  // Pipeline Reversal Radar: candle tertutup 5m/15m/1h → evaluateReversal → transitionReversal → repos.reversal,
  // plus evaluasi provisional candle berjalan (onProvisionalCandle scanner). Dijalankan SETELAH pipeline SA/PVA
  // pada candle yang sama (lihat onClosedCandles di bawah). Likuiditas dari discovery yang sama.
  const reversal = createReversalPipeline({
    repos,
    reversal: repos.reversal,
    getLiquidity: (symbol) => scanner?.liquidityOf(symbol),
    logger,
    params: reversalParams,
    timeframes: reversalTimeframes,
    onAlert: (alert) => {
      activity.reversal(alert);
      onReversalAlert?.(alert);
    },
    clock,
    ...reversalOptions,
    ...reversalEngine,
  });

  // Timeframe yang benar-benar dianalisis salah satu pipeline (arah aktif × DIRECTION_TIMEFRAMES ∪ radar aktif); 5m grafik
  // tidak termasuk. Hanya candle timeframe ini yang dicatat di log aktivitas "Candle … tutup · n koin dianalisis".
  const analysedTimeframes = new Set([
    ...directions.flatMap((d) => (directionTimeframes === null ? TIMEFRAMES : (directionTimeframes[d] ?? []))),
    ...reversalTimeframes,
  ]);

  /** Menjalankan kedua pipeline berurutan; keduanya selalu dicoba, error pertama dilempar setelah keduanya selesai. */
  async function onClosedCandles({ symbol, timeframe, candles, reason }) {
    let result;
    let failure = null;
    try {
      result = await pipeline.onClosedCandles({ symbol, timeframe, candles, reason });
    } catch (err) {
      failure = err;
    }
    let reversalResult = null;
    try {
      reversalResult = await reversal.onClosedCandles({ symbol, timeframe, candles, reason });
      // Candle yang gagal di mesin reversal sudah dicatat & dilewati pipeline (seri tetap maju); tetap dilaporkan ke
      // scanner sebagai error ingesti 'analysis' agar terlihat di status sistem, bukan hanya di log.
      const failed = reversalResult?.errors ?? [];
      if (failed.length > 0 && !failure) {
        failure = new Error(`pipeline reversal: ${failed.length} candle gagal dievaluasi (${failed[0].message})`);
      }
    } catch (err) {
      // Error kedua tidak boleh hilang: dicatat di log, error pertama diteruskan ke scanner (error ingesti 'analysis').
      if (failure) logger.error({ symbol, timeframe, err: err?.message ?? String(err) }, 'pipeline reversal gagal (bersama pipeline analisis)');
      else failure = err;
    }
    if (result !== undefined) onAnalysed?.({ symbol, timeframe, candles, reason, result, reversal: reversalResult });
    // Satu entri per timeframe × waktu tutup (digabung activity.candles): "Candle 15m 19:15 tutup · 40 koin dianalisis".
    if (!failure && candles.length > 0 && analysedTimeframes.has(timeframe)) {
      activity.candles({ timeframe, closeTime: candles.at(-1).closeTime });
    }
    if (failure) throw failure;
  }

  /** Menutup sinyal SA/PVA & kandidat reversal seri yang berhenti dipantau; keduanya selalu dicoba. */
  async function closeSeries(e) {
    let failure = null;
    try {
      await pipeline.closeSymbol(e);
    } catch (err) {
      failure = err;
    }
    try {
      await reversal.closeSymbol(e);
    } catch (err) {
      if (failure) logger.error({ symbol: e.symbol, err: err?.message ?? String(err) }, 'penutupan kandidat reversal gagal (bersama penutupan sinyal)');
      else failure = err;
    }
    if (failure) throw failure;
  }

  scanner = createScanner({
    rest,
    streamFactory,
    repos,
    getSettings,
    discoverSymbols,
    onClosedCandles,
    // Simbol delisted / keluar dari set pantauan tidak menerima candle lagi → sinyal & kandidat terbukanya ditutup (EXPIRED).
    onMonitoringStopped: async (e) => {
      onMonitoringStopped?.(e);
      await closeSeries(e);
    },
    // Kline berjalan → evaluasi provisional Reversal Radar (tidak ditunggu scanner; error dicatat pipeline, tidak dilempar).
    onProvisionalCandle: (candle) => reversal.onProvisionalCandle(candle),
    // Rekonsiliasi level-triggered: sinyal/kandidat terbuka untuk seri yang tidak dipantau ditutup tiap discovery berhasil.
    listOpenSeries: async () => mergeSeries(await repos.signals.listOpenSeries(), await repos.reversal.listOpenSeries()),
    // Waktu pasar (closeTime, backfill, sweep) = jam server; stempel operasional yang dibandingkan
    // /api/system/status dengan Date.now proses API (heartbeat, run, error, lastIngestionAt) = jam lokal.
    clock: serverClock.now,
    localClock: clock,
    closureClock: serverClock.closureNow,
    serverClock,
    logger,
    setTimer,
    clearTimer,
    // Timeframe ingesti tetap = DIRECTION_TIMEFRAMES arah aktif ∪ radar aktif ∪ CHART_TIMEFRAMES (pengaturan `timeframes` lama diabaikan).
    // Scan berkala tiap SCAN_INTERVAL_MS kecuali tes menimpanya lewat scannerOptions.scanIntervalMs.
    options: { timeframes: workerTimeframes(directions, reversalTimeframes), scanIntervalMs: SCAN_INTERVAL_MS, ...scannerOptions, closeMarginMs },
    heartbeatOwner,
    activity,
    countOpen: () => countOpen({ repos, directions, directionTimeframes, reversalTimeframes }),
  });

  return { serverClock, repos, rest, pipeline, reversal, scanner, getSettings, activity };
}

/**
 * Sinyal terbuka yang TAMPIL di UI (arah aktif × timeframe arah itu) dan kandidat Reversal Radar terbuka di timeframe
 * aktif — untuk ringkasan scan berkala ("sinyal terbuka LONG 4 · SHORT 2 · radar 38").
 */
async function countOpen({ repos, directions, directionTimeframes, reversalTimeframes }) {
  const { signals, reversal } = await repos.overview.openCounts();
  const shown = (direction, timeframe) => directions.includes(direction)
    && (directionTimeframes === null || (directionTimeframes[direction] ?? []).includes(timeframe));
  const sum = (rows, keep) => rows.reduce((total, row) => total + (keep(row) ? row.n : 0), 0);
  return {
    long: sum(signals, (r) => r.direction === 'LONG' && shown('LONG', r.timeframe)),
    short: sum(signals, (r) => r.direction === 'SHORT' && shown('SHORT', r.timeframe)),
    radar: sum(reversal, (r) => reversalTimeframes.includes(r.timeframe)),
  };
}
