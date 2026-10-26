// CLI replay historis "Reversal Radar" (docs/19 §9, docs/21): replay berurutan tanpa look-ahead, pembanding mesin lama
// SA/PVA, pelabelan triple barrier §10, laporan Markdown + JSON di reports/, ringkasan di stdout.
// Contoh:
//   npm run reversal:replay -- --synthetic --seeds 21-60 --timeframes 5m,15m,1h --scenarios all      (set evaluasi, bawaan)
//   npm run reversal:replay -- --synthetic --seeds 1-20 --tuning                                       (set penyetelan parameter)
//   npm run reversal:replay -- --synthetic --seeds 21-30 --scenarios successfulReversal,failedBounce --check-lookahead
//   npm run reversal:replay -- --synthetic --seeds 21-60 --old full                                    (pembanding lama parameter live)
//   npm run reversal:replay -- --top 20 --timeframes 5m,15m,1h --from 2025-06-01 --to 2025-10-01      (data nyata; hanya di Mac pengguna)
//   npm run reversal:replay -- --symbols BTCUSDT,ETHUSDT --timeframes 15m --from 2025-06-01 --check-lookahead
// Hasil: reports/reversal-replay-<timestamp>.md dan .json. Data Binance di-cache di data/backtest-cache (gitignored).
// Kode keluar: 0 sukses, 1 gagal, 2 argumen salah, 3 mesin reversal belum tersedia, 4 uji anti-look-ahead gagal.

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { aggregateCandles } from '../backend/backtest/synthetic.js';
import { HIGHER_TIMEFRAMES } from '../backend/market/contracts.js';
import { REVERSAL_REPLAY_USAGE, parseReversalReplayArgs } from './lib/reversalReplayArgs.js';

const ENGINE_URL = new URL('../backend/reversal/index.js', import.meta.url);
const SCENARIOS_URL = new URL('../tests/fixtures/candles/reversalScenarios.js', import.meta.url);

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

/** Timeframe dasar + timeframe konteks (HTF) yang dibutuhkan. */
export function requiredTimeframes(timeframes) {
  const set = new Set(timeframes);
  for (const tf of timeframes) for (const htf of HIGHER_TIMEFRAMES[tf] ?? []) set.add(htf);
  return [...set];
}

/**
 * Daftar pekerjaan replay { symbol, timeframe, candles, higher, scenario, seed, phases, landmarks } dari skenario sintetis:
 * tiap timeframe dasar memakai skenario yang dibangun pada timeframe itu (bentuk chart identik; sama dengan
 * scenarioUniverse), HTF dari agregasi candle dasar. `phases`/`landmarks` rencana skenario ikut dibawa agar laporan dapat
 * menghitung deteksi per fase dan lead terhadap breakout rencana.
 */
export function syntheticJobs(scenarios, args) {
  const jobs = [];
  for (const timeframe of args.timeframes) {
    for (const id of args.scenarios) {
      for (const seed of args.seeds) {
        const built = scenarios.buildScenario(id, seed, { timeframe });
        const higher = {};
        for (const htf of HIGHER_TIMEFRAMES[timeframe]) higher[htf] = aggregateCandles(built.candles, htf);
        jobs.push({ symbol: built.symbol, timeframe, candles: built.candles, higher, scenario: id, seed, phases: built.phases, landmarks: built.landmarks });
      }
    }
  }
  return jobs;
}

/** Pekerjaan replay dari peta candle nyata { [symbol]: { [timeframe]: Candle[] } }. */
export function realJobs(map, timeframes) {
  const jobs = [];
  for (const [symbol, byTf] of Object.entries(map)) {
    for (const timeframe of timeframes) {
      if (!byTf?.[timeframe]?.length) continue;
      const higher = {};
      for (const htf of HIGHER_TIMEFRAMES[timeframe]) if (byTf[htf]?.length) higher[htf] = byTf[htf];
      jobs.push({ symbol, timeframe, candles: byTf[timeframe], higher, scenario: null, seed: null });
    }
  }
  return jobs;
}

async function loadRealDataset(args, { loadDataSource, loadRestClient }) {
  const ds = await loadDataSource();
  const { createBinanceRestClient } = await loadRestClient();
  const client = createBinanceRestClient({ logger: { warn: (o, m) => log(`[binance] ${m ?? ''} ${JSON.stringify(o)}`) } });
  const symbols = args.symbols ?? await ds.listTopSymbols({ client, limit: args.top, minQuoteVolume24h: args.minQuoteVolume24h });
  log(`Simbol (${symbols.length}): ${symbols.join(', ')}`);
  const map = {};
  for (const symbol of symbols) {
    for (const timeframe of requiredTimeframes(args.timeframes)) {
      const { candles, stats } = await ds.loadFromBinance({ symbol, timeframe, from: args.from, to: args.to, client, cacheDir: args.cacheDir });
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

/** Mesin belum tersedia (stub worktree) bila evaluasi pertama melempar pesan "belum tersedia". */
const isStubError = (err) => /belum tersedia|stub/i.test(String(err?.message ?? ''));

/**
 * Jalankan CLI.
 * @param {string[]} argv
 * @param {{ loadEngine?: Function, loadScenarios?: Function, loadDataSource?: Function, loadRestClient?: Function,
 *   loadReplay?: Function, loadReport?: Function, now?: () => number }} [deps] injeksi untuk tes
 * @returns {Promise<number>} kode keluar
 */
export async function main(argv = process.argv.slice(2), {
  loadEngine = () => importOptional(ENGINE_URL),
  loadScenarios = () => import(SCENARIOS_URL.href),
  loadDataSource = () => import('../backend/backtest/dataSource.js'),
  loadRestClient = () => import('../backend/ingestion/binance/restClient.js'),
  loadReplay = () => import('../backend/reversal/replay.js'),
  loadReport = () => import('../backend/reversal/replayReport.js'),
  now = () => Date.now(),
} = {}) {
  let args;
  try {
    args = parseReversalReplayArgs(argv, { now: now() });
  } catch (err) {
    log(err.message);
    log(REVERSAL_REPLAY_USAGE);
    return 2;
  }
  if (args.help) {
    process.stdout.write(REVERSAL_REPLAY_USAGE);
    return 0;
  }
  for (const w of args.warnings) log(`PERINGATAN: ${w}`);

  const engine = await loadEngine();
  if (!engine || typeof engine.evaluateReversal !== 'function' || typeof engine.transitionReversal !== 'function') {
    log('backend/reversal/index.js (evaluateReversal/transitionReversal) belum tersedia — replay belum dapat dijalankan.');
    return 3;
  }
  const { replayReversalSeries, assertNoLookahead, LookaheadError } = await loadReplay();
  const { aggregateReplay, renderReplayReport, renderReplaySummary } = await loadReport();

  const startedAt = now();
  let jobs;
  let scenarioCatalog = [];
  if (args.source === 'synthetic') {
    const scenarios = await loadScenarios();
    scenarioCatalog = scenarios.scenarioCatalog();
    jobs = syntheticJobs(scenarios, args);
  } else {
    jobs = realJobs(await loadRealDataset(args, { loadDataSource, loadRestClient }), args.timeframes);
  }
  if (jobs.length === 0) {
    log('Tidak ada seri untuk di-replay.');
    return 1;
  }
  log(`Replay ${jobs.length} seri (${args.timeframes.join(', ')}; horizon ${args.horizonBars} candle; pembanding lama: ${args.old})`);
  if (Object.keys(args.params).length > 0) log(`Override parameter mesin: ${JSON.stringify(args.params)}`);

  const engineDeps = {
    evaluate: engine.evaluateReversal, transition: engine.transitionReversal, resolveParams: engine.resolveReversalParams,
    ...(typeof engine.requiredCandles === 'function' ? { requiredCandles: engine.requiredCandles } : {}),
  };
  const series = [];
  const lookahead = args.checkLookahead ? { checked: 0, failures: [] } : null;
  const checkedPerKey = new Map();
  let evaluations = 0;
  for (const job of jobs) {
    // Uji anti-look-ahead dijalankan SEBELUM replay utama seri yang sama: replay penuh di dalam assertNoLookahead harus
    // menjadi kontak pertama mesin dengan seri ini, sehingga mesin yang menyimpan keadaan lintas panggilan (mis. "hafal"
    // close candle berikutnya) terdeteksi saat prefiks dievaluasi ulang.
    if (lookahead) {
      const key = `${job.scenario ?? 'nyata'}|${job.timeframe}`;
      const done = checkedPerKey.get(key) ?? 0;
      if (done < args.lookaheadSeries) {
        checkedPerKey.set(key, done + 1);
        lookahead.checked += 1;
        try {
          const r = await assertNoLookahead({ symbol: job.symbol, timeframe: job.timeframe, candles: job.candles, higher: job.higher, ...engineDeps, params: args.params, samples: args.lookaheadSamples, horizonBars: args.horizonBars });
          log(`anti-look-ahead ${job.symbol} ${job.timeframe}: stabil pada candle #${r.samples.join(', #')}`);
        } catch (err) {
          if (isStubError(err)) {
            log(`Mesin reversal belum tersedia: ${err.message}`);
            return 3;
          }
          if (!(err instanceof LookaheadError)) throw err;
          lookahead.failures.push({ symbol: job.symbol, timeframe: job.timeframe, message: err.message });
          log(`anti-look-ahead ${job.symbol} ${job.timeframe}: GAGAL — ${err.message}`);
        }
      }
    }

    const t0 = now();
    let res;
    try {
      res = await replayReversalSeries({
        symbol: job.symbol, timeframe: job.timeframe, candles: job.candles, higher: job.higher, ...engineDeps, params: args.params,
        horizonBars: args.horizonBars, targetAtr: args.targetAtr, oldScanner: args.old !== 'off', oldMode: args.old === 'off' ? 'fast' : args.old,
      });
    } catch (err) {
      if (isStubError(err)) {
        log(`Mesin reversal belum tersedia: ${err.message}`);
        return 3;
      }
      throw err;
    }
    res.scenario = job.scenario ?? undefined;
    res.seed = job.seed ?? undefined;
    if (job.phases) res.phases = job.phases;
    if (job.landmarks) res.landmarks = job.landmarks;
    series.push(res);
    evaluations += res.evaluations;
    log(`${job.symbol} ${job.timeframe}: ${res.evaluations} candle dievaluasi, ${res.candidates.length} kandidat, sinyal lama ${res.old.signals} (${now() - t0} ms)`);
  }

  const result = aggregateReplay({
    series, scenarios: scenarioCatalog, lookahead,
    meta: {
      generatedAt: startedAt, source: args.source, timeframes: args.timeframes, horizonBars: args.horizonBars, targetAtr: args.targetAtr,
      oldMode: args.old === 'off' ? 'off' : args.old, seedSet: args.source === 'synthetic' ? args.seedSet : null,
      ...(args.source === 'synthetic' ? { seeds: args.seeds, scenarios: args.scenarios, tuning: args.tuning } : { symbols: [...new Set(jobs.map((j) => j.symbol))], from: args.from, to: args.to }),
      notes: [
        ...args.warnings,
        ...(Object.keys(args.params).length > 0 ? [`Override parameter mesin (--params): ${JSON.stringify(args.params)}`] : []),
        `Durasi replay ${now() - startedAt} ms untuk ${evaluations} evaluasi mesin baru`,
      ],
    },
  });

  const outDir = resolve(args.out);
  await mkdir(outDir, { recursive: true });
  const base = join(outDir, `reversal-replay-${timestampSlug(startedAt)}`);
  await writeFile(`${base}.md`, renderReplayReport(result), 'utf8');
  await writeFile(`${base}.json`, toJson(result), 'utf8');
  process.stdout.write(renderReplaySummary(result));
  log(`Laporan: ${base}.md`);
  log(`Data JSON: ${base}.json`);
  return lookahead?.failures.length ? 4 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    log(`Replay gagal: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
}
