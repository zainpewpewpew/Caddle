// Skenario pasar SINTETIS berbenih untuk validasi "Reversal Radar" (docs/19 §9). Fixture sintetis — BUKAN data
// pasar nyata: hasil replay di atasnya hanya membuktikan mekanisme dan arah perilaku detektor pada bentuk chart
// yang diketahui, bukan akurasi di pasar sungguhan.
//
// Setiap skenario deterministik untuk (seed, opsi) yang sama; derau hanya dari PRNG berbenih (tanpa Math.random).
// Panjang ≥ 350 candle: 150 candle warm-up (mesin butuh requiredCandles ≤ 150) + fase-fase skenario. Variasi
// struktural ringan per seed (panjang fase ±20 %, amplitudo ±10–20 %) agar seed evaluasi tidak sekadar berbeda derau.
// Return per candle TIDAK diskalakan menurut timeframe: bentuk chart (dalam candle) identik untuk 5m/15m/1h, yang
// berbeda hanya stempel waktu — sehingga perbedaan hasil antar-timeframe berasal dari parameter mesin per timeframe.
//
// Set benih: 1–20 = penyetelan parameter (TUNING_SEEDS), 21–60 = evaluasi (EVALUATION_SEEDS; tidak boleh dipakai
// untuk menyetel). Harga awal per seed tersebar log-uniform 0,01..1000 agar skala harga ikut teruji.
import { aggregateCandles } from '../../../backend/backtest/synthetic.js';
import { HIGHER_TIMEFRAMES, TIMEFRAME_MS } from '../../../backend/market/contracts.js';
import { SYNTHETIC_START, generateCandles, mulberry32, withZeroVolume, withoutCandle } from './synthetic.js';

/** Candle warm-up sebelum fase skenario (sama dengan BACKTEST_WARMUP / requiredCandles maksimum mesin). */
export const SCENARIO_WARMUP = 150;
/** Panjang minimum setiap skenario. */
export const MIN_SCENARIO_BARS = 350;
/** Panjang target (fase terakhir dipanjangkan sampai total ini). */
const TARGET_BARS = 370;
/** Benih penyetelan parameter (in-sample). */
export const TUNING_SEEDS = Object.freeze({ from: 1, to: 20 });
/** Benih evaluasi (out-of-sample terhadap penyetelan). */
export const EVALUATION_SEEDS = Object.freeze({ from: 21, to: 60 });
/** Skenario yang seharusnya TIDAK menghasilkan kandidat: setiap kandidat = false positive. */
export const FALSE_POSITIVE_SCENARIOS = Object.freeze(['continuedDowntrend', 'suddenPump', 'uptrendContinuation']);
/** Jenis kerusakan data pada brokenData. */
export const BROKEN_KINDS = Object.freeze(['gap', 'zeroVolume', 'corrupt', 'all']);

const repeat = (value, n) => Array.from({ length: n }, () => value);
/** Siklus zig-zag: `up` candle naik `upStep`, lalu `down` candle turun `downStep` (return per candle). */
export const zigzag = (up, upStep, down, downStep) => [...repeat(upStep, up), ...repeat(-downStep, down)];

/** PRNG rencana (variasi struktural), terpisah dari PRNG derau harga di generateCandles. */
function planRng(seed, salt) {
  return mulberry32((Math.imul(seed >>> 0, 0x9e3779b1) ^ salt) >>> 0);
}
const vary = (rng, value, pct) => value * (1 + pct * (2 * rng() - 1));
const varyInt = (rng, value, pct) => Math.max(1, Math.round(vary(rng, value, pct)));

/** Harga awal per seed, log-uniform 0,01..1000 (6 angka penting). */
export function startPriceFor(seed) {
  const u = mulberry32(((seed >>> 0) ^ 0x51ed) >>> 0)();
  return Number((10 ** (-2 + 5 * u)).toPrecision(6));
}

/** Fase sideways baseline: zig-zag 3 naik / 3 turun 0,2 % (ATR ≈ 0,3 % harga), volume konstan. */
const sideways = (name, bars, volume, extra = {}) => ({ name, bars, cycle: zigzag(3, 0.002, 3, 0.002), volume, ...extra });
/** Penurunan jelas: 2 naik 0,25 % / 4 turun `down` → ≈ −1,1 % per 6 candle (≈ 25 ATR per 60 candle). */
const decline = (name, bars, down, extra = {}) => ({ name, bars, cycle: zigzag(2, 0.0025, 4, down), volume: 110, volumeEnd: 130, wick: 0.0015, ...extra });
/** Panjang fase penutup agar total = TARGET_BARS (minimal `min`). */
const padTo = (segments, min = 20) => Math.max(min, TARGET_BARS - segments.reduce((a, s) => a + s.bars, 0));

/**
 * Rencana skenario: daftar segmen generateCandles dengan `name` fase dan `volume` dalam RIBU USDT per candle
 * (dikonversi ke volume base menurut harga awal), plus pasca-proses opsional (kerusakan data).
 * @typedef {{ segments: Array<object>, post?: (candles: object[], phases: object[]) => { candles: object[], phases: object[] } }} ScenarioPlan
 */

/**
 * Reversal sukses: downtrend jelas (≥ 4 ATR) → lower low makin dangkal → dasar membulat/sideways dengan dasar naik
 * dan volume mengering → higher low → breakout bervolume (RVOL ≥ 1,5) → markup.
 */
function successfulReversalPlan(seed) {
  const rng = planRng(seed, 0x5acc);
  const declineBars = 6 * varyInt(rng, 10, 0.2);
  const declineDown = vary(rng, 0.004, 0.15);
  // Lower low makin dangkal: tiga siklus 5 naik 0,25 % / 7 turun `depth` → net ≈ −1,2 %, −0,57 %, −0,29 % per siklus.
  // Variasi ±3 % menjaga urutan kedalaman; derau fase ini dikecilkan agar klaim "makin dangkal" kokoh pada semua seed.
  const shallowUp = 0.0025;
  const depths = [0.0035, 0.0026, 0.0022].map((d) => vary(rng, d, 0.03));
  const baseBars = 8 * varyInt(rng, 5, 0.2);
  const baseVolumeEnd = vary(rng, 45, 0.15);
  const breakoutDrift = vary(rng, 0.008, 0.2);
  const markupBars = 8 * varyInt(rng, 5, 0.2);
  const segments = [
    sideways('warmup', SCENARIO_WARMUP, 100),
    decline('decline', declineBars, declineDown),
    {
      name: 'shallower', bars: 36, volume: 120, volumeEnd: 80, noise: 0.00015,
      cycle: [
        ...repeat(shallowUp, 5), ...repeat(-depths[0], 7),
        ...repeat(shallowUp, 5), ...repeat(-depths[1], 7),
        ...repeat(shallowUp, 5), ...repeat(-depths[2], 7),
      ],
    },
    { name: 'base', bars: baseBars, cycle: zigzag(4, 0.0018, 4, 0.0014), volume: 80, volumeEnd: baseVolumeEnd, noise: 0.0003, wick: 0.001 },
    { name: 'higherLow', bars: 10, cycle: [...repeat(0.002, 4), ...repeat(-0.0015, 3), ...repeat(0.002, 3)], volume: 50, volumeEnd: 65 },
    { name: 'breakout', bars: 4, drift: breakoutDrift, volume: 220, wick: 0.002 },
    { name: 'markup', bars: markupBars, cycle: zigzag(5, 0.003, 3, 0.002), volume: 140, volumeEnd: 100 },
  ];
  segments.push(sideways('after', padTo(segments), 90));
  return { segments };
}

/** Pantulan gagal: downtrend → pantulan 1–2 ATR tanpa pembentukan dasar → lower low baru menembus dasar. */
function failedBouncePlan(seed) {
  const rng = planRng(seed, 0xfa11);
  const declineBars = 6 * varyInt(rng, 10, 0.2);
  const bounce = vary(rng, 0.0015, 0.2);
  const segments = [
    sideways('warmup', SCENARIO_WARMUP, 100),
    decline('decline', declineBars, vary(rng, 0.004, 0.15)),
    { name: 'bounce', bars: 4, drift: bounce, volume: 90 },
    { name: 'breakdown', bars: 12, drift: -vary(rng, 0.005, 0.15), volume: 150, wick: 0.0015 },
    { name: 'decline2', bars: 48, cycle: zigzag(2, 0.002, 4, 0.003), volume: 120 },
  ];
  segments.push(sideways('after', padTo(segments, 60), 90));
  return { segments };
}

/** Downtrend berlanjut: lower low terus-menerus dengan kedalaman tetap lalu bertambah. */
function continuedDowntrendPlan(seed) {
  const rng = planRng(seed, 0xd0d0);
  const d1 = vary(rng, 0.0033, 0.1);
  const d2 = d1 * vary(rng, 1.15, 0.05);
  const segments = [
    sideways('warmup', SCENARIO_WARMUP, 100),
    { name: 'decline', bars: 105, cycle: zigzag(3, 0.002, 4, d1), volume: 100, volumeEnd: 110 },
    { name: 'decline2', bars: 105, cycle: zigzag(3, 0.002, 4, d2), volume: 110, volumeEnd: 130 },
  ];
  segments.push({ name: 'decline3', bars: padTo(segments, 10), cycle: zigzag(3, 0.002, 4, d2), volume: 130 });
  return { segments };
}

/** Sideways panjang: penurunan singkat lalu range sempit datar tanpa dasar naik dan tanpa volume mengering. */
function longSidewaysPlan(seed) {
  const rng = planRng(seed, 0x51de);
  const segments = [
    sideways('warmup', SCENARIO_WARMUP, 100),
    decline('decline', 36, vary(rng, 0.004, 0.1)),
  ];
  segments.push({ name: 'range', bars: padTo(segments, 170), cycle: zigzag(3, 0.0015, 3, 0.0015), noise: 0.0002, wick: 0.001, volume: 90 });
  return { segments };
}

/** Pump mendadak: penurunan → sideways sempit tanpa dasar → dua candle +5 % bervolume besar → sideways di atas. */
function suddenPumpPlan(seed) {
  const rng = planRng(seed, 0x90b9);
  const segments = [
    sideways('warmup', SCENARIO_WARMUP, 100),
    decline('decline', 36, vary(rng, 0.004, 0.1)),
    { name: 'flat', bars: 112, cycle: zigzag(3, 0.0012, 3, 0.0012), noise: 0.0002, wick: 0.0008, volume: 90 },
    { name: 'pump', bars: 2, drift: vary(rng, 0.05, 0.1), noise: 0.002, wick: 0.004, volume: 600 },
  ];
  segments.push({ name: 'after', bars: padTo(segments, 60), cycle: zigzag(3, 0.002, 3, 0.002), volume: 150, volumeEnd: 100 });
  return { segments };
}

/** Kelanjutan uptrend: EMA25 naik, higher high/higher low, tanpa penurunan awal → harus 0 kandidat. */
function uptrendContinuationPlan(seed) {
  const rng = planRng(seed, 0x0ab0);
  const segments = [
    { name: 'warmup', bars: SCENARIO_WARMUP, cycle: zigzag(4, 0.0015, 2, 0.001), volume: 100 },
  ];
  segments.push({ name: 'uptrend', bars: padTo(segments, 200), cycle: zigzag(5, vary(rng, 0.002, 0.1), 3, 0.0015), volume: 100, volumeEnd: 120 });
  return { segments };
}

/** Indeks awal fase bernama (atau null). */
const phaseStart = (phases, name) => phases.find((p) => p.name === name)?.startIndex ?? null;

/**
 * Data rusak: reversal sukses dengan (a) gap waktu 2 candle di fase penurunan, (b) 5 candle volume nol di awal dasar,
 * (c) satu candle rusak (high < body) di tengah dasar. `kind` memilih salah satu atau semuanya.
 */
function brokenDataPlan(seed, { kind = 'all' } = {}) {
  if (!BROKEN_KINDS.includes(kind)) throw new RangeError(`kind brokenData harus salah satu dari: ${BROKEN_KINDS.join(', ')}`);
  const base = successfulReversalPlan(seed);
  const all = kind === 'all';
  return {
    segments: base.segments,
    post(candles, phases) {
      let out = candles;
      const baseStart = phaseStart(phases, 'base');
      const declineStart = phaseStart(phases, 'decline');
      if (all || kind === 'zeroVolume') out = withZeroVolume(out, baseStart + 4, 5);
      if (all || kind === 'corrupt') {
        const target = baseStart + 20;
        out = out.map((c, i) => (i === target ? { ...c, high: Math.min(c.open, c.close) * 0.998 } : c));
      }
      let shifted = phases;
      if (all || kind === 'gap') {
        const gapAt = declineStart + 12;
        out = withoutCandle(withoutCandle(out, gapAt), gapAt);
        shifted = phases.map((p) => ({
          ...p,
          startIndex: p.startIndex > gapAt ? p.startIndex - 2 : p.startIndex,
          endIndex: p.endIndex >= gapAt ? Math.max(p.startIndex, p.endIndex - 2) : p.endIndex,
        }));
      }
      return { candles: out, phases: shifted };
    },
  };
}

const SCENARIOS = Object.freeze([
  {
    id: 'successfulReversal', label: 'Reversal sukses', plan: successfulReversalPlan, falsePositive: false,
    expectation: '≥ 1 kandidat per seri, deteksi sebelum breakout, mayoritas SUCCESS (target §10: ≥ 60 % pada MEDIUM)',
  },
  {
    id: 'failedBounce', label: 'Pantulan gagal', plan: failedBouncePlan, falsePositive: false,
    expectation: 'kandidat (bila ada) berakhir CANCELLED/FAIL saat lower low baru menembus dasar',
  },
  {
    id: 'continuedDowntrend', label: 'Downtrend berlanjut', plan: continuedDowntrendPlan, falsePositive: true,
    expectation: 'tanpa kandidat atau sangat jarang (target §10: ≤ 15 % seri berkandidat)',
  },
  {
    id: 'longSideways', label: 'Sideways panjang', plan: longSidewaysPlan, falsePositive: false,
    expectation: 'sedikit kandidat; yang terbuka cenderung EXPIRED (tanpa kemajuan), bukan SUCCESS',
  },
  {
    id: 'suddenPump', label: 'Pump mendadak', plan: suddenPumpPlan, falsePositive: true,
    expectation: 'tanpa kandidat sebelum pump; kandidat setelah pump = terlambat (LATE_ENTRY/EXTENDED)',
  },
  {
    id: 'lowVolumeIlliquid', label: 'Reversal tak likuid', plan: (seed) => successfulReversalPlan(seed), falsePositive: false, volumeScale: 0.02,
    expectation: 'pola reversal sama, tetapi quote volume per candle sangat kecil → risiko ILLIQUID, VOLUME_DRY_UP bukan bukti',
  },
  {
    id: 'brokenData', label: 'Data rusak', plan: brokenDataPlan, falsePositive: false,
    expectation: 'DATA_QUALITY tanpa crash; kandidat hanya setelah jendela bebas kerusakan',
  },
  {
    id: 'uptrendContinuation', label: 'Kelanjutan uptrend', plan: uptrendContinuationPlan, falsePositive: true,
    expectation: '0 kandidat (CONTINUATION bukan reversal)',
  },
]);

export const SCENARIO_IDS = Object.freeze(SCENARIOS.map((s) => s.id));

function scenarioById(id) {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new RangeError(`Skenario tidak dikenal: ${String(id).slice(0, 40)} (pilihan: ${SCENARIO_IDS.join(', ')})`);
  return s;
}

/** Nama simbol sintetis untuk skenario × seed (dapat diurai kembali dengan parseScenarioSymbol). */
export function scenarioSymbol(id, seed) {
  return `${id}-${seed}`;
}

/** @returns {{ scenario: string, seed: number } | null} */
export function parseScenarioSymbol(symbol) {
  const m = /^([A-Za-z]+)-(\d+)$/.exec(String(symbol));
  if (!m || !SCENARIO_IDS.includes(m[1])) return null;
  return { scenario: m[1], seed: Number(m[2]) };
}

/**
 * Bangun satu skenario beserta metadata fase.
 * @param {string} id
 * @param {number} seed
 * @param {{ timeframe?: '5m'|'15m'|'1h', symbol?: string, startTime?: number, startPrice?: number, volumeScale?: number, kind?: string }} [options]
 *   volumeScale: pengali volume (lowVolumeIlliquid memakai 0,02 → ≈ 2 ribu USDT per candle); kind: jenis kerusakan brokenData.
 * @returns {{ id: string, seed: number, timeframe: string, symbol: string, candles: object[], phases: Array<{ name: string, startIndex: number, endIndex: number }>,
 *   landmarks: { bottomIndex: number|null, bottomLow: number|null, breakoutIndex: number|null, pumpIndex: number|null } }}
 */
export function buildScenario(id, seed, {
  timeframe = '15m', symbol = scenarioSymbol(id, seed), startTime = SYNTHETIC_START, startPrice = startPriceFor(seed), volumeScale, kind,
} = {}) {
  if (!Number.isInteger(seed) || seed < 0) throw new RangeError('seed harus bilangan bulat ≥ 0');
  if (!Object.hasOwn(TIMEFRAME_MS, timeframe)) throw new RangeError(`Timeframe tidak dikenal: ${String(timeframe)}`);
  if (!(startPrice > 0)) throw new RangeError('startPrice harus > 0');
  const def = scenarioById(id);
  const scale = volumeScale ?? def.volumeScale ?? 1;
  if (!(scale > 0)) throw new RangeError('volumeScale harus > 0');
  const plan = def.plan(seed, kind === undefined ? {} : { kind });
  // volume rencana = ribu USDT per candle → volume base pada harga awal.
  const unit = (1000 * scale) / startPrice;
  // Kunci `name` tidak dikenal generateCandles dan diabaikan.
  const segments = plan.segments.map((seg) => ({
    noise: 0.0004, wick: 0.0012, volumeNoise: 0.15, ...seg,
    volume: seg.volume * unit, volumeEnd: (seg.volumeEnd ?? seg.volume) * unit,
  }));
  let candles = generateCandles({ seed, symbol, timeframe, startTime, startPrice, segments });
  let phases = [];
  let pos = 0;
  for (const seg of plan.segments) {
    phases.push({ name: seg.name, startIndex: pos, endIndex: pos + seg.bars - 1 });
    pos += seg.bars;
  }
  if (typeof plan.post === 'function') ({ candles, phases } = plan.post(candles, phases));
  return { id, seed, timeframe, symbol, candles, phases, landmarks: landmarksOf(candles, phases) };
}

/** Titik acuan skenario: dasar (low terendah setelah warm-up), awal breakout, awal pump. */
function landmarksOf(candles, phases) {
  const from = Math.min(candles.length - 1, (phases.find((p) => p.name === 'warmup')?.endIndex ?? -1) + 1);
  let bottomIndex = null;
  for (let i = from; i < candles.length; i += 1) {
    const low = candles[i].low;
    if (Number.isFinite(low) && (bottomIndex === null || low < candles[bottomIndex].low)) bottomIndex = i;
  }
  return {
    bottomIndex,
    bottomLow: bottomIndex === null ? null : candles[bottomIndex].low,
    breakoutIndex: phaseStart(phases, 'breakout'),
    pumpIndex: phaseStart(phases, 'pump'),
  };
}

const builder = (id) => (seed = 1, options = {}) => buildScenario(id, seed, options).candles;

/** @type {(seed?: number, options?: object) => object[]} */
export const successfulReversal = builder('successfulReversal');
export const failedBounce = builder('failedBounce');
export const continuedDowntrend = builder('continuedDowntrend');
export const longSideways = builder('longSideways');
export const suddenPump = builder('suddenPump');
export const lowVolumeIlliquid = builder('lowVolumeIlliquid');
export const brokenData = builder('brokenData');
export const uptrendContinuation = builder('uptrendContinuation');

/**
 * Katalog skenario: `{ id, label, expectation, falsePositive, build(seed, options) → Candle[], meta(seed, options) → buildScenario(...) }`.
 */
export function scenarioCatalog() {
  return SCENARIOS.map(({ id, label, expectation, falsePositive }) => ({
    id, label, expectation, falsePositive,
    build: (seed = 1, options = {}) => buildScenario(id, seed, options).candles,
    meta: (seed = 1, options = {}) => buildScenario(id, seed, options),
  }));
}

/** Daftar seed dari rentang { from, to } (inklusif). */
export function seedRange({ from, to } = EVALUATION_SEEDS) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) throw new RangeError('rentang seed tidak valid');
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/**
 * Semesta skenario sintetis: { [symbol]: { [timeframe]: candles, ...HTF hasil aggregateCandles } } untuk setiap
 * skenario × seed. Simbol = `${id}-${seed}` (lihat parseScenarioSymbol). HTF hanya kelompok lengkap & tertutup,
 * sehingga tidak ada look-ahead dari agregasi.
 * @param {{ seeds?: number[], timeframe?: '5m'|'15m'|'1h', scenarios?: string[], options?: object }} [input]
 */
export function scenarioUniverse({ seeds = seedRange(EVALUATION_SEEDS), timeframe = '15m', scenarios = SCENARIO_IDS, options = {} } = {}) {
  if (!Array.isArray(seeds) || seeds.length === 0) throw new RangeError('seeds harus array tidak kosong');
  const ids = scenarios === 'all' ? SCENARIO_IDS : scenarios;
  const universe = {};
  for (const id of ids) {
    scenarioById(id);
    for (const seed of seeds) {
      const { symbol, candles } = buildScenario(id, seed, { ...options, timeframe });
      const byTf = { [timeframe]: candles };
      for (const htf of HIGHER_TIMEFRAMES[timeframe]) byTf[htf] = aggregateCandles(candles, htf);
      universe[symbol] = byTf;
    }
  }
  return universe;
}
