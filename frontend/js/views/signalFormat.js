// Render bersama untuk data sinyal (screener, riwayat, overview). Semua via h() — aman XSS.
import { badge } from '../lib/components.js';
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

export function alignmentBadge(value) {
  if (!value) return '—';
  const [label, tone] = ALIGNMENT_LABELS[value] ?? [value, undefined];
  return badge(label, tone);
}

export function riskBadges(flags) {
  if (!Array.isArray(flags) || flags.length === 0) return '—';
  return h('span', { class: 'cluster' }, flags.map((f) => badge(RISK_LABELS[f] ?? f.replaceAll('_', ' '), 'warn')));
}

export function patternBadge(classification) {
  return classification ? badge(classification, 'accent') : '—';
}
