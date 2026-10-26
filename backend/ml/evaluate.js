// Evaluasi meta-labeling walk-forward (López de Prado 2018, bab 3.6 & 7): model sekunder memprediksi peluang
// sinyal scanner (model primer = aturan pola + konfluensi) berakhir UNTUNG NETO (rMultiple > 0 setelah fee &
// slippage, label meta-labeling standar), dari fitur yang tersedia saat entri. Label "WIN (TP tersentuh)" sengaja
// TIDAK dipakai: pada random walk murni, peluang WIN dapat diprediksi secara mekanis (stop sempit relatif ATR lebih
// cepat menyentuh TP maupun SL) tanpa edge apa pun — model tampak "pintar" padahal expectancy-nya memburuk.
// Karena itu adopsi juga mensyaratkan bukti EKONOMI: seleksi model harus menaikkan expectancy R secara signifikan.
// Pertanyaannya BUKAN "apakah ML bisa menebak arah pasar", melainkan "apakah ML memberi peluang yang lebih
// terkalibrasi/lebih tajam daripada kalibrasi isotonik skor konfluensi yang sudah ada".
//
// Protokol (tanpa lookahead):
// - Trade diurutkan menurut waktu entri. Walk-forward anchored: `folds` jendela uji berurutan menutup bagian
//   akhir (1 − minTrainFraction) rentang waktu; train fold k = semua trade dengan entri < awal uji − embargo DAN
//   exitTime < awal uji (purging: label train tidak boleh melihat periode uji).
// - Praproses (median, mean/sd), ambang histogram, tabel isotonik, dan ambang seleksi dipelajari HANYA dari train.
// - Hyperparameter TETAP (tidak di-tuning pada data ini) agar tidak ada "garden of forking paths"; hanya dua kandidat.
// - Kontrol label diacak (train y dipermutasi): bila model kontrol tampak punya skill di data uji, ada bug/kebocoran
//   pada pipeline evaluasi → seluruh hasil dinyatakan tidak sah.
// - Keputusan "layak dipakai" konservatif (lihat ML_ADOPTION_RULES): kualitas peluang (log-loss) DAN ekonomi
//   (expectancy seleksi > semua sinyal, > seleksi isotonik, dan > 0 dengan interval bootstrap per hari). Bila gagal,
//   scanner tetap memakai kalibrasi skor.
import { applyCalibration, fitCalibration } from '../backtest/calibration.js';
import { summarize } from '../backtest/metrics.js';
import { fitGbdt, predictGbdt } from './gbdt.js';
import { fitLogistic, predictLogistic } from './logistic.js';
import { META_FEATURE_NAMES, META_FEATURES_VERSION } from './metaFeatures.js';
import { auc, blockBootstrap, blockBootstrapMean, brierScore, logLoss, mulberry32 } from './metrics.js';

export const ML_EVAL_VERSION = 1;
export const ML_EVAL_DEFAULTS = Object.freeze({ folds: 5, minTrainFraction: 0.4, embargoMs: 0, selectFraction: 0.3, seed: 7, resamples: 1000 });
/** Aturan adopsi (semua wajib terpenuhi). */
export const ML_ADOPTION_RULES = Object.freeze({
  minTestSamples: 500,
  minTrainSamples: 200,
  /** Fraksi fold minimum di mana model mengalahkan kalibrasi isotonik pada log-loss. */
  minFoldWinFraction: 0.6,
  /** Skill log-loss kontrol acak (vs base rate) di atas ini = pipeline dicurigai bocor. */
  maxControlSkill: 0.01,
});
export const ML_MODELS = Object.freeze(['base', 'isotonic', 'logistic', 'gbdt']);
const CANDIDATES = Object.freeze(['logistic', 'gbdt']);
const DAY_MS = 86_400_000;

const FIT = {
  logistic: (X, y) => {
    const m = fitLogistic(X, y, { l2: 5 });
    return (row) => predictLogistic(m, row);
  },
  gbdt: (X, y) => {
    const m = fitGbdt(X, y);
    return (row) => predictGbdt(m, row);
  },
};

const toSample = (t) => ({
  entryTime: t.entryTime, exitTime: t.exitTime, y: t.rMultiple > 0 ? 1 : 0, score: t.score,
  rMultiple: t.rMultiple, outcome: t.outcome, x: t.ml,
});

function shuffled(ys, seed) {
  const out = [...ys];
  const rand = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Fungsi prediksi kalibrasi isotonik skor; fallback base rate bila tabel belum layak (< 100 sampel). */
function isotonicPredictor(train, baseRate) {
  const table = fitCalibration(train.filter((s) => Number.isFinite(s.score)).map((s) => ({ score: s.score, win: s.y })));
  return (s) => applyCalibration(table, s.score)?.probability ?? baseRate;
}

function quantile(values, q) {
  if (values.length === 0) return Infinity;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))];
}

function scoreModel(pairs, baseLogLoss) {
  const ll = logLoss(pairs);
  return {
    n: pairs.length,
    logLoss: ll,
    brier: brierScore(pairs),
    auc: auc(pairs),
    /** Skill log-loss vs base rate: 1 − LL/LL_base (> 0 = lebih baik dari menebak base rate). */
    skill: ll === null || !baseLogLoss ? null : 1 - ll / baseLogLoss,
  };
}

const tradeLike = (s) => ({ outcome: s.outcome, rMultiple: s.rMultiple, exitTime: s.exitTime });

/**
 * @param {object[]} trades trade runner (outcome, entryTime, exitTime, rMultiple, score, ml: number[])
 * @param {Partial<typeof ML_EVAL_DEFAULTS>} [options]
 * @returns {object} lihat docs/16-riset-machine-learning.md §8 untuk cara membaca
 */
export function evaluateMetaModels(trades, options = {}) {
  const o = { ...ML_EVAL_DEFAULTS, ...options };
  const samples = (trades ?? [])
    .filter((t) => t && t.outcome !== 'OPEN' && Array.isArray(t.ml) && t.ml.length === META_FEATURE_NAMES.length
      && Number.isFinite(t.entryTime) && Number.isFinite(t.exitTime) && Number.isFinite(t.rMultiple))
    .map(toSample)
    .sort((a, b) => a.entryTime - b.entryTime);

  const result = {
    version: ML_EVAL_VERSION, featuresVersion: META_FEATURES_VERSION, featureNames: [...META_FEATURE_NAMES],
    options: { folds: o.folds, minTrainFraction: o.minTrainFraction, embargoMs: o.embargoMs, selectFraction: o.selectFraction },
    label: 'rMultiple > 0 (untung neto setelah biaya)', rules: ML_ADOPTION_RULES, samples: samples.length, folds: [], models: {},
    controls: {}, selection: null, comparison: {}, economics: {},
    coefficients: null, verdict: null,
  };
  if (samples.length < ML_ADOPTION_RULES.minTrainSamples) {
    result.verdict = {
      adopted: false, model: null, leakageSuspected: false,
      reasons: [`Sampel trade selesai hanya ${samples.length} (< ${ML_ADOPTION_RULES.minTrainSamples}) — terlalu sedikit untuk melatih & menguji model.`],
    };
    return result;
  }

  const t0 = samples[0].entryTime;
  const t1 = samples[samples.length - 1].entryTime;
  const start = t0 + (t1 - t0) * o.minTrainFraction;
  const span = t1 - start;
  const oos = { base: [], isotonic: [], logistic: [], gbdt: [], logisticShuffled: [], gbdtShuffled: [] };
  const perTrade = [];
  const selected = { isotonic: [], logistic: [], gbdt: [] };
  const allTest = [];
  /** Per trade uji: hari, R neto, dan apakah dipilih tiap model (untuk bootstrap ekonomi). */
  const picks = [];

  for (let k = 0; k < o.folds; k += 1) {
    const testStart = start + (k * span) / o.folds;
    const testEnd = k === o.folds - 1 ? Infinity : start + ((k + 1) * span) / o.folds;
    const train = samples.filter((s) => s.entryTime < testStart - o.embargoMs && s.exitTime < testStart);
    const test = samples.filter((s) => s.entryTime >= testStart && s.entryTime < testEnd);
    if (train.length < ML_ADOPTION_RULES.minTrainSamples || test.length === 0) continue;

    const ys = train.map((s) => s.y);
    const X = train.map((s) => s.x);
    const baseRate = ys.reduce((a, v) => a + v, 0) / ys.length;
    const predictors = {
      base: () => baseRate,
      isotonic: isotonicPredictor(train, baseRate),
      logistic: ((f) => (s) => f(s.x))(FIT.logistic(X, ys)),
      gbdt: ((f) => (s) => f(s.x))(FIT.gbdt(X, ys)),
      logisticShuffled: ((f) => (s) => f(s.x))(FIT.logistic(X, shuffled(ys, o.seed + k))),
      gbdtShuffled: ((f) => (s) => f(s.x))(FIT.gbdt(X, shuffled(ys, o.seed + 100 + k))),
    };
    const foldRow = { fold: k, testStart, testEnd: Number.isFinite(testEnd) ? testEnd : t1, train: train.length, test: test.length, baseRate, logLoss: {} };
    for (const [name, predict] of Object.entries(predictors)) {
      const pairs = test.map((s) => ({ p: predict(s), y: s.y }));
      oos[name].push(...pairs);
      if (ML_MODELS.includes(name)) foldRow.logLoss[name] = logLoss(pairs);
    }
    for (const s of test) {
      perTrade.push({ day: Math.floor(s.entryTime / DAY_MS), s, p: Object.fromEntries(['isotonic', ...CANDIDATES].map((m) => [m, predictors[m](s)])) });
      allTest.push(s);
    }
    // Seleksi: ambang = kuantil (1 − selectFraction) prediksi model pada TRAIN, diterapkan ke uji.
    const thresholds = {};
    for (const name of Object.keys(selected)) {
      thresholds[name] = quantile(train.map((s) => predictors[name](s)), 1 - o.selectFraction);
      selected[name].push(...test.filter((s) => predictors[name](s) >= thresholds[name]));
    }
    for (const s of test) {
      picks.push({
        day: Math.floor(s.entryTime / DAY_MS), r: s.rMultiple,
        ...Object.fromEntries(Object.keys(selected).map((name) => [name, predictors[name](s) >= thresholds[name]])),
      });
    }
    result.folds.push(foldRow);
  }

  if (result.folds.length === 0) {
    result.verdict = { adopted: false, model: null, leakageSuspected: false, reasons: ['Tidak ada fold dengan data train ≥ 200 trade — perpanjang rentang data.'] };
    return result;
  }

  const baseLL = logLoss(oos.base);
  for (const name of ML_MODELS) result.models[name] = scoreModel(oos[name], baseLL);
  result.controls = { logisticShuffled: scoreModel(oos.logisticShuffled, baseLL), gbdtShuffled: scoreModel(oos.gbdtShuffled, baseLL) };
  result.selection = {
    fraction: o.selectFraction,
    all: summarize(allTest.map(tradeLike)),
    ...Object.fromEntries(Object.entries(selected).map(([name, list]) => [name, summarize(list.map(tradeLike))])),
  };
  const llOne = (p, y) => logLoss([{ p, y }]);
  for (const name of CANDIDATES) {
    result.comparison[name] = blockBootstrapMean(
      perTrade.map(({ day, s, p }) => ({ day, diff: llOne(p.isotonic, s.y) - llOne(p[name], s.y) })),
      { resamples: o.resamples, seed: o.seed },
    );
  }
  const meanR = (xs) => (xs.length ? xs.reduce((a, x) => a + x.r, 0) / xs.length : null);
  const boot = (stat, salt) => blockBootstrap(picks, stat, { resamples: o.resamples, seed: o.seed + salt });
  for (const [k, name] of Object.keys(selected).entries()) {
    const sel = (xs) => xs.filter((x) => x[name]);
    result.economics[name] = {
      /** Expectancy R seleksi model pada data uji. */
      selected: boot((xs) => meanR(sel(xs)), 10 + k),
      /** Expectancy seleksi − expectancy semua sinyal uji (lift). */
      lift: boot((xs) => {
        const a = meanR(sel(xs));
        const b = meanR(xs);
        return a === null || b === null ? null : a - b;
      }, 20 + k),
      /** Expectancy seleksi model − expectancy seleksi isotonik. */
      vsIsotonic: name === 'isotonic' ? null : boot((xs) => {
        const a = meanR(sel(xs));
        const b = meanR(xs.filter((x) => x.isotonic));
        return a === null || b === null ? null : a - b;
      }, 30 + k),
    };
  }
  // Koefisien logistik terstandar dari model yang dilatih pada SELURUH trade (hanya untuk penjelasan, bukan evaluasi).
  const full = fitLogistic(samples.map((s) => s.x), samples.map((s) => s.y), { l2: 5 });
  result.coefficients = META_FEATURE_NAMES.map((name, j) => ({ name, weight: full.weights[j] }))
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  result.verdict = decide(result);
  return result;
}

function decide(result) {
  const r = ML_ADOPTION_RULES;
  const reasons = [];
  const controlSkill = Math.max(result.controls.logisticShuffled.skill ?? 0, result.controls.gbdtShuffled.skill ?? 0);
  // Dengan sampel uji kecil, skill kontrol acak berfluktuasi besar karena kebetulan — hanya dinilai bila n uji memadai.
  const leakageSuspected = result.models.base.n >= r.minTestSamples && controlSkill > r.maxControlSkill;
  if (leakageSuspected) {
    reasons.push(`Kontrol label acak memiliki skill ${(controlSkill * 100).toFixed(1)}% (> ${r.maxControlSkill * 100}%) — `
      + 'pipeline evaluasi dicurigai bocor; seluruh hasil ML tidak sah.');
  }
  const iso = result.models.isotonic;
  const testN = result.models.base.n;
  if (testN < r.minTestSamples) reasons.push(`Sampel uji ${testN} < ${r.minTestSamples} — terlalu sedikit untuk mendeteksi selisih beberapa poin persen.`);

  let chosen = null;
  for (const name of CANDIDATES) {
    const m = result.models[name];
    const foldWins = result.folds.filter((f) => f.logLoss[name] < f.logLoss.isotonic).length;
    const needed = Math.ceil(r.minFoldWinFraction * result.folds.length);
    const boot = result.comparison[name];
    const fails = [];
    if (!(m.logLoss < iso.logLoss)) fails.push('log-loss tidak lebih baik dari kalibrasi isotonik');
    if (!(m.skill > 0)) fails.push('tidak lebih baik dari menebak base rate');
    if (foldWins < needed) fails.push(`menang hanya di ${foldWins}/${result.folds.length} fold (butuh ≥ ${needed})`);
    if (!boot || !(boot.lower > 0)) fails.push('interval bootstrap 95% perbaikan log-loss mencakup 0 (tidak signifikan)');
    const eco = result.economics[name];
    if (!eco?.lift || !(eco.lift.lower > 0)) fails.push('seleksi model tidak menaikkan expectancy R secara signifikan dibanding semua sinyal');
    if (!eco?.vsIsotonic || !(eco.vsIsotonic.mean > 0)) fails.push('expectancy seleksi tidak lebih baik dari seleksi skor konfluensi');
    if (!eco?.selected || !(eco.selected.lower > 0)) fails.push('expectancy seleksi setelah biaya tidak positif secara signifikan');
    if (fails.length) reasons.push(`${name}: ${fails.join('; ')}.`);
    else if (!chosen || m.logLoss < result.models[chosen].logLoss) chosen = name;
  }
  const adopted = !leakageSuspected && testN >= r.minTestSamples && chosen !== null;
  if (adopted) {
    reasons.unshift(`${chosen} lolos semua aturan adopsi: peluang lebih baik dari kalibrasi isotonik dan seleksinya menaikkan `
      + 'expectancy secara signifikan out-of-sample.');
  }
  return { adopted, model: adopted ? chosen : null, leakageSuspected, reasons };
}
