// Skor & penjelasan sinyal. Fungsi murni.
//
// Prinsip:
// - Skor (0..100) adalah ukuran kualitas pola dari detektor, BUKAN probabilitas.
// - Setiap skor dapat dijelaskan: entri `PATTERN:*` dijumlahkan = patternScore,
//   entri `EARLY:*` dijumlahkan = earlyScore. Entri `CONTEXT:*` dan `RISK:*` informatif
//   (kontribusi 0) — konteks HTF & risiko tidak mengubah skor, hanya diberi label/flag.
// - Pemilihan skor menurut klasifikasi:
//     SA → hasil SA, PVA → hasil PVA, BOTH → maksimum SA/PVA (patternScore & earlyScore
//     dipilih terpisah), NONE → maksimum hasil yang tersedia (diagnostik; bukan sinyal).

import { ALIGNMENTS, CLASSIFICATIONS, RISK_FLAGS } from '../market/contracts.js';
import { DEFAULT_SCANNER_SETTINGS } from '../settings/scannerSettings.js';

export const DEFAULT_VIEW_PARAMS = Object.freeze({
  minQuoteVolume24h: DEFAULT_SCANNER_SETTINGS.liquidity.minQuoteVolume24h,
  maxSpreadBps: DEFAULT_SCANNER_SETTINGS.liquidity.maxSpreadBps,
});

const EPS = 1e-9;

function resolveViewParams(overrides = {}) {
  if (overrides === null || typeof overrides !== 'object') throw new TypeError('Parameter view harus objek');
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(DEFAULT_VIEW_PARAMS, key)) throw new TypeError(`Parameter view tidak dikenal: ${key}`);
  }
  const p = { ...DEFAULT_VIEW_PARAMS, ...overrides };
  for (const [key, v] of Object.entries(p)) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new RangeError(`${key} harus angka ≥ 0`);
  }
  return p;
}

const clampScore = (v) => Math.min(100, Math.max(0, v));

function assertScore(r, key) {
  if (typeof r[key] !== 'number' || !Number.isFinite(r[key])) throw new TypeError(`${r.pattern}.${key} harus angka`);
}

/**
 * Hasil pola yang relevan dengan klasifikasi (urutan SA lalu PVA).
 * @returns {object[]} PatternResult
 */
export function relevantResults(patterns) {
  if (patterns === null || typeof patterns !== 'object') throw new TypeError('patterns harus objek { classification, sa, pva }');
  const { classification, sa, pva } = patterns;
  if (!CLASSIFICATIONS.includes(classification)) throw new RangeError(`Klasifikasi tidak dikenal: ${classification}`);
  const need = { SA: ['SA'], PVA: ['PVA'], BOTH: ['SA', 'PVA'], NONE: [] }[classification];
  for (const key of need) {
    const r = key === 'SA' ? sa : pva;
    if (!r || typeof r !== 'object') throw new TypeError(`Hasil pola ${key} wajib ada untuk klasifikasi ${classification}`);
  }
  const list = classification === 'NONE' ? [sa, pva].filter((r) => r && typeof r === 'object') : need.map((k) => (k === 'SA' ? sa : pva));
  for (const r of list) { assertScore(r, 'patternScore'); assertScore(r, 'earlyScore'); }
  return list;
}

function best(list, key) {
  let top = null;
  for (const r of list) if (top === null || r[key] > top[key]) top = r; // seri → yang pertama (SA)
  return top;
}

/**
 * Memilih patternScore & earlyScore sesuai klasifikasi (lihat aturan di atas).
 * @returns {{ patternScore: number, earlyScore: number, patternSource: 'SA'|'PVA'|null, earlySource: 'SA'|'PVA'|null }}
 */
export function selectScores(patterns) {
  const list = relevantResults(patterns);
  const p = best(list, 'patternScore');
  const e = best(list, 'earlyScore');
  return {
    patternScore: p ? clampScore(p.patternScore) : 0,
    earlyScore: e ? clampScore(e.earlyScore) : 0,
    patternSource: p ? p.pattern : null,
    earlySource: e ? e.pattern : null,
  };
}

const fmt = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return String(Number(v.toPrecision(6)));
  if (v === null || v === undefined) return '–';
  return String(v);
};

function htfByTrend(context, baseTimeframe, trend) {
  const trends = context?.trends ?? {};
  return Object.keys(trends).filter((tf) => tf !== baseTimeframe && trends[tf]?.trend === trend);
}

/**
 * Risk flag gabungan (subset RISK_FLAGS, urutan kanonik RISK_FLAGS) beserta alasannya.
 * @returns {{ flags: string[], details: Map<string, string[]> }}
 */
export function collectRiskFlags({ patterns, timeframe, context, liquidity, dataQuality, params } = {}) {
  const p = resolveViewParams(params);
  const details = new Map();
  const add = (flag, detail) => {
    if (!RISK_FLAGS.includes(flag)) return; // flag di luar kontrak dibuang
    if (!details.has(flag)) details.set(flag, []);
    if (!details.get(flag).includes(detail)) details.get(flag).push(detail);
  };

  const byFlag = new Map();
  for (const r of relevantResults(patterns)) {
    for (const flag of Array.isArray(r.riskFlags) ? r.riskFlags : []) {
      if (!byFlag.has(flag)) byFlag.set(flag, []);
      if (!byFlag.get(flag).includes(r.pattern)) byFlag.get(flag).push(r.pattern);
    }
  }
  for (const [flag, sources] of byFlag) add(flag, `Ditandai detektor ${sources.join(', ')}`);

  if (context?.alignment === 'COUNTERTREND') {
    const bearish = htfByTrend(context, timeframe, 'BEARISH');
    add('COUNTERTREND_HTF', `Timeframe lebih tinggi bearish${bearish.length ? `: ${bearish.join(', ')}` : ''}`);
  }
  const qv = liquidity?.quoteVolume24h;
  if (typeof qv === 'number' && Number.isFinite(qv) && qv < p.minQuoteVolume24h) {
    add('POOR_LIQUIDITY', `Quote volume 24 jam ${fmt(qv)} < batas ${fmt(p.minQuoteVolume24h)}`);
  }
  const spread = liquidity?.spreadBps;
  if (typeof spread === 'number' && Number.isFinite(spread) && spread > p.maxSpreadBps) {
    add('WIDE_SPREAD', `Spread ${fmt(spread)} bps > batas ${fmt(p.maxSpreadBps)} bps`);
  }
  if (dataQuality && dataQuality.ok === false) {
    const issues = Array.isArray(dataQuality.issues) && dataQuality.issues.length ? dataQuality.issues.join(', ') : 'tidak lolos validasi';
    add('DATA_QUALITY', `Kualitas data: ${issues}`);
  }
  return { flags: RISK_FLAGS.filter((f) => details.has(f)), details };
}

function patternExplanation(result, score) {
  const conditions = Array.isArray(result.conditions) ? result.conditions : [];
  const weightOf = (c) => (typeof c.weight === 'number' && Number.isFinite(c.weight) && c.weight > 0 ? c.weight : 0);
  const total = conditions.reduce((a, c) => a + weightOf(c), 0);
  const entries = conditions.map((c) => ({
    factor: `PATTERN:${result.pattern}:${c.id}`,
    contribution: c.passed === true && total > 0 ? (100 * weightOf(c)) / total : 0,
    detail: `${c.label ?? c.id}: nilai ${fmt(c.value)} ${c.passed === true ? 'memenuhi' : 'tidak memenuhi'} ambang ${fmt(c.threshold)} (bobot ${fmt(weightOf(c))})`,
  }));
  const residual = score - entries.reduce((a, e) => a + e.contribution, 0);
  if (Math.abs(residual) > EPS) {
    entries.push({
      factor: `PATTERN:${result.pattern}:RESIDUAL`,
      contribution: residual,
      detail: 'Selisih skor detektor terhadap bobot kondisi yang lolos (penilaian parsial/penalti internal detektor)',
    });
  }
  return entries;
}

function trendSummary(context, baseTimeframe) {
  const trends = context?.trends ?? {};
  return Object.keys(trends)
    .map((tf) => `${tf} ${trends[tf]?.trend ?? 'tidak tersedia'}${tf === baseTimeframe ? ' (dasar)' : ''}`)
    .join(', ');
}

/**
 * Menyusun tampilan skor sinyal yang dapat dijelaskan.
 * @param {{ symbol?: string, timeframe?: string, patterns: { classification: string, sa?: object|null, pva?: object|null },
 *   context?: { alignment: string, trends?: object }, liquidity?: { quoteVolume24h?: number, spreadBps?: number },
 *   dataQuality?: { ok: boolean, issues?: string[] }, params?: Partial<typeof DEFAULT_VIEW_PARAMS> }} input
 * @returns {{ symbol: string|undefined, timeframe: string|undefined, classification: string, alignment: string|null,
 *   patternScore: number, earlyScore: number, riskFlags: string[], explanation: Array<{ factor: string, contribution: number, detail: string }> }}
 */
export function buildSignalView({ symbol, timeframe, patterns, context, liquidity, dataQuality, params } = {}) {
  const alignment = context?.alignment ?? null;
  if (alignment !== null && !ALIGNMENTS.includes(alignment)) throw new RangeError(`Alignment tidak dikenal: ${alignment}`);
  const scores = selectScores(patterns);
  const { flags, details } = collectRiskFlags({ patterns, timeframe, context, liquidity, dataQuality, params });
  const p = resolveViewParams(params);
  const results = relevantResults(patterns);
  const source = results.find((r) => r.pattern === scores.patternSource) ?? null;

  const explanation = [];
  const others = results.filter((r) => r !== source).map((r) => `${r.pattern} ${fmt(clampScore(r.patternScore))}`);
  explanation.push({
    factor: 'PATTERN:SELECTION',
    contribution: 0,
    detail: source
      ? `Klasifikasi ${patterns.classification}: skor pola dari ${source.pattern} v${fmt(source.version)} (${fmt(scores.patternScore)})${others.length ? `; lebih rendah: ${others.join(', ')}` : ''}`
      : 'Tidak ada hasil pola',
  });
  if (source) explanation.push(...patternExplanation(source, scores.patternScore));
  explanation.push({
    factor: `EARLY:${scores.earlySource ?? 'NONE'}`,
    contribution: scores.earlyScore,
    detail: scores.earlySource
      ? `earlyScore dari detektor ${scores.earlySource} (${fmt(scores.earlyScore)})`
      : 'Tidak ada hasil pola',
  });

  explanation.push({
    factor: 'CONTEXT:ALIGNMENT',
    contribution: 0,
    detail: alignment
      ? `${alignment} — ${trendSummary(context, timeframe) || 'tanpa rincian trend'} (konteks saja, tidak mengubah skor)`
      : 'Konteks timeframe tidak tersedia',
  });
  const hasLiquidity = Number.isFinite(liquidity?.quoteVolume24h) || Number.isFinite(liquidity?.spreadBps);
  explanation.push({
    factor: 'CONTEXT:LIQUIDITY',
    contribution: 0,
    detail: hasLiquidity
      ? `Quote volume 24 jam ${fmt(liquidity.quoteVolume24h)} (batas ${fmt(p.minQuoteVolume24h)}), spread ${fmt(liquidity.spreadBps)} bps (batas ${fmt(p.maxSpreadBps)})`
      : 'Data likuiditas tidak tersedia',
  });
  for (const flag of flags) {
    explanation.push({ factor: `RISK:${flag}`, contribution: 0, detail: details.get(flag).join('; ') });
  }

  return {
    symbol, timeframe, classification: patterns.classification, alignment,
    patternScore: scores.patternScore, earlyScore: scores.earlyScore, riskFlags: flags, explanation,
  };
}
