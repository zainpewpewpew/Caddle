// Riset "informasi di luar momentum" (docs/25): apakah alert pola live (LONG 1h SA/PVA, SHORT 15m SD/PVD; v3) membawa
// informasi tentang gerak berikutnya di luar momentum yang sudah terlihat dari harga? Riset saja: tidak menyentuh
// database, worker, atau scanner live. Desain DIKUNCI sebelum run (docs/25 §1; hash file di docs/25 §1.6).
//
// Pakai:
//   npm run research:matched                                 # semua simbol di cache, sinyal 2024-01-01 → 2026-10-01
//   npm run research:matched -- --symbols UNIUSDT,ZECUSDT     # sebagian simbol (uji asap)
//
// Bagian laporan:
//   A. Pembanding dicocokkan: alert vs candle tanpa sinyal di strata simbol × kuartal × gerak awal (0,5 ATR) × posisi
//      rentang 48 (0,2) × tersil ATR% (per simbol × kuartal). Hasil = gerak lanjutan 12/48 candle (ATR) & breakout ≤ 12
//      candle (Donchian 24/48/96). Selisih (ATT) dengan CI moving-block bootstrap 7 hari (utama), 14 hari, dan harian.
//   B. Kohort simbol lama (data sejak Jan 2024) vs baru.
//   C. Sensitivitas definisi breakout docs/24 (Donchian 24/96).
//   D. R trade docs/24 dengan CI blok 1/7/14 hari, kelompok gerak awal ≥/< 2,7 ATR, aturan satu posisi per simbol.
//   E. Persiapan praregistrasi AL-SA-ATR-01: SD, efek desain, frekuensi trade, ukuran sampel.

import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_CACHE_DIR } from '../backend/backtest/dataSource.js';
import { BACKTEST_WARMUP, RUNNER_DEFAULTS, replaySeries } from '../backend/backtest/runner.js';
import { atr } from '../backend/indicators/index.js';
import {
  MATCH_DEFAULTS, addControl, binOf, breakoutWithin, forwardMove, matchAlerts, movingBlockBootstrapDiff,
  movingBlockBootstrapMean, onePositionPerSymbol, quantileCuts, quarterOf, requiredSampleSize, stratumKey,
} from '../backend/research/matchedBaseline.js';
import { TIMING_GROUPS, breakoutFlags, classifyTiming, groupOfClass, timingAt } from '../backend/research/signalTiming.js';
import { TIMING_COMBOS, loadCached } from './research-timing.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { look: LOOK, horizons: HORIZONS, donchians: DONCHIANS, exclusion: EXCLUSION } = MATCH_DEFAULTS;
const PRIMARY_DONCHIAN = 48;
const BLOCKS = Object.freeze([7, 14, 1]); // 7 hari = CI utama
/** Ambang gerak awal hipotesis AL-SA-ATR-01 (tersil atas docs/24 §3.1). */
export const PRE_THRESHOLD_ATR = 2.7;
const OLD_COHORT_BEFORE = Date.UTC(2024, 1, 1);
export const OUTCOMES = Object.freeze([
  { key: 'fwd12', label: 'Gerak lanjutan 12 candle (ATR) — UTAMA', fmt: 'atr' },
  { key: 'fwd48', label: 'Gerak lanjutan 48 candle (ATR)', fmt: 'atr' },
  { key: 'brk48', label: 'Breakout ≤ 12 candle (Donchian 48)', fmt: 'pct' },
  { key: 'brk24', label: 'Breakout ≤ 12 candle (Donchian 24, sensitivitas)', fmt: 'pct' },
  { key: 'brk96', label: 'Breakout ≤ 12 candle (Donchian 96, sensitivitas)', fmt: 'pct' },
]);
const COVARIATES = Object.freeze(['pre', 'pos', 'vol']);

const log = (m) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${m}\n`);
const day = (s, name) => {
  const ms = Date.parse(`${s}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(ms)) throw new RangeError(`--${name} harus YYYY-MM-DD`);
  return ms;
};
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
const sd = (arr) => {
  if (arr.length < 2) return null;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1));
};
const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);

/** Pembacaan hasil utama yang ditetapkan sebelum run (docs/25 §1.5). */
export function verdictOf(ci) {
  if (!ci) return 'tidak cukup data';
  if (ci.lo > 0) return 'MENAMBAH INFORMASI (batas bawah CI > 0)';
  if (ci.hi < 0) return 'LEBIH BURUK dari momentum serupa (batas atas CI < 0)';
  return 'TIDAK TERBUKTI menambah informasi (CI memuat 0)';
}

function newAcc() {
  return {
    series: 0,
    controls: new Map(),
    alerts: [],
    all: { n: 0, sums: Object.fromEntries(OUTCOMES.map((o) => [o.key, 0])) },
    timingAll: Object.fromEntries(DONCHIANS.map((d) => [d, Object.fromEntries(TIMING_GROUPS.map((g) => [g.key, 0]))])),
    timingAlerts: Object.fromEntries(DONCHIANS.map((d) => [d, Object.fromEntries(TIMING_GROUPS.map((g) => [g.key, 0]))])),
    trades: [],
    symbolMonths: new Set(),
  };
}

async function studySeries({ symbol, combo, byTf, acc }) {
  const B = byTf[combo.timeframe];
  const dir = combo.direction;
  const res = await replaySeries({ symbol, timeframe: combo.timeframe, byTf });
  const A = atr(B, 14);
  const flags = Object.fromEntries(DONCHIANS.map((d) => [d, breakoutFlags(B, dir, d)]));
  const v3 = res.trades.v3.filter((t) => t.direction === dir);
  const v2 = res.trades.v2.filter((t) => t.direction === dir);
  const n = B.length;
  // Kandidat pembanding: ≥ EXCLUSION+1 candle dari alert SA/PVA mana pun (v2 atau v3) pada arah yang sama.
  const excluded = new Uint8Array(n);
  for (const t of [...v2, ...v3]) {
    for (let k = Math.max(0, t.entryIndex - EXCLUSION); k <= Math.min(n - 1, t.entryIndex + EXCLUSION); k += 1) excluded[k] = 1;
  }
  const cohort = B[0].openTime < OLD_COHORT_BEFORE ? 'lama' : 'baru';
  const lo = BACKTEST_WARMUP;
  const hi = n - 1 - Math.max(...HORIZONS);
  // Tersil ATR% per simbol × kuartal dari semua candle yang memenuhi syarat.
  const volByPeriod = new Map();
  for (let i = lo; i <= hi; i += 1) {
    if (!(A[i] > 0)) continue;
    const p = quarterOf(B[i].openTime);
    if (!volByPeriod.has(p)) volByPeriod.set(p, []);
    volByPeriod.get(p).push(A[i] / B[i].close);
    acc.symbolMonths.add(`${symbol}|${monthOf(B[i].openTime)}`);
  }
  const cuts = new Map([...volByPeriod].map(([p, vals]) => [p, quantileCuts(vals, MATCH_DEFAULTS.volBins)]));
  const alertAt = new Map(v3.map((t) => [t.entryIndex, t]));
  let alerts = 0;
  for (let i = lo; i <= hi; i += 1) {
    const tm = timingAt(B, A, flags[PRIMARY_DONCHIAN], dir, i, { donchian: PRIMARY_DONCHIAN, look: LOOK });
    if (!tm) continue;
    const fwd12 = forwardMove(B, A, dir, i, 12);
    const fwd48 = forwardMove(B, A, dir, i, 48);
    if (fwd12 === null || fwd48 === null) continue;
    const period = quarterOf(B[i].openTime);
    const vol = A[i] / B[i].close;
    const y = {
      fwd12, fwd48,
      brk24: breakoutWithin(flags[24], i, LOOK), brk48: breakoutWithin(flags[48], i, LOOK), brk96: breakoutWithin(flags[96], i, LOOK),
      pre: tm.pre, pos: tm.pos, vol,
    };
    const key = stratumKey({ symbol, period, pre: tm.pre, pos: tm.pos, volBin: binOf(vol, cuts.get(period)) });
    acc.all.n += 1;
    for (const o of OUTCOMES) acc.all.sums[o.key] += y[o.key];
    for (const d of DONCHIANS) acc.timingAll[d][groupOfClass(classifyTiming(flags[d], i, LOOK))] += 1;
    if (!excluded[i]) addControl(acc.controls, key, y);
    if (alertAt.has(i)) {
      alerts += 1;
      acc.alerts.push({ key, y, t: B[i].closeTime, symbol, cohort });
      for (const d of DONCHIANS) acc.timingAlerts[d][groupOfClass(classifyTiming(flags[d], i, LOOK))] += 1;
    }
  }
  // Trade (seperti docs/24): v3, tanpa OPEN, gerak awal pada candle sinyal.
  for (const t of v3) {
    if (t.outcome === 'OPEN') continue;
    const tm = timingAt(B, A, flags[PRIMARY_DONCHIAN], dir, t.entryIndex, { donchian: PRIMARY_DONCHIAN, look: LOOK });
    if (!tm) continue;
    acc.trades.push({ symbol, cohort, t: t.entryTime, exitTime: t.exitTime, r: t.rMultiple, grossR: t.grossR, costR: t.costR, pre: tm.pre });
  }
  acc.series += 1;
  return { alerts, trades: v3.length };
}

const ciSet = (events, value) => Object.fromEntries(BLOCKS.map((L) => [L, movingBlockBootstrapMean(events, { value, time: (e) => e.t, blockDays: L })]));

function summarizeCombo(acc, testStart) {
  const { matched, unmatched } = matchAlerts(acc.alerts, acc.controls);
  const nCtrl = matched.map((m) => m.nCtrl).sort((a, b) => a - b);
  const outcome = Object.fromEntries(OUTCOMES.map((o) => [o.key, {
    alert: mean(matched.map((m) => m.y[o.key])),
    ctrl: mean(matched.map((m) => m.ctrl[o.key])),
    all: acc.all.n ? acc.all.sums[o.key] / acc.all.n : null,
    att: ciSet(matched, (m) => m.diff[o.key]),
  }]));
  const balance = Object.fromEntries(COVARIATES.map((c) => [c, { alert: mean(matched.map((m) => m.y[c])), ctrl: mean(matched.map((m) => m.ctrl[c])) }]));
  const cohorts = Object.fromEntries(['lama', 'baru'].map((k) => {
    const list = matched.filter((m) => m.cohort === k);
    return [k, {
      n: list.length,
      fwd12: movingBlockBootstrapMean(list, { value: (m) => m.diff.fwd12, time: (m) => m.t, blockDays: 7 }),
      brk48: movingBlockBootstrapMean(list, { value: (m) => m.diff.brk48, time: (m) => m.t, blockDays: 7 }),
    }];
  }));
  const share = (counts) => {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    return Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, total ? v / total : null]));
  };
  const timing = Object.fromEntries(DONCHIANS.map((d) => [d, { alerts: share(acc.timingAlerts[d]), all: share(acc.timingAll[d]) }]));

  const T = acc.trades;
  const hiPre = T.filter((x) => x.pre >= PRE_THRESHOLD_ATR);
  const loPre = T.filter((x) => x.pre < PRE_THRESHOLD_ATR);
  const hiOne = onePositionPerSymbol(hiPre);
  const loOne = onePositionPerSymbol(loPre);
  const r = (x) => x.r;
  const groups = [
    ['Semua alert', T],
    ['Periode uji', T.filter((x) => x.t >= testStart)],
    [`Gerak awal ≥ ${PRE_THRESHOLD_ATR} ATR`, hiPre],
    [`Gerak awal < ${PRE_THRESHOLD_ATR} ATR`, loPre],
    [`≥ ${PRE_THRESHOLD_ATR} ATR, satu posisi per simbol`, hiOne],
    [`< ${PRE_THRESHOLD_ATR} ATR, satu posisi per simbol`, loOne],
    [`≥ ${PRE_THRESHOLD_ATR} ATR, satu posisi per simbol, periode uji`, hiOne.filter((x) => x.t >= testStart)],
  ].map(([label, list]) => ({ label, n: list.length, meanR: mean(list.map(r)), ci: ciSet(list, r) }));
  const diffHiLo = Object.fromEntries(BLOCKS.map((L) => [L, movingBlockBootstrapDiff(hiOne, loOne, { value: r, time: (e) => e.t, blockDays: L })]));

  // Persiapan praregistrasi (ukuran sampel & durasi), dari kelompok ≥ ambang dengan satu posisi per simbol.
  const sdR = sd(hiOne.map(r));
  const ci7 = movingBlockBootstrapMean(hiOne, { value: r, time: (e) => e.t, blockDays: 7 });
  const seNaive = sdR && hiOne.length ? sdR / Math.sqrt(hiOne.length) : null;
  const seBlock = ci7 ? (ci7.hi - ci7.lo) / (2 * 1.959964) : null;
  const deff = seNaive && seBlock ? (seBlock / seNaive) ** 2 : null;
  const effect = mean(hiOne.map(r));
  const stressR = mean(hiOne.map((x) => x.grossR - x.costR * (10 / 7)));
  const months = acc.symbolMonths.size;
  const perSymbolMonth = months ? hiOne.length / months : null;
  const prereg = {
    n: hiOne.length, meanR: effect, sdR, deff, stressMeanR: stressR, symbolMonths: months, tradesPerSymbolMonth: perSymbolMonth,
    nRequiredObserved: effect > 0 ? requiredSampleSize({ sd: sdR, effect, deff: Math.max(1, deff ?? 1) }) : null,
    nRequiredHalf: effect > 0 ? requiredSampleSize({ sd: sdR, effect: effect / 2, deff: Math.max(1, deff ?? 1) }) : null,
  };
  return {
    series: acc.series, alerts: acc.alerts.length, matched: matched.length, unmatched,
    medianControls: nCtrl.length ? nCtrl[Math.floor(nCtrl.length / 2)] : null, candles: acc.all.n,
    outcome, verdict: verdictOf(outcome.fwd12.att[7]), balance, cohorts, timing,
    trades: { groups, diffHiLo }, prereg,
  };
}

export async function runMatchedStudy({ symbols: only = null, from, to, cacheDir, now = Date.now() }) {
  const symbols = (await readdir(cacheDir)).filter((s) => /^[A-Z0-9]{2,30}$/.test(s) && (!only || only.includes(s))).sort();
  const accs = Object.fromEntries(TIMING_COMBOS.map((c) => [c.key, newAcc()]));
  const skipped = [];
  let minTime = Infinity;
  let maxTime = -Infinity;
  for (const symbol of symbols) {
    const byTf = {};
    for (const tf of ['15m', '1h']) {
      try {
        const c = await loadCached(cacheDir, symbol, tf, from, to);
        if (c?.length) byTf[tf] = c;
      } catch (err) {
        skipped.push(`${symbol} ${tf}: ${String(err.message).slice(0, 120)}`);
      }
    }
    for (const tf of ['15m', '1h']) {
      const s = byTf[tf];
      if (!s?.length) continue;
      minTime = Math.min(minTime, s[Math.min(BACKTEST_WARMUP, s.length - 1)].closeTime);
      maxTime = Math.max(maxTime, s.at(-1).closeTime);
    }
    for (const combo of TIMING_COMBOS) {
      const B = byTf[combo.timeframe];
      if (!B || B.length <= BACKTEST_WARMUP) continue;
      if (combo.timeframe === '15m' && !byTf['1h']) {
        skipped.push(`${symbol} 15m: konteks 1h tidak ada`);
        continue;
      }
      const started = Date.now();
      const s = await studySeries({ symbol, combo, byTf, acc: accs[combo.key] });
      log(`${symbol} ${combo.key}: ${B.length} candle, alert v3 ${s.alerts} (${Date.now() - started} ms)`);
    }
  }
  const testStart = minTime + (maxTime - minTime) * RUNNER_DEFAULTS.trainFraction;
  return {
    generatedAt: new Date(now).toISOString(),
    from: new Date(from).toISOString().slice(0, 10), to: new Date(to).toISOString().slice(0, 10),
    symbols, skipped, testStart, fee: { feeBps: RUNNER_DEFAULTS.feeBps, slippageBps: RUNNER_DEFAULTS.slippageBps },
    design: { ...MATCH_DEFAULTS, primaryDonchian: PRIMARY_DONCHIAN, blocks: BLOCKS, preThresholdAtr: PRE_THRESHOLD_ATR, oldCohortBefore: OLD_COHORT_BEFORE },
    combos: Object.fromEntries(TIMING_COMBOS.map((c) => [c.key, summarizeCombo(accs[c.key], testStart)])),
  };
}

const pct = (x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1).replace('.', ',')}%`);
const num = (x, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d).replace('.', ',')}`);
const fmtVal = (x, fmt) => (fmt === 'pct' ? pct(x) : num(x));
const fmtDiff = (x, fmt) => (fmt === 'pct' ? (x === null || x === undefined ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1).replace('.', ',')} pp`) : num(x));
const fmtCi = (ci, fmt) => (ci ? `[${fmtDiff(ci.lo, fmt)} … ${fmtDiff(ci.hi, fmt)}]` : '—');

export function renderMatchedMarkdown(result) {
  const md = [
    '# Studi informasi di luar momentum — AlphaLens',
    '',
    `Dibuat ${result.generatedAt} · ${result.symbols.length} simbol cache Binance USDT-M · sinyal ${result.from} → ${result.to} · `
      + `fee ${result.fee.feeBps} + slippage ${result.fee.slippageBps} bps per sisi`,
    '',
    'Desain dikunci sebelum run (docs/25 §1). Pembanding = candle tanpa sinyal (≥ 13 candle dari alert v2/v3 arah sama) di strata',
    'simbol × kuartal × gerak awal 12 candle (bin 0,5 ATR) × posisi rentang 48 (bin 0,2) × tersil ATR% per simbol × kuartal.',
    'Selisih (ATT) = rata-rata (hasil alert − rata-rata pembanding strata). CI = moving-block bootstrap atas hari kalender',
    '(blok 7 hari = utama; 14 hari & harian = sensitivitas), semua simbol pada hari yang sama selalu satu blok.',
    '',
  ];
  if (result.skipped.length) md.push(`Seri dilewati: ${result.skipped.join('; ')}`, '');
  for (const combo of TIMING_COMBOS) {
    const s = result.combos[combo.key];
    if (!s) continue;
    md.push(`## ${combo.label}`, '');
    md.push(`**Pembacaan utama (gerak lanjutan 12 candle, CI blok 7 hari): ${s.verdict}.**`, '');
    md.push(`Alert ${s.alerts} · cocok ${s.matched} (${pct(s.alerts ? s.matched / s.alerts : null)}), tanpa pembanding ${s.unmatched} · `
      + `median pembanding per alert ${s.medianControls ?? '—'} · candle memenuhi syarat ${s.candles.toLocaleString('id-ID')}`, '');
    md.push('### A. Alert vs pembanding dicocokkan', '');
    md.push('| Hasil | Alert | Pembanding cocok | Selisih (ATT) | CI blok 7 hari | CI blok 14 hari | CI harian | Semua candle |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const o of OUTCOMES) {
      const x = s.outcome[o.key];
      md.push(`| ${o.label} | ${fmtVal(x.alert, o.fmt)} | ${fmtVal(x.ctrl, o.fmt)} | ${fmtDiff(x.att[7]?.mean, o.fmt)} | ${fmtCi(x.att[7], o.fmt)} | ${fmtCi(x.att[14], o.fmt)} | ${fmtCi(x.att[1], o.fmt)} | ${fmtVal(x.all, o.fmt)} |`);
    }
    md.push('');
    md.push(`Keseimbangan kovariat (alert vs pembanding cocok): gerak awal ${num(s.balance.pre.alert)} vs ${num(s.balance.pre.ctrl)} ATR · `
      + `posisi rentang ${s.balance.pos.alert?.toFixed(3).replace('.', ',')} vs ${s.balance.pos.ctrl?.toFixed(3).replace('.', ',')} · `
      + `ATR% ${pct(s.balance.vol.alert)} vs ${pct(s.balance.vol.ctrl)}`, '');
    md.push('### B. Kohort simbol', '');
    md.push('| Kohort | n cocok | Selisih gerak 12 candle [CI 7 hari] | Selisih breakout Donchian 48 [CI 7 hari] |', '| --- | --- | --- | --- |');
    for (const [k, c] of Object.entries(s.cohorts)) {
      md.push(`| ${k === 'lama' ? 'Lama (data sejak Jan 2024)' : 'Baru'} | ${c.n} | ${num(c.fwd12?.mean)} ${fmtCi(c.fwd12, 'atr')} | ${fmtDiff(c.brk48?.mean, 'pct')} ${fmtCi(c.brk48, 'pct')} |`);
    }
    md.push('');
    md.push('### C. Sensitivitas definisi breakout docs/24 (porsi alert vs semua candle)', '');
    md.push('| Donchian | Sebelum | Saat | Sesudah |', '| --- | --- | --- | --- |');
    for (const d of DONCHIANS) {
      const t = s.timing[d];
      md.push(`| ${d}${d === PRIMARY_DONCHIAN ? ' (utama)' : ''} | ${pct(t.alerts.SEBELUM)} vs ${pct(t.all.SEBELUM)} | ${pct(t.alerts.SAAT)} vs ${pct(t.all.SAAT)} | ${pct(t.alerts.SESUDAH)} vs ${pct(t.all.SESUDAH)} |`);
    }
    md.push('');
    md.push('### D. R trade (docs/24) dengan CI blok', '');
    md.push('| Kelompok | n | R bersih | CI blok 7 hari | CI blok 14 hari | CI harian |', '| --- | --- | --- | --- | --- | --- |');
    for (const g of s.trades.groups) md.push(`| ${g.label} | ${g.n} | ${num(g.meanR)}R | ${fmtCi(g.ci[7], 'atr')} | ${fmtCi(g.ci[14], 'atr')} | ${fmtCi(g.ci[1], 'atr')} |`);
    const dl = s.trades.diffHiLo;
    md.push('', `Selisih ≥ − < ${PRE_THRESHOLD_ATR} ATR (satu posisi per simbol): ${num(dl[7]?.diff)}R · CI 7 hari ${fmtCi(dl[7], 'atr')} · 14 hari ${fmtCi(dl[14], 'atr')} · harian ${fmtCi(dl[1], 'atr')}`, '');
    const p = s.prereg;
    md.push('### E. Persiapan praregistrasi (≥ ambang, satu posisi per simbol)', '');
    md.push(`n ${p.n} · R bersih ${num(p.meanR)} · SD ${p.sdR?.toFixed(2).replace('.', ',') ?? '—'} · efek desain ${p.deff?.toFixed(2).replace('.', ',') ?? '—'} · `
      + `biaya stres 5 + 5 bps ${num(p.stressMeanR)}R · trade per simbol-bulan ${p.tradesPerSymbolMonth?.toFixed(3).replace('.', ',') ?? '—'} (${p.symbolMonths} simbol-bulan) · `
      + `n untuk daya 80%: ${p.nRequiredObserved ?? '—'} (efek teramati) / ${p.nRequiredHalf ?? '—'} (setengah efek)`, '');
  }
  md.push('Catatan: deskriptif pada data yang sudah dilihat (docs/24); bukan aturan entri. Daftar simbol cache dipilih menurut volume 2026-10.', '');
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
  if (from >= to) throw new RangeError('--from harus sebelum --to');
  const symbols = v.symbols ? v.symbols.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : null;
  const started = Date.now();
  const result = await runMatchedStudy({ symbols, from, to, cacheDir: resolve(ROOT, v['cache-dir']), now: started });
  result.durationS = Math.round((Date.now() - started) / 1000);
  const out = resolve(v.out);
  await mkdir(out, { recursive: true });
  const slug = result.generatedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  await writeFile(join(out, `matched-${slug}.md`), renderMatchedMarkdown(result), 'utf8');
  await writeFile(join(out, `matched-${slug}.json`), JSON.stringify(result, null, 2), 'utf8');
  log(`Selesai dalam ${result.durationS} s → ${join(out, `matched-${slug}.md`)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err) => {
    log(`Riset gagal: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
}
