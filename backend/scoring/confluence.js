// Skor konfluensi LONG/SHORT (kontrak docs/10-kontrak-akurasi-v3.md §5). Fungsi murni: tanpa I/O,
// tanpa waktu sistem, tanpa acak. Modul fitur (backend/features/*) TIDAK diimpor — objek fiturnya
// diterima sebagai input biasa sesuai bentuk kontrak §1–§4, sehingga modul ini dapat diuji terpisah.
//
// ─── STATUS: HIPOTESIS AWAL ────────────────────────────────────────────────────────────────────────
// Seluruh bobot, ambang, dan pemetaan nilai di bawah adalah HIPOTESIS AWAL berbasis praktik analisis
// teknikal umum (konfluensi pola + konteks HTF + struktur + order flow + rezim + likuiditas/Wyckoff).
// Angka-angka ini BELUM dioptimasi dan WAJIB dikalibrasi dengan backtest walk-forward out-of-sample
// (backend/backtest/*). Skor 0..100 adalah skor aturan yang dapat dijelaskan, BUKAN probabilitas.
//
// ─── Arah ──────────────────────────────────────────────────────────────────────────────────────────
// d = +1 untuk LONG, −1 untuk SHORT. Setiap besaran bertanda (structureScore, flowBias, cvdSlope,
// absorption) dikali d sehingga "positif = searah". Besaran tak bertanda dicerminkan: takerBuyRatio →
// 1 − t untuk SHORT, posisi dalam range → 1 − p untuk SHORT, sweepLow ↔ sweepHigh, climax SELLING ↔
// BUYING, TRENDING_UP ↔ TRENDING_DOWN, bias BULLISH ↔ BEARISH. Akibatnya input SHORT yang merupakan
// cermin input LONG menghasilkan skor & tier yang identik (diuji).
//
//   Bobot v1 mengikuti docs/11-riset-akurasi-scanner.md: konteks HTF & struktur (bukti time-series momentum)
//   lebih berat; order flow, rezim, dan Wyckoff (bukti empiris lemah / taker agresif cenderung berbalik) lebih ringan.
// ─── Komponen (nilai 0..1, bobot default total 100) ────────────────────────────────────────────────
// pattern   25  0.7·patternScore/100 + 0.3·earlyScore/100 (view).
// htf       20  ALIGNED 1, PARTIALLY_CONFIRMED 0.5, UNCONFIRMED 0, COUNTERTREND 0 (+ veto).
// structure 20  rata-rata berbobot: bias searah (0.4; NEUTRAL 0.3, berlawanan 0), lastEvent BOS/CHOCH
//               searah (0.3; segar ≤ freshBars = 1, lebih lama = 0.5), max(0, structureScore·d) (0.3).
// orderFlow 15  ramp(flowBias·d, 0..0.5) (0.5), ramp(cvdSlope·d, 0..0.2) (0.3),
//               ramp(takerBuyRatio searah, 0.5..0.6) (0.2); divergensi searah = bonus +0.15 (maks 1),
//               divergensi berlawanan = konflik + veto.
// regime    10  label (0.7): TRENDING searah 1, SQUEEZE 0.8, RANGING 0.5, CHOPPY 0.1, TRENDING berlawanan 0;
//               ramp(efficiencyRatio, 0.2..0.6) (0.3), dinolkan bila tren berlawanan.
// liquidity 10  peristiwa (0.5) = maks(sapuan searah yang di-reclaim & segar, climax searah segar);
//               ramp(absorption·d, 0..0.5) (0.25); posisi dalam range (0.25) = clamp((0.6 − p')/0.4),
//               p' = p untuk LONG, 1 − p untuk SHORT (dekat dasar range = baik untuk LONG).
// Sub-bagian bernilai null dikeluarkan dari rata-rata komponen. Komponen dengan input null dikeluarkan
// dari penyebut dan skor dinormalisasi ulang: score = 100·Σ(value·weight) / Σweight_tersedia.
// `contribution` pada tiap komponen sudah ternormalisasi sehingga Σcontribution = score.
// Bila bobot yang tidak tersedia > maxMissingWeightFraction (40%) → tier maksimal C dan konflik
// "Data fitur tidak lengkap".
//
// ─── Veto (id) ─────────────────────────────────────────────────────────────────────────────────────
// COUNTERTREND_HTF   alignment COUNTERTREND atau view.riskFlags memuat COUNTERTREND_HTF.
// REGIME_AGAINST     rezim TRENDING berlawanan arah dengan ADX ≥ adxVeto (25).
// FLOW_AGAINST       flowBias·d ≤ −flowVetoBias (0.3) atau divergensi order flow berlawanan.
// STRUCTURE_AGAINST  bias struktur berlawanan DAN lastEvent CHOCH berlawanan yang segar (≤ freshBars).
// RISK_<FLAG>        risk flag berat pada view: EXCESSIVE_VOLATILITY, DATA_QUALITY, POOR_LIQUIDITY,
//                    WIDE_SPREAD.
//
// ─── Tier ──────────────────────────────────────────────────────────────────────────────────────────
// A  score ≥ tierA (75), tanpa veto, data lengkap, alignment ALIGNED/PARTIALLY_CONFIRMED, struktur searah
//    (structureScore·d > 0, atau bias searah bila structureScore null) dan flow searah (flowBias·d > 0,
//    atau cvdSlope·d > 0 bila flowBias null).
// B  score ≥ tierB (60), tanpa veto, data lengkap.
// C  score ≥ tierC (45).   D  selain itu.   Ada veto atau data tidak lengkap → maksimal C.

import { ALIGNMENTS, RISK_FLAGS, resolveDirection } from '../market/contracts.js';

export const CONFLUENCE_VERSION = 1;
export const TIERS = Object.freeze(['A', 'B', 'C', 'D']);

/** Parameter default (HIPOTESIS AWAL — wajib dikalibrasi backtest). */
export const DEFAULT_CONFLUENCE_PARAMS = Object.freeze({
  weights: Object.freeze({ pattern: 25, htf: 20, structure: 20, orderFlow: 15, regime: 10, liquidity: 10 }),
  tierA: 75,
  tierB: 60,
  tierC: 45,
  /** Peristiwa (BOS/CHOCH, sapuan, climax) dianggap segar bila barsAgo ≤ freshBars. */
  freshBars: 10,
  /** Veto FLOW_AGAINST bila flowBias·d ≤ −flowVetoBias. */
  flowVetoBias: 0.3,
  /** Veto REGIME_AGAINST bila tren berlawanan dengan ADX ≥ adxVeto. */
  adxVeto: 25,
  /** Fraksi bobot tak tersedia maksimum sebelum tier dibatasi C. */
  maxMissingWeightFraction: 0.4,
});

const COMPONENT_IDS = Object.freeze(Object.keys(DEFAULT_CONFLUENCE_PARAMS.weights));
const HEAVY_RISK_FLAGS = Object.freeze(['EXCESSIVE_VOLATILITY', 'DATA_QUALITY', 'POOR_LIQUIDITY', 'WIDE_SPREAD']);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
/** Pemetaan linear x ∈ [lo, hi] → [0, 1], dipotong. */
const ramp = (x, lo, hi) => clamp01((x - lo) / (hi - lo));
const pct = (v) => `${Math.round(v * 100)}%`;
const num = (v, digits = 2) => (isNum(v) ? String(Number(v.toFixed(digits))) : '–');

function assertFinite(key, v, min, max) {
  if (!isNum(v) || v < min || v > max) throw new RangeError(`${key} harus angka ${min}..${max}`);
}

/**
 * Menggabungkan & memvalidasi parameter konfluensi (kunci tak dikenal → TypeError).
 * @param {object} [overrides] sebagian DEFAULT_CONFLUENCE_PARAMS; `weights` boleh parsial.
 */
export function resolveConfluenceParams(overrides = {}) {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('Parameter konfluensi harus objek');
  }
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(DEFAULT_CONFLUENCE_PARAMS, key)) throw new TypeError(`Parameter konfluensi tidak dikenal: ${key}`);
  }
  const w = overrides.weights ?? {};
  if (w === null || typeof w !== 'object' || Array.isArray(w)) throw new TypeError('weights harus objek');
  for (const key of Object.keys(w)) {
    if (!COMPONENT_IDS.includes(key)) throw new TypeError(`Bobot komponen tidak dikenal: ${key}`);
  }
  const weights = { ...DEFAULT_CONFLUENCE_PARAMS.weights, ...w };
  for (const [key, v] of Object.entries(weights)) assertFinite(`weights.${key}`, v, 0, 1000);
  if (Object.values(weights).reduce((a, v) => a + v, 0) <= 0) throw new RangeError('Total bobot harus > 0');

  const p = { ...DEFAULT_CONFLUENCE_PARAMS, ...overrides, weights: Object.freeze(weights) };
  for (const key of ['tierA', 'tierB', 'tierC']) assertFinite(key, p[key], 0, 100);
  if (!(p.tierA >= p.tierB && p.tierB >= p.tierC)) throw new RangeError('Ambang tier harus tierA ≥ tierB ≥ tierC');
  if (!Number.isInteger(p.freshBars) || p.freshBars < 0) throw new RangeError('freshBars harus bilangan bulat ≥ 0');
  assertFinite('flowVetoBias', p.flowVetoBias, 0, 1);
  assertFinite('adxVeto', p.adxVeto, 0, 100);
  assertFinite('maxMissingWeightFraction', p.maxMissingWeightFraction, 0, 1);
  return Object.freeze(p);
}

/** Peringkat tier: A=4, B=3, C=2, D=1. */
export function tierRank(tier) {
  const i = TIERS.indexOf(tier);
  if (i < 0) throw new RangeError(`Tier tidak dikenal: ${String(tier)}`);
  return TIERS.length - i;
}

/** true bila `tier` setara atau lebih baik dari `minTier`. */
export function meetsTier(tier, minTier) {
  return tierRank(tier) >= tierRank(minTier);
}

/** Rata-rata berbobot atas sub-bagian yang tersedia (v bukan null); null bila semua null. */
function blend(parts) {
  let sw = 0;
  let sv = 0;
  for (const { w, v } of parts) {
    if (!isNum(v)) continue;
    sw += w;
    sv += w * v;
  }
  return sw > 0 ? sv / sw : null;
}

const biasSign = (bias) => (bias === 'BULLISH' ? 1 : bias === 'BEARISH' ? -1 : bias === 'NEUTRAL' ? 0 : null);
const isFresh = (ev, freshBars) => !!ev && (!isNum(ev.barsAgo) || ev.barsAgo <= freshBars);
const dirWord = (d) => (d > 0 ? 'naik' : 'turun');

// ─── Komponen ─────────────────────────────────────────────────────────────────────────────────────

function patternComponent(view, ctx) {
  if (!view || (!isNum(view.patternScore) && !isNum(view.earlyScore))) return null;
  const value = blend([
    { w: 0.7, v: isNum(view.patternScore) ? clamp01(view.patternScore / 100) : null },
    { w: 0.3, v: isNum(view.earlyScore) ? clamp01(view.earlyScore / 100) : null },
  ]);
  const text = `Skor pola ${num(view.patternScore, 0)}, skor dini ${num(view.earlyScore, 0)}`
    + `${view.classification ? ` (klasifikasi ${view.classification})` : ''}`;
  if (view.classification === 'NONE') ctx.conflicts.push(`Tidak ada pola terdeteksi — ${text}`);
  else if (value >= 0.6) ctx.confirmations.push(`${text} — pola ${ctx.label} kuat`);
  else if (value < 0.4) ctx.conflicts.push(`${text} — pola masih lemah`);
  return { value, passed: value >= 0.5 };
}

function htfComponent(alignment, context, ctx) {
  if (alignment === null) return null;
  const trends = context?.trends ?? {};
  const detail = Object.keys(trends).map((tf) => `${tf} ${trends[tf]?.trend ?? '–'}`).join(', ');
  const suffix = detail ? ` (${detail})` : '';
  const value = { ALIGNED: 1, PARTIALLY_CONFIRMED: 0.5, UNCONFIRMED: 0, COUNTERTREND: 0 }[alignment];
  if (alignment === 'ALIGNED') ctx.confirmations.push(`Seluruh timeframe lebih tinggi searah ${ctx.label}${suffix}`);
  else if (alignment === 'PARTIALLY_CONFIRMED') ctx.confirmations.push(`Timeframe lebih tinggi sebagian searah ${ctx.label}${suffix}`);
  else if (alignment === 'UNCONFIRMED') ctx.conflicts.push(`Timeframe lebih tinggi belum mengonfirmasi arah ${ctx.label}${suffix}`);
  else ctx.conflicts.push(`Timeframe lebih tinggi berlawanan dengan arah ${ctx.label}${suffix}`);
  return { value, passed: value > 0 };
}

function structureComponent(s, ctx) {
  if (!s || typeof s !== 'object') return null;
  const { d, p } = ctx;
  const b = biasSign(s.bias);
  const biasPart = b === null ? null : b * d > 0 ? 1 : b === 0 ? 0.3 : 0;
  const ev = s.lastEvent ?? null;
  const evDir = ev ? biasSign(ev.direction) : null;
  let eventPart = 0;
  if (ev && evDir !== null && evDir * d > 0) eventPart = isFresh(ev, p.freshBars) ? 1 : 0.5;
  const scorePart = isNum(s.structureScore) ? clamp01(s.structureScore * d) : null;
  const value = blend([{ w: 0.4, v: biasPart }, { w: 0.3, v: eventPart }, { w: 0.3, v: scorePart }]);

  const signal = isNum(s.structureScore) ? s.structureScore * d : b !== null ? b * d : null;
  const scoreText = isNum(s.structureScore) ? `, skor struktur ${num(s.structureScore)}` : '';
  if (b !== null && b * d > 0) ctx.confirmations.push(`Struktur pasar ${s.bias}${scoreText} — searah ${ctx.label}`);
  else if (b !== null && b * d < 0) ctx.conflicts.push(`Struktur pasar ${s.bias}${scoreText} — berlawanan dengan ${ctx.label}`);
  if (ev && evDir !== null) {
    const when = isNum(ev.barsAgo) ? ` ${ev.barsAgo} candle lalu` : '';
    const level = isNum(ev.level) ? ` di ${num(ev.level, 6)}` : '';
    const sentence = `${ev.type} ${ev.direction}${level}${when}`;
    if (evDir * d > 0) ctx.confirmations.push(`${sentence} — penembusan struktur searah ${ctx.label}`);
    else ctx.conflicts.push(`${sentence} — penembusan struktur berlawanan`);
    if (b !== null && b * d < 0 && ev.type === 'CHOCH' && evDir * d < 0 && isFresh(ev, p.freshBars)) {
      ctx.vetoes.add('STRUCTURE_AGAINST');
    }
  }
  if (value === null) return null;
  return { value, passed: value >= 0.5, signal };
}

function orderFlowComponent(f, ctx) {
  if (!f || typeof f !== 'object') return null;
  const { d, p } = ctx;
  const fb = isNum(f.flowBias) ? f.flowBias * d : null;
  const cs = isNum(f.cvdSlope) ? f.cvdSlope * d : null;
  const tbr = isNum(f.takerBuyRatio) ? (d > 0 ? f.takerBuyRatio : 1 - f.takerBuyRatio) : null;
  let value = blend([
    { w: 0.5, v: fb === null ? null : ramp(fb, 0, 0.5) },
    { w: 0.3, v: cs === null ? null : ramp(cs, 0, 0.2) },
    { w: 0.2, v: tbr === null ? null : ramp(tbr, 0.5, 0.6) },
  ]);
  const divSign = f.divergence ? biasSign(f.divergence) : null;
  if (value !== null && divSign !== null && divSign * d > 0) value = Math.min(1, value + 0.15);

  if (fb !== null) {
    const text = `Bias order flow ${num(f.flowBias)}`;
    if (fb > 0) ctx.confirmations.push(`${text} — tekanan ${d > 0 ? 'beli' : 'jual'} dominan`);
    else if (fb < 0) ctx.conflicts.push(`${text} — tekanan ${d > 0 ? 'jual' : 'beli'} dominan`);
    if (fb <= -p.flowVetoBias) ctx.vetoes.add('FLOW_AGAINST');
  }
  if (cs !== null && f.cvdSlope !== 0) {
    const text = `CVD ${dirWord(f.cvdSlope)} ${pct(Math.abs(f.cvdSlope))} dari volume jendela`;
    if (cs > 0) ctx.confirmations.push(`${text} — tekanan ${d > 0 ? 'beli' : 'jual'} agresif`);
    else ctx.conflicts.push(`${text} — taker berlawanan arah ${ctx.label}`);
  }
  if (tbr !== null) {
    const text = `Rasio taker buy ${pct(f.takerBuyRatio)}`;
    if (tbr > 0.5) ctx.confirmations.push(`${text} — agresor ${d > 0 ? 'pembeli' : 'penjual'} lebih besar`);
    else if (tbr < 0.5) ctx.conflicts.push(`${text} — agresor ${d > 0 ? 'penjual' : 'pembeli'} lebih besar`);
  }
  if (divSign !== null) {
    const pc = isNum(f.priceChange) ? ` (harga ${dirWord(f.priceChange)} ${pct(Math.abs(f.priceChange))})` : '';
    if (divSign * d > 0) ctx.confirmations.push(`Divergensi order flow ${f.divergence}${pc} — aliran dana mendahului harga searah ${ctx.label}`);
    else {
      ctx.conflicts.push(`Divergensi order flow ${f.divergence}${pc} — aliran dana berlawanan dengan ${ctx.label}`);
      ctx.vetoes.add('FLOW_AGAINST');
    }
  }
  if (value === null) return null;
  const signal = fb !== null ? fb : cs;
  return { value, passed: value >= 0.5, signal };
}

function regimeComponent(r, ctx) {
  if (!r || typeof r !== 'object') return null;
  const { d, p } = ctx;
  const withTrend = d > 0 ? 'TRENDING_UP' : 'TRENDING_DOWN';
  const againstTrend = d > 0 ? 'TRENDING_DOWN' : 'TRENDING_UP';
  const labelValue = { [withTrend]: 1, SQUEEZE: 0.8, RANGING: 0.5, CHOPPY: 0.1, [againstTrend]: 0 };
  const label = r.regime ?? null;
  const labelPart = label !== null && Object.hasOwn(labelValue, label) ? labelValue[label] : null;
  const against = label === againstTrend;
  const erPart = isNum(r.efficiencyRatio) ? (against ? 0 : ramp(r.efficiencyRatio, 0.2, 0.6)) : null;
  const value = blend([{ w: 0.7, v: labelPart }, { w: 0.3, v: erPart }]);

  const adxText = isNum(r.adx) ? `ADX ${num(r.adx, 1)}` : 'ADX –';
  const erText = isNum(r.efficiencyRatio) ? `, efisiensi ${num(r.efficiencyRatio)}` : '';
  if (label === withTrend) ctx.confirmations.push(`Rezim ${label} (${adxText}${erText}) — tren searah ${ctx.label}`);
  else if (label === 'SQUEEZE') {
    const bw = isNum(r.bandwidthPercentile) ? `, bandwidth persentil ${pct(r.bandwidthPercentile)}` : '';
    ctx.confirmations.push(`Rezim SQUEEZE${bw} — volatilitas terkompresi, potensi ekspansi`);
  } else if (label === 'CHOPPY') {
    const chop = isNum(r.chop) ? ` (choppiness ${num(r.chop, 1)})` : '';
    ctx.conflicts.push(`Rezim CHOPPY${chop} — pergerakan acak, sinyal mudah gagal`);
  } else if (against) {
    ctx.conflicts.push(`Rezim ${label} (${adxText}${erText}) — tren berlawanan dengan ${ctx.label}`);
    if (isNum(r.adx) && r.adx >= p.adxVeto) ctx.vetoes.add('REGIME_AGAINST');
  }
  if (value === null) return null;
  return { value, passed: value >= 0.5 };
}

function liquidityComponent(l, ctx) {
  if (!l || typeof l !== 'object') return null;
  const { d, p } = ctx;
  const sweep = d > 0 ? l.sweepLow : l.sweepHigh;
  const oppSweep = d > 0 ? l.sweepHigh : l.sweepLow;
  const climaxWith = d > 0 ? 'SELLING' : 'BUYING';
  const sweepName = d > 0 ? 'Spring (sapuan low)' : 'Upthrust (sapuan high)';
  const oppSweepName = d > 0 ? 'Upthrust (sapuan high)' : 'Spring (sapuan low)';

  const sweepPart = sweep && sweep.reclaimed === true && isFresh(sweep, p.freshBars) ? 1 : 0;
  const climax = l.climax ?? null;
  const climaxPart = climax && climax.type === climaxWith && isFresh(climax, p.freshBars) ? 1 : 0;
  const ab = isNum(l.absorption) ? l.absorption * d : null;
  const pos = isNum(l.position) ? (d > 0 ? l.position : 1 - l.position) : null;
  const value = blend([
    { w: 0.5, v: Math.max(sweepPart, climaxPart) },
    { w: 0.25, v: ab === null ? null : ramp(ab, 0, 0.5) },
    { w: 0.25, v: pos === null ? null : clamp01((0.6 - pos) / 0.4) },
  ]);

  const when = (ev) => (isNum(ev.barsAgo) ? ` ${ev.barsAgo} candle lalu` : '');
  if (sweep) {
    const lvl = isNum(sweep.level) ? ` di ${num(sweep.level, 6)}` : '';
    if (sweep.reclaimed === true) ctx.confirmations.push(`${sweepName}${lvl}${when(sweep)}, kemudian di-reclaim — likuiditas diambil, peluang ${ctx.label}`);
    else ctx.conflicts.push(`${sweepName}${lvl}${when(sweep)} belum di-reclaim — level masih jebol`);
  }
  if (oppSweep && oppSweep.reclaimed === true) {
    ctx.conflicts.push(`${oppSweepName}${when(oppSweep)} di-reclaim — sinyal berlawanan dengan ${ctx.label}`);
  }
  if (climax) {
    const vr = isNum(climax.volumeRatio) ? ` (volume ${num(climax.volumeRatio, 1)}× rata-rata)` : '';
    if (climax.type === climaxWith) ctx.confirmations.push(`Climax ${climax.type}${vr}${when(climax)} — kelelahan pihak lawan`);
    else ctx.conflicts.push(`Climax ${climax.type}${vr}${when(climax)} — berlawanan dengan ${ctx.label}`);
  }
  if (ab !== null && l.absorption !== 0) {
    const text = `Absorpsi ${num(l.absorption)}`;
    if (ab > 0) ctx.confirmations.push(`${text} — volume besar diserap dekat ${d > 0 ? 'low' : 'high'}`);
    else ctx.conflicts.push(`${text} — penyerapan di sisi berlawanan`);
  }
  if (pos !== null) {
    const text = `Harga di ${pct(l.position)} range`;
    if (pos <= 0.35) ctx.confirmations.push(`${text} — dekat ${d > 0 ? 'dasar' : 'puncak'} range, risiko-imbal menarik`);
    else if (pos >= 0.8) ctx.conflicts.push(`${text} — sudah dekat ${d > 0 ? 'puncak' : 'dasar'} range`);
  }
  if (value === null) return null;
  return { value, passed: value >= 0.5 };
}

const LABELS = Object.freeze({
  pattern: 'Pola SA/PVA/SD/PVD',
  htf: 'Keselarasan timeframe lebih tinggi',
  structure: 'Struktur pasar',
  orderFlow: 'Order flow',
  regime: 'Rezim pasar',
  liquidity: 'Likuiditas & Wyckoff',
});

/**
 * Skor konfluensi direction-aware (kontrak §5).
 * @param {{ direction?: 'LONG'|'SHORT', view?: object|null, context?: { alignment?: string, trends?: object }|null,
 *   structure?: object|null, orderFlow?: object|null, regime?: object|null, liquidity?: object|null }} input
 *   direction default = view.direction atau LONG; bila keduanya ada dan berbeda → RangeError.
 * @param {object} [params] override sebagian DEFAULT_CONFLUENCE_PARAMS.
 * @returns {{ version: 1, score: number, tier: 'A'|'B'|'C'|'D',
 *   components: Array<{ id: string, label: string, weight: number, value: number|null, contribution: number, passed: boolean }>,
 *   confirmations: string[], conflicts: string[], vetoes: string[] }}
 */
export function computeConfluence(input = {}, params = {}) {
  if (input === null || typeof input !== 'object') throw new TypeError('Input konfluensi harus objek');
  const p = resolveConfluenceParams(params);
  const { view = null, context = null, structure = null, orderFlow = null, regime = null, liquidity = null } = input;
  const direction = resolveDirection(input.direction ?? view?.direction);
  if (view?.direction && view.direction !== direction) {
    throw new RangeError(`Arah view (${view.direction}) berbeda dengan arah konfluensi (${direction})`);
  }
  const d = direction === 'SHORT' ? -1 : 1;
  const alignment = view?.alignment ?? context?.alignment ?? null;
  if (alignment !== null && !ALIGNMENTS.includes(alignment)) throw new RangeError(`Alignment tidak dikenal: ${alignment}`);

  const ctx = { d, p, label: direction, confirmations: [], conflicts: [], vetoes: new Set() };
  const results = {
    pattern: patternComponent(view, ctx),
    htf: htfComponent(alignment, context, ctx),
    structure: structureComponent(structure, ctx),
    orderFlow: orderFlowComponent(orderFlow, ctx),
    regime: regimeComponent(regime, ctx),
    liquidity: liquidityComponent(liquidity, ctx),
  };

  // Veto dari alignment & risk flag view.
  const riskFlags = Array.isArray(view?.riskFlags) ? view.riskFlags : [];
  if (alignment === 'COUNTERTREND' || riskFlags.includes('COUNTERTREND_HTF')) ctx.vetoes.add('COUNTERTREND_HTF');
  for (const flag of HEAVY_RISK_FLAGS) {
    if (riskFlags.includes(flag)) {
      ctx.vetoes.add(`RISK_${flag}`);
      ctx.conflicts.push(`Risk flag ${flag} aktif — kandidat tidak layak tier A/B`);
    }
  }

  const totalWeight = COMPONENT_IDS.reduce((a, id) => a + p.weights[id], 0);
  const availableWeight = COMPONENT_IDS.reduce((a, id) => a + (results[id] ? p.weights[id] : 0), 0);
  const missingFraction = 1 - availableWeight / totalWeight;
  const incomplete = missingFraction > p.maxMissingWeightFraction + 1e-12;
  const scale = availableWeight > 0 ? 100 / availableWeight : 0;

  const components = COMPONENT_IDS.map((id) => {
    const r = results[id];
    return {
      id, label: LABELS[id], weight: p.weights[id],
      value: r ? r.value : null,
      contribution: r ? r.value * p.weights[id] * scale : 0,
      passed: r ? r.passed : false,
    };
  });
  const score = Math.min(100, Math.max(0, components.reduce((a, c) => a + c.contribution, 0)));

  if (incomplete) {
    const missing = components.filter((c) => c.value === null).map((c) => c.label).join(', ');
    ctx.conflicts.push(`Data fitur tidak lengkap — ${pct(missingFraction)} bobot tidak tersedia (${missing}); tier maksimal C`);
  }

  const vetoes = [...ctx.vetoes];
  const capped = vetoes.length > 0 || incomplete;
  const structureOk = isNum(results.structure?.signal) && results.structure.signal > 0;
  const flowOk = isNum(results.orderFlow?.signal) && results.orderFlow.signal > 0;
  let tier = 'D';
  if (!capped && score >= p.tierA && (alignment === 'ALIGNED' || alignment === 'PARTIALLY_CONFIRMED') && structureOk && flowOk) tier = 'A';
  else if (!capped && score >= p.tierB) tier = 'B';
  else if (score >= p.tierC) tier = 'C';

  return {
    version: CONFLUENCE_VERSION,
    score,
    tier,
    components,
    confirmations: ctx.confirmations,
    conflicts: ctx.conflicts,
    vetoes,
  };
}

/** Daftar risk flag yang memicu veto (urutan kanonik RISK_FLAGS). */
export const CONFLUENCE_VETO_RISK_FLAGS = Object.freeze(RISK_FLAGS.filter((f) => HEAVY_RISK_FLAGS.includes(f)));
