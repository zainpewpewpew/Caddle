// Worker scanner: discovery simbol → bootstrap candle REST → stream WebSocket → penyimpanan
// → callback analisis. Dirancang untuk berjalan lama:
// - setiap pasangan simbol×timeframe punya antrean sendiri → urutan candle terjaga;
// - request REST dibatasi paralelismenya (default 3);
// - lompatan openTime (gap, mis. setelah reconnect) di-backfill via REST SEBELUM analisis;
// - duplikat/out-of-order tetap disimpan (idempoten) tetapi tidak memicu analisis ulang;
// - sweep berkala menambal stream yang tertinggal (fallback bila WS diam);
// - rediscovery periodik menangani simbol baru & delisting;
// - semua error dicatat (dengan throttle) dan tidak menghentikan proses.
// Semua waktu lewat `clock` dan semua timer lewat setTimer/clearTimer injeksi.

import { TIMEFRAMES, TIMEFRAME_MS, expectedCloseTime } from '../backend/market/contracts.js';
import { MAX_KLINES_PER_REQUEST, lastClosedOpenTime, planBackfill, planGapFill } from '../backend/ingestion/backfill.js';

export const SCANNER_DEFAULTS = Object.freeze({
  heartbeatMs: 30_000,
  rediscoveryMs: 3_600_000,
  discoveryRetryMs: 60_000,
  restConcurrency: 3,
  provisionalThrottleMs: 1_000,
  // Candle dianggap "terlewat" bila sudah tertutup lebih lama dari grace ini tanpa diterima.
  sweepGraceMs: 30_000,
  reconnectSweepGraceMs: 5_000,
  // Gap yang lebih panjang dipotong ke candle paling baru (sisanya ditutup repair findGaps).
  maxGapCandles: 10_000,
  gapMergeWithin: 50,
  errorThrottleMs: 60_000,
  // Bootstrap awal = histori murni; default tidak memicu analisis.
  emitBootstrap: false,
});

const MESSAGE_MAX = 500;
const noopLogger = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });

class ScannerStopped extends Error {
  constructor() {
    super('scanner dihentikan');
    this.name = 'ScannerStopped';
  }
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

function assertDeps({ rest, streamFactory, repos, getSettings, discoverSymbols, onClosedCandles }) {
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
}

/** Normalisasi pengaturan scanner (lihat backend/settings/scannerSettings.js). */
function normalizeSettings(raw) {
  if (raw === null || typeof raw !== 'object') throw new TypeError('pengaturan scanner tidak valid');
  const timeframes = TIMEFRAMES.filter((tf) => Array.isArray(raw.timeframes) && raw.timeframes.includes(tf));
  if (timeframes.length === 0) throw new RangeError('pengaturan scanner tanpa timeframe valid');
  return {
    raw,
    timeframes,
    bootstrapCandles: clampInt(raw.refresh?.bootstrapCandles, 1, MAX_KLINES_PER_REQUEST, 500),
    backfillIntervalMs: clampInt(raw.refresh?.restBackfillIntervalSec, 30, 3600, 300) * 1000,
  };
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
 *   discoverSymbols: (args: { symbols: object[], tickers: object[], bookTickers: object[], settings: object })
 *     => { selected: Array<{ symbol: string }>, rejected: object[] } | Promise<object>,
 *   clock?: () => number, logger?: object, setTimer?: Function, clearTimer?: Function, options?: object,
 * }} deps
 * @returns {{ start(): Promise<void>, stop(): Promise<void>, status(): object, liquidityOf(symbol: string): object|null }}
 */
export function createScanner({
  rest,
  streamFactory,
  repos,
  getSettings,
  onClosedCandles = async () => {},
  discoverSymbols,
  clock = Date.now,
  logger = noopLogger,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
  options = {},
}) {
  assertDeps({ rest, streamFactory, repos, getSettings, discoverSymbols, onClosedCandles });
  const cfg = { ...SCANNER_DEFAULTS, ...options };
  const limiter = createLimiter(cfg.restConcurrency);

  let phase = 'idle';
  let settings = null;
  let startPromise = null;
  let stopPromise = null;
  /** @type {Map<string, object>} state per simbol×timeframe */
  const streams = new Map();
  const symbolInfo = new Map();
  let monitored = [];
  /** @type {Map<string, { quoteVolume24h: number|null, spreadBps: number|null }>} */
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

  /** Mencatat error: dihitung selalu, ditulis ke repositori dengan throttle per sumber+pesan. */
  async function report(source, err, st) {
    if (err instanceof ScannerStopped) return;
    errors += 1;
    if (cycleStats) cycleStats.errors += 1;
    const detail = errorMessage(err);
    const message = `${st ? `${st.symbol} ${st.timeframe}: ` : ''}${detail}`.slice(0, MESSAGE_MAX);
    logger.warn({ source, symbol: st?.symbol, timeframe: st?.timeframe, err: detail }, 'galat scanner');
    const now = clock();
    const key = `${source}|${detail}`;
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

  function newStreamState(symbol, timeframe) {
    return {
      key: streamKey(symbol, timeframe),
      symbol,
      timeframe,
      lastOpenTime: null,
      lastCloseTime: null,
      chain: Promise.resolve(),
      syncing: false,
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
    lastIngestionAt = clock();
    const rejected = Array.isArray(result?.rejected) ? result.rejected : [];
    if (rejected.length === 0) return candles;
    const bad = new Set(rejected.map((r) => r?.candle?.openTime));
    const reasons = Array.isArray(rejected[0]?.errors) ? rejected[0].errors.join(', ') : 'tidak valid';
    await report('validation', `${rejected.length} candle ditolak: ${reasons}`, st);
    return candles.filter((c) => !bad.has(c.openTime));
  }

  /** Memajukan high-water mark stream; memanggil analisis untuk candle yang lebih baru. */
  async function commit(st, accepted, reason, emit) {
    const fresh = accepted.filter((c) => st.lastOpenTime === null || c.openTime > st.lastOpenTime);
    if (fresh.length === 0) return;
    const last = fresh.at(-1);
    st.lastOpenTime = last.openTime;
    st.lastCloseTime = last.closeTime;
    if (latestCloseTime === null || last.closeTime > latestCloseTime) latestCloseTime = last.closeTime;
    if (!emit || !isActive(st)) return;
    try {
      await onClosedCandles({ symbol: st.symbol, timeframe: st.timeframe, candles: fresh, reason });
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
   * Seri yang belum punya data (bootstrap murni) tidak dianalisis kecuali emitBootstrap.
   */
  async function syncStream(st, reason, extra = []) {
    if (!isActive(st)) return 0;
    const fresh = st.lastOpenTime === null;
    const plan = planBackfill({
      lastOpenTime: st.lastOpenTime,
      now: clock(),
      timeframe: st.timeframe,
      maxCandles: fresh ? settings.bootstrapCandles : cfg.maxGapCandles,
    });
    const fetched = [];
    for (const req of plan) fetched.push(...await fetchKlines(st, req));
    const accepted = await upsertClosed(st, mergeClosed(st, [...extra, ...fetched]));
    const emit = reason === 'bootstrap' || fresh ? cfg.emitBootstrap : true;
    await commit(st, accepted, reason, emit);
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
    const plan = planGapFill({ gaps, timeframe: st.timeframe, now: clock(), mergeWithin: cfg.gapMergeWithin });
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
    const now = clock();
    if (candle.openTime === st.provisionalOpenTime && now - st.provisionalAt < cfg.provisionalThrottleMs) return;
    st.provisionalAt = now;
    st.provisionalOpenTime = candle.openTime;
    track(Promise.resolve()
      .then(() => repos.candles.upsertProvisional(candle))
      .then(() => { lastIngestionAt = clock(); }, (err) => report('provisional', err, st)));
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
        if (meta.down) track(sweep('reconnect', cfg.reconnectSweepGraceMs));
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

  /** Menjadwalkan sinkronisasi REST untuk stream yang tertinggal dari candle tertutup terakhir. */
  function sweep(reason, graceMs) {
    const now = clock();
    const tasks = [];
    for (const st of streams.values()) {
      if (st.syncing) continue;
      const expected = lastClosedOpenTime(now - graceMs, st.timeframe);
      if (st.lastOpenTime !== null && st.lastOpenTime >= expected) continue;
      st.syncing = true;
      tasks.push(enqueue(st, async () => {
        try {
          await syncStream(st, reason);
        } catch (err) {
          await report('backfill', err, st);
        } finally {
          st.syncing = false;
        }
      }));
    }
    return Promise.all(tasks);
  }

  function scheduleSweep() {
    schedule('sweep', settings.backfillIntervalMs, async () => {
      await sweep('sweep', cfg.sweepGraceMs);
      scheduleSweep();
    });
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
    // Likuiditas terakhir per simbol (quote volume 24 jam, spread) untuk risk flag di pipeline analisis.
    liquidity = new Map(chosen.map((s) => [s.symbol, { quoteVolume24h: s.quoteVolume24h ?? null, spreadBps: s.spreadBps ?? null }]));
    return { symbols: Array.isArray(symbols) ? symbols : [], selected: chosen.map((s) => s.symbol) };
  }

  async function syncSymbols(exchange, selected, now) {
    await repos.symbols.upsertFromExchange(exchange, now);
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
  }

  /** Menyesuaikan set stream dengan target; stream baru di-bootstrap. Mengembalikan jumlah candle. */
  async function applyTarget(target) {
    const desired = new Map();
    for (const symbol of target) {
      for (const timeframe of settings.timeframes) desired.set(streamKey(symbol, timeframe), { symbol, timeframe });
    }
    const removed = [...streams.keys()].filter((k) => !desired.has(k));
    for (const k of removed) streams.delete(k);
    const added = [];
    for (const [k, d] of desired) {
      if (streams.has(k)) continue;
      const st = newStreamState(d.symbol, d.timeframe);
      streams.set(k, st);
      added.push(st);
    }
    monitored = [...target];
    if (added.length > 0 || removed.length > 0 || (stream === null && streams.size > 0)) replaceStream();
    const counts = await Promise.all(added.map((st) => {
      let n = 0;
      return enqueue(st, async () => { n = await bootstrapStream(st); }).then(() => n);
    }));
    return counts.reduce((a, b) => a + b, 0);
  }

  async function runCycle(kind) {
    const startedAt = clock();
    const stats = { candles: 0, errors: 0 };
    cycleStats = stats;
    let nextDelay = cfg.rediscoveryMs;
    try {
      await loadSettings();
      let target = null;
      try {
        const found = await discover();
        checkStopping();
        await syncSymbols(found.symbols, found.selected, startedAt);
        target = found.selected;
        discoveryFailures = 0;
      } catch (err) {
        if (err instanceof ScannerStopped) throw err;
        discoveryFailures += 1;
        await report('discovery', err);
        nextDelay = Math.min(cfg.rediscoveryMs, cfg.discoveryRetryMs * 2 ** (discoveryFailures - 1));
        // Tanpa set simbol aktif → pakai simbol yang terakhir dipantau di database.
        if (monitored.length === 0) target = await repos.symbols.listMonitored();
      }
      checkStopping();
      if (target !== null) stats.candles += await applyTarget(target);
      logger.info({ kind, symbols: monitored.length, streams: streams.size, candles: stats.candles }, 'siklus scanner selesai');
    } catch (err) {
      if (!(err instanceof ScannerStopped)) {
        await report(settings ? 'scanner' : 'settings', err);
        nextDelay = cfg.discoveryRetryMs;
      }
    } finally {
      cycleStats = null;
      const finishedAt = clock();
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
    if (stream === null) return 'degraded';
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
    };
  }

  async function heartbeat() {
    try {
      // `state` = snapshot status() lengkap (memuat field `state`); disimpan apa adanya sebagai JSON
      // dan dibaca kembali oleh /api/system/status.
      await repos.ingestion.heartbeat({ at: clock(), state: status() });
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
    /** Likuiditas dari discovery terakhir (null bila belum ada / memakai fallback daftar DB). */
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
        scheduleSweep();
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
