// Pola SHORT lewat CERMIN harga (bukan duplikasi logika SA/PVA).
//
// Candle dicerminkan: setiap harga p → 1/p dengan high & low ditukar (high' = 1/low, low' = 1/high);
// volume, quoteVolume, dan waktu tidak berubah. Pada deret cermin, higher low = lower high nyata,
// EMA naik = EMA nyata turun, harga naik = harga nyata turun. Detektor SA/PVA yang sama dijalankan
// pada cermin, lalu hasilnya dipetakan kembali ke dunia nyata:
//   - kunci pola SA → SD (Silent Distribution, #003), PVA → PVD (Progressive Volume Distribution, #004);
//   - id & label kondisi diganti versi SHORT (mis. 'Lower high terkonfirmasi', 'Slope EMA7 negatif');
//   - nilai & ambang perubahan harga dikonversi EKSAK ke perubahan harga nyata (1/(1+m) − 1);
//     slope EMA dibalik tandanya (aproksimasi orde pertama dari slope EMA harga nyata); nilai
//     volume, RVOL, ATR%, dan rasio tidak berubah;
//   - invalidationPrice = 1 / level cermin → harga nyata DI ATAS swing high terkonfirmasi terakhir.
// Status lulus/gagal tiap kondisi, patternScore, earlyScore, dan risk flag diambil apa adanya dari
// evaluasi cermin (EXTENDED_PRICE pada cermin = harga nyata jauh DI BAWAH EMA25).
//
// Skor tetap skor aturan 0–100 yang dapat dijelaskan — BUKAN probabilitas dan bukan rekomendasi
// jual/short. Pola SHORT hanya kandidat riset.
import { PATTERN_VERSION } from './conditions.js';

/**
 * Versi metodologi pola SHORT (SD & PVD). v1 = cermin SA/PVA PATTERN_VERSION 2; v2 = cermin PATTERN_VERSION 3. Karena SD/PVD
 * menjalankan detektor SA/PVA, setiap kenaikan PATTERN_VERSION WAJIB ikut menaikkan versi ini
 * (definisi tersimpan memuat `mirrorOf`, sehingga lupa menaikkan → DEFINITION_CONFLICT saat start).
 */
export const SHORT_PATTERN_VERSION = 2;

/** Versi pola LONG yang dicerminkan oleh SHORT_PATTERN_VERSION saat ini. */
export const MIRRORED_LONG_VERSION = PATTERN_VERSION;

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Candle cermin (harga → 1/harga, high ↔ low). Nilai yang tidak valid tetap tidak valid (mis. 0 →
 * Infinity), sehingga pemeriksaan kualitas data detektor menolaknya seperti pada harga nyata.
 * @param {object[]} candles
 * @returns {object[]}
 * @throws {TypeError} bila candles bukan array
 */
export function mirrorCandles(candles) {
  if (!Array.isArray(candles)) throw new TypeError('candles harus berupa array');
  return candles.map((c) => {
    if (typeof c !== 'object' || c === null) return c;
    return { ...c, open: 1 / c.open, high: 1 / c.low, low: 1 / c.high, close: 1 / c.close };
  });
}

/** Harga cermin → harga nyata (null bila tidak valid). */
export function unmirrorPrice(value) {
  return isFiniteNumber(value) && value > 0 ? 1 / value : null;
}

/** Perubahan relatif harga cermin m → perubahan relatif harga nyata (eksak): 1/(1+m) − 1. */
export function realChangeOf(mirrorChange) {
  return isFiniteNumber(mirrorChange) && mirrorChange > -1 ? 1 / (1 + mirrorChange) - 1 : null;
}

/** Tanda dibalik; −0 dinormalkan ke 0 agar tampilan & JSON stabil. */
function negate(v) {
  if (!isFiniteNumber(v)) return null;
  return v === 0 ? 0 : -v;
}

const same = (v) => (isFiniteNumber(v) ? v : null);

/**
 * Peta kondisi pola LONG (id cermin) → kondisi SHORT. `value`/`threshold` mengonversi angka cermin;
 * `comparator` = pembanding pada nilai nyata (konsisten dengan status lulus dari evaluasi cermin).
 * Kondisi tanpa entri `label` memakai label pola LONG (makna sama untuk kedua arah, mis. volume).
 */
const MAPS = Object.freeze({
  SA: Object.freeze({
    rvolLow: { id: 'rvolLow', value: same, threshold: same },
    priceRising: { id: 'priceFalling', label: 'Harga turun dalam jendela struktur (perubahan < 0)', comparator: 'lt', value: realChangeOf, threshold: realChangeOf },
    priceGradual: { id: 'priceGradual', label: 'Harga turun bertahap: penurunan masih kecil (perubahan ≥ −ambang)', comparator: 'gte', value: realChangeOf, threshold: realChangeOf },
    higherLows: { id: 'lowerHighs', label: 'Lower high terkonfirmasi berurutan ≥ ambang', value: same, threshold: same },
    ema7Rising: { id: 'ema7Falling', label: 'Slope EMA7 negatif', comparator: 'lt', value: negate, threshold: negate },
    atrPercentLow: { id: 'atrPercentLow', value: same, threshold: same },
    ema25NotFalling: { id: 'ema25NotRising', label: 'EMA25 datar atau turun (slope ≤ +toleransi)', comparator: 'lte', value: negate, threshold: negate },
    atrNotExpanding: { id: 'atrNotExpanding', value: same, threshold: same },
    notExtended: { id: 'notExtended', label: 'Harga tidak jauh di bawah EMA25: (EMA25 − close) / ATR ≤ ambang', value: same, threshold: same },
    liquidity: { id: 'liquidity', value: same, threshold: same },
  }),
  PVA: Object.freeze({
    volumeRising: { id: 'volumeRising', value: same, threshold: same },
    volumeGrowth: { id: 'volumeGrowth', value: same, threshold: same },
    noSpikeDominance: { id: 'noSpikeDominance', value: same, threshold: same },
    volumeGrowthBroad: { id: 'volumeGrowthBroad', value: same, threshold: same },
    priceRising: { id: 'priceFalling', label: 'Harga turun dalam jendela progresif (perubahan < 0)', comparator: 'lt', value: realChangeOf, threshold: realChangeOf },
    riseNotSingleCandle: { id: 'dropNotSingleCandle', label: 'Harga turun bertahap: porsi penurunan dari satu candle ≤ ambang', value: same, threshold: same },
    higherLows: { id: 'lowerHighs', label: 'Lower high terkonfirmasi berurutan ≥ ambang', value: same, threshold: same },
    atrPercentLow: { id: 'atrPercentLow', value: same, threshold: same },
    priorQuiet: { id: 'priorQuiet', value: same, threshold: same },
    ema7Rising: { id: 'ema7Falling', label: 'Slope EMA7 negatif', comparator: 'lt', value: negate, threshold: negate },
    atrNotExpanding: { id: 'atrNotExpanding', value: same, threshold: same },
  }),
});

/** Pola SHORT → pola LONG yang dicerminkan. */
export const SHORT_TO_LONG = Object.freeze({ SD: 'SA', PVD: 'PVA' });

const identity = { value: same, threshold: same };

function mapFor(longKey, id) {
  return Object.hasOwn(MAPS[longKey], id) ? MAPS[longKey][id] : identity;
}

/**
 * Metadata kondisi SHORT (id, label, bobot, wajib, pembanding) dari metadata kondisi pola LONG.
 * @param {'SD'|'PVD'} shortKey
 * @param {ReadonlyArray<{ id: string, label: string, weight: number, required: boolean, comparator: string }>} longConditions
 */
export function describeShortConditions(shortKey, longConditions) {
  const longKey = SHORT_TO_LONG[shortKey];
  return Object.freeze(longConditions.map((c) => {
    const m = mapFor(longKey, c.id);
    return Object.freeze({
      id: m.id ?? c.id, label: m.label ?? c.label, weight: c.weight, required: c.required, comparator: m.comparator ?? c.comparator,
    });
  }));
}

/**
 * PatternResult evaluasi cermin (pola SA/PVA) → PatternResult SHORT (SD/PVD) dalam harga nyata.
 * @param {'SD'|'PVD'} shortKey
 * @param {object} mirrored PatternResult detectSilentAccumulation/detectProgressiveVolume atas candle cermin
 */
export function toShortResult(shortKey, mirrored) {
  const longKey = SHORT_TO_LONG[shortKey];
  const conditions = mirrored.conditions.map((c) => {
    const m = mapFor(longKey, c.id);
    return {
      id: m.id ?? c.id,
      label: m.label ?? c.label,
      passed: c.passed,
      value: (m.value ?? same)(c.value),
      threshold: (m.threshold ?? same)(c.threshold),
      weight: c.weight,
    };
  });
  return {
    ...mirrored,
    pattern: shortKey,
    version: SHORT_PATTERN_VERSION,
    conditions,
    invalidationPrice: unmirrorPrice(mirrored.invalidationPrice),
  };
}
