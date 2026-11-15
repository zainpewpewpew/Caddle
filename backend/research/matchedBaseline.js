// Studi "informasi di luar momentum" (riset saja; tidak dipakai worker/scanner live). Pertanyaan: apakah alert pola live
// (SA/PVA, SD/PVD) membawa informasi tentang gerak berikutnya DI LUAR momentum yang sudah terlihat dari harga? Caranya:
// setiap alert dibandingkan dengan candle tanpa sinyal yang berada di strata sama — simbol, kuartal kalender, gerak awal,
// posisi rentang, dan tersil volatilitas (coarsened exact matching). Desain dikunci sebelum run (docs/25 §1).
//
// Fungsi murni di sini; orkestrasi di scripts/research-matched.js.

import { mulberry32 } from '../backtest/eventStudy.js';

export const DAY_MS = 86_400_000;
export const MATCH_DEFAULTS = Object.freeze({
  look: 12, // jendela gerak awal & breakout berikutnya (candle)
  horizons: Object.freeze([12, 48]), // gerak lanjutan (candle)
  donchians: Object.freeze([24, 48, 96]), // 48 = utama (docs/24); 24 & 96 = sensitivitas
  exclusion: 12, // kandidat pembanding minimal 13 candle dari alert v2/v3 mana pun (arah sama)
  preBinAtr: 0.5, preMinAtr: -4, preMaxAtr: 6, // bin gerak awal 0,5 ATR; ujung digabung
  posBins: 5, // bin posisi rentang 0,2
  volBins: 3, // tersil ATR% per simbol × kuartal
});

/** Periode strata: kuartal kalender UTC, mis. '2025-Q3'. */
export function quarterOf(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

function signOf(direction) {
  if (direction === 'LONG') return 1;
  if (direction === 'SHORT') return -1;
  throw new RangeError("direction harus 'LONG' atau 'SHORT'");
}

/** Gerak lanjutan searah sinyal dalam ATR: arah × (close[i+h] − close[i]) / ATR[i]; null bila data kurang. */
export function forwardMove(candles, atrValues, direction, i, h) {
  const sign = signOf(direction);
  const a = atrValues[i];
  if (!(a > 0) || i < 0 || i + h >= candles.length) return null;
  return (sign * (candles[i + h].close - candles[i].close)) / a;
}

/** 1 bila ada breakout (flags dari breakoutFlags) di (i, i + look], selain itu 0. */
export function breakoutWithin(flags, i, look = MATCH_DEFAULTS.look) {
  for (let j = i + 1; j <= i + look; j += 1) if (flags[j]) return 1;
  return 0;
}

/** Bin gerak awal (ATR), dengan ujung bawah/atas digabung. */
export function preBin(pre, { preBinAtr = MATCH_DEFAULTS.preBinAtr, preMinAtr = MATCH_DEFAULTS.preMinAtr, preMaxAtr = MATCH_DEFAULTS.preMaxAtr } = {}) {
  const lo = Math.floor(preMinAtr / preBinAtr);
  const hi = Math.floor(preMaxAtr / preBinAtr);
  return Math.min(hi, Math.max(lo, Math.floor(pre / preBinAtr)));
}

/** Bin posisi rentang 0..posBins−1 (pos 1 masuk bin teratas). */
export function posBin(pos, posBins = MATCH_DEFAULTS.posBins) {
  return Math.min(posBins - 1, Math.max(0, Math.floor(pos * posBins)));
}

/** Batas tersil (atau kuantil `bins`) dari daftar nilai; dipakai per simbol × kuartal. */
export function quantileCuts(values, bins = MATCH_DEFAULTS.volBins) {
  const s = Float64Array.from(values).sort();
  if (!s.length) return [];
  return Array.from({ length: bins - 1 }, (_, k) => s[Math.min(s.length - 1, Math.floor(((k + 1) / bins) * s.length))]);
}

export function binOf(value, cuts) {
  let b = 0;
  while (b < cuts.length && value >= cuts[b]) b += 1;
  return b;
}

/** Kunci strata pencocokan. */
export function stratumKey({ symbol, period, pre, pos, volBin }, opts = {}) {
  return `${symbol}|${period}|${preBin(pre, opts)}|${posBin(pos, opts.posBins)}|${volBin}`;
}

/**
 * Cocokkan alert ke rata-rata pembanding di strata yang sama.
 * @param {{ key: string, y: Record<string, number> }[]} alerts
 * @param {Map<string, { n: number, sums: Record<string, number> }>} controls agregat per strata
 * @returns {{ matched: object[], unmatched: number }} matched: { ...alert, nCtrl, ctrl: {o: mean}, diff: {o: y − mean} }
 */
export function matchAlerts(alerts, controls) {
  const matched = [];
  let unmatched = 0;
  for (const a of alerts) {
    const c = controls.get(a.key);
    if (!c || c.n < 1) {
      unmatched += 1;
      continue;
    }
    const ctrl = {};
    const diff = {};
    for (const [o, v] of Object.entries(a.y)) {
      ctrl[o] = c.sums[o] / c.n;
      diff[o] = v - ctrl[o];
    }
    matched.push({ ...a, nCtrl: c.n, ctrl, diff });
  }
  return { matched, unmatched };
}

/** Tambahkan satu candle pembanding ke agregat strata. */
export function addControl(controls, key, y) {
  let c = controls.get(key);
  if (!c) {
    c = { n: 0, sums: Object.fromEntries(Object.keys(y).map((o) => [o, 0])) };
    controls.set(key, c);
  }
  c.n += 1;
  for (const [o, v] of Object.entries(y)) c.sums[o] += v;
}

const quantileOfSorted = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];

/**
 * CI rata-rata lewat moving-block bootstrap atas waktu kalender: hari dari pertama s/d terakhir (termasuk hari kosong)
 * dipotong menjadi blok `blockDays` hari berurutan yang disampling ulang dengan pengembalian; semua simbol pada hari yang
 * sama selalu ikut dalam blok yang sama. blockDays = 1 ≈ bootstrap berklaster harian.
 * @returns {{ mean: number, lo: number, hi: number, days: number, blockDays: number, reps: number } | null}
 */
export function movingBlockBootstrapMean(events, {
  value = (e) => e.value, time = (e) => e.t, blockDays = 7, reps = 2000, seed = 7, alpha = 0.05,
} = {}) {
  if (!events.length) return null;
  let d0 = Infinity;
  let d1 = -Infinity;
  const days = events.map((e) => {
    const d = Math.floor(time(e) / DAY_MS);
    if (d < d0) d0 = d;
    if (d > d1) d1 = d;
    return d;
  });
  const D = d1 - d0 + 1;
  const ps = new Float64Array(D + 1);
  const pc = new Float64Array(D + 1);
  const sums = new Float64Array(D);
  const counts = new Float64Array(D);
  events.forEach((e, k) => {
    sums[days[k] - d0] += value(e);
    counts[days[k] - d0] += 1;
  });
  for (let d = 0; d < D; d += 1) {
    ps[d + 1] = ps[d] + sums[d];
    pc[d + 1] = pc[d] + counts[d];
  }
  const L = Math.max(1, Math.min(blockDays, D));
  const nBlocks = Math.ceil(D / L);
  const starts = D - L + 1;
  const rnd = mulberry32(seed);
  const means = [];
  for (let r = 0; r < reps; r += 1) {
    let s = 0;
    let c = 0;
    for (let b = 0; b < nBlocks; b += 1) {
      const st = Math.floor(rnd() * starts);
      s += ps[st + L] - ps[st];
      c += pc[st + L] - pc[st];
    }
    if (c > 0) means.push(s / c);
  }
  means.sort((x, y) => x - y);
  return { mean: ps[D] / pc[D], lo: quantileOfSorted(means, alpha / 2), hi: quantileOfSorted(means, 1 - alpha / 2), days: D, blockDays: L, reps: means.length };
}

/**
 * CI selisih rata-rata A − B dengan moving-block bootstrap pada sumbu hari bersama: blok hari yang sama disampling untuk
 * kedua kelompok (ketergantungan waktu & antarkoin ikut terbawa). Replikasi tanpa event di salah satu kelompok dilewati.
 * @returns {{ diff: number, lo: number, hi: number, blockDays: number, reps: number } | null}
 */
export function movingBlockBootstrapDiff(eventsA, eventsB, {
  value = (e) => e.value, time = (e) => e.t, blockDays = 7, reps = 2000, seed = 11, alpha = 0.05,
} = {}) {
  if (!eventsA.length || !eventsB.length) return null;
  const dayOf = (e) => Math.floor(time(e) / DAY_MS);
  let d0 = Infinity;
  let d1 = -Infinity;
  for (const list of [eventsA, eventsB]) {
    for (const e of list) {
      const d = dayOf(e);
      if (d < d0) d0 = d;
      if (d > d1) d1 = d;
    }
  }
  const D = d1 - d0 + 1;
  const prefix = (events) => {
    const s = new Float64Array(D + 1);
    const c = new Float64Array(D + 1);
    const sums = new Float64Array(D);
    const counts = new Float64Array(D);
    for (const e of events) {
      sums[dayOf(e) - d0] += value(e);
      counts[dayOf(e) - d0] += 1;
    }
    for (let d = 0; d < D; d += 1) {
      s[d + 1] = s[d] + sums[d];
      c[d + 1] = c[d] + counts[d];
    }
    return { s, c };
  };
  const A = prefix(eventsA);
  const B = prefix(eventsB);
  const L = Math.max(1, Math.min(blockDays, D));
  const nBlocks = Math.ceil(D / L);
  const starts = D - L + 1;
  const rnd = mulberry32(seed);
  const diffs = [];
  for (let r = 0; r < reps; r += 1) {
    let sa = 0;
    let ca = 0;
    let sb = 0;
    let cb = 0;
    for (let b = 0; b < nBlocks; b += 1) {
      const st = Math.floor(rnd() * starts);
      sa += A.s[st + L] - A.s[st];
      ca += A.c[st + L] - A.c[st];
      sb += B.s[st + L] - B.s[st];
      cb += B.c[st + L] - B.c[st];
    }
    if (ca > 0 && cb > 0) diffs.push(sa / ca - sb / cb);
  }
  diffs.sort((x, y) => x - y);
  return { diff: A.s[D] / A.c[D] - B.s[D] / B.c[D], lo: quantileOfSorted(diffs, alpha / 2), hi: quantileOfSorted(diffs, 1 - alpha / 2), blockDays: L, reps: diffs.length };
}

/**
 * Aturan "maksimal satu posisi per simbol": trade urut waktu entri; trade baru pada simbol yang posisinya masih terbuka
 * (entri ≤ waktu keluar trade sebelumnya) diabaikan.
 * @param {{ symbol: string, t: number, exitTime: number }[]} trades t = entryTime
 */
export function onePositionPerSymbol(trades) {
  const sorted = [...trades].sort((a, b) => a.t - b.t || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  const busyUntil = new Map();
  const out = [];
  for (const tr of sorted) {
    if (tr.t <= (busyUntil.get(tr.symbol) ?? -Infinity)) continue;
    out.push(tr);
    busyUntil.set(tr.symbol, tr.exitTime);
  }
  return out;
}

/**
 * Ukuran sampel untuk uji satu sisi "rata-rata > 0" (α dua sisi 0,05 → z 1,96; daya 80% → z 0,8416):
 * n = ((zα + zβ) · σ · √deff / δ)². deff = efek desain dari ketergantungan antar-trade (rasio varians bootstrap blok
 * terhadap varians naif).
 */
export function requiredSampleSize({ sd, effect, deff = 1, zAlpha = 1.959964, zBeta = 0.841621 }) {
  if (!(sd > 0) || !(effect > 0) || !(deff > 0)) return null;
  return Math.ceil(((zAlpha + zBeta) * sd * Math.sqrt(deff) / effect) ** 2);
}
