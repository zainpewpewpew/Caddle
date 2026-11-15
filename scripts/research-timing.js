// Riset timing sinyal live (docs/24): kapan alert pertama pola live muncul relatif terhadap breakout harga, seberapa
// jauh harga sudah bergerak saat alert, dan hasil trade per kelompok timing. Riset saja: tidak menyentuh database,
// worker, atau scanner live.
//   LONG 1h   = pola SA/PVA, perilaku live v3 (gerbang tier ≥ B)
//   SHORT 15m = pola SD/PVD, v3
//
// Pakai:
//   npm run research:timing                                  # semua simbol di cache, sinyal 2024-01-01 → 2026-10-01
//   npm run research:timing -- --symbols UNIUSDT,ZECUSDT      # sebagian simbol
//   npm run research:timing -- --from 2025-01-01 --to 2026-10-01
//
// Trade = replaySeries runner backtest (entri open candle berikutnya, stop invalidasi, target 2R, 48 candle, biaya
// bawaan runner). Definisi timing di backend/research/signalTiming.js. Kline dibaca dari cache backtest (hanya
// dibaca; seri dengan bulan yang belum ter-cache dilewati dan dicatat). Laporan Markdown & JSON ke reports/research/.

import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_CACHE_DIR, loadFromBinance } from '../backend/backtest/dataSource.js';
import { dayClusterBootstrapMean, wilsonInterval } from '../backend/backtest/eventStudy.js';
import { BACKTEST_WARMUP, RUNNER_DEFAULTS, replaySeries } from '../backend/backtest/runner.js';
import { atr } from '../backend/indicators/index.js';
import { TIMEFRAME_MS } from '../backend/market/contracts.js';
import { TIMING_DEFAULTS, TIMING_GROUPS, breakoutFlags, timingAt } from '../backend/research/signalTiming.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { donchian: DON, look: LOOK, atrPeriod: ATR_PERIOD } = TIMING_DEFAULTS;

export const TIMING_COMBOS = Object.freeze([
  Object.freeze({ key: 'LONG 1h', label: 'LONG 1h (SA/PVA)', direction: 'LONG', timeframe: '1h' }),
  Object.freeze({ key: 'SHORT 15m', label: 'SHORT 15m (SD/PVD)', direction: 'SHORT', timeframe: '15m' }),
]);
const GROUP_LABEL = {
  SEBELUM: `Sebelum breakout (tidak ada breakout dalam ${LOOK} candle terakhir)`,
  SAAT: 'Tepat di candle breakout',
  SESUDAH: `Sesudah breakout (breakout ≤ ${LOOK} candle sebelum alert)`,
};

const log = (m) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${m}\n`);
const day = (s, name) => {
  const ms = Date.parse(`${s}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(ms)) throw new RangeError(`--${name} harus YYYY-MM-DD`);
  return ms;
};

/** Bulan pertama yang ter-cache (simbol baru: bulan sebelum listing memang tidak ada di cache). */
async function firstCachedMonth(cacheDir, symbol, timeframe) {
  let files;
  try {
    files = (await readdir(join(cacheDir, symbol, timeframe))).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).sort();
  } catch {
    return null;
  }
  if (!files.length) return null;
  const [y, m] = files[0].slice(0, 7).split('-').map(Number);
  return Date.UTC(y, m - 1, 1);
}

async function loadCached(cacheDir, symbol, timeframe, from, to) {
  const first = await firstCachedMonth(cacheDir, symbol, timeframe);
  if (first === null) return null;
  const { candles } = await loadFromBinance({ symbol, timeframe, from: Math.max(from, first), to, cacheDir });
  return candles;
}

const sortedOf = (arr) => Float64Array.from(arr).sort();
const quantile = (s, p) => (s.length ? s[Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)))] : null);
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

/** n, win rate (Wilson), rata-rata R bersih dengan CI bootstrap berklaster per hari (waktu = entryTime). */
export function outcomeOf(list) {
  if (!list.length) return { n: 0 };
  const wins = list.reduce((s, e) => s + e.win, 0);
  const ci = dayClusterBootstrapMean(list, { value: (e) => e.r, time: (e) => e.t });
  const [winLo, winHi] = wilsonInterval(wins, list.length);
  return { n: list.length, winRate: wins / list.length, winLo, winHi, meanR: mean(list.map((e) => e.r)), lo: ci?.lo ?? null, hi: ci?.hi ?? null };
}

function summarizeCombo(a, testStart) {
  const { alerts } = a;
  const baseTotal = Object.values(a.base.cls).reduce((s, v) => s + v, 0);
  const preA = sortedOf(alerts.map((e) => e.pre));
  const preB = sortedOf(a.base.pre);
  const posA = sortedOf(alerts.map((e) => e.pos));
  const posB = sortedOf(a.base.pos);
  const share = (arr, pred) => (arr.length ? arr.filter(pred).length / arr.length : null);
  const classes = TIMING_GROUPS.map((g) => {
    const list = alerts.filter((e) => g.classes.includes(e.cls));
    const baseN = g.classes.reduce((s, c) => s + (a.base.cls[c] ?? 0), 0);
    return { key: g.key, label: GROUP_LABEL[g.key], alertShare: alerts.length ? list.length / alerts.length : null, baseShare: baseTotal ? baseN / baseTotal : null, outcome: outcomeOf(list) };
  });
  const followed = (n1, n2) => (n1 + n2 ? n1 / (n1 + n2) : null);
  const follow = {
    alerts: followed(alerts.filter((e) => e.cls === 'SEBELUM_DIIKUTI').length, alerts.filter((e) => e.cls === 'SEBELUM_TANPA').length),
    base: followed(a.base.cls.SEBELUM_DIIKUTI ?? 0, a.base.cls.SEBELUM_TANPA ?? 0),
  };
  const states = [...new Set(alerts.map((e) => e.state))].sort().map((state) => {
    const list = alerts.filter((e) => e.state === state);
    return { state, share: list.length / alerts.length, medianPre: quantile(sortedOf(list.map((e) => e.pre)), 0.5), outcome: outcomeOf(list) };
  });
  const cut1 = quantile(preA, 1 / 3);
  const cut2 = quantile(preA, 2 / 3);
  const terciles = [
    { lo: null, hi: cut1, list: alerts.filter((e) => e.pre < cut1) },
    { lo: cut1, hi: cut2, list: alerts.filter((e) => e.pre >= cut1 && e.pre < cut2) },
    { lo: cut2, hi: null, list: alerts.filter((e) => e.pre >= cut2) },
  ].map((t) => ({ lo: t.lo, hi: t.hi, outcome: outcomeOf(t.list) }));
  const testAlerts = alerts.filter((e) => e.t >= testStart);
  return {
    series: a.series, totalV3: a.totalV3, analysed: alerts.length, testAnalysed: testAlerts.length,
    all: outcomeOf(alerts), test: outcomeOf(testAlerts),
    pre: {
      alerts: { p25: quantile(preA, 0.25), median: quantile(preA, 0.5), p75: quantile(preA, 0.75), ge2: share(alerts, (e) => e.pre >= 2) },
      base: { p25: quantile(preB, 0.25), median: quantile(preB, 0.5), p75: quantile(preB, 0.75), ge2: preB.length ? preB.filter((x) => x >= 2).length / preB.length : null },
    },
    pos: {
      alerts: { median: quantile(posA, 0.5), ge90: share(alerts, (e) => e.pos >= 0.9) },
      base: { median: quantile(posB, 0.5), ge90: posB.length ? posB.filter((x) => x >= 0.9).length / posB.length : null },
    },
    classes, follow, states, terciles, baseCandles: baseTotal,
  };
}

const pct = (x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1).replace('.', ',')}%`);
const num = (x, d = 2) => (x === null || x === undefined ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d).replace('.', ',')}`);
const fmtR = (o) => (o.n ? `${num(o.meanR)}R [${num(o.lo)} … ${num(o.hi)}]` : '—');
const fmtW = (o) => (o.n ? `${pct(o.winRate)} (${pct(o.winLo)}–${pct(o.winHi)})` : '—');
const dec = (x) => (x === null || x === undefined ? '—' : x.toFixed(2).replace('.', ','));

export function renderTimingMarkdown(result) {
  const { fee } = result;
  const md = [
    '# Studi timing sinyal live AlphaLens',
    '',
    `Dibuat ${result.generatedAt} · ${result.symbols.length} simbol cache Binance USDT-M · sinyal ${result.from} → ${result.to} · `
      + `fee ${fee.feeBps} + slippage ${fee.slippageBps} bps per sisi`,
    '',
    `Definisi dikunci sebelum hasil dilihat (docs/24 §1): breakout = close menembus ekstrem ${DON} candle sebelumnya; jendela sebelum/sesudah ${LOOK} candle;`,
    `gerak awal = arah × (close sinyal − close ${LOOK} candle sebelumnya) ÷ ATR${ATR_PERIOD}. Pembanding = setiap candle pada seri yang sama.`,
    'R bersih = trade replay proyek (entri open berikutnya, stop invalidasi, target 2R, 48 candle). CI R = bootstrap berklaster per hari.',
    '',
  ];
  if (result.skipped.length) md.push(`Seri dilewati: ${result.skipped.join('; ')}`, '');
  for (const combo of TIMING_COMBOS) {
    const s = result.combos[combo.key];
    if (!s) continue;
    md.push(`## ${combo.label}`, '');
    md.push(`Seri ${s.series} · alert v3 ${s.totalV3} (tanpa OPEN & cukup data: ${s.analysed}; periode uji ≥ ${new Date(result.testStart).toISOString().slice(0, 10)}: `
      + `${s.testAnalysed}) · pembanding ${s.baseCandles.toLocaleString('id-ID')} candle`, '');
    md.push('| Hasil | n | Win rate (Wilson) | R bersih [CI 95% klaster harian] |', '| --- | --- | --- | --- |');
    md.push(`| Semua periode | ${s.all.n} | ${fmtW(s.all)} | ${fmtR(s.all)} |`);
    md.push(`| Periode uji (40% akhir) | ${s.test.n} | ${fmtW(s.test)} | ${fmtR(s.test)} |`, '');
    md.push('| Timing alert | Porsi alert | Porsi candle acak | n | Win rate | R bersih [CI 95%] |', '| --- | --- | --- | --- | --- | --- |');
    for (const c of s.classes) md.push(`| ${c.label} | ${pct(c.alertShare)} | ${pct(c.baseShare)} | ${c.outcome.n} | ${fmtW(c.outcome)} | ${fmtR(c.outcome)} |`);
    md.push('');
    md.push(`Dari alert "sebelum breakout", ${pct(s.follow.alerts)} diikuti breakout dalam ${LOOK} candle berikutnya; candle acak dalam kondisi sama: `
      + `${pct(s.follow.base)} (memakai data sesudah alert — deskriptif, bukan aturan).`, '');
    md.push(`| Gerak awal ${LOOK} candle (ATR) | p25 | median | p75 | ≥ 2 ATR | posisi rentang ${DON} (median) | posisi ≥ 0,9 |`, '| --- | --- | --- | --- | --- | --- | --- |');
    md.push(`| Alert | ${num(s.pre.alerts.p25)} | ${num(s.pre.alerts.median)} | ${num(s.pre.alerts.p75)} | ${pct(s.pre.alerts.ge2)} | ${dec(s.pos.alerts.median)} | ${pct(s.pos.alerts.ge90)} |`);
    md.push(`| Candle acak | ${num(s.pre.base.p25)} | ${num(s.pre.base.median)} | ${num(s.pre.base.p75)} | ${pct(s.pre.base.ge2)} | ${dec(s.pos.base.median)} | ${pct(s.pos.base.ge90)} |`, '');
    md.push('| State alert pertama | Porsi | Gerak awal median (ATR) | n | R bersih [CI 95%] |', '| --- | --- | --- | --- | --- |');
    for (const st of s.states) md.push(`| ${st.state} | ${pct(st.share)} | ${num(st.medianPre)} | ${st.outcome.n} | ${fmtR(st.outcome)} |`);
    md.push('');
    md.push('| Tersil gerak awal | n | Win rate | R bersih [CI 95%] |', '| --- | --- | --- | --- |');
    for (const t of s.terciles) {
      const label = t.lo === null ? `gerak awal < ${num(t.hi, 1)} ATR` : t.hi === null ? `≥ ${num(t.lo, 1)} ATR` : `${num(t.lo, 1)} … ${num(t.hi, 1)} ATR`;
      md.push(`| ${label} | ${t.outcome.n} | ${fmtW(t.outcome)} | ${fmtR(t.outcome)} |`);
    }
    md.push('');
  }
  md.push('Catatan: deskriptif, bukan aturan entri. Trade bisa tumpang tindih; daftar simbol cache dipilih menurut volume 2026-10 (bias survivorship).', '');
  return md.join('\n');
}

/**
 * Jalankan studi. @returns {Promise<object>} hasil (juga ditulis ke `out` sebagai .md & .json)
 */
export async function runTimingStudy({ symbols: only = null, from, to, cacheDir, now = Date.now() }) {
  const symbols = (await readdir(cacheDir)).filter((s) => /^[A-Z0-9]{2,30}$/.test(s) && (!only || only.includes(s))).sort();
  const acc = Object.fromEntries(TIMING_COMBOS.map((c) => [c.key, { alerts: [], base: { pre: [], pos: [], cls: {} }, series: 0, totalV3: 0 }]));
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
    // Sama dengan runner: rentang waktu train/test dari setiap seri dasar (15m & 1h) yang ada.
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
      const res = await replaySeries({ symbol, timeframe: combo.timeframe, byTf });
      const A = atr(B, ATR_PERIOD);
      const flags = breakoutFlags(B, combo.direction, DON);
      const a = acc[combo.key];
      a.series += 1;
      let mine = 0;
      for (const t of res.trades.v3) {
        if (t.direction !== combo.direction) continue;
        a.totalV3 += 1;
        if (t.outcome === 'OPEN') continue;
        const tm = timingAt(B, A, flags, combo.direction, t.entryIndex, { donchian: DON, look: LOOK });
        if (!tm) continue;
        mine += 1;
        a.alerts.push({ symbol, t: t.entryTime, exitTime: t.exitTime, state: t.state, r: t.rMultiple, win: t.outcome === 'WIN' ? 1 : 0, ...tm });
      }
      for (let i = BACKTEST_WARMUP; i < B.length; i += 1) {
        const tm = timingAt(B, A, flags, combo.direction, i, { donchian: DON, look: LOOK });
        if (!tm) continue;
        a.base.pre.push(tm.pre);
        a.base.pos.push(tm.pos);
        a.base.cls[tm.cls] = (a.base.cls[tm.cls] ?? 0) + 1;
      }
      log(`${symbol} ${combo.key}: ${B.length} candle, alert v3 ${mine} (${Date.now() - started} ms)`);
    }
  }
  const testStart = minTime + (maxTime - minTime) * RUNNER_DEFAULTS.trainFraction;
  return {
    generatedAt: new Date(now).toISOString(),
    from: new Date(from).toISOString().slice(0, 10),
    to: new Date(to).toISOString().slice(0, 10),
    symbols, skipped, testStart, embargoMs: RUNNER_DEFAULTS.maxBars * TIMEFRAME_MS['1h'],
    fee: { feeBps: RUNNER_DEFAULTS.feeBps, slippageBps: RUNNER_DEFAULTS.slippageBps },
    timing: { donchian: DON, look: LOOK, atrPeriod: ATR_PERIOD },
    combos: Object.fromEntries(TIMING_COMBOS.map((c) => [c.key, summarizeCombo(acc[c.key], testStart)])),
  };
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
  const result = await runTimingStudy({ symbols, from, to, cacheDir: resolve(ROOT, v['cache-dir']), now: started });
  result.durationS = Math.round((Date.now() - started) / 1000);
  const out = resolve(v.out);
  await mkdir(out, { recursive: true });
  const slug = result.generatedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  await writeFile(join(out, `timing-${slug}.md`), renderTimingMarkdown(result), 'utf8');
  await writeFile(join(out, `timing-${slug}.json`), JSON.stringify(result, null, 2), 'utf8');
  log(`Selesai dalam ${result.durationS} s → ${join(out, `timing-${slug}.md`)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err) => {
    log(`Riset timing gagal: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
}
