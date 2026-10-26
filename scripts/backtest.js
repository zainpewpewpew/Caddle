// CLI backtest walk-forward scanner LONG/SHORT.
// Contoh:
//   npm run backtest -- --symbols BTCUSDT,ETHUSDT --timeframes 15m,1h --from 2024-01-01 --to 2025-10-01
//   npm run backtest -- --top 30 --target-r 2 --max-bars 48 --write-calibration config/calibration.json
//   npm run backtest -- --csv data/vision/ --timeframes 1h
//   npm run backtest -- --synthetic --seed 7
// Hasil: reports/backtest-<timestamp>.md dan .json. Data Binance di-cache di data/backtest-cache (gitignored).

import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HIGHER_TIMEFRAMES } from '../backend/market/contracts.js';
import { BACKTEST_USAGE, parseBacktestArgs } from './lib/backtestArgs.js';

const RUNNER_URL = new URL('../backend/backtest/runner.js', import.meta.url);
const SYNTHETIC_URL = new URL('../backend/backtest/synthetic.js', import.meta.url);

const log = (msg) => process.stderr.write(`${msg}\n`);

/** Import modul opsional; null bila FILE modul itu sendiri belum ada (error lain tetap dilempar). */
async function importOptional(url) {
  try {
    return await import(url.href);
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && String(err.message).includes(`'${fileURLToPath(url)}'`)) return null;
    throw err;
  }
}

/** Timeframe dasar + timeframe konteks (HTF) yang dibutuhkan runner. */
export function requiredTimeframes(timeframes) {
  const set = new Set(timeframes);
  for (const tf of timeframes) for (const htf of HIGHER_TIMEFRAMES[tf] ?? []) set.add(htf);
  return [...set];
}

/**
 * Seragamkan keluaran generator sintetis ke { [symbol]: { [timeframe]: Candle[] } }.
 * Menerima peta bersarang, array { symbol, timeframe, candles }, atau { candles: <salah satunya> }.
 */
export function normalizeUniverse(universe) {
  const src = universe && !Array.isArray(universe) && universe.candles && typeof universe.candles === 'object' ? universe.candles : universe;
  const out = {};
  if (Array.isArray(src)) {
    for (const item of src) {
      if (!item || typeof item.symbol !== 'string' || typeof item.timeframe !== 'string' || !Array.isArray(item.candles)) {
        throw new TypeError('Item universe sintetis wajib { symbol, timeframe, candles[] }');
      }
      (out[item.symbol] ??= {})[item.timeframe] = item.candles;
    }
    return out;
  }
  if (!src || typeof src !== 'object') throw new TypeError('Universe sintetis tidak dikenali');
  for (const [symbol, byTf] of Object.entries(src)) {
    if (!byTf || typeof byTf !== 'object' || Array.isArray(byTf)) throw new TypeError(`Universe sintetis: ${symbol} wajib { [timeframe]: Candle[] }`);
    out[symbol] = { ...byTf };
  }
  return out;
}

/** Gabung candle per simbol/timeframe: urut naik, openTime unik. */
function mergeCandles(target, candles) {
  for (const c of candles) {
    const bucket = ((target[c.symbol] ??= {})[c.timeframe] ??= []);
    bucket.push(c);
  }
}

function finalizeCandles(map) {
  for (const byTf of Object.values(map)) {
    for (const [tf, list] of Object.entries(byTf)) {
      list.sort((a, b) => a.openTime - b.openTime);
      byTf[tf] = list.filter((c, i) => i === 0 || c.openTime !== list[i - 1].openTime);
    }
  }
  return map;
}

async function expandCsvPaths(paths) {
  const files = [];
  for (const p of paths) {
    const info = await stat(p);
    if (info.isDirectory()) {
      const names = (await readdir(p)).filter((n) => n.toLowerCase().endsWith('.csv')).sort();
      files.push(...names.map((n) => join(p, n)));
    } else {
      files.push(p);
    }
  }
  return files;
}

async function loadDataset(args) {
  const tfs = requiredTimeframes(args.timeframes);
  const ds = await import('../backend/backtest/dataSource.js');

  if (args.source === 'synthetic') {
    const synthetic = await importOptional(SYNTHETIC_URL);
    if (!synthetic?.generateUniverse) throw new Error('backend/backtest/synthetic.js (generateUniverse) belum tersedia');
    const universe = await synthetic.generateUniverse({
      symbols: args.syntheticSymbols, timeframes: tfs, bars: args.syntheticBars, seed: args.seed, start: args.from,
    });
    return normalizeUniverse(universe);
  }

  if (args.source === 'csv') {
    const map = {};
    const files = await expandCsvPaths(args.csv);
    if (files.length === 0) throw new Error('Tidak ada file CSV ditemukan');
    for (const file of files) {
      const candles = await ds.loadFromCsv(file);
      const filtered = args.rangeExplicit ? candles.filter((c) => c.openTime >= args.from && c.openTime < args.to) : candles;
      mergeCandles(map, filtered);
      log(`CSV ${file}: ${filtered.length} candle`);
    }
    return finalizeCandles(map);
  }

  const { createBinanceRestClient } = await import('../backend/ingestion/binance/restClient.js');
  const client = createBinanceRestClient({ logger: { warn: (o, m) => log(`[binance] ${m ?? ''} ${JSON.stringify(o)}`) } });
  const symbols = args.symbols ?? await ds.listTopSymbols({ client, limit: args.top, minQuoteVolume24h: args.minQuoteVolume24h });
  log(`Simbol (${symbols.length}): ${symbols.join(', ')}`);
  const map = {};
  for (const symbol of symbols) {
    for (const timeframe of tfs) {
      const { candles, stats } = await ds.loadFromBinance({
        symbol, timeframe, from: args.from, to: args.to, client, cacheDir: args.cacheDir,
      });
      (map[symbol] ??= {})[timeframe] = candles;
      const gapNote = stats.gaps.length ? `, ${stats.gaps.length} celah` : '';
      log(`${symbol} ${timeframe}: ${candles.length} candle (${stats.cachedMonths}/${stats.months} bulan dari cache, ${stats.requests} request${gapNote})`);
    }
  }
  return map;
}

/** JSON dengan ±Infinity sebagai string (JSON standar tidak mendukungnya). */
function toJson(value) {
  return JSON.stringify(value, (_k, v) => (v === Infinity ? 'Infinity' : v === -Infinity ? '-Infinity' : v), 2);
}

function timestampSlug(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Jalankan CLI.
 * @param {string[]} argv
 * @param {{ loadRunner?: () => Promise<{ runBacktest?: Function }|null> }} [deps] injeksi untuk tes
 * @returns {Promise<number>} kode keluar
 */
export async function main(argv = process.argv.slice(2), { loadRunner = () => importOptional(RUNNER_URL) } = {}) {
  let args;
  try {
    args = parseBacktestArgs(argv);
  } catch (err) {
    log(err.message);
    log(BACKTEST_USAGE);
    return 2;
  }
  if (args.help) {
    process.stdout.write(BACKTEST_USAGE);
    return 0;
  }

  const runner = await loadRunner();
  if (!runner?.runBacktest) {
    log('backend/backtest/runner.js (runBacktest) belum tersedia — backtest belum dapat dijalankan.');
    return 3;
  }

  const startedAt = Date.now();
  const candles = await loadDataset(args);
  const symbols = Object.keys(candles);
  if (symbols.length === 0) {
    log('Tidak ada data candle untuk dijalankan.');
    return 1;
  }

  const result = await runner.runBacktest({
    candles,                      // { [symbol]: { [timeframe]: Candle[] } } — termasuk timeframe konteks (HTF)
    symbols,
    timeframes: args.timeframes,  // timeframe dasar yang dievaluasi
    from: args.from,
    to: args.to,
    targetR: args.targetR,
    maxBars: args.maxBars,
    folds: args.folds,
    embargoBars: args.embargoBars,
    seed: args.seed,
    source: args.source,
    onProgress: (msg) => log(typeof msg === 'string' ? msg : JSON.stringify(msg)),
  });
  if (!result || typeof result !== 'object' || !result.variants) throw new Error('runBacktest harus mengembalikan { meta, variants }');
  result.meta = {
    generatedAt: startedAt, source: args.source, symbols, timeframes: args.timeframes, from: args.from, to: args.to,
    targetR: args.targetR, maxBars: args.maxBars, folds: args.folds, embargoBars: args.embargoBars,
    ...(args.source === 'synthetic' ? { seed: args.seed } : {}),
    ...result.meta,
  };

  const { renderMarkdownReport } = await import('../backend/backtest/report.js');
  const outDir = resolve(args.out);
  await mkdir(outDir, { recursive: true });
  const base = join(outDir, `backtest-${timestampSlug(startedAt)}`);
  await writeFile(`${base}.md`, renderMarkdownReport(result), 'utf8');
  await writeFile(`${base}.json`, toJson(result), 'utf8');
  log(`Laporan: ${base}.md`);
  log(`Data JSON: ${base}.json`);

  if (args.writeCalibration) {
    const candidate = result.meta.candidate ?? 'v3';
    const table = result.calibrationTable ?? result.variants[candidate]?.calibration?.table ?? null;
    if (!table) {
      log('Tabel kalibrasi tidak ada di hasil runner — config kalibrasi TIDAK ditulis.');
    } else {
      const target = resolve(args.writeCalibration);
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, toJson({ generatedAt: startedAt, source: args.source, meta: result.meta, table }), 'utf8');
      log(`Kalibrasi ditulis: ${target}`);
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    log(`Backtest gagal: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
}
