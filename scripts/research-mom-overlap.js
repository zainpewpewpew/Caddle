// Diagnostik overlap dan bootstrap AL-MOM-01 (docs/27 §9; bahan desain, BELUM praregistrasi). Menjawab tinjauan
// ChatGPT 2026-11-16:
//   1. estimand pada alert yang punya pembanding (overlap): karakteristik alert yang tidak cocok dan sensitivitasnya
//      (strata dasar, strata + jarak, fallback);
//   2. keseimbangan kovariat sesudah pencocokan (selisih rata-rata terstandar, SMD) untuk gerak awal, posisi rentang,
//      ATR%, dan jarak dari alert sebelumnya;
//   3. bootstrap yang mengulang prosedur estimasi: blok hari kalender mengambil ulang alert DAN candle pembanding, lalu
//      rata-rata pembanding per strata dihitung ulang di setiap replikasi; dibandingkan dengan bootstrap alert saja
//      (rata-rata pembanding tetap) pada bobot hari yang sama.
// Data historis 100 koin semesta AL-SA-ATR-01 (sinyal 2024-01 → 2026-10), seluruhnya sebelum jendela uji.
//
// Pakai: npm run research:mom-overlap [-- --save-acc <file.json.gz> | --load-acc <file.json.gz>]

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import { DEFAULT_CACHE_DIR } from '../backend/backtest/dataSource.js';
import { AL_SA_ATR_01 } from '../backend/research/alSaAtr01.js';
import { DAY_MS, matchAlerts, movingBlockBootstrapMean } from '../backend/research/matchedBaseline.js';
import { cappedDistance, collectMomData, distanceBin } from './research-mom-power.js';
import {
  DOCS27_IN_UNIVERSE, Z_ONE, Z_TWO, monthsForUpperBound, rollingWindows, upperBoundPower,
} from './research-mom-sim.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const COVARIATES = Object.freeze(['pre', 'pos', 'atr', 'dist']);
const OUT = Object.freeze([['fwd12', 'A'], ['rAtr', 'B']]);
const Z_POWER = 0.841621; // daya 80%

const log = (m) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${m}\n`);
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
const sd = (arr) => {
  const m = mean(arr);
  return arr.length > 1 ? Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1)) : null;
};
const day = (s, name) => {
  const ms = Date.parse(`${s}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(ms)) throw new RangeError(`--${name} harus YYYY-MM-DD`);
  return ms;
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Kunci strata-jarak 'SIMBOL|kuartal|bin gerak|bin posisi|tersil ATR%|jarak' → bagian-bagiannya. */
export function parseStratum(keyJarak) {
  const [symbol, period, preBin, posBin, volBin, dist] = keyJarak.split('|');
  return { symbol, period, preBin: Number(preBin), posBin: Number(posBin), volBin: Number(volBin), dist, base: keyJarak.slice(0, keyJarak.lastIndexOf('|')) };
}

/**
 * Indeks sel pembanding (strata-jarak × hari) dalam array bertipe, ditambah peta strata dasar (tanpa jarak).
 * cells: Map 'kunciJarak#hari' → [n, ΣA, ΣB, Σpre, Σpos, Σatr, Σdist].
 */
export function buildCellIndex(cells) {
  const strata = new Map();
  const baseOfKey = new Map();
  const size = cells.size;
  const sid = new Int32Array(size);
  const dayOf = new Int32Array(size);
  const n = new Float64Array(size);
  const sums = Array.from({ length: 6 }, () => new Float64Array(size));
  let k = 0;
  for (const [key, c] of cells) {
    const hash = key.lastIndexOf('#');
    const s = key.slice(0, hash);
    if (!strata.has(s)) strata.set(s, strata.size);
    const base = s.slice(0, s.lastIndexOf('|'));
    if (!baseOfKey.has(base)) baseOfKey.set(base, baseOfKey.size);
    sid[k] = strata.get(s);
    dayOf[k] = Number(key.slice(hash + 1));
    n[k] = c[0];
    for (let j = 0; j < 6; j += 1) sums[j][k] = c[j + 1];
    k += 1;
  }
  const baseOf = new Int32Array(strata.size);
  for (const [s, id] of strata) baseOf[id] = baseOfKey.get(s.slice(0, s.lastIndexOf('|')));
  return { strata, baseKeys: baseOfKey, baseOf, sid, day: dayOf, n, sums, size };
}

/** Agregat pembanding penuh per strata pada level 'jarak' atau 'dasar': n dan jumlah [A, B, pre, pos, atr, dist]. */
export function strataTotals(idx, level) {
  const m = level === 'jarak' ? idx.strata.size : idx.baseKeys.size;
  const N = new Float64Array(m);
  const S = Array.from({ length: 6 }, () => new Float64Array(m));
  for (let c = 0; c < idx.size; c += 1) {
    const s = level === 'jarak' ? idx.sid[c] : idx.baseOf[idx.sid[c]];
    N[s] += idx.n[c];
    for (let j = 0; j < 6; j += 1) S[j][s] += idx.sums[j][c];
  }
  return { N, S };
}

/**
 * Bootstrap blok hari kalender (blok `blockDays`, benih tetap) yang mengulang prosedur: di setiap replikasi, bobot hari
 * dipakai untuk alert dan sel pembanding, rata-rata pembanding per strata dihitung ulang, dan alert tanpa pembanding pada
 * replikasi itu tidak ikut. Pada bobot yang sama dihitung juga versi "alert saja" (rata-rata pembanding tetap).
 * alerts: [{ s (indeks strata pada level), day, y: { fwd12, rAtr } }] — hanya alert yang cocok pada data penuh.
 * dayFrom/dayTo (indeks hari, opsional): batasi ke satu jendela; sel di luar jendela tidak dipakai. Jendela harus
 * sejajar kuartal (strata memuat kuartal), jadi rata-rata pembanding data penuh = rata-rata di dalam jendela.
 */
export function procedureBootstrap({ alerts, idx, level, blockDays = 7, reps = 2000, seed = 7, alpha = 0.05, dayFrom = null, dayTo = null, totals = null }) {
  const m = level === 'jarak' ? idx.strata.size : idx.baseKeys.size;
  const strataOfCell = level === 'jarak' ? idx.sid : Int32Array.from(idx.sid, (s) => idx.baseOf[s]);
  const full = totals ?? strataTotals(idx, level);
  let d0 = Infinity;
  let d1 = -Infinity;
  if (dayFrom !== null && dayTo !== null) {
    d0 = dayFrom;
    d1 = dayTo - 1;
  } else {
    for (let c = 0; c < idx.size; c += 1) {
      if (idx.day[c] < d0) d0 = idx.day[c];
      if (idx.day[c] > d1) d1 = idx.day[c];
    }
    for (const a of alerts) {
      if (a.day < d0) d0 = a.day;
      if (a.day > d1) d1 = a.day;
    }
  }
  const D = d1 - d0 + 1;
  const L = Math.max(1, Math.min(blockDays, D));
  const nBlocks = Math.ceil(D / L);
  const starts = D - L + 1;
  const rnd = mulberry32(seed);
  const w = new Float64Array(D);
  const N = new Float64Array(m);
  const SA = new Float64Array(m);
  const SB = new Float64Array(m);
  // full = prosedur penuh; alertsOnly = rata-rata pembanding tetap; sameSet = rata-rata pembanding tetap, tetapi hanya
  // alert yang juga ikut di versi penuh pada replikasi itu (memisahkan efek berpasangan dari efek alert yang terbuang).
  const res = { full: { A: [], B: [] }, alertsOnly: { A: [], B: [] }, sameSet: { A: [], B: [] }, matchedShare: [] };
  for (let r = 0; r < reps; r += 1) {
    w.fill(0);
    for (let b = 0; b < nBlocks; b += 1) {
      const st = Math.floor(rnd() * starts);
      for (let d = st; d < st + L; d += 1) w[d] += 1;
    }
    N.fill(0);
    SA.fill(0);
    SB.fill(0);
    for (let c = 0; c < idx.size; c += 1) {
      const dd = idx.day[c] - d0;
      if (dd < 0 || dd >= D) continue;
      const wc = w[dd];
      if (wc === 0) continue;
      const s = strataOfCell[c];
      N[s] += wc * idx.n[c];
      SA[s] += wc * idx.sums[0][c];
      SB[s] += wc * idx.sums[1][c];
    }
    let fa = 0;
    let fb = 0;
    let fw = 0;
    let oa = 0;
    let ob = 0;
    let ow = 0;
    let sa = 0;
    let sb = 0;
    for (const a of alerts) {
      const wa = w[a.day - d0];
      if (wa === 0) continue;
      const da = a.y.fwd12 - full.S[0][a.s] / full.N[a.s];
      const db = a.y.rAtr - full.S[1][a.s] / full.N[a.s];
      oa += wa * da;
      ob += wa * db;
      ow += wa;
      if (N[a.s] > 0) {
        fa += wa * (a.y.fwd12 - SA[a.s] / N[a.s]);
        fb += wa * (a.y.rAtr - SB[a.s] / N[a.s]);
        sa += wa * da;
        sb += wa * db;
        fw += wa;
      }
    }
    if (fw > 0) {
      res.full.A.push(fa / fw);
      res.full.B.push(fb / fw);
      res.sameSet.A.push(sa / fw);
      res.sameSet.B.push(sb / fw);
    }
    if (ow > 0) {
      res.alertsOnly.A.push(oa / ow);
      res.alertsOnly.B.push(ob / ow);
      res.matchedShare.push(fw / ow);
    }
  }
  const summarize = (arr, point) => {
    const s = Float64Array.from(arr).sort();
    const q = (p) => s[Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)))];
    const lo = q(alpha / 2);
    const hi = q(1 - alpha / 2);
    return { mean: point, lo, hi, se: (hi - lo) / (2 * Z_TWO), reps: s.length };
  };
  const pointA = mean(alerts.map((a) => a.y.fwd12 - full.S[0][a.s] / full.N[a.s]));
  const pointB = mean(alerts.map((a) => a.y.rAtr - full.S[1][a.s] / full.N[a.s]));
  return {
    days: D, blockDays: L,
    full: { A: summarize(res.full.A, pointA), B: summarize(res.full.B, pointB) },
    alertsOnly: { A: summarize(res.alertsOnly.A, pointA), B: summarize(res.alertsOnly.B, pointB) },
    sameSet: { A: summarize(res.sameSet.A, pointA), B: summarize(res.sameSet.B, pointB) },
    matchedShareMin: Math.min(...res.matchedShare), matchedShareMean: mean(res.matchedShare),
  };
}

/** Sub-indeks sel pada hari [dayFrom, dayTo) (id strata tetap), supaya bootstrap per jendela tidak menyapu semua sel. */
export function subsetIndex(idx, dayFrom, dayTo) {
  const keep = [];
  for (let c = 0; c < idx.size; c += 1) if (idx.day[c] >= dayFrom && idx.day[c] < dayTo) keep.push(c);
  const pick = (arr) => {
    const out = new arr.constructor(keep.length);
    keep.forEach((c, k) => { out[k] = arr[c]; });
    return out;
  };
  return { ...idx, sid: pick(idx.sid), day: pick(idx.day), n: pick(idx.n), sums: idx.sums.map(pick), size: keep.length };
}

/** SMD kovariat sesudah pencocokan: (rata-rata alert − rata-rata pembanding strata alert) / SD alert. */
export function covariateBalance({ alerts, totals }) {
  const out = {};
  COVARIATES.forEach((cov, j) => {
    const xa = alerts.map((a) => a.cov[cov]);
    const xc = alerts.map((a) => totals.S[j + 2][a.s] / totals.N[a.s]);
    const s = sd(xa);
    out[cov] = { alert: mean(xa), control: mean(xc), smd: s > 0 ? (mean(xa) - mean(xc)) / s : null };
  });
  return out;
}

const ATT = (list, o) => movingBlockBootstrapMean(list, { value: (m) => m.diff[o], time: (m) => m.t, blockDays: 7 });

/**
 * SE per jendela 12/24 bulan (strata + jarak): prosedur penuh, alert saja, dan alert saja pada himpunan yang sama; lalu
 * daya uji batas atas dan efek terkecil terdeteksi dengan SE prosedur penuh (median antarjendela).
 */
export function windowedPower({ alerts, idx, totals, from, to, reps, effect }) {
  const windows = {};
  for (const months of [12, 24]) {
    windows[months] = rollingWindows({ from, to, months }).map((w) => {
      const dayFrom = Math.floor(w.from / DAY_MS);
      const dayTo = Math.floor(w.to / DAY_MS);
      const list = alerts.filter((a) => a.day >= dayFrom && a.day < dayTo);
      const b = procedureBootstrap({ alerts: list, idx: subsetIndex(idx, dayFrom, dayTo), level: 'jarak', reps, dayFrom, dayTo, totals });
      const row = { label: w.label, n: list.length };
      for (const [, k] of OUT) row[k] = { full: b.full[k].se, alertsOnly: b.alertsOnly[k].se, sameSet: b.sameSet[k].se };
      return row;
    });
  }
  if (!windows[12].length && !windows[24].length) return null;
  const med = (arr) => {
    const s = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
    if (!s.length) return null;
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  const summary = Object.fromEntries([12, 24].map((months) => [months, Object.fromEntries(OUT.map(([, k]) => {
    const rows = windows[months];
    return [k, {
      full: med(rows.map((r) => r[k].full)), alertsOnly: med(rows.map((r) => r[k].alertsOnly)), sameSet: med(rows.map((r) => r[k].sameSet)),
      ratio: med(rows.map((r) => r[k].full / r[k].alertsOnly)),
    }];
  }))]));
  const margins = { A: [0.25, 0.3], B: [0.1, 0.12] };
  const power = [];
  for (const [, k] of OUT) {
    for (const margin of margins[k]) {
      for (const [bound, z] of [['dua sisi', Z_TWO], ['satu sisi', Z_ONE]]) {
        power.push({
          outcome: k, margin, bound,
          m12: upperBoundPower({ margin, effect: effect[k], se: summary[12][k].full, z }),
          m24: upperBoundPower({ margin, effect: effect[k], se: summary[24][k].full, z }),
          months80: monthsForUpperBound({ margin, effect: effect[k], se0: summary[24][k].full, months0: 24, z }),
        });
      }
    }
  }
  const mdeOf = (se) => (se > 0 ? (Z_TWO + Z_POWER) * se : null);
  const mde = Object.fromEntries(OUT.map(([, k]) => [k, { 12: mdeOf(summary[12][k].full), 24: mdeOf(summary[24][k].full) }]));
  return { windows, summary, power, mde };
}

/** Seluruh analisis dari agregat collectMomData({ withCells: true }). from/to (ms) mengaktifkan analisis per jendela. */
export function analyzeOverlap({ acc, reps = 2000, from = null, to = null }) {
  const idx = buildCellIndex(acc.cells);
  const covOf = (a) => ({ pre: a.pre, pos: a.pos, atr: a.atrPct, dist: cappedDistance(a.sincePrev) });
  const dayOf = (a) => Math.floor(a.t / DAY_MS);
  const levels = {};
  const bAlertsBy = {};
  const totalsBy = {};
  for (const level of ['dasar', 'jarak']) {
    const controls = level === 'jarak' ? acc.controls.tanpaJarak : acc.controls.tanpa;
    const keyOf = (a) => (level === 'jarak' ? a.keyJarak : a.key);
    const lookup = level === 'jarak' ? idx.strata : idx.baseKeys;
    const { matched, unmatched } = matchAlerts(acc.alerts.map((a) => ({ ...a, key: keyOf(a) })), controls);
    const totals = strataTotals(idx, level);
    const bAlerts = matched.map((a) => ({ s: lookup.get(a.key), day: dayOf(a), y: a.y, cov: covOf(a) }));
    bAlertsBy[level] = bAlerts;
    totalsBy[level] = totals;
    levels[level] = {
      matched: matched.length, unmatched, share: matched.length / acc.alerts.length,
      A: ATT(matched, 'fwd12'), B: ATT(matched, 'rAtr'),
      balance: covariateBalance({ alerts: bAlerts, totals }),
      bootstrap: procedureBootstrap({ alerts: bAlerts, idx, level, reps, totals }),
    };
  }
  // Fallback: strata + jarak bila ada pembanding, selain itu strata dasar.
  const indexed = acc.alerts.map((a, i) => ({ ...a, i }));
  const byJ = matchAlerts(indexed.map((a) => ({ ...a, key: a.keyJarak })), acc.controls.tanpaJarak).matched;
  const gotJ = new Set(byJ.map((m) => m.i));
  const byBase = matchAlerts(indexed.filter((a) => !gotJ.has(a.i)), acc.controls.tanpa).matched;
  const fallback = [...byJ, ...byBase];
  levels.fallback = { matched: fallback.length, share: fallback.length / acc.alerts.length, fromBase: byBase.length, A: ATT(fallback, 'fwd12'), B: ATT(fallback, 'rAtr') };

  // Karakteristik alert yang tidak cocok pada strata + jarak (dibandingkan dengan yang cocok).
  const un = indexed.filter((a) => !gotJ.has(a.i));
  const ok = indexed.filter((a) => gotJ.has(a.i));
  const share = (list, f) => {
    const m = new Map();
    for (const a of list) m.set(f(a), (m.get(f(a)) ?? 0) + 1);
    return Object.fromEntries([...m].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([k, v]) => [k, v / list.length]));
  };
  const preGroup = (a) => (a.pre < 0 ? '< 0' : a.pre < 2 ? '0–2' : a.pre < 4 ? '2–4' : '≥ 4');
  const profile = (list) => ({
    n: list.length,
    distance: share(list, (a) => distanceBin(a.sincePrev)),
    pre: share(list, preGroup),
    pos: share(list, (a) => (a.pos < 0.6 ? '< 0,6' : a.pos < 0.8 ? '0,6–0,8' : '≥ 0,8')),
    group: share(list, (a) => (DOCS27_IN_UNIVERSE.includes(a.symbol) ? 'koin docs/27' : 'koin tambahan')),
    year: share(list, (a) => new Date(a.t).toISOString().slice(0, 4)),
    atrPctMedian: [...list.map((a) => a.atrPct)].sort((x, y) => x - y)[Math.floor(list.length / 2)] ?? null,
  });
  const unBase = matchAlerts(un, acc.controls.tanpa).matched;
  const unmatchedProfile = {
    unmatched: profile(un), matched: profile(ok),
    // Hasil alert yang tidak cocok bila dicocokkan pada strata dasar (sensitivitas).
    viaBase: { n: unBase.length, A: ATT(unBase, 'fwd12'), B: ATT(unBase, 'rAtr') },
  };
  const windowed = from !== null && to !== null
    ? windowedPower({
      alerts: bAlertsBy.jarak, idx, totals: totalsBy.jarak, from, to, reps, effect: { A: levels.jarak.A.mean, B: levels.jarak.B.mean },
    })
    : null;
  const symbols = new Set(acc.alerts.map((a) => a.symbol)).size;
  return { symbols, alerts: acc.alerts.length, cells: idx.size, strata: idx.strata.size, baseStrata: idx.baseKeys.size, levels, unmatchedProfile, windowed, reps };
}

// ── Serialisasi (gzip JSON) ──
export const serializeOverlapAcc = (acc) => gzipSync(JSON.stringify({
  controls: { tanpa: [...acc.controls.tanpa], tanpaJarak: [...acc.controls.tanpaJarak] },
  alerts: acc.alerts, cells: [...acc.cells],
}));
export function deserializeOverlapAcc(buf) {
  const raw = JSON.parse(gunzipSync(buf).toString('utf8'));
  return {
    controls: { tanpa: new Map(raw.controls.tanpa), tanpaJarak: new Map(raw.controls.tanpaJarak) },
    alerts: raw.alerts, cells: new Map(raw.cells),
  };
}

// ── Markdown ──
const num = (x, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d).replace('.', ',')}`);
const plain = (x, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? '—' : x.toFixed(d).replace('.', ','));
const pctf = (x) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`);
const withCi = (ci, d = 2) => (ci ? `${num(ci.mean, d)} [${num(ci.lo, d)} … ${num(ci.hi, d)}]` : '—');
const shares = (o) => Object.entries(o).map(([k, v]) => `${k} ${pctf(v)}`).join(' · ');

function renderWindowed(w) {
  return [
    '## SE per jendela (strata + jarak): prosedur penuh vs alert saja',
    '',
    '| Jendela | n | SE A penuh · alert saja · himpunan sama | SE B penuh · alert saja · himpunan sama |',
    '| --- | --- | --- | --- |',
    ...[12, 24].flatMap((months) => w.windows[months].map((x) => `| ${months} bln ${x.label} | ${x.n} | `
      + `${plain(x.A.full, 3)} · ${plain(x.A.alertsOnly, 3)} · ${plain(x.A.sameSet, 3)} | ${plain(x.B.full, 3)} · ${plain(x.B.alertsOnly, 3)} · ${plain(x.B.sameSet, 3)} |`)),
    '',
    '| Lama | SE A median: penuh · alert saja (rasio) | SE B median: penuh · alert saja (rasio) |',
    '| --- | --- | --- |',
    ...[12, 24].map((months) => `| ${months} bulan | ${plain(w.summary[months].A.full, 3)} · ${plain(w.summary[months].A.alertsOnly, 3)} (${plain(w.summary[months].A.ratio)}) | `
      + `${plain(w.summary[months].B.full, 3)} · ${plain(w.summary[months].B.alertsOnly, 3)} (${plain(w.summary[months].B.ratio)}) |`),
    '',
    '## Daya uji batas atas dengan SE prosedur penuh (efek = titik strata + jarak)',
    '',
    '| Hasil | Margin | Batas | Daya 12 bln | Daya 24 bln | Bulan untuk daya 80% |',
    '| --- | --- | --- | --- | --- | --- |',
    ...w.power.map((p) => `| ${p.outcome} | ${plain(p.margin)} | ${p.bound} | ${pctf(p.m12)} | ${pctf(p.m24)} | ${p.months80 === null ? '—' : plain(p.months80, 0)} |`),
    '',
    `Superioritas (batas bawah CI 95% > 0, daya 80%): A ${plain(w.mde.A[12], 3)} (12 bln) · ${plain(w.mde.A[24], 3)} (24 bln); B ${plain(w.mde.B[12], 3)} · ${plain(w.mde.B[24], 3)}.`,
    '',
  ];
}

export function renderOverlapMarkdown(r) {
  const L = r.levels;
  const md = [
    '# Diagnostik overlap & bootstrap AL-MOM-01 (bahan desain, belum praregistrasi) — AlphaLens',
    '',
    `Dibuat ${r.generatedAt} · ${r.symbols} simbol semesta AL-SA-ATR-01 · sinyal ${r.from} → ${r.to} · pembanding "tanpa" · ${r.alerts} alert · `
      + `${r.cells.toLocaleString('id-ID')} sel pembanding (strata × hari) · ${r.reps} replikasi, blok 7 hari, benih 7.`,
    '',
    '## Cakupan dan sensitivitas estimand',
    '',
    '| Pencocokan | Alert cocok | A [CI 7 hari, alert saja] | B [CI 7 hari, alert saja] |',
    '| --- | --- | --- | --- |',
    `| Strata dasar | ${L.dasar.matched} (${pctf(L.dasar.share)}) | ${withCi(L.dasar.A)} | ${withCi(L.dasar.B, 3)} |`,
    `| Strata + jarak (overlap) | ${L.jarak.matched} (${pctf(L.jarak.share)}) | ${withCi(L.jarak.A)} | ${withCi(L.jarak.B, 3)} |`,
    `| Fallback (jarak, selain itu dasar) | ${L.fallback.matched} (${pctf(L.fallback.share)}; ${L.fallback.fromBase} lewat dasar) | ${withCi(L.fallback.A)} | ${withCi(L.fallback.B, 3)} |`,
    '',
    '## Alert yang tidak cocok pada strata + jarak',
    '',
    '| Ciri | Tidak cocok | Cocok |',
    '| --- | --- | --- |',
    `| n | ${r.unmatchedProfile.unmatched.n} | ${r.unmatchedProfile.matched.n} |`,
    ...[['distance', 'Jarak dari alert sebelumnya'], ['pre', 'Gerak awal (ATR)'], ['pos', 'Posisi rentang'], ['group', 'Kelompok koin'], ['year', 'Tahun']]
      .map(([k, label]) => `| ${label} | ${shares(r.unmatchedProfile.unmatched[k])} | ${shares(r.unmatchedProfile.matched[k])} |`),
    `| ATR% median | ${plain(r.unmatchedProfile.unmatched.atrPctMedian * 100)}% | ${plain(r.unmatchedProfile.matched.atrPctMedian * 100)}% |`,
    '',
    `Alert tak cocok yang dicocokkan lewat strata dasar (n ${r.unmatchedProfile.viaBase.n}): A ${withCi(r.unmatchedProfile.viaBase.A)}, B ${withCi(r.unmatchedProfile.viaBase.B, 3)}.`,
    '',
    '## Keseimbangan kovariat sesudah pencocokan (SMD)',
    '',
    '| Kovariat | Dasar: alert vs pembanding (SMD) | Strata + jarak: alert vs pembanding (SMD) |',
    '| --- | --- | --- |',
    ...COVARIATES.map((c) => {
      const a = L.dasar.balance[c];
      const b = L.jarak.balance[c];
      return `| ${c} | ${plain(a.alert, 3)} vs ${plain(a.control, 3)} (${num(a.smd, 3)}) | ${plain(b.alert, 3)} vs ${plain(b.control, 3)} (${num(b.smd, 3)}) |`;
    }),
    '',
    '## Bootstrap yang mengulang prosedur vs bootstrap alert saja (bobot hari sama)',
    '',
    '| Pencocokan | Hasil | Titik | CI prosedur penuh | SE penuh | SE alert saja | SE alert saja, himpunan sama | Rasio penuh/alert saja |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...['dasar', 'jarak'].flatMap((lv) => OUT.map(([, k]) => {
      const b = L[lv].bootstrap;
      const f = b.full[k];
      const o = b.alertsOnly[k];
      return `| ${lv} | ${k} | ${num(f.mean, 3)} | [${num(f.lo, 3)} … ${num(f.hi, 3)}] | ${plain(f.se, 4)} | ${plain(o.se, 4)} | ${plain(b.sameSet[k].se, 4)} | ${plain(f.se / o.se, 3)} |`;
    })),
    '',
    `Porsi alert yang tetap punya pembanding di setiap replikasi (strata + jarak): rata-rata ${pctf(L.jarak.bootstrap.matchedShareMean)}, terendah ${pctf(L.jarak.bootstrap.matchedShareMin)}.`,
    '',
    ...(r.windowed ? renderWindowed(r.windowed) : []),
  ];
  return md.join('\n');
}

async function main(argv) {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      from: { type: 'string', default: '2024-01-01' }, to: { type: 'string', default: '2026-10-01' },
      'cache-dir': { type: 'string', default: DEFAULT_CACHE_DIR }, out: { type: 'string', default: join(ROOT, 'reports', 'research') },
      'save-acc': { type: 'string' }, 'load-acc': { type: 'string' }, reps: { type: 'string', default: '2000' },
    },
    strict: true,
  });
  const from = day(v.from, 'from');
  const to = day(v.to, 'to');
  if (from >= to) throw new RangeError('--from harus sebelum --to');
  const reps = Number(v.reps);
  if (!Number.isInteger(reps) || reps < 100) throw new RangeError('--reps harus bilangan bulat ≥ 100');
  const started = Date.now();
  let acc;
  if (v['load-acc']) {
    acc = deserializeOverlapAcc(await readFile(resolve(v['load-acc'])));
  } else {
    const res = await collectMomData({ symbols: AL_SA_ATR_01.universe, from, to, cacheDir: resolve(ROOT, v['cache-dir']), withCells: true });
    if (res.skipped.length) log(`Dilewati: ${res.skipped.join('; ')}`);
    acc = res.acc;
    if (v['save-acc']) {
      await writeFile(resolve(v['save-acc']), serializeOverlapAcc(acc));
      log(`Agregat disimpan → ${resolve(v['save-acc'])}`);
    }
  }
  log(`Analisis: ${acc.alerts.length} alert, ${acc.cells.size} sel pembanding`);
  const result = { generatedAt: new Date(started).toISOString(), from: v.from, to: v.to, ...analyzeOverlap({ acc, reps, from, to }) };
  result.durationS = Math.round((Date.now() - started) / 1000);
  const out = resolve(v.out);
  await mkdir(out, { recursive: true });
  const slug = result.generatedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  await writeFile(join(out, `mom-overlap-${slug}.md`), renderOverlapMarkdown(result), 'utf8');
  await writeFile(join(out, `mom-overlap-${slug}.json`), JSON.stringify(result, null, 2), 'utf8');
  log(`Selesai dalam ${result.durationS} s → ${join(out, `mom-overlap-${slug}.md`)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err) => {
    log(`Diagnostik gagal: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
}
