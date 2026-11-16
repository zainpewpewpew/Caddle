// Simulasi daya AL-MOM-01 dari data historis 100 koin semesta AL-SA-ATR-01 (docs/27 §7; bahan desain, BELUM
// praregistrasi). Menjawab tinjauan ChatGPT 2026-11-16:
//   1. laju alert dan SE diukur langsung di 100 koin, bukan diskalakan √n dari 31 koin;
//   2. SE per jendela 12/24 bulan yang bergeser per kuartal (variasi rezim);
//   3. efek desain lintas simbol (sinyal yang muncul bersamaan) dari subset simbol acak → apa arti 4× simbol;
//   4. kovariat jarak dari alert sebelumnya: strata penyesuaian, subkelompok "segar", dan uji interaksinya;
//   5. jangkar biaya pulang-pergi dalam ATR dan R;
//   6. daya uji batas atas dengan batas dua sisi 95% vs satu sisi 95%.
// Deskriptif pada data historis (sinyal 2024-01 → 2026-10), seluruhnya sebelum jendela uji AL-SA-ATR-01.
//
// Pakai: npm run research:mom-sim [-- --save-acc <file.json> | --load-acc <file.json>]

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { AL_SA_ATR_01 } from '../backend/research/alSaAtr01.js';
import { matchAlerts, movingBlockBootstrapDiff, movingBlockBootstrapMean } from '../backend/research/matchedBaseline.js';
import { MOM_DESIGN, collectMomData, distanceBin } from './research-mom-power.js';
import { RESEARCH_SNAPSHOT_DIR, assertBeforeMomWindow } from './research-window-guard.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const Z_TWO = 1.959964; // batas atas CI 95% dua sisi (α satu sisi 2,5%), sama dengan docs/25–27
export const Z_ONE = 1.644854; // batas atas satu sisi 95% (α 5%)
const Z_POWER = 0.841621; // daya 80%
export const MARGINS = Object.freeze({ fwd12: Object.freeze([0.25, 0.3]), rAtr: Object.freeze([0.1, 0.12]) });
// 31 koin docs/27 yang juga ada di semesta AL-SA-ATR-01: dasar untuk mengulang proyeksi √n docs/27.
export const DOCS27_IN_UNIVERSE = Object.freeze([
  '1000PEPEUSDT', 'ADAUSDT', 'BCHUSDT', 'BNBUSDT', 'BTCUSDT', 'BTWUSDT', 'BULLAUSDT', 'CAPUSDT', 'DODOXUSDT', 'DOGEUSDT',
  'ENAUSDT', 'ERAUSDT', 'ETHUSDT', 'HYPEUSDT', 'INJUSDT', 'JCTUSDT', 'LINKUSDT', 'NEARUSDT', 'PUMPUSDT', 'QNTUSDT',
  'SOLUSDT', 'SUIUSDT', 'TAOUSDT', 'UNIUSDT', 'WLDUSDT', 'XRPUSDT', 'ZECUSDT',
]);
const SUBSET_SIZES = Object.freeze([10, 25, 50, 75]);
const SUBSET_DRAWS = 20;
const COST_RT = (2 * (MOM_DESIGN.feeBps + MOM_DESIGN.slippageBps)) / 10_000; // biaya pulang-pergi, fraksi harga

const log = (m) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${m}\n`);
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const quantile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))] : null);
const ym = (ms) => new Date(ms).toISOString().slice(0, 7);
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

/** Φ(x), distribusi normal baku (Abramowitz & Stegun 7.1.26 lewat erf; galat < 1,5e-7). */
export function normalCdf(x) {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** Daya uji batas atas: P(est + z·SE < margin) bila efek sebenarnya `effect`. */
export function upperBoundPower({ margin, effect, se, z }) {
  if (!(se > 0)) return null;
  return normalCdf((margin - effect) / se - z);
}

/** Bulan untuk daya 80% pada uji batas atas, dari SE empiris pada `months0` bulan (SE ∝ 1/√bulan). */
export function monthsForUpperBound({ margin, effect, se0, months0, z }) {
  if (!(se0 > 0) || !(margin > effect)) return null;
  return months0 * ((se0 * (z + Z_POWER)) / (margin - effect)) ** 2;
}

/** SE dari CI persentil 95% dua sisi. */
export const seFromCi = (ci, z = Z_TWO) => (ci ? (ci.hi - ci.lo) / (2 * z) : null);

/** Jendela `months` bulan yang bergeser `stepMonths` bulan, seluruhnya di dalam [from, to). */
export function rollingWindows({ from, to, months, stepMonths = 3 }) {
  const out = [];
  const d = new Date(from);
  for (let k = 0; ; k += stepMonths) {
    const a = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k, 1);
    const b = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k + months, 1);
    if (b > to) break;
    out.push({ from: a, to: b, label: `${ym(a)} → ${ym(b - 1)}` });
  }
  return out;
}

/** Subset k simbol acak yang deterministik (Fisher–Yates dengan benih). */
export function sampleSymbols(symbols, k, seed) {
  const arr = [...symbols].sort();
  const rnd = mulberry32(seed);
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, Math.min(k, arr.length));
}

/**
 * Model SE² = a + b / k (k = jumlah simbol): b/k = bagian per simbol yang mengecil bila simbol ditambah, a = bagian
 * bersama (pasar bergerak bersama) yang tidak mengecil. Kuadrat terkecil biasa pada x = 1/k.
 */
export function fitCommonComponent(points) {
  const xs = points.map((p) => 1 / p.k);
  const ys = points.map((p) => p.se ** 2);
  const mx = mean(xs);
  const my = mean(ys);
  const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  const b = sxx > 0 ? xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / sxx : 0;
  return { a: my - b * mx, b };
}

const ATT = (list, o, blockDays = 7) => movingBlockBootstrapMean(list, { value: (m) => m.diff[o], time: (m) => m.t, blockDays });
const OUT = Object.freeze([['fwd12', 'A'], ['rAtr', 'B']]);

/** Seluruh analisis dari agregat collectMomData (tanpa I/O). */
export function analyzeMomSim({ acc, from, to, baseSymbols = DOCS27_IN_UNIVERSE }) {
  const { matched, unmatched } = matchAlerts(acc.alerts, acc.controls.tanpa);
  const symbols = [...new Set(acc.alerts.map((a) => a.symbol))].sort();
  const monthsBySymbol = new Map();
  for (const sm of acc.symbolMonths) {
    const s = sm.slice(0, sm.indexOf('|'));
    monthsBySymbol.set(s, (monthsBySymbol.get(s) ?? 0) + 1);
  }
  const allSymbols = [...monthsBySymbol.keys()].sort();
  const group = (s) => (baseSymbols.includes(s) ? 'lama' : 'baru');
  const rates = Object.fromEntries(['lama', 'baru'].map((g) => {
    const syms = allSymbols.filter((s) => group(s) === g);
    const sm = syms.reduce((n, s) => n + monthsBySymbol.get(s), 0);
    const alerts = acc.alerts.filter((a) => group(a.symbol) === g).length;
    return [g, { symbols: syms.length, symbolMonths: sm, alerts, perSymbolMonth: sm ? alerts / sm : null }];
  }));
  const full = {
    alerts: acc.alerts.length, matched: matched.length, unmatched, matchRate: acc.alerts.length ? matched.length / acc.alerts.length : null,
    symbolMonths: acc.symbolMonths.size, perSymbolMonth: acc.alerts.length / acc.symbolMonths.size,
    ...Object.fromEntries(OUT.map(([o, k]) => {
      const ci = ATT(matched, o);
      return [k, { ci7: ci, ci14: ATT(matched, o, 14), ci1: ATT(matched, o, 1), se: seFromCi(ci) }];
    })),
  };
  const lampau = matchAlerts(acc.alerts, acc.controls.lampau).matched;
  full.lampau = { matched: lampau.length, ...Object.fromEntries(OUT.map(([o, k]) => [k, ATT(lampau, o)])) };

  // 1–2. SE langsung per jendela 12/24 bulan (bergeser per kuartal), 100 koin.
  const windows = Object.fromEntries([12, 24].map((months) => [months, rollingWindows({ from, to, months }).map((w) => {
    const list = matched.filter((m) => m.t >= w.from && m.t < w.to);
    const res = { label: w.label, n: list.length, perMonth: list.length / months };
    for (const [o, k] of OUT) {
      const ci = ATT(list, o);
      res[k] = { mean: ci?.mean ?? null, se: seFromCi(ci) };
    }
    return res;
  })]));
  const seSummary = Object.fromEntries([12, 24].map((months) => [months, Object.fromEntries(OUT.map(([, k]) => {
    const ses = windows[months].map((w) => w[k].se).filter((x) => x > 0);
    return [k, { median: median(ses), min: Math.min(...ses), max: Math.max(...ses) }];
  }))]));

  // Proyeksi √n gaya docs/27, diulang dari koin lama saja, dibandingkan dengan SE empiris 100 koin.
  const base = matched.filter((m) => baseSymbols.includes(m.symbol));
  const baseRate = rates.lama.perSymbolMonth;
  const baseMatchRate = base.length / acc.alerts.filter((a) => baseSymbols.includes(a.symbol)).length;
  const projection = Object.fromEntries(OUT.map(([o, k]) => {
    const seBase = seFromCi(ATT(base, o));
    return [k, Object.fromEntries([12, 24].map((months) => {
      const n = baseRate * 100 * baseMatchRate * months;
      const projected = seBase * Math.sqrt(base.length / n);
      return [months, { projected, empirical: seSummary[months][k].median, ratio: seSummary[months][k].median / projected }];
    }))];
  }));

  // 3. Efek desain lintas simbol: SE pada subset simbol acak (periode penuh).
  const subsets = [];
  for (const k of [...SUBSET_SIZES.filter((x) => x < allSymbols.length), allSymbols.length]) {
    const draws = k === allSymbols.length ? 1 : SUBSET_DRAWS;
    const se = { A: [], B: [] };
    for (let d = 0; d < draws; d += 1) {
      const pick = new Set(sampleSymbols(allSymbols, k, 1000 + 97 * k + d));
      const list = matched.filter((m) => pick.has(m.symbol));
      for (const [o, key] of OUT) se[key].push(seFromCi(ATT(list, o)));
    }
    subsets.push({ k, draws, A: mean(se.A), B: mean(se.B) });
  }
  const crossSection = Object.fromEntries(OUT.map(([, key]) => {
    const fit = fitCommonComponent(subsets.map((s) => ({ k: s.k, se: s[key] })));
    const kAll = allSymbols.length;
    const seAll = subsets.at(-1)[key];
    const se4x = Math.sqrt(Math.max(0, fit.a + fit.b / (4 * kAll)));
    return [key, { ...fit, commonShare: fit.a / seAll ** 2, se: seAll, se4x, gain4x: seAll / se4x, gainIdeal: 2 }];
  }));

  // 4. Jarak dari alert sebelumnya.
  const alertsJ = acc.alerts.map((a) => ({ ...a, key: a.keyJarak }));
  const adj = matchAlerts(alertsJ, acc.controls.tanpaJarak);
  const ctrlByBin = {};
  for (const [key, c] of acc.controls.tanpaJarak) {
    const bin = key.slice(key.lastIndexOf('|') + 1);
    ctrlByBin[bin] = (ctrlByBin[bin] ?? 0) + c.n;
  }
  const ctrlTotal = Object.values(ctrlByBin).reduce((a, b) => a + b, 0);
  const bins = ['d12', 'd48', 'jauh'].map((bin) => {
    const alerts = acc.alerts.filter((a) => distanceBin(a.sincePrev) === bin).length;
    const sub = matched.filter((m) => distanceBin(m.sincePrev) === bin);
    return {
      bin, alertShare: alerts / acc.alerts.length, controlShare: (ctrlByBin[bin] ?? 0) / ctrlTotal, n: sub.length,
      ...Object.fromEntries(OUT.map(([o, k]) => [k, ATT(sub, o)])),
    };
  });
  const fresh = matched.filter((m) => distanceBin(m.sincePrev) === 'jauh');
  const repeat = matched.filter((m) => distanceBin(m.sincePrev) !== 'jauh');
  const distance = {
    bins,
    adjusted: {
      matched: adj.matched.length, matchRate: adj.matched.length / acc.alerts.length,
      ...Object.fromEntries(OUT.map(([o, k]) => {
        const ci = ATT(adj.matched, o);
        return [k, { ci7: ci, se: seFromCi(ci) }];
      })),
    },
    interaction: Object.fromEntries(OUT.map(([o, k]) => [k, movingBlockBootstrapDiff(fresh, repeat, { value: (m) => m.diff[o], time: (m) => m.t, blockDays: 7 })])),
    fresh: fresh.length, repeat: repeat.length,
  };

  // 5. Jangkar biaya pulang-pergi (fee + slippage) dalam ATR dan R (1R = stop 1,5 ATR).
  const costAtr = matched.map((m) => COST_RT / m.atrPct).filter(Number.isFinite).sort((a, b) => a - b);
  const pct = (arr) => ({ p25: quantile(arr, 0.25), p50: quantile(arr, 0.5), p75: quantile(arr, 0.75) });
  const cost = { roundTripBps: COST_RT * 10_000, atr: pct(costAtr), r: pct(costAtr.map((c) => c / MOM_DESIGN.stopAtr)) };

  // 6. Daya uji batas atas dari SE empiris (median dan terburuk antarjendela).
  const power = [];
  for (const [o, key] of OUT) {
    const effect = full[key].ci7.mean;
    for (const margin of MARGINS[o]) {
      for (const [bound, z] of [['dua sisi', Z_TWO], ['satu sisi', Z_ONE]]) {
        const row = { outcome: key, margin, bound, effect };
        for (const months of [12, 24]) {
          const s = seSummary[months][key];
          row[`m${months}`] = {
            power0: upperBoundPower({ margin, effect: 0, se: s.median, z }),
            powerEffect: upperBoundPower({ margin, effect, se: s.median, z }),
            powerEffectWorst: upperBoundPower({ margin, effect, se: s.max, z }),
          };
        }
        row.months80 = monthsForUpperBound({ margin, effect, se0: seSummary[24][key].median, months0: 24, z });
        power.push(row);
      }
    }
    const mde = Object.fromEntries([12, 24].map((months) => [months, (Z_TWO + Z_POWER) * seSummary[months][key].median]));
    power.push({ outcome: key, kind: 'superioritas', mde });
  }
  return { symbols: allSymbols.length, alertSymbols: symbols.length, rates, full, windows, seSummary, projection, subsets, crossSection, distance, cost, power };
}

// ── Serialisasi agregat (supaya analisis bisa diulang tanpa replay 100 koin) ──
export const serializeAcc = (acc) => JSON.stringify({
  controls: Object.fromEntries(Object.entries(acc.controls).map(([k, m]) => [k, [...m]])),
  alerts: acc.alerts, symbolMonths: [...acc.symbolMonths],
});
export function deserializeAcc(text) {
  const raw = JSON.parse(text);
  return {
    controls: Object.fromEntries(Object.entries(raw.controls).map(([k, entries]) => [k, new Map(entries)])),
    alerts: raw.alerts, alertTrades: [], symbolMonths: new Set(raw.symbolMonths),
  };
}

// ── Markdown ──
const num = (x, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d).replace('.', ',')}`);
const plain = (x, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? '—' : x.toFixed(d).replace('.', ','));
const pctf = (x) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`);
const withCi = (ci, d = 2) => (ci ? `${num(ci.mean ?? ci.diff, d)} [${num(ci.lo, d)} … ${num(ci.hi, d)}]` : '—');
const int = (x) => (x === null || x === undefined ? '—' : Math.round(x).toLocaleString('id-ID'));

export function renderMomSimMarkdown(r) {
  const f = r.full;
  const md = [
    '# Simulasi daya AL-MOM-01, 100 koin (bahan desain, belum praregistrasi) — AlphaLens',
    '',
    `Dibuat ${r.generatedAt} · ${r.symbols} simbol semesta AL-SA-ATR-01 · sinyal ${r.from} → ${r.to} · LONG 1h SA/PVA v3 · pembanding "tanpa" · `
      + `CI moving-block bootstrap 7 hari. Deskriptif pada data historis.`,
    '',
    '## Laju alert dan hasil periode penuh',
    '',
    `Alert ${int(f.alerts)} · cocok ${int(f.matched)} (${pctf(f.matchRate)}) · ${int(f.symbolMonths)} simbol-bulan · ${plain(f.perSymbolMonth)} alert per simbol-bulan `
      + `(koin docs/27 ${plain(r.rates.lama.perSymbolMonth)}, n simbol ${r.rates.lama.symbols}; koin tambahan ${plain(r.rates.baru.perSymbolMonth)}, n simbol ${r.rates.baru.symbols}).`,
    '',
    `A (gerak 12 candle, ATR): ${withCi(f.A.ci7)}, CI 14 hari [${num(f.A.ci14?.lo)} … ${num(f.A.ci14?.hi)}], harian [${num(f.A.ci1?.lo)} … ${num(f.A.ci1?.hi)}], SE ${plain(f.A.se, 3)}.`,
    `B (R, geometri identik): ${withCi(f.B.ci7, 3)}, CI 14 hari [${num(f.B.ci14?.lo, 3)} … ${num(f.B.ci14?.hi, 3)}], harian [${num(f.B.ci1?.lo, 3)} … ${num(f.B.ci1?.hi, 3)}], SE ${plain(f.B.se, 3)}.`,
    `Sensitivitas "lampau" (cocok ${int(f.lampau.matched)}): A ${withCi(f.lampau.A)}, B ${withCi(f.lampau.B, 3)}.`,
    '',
    '## SE langsung per jendela (100 koin)',
    '',
    '| Jendela | n cocok | per bulan | A: titik | A: SE | B: titik | B: SE |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...[12, 24].flatMap((months) => r.windows[months].map((w) => `| ${months} bln ${w.label} | ${int(w.n)} | ${int(w.perMonth)} | ${num(w.A.mean)} | ${plain(w.A.se, 3)} | ${num(w.B.mean, 3)} | ${plain(w.B.se, 3)} |`)),
    '',
    '| Lama | SE A median [min … maks] | SE B median [min … maks] | Proyeksi √n dari koin docs/27: A · B | Rasio empiris/proyeksi: A · B |',
    '| --- | --- | --- | --- | --- |',
    ...[12, 24].map((months) => {
      const a = r.seSummary[months].A;
      const b = r.seSummary[months].B;
      return `| ${months} bulan | ${plain(a.median, 3)} [${plain(a.min, 3)} … ${plain(a.max, 3)}] | ${plain(b.median, 3)} [${plain(b.min, 3)} … ${plain(b.max, 3)}] | `
        + `${plain(r.projection.A[months].projected, 3)} · ${plain(r.projection.B[months].projected, 3)} | ${plain(r.projection.A[months].ratio)} · ${plain(r.projection.B[months].ratio)} |`;
    }),
    '',
    '## Efek desain lintas simbol (periode penuh)',
    '',
    '| Simbol | Undian | SE A | SE B |',
    '| --- | --- | --- | --- |',
    ...r.subsets.map((s) => `| ${s.k} | ${s.draws} | ${plain(s.A, 3)} | ${plain(s.B, 3)} |`),
    '',
    ...OUT.map(([, k]) => {
      const c = r.crossSection[k];
      return `${k}: model SE² = a + b/k → bagian bersama ${pctf(c.commonShare)} dari SE² pada ${r.symbols} simbol; 4× simbol memperkecil SE ${plain(c.gain4x)}× (ideal tanpa korelasi 2×).`;
    }),
    '',
    '## Jarak dari alert sebelumnya',
    '',
    '| Kelompok | Porsi alert | Porsi candle pembanding | n cocok | A [CI 7 hari] | B [CI 7 hari] |',
    '| --- | --- | --- | --- | --- | --- |',
    ...r.distance.bins.map((b) => `| ${b.bin === 'd12' ? '≤ 12 candle' : b.bin === 'd48' ? '13–48 candle' : '> 48 / belum ada'} | ${pctf(b.alertShare)} | ${pctf(b.controlShare)} | ${int(b.n)} | ${withCi(b.A)} | ${withCi(b.B, 3)} |`),
    '',
    `Strata + jarak: cocok ${int(r.distance.adjusted.matched)} (${pctf(r.distance.adjusted.matchRate)}), A ${withCi(r.distance.adjusted.A.ci7)} (SE ${plain(r.distance.adjusted.A.se, 3)}), `
      + `B ${withCi(r.distance.adjusted.B.ci7, 3)} (SE ${plain(r.distance.adjusted.B.se, 3)}).`,
    `Interaksi segar − berulang (n ${int(r.distance.fresh)} vs ${int(r.distance.repeat)}): A ${withCi(r.distance.interaction.A)}, B ${withCi(r.distance.interaction.B, 3)}.`,
    '',
    '## Jangkar biaya',
    '',
    `Biaya pulang-pergi ${plain(r.cost.roundTripBps, 0)} bps (fee + slippage). Pada alert cocok: ${plain(r.cost.atr.p50)} ATR [kuartil ${plain(r.cost.atr.p25)} … ${plain(r.cost.atr.p75)}] = `
      + `${plain(r.cost.r.p50, 3)}R [${plain(r.cost.r.p25, 3)} … ${plain(r.cost.r.p75, 3)}].`,
    '',
    '## Daya uji batas atas (SE empiris; efek = titik periode penuh)',
    '',
    '| Hasil | Margin | Batas | 12 bln: daya bila efek 0 · efek historis · SE terburuk | 24 bln: daya bila efek 0 · efek historis · SE terburuk | Bulan untuk daya 80% |',
    '| --- | --- | --- | --- | --- | --- |',
    ...r.power.filter((p) => !p.kind).map((p) => `| ${p.outcome} | ${plain(p.margin)} | ${p.bound} | ${pctf(p.m12.power0)} · ${pctf(p.m12.powerEffect)} · ${pctf(p.m12.powerEffectWorst)} | `
      + `${pctf(p.m24.power0)} · ${pctf(p.m24.powerEffect)} · ${pctf(p.m24.powerEffectWorst)} | ${p.months80 === null ? '—' : plain(p.months80, 0)} |`),
    '',
    ...r.power.filter((p) => p.kind).map((p) => `Superioritas ${p.outcome} (batas bawah CI 95% > 0, daya 80%): efek terkecil terdeteksi 12 bln ${plain(p.mde[12], 3)}, 24 bln ${plain(p.mde[24], 3)}.`),
    '',
  ];
  return md.join('\n');
}

async function main(argv) {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      from: { type: 'string', default: '2024-01-01' }, to: { type: 'string', default: '2026-10-01' },
      'cache-dir': { type: 'string', default: RESEARCH_SNAPSHOT_DIR }, out: { type: 'string', default: join(ROOT, 'reports', 'research') },
      'save-acc': { type: 'string' }, 'load-acc': { type: 'string' },
    },
    strict: true,
  });
  const from = day(v.from, 'from');
  const to = day(v.to, 'to');
  assertBeforeMomWindow(to);
  if (from >= to) throw new RangeError('--from harus sebelum --to');
  const started = Date.now();
  let acc;
  if (v['load-acc']) {
    acc = deserializeAcc(await readFile(resolve(v['load-acc']), 'utf8'));
  } else {
    const res = await collectMomData({ symbols: AL_SA_ATR_01.universe, from, to, cacheDir: resolve(ROOT, v['cache-dir']) });
    if (res.skipped.length) log(`Dilewati: ${res.skipped.join('; ')}`);
    acc = res.acc;
    if (v['save-acc']) await writeFile(resolve(v['save-acc']), serializeAcc(acc), 'utf8');
  }
  const result = { generatedAt: new Date(started).toISOString(), from: v.from, to: v.to, ...analyzeMomSim({ acc, from, to }) };
  result.durationS = Math.round((Date.now() - started) / 1000);
  const out = resolve(v.out);
  await mkdir(out, { recursive: true });
  const slug = result.generatedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  await writeFile(join(out, `mom-sim-${slug}.md`), renderMomSimMarkdown(result), 'utf8');
  await writeFile(join(out, `mom-sim-${slug}.json`), JSON.stringify(result, null, 2), 'utf8');
  log(`Selesai dalam ${result.durationS} s → ${join(out, `mom-sim-${slug}.md`)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err) => {
    log(`Simulasi gagal: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
}
