// Studi kejadian (event study) untuk riset formulasi: barrier tiga sisi per sinyal dengan entri di open candle
// berikutnya, biaya & funding dalam satuan R, baseline, dan interval kepercayaan bootstrap BERKLASTER PER HARI
// (hari UTC disampling ulang utuh, sehingga sinyal yang berkorelasi pada hari yang sama tidak dihitung sebagai
// pengamatan independen). Fungsi murni & deterministik: PRNG berbenih 32-bit (mulberry32, tanpa kehilangan presisi).
// Dipakai skrip riset (scripts/research-bsv-1h.js) dan BUKAN oleh scanner live. Skor/hasil di sini adalah hasil uji
// historis, bukan probabilitas atau janji kinerja.

export const DAY_MS = 86_400_000;

/** PRNG 32-bit deterministik (mulberry32). @param {number} seed @returns {() => number} [0, 1) */
export function mulberry32(seed) {
  let a = seed | 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Interval Wilson untuk proporsi k/n. @returns {[number, number] | [null, null]} */
export function wilsonInterval(k, n, z = 1.96) {
  if (!(n > 0)) return [null, null];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [c - h, c + h];
}

/** Indeks pertama di `sorted` dengan nilai ≥ x (pencarian biner). */
function lowerBound(sorted, x) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Biaya funding posisi LONG dalam R: Σ fundingRate × harga open candle saat funding / stopDistance, untuk setiap funding
 * dengan fundingTime di [openTime candle entri, akhir candle keluar). Funding tepat di jam entri dan di candle keluar
 * ikut dihitung (konservatif saat funding positif = long membayar). Hasil positif = biaya.
 * @param {Array<{ openTime: number, open: number }>} candles
 * @param {{ times: number[], rates: number[] }} funding fundingTime terurut naik dan rate pasangannya
 */
export function longFundingR(candles, entryIndex, exitIndex, stopDistance, funding, intervalMs) {
  const start = candles[entryIndex].openTime;
  const endExclusive = candles[exitIndex].openTime + intervalMs;
  let sum = 0;
  for (let k = lowerBound(funding.times, start); k < funding.times.length && funding.times[k] < endExclusive; k += 1) {
    const idx = entryIndex + Math.floor((funding.times[k] - start) / intervalMs);
    const c = candles[idx];
    const price = idx <= exitIndex && c && c.openTime <= funding.times[k] && funding.times[k] < c.openTime + intervalMs
      ? c.open : candles[entryIndex].open;
    sum += funding.rates[k] * price;
  }
  return sum / stopDistance;
}

/**
 * Barrier tiga sisi posisi LONG untuk sinyal pada close candle i.
 * - Entri = open candle i+1; stop = entri − stopDistance; target = entri + targetR × stopDistance.
 * - Candle j = i+1..i+maxBars: low ≤ stop → STOP (−1R) DIPERIKSA DULU (konservatif bila stop & target tersentuh pada
 *   candle yang sama), lalu high ≥ target → TARGET (+targetR); tanpa sentuhan → TIME: (close[i+maxBars] − entri) / stopDistance.
 * - Biaya = costRoundTrip × entri / stopDistance (fee + slippage dua sisi sebagai proporsi harga).
 * - Funding opsional (longFundingR). netR = grossR − costR − fundingR.
 * @param {Array<{ openTime: number, open: number, high: number, low: number, close: number }>} candles
 * @param {number} i indeks candle sinyal
 * @param {{ stopDistance: number, targetR?: number, maxBars?: number, costRoundTrip?: number,
 *   funding?: { times: number[], rates: number[] } | null, intervalMs?: number }} options
 * @returns {null | { outcome: 'STOP'|'TARGET'|'TIME', grossR: number, costR: number, fundingR: number, netR: number,
 *   entryIndex: number, exitIndex: number, entryPrice: number, entryTime: number }} null bila data tidak cukup
 */
export function longTripleBarrier(candles, i, {
  stopDistance, targetR = 2, maxBars = 48, costRoundTrip = 0, funding = null, intervalMs = 3_600_000,
} = {}) {
  if (!(stopDistance > 0) || !Number.isInteger(i) || i < 0 || i + maxBars >= candles.length) return null;
  const entryIndex = i + 1;
  const entry = candles[entryIndex].open;
  const stop = entry - stopDistance;
  const target = entry + targetR * stopDistance;
  let outcome = 'TIME';
  let grossR = null;
  let exitIndex = i + maxBars;
  for (let j = entryIndex; j <= i + maxBars; j += 1) {
    if (candles[j].low <= stop) {
      outcome = 'STOP';
      grossR = -1;
      exitIndex = j;
      break;
    }
    if (candles[j].high >= target) {
      outcome = 'TARGET';
      grossR = targetR;
      exitIndex = j;
      break;
    }
  }
  if (grossR === null) grossR = (candles[i + maxBars].close - entry) / stopDistance;
  const costR = (costRoundTrip * entry) / stopDistance;
  const fundingR = funding ? longFundingR(candles, entryIndex, exitIndex, stopDistance, funding, intervalMs) : 0;
  return {
    outcome, grossR, costR, fundingR, netR: grossR - costR - fundingR,
    entryIndex, exitIndex, entryPrice: entry, entryTime: candles[entryIndex].openTime,
  };
}

/** Kelompokkan nilai per hari UTC, urutan hari = urutan kemunculan pertama. */
function groupByDay(events, value, time) {
  const index = new Map();
  const sums = [];
  const counts = [];
  for (const e of events) {
    const day = Math.floor(time(e) / DAY_MS);
    let k = index.get(day);
    if (k === undefined) {
      k = sums.length;
      index.set(day, k);
      sums.push(0);
      counts.push(0);
    }
    sums[k] += value(e);
    counts[k] += 1;
  }
  return { index, sums, counts };
}

const quantileOfSorted = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];

/**
 * CI rata-rata lewat bootstrap berklaster per hari (hari disampling ulang dengan pengembalian, semua sinyal pada hari
 * terpilih ikut). Butuh ≥ 5 hari berbeda.
 * @returns {{ mean: number, lo: number, hi: number, days: number } | null}
 */
export function dayClusterBootstrapMean(events, {
  value = (e) => e.netR, time = (e) => e.t, reps = 2000, seed = 7, alpha = 0.05,
} = {}) {
  if (!events.length) return null;
  const { sums, counts } = groupByDay(events, value, time);
  if (sums.length < 5) return null;
  const rnd = mulberry32(seed);
  const means = new Float64Array(reps);
  for (let r = 0; r < reps; r += 1) {
    let s = 0;
    let n = 0;
    for (let k = 0; k < sums.length; k += 1) {
      const d = Math.floor(rnd() * sums.length);
      s += sums[d];
      n += counts[d];
    }
    means[r] = s / n;
  }
  means.sort();
  const mean = events.reduce((acc, e) => acc + value(e), 0) / events.length;
  return { mean, lo: quantileOfSorted(means, alpha / 2), hi: quantileOfSorted(means, 1 - alpha / 2), days: sums.length };
}

/**
 * Selisih rata-rata A − B (mis. sinyal − baseline) dengan bootstrap berpasangan per hari: hari baseline disampling ulang,
 * sinyal & baseline pada hari terpilih ikut bersama. Replikasi tidak terdefinisi bila tak ada sinyal pada hari terpilih.
 * @returns {{ diff: number, lo: number, median: number, hi: number } | null}
 */
export function pairedDayBootstrapDiff(eventsA, eventsB, {
  value = (e) => e.netR, time = (e) => e.t, reps = 2000, seed = 11, alpha = 0.05,
} = {}) {
  if (!eventsA.length || !eventsB.length) return null;
  const A = groupByDay(eventsA, value, time);
  const B = groupByDay(eventsB, value, time);
  const days = [...B.index.keys()];
  const aIndexOfB = days.map((day) => A.index.get(day) ?? -1);
  const rnd = mulberry32(seed);
  const diffs = [];
  for (let r = 0; r < reps; r += 1) {
    let sa = 0;
    let na = 0;
    let sb = 0;
    let nb = 0;
    for (let k = 0; k < days.length; k += 1) {
      const d = Math.floor(rnd() * days.length);
      const a = aIndexOfB[d];
      if (a >= 0) {
        sa += A.sums[a];
        na += A.counts[a];
      }
      sb += B.sums[d];
      nb += B.counts[d];
    }
    if (na > 0) diffs.push(sa / na - sb / nb);
  }
  if (!diffs.length) return null;
  diffs.sort((x, y) => x - y);
  const meanOf = (events) => events.reduce((acc, e) => acc + value(e), 0) / events.length;
  return {
    diff: meanOf(eventsA) - meanOf(eventsB),
    lo: quantileOfSorted(diffs, alpha / 2), median: quantileOfSorted(diffs, 0.5), hi: quantileOfSorted(diffs, 1 - alpha / 2),
  };
}

/**
 * Ringkasan sekumpulan hasil barrier: jumlah, win rate (Wilson), rata-rata R kotor/biaya/funding/bersih.
 * @param {Array<{ outcome: string, grossR: number, costR: number, fundingR: number, netR: number }>} events
 */
export function summarizeEvents(events) {
  const n = events.length;
  if (!n) return { n: 0 };
  const wins = events.filter((e) => e.outcome === 'TARGET').length;
  const stops = events.filter((e) => e.outcome === 'STOP').length;
  const mean = (k) => events.reduce((acc, e) => acc + e[k], 0) / n;
  return {
    n, winRate: wins / n, winCI: wilsonInterval(wins, n), stopRate: stops / n, timeRate: (n - wins - stops) / n,
    meanGrossR: mean('grossR'), meanCostR: mean('costR'), meanFundingR: mean('fundingR'), meanNetR: mean('netR'),
  };
}
