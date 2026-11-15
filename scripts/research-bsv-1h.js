// Riset BSV-1h (LONG 1h, "Breakout Struktur Bervolume"): uji ulang jendela eksplorasi (paritas alat) atau uji LUAR
// SAMPEL yang dipraregistrasi di docs/23. Riset saja: tidak menyentuh database, worker, atau scanner live.
//
// Pakai:
//   npm run research:bsv -- --window explore                # paritas eksplorasi Jul–Sep 2026 (tanpa funding)
//   npm run research:bsv -- --window explore --funding on   # sama, dengan funding historis
//   npm run research:bsv -- --window oos                    # uji keputusan 2024-01-15 → 2026-06-28 (dengan funding)
//
// Data kline 1h dibaca dari cache backtest (data/backtest-cache; bulan lengkap hanya dibaca). Funding historis diambil
// lewat klien REST proyek (DNS sesuai BINANCE_DNS) dan di-cache per bulan. Laporan JSON & Markdown ke reports/research/.

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_CACHE_DIR, loadFromBinance } from '../backend/backtest/dataSource.js';
import { dayClusterBootstrapMean, longTripleBarrier, pairedDayBootstrapDiff, summarizeEvents } from '../backend/backtest/eventStudy.js';
import { loadFundingRates } from '../backend/backtest/funding.js';
import { createBinanceRestClient } from '../backend/ingestion/binance/restClient.js';
import { atr } from '../backend/indicators/index.js';
import { BSV_1H_V1, detectBsvSignals, isFirstBreak } from '../backend/research/bsv1h.js';
import { classifyTrend } from '../backend/timeframe/trend.js';

const H = 3_600_000;
const H4 = 4 * H;
const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Jendela dibekukan di praregistrasi docs/23. `explore` = jendela yang SUDAH dilihat (hanya untuk paritas alat).
export const WINDOWS = Object.freeze({
  explore: {
    label: 'eksplorasi (paritas alat)', from: Date.UTC(2026, 6, 1), to: Date.UTC(2026, 8, 29),
    loadFrom: Date.UTC(2026, 4, 1), loadTo: Date.UTC(2026, 9, 1), universe: 'explore', fundingDefault: 'off',
  },
  oos: {
    label: 'luar sampel terpraregistrasi', from: Date.UTC(2024, 0, 15), to: Date.UTC(2026, 5, 28),
    loadFrom: Date.UTC(2024, 0, 1), loadTo: Date.UTC(2026, 6, 1), universe: 'all', fundingDefault: 'on',
  },
});
export const COST_PRIMARY = 2 * (0.0005 + 0.0002); // fee taker 5 bps + slippage 2 bps per sisi
export const COST_STRESS = 2 * (0.0005 + 0.0005); // fee 5 bps + slippage 5 bps per sisi
export const MIN_HISTORY = 300; // riwayat minimum (candle 1h) sebelum sinyal di jendela oos
export const SUBPERIODS = Object.freeze([
  ['2024', Date.UTC(2024, 0, 1), Date.UTC(2025, 0, 1)],
  ['2025', Date.UTC(2025, 0, 1), Date.UTC(2026, 0, 1)],
  ['2026H1', Date.UTC(2026, 0, 1), Date.UTC(2026, 6, 1)],
]);
// File yang menentukan hasil; hash SHA-256-nya dicatat di praregistrasi sebelum uji oos dijalankan.
export const FROZEN_FILES = Object.freeze([
  'backend/research/bsv1h.js', 'backend/backtest/eventStudy.js', 'backend/backtest/funding.js', 'scripts/research-bsv-1h.js',
]);

const mean = (arr, key = 'netR') => (arr.length ? arr.reduce((acc, e) => acc + e[key], 0) / arr.length : null);
const fmt = (v, d = 3) => (v === null || v === undefined || Number.isNaN(v) ? '–' : Number(v).toFixed(d));
const round = (v) => (typeof v === 'number' && !Number.isInteger(v) ? Number(v.toFixed(4)) : v);
const fmtValue = (v) => {
  if (typeof v === 'string') return v;
  if (v !== null && typeof v === 'object') return JSON.stringify(v, (_k, x) => round(x));
  return fmt(v);
};
// Kolom per trade yang diekspor ke JSON (audit & analisis ulang tanpa menjalankan ulang).
const TRADE_FIELDS = Object.freeze([
  's', 't', 'index', 'outcome', 'grossR', 'costR', 'fundingR', 'netR', 'netRStress', 'rvol', 'firstBreak', 'nonOverlap', 'trend4h', 'established',
]);

async function firstCachedMonth(cacheDir, symbol) {
  try {
    const files = (await readdir(join(cacheDir, symbol, '1h'))).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).sort();
    return files.length ? files[0].slice(0, 7) : null;
  } catch {
    return null;
  }
}

/** Candle 4h dari 1h, hanya grup lengkap & bersambung (batas 00/04/08… UTC, sama dengan Binance). */
function aggregate4h(c1) {
  const out = [];
  let i = 0;
  while (i < c1.length) {
    const g = Math.floor(c1[i].openTime / H4) * H4;
    let j = i;
    while (j < c1.length && Math.floor(c1[j].openTime / H4) * H4 === g) j += 1;
    const grp = c1.slice(i, j);
    if (grp.length === 4 && grp.every((c, k) => c.openTime === g + k * H)) {
      out.push({
        openTime: g, closeTime: g + H4 - 1, open: grp[0].open, high: Math.max(...grp.map((c) => c.high)),
        low: Math.min(...grp.map((c) => c.low)), close: grp[3].close, volume: grp.reduce((a, c) => a + c.volume, 0),
      });
    }
    i = j;
  }
  return out;
}

/** Label tren 4h (laporan saja, bukan syarat): candle 4h dengan closeTime ≤ closeTime candle sinyal. */
function trend4hLabeler(c1) {
  const c4 = aggregate4h(c1);
  const trends = c4.map((_, k) => (k < 30 ? 'NEUTRAL' : classifyTrend(c4.slice(Math.max(0, k - 74), k + 1)).trend));
  return (index) => {
    const closeT = c1[index].openTime + H - 1;
    let lo = 0;
    let hi = c4.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (c4[mid].closeTime <= closeT) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 ? trends[lo - 1] : 'NEUTRAL';
  };
}

async function loadUniverse(window, cacheDir) {
  const symbols = (await readdir(cacheDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const loaded = [];
  for (const symbol of symbols) {
    const first = await firstCachedMonth(cacheDir, symbol);
    if (!first) continue;
    const from = Math.max(window.loadFrom, Date.parse(`${first}-01T00:00:00Z`));
    if (from >= window.loadTo) continue;
    const { candles } = await loadFromBinance({ symbol, timeframe: '1h', from, to: window.loadTo, cacheDir });
    if (candles.length < 2) continue;
    const inWindow = candles.filter((c) => c.openTime >= window.from && c.openTime < window.to);
    loaded.push({
      symbol, candles, established: first <= '2024-01', inWindow: inWindow.length,
      warm: candles.filter((c) => c.openTime < window.from).length,
      quoteVolume: inWindow.reduce((acc, c) => acc + c.quoteVolume, 0),
    });
  }
  if (window.universe === 'explore') {
    // Aturan eksplorasi: cakupan ≥ 90% jendela, ≥ 300 candle pemanasan, 30 teratas menurut quote volume di jendela.
    const need = 0.9 * ((window.to - window.from) / H);
    return loaded.filter((u) => u.inWindow >= need && u.warm >= 300).sort((a, b) => b.quoteVolume - a.quoteVolume).slice(0, 30);
  }
  // Aturan oos (praregistrasi): semua simbol ber-cache; sinyal & baseline baru dihitung setelah ≥ MIN_HISTORY candle.
  return loaded.filter((u) => u.inWindow > 0).sort((a, b) => b.quoteVolume - a.quoteVolume);
}

/** Sinyal & baseline satu simbol. Baseline B0 = setiap candle di jendela, geometri/biaya/funding sama, tanpa jeda. */
function studySymbol(u, window, { funding, minHistory }) {
  const p = BSV_1H_V1;
  const c = u.candles;
  const atrs = atr(c, p.atrPeriod);
  const stressFactor = COST_STRESS / COST_PRIMARY;
  const barrierAt = (i, a) => longTripleBarrier(c, i, {
    stopDistance: p.stopAtr * a, targetR: p.targetR, maxBars: p.maxBars, costRoundTrip: COST_PRIMARY, funding, intervalMs: H,
  });
  const toEvent = (i, b) => ({
    s: u.symbol, t: c[i].openTime, index: i, established: u.established, ...b,
    netRStress: b.grossR - b.costR * stressFactor - b.fundingR,
  });
  const baseline = [];
  for (let i = Math.max(p.minIndex, minHistory); i < c.length - 1; i += 1) {
    if (c[i].openTime < window.from || c[i].openTime >= window.to) continue;
    const a = atrs[i];
    if (!(a > 0)) continue;
    const b = barrierAt(i, a);
    if (b) baseline.push(toEvent(i, b));
  }
  const signals = [];
  const label4h = trend4hLabeler(c);
  let busyUntil = -1;
  for (const sg of detectBsvSignals(c, { from: window.from, to: window.to, minHistory })) {
    const b = barrierAt(sg.index, sg.atr);
    if (!b) continue;
    const nonOverlap = sg.index > busyUntil;
    if (nonOverlap) busyUntil = b.exitIndex;
    signals.push({ ...toEvent(sg.index, b), rvol: sg.rvol, firstBreak: isFirstBreak(c, sg), nonOverlap, trend4h: label4h(sg.index) });
  }
  return { signals, baseline };
}

function cell(events, baseline) {
  const s = summarizeEvents(events);
  if (!s.n) return { n: 0 };
  const ci = dayClusterBootstrapMean(events, { seed: 7 });
  return { ...s, netCI: ci ? [ci.lo, ci.hi] : null, days: ci?.days ?? null, diffVsBaseline: pairedDayBootstrapDiff(events, baseline, { seed: 11 }) };
}

/** Kriteria praregistrasi (docs/23). Keputusan LULUS hanya bila SEMUA terpenuhi. */
export function evaluateCriteria(report) {
  const d = report.decision;
  const sub = report.subperiods.filter((p) => p.signals.n > 0 && p.baseline.n > 0);
  const subWins = sub.filter((p) => p.diff > 0).length;
  const criteria = [
    { id: 'P0', text: 'n sinyal ≥ 200', pass: d.n >= 200, value: d.n },
    { id: 'P1', text: 'rata-rata R bersih > 0 dan batas bawah CI 95% (klaster harian) > 0', pass: d.meanNetR > 0 && Array.isArray(d.netCI) && d.netCI[0] > 0, value: d.netCI },
    { id: 'P2', text: 'selisih terhadap baseline: batas bawah CI 95% (bootstrap berpasangan harian) > 0', pass: Boolean(d.diffVsBaseline) && d.diffVsBaseline.lo > 0, value: d.diffVsBaseline },
    { id: 'P3', text: 'selisih terhadap baseline > 0 di ≥ 2 dari 3 sub-periode (2024, 2025, 2026H1)', pass: subWins >= 2, value: `${subWins}/${sub.length}` },
    { id: 'P4', text: 'rata-rata R bersih dengan biaya stres 5+5 bps per sisi > 0', pass: report.stress.meanNetR > 0, value: report.stress.meanNetR },
    { id: 'P5', text: 'leave-one-symbol-out: rata-rata R bersih minimum > 0', pass: report.leaveOneOut.min > 0, value: report.leaveOneOut },
  ];
  return { criteria, verdict: criteria.every((c) => c.pass) ? 'LULUS' : 'TIDAK LULUS' };
}

function buildReport({ window, fundingMode, universe, signals, baseline, hashes, fundingStats }) {
  const subperiods = SUBPERIODS.map(([name, from, to]) => {
    const sg = signals.filter((e) => e.t >= from && e.t < to);
    const bl = baseline.filter((e) => e.t >= from && e.t < to);
    return { name, signals: summarizeEvents(sg), baseline: summarizeEvents(bl), diff: sg.length && bl.length ? mean(sg) - mean(bl) : null };
  }).filter((p) => p.signals.n > 0 || p.baseline.n > 0);
  const bySymbol = new Map();
  for (const e of signals) {
    if (!bySymbol.has(e.s)) bySymbol.set(e.s, []);
    bySymbol.get(e.s).push(e);
  }
  const loo = [...bySymbol.keys()].map((s) => ({ s, mean: mean(signals.filter((e) => e.s !== s)) }));
  const baselineCI = dayClusterBootstrapMean(baseline, { seed: 7 });
  const report = {
    study: 'BSV-1h v1 (LONG 1h, Breakout Struktur Bervolume)',
    generatedAt: new Date().toISOString(),
    window: { name: window.label, from: new Date(window.from).toISOString(), to: new Date(window.to).toISOString() },
    params: BSV_1H_V1,
    costs: { primaryRoundTrip: COST_PRIMARY, stressRoundTrip: COST_STRESS },
    funding: fundingMode,
    fundingStats,
    universe: universe.map((u) => ({ symbol: u.symbol, established: u.established, candlesInWindow: u.inWindow })),
    hashes,
    baseline: { ...summarizeEvents(baseline), netCI: baselineCI ? [baselineCI.lo, baselineCI.hi] : null },
    decision: cell(signals, baseline),
    stress: { meanNetR: mean(signals, 'netRStress') },
    subperiods,
    leaveOneOut: loo.length
      ? { min: Math.min(...loo.map((x) => x.mean)), max: Math.max(...loo.map((x) => x.mean)), worstWithout: loo.reduce((a, b) => (b.mean < a.mean ? b : a)).s }
      : { min: null, max: null, worstWithout: null },
    perSymbol: [...bySymbol.entries()].map(([s, a]) => ({ s, n: a.length, meanNetR: mean(a) })).sort((x, y) => y.meanNetR - x.meanNetR),
    robustness: {
      nonOverlap: cell(signals.filter((e) => e.nonOverlap), baseline),
      firstBreak: cell(signals.filter((e) => e.firstBreak), baseline),
      established: cell(signals.filter((e) => e.established), baseline.filter((e) => e.established)),
      newer: cell(signals.filter((e) => !e.established), baseline.filter((e) => !e.established)),
      trend4h: Object.fromEntries(['BULLISH', 'NEUTRAL', 'BEARISH'].map((tr) => [tr, summarizeEvents(signals.filter((e) => e.trend4h === tr))])),
    },
    trades: signals.map((e) => TRADE_FIELDS.map((k) => round(e[k]))),
    tradeFields: TRADE_FIELDS,
  };
  report.evaluation = evaluateCriteria(report);
  return report;
}

function renderMarkdown(r) {
  const lines = [];
  lines.push(`# ${r.study}: ${r.window.name}`, '');
  lines.push(`Jendela sinyal ${r.window.from.slice(0, 10)} → ${r.window.to.slice(0, 10)} · ${r.universe.length} simbol · funding ${r.funding} · biaya ${fmt(r.costs.primaryRoundTrip * 1e4, 0)} bps pulang-pergi (stres ${fmt(r.costs.stressRoundTrip * 1e4, 0)} bps)`, '');
  lines.push('| Sel | n | Win rate | R kotor | Biaya R | Funding R | R bersih [CI 95% klaster harian] | Selisih vs baseline [CI 95%] |');
  lines.push('|---|---|---|---|---|---|---|---|');
  const row = (name, c) => {
    if (!c || !c.n) return `| ${name} | 0 | | | | | | |`;
    const ci = c.netCI ? ` [${fmt(c.netCI[0])} … ${fmt(c.netCI[1])}]` : '';
    const df = c.diffVsBaseline ? `${fmt(c.diffVsBaseline.diff)} [${fmt(c.diffVsBaseline.lo)} … ${fmt(c.diffVsBaseline.hi)}]` : '';
    return `| ${name} | ${c.n} | ${fmt(c.winRate * 100, 1)}% | ${fmt(c.meanGrossR)} | ${fmt(c.meanCostR)} | ${fmt(c.meanFundingR)} | ${fmt(c.meanNetR)}${ci} | ${df} |`;
  };
  lines.push(row('Baseline B0 (semua candle)', r.baseline));
  lines.push(row('**BSV-1h v1 (keputusan)**', r.decision));
  lines.push(row('Ketahanan: tanpa tumpang tindih', r.robustness.nonOverlap));
  lines.push(row('Ketahanan: tembusan pertama', r.robustness.firstBreak));
  lines.push(row('Ketahanan: simbol sejak 2024-01', r.robustness.established));
  lines.push(row('Ketahanan: simbol lebih baru', r.robustness.newer));
  lines.push('');
  lines.push(`Biaya stres 5+5 bps: R bersih ${fmt(r.stress.meanNetR)} · leave-one-symbol-out min ${fmt(r.leaveOneOut.min)} (tanpa ${r.leaveOneOut.worstWithout ?? '–'}), maks ${fmt(r.leaveOneOut.max)}`, '');
  lines.push('| Sub-periode | n sinyal | R bersih sinyal | R bersih baseline | Selisih |', '|---|---|---|---|---|');
  for (const p of r.subperiods) lines.push(`| ${p.name} | ${p.signals.n} | ${fmt(p.signals.meanNetR)} | ${fmt(p.baseline.meanNetR)} | ${fmt(p.diff)} |`);
  lines.push('', '| Tren 4h saat sinyal (laporan saja) | n | R bersih |', '|---|---|---|');
  for (const [k, v] of Object.entries(r.robustness.trend4h)) lines.push(`| ${k} | ${v.n} | ${fmt(v.meanNetR)} |`);
  lines.push('', `## Kriteria praregistrasi → **${r.evaluation.verdict}**`, '');
  for (const c of r.evaluation.criteria) {
    lines.push(`- ${c.pass ? '✅' : '❌'} ${c.id}: ${c.text} (nilai: ${fmtValue(c.value)})`);
  }
  lines.push('', 'Hash SHA-256 file yang dibekukan:');
  for (const [f, h] of Object.entries(r.hashes)) lines.push(`- \`${f}\`: \`${h}\``);
  return lines.join('\n');
}

async function main() {
  const { values } = parseArgs({
    options: {
      window: { type: 'string', default: 'explore' },
      funding: { type: 'string' },
      'cache-dir': { type: 'string', default: DEFAULT_CACHE_DIR },
      'out-dir': { type: 'string', default: 'reports/research' },
    },
  });
  const window = WINDOWS[values.window];
  if (!window) throw new Error(`--window harus salah satu dari: ${Object.keys(WINDOWS).join(', ')}`);
  const fundingMode = values.funding ?? window.fundingDefault;
  if (!['on', 'off'].includes(fundingMode)) throw new Error('--funding harus on atau off');
  const cacheDir = values['cache-dir'];
  const minHistory = window.universe === 'all' ? MIN_HISTORY : 0;

  const hashes = {};
  for (const f of FROZEN_FILES) hashes[f] = createHash('sha256').update(await readFile(join(ROOT, f))).digest('hex');

  const universe = await loadUniverse(window, cacheDir);
  const client = fundingMode === 'on'
    ? createBinanceRestClient({ logger: { warn: (o, m) => console.error(`[binance] ${m ?? ''} ${JSON.stringify(o)}`) } })
    : null;
  const signals = [];
  const baseline = [];
  const fundingStats = { requests: 0, fetchedMonths: 0, cachedMonths: 0 };
  for (const u of universe) {
    let funding = null;
    if (client) {
      const { rates, stats } = await loadFundingRates({ symbol: u.symbol, from: window.loadFrom, to: window.loadTo, client, cacheDir });
      funding = { times: rates.map((r) => r.fundingTime), rates: rates.map((r) => r.fundingRate) };
      fundingStats.requests += stats.requests;
      fundingStats.fetchedMonths += stats.fetchedMonths;
      fundingStats.cachedMonths += stats.cachedMonths;
    }
    const result = studySymbol(u, window, { funding, minHistory });
    signals.push(...result.signals);
    baseline.push(...result.baseline);
  }

  const report = buildReport({ window, fundingMode, universe, signals, baseline, hashes, fundingStats });
  const outDir = join(ROOT, values['out-dir']);
  await mkdir(outDir, { recursive: true });
  const base = `bsv-1h-${values.window}-funding-${fundingMode}`;
  await writeFile(join(outDir, `${base}.json`), JSON.stringify(report, null, 2));
  const md = renderMarkdown(report);
  await writeFile(join(outDir, `${base}.md`), md);
  console.log(md);
  console.log(`\nLaporan: ${join(values['out-dir'], base)}.json dan .md`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
