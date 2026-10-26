// Pembagian data urut waktu untuk validasi out-of-sample (López de Prado, bab 7):
// walk-forward ekspansi (anchored) dengan embargo + purging label yang bocor ke periode uji.
// Semua indeks: train = [0, trainEnd), test = [testStart, testEnd) — batas akhir eksklusif.

export const SPLIT_DEFAULTS = Object.freeze({ folds: 5, minTrainFraction: 0.4, embargoBars: 48, testFraction: 0.3 });

function resolveLength(nOrTimes) {
  if (Array.isArray(nOrTimes)) {
    for (let i = 1; i < nOrTimes.length; i += 1) {
      if (!(nOrTimes[i] >= nOrTimes[i - 1])) throw new RangeError('times harus urut waktu naik');
    }
    return nOrTimes.length;
  }
  if (!Number.isInteger(nOrTimes) || nOrTimes < 0) throw new RangeError('n harus bilangan bulat ≥ 0');
  return nOrTimes;
}

function assertEmbargo(embargoBars) {
  if (!Number.isInteger(embargoBars) || embargoBars < 0) throw new RangeError('embargoBars harus bilangan bulat ≥ 0');
}

/**
 * Walk-forward anchored: data awal minTrainFraction·n selalu training, sisanya dibagi `folds` blok uji
 * berurutan yang menutup [floor(n·minTrainFraction), n). Training fold k = [0, testStart − embargoBars):
 * celah embargo mencegah label training (yang memandang ke depan hingga maxBars) tumpang-tindih dengan uji.
 * Fold dengan training kosong atau blok uji kosong dilewati.
 * @param {number|number[]} nOrTimes  jumlah bar, atau array waktu urut naik
 * @returns {{ fold: number, trainStart: number, trainEnd: number, testStart: number, testEnd: number }[]}
 */
export function walkForwardSplits(nOrTimes, {
  folds = SPLIT_DEFAULTS.folds,
  minTrainFraction = SPLIT_DEFAULTS.minTrainFraction,
  embargoBars = SPLIT_DEFAULTS.embargoBars,
} = {}) {
  const n = resolveLength(nOrTimes);
  if (!Number.isInteger(folds) || folds < 1) throw new RangeError('folds harus bilangan bulat ≥ 1');
  if (!(minTrainFraction > 0 && minTrainFraction < 1)) throw new RangeError('minTrainFraction harus di (0, 1)');
  assertEmbargo(embargoBars);

  const start = Math.floor(n * minTrainFraction);
  const span = n - start;
  const out = [];
  for (let k = 0; k < folds; k += 1) {
    const testStart = start + Math.floor((k * span) / folds);
    const testEnd = start + Math.floor(((k + 1) * span) / folds);
    const trainEnd = testStart - embargoBars;
    if (testEnd <= testStart || trainEnd <= 0) continue;
    out.push({ fold: out.length, trainStart: 0, trainEnd, testStart, testEnd });
  }
  return out;
}

/**
 * Satu pembagian holdout: uji = ceil(n·testFraction) bar terakhir, training berakhir embargoBars sebelumnya.
 * @returns {null | { fold: 0, trainStart: 0, trainEnd: number, testStart: number, testEnd: number }}
 */
export function holdoutSplit(nOrTimes, {
  testFraction = SPLIT_DEFAULTS.testFraction,
  embargoBars = SPLIT_DEFAULTS.embargoBars,
} = {}) {
  const n = resolveLength(nOrTimes);
  if (!(testFraction > 0 && testFraction < 1)) throw new RangeError('testFraction harus di (0, 1)');
  assertEmbargo(embargoBars);
  const testStart = n - Math.ceil(n * testFraction);
  const trainEnd = testStart - embargoBars;
  if (testStart >= n || trainEnd <= 0) return null;
  return { fold: 0, trainStart: 0, trainEnd, testStart, testEnd: n };
}

/**
 * Pisahkan trade (hasil labelTrade: entryIndex, exitIndex) ke training/uji untuk satu split.
 * - train: entryIndex ∈ [trainStart, trainEnd) DAN exitIndex < testStart (purging: label yang
 *   menyentuh periode uji dibuang). Trade OPEN dibuang dari training.
 * - test: entryIndex ∈ [testStart, testEnd).
 * - Trade yang entry di celah embargo [trainEnd, testStart) tidak dipakai.
 * @returns {{ train: object[], test: object[], purged: number }}
 */
export function purgeTrades(trades, split) {
  const { trainStart = 0, trainEnd, testStart, testEnd } = split;
  const train = [];
  const test = [];
  let purged = 0;
  for (const t of trades ?? []) {
    const e = t.entryIndex;
    if (e >= trainStart && e < trainEnd) {
      if (t.outcome !== 'OPEN' && Number.isFinite(t.exitIndex) && t.exitIndex < testStart) train.push(t);
      else purged += 1;
    } else if (e >= testStart && e < testEnd) {
      test.push(t);
    }
  }
  return { train, test, purged };
}
