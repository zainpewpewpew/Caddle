// Evaluasi praregistrasi AL-SA-ATR-01 (docs/26). Riset saja: tidak menyentuh database, worker, atau scanner live.
// Jalankan HANYA pada commit beku (docs/26 §6); hash pohon kode dicocokkan dengan docs/26.
//
// Pakai:
//   npm run research:al-sa-atr-01 -- --mode count --to 2027-07-16      # hanya jumlah trade, tanpa hasil R
//   npm run research:al-sa-atr-01 -- --mode evaluate --to 2027-07-16   # evaluasi keputusan (sekali saja)
//
// Data: kline 1h & funding Binance USDT-M untuk 100 simbol beku, dimuat sejak windowStart − warmupDays, di-cache di
// data/backtest-cache. Laporan JSON & Markdown ke reports/research/.

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_CACHE_DIR, loadFromBinance } from '../backend/backtest/dataSource.js';
import { longFundingR } from '../backend/backtest/eventStudy.js';
import { loadFundingRates } from '../backend/backtest/funding.js';
import { replaySeries } from '../backend/backtest/runner.js';
import { createBinanceRestClient } from '../backend/ingestion/binance/restClient.js';
import { atr } from '../backend/indicators/index.js';
import { TIMEFRAME_MS } from '../backend/market/contracts.js';
import { AL_SA_ATR_01 as CFG, evaluateCriteria, netOutcome, preMoveAt } from '../backend/research/alSaAtr01.js';
import { movingBlockBootstrapDiff, movingBlockBootstrapMean, onePositionPerSymbol } from '../backend/research/matchedBaseline.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOC = join(ROOT, 'docs', '26-praregistrasi-al-sa-atr-01.md');
const H = TIMEFRAME_MS['1h'];
const DAY = 86_400_000;

const log = (m) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${m}\n`);
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

/**
 * Hash pohon kode: SHA-256 atas baris "path relatif + SHA-256 isi" untuk semua .js di backend/ ditambah skrip ini,
 * diurutkan menurut path. Perubahan apa pun pada kode analisis/backtest mengubah hash ini.
 */
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
  rels.push('scripts/research-al-sa-atr-01.js');
  rels.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const h = createHash('sha256');
  for (const rel of rels) h.update(`${rel}\n${createHash('sha256').update(await readFile(join(root, rel))).digest('hex')}\n`);
  return { hash: h.digest('hex'), files: rels.length };
}

/** Hash pohon yang dibekukan di docs/26 (baris "Hash pohon kode: `<64 hex>`"). */
export async function frozenTreeHash(docPath = DOC) {
  const text = await readFile(docPath, 'utf8');
  return text.match(/Hash pohon kode: `([0-9a-f]{64})`/)?.[1] ?? null;
}

async function collect({ cutoff, client, cacheDir, withFunding }) {
  const loadFrom = CFG.windowStart - CFG.warmupDays * DAY;
  const end = Math.min(cutoff, CFG.maxWindowEnd) - CFG.settleBars * H;
  const records = [];
  const skipped = [];
  let open = 0;
  for (const symbol of CFG.universe) {
    let candles;
    try {
      ({ candles } = await loadFromBinance({ symbol, timeframe: '1h', from: loadFrom, to: cutoff, client, cacheDir }));
    } catch (err) {
      skipped.push(`${symbol}: ${String(err.message).slice(0, 120)}`);
      continue;
    }
    if (!candles.length) {
      skipped.push(`${symbol}: tidak ada candle`);
      continue;
    }
    const res = await replaySeries({
      symbol, timeframe: '1h', byTf: { '1h': candles },
      options: { targetR: CFG.targetR, maxBars: CFG.maxBars, feeBps: CFG.feeBps, slippageBps: CFG.slippageBps, entry: CFG.entry },
    });
    const A = atr(candles, CFG.atrPeriod);
    let funding = null;
    let cohort = null;
    if (withFunding) {
      const { rates } = await loadFundingRates({ symbol, from: CFG.windowStart - DAY, to: cutoff, client, cacheDir });
      funding = { times: rates.map((r) => r.fundingTime), rates: rates.map((r) => r.fundingRate) };
      const { candles: old } = await loadFromBinance({ symbol, timeframe: '1h', from: CFG.oldCohortFrom, to: CFG.oldCohortTo, client, cacheDir });
      cohort = old.length ? 'lama' : 'baru';
    }
    let mine = 0;
    for (const t of res.trades.v3) {
      if (t.direction !== CFG.direction) continue;
      const signal = candles[t.entryIndex];
      if (signal.openTime < CFG.windowStart || signal.openTime >= end) continue;
      if (t.outcome === 'OPEN') {
        open += 1;
        continue;
      }
      const pre = preMoveAt(candles, A, t.entryIndex, CFG.look);
      if (pre === null) continue;
      const fundingR = funding ? longFundingR(candles, t.entryIndex + 1, t.exitIndex, t.risk, funding, H) : 0;
      records.push({
        symbol, cohort, t: t.entryTime, exitTime: t.exitTime, signalTime: signal.closeTime, pre, outcome: t.outcome,
        fundingR, ...netOutcome(t, fundingR, CFG),
      });
      mine += 1;
    }
    log(`${symbol}: ${candles.length} candle, trade LONG v3 dalam jendela ${mine}`);
  }
  const filtered = onePositionPerSymbol(records.filter((r) => r.pre >= CFG.preThresholdAtr));
  const complement = onePositionPerSymbol(records.filter((r) => r.pre < CFG.preThresholdAtr));
  return { filtered, complement, open, skipped, end };
}

function maxDrawdown(list) {
  let eq = 0;
  let peak = 0;
  let dd = 0;
  for (const r of [...list].sort((a, b) => a.exitTime - b.exitTime)) {
    eq += r.netR;
    peak = Math.max(peak, eq);
    dd = Math.min(dd, eq - peak);
  }
  return dd;
}

async function main(argv) {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      mode: { type: 'string', default: 'count' }, to: { type: 'string' },
      'cache-dir': { type: 'string', default: DEFAULT_CACHE_DIR }, out: { type: 'string', default: join(ROOT, 'reports', 'research') },
    },
    strict: true,
  });
  if (!['count', 'evaluate'].includes(v.mode)) throw new TypeError('--mode harus count atau evaluate');
  const now = Date.now();
  const cutoff = v.to ? Date.parse(`${v.to}T00:00:00Z`) : now;
  if (!Number.isFinite(cutoff) || cutoff > now) throw new RangeError('--to harus tanggal YYYY-MM-DD yang sudah lewat');
  if (cutoff <= CFG.windowStart) throw new RangeError('Jendela data AL-SA-ATR-01 belum dimulai');
  if (cutoff > CFG.maxWindowEnd) throw new RangeError('--to melewati batas jendela praregistrasi');
  const client = createBinanceRestClient({ logger: { warn: (o, m) => log(`[binance] ${m ?? ''} ${JSON.stringify(o)}`) } });
  const cacheDir = resolve(ROOT, v['cache-dir']);
  const tree = await codeTreeHash();
  const frozen = await frozenTreeHash();
  const hashesMatch = tree.hash === frozen;
  if (!hashesMatch) log(`PERINGATAN: hash pohon kode ${tree.hash} ≠ docs/26 ${frozen ?? '(tidak ada)'} — hasil TIDAK SAH sebagai uji keputusan`);
  const { filtered, complement, open, skipped, end } = await collect({ cutoff, client, cacheDir, withFunding: v.mode === 'evaluate' });
  const out = resolve(v.out);
  await mkdir(out, { recursive: true });
  const slug = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const base = join(out, `al-sa-atr-01-${v.mode}-${slug}`);
  const header = {
    id: CFG.id, mode: v.mode, generatedAt: new Date(now).toISOString(), cutoff: new Date(cutoff).toISOString(),
    signalWindowEnd: new Date(end).toISOString(), tree, frozenTree: frozen, hashesMatch, skipped,
  };
  if (v.mode === 'count') {
    const report = { ...header, nFiltered: filtered.length, nComplement: complement.length, nRequired: CFG.nRequired, openAtCutoff: open };
    await writeFile(`${base}.json`, JSON.stringify(report, null, 2));
    log(`Trade kelompok filter: ${filtered.length} / ${CFG.nRequired} wajib · pelengkap ${complement.length} · masih terbuka ${open}`);
    return;
  }
  const value = (e) => e.netR;
  const time = (e) => e.t;
  const main7 = movingBlockBootstrapMean(filtered, { value, time, blockDays: CFG.blockDays, reps: CFG.reps, seed: CFG.seed });
  const sens = Object.fromEntries(CFG.sensitivityBlockDays.map((L) => [L, movingBlockBootstrapMean(filtered, { value, time, blockDays: L, reps: CFG.reps, seed: CFG.seed })]));
  const diff = movingBlockBootstrapDiff(filtered, complement, { value, time, blockDays: CFG.blockDays, reps: CFG.reps, seed: CFG.diffSeed });
  const stressMean = mean(filtered.map((e) => e.stressR));
  const criteria = evaluateCriteria({ n: filtered.length, nRequired: CFG.nRequired, main: main7, diff, stressMean, hashesMatch });
  const bySymbol = {};
  for (const r of filtered) (bySymbol[r.symbol] ??= []).push(r.netR);
  const report = {
    ...header, criteria, nFiltered: filtered.length, nComplement: complement.length, nRequired: CFG.nRequired, openAtCutoff: open,
    main: main7, sensitivity: sens, diff, stressMean, meanFundingR: mean(filtered.map((e) => e.fundingR)),
    complementMean: mean(complement.map(value)), maxDrawdownR: maxDrawdown(filtered),
    outcomes: Object.fromEntries(['WIN', 'LOSS', 'TIMEOUT'].map((o) => [o, filtered.filter((e) => e.outcome === o).length])),
    cohorts: Object.fromEntries(['lama', 'baru'].map((k) => {
      const list = filtered.filter((e) => e.cohort === k);
      return [k, { n: list.length, meanR: mean(list.map(value)) }];
    })),
    bySymbol: Object.fromEntries(Object.entries(bySymbol).map(([s, rs]) => [s, { n: rs.length, meanR: mean(rs) }])),
  };
  await writeFile(`${base}.json`, JSON.stringify(report, null, 2));
  const f = (x) => (x === null || x === undefined ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(3).replace('.', ',')}`);
  const md = [
    `# Evaluasi ${CFG.id} — ${criteria.verdict}`, '',
    `Dibuat ${header.generatedAt} · cutoff data ${header.cutoff} · sinyal s/d ${header.signalWindowEnd} · `
      + `hash pohon ${hashesMatch ? 'cocok' : 'BERBEDA'} (${tree.hash})`, '',
    '| Kriteria | Nilai | Terpenuhi |', '| --- | --- | --- |',
    `| P0 n ≥ ${CFG.nRequired} | ${filtered.length} | ${criteria.P0 ? 'ya' : 'tidak'} |`,
    `| P1 R bersih > 0 & batas bawah CI blok ${CFG.blockDays} hari > 0 | ${f(main7?.mean)} [${f(main7?.lo)} … ${f(main7?.hi)}] | ${criteria.P1 ? 'ya' : 'tidak'} |`,
    `| P2 selisih vs pelengkap > 0 & batas bawah CI > 0 | ${f(diff?.diff)} [${f(diff?.lo)} … ${f(diff?.hi)}] | ${criteria.P2 ? 'ya' : 'tidak'} |`,
    `| P3 R bersih biaya stres ${CFG.stressFeeBps} + ${CFG.stressSlippageBps} bps > 0 | ${f(stressMean)} | ${criteria.P3 ? 'ya' : 'tidak'} |`,
    `| P4 kode = commit beku | ${hashesMatch ? 'cocok' : 'berbeda'} | ${criteria.P4 ? 'ya' : 'tidak'} |`, '',
    `Laporan (bukan penentu): CI 14 hari [${f(sens[14]?.lo)} … ${f(sens[14]?.hi)}], harian [${f(sens[1]?.lo)} … ${f(sens[1]?.hi)}]; `
      + `pelengkap ${f(report.complementMean)}R (n ${complement.length}); funding rata-rata ${f(report.meanFundingR)}R; `
      + `drawdown maks ${f(report.maxDrawdownR)}R; W/L/T ${report.outcomes.WIN}/${report.outcomes.LOSS}/${report.outcomes.TIMEOUT}; `
      + `kohort lama ${f(report.cohorts.lama.meanR)}R (n ${report.cohorts.lama.n}), baru ${f(report.cohorts.baru.meanR)}R (n ${report.cohorts.baru.n}).`, '',
    skipped.length ? `Simbol dilewati: ${skipped.join('; ')}` : 'Tidak ada simbol yang dilewati.', '',
  ].join('\n');
  await writeFile(`${base}.md`, md);
  log(`${criteria.verdict} → ${base}.md`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err) => {
    log(`Evaluasi gagal: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
}
