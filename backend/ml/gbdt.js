// Gradient boosting pohon keputusan dangkal (gaya LightGBM/XGBoost: histogram kuantil, daun Newton, L2 pada daun)
// untuk klasifikasi biner log-loss. Fungsi murni & deterministik (tanpa subsampling acak). Implementasi kecil
// sengaja dipilih daripada dependensi native (lihat docs/16-riset-machine-learning.md §6): data meta-labeling
// berukuran ribuan–puluhan ribu baris × ±30 fitur, jauh di bawah kebutuhan LightGBM/ONNX.
//
// Default KONSERVATIF (bukan hasil tuning): pohon kedalaman 2, 100 ronde, laju belajar 0.05, minimal 40 sampel per
// daun, λ = 5. Model yang lebih dalam/lebih lama mudah menghafal noise pada data harga intraday.
import { fitPreprocess, impute } from './preprocess.js';

export const GBDT_DEFAULTS = Object.freeze({ rounds: 100, depth: 2, learningRate: 0.05, minLeaf: 40, lambda: 5, maxBins: 32 });

const sigmoid = (z) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/** Ambang kuantil unik per kolom (maks maxBins − 1); nilai ≤ thresholds[b] masuk bin b. */
function quantileThresholds(values, maxBins) {
  const s = [...values].sort((a, b) => a - b);
  const out = [];
  for (let b = 1; b < maxBins; b += 1) {
    const v = s[Math.min(s.length - 1, Math.floor((b * s.length) / maxBins))];
    if (out.length === 0 || v > out[out.length - 1]) out.push(v);
  }
  // Ambang terakhir = maksimum tidak berguna sebagai pemisah (semua baris ke kiri).
  if (out.length && out[out.length - 1] >= s[s.length - 1]) out.pop();
  return out;
}

function binIndex(thresholds, v) {
  let lo = 0;
  let hi = thresholds.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (v <= thresholds[mid]) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function buildNode(rows, depth, ctx) {
  let G = 0;
  let H = 0;
  for (const i of rows) {
    G += ctx.g[i];
    H += ctx.h[i];
  }
  const leaf = { leaf: (-G / (H + ctx.lambda)) * ctx.learningRate };
  if (depth >= ctx.depth || rows.length < 2 * ctx.minLeaf) return leaf;

  const parentScore = (G * G) / (H + ctx.lambda);
  let best = null;
  for (let j = 0; j < ctx.thresholds.length; j += 1) {
    const T = ctx.thresholds[j].length;
    if (T === 0) continue;
    const hg = new Float64Array(T + 1);
    const hh = new Float64Array(T + 1);
    const hc = new Int32Array(T + 1);
    for (const i of rows) {
      const b = ctx.bins[i][j];
      hg[b] += ctx.g[i];
      hh[b] += ctx.h[i];
      hc[b] += 1;
    }
    let GL = 0;
    let HL = 0;
    let CL = 0;
    for (let b = 0; b < T; b += 1) {
      GL += hg[b];
      HL += hh[b];
      CL += hc[b];
      const CR = rows.length - CL;
      if (CL < ctx.minLeaf) continue;
      if (CR < ctx.minLeaf) break;
      const GR = G - GL;
      const HR = H - HL;
      const gain = (GL * GL) / (HL + ctx.lambda) + (GR * GR) / (HR + ctx.lambda) - parentScore;
      if (gain > 1e-12 && (best === null || gain > best.gain)) best = { gain, feature: j, bin: b };
    }
  }
  if (best === null) return leaf;
  const left = [];
  const right = [];
  for (const i of rows) (ctx.bins[i][best.feature] <= best.bin ? left : right).push(i);
  return {
    feature: best.feature,
    threshold: ctx.thresholds[best.feature][best.bin],
    left: buildNode(left, depth + 1, ctx),
    right: buildNode(right, depth + 1, ctx),
  };
}

function treeValue(node, row) {
  let n = node;
  while (n.leaf === undefined) n = row[n.feature] <= n.threshold ? n.left : n.right;
  return n.leaf;
}

/**
 * @param {number[][]} X baris × fitur (NaN diimputasi median train)
 * @param {(0|1)[]} y
 * @param {Partial<typeof GBDT_DEFAULTS>} [options]
 * @returns {{ type: 'gbdt', prep: object, base: number, trees: object[] }}
 */
export function fitGbdt(X, y, options = {}) {
  if (!Array.isArray(X) || X.length === 0 || X.length !== y?.length) throw new RangeError('X dan y wajib tidak kosong dan sama panjang');
  const o = { ...GBDT_DEFAULTS, ...options };
  if (!Number.isInteger(o.rounds) || o.rounds < 0 || !Number.isInteger(o.depth) || o.depth < 1) throw new RangeError('rounds/depth tidak valid');
  const prep = fitPreprocess(X);
  const rowsX = X.map((row) => impute(prep, row));
  const p = rowsX[0].length;
  const thresholds = Array.from({ length: p }, (_, j) => quantileThresholds(rowsX.map((r) => r[j]), o.maxBins));
  const bins = rowsX.map((r) => r.map((v, j) => binIndex(thresholds[j], v)));

  const n = rowsX.length;
  const rate = Math.min(1 - 1e-6, Math.max(1e-6, y.reduce((a, v) => a + v, 0) / n));
  const base = Math.log(rate / (1 - rate));
  const F = new Float64Array(n).fill(base);
  const g = new Float64Array(n);
  const h = new Float64Array(n);
  const all = Array.from({ length: n }, (_, i) => i);
  const trees = [];
  for (let t = 0; t < o.rounds; t += 1) {
    for (let i = 0; i < n; i += 1) {
      const q = sigmoid(F[i]);
      g[i] = q - y[i];
      h[i] = Math.max(q * (1 - q), 1e-9);
    }
    const tree = buildNode(all, 0, { ...o, g, h, bins, thresholds });
    trees.push(tree);
    for (let i = 0; i < n; i += 1) F[i] += treeValue(tree, rowsX[i]);
  }
  return { type: 'gbdt', prep, base, trees };
}

/** Peluang WIN untuk satu baris fitur. */
export function predictGbdt(model, row) {
  const x = impute(model.prep, row);
  let z = model.base;
  for (const tree of model.trees) z += treeValue(tree, x);
  return sigmoid(z);
}
