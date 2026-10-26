// Render bersama untuk data sinyal (screener, riwayat, overview). Semua via h() — aman XSS.
import { badge, stage } from '../lib/components.js';
import { h } from '../lib/dom.js';

const ALIGNMENT_LABELS = {
  ALIGNED: ['Aligned', 'bull'],
  PARTIALLY_CONFIRMED: ['Parsial', 'accent'],
  UNCONFIRMED: ['Unconfirmed', undefined],
  COUNTERTREND: ['Countertrend', 'warn'],
};

// Selaras dengan RISK_FLAGS di backend/market/contracts.js.
const RISK_LABELS = {
  POOR_LIQUIDITY: 'Likuiditas rendah',
  WIDE_SPREAD: 'Spread lebar',
  EXCESSIVE_VOLATILITY: 'Volatilitas ekstrem',
  COUNTERTREND_HTF: 'Melawan tren HTF',
  EXTENDED_PRICE: 'Harga melebar',
  DATA_QUALITY: 'Kualitas data',
};

// Nama pola untuk tooltip badge. SD/PVD adalah cermin bearish SA/PVA (pola #003/#004).
const PATTERN_NAMES = {
  SA: 'Silent Accumulation',
  PVA: 'Progressive Volume Accumulation',
  SD: 'Silent Distribution',
  PVD: 'Progressive Volume Distribution',
};
const SHORT_PATTERNS = new Set(['SD', 'PVD']);
const HOT_STAGES = new Set(['BREAKOUT', 'BREAKDOWN']);

/** Arah sinyal; nilai hilang/lama (sebelum SHORT ada) = 'LONG'. */
export const directionOf = (value) => (value === 'SHORT' ? 'SHORT' : 'LONG');

export function alignmentBadge(value) {
  if (!value) return '—';
  const [label, tone] = ALIGNMENT_LABELS[value] ?? [value, undefined];
  return badge(label, tone);
}

export function riskBadges(flags) {
  if (!Array.isArray(flags) || flags.length === 0) return '—';
  return h('span', { class: 'cluster' }, flags.map((f) => badge(RISK_LABELS[f] ?? f.replaceAll('_', ' '), 'warn')));
}

/**
 * Badge klasifikasi pola. SD/PVD (dan BOTH pada arah SHORT = SD + PVD) bernada bear; pola LONG tetap accent.
 * @param {string|null|undefined} classification
 * @param {'LONG'|'SHORT'} [direction] diperlukan hanya untuk membedakan BOTH; default LONG.
 */
export function patternBadge(classification, direction) {
  if (!classification) return '—';
  const short = SHORT_PATTERNS.has(classification) || (classification === 'BOTH' && directionOf(direction) === 'SHORT');
  const el = badge(classification, short ? 'bear' : 'accent');
  const name = classification === 'BOTH' ? (short ? 'SD + PVD' : 'SA + PVA') : PATTERN_NAMES[classification];
  if (name) el.title = name;
  return el;
}

/** Badge arah sinyal: LONG bernada bull, SHORT bernada bear. Selalu berlabel teks (warna bukan satu-satunya penanda). */
export function directionBadge(direction) {
  const value = directionOf(direction);
  return badge(value, value === 'SHORT' ? 'bear' : 'bull');
}

/**
 * Tahap sinyal. State SHORT (EARLY_BEARISH, BREAKDOWN) punya warna sendiri di CSS; MOMENTUM_BUILDING dipakai kedua
 * arah, sehingga sinyal SHORT diberi `data-direction="SHORT"` agar bernada bear. LONG identik dengan stage().
 */
export function signalStage(state, direction) {
  const el = stage(state);
  if (directionOf(direction) === 'SHORT') el.dataset.direction = 'SHORT';
  // Tahap konfirmasi (BREAKOUT/BREAKDOWN) berdenyut halus di CSS (dimatikan saat reduced motion / animasi off).
  if (HOT_STAGES.has(state)) el.classList.add('stage--hot');
  return el;
}

// ---- Konfluensi & tier keyakinan (field opsional dari backend akurasi) ----
// confluenceScore 0..100 = skor ATURAN (bukan probabilitas); confidenceTier 'A'..'D' (A tertinggi); winProbability
// 0..1 hanya bila sudah dikalibrasi backtest, selain itu null. Sinyal lama tidak membawa field ini (undefined) →
// diperlakukan null dan TIDAK ditampilkan apa pun (tanpa placeholder).

const TIER_RANK = Object.freeze({ A: 4, B: 3, C: 2, D: 1 });
const TIER_TONE = Object.freeze({ A: 'bull', B: 'accent', C: 'warn', D: undefined });
const TIER_TEXT = Object.freeze({
  A: 'konfluensi tertinggi',
  B: 'konfluensi baik',
  C: 'konfluensi sedang',
  D: 'konfluensi rendah',
});

/** Komponen konfluensi yang dikenal → label Bahasa Indonesia. Komponen lain tampil dengan namanya apa adanya. */
export const CONFLUENCE_COMPONENT_LABELS = Object.freeze({
  pattern: 'Pola',
  htf: 'Timeframe lebih tinggi',
  structure: 'Struktur pasar',
  orderFlow: 'Order flow',
  regime: 'Rezim pasar',
  liquidity: 'Likuiditas',
});

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Tier valid ('A'|'B'|'C'|'D', huruf kecil diterima) atau null. */
export function normalizeTier(tier) {
  if (typeof tier !== 'string') return null;
  const t = tier.trim().toUpperCase();
  return Object.hasOwn(TIER_RANK, t) ? t : null;
}

/** Peringkat tier untuk pengurutan (A=4 … D=1); null bila tidak ada tier. */
export function tierRank(tier) {
  const t = normalizeTier(tier);
  return t ? TIER_RANK[t] : null;
}

/**
 * Apakah tier memenuhi tier minimum. Tanpa minimum (kosong/tidak valid) → selalu true. Baris tanpa tier tidak
 * memenuhi minimum apa pun (keyakinannya tidak diketahui).
 */
export function meetsMinTier(tier, minTier) {
  const min = normalizeTier(minTier);
  if (!min) return true;
  const rank = tierRank(tier);
  return rank !== null && rank >= TIER_RANK[min];
}

/** Skor konfluensi 0..100 dibulatkan, atau null bila tidak ada/tidak valid. */
export function confluenceValue(score) {
  return isFiniteNum(score) ? Math.round(Math.max(0, Math.min(100, score))) : null;
}

/**
 * Probabilitas menang terkalibrasi → teks persen ('62%'), atau null bila belum dikalibrasi / tidak valid.
 * null berarti JANGAN tampilkan apa pun (bukan '—').
 * @param {number|null|undefined} p 0..1
 * @returns {string|null}
 */
export function formatWinProbability(p) {
  if (!isFiniteNum(p) || p < 0 || p > 1) return null;
  return `${Math.round(p * 100)}%`;
}

/**
 * Badge tier keyakinan: A = emerald dengan glow (kelas tier-badge--a), B = accent, C = warn, D = netral.
 * Berlabel teks "Tier X" (warna bukan satu-satunya penanda) + tooltip/aria-label. null bila tidak ada tier.
 * @returns {HTMLElement|null}
 */
export function tierBadge(tier) {
  const t = normalizeTier(tier);
  if (!t) return null;
  const el = badge(`Tier ${t}`, TIER_TONE[t]);
  el.classList.add('tier-badge', `tier-badge--${t.toLowerCase()}`);
  el.dataset.tier = t;
  const text = `Tier keyakinan ${t} — ${TIER_TEXT[t]} (A tertinggi, D terendah). Peringkat aturan, bukan probabilitas profit.`;
  el.title = text;
  el.setAttribute('aria-label', text);
  return el;
}

/**
 * Faktor konfluensi dari explanation[] ({ factor, contribution, detail }):
 * - 'CONFLUENCE:<komponen>' (pattern, htf, structure, orderFlow, regime, liquidity, …) → components
 * - 'CONFLUENCE:CONFIRM' → confirms, 'CONFLUENCE:CONFLICT' → conflicts
 * - 'CONFLUENCE:TIER' → tier (detail-nya), bukan komponen
 * Faktor non-konfluensi diabaikan. Tidak ada angka rekaan: contribution non-angka → null.
 * @param {Array<{ factor?: string, contribution?: number, detail?: string }>|null|undefined} explanation
 * @returns {{ components: Array<{ name: string, label: string, contribution: number|null, detail: string|null }>,
 *   confirms: Array<{ contribution: number|null, detail: string|null }>,
 *   conflicts: Array<{ contribution: number|null, detail: string|null }>, tier: { detail: string|null }|null }}
 */
export function confluenceBreakdown(explanation) {
  const out = { components: [], confirms: [], conflicts: [], tier: null };
  if (!Array.isArray(explanation)) return out;
  for (const item of explanation) {
    const factor = typeof item?.factor === 'string' ? item.factor : '';
    if (!factor.startsWith('CONFLUENCE:')) continue;
    const name = factor.slice('CONFLUENCE:'.length);
    if (!name) continue;
    const contribution = isFiniteNum(item.contribution) ? item.contribution : null;
    const detail = typeof item.detail === 'string' && item.detail ? item.detail : null;
    if (name === 'TIER') out.tier = { detail };
    else if (name === 'CONFIRM') out.confirms.push({ contribution, detail });
    else if (name === 'CONFLICT') out.conflicts.push({ contribution, detail });
    else out.components.push({ name, label: CONFLUENCE_COMPONENT_LABELS[name] ?? name, contribution, detail });
  }
  return out;
}

/** Apakah baris membawa data konfluensi/tier/probabilitas (untuk memutuskan kolom mana yang tampil). */
export function confluenceFieldsOf(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return {
    tier: list.some((r) => normalizeTier(r?.confidenceTier) !== null),
    score: list.some((r) => confluenceValue(r?.confluenceScore) !== null),
    winProbability: list.some((r) => formatWinProbability(r?.winProbability) !== null),
  };
}
