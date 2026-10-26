// Evaluasi historis radar smart money TANPA look-ahead (kontrak docs/15 §2 `evaluate.js`). Fungsi murni: tanpa I/O,
// tanpa Date.now(), tanpa acak — masukan sama → laporan identik (dapat di-serialisasi JSON).
//
// ─── Prosedur per titik t = start + i·stepMs, t < end ────────────────────────────────────────────────
// 1. Universe = aktivitas dengan blockTime < t (KETAT). Aktivitas diurutkan & di-dedupe SEKALI; batas dicari dengan
//    pencarian biner. analyzeUniverse(now = t − 1 ms) → PnL, penanda, klaster, skor & kelayakan wallet HANYA dari
//    data sebelum t (trade yang tertutup sebelum t). Wallet yang kemudian rugi/berhenti tetap dihitung di t (tanpa
//    survivorship). Harga tidak diberikan ke analyzeUniverse: skor & kelayakan hanya membaca PnL realisasi.
// 2. Radar = buildAccumulationRadar atas aktivitas [t − windowMs, t) dengan now = t.
// 3. Kandidat = token radar dengan independentBuyers ≥ minIndependentBuyers dan state ∈ signalStates (default
//    ACCUMULATING). Cooldown: token yang sama tidak disinyalkan ulang selama t − sinyal terakhirnya < cooldownMs
//    (default = horizon terpanjang) → jendela return tidak tumpang-tindih; kandidat yang ditahan dihitung.
// 4. Harga masuk = priceAt(tokenKey, t + entryDelayMs) (default jeda 0 → priceAt(t)); return horizon h =
//    priceAt(tokenKey, t + entryDelayMs + h) / harga masuk − 1, dalam PECAHAN (0,05 = +5 %). Harga null/≤ 0 → return
//    null = "harga hilang" (ENTRY_PRICE / EXIT_PRICE), dihitung di cakupan, tidak dibuang diam-diam. priceAt yang
//    melempar error (sumber harga gagal) juga dihitung harga hilang; jumlah & pesan pertamanya masuk summary dan
//    peringatan — evaluasi tetap selesai.
// 5. Baseline di titik yang sama: semua token non-quote dengan SWAP_BUY oleh wallet mana pun di universe dalam
//    [t − windowMs, t), horizon sama. Rata-rata baseline titik t dipasangkan ke setiap sinyal di t:
//    excess = return sinyal − rata-rata baseline (mengontrol kondisi pasar saat itu). Baseline gabungan semua titik
//    dilaporkan terpisah (sampel token × titik dapat tumpang-tindih; n-nya bukan sampel independen).
// 6. Metrik per ember keyakinan (default <40, 40–60, 60–80, ≥80) & horizon: jumlah sinyal, ber-harga, harga hilang
//    (masuk/keluar), cakupan, rata-rata, median, hit rate (> 0) + CI Wilson 95 %, rata-rata baseline pasangan,
//    rata-rata excess, serta peringatan sampel kecil (n < minSample) & cakupan rendah (< minCoverage).
//
// Label alamat diperlakukan statis (hanya mengecualikan infrastruktur: exchange, router/pool, kontrak); label
// performa vendor tidak dipakai modul mana pun. Laporan bersifat in-sample terhadap data yang tersedia.
// Ekstensi kontrak (aditif): `labels` (opsional) pada input; parameter lain lewat `params` (DEFAULT_EVALUATION_PARAMS).
// stepMs/windowMs/horizonsMs/minIndependentBuyers pada input (kontrak) mengalahkan nilai di `params`.

import { DISCLAIMERS, RADAR_STATES, isQuoteAsset, tokenKey as makeTokenKey, walletKey as makeWalletKey } from './contracts.js';
import { analyzeUniverse, isAnalyzableActivity } from './analyze.js';
import { buildAccumulationRadar, dedupeActivities, shortAddress } from './radar.js';
import { wilsonInterval } from '../backtest/metrics.js';
import { fmtNumber, fmtPct } from '../backtest/report.js';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Parameter default evaluasi (HIPOTESIS AWAL). */
export const DEFAULT_EVALUATION_PARAMS = Object.freeze({
  stepMs: 6 * HOUR,
  windowMs: 24 * HOUR,
  horizonsMs: Object.freeze([4 * HOUR, 24 * HOUR, 3 * DAY]),
  minIndependentBuyers: 3,
  signalStates: Object.freeze(['ACCUMULATING']),
  /** Batas ember keyakinan (naik ketat): [40, 60, 80] → <40, 40–60, 60–80, ≥80. */
  convictionBuckets: Object.freeze([40, 60, 80]),
  /** null = horizon terpanjang. */
  cooldownMs: null,
  /** Jeda eksekusi (latensi data/API) sebelum harga masuk. */
  entryDelayMs: 0,
  minSample: 30,
  minCoverage: 0.8,
  maxSteps: 5000,
  /** true → timeline memuat wallet layak (+ skor) & kandidat per titik (untuk audit/uji). */
  includeStepDetails: false,
  /** Override untuk analyzeUniverse ({ flags, clusters, score }). */
  analyze: Object.freeze({}),
  /** Override untuk buildAccumulationRadar. */
  radar: Object.freeze({}),
});

const INPUT_PARAM_KEYS = Object.freeze(['stepMs', 'windowMs', 'horizonsMs', 'minIndependentBuyers']);
const MAX_MARKDOWN_SIGNALS = 100;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isPosInt = (v) => Number.isInteger(v) && v > 0;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

function median(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Indeks pertama dengan times[i] ≥ x. */
function lowerBound(times, x) {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Durasi Bahasa Indonesia: 4 jam, 3 hari, 30 menit. */
function fmtDuration(ms) {
  if (!isNum(ms)) return '—';
  if (ms === 0) return '0 dtk';
  if (ms % DAY === 0) return `${ms / DAY} hari`;
  if (ms % HOUR === 0) return `${ms / HOUR} jam`;
  if (ms % MINUTE === 0) return `${ms / MINUTE} menit`;
  return `${fmtNumber(ms / 1000, 1)} dtk`;
}

function resolveParams(input, params) {
  if (!isPlainObject(params)) throw new TypeError('Parameter evaluasi harus objek');
  for (const key of Object.keys(params)) {
    if (!Object.hasOwn(DEFAULT_EVALUATION_PARAMS, key)) throw new TypeError(`Parameter evaluasi tidak dikenal: ${key}`);
  }
  const p = { ...DEFAULT_EVALUATION_PARAMS, ...params };
  for (const key of INPUT_PARAM_KEYS) if (input[key] !== undefined && input[key] !== null) p[key] = input[key];

  if (!isPosInt(p.stepMs)) throw new RangeError('stepMs harus bilangan bulat > 0 (ms)');
  if (!isPosInt(p.windowMs)) throw new RangeError('windowMs harus bilangan bulat > 0 (ms)');
  if (!Array.isArray(p.horizonsMs) || p.horizonsMs.length === 0 || !p.horizonsMs.every(isPosInt)) {
    throw new RangeError('horizonsMs harus array bilangan bulat > 0 (minimal satu horizon)');
  }
  if (!Number.isInteger(p.minIndependentBuyers) || p.minIndependentBuyers < 1) {
    throw new RangeError('minIndependentBuyers harus bilangan bulat ≥ 1');
  }
  if (!Array.isArray(p.signalStates) || p.signalStates.length === 0 || !p.signalStates.every((s) => RADAR_STATES.includes(s))) {
    throw new RangeError(`signalStates harus berisi minimal satu dari ${RADAR_STATES.join(', ')}`);
  }
  const edges = p.convictionBuckets;
  if (!Array.isArray(edges) || !edges.every((e, i) => isNum(e) && e > 0 && e <= 100 && (i === 0 || e > edges[i - 1]))) {
    throw new RangeError('convictionBuckets harus angka naik ketat di rentang (0, 100]');
  }
  if (p.cooldownMs !== null && !(Number.isInteger(p.cooldownMs) && p.cooldownMs >= 0)) {
    throw new RangeError('cooldownMs harus null (= horizon terpanjang) atau bilangan bulat ≥ 0');
  }
  if (!(Number.isInteger(p.entryDelayMs) && p.entryDelayMs >= 0)) throw new RangeError('entryDelayMs harus bilangan bulat ≥ 0');
  if (!isPosInt(p.minSample)) throw new RangeError('minSample harus bilangan bulat > 0');
  if (!(isNum(p.minCoverage) && p.minCoverage >= 0 && p.minCoverage <= 1)) throw new RangeError('minCoverage harus angka 0..1');
  if (!isPosInt(p.maxSteps)) throw new RangeError('maxSteps harus bilangan bulat > 0');
  if (typeof p.includeStepDetails !== 'boolean') throw new TypeError('includeStepDetails harus boolean');
  if (!isPlainObject(p.analyze)) throw new TypeError('analyze harus objek parameter analyzeUniverse');
  if (!isPlainObject(p.radar)) throw new TypeError('radar harus objek parameter buildAccumulationRadar');

  const horizonsMs = [...new Set(p.horizonsMs)].sort((a, b) => a - b);
  return {
    ...p,
    horizonsMs,
    signalStates: [...p.signalStates],
    convictionBuckets: [...edges],
    cooldownMs: p.cooldownMs ?? horizonsMs[horizonsMs.length - 1],
  };
}

/** Ember keyakinan dari batas naik ketat. */
function bucketDefs(edges) {
  if (edges.length === 0) return [{ label: 'semua', min: null, max: null }];
  const defs = [{ label: `<${edges[0]}`, min: null, max: edges[0] }];
  for (let i = 1; i < edges.length; i += 1) defs.push({ label: `${edges[i - 1]}–${edges[i]}`, min: edges[i - 1], max: edges[i] });
  defs.push({ label: `≥${edges[edges.length - 1]}`, min: edges[edges.length - 1], max: null });
  return defs;
}

function bucketOf(defs, conviction) {
  return defs.find((d) => (d.min === null || conviction >= d.min) && (d.max === null || conviction < d.max)) ?? defs[0];
}

const positivePrice = (v) => (isNum(v) && v > 0 ? v : null);

/**
 * Pembaca harga yang tahan kegagalan sumber: error dari priceAt → null (harga hilang), dihitung & pesan pertama
 * disimpan untuk peringatan — bukan dianggap nol, bukan menggagalkan seluruh evaluasi.
 */
function safePriceReader(priceAt) {
  const errors = { count: 0, first: null };
  const read = (tokenKey, at) => {
    try {
      return positivePrice(priceAt(tokenKey, at));
    } catch (err) {
      errors.count += 1;
      if (errors.first === null) errors.first = String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 200);
      return null;
    }
  };
  return { read, errors };
}

/** Harga masuk & return ke depan per token pada satu titik (memo: token sinyal juga token baseline). */
function forwardFactory(readPrice, entryAt, horizonsMs) {
  const cache = new Map();
  return (tokenKey) => {
    const hit = cache.get(tokenKey);
    if (hit) return hit;
    const entryPrice = readPrice(tokenKey, entryAt);
    const forward = horizonsMs.map((horizonMs) => {
      const exitAt = entryAt + horizonMs;
      if (entryPrice === null) return { horizonMs, exitAt, exitPrice: null, return: null, missing: 'ENTRY_PRICE' };
      const exitPrice = readPrice(tokenKey, exitAt);
      if (exitPrice === null) return { horizonMs, exitAt, exitPrice: null, return: null, missing: 'EXIT_PRICE' };
      return { horizonMs, exitAt, exitPrice, return: exitPrice / entryPrice - 1, missing: null };
    });
    const out = { entryPrice, forward };
    cache.set(tokenKey, out);
    return out;
  };
}

/** Token non-quote dengan SWAP_BUY (oleh siapa pun) di jendela, terurut. */
function baselineTokens(windowActs) {
  const keys = new Set();
  for (const a of windowActs) {
    if (a.type === 'SWAP_BUY' && !isQuoteAsset(a.chain, a.token.address)) keys.add(makeTokenKey(a.chain, a.token.address));
  }
  return [...keys].sort(cmp);
}

/** Cakupan sebagai persen satu desimal, DIBULATKAN KE BAWAH agar 79,95 % tidak tampil sebagai "80,0 % < 80,0 %". */
const fmtCoverage = (v) => (isNum(v) ? fmtPct(Math.floor(v * 1000 + 1e-9) / 1000, 1) : '—');

function metricWarnings(m, p) {
  if (m.signals === 0) return ['tidak ada sinyal'];
  const out = [];
  if (m.withPrice < p.minSample) out.push(`sampel kecil: n = ${m.withPrice} < ${p.minSample}`);
  if (m.coverage < p.minCoverage) {
    out.push(`cakupan harga rendah: ${fmtCoverage(m.coverage)} < ${fmtCoverage(p.minCoverage)} (${m.missingPrice} harga hilang)`);
  }
  return out;
}

/** Metrik satu horizon atas daftar sinyal. */
function horizonMetrics(items, j, horizonMs, p) {
  const returns = [];
  const baselines = [];
  const excess = [];
  let missingEntry = 0;
  let missingExit = 0;
  for (const s of items) {
    const h = s.forward[j];
    if (h.return === null) {
      if (h.missing === 'ENTRY_PRICE') missingEntry += 1;
      else missingExit += 1;
      continue;
    }
    returns.push(h.return);
    if (h.baselineMean !== null) {
      baselines.push(h.baselineMean);
      excess.push(h.excess);
    }
  }
  const n = returns.length;
  const hits = returns.filter((r) => r > 0).length;
  const m = {
    horizonMs,
    signals: items.length,
    withPrice: n,
    missingPrice: items.length - n,
    missingEntry,
    missingExit,
    coverage: items.length ? n / items.length : null,
    mean: mean(returns),
    median: median(returns),
    hitRate: n ? hits / n : null,
    hitRateCi: n ? wilsonInterval(hits, n) : null,
    baselineMean: mean(baselines),
    excessMean: mean(excess),
    pairedWithBaseline: baselines.length,
  };
  m.warnings = metricWarnings(m, p);
  return m;
}

function baselineMetrics(pool, horizonMs, p) {
  const n = pool.returns.length;
  const missing = pool.missingEntry + pool.missingExit;
  const m = {
    horizonMs,
    samples: pool.samples,
    withPrice: n,
    missingPrice: missing,
    missingEntry: pool.missingEntry,
    missingExit: pool.missingExit,
    coverage: pool.samples ? n / pool.samples : null,
    mean: mean(pool.returns),
    median: median(pool.returns),
    hitRate: n ? pool.returns.filter((r) => r > 0).length / n : null,
  };
  m.warnings = pool.samples === 0 ? ['tidak ada token baseline']
    : m.coverage < p.minCoverage ? [`cakupan harga rendah: ${fmtCoverage(m.coverage)} < ${fmtCoverage(p.minCoverage)}`] : [];
  return m;
}

const listHorizons = (entries) => entries.map(([h, v]) => `${v} (${fmtDuration(h)})`).join(', ');

function collectWarnings({ p, data, summary, overall, byBucket, baseline, lastStepAt }) {
  const warnings = [];
  if (data.simulated) warnings.push(`${DISCLAIMERS.simulated} Hasil hanya menguji mekanisme evaluasi, bukan kinerja pasar nyata.`);
  if (summary.priceErrors > 0) {
    warnings.push(`Sumber harga gagal pada ${summary.priceErrors} permintaan (pertama: "${summary.firstPriceError}") — dihitung sebagai harga hilang, bukan nol.`);
  }
  if (summary.eligibleWallets.max === 0) {
    warnings.push('Tidak ada wallet yang layak (eligible) di titik mana pun — riwayat sebelum titik evaluasi belum cukup (trade tertutup, jumlah token, atau lama riwayat).');
  }
  if (summary.signals === 0) {
    warnings.push(`Tidak ada sinyal (≥ ${p.minIndependentBuyers} pembeli independen, state ${p.signalStates.join('/')}) pada rentang evaluasi — tidak ada yang dapat disimpulkan.`);
  } else {
    const small = overall.filter((m) => m.withPrice < p.minSample).map((m) => [m.horizonMs, `n = ${m.withPrice}`]);
    if (small.length) {
      warnings.push(`Sampel kecil secara keseluruhan: ${listHorizons(small)} sinyal ber-harga (< ${p.minSample}) — terlalu sedikit untuk kesimpulan.`);
    }
    const low = overall.filter((m) => m.coverage < p.minCoverage).map((m) => [m.horizonMs, fmtCoverage(m.coverage)]);
    if (low.length) {
      warnings.push(`Cakupan harga rendah secara keseluruhan: ${listHorizons(low)} (< ${fmtCoverage(p.minCoverage)}); sinyal tanpa harga dihitung sebagai harga hilang.`);
    }
    for (const b of byBucket) {
      const active = b.horizons.filter((m) => m.signals > 0);
      const bSmall = active.filter((m) => m.withPrice < p.minSample).map((m) => [m.horizonMs, `n = ${m.withPrice}`]);
      if (bSmall.length) warnings.push(`Ember keyakinan ${b.bucket}: sampel kecil — ${listHorizons(bSmall)} (< ${p.minSample}).`);
      const bLow = active.filter((m) => m.coverage < p.minCoverage).map((m) => [m.horizonMs, fmtCoverage(m.coverage)]);
      if (bLow.length) warnings.push(`Ember keyakinan ${b.bucket}: cakupan harga rendah — ${listHorizons(bLow)} (< ${fmtCoverage(p.minCoverage)}).`);
    }
  }
  const baseLow = baseline.filter((m) => m.samples > 0 && m.coverage < p.minCoverage).map((m) => [m.horizonMs, fmtCoverage(m.coverage)]);
  if (baseLow.length) warnings.push(`Cakupan harga baseline rendah: ${listHorizons(baseLow)} (< ${fmtCoverage(p.minCoverage)}) — pembanding kurang andal.`);
  const maxH = p.horizonsMs[p.horizonsMs.length - 1];
  const hasSamples = summary.signals > 0 || baseline.some((m) => m.samples > 0);
  if (hasSamples && data.lastActivityAt !== null && lastStepAt + p.entryDelayMs + maxH > data.lastActivityAt) {
    warnings.push(`Horizon ${fmtDuration(maxH)} dari titik-titik terakhir melewati aktivitas terakhir di data — return titik akhir bisa hilang atau memakai harga terakhir yang masih dalam batas kedaluwarsa.`);
  }
  return warnings;
}

function buildStatements(p, summary) {
  const at = p.entryDelayMs > 0 ? `t + ${fmtDuration(p.entryDelayMs)}` : 't';
  return [
    `${DISCLAIMERS.conviction} Ember keyakinan hanya mengelompokkan sinyal; hit rate per ember bukan peluang yang terkalibrasi.`,
    'Hasil bersifat in-sample terhadap data yang tersedia: bobot & ambang radar dan skor wallet belum divalidasi pada data terpisah (out-of-sample), dan daftar wallet yang dilacak dapat mengandung bias seleksi (wallet ditemukan karena kinerja yang sudah terlihat). Kinerja masa lalu tidak menjamin hasil masa depan.',
    'Tanpa look-ahead: di setiap titik t, PnL, penanda, klaster, skor, dan kelayakan wallet dihitung hanya dari aktivitas dengan blockTime < t (hanya trade yang sudah tertutup sebelum t); radar memakai jendela [t − jendela, t).',
    `Harga masuk = harga pada ${at}; return = harga pada ${at} + horizon ÷ harga masuk − 1. Sinyal tanpa harga masuk/keluar dihitung sebagai "harga hilang" pada kolom cakupan — tidak dibuang diam-diam.`,
    'Tanpa survivorship: wallet yang layak pada t tetap dihitung walau kemudian rugi atau berhenti bertransaksi; token yang kemudian tidak punya harga dicatat sebagai harga hilang.',
    `Token yang sama tidak disinyalkan ulang selama cooldown ${fmtDuration(p.cooldownMs)} agar sampel return tidak tumpang-tindih (kandidat yang ditahan: ${summary.suppressedByCooldown}).`,
    'Baseline = semua token non-quote yang dibeli via swap oleh wallet mana pun di universe dalam jendela yang sama; "selisih vs baseline" = rata-rata (return sinyal − rata-rata baseline pada titik t yang sama).',
    'Label alamat diperlakukan statis dan hanya dipakai untuk mengecualikan infrastruktur (exchange, router/pool DEX, kontrak, bot); label "smart money" vendor tidak dipakai.',
    DISCLAIMERS.insiderName,
  ];
}

/**
 * Evaluasi historis sinyal radar tanpa look-ahead.
 * @param {{ activities: object[], priceAt: (tokenKey: string, t: number) => number|null, start: number, end: number,
 *   stepMs?: number, windowMs?: number, horizonsMs?: number[], minIndependentBuyers?: number,
 *   labels?: Map<string, object>|object[] }} input
 * @param {Partial<typeof DEFAULT_EVALUATION_PARAMS>} [params]
 * @returns {object} laporan JSON: { kind, version, params, data, summary, overall, byBucket, baseline, signals,
 *   timeline, warnings, statements }
 */
export function evaluateHistorically(input, params = {}) {
  if (!isPlainObject(input)) throw new TypeError('Input evaluasi harus objek');
  const { activities, priceAt, start, end, labels } = input;
  if (!Array.isArray(activities)) throw new TypeError('activities harus array');
  if (typeof priceAt !== 'function') throw new TypeError('priceAt harus fungsi (tokenKey, t) → number|null');
  if (!Number.isInteger(start) || !Number.isInteger(end) || start >= end) {
    throw new RangeError('start dan end harus epoch ms bilangan bulat dengan start < end');
  }
  const p = resolveParams(input, params);
  const stepCount = Math.ceil((end - start) / p.stepMs);
  if (stepCount > p.maxSteps) {
    throw new RangeError(`Terlalu banyak titik evaluasi (${stepCount} > maxSteps ${p.maxSteps}) — perbesar stepMs atau persempit rentang`);
  }

  // Urut & dedupe SEKALI; setiap titik hanya memotong prefiks/jendela dengan pencarian biner.
  const usable = activities.filter(isAnalyzableActivity);
  const sorted = dedupeActivities(usable);
  const times = sorted.map((a) => a.blockTime);
  const buckets = bucketDefs(p.convictionBuckets);
  const H = p.horizonsMs.length;

  const signals = [];
  const timeline = [];
  const lastSignalAt = new Map();
  const pool = p.horizonsMs.map(() => ({ samples: 0, missingEntry: 0, missingExit: 0, returns: [] }));
  const prices = safePriceReader(priceAt);
  let candidates = 0;
  let suppressedByCooldown = 0;

  for (let i = 0; i < stepCount; i += 1) {
    const t = start + i * p.stepMs;
    const hi = lowerBound(times, t); // universe = sorted[0, hi): blockTime < t
    const lo = lowerBound(times, t - p.windowMs); // jendela = sorted[lo, hi): blockTime ∈ [t − windowMs, t)
    const analysis = analyzeUniverse({ activities: sorted.slice(0, hi), labels, now: t - 1 }, p.analyze);
    const windowActs = sorted.slice(lo, hi);
    const radar = buildAccumulationRadar({
      activities: windowActs, walletScores: analysis.walletScores, clusterOf: analysis.clusterOf, now: t, windowMs: p.windowMs,
    }, p.radar);

    const entryAt = t + p.entryDelayMs;
    const forwardOf = forwardFactory(prices.read, entryAt, p.horizonsMs);

    // Baseline titik t.
    const baseKeys = baselineTokens(windowActs);
    const baseSum = new Array(H).fill(0);
    const baseN = new Array(H).fill(0);
    for (const key of baseKeys) {
      const { forward } = forwardOf(key);
      for (let j = 0; j < H; j += 1) {
        const h = forward[j];
        pool[j].samples += 1;
        if (h.return === null) {
          if (h.missing === 'ENTRY_PRICE') pool[j].missingEntry += 1;
          else pool[j].missingExit += 1;
        } else {
          pool[j].returns.push(h.return);
          baseSum[j] += h.return;
          baseN[j] += 1;
        }
      }
    }
    const baselineAt = baseSum.map((s, j) => (baseN[j] > 0 ? s / baseN[j] : null));

    // Kandidat → sinyal (cooldown per token).
    let stepCandidates = 0;
    let stepSignals = 0;
    let stepSuppressed = 0;
    const candidateDetails = [];
    for (const r of radar) {
      if (r.independentBuyers < p.minIndependentBuyers || !p.signalStates.includes(r.state)) continue;
      stepCandidates += 1;
      const prev = lastSignalAt.get(r.tokenKey);
      const suppressed = prev !== undefined && t - prev < p.cooldownMs;
      if (p.includeStepDetails) {
        candidateDetails.push({
          tokenKey: r.tokenKey, conviction: r.conviction, state: r.state, independentBuyers: r.independentBuyers, signalled: !suppressed,
        });
      }
      if (suppressed) {
        stepSuppressed += 1;
        continue;
      }
      lastSignalAt.set(r.tokenKey, t);
      stepSignals += 1;
      const { entryPrice, forward } = forwardOf(r.tokenKey);
      signals.push({
        t,
        tokenKey: r.tokenKey,
        chain: r.chain,
        token: { address: r.token?.address ?? null, symbol: r.token?.symbol ?? null },
        conviction: r.conviction,
        bucket: bucketOf(buckets, r.conviction).label,
        state: r.state,
        independentBuyers: r.independentBuyers,
        buyerCount: r.buyerCount,
        buyers: r.buyers.map((b) => b.wallet).sort(cmp),
        netFlowUsd: r.netFlowUsd,
        entryAt,
        entryPrice,
        forward: forward.map((h, j) => ({
          ...h,
          baselineMean: baselineAt[j],
          excess: h.return !== null && baselineAt[j] !== null ? h.return - baselineAt[j] : null,
        })),
      });
    }
    candidates += stepCandidates;
    suppressedByCooldown += stepSuppressed;

    const step = {
      t,
      universeActivities: hi,
      windowActivities: hi - lo,
      wallets: analysis.stats.wallets,
      eligibleWallets: analysis.stats.eligibleWallets,
      radarTokens: radar.length,
      candidates: stepCandidates,
      signals: stepSignals,
      suppressedByCooldown: stepSuppressed,
      baselineTokens: baseKeys.length,
    };
    if (p.includeStepDetails) {
      step.eligible = [...analysis.walletScores].filter(([, ws]) => ws.eligible).map(([walletKey, ws]) => ({ walletKey, score: ws.score }));
      step.candidateTokens = candidateDetails;
    }
    timeline.push(step);
  }

  const eligibleCounts = timeline.map((s) => s.eligibleWallets);
  const data = {
    activities: sorted.length,
    duplicates: usable.length - sorted.length,
    invalid: activities.length - usable.length,
    wallets: new Set(sorted.map((a) => makeWalletKey(a.chain, a.wallet))).size,
    firstActivityAt: sorted.length ? sorted[0].blockTime : null,
    lastActivityAt: sorted.length ? sorted[sorted.length - 1].blockTime : null,
    simulated: sorted.some((a) => a.isSimulated === true),
  };
  const summary = {
    steps: stepCount,
    stepsWithEligibleWallets: eligibleCounts.filter((c) => c > 0).length,
    stepsWithSignals: timeline.filter((s) => s.signals > 0).length,
    candidates,
    signals: signals.length,
    suppressedByCooldown,
    eligibleWallets: { min: Math.min(...eligibleCounts), mean: mean(eligibleCounts), max: Math.max(...eligibleCounts) },
    priceErrors: prices.errors.count,
    firstPriceError: prices.errors.first,
  };
  const overall = p.horizonsMs.map((h, j) => horizonMetrics(signals, j, h, p));
  const byBucket = buckets.map((b) => {
    const items = signals.filter((s) => s.bucket === b.label);
    return { bucket: b.label, minConviction: b.min, maxConviction: b.max, horizons: p.horizonsMs.map((h, j) => horizonMetrics(items, j, h, p)) };
  });
  const baseline = p.horizonsMs.map((h, j) => baselineMetrics(pool[j], h, p));
  const lastStepAt = start + (stepCount - 1) * p.stepMs;

  return {
    kind: 'smart-money-evaluation',
    version: 1,
    params: { start, end, ...p },
    data,
    summary,
    overall,
    byBucket,
    baseline,
    signals,
    timeline,
    warnings: collectWarnings({ p, data, summary, overall, byBucket, baseline, lastStepAt }),
    statements: buildStatements(p, summary),
  };
}

// ─── Markdown ───────────────────────────────────────────────────────────────────────────────────────

function fmtTime(ms) {
  if (!isNum(ms)) return '—';
  return new Date(ms).toISOString().replace('T', ' ').replace(/:\d{2}\.\d{3}Z$/, ' UTC');
}

function fmtReturn(v) {
  if (!isNum(v)) return '—';
  return `${v > 0 ? '+' : ''}${fmtPct(v, 2)}`;
}

function fmtPrice(v) {
  if (!isNum(v)) return '—';
  return `$${String(Number(v.toPrecision(4))).replace('.', ',')}`;
}

function fmtCiPct(ci) {
  return Array.isArray(ci) ? `${fmtNumber(ci[0] * 100, 1)}–${fmtNumber(ci[1] * 100, 1)}%` : '—';
}

/** Simbol token dari data on-chain tidak tepercaya: hanya huruf/angka/spasi/._-$+, maks 24 karakter. */
function safeSymbol(symbol) {
  const s = String(symbol ?? '').replace(/[^\p{L}\p{N} ._\-$+]/gu, '').trim().slice(0, 24);
  return s || '?';
}

/** Teks aman untuk sel tabel Markdown (tanpa '|' dan baris baru). */
function cell(v) {
  return String(v ?? '—').replace(/\|/g, '/').replace(/\r?\n/g, ' ');
}

function table(headers, rows) {
  if (rows.length === 0) return ['_Tidak ada data._'];
  const row = (values) => `| ${values.map(cell).join(' | ')} |`;
  return [row(headers), row(headers.map(() => '---')), ...rows.map(row)];
}

function metricRow(label, m) {
  return [
    label, String(m.signals), String(m.missingPrice), fmtCoverage(m.coverage), fmtReturn(m.mean), fmtReturn(m.median),
    fmtPct(m.hitRate, 0), fmtCiPct(m.hitRateCi), fmtReturn(m.baselineMean), fmtReturn(m.excessMean),
    m.warnings.join('; ') || '—',
  ];
}

/**
 * Render laporan evaluasi sebagai Markdown Bahasa Indonesia (deterministik).
 * @param {object} report keluaran evaluateHistorically
 * @returns {string}
 */
export function formatEvaluationMarkdown(report) {
  if (!isPlainObject(report) || report.kind !== 'smart-money-evaluation' || !Array.isArray(report.byBucket)) {
    throw new TypeError('Laporan evaluasi tidak valid (harus keluaran evaluateHistorically)');
  }
  const { params: p, data, summary } = report;
  const lines = [
    '# Laporan Evaluasi Historis — Smart Money Radar',
    '',
    `> ${DISCLAIMERS.conviction}`,
    '> Hasil in-sample terhadap data yang tersedia. Skor & kelayakan wallet di setiap titik t dihitung hanya dari data sebelum t.',
    '',
    '## Parameter',
    '',
    `- Rentang evaluasi: ${fmtTime(p.start)} → ${fmtTime(p.end)} · ${summary.steps} titik, langkah ${fmtDuration(p.stepMs)}`,
    `- Jendela radar: ${fmtDuration(p.windowMs)} · horizon: ${p.horizonsMs.map(fmtDuration).join(', ')}`,
    `- Syarat sinyal: ≥ ${p.minIndependentBuyers} pembeli independen, state ${p.signalStates.join('/')}`,
    `- Cooldown token: ${fmtDuration(p.cooldownMs)} · jeda eksekusi: ${p.entryDelayMs > 0 ? fmtDuration(p.entryDelayMs) : 'tanpa jeda'}`,
    `- Ember keyakinan: ${report.byBucket.map((b) => b.bucket).join(', ')}`,
    `- Data: ${data.activities} aktivitas unik dari ${data.wallets} wallet (${fmtTime(data.firstActivityAt)} → ${fmtTime(data.lastActivityAt)})`
      + `${data.duplicates ? ` · ${data.duplicates} duplikat diabaikan` : ''}${data.invalid ? ` · ${data.invalid} tidak valid diabaikan` : ''}`
      + `${data.simulated ? ' · **DATA SIMULASI**' : ''}`,
    '',
    '## Ringkasan',
    '',
    `- Kandidat: ${summary.candidates} · sinyal: ${summary.signals} · ditahan cooldown: ${summary.suppressedByCooldown} · titik dengan sinyal: ${summary.stepsWithSignals}`,
    `- Wallet layak per titik: min ${summary.eligibleWallets.min} · rata-rata ${fmtNumber(summary.eligibleWallets.mean, 1)} · maks ${summary.eligibleWallets.max}`,
    '',
    '## Peringatan',
    '',
  ];
  if (report.warnings.length) lines.push(...report.warnings.map((w) => `- ⚠️ ${w}`));
  else lines.push('- Tidak ada peringatan otomatis. Tetap ingat: kinerja masa lalu tidak menjamin hasil masa depan.');
  lines.push('');

  lines.push('## Hasil per ember keyakinan', '',
    'Return dalam persen dari harga masuk; "Baseline" = rata-rata semua token yang dibeli di jendela yang sama pada titik yang sama; '
    + '"Selisih" = rata-rata (return sinyal − baseline).', '');
  const headers = ['Ember', 'Sinyal', 'Harga hilang', 'Cakupan', 'Rata-rata', 'Median', 'Hit rate', 'CI 95% hit rate', 'Baseline', 'Selisih vs baseline', 'Catatan'];
  p.horizonsMs.forEach((h, j) => {
    const rows = report.byBucket.map((b) => metricRow(b.bucket, b.horizons[j]));
    rows.push(metricRow('**Semua**', report.overall[j]));
    lines.push(`### Horizon ${fmtDuration(h)}`, '', ...table(headers, rows), '');
  });

  lines.push('## Baseline gabungan', '',
    'Semua token non-quote yang dibeli via swap di jendela setiap titik; sampel token × titik dapat tumpang-tindih (n bukan sampel independen).', '');
  lines.push(...table(['Horizon', 'Sampel', 'Harga hilang', 'Cakupan', 'Rata-rata', 'Median', 'Hit rate', 'Catatan'],
    report.baseline.map((m) => [
      fmtDuration(m.horizonMs), String(m.samples), String(m.missingPrice), fmtCoverage(m.coverage), fmtReturn(m.mean),
      fmtReturn(m.median), fmtPct(m.hitRate, 0), m.warnings.join('; ') || '—',
    ])), '');

  lines.push('## Sinyal', '');
  const shown = report.signals.slice(0, MAX_MARKDOWN_SIGNALS);
  lines.push(...table(
    ['Waktu (t)', 'Token', 'Keyakinan', 'Pembeli independen', 'Harga masuk', ...p.horizonsMs.map((h) => `Return ${fmtDuration(h)} (selisih)`)],
    shown.map((s) => [
      fmtTime(s.t),
      `${safeSymbol(s.token.symbol)} (${s.chain}:${shortAddress(s.token.address)})`,
      `${s.conviction} (${s.bucket})`,
      String(s.independentBuyers),
      fmtPrice(s.entryPrice),
      ...s.forward.map((f) => (f.return === null
        ? `harga hilang (${f.missing === 'ENTRY_PRICE' ? 'masuk' : 'keluar'})`
        : `${fmtReturn(f.return)} (${fmtReturn(f.excess)})`)),
    ]),
  ));
  if (report.signals.length > shown.length) lines.push('', `_${report.signals.length - shown.length} sinyal lain tidak ditampilkan._`);
  lines.push('');

  lines.push('## Metodologi & batasan', '', ...report.statements.map((s) => `- ${s}`), '');
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}
