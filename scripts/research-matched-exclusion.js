// Sensitivitas PASCA-RUN untuk docs/25 §2 (tidak dikunci sebelum run): seberapa besar hasil pembanding dicocokkan
// bergantung pada jendela pengecualian kandidat pembanding? Desain terkunci (docs/25 §1.2) membuang candle yang berjarak
// ≤ 12 candle dari alert v2/v3, TERMASUK candle sebelum alert. Bagian "sebelum" memakai data masa depan: candle yang tidak
// diikuti alert dalam 12 candle berikutnya cenderung tidak menguat, sehingga pembanding tampak lebih buruk dan selisih
// (ATT) terlalu besar. Varian kausal di sini hanya memakai informasi yang sudah ada pada candle itu. File yang hash-nya
// dikunci (docs/25 §1.6) tidak diubah; fungsi pencocokan & bootstrap dipakai apa adanya. Riset saja.
//
// Pakai:
//   npm run research:matched-exclusion                  # semua simbol cache, 4 proses paralel
//   npm run research:matched-exclusion -- --jobs 1      # satu proses (hasil sama)
//
// Varian (candle k dikeluarkan dari kumpulan pembanding bila ada alert e dengan e − before ≤ k ≤ e + after):
//   simetris  before 12, after 12   desain terkunci (memakai masa depan); harus mereproduksi `npm run research:matched`
//   lampau    before 0,  after 12   alert di candle k atau 12 candle sebelumnya (kausal)
//   tanpa     before 0,  after 0    hanya candle alert itu sendiri (kausal)

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { BACKTEST_WARMUP, replaySeries } from '../backend/backtest/runner.js';
import { atr } from '../backend/indicators/index.js';
import {
  MATCH_DEFAULTS, addControl, binOf, breakoutWithin, forwardMove, matchAlerts, movingBlockBootstrapMean, quantileCuts,
  quarterOf, stratumKey,
} from '../backend/research/matchedBaseline.js';
import { breakoutFlags, timingAt } from '../backend/research/signalTiming.js';
import { OUTCOMES, verdictOf } from './research-matched.js';
import { TIMING_COMBOS, loadCached } from './research-timing.js';
import { RESEARCH_SNAPSHOT_DIR, assertBeforeMomWindow } from './research-window-guard.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = fileURLToPath(import.meta.url);
const { look: LOOK, horizons: HORIZONS, donchians: DONCHIANS } = MATCH_DEFAULTS;
const PRIMARY_DONCHIAN = 48;
const BLOCKS = Object.freeze([7, 14, 1]); // 7 hari = CI utama
const OLD_COHORT_BEFORE = Date.UTC(2024, 1, 1); // sama dengan scripts/research-matched.js
const COVARIATES = Object.freeze(['pre', 'pos', 'vol']);

export const EXCLUSION_VARIANTS = Object.freeze([
  Object.freeze({ key: 'simetris', before: 12, after: 12, label: '±12 candle dari alert (desain terkunci; memakai masa depan)' }),
  Object.freeze({ key: 'lampau', before: 0, after: 12, label: 'alert di candle itu atau 12 candle sebelumnya (kausal)' }),
  Object.freeze({ key: 'tanpa', before: 0, after: 0, label: 'hanya candle alert itu sendiri (kausal)' }),
]);

/**
 * Mask kandidat pembanding: candle k dikeluarkan (1) bila ada alert e dengan e − before ≤ k ≤ e + after.
 * before > 0 berarti candle dikeluarkan karena alert yang BELUM terjadi pada candle itu (informasi masa depan).
 */
export function exclusionMask(n, alertIndices, { before, after }) {
  const mask = new Uint8Array(n);
  for (const e of alertIndices) {
    for (let k = Math.max(0, e - before); k <= Math.min(n - 1, e + after); k += 1) mask[k] = 1;
  }
  return mask;
}

const log = (m) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${m}\n`);
const day = (s, name) => {
  const ms = Date.parse(`${s}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(ms)) throw new RangeError(`--${name} harus YYYY-MM-DD`);
  return ms;
};
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
const zeroStats = () => ({ n: 0, fwd12: 0, pre: 0 });

function emptyCombo() {
  return {
    series: 0,
    alerts: 0,
    all: { n: 0, sums: Object.fromEntries(OUTCOMES.map((o) => [o.key, 0])) },
    pool: Object.fromEntries(EXCLUSION_VARIANTS.map((v) => [v.key, zeroStats()])),
    lookahead: zeroStats(),
    variants: Object.fromEntries(EXCLUSION_VARIANTS.map((v) => [v.key, { matched: [], unmatched: 0 }])),
  };
}

function addStats(acc, part) {
  acc.n += part.n;
  acc.fwd12 += part.fwd12;
  acc.pre += part.pre;
}

function mergeCombo(acc, part) {
  acc.series += part.series;
  acc.alerts += part.alerts;
  acc.all.n += part.all.n;
  for (const o of OUTCOMES) acc.all.sums[o.key] += part.all.sums[o.key];
  for (const v of EXCLUSION_VARIANTS) {
    addStats(acc.pool[v.key], part.pool[v.key]);
    acc.variants[v.key].unmatched += part.variants[v.key].unmatched;
    for (const m of part.variants[v.key].matched) acc.variants[v.key].matched.push(m);
  }
  addStats(acc.lookahead, part.lookahead);
}

/** Satu seri: sama persis dengan studySeries di scripts/research-matched.js, tetapi dengan tiga mask pengecualian. */
async function seriesRecords({ symbol, combo, byTf }) {
  const B = byTf[combo.timeframe];
  const dir = combo.direction;
  const res = await replaySeries({ symbol, timeframe: combo.timeframe, byTf });
  const A = atr(B, 14);
  const flags = Object.fromEntries(DONCHIANS.map((d) => [d, breakoutFlags(B, dir, d)]));
  const v3 = res.trades.v3.filter((t) => t.direction === dir);
  const v2 = res.trades.v2.filter((t) => t.direction === dir);
  const n = B.length;
  const alertIdx = [...v2, ...v3].map((t) => t.entryIndex);
  const masks = Object.fromEntries(EXCLUSION_VARIANTS.map((v) => [v.key, exclusionMask(n, alertIdx, v)]));
  const cohort = B[0].openTime < OLD_COHORT_BEFORE ? 'lama' : 'baru';
  const lo = BACKTEST_WARMUP;
  const hi = n - 1 - Math.max(...HORIZONS);
  const volByPeriod = new Map();
  for (let i = lo; i <= hi; i += 1) {
    if (!(A[i] > 0)) continue;
    const p = quarterOf(B[i].openTime);
    if (!volByPeriod.has(p)) volByPeriod.set(p, []);
    volByPeriod.get(p).push(A[i] / B[i].close);
  }
  const cuts = new Map([...volByPeriod].map(([p, vals]) => [p, quantileCuts(vals, MATCH_DEFAULTS.volBins)]));
  const alertAt = new Set(v3.map((t) => t.entryIndex));
  const controls = Object.fromEntries(EXCLUSION_VARIANTS.map((v) => [v.key, new Map()]));
  const part = emptyCombo();
  part.series = 1;
  const alerts = [];
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
    part.all.n += 1;
    for (const o of OUTCOMES) part.all.sums[o.key] += y[o.key];
    const stats = { n: 1, fwd12, pre: tm.pre };
    for (const v of EXCLUSION_VARIANTS) {
      if (masks[v.key][i]) continue;
      addControl(controls[v.key], key, y);
      addStats(part.pool[v.key], stats);
    }
    // Dikeluarkan desain terkunci HANYA karena alert yang menyusul ≤ 12 candle kemudian (sumber bias masa depan).
    if (masks.simetris[i] && !masks.lampau[i]) addStats(part.lookahead, stats);
    if (alertAt.has(i)) alerts.push({ key, y, t: B[i].closeTime, symbol, cohort });
  }
  part.alerts = alerts.length;
  for (const v of EXCLUSION_VARIANTS) {
    const { matched, unmatched } = matchAlerts(alerts, controls[v.key]);
    part.variants[v.key] = {
      matched: matched.map((m) => ({ symbol: m.symbol, t: m.t, cohort: m.cohort, nCtrl: m.nCtrl, y: m.y, ctrl: m.ctrl, diff: m.diff })),
      unmatched,
    };
  }
  return part;
}

/** Proses sekelompok simbol (dipakai langsung atau oleh proses pekerja). */
export async function collectShard({ symbols, from, to, cacheDir, onSeries = () => {} }) {
  const combos = Object.fromEntries(TIMING_COMBOS.map((c) => [c.key, emptyCombo()]));
  const skipped = [];
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
    for (const combo of TIMING_COMBOS) {
      const B = byTf[combo.timeframe];
      if (!B || B.length <= BACKTEST_WARMUP) continue;
      if (combo.timeframe === '15m' && !byTf['1h']) {
        skipped.push(`${symbol} 15m: konteks 1h tidak ada`);
        continue;
      }
      const started = Date.now();
      const part = await seriesRecords({ symbol, combo, byTf });
      mergeCombo(combos[combo.key], part);
      onSeries(`${symbol} ${combo.key}: ${B.length} candle, alert v3 ${part.alerts} (${Date.now() - started} ms)`);
    }
  }
  return { symbols, skipped, combos };
}

const ciSet = (events, value) => Object.fromEntries(BLOCKS.map((L) => [L, movingBlockBootstrapMean(events, { value, time: (e) => e.t, blockDays: L })]));
const avgStats = (s) => ({ n: s.n, fwd12: s.n ? s.fwd12 / s.n : null, pre: s.n ? s.pre / s.n : null });

function summarizeVariant(acc, key) {
  const { matched, unmatched } = acc.variants[key];
  const nCtrl = matched.map((m) => m.nCtrl).sort((a, b) => a - b);
  const outcome = Object.fromEntries(OUTCOMES.map((o) => [o.key, {
    alert: mean(matched.map((m) => m.y[o.key])),
    ctrl: mean(matched.map((m) => m.ctrl[o.key])),
    att: ciSet(matched, (m) => m.diff[o.key]),
  }]));
  const balance = Object.fromEntries(COVARIATES.map((c) => [c, { alert: mean(matched.map((m) => m.y[c])), ctrl: mean(matched.map((m) => m.ctrl[c])) }]));
  const cohorts = Object.fromEntries(['lama', 'baru'].map((k) => {
    const list = matched.filter((m) => m.cohort === k);
    return [k, { n: list.length, fwd12: movingBlockBootstrapMean(list, { value: (m) => m.diff.fwd12, time: (m) => m.t, blockDays: 7 }) }];
  }));
  return {
    matched: matched.length, unmatched, medianControls: nCtrl.length ? nCtrl[Math.floor(nCtrl.length / 2)] : null,
    pool: avgStats(acc.pool[key]), outcome, balance, cohorts, verdict: verdictOf(outcome.fwd12.att[7]),
  };
}

/** Gabungkan hasil pekerja (urutan alert = urutan simbol lalu waktu, sama dengan run tunggal) lalu ringkas per varian. */
export function summarizeShards(shards) {
  const symbols = [...new Set(shards.flatMap((s) => s.symbols))].sort();
  const rank = new Map(symbols.map((s, k) => [s, k]));
  const combos = {};
  for (const c of TIMING_COMBOS) {
    const acc = emptyCombo();
    for (const sh of shards) mergeCombo(acc, sh.combos[c.key]);
    for (const v of EXCLUSION_VARIANTS) acc.variants[v.key].matched.sort((a, b) => rank.get(a.symbol) - rank.get(b.symbol) || a.t - b.t);
    combos[c.key] = {
      series: acc.series, alerts: acc.alerts, candles: acc.all.n,
      all: Object.fromEntries(OUTCOMES.map((o) => [o.key, acc.all.n ? acc.all.sums[o.key] / acc.all.n : null])),
      lookahead: avgStats(acc.lookahead),
      variants: Object.fromEntries(EXCLUSION_VARIANTS.map((v) => [v.key, summarizeVariant(acc, v.key)])),
    };
  }
  return { symbols, skipped: shards.flatMap((s) => s.skipped), combos };
}

const pct = (x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1).replace('.', ',')}%`);
const num = (x, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d).replace('.', ',')}`);
const fmtDiff = (x, fmt) => (fmt === 'pct' ? (x === null || x === undefined ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1).replace('.', ',')} pp`) : num(x));
const fmtCi = (ci, fmt) => (ci ? `[${fmtDiff(ci.lo, fmt)} … ${fmtDiff(ci.hi, fmt)}]` : '—');
const withCi = (ci, fmt) => (ci ? `${fmtDiff(ci.mean, fmt)} ${fmtCi(ci, fmt)}` : '—');

export function renderExclusionMarkdown(result) {
  const md = [
    '# Sensitivitas jendela pengecualian pembanding (pasca-run) — AlphaLens',
    '',
    `Dibuat ${result.generatedAt} · ${result.symbols.length} simbol cache Binance USDT-M · sinyal ${result.from} → ${result.to}`,
    '',
    'Analisis PASCA-RUN, tidak dikunci sebelum run (docs/25 §2). Strata, hasil, dan bootstrap sama dengan desain terkunci;',
    'hanya kumpulan kandidat pembanding yang berbeda. Varian "simetris" = desain terkunci dan harus sama dengan laporan',
    '`npm run research:matched`. Candle k dikeluarkan bila ada alert v2/v3 (arah sama) e dengan e − before ≤ k ≤ e + after:',
    '',
    ...EXCLUSION_VARIANTS.map((v) => `- **${v.key}** (before ${v.before}, after ${v.after}): ${v.label}`),
    '',
  ];
  if (result.skipped.length) md.push(`Seri dilewati: ${result.skipped.join('; ')}`, '');
  for (const combo of TIMING_COMBOS) {
    const s = result.combos[combo.key];
    if (!s) continue;
    const la = s.lookahead;
    const base = s.variants.simetris.pool;
    md.push(`## ${combo.label}`, '');
    md.push(`Alert v3 ${s.alerts} · candle memenuhi syarat ${s.candles.toLocaleString('id-ID')} · semua candle: gerak lanjutan 12 candle ${num(s.all.fwd12)} ATR`, '');
    md.push(`Dikeluarkan desain terkunci HANYA karena alert menyusul ≤ 12 candle kemudian: ${la.n.toLocaleString('id-ID')} candle, `
      + `gerak awal ${num(la.pre)} ATR, gerak lanjutan 12 candle ${num(la.fwd12)} ATR (kandidat pembanding terkunci: `
      + `${base.n.toLocaleString('id-ID')} candle, gerak awal ${num(base.pre)}, gerak lanjutan ${num(base.fwd12)} ATR).`, '');
    md.push('| Pengecualian | Kandidat | Alert cocok | Median pembanding | Pembanding: gerak 12 | Selisih gerak 12 [CI 7 hari] | CI 14 hari | CI harian | Selisih gerak 48 [CI 7 hari] | Selisih breakout D48 [CI 7 hari] | Pembacaan |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const v of EXCLUSION_VARIANTS) {
      const x = s.variants[v.key];
      const f12 = x.outcome.fwd12;
      md.push(`| ${v.key} | ${x.pool.n.toLocaleString('id-ID')} | ${x.matched} (${pct(s.alerts ? x.matched / s.alerts : null)}) | ${x.medianControls ?? '—'} | `
        + `${num(f12.ctrl)} | ${withCi(f12.att[7], 'atr')} | ${fmtCi(f12.att[14], 'atr')} | ${fmtCi(f12.att[1], 'atr')} | `
        + `${withCi(x.outcome.fwd48.att[7], 'atr')} | ${withCi(x.outcome.brk48.att[7], 'pct')} | ${x.verdict.split(' (')[0]} |`);
    }
    md.push('');
    md.push('| Pengecualian | Gerak awal alert vs pembanding | Posisi rentang | ATR% | Breakout D24 [CI 7 hari] | Breakout D96 [CI 7 hari] | Kohort lama: gerak 12 [CI 7 hari] | Kohort baru |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const v of EXCLUSION_VARIANTS) {
      const x = s.variants[v.key];
      const b = x.balance;
      md.push(`| ${v.key} | ${num(b.pre.alert)} vs ${num(b.pre.ctrl)} | ${b.pos.alert?.toFixed(3).replace('.', ',')} vs ${b.pos.ctrl?.toFixed(3).replace('.', ',')} | `
        + `${pct(b.vol.alert)} vs ${pct(b.vol.ctrl)} | ${withCi(x.outcome.brk24.att[7], 'pct')} | ${withCi(x.outcome.brk96.att[7], 'pct')} | `
        + `${withCi(x.cohorts.lama.fwd12, 'atr')} (n ${x.cohorts.lama.n}) | ${withCi(x.cohorts.baru.fwd12, 'atr')} (n ${x.cohorts.baru.n}) |`);
    }
    md.push('');
  }
  md.push('Catatan: deskriptif pada data yang sudah dilihat (docs/24); bukan aturan entri.', '');
  return md.join('\n');
}

function runWorker(args) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', fail);
    child.on('exit', (code) => (code === 0 ? done() : fail(new Error(`proses pekerja keluar dengan kode ${code}`))));
  });
}

async function main(argv) {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      symbols: { type: 'string' }, from: { type: 'string', default: '2024-01-01' }, to: { type: 'string', default: '2026-10-01' },
      'cache-dir': { type: 'string', default: RESEARCH_SNAPSHOT_DIR }, out: { type: 'string', default: join(ROOT, 'reports', 'research') },
      jobs: { type: 'string', default: '4' }, worker: { type: 'boolean', default: false }, records: { type: 'string' },
    },
    strict: true,
  });
  const from = day(v.from, 'from');
  const to = day(v.to, 'to');
  assertBeforeMomWindow(to);
  if (from >= to) throw new RangeError('--from harus sebelum --to');
  const cacheDir = resolve(ROOT, v['cache-dir']);
  const only = v.symbols ? v.symbols.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : null;
  const symbols = (await readdir(cacheDir)).filter((s) => /^[A-Z0-9]{2,30}$/.test(s) && (!only || only.includes(s))).sort();
  if (v.worker) {
    if (!v.records) throw new RangeError('--worker butuh --records');
    const shard = await collectShard({ symbols, from, to, cacheDir, onSeries: log });
    await writeFile(v.records, JSON.stringify(shard), 'utf8');
    return;
  }
  const jobs = Number(v.jobs);
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 16) throw new RangeError('--jobs harus bilangan bulat 1..16');
  const started = Date.now();
  let shards;
  if (jobs === 1 || symbols.length < 2) {
    shards = [await collectShard({ symbols, from, to, cacheDir, onSeries: log })];
  } else {
    const tmp = await mkdtemp(join(tmpdir(), 'alphalens-exclusion-'));
    try {
      const groups = Array.from({ length: Math.min(jobs, symbols.length) }, () => []);
      symbols.forEach((s, k) => groups[k % groups.length].push(s));
      const files = groups.map((_, k) => join(tmp, `shard-${k}.json`));
      await Promise.all(groups.map((g, k) => runWorker([
        '--worker', '--symbols', g.join(','), '--records', files[k], '--from', v.from, '--to', v.to, '--cache-dir', cacheDir,
      ])));
      shards = await Promise.all(files.map(async (f) => JSON.parse(await readFile(f, 'utf8'))));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
  const result = { generatedAt: new Date(started).toISOString(), from: v.from, to: v.to, jobs, ...summarizeShards(shards) };
  result.durationS = Math.round((Date.now() - started) / 1000);
  const out = resolve(v.out);
  await mkdir(out, { recursive: true });
  const slug = result.generatedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  await writeFile(join(out, `matched-exclusion-${slug}.md`), renderExclusionMarkdown(result), 'utf8');
  await writeFile(join(out, `matched-exclusion-${slug}.json`), JSON.stringify(result, null, 2), 'utf8');
  log(`Selesai dalam ${result.durationS} s → ${join(out, `matched-exclusion-${slug}.md`)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err) => {
    log(`Riset gagal: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
}
