// Worker scanner: discovery simbol → bootstrap candle REST → stream WebSocket → penyimpanan
// → callback analisis. Dirancang untuk berjalan lama:
// - setiap pasangan simbol×timeframe punya antrean sendiri → urutan candle terjaga;
// - request REST dibatasi paralelismenya (default 3);
// - lompatan openTime (gap, mis. setelah reconnect) di-backfill via REST SEBELUM analisis;
// - timeframe yang dipilih di pengaturan dianalisis; HTF yang dibutuhkan konteksnya (HIGHER_TIMEFRAMES) selalu
//   ikut diingesti sebagai seri konteks saja (disimpan, tidak pernah memicu analisis) walau tidak dipilih;
// - duplikat/out-of-order tetap disimpan (idempoten) tetapi tidak memicu analisis ulang;
// - sweep berkala menambal stream yang tertinggal (fallback bila WS diam);
// - discovery yang memilih 0 simbol padahal set pantauan tidak kosong dianggap anomali (seperti discovery gagal)
//   KECUALI data discovery menjelaskannya (simbol lama delisted / ditolak filter pengaturan dengan alasan sah);
//   simbol lama yang delisted menurut exchangeInfo tidak kosong tetap dilepas walau discovery anomali;
// - rediscovery periodik menangani simbol baru & delisting; simbol/timeframe yang berhenti dipantau
//   dilaporkan lewat onMonitoringStopped (worker menutup sinyal terbukanya) SETELAH stream-nya dilepas;
//   dengan `listOpenSeries`, setiap discovery yang berhasil juga merekonsiliasi seri bersinyal terbuka yang
//   tidak lagi dipantau (level-triggered: callback gagal, stop() di tengah siklus, DB lama → dicoba lagi);
// - semua error dicatat (dengan throttle) dan tidak menghentikan proses;
// - bila `serverClock` diberikan, jam disinkronkan dengan waktu server Binance di awal setiap siklus
//   (start, rediscovery, dan percobaan ulang discovery); `clock` sebaiknya = serverClock.now.
// Dua jam injeksi: `clock` (waktu pasar/server Binance) untuk semua perbandingan dengan closeTime —
// rencana backfill/gap, sweep, staleStreams, candleLagMs — serta stempel simbol & penutupan sinyal;
// `localClock` (jam host, default = clock) untuk stempel operasional yang dibandingkan API/UI dengan
// jamnya sendiri — heartbeat `at`, recordRun, recordError, lastIngestionAt — dan throttle internal.
// `closureClock` (default = clock; worker: serverClock.closureNow) khusus untuk keputusan "sudah tertutup" di
// rencana REST (bootstrap, gap, repair, sweep): tidak pernah di depan waktu server saat jam host diketahui salah.
// Semua timer lewat setTimer/clearTimer injeksi.

import { HIGHER_TIMEFRAMES, TIMEFRAMES, TIMEFRAME_MS, expectedCloseTime } from '../backend/market/contracts.js';
import { CLOSE_MARGIN_MS, MAX_KLINES_PER_REQUEST, lastClosedOpenTime, planBackfill, planGapFill } from '../backend/ingestion/backfill.js';
import { REJECT_REASONS } from '../backend/ingestion/symbolDiscovery.js';

export const SCANNER_DEFAULTS = Object.freeze({
  heartbeatMs: 30_000,
  rediscoveryMs: 3_600_000,
  discoveryRetryMs: 60_000,
  restConcurrency: 3,
  provisionalThrottleMs: 1_000,
  // Margin keamanan penutupan (CLOSE_MARGIN_MS): rencana REST (backfill, gap, sweep) hanya mencakup candle yang
  // tertutup sebelum (clock() − margin), sama dengan margin isClosed klien REST — candle yang baru saja tutup
  // diserahkan ke kline final WS atau sweep berikutnya.
  closeMarginMs: CLOSE_MARGIN_MS,
  // Candle dianggap "terlewat" bila sudah tertutup lebih lama dari grace ini tanpa diterima.
  sweepGraceMs: 30_000,
  // Gap yang lebih panjang dipotong ke candle paling baru (sisanya ditutup repair findGaps).
  maxGapCandles: 10_000,
  gapMergeWithin: 50,
  errorThrottleMs: 60_000,
  // Bootstrap awal = histori murni; default tidak memicu analisis.
  emitBootstrap: false,
});

const MESSAGE_MAX = 500;
// Kontrak delivery Binance (mis. BTCUSDT_250627): ditolak pola simbol repositori, dan itu memang diharapkan.
const DELIVERY_SYMBOL = /^[A-Z0-9]+_\d{6}$/;
const SKIPPED_LOG_MAX = 20;
const noopLogger = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });

class ScannerStopped extends Error {
  constructor() {
    super('scanner dihentikan');
    this.name = 'ScannerStopped';
  }
}

/**
 * Discovery memilih 0 simbol padahal set pantauan sebelumnya tidak kosong dan data discovery tidak
 * menjelaskannya — diperlakukan sebagai discovery gagal. `kept` = simbol lama yang dipertahankan; `released`
 * = simbol lama yang delisted menurut exchangeInfo yang tidak kosong (tetap dilepas, SYMBOL_DELISTED).
 */
class AnomalousDiscovery extends Error {
  constructor(mode, previousCount, { exchange = [], kept = [], released = [] } = {}) {
    super(`discovery anomali: 0 simbol terpilih (mode ${mode}) padahal ${previousCount} simbol sedang dipantau; `
      + (released.length === 0
        ? 'set pantauan & stream dipertahankan, tidak ada sinyal yang ditutup'
        : `${kept.length} simbol dipertahankan, hanya ${released.length} simbol delisted yang dilepas`));
    this.name = 'AnomalousDiscovery';
    this.exchange = exchange;
    this.kept = kept;
    this.released = released;
  }
}

/**
 * Simbol lama yang 0-terpilihnya TIDAK dijelaskan data discovery, atau null bila input discovery sendiri rusak
 * (exchangeInfo tanpa simbol; mode auto dengan ticker 24 jam / book ticker kosong). Sebuah simbol lama dijelaskan
 * bila exchangeInfo (tidak kosong) tidak lagi mencantumkannya sebagai TRADING (delisted), atau discovery
 * menolaknya dengan alasan selain NO_TICKER (mis. NOT_IN_MANUAL_LIST, WIDE_SPREAD, LOW_VOLUME — pengaturan sah).
 * NO_TICKER / tanpa alasan pada simbol yang masih TRADING = data ticker/hasil discovery tidak lengkap.
 */
function unexplainedZero(previous, { exchange, tickers, bookTickers, result, auto }) {
  if (exchange.length === 0) return null;
  if (auto && (!Array.isArray(tickers) || tickers.length === 0 || !Array.isArray(bookTickers) || bookTickers.length === 0)) return null;
  const status = new Map(exchange.map((s) => [s?.symbol, s?.status]));
  const reasons = new Map((Array.isArray(result?.rejected) ? result.rejected : []).map((r) => [r?.symbol, r?.reason]));
  return previous.filter((s) => status.get(s) === 'TRADING'
    && (typeof reasons.get(s) !== 'string' || reasons.get(s) === REJECT_REASONS.NO_TICKER));
}

function errorMessage(err) {
  if (typeof err === 'string') return err;
  const base = String(err?.message ?? err);
  return err?.status && !base.includes(String(err.status)) ? `${base} (status ${err.status})` : base;
}

const streamKey = (symbol, timeframe) => `${symbol}:${timeframe}`;

function clampInt(value, min, max, fallback) {
  return Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** Pembatas jumlah tugas async yang berjalan bersamaan. */
function createLimiter(max) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= max || waiting.length === 0) return;
    active += 1;
    const { fn, resolve, reject } = waiting.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return {
    run(fn) {
      return new Promise((resolve, reject) => {
        waiting.push({ fn, resolve, reject });
        next();
      });
    },
  };
}

function assertDeps({ rest, streamFactory, repos, getSettings, discoverSymbols, onClosedCandles, onMonitoringStopped, serverClock }) {
  for (const m of ['getExchangeInfo', 'get24hTickers', 'getBookTickers', 'getKlines']) {
    if (typeof rest?.[m] !== 'function') throw new TypeError(`rest.${m} wajib ada`);
  }
  const need = {
    candles: ['upsertClosed', 'getLastOpenTime', 'findGaps', 'upsertProvisional'],
    symbols: ['upsertFromExchange', 'setMonitored', 'listMonitored', 'markDelisted'],
    ingestion: ['recordRun', 'recordError', 'heartbeat'],
  };
  for (const [repo, methods] of Object.entries(need)) {
    for (const m of methods) {
      if (typeof repos?.[repo]?.[m] !== 'function') throw new TypeError(`repos.${repo}.${m} wajib ada`);
    }
  }
  if (typeof streamFactory !== 'function') throw new TypeError('streamFactory wajib berupa fungsi');
  if (typeof getSettings !== 'function') throw new TypeError('getSettings wajib berupa fungsi');
  if (typeof discoverSymbols !== 'function') throw new TypeError('discoverSymbols wajib berupa fungsi');
  if (typeof onClosedCandles !== 'function') throw new TypeError('onClosedCandles wajib berupa fungsi');
  if (typeof onMonitoringStopped !== 'function') throw new TypeError('onMonitoringStopped wajib berupa fungsi');
  if (serverClock !== undefined && serverClock !== null
    && (typeof serverClock.sync !== 'function' || typeof serverClock.offsetMs !== 'function')) {
    throw new TypeError('serverClock harus { sync(), offsetMs() }');
  }
}

/** Normalisasi pengaturan scanner (lihat backend/settings/scannerSettings.js). */
function normalizeSettings(raw) {
  if (raw === null || typeof raw !== 'object') throw new TypeError('pengaturan scanner tidak valid');
  const timeframes = TIMEFRAMES.filter((tf) => Array.isArray(raw.timeframes) && raw.timeframes.includes(tf));
  if (timeframes.length === 0) throw new RangeError('pengaturan scanner tanpa timeframe valid');
  // Seri yang diingesti = timeframe terpilih ∪ HTF konteksnya; hanya `timeframes` yang dianalisis.
  const ingestTimeframes = TIMEFRAMES.filter((tf) => timeframes.includes(tf)
    || timeframes.some((base) => HIGHER_TIMEFRAMES[base].includes(tf)));
  return {
    raw,
    timeframes,
    ingestTimeframes,
    bootstrapCandles: clampInt(raw.refresh?.bootstrapCandles, 1, MAX_KLINES_PER_REQUEST, 500),
    backfillIntervalMs: clampInt(raw.refresh?.restBackfillIntervalSec, 30, 3600, 300) * 1000,
  };
}

const isLimit = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Ambang likuiditas dari pengaturan (settings.liquidity) atau null bila tidak lengkap/tidak valid. */
function liquidityThresholds(raw) {
  const { minQuoteVolume24h, maxSpreadBps } = raw?.liquidity ?? {};
  return isLimit(minQuoteVolume24h) && isLimit(maxSpreadBps) ? Object.freeze({ minQuoteVolume24h, maxSpreadBps }) : null;
}

/**
 * Membuat scanner ingesti.
 * @param {{
 *   rest: { getExchangeInfo: Function, get24hTickers: Function, getBookTickers: Function, getKlines: Function },
 *   streamFactory: (opts: { streams: Array<{ symbol: string, timeframe: string }>, onCandle: Function, onState: Function })
 *     => { start(): void, stop(): void, state(): { state: string, reconnects?: number } },
 *   repos: { candles: object, symbols: object, ingestion: object },
 *   getSettings: () => Promise<object>,
 *   onClosedCandles?: (e: { symbol: string, timeframe: string, candles: object[], reason: string }) => Promise<void>|void,
 *   onMonitoringStopped?: (e: { symbol: string, timeframes: string[]|null, reason: 'SYMBOL_DELISTED'|'MONITORING_STOPPED',
 *     at: number }) => Promise<void>|void,
 *   listOpenSeries?: () => Promise<Array<{ symbol: string, timeframe: string }>>,
 *   discoverSymbols: (args: { symbols: object[], tickers: object[], bookTickers: object[], settings: object })
 *     => { selected: Array<{ symbol: string }>, rejected: object[] } | Promise<object>,
 *   clock?: () => number, localClock?: () => number, closureClock?: () => number, logger?: object, setTimer?: Function,
 *   clearTimer?: Function, options?: object,
 *   serverClock?: { sync(): Promise<{ ok: boolean, message?: string }>, offsetMs(): number },
 * }} deps
 *   clock: waktu server (worker: serverClock.now); localClock: jam host (worker: Date.now; default = clock) untuk
 *   stempel yang dibandingkan /api/system/status dengan Date.now proses API (heartbeat, run, error, lastIngestionAt).
 *   closureClock: acuan rencana REST & staleness sweep (worker: serverClock.closureNow; default = clock) — saat jam
 *   host diketahui di depan server (OFFSET_OUT_OF_RANGE) candle yang masih berjalan tidak direncanakan sebagai tertutup.
 *   serverClock: jam tersinkron server (backend/ingestion/serverClock.js); sync() dipanggil tiap siklus,
 *   kegagalan dicatat sebagai error ingesti sumber 'clock' (offset terakhir tetap dipakai). Hasil
 *   reason OFFSET_OUT_OF_RANGE → state 'degraded' + status().clockFault sampai sync berikutnya berhasil.
 *   onMonitoringStopped: dipanggil setelah stream dilepas untuk (a) simbol yang sebelumnya dipantau (termasuk
 *   daftar di DB saat siklus pertama) dan tidak terpilih lagi — reason SYMBOL_DELISTED bila delisted, selain itu
 *   MONITORING_STOPPED, timeframes null (= semua); (b) simbol yang tetap dipantau tetapi timeframe-nya dilepas
 *   dari pengaturan — MONITORING_STOPPED dengan timeframes tersebut. Error dicatat (sumber 'monitoring').
 *   Hanya setelah discovery berhasil; fallback daftar DB tidak pernah melepas simbol.
 *   listOpenSeries: seri simbol×timeframe yang masih punya sinyal terbuka (worker: repos.signals.listOpenSeries).
 *   Setelah setiap discovery berhasil dan pelaporan di atas, seri terbuka yang tidak dipantau (simbol tidak
 *   terpilih → timeframes null, reason SYMBOL_DELISTED bila simbol tidak TRADING/hilang dari exchangeInfo, selain itu
 *   MONITORING_STOPPED; simbol terpilih dengan timeframe di luar pengaturan → MONITORING_STOPPED + timeframe itu)
 *   juga dilaporkan, kecuali yang sudah dilaporkan di siklus yang sama. Penutupan yang gagal atau terlewat
 *   (stop() di tengah siklus, timeframe dilepas saat worker mati, sinyal yatim dari DB lama) dicoba lagi tiap siklus.
 * @returns {{ start(): Promise<void>, stop(): Promise<void>, status(): object, liquidityOf(symbol: string): object|null }}
 */
export function createScanner({
  rest,
  streamFactory,
  repos,
  getSettings,
  onClosedCandles = async () => {},
  onMonitoringStopped = async () => {},
  listOpenSeries = null,
  discoverSymbols,
  clock = Date.now,
  localClock = clock,
  closureClock = clock,
  logger = noopLogger,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
  options = {},
  serverClock = null,
}) {
  assertDeps({ rest, streamFactory, repos, getSettings, discoverSymbols, onClosedCandles, onMonitoringStopped, serverClock });
  if (typeof clock !== 'function' || typeof localClock !== 'function' || typeof closureClock !== 'function') {
    throw new TypeError('clock, localClock, dan closureClock wajib berupa fungsi');
  }
  if (listOpenSeries !== null && typeof listOpenSeries !== 'function') throw new TypeError('listOpenSeries harus fungsi atau null');
  const cfg = { ...SCANNER_DEFAULTS, ...options };
  if (!Number.isInteger(cfg.closeMarginMs) || cfg.closeMarginMs < 0 || cfg.closeMarginMs > 60_000) {
    throw new RangeError('options.closeMarginMs harus bilangan bulat 0..60000');
  }
  /** Acuan rencana REST: waktu server (jam acuan penutupan) dikurangi margin penutupan. */
  const settledNow = () => closureClock() - cfg.closeMarginMs;
  const limiter = createLimiter(cfg.restConcurrency);

  let phase = 'idle';
  let settings = null;
  let startPromise = null;
  let stopPromise = null;
  /** @type {Map<string, object>} state per simbol×timeframe */
  const streams = new Map();
  const symbolInfo = new Map();
  let monitored = [];
  /** @type {Map<string, { quoteVolume24h: number|null, spreadBps: number|null, thresholds: { minQuoteVolume24h: number, maxSpreadBps: number } | null }>} */
  let liquidity = new Map();
  let dbMonitoredChecked = false;
  let stream = null;
  let reconnectsBase = 0;
  const timers = new Map();
  const inflight = new Set();
  const errorSeen = new Map();
  let errors = 0;
  let pending = 0;
  let scanDurationMs = null;
  let lastIngestionAt = null;
  let latestCloseTime = null;
  let discoveryFailures = 0;
  /** Alasan jam server diketahui rusak (OFFSET_OUT_OF_RANGE) dari sync terakhir, null bila sehat/tidak diketahui. */
  let clockFault = null;
  let cycleStats = null;
  const counters = { gaps: 0, duplicates: 0 };

  const isStopping = () => phase === 'stopping' || phase === 'stopped';
  const checkStopping = () => {
    if (isStopping()) throw new ScannerStopped();
  };
  const isActive = (st) => streams.get(st.key) === st;

  // ---------- utilitas proses ----------

  function track(promise) {
    inflight.add(promise);
    promise.then(() => inflight.delete(promise), () => inflight.delete(promise));
    return promise;
  }

  function cancel(name) {
    const handle = timers.get(name);
    if (handle !== undefined) {
      clearTimer(handle);
      timers.delete(name);
    }
  }

  /** Menjadwalkan tugas bernama (menggantikan jadwal sebelumnya). Tidak ada jadwal baru saat berhenti. */
  function schedule(name, ms, fn) {
    cancel(name);
    if (isStopping()) return;
    const handle = setTimer(() => {
      timers.delete(name);
      track(Promise.resolve().then(fn).catch((err) => report('scanner', err)));
    }, ms);
    timers.set(name, handle);
  }

  /**
   * Mencatat error: dihitung selalu, ditulis ke repositori dengan throttle per sumber + pesan tersimpan (pesan
   * memuat simbol & timeframe), sehingga error yang sama di simbol lain tetap tercatat.
   */
  async function report(source, err, st) {
    if (err instanceof ScannerStopped) return;
    errors += 1;
    if (cycleStats) cycleStats.errors += 1;
    const detail = errorMessage(err);
    const message = `${st ? `${st.symbol} ${st.timeframe}: ` : ''}${detail}`.slice(0, MESSAGE_MAX);
    logger.warn({ source, symbol: st?.symbol, timeframe: st?.timeframe, err: detail }, 'galat scanner');
    const now = localClock();
    const key = `${source}|${message}`;
    const last = errorSeen.get(key);
    if (last !== undefined && now - last < cfg.errorThrottleMs) return;
    if (errorSeen.size >= 1000) errorSeen.clear();
    errorSeen.set(key, now);
    try {
      await repos.ingestion.recordError({ at: now, source, message });
    } catch (e) {
      logger.error({ err: errorMessage(e) }, 'gagal mencatat error ingesti');
    }
  }

  /** Antrean serial per stream; tidak pernah reject. */
  function enqueue(st, task) {
    pending += 1;
    const run = st.chain
      .then(task)
      .catch((err) => report('scanner', err, st))
      .finally(() => {
        pending -= 1;
      });
    st.chain = run;
    return track(run);
  }

  function newStreamState(symbol, timeframe, analyze) {
    return {
      key: streamKey(symbol, timeframe),
      symbol,
      timeframe,
      // false = seri konteks HTF saja (timeframe tidak dipilih): disimpan, tidak pernah memicu analisis.
      analyze,
      lastOpenTime: null,
      lastCloseTime: null,
      // Waktu server saat bootstrap stream dimulai: candle yang tutup sebelumnya = histori (lihat firstOpenSweep).
      liveFrom: null,
      chain: Promise.resolve(),
      // Jumlah sinkronisasi sweep yang antre/berjalan untuk stream ini (lihat sweep()).
      syncing: 0,
      provisionalAt: null,
      provisionalOpenTime: null,
    };
  }

  // ---------- penyimpanan & emisi ----------

  function mergeClosed(st, list) {
    const byOpen = new Map();
    for (const c of list) {
      if (c && c.isClosed === true && c.symbol === st.symbol && c.timeframe === st.timeframe && Number.isSafeInteger(c.openTime)) {
        byOpen.set(c.openTime, c);
      }
    }
    return [...byOpen.values()].sort((a, b) => a.openTime - b.openTime);
  }

  /** upsertClosed lalu kembalikan candle yang diterima (tanpa yang ditolak validasi). */
  async function upsertClosed(st, candles) {
    if (candles.length === 0) return [];
    const result = await repos.candles.upsertClosed(candles);
    lastIngestionAt = localClock();
    const rejected = Array.isArray(result?.rejected) ? result.rejected : [];
    if (rejected.length === 0) return candles;
    const bad = new Set(rejected.map((r) => r?.candle?.openTime));
    const reasons = Array.isArray(rejected[0]?.errors) ? rejected[0].errors.join(', ') : 'tidak valid';
    await report('validation', `${rejected.length} candle ditolak: ${reasons}`, st);
    return candles.filter((c) => !bad.has(c.openTime));
  }

  /**
   * Memajukan high-water mark stream; memanggil analisis untuk candle yang lebih baru (`emitFrom`: hanya candle
   * dengan closeTime ≥ nilai itu yang dianalisis; yang lebih awal disimpan sebagai histori).
   */
  async function commit(st, accepted, reason, emit, emitFrom = null) {
    const fresh = accepted.filter((c) => st.lastOpenTime === null || c.openTime > st.lastOpenTime);
    if (fresh.length === 0) return;
    const last = fresh.at(-1);
    st.lastOpenTime = last.openTime;
    st.lastCloseTime = last.closeTime;
    if (latestCloseTime === null || last.closeTime > latestCloseTime) latestCloseTime = last.closeTime;
    const emitted = emitFrom === null ? fresh : fresh.filter((c) => c.closeTime >= emitFrom);
    if (!emit || emitted.length === 0 || !isActive(st) || !st.analyze) return;
    try {
      await onClosedCandles({ symbol: st.symbol, timeframe: st.timeframe, candles: emitted, reason });
    } catch (err) {
      await report('analysis', err, st);
    }
  }

  async function fetchKlines(st, req) {
    const candles = await limiter.run(() => {
      checkStopping();
      return rest.getKlines({ symbol: st.symbol, timeframe: st.timeframe, startTime: req.startTime, endTime: req.endTime, limit: req.limit });
    });
    if (!Array.isArray(candles)) throw new TypeError('respons klines bukan array');
    return candles;
  }

  /**
   * Mengambil semua candle tertutup setelah high-water mark sampai sekarang (REST), digabung dengan
   * `extra` (mis. candle WS pemicu), disimpan, lalu dianalisis berurutan.
   * Seri yang belum punya data (bootstrap murni) tidak dianalisis kecuali emitBootstrap. `emitFrom`: lihat commit.
   */
  async function syncStream(st, reason, extra = [], emitFrom = null) {
    if (!isActive(st)) return 0;
    const fresh = st.lastOpenTime === null;
    const plan = planBackfill({
      lastOpenTime: st.lastOpenTime,
      now: settledNow(),
      timeframe: st.timeframe,
      maxCandles: fresh ? settings.bootstrapCandles : cfg.maxGapCandles,
    });
    const fetched = [];
    for (const req of plan) fetched.push(...await fetchKlines(st, req));
    const accepted = await upsertClosed(st, mergeClosed(st, [...extra, ...fetched]));
    const emit = reason === 'bootstrap' || fresh ? cfg.emitBootstrap : true;
    await commit(st, accepted, reason, emit, emitFrom);
    return accepted.length;
  }

  /** Menutup lubang historis di jendela bootstrap (hasil findGaps). Tidak memicu analisis. */
  async function repairGaps(st) {
    if (st.lastOpenTime === null || !isActive(st)) return 0;
    const ms = TIMEFRAME_MS[st.timeframe];
    let from = st.lastOpenTime - (settings.bootstrapCandles - 1) * ms;
    const onboard = symbolInfo.get(st.symbol)?.onboardDate;
    if (Number.isSafeInteger(onboard)) from = Math.max(from, Math.ceil(onboard / ms) * ms);
    if (from > st.lastOpenTime) return 0;
    const gaps = await repos.candles.findGaps({ symbol: st.symbol, timeframe: st.timeframe, from, to: st.lastOpenTime });
    if (!Array.isArray(gaps) || gaps.length === 0) return 0;
    const plan = planGapFill({ gaps, timeframe: st.timeframe, now: settledNow(), mergeWithin: cfg.gapMergeWithin });
    let n = 0;
    for (const req of plan) {
      const candles = mergeClosed(st, await fetchKlines(st, req)).filter((c) => c.openTime <= st.lastOpenTime);
      n += (await upsertClosed(st, candles)).length;
    }
    if (n > 0) logger.info({ symbol: st.symbol, timeframe: st.timeframe, candles: n }, 'gap historis ditutup');
    return n;
  }

  async function bootstrapStream(st) {
    if (!isActive(st)) return 0;
    let n = 0;
    st.liveFrom ??= clock();
    try {
      const last = await repos.candles.getLastOpenTime({ symbol: st.symbol, timeframe: st.timeframe });
      if (Number.isSafeInteger(last) && st.lastOpenTime === null) {
        st.lastOpenTime = last;
        st.lastCloseTime = expectedCloseTime(last, st.timeframe);
        if (latestCloseTime === null || st.lastCloseTime > latestCloseTime) latestCloseTime = st.lastCloseTime;
      }
      n += await syncStream(st, 'bootstrap');
    } catch (err) {
      await report('bootstrap', err, st);
      return n;
    }
    try {
      n += await repairGaps(st);
    } catch (err) {
      await report('gap-repair', err, st);
    }
    return n;
  }

  // ---------- event WebSocket ----------

  async function handleClosed(st, candle) {
    if (!isActive(st)) return;
    const ms = TIMEFRAME_MS[st.timeframe];
    if (st.lastOpenTime !== null && candle.openTime <= st.lastOpenTime) {
      // Duplikat atau out-of-order: tetap disimpan (idempoten), tanpa analisis ulang.
      counters.duplicates += 1;
      await upsertClosed(st, [candle]);
      return;
    }
    if (st.lastOpenTime !== null && candle.openTime === st.lastOpenTime + ms) {
      await commit(st, await upsertClosed(st, [candle]), 'live', true);
      return;
    }
    // Lompatan openTime → backfill REST dulu agar analisis menerima candle berurutan.
    counters.gaps += 1;
    logger.info({ symbol: st.symbol, timeframe: st.timeframe, from: st.lastOpenTime, to: candle.openTime }, 'gap terdeteksi, backfill REST');
    try {
      await syncStream(st, 'gap', [candle]);
    } catch (err) {
      await report('backfill', err, st);
      // Simpan candle WS agar tidak hilang; high-water mark tidak maju sehingga gap dicoba ulang.
      await upsertClosed(st, [candle]);
    }
  }

  function handleProvisional(st, candle) {
    if (st.lastOpenTime !== null && candle.openTime <= st.lastOpenTime) return; // sudah tertutup
    if (st.provisionalOpenTime !== null && candle.openTime < st.provisionalOpenTime) return;
    const now = localClock();
    if (candle.openTime === st.provisionalOpenTime && now - st.provisionalAt < cfg.provisionalThrottleMs) return;
    st.provisionalAt = now;
    st.provisionalOpenTime = candle.openTime;
    track(Promise.resolve()
      .then(() => repos.candles.upsertProvisional(candle))
      .then(() => { lastIngestionAt = localClock(); }, (err) => report('provisional', err, st)));
  }

  function handleWsCandle(handle, candle) {
    if (handle !== stream || isStopping()) return;
    const st = streams.get(streamKey(candle?.symbol, candle?.timeframe));
    if (!st) return; // simbol tidak lagi dipantau (mis. delisted)
    if (candle.isClosed) enqueue(st, () => handleClosed(st, candle));
    else handleProvisional(st, candle);
  }

  function handleWsState(handle, meta, s) {
    if (handle !== stream || isStopping() || s === null || typeof s !== 'object') return;
    if (s.event === 'error') {
      track(report('ws', `${s.error?.kind ?? 'error'}: ${s.error?.message ?? ''}`));
    } else if (s.event === 'disconnect') {
      logger.warn({ connection: s.connection, code: s.code }, 'koneksi WebSocket terputus');
    } else if (s.event === 'state') {
      logger.info({ state: s.state, reconnects: s.reconnects }, 'state WebSocket');
      if (s.state === 'open') {
        if (meta.down) reconnectSweep();
        else if (!meta.opened) firstOpenSweep();
        meta.opened = true;
        meta.down = false;
      } else if (meta.opened) {
        meta.down = true;
      }
    }
  }

  /**
   * Mengganti stream WS dengan set stream terbaru (buat yang baru dulu, baru hentikan yang lama).
   * Pada penggantian, open pertama stream baru diperlakukan seperti reconnect → sweep catch-up.
   */
  function replaceStream() {
    const old = stream;
    stream = null;
    const list = [...streams.values()].map(({ symbol, timeframe }) => ({ symbol, timeframe }));
    if (list.length > 0) {
      const meta = { opened: false, down: old !== null };
      let handle = null;
      handle = streamFactory({
        streams: list,
        onCandle: (c) => handleWsCandle(handle, c),
        onState: (s) => handleWsState(handle, meta, s),
      });
      stream = handle;
      handle.start();
    }
    if (old) {
      reconnectsBase += old.state()?.reconnects ?? 0;
      old.stop();
    }
  }

  // ---------- sweep kesegaran data ----------

  /**
   * Menjadwalkan sinkronisasi REST untuk stream yang tertinggal dari candle tertutup terakhir.
   * Grace minimal = margin penutupan, agar stream tidak disinkronkan untuk candle yang belum boleh diambil REST.
   * Stream yang sinkronisasi sweep-nya masih antre/berjalan dilewati, KECUALI `includeSyncing`: rencana
   * sinkronisasi yang berjalan dibuat saat ia mulai (bisa sebelum candle terbaru boleh diambil), jadi satu
   * sinkronisasi lagi diantrekan; antrean per stream menyerialkannya dan rencananya dihitung ulang dari
   * high-water mark saat ia berjalan (kosong bila candle itu sudah diterima). `catchup`: saat tugas berjalan,
   * stream yang belum punya data (bootstrap gagal) dilewati — dicoba ulang oleh sweep berkala — dan candle yang
   * tutup sebelum bootstrap stream dimulai (`liveFrom`) disimpan sebagai histori tanpa analisis, seperti bootstrap.
   */
  function sweep(reason, graceMs, { includeSyncing = false, catchup = false } = {}) {
    const now = closureClock() - Math.max(graceMs, cfg.closeMarginMs);
    const tasks = [];
    for (const st of streams.values()) {
      if (st.syncing > 0 && !includeSyncing) continue;
      const expected = lastClosedOpenTime(now, st.timeframe);
      if (st.lastOpenTime !== null && st.lastOpenTime >= expected) continue;
      st.syncing += 1;
      tasks.push(enqueue(st, async () => {
        try {
          if (!catchup) await syncStream(st, reason);
          else if (st.lastOpenTime !== null) await syncStream(st, reason, [], st.liveFrom ?? clock());
        } catch (err) {
          await report('backfill', err, st);
        } finally {
          st.syncing -= 1;
        }
      }));
    }
    return Promise.all(tasks);
  }

  /**
   * Catch-up setelah (re)connect: Binance tidak mengulang kline final yang terkirim saat socket putus. Semua
   * candle yang tutup sebelum socket dibuka harus diambil REST — tanpa grace selain margin penutupan. Yang tutup
   * kurang dari margin sebelum open belum boleh diambil REST, jadi sweep diulang sekali setelah margin berlalu —
   * juga untuk stream yang sinkronisasi pertamanya masih berjalan (rencananya mungkin tanpa candle tersebut).
   */
  function reconnectSweep() {
    track(sweep('reconnect', cfg.closeMarginMs));
    schedule('reconnect-sweep', cfg.closeMarginMs, () => sweep('reconnect', cfg.closeMarginMs, { includeSyncing: true }));
  }

  /**
   * Open pertama stream awal (bukan reconnect/penggantian): bootstrap bisa saja merencanakan REST kurang dari
   * margin setelah candle terbaru tutup (candle itu dikecualikan), sementara kline final-nya terkirim sebelum
   * socket terbuka. Satu sweep setelah margin berlalu mengambilnya (antre di belakang bootstrap; stream yang
   * sudah mutakhir tidak menyentuh REST; stream yang bootstrap-nya gagal tidak dicoba ulang secepat ini).
   * Candle yang tutup sebelum bootstrap dimulai tetap histori (tanpa analisis); yang tutup sesudahnya
   * dianalisis dengan reason 'catchup'.
   */
  function firstOpenSweep() {
    schedule('open-sweep', cfg.closeMarginMs, () => sweep('catchup', cfg.closeMarginMs, { catchup: true }));
  }

  function scheduleSweep() {
    schedule('sweep', settings.backfillIntervalMs, async () => {
      await sweep('sweep', cfg.sweepGraceMs);
      scheduleSweep();
    });
  }

  /**
   * Memastikan sweep berkala terjadwal begitu scanner berjalan DAN pengaturan sudah pernah termuat. Dipanggil
   * dari start() dan setiap siklus yang berhasil memuat pengaturan: bila pemuatan pertama gagal, sweep
   * dijadwalkan pada siklus berikutnya yang berhasil (bukan crash di start lalu tidak pernah terjadwal).
   */
  function ensureSweep() {
    if (phase === 'running' && settings !== null && !timers.has('sweep')) scheduleSweep();
  }

  // ---------- discovery ----------

  async function loadSettings() {
    try {
      settings = normalizeSettings(await getSettings());
    } catch (err) {
      // Tanpa pengaturan valid terakhir, siklus tidak bisa jalan (dicatat oleh runCycle).
      if (!settings) throw err;
      await report('settings', err);
    }
  }

  async function discover() {
    const [symbols, tickers, bookTickers] = await Promise.all([
      limiter.run(() => rest.getExchangeInfo()),
      limiter.run(() => rest.get24hTickers()),
      limiter.run(() => rest.getBookTickers()),
    ]);
    const result = await discoverSymbols({ symbols, tickers, bookTickers, settings: settings.raw });
    const chosen = (result?.selected ?? []).filter((s) => typeof s?.symbol === 'string');
    const exchange = Array.isArray(symbols) ? symbols : [];
    // Penjaga anomali: 0 simbol terpilih (mode auto atau manual) padahal set pantauan sebelumnya (memori, atau
    // daftar DB di siklus pertama) tidak kosong, DAN data discovery tidak menjelaskannya (unexplainedZero) →
    // hampir pasti data discovery rusak/kosong sementara. Ditolak SEBELUM likuiditas/simbol/stream disentuh;
    // runCycle menanganinya seperti discovery gagal (error 'discovery', coba ulang dengan jeda, fallback daftar
    // DB, tanpa rekonsiliasi). Simbol lama yang delisted menurut exchangeInfo tidak kosong tetap dilepas.
    // 0 simbol yang dijelaskan (simbol lama delisted, atau ditolak filter pengaturan yang sah — mis. mode manual
    // dengan simbol tak terdaftar, filter likuiditas yang menolak semua) diterapkan seperti discovery biasa.
    if (chosen.length === 0) {
      const previous = monitored.length > 0 ? monitored : (dbMonitoredChecked ? [] : await repos.symbols.listMonitored());
      const auto = settings.raw?.symbols?.mode === 'auto';
      const unexplained = previous.length > 0 ? unexplainedZero(previous, { exchange, tickers, bookTickers, result, auto }) : [];
      if (unexplained === null || unexplained.length > 0) {
        const mode = settings.raw?.symbols?.mode ?? 'tidak diketahui';
        const status = new Map(exchange.map((s) => [s?.symbol, s?.status]));
        const released = exchange.length === 0 ? [] : previous.filter((s) => status.get(s) !== 'TRADING');
        const kept = previous.filter((s) => !released.includes(s));
        logger.warn({ mode, previous: previous.length, released: released.length },
          'discovery memilih 0 simbol padahal set pantauan tidak kosong; set pantauan dipertahankan');
        throw new AnomalousDiscovery(mode, previous.length, { exchange, kept, released });
      }
    }
    // Likuiditas terakhir per simbol (quote volume 24 jam, spread) untuk risk flag di pipeline analisis,
    // beserta ambang pengaturan yang dipakai discovery ini — sehingga risk flag dinilai dengan batas
    // pengguna, termasuk mode manual yang tidak memfilter likuiditas. Ambang tidak valid → null
    // (pipeline memakai default DEFAULT_VIEW_PARAMS).
    const thresholds = liquidityThresholds(settings.raw);
    liquidity = new Map(chosen.map((s) => [s.symbol, {
      quoteVolume24h: s.quoteVolume24h ?? null, spreadBps: s.spreadBps ?? null, thresholds,
    }]));
    return { symbols: exchange, selected: chosen.map((s) => s.symbol) };
  }

  /**
   * Simbol exchangeInfo yang tidak disimpan repositori (format simbol tidak didukung) dicatat sekali per
   * discovery — BUKAN error ingesti. Kontrak delivery (`XXXUSDT_YYMMDD`) memang diharapkan → debug;
   * selain itu (bentuk tidak terduga) → info.
   */
  function logSkippedSymbols(result) {
    const list = Array.isArray(result?.rejected) ? result.rejected : [];
    const count = Number.isInteger(result?.rejectedCount) ? result.rejectedCount : list.length;
    if (count === 0) return;
    const symbols = list.map((r) => (typeof r?.symbol === 'string' ? r.symbol : null));
    const expected = symbols.length === count && symbols.every((s) => s !== null && DELIVERY_SYMBOL.test(s));
    const reasons = [...new Set(list.flatMap((r) => (Array.isArray(r?.errors) ? r.errors : [])))].slice(0, 5);
    logger[expected ? 'debug' : 'info']({ count, symbols: symbols.slice(0, SKIPPED_LOG_MAX), reasons },
      'simbol exchangeInfo tidak disimpan (format simbol tidak didukung)');
  }

  async function syncSymbols(exchange, selected, now) {
    logSkippedSymbols(await repos.symbols.upsertFromExchange(exchange, now));
    for (const s of exchange) symbolInfo.set(s.symbol, s);
    const previously = new Set(monitored);
    if (!dbMonitoredChecked) {
      for (const s of await repos.symbols.listMonitored()) previously.add(s);
      dbMonitoredChecked = true;
    }
    // Delisted = sebelumnya dipantau, kini hilang dari exchangeInfo atau tidak lagi TRADING.
    const bySymbol = new Map(exchange.map((s) => [s.symbol, s]));
    const delisted = [...previously].filter((s) => bySymbol.get(s)?.status !== 'TRADING');
    if (delisted.length > 0) {
      await repos.symbols.markDelisted(delisted, now);
      logger.warn({ symbols: delisted }, 'simbol delisted, stream dihentikan');
    }
    await repos.symbols.setMonitored(selected, now);
    // Simbol yang berhenti dipantau → reason untuk penutupan sinyal terbukanya (setelah stream dilepas).
    const chosen = new Set(selected);
    const gone = new Set(delisted);
    return new Map([...previously].filter((s) => !chosen.has(s))
      .map((s) => [s, gone.has(s) ? 'SYMBOL_DELISTED' : 'MONITORING_STOPPED']));
  }

  /** Melaporkan simbol/timeframe yang berhenti dipantau; error dicatat, tidak menghentikan siklus. */
  async function notifyStopped(stoppedSymbols, removedKeys, target, at) {
    const events = [...stoppedSymbols].map(([symbol, reason]) => ({ symbol, timeframes: null, reason }));
    const kept = new Set(target);
    const byTimeframe = new Map();
    for (const { symbol, timeframe } of removedKeys) {
      if (!kept.has(symbol) || stoppedSymbols.has(symbol)) continue;
      if (!byTimeframe.has(symbol)) byTimeframe.set(symbol, []);
      byTimeframe.get(symbol).push(timeframe);
    }
    for (const [symbol, timeframes] of byTimeframe) events.push({ symbol, timeframes, reason: 'MONITORING_STOPPED' });
    await emitStopped(events, at);
    // Seri yang sudah dilaporkan siklus ini (berhasil atau tidak): simbol (semua timeframe) atau simbol:timeframe.
    return new Set(events.flatMap((e) => (e.timeframes === null ? [e.symbol] : e.timeframes.map((tf) => streamKey(e.symbol, tf)))));
  }

  async function emitStopped(events, at) {
    for (const e of events) {
      try {
        await onMonitoringStopped({ ...e, at });
      } catch (err) {
        await report('monitoring', err);
      }
    }
  }

  /**
   * Rekonsiliasi level-triggered setelah discovery berhasil: seri yang masih punya sinyal terbuka tetapi tidak
   * dipantau lagi dilaporkan (kecuali `covered` — sudah dilaporkan siklus ini; kegagalannya dicoba siklus berikut).
   */
  async function reconcileOpenSignals(target, statusBySymbol, covered, at) {
    if (!listOpenSeries || isStopping()) return;
    let open;
    try {
      open = await listOpenSeries();
      if (!Array.isArray(open)) throw new TypeError('listOpenSeries harus mengembalikan array');
    } catch (err) {
      await report('monitoring', err);
      return;
    }
    const kept = new Set(target);
    const wanted = new Set(settings.timeframes);
    const bySymbol = new Map();
    for (const s of open) {
      if (typeof s?.symbol !== 'string' || !TIMEFRAMES.includes(s?.timeframe)) continue;
      if (kept.has(s.symbol) && wanted.has(s.timeframe)) continue;
      if (covered.has(s.symbol) || covered.has(streamKey(s.symbol, s.timeframe))) continue;
      if (!bySymbol.has(s.symbol)) bySymbol.set(s.symbol, new Set());
      bySymbol.get(s.symbol).add(s.timeframe);
    }
    const events = [...bySymbol].map(([symbol, timeframes]) => (kept.has(symbol)
      ? { symbol, timeframes: TIMEFRAMES.filter((tf) => timeframes.has(tf)), reason: 'MONITORING_STOPPED' }
      : { symbol, timeframes: null, reason: statusBySymbol.get(symbol) === 'TRADING' ? 'MONITORING_STOPPED' : 'SYMBOL_DELISTED' }));
    if (events.length > 0) logger.info({ series: events.map((e) => e.symbol) }, 'sinyal terbuka pada seri yang tidak dipantau, dilaporkan untuk ditutup');
    await emitStopped(events, at);
  }

  /**
   * Menyesuaikan set stream dengan target; stream baru di-bootstrap. Mengembalikan jumlah candle.
   * Per simbol diingesti `settings.ingestTimeframes` (terpilih ∪ HTF konteksnya); hanya timeframe terpilih
   * yang dianalisis (`st.analyze`). Timeframe yang tidak lagi dianalisis — streamnya dilepas ATAU tetap berjalan
   * sebagai konteks HTF — dilaporkan bersama `stopped` (dari syncSymbols) → onMonitoringStopped setelah stream
   * lama berhenti. `statusBySymbol` (status exchangeInfo discovery ini; null pada fallback DB) → rekonsiliasi
   * sinyal terbuka.
   */
  async function applyTarget(target, stopped = new Map(), at = clock(), statusBySymbol = null) {
    const analyzed = new Set(settings.timeframes);
    const desired = new Map();
    for (const symbol of target) {
      for (const timeframe of settings.ingestTimeframes) {
        desired.set(streamKey(symbol, timeframe), { symbol, timeframe, analyze: analyzed.has(timeframe) });
      }
    }
    const removed = [...streams.keys()].filter((k) => !desired.has(k));
    // Seri yang berhenti dianalisis: stream analisis yang dilepas + stream yang turun menjadi konteks saja.
    const unanalyzed = removed.map((k) => streams.get(k)).filter((st) => st.analyze);
    for (const k of removed) streams.delete(k);
    const added = [];
    for (const [k, d] of desired) {
      const existing = streams.get(k);
      if (existing) {
        if (existing.analyze && !d.analyze) unanalyzed.push(existing);
        existing.analyze = d.analyze;
        continue;
      }
      const st = newStreamState(d.symbol, d.timeframe, d.analyze);
      streams.set(k, st);
      added.push(st);
    }
    monitored = [...target];
    if (added.length > 0 || removed.length > 0 || (stream === null && streams.size > 0)) replaceStream();
    // Stream lama sudah dilepas (candle baru untuknya diabaikan) → aman menutup sinyal terbukanya.
    const notified = notifyStopped(stopped, unanalyzed, target, at);
    const counts = await Promise.all(added.map((st) => {
      let n = 0;
      return enqueue(st, async () => { n = await bootstrapStream(st); }).then(() => n);
    }));
    const covered = await notified;
    // Hanya setelah discovery berhasil (statusBySymbol ada); fallback daftar DB tidak pernah melepas apa pun.
    if (statusBySymbol) await reconcileOpenSignals(target, statusBySymbol, covered, at);
    return counts.reduce((a, b) => a + b, 0);
  }

  /**
   * Sinkronisasi jam server; tidak pernah melempar — kegagalan dicatat, offset terakhir tetap dipakai.
   * OFFSET_OUT_OF_RANGE (selisih jam host vs server melebihi batas serverClock) berarti jam yang dipakai
   * diketahui salah: worker tetap berjalan tetapi berstatus 'degraded' (status().clockFault) sampai sync
   * berikutnya berhasil. Kegagalan lain (jaringan/HTTP/RTT) tidak mengubah state: offset terakhir masih sah.
   */
  async function syncClock() {
    if (!serverClock) return;
    try {
      const result = await limiter.run(() => serverClock.sync());
      if (result?.ok === true) {
        if (clockFault !== null) logger.info({ offsetMs: result.offsetMs }, 'jam server kembali tersinkron');
        clockFault = null;
      } else if (result?.ok === false) {
        if (result.reason === 'OFFSET_OUT_OF_RANGE') {
          clockFault = result.reason;
          logger.warn({ reason: result.reason, measuredOffsetMs: result.measuredOffsetMs, offsetMs: result.offsetMs },
            'jam host menyimpang dari waktu server Binance melebihi batas; worker degraded (periksa NTP host)');
        }
        await report('clock', result.message ?? 'sinkronisasi jam server gagal');
      }
    } catch (err) {
      await report('clock', err);
    }
  }

  async function runCycle(kind) {
    const stats = { candles: 0, errors: 0 };
    cycleStats = stats;
    // Jam disinkronkan dulu agar waktu siklus, validasi "tertutup", dan rencana backfill memakai waktu server.
    await syncClock();
    // startedAt/finishedAt (recordRun, scanDurationMs) = jam host; `at` = waktu server untuk stempel simbol & sinyal.
    const startedAt = localClock();
    const at = clock();
    let nextDelay = cfg.rediscoveryMs;
    try {
      await loadSettings();
      ensureSweep();
      let target = null;
      let stopped = new Map();
      let statusBySymbol = null;
      try {
        const found = await discover();
        checkStopping();
        stopped = await syncSymbols(found.symbols, found.selected, at);
        target = found.selected;
        statusBySymbol = new Map(found.symbols.map((s) => [s?.symbol, s?.status]));
        discoveryFailures = 0;
      } catch (err) {
        if (err instanceof ScannerStopped) throw err;
        discoveryFailures += 1;
        await report('discovery', err);
        nextDelay = Math.min(cfg.rediscoveryMs, cfg.discoveryRetryMs * 2 ** (discoveryFailures - 1));
        if (err instanceof AnomalousDiscovery && err.released.length > 0) {
          // Discovery anomali, tetapi exchangeInfo (tidak kosong) menyatakan sebagian simbol lama delisted:
          // simbol itu tetap dilepas (markDelisted, SYMBOL_DELISTED); sisanya dipertahankan. Tanpa rekonsiliasi
          // sinyal terbuka (statusBySymbol null) karena hasil discovery ini tidak dipercaya.
          checkStopping();
          stopped = await syncSymbols(err.exchange, err.kept, at);
          target = err.kept;
        } else if (monitored.length === 0) {
          // Tanpa set simbol aktif → pakai simbol yang terakhir dipantau di database.
          target = await repos.symbols.listMonitored();
        }
      }
      checkStopping();
      if (target !== null) stats.candles += await applyTarget(target, stopped, at, statusBySymbol);
      logger.info({ kind, symbols: monitored.length, streams: streams.size, candles: stats.candles }, 'siklus scanner selesai');
    } catch (err) {
      if (!(err instanceof ScannerStopped)) {
        await report(settings ? 'scanner' : 'settings', err);
        nextDelay = cfg.discoveryRetryMs;
      }
    } finally {
      cycleStats = null;
      const finishedAt = localClock();
      scanDurationMs = finishedAt - startedAt;
      try {
        await repos.ingestion.recordRun({ startedAt, finishedAt, symbols: monitored.length, candles: stats.candles, errors: stats.errors });
      } catch (err) {
        logger.error({ err: errorMessage(err) }, 'gagal mencatat run ingesti');
      }
      schedule('rediscovery', nextDelay, () => runCycle('rediscovery'));
    }
  }

  // ---------- heartbeat & status ----------

  function currentState() {
    if (phase !== 'running') return phase;
    if (stream === null || clockFault !== null) return 'degraded';
    return stream.state()?.state === 'open' ? 'running' : 'degraded';
  }

  function status() {
    const now = clock();
    const ws = stream ? stream.state() : null;
    let staleStreams = 0;
    for (const st of streams.values()) {
      if (st.lastOpenTime === null || st.lastOpenTime < lastClosedOpenTime(now - cfg.sweepGraceMs, st.timeframe)) staleStreams += 1;
    }
    return {
      state: currentState(),
      lastIngestionAt,
      candleLagMs: latestCloseTime === null ? null : Math.max(0, now - latestCloseTime),
      reconnects: reconnectsBase + (ws?.reconnects ?? 0),
      errors,
      scanDurationMs,
      queue: pending,
      symbols: monitored.length,
      streams: streams.size,
      staleStreams,
      ws: ws?.state ?? null,
      gaps: counters.gaps,
      duplicates: counters.duplicates,
      clockOffsetMs: serverClock ? serverClock.offsetMs() : null,
      clockFault,
    };
  }

  async function heartbeat() {
    try {
      // `state` = snapshot status() lengkap (memuat field `state`); disimpan apa adanya sebagai JSON
      // dan dibaca kembali oleh /api/system/status.
      await repos.ingestion.heartbeat({ at: localClock(), state: status() });
    } catch (err) {
      logger.error({ err: errorMessage(err) }, 'heartbeat ingesti gagal');
    }
  }

  function scheduleHeartbeat() {
    schedule('heartbeat', cfg.heartbeatMs, async () => {
      await heartbeat();
      scheduleHeartbeat();
    });
  }

  async function drain() {
    while (inflight.size > 0) await Promise.allSettled([...inflight]);
  }

  return {
    /**
     * Likuiditas dari discovery terakhir + ambang pengaturan yang dipakai discovery tersebut
     * (null bila belum ada / memakai fallback daftar DB).
     * @returns {{ quoteVolume24h: number|null, spreadBps: number|null, thresholds: { minQuoteVolume24h: number, maxSpreadBps: number } | null } | null}
     */
    liquidityOf(symbol) {
      return liquidity.get(symbol) ?? null;
    },
    /** Menjalankan discovery + bootstrap pertama lalu loop berkala. Tidak reject karena error REST/DB. */
    start() {
      if (startPromise) return startPromise;
      if (phase !== 'idle') return Promise.resolve();
      phase = 'starting';
      startPromise = track((async () => {
        await heartbeat();
        scheduleHeartbeat();
        await runCycle('start');
        if (isStopping()) return;
        phase = 'running';
        ensureSweep();
        await heartbeat();
      })().catch((err) => report('scanner', err)));
      return startPromise;
    },

    /** Graceful stop: hentikan timer & stream, tunggu tugas aktif selesai, heartbeat akhir. Idempoten. */
    stop() {
      if (stopPromise) return stopPromise;
      phase = 'stopping';
      stopPromise = (async () => {
        for (const name of [...timers.keys()]) cancel(name);
        if (stream) {
          reconnectsBase += stream.state()?.reconnects ?? 0;
          stream.stop();
          stream = null;
        }
        await drain();
        for (const name of [...timers.keys()]) cancel(name);
        phase = 'stopped';
        await heartbeat();
      })();
      return stopPromise;
    },

    status,
  };
}
