// Parsing argumen CLI backtest (scripts/backtest.js). Dipisah agar dapat diuji tanpa menjalankan backtest.

import { parseArgs } from 'node:util';
import { TIMEFRAMES } from '../../backend/market/contracts.js';

export const BACKTEST_USAGE = `Pemakaian: npm run backtest -- [opsi]

Sumber data (pilih satu; bawaan Binance REST dengan cache di data/backtest-cache):
  --symbols BTCUSDT,ETHUSDT   daftar simbol USDT-M perpetual
  --top 30                    N simbol teratas menurut quote volume 24 jam (butuh akses Binance)
  --csv path[,path...]        file CSV kline Binance / data.binance.vision (nama 'SIMBOL-TF-YYYY-MM.csv'),
                              atau folder berisi file tersebut
  --synthetic                 pasar sintetis berbenih (hanya membuktikan mekanisme, bukan akurasi)

Opsi:
  --timeframes 15m,1h         timeframe dasar (pilihan: ${TIMEFRAMES.join(', ')}; bawaan 15m,1h)
  --from 2024-01-01           awal rentang (UTC, inklusif; bawaan 2024-01-01)
  --to 2025-10-01             akhir rentang (UTC, eksklusif; bawaan sekarang)
  --target-r 2                target dalam kelipatan risiko (R)
  --max-bars 48               batas waktu trade (candle)
  --folds 5                   (cadangan; runner saat ini memakai holdout waktu 60% train / 40% test)
  --embargo 48                (cadangan; embargo runner = max-bars candle + purging)
  --seed 42                   benih data sintetis
  --synthetic-symbols 6       jumlah simbol sintetis
  --synthetic-bars 3000       jumlah candle sintetis per simbol & timeframe dasar
  --min-quote-volume 50000000 ambang quote volume 24 jam untuk --top
  --cache-dir data/backtest-cache
  --no-cache                  jangan baca/tulis cache disk
  --out reports/              folder laporan (backtest-<timestamp>.md & .json)
  --write-calibration config/calibration.json   tulis tabel kalibrasi hasil backtest
  -h, --help                  tampilkan bantuan ini
`;

const OPTIONS = Object.freeze({
  symbols: { type: 'string' },
  top: { type: 'string' },
  csv: { type: 'string' },
  synthetic: { type: 'boolean', default: false },
  timeframes: { type: 'string', default: '15m,1h' },
  from: { type: 'string' },
  to: { type: 'string' },
  'target-r': { type: 'string', default: '2' },
  'max-bars': { type: 'string', default: '48' },
  folds: { type: 'string', default: '5' },
  embargo: { type: 'string' },
  seed: { type: 'string', default: '42' },
  'synthetic-symbols': { type: 'string', default: '6' },
  'synthetic-bars': { type: 'string', default: '3000' },
  'min-quote-volume': { type: 'string', default: '0' },
  'cache-dir': { type: 'string', default: 'data/backtest-cache' },
  'no-cache': { type: 'boolean', default: false },
  out: { type: 'string', default: 'reports' },
  'write-calibration': { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
});

const DEFAULT_FROM = '2024-01-01';
const SYMBOL_RE = /^[A-Z0-9]{2,30}$/;

function list(text) {
  return String(text).split(',').map((s) => s.trim()).filter(Boolean);
}

function number(name, text, { integer = false, min = -Infinity, max = Infinity } = {}) {
  const n = Number(text);
  if (text === undefined || String(text).trim() === '' || !Number.isFinite(n) || (integer && !Number.isInteger(n)) || n < min || n > max) {
    throw new RangeError(`--${name} harus ${integer ? 'bilangan bulat' : 'angka'} ${min}..${max} (diberikan: ${String(text).slice(0, 40)})`);
  }
  return n;
}

function date(name, text) {
  const s = String(text).trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s;
  const ms = /^\d+$/.test(s) ? Number(s) : Date.parse(iso);
  if (!Number.isSafeInteger(ms) || ms < 0) throw new RangeError(`--${name} bukan tanggal valid (format YYYY-MM-DD): ${s.slice(0, 40)}`);
  return ms;
}

/**
 * Parse argumen CLI backtest.
 * @param {string[]} argv argumen setelah nama skrip (process.argv.slice(2))
 * @param {{ now?: number }} [options] `now` = nilai bawaan --to
 * @returns {{
 *   help: boolean, source: 'binance'|'csv'|'synthetic', symbols: string[]|null, top: number|null, csv: string[]|null,
 *   timeframes: string[], from: number, to: number, rangeExplicit: boolean, targetR: number, maxBars: number, folds: number, embargoBars: number,
 *   seed: number, syntheticSymbols: number, syntheticBars: number, minQuoteVolume24h: number,
 *   cacheDir: string|null, out: string, writeCalibration: string|null,
 * }}
 * @throws {TypeError|RangeError} pesan bahasa Indonesia untuk argumen tidak valid
 */
export function parseBacktestArgs(argv, { now = Date.now() } = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false, strict: true });
  } catch (err) {
    throw new TypeError(`Argumen tidak valid: ${err.message}`, { cause: err });
  }
  const v = parsed.values;
  const base = { help: v.help };
  if (v.help) return { ...base, source: null };

  const sources = [v.symbols !== undefined || v.top !== undefined ? 'binance' : null, v.csv !== undefined ? 'csv' : null, v.synthetic ? 'synthetic' : null].filter(Boolean);
  if (sources.length > 1) throw new TypeError('Pilih satu sumber data: --symbols/--top, --csv, atau --synthetic');
  if (v.symbols !== undefined && v.top !== undefined) throw new TypeError('--symbols dan --top tidak boleh dipakai bersamaan');
  const source = sources[0] ?? 'binance';

  let symbols = null;
  if (v.symbols !== undefined) {
    symbols = [...new Set(list(v.symbols).map((s) => s.toUpperCase()))];
    if (symbols.length === 0) throw new TypeError('--symbols kosong');
    const bad = symbols.find((s) => !SYMBOL_RE.test(s));
    if (bad) throw new TypeError(`Simbol tidak valid: ${bad.slice(0, 40)}`);
  }
  const top = v.top !== undefined ? number('top', v.top, { integer: true, min: 1, max: 200 }) : null;
  if (source === 'binance' && symbols === null && top === null) throw new TypeError('Sumber Binance butuh --symbols atau --top (atau gunakan --csv / --synthetic)');

  const csv = v.csv !== undefined ? list(v.csv) : null;
  if (csv !== null && csv.length === 0) throw new TypeError('--csv kosong');

  const timeframes = [...new Set(list(v.timeframes))];
  if (timeframes.length === 0) throw new TypeError('--timeframes kosong');
  const badTf = timeframes.find((tf) => !TIMEFRAMES.includes(tf));
  if (badTf) throw new TypeError(`Timeframe tidak didukung: ${badTf.slice(0, 16)} (pilihan: ${TIMEFRAMES.join(', ')})`);

  const from = date('from', v.from ?? DEFAULT_FROM);
  const to = v.to !== undefined ? date('to', v.to) : now;
  if (from >= to) throw new RangeError('--from harus sebelum --to');

  const maxBars = number('max-bars', v['max-bars'], { integer: true, min: 1, max: 1000 });
  const outDir = String(v.out).trim();
  if (outDir === '') throw new TypeError('--out kosong');
  return {
    ...base,
    source,
    symbols,
    top,
    csv,
    timeframes,
    from,
    to,
    // CSV: rentang hanya menyaring bila --from/--to diberikan eksplisit.
    rangeExplicit: v.from !== undefined || v.to !== undefined,
    targetR: number('target-r', v['target-r'], { min: 0.1, max: 20 }),
    maxBars,
    folds: number('folds', v.folds, { integer: true, min: 2, max: 50 }),
    embargoBars: v.embargo !== undefined ? number('embargo', v.embargo, { integer: true, min: 0, max: 10_000 }) : maxBars,
    seed: number('seed', v.seed, { integer: true, min: 0, max: 2 ** 32 - 1 }),
    syntheticSymbols: number('synthetic-symbols', v['synthetic-symbols'], { integer: true, min: 1, max: 100 }),
    syntheticBars: number('synthetic-bars', v['synthetic-bars'], { integer: true, min: 200, max: 200_000 }),
    minQuoteVolume24h: number('min-quote-volume', v['min-quote-volume'], { min: 0, max: 1e12 }),
    cacheDir: v['no-cache'] ? null : v['cache-dir'],
    out: outDir,
    writeCalibration: v['write-calibration'] ?? null,
  };
}
