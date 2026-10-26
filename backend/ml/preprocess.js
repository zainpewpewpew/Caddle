// Praproses fitur yang DIPELAJARI HANYA dari data train: imputasi median untuk NaN dan standardisasi (mean/sd).
// Statistik dari seluruh data (termasuk test) adalah kebocoran klasik; fungsi ini sengaja hanya menerima matriks train.

const median = (xs) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * @param {number[][]} X baris × fitur (NaN = tidak tersedia)
 * @returns {{ medians: number[], means: number[], sds: number[] }}
 */
export function fitPreprocess(X) {
  if (!Array.isArray(X) || X.length === 0) throw new RangeError('Matriks train kosong');
  const p = X[0].length;
  const medians = [];
  const means = [];
  const sds = [];
  for (let j = 0; j < p; j += 1) {
    const col = X.map((row) => row[j]).filter(Number.isFinite);
    const med = median(col);
    const filled = X.map((row) => (Number.isFinite(row[j]) ? row[j] : med));
    const mean = filled.reduce((a, v) => a + v, 0) / filled.length;
    const variance = filled.reduce((a, v) => a + (v - mean) ** 2, 0) / filled.length;
    medians.push(med);
    means.push(mean);
    // Kolom konstan (sd 0) → sd 1 agar nilai terstandar 0, bukan NaN.
    sds.push(variance > 1e-12 ? Math.sqrt(variance) : 1);
  }
  return { medians, means, sds };
}

/** Imputasi median saja (untuk model pohon yang tidak butuh skala). */
export function impute(prep, row) {
  return row.map((v, j) => (Number.isFinite(v) ? v : prep.medians[j]));
}

/** Imputasi lalu standardisasi. */
export function standardize(prep, row) {
  return row.map((v, j) => ((Number.isFinite(v) ? v : prep.medians[j]) - prep.means[j]) / prep.sds[j]);
}
