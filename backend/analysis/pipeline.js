// Pipeline analisis per candle tertutup: pola → konteks timeframe → skor → state machine → persistensi.
// Arah LONG (pola SA/PVA) dan SHORT (pola SD/PVD = cermin SA/PVA, lihat backend/patterns/mirror.js). Kedua
// arah berbagi candle, kualitas seri, trend HTF, dan input pasar (ATR, RVOL, swing) per candle; yang dihitung
// per arah hanya deteksi pola, alignment (relatif terhadap arah), skor, dan state machine.
// Worker live memanggil `createAnalysisPipeline(...).onClosedCandles`; replay/backtest (M6) memanggil
// `analyzeAt` / `analyzeDirectionsAt` yang sama dengan sumber candle historis, sehingga live dan backtest
// memakai logika identik. Skor adalah skor aturan yang dapat dijelaskan, bukan probabilitas; sinyal SHORT
// adalah kandidat riset, bukan rekomendasi jual/short.
import { setImmediate as nextMacrotask } from 'node:timers/promises';
import { DIRECTIONS, HIGHER_TIMEFRAMES, TIMEFRAME_MS, TIMEFRAMES, resolveDirection } from '../market/contracts.js';
import {
  MIRROR_BASE, PATTERN_VERSION, PVA_CONDITIONS, PVD_CONDITIONS, SA_CONDITIONS, SD_CONDITIONS, SHORT_PATTERN_VERSION,
  evaluatePatterns, evaluateShortPatterns, requiredCandles, resolveParams,
} from '../patterns/index.js';
import { applyCalibration } from '../backtest/calibration.js';
import { extractFeatures } from '../features/index.js';
import { buildSignalView, computeConfluence } from '../scoring/index.js';
import { deriveDirectionalMarketInputs, transition } from '../signals/index.js';
import { buildTimeframeContext, contextForDirection } from '../timeframe/index.js';

// Candle historis yang dimuat per timeframe: warm-up pola (SA/SD 63, PVA/PVD 70), trend (29) dan swing
// resistance/support, dengan cadangan agar ATR/EMA stabil.
export const ANALYSIS_LOOKBACK = 300;

const PATTERN_NAMES = Object.freeze({
  SA: 'Silent Accumulation',
  PVA: 'Progressive Volume Accumulation',
  SD: 'Silent Distribution',
  PVD: 'Progressive Volume Distribution',
});

/** Pola per arah: kunci, metadata kondisi, kunci override di `params`, dan versi metodologi. */
const PATTERNS_BY_DIRECTION = Object.freeze({
  LONG: Object.freeze([
    { key: 'SA', conditions: SA_CONDITIONS, paramsKey: 'sa', version: PATTERN_VERSION },
    { key: 'PVA', conditions: PVA_CONDITIONS, paramsKey: 'pva', version: PATTERN_VERSION },
  ]),
  SHORT: Object.freeze([
    { key: 'SD', conditions: SD_CONDITIONS, paramsKey: 'sd', version: SHORT_PATTERN_VERSION },
    { key: 'PVD', conditions: PVD_CONDITIONS, paramsKey: 'pvd', version: SHORT_PATTERN_VERSION },
  ]),
});

/** Penjelasan likuiditas untuk candle historis hasil replay (ukuran saat ini tidak dipakai — tanpa lookahead). */
export const REPLAY_LIQUIDITY_DETAIL = 'Data likuiditas tidak tersedia untuk candle historis (replay): ukuran 24 jam '
  + 'dari discovery terakhir hanya berlaku untuk candle terbaru, sehingga risk flag likuiditas/spread tidak dinilai';

function withReplayLiquidity(view) {
  return { ...view, explanation: view.explanation.map((e) => (e.factor === 'CONTEXT:LIQUIDITY' ? { ...e, detail: REPLAY_LIQUIDITY_DETAIL } : e)) };
}

/**
 * Kunci tabel kalibrasi: `${arah}:${timeframe}` lebih spesifik, lalu `${arah}:*`. Tabel berasal dari backtest
 * out-of-sample (`npm run backtest -- --write-calibration`); tanpa tabel peluang = null (tidak pernah dikarang).
 */
function calibrationFor(calibration, direction, timeframe, score) {
  const tables = calibration?.tables;
  if (!tables || typeof tables !== 'object') return null;
  const table = tables[`${direction}:${timeframe}`] ?? tables[`${direction}:*`] ?? null;
  if (!table) return null;
  try {
    const c = applyCalibration(table, score);
    const unit = (v) => Number.isFinite(v) && v >= 0 && v <= 1;
    return c && unit(c.probability) && unit(c.lower) && unit(c.upper) ? c : null;
  } catch {
    return null; // tabel rusak tidak boleh menghentikan analisis seri
  }
}

/**
 * View + konfluensi v3: `view.confluence` (skor, tier, komponen, konfirmasi, konflik, veto, kalibrasi) dan entri
 * penjelasan `CONFLUENCE:*` (kontribusi komponen dijumlahkan = skor konfluensi; entri lain kontribusi 0).
 */
function withConfluence(view, { direction, timeframe, context, features, params, scoreView }) {
  // Timeframe tanpa HTF (1h): alignment selalu UNCONFIRMED karena tidak ada pembanding, bukan karena setup buruk —
  // komponen HTF dikeluarkan dari penyebut alih-alih dinilai 0.
  const hasHtf = HIGHER_TIMEFRAMES[timeframe].length > 0;
  const input = hasHtf ? { view: scoreView, context } : { view: { ...scoreView, alignment: null }, context: null };
  const c = computeConfluence({ direction, ...input, ...features }, params.confluence ?? {});
  const calibration = calibrationFor(params.calibration, direction, timeframe, c.score);
  const explanation = [
    {
      factor: 'CONFLUENCE:TIER',
      contribution: 0,
      detail: `Konfluensi v${c.version}: skor ${c.score} → tier ${c.tier}${c.vetoes.length ? ` (veto: ${c.vetoes.join(', ')})` : ''}`
        + (calibration
          ? `; peluang historis ${Math.round(calibration.probability * 100)}% (95% CI ${Math.round(calibration.lower * 100)}–${Math.round(calibration.upper * 100)}%, ${calibration.samples} sampel backtest)`
          : '; peluang historis belum tersedia (jalankan kalibrasi backtest)'),
    },
    ...c.components.map((k) => ({
      factor: `CONFLUENCE:${k.id}`,
      contribution: k.contribution,
      detail: `${k.label}: ${k.value === null ? 'data tidak tersedia' : `nilai ${Math.round(k.value * 100)}%`} (bobot ${k.weight})`,
    })),
    ...c.confirmations.map((t) => ({ factor: 'CONFLUENCE:CONFIRM', contribution: 0, detail: t })),
    ...c.conflicts.map((t) => ({ factor: 'CONFLUENCE:CONFLICT', contribution: 0, detail: t })),
  ];
  return { ...view, confluence: { ...c, calibration }, explanation: [...view.explanation, ...explanation] };
}

/** Daftar arah tervalidasi (tidak kosong, tanpa duplikat), urut DIRECTIONS (LONG lebih dulu). */
function resolveDirections(directions) {
  if (!Array.isArray(directions) || directions.length === 0) throw new TypeError('directions harus array arah yang tidak kosong');
  for (const d of directions) if (!DIRECTIONS.includes(d)) throw new RangeError(`Arah tidak dikenal: ${String(d)}`);
  if (new Set(directions).size !== directions.length) throw new RangeError('directions tidak boleh berisi arah ganda');
  return Object.freeze(DIRECTIONS.filter((d) => directions.includes(d)));
}

/**
 * Timeframe per arah untuk pipeline: null = semua timeframe (perilaku lama, dipakai tes/replay); objek
 * { LONG?: string[], SHORT?: string[] } — arah aktif tanpa entri juga memakai semua timeframe.
 */
function resolveDirectionTimeframes(map, directions) {
  if (map !== null && (typeof map !== 'object' || Array.isArray(map))) throw new TypeError('directionTimeframes harus objek atau null');
  const out = {};
  for (const d of directions) {
    const list = map?.[d] ?? TIMEFRAMES;
    if (!Array.isArray(list) || list.length === 0 || list.some((tf) => !TIMEFRAMES.includes(tf))) {
      throw new RangeError(`directionTimeframes.${d} harus array timeframe valid yang tidak kosong`);
    }
    out[d] = Object.freeze([...list]);
  }
  return Object.freeze(out);
}

/**
 * Kualitas seri dasar yang dimuat: celah (openTime tidak bersambung), candle belum tertutup, campuran seri.
 * Pola juga memeriksa jendelanya sendiri; ini menangkap masalah di luar jendela pola (mis. konteks swing).
 * @returns {{ ok: boolean, issues: string[] }}
 */
export function assessSeriesQuality(candles, timeframe) {
  const issues = [];
  const ms = TIMEFRAME_MS[timeframe];
  let gaps = 0;
  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i];
    if (c.isClosed !== true) issues.push('UNCLOSED_CANDLE');
    if (c.timeframe !== timeframe || c.symbol !== candles[0].symbol) issues.push('MIXED_SERIES');
    if (i > 0 && c.openTime - candles[i - 1].openTime !== ms) gaps += 1;
  }
  if (gaps > 0) issues.push(`GAP:${gaps}`);
  const unique = [...new Set(issues)];
  return { ok: unique.length === 0, issues: unique };
}

/**
 * Evaluasi murni BEBERAPA arah pada satu titik waktu (closeTime candle dasar terakhir). Tidak menyentuh
 * database. Candle, kualitas seri, trend per timeframe, dan input pasar dihitung SEKALI untuk semua arah;
 * per arah: pola (LONG: SA/PVA, SHORT: SD/PVD pada candle cermin), alignment relatif arah, skor, transisi.
 * Hasil tiap arah identik dengan analyzeAt({ ..., direction }) untuk arah itu.
 * @param {{ symbol: string, timeframe: string,
 *   candlesByTimeframe: Record<string, import('../market/contracts.js').Candle[]>,
 *   prevByDirection?: { LONG?: object|null, SHORT?: object|null },
 *   liquidity?: { quoteVolume24h?: number, spreadBps?: number },
 *   dataQuality?: { ok: boolean, issues?: string[] },
 *   params?: { sa?: object, pva?: object, sd?: object, pvd?: object, signals?: object,
 *     view?: { minQuoteVolume24h?: number, maxSpreadBps?: number } },
 *   directions?: Array<'LONG'|'SHORT'> }} input
 *   prevByDirection: sinyal terbuka per arah (tidak ada = null). directions: default kedua arah.
 *   params.sd/pvd: override parameter pola SHORT (terpisah dari sa/pva; default = default SA/PVA).
 * @returns {null | Partial<Record<'LONG'|'SHORT', { direction: 'LONG'|'SHORT', evaluationTime: number,
 *   patterns: object, context: object, view: object, market: object, next: object, event: object|null, alert: boolean }>>}
 */
export function analyzeDirectionsAt({
  symbol, timeframe, candlesByTimeframe, prevByDirection = {}, liquidity, dataQuality, params = {}, directions = DIRECTIONS,
}) {
  if (!TIMEFRAMES.includes(timeframe)) throw new RangeError(`Timeframe tidak didukung: ${timeframe}`);
  const active = resolveDirections(directions);
  if (prevByDirection === null || typeof prevByDirection !== 'object') throw new TypeError('prevByDirection harus objek');
  const base = candlesByTimeframe?.[timeframe] ?? [];
  if (!base.length) return null;
  const last = base[base.length - 1];
  const evaluationTime = last.closeTime;

  const quality = dataQuality ?? assessSeriesQuality(base, timeframe);
  const patternsByDirection = {};
  for (const direction of active) {
    patternsByDirection[direction] = direction === 'SHORT'
      ? evaluateShortPatterns(base, { sd: params.sd, pvd: params.pvd })
      : evaluatePatterns(base, { sa: params.sa, pva: params.pva });
  }
  // Trend per timeframe dihitung sekali. Alignment LONG = hasil buildTimeframeContext apa adanya; arah lain
  // hanya menghitung ulang alignment dari trend yang sama (contextForDirection).
  const context = buildTimeframeContext({ baseTimeframe: timeframe, evaluationTime, candlesByTimeframe });
  const markets = deriveDirectionalMarketInputs(base);
  // Fitur v3 dihitung sekali untuk kedua arah (fitur tidak berarah). params.confluence === false = mode v2 murni
  // (tanpa fitur/konfluensi/gerbang tier) — dipakai backtest sebagai pembanding "sebelum".
  const confluenceOn = params.confluence !== false;
  const features = confluenceOn ? extractFeatures(base) : null;

  const out = {};
  for (const direction of active) {
    const patterns = patternsByDirection[direction];
    const directionContext = direction === 'LONG' ? context : contextForDirection(context, timeframe, direction);
    let view = buildSignalView({ symbol, timeframe, patterns, context: directionContext, liquidity, dataQuality: quality, params: params.view });
    if (confluenceOn) {
      // Tier (yang menggerbang state) dihitung TANPA likuiditas 24 jam saat ini: ukuran itu hanya ada untuk candle terbaru
      // (replay/backtest tidak memilikinya), sehingga live, restart, dan backtest memberi state yang sama. Risk flag
      // likuiditas tetap tampil di view; flag likuiditas dari candle (detektor) tetap ikut veto.
      const scoreView = liquidity === undefined || liquidity === null ? view : buildSignalView({
        symbol, timeframe, patterns, context: directionContext, dataQuality: quality, params: params.view,
      });
      view = withConfluence(view, { direction, timeframe, context: directionContext, features, params, scoreView });
    }
    const market = markets[direction];
    const result = transition(prevByDirection[direction] ?? null, { candle: last, patterns, context: directionContext, market, view }, params.signals);
    out[direction] = { direction, evaluationTime, patterns, context: directionContext, view, market, ...result };
  }
  return out;
}

/**
 * Evaluasi murni SATU arah pada satu titik waktu (closeTime candle dasar terakhir). Tidak menyentuh database.
 * Hanya candle dengan closeTime ≤ waktu evaluasi yang dipakai, termasuk timeframe lebih tinggi.
 * @param {{ symbol: string, timeframe: string,
 *   candlesByTimeframe: Record<string, import('../market/contracts.js').Candle[]>,
 *   prev: object|null, liquidity?: { quoteVolume24h?: number, spreadBps?: number },
 *   dataQuality?: { ok: boolean, issues?: string[] },
 *   params?: { sa?: object, pva?: object, sd?: object, pvd?: object, signals?: object, view?: { minQuoteVolume24h?: number, maxSpreadBps?: number } },
 *   direction?: 'LONG'|'SHORT' }} input
 *   `direction` default LONG (pola SA/PVA, perilaku lama); SHORT = pola SD/PVD dan `prev` wajib sinyal SHORT.
 *   `params.view`: ambang risk flag likuiditas/spread (default DEFAULT_VIEW_PARAMS). Worker live mengisinya
 *   dengan ambang pengaturan scanner yang dipakai discovery; backtest dapat memberikan ambangnya sendiri.
 * @returns {null | { direction: 'LONG'|'SHORT', evaluationTime: number, patterns: object, context: object, view: object,
 *   market: object, next: object, event: object|null, alert: boolean }}
 */
export function analyzeAt({ symbol, timeframe, candlesByTimeframe, prev, liquidity, dataQuality, params = {}, direction = 'LONG' }) {
  if (!TIMEFRAMES.includes(timeframe)) throw new RangeError(`Timeframe tidak didukung: ${timeframe}`);
  const dir = resolveDirection(direction);
  const results = analyzeDirectionsAt({
    symbol, timeframe, candlesByTimeframe, prevByDirection: { [dir]: prev ?? null }, liquidity, dataQuality, params, directions: [dir],
  });
  return results === null ? null : results[dir];
}

/**
 * Definisi pola berversi yang dipersistensi (pattern_definitions) — parameter efektif + metadata kondisi.
 * `maxWarmup` = jumlah candle yang benar-benar dimuat pemanggil (lookback pipeline); parameter yang
 * warm-up-nya melebihi itu ditolak PatternParamsError alih-alih membuat pola diam-diam selalu insufficientData.
 * `directions` default ['LONG'] (SA, PVA — bentuk definisi tidak berubah); SHORT menambah SD & PVD dengan
 * `direction: 'SHORT'` dan `mirrorOf` (pola & versi LONG yang dicerminkan), sehingga perubahan SA/PVA tanpa
 * menaikkan SHORT_PATTERN_VERSION ditolak DEFINITION_CONFLICT saat definisi didaftarkan.
 */
export function patternDefinitions(params = {}, { maxWarmup, directions = ['LONG'] } = {}) {
  const options = maxWarmup === undefined ? undefined : { maxWarmup };
  return resolveDirections(directions).flatMap((direction) => PATTERNS_BY_DIRECTION[direction].map(({ key, conditions, paramsKey, version }) => {
    const p = resolveParams(key, params[paramsKey], options);
    const definition = { params: { ...p }, conditions: conditions.map((c) => ({ ...c })), requiredCandles: requiredCandles(key, p) };
    if (direction === 'SHORT') Object.assign(definition, { direction, mirrorOf: { pattern: MIRROR_BASE[key], version: PATTERN_VERSION } });
    return { key, version, name: PATTERN_NAMES[key], definition };
  }));
}

/**
 * Handler `onClosedCandles` untuk scanner. Evaluasi per (simbol, timeframe) diserialkan agar
 * candle WebSocket dan backfill yang datang bersamaan tidak membuka dua sinyal.
 *
 * Setiap candle dasar BARU dievaluasi berurutan (replay) — mis. setelah backfill gap beberapa candle
 * sekaligus — sehingga transisi state terjadi pada candle yang benar, sama seperti backtest.
 * Alert hanya untuk candle terbaru; transisi historis hasil replay disimpan tanpa alert.
 * Titik awal replay = kursor analisis persisten PER ARAH (signals.lastEvaluatedCandleTime: candle terakhir
 * yang dievaluasi, termasuk candle tanpa event), sehingga restart hanya mengevaluasi candle setelah kursor.
 * Evaluasi pertama sebuah seri (atau arah) tanpa kursor hanya memakai candle terakhir (bootstrap = histori).
 * Replay panjang memberi giliran ke event loop tiap `yieldEvery` candle TOTAL di seluruh pipeline — anggaran
 * bersama antar seri, bukan per seri — sehingga banyak seri yang me-replay bersamaan (mis. setelah gap
 * panjang di-backfill) tetap menahan timer/heartbeat/WS paling lama ±`yieldEvery` candle, bukan N × `yieldEvery`.
 *
 * Arah (`directions`, default ['LONG'] — perilaku lama; worker memakai kedua arah): setiap candle dievaluasi
 * sekali untuk semua arah yang belum mengevaluasinya (candle, trend HTF, dan input pasar dipakai bersama; satu
 * giliran anggaran `yieldEvery` per candle). Sinyal, event, dan kursor disimpan per arah (LONG lebih dulu).
 * Panggilan repositori untuk LONG tidak membawa argumen `direction` (bentuk lama); SHORT memakai
 * `direction: 'SHORT'`.
 *
 * `directionTimeframes` (worker: DIRECTION_TIMEFRAMES = LONG 15m, SHORT 1h): arah hanya dievaluasi pada timeframe-nya;
 * seri tanpa arah yang berlaku dilewati (skipped 'NO_DIRECTION'). Sinyal terbuka lama dari arah yang tidak lagi dipindai
 * pada timeframe itu ditutup EXPIRED (MONITORING_STOPPED) saat seri itu pertama kali dievaluasi. null = semua timeframe.
 *
 * @param {{ repos: { candles: any }, signals: any,
 *   getLiquidity?: (symbol: string) => { quoteVolume24h: number|null, spreadBps: number|null,
 *     thresholds?: { minQuoteVolume24h: number, maxSpreadBps: number } } | null | undefined,
 *   logger?: any, params?: object, lookback?: number, maxReplay?: number, settleMs?: number,
 *   sleep?: (ms: number) => Promise<void>, yieldEvery?: number, yieldToEventLoop?: () => Promise<void>,
 *   directions?: Array<'LONG'|'SHORT'>, directionTimeframes?: { LONG?: string[], SHORT?: string[] } | null,
 *   onAlert?: (alert: { symbol: string, timeframe: string, direction: 'LONG'|'SHORT', state: string, event: object, view: object }) => void }} deps
 *   settleMs: bila candle timeframe lebih tinggi yang tutup bersamaan belum tersimpan, tunggu sekali
 *   selama ini agar konteks live sama dengan replay (stream per timeframe diproses paralel).
 *   getLiquidity: ukuran likuiditas dari discovery terakhir; `thresholds` (ambang pengaturan yang dipakai
 *   discovery yang sama) menggantikan `params.view` agar risk flag & penjelasan memakai batas pengguna.
 *   Ukuran itu menggambarkan pasar SAAT INI, jadi hanya dipakai untuk candle terbaru batch; candle
 *   historis hasil replay dievaluasi dengan likuiditas tidak diketahui (tanpa POOR_LIQUIDITY/WIDE_SPREAD,
 *   penjelasan CONTEXT:LIQUIDITY = REPLAY_LIQUIDITY_DETAIL) agar tidak ada lookahead.
 */
export function createAnalysisPipeline({
  repos, signals, getLiquidity = () => undefined, logger, params = {}, lookback = ANALYSIS_LOOKBACK,
  maxReplay = 288, settleMs = 0, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), onAlert,
  yieldEvery = 25, yieldToEventLoop = () => nextMacrotask(), directions = ['LONG'], directionTimeframes = null,
}) {
  if (!repos?.candles || !signals) throw new TypeError('repos.candles dan signals wajib ada');
  if (!Number.isInteger(lookback) || lookback < 100 || lookback > 1500) throw new RangeError('lookback harus 100..1500');
  if (!Number.isInteger(maxReplay) || maxReplay < 1 || maxReplay > 5000) throw new RangeError('maxReplay harus 1..5000');
  if (!Number.isInteger(settleMs) || settleMs < 0 || settleMs > 30_000) throw new RangeError('settleMs harus 0..30000');
  if (!Number.isInteger(yieldEvery) || yieldEvery < 1 || yieldEvery > 5000) throw new RangeError('yieldEvery harus 1..5000');
  const activeDirections = resolveDirections(directions);
  const allowedTimeframes = resolveDirectionTimeframes(directionTimeframes, activeDirections);
  // Arah yang dievaluasi pada satu timeframe (worker: LONG hanya 15m, SHORT hanya 1h — DIRECTION_TIMEFRAMES).
  const directionsFor = (timeframe) => activeDirections.filter((d) => allowedTimeframes[d].includes(timeframe));
  // Seri × arah yang sinyal terbuka lamanya (dari timeframe yang kini tidak dipindai arah itu) sudah diperiksa.
  const leftoverChecked = new Set();
  const definitions = patternDefinitions(params, { maxWarmup: lookback, directions: activeDirections });
  let definitionsReady = null;
  const queues = new Map();
  // openTime candle dasar terakhir yang dievaluasi per seri × arah (cache dari kursor analisis persisten, diisi
  // saat pertama kali sehingga tetap berlaku setelah restart) — mencegah candle yang sama dievaluasi dua
  // kali, termasuk membuka sinyal baru pada candle yang baru saja menutup sinyal sebelumnya.
  const lastEvaluated = new Map();
  // Anggaran giliran event loop bersama untuk seluruh pipeline: `sliceUsed` = candle yang dievaluasi sejak
  // jeda terakhir. Seri yang kehabisan anggaran menjadwalkan SATU jeda (`sliceTurn`) — dijadwalkan saat itu
  // juga, jadi berjalan setelah timer/callback yang sudah antre — dan semua seri lain yang ikut kehabisan
  // menunggu jeda yang SAMA; anggaran di-reset saat jeda berjalan. Dengan jeda per seri, N lanjutan
  // setImmediate jatuh di fase check yang sama dan masing-masing menjalankan `yieldEvery` candle sebelum
  // timer/I/O sempat berjalan. Bila tidak ada evaluasi yang berjalan, anggaran di-reset (sama dengan
  // perilaku per panggilan sebelumnya untuk satu seri).
  let sliceUsed = 0;
  let sliceTurn = null;
  let activeEvaluations = 0;

  /** Argumen repositori per arah: LONG tanpa `direction` (bentuk lama), SHORT dengan `direction`. */
  const scoped = (direction, args) => (direction === 'LONG' ? args : { ...args, direction });
  const cursorKey = (symbol, timeframe, direction) => `${symbol}:${timeframe}:${direction}`;

  async function takeEvaluationSlot() {
    while (sliceUsed >= yieldEvery) {
      if (sliceTurn === null) {
        const turn = Promise.resolve(yieldToEventLoop()).catch(() => {}).then(() => {
          if (sliceTurn === turn) {
            sliceUsed = 0;
            sliceTurn = null;
          }
        });
        sliceTurn = turn;
      }
      await sliceTurn;
    }
    sliceUsed += 1;
  }

  function ensureDefinitions() {
    definitionsReady ??= (async () => {
      for (const d of definitions) await signals.ensurePatternDefinition(d);
    })().catch((err) => {
      definitionsReady = null;
      throw err;
    });
    return definitionsReady;
  }

  /** Tunggu sekali bila candle HTF yang seharusnya tutup bersamaan dengan candle dasar belum tersimpan. */
  async function settleHigherTimeframes(symbol, timeframe, evaluationTime) {
    if (settleMs === 0) return;
    for (const tf of HIGHER_TIMEFRAMES[timeframe]) {
      const htfMs = TIMEFRAME_MS[tf];
      if ((evaluationTime + 1) % htfMs !== 0) continue;
      const lastOpen = await repos.candles.getLastOpenTime({ symbol, timeframe: tf });
      if (lastOpen === null || lastOpen < evaluationTime + 1 - htfMs) {
        await sleep(settleMs);
        return;
      }
    }
  }

  /** Pisahkan ukuran likuiditas dari ambang yang menyertainya; ambang → params.view untuk analyzeAt. */
  function liquidityInputs(info) {
    if (info === null || info === undefined) return { liquidity: undefined, params };
    const { thresholds, ...liquidity } = info;
    if (thresholds === null || thresholds === undefined) return { liquidity, params };
    return { liquidity, params: { ...params, view: { ...params.view, ...thresholds } } };
  }

  async function evaluate(series) {
    activeEvaluations += 1;
    try {
      return await evaluateSeries(series);
    } finally {
      activeEvaluations -= 1;
      if (activeEvaluations === 0) {
        sliceUsed = 0;
        sliceTurn = null;
      }
    }
  }

  /**
   * Sinyal terbuka arah yang tidak lagi dipindai pada timeframe ini (mis. LONG 1h / SHORT 15m dari versi sebelum
   * DIRECTION_TIMEFRAMES) ditutup EXPIRED/MONITORING_STOPPED sekali per proses, agar tidak menggantung selamanya.
   */
  async function closeLeftovers(symbol, timeframe, at) {
    for (const direction of activeDirections) {
      if (allowedTimeframes[direction].includes(timeframe)) continue;
      const key = cursorKey(symbol, timeframe, direction);
      if (leftoverChecked.has(key)) continue;
      leftoverChecked.add(key);
      if (typeof signals.closeOpenForSymbol !== 'function') continue;
      if (!(await signals.getOpen(scoped(direction, { symbol, timeframe })))) continue;
      const result = await signals.closeOpenForSymbol({ symbol, timeframes: [timeframe], direction, reason: 'MONITORING_STOPPED', at });
      if (result.closed.length > 0) {
        logger?.info?.({ symbol, timeframe, direction, closed: result.closed.length }, 'sinyal ditutup: arah tidak dipindai di timeframe ini');
      }
    }
  }

  async function evaluateSeries({ symbol, timeframe }) {
    if (!TIMEFRAMES.includes(timeframe)) throw new RangeError(`Timeframe tidak didukung: ${timeframe}`);
    await ensureDefinitions();
    const seriesDirections = directionsFor(timeframe);
    const base = await repos.candles.getLatest({ symbol, timeframe, limit: lookback + maxReplay });
    if (!base.length) return { symbol, timeframe, skipped: 'NO_DATA' };
    const last = base[base.length - 1];
    await closeLeftovers(symbol, timeframe, last.closeTime);
    if (seriesDirections.length === 0) return { symbol, timeframe, skipped: 'NO_DIRECTION' };

    // Candle yang belum dievaluasi per arah (indeks di `base`): selalu sufiks seri yang berakhir di candle terakhir.
    const pendingByDirection = new Map();
    let dropped = 0;
    for (const direction of seriesDirections) {
      const key = cursorKey(symbol, timeframe, direction);
      if (!lastEvaluated.has(key)) lastEvaluated.set(key, await signals.lastEvaluatedCandleTime(scoped(direction, { symbol, timeframe })));
      const seen = lastEvaluated.get(key);
      if (seen !== null && last.openTime <= seen) continue;
      const fresh = seen === null ? [base.length - 1] : base.map((c, i) => (c.openTime > seen ? i : -1)).filter((i) => i >= 0);
      const kept = fresh.slice(-maxReplay);
      dropped = Math.max(dropped, fresh.length - kept.length);
      pendingByDirection.set(direction, new Set(kept));
    }
    if (pendingByDirection.size === 0) return { symbol, timeframe, skipped: 'ALREADY_EVALUATED' };
    // Gabungan semua arah, urut naik: satu evaluasi per candle untuk arah yang belum mengevaluasinya.
    const pending = [...new Set([...pendingByDirection.values()].flatMap((s) => [...s]))].sort((a, b) => a - b);
    if (dropped > 0) {
      logger?.warn?.({ symbol, timeframe, dropped, maxReplay }, 'replay dipotong: candle lama tidak dievaluasi');
    }

    await settleHigherTimeframes(symbol, timeframe, last.closeTime);
    const higher = {};
    const span = (pending.length + 1) * TIMEFRAME_MS[timeframe];
    for (const tf of HIGHER_TIMEFRAMES[timeframe]) {
      higher[tf] = await repos.candles.getLatest({ symbol, timeframe: tf, limit: Math.min(10_000, lookback + Math.ceil(span / TIMEFRAME_MS[tf]) + 2) });
    }

    const { liquidity, params: runParams } = liquidityInputs(getLiquidity(symbol));
    const latest = pending[pending.length - 1];
    const results = new Map();
    for (let n = 0; n < pending.length; n += 1) {
      // Repositori better-sqlite3 resolve sinkron: tanpa jeda eksplisit replay panjang menahan timer & I/O.
      await takeEvaluationSlot();
      const index = pending[n];
      const candle = base[index];
      const window = base.slice(Math.max(0, index + 1 - lookback), index + 1);
      const due = seriesDirections.filter((d) => pendingByDirection.get(d)?.has(index));
      const prevByDirection = {};
      for (const direction of due) prevByDirection[direction] = await signals.getOpen(scoped(direction, { symbol, timeframe }));
      const historical = index !== latest;
      const evaluated = analyzeDirectionsAt({ symbol, timeframe, candlesByTimeframe: { [timeframe]: window, ...higher }, prevByDirection,
        liquidity: historical ? undefined : liquidity, params: runParams, directions: due });
      for (const direction of due) {
        let result = evaluated[direction];
        if (historical) result = { ...result, view: withReplayLiquidity(result.view) };
        const prev = prevByDirection[direction];
        let saved = null;
        if (result.event || (prev && result.next !== prev)) {
          // save() memajukan kursor analisis arah snapshot dalam transaksi yang sama dengan sinyal + event.
          saved = await signals.save({ symbol, timeframe, snapshot: result.next, event: result.event, explanation: result.view.explanation });
        }
        if (saved?.saved !== true) {
          await signals.markEvaluated(scoped(direction, { symbol, timeframe, openTime: candle.openTime, now: candle.closeTime }));
        }
        lastEvaluated.set(cursorKey(symbol, timeframe, direction), candle.openTime);
        results.set(direction, result);
      }
    }

    // Setiap arah yang dievaluasi berakhir di candle terbaru; alert hanya dari hasil candle itu.
    for (const direction of seriesDirections) {
      const result = results.get(direction);
      if (!result?.alert) continue;
      logger?.info?.({ symbol, timeframe, direction, state: result.next.state, reason: result.event?.reason }, 'alert sinyal');
      onAlert?.({ symbol, timeframe, direction, state: result.next.state, event: result.event, view: result.view });
    }
    const perDirection = {};
    for (const [direction, result] of results) {
      perDirection[direction] = {
        state: result.next.state, classification: result.patterns.classification, event: result.event, alert: result.alert,
        evaluated: pendingByDirection.get(direction).size,
      };
    }
    // Field tingkat atas = arah utama (LONG bila ikut dievaluasi); `evaluated` = jumlah candle yang dievaluasi.
    const direction = seriesDirections.find((d) => results.has(d));
    const primary = results.get(direction);
    return {
      symbol, timeframe, direction, evaluationTime: primary.evaluationTime, state: primary.next.state, evaluated: pending.length,
      classification: primary.patterns.classification, event: primary.event, alert: primary.alert, directions: perDirection,
    };
  }

  /** Menjalankan `task` setelah semua tugas antrean `keys` selesai; tugas berikutnya di antrean itu menunggu `task`. */
  function serialize(keys, task) {
    const prior = Promise.all(keys.map((k) => (queues.get(k) ?? Promise.resolve()).catch(() => {})));
    const run = prior.then(task);
    for (const key of keys) {
      queues.set(key, run);
      run.finally(() => { if (queues.get(key) === run) queues.delete(key); }).catch(() => {});
    }
    return run;
  }

  return {
    /** @param {{ symbol: string, timeframe: string, candles?: object[], reason?: string }} series */
    onClosedCandles(series) {
      return serialize([`${series?.symbol}:${series?.timeframe}`], () => evaluate(series));
    },
    /**
     * Simbol berhenti dipantau (delisted / keluar dari set pantauan): tutup sinyal terbukanya (kedua arah)
     * menjadi EXPIRED dengan `reason` (signals.closeOpenForSymbol), diserialkan dengan evaluasi yang masih
     * berjalan untuk seri yang sama. Tanpa alert. `timeframes` null → semua timeframe.
     * @param {{ symbol: string, timeframes?: string[]|null, reason: string, at: number }} input
     * @returns {Promise<{ closed: Array<{ id: number, timeframe: string, fromState: string, price: number|null }> }>}
     */
    closeSymbol({ symbol, timeframes = null, reason, at } = {}) {
      if (typeof signals.closeOpenForSymbol !== 'function') return Promise.reject(new TypeError('signals.closeOpenForSymbol wajib ada'));
      const list = timeframes ?? TIMEFRAMES;
      return serialize(list.map((tf) => `${symbol}:${tf}`), async () => {
        const result = await signals.closeOpenForSymbol({ symbol, timeframes: list, reason, at });
        if (result.closed.length > 0) {
          logger?.info?.({ symbol, reason, closed: result.closed.map((c) => `${c.timeframe}:${c.fromState}`) }, 'sinyal ditutup: simbol berhenti dipantau');
        }
        return result;
      });
    },
    ensureDefinitions,
    /** Arah yang dievaluasi pipeline ini (urut LONG, SHORT). */
    directions: activeDirections,
  };
}
