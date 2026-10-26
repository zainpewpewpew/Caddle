// Fitur per seri untuk Reversal Radar (docs/19 §3.1). Semua fungsi MURNI dan KAUSAL: fitur pada indeks
// evaluasi `last` hanya memakai candle ≤ last; swing hanya dipakai bila confirmedIndex ≤ last (swing fraktal
// 2-2 baru diketahui 2 candle setelah terbentuk — waktu deteksi yang jujur). Tanpa I/O, tanpa Date.now().
//
// Nilai yang tidak dapat dihitung = null (bukan 0 palsu). Ambang berasal dari params (hipotesis awal yang
// wajib divalidasi replay). Detektor (detector.js) merangkai fitur ini menjadi daftar bukti; modul ini
// tidak tahu tahap/skor sehingga dapat dipakai ulang oleh replay & laporan.
//
// Keputusan yang tidak dirinci kontrak (dicatat di komentar fungsi masing-masing): skala ATR evaluasi untuk
// kedalaman LL/retest, syarat "menjauh dulu" pada retest dasar, divergensi RSI diukur pada pasangan swing low
// yang berakhir di dasar, higher low dibanding swing low sebelumnya SEJAK dasar, langkah tangga diukur antar
// swing sejenis.
import { analyzeMarketStructure } from '../features/marketStructure.js';
import { analyzeOrderFlow } from '../features/orderFlow.js';
import { analyzeRegime } from '../features/regime.js';
import { atr, confirmedAt, ema, findSwings, normalizedSlope, rsi, rvol, trailingHigherLows } from '../indicators/index.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const positive = (v) => (isNum(v) && v > 0 ? v : null);

/** Rata-rata; null bila kosong atau ada nilai non-hingga. */
export function meanOf(values) {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) {
    if (!isNum(v)) return null;
    sum += v;
  }
  return sum / values.length;
}

/** Median; null bila kosong atau ada nilai non-hingga. */
export function medianOf(values) {
  if (values.length === 0 || !values.every(isNum)) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Fit kuadrat kuadrat-terkecil y = a·x² + b·x + c atas x = 0..n−1 (x dipusatkan secara internal agar stabil
 * numerik, koefisien dikembalikan dalam sumbu x asli). r2 = 1 − SSres/SStot (1 bila SStot = 0 dan SSres = 0).
 * vertexIndex = −b/(2a) (indeks pecahan, boleh di luar jendela); vertexValue = nilai kurva di vertex.
 * @param {number[]} values
 * @returns {{ a: number, b: number, c: number, r2: number, vertexIndex: number|null, vertexValue: number|null }|null}
 *   null bila kurang dari 3 titik, ada nilai non-hingga, atau sistem singular
 */
export function quadraticFit(values) {
  const n = values.length;
  if (n < 3 || !values.every(isNum)) return null;
  const m = (n - 1) / 2;
  let s2 = 0;
  let s4 = 0;
  let t0 = 0;
  let t1 = 0;
  let t2 = 0;
  for (let i = 0; i < n; i += 1) {
    const x = i - m;
    const x2 = x * x;
    s2 += x2;
    s4 += x2 * x2;
    t0 += values[i];
    t1 += x * values[i];
    t2 += x2 * values[i];
  }
  const det = s4 * n - s2 * s2;
  if (!(det > 0) || !(s2 > 0)) return null;
  const a = (t2 * n - s2 * t0) / det;
  const cC = (s4 * t0 - s2 * t2) / det;
  const bC = t1 / s2;
  // Kembali ke sumbu x asli: y = a(x−m)² + bC(x−m) + cC.
  const b = bC - 2 * a * m;
  const c = a * m * m - bC * m + cC;
  const mean = t0 / n;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i += 1) {
    const fit = a * i * i + b * i + c;
    ssRes += (values[i] - fit) ** 2;
    ssTot += (values[i] - mean) ** 2;
  }
  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : (ssRes === 0 ? 1 : 0);
  const vertexIndex = a !== 0 ? -b / (2 * a) : null;
  const vertexValue = vertexIndex === null ? null : a * vertexIndex * vertexIndex + b * vertexIndex + c;
  return { a, b, c, r2, vertexIndex, vertexValue };
}

/**
 * Slope regresi linear y terhadap x untuk titik {x, y} (satuan y per satuan x). null bila < 2 titik atau x seragam.
 * @param {Array<{x:number, y:number}>} points
 */
export function linearSlope(points) {
  const n = points.length;
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  for (const p of points) { sx += p.x; sy += p.y; }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  return sxx > 0 ? sxy / sxx : null;
}

/**
 * Seri indikator yang dihitung SEKALI per evaluasi (EMA cepat/lambat, ATR, RVOL, RSI, slope EMA, swing
 * terkonfirmasi pada candle terakhir). Semua array sepanjang candles; null selama warm-up.
 * @param {object[]} candles candle valid, urut naik (candle terakhir = titik evaluasi)
 * @param {object} p parameter hasil resolveReversalParams
 */
export function computeReversalSeries(candles, p) {
  const last = candles.length - 1;
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const emaFast = ema(closes, p.emaFast);
  const emaSlow = ema(closes, p.emaSlow);
  const swings = confirmedAt(findSwings(candles, { left: p.swingLeft, right: p.swingRight }), last);
  return {
    last,
    closes,
    volumes,
    emaFast,
    emaSlow,
    atr: atr(candles, p.atrPeriod),
    rvol: rvol(volumes, p.rvolPeriod),
    rsi: rsi(closes, p.rsiPeriod),
    emaFastSlope: normalizedSlope(emaFast, p.slopeLookback),
    emaSlowSlope: normalizedSlope(emaSlow, p.slopeLookback),
    highs: swings.highs,
    lows: swings.lows,
  };
}

/** Indeks low terendah pada `lookback` candle terakhir sampai `last` (seri → kemunculan PERTAMA). */
export function findBottomIndex(candles, last, lookback) {
  const from = Math.max(0, last - lookback + 1);
  let idx = from;
  for (let i = from + 1; i <= last; i += 1) if (candles[i].low < candles[idx].low) idx = i;
  return idx;
}

/**
 * Konteks penurunan awal (§3.1 A): close tertinggi pada `declineLookback` candle sebelum/sampai dasar,
 * penurunan dalam fraksi & kelipatan ATR dasar, umur dasar, dan apakah ada close di bawah dasar sesudahnya.
 * ok = (declineAtr ≥ minDeclineAtr ATAU declinePct ≥ minDeclinePct) DAN barsSinceBottom ≥ minBottomAge DAN
 * dasar belum ditembus close. ema25Falling = slope EMA lambat pada candle evaluasi < 0 (null bila belum terhitung).
 */
export function analyzePriorDecline(candles, series, bottomIndex, p) {
  const { last, closes, atr: atrSeries, emaSlowSlope } = series;
  const bottomPrice = candles[bottomIndex].low;
  const from = Math.max(0, bottomIndex - p.declineLookback + 1);
  let highIndex = from;
  for (let i = from + 1; i <= bottomIndex; i += 1) if (closes[i] > closes[highIndex]) highIndex = i;
  const highClose = closes[highIndex];
  const atrAtBottom = positive(atrSeries[bottomIndex]);
  const drop = highClose - bottomPrice;
  const declinePct = highClose > 0 ? drop / highClose : null;
  const declineAtr = atrAtBottom === null ? null : drop / atrAtBottom;
  const barsSinceBottom = last - bottomIndex;
  let brokenBelow = false;
  for (let i = bottomIndex + 1; i <= last; i += 1) if (closes[i] < bottomPrice) brokenBelow = true;
  const slope = emaSlowSlope[last];
  const ema25Falling = isNum(slope) ? slope < 0 : null;
  const deep = (declineAtr !== null && declineAtr >= p.minDeclineAtr) || (declinePct !== null && declinePct >= p.minDeclinePct);
  const ok = deep && barsSinceBottom >= p.minBottomAge && !brokenBelow;
  return { ok, declinePct, declineAtr, highIndex, bottomIndex, bottomPrice, barsSinceBottom, ema25Falling };
}

/**
 * Rantai lower low swing yang berakhir di dasar (dasar harus swing low terkonfirmasi). Kedalaman diukur dalam
 * ATR candle evaluasi (`atrNow`, satu skala agar teks "0,4 ATR vs 1,3 ATR" sebanding).
 * @returns {{ chain: object[], depthLast: number|null, depthPrev: number|null }} chain = swing LL berurutan
 *   (urut waktu, termasuk dasar); depth null bila rantai < 3 swing atau ATR tidak tersedia
 */
export function lowerLowChain(lows, bottomIndex, atrNow) {
  const upTo = lows.filter((s) => s.index <= bottomIndex);
  if (upTo.length === 0 || upTo[upTo.length - 1].index !== bottomIndex) return { chain: [], depthLast: null, depthPrev: null };
  let start = upTo.length - 1;
  while (start > 0 && upTo[start].price < upTo[start - 1].price) start -= 1;
  const chain = upTo.slice(start);
  if (chain.length < 3 || !(atrNow > 0)) return { chain, depthLast: null, depthPrev: null };
  const [a, b, c] = chain.slice(-3);
  return { chain, depthLast: (b.price - c.price) / atrNow, depthPrev: (a.price - b.price) / atrNow };
}

/**
 * Retest dasar (double bottom / dasar bertahan): sesudah dasar close sempat menjauh ≥ departAtr, lalu ada candle
 * yang low-nya kembali ≤ dasar + retestAtr (candle retest PERTAMA sesudah menjauh). Syarat "menjauh dulu"
 * ditambahkan agar candle tepat sesudah dasar tidak dihitung sebagai retest.
 * @returns {{ retestIndex: number|null, departIndex: number|null, retestLow: number|null }}
 */
export function findBottomRetest(candles, bottomIndex, last, atrNow, p) {
  if (!(atrNow > 0)) return { retestIndex: null, departIndex: null, retestLow: null };
  const bottom = candles[bottomIndex].low;
  const departLevel = bottom + p.bottomHeldDepartAtr * atrNow;
  const retestLevel = bottom + p.bottomHeldRetestAtr * atrNow;
  let departIndex = null;
  for (let i = bottomIndex + 1; i <= last; i += 1) {
    const c = candles[i];
    if (departIndex === null) {
      if (c.close >= departLevel) departIndex = i;
      continue;
    }
    if (c.low <= retestLevel) return { retestIndex: i, departIndex, retestLow: c.low };
  }
  return { retestIndex: null, departIndex, retestLow: null };
}

/**
 * Momentum turun melemah: rata-rata body candle merah `bars` candle terakhir dibanding `bars` candle
 * sebelumnya, serta porsi volume candle merah pada jendela terakhir.
 * @returns {{ recentBody: number|null, prevBody: number|null, bodyRatio: number|null, redVolumeShare: number|null, redCount: number }}
 */
export function downMomentum(candles, last, bars) {
  const stats = (from, to) => {
    let body = 0;
    let red = 0;
    let redVol = 0;
    let vol = 0;
    for (let i = from; i <= to; i += 1) {
      const c = candles[i];
      vol += c.volume;
      if (c.close < c.open) {
        red += 1;
        body += c.open - c.close;
        redVol += c.volume;
      }
    }
    return { avgBody: red > 0 ? body / red : 0, redCount: red, redVolumeShare: vol > 0 ? redVol / vol : null };
  };
  if (last - 2 * bars + 1 < 0) return { recentBody: null, prevBody: null, bodyRatio: null, redVolumeShare: null, redCount: 0 };
  const recent = stats(last - bars + 1, last);
  const prev = stats(last - 2 * bars + 1, last - bars);
  const prevBody = prev.redCount > 0 ? prev.avgBody : null;
  return {
    recentBody: recent.avgBody,
    prevBody,
    bodyRatio: prevBody !== null && prevBody > 0 ? recent.avgBody / prevBody : null,
    redVolumeShare: recent.redVolumeShare,
    redCount: recent.redCount,
  };
}

/**
 * Divergensi RSI pada dua swing low terkonfirmasi terakhir yang berakhir di dasar (dasar harus swing low):
 * harga lower low tetapi RSI lebih tinggi. Diukur di dasar (bukan dua swing terakhir sembarang) agar bukti
 * tidak hilang ketika higher low mulai terbentuk sesudah dasar.
 * @returns {{ prev: object|null, bottom: object|null, priceLowerLow: boolean|null, rsiDiff: number|null }}
 */
export function rsiDivergenceAtBottom(lows, rsiSeries, bottomIndex) {
  const upTo = lows.filter((s) => s.index <= bottomIndex);
  if (upTo.length < 2 || upTo[upTo.length - 1].index !== bottomIndex) return { prev: null, bottom: null, priceLowerLow: null, rsiDiff: null };
  const [prev, bottom] = upTo.slice(-2);
  const r0 = rsiSeries[prev.index];
  const r1 = rsiSeries[bottom.index];
  return {
    prev,
    bottom,
    priceLowerLow: bottom.price < prev.price,
    rsiDiff: isNum(r0) && isNum(r1) ? r1 - r0 : null,
  };
}

/** ATR sekarang dibanding ATR `lookback` candle lalu (rasio; null bila salah satu tidak tersedia/nol). */
export function atrContractionRatio(atrSeries, last, lookback) {
  const now = positive(atrSeries[last]);
  const before = last - lookback >= 0 ? positive(atrSeries[last - lookback]) : null;
  return now !== null && before !== null ? now / before : null;
}

/** Jarak |EMA cepat − EMA lambat| / ATR pada indeks i; null bila belum terhitung. */
export function emaDistanceAtr(series, i) {
  if (i < 0) return null;
  const a = positive(series.atr[i]);
  const f = series.emaFast[i];
  const s = series.emaSlow[i];
  return a !== null && isNum(f) && isNum(s) ? Math.abs(f - s) / a : null;
}

/** Range (max high − min low) candle [from, to]; null bila jendela kosong/di luar data. */
export function rangeOf(candles, from, to) {
  if (from < 0 || to < from || to >= candles.length) return null;
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = from; i <= to; i += 1) {
    if (candles[i].high > hi) hi = candles[i].high;
    if (candles[i].low < lo) lo = candles[i].low;
  }
  return hi - lo;
}

/** Rasio range `lookback` candle terakhir terhadap `lookback` candle sebelumnya. */
export function rangeContraction(candles, last, lookback) {
  const recent = rangeOf(candles, last - lookback + 1, last);
  const previous = rangeOf(candles, last - 2 * lookback + 1, last - lookback);
  return { recent, previous, ratio: recent !== null && previous !== null && previous > 0 ? recent / previous : null };
}

/**
 * Dasar membulat: fit kuadrat close pada `window` candle terakhir. vertexPos = posisi vertex sebagai fraksi
 * jendela (0 = awal, 1 = candle evaluasi); vertexIndex dikembalikan absolut (indeks candle, dibulatkan).
 */
export function roundedBottomFit(closes, last, window) {
  const from = last - window + 1;
  if (from < 0) return null;
  const fit = quadraticFit(closes.slice(from, last + 1));
  if (fit === null) return null;
  const vertexPos = fit.vertexIndex === null ? null : fit.vertexIndex / (window - 1);
  const vertexIndex = fit.vertexIndex === null ? null : Math.min(last, Math.max(from, from + Math.round(fit.vertexIndex)));
  return { ...fit, vertexPos, vertexIndex, from };
}

/**
 * Sideways dengan dasar makin tinggi: range `lookback` candle terakhir dalam ATR dan slope regresi harga
 * swing low terkonfirmasi di jendela itu (ATR per candle).
 */
export function risingFloor(candles, lows, last, lookback, atrNow) {
  const from = Math.max(0, last - lookback + 1);
  const range = rangeOf(candles, from, last);
  const points = lows.filter((s) => s.index >= from).map((s) => ({ x: s.index, y: s.price }));
  const slope = linearSlope(points);
  return {
    rangeAtr: range !== null && atrNow > 0 ? range / atrNow : null,
    slopeAtr: slope !== null && atrNow > 0 ? slope / atrNow : null,
    swingCount: points.length,
    lastSwing: points.length > 0 ? lows.filter((s) => s.index >= from).at(-1) : null,
  };
}

/**
 * Higher low terkonfirmasi sesudah dasar yang masih UTUH (aturan audit PR #19): swing low dengan index > dasar,
 * harga > swing low sebelumnya sejak dasar (atau > dasar bila ia yang pertama), tidak ada low sesudahnya di
 * bawahnya, dan close evaluasi di atasnya. Dicari dari yang terbaru; dikembalikan HL utuh terbaru.
 * @returns {{ swing: object, chain: number, all: object[] }|null} chain = jumlah HL berurutan yang berakhir di swing itu
 */
export function intactHigherLow(candles, lows, bottomIndex, last) {
  const bottom = candles[bottomIndex].low;
  const after = lows.filter((s) => s.index > bottomIndex);
  const close = candles[last].close;
  for (let k = after.length - 1; k >= 0; k -= 1) {
    const s = after[k];
    const prevPrice = k > 0 ? after[k - 1].price : bottom;
    if (!(s.price > prevPrice) || !(s.price > bottom)) continue;
    let intact = close > s.price;
    for (let i = s.index + 1; intact && i <= last; i += 1) if (candles[i].low < s.price) intact = false;
    if (!intact) continue;
    let chain = 0;
    for (let j = k; j >= 0; j -= 1) {
      if (!(after[j].price > (j > 0 ? after[j - 1].price : bottom))) break;
      chain += 1;
    }
    return { swing: s, chain, all: after };
  }
  return null;
}

/**
 * Spring kausal: candle sapuan j dalam `bars` candle terakhir (j ∈ [last−bars, last]) yang low-nya menembus swing
 * low terkonfirmasi SEBELUM j (confirmedIndex < j, swing terbaru); reclaimed = close evaluasi > level; RVOL candle
 * sapuan dari seri RVOL (baseline candle sebelumnya). Sapuan terbaru yang dikembalikan.
 * @returns {{ index: number, level: number, swingIndex: number, reclaimed: boolean, rvol: number|null }|null}
 */
export function findSpring(candles, lows, rvolSeries, last, bars) {
  const from = Math.max(0, last - bars);
  for (let j = last; j >= from; j -= 1) {
    let swing = null;
    for (const s of lows) if (s.confirmedIndex < j && (swing === null || s.index > swing.index)) swing = s;
    if (swing === null || !(candles[j].low < swing.price)) continue;
    return {
      index: j,
      level: swing.price,
      swingIndex: swing.index,
      reclaimed: candles[last].close > swing.price,
      rvol: isNum(rvolSeries[j]) ? rvolSeries[j] : null,
    };
  }
  return null;
}

/** Indeks terakhir dalam [last−lookback, last−1] dengan close ≤ EMA lambat (null bila tidak ada). */
export function lastCloseAtOrBelowEma(series, last, lookback) {
  for (let i = last - 1; i >= Math.max(0, last - lookback); i -= 1) {
    const e = series.emaSlow[i];
    if (isNum(e) && series.closes[i] <= e) return i;
  }
  return null;
}

/**
 * Lower high terkonfirmasi terakhir sejak dasar: swing high terbaru dengan index > dasar yang harganya lebih
 * rendah dari swing high sebelumnya (label LH). broken = close evaluasi di atasnya.
 */
export function lowerHighSinceBottom(highs, bottomIndex, close) {
  for (let k = highs.length - 1; k >= 0; k -= 1) {
    const s = highs[k];
    if (s.index <= bottomIndex) break;
    if (k > 0 && s.price < highs[k - 1].price) return { swing: s, prev: highs[k - 1], broken: close > s.price };
  }
  return null;
}

/** Jumlah higher-high berurutan di akhir daftar swing high. */
export function trailingHigherHighs(highs) {
  let count = 0;
  for (let i = highs.length - 1; i > 0; i -= 1) {
    if (highs[i].price > highs[i - 1].price) count += 1;
    else break;
  }
  return count;
}

/**
 * Tangga sejak dasar: HL berurutan (swing low index ≥ dasar) & HH berurutan (swing high index > dasar), serta
 * langkah terbesar antar swing sejenis dalam rantai (ATR). Langkah diukur antar swing sejenis (HL ke HL, HH ke HH).
 */
export function staircaseSinceBottom(highs, lows, bottomIndex, atrNow) {
  const lowsSince = lows.filter((s) => s.index >= bottomIndex);
  const highsSince = highs.filter((s) => s.index > bottomIndex);
  const hl = trailingHigherLows(lowsSince);
  const hh = trailingHigherHighs(highsSince);
  let maxStep = 0;
  for (let i = lowsSince.length - hl; i < lowsSince.length; i += 1) if (i > 0) maxStep = Math.max(maxStep, lowsSince[i].price - lowsSince[i - 1].price);
  for (let i = highsSince.length - hh; i < highsSince.length; i += 1) if (i > 0) maxStep = Math.max(maxStep, highsSince[i].price - highsSince[i - 1].price);
  return {
    higherLows: hl,
    higherHighs: hh,
    maxStepAtr: atrNow > 0 && (hl > 0 || hh > 0) ? maxStep / atrNow : null,
    lastLow: lowsSince.at(-1) ?? null,
    lastHigh: highsSince.at(-1) ?? null,
  };
}

/** Rata-rata volume `recent` candle terakhir dibanding rata-rata `baseline` candle sebelumnya. */
export function volumeDryUp(volumes, last, recent, baseline) {
  const start = last - recent - baseline + 1;
  if (start < 0) return { recent: null, baseline: null, ratio: null };
  const r = meanOf(volumes.slice(last - recent + 1, last + 1));
  const b = meanOf(volumes.slice(start, last - recent + 1));
  return { recent: r, baseline: b, ratio: r !== null && b !== null && b > 0 ? r / b : null };
}

/** Kenaikan close dalam `lookback` candle (ATR) dan rata-rata RVOL jendela itu (null bila ada RVOL null). */
export function quietRise(series, last, lookback, atrNow) {
  if (last - lookback < 0) return { riseAtr: null, avgRvol: null, rise: null };
  const rise = series.closes[last] - series.closes[last - lookback];
  return {
    rise,
    riseAtr: atrNow > 0 ? rise / atrNow : null,
    avgRvol: meanOf(series.rvol.slice(last - lookback + 1, last + 1)),
  };
}

/**
 * Level pemicu (resistance berjalan, aturan runningLevel PR #19) pada indeks evaluasi `evalIndex`: swing high
 * terkonfirmasi terakhir sejak dasar (index > dasar, confirmedIndex ≤ evalIndex), dinaikkan ke high tertinggi
 * candle SESUDAH swing itu sampai candle SEBELUM evalIndex. Tanpa swing high sejak dasar → high tertinggi
 * candle [dasar, evalIndex−1] (candle evaluasi tidak ikut: close-nya tidak mungkin melewati high-nya sendiri).
 * @returns {{ level: number, swing: object|null }|null}
 */
export function triggerLevelAt(candles, highs, bottomIndex, evalIndex) {
  let swing = null;
  for (const s of highs) if (s.index > bottomIndex && s.confirmedIndex <= evalIndex) swing = s;
  if (swing !== null) {
    let level = swing.price;
    for (let i = swing.index + 1; i < evalIndex; i += 1) level = Math.max(level, candles[i].high);
    return { level, swing };
  }
  if (evalIndex - 1 < bottomIndex) return null;
  let level = -Infinity;
  for (let i = bottomIndex; i < evalIndex; i += 1) level = Math.max(level, candles[i].high);
  return { level, swing: null };
}

/**
 * Tren HTF dari EMA lambat & slope-nya pada candle HTF terakhir: BEARISH = EMA turun (slope < −ambang) & close <
 * EMA; BULLISH = EMA naik & close > EMA; selain itu NEUTRAL. null bila candle kurang dari warm-up.
 * Pemanggil wajib memberi candle HTF yang sudah tutup pada waktu evaluasi (lihat detector.htfContext).
 */
export function htfTrend(candles, p) {
  const warmup = p.emaSlow + p.slopeLookback - 1;
  if (candles.length < warmup) return null;
  const closes = candles.map((c) => c.close);
  const last = closes.length - 1;
  const emaSlow = ema(closes, p.emaSlow);
  const slope = normalizedSlope(emaSlow, p.slopeLookback)[last];
  const e = emaSlow[last];
  if (!isNum(slope) || !isNum(e)) return null;
  const close = closes[last];
  let trend = 'NEUTRAL';
  if (slope < -p.htfSlopeThreshold && close < e) trend = 'BEARISH';
  else if (slope > p.htfSlopeThreshold && close > e) trend = 'BULLISH';
  return { trend, ema25: e, slope, close, asOf: candles[last].closeTime, candleCount: candles.length };
}

/**
 * Kelas likuiditas (§3.1): quoteVolume24h vs ambang (LIQUID / THIN / ILLIQUID); tanpa data → UNKNOWN lalu
 * fallback rata-rata quote volume per candle < minAvgQuoteVolume[timeframe] → ILLIQUID. Spread di atas
 * maxSpreadBps menurunkan LIQUID menjadi THIN (keputusan sendiri; kontrak hanya menyebut ambang spread).
 * @param {{ quoteVolume24h?: number|null, spreadBps?: number|null, thresholds?: { minQuoteVolume24h?: number, maxSpreadBps?: number } }|null|undefined} liquidity
 */
export function liquidityClassOf(liquidity, avgQuoteVolume, timeframe, p) {
  const t = liquidity?.thresholds ?? {};
  const minQv = isNum(t.minQuoteVolume24h) && t.minQuoteVolume24h >= 0 ? t.minQuoteVolume24h : p.minQuoteVolume24h;
  const maxSpread = isNum(t.maxSpreadBps) && t.maxSpreadBps >= 0 ? t.maxSpreadBps : p.maxSpreadBps;
  const qv = liquidity?.quoteVolume24h;
  let cls = 'UNKNOWN';
  if (isNum(qv) && qv >= 0 && minQv > 0) {
    if (qv >= minQv) cls = 'LIQUID';
    else if (qv >= p.thinLiquidityRatio * minQv) cls = 'THIN';
    else cls = 'ILLIQUID';
  }
  if (cls === 'UNKNOWN' && isNum(avgQuoteVolume) && avgQuoteVolume < p.minAvgQuoteVolume[timeframe]) cls = 'ILLIQUID';
  const spread = liquidity?.spreadBps;
  if (cls === 'LIQUID' && isNum(spread) && spread > maxSpread) cls = 'THIN';
  return cls;
}

/** Struktur pasar, order-flow, dan rezim pada candle terakhir (pembungkus fitur v3 yang sudah ada). */
export function auxiliaryFeatures(candles, p) {
  const structure = analyzeMarketStructure(candles, { left: p.swingLeft, right: p.swingRight });
  const flow = analyzeOrderFlow(candles, { divergenceLookback: p.cvdDivergenceLookback });
  const regime = analyzeRegime(candles);
  return { structure, flow, regime };
}
