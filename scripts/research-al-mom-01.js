// Analisis praregistrasi AL-MOM-01 (docs/28): apakah alert LONG 1h SA/PVA v3 membawa informasi di luar momentum serupa.
// Riset saja: tidak menyentuh database, worker, atau scanner live.
//
// Tiga mode (docs/28 §8–§9):
//   validate  data historis SEBELUM jendela uji (--to ≤ 2026-11-16), hanya dari cache. Laporan lengkap berlabel VALIDASI;
//             bukan hasil uji.
//   count     jumlah observasi dan integritas data, TANPA menghitung hasil A/B. Fungsi hasil tidak pernah dipanggil.
//   evaluate  evaluasi tunggal pada cutoff tetap 2028-11-16. Ditolak bila: sebelum cutoff, --to bukan 2028-11-16, hash
//             pohon ≠ docs/28 §9, pohon kerja kotor, data belum beres, atau log evaluasi sebelumnya sudah ada (kecuali
//             --rerun-reason, yang dicatat di laporan).
//
// Pakai:
//   npm run research:al-mom-01 -- --mode validate --from 2024-10-01 --to 2026-10-01
//   npm run research:al-mom-01 -- --mode count --to 2027-01-01
//   npm run research:al-mom-01 -- --mode evaluate --to 2028-11-16
//
// File ini mandiri: hanya mengimpor backend/ (beku bersama AL-SA-ATR-01) dan modul bawaan Node. Hash pohon AL-MOM-01 =
// semua .js di backend/ + file ini (cara docs/26 §8), jadi mencakup seluruh kode yang menentukan hasil.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_CACHE_DIR, findGaps, loadFromBinance } from '../backend/backtest/dataSource.js';
import { mulberry32 } from '../backend/backtest/eventStudy.js';
import { labelTrade } from '../backend/backtest/labeler.js';
import { BACKTEST_WARMUP, replaySeries } from '../backend/backtest/runner.js';
import { binanceFetch } from '../backend/ingestion/binance/network.js';
import { createBinanceRestClient } from '../backend/ingestion/binance/restClient.js';
import { atr } from '../backend/indicators/index.js';
import { TIMEFRAME_MS } from '../backend/market/contracts.js';
import { AL_SA_ATR_01 } from '../backend/research/alSaAtr01.js';
import { DAY_MS, binOf, forwardMove, posBin, preBin, quantileCuts, quarterOf } from '../backend/research/matchedBaseline.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SELF = 'scripts/research-al-mom-01.js';
const DOC = join(ROOT, 'docs', '28-kunci-inti-al-mom-01.md');
const H = TIMEFRAME_MS['1h'];
export const DEFAULT_LOG_DIR = join(ROOT, 'research-log', 'al-mom-01');
const MANUAL_DELISTING_FILE = join(ROOT, 'research-log', 'al-sa-atr-01', 'delisting-manual.json');
// deliveryDate perpetual tanpa jadwal delisting (2100-12-25 08:00 UTC), sama dengan audit AL-SA-ATR-01.
export const FAR_DELIVERY = 4_133_404_800_000;
const FLAT_TAIL_MIN = 24;
const GRACE_CANDLES = 2;
const Z95 = 1.959964;

// ── Konfigurasi beku (docs/28 §2–§6 dan rincian §9) ──
export const AL_MOM_01 = Object.freeze({
  id: 'AL-MOM-01',
  version: 1,
  direction: 'LONG',
  timeframe: '1h',
  // Jendela (docs/28 §3): openTime di [windowStart, cutoff − settleBars candle); data dimuat sejak windowStart − 30 hari.
  windowStart: Date.UTC(2026, 10, 16),
  cutoff: Date.UTC(2028, 10, 16),
  settleBars: 50,
  warmupDays: 30,
  // Fitur & hasil (sama dengan scripts/research-mom-power.js pada commit 7da88ce).
  look: 12, // gerak awal 12 candle; hasil A = gerak 12 candle
  donchian: 48,
  atrPeriod: 14,
  horizonMax: 48, // kelayakan: gerak 12 & 48 candle tersedia
  design: Object.freeze({ stopAtr: 1.5, targetR: 2, maxBars: 48, feeBps: 5, slippageBps: 2 }),
  // Strata (docs/28 §4): simbol × kuartal × bin gerak awal 0,5 ATR (ujung −4/+6 digabung) × bin posisi 0,2 × tersil ATR%
  // × jarak dari alert v2/v3 LONG sebelumnya (≤ 12, 13–48, > 48/belum ada).
  strata: Object.freeze({ preBinAtr: 0.5, preMinAtr: -4, preMaxAtr: 6, posBins: 5, volBins: 3, near: 12, far: 48 }),
  // Sensitivitas bin gerak awal yang lebih halus (rincian §9; selalu dihitung, ditandai "dipicu" bila |SMD| > 0,10).
  finePreBinAtr: 0.25,
  // Diagnostik overlap (rincian §9): gerak awal ≥ 4 ATR. Bukan hipotesis.
  extremePreAtr: 4,
  margin: 0.25, // docs/28 §6, batas deskriptif
  alpha: 0.05, // CI 95% dua sisi, persentil 2,5% & 97,5%
  blockDays: 7,
  sensitivityBlockDays: Object.freeze([14, 1]),
  reps: 10_000,
  seed: 20_261_116,
  // Presisi Monte Carlo (laporan, bukan penentu): CI utama diulang dengan benih lain, replikasi sama.
  precisionSeeds: Object.freeze([20_261_117, 20_261_118, 20_261_119, 20_261_120, 20_261_121, 20_261_122, 20_261_123, 20_261_124, 20_261_125, 20_261_126]),
  // Replikasi tanpa satu pun alert berpembanding = tidak valid: dikeluarkan dari persentil dan dihitung. Bila > 1%
  // replikasi utama tidak valid, CI dinyatakan tidak stabil dan hasil dibaca sebagai kelompok 4.
  invalidRepMaxShare: 0.01,
  smd: Object.freeze({ threshold: 0.1, large: 0.2 }),
  universe: AL_SA_ATR_01.universe,
});

// 27 koin semesta yang dipakai saat pola dikembangkan dan diperiksa (docs/24–27; sama dengan DOCS27_IN_UNIVERSE di
// scripts/research-mom-sim.js). Hanya untuk profil "kelompok koin" alert tak cocok (docs/28 §7).
export const DEVELOPMENT_COINS = Object.freeze([
  '1000PEPEUSDT', 'ADAUSDT', 'BCHUSDT', 'BNBUSDT', 'BTCUSDT', 'BTWUSDT', 'BULLAUSDT', 'CAPUSDT', 'DODOXUSDT', 'DOGEUSDT',
  'ENAUSDT', 'ERAUSDT', 'ETHUSDT', 'HYPEUSDT', 'INJUSDT', 'JCTUSDT', 'LINKUSDT', 'NEARUSDT', 'PUMPUSDT', 'QNTUSDT',
  'SOLUSDT', 'SUIUSDT', 'TAOUSDT', 'UNIUSDT', 'WLDUSDT', 'XRPUSDT', 'ZECUSDT',
]);
const DEV_SET = new Set(DEVELOPMENT_COINS);

export const LEVELS = Object.freeze(['jarak', 'dasar', 'halus', 'lampau']);
export const LEVEL_LABELS = Object.freeze({
  jarak: 'strata + jarak (utama)',
  dasar: 'strata tanpa jarak',
  halus: 'strata + jarak, bin gerak awal 0,25 ATR',
  lampau: 'pembanding "lampau", strata tanpa jarak',
});
export const DIST_BINS = Object.freeze(['d12', 'd48', 'jauh']);
export const COVARIATES = Object.freeze(['pre', 'pos', 'atr', 'dist']);
const COVARIATE_LABELS = Object.freeze({
  pre: 'Gerak awal 12 candle (ATR)', pos: 'Posisi rentang Donchian 48', atr: 'ATR%', dist: 'Jarak dari alert sebelumnya (candle, maks 49)',
});
// Isi agregat strata: [n, ΣA, ΣB, Σpre, Σpos, Σatr, Σdist, n d12, n d48, n jauh].
const TOT = 10;

const log = (m) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${m}\n`);
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
const iso = (ms) => (ms === null || ms === undefined || !Number.isFinite(ms) ? null : new Date(ms).toISOString());
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const dayIndex = (ms) => Math.floor(ms / DAY_MS);

// ── Fitur dan kelayakan candle (tanpa hasil) ──

/** Kuartal → indeks bilangan (tahun − 2000) × 4 + kuartal − 1. */
export function quarterIndex(ms) {
  const q = quarterOf(ms);
  return (Number(q.slice(0, 4)) - 2000) * 4 + Number(q.slice(-1)) - 1;
}

/**
 * Gerak awal dan posisi rentang, hanya dari candle ≤ i (rumus sama dengan backend/research/signalTiming.js timingAt,
 * tanpa kelas timing yang melihat breakout sesudah i).
 */
export function prePos(candles, atrValues, i, cfg = AL_MOM_01) {
  const a = atrValues[i];
  if (!(a > 0) || i < cfg.donchian + cfg.look || i >= candles.length) return null;
  const pre = (candles[i].close - candles[i - cfg.look].close) / a;
  let hi = -Infinity;
  let lo = Infinity;
  for (let k = i - cfg.donchian + 1; k <= i; k += 1) {
    if (candles[k].high > hi) hi = candles[k].high;
    if (candles[k].low < lo) lo = candles[k].low;
  }
  return { pre, pos: hi > lo ? (candles[i].close - lo) / (hi - lo) : 0.5 };
}

/**
 * Kelayakan candle (docs/28 §3, sama dengan research-mom-power.js): i ∈ [BACKTEST_WARMUP, n − 1 − 48], ATR14 > 0, open
 * candle i+1 > 0, dan stop entri − 1,5 ATR > 0. Dengan i ≤ n − 49, gerak 12/48 candle tersedia dan trade B (maks 48
 * candle) pasti selesai, jadi kelayakan ditentukan TANPA menghitung hasil. Tes UNIT-MOM01-002 memeriksa kesetaraannya.
 */
export function eligibleAt(candles, atrValues, i, cfg = AL_MOM_01) {
  if (i < BACKTEST_WARMUP || i > candles.length - 1 - cfg.horizonMax) return false;
  const a = atrValues[i];
  if (!(a > 0)) return false;
  const entry = candles[i + 1].open;
  return entry > 0 && entry - cfg.design.stopAtr * a > 0;
}

/** Trade LONG geometri identik (sama dengan atrTrade research-mom-power.js): entri open i+1, stop 1,5 ATR, 2R, 48 candle. */
export function atrTrade(candles, atrValues, i, design = AL_MOM_01.design) {
  const entry = candles[i + 1]?.open;
  const a = atrValues[i];
  if (!(entry > 0) || !(a > 0)) return null;
  const stop = entry - design.stopAtr * a;
  if (!(stop > 0)) return null;
  const t = labelTrade({
    candles, entryIndex: i, direction: 'LONG', entryPrice: entry, stopPrice: stop,
    targetR: design.targetR, maxBars: design.maxBars, feeBps: design.feeBps, slippageBps: design.slippageBps,
  });
  return t && t.outcome !== 'OPEN' ? { r: t.rMultiple, exitTime: t.exitTime } : null;
}

/** Hasil A (gerak 12 candle, ATR) dan B (R geometri identik). HANYA dipanggil di mode validate/evaluate. */
export function outcomesAt(candles, atrValues, i, cfg = AL_MOM_01) {
  const fwd12 = forwardMove(candles, atrValues, 'LONG', i, cfg.look);
  const trade = atrTrade(candles, atrValues, i, cfg.design);
  return fwd12 === null || !trade ? null : { A: fwd12, B: trade.r };
}

/** Indeks alert sebelumnya (< i) untuk tiap candle; −1 bila tidak ada. idx terurut naik. */
export function previousAlertIndex(n, idx) {
  const prev = new Int32Array(n).fill(-1);
  let k = 0;
  let last = -1;
  for (let i = 0; i < n; i += 1) {
    while (k < idx.length && idx[k] < i) {
      last = idx[k];
      k += 1;
    }
    prev[i] = last;
  }
  return prev;
}

/** Mask "lampau": candle k dikeluarkan bila ada alert e dengan e ≤ k ≤ e + after (hanya alert yang sudah terjadi). */
export function exclusionAfter(n, idx, after) {
  const mask = new Uint8Array(n);
  for (const e of idx) for (let k = Math.max(0, e); k <= Math.min(n - 1, e + after); k += 1) mask[k] = 1;
  return mask;
}

/** Bin jarak: 0 = ≤ 12 candle, 1 = 13–48, 2 = > 48 atau belum ada alert sebelumnya. */
export function distanceIndex(sincePrev, cfg = AL_MOM_01) {
  if (sincePrev === null || sincePrev === undefined || sincePrev > cfg.strata.far) return 2;
  return sincePrev <= cfg.strata.near ? 0 : 1;
}

/** Jarak untuk kovariat keseimbangan: > 48 atau belum ada → 49 (sama dengan research-mom-power.js). */
export function cappedDistance(sincePrev, cfg = AL_MOM_01) {
  return sincePrev === null || sincePrev === undefined || sincePrev > cfg.strata.far ? cfg.strata.far + 1 : sincePrev;
}

/** Indeks bin gerak awal berbasis 0 (ujung −4/+6 digabung). */
export function preIndex(pre, binAtr, cfg = AL_MOM_01) {
  const { preMinAtr, preMaxAtr } = cfg.strata;
  return preBin(pre, { preBinAtr: binAtr, preMinAtr, preMaxAtr }) - Math.floor(preMinAtr / binAtr);
}

/** Kode strata dasar (bilangan bulat unik): simbol × kuartal × bin gerak × bin posisi × tersil ATR%. */
export function baseCode(sym, qIdx, preIdx, posB, volB) {
  return (((sym * 512 + qIdx) * 64 + preIdx) * 5 + posB) * 3 + volB;
}

/** Kunci strata gaya matchedBaseline.stratumKey dari bagian-bagiannya (untuk laporan dan tes paritas). */
export function stratumLabel({ symbol, quarter, preB, posB, volB, distIdx = null }) {
  return `${symbol}|${quarter}|${preB}|${posB}|${volB}${distIdx === null ? '' : `|${DIST_BINS[distIdx]}`}`;
}

// ── Pengumpulan data ──

/** Wadah agregat untuk seluruh simbol. withOutcomes false = mode count (tidak ada hasil yang disimpan). */
export function createStore({ withOutcomes }) {
  return {
    withOutcomes,
    alerts: [],
    strata: Object.fromEntries(LEVELS.map((l) => [l, new Map()])),
    cells: withOutcomes ? Object.fromEntries(LEVELS.map((l) => [l, { code: [], day: [], n: [], a: [], b: [] }])) : null,
    // Momen kovariat semua pembanding "tanpa" (SMD sebelum pencocokan).
    before: { n: 0, sum: new Float64Array(4), sumsq: new Float64Array(4), dist: new Float64Array(3) },
    controls: { tanpa: 0, lampau: 0 },
    eligible: 0,
    outcomeMismatch: 0,
    months: new Map(), // 'YYYY-MM' → { alerts, symbols:Set }
  };
}

function newStage(withOutcomes) {
  return {
    totals: Object.fromEntries(LEVELS.map((l) => [l, new Map()])),
    cells: withOutcomes ? Object.fromEntries(LEVELS.map((l) => [l, new Map()])) : null,
    alerts: [],
  };
}

function addControl(stage, level, code, day, y, cov) {
  let t = stage.totals[level].get(code);
  if (!t) {
    t = new Float64Array(TOT);
    stage.totals[level].set(code, t);
  }
  t[0] += 1;
  if (y) {
    t[1] += y.A;
    t[2] += y.B;
  }
  t[3] += cov.pre;
  t[4] += cov.pos;
  t[5] += cov.atr;
  t[6] += cov.dist;
  t[7 + cov.distIdx] += 1;
  if (stage.cells) {
    const key = code * 65536 + day;
    let c = stage.cells[level].get(key);
    if (!c) {
      c = new Float64Array(3);
      stage.cells[level].set(key, c);
    }
    c[0] += 1;
    c[1] += y.A;
    c[2] += y.B;
  }
}

/** Simpan agregat strata dan sel HANYA untuk strata yang punya alert (strata per simbol, jadi lengkap per simbol). */
function flushStage(store, stage) {
  for (const level of LEVELS) {
    const need = new Set(stage.alerts.map((a) => a.code[level]));
    for (const [code, t] of stage.totals[level]) if (need.has(code)) store.strata[level].set(code, t);
    if (!stage.cells) continue;
    const dst = store.cells[level];
    for (const [key, c] of stage.cells[level]) {
      const code = Math.floor(key / 65536);
      if (!need.has(code)) continue;
      dst.code.push(code);
      dst.day.push(key - code * 65536);
      dst.n.push(c[0]);
      dst.a.push(c[1]);
      dst.b.push(c[2]);
    }
  }
  for (const a of stage.alerts) store.alerts.push(a);
}

/**
 * Satu deret simbol → alert & pembanding dalam jendela. v3Idx = indeks candle alert v3 LONG; anyIdx = alert v2 ∪ v3
 * LONG (pengecualian pembanding & jarak). window = { from, to } atas openTime. delistingTime = waktu delisting
 * terverifikasi (candle pada/sesudahnya dikeluarkan) atau null. outcomeFn null = mode count.
 * onRecord (opsional, untuk simulasi coverage) menerima setiap candle yang masuk analisis.
 */
export function collectSeries({
  store, sym, symbol, candles, v3Idx, anyIdx, window, delistingTime = null, outcomeFn = null, cfg = AL_MOM_01, onRecord = null,
}) {
  const n = candles.length;
  const out = {
    symbol, candles: n, eligible: 0, alerts: 0, controlsTanpa: 0, controlsLampau: 0, excludedDelisting: 0, spanningDelisting: 0,
  };
  if (store.withOutcomes && typeof outcomeFn !== 'function') throw new TypeError('outcomeFn wajib bila store menyimpan hasil');
  if (!store.withOutcomes && outcomeFn !== null) throw new TypeError('mode count tidak boleh memberi outcomeFn');
  if (n <= BACKTEST_WARMUP + cfg.horizonMax + 1) return out;
  const A = atr(candles, cfg.atrPeriod);
  const any = [...new Set(anyIdx)].sort((x, y) => x - y);
  const anyMark = new Uint8Array(n);
  for (const e of any) if (e >= 0 && e < n) anyMark[e] = 1;
  const v3Mark = new Uint8Array(n);
  for (const e of v3Idx) {
    if (!anyMark[e]) throw new RangeError(`${symbol}: alert v3 ${e} tidak ada di daftar alert v2/v3`);
    v3Mark[e] = 1;
  }
  const lampau = exclusionAfter(n, any, cfg.look);
  const prev = previousAlertIndex(n, any);
  const lo = BACKTEST_WARMUP;
  const hi = n - 1 - cfg.horizonMax;
  const delisted = (c) => delistingTime !== null && c.openTime >= delistingTime;
  const inWindow = (c) => c.openTime >= window.from && c.openTime < window.to;

  // Tersil ATR% per kuartal dari populasi analisis (candle jendela, sebelum delisting, ATR > 0).
  const volByQ = new Map();
  for (let i = lo; i <= hi; i += 1) {
    const c = candles[i];
    if (!inWindow(c) || delisted(c) || !(A[i] > 0)) continue;
    const q = quarterOf(c.openTime);
    if (!volByQ.has(q)) volByQ.set(q, []);
    volByQ.get(q).push(A[i] / c.close);
  }
  const cuts = new Map([...volByQ].map(([q, vals]) => [q, quantileCuts(vals, cfg.strata.volBins)]));

  const stage = newStage(store.withOutcomes);
  for (let i = lo; i <= hi; i += 1) {
    const c = candles[i];
    if (!inWindow(c)) continue;
    if (delisted(c)) {
      out.excludedDelisting += 1;
      continue;
    }
    if (!eligibleAt(candles, A, i, cfg)) continue;
    const pp = prePos(candles, A, i, cfg);
    if (!pp) continue;
    let y = null;
    if (store.withOutcomes) {
      y = outcomeFn(candles, A, i, cfg);
      if (y === null) {
        store.outcomeMismatch += 1;
        continue;
      }
    }
    const quarter = quarterOf(c.openTime);
    const qIdx = quarterIndex(c.openTime);
    const atrPct = A[i] / c.close;
    const volB = binOf(atrPct, cuts.get(quarter));
    const posB = posBin(pp.pos, cfg.strata.posBins);
    const pre05 = preIndex(pp.pre, cfg.strata.preBinAtr, cfg);
    const preFine = preIndex(pp.pre, cfg.finePreBinAtr, cfg);
    const sincePrev = prev[i] >= 0 ? i - prev[i] : null;
    const distIdx = distanceIndex(sincePrev, cfg);
    const cov = { pre: pp.pre, pos: pp.pos, atr: atrPct, dist: cappedDistance(sincePrev, cfg), distIdx };
    const b05 = baseCode(sym, qIdx, pre05, posB, volB);
    const code = { jarak: b05 * 3 + distIdx, dasar: b05, halus: baseCode(sym, qIdx, preFine, posB, volB) * 3 + distIdx, lampau: b05 };
    const day = dayIndex(c.closeTime);
    const isAlert = v3Mark[i] === 1;
    const isTanpa = anyMark[i] === 0;
    const isLampau = lampau[i] === 0;
    out.eligible += 1;
    store.eligible += 1;
    if (delistingTime !== null && candles[i + cfg.horizonMax].openTime >= delistingTime) out.spanningDelisting += 1;
    if (isTanpa) {
      for (const level of ['jarak', 'dasar', 'halus']) addControl(stage, level, code[level], day, y, cov);
      out.controlsTanpa += 1;
      store.controls.tanpa += 1;
      const B = store.before;
      B.n += 1;
      COVARIATES.forEach((k, j) => {
        B.sum[j] += cov[k];
        B.sumsq[j] += cov[k] * cov[k];
      });
      B.dist[distIdx] += 1;
    }
    if (isLampau) {
      addControl(stage, 'lampau', code.lampau, day, y, cov);
      out.controlsLampau += 1;
      store.controls.lampau += 1;
    }
    const month = new Date(c.openTime).toISOString().slice(0, 7);
    if (!store.months.has(month)) store.months.set(month, { alerts: 0, symbols: new Set() });
    store.months.get(month).symbols.add(symbol);
    if (isAlert) {
      out.alerts += 1;
      store.months.get(month).alerts += 1;
      stage.alerts.push({
        symbol, sym, t: c.closeTime, openTime: c.openTime, day, quarter, pre: pp.pre, pos: pp.pos, atr: atrPct,
        dist: cov.dist, distIdx, sincePrev, extreme: pp.pre >= cfg.extremePreAtr, preB: pre05 + Math.floor(cfg.strata.preMinAtr / cfg.strata.preBinAtr),
        posB, volB, code, ...(y ? { y } : {}),
      });
    }
    onRecord?.({ i, sym, symbol, isAlert, isTanpa, isLampau, code, day, atr: A[i], openTime: c.openTime });
  }
  flushStage(store, stage);
  return out;
}

// ── Integritas data dan delisting (docs/26 §11.2, dipakai ulang oleh docs/28 §3) ──

export const isFlatZero = (c) => c.volume === 0 && c.open === c.high && c.high === c.low && c.low === c.close;

/** Ekor candle datar bervolume 0: openTime candle pertamanya dan panjangnya. */
export function flatTail(candles) {
  let i = candles.length;
  while (i > 0 && isFlatZero(candles[i - 1])) i -= 1;
  return i === candles.length ? { start: null, length: 0 } : { start: candles[i].openTime, length: candles.length - i };
}

/**
 * Waktu delisting & verifikasi, aturan sama dengan audit AL-SA-ATR-01 (delistingInfo): exchangeInfo non-TRADING dengan
 * deliveryDate ≠ 2100, atau catatan manual (hanya bila simbol tidak ada di exchangeInfo); terverifikasi bila sejak waktu
 * itu + 2 candle hanya ada candle datar bervolume 0. `unresolved` = delisting belum terverifikasi atau ekor datar
 * ≥ 24 candle tanpa delisting terverifikasi.
 */
export function delistingStatus({ meta, manual = null, candles, intervalMs = H }) {
  let time = null;
  let source = null;
  if (meta && meta.status !== 'TRADING' && Number.isFinite(meta.deliveryDate) && meta.deliveryDate !== FAR_DELIVERY) {
    time = meta.deliveryDate;
    source = 'exchangeInfo';
  } else if (meta === null && manual && Number.isFinite(manual.time)) {
    time = manual.time;
    source = 'manual';
  }
  const tail = flatTail(candles);
  const verified = time !== null && candles.every((c) => c.openTime < time + GRACE_CANDLES * intervalMs || isFlatZero(c));
  const unresolved = (time !== null && !verified) || (!verified && tail.length >= FLAT_TAIL_MIN);
  return { time, source, verified, unresolved, flatTail: tail.length, flatTailStart: tail.start };
}

/**
 * Data berhenti sebelum batas akhir muat (lebih dari 2 candle) tanpa delisting terverifikasi = belum terselesaikan
 * (docs/26 §11.2: BELUM_TERSELESAIKAN bila data berhenti).
 */
export function endsEarly(candles, dataTo, delisting = null, intervalMs = H) {
  if (!candles.length) return true;
  if (delisting?.verified) return false;
  return dataTo - (candles.at(-1).closeTime + 1) > GRACE_CANDLES * intervalMs;
}

/** Ringkasan integritas deret (tanpa hasil): celah, candle bervolume 0, ekor datar. */
export function seriesIntegrity(candles, intervalMs = H) {
  const gaps = findGaps(candles, intervalMs);
  return {
    candles: candles.length, first: candles[0]?.openTime ?? null, last: candles.at(-1)?.openTime ?? null, gaps: gaps.length,
    missingCandles: gaps.reduce((s, g) => s + g.missing, 0), flatZero: candles.filter(isFlatZero).length,
  };
}

// ── Indeks bootstrap ──

/**
 * Indeks satu level untuk bootstrap: strata yang punya alert berpembanding (id rapat), total pembanding penuh per strata,
 * dan sel pembanding (strata × hari) terurut hari dalam [dayFrom, dayFrom + D).
 */
export function buildLevelIndex({ store, level, alerts, dayFrom, D }) {
  const sidOf = new Map();
  for (const a of alerts) if (!sidOf.has(a.code[level])) sidOf.set(a.code[level], sidOf.size);
  const m = sidOf.size;
  const N = new Float64Array(m);
  const SA = new Float64Array(m);
  const SB = new Float64Array(m);
  for (const [code, s] of sidOf) {
    const t = store.strata[level].get(code);
    N[s] = t[0];
    SA[s] = t[1];
    SB[s] = t[2];
  }
  const src = store.cells[level];
  const keep = [];
  const counts = new Int32Array(D + 1);
  for (let k = 0; k < src.code.length; k += 1) {
    const s = sidOf.get(src.code[k]);
    if (s === undefined) continue;
    const d = src.day[k] - dayFrom;
    if (d < 0 || d >= D) throw new RangeError(`sel pembanding di luar rentang hari analisis (${src.day[k]})`);
    keep.push(k);
    counts[d + 1] += 1;
  }
  const dayStart = new Int32Array(D + 1);
  for (let d = 0; d < D; d += 1) dayStart[d + 1] = dayStart[d] + counts[d + 1];
  const fill = Int32Array.from(dayStart.subarray(0, D));
  const cSid = new Int32Array(keep.length);
  const cN = new Float64Array(keep.length);
  const cA = new Float64Array(keep.length);
  const cB = new Float64Array(keep.length);
  const check = new Float64Array(m);
  for (const k of keep) {
    const d = src.day[k] - dayFrom;
    const j = fill[d];
    fill[d] += 1;
    const s = sidOf.get(src.code[k]);
    cSid[j] = s;
    cN[j] = src.n[k];
    cA[j] = src.a[k];
    cB[j] = src.b[k];
    check[s] += src.n[k];
  }
  for (let s = 0; s < m; s += 1) {
    if (check[s] !== N[s]) throw new Error(`total pembanding strata ${level} tidak sama dengan jumlah selnya`);
  }
  return { level, m, sidOf, N, SA, SB, dayStart, cSid, cN, cA, cB, cells: keep.length };
}

/**
 * Kelompok alert untuk bootstrap: id strata rapat, hari relatif, hasil, dan mask subkelompok. Dengan `fallbackIndex`,
 * aturan fallback diulang di setiap replikasi: strata level utama bila punya pembanding pada replikasi itu, selain itu
 * strata level fallback; alert tanpa strata utama sama sekali memakai id −1 di level utama.
 */
export function buildGroup({ name, index, alerts, dayFrom, masks = {}, variants = false, diagnostics = false, fallbackIndex = null }) {
  const n = alerts.length;
  const sid = new Int32Array(n);
  const sid2 = fallbackIndex ? new Int32Array(n) : null;
  const day = new Int32Array(n);
  const yA = new Float64Array(n);
  const yB = new Float64Array(n);
  alerts.forEach((a, k) => {
    const s = index.sidOf.get(a.code[index.level]);
    if (s === undefined && !fallbackIndex) throw new RangeError(`alert ${a.symbol ?? ''} ${a.day} tidak punya strata di level ${index.level}`);
    sid[k] = s ?? -1;
    if (fallbackIndex) {
      const s2 = fallbackIndex.sidOf.get(a.code[fallbackIndex.level]);
      if (s2 === undefined) throw new RangeError(`alert ${a.symbol ?? ''} ${a.day} tidak punya strata fallback di level ${fallbackIndex.level}`);
      sid2[k] = s2;
    }
    day[k] = a.day - dayFrom;
    yA[k] = a.y.A;
    yB[k] = a.y.B;
  });
  if ((variants || diagnostics) && (fallbackIndex || sid.some((x) => x < 0))) throw new TypeError('varian & diagnostik hanya untuk kelompok satu level');
  const maskArrays = Object.fromEntries(Object.entries(masks).map(([k, f]) => [k, Uint8Array.from(alerts, (a) => (f(a) ? 1 : 0))]));
  const extreme = Uint8Array.from(alerts, (a) => (a.extreme ? 1 : 0));
  return {
    name, level: index.level, n, sid, day, yA, yB, masks: maskArrays, extreme, variants, diagnostics,
    fallback: fallbackIndex ? { level: fallbackIndex.level, sid: sid2 } : null,
  };
}

/**
 * Moving-block bootstrap atas hari kalender yang MENGULANG prosedur estimasi (docs/28 §5). Setiap replikasi: ⌈D/L⌉ blok
 * `blockDays` hari diambil dengan pengembalian (awal blok seragam di [0, D − L]); blok terakhir dipotong supaya deret
 * hasil resampling tepat D hari (MBB baku: n pengamatan pertama dari blok yang disambung); bobot hari dipakai untuk alert DAN
 * sel pembanding; rata-rata pembanding per strata dihitung ulang; alert yang strata-nya tidak punya pembanding pada
 * replikasi itu tidak ikut. Untuk kelompok dengan `variants`, pada bobot yang sama dihitung juga:
 *   populasi tetap — semua alert berbobot ikut; rata-rata pembanding replikasi bila ada, selain itu rata-rata penuh;
 *   himpunan sama  — alert yang ikut di prosedur penuh, rata-rata pembanding penuh (tetap);
 *   alert saja     — semua alert berbobot, rata-rata pembanding penuh (metode docs/25–27).
 * Kembalian: jumlah berbobot dan bobot per replikasi, supaya ATT gabungan (fallback) dan selisih subkelompok bisa
 * dihitung per replikasi.
 */
export function runBootstrap({ D, blockDays, reps, seed, indexes, groups }) {
  const L = Math.max(1, Math.min(blockDays, D));
  const nBlocks = Math.ceil(D / L);
  const lastLen = D - (nBlocks - 1) * L;
  const starts = D - L + 1;
  const rnd = mulberry32(seed);
  const w = new Float64Array(D);
  const lv = {};
  for (const g of groups) {
    for (const level of [g.level, g.fallback?.level].filter(Boolean)) {
      if (lv[level]) continue;
      const idx = indexes[level];
      lv[level] = { idx, N: new Float64Array(idx.m), SA: new Float64Array(idx.m), SB: new Float64Array(idx.m) };
    }
  }
  const arr = () => new Float64Array(reps);
  const res = groups.map((g) => {
    const r = { name: g.name, full: { a: arr(), b: arr(), w: arr() }, masks: {} };
    for (const k of Object.keys(g.masks)) r.masks[k] = { a: arr(), b: arr(), w: arr() };
    if (g.variants) {
      r.fixedPop = { a: arr(), b: arr(), w: arr() };
      r.sameSet = { a: arr(), b: arr(), w: arr() };
      r.alertsOnly = { a: arr(), b: arr(), w: arr() };
    }
    if (g.diagnostics) {
      r.diag = { kept: arr(), drawn: arr(), keptWeight: arr(), drawnWeight: arr(), activeStrata: arr(), extremeKept: arr(), extremeDrawn: arr() };
      r.stamp = new Int32Array(lv[g.level].idx.m);
    }
    return r;
  });
  for (let rep = 0; rep < reps; rep += 1) {
    w.fill(0);
    for (let b = 0; b < nBlocks; b += 1) {
      const st = Math.floor(rnd() * starts);
      const len = b === nBlocks - 1 ? lastLen : L;
      for (let d = st; d < st + len; d += 1) w[d] += 1;
    }
    for (const key of Object.keys(lv)) {
      const { idx, N, SA, SB } = lv[key];
      N.fill(0);
      SA.fill(0);
      SB.fill(0);
      for (let d = 0; d < D; d += 1) {
        const wd = w[d];
        if (wd === 0) continue;
        for (let j = idx.dayStart[d]; j < idx.dayStart[d + 1]; j += 1) {
          const s = idx.cSid[j];
          N[s] += wd * idx.cN[j];
          SA[s] += wd * idx.cA[j];
          SB[s] += wd * idx.cB[j];
        }
      }
    }
    groups.forEach((g, gi) => {
      const { idx, N, SA, SB } = lv[g.level];
      const fbl = g.fallback ? lv[g.fallback.level] : null;
      const r = res[gi];
      const maskKeys = Object.keys(g.masks);
      let fa = 0;
      let fb = 0;
      let fw = 0;
      let pa = 0;
      let pb = 0;
      let pw = 0;
      let sa = 0;
      let sb = 0;
      let oa = 0;
      let ob = 0;
      let ow = 0;
      let kept = 0;
      let drawn = 0;
      let active = 0;
      let exK = 0;
      let exD = 0;
      const ma = new Float64Array(maskKeys.length);
      const mb = new Float64Array(maskKeys.length);
      const mw = new Float64Array(maskKeys.length);
      for (let k = 0; k < g.n; k += 1) {
        const wa = w[g.day[k]];
        if (wa === 0) continue;
        const s = g.sid[k];
        const fullA = g.variants ? g.yA[k] - idx.SA[s] / idx.N[s] : 0;
        const fullB = g.variants ? g.yB[k] - idx.SB[s] / idx.N[s] : 0;
        drawn += 1;
        if (g.extreme[k]) exD += wa;
        if (g.variants) {
          oa += wa * fullA;
          ob += wa * fullB;
          ow += wa;
        }
        let dA = 0;
        let dB = 0;
        let ok = false;
        if (s >= 0 && N[s] > 0) {
          dA = g.yA[k] - SA[s] / N[s];
          dB = g.yB[k] - SB[s] / N[s];
          ok = true;
        } else if (fbl) {
          const s2 = g.fallback.sid[k];
          if (fbl.N[s2] > 0) {
            dA = g.yA[k] - fbl.SA[s2] / fbl.N[s2];
            dB = g.yB[k] - fbl.SB[s2] / fbl.N[s2];
            ok = true;
          }
        }
        if (ok) {
          fa += wa * dA;
          fb += wa * dB;
          fw += wa;
          kept += 1;
          if (g.extreme[k]) exK += wa;
          if (g.variants) {
            sa += wa * fullA;
            sb += wa * fullB;
            pa += wa * dA;
            pb += wa * dB;
          }
          if (g.diagnostics && r.stamp[s] !== rep + 1) {
            r.stamp[s] = rep + 1;
            active += 1;
          }
          for (let m = 0; m < maskKeys.length; m += 1) {
            if (!g.masks[maskKeys[m]][k]) continue;
            ma[m] += wa * dA;
            mb[m] += wa * dB;
            mw[m] += wa;
          }
        } else if (g.variants) {
          pa += wa * fullA;
          pb += wa * fullB;
        }
      }
      if (g.variants) pw = ow;
      r.full.a[rep] = fa;
      r.full.b[rep] = fb;
      r.full.w[rep] = fw;
      maskKeys.forEach((key, m) => {
        r.masks[key].a[rep] = ma[m];
        r.masks[key].b[rep] = mb[m];
        r.masks[key].w[rep] = mw[m];
      });
      if (g.variants) {
        r.fixedPop.a[rep] = pa;
        r.fixedPop.b[rep] = pb;
        r.fixedPop.w[rep] = pw;
        r.sameSet.a[rep] = sa;
        r.sameSet.b[rep] = sb;
        r.sameSet.w[rep] = fw;
        r.alertsOnly.a[rep] = oa;
        r.alertsOnly.b[rep] = ob;
        r.alertsOnly.w[rep] = ow;
      }
      if (g.diagnostics) {
        const dg = r.diag;
        dg.kept[rep] = kept;
        dg.drawn[rep] = drawn;
        dg.keptWeight[rep] = fw;
        dg.drawnWeight[rep] = g.variants ? ow : fw;
        dg.activeStrata[rep] = active;
        dg.extremeKept[rep] = exK;
        dg.extremeDrawn[rep] = exD;
      }
    });
  }
  return { blockDays: L, nBlocks, lastLen, D, reps, seed, groups: res };
}

// ── Ringkasan statistik ──

const sortedFinite = (values) => Float64Array.from(values.filter((x) => Number.isFinite(x))).sort();
/** Persentil yang sama dengan matchedBaseline: nilai terurut ke-floor(p · m). */
const pctOfSorted = (s, p) => (s.length ? s[Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)))] : null);
const sdOf = (vals) => {
  if (vals.length < 2) return null;
  const m = vals.reduce((x, y) => x + y, 0) / vals.length;
  return Math.sqrt(vals.reduce((s, x) => s + (x - m) ** 2, 0) / (vals.length - 1));
};

/** Rasio per replikasi (jumlah/bobot); bobot 0 → NaN (replikasi tidak valid). */
export function ratioSeries(sum, weight) {
  const out = new Float64Array(sum.length);
  for (let k = 0; k < sum.length; k += 1) out[k] = weight[k] > 0 ? sum[k] / weight[k] : NaN;
  return out;
}

/**
 * CI persentil (2,5% & 97,5%) dari replikasi valid, SE = SD replikasi, SE dari lebar CI (cara docs/25–27), jumlah
 * replikasi tidak valid, dan status stabil (tidak valid ≤ invalidRepMaxShare).
 */
export function summarizeReplicates(values, point, { alpha = AL_MOM_01.alpha, maxInvalidShare = AL_MOM_01.invalidRepMaxShare } = {}) {
  const all = Array.from(values);
  const s = sortedFinite(all);
  const invalid = all.length - s.length;
  const lo = pctOfSorted(s, alpha / 2);
  const hi = pctOfSorted(s, 1 - alpha / 2);
  return {
    point: Number.isFinite(point) ? point : null, lo, hi,
    se: sdOf(Array.from(s)), seCi: lo === null ? null : (hi - lo) / (2 * Z95),
    reps: all.length, valid: s.length, invalid, invalidShare: all.length ? invalid / all.length : null,
    stable: all.length > 0 && invalid / all.length <= maxInvalidShare,
  };
}

/** Φ(x) (Abramowitz & Stegun 7.1.26; galat < 1,5e-7). */
export function normalCdf(x) {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** Φ⁻¹(p) (algoritme Acklam; galat relatif < 1,2e-9). */
export function normalQuantile(p) {
  if (!(p > 0 && p < 1)) return p === 0 ? -Infinity : p === 1 ? Infinity : NaN;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo || p > 1 - lo) {
    const q = Math.sqrt(-2 * Math.log(p < lo ? p : 1 - p));
    const v = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    return p < lo ? v : -v;
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * Pembanding metode CI (LAPORAN SAJA; keputusan tetap memakai persentil, docs/28 §5): pergeseran median bootstrap
 * terhadap titik (dalam SE), CI basic [2θ̂ − q97,5; 2θ̂ − q2,5], dan CI persentil bias-corrected (BC, z0 = Φ⁻¹ porsi
 * replikasi < θ̂, seri dihitung setengah). Kelompok docs/28 §6 dihitung untuk tiap metode; "rapuh" bila berbeda.
 */
export function ciMethodComparison(values, point, { alpha = AL_MOM_01.alpha, margin = AL_MOM_01.margin, stable = true } = {}) {
  const s = sortedFinite(Array.from(values));
  if (!s.length || !Number.isFinite(point)) return null;
  const q = (p) => pctOfSorted(s, p);
  const se = sdOf(Array.from(s));
  let below = 0;
  for (const x of s) below += x < point ? 1 : x === point ? 0.5 : 0;
  const z0 = normalQuantile(Math.min(1 - 1 / (2 * s.length), Math.max(1 / (2 * s.length), below / s.length)));
  const za = normalQuantile(1 - alpha / 2);
  const percentile = { lo: q(alpha / 2), hi: q(1 - alpha / 2) };
  const basic = { lo: 2 * point - q(1 - alpha / 2), hi: 2 * point - q(alpha / 2) };
  const bc = { lo: q(normalCdf(2 * z0 - za)), hi: q(normalCdf(2 * z0 + za)) };
  const group = (c) => verdictGroup({ ...c, stable }, margin).group;
  const groups = { percentile: group(percentile), basic: group(basic), bc: group(bc) };
  return {
    median: q(0.5), shiftSe: se > 0 ? (q(0.5) - point) / se : null, z0,
    upperSe: se > 0 ? (percentile.hi - point) / se : null, lowerSe: se > 0 ? (point - percentile.lo) / se : null,
    percentile, basic, bc, groups, fragile: new Set(Object.values(groups)).size > 1,
  };
}

const quantiles = (values, ps = [0, 0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99, 1]) => {
  const s = sortedFinite(Array.from(values));
  return Object.fromEntries(ps.map((p) => [String(p), s.length ? s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))] : null]));
};

function pearson(x, y) {
  const n = x.length;
  if (n < 3) return null;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let k = 0; k < n; k += 1) {
    sxy += (x[k] - mx) * (y[k] - my);
    sxx += (x[k] - mx) ** 2;
    syy += (y[k] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

function ranks(x) {
  const order = x.map((v, k) => [v, k]).sort((a, b) => a[0] - b[0]);
  const r = new Array(x.length);
  for (let k = 0; k < order.length;) {
    let j = k;
    while (j + 1 < order.length && order[j + 1][0] === order[k][0]) j += 1;
    for (let t = k; t <= j; t += 1) r[order[t][1]] = (k + j) / 2;
    k = j + 1;
  }
  return r;
}

/** Diagnostik per replikasi (docs/28 §5, rincian §9): distribusi dan hubungan porsi alert hilang ↔ ATT. */
export function replicateDiagnostics(boot, groupName = 'main') {
  const g = boot.groups.find((x) => x.name === groupName);
  if (!g?.diag) return null;
  const dg = g.diag;
  const att = ratioSeries(g.full.a, g.full.w);
  const lost = Float64Array.from(dg.keptWeight, (kw, k) => (dg.drawnWeight[k] > 0 ? 1 - kw / dg.drawnWeight[k] : NaN));
  const extremeShare = Float64Array.from(dg.extremeKept, (ek, k) => (dg.extremeDrawn[k] > 0 ? ek / dg.extremeDrawn[k] : NaN));
  const ok = [];
  for (let k = 0; k < att.length; k += 1) if (Number.isFinite(att[k]) && Number.isFinite(lost[k])) ok.push(k);
  const xs = ok.map((k) => lost[k]);
  const ys = ok.map((k) => att[k]);
  const cut = pctOfSorted(Float64Array.from(xs).sort(), 0.9);
  const top = ok.filter((k) => lost[k] >= cut).map((k) => att[k]);
  const rest = ok.filter((k) => lost[k] < cut).map((k) => att[k]);
  return {
    keptAlerts: quantiles(dg.kept), drawnAlerts: quantiles(dg.drawn), lostShare: quantiles(lost), activeStrata: quantiles(dg.activeStrata),
    extremeKeptShare: quantiles(extremeShare), attA: quantiles(att),
    lostVsAtt: {
      pearson: pearson(xs, ys), spearman: pearson(ranks(xs), ranks(ys)),
      topDecileCut: cut, meanAttTopDecile: mean(top), meanAttRest: mean(rest), nTop: top.length, nRest: rest.length,
    },
  };
}

/** Dekomposisi varians: alert saja vs populasi tetap (kovariasi) dan populasi tetap vs penuh (komposisi overlap). */
export function varianceDecomposition(boot, groupName = 'main', outcome = 'a') {
  const g = boot.groups.find((x) => x.name === groupName);
  if (!g?.fixedPop) return null;
  const ao = ratioSeries(g.alertsOnly[outcome], g.alertsOnly.w);
  const fp = ratioSeries(g.fixedPop[outcome], g.fixedPop.w);
  const fu = ratioSeries(g.full[outcome], g.full.w);
  const ss = ratioSeries(g.sameSet[outcome], g.sameSet.w);
  const ok = [];
  for (let k = 0; k < ao.length; k += 1) if ([ao, fp, fu, ss].every((x) => Number.isFinite(x[k]))) ok.push(k);
  const v = (x) => {
    const vals = ok.map((k) => x[k]);
    const s = sdOf(vals);
    return s === null ? null : s * s;
  };
  // Δc = rata-rata pembanding replikasi − rata-rata pembanding penuh (bobot alert sama): fp = ao − Δc.
  const dc = ok.map((k) => ao[k] - fp[k]);
  const aov = ok.map((k) => ao[k]);
  const mdc = mean(dc);
  const mao = mean(aov);
  const cov = dc.length > 1 ? dc.reduce((s, x, j) => s + (x - mdc) * (aov[j] - mao), 0) / (dc.length - 1) : null;
  const vdc = sdOf(dc);
  return {
    reps: ok.length, varAlertsOnly: v(ao), varFixedPop: v(fp), varFull: v(fu), varSameSet: v(ss),
    varControlShift: vdc === null ? null : vdc * vdc, covAlertsControlShift: cov,
  };
}

// ── SMD ──

/**
 * Selisih rata-rata terstandar (rincian docs/28 §9).
 *   Kontinu: (rata-rata alert − rata-rata pembanding) / SD alert SEBELUM pencocokan (seluruh alert jendela, n − 1),
 *   penyebut yang sama untuk sebelum dan sesudah pencocokan (Stuart 2010; Austin 2009 untuk ATT).
 *   Sesudah pencocokan: alert = alert berpembanding pada level itu (bobot 1); pembanding = rata-rata atas alert dari
 *   rata-rata pembanding strata-nya, setara bobot pembanding (alert di strata ÷ pembanding di strata).
 *   Kategori (bin jarak): indikator per kategori, SD alert = √(p(1 − p)) sebelum pencocokan.
 *   Varians nol: SD alert 0 → SD gabungan √((s_alert² + s_pembanding²)/2); bila itu juga 0 → SMD 0 bila selisih 0,
 *   selain itu null dengan status "tak terdefinisi".
 */
export function smdValue(diff, sdAlert, sdControl) {
  if (!Number.isFinite(diff)) return { smd: null, status: 'tak terdefinisi', denominator: null };
  let den = sdAlert;
  let basis = 'sd alert';
  if (!(den > 0)) {
    den = Math.sqrt(((sdAlert ?? 0) ** 2 + (sdControl ?? 0) ** 2) / 2);
    basis = 'sd gabungan';
  }
  if (!(den > 0)) return diff === 0 ? { smd: 0, status: 'seimbang', denominator: 0, basis: 'varians nol' } : { smd: null, status: 'tak terdefinisi', denominator: 0, basis: 'varians nol' };
  const smd = diff / den;
  return { smd, status: smdStatus(smd), denominator: den, basis };
}

export function smdStatus(smd, cfg = AL_MOM_01) {
  if (smd === null || !Number.isFinite(smd)) return 'tak terdefinisi';
  const a = Math.abs(smd);
  if (a > cfg.smd.large) return 'tidak seimbang besar';
  if (a > cfg.smd.threshold) return 'tidak seimbang';
  return 'seimbang';
}

function momentsOf(values) {
  const n = values.length;
  const m = n ? values.reduce((a, b) => a + b, 0) / n : null;
  return { n, mean: m, sd: n > 1 ? Math.sqrt(values.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)) : null };
}

/** Tabel SMD: sebelum pencocokan (alert vs semua pembanding "tanpa") dan sesudah pencocokan per level. */
export function balanceTable({ store, matchedBy }) {
  const all = store.alerts;
  const B = store.before;
  const rows = {};
  COVARIATES.forEach((cov, j) => {
    const ma = momentsOf(all.map((a) => a[cov]));
    const mc = B.n ? B.sum[j] / B.n : null;
    const vc = B.n > 1 ? (B.sumsq[j] - B.n * mc * mc) / (B.n - 1) : null;
    const sdc = vc === null ? null : Math.sqrt(Math.max(0, vc));
    const before = { alert: ma.mean, control: mc, ...smdValue(ma.mean === null || mc === null ? NaN : ma.mean - mc, ma.sd, sdc) };
    const after = {};
    for (const [level, list] of Object.entries(matchedBy)) {
      if (!list.length) {
        after[level] = { alert: null, control: null, smd: null, status: 'tak terdefinisi' };
        continue;
      }
      const xa = mean(list.map((a) => a[cov]));
      const xc = mean(list.map((a) => {
        const t = store.strata[level].get(a.code[level]);
        return t[3 + j] / t[0];
      }));
      after[level] = { alert: xa, control: xc, ...smdValue(xa - xc, ma.sd, sdc) };
    }
    rows[cov] = { before, after, sdAlert: ma.sd, sdControl: sdc };
  });
  const dist = {};
  DIST_BINS.forEach((bin, k) => {
    const pa = all.length ? all.filter((a) => a.distIdx === k).length / all.length : null;
    const pc = B.n ? B.dist[k] / B.n : null;
    const sda = pa === null ? null : Math.sqrt(pa * (1 - pa));
    const sdc = pc === null ? null : Math.sqrt(pc * (1 - pc));
    const after = {};
    for (const [level, list] of Object.entries(matchedBy)) {
      if (!list.length) {
        after[level] = { alert: null, control: null, smd: null, status: 'tak terdefinisi' };
        continue;
      }
      const xa = list.filter((a) => a.distIdx === k).length / list.length;
      const xc = mean(list.map((a) => {
        const t = store.strata[level].get(a.code[level]);
        return t[7 + k] / t[0];
      }));
      after[level] = { alert: xa, control: xc, ...smdValue(xa - xc, sda, sdc) };
    }
    dist[bin] = { before: { alert: pa, control: pc, ...smdValue(pa === null || pc === null ? NaN : pa - pc, sda, sdc) }, after };
  });
  const primary = [...COVARIATES.map((c) => rows[c].after.jarak), ...DIST_BINS.map((b) => dist[b].after.jarak)];
  const worst = Math.max(0, ...primary.map((x) => (x?.smd === null || x?.smd === undefined ? 0 : Math.abs(x.smd))));
  const undefinedCount = primary.filter((x) => x?.status === 'tak terdefinisi').length;
  return { continuous: rows, distance: dist, worstPrimary: worst, triggered: worst > AL_MOM_01.smd.threshold || undefinedCount > 0, undefinedCount };
}

// ── Keputusan (docs/28 §6) ──

export function verdictGroup({ lo, hi, stable = true }, margin = AL_MOM_01.margin) {
  if (!stable || lo === null || hi === null || !Number.isFinite(lo) || !Number.isFinite(hi)) {
    return { group: 4, reason: 'CI tidak stabil atau tidak terestimasi; dibaca sebagai tidak konklusif' };
  }
  if (lo > 0 && hi < margin) return { group: 1, reason: 'lo > 0 dan hi < M' };
  if (lo > 0) return { group: 2, reason: 'lo > 0 dan hi ≥ M' };
  if (hi < margin) return { group: 3, reason: 'lo ≤ 0 dan hi < M' };
  return { group: 4, reason: 'lo ≤ 0 dan hi ≥ M' };
}

export const GROUP_TEXT = Object.freeze({
  1: { reading: 'Lebih informatif daripada momentum; keunggulannya < 0,25 ATR', product: 'Pola dipertahankan; klaim keunggulan prediktif terbatas sesuai CI' },
  2: { reading: 'Lebih informatif daripada momentum', product: 'Pola dipertahankan; besar keunggulan belum dibatasi' },
  3: { reading: 'Keunggulan, kalau ada, < 0,25 ATR', product: 'Dipertahankan sebagai klasifikasi momentum, tanpa klaim nilai tambah' },
  4: { reading: 'Tidak konklusif', product: 'Status riset; klaim tidak berubah' },
});

// ── Rezim BTC (docs/26 §10.3, dilaporkan saja) ──

/** Per openTime candle BTC: tren 30 hari (close > close 720 candle sebelumnya) dan volatilitas realisasi 30 hari. */
export function btcRegimeSeries(candles, lookback = 720) {
  const out = new Map();
  const r = candles.map((c, i) => (i > 0 && candles[i - 1].close > 0 && c.close > 0 ? Math.log(c.close / candles[i - 1].close) : 0));
  let s = 0;
  let s2 = 0;
  for (let i = 0; i < candles.length; i += 1) {
    s += r[i];
    s2 += r[i] * r[i];
    if (i >= lookback) {
      s -= r[i - lookback];
      s2 -= r[i - lookback] * r[i - lookback];
    }
    if (i < lookback) {
      out.set(candles[i].openTime, { up: null, vol: null });
      continue;
    }
    const m = s / lookback;
    out.set(candles[i].openTime, { up: candles[i].close > candles[i - lookback].close, vol: Math.sqrt(Math.max(0, s2 / lookback - m * m)) });
  }
  return out;
}

/** Label rezim untuk alert; tersil volatilitas dihitung atas seluruh jam jendela. */
export function labelRegimes(alerts, regime, window) {
  if (!regime) return { labelled: 0, cuts: null };
  const vols = [];
  for (const [t, v] of regime) if (t >= window.from && t < window.to && v.vol !== null) vols.push(v.vol);
  const cuts = quantileCuts(vols, 3);
  let labelled = 0;
  for (const a of alerts) {
    const v = regime.get(a.openTime);
    a.btcUp = v?.up ?? null;
    a.btcVol = v?.vol === null || v?.vol === undefined ? null : binOf(v.vol, cuts);
    if (a.btcUp !== null) labelled += 1;
  }
  return { labelled, cuts };
}

// ── Analisis ──

const attOf = (list, level, store, key) => mean(list.map((a) => {
  const t = store.strata[level].get(a.code[level]);
  return a.y[key] - t[key === 'A' ? 1 : 2] / t[0];
}));

function profileOf(list) {
  const share = (f) => {
    const m = new Map();
    for (const a of list) m.set(f(a), (m.get(f(a)) ?? 0) + 1);
    return Object.fromEntries([...m].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([k, v]) => [k, v / list.length]));
  };
  const pres = Float64Array.from(list.map((a) => a.pre)).sort();
  return {
    n: list.length,
    pre: share((a) => (a.pre < 0 ? 'a: < 0' : a.pre < 2 ? 'b: 0–2' : a.pre < 4 ? 'c: 2–4' : a.pre < 6 ? 'd: 4–6' : 'e: ≥ 6')),
    preQuantiles: { p10: pctOfSorted(pres, 0.1), p50: pctOfSorted(pres, 0.5), p90: pctOfSorted(pres, 0.9) },
    distance: share((a) => DIST_BINS[a.distIdx]),
    group: share((a) => (DEV_SET.has(a.symbol) ? 'koin docs/24–27' : 'koin lain')),
    pos: share((a) => (a.pos < 0.6 ? 'a: < 0,6' : a.pos < 0.8 ? 'b: 0,6–0,8' : 'c: ≥ 0,8')),
    year: share((a) => new Date(a.openTime).toISOString().slice(0, 4)),
    atrMedian: list.length ? Float64Array.from(list.map((a) => a.atr)).sort()[Math.floor(list.length / 2)] : null,
  };
}

const notEstimable = (reason) => ({ estimable: false, reason });

/** CI satu set replikasi (jumlah & bobot) + titik. */
function ciFrom(sumA, sumB, weight, pointA, pointB) {
  return { A: summarizeReplicates(ratioSeries(sumA, weight), pointA), B: summarizeReplicates(ratioSeries(sumB, weight), pointB) };
}

/** CI selisih dua subkelompok per replikasi (keduanya harus valid). */
function diffCi(x, y, pointX, pointY, key) {
  const ax = ratioSeries(x[key], x.w);
  const ay = ratioSeries(y[key], y.w);
  return summarizeReplicates(Float64Array.from(ax, (v, k) => v - ay[k]), pointX === null || pointY === null ? NaN : pointX - pointY);
}

/**
 * Seluruh analisis dari wadah `store` (withOutcomes). dayFrom/dayTo = rentang hari kalender jendela [dayFrom, dayTo).
 * Kembalian: objek laporan (tanpa I/O).
 */
export function analyzeStore({
  store, cfg = AL_MOM_01, dayFrom, dayTo, reps = cfg.reps, seed = cfg.seed, precisionSeeds = cfg.precisionSeeds,
  sensitivityBlocks = cfg.sensitivityBlockDays, withVerdict = false,
}) {
  if (!store.withOutcomes) throw new TypeError('analyzeStore butuh store dengan hasil (mode validate/evaluate)');
  const D = dayTo - dayFrom;
  const alerts = store.alerts;
  const has = (level) => (a) => (store.strata[level].get(a.code[level])?.[0] ?? 0) > 0;
  const matchedBy = Object.fromEntries(LEVELS.map((l) => [l, alerts.filter(has(l))]));
  const main = matchedBy.jarak;
  const unmatched = alerts.filter((a) => !has('jarak')(a));
  const rest = unmatched.filter(has('dasar'));
  const indexes = Object.fromEntries(LEVELS.map((l) => [l, buildLevelIndex({ store, level: l, alerts: matchedBy[l], dayFrom, D })]));
  const point = (list, level) => ({ A: list.length ? attOf(list, level, store, 'A') : null, B: list.length ? attOf(list, level, store, 'B') : null });
  const masks = {
    fresh: (a) => a.distIdx === 2, repeat: (a) => a.distIdx !== 2, extreme: (a) => a.extreme, nonExtreme: (a) => !a.extreme,
    btcUp: (a) => a.btcUp === true, btcDown: (a) => a.btcUp === false,
    btcVol0: (a) => a.btcVol === 0, btcVol1: (a) => a.btcVol === 1, btcVol2: (a) => a.btcVol === 2,
  };
  const groupsMain = [];
  if (main.length) groupsMain.push(buildGroup({ name: 'main', index: indexes.jarak, alerts: main, dayFrom, masks, variants: true, diagnostics: true }));
  for (const level of ['dasar', 'halus', 'lampau']) {
    if (matchedBy[level].length) groupsMain.push(buildGroup({ name: level, index: indexes[level], alerts: matchedBy[level], dayFrom }));
  }
  if (rest.length) groupsMain.push(buildGroup({ name: 'rest', index: indexes.dasar, alerts: rest, dayFrom, masks: { extreme: masks.extreme } }));
  if (main.length || rest.length) {
    groupsMain.push(buildGroup({ name: 'fallback', index: indexes.jarak, alerts: [...main, ...rest], dayFrom, fallbackIndex: indexes.dasar }));
  }
  const boot = groupsMain.length ? runBootstrap({ D, blockDays: cfg.blockDays, reps, seed, indexes, groups: groupsMain }) : null;
  const G = (name) => boot?.groups.find((g) => g.name === name) ?? null;

  const pMain = point(main, 'jarak');
  const primary = main.length ? ciFrom(G('main').full.a, G('main').full.b, G('main').full.w, pMain.A, pMain.B) : null;
  const ciMethods = primary ? ciMethodComparison(ratioSeries(G('main').full.a, G('main').full.w), pMain.A, { alpha: cfg.alpha, margin: cfg.margin, stable: primary.A.stable }) : null;

  // Metode bootstrap (pada estimand utama): 7 hari (utama) dan 14 hari/harian; masing-masing penuh, populasi tetap,
  // himpunan sama, alert saja.
  const methods = {};
  if (main.length) {
    const byBlock = { [cfg.blockDays]: boot };
    for (const L of sensitivityBlocks) {
      byBlock[L] = runBootstrap({
        D, blockDays: L, reps, seed, indexes: { jarak: indexes.jarak },
        groups: [buildGroup({ name: 'main', index: indexes.jarak, alerts: main, dayFrom, variants: true })],
      });
    }
    for (const [L, b] of Object.entries(byBlock)) {
      const g = b.groups.find((x) => x.name === 'main');
      methods[L] = Object.fromEntries(['full', 'fixedPop', 'sameSet', 'alertsOnly'].map((v) => [v, ciFrom(g[v].a, g[v].b, g[v].w, pMain.A, pMain.B)]));
    }
  }

  // Presisi Monte Carlo CI utama (benih lain, replikasi sama).
  let precision = null;
  if (main.length && precisionSeeds.length) {
    const los = [];
    const his = [];
    for (const s of precisionSeeds) {
      const b = runBootstrap({ D, blockDays: cfg.blockDays, reps, seed: s, indexes: { jarak: indexes.jarak }, groups: [buildGroup({ name: 'main', index: indexes.jarak, alerts: main, dayFrom })] });
      const g = b.groups[0];
      const sm = summarizeReplicates(ratioSeries(g.full.a, g.full.w), pMain.A);
      los.push(sm.lo);
      his.push(sm.hi);
    }
    const sdLo = sdOf(los);
    const sdHi = sdOf(his);
    precision = {
      seeds: precisionSeeds.length, reps, sdLo, sdHi, loRange: [Math.min(...los), Math.max(...los)], hiRange: [Math.min(...his), Math.max(...his)],
      nearBoundary: primary ? (Math.abs(primary.A.lo) < 3 * sdLo || Math.abs(primary.A.hi - cfg.margin) < 3 * sdHi) : null,
    };
  }

  // Sensitivitas pencocokan (docs/28 §7), masing-masing dengan bootstrap prosedur penuh 7 hari.
  const sensitivity = {};
  for (const level of ['dasar', 'halus', 'lampau']) {
    const list = matchedBy[level];
    sensitivity[level] = list.length
      ? { n: list.length, share: list.length / alerts.length, ...ciFrom(G(level).full.a, G(level).full.b, G(level).full.w, point(list, level).A, point(list, level).B) }
      : { n: 0, ...notEstimable('tidak ada alert berpembanding') };
  }
  // Fallback: strata + jarak bila ada pembanding, selain itu strata dasar.
  const pRest = point(rest, 'dasar');
  if (main.length || rest.length) {
    const f = G('fallback').full;
    const n = main.length + rest.length;
    const pA = ((pMain.A ?? 0) * main.length + (pRest.A ?? 0) * rest.length) / n;
    const pB = ((pMain.B ?? 0) * main.length + (pRest.B ?? 0) * rest.length) / n;
    sensitivity.fallback = { n, share: n / alerts.length, fromBase: rest.length, ...ciFrom(f.a, f.b, f.w, pA, pB) };
  }

  // Subkelompok (dilaporkan; bukan penentu) dengan bootstrap yang sama.
  const subgroups = {};
  if (main.length) {
    const g = G('main');
    for (const key of Object.keys(masks)) {
      const list = main.filter(masks[key]);
      subgroups[key] = list.length ? { n: list.length, ...ciFrom(g.masks[key].a, g.masks[key].b, g.masks[key].w, point(list, 'jarak').A, point(list, 'jarak').B) } : { n: 0, ...notEstimable('tidak ada alert') };
    }
    const pf = point(main.filter(masks.fresh), 'jarak');
    const pr = point(main.filter(masks.repeat), 'jarak');
    const pe = point(main.filter(masks.extreme), 'jarak');
    const pn = point(main.filter(masks.nonExtreme), 'jarak');
    subgroups.interactionFreshRepeat = subgroups.fresh.n && subgroups.repeat.n
      ? { A: diffCi(g.masks.fresh, g.masks.repeat, pf.A, pr.A, 'a'), B: diffCi(g.masks.fresh, g.masks.repeat, pf.B, pr.B, 'b') }
      : notEstimable('salah satu subkelompok kosong');
    subgroups.extremeMinusNonExtreme = subgroups.extreme.n && subgroups.nonExtreme.n
      ? { A: diffCi(g.masks.extreme, g.masks.nonExtreme, pe.A, pn.A, 'a'), B: diffCi(g.masks.extreme, g.masks.nonExtreme, pe.B, pn.B, 'b') }
      : notEstimable('salah satu subkelompok kosong');
  }

  // Overlap & gerak awal ekstrem (diagnostik, rincian §9).
  const ext = alerts.filter((a) => a.extreme);
  const extMatched = main.filter((a) => a.extreme);
  const restExt = rest.filter((a) => a.extreme);
  const overlap = {
    alerts: alerts.length, matched: main.length, unmatched: unmatched.length, matchedShare: alerts.length ? main.length / alerts.length : null,
    profiles: { matched: profileOf(main), unmatched: profileOf(unmatched) },
    extreme: {
      threshold: cfg.extremePreAtr, n: ext.length, matched: extMatched.length, unmatched: ext.length - extMatched.length,
      unmatchedShareOfExtreme: ext.length ? (ext.length - extMatched.length) / ext.length : null,
      coveredShare: ext.length ? extMatched.length / ext.length : null,
      shareOfUnmatched: unmatched.length ? unmatched.filter((a) => a.extreme).length / unmatched.length : null,
      shareOfMatched: main.length ? extMatched.length / main.length : null,
    },
    viaBase: rest.length ? { n: rest.length, ...ciFrom(G('rest').full.a, G('rest').full.b, G('rest').full.w, pRest.A, pRest.B) } : { n: 0, ...notEstimable('tidak ada alert tak cocok yang punya pembanding di strata dasar') },
    viaBaseExtreme: restExt.length
      ? { n: restExt.length, ...ciFrom(G('rest').masks.extreme.a, G('rest').masks.extreme.b, G('rest').masks.extreme.w, point(restExt, 'dasar').A, point(restExt, 'dasar').B) }
      : { n: 0, ...notEstimable('tidak ada alert ekstrem tak cocok yang punya pembanding di strata dasar') },
    unmatchedWithoutAnyControl: unmatched.length - rest.length,
  };

  const balance = balanceTable({ store, matchedBy });
  const diagnostics = boot ? replicateDiagnostics(boot, 'main') : null;
  const decomposition = boot && main.length ? { A: varianceDecomposition(boot, 'main', 'a'), B: varianceDecomposition(boot, 'main', 'b') } : null;
  const months = [...store.months].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([month, v]) => ({
    month, alerts: v.alerts, symbols: v.symbols.size, perSymbol: v.symbols.size ? v.alerts / v.symbols.size : null,
    matched: main.filter((a) => new Date(a.openTime).toISOString().slice(0, 7) === month).length,
  }));
  const report = {
    counts: {
      eligible: store.eligible, alerts: alerts.length, controlsTanpa: store.controls.tanpa, controlsLampau: store.controls.lampau,
      matched: Object.fromEntries(LEVELS.map((l) => [l, matchedBy[l].length])), strata: Object.fromEntries(LEVELS.map((l) => [l, indexes[l].m])),
      cells: Object.fromEntries(LEVELS.map((l) => [l, indexes[l].cells])), outcomeMismatch: store.outcomeMismatch, days: D,
    },
    bootstrap: { blockDays: cfg.blockDays, reps, seed, sensitivityBlocks: [...sensitivityBlocks], alpha: cfg.alpha, invalidRepMaxShare: cfg.invalidRepMaxShare },
    primary, ciMethods, methods, precision, sensitivity, subgroups, overlap, balance, diagnostics, decomposition, months,
  };
  if (withVerdict) {
    report.verdict = primary ? { ...verdictGroup({ lo: primary.A.lo, hi: primary.A.hi, stable: primary.A.stable }, cfg.margin), margin: cfg.margin } : verdictGroup({ lo: null, hi: null });
    report.verdict.text = GROUP_TEXT[report.verdict.group];
  }
  return report;
}

// ── Count (tanpa hasil) ──

/** Ringkasan jumlah observasi dari store mode count: alert, pembanding, alert berpembanding per level, ekstrem, per bulan. */
export function countSummary(store, cfg = AL_MOM_01) {
  const has = (level) => (a) => (store.strata[level].get(a.code[level])?.[0] ?? 0) > 0;
  const main = store.alerts.filter(has('jarak'));
  return {
    eligible: store.eligible, alerts: store.alerts.length, controlsTanpa: store.controls.tanpa, controlsLampau: store.controls.lampau,
    matched: Object.fromEntries(LEVELS.map((l) => [l, store.alerts.filter(has(l)).length])),
    extreme: { threshold: cfg.extremePreAtr, n: store.alerts.filter((a) => a.extreme).length, matched: main.filter((a) => a.extreme).length },
    months: [...store.months].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([month, v]) => ({ month, alerts: v.alerts, symbols: v.symbols.size })),
  };
}

// ── Hash pohon & pengaman mode ──

/** SHA-256 atas baris "path relatif + SHA-256 isi" untuk semua .js di backend/ + file ini, urut menurut path. */
export async function codeTreeHash(root = ROOT) {
  const rels = [];
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith('.js')) rels.push(relative(root, p).split('\\').join('/'));
    }
  }
  await walk(join(root, 'backend'));
  rels.push(SELF);
  rels.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const h = createHash('sha256');
  for (const rel of rels) h.update(`${rel}\n${sha256(await readFile(join(root, rel)))}\n`);
  return { hash: h.digest('hex'), files: rels.length };
}

/** Hash beku AL-MOM-01 di docs/28 §9 (baris "Hash pohon kode AL-MOM-01: `<64 hex>`"). */
export async function frozenTreeHash(docPath = DOC) {
  const text = await readFile(docPath, 'utf8');
  return text.match(/Hash pohon kode AL-MOM-01: `([0-9a-f]{64})`/)?.[1] ?? null;
}

/**
 * Pengaman mode (docs/28 §8). Melempar galat dengan semua alasan penolakan.
 *   validate: --from < --to ≤ awal jendela (2026-11-16), jendela ≥ 90 hari.
 *   count:    awal jendela < --to ≤ sekarang, --to ≤ cutoff.
 *   evaluate: sekarang ≥ cutoff, --to = cutoff, hash pohon = docs/28 §9, pohon kerja bersih, folder log & cache bawaan,
 *             tidak ada log evaluasi sebelumnya (kecuali rerunReason), dan data beres.
 */
export function assertModeAllowed({
  mode, from = null, to, now, cfg = AL_MOM_01, tree = null, frozen = null, gitClean = null, previousEvaluations = [], rerunReason = null,
  integrityProblems = null, defaultDirs = true,
}) {
  const reasons = [];
  if (!['validate', 'count', 'evaluate'].includes(mode)) reasons.push('--mode harus validate, count, atau evaluate');
  if (!Number.isFinite(to)) reasons.push('--to wajib berupa tanggal YYYY-MM-DD');
  if (mode === 'validate') {
    if (!Number.isFinite(from)) reasons.push('--from wajib untuk validate');
    else if (to - from < 90 * DAY_MS) reasons.push('jendela validasi minimal 90 hari');
    if (to > cfg.windowStart) reasons.push(`validate hanya untuk data sebelum jendela uji: --to harus ≤ ${iso(cfg.windowStart).slice(0, 10)}`);
  }
  if (mode === 'count') {
    if (to <= cfg.windowStart) reasons.push('count: --to harus sesudah awal jendela 2026-11-16');
    if (to > now) reasons.push('count: --to harus tanggal yang sudah lewat');
    if (to > cfg.cutoff) reasons.push('count: --to melewati cutoff 2028-11-16');
  }
  if (mode === 'evaluate') {
    if (now < cfg.cutoff) reasons.push(`evaluate ditolak: cutoff ${iso(cfg.cutoff)} belum lewat`);
    if (to !== cfg.cutoff) reasons.push('evaluate ditolak: --to harus 2028-11-16 (cutoff tetap docs/28 §5)');
    if (!frozen) reasons.push('evaluate ditolak: hash beku AL-MOM-01 belum tercatat di docs/28 §9');
    else if (!tree || tree !== frozen) reasons.push(`evaluate ditolak: hash pohon ${tree ?? '(tidak ada)'} ≠ docs/28 §9 ${frozen}`);
    if (gitClean !== true) reasons.push('evaluate ditolak: pohon kerja git tidak bersih (atau status git tidak terbaca)');
    if (defaultDirs !== true) reasons.push('evaluate ditolak: --log-dir dan --cache-dir harus bawaan (research-log/al-mom-01/, data/backtest-cache)');
    if (previousEvaluations.length && !(typeof rerunReason === 'string' && rerunReason.trim().length >= 10)) {
      reasons.push(`evaluate ditolak: log evaluasi sebelumnya ada (${previousEvaluations.join(', ')}); evaluasi ulang hanya dengan --rerun-reason yang dicatat`);
    }
    if (integrityProblems === null) reasons.push('evaluate ditolak: integritas data belum diperiksa');
    else if (integrityProblems.length) reasons.push(`evaluate ditolak: data belum beres (${integrityProblems.slice(0, 5).join('; ')}${integrityProblems.length > 5 ? '; …' : ''})`);
  }
  if (reasons.length) {
    const err = new Error(reasons.join(' | '));
    err.reasons = reasons;
    throw err;
  }
  return true;
}

// ── Markdown ──

const num = (x, d = 3) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d).replace('.', ',')}`);
const plain = (x, d = 3) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(d).replace('.', ','));
const pct = (x, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(d).replace('.', ',')}%`);
const ci = (s, d = 3) => (s && s.lo !== null && s.lo !== undefined ? `${num(s.point, d)} [${num(s.lo, d)} … ${num(s.hi, d)}]` : '— (tidak terestimasi)');
const shares = (o) => Object.entries(o ?? {}).map(([k, v]) => `${k.replace(/^[a-e]: /, '')} ${pct(v, 0)}`).join(' · ');

export function renderMarkdown(r) {
  const md = [];
  const label = r.mode === 'evaluate' ? 'EVALUASI' : 'VALIDASI HISTORIS (bukan hasil uji)';
  md.push(`# ${r.id} — ${label}`, '');
  md.push(`Dibuat ${r.generatedAt} · mode ${r.mode} · jendela sinyal ${r.window.from} → ${r.window.to} · data s/d ${r.dataTo} · `
    + `hash pohon ${r.tree?.hash ?? '—'} (${r.hashesMatch ? 'sama dengan docs/28 §9' : 'belum/tidak sama dengan docs/28 §9'}) · commit ${r.git?.commit ?? '—'}${r.git?.clean ? '' : ' (pohon kerja kotor)'} · Node ${r.node}`);
  md.push('', `Bootstrap: moving-block hari kalender, blok ${r.analysis.bootstrap.blockDays} hari, ${r.analysis.bootstrap.reps} replikasi, benih ${r.analysis.bootstrap.seed}, CI persentil 95% dua sisi. `
    + `${r.symbols.length} simbol; dilewati ${r.skipped.length}.`, '');
  const a = r.analysis;
  if (r.mode === 'evaluate' && a.verdict) {
    md.push(`## Hasil: kelompok ${a.verdict.group}`, '');
    md.push(`${a.verdict.text.reading}. Keputusan produk: ${a.verdict.text.product}. (${a.verdict.reason}; M = ${plain(a.verdict.margin, 2)} ATR.)`, '');
  } else if (a.verdict) {
    md.push(`## Kelompok pada data validasi: ${a.verdict.group} (bukan hasil uji)`, '');
  }
  md.push('## Estimand utama (strata + jarak, pembanding "tanpa", populasi overlap)', '');
  md.push('| Hasil | ATT [CI 95%] | SE (SD replikasi) | Replikasi valid | Stabil |', '| --- | --- | --- | --- | --- |');
  for (const k of ['A', 'B']) {
    const s = a.primary?.[k];
    md.push(`| ${k === 'A' ? 'A: gerak 12 candle (ATR)' : 'B: R geometri identik'} | ${ci(s)} | ${plain(s?.se, 4)} | ${s ? `${s.valid}/${s.reps}` : '—'} | ${s ? (s.stable ? 'ya' : 'TIDAK') : '—'} |`);
  }
  md.push('', `Alert layak ${a.counts.alerts} · berpembanding ${a.counts.matched.jarak} (${pct(a.overlap.matchedShare)}) · strata aktif ${a.counts.strata.jarak} · `
    + `sel pembanding ${a.counts.cells.jarak.toLocaleString('id-ID')} · candle layak ${a.counts.eligible.toLocaleString('id-ID')} · ketidakcocokan kelayakan ${a.counts.outcomeMismatch}.`, '');
  if (a.ciMethods) {
    const c = a.ciMethods;
    const iv = (x) => `[${num(x.lo)} … ${num(x.hi)}]`;
    md.push(`Pembanding metode CI A (laporan saja; keputusan memakai persentil, docs/28 §5): median bootstrap ${num(c.median)} (geser ${num(c.shiftSe, 2)} SE; `
      + `batas atas titik + ${plain(c.upperSe, 2)} SE, batas bawah titik − ${plain(c.lowerSe, 2)} SE) · persentil ${iv(c.percentile)} kelompok ${c.groups.percentile} · `
      + `basic ${iv(c.basic)} kelompok ${c.groups.basic} · BC ${iv(c.bc)} kelompok ${c.groups.bc}${c.fragile ? ' — **rapuh terhadap metode CI**' : ''}.`, '');
  }
  if (a.precision) {
    md.push(`Presisi Monte Carlo (${a.precision.seeds} benih lain × ${a.precision.reps}): SD batas bawah ${plain(a.precision.sdLo, 4)}, batas atas ${plain(a.precision.sdHi, 4)}`
      + `${a.precision.nearBoundary ? ' — **dekat batas**' : ''}.`, '');
  }
  md.push('## Perbandingan metode bootstrap (estimand utama)', '');
  md.push('| Blok | Metode | A [CI] | SE A | B [CI] | SE B | Tidak valid |', '| --- | --- | --- | --- | --- | --- | --- |');
  const METHOD = { full: 'prosedur penuh', fixedPop: 'populasi tetap', sameSet: 'himpunan sama', alertsOnly: 'alert saja' };
  for (const [L, m] of Object.entries(a.methods ?? {})) {
    for (const [v, s] of Object.entries(m)) md.push(`| ${L} hari | ${METHOD[v]}${Number(L) === a.bootstrap.blockDays && v === 'full' ? ' (utama)' : ''} | ${ci(s.A)} | ${plain(s.A.se, 4)} | ${ci(s.B)} | ${plain(s.B.se, 4)} | ${s.A.invalid} |`);
  }
  if (a.decomposition?.A) {
    const d = a.decomposition.A;
    md.push('', `Dekomposisi varians A (blok 7 hari): alert saja ${plain(d.varAlertsOnly, 5)}, populasi tetap ${plain(d.varFixedPop, 5)}, penuh ${plain(d.varFull, 5)}, himpunan sama ${plain(d.varSameSet, 5)}; `
      + `Var(geser rata-rata pembanding) ${plain(d.varControlShift, 5)}, Cov(alert saja, geser) ${plain(d.covAlertsControlShift, 5)}.`);
  }
  md.push('', '## Diagnostik per replikasi (blok 7 hari)', '');
  if (a.diagnostics) {
    const q = (o, d = 3) => `${plain(o['0'], d)} · ${plain(o['0.05'], d)} · ${plain(o['0.5'], d)} · ${plain(o['0.95'], d)} · ${plain(o['1'], d)}`;
    md.push('| Ukuran | min · p5 · median · p95 · maks |', '| --- | --- |');
    md.push(`| Alert terambil yang punya pembanding | ${q(a.diagnostics.keptAlerts, 0)} |`);
    md.push(`| Porsi bobot alert kehilangan pembanding | ${q(a.diagnostics.lostShare, 4)} |`);
    md.push(`| Strata aktif | ${q(a.diagnostics.activeStrata, 0)} |`);
    md.push(`| Porsi alert ≥ 4 ATR yang tetap cocok | ${q(a.diagnostics.extremeKeptShare, 3)} |`);
    md.push(`| ATT A | ${q(a.diagnostics.attA, 3)} |`);
    const lv = a.diagnostics.lostVsAtt;
    md.push('', `Hubungan porsi hilang ↔ ATT A: Pearson ${plain(lv.pearson)}, Spearman ${plain(lv.spearman)}; rata-rata ATT pada 10% replikasi dengan kehilangan terbesar ${num(lv.meanAttTopDecile)} vs lainnya ${num(lv.meanAttRest)}.`);
  }
  md.push('', '## Sensitivitas pencocokan (bukan penentu)', '');
  md.push('| Pencocokan | Alert | A [CI prosedur penuh] | B [CI] |', '| --- | --- | --- | --- |');
  for (const [k, s] of Object.entries(a.sensitivity)) {
    const name = k === 'fallback' ? `fallback (jarak, selain itu dasar; ${s.fromBase ?? 0} lewat dasar)` : LEVEL_LABELS[k];
    md.push(`| ${name} | ${s.n} (${pct(s.share)}) | ${s.estimable === false ? `tidak terestimasi: ${s.reason}` : ci(s.A)} | ${s.estimable === false ? '—' : ci(s.B)} |`);
  }
  md.push('', `Sensitivitas bin 0,25 ATR ${a.balance.triggered ? '**DIPICU** (ada |SMD| > 0,10 atau SMD tak terdefinisi pada estimand utama)' : 'tidak dipicu (semua |SMD| utama ≤ 0,10)'}; estimand utama tidak berubah.`, '');
  md.push('## Keseimbangan kovariat (SMD)', '');
  md.push('| Kovariat | Sebelum | Utama | Dasar | Bin 0,25 | Lampau |', '| --- | --- | --- | --- | --- | --- |');
  const cell = (x) => (x ? `${num(x.smd)} ${x.status === 'seimbang' ? '' : `(${x.status})`}`.trim() : '—');
  for (const c of COVARIATES) {
    const row = a.balance.continuous[c];
    md.push(`| ${COVARIATE_LABELS[c]} | ${cell(row.before)} | ${cell(row.after.jarak)} | ${cell(row.after.dasar)} | ${cell(row.after.halus)} | ${cell(row.after.lampau)} |`);
  }
  for (const b of DIST_BINS) {
    const row = a.balance.distance[b];
    md.push(`| Jarak = ${b} (proporsi) | ${cell(row.before)} | ${cell(row.after.jarak)} | ${cell(row.after.dasar)} | ${cell(row.after.halus)} | ${cell(row.after.lampau)} |`);
  }
  md.push('', '## Overlap dan gerak awal ≥ 4 ATR (diagnostik, bukan hipotesis)', '');
  const o = a.overlap;
  md.push(`Alert ${o.alerts}: cocok ${o.matched} (${pct(o.matchedShare)}), tidak cocok ${o.unmatched}; tanpa pembanding di strata dasar sekalipun ${o.unmatchedWithoutAnyControl}.`, '');
  md.push('| Ciri | Tidak cocok | Cocok |', '| --- | --- | --- |');
  md.push(`| Gerak awal | ${shares(o.profiles.unmatched.pre)} | ${shares(o.profiles.matched.pre)} |`);
  md.push(`| Gerak awal p10 · p50 · p90 | ${plain(o.profiles.unmatched.preQuantiles.p10, 2)} · ${plain(o.profiles.unmatched.preQuantiles.p50, 2)} · ${plain(o.profiles.unmatched.preQuantiles.p90, 2)} | `
    + `${plain(o.profiles.matched.preQuantiles.p10, 2)} · ${plain(o.profiles.matched.preQuantiles.p50, 2)} · ${plain(o.profiles.matched.preQuantiles.p90, 2)} |`);
  md.push(`| Jarak | ${shares(o.profiles.unmatched.distance)} | ${shares(o.profiles.matched.distance)} |`);
  md.push(`| Kelompok koin | ${shares(o.profiles.unmatched.group)} | ${shares(o.profiles.matched.group)} |`);
  md.push(`| Posisi rentang | ${shares(o.profiles.unmatched.pos)} | ${shares(o.profiles.matched.pos)} |`);
  md.push(`| Tahun | ${shares(o.profiles.unmatched.year)} | ${shares(o.profiles.matched.year)} |`);
  md.push(`| ATR% median | ${pct(o.profiles.unmatched.atrMedian, 2)} | ${pct(o.profiles.matched.atrMedian, 2)} |`);
  const e = o.extreme;
  md.push('', `Gerak awal ≥ ${e.threshold} ATR: ${e.n} alert, ${e.matched} tercakup estimand (${pct(e.coveredShare)}), ${e.unmatched} tidak cocok (${pct(e.unmatchedShareOfExtreme)}); `
    + `porsinya ${pct(e.shareOfUnmatched)} dari alert tak cocok vs ${pct(e.shareOfMatched)} dari alert cocok.`);
  md.push(`Fallback strata dasar untuk alert tak cocok: ${o.viaBase.estimable === false ? `tidak terestimasi (${o.viaBase.reason})` : `n ${o.viaBase.n}, A ${ci(o.viaBase.A)}, B ${ci(o.viaBase.B)}`}; `
    + `khusus ≥ ${e.threshold} ATR: ${o.viaBaseExtreme.estimable === false ? `tidak terestimasi (${o.viaBaseExtreme.reason})` : `n ${o.viaBaseExtreme.n}, A ${ci(o.viaBaseExtreme.A)}`}.`);
  const s = a.subgroups;
  if (s.extreme) {
    md.push(`Di dalam estimand: ≥ ${e.threshold} ATR ${s.extreme.estimable === false ? 'tidak terestimasi' : `n ${s.extreme.n}, A ${ci(s.extreme.A)}`}; < ${e.threshold} ATR ${s.nonExtreme.estimable === false ? 'tidak terestimasi' : `n ${s.nonExtreme.n}, A ${ci(s.nonExtreme.A)}`}; `
      + `selisih ${s.extremeMinusNonExtreme.estimable === false ? 'tidak terestimasi' : ci(s.extremeMinusNonExtreme.A)}. Deskriptif; bukan dasar keputusan produk.`);
  }
  md.push('', '## Subkelompok (dilaporkan; bukan penentu)', '');
  md.push('| Subkelompok | n | A [CI] | B [CI] |', '| --- | --- | --- | --- |');
  const SUB = {
    fresh: 'segar (> 48 candle / belum ada)', repeat: 'berulang (≤ 48 candle)', btcUp: 'BTC 30 hari naik', btcDown: 'BTC 30 hari turun',
    btcVol0: 'vol BTC tersil 1 (rendah)', btcVol1: 'vol BTC tersil 2', btcVol2: 'vol BTC tersil 3 (tinggi)',
  };
  for (const [k, label2] of Object.entries(SUB)) {
    const x = s[k];
    if (!x) continue;
    md.push(`| ${label2} | ${x.n} | ${x.estimable === false ? '—' : ci(x.A)} | ${x.estimable === false ? '—' : ci(x.B)} |`);
  }
  if (s.interactionFreshRepeat) {
    md.push('', `Interaksi segar − berulang: ${s.interactionFreshRepeat.estimable === false ? 'tidak terestimasi' : `A ${ci(s.interactionFreshRepeat.A)}, B ${ci(s.interactionFreshRepeat.B)}`}.`);
  }
  md.push('', '## Laju alert per bulan', '', '| Bulan | Alert | Simbol aktif | Alert per simbol | Berpembanding |', '| --- | --- | --- | --- | --- |');
  for (const m of a.months) md.push(`| ${m.month} | ${m.alerts} | ${m.symbols} | ${plain(m.perSymbol, 2)} | ${m.matched} |`);
  md.push('', '## Integritas data', '');
  md.push(`Celah total ${r.integrity.gaps} (candle hilang ${r.integrity.missingCandles}); candle datar bervolume 0 ${r.integrity.flatZero}; dikeluarkan karena delisting ${r.integrity.excludedDelisting}; `
    + `alert/pembanding yang jendela 48 candle-nya melintasi delisting ${r.integrity.spanningDelisting}; masalah: ${r.integrity.problems.length ? r.integrity.problems.join('; ') : 'tidak ada'}.`);
  if (r.skipped.length) md.push('', `Simbol dilewati: ${r.skipped.join('; ')}`);
  md.push('', '## Catatan', '');
  md.push('- AL-MOM-01 adalah uji prospektif dengan periode data bersama AL-SA-ATR-01 dan pembekuan sebelum outcome dibuka; tidak sepenuhnya independen (docs/28 §7).');
  md.push('- Kesimpulan terutama berlaku untuk alert dengan gerak awal moderat; cakupan gerak awal ekstrem dilaporkan di atas.');
  if (r.rerunReason) md.push(`- Evaluasi ulang. Alasan tercatat: ${r.rerunReason}`);
  md.push('');
  return md.join('\n');
}

// ── I/O dan orkestrasi ──

async function firstCachedMonth(cacheDir, symbol) {
  try {
    const files = (await readdir(join(cacheDir, symbol, '1h'))).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).sort();
    if (!files.length) return null;
    const [y, m] = files[0].slice(0, 7).split('-').map(Number);
    return Date.UTC(y, m - 1, 1);
  } catch {
    return null;
  }
}

/** exchangeInfo mentah: status dan deliveryDate per simbol. */
export async function fetchExchangeMeta({ fetchImpl = binanceFetch } = {}) {
  const res = await fetchImpl('https://fapi.binance.com/fapi/v1/exchangeInfo', { signal: AbortSignal.timeout(30_000) });
  if (res.status !== 200) throw new Error(`exchangeInfo HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body?.symbols)) throw new Error('respons exchangeInfo tanpa array symbols');
  return new Map(body.symbols.filter((s) => typeof s?.symbol === 'string').map((s) => [s.symbol, { status: String(s.status), deliveryDate: Number(s.deliveryDate) }]));
}

/** Catatan delisting manual bersama (research-log/al-sa-atr-01/delisting-manual.json; sumber https wajib). */
export async function readManualDelistings(file = MANUAL_DELISTING_FILE) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return new Map();
  }
  const list = JSON.parse(raw);
  if (!Array.isArray(list)) throw new TypeError('delisting-manual.json harus berupa array');
  const out = new Map();
  for (const e of list) {
    const time = Date.parse(e?.deliveryTime);
    if (typeof e?.symbol !== 'string' || !Number.isFinite(time) || typeof e?.source !== 'string' || !e.source.startsWith('https://')) {
      throw new TypeError(`Entri delisting manual tidak valid: ${JSON.stringify(e).slice(0, 160)}`);
    }
    out.set(e.symbol, { time, source: e.source });
  }
  return out;
}

/** Log evaluasi AL-MOM-01 yang sudah ada (mulai atau selesai). */
export async function previousEvaluationLogs(logDir = DEFAULT_LOG_DIR) {
  try {
    return (await readdir(logDir)).filter((f) => /^evaluate-/.test(f)).sort();
  } catch {
    return [];
  }
}

function gitState() {
  const git = (args) => {
    try {
      return String(execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim();
    } catch {
      return null;
    }
  };
  const status = git(['status', '--porcelain']);
  return { commit: git(['rev-parse', 'HEAD']), clean: status === null ? null : status === '' };
}

/** Tulis tanpa menimpa: nama yang sudah ada mendapat akhiran -r2, -r3, ... */
async function writeAppendOnly(dir, base, files) {
  await mkdir(dir, { recursive: true });
  const existing = new Set(await readdir(dir));
  for (let rev = 1; rev < 100; rev += 1) {
    const stem = `${base}${rev === 1 ? '' : `-r${rev}`}`;
    if (files.some(([ext]) => existing.has(`${stem}${ext}`))) continue;
    for (const [ext, body] of files) await writeFile(join(dir, `${stem}${ext}`), body, { encoding: 'utf8', flag: 'wx' });
    return files.map(([ext]) => join(dir, `${stem}${ext}`));
  }
  throw new Error(`Terlalu banyak file ${base}`);
}

/**
 * Kumpulkan seluruh semesta. deps: { loadCandles(symbol, from, to) → candles|null, replayIdx(symbol, candles) →
 * { v3Idx, anyIdx }, delisting(symbol, candles) → status|null }. Mengembalikan store, integritas, dan rezim BTC.
 */
export async function collectUniverse({ symbols, window, loadFrom, dataTo, withOutcomes, deps, cfg = AL_MOM_01, onRecord = null }) {
  const store = createStore({ withOutcomes });
  const perSymbol = [];
  const skipped = [];
  const problems = [];
  let regime = null;
  for (const [sym, symbol] of symbols.entries()) {
    let candles;
    try {
      candles = await deps.loadCandles(symbol, loadFrom, dataTo);
    } catch (err) {
      skipped.push(`${symbol}: ${String(err?.message ?? err).slice(0, 140)}`);
      problems.push(`${symbol} GAGAL_DIAMBIL`);
      continue;
    }
    if (!candles?.length) {
      skipped.push(`${symbol}: tidak ada candle`);
      continue;
    }
    const integrity = seriesIntegrity(candles);
    const dl = deps.delisting ? deps.delisting(symbol, candles) : null;
    if (dl?.unresolved) problems.push(`${symbol} delisting/ekor datar belum terselesaikan`);
    if (Number.isFinite(dataTo) && endsEarly(candles, dataTo, dl)) problems.push(`${symbol} data berhenti sebelum ${iso(dataTo)} tanpa delisting terverifikasi`);
    const { v3Idx, anyIdx } = await deps.replayIdx(symbol, candles);
    const res = collectSeries({
      store, sym, symbol, candles, v3Idx, anyIdx, window, delistingTime: dl?.verified ? dl.time : null,
      outcomeFn: withOutcomes ? outcomesAt : null, cfg, onRecord,
    });
    if (symbol === 'BTCUSDT') regime = btcRegimeSeries(candles);
    perSymbol.push({ ...res, integrity, delisting: dl ? { time: iso(dl.time), source: dl.source, verified: dl.verified, unresolved: dl.unresolved, flatTail: dl.flatTail } : null });
    log(`${symbol}: ${candles.length} candle, alert v3 LONG layak ${res.alerts}, pembanding ${res.controlsTanpa}`);
  }
  const regimeInfo = labelRegimes(store.alerts, regime, window);
  const integrity = {
    gaps: perSymbol.reduce((s, x) => s + x.integrity.gaps, 0), missingCandles: perSymbol.reduce((s, x) => s + x.integrity.missingCandles, 0),
    flatZero: perSymbol.reduce((s, x) => s + x.integrity.flatZero, 0), excludedDelisting: perSymbol.reduce((s, x) => s + x.excludedDelisting, 0),
    spanningDelisting: perSymbol.reduce((s, x) => s + x.spanningDelisting, 0), problems,
  };
  return { store, perSymbol, skipped, integrity, regime: regimeInfo };
}

/**
 * Pemeriksaan integritas sebelum hasil apa pun dihitung (evaluate): muat semua deret, periksa delisting/ekor datar dan
 * kegagalan muat. Deret disimpan di memori supaya pengumpulan berikutnya memakai data yang sama persis.
 */
export async function preflightIntegrity({ symbols, loadFrom, dataTo, deps }) {
  const problems = [];
  const candlesBySymbol = new Map();
  for (const symbol of symbols) {
    let candles;
    try {
      candles = await deps.loadCandles(symbol, loadFrom, dataTo);
    } catch (err) {
      problems.push(`${symbol} GAGAL_DIAMBIL: ${String(err?.message ?? err).slice(0, 100)}`);
      continue;
    }
    if (!candles?.length) {
      problems.push(`${symbol} tidak ada candle`);
      continue;
    }
    const dl = deps.delisting ? deps.delisting(symbol, candles) : null;
    if (dl?.unresolved) problems.push(`${symbol} delisting/ekor datar belum terselesaikan`);
    if (endsEarly(candles, dataTo, dl)) problems.push(`${symbol} data berhenti sebelum ${iso(dataTo)} tanpa delisting terverifikasi`);
    candlesBySymbol.set(symbol, candles);
  }
  return { problems, candlesBySymbol };
}

function windowOf(mode, from, to, cfg) {
  const start = mode === 'validate' ? from : cfg.windowStart;
  const end = to - cfg.settleBars * H;
  return { from: start, to: end, loadFrom: start - cfg.warmupDays * DAY_MS, dayFrom: dayIndex(start), dayTo: dayIndex(end - 1) + 1 };
}

async function main(argv) {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      mode: { type: 'string', default: 'validate' }, from: { type: 'string' }, to: { type: 'string' },
      'cache-dir': { type: 'string', default: DEFAULT_CACHE_DIR }, out: { type: 'string' }, 'log-dir': { type: 'string', default: DEFAULT_LOG_DIR },
      'rerun-reason': { type: 'string' }, reps: { type: 'string' },
    },
    strict: true,
  });
  const cfg = AL_MOM_01;
  const now = Date.now();
  const parseDay = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00Z`) : NaN);
  const from = v.from ? parseDay(v.from) : null;
  const to = parseDay(v.to);
  // Jumlah replikasi hanya boleh diubah di validate (uji cepat); count/evaluate memakai nilai beku.
  const reps = v.reps && v.mode === 'validate' ? Number(v.reps) : cfg.reps;
  if (!Number.isInteger(reps) || reps < 200) throw new RangeError('--reps harus bilangan bulat ≥ 200');
  const cacheDir = resolve(ROOT, v['cache-dir']);
  const logDir = resolve(v['log-dir']);
  const defaultDirs = cacheDir === resolve(ROOT, DEFAULT_CACHE_DIR) && logDir === resolve(DEFAULT_LOG_DIR);
  const tree = await codeTreeHash();
  const frozen = await frozenTreeHash();
  const git = gitState();
  const previous = v.mode === 'evaluate' ? await previousEvaluationLogs(logDir) : [];
  // Pengaman dasar sebelum data apa pun dimuat; integritas data evaluate diperiksa lagi sesudah data dimuat.
  assertModeAllowed({
    mode: v.mode, from, to, now, cfg, tree: tree.hash, frozen, gitClean: git.clean, previousEvaluations: previous,
    rerunReason: v['rerun-reason'] ?? null, integrityProblems: v.mode === 'evaluate' ? [] : null, defaultDirs,
  });
  const win = windowOf(v.mode, from, to, cfg);
  const withOutcomes = v.mode !== 'count';
  const client = v.mode === 'validate' ? null : createBinanceRestClient({ logger: { warn: (o, m) => log(`[binance] ${m ?? ''} ${JSON.stringify(o)}`) } });
  let meta = null;
  if (v.mode !== 'validate') {
    try {
      meta = await fetchExchangeMeta();
    } catch (err) {
      if (v.mode === 'evaluate') throw new Error(`evaluate ditolak: exchangeInfo tidak terbaca (${err.message})`, { cause: err });
      log(`PERINGATAN: exchangeInfo tidak terbaca (${err.message}); delisting tidak diperiksa`);
    }
  }
  const manual = v.mode === 'validate' ? new Map() : await readManualDelistings();
  const deps = {
    async loadCandles(symbol, loadFrom, dataTo) {
      if (v.mode === 'validate') {
        const first = await firstCachedMonth(cacheDir, symbol);
        if (first === null) throw new Error('tidak ada di cache');
        return (await loadFromBinance({ symbol, timeframe: '1h', from: Math.max(loadFrom, first), to: dataTo, cacheDir })).candles;
      }
      return (await loadFromBinance({ symbol, timeframe: '1h', from: loadFrom, to: dataTo, client, cacheDir })).candles;
    },
    async replayIdx(symbol, candles) {
      const res = await replaySeries({ symbol, timeframe: '1h', byTf: { '1h': candles } });
      const v3 = res.trades.v3.filter((t) => t.direction === 'LONG').map((t) => t.entryIndex);
      const v2 = res.trades.v2.filter((t) => t.direction === 'LONG').map((t) => t.entryIndex);
      return { v3Idx: v3, anyIdx: [...new Set([...v2, ...v3])].sort((a, b) => a - b) };
    },
    delisting: v.mode === 'validate' ? (symbol, candles) => delistingStatus({ meta: undefined, candles })
      : (symbol, candles) => delistingStatus({ meta: meta ? (meta.get(symbol) ?? null) : undefined, manual: manual.get(symbol) ?? null, candles }),
  };
  if (v.mode === 'evaluate') {
    // Integritas diperiksa SEBELUM hasil dihitung; penanda mulai ditulis sesudah lolos, sebelum hasil dihitung.
    const pre = await preflightIntegrity({ symbols: [...cfg.universe], loadFrom: win.loadFrom, dataTo: to, deps });
    assertModeAllowed({ mode: 'evaluate', to, now, cfg, tree: tree.hash, frozen, gitClean: git.clean, previousEvaluations: previous, rerunReason: v['rerun-reason'] ?? null, integrityProblems: pre.problems, defaultDirs });
    deps.loadCandles = async (symbol) => pre.candlesBySymbol.get(symbol) ?? null;
    await writeAppendOnly(logDir, `evaluate-started-${v.to}`, [['.json', JSON.stringify({ id: cfg.id, startedAt: new Date().toISOString(), tree, git, rerunReason: v['rerun-reason'] ?? null }, null, 2)]]);
  }
  const started = Date.now();
  const col = await collectUniverse({ symbols: [...cfg.universe], window: win, loadFrom: win.loadFrom, dataTo: to, withOutcomes, deps, cfg });
  const header = {
    id: cfg.id, version: cfg.version, mode: v.mode, generatedAt: new Date(now).toISOString(), window: { from: iso(win.from), to: iso(win.to) },
    dataFrom: iso(win.loadFrom), dataTo: iso(to), tree, frozenTree: frozen, hashesMatch: tree.hash === frozen, git, node: process.version,
    symbols: [...cfg.universe], skipped: col.skipped, integrity: col.integrity, regime: { labelled: col.regime.labelled },
    rerunReason: v['rerun-reason'] ?? null,
  };
  if (v.mode === 'count') {
    const report = { ...header, counts: countSummary(col.store, cfg), perSymbol: col.perSymbol };
    const files = await writeAppendOnly(logDir, `count-${v.to}`, [['.json', JSON.stringify(report, null, 2)]]);
    log(`Count selesai: alert ${report.counts.alerts}, berpembanding ${report.counts.matched.jarak} → ${files[0]}`);
    return;
  }
  log(`Analisis: ${col.store.alerts.length} alert, ${reps} replikasi …`);
  const analysis = analyzeStore({ store: col.store, cfg, dayFrom: win.dayFrom, dayTo: win.dayTo, reps, withVerdict: true });
  const report = { ...header, durationS: Math.round((Date.now() - started) / 1000), analysis, perSymbol: col.perSymbol };
  const slug = report.generatedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  if (v.mode === 'evaluate') {
    const files = await writeAppendOnly(logDir, `evaluate-${v.to}`, [['.json', JSON.stringify(report, null, 2)], ['.md', renderMarkdown(report)]]);
    log(`Evaluasi selesai: kelompok ${analysis.verdict.group} → ${files[1]}`);
    return;
  }
  const out = resolve(v.out ?? join(ROOT, 'reports', 'research'));
  await mkdir(out, { recursive: true });
  await writeFile(join(out, `al-mom-01-validate-${slug}.json`), JSON.stringify(report, null, 2), 'utf8');
  await writeFile(join(out, `al-mom-01-validate-${slug}.md`), renderMarkdown(report), 'utf8');
  log(`Validasi selesai dalam ${report.durationS} s → ${join(out, `al-mom-01-validate-${slug}.md`)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err) => {
    log(`AL-MOM-01 gagal: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
}
