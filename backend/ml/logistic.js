// Regresi logistik dengan regularisasi L2 (ridge), dilatih metode Newton/IRLS. Fungsi murni & deterministik.
// Dipilih sebagai model meta-labeling pertama karena: sedikit parameter (≈ jumlah fitur), konveks (satu solusi,
// tanpa benih acak), cepat (< 1 detik untuk puluhan ribu baris), dan koefisiennya dapat dijelaskan.
import { fitPreprocess, standardize } from './preprocess.js';

const sigmoid = (z) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/** Selesaikan A·x = b (A simetris positif definit kecil) dengan eliminasi Gauss + pivot parsial. */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const diag = M[col][col];
    if (Math.abs(diag) < 1e-12) continue;
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const f = M[r][col] / diag;
      if (f === 0) continue;
      for (let k = col; k <= n; k += 1) M[r][k] -= f * M[col][k];
    }
  }
  return M.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[n] / row[i]));
}

/**
 * @param {number[][]} X baris × fitur (NaN boleh; diimputasi median train)
 * @param {(0|1)[]} y
 * @param {{ l2?: number, iterations?: number, tolerance?: number }} [options]
 *   l2 = kekuatan penalti pada bobot terstandar (intersep tidak dipenalti).
 * @returns {{ type: 'logistic', prep: object, bias: number, weights: number[], iterations: number }}
 */
export function fitLogistic(X, y, { l2 = 1, iterations = 25, tolerance = 1e-8 } = {}) {
  if (!Array.isArray(X) || X.length === 0 || X.length !== y?.length) throw new RangeError('X dan y wajib tidak kosong dan sama panjang');
  if (!(l2 >= 0)) throw new RangeError('l2 harus ≥ 0');
  const prep = fitPreprocess(X);
  const Z = X.map((row) => [1, ...standardize(prep, row)]);
  const p = Z[0].length;
  let beta = new Array(p).fill(0);
  let iter = 0;
  for (; iter < iterations; iter += 1) {
    const grad = new Array(p).fill(0);
    const H = Array.from({ length: p }, () => new Array(p).fill(0));
    for (let i = 0; i < Z.length; i += 1) {
      const z = Z[i];
      let eta = 0;
      for (let j = 0; j < p; j += 1) eta += beta[j] * z[j];
      const mu = sigmoid(eta);
      const w = Math.max(mu * (1 - mu), 1e-9);
      const r = y[i] - mu;
      for (let j = 0; j < p; j += 1) {
        grad[j] += r * z[j];
        const wz = w * z[j];
        for (let k = j; k < p; k += 1) H[j][k] += wz * z[k];
      }
    }
    for (let j = 0; j < p; j += 1) {
      for (let k = 0; k < j; k += 1) H[j][k] = H[k][j];
      if (j > 0) {
        grad[j] -= l2 * beta[j];
        H[j][j] += l2;
      }
    }
    const step = solve(H, grad);
    beta = beta.map((b, j) => b + step[j]);
    if (Math.max(...step.map(Math.abs)) < tolerance) {
      iter += 1;
      break;
    }
  }
  return { type: 'logistic', prep, bias: beta[0], weights: beta.slice(1), iterations: iter };
}

/** Peluang WIN untuk satu baris fitur. */
export function predictLogistic(model, row) {
  const z = standardize(model.prep, row);
  let eta = model.bias;
  for (let j = 0; j < z.length; j += 1) eta += model.weights[j] * z[j];
  return sigmoid(eta);
}
