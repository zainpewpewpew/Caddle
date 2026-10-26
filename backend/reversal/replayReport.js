// Agregasi & laporan replay "Reversal Radar" (docs/19 §9). Fungsi murni: tanpa I/O, tanpa Date.now() (stempel waktu
// dari meta). Agregasi per timeframe × skenario × sensitivitas (SENSITIVITY_FILTERS = filter tampilan: kandidat
// dihitung bila skor & jumlah bukti saat deteksi pertama memenuhi ambang), rasio selalu disertai jumlah sampel
// (k/n) dan interval Wilson 95 %, median/kuartil MFE & MAE, lead vs mesin lama & vs breakout, false positive,
// perbandingan lama vs baru, dan pemeriksaan target docs/19 §10 (definisi keberhasilan ditetapkan SEBELUM evaluasi).
// Untuk data nyata multi-peristiwa: hasil per tahap awal & per status terlambat, distribusi skor saat deteksi per tahap,
// jarak stop + dua basis pembanding tanpa keterampilan (random walk & empiris), breakout gagal sebelum target, lead per
// peristiwa (sinyal lama terdekat ±horizon), dan target T-NYATA-1..3 (hanya bila ada grup dataNyata).
// Data sintetis ≠ pasar nyata; laporan tidak pernah menyatakan probabilitas keberhasilan.
import { wilsonInterval } from '../backtest/metrics.js';
import { fmtNumber, fmtPct } from '../backtest/report.js';
import { EVIDENCE_WEIGHTS, SENSITIVITIES, SENSITIVITY_FILTERS, STAGES } from './constants.js';

/** Ambang peringatan kejujuran (sama dengan laporan backtest). */
export const REPLAY_REPORT_THRESHOLDS = Object.freeze({ minSample: 30, maxCiWidth: 0.2 });

/** Definisi keberhasilan docs/19 §10 — ditetapkan sebelum evaluasi; TIDAK diubah setelah melihat hasil. */
export const SUCCESS_DEFINITION = 'SUCCESS bila dalam horizon setelah deteksi pertama harga mencapai close deteksi + 2 × ATR deteksi '
  + 'sebelum close < level invalidasi saat deteksi (FAIL); tanpa keduanya sampai horizon = TIMEOUT; data habis = OPEN (dikecualikan). '
  + 'TP & SL pada candle yang sama = FAIL; gap melewati stop = keluar di open (konservatif).';

/** Skenario yang seharusnya tanpa kandidat (bila meta tidak menyebut daftar lain). */
export const DEFAULT_FALSE_POSITIVE_SCENARIOS = Object.freeze(['continuedDowntrend', 'suddenPump', 'uptrendContinuation']);
/** Label skenario tanpa metadata (data nyata). */
export const REAL_DATA_SCENARIO = 'dataNyata';

/** Target awal §10 (hipotesis yang diperiksa, bukan klaim). */
export const TARGET_RULES = Object.freeze([
  { id: 'SUCCESS_RATE', scenario: 'successfulReversal', sensitivity: 'MEDIUM', text: 'successfulReversal: SUCCESS ≥ 60 % pada MEDIUM' },
  { id: 'DOWNTREND_FP', scenario: 'continuedDowntrend', sensitivity: 'HIGH', text: 'continuedDowntrend: ≤ 15 % seri berkandidat (semua sensitivitas)' },
  { id: 'UPTREND_ZERO', scenario: 'uptrendContinuation', sensitivity: 'HIGH', text: 'uptrendContinuation: 0 kandidat' },
  { id: 'LEAD_POSITIVE', scenario: 'successfulReversal', sensitivity: 'MEDIUM', text: 'successfulReversal: median lead kandidat pertama vs sinyal lama pertama > 0 candle' },
]);

/** Target tambahan untuk data nyata (grup dataNyata) — hanya diperiksa bila run memuat grup itu; hipotesis, bukan klaim. */
export const REAL_DATA_TARGET_RULES = Object.freeze([
  { id: 'T_NYATA_1', scenario: REAL_DATA_SCENARIO, sensitivity: 'MEDIUM', text: 'T-NYATA-1 dataNyata: SUCCESS pada MEDIUM melampaui basis acak empiris (CI bawah SUCCESS > basis)' },
  { id: 'T_NYATA_2', scenario: REAL_DATA_SCENARIO, sensitivity: 'MEDIUM', text: 'T-NYATA-2 dataNyata: median lead per peristiwa (padanan ±horizon) > 0 pada MEDIUM' },
  { id: 'T_NYATA_3', scenario: REAL_DATA_SCENARIO, sensitivity: 'MEDIUM', text: 'T-NYATA-3 dataNyata: kandidat pertama EARLY_FORMATION ≥ 10 % pada MEDIUM' },
]);

/** Bin skor 10 poin untuk histogram skor saat deteksi: 0–9, 10–19, …, 80–89, 90–100 (bin terakhir memuat 100). */
export const SCORE_BINS = Object.freeze(Array.from({ length: 10 }, (_, i) => Object.freeze({
  label: i === 9 ? '90–100' : `${10 * i}–${10 * i + 9}`, min: 10 * i, max: i === 9 ? 100 : 10 * i + 9,
})));

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const finiteList = (xs) => xs.filter(isNum);
const TF_ORDER = ['5m', '15m', '1h'];
const tfRank = (tf) => (TF_ORDER.indexOf(tf) === -1 ? 99 : TF_ORDER.indexOf(tf));

/** Kuantil sampel (interpolasi linear). n = 0 → semua null. */
export function quantiles(values) {
  const xs = finiteList(values ?? []).sort((a, b) => a - b);
  const n = xs.length;
  if (n === 0) return { n: 0, min: null, q1: null, median: null, q3: null, max: null };
  const at = (q) => {
    const pos = (n - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return lo === hi ? xs[lo] : xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
  };
  return { n, min: xs[0], q1: at(0.25), median: at(0.5), q3: at(0.75), max: xs[n - 1] };
}

/** Proporsi k/n dengan interval Wilson 95 %; n = 0 → p & ci null (tidak ada informasi). */
export function rate(k, n) {
  if (!isNum(n) || n <= 0) return { k: isNum(k) ? k : 0, n: 0, p: null, ci: null };
  return { k, n, p: k / n, ci: wilsonInterval(k, n) };
}

/** Histogram skor per bin SCORE_BINS (hitungan per bin; skor di luar 0..100 dijepit ke bin tepi; non-angka diabaikan). */
export function scoreHistogram(scores) {
  const counts = SCORE_BINS.map(() => 0);
  for (const s of scores ?? []) {
    if (!isNum(s)) continue;
    counts[Math.min(SCORE_BINS.length - 1, Math.max(0, Math.floor(s / 10)))] += 1;
  }
  return counts;
}

/** Rata-rata nilai hingga: { n, p } (p null bila n = 0) — untuk basis random walk (bukan proporsi, tanpa CI). */
function meanOf(values) {
  const xs = finiteList(values ?? []);
  return { n: xs.length, p: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null };
}

/** Kandidat lolos filter sensitivitas bila skor & jumlah bukti saat deteksi pertama ≥ ambang. */
export function passesSensitivity(candidate, sensitivity) {
  const f = SENSITIVITY_FILTERS[sensitivity];
  if (!f) throw new RangeError(`Sensitivitas tidak dikenal: ${String(sensitivity)}`);
  return (candidate.firstScore ?? 0) >= f.minScore && (candidate.firstEvidenceCount ?? 0) >= f.minEvidence;
}

const median = (xs) => quantiles(xs).median;

/** Alasan penutupan kandidat docs/19 §4 yang dihitung terpisah; lainnya masuk `other`. */
export const CLOSE_REASONS = Object.freeze(['CLOSE_BELOW_INVALIDATION', 'BREAKOUT_FAILED', 'NO_PROGRESS', 'EVIDENCE_FADED']);
/** Id bukti kontrak (urutan constants.js) untuk tabel frekuensi bukti. */
export const EVIDENCE_IDS = Object.freeze(Object.keys(EVIDENCE_WEIGHTS));

/**
 * Frekuensi tiap bukti: bagian evaluasi candle yang meloloskannya (dari `evidenceCounts` seri) dan bagian kandidat yang
 * memuatnya saat deteksi pertama. Dipakai untuk menilai ambang mana yang diskriminatif antar skenario.
 */
function evidenceShare(list, cands) {
  const evaluations = list.reduce((a, s) => a + (s.evaluations ?? 0), 0);
  const out = {};
  for (const id of EVIDENCE_IDS) {
    const k = list.reduce((a, s) => a + (s.evidenceCounts?.[id] ?? 0), 0);
    const kc = cands.filter((c) => Array.isArray(c.firstEvidence) && c.firstEvidence.includes(id)).length;
    out[id] = { evaluations: rate(k, evaluations), candidates: rate(kc, cands.length) };
  }
  return out;
}

/**
 * Ringkasan per fase rencana skenario sintetis (seri membawa `phases` [{ name, startIndex, endIndex }] dan `landmarks`
 * { bottomIndex, breakoutIndex }); null bila tidak ada seri berfase (data nyata). `candidates` = jumlah kandidat per fase
 * tempat candle deteksi pertamanya berada; `first` = hanya kandidat pertama tiap seri; `preBottom` = kandidat yang dibuka
 * sebelum low terendah rencana (false start di tengah penurunan); `leadVsPlan` = indeks breakout rencana − indeks deteksi
 * kandidat pertama; `leadVsPlanAfterBottom` = sama, tetapi kandidat pertama yang dibuka pada/setelah dasar.
 */
function phaseSummary(list, perSeries) {
  if (!list.some((s) => Array.isArray(s.phases) && s.phases.length)) return null;
  const order = [];
  const candidates = {};
  const first = {};
  const bump = (acc, name) => { acc[name] = (acc[name] ?? 0) + 1; };
  let preBottom = 0;
  let withBottom = 0;
  const leadVsPlan = [];
  const leadVsPlanAfterBottom = [];
  list.forEach((s, i) => {
    const phases = Array.isArray(s.phases) ? s.phases : [];
    for (const ph of phases) if (!order.includes(ph.name)) order.push(ph.name);
    const nameOf = (index) => phases.find((ph) => index >= ph.startIndex && index <= ph.endIndex)?.name ?? 'luar';
    const cands = perSeries[i];
    cands.forEach((c, k) => {
      const name = nameOf(c.firstDetectedIndex);
      if (!order.includes(name)) order.push(name);
      bump(candidates, name);
      if (k === 0) bump(first, name);
    });
    const bottom = s.landmarks?.bottomIndex;
    const breakout = s.landmarks?.breakoutIndex;
    if (Number.isInteger(bottom)) {
      withBottom += cands.length;
      preBottom += cands.filter((c) => c.firstDetectedIndex < bottom).length;
    }
    if (Number.isInteger(breakout) && cands.length) {
      leadVsPlan.push(breakout - cands[0].firstDetectedIndex);
      const afterBottom = Number.isInteger(bottom) ? cands.find((c) => c.firstDetectedIndex >= bottom) : cands[0];
      if (afterBottom) leadVsPlanAfterBottom.push(breakout - afterBottom.firstDetectedIndex);
    }
  });
  return { order, candidates, first, preBottom: rate(preBottom, withBottom), leadVsPlan: quantiles(leadVsPlan), leadVsPlanAfterBottom: quantiles(leadVsPlanAfterBottom) };
}

/**
 * Statistik sekumpulan seri pada satu sensitivitas.
 * @param {object[]} seriesList hasil replayReversalSeries (dengan `candidates`, `old`)
 * @param {'LOW'|'MEDIUM'|'HIGH'} sensitivity
 */
export function summarizeCandidates(seriesList, sensitivity) {
  const list = seriesList ?? [];
  const perSeries = list.map((s) => (s.candidates ?? []).filter((c) => passesSensitivity(c, sensitivity)));
  const cands = perSeries.flat();
  const firstPerSeries = perSeries.map((xs) => xs[0]).filter(Boolean); // kandidat pertama tiap seri (yang lolos filter)
  const counts = perSeries.map((xs) => xs.length);
  const nSeries = list.length;
  const n = cands.length;
  const isLabeled = (c) => c.outcome === 'SUCCESS' || c.outcome === 'FAIL' || c.outcome === 'TIMEOUT';
  const labeled = cands.filter(isLabeled);
  const count = (pred) => cands.filter(pred).length;
  const firstStage = Object.fromEntries(STAGES.map((st) => [st, count((c) => c.firstStage === st)]));
  const reached = cands.filter((c) => (c.stages ?? []).some((s) => s.stage === 'CONFIRMED_BREAKOUT'));
  const closeReasons = Object.fromEntries(CLOSE_REASONS.map((r) => [r, count((c) => c.closeReason === r)]));
  closeReasons.other = count((c) => c.closeIndex !== null && c.closeIndex !== undefined && !CLOSE_REASONS.includes(c.closeReason));
  const oldOn = list.some((s) => s.old?.enabled);
  // Rincian hasil triple barrier untuk sekumpulan kandidat (rasio atas kandidat berlabel; OPEN & tanpa label dikecualikan).
  const outcomeRates = (xs) => {
    const lab = xs.filter(isLabeled);
    return {
      labeled: lab.length,
      open: xs.filter((c) => c.outcome === 'OPEN').length,
      unlabeled: xs.filter((c) => c.outcome === null).length,
      success: rate(lab.filter((c) => c.outcome === 'SUCCESS').length, lab.length),
      fail: rate(lab.filter((c) => c.outcome === 'FAIL').length, lab.length),
      timeout: rate(lab.filter((c) => c.outcome === 'TIMEOUT').length, lab.length),
    };
  };
  const subset = (xs) => ({ candidates: xs.length, ...outcomeRates(xs) });
  const byStage = (pick) => Object.fromEntries(STAGES.map((st) => [st, pick(cands.filter((c) => c.firstStage === st))]));
  const outcomes = outcomeRates(cands);
  // Basis pembanding tanpa keterampilan (dihitung per kandidat berlabel di replay.js; digabung per grup di sini).
  const shuffled = labeled.reduce((acc, c) => {
    const b = c.baselineShuffled;
    if (b && isNum(b.k) && isNum(b.n)) { acc.k += b.k; acc.n += b.n; }
    return acc;
  }, { k: 0, n: 0 });
  const baselineShuffled = rate(shuffled.k, shuffled.n);
  // Breakout gagal yang tidak pernah mencapai target: BREAKOUT_FAILED dengan mfeAtr < targetAtr seri (penyebut = yang berlabel).
  let failedBeforeTargetK = 0;
  let failedBeforeTargetN = 0;
  list.forEach((s, i) => {
    for (const c of perSeries[i]) {
      if (c.closeReason !== 'BREAKOUT_FAILED' || !isLabeled(c) || !isNum(c.mfeAtr) || !isNum(s.targetAtr)) continue;
      failedBeforeTargetN += 1;
      if (c.mfeAtr < s.targetAtr) failedBeforeTargetK += 1;
    }
  });
  const nearest = finiteList(cands.map((c) => c.leadVsOldNearest));
  return {
    sensitivity,
    series: nSeries,
    candidates: n,
    perSeries: { mean: nSeries ? n / nSeries : null, max: counts.length ? Math.max(...counts) : 0 },
    seriesWithCandidate: rate(counts.filter((k) => k > 0).length, nSeries),
    cancelled: rate(count((c) => c.status === 'CANCELLED'), n),
    expired: rate(count((c) => c.status === 'EXPIRED'), n),
    stillOpen: count((c) => c.closeIndex === null),
    reachedConfirmed: rate(reached.length, n),
    // "CONFIRMED sesaat": mencapai CONFIRMED_BREAKOUT lalu ditutup BREAKOUT_FAILED (penyebut = kandidat yang mencapai CONFIRMED).
    falseBreakouts: rate(reached.filter((c) => c.closeReason === 'BREAKOUT_FAILED').length, reached.length),
    // Kandidat yang dibuka langsung sebagai CONFIRMED_BREAKOUT dan berakhir BREAKOUT_FAILED (penyebut = dibuka sebagai CONFIRMED).
    confirmedFirstFailed: rate(count((c) => c.firstStage === 'CONFIRMED_BREAKOUT' && c.closeReason === 'BREAKOUT_FAILED'), firstStage.CONFIRMED_BREAKOUT),
    closeReasons,
    barsOpen: quantiles(cands.map((c) => c.barsOpen)),
    evidence: evidenceShare(list, cands),
    phases: phaseSummary(list, perSeries),
    outcomes,
    // Hasil per tahap awal & per status terlambat saat deteksi (LATE_ENTRY/EXTENDED) — kandidat & rasio berlabel.
    outcomesByFirstStage: byStage(subset),
    outcomesByExtended: { extended: subset(cands.filter((c) => c.extendedAtDetection === true)), notExtended: subset(cands.filter((c) => c.extendedAtDetection !== true)) },
    // Distribusi skor & jumlah bukti saat deteksi per tahap awal (dasar memilih ambang sensitivitas per tahap).
    firstScoreByStage: byStage((xs) => quantiles(xs.map((c) => c.firstScore))),
    firstEvidenceByStage: byStage((xs) => quantiles(xs.map((c) => c.firstEvidenceCount))),
    firstScoreHistogramByStage: byStage((xs) => scoreHistogram(xs.map((c) => c.firstScore))),
    // Jarak stop (ATR deteksi) & basis pembanding tanpa keterampilan atas kandidat berlabel; selisih = SUCCESS − basis empiris.
    stopDistanceAtr: quantiles(labeled.map((c) => c.stopDistanceAtr)),
    baselineRandomWalk: meanOf(labeled.map((c) => c.baselineRandomWalk)),
    baselineShuffled,
    successMinusBaseline: isNum(outcomes.success.p) && isNum(baselineShuffled.p) ? outcomes.success.p - baselineShuffled.p : null,
    failedBeforeTarget: rate(failedBeforeTargetK, failedBeforeTargetN),
    mfeAtr: quantiles(labeled.map((c) => c.mfeAtr)),
    maeAtr: quantiles(labeled.map((c) => c.maeAtr)),
    mfePct: quantiles(labeled.map((c) => c.mfePct)),
    maePct: quantiles(labeled.map((c) => c.maePct)),
    // Lead vs mesin lama: `leadVsOldFirst` = kandidat PERTAMA tiap seri vs sinyal lama pertama (siapa lebih dulu menandai
    // simbol itu — dipakai target §10); `leadVsOld` = semua kandidat (kandidat lanjutan wajar bernilai negatif).
    leadVsOld: quantiles(cands.map((c) => c.leadVsOld)),
    leadVsOldAlert: quantiles(cands.map((c) => c.leadVsOldAlert)),
    leadVsOldFirst: quantiles(firstPerSeries.map((c) => c.leadVsOld)),
    leadVsOldAlertFirst: quantiles(firstPerSeries.map((c) => c.leadVsOldAlert)),
    // Lead per peristiwa: sinyal lama TERDEKAT dalam ±horizon dari tiap deteksi (bermakna pada seri multi-peristiwa/data nyata).
    leadVsOldNearest: quantiles(nearest),
    leadVsOldNearestMatched: rate(nearest.length, n),
    leadVsOldNearestPositive: rate(nearest.filter((v) => v > 0).length, nearest.length),
    leadVsBreakout: quantiles(cands.map((c) => c.leadVsBreakout)),
    barsToTrigger: quantiles(cands.map((c) => c.barsToTrigger)),
    barsToConfirmed: quantiles(cands.map((c) => c.barsToConfirmed)),
    firstStage,
    lateEntry: rate(count((c) => c.lateEntry === true), n),
    extendedAtDetection: rate(count((c) => c.extendedAtDetection === true), n),
    firstIndexMedian: median(perSeries.map((xs) => xs[0]?.firstDetectedIndex)),
    old: {
      enabled: oldOn,
      seriesWithSignal: rate(list.filter((s) => s.old?.firstSignalIndex !== null && s.old?.firstSignalIndex !== undefined).length, nSeries),
      signals: list.reduce((a, s) => a + (s.old?.signals ?? 0), 0),
      alerts: list.reduce((a, s) => a + (s.old?.alerts ?? 0), 0),
      firstIndexMedian: median(list.map((s) => s.old?.firstSignalIndex)),
    },
    classifications: list.reduce((acc, s) => {
      for (const [k, v] of Object.entries(s.classifications ?? {})) acc[k] = (acc[k] ?? 0) + v;
      return acc;
    }, {}),
    anomalies: list.reduce((a, s) => a + Object.values(s.anomalies ?? {}).reduce((x, y) => x + y, 0), 0),
  };
}

function groupKey(s) {
  return `${s.timeframe}|${s.scenario ?? REAL_DATA_SCENARIO}`;
}

/** Status pemeriksaan target §10. */
function targetStatus(ok) {
  return ok === null ? 'TANPA_DATA' : ok ? 'TERPENUHI' : 'TIDAK_TERPENUHI';
}

/**
 * Pemeriksaan target §10 per timeframe. Hanya melaporkan apa yang dihitung; tanpa data → TANPA_DATA.
 * @returns {Array<{ id, text, timeframe, status, value, n, smallSample }>}
 */
export function checkTargets(groups, timeframes) {
  const out = [];
  const find = (tf, scenario, sensitivity) => groups.find((g) => g.timeframe === tf && g.scenario === scenario && g.sensitivity === sensitivity) ?? null;
  // Target data nyata (T-NYATA) hanya bila run memuat grup dataNyata — pada run sintetis daftar target tidak berubah.
  const rules = groups.some((g) => g.scenario === REAL_DATA_SCENARIO) ? [...TARGET_RULES, ...REAL_DATA_TARGET_RULES] : TARGET_RULES;
  for (const tf of timeframes) {
    for (const rule of rules) {
      const g = find(tf, rule.scenario, rule.sensitivity);
      let ok = null;
      let value = null;
      let n = 0;
      let detail = null;
      if (g) {
        if (rule.id === 'SUCCESS_RATE') {
          n = g.outcomes.success.n;
          value = g.outcomes.success.p;
          ok = n > 0 ? value >= 0.6 : null;
        } else if (rule.id === 'DOWNTREND_FP') {
          n = g.seriesWithCandidate.n;
          value = g.seriesWithCandidate.p;
          ok = n > 0 ? value <= 0.15 : null;
        } else if (rule.id === 'UPTREND_ZERO') {
          n = g.series;
          value = g.candidates;
          ok = n > 0 ? g.candidates === 0 : null;
        } else if (rule.id === 'LEAD_POSITIVE') {
          n = g.leadVsOldFirst.n;
          value = g.leadVsOldFirst.median;
          ok = n > 0 ? value > 0 : null;
        } else if (rule.id === 'T_NYATA_1') {
          // CI bawah SUCCESS harus di atas basis acak empiris (titik); tanpa basis (n = 0) → tanpa data.
          const base = g.baselineShuffled ?? rate(0, 0);
          n = g.outcomes.success.n;
          value = g.outcomes.success.p;
          detail = { ci: g.outcomes.success.ci, baseline: base.p, baselineN: base.n };
          ok = n > 0 && base.n > 0 ? g.outcomes.success.ci[0] > base.p : null;
        } else if (rule.id === 'T_NYATA_2') {
          n = g.leadVsOldNearest?.n ?? 0;
          value = g.leadVsOldNearest?.median ?? null;
          ok = n > 0 ? value > 0 : null;
        } else if (rule.id === 'T_NYATA_3') {
          const early = rate(g.firstStage.EARLY_FORMATION, g.candidates);
          n = early.n;
          value = early.p;
          ok = n > 0 ? value >= 0.1 : null;
        }
      }
      out.push({ id: rule.id, text: rule.text, timeframe: tf, status: targetStatus(ok), value, n, smallSample: n > 0 && n < REPLAY_REPORT_THRESHOLDS.minSample, detail });
    }
  }
  return out;
}

/** Peringatan kejujuran otomatis. */
export function collectReplayWarnings(result, t = REPLAY_REPORT_THRESHOLDS) {
  const warnings = [];
  const meta = result.meta ?? {};
  if (meta.source === 'synthetic') {
    warnings.push('Data **sintetis**: hasil hanya membuktikan mekanisme & arah perilaku pada bentuk chart yang diketahui — BUKAN akurasi pasar nyata.');
  }
  if (meta.seedSet === 'tuning' || meta.seedSet === 'mixed') {
    warnings.push(`Benih penyetelan (1–20) ikut dievaluasi (set: ${meta.seedSet}) — angka ini in-sample dan tidak boleh dipakai sebagai hasil evaluasi.`);
  }
  if (meta.oldMode === null || meta.oldMode === 'off') warnings.push('Pembanding mesin lama dimatikan — lead vs mesin lama tidak tersedia.');
  if (meta.oldMode === 'fast') warnings.push('Pembanding mesin lama mode cepat (tanpa konfluensi v3): indeks sinyal pertama identik dengan live, indeks alert pertama memakai definisi v2 (tanpa gerbang tier).');
  const medium = (result.groups ?? []).filter((g) => g.sensitivity === 'MEDIUM');
  // Sampel kecil & CI lebar dirangkum satu baris per timeframe agar daftar tetap terbaca pada run banyak skenario.
  for (const tf of [...new Set(medium.map((g) => g.timeframe))]) {
    const gs = medium.filter((g) => g.timeframe === tf);
    const small = gs.filter((g) => g.candidates > 0 && g.outcomes.success.n > 0 && g.outcomes.success.n < t.minSample);
    if (small.length) {
      warnings.push(`${tf} (MEDIUM): hasil berlabel n < ${t.minSample} — sampel terlalu kecil untuk kesimpulan pada ${small.map((g) => `${g.scenario} (n = ${g.outcomes.success.n})`).join(', ')}.`);
    }
    const wide = gs.filter((g) => g.outcomes.success.ci && g.outcomes.success.ci[1] - g.outcomes.success.ci[0] > t.maxCiWidth);
    if (wide.length) {
      warnings.push(`${tf} (MEDIUM): CI 95 % SUCCESS lebih lebar dari ${fmtNumber(t.maxCiWidth * 100, 0)} poin — ketidakpastian tinggi pada ${wide.map((g) => `${g.scenario} (${fmtCi(g.outcomes.success.ci)})`).join(', ')}.`);
    }
  }
  for (const g of medium) {
    const label = `${g.timeframe} ${g.scenario} (MEDIUM)`;
    if (g.outcomes.unlabeled > 0) warnings.push(`${label}: ${g.outcomes.unlabeled} kandidat tanpa label (tanpa level invalidasi/ATR saat deteksi) — dikecualikan dari rasio hasil.`);
    if (g.anomalies > 0) warnings.push(`${label}: ${g.anomalies} anomali kontrak state machine (lihat anomalies di JSON).`);
  }
  if (result.lookahead?.failures?.length) {
    warnings.push(`Uji anti-look-ahead GAGAL pada ${result.lookahead.failures.length} seri — hasil replay TIDAK sah sampai diperbaiki.`);
  }
  return warnings;
}

/**
 * Agregasi hasil replay.
 * @param {{ series: object[], meta?: object, scenarios?: Array<{ id: string, label?: string, expectation?: string, falsePositive?: boolean }>,
 *   lookahead?: { checked: number, failures: Array<{ symbol: string, timeframe: string, message: string }> } | null }} input
 *   series: hasil replayReversalSeries, boleh membawa `scenario` & `seed` (describe pada replayReversalUniverse).
 */
export function aggregateReplay({ series, meta = {}, scenarios = [], lookahead = null } = {}) {
  if (!Array.isArray(series)) throw new TypeError('series harus array hasil replay');
  const scenarioMeta = new Map(scenarios.map((s) => [s.id, s]));
  const fpList = meta.falsePositiveScenarios ?? scenarios.filter((s) => s.falsePositive).map((s) => s.id);
  const fpSet = new Set(fpList.length ? fpList : DEFAULT_FALSE_POSITIVE_SCENARIOS);
  const timeframes = [...new Set(series.map((s) => s.timeframe))].sort((a, b) => tfRank(a) - tfRank(b));
  const byKey = new Map();
  for (const s of series) {
    const key = groupKey(s);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(s);
  }
  const scenarioOrder = (id) => {
    const i = scenarios.findIndex((s) => s.id === id);
    return i === -1 ? 99 : i;
  };
  const keys = [...byKey.keys()].sort((a, b) => {
    const [tfa, sca] = a.split('|');
    const [tfb, scb] = b.split('|');
    return tfRank(tfa) - tfRank(tfb) || scenarioOrder(sca) - scenarioOrder(scb) || sca.localeCompare(scb);
  });
  const groups = [];
  for (const key of keys) {
    const [timeframe, scenario] = key.split('|');
    const list = byKey.get(key);
    const sm = scenarioMeta.get(scenario);
    for (const sensitivity of SENSITIVITIES) {
      groups.push({
        timeframe, scenario, label: sm?.label ?? scenario, expectation: sm?.expectation ?? null, falsePositive: fpSet.has(scenario),
        ...summarizeCandidates(list, sensitivity),
      });
    }
  }
  const byTimeframe = [];
  for (const tf of timeframes) {
    const list = series.filter((s) => s.timeframe === tf);
    for (const sensitivity of SENSITIVITIES) byTimeframe.push({ timeframe: tf, ...summarizeCandidates(list, sensitivity) });
  }
  const falsePositives = groups.filter((g) => g.falsePositive).map((g) => ({
    timeframe: g.timeframe, scenario: g.scenario, sensitivity: g.sensitivity, series: g.series, candidates: g.candidates,
    perSeries: g.perSeries, seriesWithCandidate: g.seriesWithCandidate, lateEntry: g.lateEntry, extendedAtDetection: g.extendedAtDetection,
  }));
  const comparison = groups.filter((g) => g.sensitivity === 'HIGH').map((g) => ({
    timeframe: g.timeframe, scenario: g.scenario, series: g.series,
    old: { ...g.old },
    radar: { seriesWithCandidate: g.seriesWithCandidate, candidates: g.candidates, firstIndexMedian: g.firstIndexMedian },
    leadVsOld: g.leadVsOld, leadVsOldAlert: g.leadVsOldAlert, leadVsOldFirst: g.leadVsOldFirst, leadVsOldAlertFirst: g.leadVsOldAlertFirst,
  }));
  const result = {
    meta: {
      source: 'unknown', timeframes, scenarios: [...new Set(series.map((s) => s.scenario ?? REAL_DATA_SCENARIO))],
      seeds: [...new Set(series.map((s) => s.seed).filter(isNum))].sort((a, b) => a - b),
      seedSet: null, horizonBars: series[0]?.horizonBars ?? null, targetAtr: series[0]?.targetAtr ?? null,
      baseline: series.find((s) => s.baseline)?.baseline ?? null, scoreBins: SCORE_BINS.map((b) => b.label),
      sensitivities: SENSITIVITIES, sensitivityFilters: SENSITIVITY_FILTERS, successDefinition: SUCCESS_DEFINITION,
      oldMode: series.find((s) => s.old)?.old?.enabled ? series.find((s) => s.old).old.mode : 'off',
      falsePositiveScenarios: [...fpSet], notes: [],
      ...meta,
    },
    totals: {
      series: series.length,
      evaluations: series.reduce((a, s) => a + (s.evaluations ?? 0), 0),
      oldEvaluations: series.reduce((a, s) => a + (s.old?.evaluations ?? 0), 0),
      candidates: series.reduce((a, s) => a + (s.candidates?.length ?? 0), 0),
    },
    groups,
    byTimeframe,
    falsePositives,
    comparison,
    targets: checkTargets(groups, timeframes),
    lookahead,
    warnings: [],
  };
  result.warnings = collectReplayWarnings(result);
  return result;
}

// ---- Render Markdown -------------------------------------------------------------------------------------------

function fmtCi(ci) {
  return Array.isArray(ci) && isNum(ci[0]) && isNum(ci[1]) ? `${fmtNumber(ci[0] * 100, 1)}–${fmtNumber(ci[1] * 100, 1)} %` : '—';
}

/** Rasio SELALU dengan jumlah sampel: "k/n = p % (CI a–b %)"; n = 0 → "— (n = 0)". */
export function fmtRate(r) {
  if (!r || !isNum(r.n) || r.n === 0) return '— (n = 0)';
  return `${r.k}/${r.n} = ${fmtPct(r.p)} (CI ${fmtCi(r.ci)})`;
}

/** Kuantil ringkas: "median (Q1–Q3), n" dengan satuan. */
function fmtQ(q, digits = 1, unit = '') {
  if (!q || q.n === 0) return '— (n = 0)';
  const f = (v) => `${fmtNumber(v, digits)}${unit}`;
  return `${f(q.median)} (${f(q.q1)}–${f(q.q3)}), n = ${q.n}`;
}

const fmtSigned = (v, digits = 0) => (isNum(v) ? `${v > 0 ? '+' : ''}${fmtNumber(v, digits)}` : '—');
/** Lead ringkas: "+k candle, n = m" atau "— (n = 0)". */
const fmtLead = (q) => (q && q.n ? `${fmtSigned(q.median)} candle, n = ${q.n}` : '— (n = 0)');

function fmtDate(v) {
  if (!isNum(v)) return '—';
  return new Date(v).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function cell(v) {
  return String(v ?? '—').replace(/\|/g, '/').replace(/\r?\n/g, ' ');
}
const row = (values) => `| ${values.map(cell).join(' | ')} |`;
function table(headers, rows) {
  if (rows.length === 0) return ['_Tidak ada data._'];
  return [row(headers), row(headers.map(() => '---')), ...rows.map(row)];
}

const STATUS_LABEL = Object.freeze({ TERPENUHI: 'TERPENUHI', TIDAK_TERPENUHI: 'TIDAK terpenuhi', TANPA_DATA: 'tanpa data' });

function targetValue(t) {
  if (t.status === 'TANPA_DATA') return '—';
  if (t.id === 'UPTREND_ZERO') return `${t.value} kandidat pada ${t.n} seri`;
  if (t.id === 'LEAD_POSITIVE' || t.id === 'T_NYATA_2') return `median ${fmtSigned(t.value)} candle, n = ${t.n}`;
  if (t.id === 'T_NYATA_1') return `SUCCESS ${fmtPct(t.value)} (CI ${fmtCi(t.detail?.ci)}) vs basis empiris ${fmtPct(t.detail?.baseline)}, n = ${t.n}`;
  return `${fmtPct(t.value)}, n = ${t.n}`;
}

/** Rata-rata ringkas tanpa CI (basis random walk): "p %, n = m". */
function fmtMean(m) {
  return m && isNum(m.n) && m.n > 0 ? `${fmtPct(m.p)}, n = ${m.n}` : '— (n = 0)';
}

/** Selisih dalam poin persen bertanda: "+4,2 poin" atau "—". */
const fmtPoints = (v) => (isNum(v) ? `${fmtSigned(v * 100, 1)} poin` : '—');

/**
 * Render laporan Markdown (bahasa Indonesia).
 * @param {ReturnType<typeof aggregateReplay>} result
 */
export function renderReplayReport(result) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.groups)) throw new TypeError('Hasil replay wajib berbentuk { meta, groups }');
  const meta = result.meta ?? {};
  const lines = [
    '# Laporan Replay Reversal Radar',
    '',
    '> Riset saja — bukan nasihat keuangan dan bukan perintah transaksi. Skor Reversal Radar adalah skor aturan yang dapat',
    '> dijelaskan, **bukan probabilitas**; laporan ini tidak menyatakan peluang keberhasilan di masa depan. Rasio hasil',
    '> selalu disertai jumlah sampel dan interval kepercayaan Wilson 95 %.',
    '',
  ];
  if (meta.source === 'synthetic') {
    lines.push('> ⚠️ **Data sintetis ≠ pasar nyata.** Skenario dibangun dengan bentuk chart yang diketahui (reversal sukses, pantulan gagal,',
      '> dll.) untuk menguji mekanisme deteksi dan arah perilaku detektor. Angka di sini TIDAK menggambarkan akurasi di pasar nyata.', '');
  }
  lines.push('## Parameter', '',
    `- Dibuat: ${fmtDate(meta.generatedAt)}`,
    `- Sumber data: ${meta.source ?? '—'}`,
    `- Timeframe: ${(meta.timeframes ?? []).join(', ') || '—'}`,
    `- Skenario: ${(meta.scenarios ?? []).join(', ') || '—'}`,
    `- Benih: ${(meta.seeds ?? []).length ? `${meta.seeds[0]}–${meta.seeds.at(-1)} (${meta.seeds.length} benih, set ${meta.seedSet ?? '—'})` : '—'}`,
    `- Horizon: ${meta.horizonBars ?? '—'} candle · target: +${fmtNumber(meta.targetAtr, 1)} × ATR deteksi · stop: level invalidasi saat deteksi`,
    `- Definisi keberhasilan (§10, ditetapkan sebelum evaluasi): ${meta.successDefinition ?? SUCCESS_DEFINITION}`,
    `- Sensitivitas (filter tampilan, bukan parameter mesin): ${SENSITIVITIES.map((s) => `${s} (skor ≥ ${SENSITIVITY_FILTERS[s].minScore}, bukti ≥ ${SENSITIVITY_FILTERS[s].minEvidence})`).join('; ')}`,
    `- Pembanding mesin lama (SA/PVA analyzeAt): ${meta.oldMode ?? 'off'}`,
    `- Seri: ${result.totals?.series ?? 0} · evaluasi mesin baru: ${result.totals?.evaluations ?? 0} · evaluasi mesin lama: ${result.totals?.oldEvaluations ?? 0} · kandidat: ${result.totals?.candidates ?? 0}`,
  );
  if (Array.isArray(meta.symbols)) {
    // Data nyata: simbol yang diminta vs yang benar-benar di-replay, plus yang dilewati beserta alasannya (meta.symbolsSkipped).
    const requested = Array.isArray(meta.symbolsRequested) ? meta.symbolsRequested : null;
    const skipped = Array.isArray(meta.symbolsSkipped) ? meta.symbolsSkipped : [];
    if (isNum(meta.from) && isNum(meta.to)) lines.push(`- Rentang data: ${fmtDate(meta.from)} – ${fmtDate(meta.to)}`);
    lines.push(`- Simbol diminta: ${isNum(meta.topRequested)
      ? `--top ${meta.topRequested} → discovery mengembalikan ${requested ? requested.length : '—'}${requested && requested.length < meta.topRequested ? ' (filter kontrak/likuiditas discovery)' : ''}`
      : requested ? `${requested.length} (--symbols)` : '—'}`);
    lines.push(`- Simbol di-replay (${meta.symbols.length}): ${meta.symbols.join(', ') || '—'}`);
    lines.push(`- Simbol dilewati: ${skipped.length ? skipped.map((s) => `${s.symbol} (${s.reason})`).join('; ') : 'tidak ada'}`);
  }
  for (const note of meta.notes ?? []) lines.push(`- Catatan: ${note}`);
  lines.push('');

  lines.push('## Peringatan kejujuran', '');
  const warnings = result.warnings ?? [];
  if (warnings.length) lines.push(...warnings.map((w) => `- ⚠️ ${w}`));
  else lines.push('- Tidak ada peringatan otomatis. Kinerja pada data historis/sintetis tidak menjamin hasil masa depan.');
  lines.push('');

  lines.push('## Pemeriksaan target §10', '',
    'Target awal adalah hipotesis yang diperiksa, bukan klaim. "Tanpa data" = skenario/sensitivitas itu tidak ada dalam run ini.', '',
    ...table(['TF', 'Target', 'Status', 'Nilai', 'Catatan'], (result.targets ?? []).map((t) => [
      t.timeframe, t.text, STATUS_LABEL[t.status] ?? t.status, targetValue(t), t.smallSample ? 'sampel terlalu kecil' : '—',
    ])), '');

  lines.push('## Ringkasan per timeframe', '',
    'Lead vs lama = indeks sinyal lama pertama − indeks deteksi (positif = Reversal Radar lebih awal): kandidat pertama tiap seri / semua kandidat.',
    'Basis acak RW / empiris = rasio SUCCESS yang diharapkan tanpa keterampilan pada penghalang yang sama (lihat "Basis pembanding tanpa keterampilan").', '',
    ...table(['TF', 'Sensitivitas', 'Seri', 'Kandidat', 'Kandidat/seri', 'SUCCESS', 'FAIL', 'TIMEOUT', 'Basis acak RW', 'Basis acak empiris', 'Batal', 'Kedaluwarsa', 'Lead vs lama: kandidat pertama (median)', 'Lead vs lama: semua kandidat (median)'],
      (result.byTimeframe ?? []).map((g) => [
        g.timeframe, g.sensitivity, String(g.series), String(g.candidates), fmtNumber(g.perSeries.mean, 2),
        fmtRate(g.outcomes.success), fmtRate(g.outcomes.fail), fmtRate(g.outcomes.timeout), fmtMean(g.baselineRandomWalk), fmtRate(g.baselineShuffled),
        fmtRate(g.cancelled), fmtRate(g.expired), fmtLead(g.leadVsOldFirst), fmtLead(g.leadVsOld),
      ])), '');

  lines.push('## Per timeframe × skenario × sensitivitas', '',
    'Kandidat dihitung bila skor dan jumlah bukti saat deteksi pertama memenuhi filter sensitivitas. Rasio hasil memakai kandidat berlabel',
    '(SUCCESS/FAIL/TIMEOUT); OPEN (data habis) dan tanpa label dikecualikan dari penyebut.', '',
    ...table(['TF', 'Skenario', 'Sens.', 'Seri', 'Kandidat', 'Kand./seri', 'Seri berkandidat', 'SUCCESS', 'FAIL', 'TIMEOUT', 'Batal', 'Kedaluwarsa', 'OPEN/tanpa label', 'Tahap awal E/D/C'],
      result.groups.map((g) => [
        g.timeframe, g.label ?? g.scenario, g.sensitivity, String(g.series), String(g.candidates), fmtNumber(g.perSeries.mean, 2), fmtRate(g.seriesWithCandidate),
        fmtRate(g.outcomes.success), fmtRate(g.outcomes.fail), fmtRate(g.outcomes.timeout), fmtRate(g.cancelled), fmtRate(g.expired),
        `${g.outcomes.open}/${g.outcomes.unlabeled}`, `${g.firstStage.EARLY_FORMATION}/${g.firstStage.DEVELOPING_REVERSAL}/${g.firstStage.CONFIRMED_BREAKOUT}`,
      ])), '');

  const withCandidates = result.groups.filter((g) => g.candidates > 0);
  const target = fmtNumber(meta.targetAtr, 1);
  lines.push('## Basis pembanding tanpa keterampilan', '',
    'Dua basis "tanpa keterampilan" untuk menilai apakah rasio SUCCESS melebihi yang diperoleh tanpa informasi pada penghalang yang sama.',
    'Jarak stop s = (close deteksi − level invalidasi saat deteksi) / ATR deteksi, per kandidat berlabel (level yang benar-benar dipakai pelabelan).',
    `**Basis acak RW** = rata-rata s / (${target} + s) atas kandidat berlabel: peluang random walk tanpa drift menyentuh +${target} × ATR sebelum −s × ATR`,
    '(aproksimasi tanpa batas waktu, TIMEOUT diabaikan — pembanding kasar). **Basis acak empiris** = untuk tiap kandidat berlabel diambil',
    `K = ${meta.baseline?.samples ?? '—'} indeks acak (PRNG berbenih, deterministik) pada seri yang sama setelah warm-up dan sebelum n − horizon, lalu dilabeli dengan aturan`,
    `triple barrier yang SAMA: target = ${target} × ATR${meta.baseline?.atrPeriod ?? ''}(idx), stop = s × ATR${meta.baseline?.atrPeriod ?? ''}(idx); k/n digabung per grup. Selisih = SUCCESS − basis empiris`,
    '(poin persen); sinyal melebihi kebetulan bila selisih positif DAN CI bawah SUCCESS di atas basis (target T-NYATA-1 pada data nyata).', '',
    ...table(['TF', 'Skenario', 'Sens.', 'Berlabel', 'Jarak stop s (ATR) median (Q1–Q3)', 'Basis acak RW', 'Basis acak empiris', 'SUCCESS', 'Selisih SUCCESS − basis empiris'],
      withCandidates.map((g) => [
        g.timeframe, g.label ?? g.scenario, g.sensitivity, String(g.outcomes.labeled), fmtQ(g.stopDistanceAtr, 2), fmtMean(g.baselineRandomWalk),
        fmtRate(g.baselineShuffled), fmtRate(g.outcomes.success), fmtPoints(g.successMinusBaseline),
      ])), '');

  lines.push('## Hasil per tahap awal', '',
    'Hasil triple barrier dipisah menurut tahap saat kandidat pertama dibuka (EARLY_FORMATION / DEVELOPING_REVERSAL / CONFIRMED_BREAKOUT);',
    'hanya grup & tahap yang berkandidat. Rasio atas kandidat berlabel.', '',
    ...table(['TF', 'Skenario', 'Sens.', 'Tahap awal', 'Kandidat', 'Berlabel', 'SUCCESS', 'FAIL', 'TIMEOUT'],
      withCandidates.flatMap((g) => STAGES.filter((st) => g.outcomesByFirstStage?.[st]?.candidates > 0).map((st) => {
        const o = g.outcomesByFirstStage[st];
        return [g.timeframe, g.label ?? g.scenario, g.sensitivity, st, String(o.candidates), String(o.labeled), fmtRate(o.success), fmtRate(o.fail), fmtRate(o.timeout)];
      }))), '');

  lines.push('## Hasil menurut status terlambat saat deteksi', '',
    'Terlambat = saat deteksi pertama kandidat sudah membawa risiko LATE_ENTRY/EXTENDED (harga sudah jauh dari dasar); tepat waktu = tidak.',
    'Hanya grup berkandidat; rasio atas kandidat berlabel.', '',
    ...table(['TF', 'Skenario', 'Sens.', 'Status saat deteksi', 'Kandidat', 'Berlabel', 'SUCCESS', 'FAIL', 'TIMEOUT'],
      withCandidates.flatMap((g) => [['extended', 'terlambat (LATE_ENTRY/EXTENDED)'], ['notExtended', 'tepat waktu']].flatMap(([key, label]) => {
        const o = g.outcomesByExtended?.[key];
        return o && o.candidates > 0 ? [[g.timeframe, g.label ?? g.scenario, g.sensitivity, label, String(o.candidates), String(o.labeled), fmtRate(o.success), fmtRate(o.fail), fmtRate(o.timeout)]] : [];
      }))), '');

  const high = result.groups.filter((g) => g.sensitivity === 'HIGH');
  lines.push('## Alasan penutupan & breakout gagal (sensitivitas HIGH = semua kandidat)', '',
    'Mengukur kekhawatiran state machine: kandidat yang dibuka lalu CANCELLED/EXPIRED menurut alasan docs/19 §4, dan "CONFIRMED sesaat" =',
    'kandidat yang mencapai CONFIRMED_BREAKOUT lalu ditutup BREAKOUT_FAILED. "CONFIRMED sejak awal → gagal" = dibuka langsung sebagai CONFIRMED lalu BREAKOUT_FAILED.',
    `"Breakout gagal sebelum target" = di antara kandidat BREAKOUT_FAILED yang berlabel, yang MFE-nya < ${target} × ATR (tidak pernah mencapai target sebelum gagal).`, '',
    ...table(['TF', 'Skenario', 'Kandidat', 'Close < invalidasi', 'Breakout gagal', 'Tanpa kemajuan', 'Bukti melemah', 'Lainnya', 'Masih terbuka', 'Mencapai CONFIRMED', 'CONFIRMED sesaat', 'CONFIRMED sejak awal → gagal', 'Candle terbuka (median)', 'Breakout gagal sebelum target'],
      high.map((g) => [
        g.timeframe, g.label ?? g.scenario, String(g.candidates), String(g.closeReasons.CLOSE_BELOW_INVALIDATION), String(g.closeReasons.BREAKOUT_FAILED),
        String(g.closeReasons.NO_PROGRESS), String(g.closeReasons.EVIDENCE_FADED), String(g.closeReasons.other), String(g.stillOpen),
        fmtRate(g.reachedConfirmed), fmtRate(g.falseBreakouts), fmtRate(g.confirmedFirstFailed), fmtQ(g.barsOpen, 0), fmtRate(g.failedBeforeTarget),
      ])), '');

  lines.push('## Distribusi skor saat deteksi per tahap awal (sensitivitas HIGH)', '',
    'Skor & jumlah bukti saat deteksi pertama per tahap awal (semua kandidat) — dasar memilih ambang sensitivitas per tahap dari data.',
    `Histogram = jumlah kandidat per bin skor 10 poin, urutan ${SCORE_BINS.map((b) => b.label).join(' / ')}.`, '',
    ...table(['TF', 'Skenario', 'Tahap awal', 'Kandidat', 'Skor median (Q1–Q3)', 'Skor min–maks', 'Bukti median (Q1–Q3)', 'Histogram skor (bin 10 poin)'],
      high.filter((g) => g.candidates > 0).flatMap((g) => STAGES.filter((st) => g.firstScoreByStage?.[st]?.n > 0 || g.firstEvidenceByStage?.[st]?.n > 0).map((st) => {
        const q = g.firstScoreByStage[st];
        return [
          g.timeframe, g.label ?? g.scenario, st, String(g.firstStage[st]), fmtQ(q, 0), q.n ? `${fmtNumber(q.min, 0)}–${fmtNumber(q.max, 0)}` : '—',
          fmtQ(g.firstEvidenceByStage[st], 1), (g.firstScoreHistogramByStage?.[st] ?? []).join('/') || '—',
        ];
      }))), '');

  const phased = high.filter((g) => g.phases);
  if (phased.length) {
    const phaseCells = (counts, order) => order.filter((n) => counts[n]).map((n) => `${n} ${counts[n]}`).join(' · ') || '—';
    lines.push('## Deteksi per fase rencana skenario (sintetis, sensitivitas HIGH)', '',
      'Fase rencana tempat candle deteksi pertama tiap kandidat berada. "Sebelum dasar" = kandidat dibuka sebelum low terendah rencana',
      '(false start di tengah penurunan). Lead vs breakout rencana = indeks breakout rencana − indeks deteksi kandidat pertama yang dibuka',
      'pada/setelah dasar (positif = lebih awal; hanya skenario dengan fase breakout).', '',
      ...table(['TF', 'Skenario', 'Kandidat', 'Per fase (semua kandidat)', 'Per fase (kandidat pertama tiap seri)', 'Sebelum dasar', 'Lead vs breakout rencana'],
        phased.map((g) => [
          g.timeframe, g.label ?? g.scenario, String(g.candidates), phaseCells(g.phases.candidates, g.phases.order), phaseCells(g.phases.first, g.phases.order),
          fmtRate(g.phases.preBottom), fmtQ(g.phases.leadVsPlanAfterBottom, 0),
        ])), '');
  }

  lines.push('## Frekuensi bukti per skenario (sensitivitas HIGH)', '',
    'Sel = % evaluasi candle yang meloloskan bukti itu / % kandidat yang memuat bukti itu saat deteksi pertama. Bukti yang sama seringnya',
    'lolos pada skenario false positive (downtrend berlanjut, sideways, uptrend) dan pada reversal sukses tidak diskriminatif → kandidat penyetelan ambang.', '');
  for (const tf of result.meta?.timeframes ?? []) {
    const cols = high.filter((g) => g.timeframe === tf);
    if (!cols.length) continue;
    lines.push(`### ${tf}`, '', ...table(['Bukti', ...cols.map((g) => g.label ?? g.scenario)], EVIDENCE_IDS.map((id) => [
      id, ...cols.map((g) => `${fmtShare(g.evidence?.[id]?.evaluations)} / ${fmtShare(g.evidence?.[id]?.candidates)}`),
    ])), '');
  }

  const medium = result.groups.filter((g) => g.sensitivity === 'MEDIUM');
  lines.push('## Ekskursi MFE/MAE (sensitivitas MEDIUM, kandidat berlabel)', '',
    'MFE = pergerakan menguntungkan maksimum, MAE = pergerakan merugikan maksimum sejak close deteksi sampai keluar (ATR deteksi dan % harga).',
    'Pada SUCCESS MFE dibatasi di target (2 ATR); pada FAIL MFE candle keluar diabaikan (urutan intrabar ambigu).', '',
    ...table(['TF', 'Skenario', 'MFE (ATR) median (Q1–Q3)', 'MAE (ATR)', 'MFE (%)', 'MAE (%)'], medium.map((g) => [
      g.timeframe, g.label ?? g.scenario, fmtQ(g.mfeAtr, 2), fmtQ(g.maeAtr, 2), fmtQpct(g.mfePct), fmtQpct(g.maePct),
    ])), '');

  lines.push('## Lead deteksi (sensitivitas MEDIUM)', '',
    'Lead vs mesin lama = indeks sinyal lama pertama (QUIET/EARLY_BULLISH) − indeks deteksi (positif = Reversal Radar lebih awal): "kandidat pertama" =',
    'kandidat pertama tiap seri (siapa lebih dulu menandai simbol; dipakai target §10), "semua kandidat" = termasuk kandidat lanjutan (wajar negatif);',
    'vs alert lama = terhadap state alert lama pertama (kandidat pertama); vs breakout = candle sampai close pertama di atas level pemicu saat deteksi (dalam horizon);',
    'ke pemicu = candle sampai bukti TRIGGER_BREAK pertama; ke CONFIRMED = candle sampai tahap CONFIRMED_BREAKOUT. Format: median (Q1–Q3), n.', '',
    ...table(['TF', 'Skenario', 'vs mesin lama — kandidat pertama', 'vs mesin lama — semua kandidat', 'vs alert lama — kandidat pertama', 'vs breakout', 'ke pemicu', 'ke CONFIRMED'], medium.map((g) => [
      g.timeframe, g.label ?? g.scenario, fmtQ(g.leadVsOldFirst, 0), fmtQ(g.leadVsOld, 0), fmtQ(g.leadVsOldAlertFirst, 0), fmtQ(g.leadVsBreakout, 0), fmtQ(g.barsToTrigger, 0), fmtQ(g.barsToConfirmed, 0),
    ])), '');

  lines.push('## Lead per peristiwa (padanan sinyal lama terdekat ±horizon)', '',
    `Untuk tiap kandidat (sensitivitas MEDIUM): indeks mulai sinyal lama (QUIET/EARLY_BULLISH) TERDEKAT dalam ±${meta.horizonBars ?? '—'} candle dari deteksi − indeks deteksi`,
    '(positif = Reversal Radar lebih awal; bila sama dekat dipilih yang sesudah deteksi). Berbeda dengan "vs mesin lama — semua kandidat" (sinyal lama PERTAMA seri),',
    'yang hanya bermakna pada seri satu-peristiwa (sintetis); pada data nyata multi-peristiwa pakai tabel ini. Tanpa padanan = tidak ada sinyal lama dalam jendela.', '',
    ...table(['TF', 'Skenario', 'Kandidat', 'Berpadanan', 'Tanpa padanan', 'Lead median (Q1–Q3)', 'Lead > 0 (dari yang berpadanan)'], medium.map((g) => [
      g.timeframe, g.label ?? g.scenario, String(g.candidates), fmtRate(g.leadVsOldNearestMatched), String(g.candidates - (g.leadVsOldNearestMatched?.k ?? 0)),
      fmtQ(g.leadVsOldNearest, 0), fmtRate(g.leadVsOldNearestPositive),
    ])), '');

  lines.push('## False positive (skenario yang seharusnya tanpa kandidat)', '',
    'Setiap kandidat pada skenario ini dihitung sebagai false positive; kolom terlambat = kandidat yang saat deteksi sudah LATE_ENTRY/EXTENDED.', '',
    ...table(['TF', 'Skenario', 'Sens.', 'Seri', 'Kandidat (FP)', 'FP/seri', 'Seri berkandidat', 'Terlambat saat deteksi'], (result.falsePositives ?? []).map((g) => [
      g.timeframe, g.scenario, g.sensitivity, String(g.series), String(g.candidates), fmtNumber(g.perSeries.mean, 2), fmtRate(g.seriesWithCandidate), fmtRate(g.extendedAtDetection),
    ])), '');

  lines.push('## Perbandingan mesin lama (SA/PVA) vs Reversal Radar (sensitivitas HIGH = semua kandidat)', '',
    ...table(['TF', 'Skenario', 'Seri', 'Seri dengan sinyal lama', 'Sinyal lama (total)', 'Seri dengan kandidat baru', 'Kandidat baru (total)', 'Indeks pertama lama (median)', 'Indeks pertama baru (median)', 'Lead vs lama: kandidat pertama (median)', 'Lead vs lama: semua kandidat (median)'],
      (result.comparison ?? []).map((c) => [
        c.timeframe, c.scenario, String(c.series), c.old.enabled ? fmtRate(c.old.seriesWithSignal) : 'pembanding mati', c.old.enabled ? String(c.old.signals) : '—',
        fmtRate(c.radar.seriesWithCandidate), String(c.radar.candidates), fmtNumber(c.old.firstIndexMedian, 0), fmtNumber(c.radar.firstIndexMedian, 0),
        fmtLead(c.leadVsOldFirst), fmtLead(c.leadVsOld),
      ])), '');

  if (result.lookahead) {
    const la = result.lookahead;
    lines.push('## Uji anti-look-ahead (stabilitas prefiks)', '',
      `Seri diperiksa: ${la.checked ?? 0}; gagal: ${la.failures?.length ?? 0}.`, '');
    for (const f of la.failures ?? []) lines.push(`- ❌ ${f.symbol} ${f.timeframe}: ${f.message}`);
    if (!(la.failures?.length)) lines.push('- Semua seri yang diperiksa stabil: hasil pada prefiks tidak berubah saat candle masa depan ditambahkan.');
    lines.push('');
  }

  lines.push('## Glosarium', '',
    '- **SUCCESS/FAIL/TIMEOUT**: hasil triple barrier §10 dari close deteksi pertama; bukan hasil transaksi nyata (tanpa biaya, tanpa slippage).',
    '- **CI 95 %**: interval skor Wilson untuk proporsi; lebar = ketidakpastian tinggi.',
    '- **Batal/Kedaluwarsa**: kandidat ditutup CANCELLED (close < invalidasi, breakout gagal) / EXPIRED (tanpa kemajuan atau bukti melemah) — terpisah dari hasil harga.',
    '- **CONFIRMED sesaat**: kandidat mencapai CONFIRMED_BREAKOUT lalu ditutup BREAKOUT_FAILED (close < pemicu − failedBreakAtr × ATR).',
    '- **Lead**: selisih candle; positif = Reversal Radar lebih awal. "Kandidat pertama" = kandidat pertama tiap seri vs sinyal lama pertama.',
    '- **Lead vs lama — semua kandidat**: setiap kandidat vs sinyal lama PERTAMA seri — hanya bermakna pada seri satu-peristiwa (sintetis); pada data nyata',
    '  multi-peristiwa kandidat lanjutan wajar bernilai sangat negatif. Pakai **lead per peristiwa** = sinyal lama terdekat dalam ±horizon dari tiap deteksi.',
    '- **Jarak stop s**: (close deteksi − level invalidasi saat deteksi) / ATR deteksi — risiko awal kandidat dalam ATR.',
    '- **Basis acak RW**: rata-rata s / (target + s) — peluang random walk tanpa drift mencapai +target × ATR sebelum −s × ATR (tanpa batas waktu).',
    '- **Basis acak empiris**: K indeks acak berbenih per kandidat berlabel pada seri yang sama (setelah warm-up, sebelum n − horizon), dilabeli dengan aturan',
    '  triple barrier yang sama memakai ATR di indeks itu; SUCCESS k/n gabungan = rasio SUCCESS tanpa keterampilan pada pasar & penghalang yang sama.',
    '- **Breakout gagal sebelum target**: kandidat BREAKOUT_FAILED berlabel dengan MFE < target × ATR (gagal tanpa pernah mencapai target).',
    '- **Terlambat saat deteksi**: kandidat yang saat deteksi pertama sudah membawa risiko LATE_ENTRY/EXTENDED.',
    '- **Sensitivitas**: filter tampilan skor/bukti minimum; mesin selalu mengevaluasi pada ambang HIGH.',
    '');
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** Proporsi ringkas tanpa CI untuk tabel padat (n = 0 → "—"). */
function fmtShare(r) {
  return r && isNum(r.n) && r.n > 0 ? fmtPct(r.p, 0) : '—';
}

/** Kuantil dalam persen (nilai pecahan → %). */
function fmtQpct(q) {
  if (!q || q.n === 0) return '— (n = 0)';
  return `${fmtPct(q.median, 2)} (${fmtPct(q.q1, 2)}–${fmtPct(q.q3, 2)}), n = ${q.n}`;
}

/** Ringkasan singkat untuk stdout CLI (sensitivitas MEDIUM + target §10). */
export function renderReplaySummary(result) {
  const lines = [`Replay Reversal Radar — ${result.totals?.series ?? 0} seri, ${result.totals?.evaluations ?? 0} evaluasi, ${result.totals?.candidates ?? 0} kandidat (sumber: ${result.meta?.source ?? '—'})`];
  for (const g of (result.groups ?? []).filter((x) => x.sensitivity === 'MEDIUM')) {
    const lead = g.leadVsOldFirst.n ? `lead kandidat pertama vs lama med. ${fmtSigned(g.leadVsOldFirst.median)} (n = ${g.leadVsOldFirst.n})` : 'lead vs lama —';
    const nearest = g.leadVsOldNearest?.n ? `lead per peristiwa med. ${fmtSigned(g.leadVsOldNearest.median)} (n = ${g.leadVsOldNearest.n})` : 'lead per peristiwa —';
    lines.push(`  ${g.timeframe.padEnd(3)} ${g.scenario.padEnd(20)} seri ${String(g.series).padStart(3)} · kandidat ${String(g.candidates).padStart(3)} (${fmtNumber(g.perSeries.mean, 2)}/seri) · SUCCESS ${fmtRate(g.outcomes.success)} · FAIL ${fmtRate(g.outcomes.fail)} · TIMEOUT ${fmtRate(g.outcomes.timeout)} · basis empiris ${fmtRate(g.baselineShuffled)} · ${lead} · ${nearest}`);
  }
  for (const t of result.targets ?? []) lines.push(`  [§10] ${t.timeframe} ${t.text}: ${STATUS_LABEL[t.status]}${t.status === 'TANPA_DATA' ? '' : ` (${targetValue(t)})`}${t.smallSample ? ' — sampel terlalu kecil' : ''}`);
  for (const w of result.warnings ?? []) lines.push(`  ⚠️ ${w.replace(/\*\*/g, '')}`);
  return `${lines.join('\n')}\n`;
}
