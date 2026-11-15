// Bahan desain AL-MOM-01 (docs/27; BELUM praregistrasi): daya uji dua eksperimen pembanding "momentum murni" untuk
// alert LONG 1h SA/PVA v3, dari data historis 31 koin cache (sinyal 2024-01-01 → 2026-10-01). Riset saja; deskriptif
// pada data yang sudah dilihat (docs/24–25), dipakai untuk memilih desain, bukan sebagai bukti.
//
//   A. Nilai informasi: gerak lanjutan 12 candle (ATR), alert vs rata-rata candle tanpa alert di strata yang sama
//      (simbol × kuartal × gerak awal × posisi rentang × tersil ATR%, sama dengan docs/25).
//   B. Nilai strategi dengan geometri identik: alert dan pembanding sama-sama entri di open candle berikutnya, stop
//      1,5 × ATR14, target 2R, batas 48 candle, fee 5 + slippage 2 bps per sisi; selisih R per alert vs rata-rata strata.
//
// Pembanding utama "tanpa" (semua candle tanpa alert v2/v3 searah), sensitivitas "lampau" (tanpa alert di candle itu atau
// 12 candle sebelumnya). CI moving-block bootstrap atas hari kalender (blok 7 hari utama). Daya: SE dari lebar CI blok 7
// hari, diskalakan √(n historis / n), untuk uji "batas bawah CI 95% > 0" (setara satu sisi α 2,5%) dengan daya 80%.
//
// Pakai: npm run research:mom-power

import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_CACHE_DIR } from '../backend/backtest/dataSource.js';
import { labelTrade } from '../backend/backtest/labeler.js';
import { BACKTEST_WARMUP, replaySeries } from '../backend/backtest/runner.js';
import { atr } from '../backend/indicators/index.js';
import {
  DAY_MS, MATCH_DEFAULTS, addControl, binOf, forwardMove, matchAlerts, movingBlockBootstrapMean, onePositionPerSymbol,
  quantileCuts, quarterOf, stratumKey,
} from '../backend/research/matchedBaseline.js';
import { breakoutFlags, timingAt } from '../backend/research/signalTiming.js';
import { exclusionMask } from './research-matched-exclusion.js';
import { loadCached } from './research-timing.js';
import { assertBeforeMomWindow } from './research-window-guard.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOOK = 12;
const DONCHIAN = 48;
const HORIZON_MAX = 48; // kelayakan candle sama dengan docs/25 (gerak 12 & 48 candle tersedia)
const BLOCKS = Object.freeze([7, 14, 1]);
const Z_ALPHA = 1.959964; // batas bawah CI 95% > 0
const Z_POWER = 0.841621; // daya 80%
const SINCE_PREV_SPLIT = 48; // candle sejak alert v2/v3 sebelumnya (usul tinjauan ChatGPT)

export const MOM_DESIGN = Object.freeze({ stopAtr: 1.5, targetR: 2, maxBars: 48, feeBps: 5, slippageBps: 2 });
export const MOM_VARIANTS = Object.freeze([
  Object.freeze({ key: 'tanpa', before: 0, after: 0, label: 'semua candle tanpa alert (utama)' }),
  Object.freeze({ key: 'lampau', before: 0, after: 12, label: 'tanpa alert di candle itu atau 12 candle sebelumnya' }),
]);
const OUTCOME_KEYS = Object.freeze(['fwd12', 'rAtr']);

const log = (m) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${m}\n`);
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
const day = (s, name) => {
  const ms = Date.parse(`${s}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(ms)) throw new RangeError(`--${name} harus YYYY-MM-DD`);
  return ms;
};

/** Trade LONG dengan geometri identik untuk alert & pembanding: entri open i+1, stop 1,5 × ATR[i], target 2R, 48 candle. */
export function atrTrade(candles, atrValues, i, design = MOM_DESIGN) {
  const entry = candles[i + 1]?.open;
  const a = atrValues[i];
  if (!(entry > 0) || !(a > 0)) return null;
  const stop = entry - design.stopAtr * a;
  if (!(stop > 0)) return null;
  const t = labelTrade({
    candles, entryIndex: i, direction: 'LONG', entryPrice: entry, stopPrice: stop,
    targetR: design.targetR, maxBars: design.maxBars, feeBps: design.feeBps, slippageBps: design.slippageBps,
  });
  return t && t.outcome !== 'OPEN' ? { r: t.rMultiple, entryTime: candles[i + 1].openTime, exitTime: t.exitTime } : null;
}

/** Efek terkecil yang terdeteksi (daya 80%, batas bawah CI 95% > 0) dengan n alert, dari SE historis pada nHist. */
export function minDetectableEffect({ seHist, nHist, n, zAlpha = Z_ALPHA, zPower = Z_POWER }) {
  if (!(seHist > 0) || !(nHist > 0) || !(n > 0)) return null;
  return (zAlpha + zPower) * seHist * Math.sqrt(nHist / n);
}

/** Jumlah alert untuk mendeteksi efek δ dengan daya 80%. */
export function requiredAlerts({ seHist, nHist, effect, zAlpha = Z_ALPHA, zPower = Z_POWER }) {
  if (!(seHist > 0) || !(nHist > 0) || !(effect > 0)) return null;
  return Math.ceil(nHist * ((zAlpha + zPower) * seHist / effect) ** 2);
}

/**
 * Kelompok jarak dari alert v2/v3 sebelumnya (candle), untuk strata penyesuaian docs/27 §7: ≤ 12, 13–48, > 48 atau
 * belum ada. Dihitung sama untuk alert dan pembanding (hanya melihat ke belakang).
 */
export function distanceBin(sincePrev) {
  if (sincePrev === null || sincePrev === undefined || sincePrev > SINCE_PREV_SPLIT) return 'jauh';
  return sincePrev <= LOOK ? 'd12' : 'd48';
}

/** Jarak (candle) untuk kovariat keseimbangan: > 48 atau belum ada → 49. */
export const cappedDistance = (sincePrev) => (sincePrev === null || sincePrev === undefined || sincePrev > SINCE_PREV_SPLIT ? SINCE_PREV_SPLIT + 1 : sincePrev);

/** Sel agregat pembanding: n, jumlah hasil (A = fwd12, B = rAtr), dan jumlah kovariat. */
export function addCell(cells, key, y, cov) {
  let c = cells.get(key);
  if (!c) {
    c = [0, 0, 0, 0, 0, 0, 0];
    cells.set(key, c);
  }
  c[0] += 1;
  c[1] += y.fwd12;
  c[2] += y.rAtr;
  c[3] += cov.pre;
  c[4] += cov.pos;
  c[5] += cov.atr;
  c[6] += cov.dist;
}

/** Indeks alert sebelumnya (< i) untuk tiap candle; −1 bila tidak ada. alertIdx terurut naik. */
export function previousAlertIndex(n, alertIdx) {
  const prev = new Int32Array(n).fill(-1);
  let k = 0;
  let last = -1;
  for (let i = 0; i < n; i += 1) {
    while (k < alertIdx.length && alertIdx[k] < i) {
      last = alertIdx[k];
      k += 1;
    }
    prev[i] = last;
  }
  return prev;
}

async function seriesPart({ symbol, byTf, acc }) {
  const B = byTf['1h'];
  const res = await replaySeries({ symbol, timeframe: '1h', byTf });
  const A = atr(B, 14);
  const flags = breakoutFlags(B, 'LONG', DONCHIAN);
  const v3 = res.trades.v3.filter((t) => t.direction === 'LONG');
  const v2 = res.trades.v2.filter((t) => t.direction === 'LONG');
  const n = B.length;
  const allIdx = [...new Set([...v2, ...v3].map((t) => t.entryIndex))].sort((a, b) => a - b);
  const masks = Object.fromEntries(MOM_VARIANTS.map((v) => [v.key, exclusionMask(n, allIdx, v)]));
  const prev = previousAlertIndex(n, allIdx);
  const lo = BACKTEST_WARMUP;
  const hi = n - 1 - HORIZON_MAX;
  const volByPeriod = new Map();
  for (let i = lo; i <= hi; i += 1) {
    if (!(A[i] > 0)) continue;
    const p = quarterOf(B[i].openTime);
    if (!volByPeriod.has(p)) volByPeriod.set(p, []);
    volByPeriod.get(p).push(A[i] / B[i].close);
    acc.symbolMonths.add(`${symbol}|${new Date(B[i].openTime).toISOString().slice(0, 7)}`);
  }
  const cuts = new Map([...volByPeriod].map(([p, vals]) => [p, quantileCuts(vals, MATCH_DEFAULTS.volBins)]));
  const alertAt = new Set(v3.map((t) => t.entryIndex));
  let alerts = 0;
  for (let i = lo; i <= hi; i += 1) {
    const tm = timingAt(B, A, flags, 'LONG', i, { donchian: DONCHIAN, look: LOOK });
    if (!tm) continue;
    const fwd12 = forwardMove(B, A, 'LONG', i, 12);
    if (fwd12 === null || forwardMove(B, A, 'LONG', i, 48) === null) continue;
    const trade = atrTrade(B, A, i);
    if (!trade) continue;
    const period = quarterOf(B[i].openTime);
    const y = { fwd12, rAtr: trade.r };
    const key = stratumKey({ symbol, period, pre: tm.pre, pos: tm.pos, volBin: binOf(A[i] / B[i].close, cuts.get(period)) });
    const sincePrev = prev[i] >= 0 ? i - prev[i] : null;
    // Strata + jarak dari alert sebelumnya (docs/27 §7), hanya untuk pembanding utama "tanpa".
    const keyJarak = `${key}|${distanceBin(sincePrev)}`;
    for (const v of MOM_VARIANTS) if (!masks[v.key][i]) addControl(acc.controls[v.key], key, y);
    if (acc.controls.tanpaJarak && !masks.tanpa[i]) addControl(acc.controls.tanpaJarak, keyJarak, y);
    // Agregat pembanding per strata-jarak × hari (docs/27 §9): untuk bootstrap yang mengambil ulang pembanding per blok
    // hari dan untuk keseimbangan kovariat. Hari = closeTime, sama dengan waktu alert.
    if (acc.cells && !masks.tanpa[i]) addCell(acc.cells, `${keyJarak}#${Math.floor(B[i].closeTime / DAY_MS)}`, y, {
      pre: tm.pre, pos: tm.pos, atr: A[i] / B[i].close, dist: cappedDistance(sincePrev),
    });
    if (alertAt.has(i)) {
      alerts += 1;
      acc.alerts.push({
        key, keyJarak, y, t: B[i].closeTime, symbol, sincePrev, atrPct: A[i] / B[i].close, pre: tm.pre, pos: tm.pos,
      });
      acc.alertTrades.push({ symbol, t: trade.entryTime, exitTime: trade.exitTime, r: trade.r });
    }
  }
  return alerts;
}

const ciSet = (events, value) => Object.fromEntries(BLOCKS.map((L) => [L, movingBlockBootstrapMean(events, { value, time: (e) => e.t, blockDays: L })]));
const seOf = (ci) => (ci ? (ci.hi - ci.lo) / (2 * Z_ALPHA) : null);

function summarize(acc) {
  const months = acc.symbolMonths.size;
  const rate = acc.alerts.length / months;
  const variants = {};
  for (const v of MOM_VARIANTS) {
    const { matched, unmatched } = matchAlerts(acc.alerts, acc.controls[v.key]);
    const outcomes = Object.fromEntries(OUTCOME_KEYS.map((o) => {
      const att = ciSet(matched, (m) => m.diff[o]);
      return [o, { alert: mean(matched.map((m) => m.y[o])), ctrl: mean(matched.map((m) => m.ctrl[o])), att, se7: seOf(att[7]) }];
    }));
    variants[v.key] = { matched: matched.length, unmatched, matchRate: acc.alerts.length ? matched.length / acc.alerts.length : null, ...outcomes };
    if (v.key === 'tanpa') {
      const near = (m) => m.sincePrev !== null && m.sincePrev <= SINCE_PREV_SPLIT;
      variants[v.key].sincePrev = Object.fromEntries([['dekat', near], ['jauh', (m) => !near(m)]].map(([k, f]) => {
        const list = matched.filter(f);
        return [k, {
          n: list.length,
          fwd12: movingBlockBootstrapMean(list, { value: (m) => m.diff.fwd12, time: (m) => m.t, blockDays: 7 }),
          rAtr: movingBlockBootstrapMean(list, { value: (m) => m.diff.rAtr, time: (m) => m.t, blockDays: 7 }),
        }];
      }));
    }
  }
  const one = onePositionPerSymbol(acc.alertTrades);
  const alertOnly = { n: one.length, meanR: mean(one.map((x) => x.r)), ci7: movingBlockBootstrapMean(one, { value: (x) => x.r, time: (x) => x.t, blockDays: 7 }) };
  const p = variants.tanpa;
  const perMonth100 = rate * 100 * p.matchRate;
  const power = {
    alertsPerSymbolMonth: rate,
    matchedAlertsPerMonth100: perMonth100,
    rows: [6, 9, 12, 18, 24].map((M) => {
      const n = perMonth100 * M;
      return { months: M, n: Math.round(n), mdeA: minDetectableEffect({ seHist: p.fwd12.se7, nHist: p.matched, n }), mdeB: minDetectableEffect({ seHist: p.rAtr.se7, nHist: p.matched, n }) };
    }),
    requiredA: [0.1, 0.15, 0.2, 0.25].map((effect) => {
      const n = requiredAlerts({ seHist: p.fwd12.se7, nHist: p.matched, effect });
      return { effect, n, months100: n / perMonth100 };
    }),
    requiredB: [0.03, 0.05, 0.1].map((effect) => {
      const n = requiredAlerts({ seHist: p.rAtr.se7, nHist: p.matched, effect });
      return { effect, n, months100: n / perMonth100 };
    }),
  };
  return { alerts: acc.alerts.length, symbolMonths: months, variants, alertOnly, power };
}

/**
 * Kumpulkan alert & agregat pembanding per strata untuk simbol cache (semua, atau `only`). Dipakai juga oleh
 * scripts/research-mom-sim.js. `acc.controls.tanpaJarak` = pembanding "tanpa" dengan strata + jarak alert sebelumnya.
 */
export async function collectMomData({ symbols: only = null, from, to, cacheDir, withCells = false }) {
  const symbols = (await readdir(cacheDir)).filter((s) => /^[A-Z0-9]{2,30}$/.test(s) && (!only || only.includes(s))).sort();
  const acc = {
    controls: { ...Object.fromEntries(MOM_VARIANTS.map((v) => [v.key, new Map()])), tanpaJarak: new Map() },
    alerts: [], alertTrades: [], symbolMonths: new Set(), ...(withCells ? { cells: new Map() } : {}),
  };
  const skipped = [];
  for (const symbol of symbols) {
    let candles = null;
    try {
      candles = await loadCached(cacheDir, symbol, '1h', from, to);
    } catch (err) {
      skipped.push(`${symbol} 1h: ${String(err.message).slice(0, 120)}`);
    }
    if (!candles || candles.length <= BACKTEST_WARMUP) continue;
    const started = Date.now();
    const alerts = await seriesPart({ symbol, byTf: { '1h': candles }, acc });
    log(`${symbol} LONG 1h: ${candles.length} candle, alert v3 ${alerts} (${Date.now() - started} ms)`);
  }
  return { symbols, skipped, acc };
}

export async function runMomPower({ symbols: only = null, from, to, cacheDir, now = Date.now() }) {
  const { symbols, skipped, acc } = await collectMomData({ symbols: only, from, to, cacheDir });
  return {
    generatedAt: new Date(now).toISOString(), from: new Date(from).toISOString().slice(0, 10), to: new Date(to).toISOString().slice(0, 10),
    symbols, skipped, design: { ...MOM_DESIGN, variants: MOM_VARIANTS.map((v) => v.key), sincePrevSplit: SINCE_PREV_SPLIT }, ...summarize(acc),
  };
}

const num = (x, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d).replace('.', ',')}`);
const plain = (x, d = 2) => (x === null || x === undefined ? '—' : x.toFixed(d).replace('.', ','));
const withCi = (ci, d = 2) => (ci ? `${num(ci.mean, d)} [${num(ci.lo, d)} … ${num(ci.hi, d)}]` : '—');
const int = (x) => (x === null || x === undefined ? '—' : Math.round(x).toLocaleString('id-ID'));

export function renderMomPowerMarkdown(r) {
  const md = [
    '# Daya uji AL-MOM-01 (bahan desain, belum praregistrasi) — AlphaLens',
    '',
    `Dibuat ${r.generatedAt} · ${r.symbols.length} simbol cache · sinyal ${r.from} → ${r.to} · LONG 1h SA/PVA v3 · `
      + `geometri B: stop ${plain(r.design.stopAtr, 1)} ATR, target ${r.design.targetR}R, ${r.design.maxBars} candle, fee ${r.design.feeBps} + slippage ${r.design.slippageBps} bps per sisi`,
    '',
    `Alert ${r.alerts} · ${r.symbolMonths} simbol-bulan (${plain(r.power.alertsPerSymbolMonth)} alert per simbol-bulan). Deskriptif pada data yang sudah dilihat.`,
    '',
    '## Selisih alert − pembanding strata (ATT)',
    '',
    '| Pembanding | Cocok | A: gerak 12 candle alert vs pembanding (ATR) | A: selisih [CI 7 hari] | CI 14 hari · harian | B: R alert vs pembanding | B: selisih R [CI 7 hari] | CI 14 hari · harian |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...MOM_VARIANTS.map((v) => {
      const x = r.variants[v.key];
      const a = x.fwd12;
      const b = x.rAtr;
      const ci = (c) => (c ? `[${num(c.lo)} … ${num(c.hi)}]` : '—');
      return `| ${v.key} | ${x.matched} (${plain(x.matchRate * 100, 1)}%) | ${num(a.alert)} vs ${num(a.ctrl)} | ${withCi(a.att[7])} | ${ci(a.att[14])} · ${ci(a.att[1])} | `
        + `${num(b.alert)} vs ${num(b.ctrl)} | ${withCi(b.att[7])} | ${ci(b.att[14])} · ${ci(b.att[1])} |`;
    }),
    '',
    `Jarak dari alert v2/v3 sebelumnya (pembanding "tanpa"): ≤ ${r.design.sincePrevSplit} candle n ${r.variants.tanpa.sincePrev.dekat.n}, `
      + `A ${withCi(r.variants.tanpa.sincePrev.dekat.fwd12)}, B ${withCi(r.variants.tanpa.sincePrev.dekat.rAtr)} · `
      + `> ${r.design.sincePrevSplit} candle atau tidak ada n ${r.variants.tanpa.sincePrev.jauh.n}, A ${withCi(r.variants.tanpa.sincePrev.jauh.fwd12)}, `
      + `B ${withCi(r.variants.tanpa.sincePrev.jauh.rAtr)}.`,
    '',
    `Strategi alert saja dengan geometri B (satu posisi per simbol): n ${r.alertOnly.n}, R bersih ${withCi(r.alertOnly.ci7)}.`,
    '',
    '## Daya 80% (batas bawah CI 95% > 0), pembanding "tanpa", 100 koin',
    '',
    `SE blok 7 hari pada n ${r.variants.tanpa.matched}: A ${plain(r.variants.tanpa.fwd12.se7, 3)} ATR, B ${plain(r.variants.tanpa.rAtr.se7, 3)} R. `
      + `Perkiraan ${plain(r.power.matchedAlertsPerMonth100, 0)} alert cocok per bulan di 100 koin (laju 31 koin cache; koin lain belum diukur).`,
    '',
    '| Lama jendela | Alert cocok | Efek terkecil terdeteksi A (ATR) | Efek terkecil terdeteksi B (R) |',
    '| --- | --- | --- | --- |',
    ...r.power.rows.map((x) => `| ${x.months} bulan | ${int(x.n)} | ${plain(x.mdeA)} | ${plain(x.mdeB, 3)} |`),
    '',
    '| Efek A (ATR) | Alert dibutuhkan | Bulan (100 koin) |',
    '| --- | --- | --- |',
    ...r.power.requiredA.map((x) => `| ${plain(x.effect)} | ${int(x.n)} | ${plain(x.months100, 1)} |`),
    '',
    '| Efek B (R) | Alert dibutuhkan | Bulan (100 koin) |',
    '| --- | --- | --- |',
    ...r.power.requiredB.map((x) => `| ${plain(x.effect)} | ${int(x.n)} | ${plain(x.months100, 1)} |`),
    '',
    'Catatan: SE diskalakan dengan √n dari data historis; efek desain dari ketergantungan waktu ikut terbawa lewat bootstrap blok.',
    '',
  ];
  return md.join('\n');
}

async function main(argv) {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      symbols: { type: 'string' }, from: { type: 'string', default: '2024-01-01' }, to: { type: 'string', default: '2026-10-01' },
      'cache-dir': { type: 'string', default: DEFAULT_CACHE_DIR }, out: { type: 'string', default: join(ROOT, 'reports', 'research') },
    },
    strict: true,
  });
  const from = day(v.from, 'from');
  const to = day(v.to, 'to');
  assertBeforeMomWindow(to);
  if (from >= to) throw new RangeError('--from harus sebelum --to');
  const symbols = v.symbols ? v.symbols.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : null;
  const started = Date.now();
  const result = await runMomPower({ symbols, from, to, cacheDir: resolve(ROOT, v['cache-dir']), now: started });
  result.durationS = Math.round((Date.now() - started) / 1000);
  const out = resolve(v.out);
  await mkdir(out, { recursive: true });
  const slug = result.generatedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  await writeFile(join(out, `mom-power-${slug}.md`), renderMomPowerMarkdown(result), 'utf8');
  await writeFile(join(out, `mom-power-${slug}.json`), JSON.stringify(result, null, 2), 'utf8');
  log(`Selesai dalam ${result.durationS} s → ${join(out, `mom-power-${slug}.md`)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err) => {
    log(`Riset gagal: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
}
