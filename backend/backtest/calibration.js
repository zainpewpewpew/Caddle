// Kalibrasi skor aturan (0..100) menjadi peluang empiris menang, dari trade backtest out-of-sample.
// Metode: bin kuantil → gabung bin kecil → posterior Beta (Laplace) → isotonik PAV (monoton naik terhadap skor).
// Fungsi murni. Peluang hanya boleh ditampilkan bila sampel memadai (lihat MIN_CALIBRATION_SAMPLES).

import { fitLogistic, predictLogistic } from '../ml/logistic.js';
import { brierScore, wilsonInterval } from './metrics.js';

export const CALIBRATION_VERSION = 1;
export const CALIBRATION_METHOD = 'isotonic-pav+beta-prior';
export const PLATT_METHOD = 'platt-logistic+bins';
export const CALIBRATION_METHODS = Object.freeze(['platt', 'isotonic']);
/** Total sampel minimum agar applyCalibration mau mengeluarkan peluang. */
export const MIN_CALIBRATION_SAMPLES = 100;

const toWin = (w) => (w === true || w === 1 ? 1 : w === false || w === 0 ? 0 : null);

function cleanSamples(samples) {
  const out = [];
  for (const s of samples ?? []) {
    const win = toWin(s?.win);
    if (Number.isFinite(s?.score) && win !== null) out.push({ score: s.score, win });
  }
  return out.sort((a, b) => a.score - b.score);
}

/** Bin kuantil atas sampel terurut; skor yang sama tidak pernah terbelah ke dua bin. */
function quantileBins(sorted, bins) {
  const n = sorted.length;
  const k = Math.min(bins, n);
  const out = [];
  let i = 0;
  for (let b = 1; b <= k && i < n; b += 1) {
    let end = b === k ? n : Math.max(i + 1, Math.floor((b * n) / k));
    while (end < n && sorted[end].score === sorted[end - 1].score) end += 1;
    const slice = sorted.slice(i, end);
    out.push({ lo: slice[0].score, hi: slice[slice.length - 1].score, n: slice.length, wins: slice.reduce((a, s) => a + s.win, 0) });
    i = end;
  }
  return out;
}

const mergeTwo = (a, b) => ({ lo: Math.min(a.lo, b.lo), hi: Math.max(a.hi, b.hi), n: a.n + b.n, wins: a.wins + b.wins });

/** Gabungkan bin dengan n < minSamples ke tetangga (kiri ke kanan; sisa ekor digabung ke bin sebelumnya). */
function mergeSmall(bins, minSamples) {
  const out = [];
  let acc = null;
  for (const b of bins) {
    acc = acc ? mergeTwo(acc, b) : { ...b };
    if (acc.n >= minSamples) {
      out.push(acc);
      acc = null;
    }
  }
  if (acc) {
    if (out.length > 0) out.push(mergeTwo(out.pop(), acc));
    else out.push(acc);
  }
  return out;
}

/**
 * Pool-Adjacent-Violators: blok bertumpuk; peluang blok = posterior Beta dari hitungan gabungan.
 * Setelah tiap push, blok digabung selama peluang blok sebelumnya > blok teratas → hasil monoton naik.
 */
function pav(bins, posterior) {
  const stack = [];
  for (const b of bins) {
    stack.push({ ...b, probability: posterior(b) });
    while (stack.length > 1 && stack[stack.length - 2].probability > stack[stack.length - 1].probability) {
      const top = stack.pop();
      const prev = stack.pop();
      const merged = mergeTwo(prev, top);
      stack.push({ ...merged, probability: posterior(merged) });
    }
  }
  return stack;
}

/**
 * Pasang tabel kalibrasi dari sampel { score, win: 0|1 }.
 * Probabilitas bin = (wins + α) / (n + α + β); lower/upper = interval Wilson 95% dari wins/n bin.
 * @returns {{ version: 1, method: string, totalSamples: number, prior: { alpha: number, beta: number },
 *   bins: { lo: number, hi: number, n: number, wins: number, probability: number, lower: number, upper: number }[] }}
 */
export function fitCalibration(samples, { bins = 10, minSamplesPerBin = 30, prior = { alpha: 1, beta: 1 } } = {}) {
  if (!Number.isInteger(bins) || bins < 1) throw new RangeError('bins harus bilangan bulat ≥ 1');
  const alpha = prior?.alpha ?? 1;
  const beta = prior?.beta ?? 1;
  if (!(alpha >= 0 && beta >= 0)) throw new RangeError('prior alpha/beta harus ≥ 0');
  const sorted = cleanSamples(samples);
  const table = { version: CALIBRATION_VERSION, method: CALIBRATION_METHOD, totalSamples: sorted.length, prior: { alpha, beta }, bins: [] };
  if (sorted.length === 0) return table;

  const posterior = (b) => (b.n + alpha + beta > 0 ? (b.wins + alpha) / (b.n + alpha + beta) : 0.5);
  const merged = mergeSmall(quantileBins(sorted, bins), minSamplesPerBin);
  table.bins = pav(merged, posterior).map((b) => {
    const [lower, upper] = wilsonInterval(b.wins, b.n);
    return { lo: b.lo, hi: b.hi, n: b.n, wins: b.wins, probability: b.probability, lower, upper };
  });
  return table;
}

/**
 * Kalibrasi Platt: regresi logistik 1 dimensi peluang = σ(a·skor + b), lalu disajikan dalam bentuk tabel bin yang SAMA
 * dengan fitCalibration (bin kuantil, bin kecil digabung) agar applyCalibration, file config/calibration.json, dan worker
 * live tetap bekerja tanpa perubahan. Peluang bin = rata-rata prediksi Platt atas sampel train di bin itu; interval =
 * Wilson 95% dari hitungan bin (jujur soal ketidakpastian). Platt hanya punya 2 parameter, sehingga jauh lebih stabil
 * daripada isotonik pada sampel kecil (Niculescu-Mizil & Caruana 2005; Kull dkk. 2017 — docs/16 §9).
 * Kemiringan negatif (skor tinggi justru lebih sering kalah) TIDAK dipaksa monoton naik: itu temuan yang harus terlihat.
 * @returns {ReturnType<typeof fitCalibration> & { coefficients?: { slope: number, intercept: number } }}
 */
export function fitPlattCalibration(samples, { bins = 10, minSamplesPerBin = 30 } = {}) {
  if (!Number.isInteger(bins) || bins < 1) throw new RangeError('bins harus bilangan bulat ≥ 1');
  const sorted = cleanSamples(samples);
  const table = { version: CALIBRATION_VERSION, method: PLATT_METHOD, totalSamples: sorted.length, bins: [] };
  if (sorted.length === 0) return table;
  const wins = sorted.reduce((a, s) => a + s.win, 0);
  // Satu kelas saja → logistik tak terdefinisi; pakai frekuensi (dengan prior Laplace) untuk semua bin.
  const flat = wins === 0 || wins === sorted.length ? (wins + 1) / (sorted.length + 2) : null;
  const model = flat === null ? fitLogistic(sorted.map((s) => [s.score / 100]), sorted.map((s) => s.win), { l2: 0.01 }) : null;
  const predict = (score) => (model ? predictLogistic(model, [score / 100]) : flat);
  if (model) {
    // Koefisien dalam satuan skor mentah (prep menstandarkan skor/100).
    const slope = model.weights[0] / model.prep.sds[0] / 100;
    table.coefficients = { slope, intercept: model.bias - (model.weights[0] * model.prep.means[0]) / model.prep.sds[0] };
  }
  const merged = mergeSmall(quantileBins(sorted, bins), minSamplesPerBin);
  table.bins = merged.map((b) => {
    const inBin = sorted.filter((s) => s.score >= b.lo && s.score <= b.hi);
    const probability = inBin.reduce((a, s) => a + predict(s.score), 0) / inBin.length;
    const [lower, upper] = wilsonInterval(b.wins, b.n);
    return { lo: b.lo, hi: b.hi, n: b.n, wins: b.wins, probability, lower, upper };
  });
  return table;
}

/** Pasang tabel kalibrasi dengan metode 'platt' (bawaan) atau 'isotonic'. */
export function fitCalibrationBy(method, samples, options) {
  if (method === 'platt') return fitPlattCalibration(samples, options);
  if (method === 'isotonic') return fitCalibration(samples, options);
  throw new RangeError(`Metode kalibrasi tidak dikenal: ${String(method)} (pilihan: ${CALIBRATION_METHODS.join(', ')})`);
}

/** Indeks bin untuk skor; celah antarbin dibelah di titik tengah, di luar rentang → bin ujung. */
function findBin(bins, score) {
  for (let i = 0; i < bins.length - 1; i += 1) {
    if (score <= (bins[i].hi + bins[i + 1].lo) / 2) return i;
  }
  return bins.length - 1;
}

const unit = (v) => Number.isFinite(v) && v >= 0 && v <= 1;
const validBin = (b) => b !== null && typeof b === 'object' && Number.isFinite(b.lo) && Number.isFinite(b.hi) && b.lo <= b.hi
  && Number.isInteger(b.n) && b.n >= 0 && unit(b.probability) && unit(b.lower) && unit(b.upper);

/**
 * Tabel layak dipakai: bentuk lengkap (bin terurut, peluang & interval 0..1) dan total sampel ≥ 100. Tabel dari file
 * (config/calibration.json) bisa rusak/diedit tangan, jadi divalidasi penuh agar tidak pernah menghasilkan peluang palsu
 * atau error di pipeline.
 */
export function isUsableCalibration(table) {
  if (!table || typeof table !== 'object' || !Array.isArray(table.bins) || table.bins.length === 0) return false;
  if (!Number.isFinite(table.totalSamples) || table.totalSamples < MIN_CALIBRATION_SAMPLES) return false;
  return table.bins.every((b, i) => validBin(b) && (i === 0 || table.bins[i - 1].hi <= b.lo));
}

const usable = isUsableCalibration;

/**
 * Isi file config/calibration.json (tulisan `npm run backtest -- --write-calibration`) → { version: 1, tables } dengan
 * hanya tabel valid berkunci 'LONG|SHORT:*|5m|15m|1h'. Melempar Error bila JSON/bentuk tidak dikenal atau tidak ada tabel
 * yang layak (pemanggil mengabaikan file dan peluang tidak ditampilkan).
 * @param {string} text
 */
export function parseCalibrationFile(text) {
  const parsed = JSON.parse(text);
  if (parsed?.version !== 1 || !parsed.tables || typeof parsed.tables !== 'object') throw new Error('bentuk tidak dikenal');
  const tables = Object.fromEntries(Object.entries(parsed.tables)
    .filter(([key, table]) => /^(LONG|SHORT):(\*|5m|15m|1h)$/.test(key) && isUsableCalibration(table)));
  if (Object.keys(tables).length === 0) throw new Error('tidak ada tabel yang valid (≥ 100 sampel)');
  return { version: 1, tables };
}

/**
 * Peluang empiris untuk satu skor. null bila tabel null/kosong, total sampel < 100, atau skor tidak valid.
 * @returns {null | { probability: number, lower: number, upper: number, samples: number }}
 */
export function applyCalibration(table, score) {
  if (!usable(table) || !Number.isFinite(score)) return null;
  const b = table.bins[findBin(table.bins, score)];
  return { probability: b.probability, lower: b.lower, upper: b.upper, samples: b.n };
}

/**
 * Evaluasi kalibrasi pada data uji (out-of-sample).
 * ECE = Σ_b (n_b/N)·|rata-rata peluang prediksi − frekuensi menang| per bin tabel; Brier = rata-rata (p − y)².
 * @returns {null | { n: number, ece: number|null, brier: number|null,
 *   bins: { lo: number, hi: number, n: number, predicted: number|null, observed: number|null }[] }}
 */
export function reliabilityReport(table, testSamples) {
  if (!usable(table)) return null;
  const rows = table.bins.map((b) => ({ lo: b.lo, hi: b.hi, n: 0, sumP: 0, wins: 0 }));
  const pairs = [];
  for (const s of cleanSamples(testSamples)) {
    const idx = findBin(table.bins, s.score);
    const p = table.bins[idx].probability;
    rows[idx].n += 1;
    rows[idx].sumP += p;
    rows[idx].wins += s.win;
    pairs.push({ p, y: s.win });
  }
  const n = pairs.length;
  const ece = n === 0 ? null : rows.reduce((a, r) => (r.n === 0 ? a : a + (r.n / n) * Math.abs(r.sumP / r.n - r.wins / r.n)), 0);
  return {
    n,
    ece,
    brier: brierScore(pairs),
    bins: rows.map((r) => ({
      lo: r.lo, hi: r.hi, n: r.n, predicted: r.n ? r.sumP / r.n : null, observed: r.n ? r.wins / r.n : null,
    })),
  };
}
