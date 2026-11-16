// Diagnostik metodologi AL-MOM-01 (docs/29 §14–§19). Riset saja: tidak mengubah runner beku (scripts/research-al-mom-01.js)
// atau desain inti docs/28 §2–§8, dan tidak dipakai untuk memilih metode berdasarkan arah hasil.
//
// Mode:
//   historical  ciri data historis SEBELUM jendela uji (default jendela semu validate 2024-10-01 … 2026-10-01; cache saja,
//               penjaga --to ≤ 2026-11-16): struktur return, alert, strata, dan pasangan alert–pembanding.
//   sim         ciri yang sama pada data sintetis (skenario simulasi coverage) + dekomposisi estimator dan bootstrap:
//               komponen dasar y0 (target populasi TEPAT 0: harga dasar martingale, seleksi hanya dari candle ≤ t) dan
//               komponen drift Δ, pergeseran distribusi bootstrap per komponen/varian/panjang blok, dan probe bobot
//               alert–pembanding terpisah (penggandaan blok yang sama dimatikan).
//   oracle      bias estimator: rata-rata pembanding per strata dari sampel independen (lapisan rezim sama, inovasi lain,
//               leave-one-out), dibandingkan dengan estimator plug-in pada sampel yang sama.
//   landmark    diagnostik landmark waktu keputusan lintas simbol (usulan pelengkap; estimand berbeda).
//   levels      titik estimasi tiap level pembanding docs/28 §4 (utama, dasar, halus, lampau), komponen dasar & drift.
//   describe    ciri DGP saja (return, alert, strata, rezim, pasangan) tanpa bootstrap/CI: kalibrasi skenario docs/29 §21.
//
// Pakai:
//   node scripts/research-al-mom-01-diagnose.js --mode historical
//   node scripts/research-al-mom-01-diagnose.js --mode sim --scenario dasar0 --sims 300 --reps 999
//   node scripts/research-al-mom-01-diagnose.js --mode sim --scenario dasar025 --set delta=0.2946 --sims 300
//   node scripts/research-al-mom-01-diagnose.js --mode oracle --scenario dasar025 --set delta=0.2946 --configs 8 --draws 40

import { availableParallelism } from 'node:os';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { loadFromBinance } from '../backend/backtest/dataSource.js';
import { mulberry32 } from '../backend/backtest/eventStudy.js';
import { replaySeries } from '../backend/backtest/runner.js';
import { atr } from '../backend/indicators/index.js';
import { DAY_MS } from '../backend/research/matchedBaseline.js';
import {
  AL_MOM_01, LEVELS, buildGroup, buildLevelIndex, ciMethodComparison, codeTreeHash, collectSeries, createStore, outcomesAt,
  ratioSeries, runBootstrap,
} from './research-al-mom-01.js';
import * as COV from './research-al-mom-01-coverage.js';
import { RESEARCH_SNAPSHOT_DIR, assertBeforeMomWindow } from './research-window-guard.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const H = 3_600_000;
const FWD_LAGS = [12, 24, 48, 168];
const log = (m) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${m}\n`);

// ── Statistik kecil ──
const meanOf = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sdOf = (a) => {
  if (a.length < 2) return null;
  const m = meanOf(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const quant = (a, p) => {
  const s = Float64Array.from(a.filter(Number.isFinite)).sort();
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))] : null;
};
export function pearson(x, y) {
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let k = 0; k < x.length; k += 1) {
    if (!Number.isFinite(x[k]) || !Number.isFinite(y[k])) continue;
    n += 1;
    sx += x[k];
    sy += y[k];
  }
  if (n < 3) return null;
  const mx = sx / n;
  const my = sy / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let k = 0; k < x.length; k += 1) {
    if (!Number.isFinite(x[k]) || !Number.isFinite(y[k])) continue;
    sxy += (x[k] - mx) * (y[k] - my);
    sxx += (x[k] - mx) ** 2;
    syy += (y[k] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}
const lagCorr = (x, lag) => (x.length > lag + 2 ? pearson(x.subarray(0, x.length - lag), x.subarray(lag)) : null);

// ── Ciri return satu deret ──

/**
 * Akumulator ciri lintas simbol untuk jendela [from, to): return per jam dan per blok 12 jam terstandar per simbol
 * (korelasi rata-rata antarsimbol = Σ_h (S_h² − Q_h) / Σ_h n_h(n_h − 1)), statistik per simbol, dan struktur strata.
 */
export function createAccumulator({ from, to }) {
  const hours = Math.ceil((to - from) / H);
  const blocks = Math.ceil(hours / 12);
  return {
    from, to, hours,
    cross: {
      hS: new Float64Array(hours), hQ: new Float64Array(hours), hN: new Float64Array(hours),
      bS: new Float64Array(blocks), bQ: new Float64Array(blocks), bN: new Float64Array(blocks),
    },
    perSymbol: [],
    alerts: [], // per alert: lihat addStrataStructure
    alertStrata: 0,
    alertsPerStratum: [],
    // Momen hasil pembanding strata ber-alert (tiap pembanding sekali per strata) untuk SD alert vs pembanding.
    ctrlMoments: [0, 0, 0],
    dayCount: new Map(),
    symDayCount: new Map(),
  };
}

/** Ciri return satu simbol: autokorelasi, rasio varians, ACF gerak 12 candle (ATR, jendela tak tumpang tindih). */
export function addReturnStats(acc, candles, atrValues, symbolIndex = 0) {
  const n = candles.length;
  let t0 = -1;
  let t1 = -1;
  for (let t = 1; t < n; t += 1) {
    const ot = candles[t].openTime;
    if (ot >= acc.from && ot < acc.to) {
      if (t0 < 0) t0 = t;
      t1 = t;
    }
  }
  if (t0 < 0 || t1 - t0 < 24 * 30) return null;
  const m = t1 - t0 + 1;
  const r = new Float64Array(m);
  for (let k = 0; k < m; k += 1) r[k] = Math.log(candles[t0 + k].close / candles[t0 + k - 1].close);
  const mu = meanOf(Array.from(r));
  const sd = sdOf(Array.from(r));
  // Blok absolut 12/24/48 jam (selaras dengan acc.from), hanya blok lengkap.
  const blockSums = (len) => {
    const sums = new Map();
    for (let k = 0; k < m; k += 1) {
      const h = Math.floor((candles[t0 + k].openTime - acc.from) / H);
      const b = Math.floor(h / len);
      const cur = sums.get(b) ?? [0, 0];
      cur[0] += r[k];
      cur[1] += 1;
      sums.set(b, cur);
    }
    const keys = [...sums.keys()].filter((b) => sums.get(b)[1] === len).sort((x, y) => x - y);
    return { keys, vals: Float64Array.from(keys, (b) => sums.get(b)[0]) };
  };
  const b12 = blockSums(12);
  const b24 = blockSums(24);
  const b48 = blockSums(48);
  const varOf = (x) => sdOf(Array.from(x)) ** 2;
  const out = {
    sym: symbolIndex, hours: m, sd, acf1: lagCorr(r, 1), acf12h: lagCorr(b12.vals, 1), acf24h: lagCorr(b24.vals, 1),
    vr12: varOf(b12.vals) / (12 * sd * sd), vr48: varOf(b48.vals) / (48 * sd * sd), fwd: {},
  };
  // Gerak 12 candle dalam ATR (rumus hasil A) untuk setiap candle jendela; korelasi pada jarak ≥ 12 (jendela tak tumpang).
  const a = new Float64Array(m);
  for (let k = 0; k < m; k += 1) {
    const t = t0 + k;
    a[k] = t + 12 < n && atrValues[t] > 0 ? (candles[t + 12].close - candles[t].close) / atrValues[t] : NaN;
  }
  for (const L of FWD_LAGS) out.fwd[L] = lagCorr(a, L);
  // Lintas simbol.
  if (sd > 0) {
    const C = acc.cross;
    for (let k = 0; k < m; k += 1) {
      const h = Math.floor((candles[t0 + k].openTime - acc.from) / H);
      const z = (r[k] - mu) / sd;
      C.hS[h] += z;
      C.hQ[h] += z * z;
      C.hN[h] += 1;
    }
    const bm = meanOf(Array.from(b12.vals));
    const bs = sdOf(Array.from(b12.vals));
    if (bs > 0) {
      b12.keys.forEach((b, j) => {
        const z = (b12.vals[j] - bm) / bs;
        C.bS[b] += z;
        C.bQ[b] += z * z;
        C.bN[b] += 1;
      });
    }
  }
  acc.perSymbol.push(out);
  return out;
}

/** Korelasi rata-rata antarsimbol dari akumulator terstandar (opsional hanya jam dengan keep(h) benar). */
export function crossCorrelation(S, Q, N, keep = null) {
  let num = 0;
  let den = 0;
  for (let h = 0; h < S.length; h += 1) {
    if (N[h] < 2 || (keep && !keep(h))) continue;
    num += S[h] * S[h] - Q[h];
    den += N[h] * (N[h] - 1);
  }
  return den > 0 ? num / den : null;
}

// ── Struktur strata & pasangan ──

/** Rekaman candle satu simbol (dari onRecord collectSeries) dengan dua kanal hasil: y (A) dan d (komponen drift; 0 di data nyata). */
export function newRecords() {
  return { i: [], day: [], code: [], alert: [], tanpa: [], y: [], d: [] };
}
export function pushRecord(rec, r, y, d) {
  rec.i.push(r.i);
  rec.day.push(r.day);
  rec.code.push(r.code.jarak);
  rec.alert.push(r.isAlert ? 1 : 0);
  rec.tanpa.push(r.isTanpa ? 1 : 0);
  rec.y.push(y);
  rec.d.push(d);
}

/**
 * Per alert v3 (strata utama "jarak"): jumlah pembanding strata, hari berbeda, porsi pembanding pada hari yang sama,
 * ±3 hari, dan yang jendela 12 candle-nya tumpang tindih dengan alert (|Δi| ≤ 11); posisi pembanding terhadap alert:
 * 1–12 candle SEBELUM (jendela hasilnya memuat gerak pemicu), 1–12 SESUDAH, dan lainnya. Deskriptif saja: pembagian
 * posisi memakai waktu alert, jadi TIDAK boleh dipakai sebagai estimator (docs/29 §18).
 */
export function addStrataStructure(acc, rec, sym = 0) {
  const n = rec.i.length;
  const alertsByCode = new Map();
  for (let k = 0; k < n; k += 1) {
    if (!rec.alert[k]) continue;
    const c = rec.code[k];
    if (!alertsByCode.has(c)) alertsByCode.set(c, []);
    alertsByCode.get(c).push(k);
    acc.dayCount.set(rec.day[k], (acc.dayCount.get(rec.day[k]) ?? 0) + 1);
    const sd = `${sym}:${rec.day[k]}`;
    acc.symDayCount.set(sd, (acc.symDayCount.get(sd) ?? 0) + 1);
  }
  const ctrl = new Map();
  for (let k = 0; k < n; k += 1) {
    if (!rec.tanpa[k] || !alertsByCode.has(rec.code[k])) continue;
    const c = rec.code[k];
    if (!ctrl.has(c)) ctrl.set(c, []);
    ctrl.get(c).push(k);
  }
  for (const [code, list] of alertsByCode) {
    const cs = ctrl.get(code) ?? [];
    acc.alertStrata += 1;
    for (const kc of cs) {
      acc.ctrlMoments[0] += 1;
      acc.ctrlMoments[1] += rec.y[kc];
      acc.ctrlMoments[2] += rec.y[kc] * rec.y[kc];
    }
    acc.alertsPerStratum.push(list.length);
    const days = new Set(cs.map((k) => rec.day[k])).size;
    for (const ka of list) {
      const ia = rec.i[ka];
      const da = rec.day[ka];
      const row = { matched: cs.length > 0, N: cs.length, days, y: rec.y[ka], d: rec.d[ka], day: da };
      if (cs.length) {
        let nDay = 0;
        let nWeek = 0;
        let nNear = 0;
        let nPre = 0;
        let nPost = 0;
        const s = { all: [0, 0], day: [0, 0], pre: [0, 0], post: [0, 0], far: [0, 0] };
        for (const kc of cs) {
          const ic = rec.i[kc];
          const dc = rec.day[kc];
          const y = rec.y[kc];
          const d = rec.d[kc];
          s.all[0] += y;
          s.all[1] += d;
          if (dc === da) {
            nDay += 1;
            s.day[0] += y;
            s.day[1] += d;
          }
          if (Math.abs(dc - da) <= 3) nWeek += 1;
          if (Math.abs(ic - ia) <= 11) nNear += 1;
          if (ic < ia && ic >= ia - 12) {
            nPre += 1;
            s.pre[0] += y;
            s.pre[1] += d;
          } else if (ic > ia && ic <= ia + 12) {
            nPost += 1;
            s.post[0] += y;
            s.post[1] += d;
          } else {
            s.far[0] += y;
            s.far[1] += d;
          }
        }
        const N = cs.length;
        Object.assign(row, {
          shareDay: nDay / N, shareWeek: nWeek / N, shareNear: nNear / N, sharePre: nPre / N, sharePost: nPost / N,
          m: s.all[0] / N, mD: s.all[1] / N, mDay: nDay ? s.day[0] / nDay : NaN,
          // Kontribusi ke rata-rata pembanding m (jumlahnya = m): Σ_posisi y / N.
          cPre: s.pre[0] / N, cPost: s.post[0] / N, cFar: s.far[0] / N, cPreD: s.pre[1] / N, cPostD: s.post[1] / N, cFarD: s.far[1] / N,
          nPre, nPost, sPre: s.pre[0], sPost: s.post[0], sFar: s.far[0], nFar: N - nPre - nPost,
        });
      }
      acc.alerts.push(row);
    }
  }
}

/**
 * Ciri rezim pasar (docs/29 §21, kalibrasi skenario "rezim padat"), tanpa hasil apa pun: hari diurutkan menurut
 * volatilitas pasar harian √Σ_h m_h² (m_h = rata-rata return terstandar antarsimbol pada jam h); `topShare` hari teratas
 * = hari bergejolak. Dibandingkan: korelasi antarsimbol 1 jam, porsi alert (konsentrasi), dan porsi alert berpembanding.
 */
export function regimeCharacter(acc, D, topShare = 0.15) {
  const C = acc.cross;
  const day0 = Math.floor(acc.from / DAY_MS);
  const vol = new Float64Array(D);
  const hoursIn = new Float64Array(D);
  for (let h = 0; h < C.hS.length; h += 1) {
    if (C.hN[h] < 2) continue;
    const d = Math.floor((acc.from + h * H) / DAY_MS) - day0;
    if (d < 0 || d >= D) continue;
    const m = C.hS[h] / C.hN[h];
    vol[d] += m * m;
    hoursIn[d] += 1;
  }
  const valid = [...Array(D).keys()].filter((d) => hoursIn[d] >= 12);
  if (valid.length < 20) return null;
  const inValid = new Set(valid);
  const dayOfHour = (h) => Math.floor((acc.from + h * H) / DAY_MS) - day0;
  const alertsOn = new Float64Array(D);
  for (const r of acc.alerts) if (inValid.has(r.day - day0)) alertsOn[r.day - day0] += 1;
  // Korelasi subset = kovarians rata-rata antarpasangan ÷ varians rata-rata pada subset yang sama (return distandarkan
  // dengan SD seluruh sampel, jadi pembagian dengan varians subset perlu agar hari bergejolak tidak tampak "> 1").
  const corrOn = (days) => {
    let num = 0;
    let pairs = 0;
    let q = 0;
    let n = 0;
    for (let h = 0; h < C.hS.length; h += 1) {
      if (C.hN[h] < 2 || !days.has(dayOfHour(h))) continue;
      num += C.hS[h] * C.hS[h] - C.hQ[h];
      pairs += C.hN[h] * (C.hN[h] - 1);
      q += C.hQ[h];
      n += C.hN[h];
    }
    return pairs > 0 && q > 0 ? (num / pairs) / (q / n) : null;
  };
  const split = (score) => {
    const sorted = [...valid].sort((a, b) => score[b] - score[a] || a - b);
    const top = new Set(sorted.slice(0, Math.max(1, Math.round(valid.length * topShare))));
    const rest = new Set(valid.filter((d) => !top.has(d)));
    const aTop = acc.alerts.filter((r) => top.has(r.day - day0));
    const aRest = acc.alerts.filter((r) => rest.has(r.day - day0));
    const share = (list) => (list.length ? list.filter((r) => r.matched).length / list.length : null);
    const volTop = meanOf([...top].map((d) => Math.sqrt(vol[d])));
    const volRest = meanOf([...rest].map((d) => Math.sqrt(vol[d])));
    const corrTop = corrOn(top);
    const corrRest = corrOn(rest);
    const nAll = aTop.length + aRest.length;
    return {
      volRatio: volRest > 0 ? volTop / volRest : null, corrTop, corrRest, corrRatio: corrRest > 0 ? corrTop / corrRest : null,
      alertShareTop: nAll ? aTop.length / nAll : null, alertConcentration: nAll ? aTop.length / nAll / (top.size / valid.length) : null,
      matchedTop: share(aTop), matchedRest: share(aRest),
      controlsTop: meanOf(aTop.filter((r) => r.matched).map((r) => r.N)), controlsRest: meanOf(aRest.filter((r) => r.matched).map((r) => r.N)),
    };
  };
  // Datar (rata-rata antar-simulasi per kunci): vol* = hari bergejolak, alert* = hari padat alert.
  const prefix = (p, o) => Object.fromEntries(Object.entries(o).map(([k, x]) => [`${p}${k[0].toUpperCase()}${k.slice(1)}`, x]));
  return { topShare, days: valid.length, corrAll: corrOn(inValid), ...prefix('vol', split(vol)), ...prefix('alert', split(alertsOn)) };
}

/** Ringkasan ciri dari akumulator (D = jumlah hari jendela). */
export function summarizeAccumulator(acc, D) {
  const ps = acc.perSymbol;
  const avg = (f) => meanOf(ps.map(f).filter(Number.isFinite));
  const all = acc.alerts;
  const mt = all.filter((r) => r.matched);
  const col = (f) => mt.map(f);
  const daily = new Array(D).fill(0);
  const day0 = Math.floor(acc.from / DAY_MS);
  for (const [d, c] of acc.dayCount) if (d - day0 >= 0 && d - day0 < D) daily[d - day0] += c;
  const dm = meanOf(daily);
  const dv = sdOf(daily) ** 2;
  const sortedDaily = [...daily].sort((x, y) => y - x);
  const top = sortedDaily.slice(0, Math.max(1, Math.round(D * 0.1))).reduce((s, x) => s + x, 0);
  const totalAlerts = daily.reduce((s, x) => s + x, 0);
  const symDays = [...acc.symDayCount.values()];
  const sum = (f) => mt.reduce((s, r) => s + f(r), 0);
  const C = acc.cross;
  return {
    symbols: ps.length,
    returns: {
      crossCorr1h: crossCorrelation(C.hS, C.hQ, C.hN), crossCorr12h: crossCorrelation(C.bS, C.bQ, C.bN),
      acf1h: avg((s) => s.acf1), acf12h: avg((s) => s.acf12h), acf24h: avg((s) => s.acf24h), vr12: avg((s) => s.vr12), vr48: avg((s) => s.vr48),
      fwdAcf: Object.fromEntries(FWD_LAGS.map((L) => [L, avg((s) => s.fwd[L])])),
    },
    alerts: {
      total: all.length, matched: mt.length, matchedShare: all.length ? mt.length / all.length : null,
      perSymbolYear: ps.length ? all.length / ps.length / (D / 365.25) : null,
      dailyDispersion: dm > 0 ? dv / dm : null, top10DayShare: totalAlerts ? top / totalAlerts : null,
      perActiveSymbolDay: meanOf(symDays),
    },
    strata: {
      alertStrata: acc.alertStrata, alertsPerStratum: meanOf(acc.alertsPerStratum),
      controlsMedian: quant(col((r) => r.N), 0.5), controlsMean: meanOf(col((r) => r.N)), controlsP10: quant(col((r) => r.N), 0.1), controlsP90: quant(col((r) => r.N), 0.9),
      controlDaysMedian: quant(col((r) => r.days), 0.5), controlDaysMean: meanOf(col((r) => r.days)),
      shareSameDay: meanOf(col((r) => r.shareDay)), shareWeek: meanOf(col((r) => r.shareWeek)), shareOverlap: meanOf(col((r) => r.shareNear)),
      sharePre: meanOf(col((r) => r.sharePre)), sharePost: meanOf(col((r) => r.sharePost)),
    },
    regime: regimeCharacter(acc, D),
    pairing: {
      alertSd: sdOf(col((r) => r.y)),
      controlSd: acc.ctrlMoments[0] > 1 ? Math.sqrt(Math.max(0, (acc.ctrlMoments[2] - acc.ctrlMoments[1] ** 2 / acc.ctrlMoments[0]) / (acc.ctrlMoments[0] - 1))) : null,
      corrYM: pearson(col((r) => r.y), col((r) => r.m)),
      corrYMDay: pearson(col((r) => r.y), col((r) => r.mDay)), withSameDay: mt.filter((r) => Number.isFinite(r.mDay)).length,
    },
    // Dekomposisi titik: θ̂ = Ȳ_alert − C̄, C̄ = kontribusi pembanding sebelum + sesudah + lainnya (deskriptif).
    estimator: {
      point: mt.length ? meanOf(col((r) => r.y - r.m)) : null, alertMean: meanOf(col((r) => r.y)), controlMean: meanOf(col((r) => r.m)),
      cPre: meanOf(col((r) => r.cPre)), cPost: meanOf(col((r) => r.cPost)), cFar: meanOf(col((r) => r.cFar)),
      meanPreControl: sum((r) => r.nPre) ? sum((r) => r.sPre) / sum((r) => r.nPre) : null,
      meanPostControl: sum((r) => r.nPost) ? sum((r) => r.sPost) / sum((r) => r.nPost) : null,
      meanFarControl: sum((r) => r.nFar) ? sum((r) => r.sFar) / sum((r) => r.nFar) : null,
      drift: { alertMean: meanOf(col((r) => r.d)), controlMean: meanOf(col((r) => r.mD)), cPre: meanOf(col((r) => r.cPreD)), cPost: meanOf(col((r) => r.cPostD)), cFar: meanOf(col((r) => r.cFarD)) },
    },
  };
}

// ── Bootstrap: pergeseran per komponen & probe bobot terpisah ──

/** Pergeseran distribusi bootstrap terhadap titik: median & rata-rata replikasi, dalam satuan SE replikasi. */
export function shiftStats(values, point) {
  const s = Float64Array.from(Array.from(values).filter(Number.isFinite)).sort();
  if (!s.length) return null;
  const mean = s.reduce((x, y) => x + y, 0) / s.length;
  const se = Math.sqrt(s.reduce((acc, x) => acc + (x - mean) ** 2, 0) / Math.max(1, s.length - 1));
  const med = s[Math.floor(0.5 * s.length)];
  return { se, mean, median: med, meanShift: mean - point, medShift: med - point, meanShiftSe: se > 0 ? (mean - point) / se : null, medShiftSe: se > 0 ? (med - point) / se : null, invalid: values.length - s.length };
}

/**
 * Moving-block bootstrap prosedur penuh dengan bobot hari alert dan pembanding dari dua aliran acak. coupled = true
 * memakai SATU aliran untuk keduanya (identik dengan runBootstrap runner, benih sama); coupled = false memutus
 * penggandaan alert dan pembanding di blok yang sama (probe mekanisme; bukan metode kandidat).
 */
export function probeBootstrap({ index, group, D, blockDays, reps, seed, coupled }) {
  const L = Math.max(1, Math.min(blockDays, D));
  const nBlocks = Math.ceil(D / L);
  const lastLen = D - (nBlocks - 1) * L;
  const starts = D - L + 1;
  const rndA = mulberry32(seed);
  const rndC = coupled ? null : mulberry32(seed ^ 0x5bd1e995);
  const wA = new Float64Array(D);
  const wC = coupled ? wA : new Float64Array(D);
  const N = new Float64Array(index.m);
  const SA = new Float64Array(index.m);
  const out = new Float64Array(reps);
  const draw = (w, rnd) => {
    w.fill(0);
    for (let b = 0; b < nBlocks; b += 1) {
      const st = Math.floor(rnd() * starts);
      const len = b === nBlocks - 1 ? lastLen : L;
      for (let d = st; d < st + len; d += 1) w[d] += 1;
    }
  };
  for (let r = 0; r < reps; r += 1) {
    draw(wA, rndA);
    if (!coupled) draw(wC, rndC);
    N.fill(0);
    SA.fill(0);
    for (let d = 0; d < D; d += 1) {
      const wd = wC[d];
      if (wd === 0) continue;
      for (let j = index.dayStart[d]; j < index.dayStart[d + 1]; j += 1) {
        const s = index.cSid[j];
        N[s] += wd * index.cN[j];
        SA[s] += wd * index.cA[j];
      }
    }
    let fa = 0;
    let fw = 0;
    for (let k = 0; k < group.n; k += 1) {
      const wa = wA[group.day[k]];
      if (wa === 0) continue;
      const s = group.sid[k];
      if (N[s] > 0) {
        fa += wa * (group.yA[k] - SA[s] / N[s]);
        fw += wa;
      }
    }
    out[r] = fw > 0 ? fa / fw : NaN;
  }
  return out;
}

// ── Satu dataset sintetis ──

const scenarioOf = (name, set = {}) => {
  const base = COV.SCENARIOS[name];
  if (!base) throw new RangeError(`skenario tidak dikenal: ${name}`);
  return { ...base, ...set };
};

/**
 * Analisis diagnostik satu dataset sintetis: ciri (seperti historis), dekomposisi titik y = y0 + Δ, dan bootstrap
 * (slot A = y penuh, slot B = Δ dengan bobot sama, jadi y0* = A* − B* per replikasi).
 */
export function diagnoseSimulation(sc, seed, reps, { blocks = [7, 1, 14], probe = true } = {}) {
  const win = COV.simWindow(sc);
  const store = createStore({ withOutcomes: true });
  const acc = createAccumulator({ from: win.from, to: win.to });
  COV.simulateMarket(sc, seed, (s, sym) => {
    const A = atr(s.candles, AL_MOM_01.atrPeriod);
    addReturnStats(acc, s.candles, A, sym);
    const rec = newRecords();
    const cum = s.cumDrift;
    let lastI = -1;
    let lastY = null;
    collectSeries({
      store, sym, symbol: s.symbol, candles: s.candles, v3Idx: s.v3Idx, anyIdx: s.anyIdx, window: win,
      outcomeFn: (c, at, i, cfg) => {
        const y = outcomesAt(c, at, i, cfg);
        lastI = i;
        lastY = y ? { A: y.A, B: (cum[i + cfg.look] - cum[i]) / at[i] } : null;
        return lastY;
      },
      onRecord: (r) => {
        if (r.i === lastI && lastY) pushRecord(rec, r, lastY.A, lastY.B);
      },
    });
    addStrataStructure(acc, rec, sym);
  });
  const dayFrom = Math.floor(win.from / DAY_MS);
  const D = Math.floor((win.to - 1) / DAY_MS) + 1 - dayFrom;
  const character = summarizeAccumulator(acc, D);
  const main = store.alerts.filter((a) => (store.strata.jarak.get(a.code.jarak)?.[0] ?? 0) > 0);
  const out = { seed, character, n: main.length };
  if (!main.length) return { ...out, failed: 'tidak ada alert berpembanding' };
  const t = (a) => store.strata.jarak.get(a.code.jarak);
  const yBar = meanOf(main.map((a) => a.y.A));
  const cBar = meanOf(main.map((a) => t(a)[1] / t(a)[0]));
  const dBar = meanOf(main.map((a) => a.y.B));
  const cdBar = meanOf(main.map((a) => t(a)[2] / t(a)[0]));
  out.point = { full: yBar - cBar, drift: dBar - cdBar, base: yBar - dBar - (cBar - cdBar), alertBase: yBar - dBar, controlBase: cBar - cdBar, alertDrift: dBar, controlDrift: cdBar };
  const index = buildLevelIndex({ store, level: 'jarak', alerts: main, dayFrom, D });
  out.boot = {};
  for (const L of blocks) {
    const b = runBootstrap({
      D, blockDays: L, reps, seed: AL_MOM_01.seed, indexes: { jarak: index },
      groups: [buildGroup({ name: 'main', index, alerts: main, dayFrom, variants: L === 7 })],
    });
    const g = b.groups[0];
    const full = ratioSeries(g.full.a, g.full.w);
    const res = { full: shiftStats(full, out.point.full) };
    if (L === 7) {
      const drift = ratioSeries(g.full.b, g.full.w);
      const base = full.map((x, k) => x - drift[k]);
      res.drift = shiftStats(drift, out.point.drift);
      res.base = shiftStats(base, out.point.base);
      res.fixedPop = shiftStats(ratioSeries(g.fixedPop.a, g.fixedPop.w), out.point.full);
      res.sameSet = shiftStats(ratioSeries(g.sameSet.a, g.sameSet.w), out.point.full);
      res.alertsOnly = shiftStats(ratioSeries(g.alertsOnly.a, g.alertsOnly.w), out.point.full);
      const cm = ciMethodComparison(full, out.point.full);
      res.ci = { percentile: cm.percentile, basic: cm.basic, bc: cm.bc, z0: cm.z0 };
      if (probe) {
        const group = buildGroup({ name: 'probe', index, alerts: main, dayFrom });
        const coupled = probeBootstrap({ index, group, D, blockDays: 7, reps, seed: AL_MOM_01.seed, coupled: true });
        res.probeCoupledMatches = coupled.every((x, k) => (Number.isNaN(x) && Number.isNaN(full[k])) || Math.abs(x - full[k]) < 1e-12);
        res.decoupled = shiftStats(probeBootstrap({ index, group, D, blockDays: 7, reps, seed: AL_MOM_01.seed, coupled: false }), out.point.full);
      }
    }
    out.boot[L] = res;
  }
  return out;
}

// ── Diagnostik landmark waktu keputusan (usulan docs/29 §18; BUKAN estimand utama) ──

/** Uraikan kode strata utama (baseCode × 3 + jarak) → bin gerak awal 0,5 ATR, posisi, jarak. */
export function decodeJarak(code) {
  const distIdx = code % 3;
  const b = Math.floor(code / 3);
  const b2 = Math.floor(b / 3);
  const posB = b2 % 5;
  const preIdx = Math.floor(b2 / 5) % 64;
  return { preIdx, posB, distIdx };
}

/**
 * Pembanding landmark lintas simbol: untuk alert simbol X pada jam t, pembanding = candle "tanpa" simbol LAIN pada jam
 * yang SAMA dengan sel fitur sama (gerak awal bin 1 ATR, posisi 0,2, jarak 3 bin). Keanggotaan sel dan keberadaan
 * pembanding hanya ditentukan informasi ≤ t; jendela hasil pembanding = jendela hasil alert. Di bawah H0 martingale
 * estimator ini tak bias secara eksak. Estimand-nya BERBEDA dari docs/28 (perbandingan lintas simbol pada waktu sama).
 */
export function landmarkSimulation(sc, seed) {
  const win = COV.simWindow(sc);
  const cells = new Map(); // jam × sel → [n, Σy, ΣΔ]
  const alerts = []; // [kunci, y, Δ]
  const plug = createStore({ withOutcomes: true });
  COV.simulateMarket(sc, seed, (s, sym) => {
    const cum = s.cumDrift;
    let lastI = -1;
    let lastY = null;
    collectSeries({
      store: plug, sym, symbol: s.symbol, candles: s.candles, v3Idx: s.v3Idx, anyIdx: s.anyIdx, window: win,
      outcomeFn: (c, at, i, cfg) => {
        const y = outcomesAt(c, at, i, cfg);
        lastI = i;
        lastY = y ? { A: y.A, B: (cum[i + cfg.look] - cum[i]) / at[i] } : null;
        return lastY;
      },
      onRecord: (r) => {
        if (r.i !== lastI || !lastY) return;
        const { preIdx, posB, distIdx } = decodeJarak(r.code.jarak);
        const key = Math.floor((r.openTime - win.from) / H) * 1000 + Math.floor(preIdx / 2) * 15 + posB * 3 + distIdx;
        if (r.isAlert) alerts.push([key, lastY.A, lastY.B]);
        else if (r.isTanpa) {
          let v = cells.get(key);
          if (!v) {
            v = [0, 0, 0];
            cells.set(key, v);
          }
          v[0] += 1;
          v[1] += lastY.A;
          v[2] += lastY.B;
        }
      },
    });
  });
  let n = 0;
  let sy = 0;
  let sd = 0;
  let nCtrl = 0;
  for (const [key, y, d] of alerts) {
    const v = cells.get(key);
    if (!v) continue;
    n += 1;
    sy += y - v[1] / v[0];
    sd += d - v[2] / v[0];
    nCtrl += v[0];
  }
  const main = plug.alerts.filter((a) => (plug.strata.jarak.get(a.code.jarak)?.[0] ?? 0) > 0);
  const t = (a) => plug.strata.jarak.get(a.code.jarak);
  return {
    seed, alerts: alerts.length, matched: n, share: alerts.length ? n / alerts.length : null, controlsPerAlert: n ? nCtrl / n : null,
    lx: n ? { full: sy / n, drift: sd / n, base: (sy - sd) / n } : null,
    primary: main.length ? { full: meanOf(main.map((a) => a.y.A - t(a)[1] / t(a)[0])), drift: meanOf(main.map((a) => a.y.B - t(a)[2] / t(a)[0])) } : null,
  };
}

// ── Titik per level pembanding docs/28 §4 (utama, dasar, halus, lampau) ──

/** Titik estimasi tiap level pembanding untuk komponen penuh dan drift (tanpa bootstrap). */
export function levelsSimulation(sc, seed) {
  const win = COV.simWindow(sc);
  const store = createStore({ withOutcomes: true });
  COV.simulateMarket(sc, seed, (s, sym) => {
    const cum = s.cumDrift;
    collectSeries({
      store, sym, symbol: s.symbol, candles: s.candles, v3Idx: s.v3Idx, anyIdx: s.anyIdx, window: win,
      outcomeFn: (c, at, i, cfg) => {
        const y = outcomesAt(c, at, i, cfg);
        return y ? { A: y.A, B: (cum[i + cfg.look] - cum[i]) / at[i] } : null;
      },
    });
  });
  return Object.fromEntries(LEVELS.map((l) => {
    const m = store.alerts.filter((a) => (store.strata[l].get(a.code[l])?.[0] ?? 0) > 0);
    const t = (a) => store.strata[l].get(a.code[l]);
    return [l, m.length ? { full: meanOf(m.map((a) => a.y.A - t(a)[1] / t(a)[0])), drift: meanOf(m.map((a) => a.y.B - t(a)[2] / t(a)[0])), share: m.length / store.alerts.length } : null];
  }));
}

// ── Oracle: rata-rata strata dari sampel independen ──

/**
 * Satu draw oracle: semua sel strata utama (n, Σy0, ΣΔ) dan alert berpembanding (kode, y0, Δ, n & jumlah sel sendiri).
 * Butuh simulateMarket dengan `innovationSeed` (lapisan rezim dari `seed`, inovasi dari `innovationSeed`).
 */
export function oracleDraw(sc, seed, innovationSeed) {
  if (!COV.SUPPORTS_INNOVATION_SEED) throw new Error('simulateMarket belum mendukung innovationSeed');
  const win = COV.simWindow(sc);
  const cells = new Map();
  const alerts = [];
  COV.simulateMarket(sc, seed, (s, sym) => {
    const cum = s.cumDrift;
    const store = createStore({ withOutcomes: true });
    const rec = newRecords();
    let lastI = -1;
    let lastY = null;
    collectSeries({
      store, sym, symbol: s.symbol, candles: s.candles, v3Idx: s.v3Idx, anyIdx: s.anyIdx, window: win,
      outcomeFn: (c, at, i, cfg) => {
        const y = outcomesAt(c, at, i, cfg);
        lastI = i;
        lastY = y ? { A: y.A, B: (cum[i + cfg.look] - cum[i]) / at[i] } : null;
        return lastY;
      },
      onRecord: (r) => {
        if (r.i === lastI && lastY) pushRecord(rec, r, lastY.A, lastY.B);
      },
    });
    const own = new Map();
    for (let k = 0; k < rec.i.length; k += 1) {
      if (!rec.tanpa[k]) continue;
      const c = rec.code[k];
      let v = own.get(c);
      if (!v) {
        v = [0, 0, 0];
        own.set(c, v);
      }
      v[0] += 1;
      v[1] += rec.y[k] - rec.d[k];
      v[2] += rec.d[k];
    }
    for (const [c, v] of own) cells.set(c, v);
    // Semua alert (juga yang tak cocok di draw sendiri: n sendiri 0), supaya oracle bisa memakai populasi overlap
    // populasi (sel punya pembanding di draw lain) tanpa seleksi overlap ex-post.
    for (let k = 0; k < rec.i.length; k += 1) {
      if (!rec.alert[k]) continue;
      const v = own.get(rec.code[k]) ?? [0, 0, 0];
      alerts.push([rec.code[k], rec.y[k] - rec.d[k], rec.d[k], v[0], v[1], v[2]]);
    }
  }, { innovationSeed });
  const codes = Float64Array.from(cells.keys());
  const vals = new Float64Array(codes.length * 3);
  let j = 0;
  for (const v of cells.values()) {
    vals[j] = v[0];
    vals[j + 1] = v[1];
    vals[j + 2] = v[2];
    j += 3;
  }
  return { codes, vals, alerts: Float64Array.from(alerts.flat()) };
}

/**
 * Gabungkan draw satu konfigurasi rezim, per draw:
 *   plug-in       — alert cocok di draw sendiri, rata-rata pembanding sel sendiri (estimator docs/28);
 *   oracle cocok  — alert yang sama, rata-rata pembanding sel dari draw LAIN (leave-one-out);
 *   oracle semua  — semua alert yang sel-nya punya pembanding di draw lain (populasi overlap tanpa seleksi ex-post).
 */
export function oracleCombine(draws) {
  const pool = new Map();
  for (const d of draws) {
    for (let k = 0; k < d.codes.length; k += 1) {
      const c = d.codes[k];
      let v = pool.get(c);
      if (!v) {
        v = [0, 0, 0];
        pool.set(c, v);
      }
      v[0] += d.vals[3 * k];
      v[1] += d.vals[3 * k + 1];
      v[2] += d.vals[3 * k + 2];
    }
  }
  return draws.map((d) => {
    const a = d.alerts;
    let n = 0;
    let nOr = 0;
    let nAll = 0;
    let nTot = 0;
    const plug = [0, 0];
    const orc = [0, 0];
    const plugSub = [0, 0];
    const alertMean = [0, 0];
    const all = [0, 0];
    const allAlerts = [0, 0];
    for (let k = 0; k < a.length; k += 6) {
      const [code, y0, dl, on, os0, osd] = [a[k], a[k + 1], a[k + 2], a[k + 3], a[k + 4], a[k + 5]];
      nTot += 1;
      allAlerts[0] += y0;
      allAlerts[1] += dl;
      const p = pool.get(code) ?? [0, 0, 0];
      const ln = p[0] - on;
      if (ln > 0) {
        nAll += 1;
        all[0] += y0 - (p[1] - os0) / ln;
        all[1] += dl - (p[2] - osd) / ln;
      }
      if (on === 0) continue;
      n += 1;
      plug[0] += y0 - os0 / on;
      plug[1] += dl - osd / on;
      alertMean[0] += y0;
      alertMean[1] += dl;
      if (ln > 0) {
        nOr += 1;
        orc[0] += y0 - (p[1] - os0) / ln;
        orc[1] += dl - (p[2] - osd) / ln;
        plugSub[0] += y0 - os0 / on;
        plugSub[1] += dl - osd / on;
      }
    }
    return {
      n, nOracle: nOr, nAll, nTotal: nTot, plugBase: n ? plug[0] / n : null, plugDrift: n ? plug[1] / n : null,
      alertBase: n ? alertMean[0] / n : null, alertDrift: n ? alertMean[1] / n : null,
      allAlertBase: nTot ? allAlerts[0] / nTot : null, allAlertDrift: nTot ? allAlerts[1] / nTot : null,
      oracleBase: nOr ? orc[0] / nOr : null, oracleDrift: nOr ? orc[1] / nOr : null,
      oracleAllBase: nAll ? all[0] / nAll : null, oracleAllDrift: nAll ? all[1] / nAll : null,
      plugSubBase: nOr ? plugSub[0] / nOr : null, plugSubDrift: nOr ? plugSub[1] / nOr : null,
    };
  });
}

// ── Historis ──

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

/** Ciri data historis (penjaga jendela lebih dulu, sebelum I/O apa pun). */
export async function historical({ from, to, cacheDir, replayCache }) {
  assertBeforeMomWindow(to);
  const cfg = AL_MOM_01;
  const win = { from, to: to - cfg.settleBars * H };
  const loadFrom = from - cfg.warmupDays * DAY_MS;
  let replay;
  try {
    replay = JSON.parse(await readFile(replayCache, 'utf8'));
  } catch {
    replay = {};
  }
  const store = createStore({ withOutcomes: true });
  const acc = createAccumulator({ from: win.from, to: win.to });
  // Kelayakan landmark lintas simbol (§18): HANYA hitungan pembanding, tanpa hasil.
  const lxCells = new Map();
  const lxAlerts = [];
  for (const [sym, symbol] of cfg.universe.entries()) {
    const first = await firstCachedMonth(cacheDir, symbol);
    if (first === null) {
      log(`${symbol}: tidak ada di cache`);
      continue;
    }
    const { candles } = await loadFromBinance({ symbol, timeframe: '1h', from: Math.max(loadFrom, first), to, cacheDir });
    if (!candles.length || candles.at(-1).openTime >= to) throw new Error(`${symbol}: data di luar batas`);
    const key = `${symbol}|${candles.length}|${candles[0].openTime}|${candles.at(-1).openTime}`;
    if (!replay[key]) {
      const res = await replaySeries({ symbol, timeframe: '1h', byTf: { '1h': candles } });
      const v3 = res.trades.v3.filter((x) => x.direction === 'LONG').map((x) => x.entryIndex);
      const v2 = res.trades.v2.filter((x) => x.direction === 'LONG').map((x) => x.entryIndex);
      replay[key] = { v3, any: [...new Set([...v2, ...v3])].sort((a, b) => a - b) };
    }
    const A = atr(candles, cfg.atrPeriod);
    addReturnStats(acc, candles, A, sym);
    const rec = newRecords();
    let lastI = -1;
    let lastY = null;
    collectSeries({
      store, sym, symbol, candles, v3Idx: replay[key].v3, anyIdx: replay[key].any, window: win,
      outcomeFn: (c, at, i, cf) => {
        lastY = outcomesAt(c, at, i, cf);
        lastI = i;
        return lastY;
      },
      onRecord: (r) => {
        if (r.i === lastI && lastY) pushRecord(rec, r, lastY.A, 0);
        const { preIdx, posB, distIdx } = decodeJarak(r.code.jarak);
        const key = Math.floor((r.openTime - win.from) / H) * 1000 + Math.floor(preIdx / 2) * 15 + posB * 3 + distIdx;
        if (r.isAlert) lxAlerts.push(key);
        else if (r.isTanpa) lxCells.set(key, (lxCells.get(key) ?? 0) + 1);
      },
    });
    addStrataStructure(acc, rec, sym);
    log(`${symbol}: ${candles.length} candle, alert ${rec.alert.reduce((s, x) => s + x, 0)}`);
  }
  await writeFile(replayCache, JSON.stringify(replay), 'utf8');
  const dayFrom = Math.floor(win.from / DAY_MS);
  const D = Math.floor((win.to - 1) / DAY_MS) + 1 - dayFrom;
  const character = summarizeAccumulator(acc, D);
  const main = store.alerts.filter((a) => (store.strata.jarak.get(a.code.jarak)?.[0] ?? 0) > 0);
  const t = (a) => store.strata.jarak.get(a.code.jarak);
  const runnerPoint = main.length ? meanOf(main.map((a) => a.y.A - t(a)[1] / t(a)[0])) : null;
  const lxWith = lxAlerts.filter((k) => lxCells.has(k));
  const landmarkFeasibility = {
    alerts: lxAlerts.length, withComparator: lxWith.length, share: lxAlerts.length ? lxWith.length / lxAlerts.length : null,
    controlsPerAlert: lxWith.length ? lxWith.reduce((sum, k) => sum + lxCells.get(k), 0) / lxWith.length : null,
  };
  return { window: { from: new Date(win.from).toISOString(), to: new Date(win.to).toISOString() }, dataTo: new Date(to).toISOString(), D, character, runnerCheck: { matched: main.length, point: runnerPoint }, landmarkFeasibility };
}

// ── Agregasi simulasi ──

const proportion = COV.proportion;

/** Rata-rata ciri DGP antar-simulasi (tanpa estimator/CI): returns, alerts, strata, regime, pairing. */
export function averageCharacter(ok) {
  return Object.fromEntries(['returns', 'alerts', 'strata', 'regime', 'pairing'].map((sec) => [sec, Object.fromEntries(Object.keys(ok.find((r) => r.character?.[sec])?.character?.[sec] ?? {})
    .filter((k) => ok.some((r) => typeof r.character?.[sec]?.[k] === 'number'))
    .map((k) => [k, meanOf(ok.map((r) => r.character?.[sec]?.[k]).filter(Number.isFinite))]))]));
}

/** Ringkasan antar-simulasi dengan SE Monte Carlo (SD/√n) dan galat satu sisi CI terhadap beberapa definisi target. */
export function aggregateSim(runs, truths) {
  const ok = runs.filter((r) => r && !r.failed);
  const n = ok.length;
  const ms = (f) => {
    const v = ok.map(f).filter(Number.isFinite);
    return { mean: meanOf(v), mcSe: v.length > 1 ? sdOf(v) / Math.sqrt(v.length) : null, sd: sdOf(v), n: v.length };
  };
  const b7 = (k, f) => ms((r) => (r.boot[7][k] ? f(r.boot[7][k]) : NaN));
  const res = {
    sims: runs.length, ok: n,
    point: { full: ms((r) => r.point.full), base: ms((r) => r.point.base), drift: ms((r) => r.point.drift), alertBase: ms((r) => r.point.alertBase), controlBase: ms((r) => r.point.controlBase), alertDrift: ms((r) => r.point.alertDrift), controlDrift: ms((r) => r.point.controlDrift) },
    seEmp: sdOf(ok.map((r) => r.point.full)),
    boot: {
      se: b7('full', (x) => x.se), seAlertsOnly: b7('alertsOnly', (x) => x.se), seDecoupled: b7('decoupled', (x) => x.se),
      ratioFullAlertsOnly: ms((r) => r.boot[7].full.se / r.boot[7].alertsOnly.se),
      shift: Object.fromEntries(['full', 'base', 'drift', 'fixedPop', 'sameSet', 'alertsOnly', 'decoupled'].map((k) => [k, { medSe: b7(k, (x) => x.medShiftSe), meanSe: b7(k, (x) => x.meanShiftSe), mean: b7(k, (x) => x.meanShift) }])),
      shiftBlocks: Object.fromEntries(Object.keys(ok[0]?.boot ?? {}).map((L) => [L, ms((r) => r.boot[L].full.medShiftSe)])),
      seBlocks: Object.fromEntries(Object.keys(ok[0]?.boot ?? {}).map((L) => [L, ms((r) => r.boot[L].full.se)])),
      invalid: ok.reduce((s, r) => s + (r.boot[7].full.invalid ?? 0), 0),
      probeCoupledMatches: ok.every((r) => r.boot[7].probeCoupledMatches !== false),
      seBase: b7('base', (x) => x.se), seDrift: b7('drift', (x) => x.se),
    },
    character: averageCharacter(ok),
    fwdAcf: Object.fromEntries(FWD_LAGS.map((L) => [L, meanOf(ok.map((r) => r.character.returns.fwdAcf[L]).filter(Number.isFinite))])),
    errors: {},
  };
  for (const [name, value] of Object.entries(truths)) {
    if (!Number.isFinite(value)) continue;
    res.errors[name] = { value };
    for (const m of ['percentile', 'basic', 'bc']) {
      const list = ok.filter((r) => r.boot[7].ci?.[m]?.lo !== null && r.boot[7].ci?.[m]?.lo !== undefined);
      res.errors[name][m] = {
        hiBelow: proportion(list.filter((r) => r.boot[7].ci[m].hi < value).length, list.length),
        loAbove: proportion(list.filter((r) => r.boot[7].ci[m].lo > value).length, list.length),
      };
    }
  }
  return res;
}

// ── Orkestrasi ──

async function runPool(tasks, workers) {
  const results = new Array(tasks.length);
  let next = 0;
  let done = 0;
  const pool = [];
  await new Promise((ok, fail) => {
    for (let i = 0; i < Math.min(workers, tasks.length); i += 1) {
      // Kunci berbeda dari simulasi coverage: modul itu ikut dimuat di pekerja ini dan memasang penangan untuk `batch`.
      const w = new Worker(SELF, { workerData: { diagnoseBatch: true } });
      pool.push(w);
      const feed = () => {
        if (next >= tasks.length) return;
        const k = next;
        next += 1;
        w.postMessage({ k, ...tasks[k] });
      };
      w.on('message', (msg) => {
        results[msg.k] = msg.result;
        done += 1;
        if (done % 25 === 0 || done === tasks.length) log(`${done}/${tasks.length}`);
        if (done === tasks.length) ok();
        else feed();
      });
      w.on('error', fail);
      feed();
    }
  });
  await Promise.all(pool.map((w) => w.terminate()));
  return results;
}

if (!isMainThread && workerData?.diagnoseBatch) {
  parentPort.on('message', (task) => {
    const sc = scenarioOf(task.scenario, task.set);
    const result = task.kind === 'oracle' ? oracleDraw(sc, task.seed, task.innovationSeed)
      : task.kind === 'landmark' ? landmarkSimulation(sc, task.seed)
        : task.kind === 'levels' ? levelsSimulation(sc, task.seed) : diagnoseSimulation(sc, task.seed, task.reps, task.opts ?? {});
    parentPort.postMessage({ k: task.k, result }, result.codes ? [result.codes.buffer, result.vals.buffer, result.alerts.buffer] : []);
  });
}

const parseSet = (list = []) => Object.fromEntries(list.map((kv) => {
  const [k, v] = kv.split('=');
  if (!k || v === undefined || !Number.isFinite(Number(v))) throw new RangeError(`--set tidak sah: ${kv}`);
  return [k, Number(v)];
}));

async function main(argv) {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      mode: { type: 'string', default: 'sim' }, scenario: { type: 'string', default: 'dasar0' }, set: { type: 'string', multiple: true },
      sims: { type: 'string', default: '200' }, reps: { type: 'string', default: '999' }, seed: { type: 'string', default: '930001' },
      workers: { type: 'string', default: String(Math.max(1, Math.min(4, availableParallelism() - 2))) },
      configs: { type: 'string', default: '8' }, draws: { type: 'string', default: '40' }, truths: { type: 'string' },
      from: { type: 'string', default: '2024-10-01' }, to: { type: 'string', default: '2026-10-01' },
      'cache-dir': { type: 'string', default: RESEARCH_SNAPSHOT_DIR }, out: { type: 'string', default: join(ROOT, 'reports', 'research') }, tag: { type: 'string' },
    },
    strict: true,
  });
  const started = Date.now();
  const tree = (await codeTreeHash()).hash;
  const out = resolve(v.out);
  await mkdir(out, { recursive: true });
  const slug = new Date(started).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const tag = v.tag ? `-${v.tag}` : '';
  let result;
  if (v.mode === 'historical') {
    const day = (s) => Date.parse(`${s}T00:00:00Z`);
    result = await historical({ from: day(v.from), to: day(v.to), cacheDir: resolve(ROOT, v['cache-dir']), replayCache: join(out, `al-mom-01-diag-replay-${v.from}-${v.to}.json`) });
  } else if (v.mode === 'sim') {
    const set = parseSet(v.set);
    const sims = Number(v.sims);
    const tasks = Array.from({ length: sims }, (_, k) => ({ kind: 'sim', scenario: v.scenario, set, seed: Number(v.seed) + k, reps: Number(v.reps) }));
    const runs = await runPool(tasks, Number(v.workers));
    const sc = scenarioOf(v.scenario, set);
    const extra = v.truths ? Object.fromEntries(v.truths.split(',').map((kv) => kv.split('=')).map(([k, x]) => [k, Number(x)])) : {};
    const meanFull = meanOf(runs.filter((r) => r && !r.failed).map((r) => r.point.full));
    const meanDrift = meanOf(runs.filter((r) => r && !r.failed).map((r) => r.point.drift));
    result = {
      scenario: v.scenario, set, sc, sims, reps: Number(v.reps), seed: Number(v.seed),
      aggregate: aggregateSim(runs, { nol: 0, delta: sc.delta, thetaInfo: meanDrift, plugInMean: meanFull, ...extra }),
      runs: runs.map((r) => (r && !r.failed ? [r.point.full, r.point.base, r.point.drift, r.boot[7].ci.percentile.lo, r.boot[7].ci.percentile.hi, r.boot[7].ci.basic.lo, r.boot[7].ci.basic.hi, r.boot[7].ci.bc.lo, r.boot[7].ci.bc.hi, r.boot[7].full.se, r.boot[7].full.median] : null)),
    };
  } else if (v.mode === 'describe') {
    // Ciri DGP saja (kalibrasi skenario tanpa melihat bias, SE, atau CI): tanpa bootstrap.
    const set = parseSet(v.set);
    const sims = Number(v.sims);
    const runs = await runPool(Array.from({ length: sims }, (_, k) => ({ kind: 'sim', scenario: v.scenario, set, seed: Number(v.seed) + k, reps: 0, opts: { blocks: [], probe: false } })), Number(v.workers));
    const ok = runs.filter((r) => r?.character);
    result = { scenario: v.scenario, set, sc: scenarioOf(v.scenario, set), sims, seed: Number(v.seed), ok: ok.length, character: averageCharacter(ok) };
  } else if (v.mode === 'landmark') {
    const set = parseSet(v.set);
    const sims = Number(v.sims);
    const runs = (await runPool(Array.from({ length: sims }, (_, k) => ({ kind: 'landmark', scenario: v.scenario, set, seed: Number(v.seed) + k })), Number(v.workers))).filter((r) => r?.lx && r.primary);
    const ms = (f) => {
      const vals = runs.map(f).filter(Number.isFinite);
      return { mean: meanOf(vals), mcSe: sdOf(vals) / Math.sqrt(vals.length), sd: sdOf(vals), n: vals.length };
    };
    result = {
      scenario: v.scenario, set, sc: scenarioOf(v.scenario, set), sims, seed: Number(v.seed),
      summary: {
        lxFull: ms((r) => r.lx.full), lxBase: ms((r) => r.lx.base), lxDrift: ms((r) => r.lx.drift), share: ms((r) => r.share), controlsPerAlert: ms((r) => r.controlsPerAlert),
        primaryFull: ms((r) => r.primary.full), primaryDrift: ms((r) => r.primary.drift), primaryBase: ms((r) => r.primary.full - r.primary.drift),
      },
    };
  } else if (v.mode === 'levels') {
    const set = parseSet(v.set);
    const sims = Number(v.sims);
    const runs = await runPool(Array.from({ length: sims }, (_, k) => ({ kind: 'levels', scenario: v.scenario, set, seed: Number(v.seed) + k })), Number(v.workers));
    const ms = (vals) => ({ mean: meanOf(vals), mcSe: sdOf(vals) / Math.sqrt(vals.length), n: vals.length });
    result = {
      scenario: v.scenario, set, sc: scenarioOf(v.scenario, set), sims, seed: Number(v.seed),
      summary: Object.fromEntries(LEVELS.map((l) => {
        const ok = runs.filter((r) => r?.[l]);
        return [l, { full: ms(ok.map((r) => r[l].full)), drift: ms(ok.map((r) => r[l].drift)), base: ms(ok.map((r) => r[l].full - r[l].drift)), share: ms(ok.map((r) => r[l].share)) }];
      })),
    };
  } else if (v.mode === 'oracle') {
    const set = parseSet(v.set);
    const configs = Number(v.configs);
    const draws = Number(v.draws);
    const per = [];
    for (let c = 0; c < configs; c += 1) {
      const tasks = Array.from({ length: draws }, (_, k) => ({ kind: 'oracle', scenario: v.scenario, set, seed: Number(v.seed) + c, innovationSeed: 7_000_000 + c * 1000 + k }));
      const res = await runPool(tasks, Number(v.workers));
      const comb = oracleCombine(res);
      per.push(comb);
      const m = (f) => meanOf(comb.map(f).filter(Number.isFinite));
      log(`konfigurasi ${c}: plug-in dasar ${m((x) => x.plugBase).toFixed(4)} vs oracle ${m((x) => x.oracleBase).toFixed(4)}; drift ${m((x) => x.plugDrift).toFixed(4)} vs ${m((x) => x.oracleDrift).toFixed(4)}`);
    }
    const flat = per.flat();
    const stat = (f) => {
      const vals = flat.map(f).filter(Number.isFinite);
      return { mean: meanOf(vals), mcSe: sdOf(vals) / Math.sqrt(vals.length), n: vals.length };
    };
    // SE MC antar-konfigurasi (konfigurasi = unit independen; draw dalam konfigurasi berbagi lapisan rezim).
    const byConfig = (f) => {
      const vals = per.map((comb) => meanOf(comb.map(f).filter(Number.isFinite)));
      return { mean: meanOf(vals), mcSe: sdOf(vals) / Math.sqrt(vals.length), configs: vals.length };
    };
    result = {
      scenario: v.scenario, set, sc: scenarioOf(v.scenario, set), configs, draws, seed: Number(v.seed),
      summary: {
        plugBase: stat((x) => x.plugBase), oracleBase: stat((x) => x.oracleBase), plugDrift: stat((x) => x.plugDrift), oracleDrift: stat((x) => x.oracleDrift),
        alertBase: stat((x) => x.alertBase), alertDrift: stat((x) => x.alertDrift), allAlertBase: stat((x) => x.allAlertBase), allAlertDrift: stat((x) => x.allAlertDrift),
        oracleAllBase: stat((x) => x.oracleAllBase), oracleAllDrift: stat((x) => x.oracleAllDrift),
        biasAllBase: byConfig((x) => (Number.isFinite(x.oracleAllBase) && Number.isFinite(x.plugBase) ? x.plugBase - x.oracleAllBase : NaN)),
        biasAllDrift: byConfig((x) => (Number.isFinite(x.oracleAllDrift) && Number.isFinite(x.plugDrift) ? x.plugDrift - x.oracleAllDrift : NaN)),
        allShare: meanOf(flat.map((x) => x.nAll / x.nTotal)),
        biasBase: byConfig((x) => (Number.isFinite(x.oracleBase) ? x.plugSubBase - x.oracleBase : NaN)),
        biasDrift: byConfig((x) => (Number.isFinite(x.oracleDrift) ? x.plugSubDrift - x.oracleDrift : NaN)),
        oracleShare: meanOf(flat.map((x) => x.nOracle / x.n)),
      },
      perConfig: per.map((comb) => Object.fromEntries(['plugBase', 'oracleBase', 'oracleAllBase', 'plugDrift', 'oracleDrift', 'oracleAllDrift'].map((k) => [k, meanOf(comb.map((x) => x[k]).filter(Number.isFinite))]))),
    };
  } else {
    throw new RangeError(`mode tidak dikenal: ${v.mode}`);
  }
  const report = { generatedAt: new Date(started).toISOString(), mode: v.mode, tree, durationS: Math.round((Date.now() - started) / 1000), node: process.version, ...result };
  const file = join(out, `al-mom-01-diag-${v.mode}${tag}-${slug}.json`);
  await writeFile(file, JSON.stringify(report, null, 2), 'utf8');
  log(`Selesai dalam ${report.durationS} s → ${file}`);
}

if (isMainThread && process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err) => {
    log(`Diagnostik gagal: ${err?.stack ?? err}`);
    process.exitCode = 1;
  });
}
