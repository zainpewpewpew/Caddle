// Render laporan backtest (Markdown, bahasa Indonesia) dari objek hasil runner. Fungsi murni: tanpa I/O,
// tanpa Date.now() — stempel waktu diambil dari result.meta. Laporan memisahkan tegas in-sample (train)
// dan out-of-sample (test), dan menambahkan peringatan kejujuran otomatis.

/**
 * Ringkasan hasil trade (lihat backend/backtest/metrics.js summarize).
 * @typedef {object} Summary
 * @property {number} n
 * @property {number} [wins]
 * @property {number} [losses]
 * @property {number} [timeouts]
 * @property {number|null} winRate          0..1
 * @property {[number, number]|null} winRateCi  interval Wilson 95% (0..1)
 * @property {number|null} expectancyR
 * @property {number|null} profitFactor     Infinity bila tanpa kerugian
 * @property {number|null} [avgMfeR]
 * @property {number|null} [avgMaeR]
 */

/**
 * Sepasang ringkasan in-sample/out-of-sample.
 * @typedef {{ train?: Summary|null, test?: Summary|null }} SplitSummary
 */

/**
 * Satu sel tabel arah × timeframe × tier.
 * @typedef {{ direction: 'LONG'|'SHORT', timeframe: string, tier?: string|null, train?: Summary|null, test?: Summary|null }} GroupRow
 */

/**
 * Kalibrasi skor → peluang menang, dievaluasi pada data out-of-sample.
 * @typedef {object} CalibrationReport
 * @property {Array<{ lower?: number, upper?: number, n: number, predicted?: number, observed?: number,
 *                    meanScore?: number, ci?: [number, number] }>} [bins]  diagram reliabilitas
 * @property {number|null} [ece]     expected calibration error (0..1)
 * @property {number|null} [brier]   Brier score (0..1, lebih kecil lebih baik)
 * @property {number|null} [brierBaseline]  Brier bila selalu memprediksi base rate
 * @property {'train'|'test'} [sample]   default 'test'
 * @property {object} [table]  tabel hasil fitCalibration (untuk config/calibration.json)
 */

/**
 * Hasil satu varian strategi.
 * @typedef {object} VariantResult
 * @property {string} [label]        nama tampilan, mis. 'Sebelum — pola v2 saja'
 * @property {string} [description]
 * @property {Summary|null} trainSummary   in-sample
 * @property {Summary|null} testSummary    out-of-sample (walk-forward)
 * @property {Record<string, SplitSummary>} [byTier]       kunci 'A'|'B'|'C'|'D'
 * @property {Record<string, SplitSummary>} [byDirection]  kunci 'LONG'|'SHORT'
 * @property {GroupRow[]} [byGroup]                        tabel arah × timeframe × tier
 * @property {CalibrationReport|null} [calibration]
 */

/**
 * Objek hasil runner (backend/backtest/runner.js runBacktest).
 * @typedef {object} BacktestResult
 * @property {{
 *   generatedAt?: number|string, source?: 'binance'|'csv'|'synthetic', symbols?: string[], timeframes?: string[],
 *   from?: number|string, to?: number|string, targetR?: number, maxBars?: number, folds?: number, embargoBars?: number,
 *   seed?: number, baseline?: string, candidate?: string, notes?: string[],
 * }} meta  baseline/candidate = nama varian pembanding (default 'v2' dan 'v3')
 * @property {Record<string, VariantResult>} variants
 */

/** Ambang peringatan kejujuran. */
export const REPORT_THRESHOLDS = Object.freeze({
  minSample: 30,          // n < 30 → sampel terlalu kecil
  maxCiWidth: 0.2,        // lebar CI Wilson > 20 poin persen → CI lebar
  overfitGap: 0.1,        // win rate train − test > 10 poin → indikasi overfitting
  maxEce: 0.1,            // ECE > 10% → kalibrasi buruk
});

const DIRECTION_ORDER = Object.freeze(['LONG', 'SHORT']);
const TIER_ORDER = Object.freeze(['A', 'B', 'C', 'D']);

const isNum = (v) => typeof v === 'number' && !Number.isNaN(v);
const comma = (s) => s.replace('.', ',');

/** Angka desimal gaya Indonesia (koma desimal); '—' bila tidak ada. */
export function fmtNumber(v, digits = 2) {
  if (v === Infinity) return '∞';
  if (v === -Infinity) return '−∞';
  if (!isNum(v)) return '—';
  return comma(v.toFixed(digits)).replace(/^-/, '−');
}

/** Persentase dari pecahan 0..1. */
export function fmtPct(v, digits = 1) {
  return isNum(v) ? `${fmtNumber(v * 100, digits)}%` : '—';
}

function fmtR(v) {
  if (!isNum(v)) return '—';
  return `${v > 0 ? '+' : ''}${fmtNumber(v, 2)}R`;
}

function fmtCi(ci) {
  return Array.isArray(ci) && isNum(ci[0]) && isNum(ci[1]) ? `${fmtNumber(ci[0] * 100, 1)}–${fmtNumber(ci[1] * 100, 1)}%` : '—';
}

function fmtDate(v) {
  if (v === undefined || v === null || v === '') return '—';
  const d = new Date(typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC').replace(' 00:00:00 UTC', '');
}

/** Teks Markdown aman untuk sel tabel (tanpa '|' dan baris baru). */
function cell(v) {
  return String(v ?? '—').replace(/\|/g, '/').replace(/\r?\n/g, ' ');
}

function row(values) {
  return `| ${values.map(cell).join(' | ')} |`;
}

function table(headers, rows) {
  if (rows.length === 0) return ['_Tidak ada data._'];
  return [row(headers), row(headers.map(() => '---')), ...rows.map(row)];
}

/** Catatan kejujuran per ringkasan (dipakai di kolom "Catatan" & daftar peringatan). */
function sampleFlags(s, t = REPORT_THRESHOLDS) {
  if (!s) return [];
  const flags = [];
  if (!isNum(s.n) || s.n < t.minSample) flags.push('sampel terlalu kecil');
  const ci = s.winRateCi;
  if (Array.isArray(ci) && isNum(ci[0]) && isNum(ci[1]) && ci[1] - ci[0] > t.maxCiWidth) flags.push('CI lebar');
  return flags;
}

const SUMMARY_HEADERS = Object.freeze(['n', 'Win rate', 'CI 95% (Wilson)', 'Expectancy', 'Profit factor', 'MFE rata²', 'MAE rata²', 'W/L/T']);

function summaryCells(s) {
  if (!s) return SUMMARY_HEADERS.map(() => '—');
  const wlt = [s.wins, s.losses, s.timeouts].every(isNum) ? `${s.wins}/${s.losses}/${s.timeouts}` : '—';
  return [
    isNum(s.n) ? String(s.n) : '—', fmtPct(s.winRate), fmtCi(s.winRateCi), fmtR(s.expectancyR),
    fmtNumber(s.profitFactor), fmtR(s.avgMfeR), fmtR(s.avgMaeR), wlt,
  ];
}

const SAMPLE_LABEL = Object.freeze({ train: 'In-sample (train)', test: 'Out-of-sample (test)' });

function sortKeys(keys, order) {
  return [...keys].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia !== ib) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function splitTable(firstHeader, map, order) {
  const rows = [];
  for (const key of sortKeys(Object.keys(map ?? {}), order)) {
    for (const sample of ['test', 'train']) {
      const s = map[key]?.[sample];
      if (!s) continue;
      rows.push([key, SAMPLE_LABEL[sample], ...summaryCells(s), sampleFlags(s).join(', ') || '—']);
    }
  }
  return table([firstHeader, 'Sampel', ...SUMMARY_HEADERS, 'Catatan'], rows);
}

function groupTable(groups) {
  const sorted = [...(groups ?? [])].sort((a, b) => (
    (DIRECTION_ORDER.indexOf(a.direction) - DIRECTION_ORDER.indexOf(b.direction))
    || String(a.timeframe).localeCompare(String(b.timeframe), 'en', { numeric: true })
    || (TIER_ORDER.indexOf(a.tier ?? '') - TIER_ORDER.indexOf(b.tier ?? ''))
  ));
  const rows = [];
  for (const g of sorted) {
    for (const sample of ['test', 'train']) {
      const s = g[sample];
      if (!s) continue;
      rows.push([g.direction, g.timeframe, g.tier ?? 'semua', SAMPLE_LABEL[sample], ...summaryCells(s), sampleFlags(s).join(', ') || '—']);
    }
  }
  return table(['Arah', 'TF', 'Tier', 'Sampel', ...SUMMARY_HEADERS, 'Catatan'], rows);
}

function delta(a, b, fmt) {
  if (!isNum(a) || !isNum(b) || !Number.isFinite(a) || !Number.isFinite(b)) return '—';
  const d = b - a;
  return `${d > 0 ? '+' : ''}${fmt(d)}`;
}

function comparisonSection(result, baselineName, candidateName) {
  const base = result.variants?.[baselineName];
  const cand = result.variants?.[candidateName];
  const lines = ['## Perbandingan sebelum vs sesudah', ''];
  if (!base || !cand) {
    lines.push(`_Perbandingan tidak tersedia: varian "${baselineName}" dan/atau "${candidateName}" tidak ada di hasil._`, '');
    return lines;
  }
  const baseLabel = base.label ?? 'Sebelum — pola v2 saja';
  const candLabel = cand.label ?? 'Sesudah — v3 confluence tier A/B';
  lines.push(
    `- **Sebelum**: ${baseLabel} (\`${baselineName}\`)`,
    `- **Sesudah**: ${candLabel} (\`${candidateName}\`)`,
    '',
    'Penilaian utama memakai **out-of-sample**; in-sample hanya pembanding untuk mendeteksi overfitting.',
    '',
  );
  const rows = [];
  for (const sample of ['test', 'train']) {
    const key = sample === 'test' ? 'testSummary' : 'trainSummary';
    const a = base[key];
    const b = cand[key];
    if (!a && !b) continue;
    rows.push([SAMPLE_LABEL[sample], 'Sebelum', ...summaryCells(a).slice(0, 5), '—']);
    rows.push([SAMPLE_LABEL[sample], 'Sesudah', ...summaryCells(b).slice(0, 5), [
      `WR ${delta(a?.winRate, b?.winRate, (d) => `${fmtNumber(d * 100, 1)} pp`)}`,
      `E ${delta(a?.expectancyR, b?.expectancyR, (d) => `${fmtNumber(d, 2)}R`)}`,
    ].join('; ')]);
  }
  lines.push(...table(['Sampel', 'Varian', ...SUMMARY_HEADERS.slice(0, 5), 'Selisih (sesudah − sebelum)'], rows), '');
  const a = base.testSummary;
  const b = cand.testSummary;
  if (a && b && Array.isArray(a.winRateCi) && Array.isArray(b.winRateCi)) {
    const overlap = b.winRateCi[0] <= a.winRateCi[1] && a.winRateCi[0] <= b.winRateCi[1];
    lines.push(overlap
      ? '> Interval kepercayaan win rate out-of-sample kedua varian **beririsan** — perbedaan belum dapat dianggap signifikan secara statistik.'
      : '> Interval kepercayaan win rate out-of-sample kedua varian **tidak beririsan** — perbedaan cukup kuat pada data ini (tetap bukan jaminan masa depan).', '');
  }
  return lines;
}

function calibrationSection(name, variant) {
  const cal = variant?.calibration;
  if (!cal) return [];
  const sample = cal.sample ?? 'test';
  const lines = [`### Kalibrasi — ${variant.label ?? name} (${SAMPLE_LABEL[sample] ?? sample})`, ''];
  const metrics = [`ECE: **${fmtPct(cal.ece)}**`, `Brier: **${fmtNumber(cal.brier, 4)}**`];
  if (isNum(cal.brierBaseline)) metrics.push(`Brier baseline (base rate): ${fmtNumber(cal.brierBaseline, 4)}`);
  lines.push(metrics.join(' · '), '');
  const bins = Array.isArray(cal.bins) ? cal.bins : [];
  const rows = bins.map((b) => {
    const range = isNum(b.lower) && isNum(b.upper) ? `${fmtNumber(b.lower, 0)}–${fmtNumber(b.upper, 0)}` : (isNum(b.meanScore) ? `≈${fmtNumber(b.meanScore, 0)}` : '—');
    const gap = isNum(b.predicted) && isNum(b.observed) ? `${fmtNumber((b.observed - b.predicted) * 100, 1)} pp` : '—';
    return [range, isNum(b.n) ? String(b.n) : '—', fmtPct(b.predicted), fmtPct(b.observed), fmtCi(b.ci), gap, isNum(b.n) && b.n < REPORT_THRESHOLDS.minSample ? 'sampel terlalu kecil' : '—'];
  });
  lines.push('Diagram reliabilitas (prediksi vs realisasi per bin skor):', '');
  lines.push(...table(['Bin skor', 'n', 'Prediksi', 'Realisasi', 'CI 95%', 'Selisih', 'Catatan'], rows), '');
  return lines;
}

const MODEL_LABEL = Object.freeze({
  base: 'Base rate (selalu menebak rata-rata train)',
  isotonic: 'Kalibrasi isotonik skor konfluensi (yang dipakai sekarang)',
  logistic: 'Regresi logistik L2 (ML)',
  gbdt: 'Gradient boosting pohon dangkal (ML)',
  logisticShuffled: 'Kontrol: logistik, label train diacak',
  gbdtShuffled: 'Kontrol: gradient boosting, label train diacak',
});

/**
 * Bagian lab meta-labeling ML (result.ml dari backend/ml/evaluate.js). Kosong bila backtest tanpa --ml.
 * @param {object|null|undefined} ml
 * @returns {string[]}
 */
export function mlSection(ml, meta = {}) {
  if (!ml || typeof ml !== 'object') return [];
  const lines = ['## Lab meta-labeling (machine learning)', '',
    '> Model sekunder memprediksi peluang sinyal scanner berakhir untung neto (R > 0 setelah fee & slippage) dari fitur '
    + 'saat entri. Dievaluasi walk-forward '
    + `${ml.options?.folds ?? '—'} fold dengan embargo + purging; praproses & model dilatih hanya dari train. `
    + 'Hasil ini TIDAK dipakai scanner live; lihat docs/16-riset-machine-learning.md.', ''];
  if (meta?.source === 'synthetic') {
    lines.push('> ⚠️ **Data sintetis.** Generator menanam pola (akumulasi → markup dengan taker buy tinggi) yang sengaja dapat '
      + 'dipelajari; skor ML di sini hanya membuktikan mekanisme bekerja, BUKAN akurasi di pasar nyata.', '');
  }
  const v = ml.verdict;
  if (v) {
    lines.push(v.adopted
      ? `**Keputusan: model \`${v.model}\` LOLOS aturan adopsi** (masih perlu konfirmasi pada periode data baru sebelum dipakai live).`
      : '**Keputusan: ML TIDAK diadopsi — tetap pakai kalibrasi skor konfluensi.**', '');
    if (v.leakageSuspected) lines.push('- ⚠️ Kontrol label acak menunjukkan skill — hasil tidak sah, periksa kebocoran data.');
    lines.push(...(v.reasons ?? []).map((r) => `- ${r}`), '');
  }
  lines.push(`Sampel trade selesai: ${ml.samples ?? 0}.`, '');
  const models = { ...(ml.models ?? {}), ...(ml.controls ?? {}) };
  if (Object.keys(models).length) {
    lines.push('### Kualitas peluang out-of-sample', '',
      'Log-loss & Brier makin kecil makin baik. Skill = 1 − log-loss / log-loss base rate (≤ 0 = tidak berguna). AUC 0,5 = acak.', '');
    lines.push(...table(['Model', 'n uji', 'Log-loss', 'Brier', 'AUC', 'Skill'], Object.entries(models).map(([name, m]) => [
      MODEL_LABEL[name] ?? name, isNum(m.n) ? String(m.n) : '—', fmtNumber(m.logLoss, 4), fmtNumber(m.brier, 4), fmtNumber(m.auc, 3), fmtPct(m.skill, 2),
    ])), '');
  }
  if (Array.isArray(ml.folds) && ml.folds.length) {
    lines.push('### Per fold (log-loss uji)', '');
    lines.push(...table(['Fold', 'Mulai uji', 'n train', 'n uji', 'Base rate', 'Base', 'Isotonik', 'Logistik', 'GBDT'], ml.folds.map((f) => [
      String(f.fold + 1), fmtDate(f.testStart), String(f.train), String(f.test), fmtPct(f.baseRate),
      fmtNumber(f.logLoss?.base, 4), fmtNumber(f.logLoss?.isotonic, 4), fmtNumber(f.logLoss?.logistic, 4), fmtNumber(f.logLoss?.gbdt, 4),
    ])), '');
  }
  const cmp = ml.comparison ?? {};
  const cmpRows = Object.entries(cmp).filter(([, b]) => b).map(([name, b]) => [
    MODEL_LABEL[name] ?? name, fmtNumber(b.mean, 5), `${fmtNumber(b.lower, 5)} … ${fmtNumber(b.upper, 5)}`, String(b.blocks),
  ]);
  if (cmpRows.length) {
    lines.push('### Perbaikan log-loss vs kalibrasi isotonik (bootstrap blok per hari)', '',
      'Positif = ML lebih baik. Bila interval mencakup 0, perbaikan tidak signifikan.', '');
    lines.push(...table(['Model', 'Rata-rata', 'Interval 95%', 'Hari (blok)'], cmpRows), '');
  }
  const eco = ml.economics ?? {};
  const ecoRows = ['isotonic', 'logistic', 'gbdt'].filter((k) => eco[k]).map((k) => {
    const e = eco[k];
    const ci = (b) => (b ? `${fmtR(b.mean)} (${fmtR(b.lower)} … ${fmtR(b.upper)})` : '—');
    return [MODEL_LABEL[k], ci(e.selected), ci(e.lift), ci(e.vsIsotonic)];
  });
  if (ecoRows.length) {
    lines.push('### Bukti ekonomi (bootstrap blok per hari, interval 95%)', '',
      'Peluang yang lebih tajam belum tentu menghasilkan uang. ML hanya layak bila seleksinya menaikkan expectancy R neto.', '');
    lines.push(...table(['Seleksi', 'Expectancy seleksi', 'Lift vs semua sinyal', 'Selisih vs seleksi isotonik'], ecoRows), '');
  }
  const sel = ml.selection;
  if (sel) {
    lines.push(`### Seleksi ${fmtPct(sel.fraction, 0)} sinyal teratas (ambang dari train, diterapkan ke uji)`, '');
    lines.push(...table(['Pilihan', ...SUMMARY_HEADERS], [
      ['Semua sinyal uji', ...summaryCells(sel.all)],
      ...['isotonic', 'logistic', 'gbdt'].filter((k) => sel[k]).map((k) => [MODEL_LABEL[k], ...summaryCells(sel[k])]),
    ]), '');
  }
  if (Array.isArray(ml.coefficients) && ml.coefficients.length) {
    lines.push('### Fitur paling berpengaruh (koefisien logistik terstandar, seluruh data — penjelasan saja)', '');
    lines.push(...table(['Fitur', 'Bobot'], ml.coefficients.slice(0, 10).map((c) => [c.name, fmtNumber(c.weight, 3)])), '');
  }
  return lines;
}

/**
 * Kumpulkan peringatan kejujuran otomatis untuk seluruh hasil.
 * @param {BacktestResult} result
 * @returns {string[]}
 */
export function collectWarnings(result, t = REPORT_THRESHOLDS) {
  const warnings = [];
  const meta = result?.meta ?? {};
  if (meta.source === 'synthetic') {
    warnings.push('Data **sintetis**: hasil hanya membuktikan mekanisme (tanpa lookahead, metrik benar), BUKAN akurasi pasar nyata.');
  }
  for (const [name, v] of Object.entries(result?.variants ?? {})) {
    const label = v.label ?? name;
    if (!v.testSummary || !isNum(v.testSummary.n) || v.testSummary.n === 0) {
      warnings.push(`${label}: tidak ada hasil out-of-sample — angka in-sample saja tidak boleh dipakai sebagai klaim akurasi.`);
    } else {
      const flags = sampleFlags(v.testSummary, t);
      if (flags.includes('sampel terlalu kecil')) warnings.push(`${label}: out-of-sample n = ${v.testSummary.n} < ${t.minSample} — sampel terlalu kecil untuk kesimpulan.`);
      if (flags.includes('CI lebar')) warnings.push(`${label}: CI 95% win rate out-of-sample lebar (${fmtCi(v.testSummary.winRateCi)}) — ketidakpastian tinggi.`);
    }
    const tr = v.trainSummary?.winRate;
    const te = v.testSummary?.winRate;
    if (isNum(tr) && isNum(te) && tr - te > t.overfitGap) {
      warnings.push(`${label}: win rate in-sample ${fmtPct(tr)} jauh di atas out-of-sample ${fmtPct(te)} — indikasi overfitting.`);
    }
    const smallGroups = [
      ...Object.entries(v.byTier ?? {}).map(([k, s]) => [`tier ${k}`, s?.test]),
      ...Object.entries(v.byDirection ?? {}).map(([k, s]) => [k, s?.test]),
    ].filter(([, s]) => s && isNum(s.n) && s.n < t.minSample).map(([k]) => k);
    if (smallGroups.length) warnings.push(`${label}: sampel terlalu kecil (n < ${t.minSample}) pada ${smallGroups.join(', ')}.`);
    const cal = v.calibration;
    if (cal && isNum(cal.ece) && cal.ece > t.maxEce) warnings.push(`${label}: ECE ${fmtPct(cal.ece)} > ${fmtPct(t.maxEce)} — skor belum terkalibrasi baik; jangan tampilkan sebagai peluang.`);
    if (cal && (cal.sample ?? 'test') !== 'test') warnings.push(`${label}: kalibrasi dievaluasi in-sample — angka reliabilitas optimistis.`);
  }
  return warnings;
}

/**
 * Render laporan Markdown.
 * @param {BacktestResult} result
 * @returns {string}
 */
export function renderMarkdownReport(result) {
  if (!result || typeof result !== 'object' || !result.variants || typeof result.variants !== 'object') {
    throw new TypeError('Hasil backtest wajib berbentuk { meta, variants }');
  }
  const meta = result.meta ?? {};
  const baselineName = meta.baseline ?? 'v2';
  const candidateName = meta.candidate ?? 'v3';
  const lines = [
    '# Laporan Backtest AlphaLens',
    '',
    '> Riset saja — bukan nasihat keuangan. Skor/tier adalah aturan yang dapat dijelaskan, bukan probabilitas;',
    '> peluang hanya sah bila berasal dari kalibrasi out-of-sample dengan sampel memadai dan selalu disertai interval.',
    '',
    '## Parameter',
    '',
    `- Dibuat: ${fmtDate(meta.generatedAt)}`,
    `- Sumber data: ${meta.source ?? '—'}`,
    `- Simbol: ${Array.isArray(meta.symbols) && meta.symbols.length ? meta.symbols.join(', ') : '—'}`,
    `- Timeframe: ${Array.isArray(meta.timeframes) && meta.timeframes.length ? meta.timeframes.join(', ') : '—'}`,
    `- Rentang: ${fmtDate(meta.from)} → ${fmtDate(meta.to)}`,
    `- Target: ${isNum(meta.targetR) ? `${fmtNumber(meta.targetR, 1)}R` : '—'} · batas waktu ${isNum(meta.maxBars) ? `${meta.maxBars} candle` : '—'} · TP & SL di candle yang sama = LOSS (konservatif)`,
    typeof meta.validation === 'string'
      ? `- Validasi: ${meta.validation}`
      : `- Validasi: walk-forward ${isNum(meta.folds) ? `${meta.folds} fold` : '—'}, embargo ${isNum(meta.embargoBars) ? `${meta.embargoBars} candle` : '—'}`,
  ];
  if (isNum(meta.seed)) lines.push(`- Seed: ${meta.seed}`);
  for (const note of meta.notes ?? []) lines.push(`- Catatan: ${note}`);
  lines.push('');

  const warnings = collectWarnings(result);
  lines.push('## Peringatan kejujuran', '');
  if (warnings.length) lines.push(...warnings.map((w) => `- ⚠️ ${w}`));
  else lines.push('- Tidak ada peringatan otomatis. Tetap ingat: kinerja masa lalu tidak menjamin hasil masa depan.');
  lines.push('');

  lines.push(...comparisonSection(result, baselineName, candidateName));

  const names = Object.keys(result.variants);
  const ordered = [...names.filter((n) => n === baselineName), ...names.filter((n) => n === candidateName), ...names.filter((n) => n !== baselineName && n !== candidateName)];
  for (const name of ordered) {
    const v = result.variants[name];
    lines.push(`## Varian: ${v.label ?? name}`, '');
    if (v.description) lines.push(v.description, '');
    lines.push('### Ringkasan', '');
    lines.push(...table(['Sampel', ...SUMMARY_HEADERS, 'Catatan'], [
      ['Out-of-sample (test)', ...summaryCells(v.testSummary), sampleFlags(v.testSummary).join(', ') || '—'],
      ['In-sample (train)', ...summaryCells(v.trainSummary), sampleFlags(v.trainSummary).join(', ') || '—'],
    ]), '');
    if (Array.isArray(v.byGroup) && v.byGroup.length) {
      lines.push('### Per arah × timeframe × tier', '', ...groupTable(v.byGroup), '');
    }
    if (v.byDirection && Object.keys(v.byDirection).length) {
      lines.push('### Per arah', '', ...splitTable('Arah', v.byDirection, DIRECTION_ORDER), '');
    }
    if (v.byTier && Object.keys(v.byTier).length) {
      lines.push('### Per tier', '', ...splitTable('Tier', v.byTier, TIER_ORDER), '');
    }
  }

  const calLines = ordered.flatMap((name) => calibrationSection(name, result.variants[name]));
  lines.push('## Kalibrasi', '');
  if (calLines.length) {
    lines.push('ECE = rata-rata selisih |prediksi − realisasi| berbobot jumlah sampel; Brier = rata-rata (p − hasil)². Keduanya makin kecil makin baik.', '');
    lines.push(...calLines);
  } else {
    lines.push('_Tidak ada data kalibrasi._', '');
  }

  lines.push(...mlSection(result.ml, meta));

  lines.push('## Glosarium', '',
    '- **Win rate**: proporsi trade yang berakhir WIN (TP tersentuh). CI 95% memakai interval skor Wilson.',
    '- **Expectancy (R)**: rata-rata hasil per trade dalam kelipatan risiko awal (1R = jarak entry ke stop).',
    '- **Profit factor**: total R menang / total R kalah (∞ bila tidak ada kerugian).',
    '- **MFE/MAE**: pergerakan menguntungkan/merugikan maksimum selama trade, dalam R.',
    '- **In-sample (train)** dipakai untuk menyetel; **out-of-sample (test)** adalah data yang tidak dilihat saat menyetel.',
    '');
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}
