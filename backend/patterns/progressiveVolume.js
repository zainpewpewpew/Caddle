// Pattern #002 — Progressive Volume Accumulation (PVA), versi 2 (lihat PATTERN_VERSION).
// Harga naik bertahap disertai volume yang meningkat progresif dari kondisi sepi. Jendela
// progresif = subWindows × subWindowLength candle terakhir, dibagi menjadi sub-jendela berurutan.
// Pola ditolak bila kenaikan volume didominasi satu lonjakan anomali. Dua penjaga:
//   - noSpikeDominance: porsi volume candle terbesar di seluruh jendela (lonjakan raksasa);
//   - growthNotSingleSpike: porsi KENAIKAN volume sub-jendela terakhir (terhadap rata-rata
//     sub-jendela pertama) yang berasal dari candle terbesarnya. Penjaga ini mengikat pada
//     besaran yang sama dengan volumeGrowth, sehingga satu candle 3–5× rata-rata di volume datar
//     (porsi jendela hanya ±0,15–0,2) tidak dapat sendirian memenuhi minVolumeGrowth.
// Fungsi murni; tidak memanggil detektor SA. Skor bukan probabilitas — lihat conditions.js.
import { percentChange, rvol, spikeDominance } from '../indicators/index.js';
import { analyzeStructure, describeConditions, mean, runDetector } from './conditions.js';
import { requiredCandles, resolveParams } from './params.js';

// Bobot total 100. Wajib 75 (definisi pola), opsional 25 (kualitas). Dengan minScore 85,
// minimal 10 poin kondisi opsional harus lulus.
const DEFS = [
  { id: 'volumeRising', label: 'Volume progresif: rata-rata tiap sub-jendela naik dari sebelumnya (jumlah langkah naik ≥ ambang)', weight: 15, required: true, comparator: 'gte' },
  { id: 'volumeGrowth', label: 'Pertumbuhan volume: sub-jendela terakhir / pertama ≥ ambang', weight: 10, required: true, comparator: 'gte' },
  { id: 'noSpikeDominance', label: 'Tidak didominasi satu lonjakan volume: porsi volume candle terbesar di jendela ≤ ambang', weight: 10, required: true, comparator: 'lte' },
  { id: 'growthNotSingleSpike', label: 'Kenaikan volume tidak berasal dari satu candle: porsi kenaikan sub-jendela terakhir (terhadap rata-rata sub-jendela pertama) dari candle terbesarnya ≤ ambang', weight: 5, required: true, comparator: 'lte' },
  { id: 'priceRising', label: 'Harga naik dalam jendela progresif (perubahan > 0)', weight: 10, required: true, comparator: 'gt' },
  { id: 'riseNotSingleCandle', label: 'Kenaikan bertahap: porsi kenaikan dari satu candle ≤ ambang', weight: 10, required: true, comparator: 'lte' },
  { id: 'higherLows', label: 'Higher low terkonfirmasi berurutan ≥ ambang', weight: 10, required: true, comparator: 'gte' },
  { id: 'atrPercentLow', label: 'Volatilitas terkendali: ATR% ≤ ambang', weight: 5, required: true, comparator: 'lte' },
  { id: 'priorQuiet', label: 'Berawal dari kondisi sepi: rata-rata RVOL sub-jendela pertama ≤ ambang', weight: 15, required: false, comparator: 'lte' },
  { id: 'ema7Rising', label: 'Slope EMA7 positif', weight: 5, required: false, comparator: 'gt' },
  { id: 'atrNotExpanding', label: 'Volatilitas tidak melonjak: ATR% / median ATR% ≤ ambang', weight: 5, required: false, comparator: 'lte' },
];

/** Metadata kondisi PVA (id, label, bobot, wajib, pembanding) — tanpa kondisi gerbang. */
export const PVA_CONDITIONS = describeConditions(DEFS);

const thresholdsOf = (p) => ({
  volumeRising: p.subWindows - 1,
  volumeGrowth: p.minVolumeGrowth,
  noSpikeDominance: p.maxSpikeDominance,
  growthNotSingleSpike: p.maxSpikeGrowthShare,
  priceRising: 0,
  riseNotSingleCandle: p.maxSingleMoveShare,
  higherLows: p.minHigherLows,
  atrPercentLow: p.maxAtrPercent,
  priorQuiet: p.maxPriorRvol,
  ema7Rising: 0,
  atrNotExpanding: p.maxAtrExpansion,
});

function measure(candles, p, f) {
  const { last, closes } = f;
  const L = p.subWindowLength;
  const window = p.subWindows * L;
  const start = last - window + 1;
  const volumes = candles.map((c) => c.volume);

  const subMeans = Array.from({ length: p.subWindows }, (_, j) => mean(volumes.slice(start + j * L, start + (j + 1) * L)));
  let risingSteps = 0;
  for (let j = 1; j < subMeans.length; j += 1) if (subMeans[j] > subMeans[j - 1]) risingSteps += 1;
  const first = subMeans[0];
  const growth = first > 0 ? subMeans.at(-1) / first : null;

  // Kenaikan sub-jendela terakhir = Σ (volume − rata-rata sub-jendela pertama). Porsi candle
  // terbesar: kenaikan merata → 1/L; satu lonjakan pada volume datar → ≈ 1. Tidak terdefinisi
  // (null → gagal) bila volume tidak naik.
  const lastVolumes = volumes.slice(last - L + 1, last + 1);
  const increase = first === null ? null : lastVolumes.reduce((a, b) => a + b, 0) - L * first;
  const spikeGrowthShare = increase > 0 ? (Math.max(...lastVolumes) - first) / increase : null;

  // RVOL sub-jendela pertama: baseline = rvolPeriod candle sebelum masing-masing candle.
  const priorRvol = mean(rvol(volumes, p.rvolPeriod).slice(start, start + L));

  // Kenaikan total jendela = close terakhir − close sebelum jendela. Porsi satu candle = kenaikan
  // close-ke-close terbesar / kenaikan total; tidak terdefinisi bila harga tidak naik.
  const totalRise = closes[last] - closes[start - 1];
  let maxMove = 0;
  for (let i = start; i <= last; i += 1) maxMove = Math.max(maxMove, closes[i] - closes[i - 1]);
  const singleMoveShare = totalRise > 0 ? maxMove / totalRise : null;

  const structure = analyzeStructure(candles, f, window);
  return {
    structure,
    liquidity: mean(candles.slice(start).map((c) => c.quoteVolume)),
    values: {
      volumeRising: risingSteps,
      volumeGrowth: growth,
      noSpikeDominance: spikeDominance(volumes, window),
      growthNotSingleSpike: spikeGrowthShare,
      priceRising: percentChange(closes, window)[last],
      riseNotSingleCandle: singleMoveShare,
      higherLows: structure.higherLows,
      atrPercentLow: f.atrPercent,
      priorQuiet: priorRvol,
      ema7Rising: f.ema7Slope,
      atrNotExpanding: f.atrExpansion,
    },
  };
}

/**
 * Deteksi Progressive Volume Accumulation pada candle terakhir.
 * @param {object[]} candles candle tertutup satu simbol & timeframe, urut naik
 * @param {object} [params] override parsial DEFAULT_PVA_PARAMS
 * @returns {object} PatternResult (kontrak §6)
 * @throws {PatternParamsError} bila parameter tidak valid
 */
export function detectProgressiveVolume(candles, params) {
  const p = resolveParams('PVA', params);
  return runDetector({
    pattern: 'PVA',
    candles,
    params: p,
    minCandles: requiredCandles('PVA', p),
    defs: DEFS,
    thresholds: thresholdsOf(p),
    measure,
  });
}
