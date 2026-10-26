// Parsing argumen CLI replay Reversal Radar (scripts/reversal-replay.js). Dipisah agar dapat diuji tanpa menjalankan replay.
import { parseArgs } from 'node:util';
import { REVERSAL_TIMEFRAMES } from '../../backend/reversal/constants.js';
import { EVALUATION_SEEDS, SCENARIO_IDS, TUNING_SEEDS } from '../../tests/fixtures/candles/reversalScenarios.js';

export const REVERSAL_REPLAY_USAGE = `Pemakaian: npm run reversal:replay -- [opsi]

Sumber data (pilih satu):
  --synthetic                 skenario sintetis berbenih (tests/fixtures/candles/reversalScenarios.js; membuktikan mekanisme, bukan akurasi)
  --symbols BTCUSDT,ETHUSDT   data Binance USDT-M nyata (cache data/backtest-cache; hanya dapat diakses dari Mac pengguna)
  --top 20                    N simbol teratas menurut quote volume 24 jam (butuh akses Binance)

Opsi skenario sintetis:
  --seeds 21-60               benih (rentang a-b dan/atau daftar a,b,c). Set penyetelan = ${TUNING_SEEDS.from}-${TUNING_SEEDS.to}, set evaluasi = ${EVALUATION_SEEDS.from}-${EVALUATION_SEEDS.to} (bawaan)
  --scenarios all|id,id       pilihan: ${SCENARIO_IDS.join(', ')}
  --tuning                    menyatakan run ini untuk menyetel parameter (benih 1-20 tanpa peringatan)

Opsi data nyata:
  --from 2025-06-01           awal rentang (UTC, inklusif)
  --to 2025-10-01             akhir rentang (UTC, eksklusif; bawaan sekarang)
  --min-quote-volume 0        ambang quote volume 24 jam untuk --top
  --cache-dir data/backtest-cache
  --no-cache                  jangan baca/tulis cache disk

Opsi umum:
  --timeframes 5m,15m,1h      timeframe dasar (pilihan: ${REVERSAL_TIMEFRAMES.join(', ')}; bawaan semua)
  --horizon 48                horizon triple barrier (candle) — definisi keberhasilan docs/19 §10
  --target-atr 2              target = close deteksi + N × ATR deteksi (§10: 2)
  --old fast|full|off         pembanding mesin lama SA/PVA: fast (bawaan; tanpa konfluensi v3, sinyal pertama identik),
                              full (parameter live, ≈ 4× lebih lambat), off
  --check-lookahead           uji stabilitas prefiks (anti-look-ahead) pada sebagian seri
  --lookahead-samples 4       jumlah indeks acak per seri yang diuji
  --lookahead-series 1        jumlah seri per skenario × timeframe (data nyata: per timeframe) yang diuji
  --out reports/              folder laporan (reversal-replay-<timestamp>.md & .json)
  -h, --help                  tampilkan bantuan ini
`;

const OPTIONS = Object.freeze({
  synthetic: { type: 'boolean', default: false },
  seeds: { type: 'string', default: `${EVALUATION_SEEDS.from}-${EVALUATION_SEEDS.to}` },
  scenarios: { type: 'string', default: 'all' },
  tuning: { type: 'boolean', default: false },
  symbols: { type: 'string' },
  top: { type: 'string' },
  from: { type: 'string' },
  to: { type: 'string' },
  'min-quote-volume': { type: 'string', default: '0' },
  'cache-dir': { type: 'string', default: 'data/backtest-cache' },
  'no-cache': { type: 'boolean', default: false },
  timeframes: { type: 'string', default: REVERSAL_TIMEFRAMES.join(',') },
  horizon: { type: 'string', default: '48' },
  'target-atr': { type: 'string', default: '2' },
  old: { type: 'string', default: 'fast' },
  'check-lookahead': { type: 'boolean', default: false },
  'lookahead-samples': { type: 'string', default: '4' },
  'lookahead-series': { type: 'string', default: '1' },
  out: { type: 'string', default: 'reports' },
  help: { type: 'boolean', short: 'h', default: false },
});

const DEFAULT_FROM = '2025-06-01';
const SYMBOL_RE = /^[A-Z0-9]{2,30}$/;
const MAX_SEEDS = 500;

const list = (text) => String(text).split(',').map((s) => s.trim()).filter(Boolean);

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
 * Daftar benih dari teks "21-60", "1,2,3", atau campuran "1-3,7"; unik, urut naik, maksimum 500.
 * @param {string} text
 * @returns {number[]}
 */
export function parseSeeds(text) {
  const out = new Set();
  for (const part of list(text)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new RangeError(`--seeds tidak valid: ${part.slice(0, 20)} (contoh: 21-60 atau 1,2,3)`);
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to || to > 2 ** 32 - 1) throw new RangeError(`--seeds rentang tidak valid: ${part.slice(0, 20)}`);
    for (let s = from; s <= to; s += 1) {
      out.add(s);
      if (out.size > MAX_SEEDS) throw new RangeError(`--seeds terlalu banyak (maksimum ${MAX_SEEDS})`);
    }
  }
  if (out.size === 0) throw new RangeError('--seeds kosong');
  return [...out].sort((a, b) => a - b);
}

/** 'tuning' bila semua benih di set penyetelan, 'evaluation' bila semua di set evaluasi, 'mixed' bila keduanya, selain itu 'custom'. */
export function classifySeeds(seeds) {
  const inRange = (s, r) => s >= r.from && s <= r.to;
  const tuning = seeds.filter((s) => inRange(s, TUNING_SEEDS)).length;
  const evaluation = seeds.filter((s) => inRange(s, EVALUATION_SEEDS)).length;
  if (tuning === seeds.length) return 'tuning';
  if (evaluation === seeds.length) return 'evaluation';
  if (tuning > 0 && evaluation > 0 && tuning + evaluation === seeds.length) return 'mixed';
  return tuning > 0 ? 'mixed' : 'custom';
}

/**
 * Parse argumen CLI replay Reversal Radar.
 * @param {string[]} argv argumen setelah nama skrip
 * @param {{ now?: number }} [options] `now` = nilai bawaan --to
 * @returns {{
 *   help: boolean, source: 'synthetic'|'binance'|null, seeds: number[], seedSet: string, scenarios: string[], tuning: boolean,
 *   symbols: string[]|null, top: number|null, from: number, to: number, minQuoteVolume24h: number, cacheDir: string|null,
 *   timeframes: string[], horizonBars: number, targetAtr: number, old: 'fast'|'full'|'off', checkLookahead: boolean,
 *   lookaheadSamples: number, lookaheadSeries: number, out: string, warnings: string[],
 * }}
 * @throws {TypeError|RangeError} pesan bahasa Indonesia untuk argumen tidak valid
 */
export function parseReversalReplayArgs(argv, { now = Date.now() } = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false, strict: true });
  } catch (err) {
    throw new TypeError(`Argumen tidak valid: ${err.message}`, { cause: err });
  }
  const v = parsed.values;
  if (v.help) return { help: true, source: null };

  const binance = v.symbols !== undefined || v.top !== undefined;
  if (binance && v.synthetic) throw new TypeError('Pilih satu sumber data: --synthetic atau --symbols/--top');
  if (!binance && !v.synthetic) throw new TypeError('Pilih sumber data: --synthetic (skenario fixture) atau --symbols/--top (data Binance nyata)');
  if (v.symbols !== undefined && v.top !== undefined) throw new TypeError('--symbols dan --top tidak boleh dipakai bersamaan');
  const source = binance ? 'binance' : 'synthetic';

  let symbols = null;
  if (v.symbols !== undefined) {
    symbols = [...new Set(list(v.symbols).map((s) => s.toUpperCase()))];
    if (symbols.length === 0) throw new TypeError('--symbols kosong');
    const bad = symbols.find((s) => !SYMBOL_RE.test(s));
    if (bad) throw new TypeError(`Simbol tidak valid: ${bad.slice(0, 40)}`);
  }
  const top = v.top !== undefined ? number('top', v.top, { integer: true, min: 1, max: 200 }) : null;

  const timeframes = [...new Set(list(v.timeframes))];
  if (timeframes.length === 0) throw new TypeError('--timeframes kosong');
  const badTf = timeframes.find((tf) => !REVERSAL_TIMEFRAMES.includes(tf));
  if (badTf) throw new TypeError(`Timeframe tidak didukung Reversal Radar: ${badTf.slice(0, 16)} (pilihan: ${REVERSAL_TIMEFRAMES.join(', ')})`);

  const scenarios = v.scenarios.trim() === 'all' ? [...SCENARIO_IDS] : [...new Set(list(v.scenarios))];
  if (scenarios.length === 0) throw new TypeError('--scenarios kosong');
  const badScenario = scenarios.find((s) => !SCENARIO_IDS.includes(s));
  if (badScenario) throw new TypeError(`Skenario tidak dikenal: ${badScenario.slice(0, 40)} (pilihan: ${SCENARIO_IDS.join(', ')})`);

  const seeds = parseSeeds(v.seeds);
  const seedSet = classifySeeds(seeds);
  const warnings = [];
  if (source === 'synthetic' && (seedSet === 'tuning' || seedSet === 'mixed') && !v.tuning) {
    warnings.push(`Benih ${TUNING_SEEDS.from}–${TUNING_SEEDS.to} adalah SET PENYETELAN: hasilnya in-sample dan TIDAK boleh dilaporkan sebagai evaluasi. `
      + `Gunakan --seeds ${EVALUATION_SEEDS.from}-${EVALUATION_SEEDS.to} untuk evaluasi, atau tambahkan --tuning bila memang sedang menyetel.`);
  }

  const from = date('from', v.from ?? DEFAULT_FROM);
  const to = v.to !== undefined ? date('to', v.to) : now;
  if (from >= to) throw new RangeError('--from harus sebelum --to');

  const old = String(v.old).trim();
  if (!['fast', 'full', 'off'].includes(old)) throw new TypeError(`--old harus fast, full, atau off (diberikan: ${old.slice(0, 20)})`);
  const outDir = String(v.out).trim();
  if (outDir === '') throw new TypeError('--out kosong');

  return {
    help: false,
    source,
    seeds,
    seedSet,
    scenarios,
    tuning: v.tuning,
    symbols,
    top,
    from,
    to,
    minQuoteVolume24h: number('min-quote-volume', v['min-quote-volume'], { min: 0, max: 1e12 }),
    cacheDir: v['no-cache'] ? null : v['cache-dir'],
    timeframes,
    horizonBars: number('horizon', v.horizon, { integer: true, min: 1, max: 5000 }),
    targetAtr: number('target-atr', v['target-atr'], { min: 0.1, max: 20 }),
    old,
    checkLookahead: v['check-lookahead'],
    lookaheadSamples: number('lookahead-samples', v['lookahead-samples'], { integer: true, min: 1, max: 100 }),
    lookaheadSeries: number('lookahead-series', v['lookahead-series'], { integer: true, min: 1, max: 1000 }),
    out: outDir,
    warnings,
  };
}
