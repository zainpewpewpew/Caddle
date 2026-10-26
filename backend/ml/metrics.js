// Metrik peluang untuk evaluasi meta-model. Fungsi murni.
import { brierScore } from '../backtest/metrics.js';

export { brierScore };

const EPS = 1e-6;

/** Log-loss (cross-entropy) rata-rata; peluang dipotong ke [1e-6, 1 − 1e-6]. null bila kosong. */
export function logLoss(pairs) {
  const valid = (pairs ?? []).filter((x) => Number.isFinite(x?.p) && (x.y === 0 || x.y === 1));
  if (valid.length === 0) return null;
  return -valid.reduce((a, { p, y }) => {
    const q = Math.min(1 - EPS, Math.max(EPS, p));
    return a + (y === 1 ? Math.log(q) : Math.log(1 - q));
  }, 0) / valid.length;
}

/**
 * AUC ROC = peluang trade WIN acak diberi peluang lebih tinggi dari trade non-WIN acak (Mann–Whitney; seri = ½).
 * 0.5 = tidak lebih baik dari acak. null bila salah satu kelas kosong.
 */
export function auc(pairs) {
  const valid = (pairs ?? []).filter((x) => Number.isFinite(x?.p) && (x.y === 0 || x.y === 1));
  const pos = valid.filter((x) => x.y === 1).length;
  const neg = valid.length - pos;
  if (pos === 0 || neg === 0) return null;
  const sorted = [...valid].sort((a, b) => a.p - b.p);
  let rankSumPos = 0;
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j < sorted.length && sorted[j].p === sorted[i].p) j += 1;
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k += 1) if (sorted[k].y === 1) rankSumPos += avgRank;
    i = j;
  }
  return (rankSumPos - (pos * (pos + 1)) / 2) / (pos * neg);
}

/** PRNG deterministik mulberry32 (benih 32-bit) → fungsi () ∈ [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Bootstrap blok (blok = hari UTC entri). Trade pada hari yang sama saling berkorelasi (seluruh pasar kripto bergerak
 * bersama), jadi resampling per trade membuat interval terlalu sempit; resampling per hari lebih jujur.
 * @param {{ day: number }[]} items
 * @param {(items: object[]) => number|null} stat statistik atas sekumpulan item (null = tidak terdefinisi)
 * @returns {null | { mean: number, lower: number, upper: number, blocks: number }} interval persentil 95%
 */
export function blockBootstrap(items, stat, { resamples = 1000, seed = 1 } = {}) {
  const blocks = new Map();
  for (const it of items ?? []) {
    if (!blocks.has(it.day)) blocks.set(it.day, []);
    blocks.get(it.day).push(it);
  }
  const list = [...blocks.values()];
  const observed = stat(items ?? []);
  if (list.length < 2 || !Number.isFinite(observed)) return null;
  const rand = mulberry32(seed);
  const values = [];
  for (let r = 0; r < resamples; r += 1) {
    const sample = [];
    for (let k = 0; k < list.length; k += 1) sample.push(...list[Math.floor(rand() * list.length)]);
    const v = stat(sample);
    if (Number.isFinite(v)) values.push(v);
  }
  if (values.length < resamples / 2) return null;
  values.sort((a, b) => a - b);
  return {
    mean: observed,
    lower: values[Math.floor(0.025 * (values.length - 1))],
    upper: values[Math.ceil(0.975 * (values.length - 1))],
    blocks: list.length,
  };
}

const meanOf = (xs) => (xs.length ? xs.reduce((a, v) => a + v, 0) / xs.length : null);

/** Bootstrap blok untuk rata-rata `diff` (selisih berpasangan per trade). */
export function blockBootstrapMean(items, options) {
  const valid = (items ?? []).filter((it) => Number.isFinite(it?.diff));
  return blockBootstrap(valid, (xs) => meanOf(xs.map((x) => x.diff)), options);
}
