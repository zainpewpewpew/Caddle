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
  return el;
}
